import { decodeScopedServiceCommand, runScopedCommand } from '../service/scoped-command';
import { authorizeScoped, bindScopedComponent, scopedServiceAuthority, type ScopedServiceAuthority } from '../service/scoped-authority';
import { z } from 'zod';
import type { AuthenticatedRequestContext, RequestIdentityBoundary } from '../auth/request-identity';
import { AUTHENTICATED_SESSION_ENVELOPE_VERSION, decodeAuthenticatedSessionEnvelope } from '../contracts/authenticated-session-codec';
import type { PreparedQuestionBank } from '../data/prepared-question-bank';
import type { InterviewContext } from '../data/load-interview-context';
import { parseApprovedKnowledgeBundle } from '../data/approved-knowledge';
import { createReviewedEvaluationKnowledgeContext } from '../data/reviewed-evaluation-context';
import { loadBankScopeRegistryFromReader, prepareBankScopeReview, validateBankScopeReview, verifyBankScopeReviewReceipt } from '../data/evaluation-scope-registry';
import { prepareEndedSessionReview, validateReviewedSessionEvaluationInput, verifyStoredSessionEvaluationReviewFromReaders, type StoredSessionEvaluationReviewReaders } from '../evaluation-supply';
import { prepareReviewedEvaluationJobInput } from '../reviewed-evaluation-queue';
import { parseReviewedEvaluationRevisionReference, prepareReviewedEvaluationRevisionReference } from '../evaluation-revisions';
import { evaluationFrozenInputHash } from '../evaluation-history';
import { buildEvaluationClusterInputs } from '../providers/evaluation-input';
import type { SessionAccessBinding } from '../request-realtime-server';
import type { SessionCommandRepository, SessionCommandSnapshot } from '../session-writer/session-command-ports';
import { decodeSessionEvaluationHandoff, evaluationTextSha256 as sha } from './e-handoff-codec';
import { resolveEvaluationReviewer, resolveStoredEvaluationReviewer, type EvaluationReviewerAction } from './review-trust';
import { EvaluationWriterError, type EvaluationWriterRepository, type EvaluationScopeControl, type EvaluationSessionControl, type EvaluationCommandReceipt,
  type EvaluationReviewerCapability, type EvaluationAdmissionCapability, type EvaluationConsumptionInput, type EvaluationReviewArtifact,
  type EvaluationArtifactKind, type EvaluationProjection } from './evaluation-writer-ports';
import { AUTHENTICATED_EVALUATION_COMMAND_VERSION, authenticatedEvaluationCommandSchema, evaluationCommandInputSha256,
  type AuthenticatedEvaluationCommand, type EvaluationMutationAction, type ServiceEvaluationMutations } from './service-evaluation';

const reject = (status: number, code: string): never => { throw new EvaluationWriterError(status, code); };
const actorSchema = z.object({ actorId: z.string().min(1) }).passthrough();
const jsonText = z.string().min(2).max(8 * 1024 * 1024);
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value); if (!result.success) return reject(400, 'F_COMMAND_INVALID'); return result.data;
}
function json(value: string): unknown { try { return JSON.parse(value); } catch { return reject(400, 'F_JSON_INVALID'); } }
function checked<T>(operation: () => T): T {
  try { return operation(); } catch (cause) {
    if (cause instanceof EvaluationWriterError) throw cause;
    const message = cause instanceof Error ? cause.message.split(':', 1)[0] : '';
    return reject(409, /^[A-Z][A-Z0-9_]{1,100}$/u.test(message) ? message : 'F_DOMAIN_INPUT_INVALID');
  }
}
function artifact(kind: EvaluationArtifactKind, contentSha256: string, text: string): EvaluationReviewArtifact {
  return { kind, contentSha256, json: text, rawSha256: sha(text) };
}
function artifactValue(value: EvaluationReviewArtifact, kind: EvaluationArtifactKind) {
  if (value.kind !== kind || sha(value.json) !== value.rawSha256) return reject(409, 'F_ARTIFACT_BYTES_CHANGED');
  return json(value.json);
}
export interface IsolatedEvaluationServiceOptions {
  environment: 'isolated-evaluation-writer'; identity: RequestIdentityBoundary;
  repository: EvaluationWriterRepository; sessions: Pick<SessionCommandRepository, 'read'>;
  /** Actual D/C pinned bank reader, never a local mirror or user path. */
  loadPinnedBank(context: AuthenticatedRequestContext, snapshot: SessionCommandSnapshot): Promise<PreparedQuestionBank>;
  mintReviewer(context: AuthenticatedRequestContext, authority: { action: EvaluationReviewerAction; actorId: string; publicKeySha256: string;
    control: EvaluationScopeControl; sessionId?: string }): EvaluationReviewerCapability;
  mintAdmission(context: AuthenticatedRequestContext, input: EvaluationConsumptionInput): EvaluationAdmissionCapability;
  /** External trust synchronization can narrow this DB revision's authority;
   * it cannot authorize a principal absent from the current DB trust record. */
  assertTrustCurrent(context: AuthenticatedRequestContext, trust: EvaluationReviewArtifact): Promise<void>;
  observe?(phase: 'before-consume' | 'after-consume' | 'before-publish' | 'after-publish', detail: { action: string; sessionId: string; key: string }): Promise<void>;
}

/** No filesystem persistence, evaluation queue, signer, model or local fallback.
 * Actual supply/read/consumer callers use existing domain gates and the SQL
 * writer, while a separately authorized worker consumes only registered jobs. */
export function createIsolatedEvaluationService(options: IsolatedEvaluationServiceOptions) {
  if (options.environment !== 'isolated-evaluation-writer' || process.env.NODE_ENV === 'production') reject(503, 'F_ISOLATED_COMPOSITION_REQUIRED');
  return createEvaluationServiceCore(options);
}

function createEvaluationServiceCore(options: Omit<IsolatedEvaluationServiceOptions, 'environment'> & { authority?: ScopedServiceAuthority }) {
  const { identity, repository } = options;
  async function current(context: AuthenticatedRequestContext) {
    const value = await identity.revalidate(context);
    if (value.mode !== 'authenticated' || !value.scope) return reject(403, 'F_SCOPE_REQUIRED');
    if (options.authority) await authorizeScoped(options.authority, value, 'read'); return value;
  }
  async function read(context: AuthenticatedRequestContext, binding: SessionAccessBinding) {
    const selected = await current(context), snapshot = await options.sessions.read(selected, binding.sessionId);
    if (!snapshot || !snapshot.created) return reject(404, 'F_SESSION_NOT_FOUND');
    identity.assertResource(selected, snapshot.binding);
    if (snapshot.binding.sessionId !== binding.sessionId || snapshot.contextSnapshotSha256 !== binding.contextSnapshotSha256 ||
      sha(snapshot.pinsJson) !== snapshot.pinsSha256) return reject(409, 'F_SESSION_BINDING_CHANGED');
    const decoded = decodeAuthenticatedSessionEnvelope({ version: AUTHENTICATED_SESSION_ENVELOPE_VERSION,
      sessionJson: snapshot.sessionJson, sessionSha256: snapshot.sessionSha256, contextJson: snapshot.contextJson,
      contextSha256: snapshot.contextSnapshotSha256 }, snapshot.binding.ownerId);
    return { selected, snapshot, ...decoded };
  }
  function receipt(value: EvaluationCommandReceipt, sessionId?: string) {
    if (sessionId && value.sessionId !== null && value.sessionId !== sessionId) return reject(409, 'F_RECEIPT_SESSION_CHANGED');
    if (sha(value.resultJson) !== value.resultSha256) return reject(409, 'F_RECEIPT_BYTES_CHANGED');
    return { version: AUTHENTICATED_EVALUATION_COMMAND_VERSION, operationId: value.operationId, key: value.key,
      inputSha256: value.inputSha256, replay: value.replay, result: json(value.resultJson) };
  }
  async function controls(context: AuthenticatedRequestContext, sessionId: string) {
    const scope = await repository.scopeControl(context), session = await repository.sessionControl(context, sessionId);
    return { scope, session };
  }
  function controlProjection(scope: EvaluationScopeControl, session: EvaluationSessionControl | null) {
    return { trustGeneration: scope.trustGeneration, registryGeneration: scope.registryGeneration,
      registrySha256: scope.registry?.contentSha256 ?? null, approvalGeneration: session?.approvalGeneration ?? '0',
      approvalSha256: session?.approvalSha256 ?? null, approvalRevoked: session?.approvalRevoked ?? false, writer: session?.writer ?? null, fence: session?.fence ?? null };
  }
  function registryReaders(scope: EvaluationScopeControl) {
    return {
      async readRegistryPointer() {
        if (!scope.registry) throw Object.assign(new Error('Registry not supplied'), { code: 'ENOENT' });
        return JSON.stringify({ contentSha256: scope.registry.contentSha256 });
      },
      async readRegistryRevision(hash: string) {
        if (!scope.registry || !scope.registryReceipt || hash !== scope.registry.contentSha256) return reject(409, 'F_REGISTRY_CHANGED');
        return JSON.stringify({ registry: artifactValue(scope.registry, 'registry'), receipt: artifactValue(scope.registryReceipt, 'registry-receipt') });
      },
    };
  }
  async function registry(context: AuthenticatedRequestContext, scope: EvaluationScopeControl) {
    if (!scope.registry && !scope.registryReceipt) return null;
    if (!scope.registry || !scope.registryReceipt || !scope.trust) return reject(409, 'F_REGISTRY_INCOMPLETE');
    await options.assertTrustCurrent(context, scope.trust);
    const actor = parse(actorSchema, artifactValue(scope.registryReceipt, 'registry-receipt'));
    const authority = resolveStoredEvaluationReviewer(scope.trust, context, actor.actorId, 'publish-spec', scope.serverNow);
    return loadBankScopeRegistryFromReader(registryReaders(scope), authority.publicKey, () => Date.parse(scope.serverNow));
  }
  async function reviewReaders(context: AuthenticatedRequestContext, scope: EvaluationScopeControl, session: EvaluationSessionControl,
    frozen: ReturnType<typeof decodeSessionEvaluationHandoff>, derived: ReturnType<typeof prepareReviewedEvaluationJobInput>): Promise<StoredSessionEvaluationReviewReaders> {
    if (!scope.trust || !scope.registryReceipt || !session.receipt) return reject(409, 'F_REVIEW_NOT_SUPPLIED');
    await options.assertTrustCurrent(context, scope.trust);
    const envelope = parse(z.object({ receipt: z.unknown(), proposal: z.unknown() }).strict(), artifactValue(session.receipt, 'session-receipt'));
    const signer = resolveStoredEvaluationReviewer(scope.trust, context, parse(actorSchema, envelope.receipt).actorId, 'supply-session', scope.serverNow);
    const registrySigner = resolveStoredEvaluationReviewer(scope.trust, context,
      parse(actorSchema, artifactValue(scope.registryReceipt, 'registry-receipt')).actorId, 'publish-spec', scope.serverNow);
    return { trustedPublicKey: signer.publicKey, trustedRegistryPublicKey: registrySigner.publicKey, now: () => Date.parse(scope.serverNow),
      async loadContext(hash, owner) {
        if (owner !== frozen.payload.ownerId) return reject(404, 'F_CONTEXT_NOT_FOUND');
        if (hash === frozen.payload.contextSnapshotSha256) return structuredClone(frozen.context);
        if (hash === derived.contextSnapshotSha256) return structuredClone(derived.context);
        return reject(404, 'F_CONTEXT_NOT_FOUND');
      }, reviews: { ...registryReaders(scope), async readSessionReceipt(hash) {
        if (hash !== session.receipt!.contentSha256) return reject(409, 'F_APPROVAL_CHANGED'); return session.receipt!.json;
      } } };
  }
  async function prepare(context: AuthenticatedRequestContext, scope: EvaluationScopeControl, session: EvaluationSessionControl,
    frozen: ReturnType<typeof decodeSessionEvaluationHandoff>) {
    const latest = await registry(context, scope);
    if (!latest || !session.receipt || !session.bundle || session.approvalRevoked || session.registrySha256 !== latest.contentSha256)
      return null;
    const bundleArtifact = session.bundle, receiptArtifact = session.receipt;
    const bundle = checked(() => parseApprovedKnowledgeBundle(artifactValue(bundleArtifact, 'bundle')));
    const projection = checked(() => createReviewedEvaluationKnowledgeContext(frozen.context, frozen.session, bundle, {
      path: 'evaluation-artifact:' + bundle.contentSha256, fileSha256: bundleArtifact.rawSha256,
      sessionReviewReceiptSha256: receiptArtifact.contentSha256, evaluationSpecRegistrySha256: latest.contentSha256, evaluationSpecRegistry: latest,
    }));
    const derived = checked(() => prepareReviewedEvaluationJobInput(projection.context, frozen.session, frozen.context, frozen.payload.model));
    const readers = await reviewReaders(context, scope, session, frozen, derived);
    if (!await verifyStoredSessionEvaluationReviewFromReaders(derived.context, derived.session, readers)) return null;
    const answers = checked(() => buildEvaluationClusterInputs(derived.context, derived.session)).flatMap(item => item.answers);
    const readiness = { readyCount: answers.filter(answer => !answer.knowledge.holdReasons.length).length,
      held: answers.flatMap(answer => answer.knowledge.holdReasons) };
    return { derived, projection, readers, readiness };
  }
  async function consume(context: AuthenticatedRequestContext, snapshot: SessionCommandSnapshot, input: AuthenticatedEvaluationCommand) {
    const supplied = parse(z.object({ handoffPayloadSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      approvalSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable() }).strict(), input.payload);
    const frozen = decodeSessionEvaluationHandoff(snapshot), { scope, session } = await controls(context, snapshot.binding.sessionId);
    if (supplied.handoffPayloadSha256 !== frozen.handoff.payloadSha256) return reject(409, 'F_HANDOFF_BINDING_CHANGED');
    if (supplied.approvalSha256 !== (session?.approvalSha256 ?? null)) return reject(409, 'F_APPROVAL_CHANGED');
    let ready: Awaited<ReturnType<typeof prepare>> = null;
    const reasons = ['AUTHENTICATED_SESSION_REVIEW_REQUIRED'];
    if (session?.receipt && session.bundle && !session.approvalRevoked) {
      try {
        ready = await prepare(context, scope, session, frozen);
        if (ready && !ready.readiness.readyCount) { reasons.push(...ready.readiness.held); ready = null; }
      }
      catch (cause) { if (cause instanceof EvaluationWriterError && cause.status === 403) reasons.push(cause.code); else throw cause; }
    }
    const request: EvaluationConsumptionInput = { key: input.key, inputSha256: evaluationCommandInputSha256(snapshot.binding.sessionId, 'consume', input.payload),
      sessionId: snapshot.binding.sessionId, handoffIntentId: frozen.handoff.intentId, handoffPayloadSha256: frozen.handoff.payloadSha256,
      frozenSessionSha256: frozen.payload.frozenSessionSha256, originalContextSnapshotSha256: frozen.payload.contextSnapshotSha256,
      expectedTrustGeneration: input.expectedTrustGeneration, expectedRegistryGeneration: input.expectedRegistryGeneration,
      expectedApprovalGeneration: input.expectedApprovalGeneration, approvalSha256: supplied.approvalSha256,
      state: ready ? 'registered' : 'review_required', reasons: ready ? [] : reasons };
    if (ready) {
      const prepared = ready.derived;
      // Only identity fields are used by the existing pure reference builder.
      const job = { id: prepared.jobId, sourceSha256: prepared.sourceSha256, snapshotSha256: prepared.snapshotSha256,
        pipelineVersion: prepared.pipelineVersion, model: prepared.model };
      const reference = checked(() => prepareReviewedEvaluationRevisionReference({ originalSession: frozen.session, job,
        receiptSha256: session!.receipt!.contentSha256, receiptIssuedAt: parse(z.object({ receipt: z.object({ issuedAt: z.string() }) }).passthrough(), json(session!.receipt!.json)).receipt.issuedAt,
        originalContextSnapshotSha256: frozen.payload.contextSnapshotSha256, reviewedContextSnapshotSha256: prepared.contextSnapshotSha256,
        sessionFrozenInputSha256: evaluationFrozenInputHash(frozen.session) }));
      const revisionJson = JSON.stringify(reference);
      request.registration = { jobId: prepared.jobId, sourceSha256: prepared.sourceSha256, snapshotJson: prepared.snapshotJson, snapshotSha256: prepared.snapshotSha256,
        reviewedContext: artifact('reviewed-context', prepared.contextSnapshotSha256, prepared.contextJson), pipelineVersion: prepared.pipelineVersion, model: prepared.model,
        revisionJson, revisionSha256: reference.contentSha256, revisionRawSha256: sha(revisionJson) };
    }
    await options.observe?.('before-consume', { action: 'consume', sessionId: snapshot.binding.sessionId, key: input.key });
    const result = await repository.consume(context, request, options.mintAdmission(context, request));
    await options.observe?.('after-consume', { action: 'consume', sessionId: snapshot.binding.sessionId, key: input.key }); return receipt(result);
  }
  function validateProjection(value: EvaluationProjection | null, sessionId: string) {
    if (!value) return null;
    if (value.sessionId !== sessionId) return reject(404, 'F_REVISION_NOT_FOUND');
    if (value.revisionJson) {
      const reference = checked(() => parseReviewedEvaluationRevisionReference(json(value.revisionJson!)));
      if (reference.contentSha256 !== value.revisionSha256 || reference.sessionId !== sessionId || value.job?.id !== reference.job.id ||
        Object.entries(reference.job).some(([key, data]) => value.job?.[key as keyof NonNullable<EvaluationProjection['job']>] !== data))
        return reject(409, 'F_REVISION_BINDING_CHANGED');
    }
    return value;
  }
  async function authorizedProjection(context: AuthenticatedRequestContext, snapshot: SessionCommandSnapshot, scope: EvaluationScopeControl,
    session: EvaluationSessionControl | null, value: EvaluationProjection | null, historical = false) {
    const found = validateProjection(value, snapshot.binding.sessionId);
    if (!found?.job) return found;
    const frozen = decodeSessionEvaluationHandoff(snapshot);
    if (found.revisionJson) {
      const reference = checked(() => parseReviewedEvaluationRevisionReference(json(found.revisionJson!)));
      if (reference.ownerId !== frozen.payload.ownerId || reference.originalContextSnapshotSha256 !== frozen.payload.contextSnapshotSha256 ||
        reference.reviewedContextSnapshotSha256 !== found.job.contextSnapshotSha256 || reference.sessionFrozenInputSha256 !== evaluationFrozenInputHash(frozen.session))
        return reject(409, 'F_REVISION_INPUT_CHANGED');
    }
    async function historicalResult() {
      if (!historical) return { ...found!, state: 'review_required' as const, currentApproval: false, result: null };
      const stored = await repository.readArtifact(context, 'reviewed-context', found!.job!.contextSnapshotSha256);
      if (!stored) return reject(409, 'F_HISTORICAL_CONTEXT_MISSING');
      const originalContext = artifactValue(stored, 'reviewed-context') as InterviewContext;
      const original = checked(() => prepareReviewedEvaluationJobInput(originalContext, frozen.session, frozen.context, found!.job!.model));
      if (original.jobId !== found!.job!.id || original.sourceSha256 !== found!.job!.sourceSha256 ||
        original.snapshotSha256 !== found!.job!.snapshotSha256 || original.contextSnapshotSha256 !== found!.job!.contextSnapshotSha256)
        return reject(409, 'F_HISTORICAL_INPUT_CHANGED');
      if (found!.revisionJson && checked(() => parseReviewedEvaluationRevisionReference(json(found!.revisionJson!))).receiptSha256 !== originalContext.manifest.recordIds.sessionReviewReceiptSha256)
        return reject(409, 'F_HISTORICAL_REVIEW_CHANGED');
      // Exact historical bytes remain readable to the current owner. This
      // explicit revision view never re-approves them as a current result.
      return { ...found!, state: 'review_required' as const, currentApproval: false, resultIsHistorical: true };
    }
    if (!found.currentApproval) return historicalResult();
    let prepared: Awaited<ReturnType<typeof prepare>> = null;
    try { if (session) prepared = await prepare(context, scope, session, frozen); }
    catch (cause) { if (!(cause instanceof EvaluationWriterError && cause.status === 403)) throw cause; }
    if (!prepared) return historicalResult();
    const expected = prepared.derived;
    if (found.job.id !== expected.jobId || found.job.sourceSha256 !== expected.sourceSha256 || found.job.snapshotSha256 !== expected.snapshotSha256 ||
      found.job.contextSnapshotSha256 !== expected.contextSnapshotSha256 || found.job.pipelineVersion !== expected.pipelineVersion || found.job.model !== expected.model)
      return reject(409, 'F_JOB_INPUT_CHANGED');
    if (found.revisionJson) {
      const reference = checked(() => parseReviewedEvaluationRevisionReference(json(found.revisionJson!)));
      if (reference.originalContextSnapshotSha256 !== frozen.payload.contextSnapshotSha256 || reference.reviewedContextSnapshotSha256 !== expected.contextSnapshotSha256 ||
        reference.sessionFrozenInputSha256 !== evaluationFrozenInputHash(frozen.session) || reference.receiptSha256 !== session!.receipt!.contentSha256)
        return reject(409, 'F_REVISION_INPUT_CHANGED');
    }
    return found;
  }
  const mutations: ServiceEvaluationMutations = {
    kind: 'isolated-db-evaluation-writer',
    async query(context, binding, action, query) {
      const base = await read(context, binding), selected = base.selected;
      const { scope, session } = await controls(selected, binding.sessionId), control = controlProjection(scope, session);
      if (action === 'commands') {
        const saved = await repository.receipt(selected, { key: query.key ?? '', inputSha256: query.inputSha256 ?? '' });
        if (!saved) return reject(404, 'F_RECEIPT_NOT_FOUND'); return receipt(saved, binding.sessionId);
      }
      if (action === 'revision') return await authorizedProjection(selected, base.snapshot, scope, session,
        await repository.jobProjection(selected, query.jobId ?? ''), true) ?? reject(404, 'F_REVISION_NOT_FOUND');
      if (action === 'status') return { version: 'authenticated-evaluation-view-v1', control,
        handoff: base.snapshot.handoff ? { intentId: base.snapshot.handoff.intentId, payloadSha256: base.snapshot.handoff.payloadSha256,
          frozenSessionSha256: base.snapshot.handoff.frozenSessionSha256, committedRevision: base.snapshot.handoff.committedRevision } : null,
        projection: await authorizedProjection(selected, base.snapshot, scope, session, await repository.projection(selected, binding.sessionId)) };
      if (action === 'registry') {
        const bank = await options.loadPinnedBank(selected, base.snapshot);
        const inventory = checked(() => prepareBankScopeReview(base.context, bank, { ownerId: selected.account.ownerId }));
        return { version: 'authenticated-evaluation-registry-v1', control, registryJson: scope.registry?.json ?? null, registryReceiptJson: scope.registryReceipt?.json ?? null, inventory };
      }
      const frozen = decodeSessionEvaluationHandoff(base.snapshot);
      if (action === 'approval') return { version: 'authenticated-evaluation-approval-v1', control, reviewJson: session?.receipt?.json ?? null, bundleJson: session?.bundle?.json ?? null };
      const latest = await registry(selected, scope);
      return { version: 'authenticated-ended-session-review-v1', control, proposal: checked(() => prepareEndedSessionReview(frozen.context, frozen.session, latest ?? undefined)) };
    },
    async command(context, binding, action: EvaluationMutationAction, raw) {
      const input = parse(authenticatedEvaluationCommandSchema, raw), base = await read(context, binding), selected = base.selected;
      const key = { key: input.key, inputSha256: evaluationCommandInputSha256(binding.sessionId, action, input.payload) };
      const { scope, session } = await controls(selected, binding.sessionId);
      let reviewer: ReturnType<typeof resolveEvaluationReviewer> | undefined;
      const permission: EvaluationReviewerAction | null = action === 'registry' ? 'publish-spec' : action === 'approval' ? 'supply-session' : action === 'withdraw' ? 'withdraw' : null;
      if (permission) {
        if (scope.trust) await options.assertTrustCurrent(selected, scope.trust);
        reviewer = resolveEvaluationReviewer(scope.trust, selected, permission, scope.serverNow);
      }
      const prior = await repository.receipt(selected, key); if (prior) return receipt(prior, binding.sessionId);
      if (action === 'consume') return consume(selected, base.snapshot, input);
      if (action === 'retry') {
        const p = parse(z.object({ jobId: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(), input.payload);
        const projected = await authorizedProjection(selected, base.snapshot, scope, session, await repository.jobProjection(selected, p.jobId));
        if (!projected?.currentApproval) return reject(409, 'F_REVIEW_NOT_CURRENT');
        return receipt(await repository.retry(selected, { ...key, jobId: p.jobId }));
      }
      const cap = options.mintReviewer(selected, { action: permission!, actorId: reviewer!.actorId, publicKeySha256: reviewer!.publicKeySha256,
        control: scope, ...(action === 'registry' ? {} : { sessionId: binding.sessionId }) });
      const precondition = { expectedTrustGeneration: input.expectedTrustGeneration, expectedRegistryGeneration: input.expectedRegistryGeneration };
      await options.observe?.('before-publish', { action, sessionId: binding.sessionId, key: input.key });
      let result: EvaluationCommandReceipt;
      if (action === 'registry') {
        const p = parse(z.object({ registryJson: jsonText, receiptJson: jsonText }).strict(), input.payload), bank = await options.loadPinnedBank(selected, base.snapshot);
        const parsed = checked(() => validateBankScopeReview(json(p.registryJson), base.context, bank, reviewer!.actorId));
        const signed = checked(() => verifyBankScopeReviewReceipt(json(p.receiptJson), parsed, reviewer!.publicKey, Date.parse(scope.serverNow)));
        if (signed.actorId !== reviewer!.actorId) return reject(403, 'F_REVIEW_ACTOR_MISMATCH');
        result = await repository.publishRegistry(selected, { ...key, ...precondition,
          registry: artifact('registry', parsed.contentSha256, p.registryJson), receipt: artifact('registry-receipt', sha(JSON.stringify(signed)), p.receiptJson) }, cap);
      } else if (action === 'approval') {
        const p = parse(z.object({ bundleJson: jsonText, reviewJson: jsonText }).strict(), input.payload), frozen = decodeSessionEvaluationHandoff(base.snapshot);
        const envelope = parse(z.object({ receipt: z.unknown(), proposal: z.unknown() }).strict(), json(p.reviewJson));
        const latest = await registry(selected, scope);
        const validated = checked(() => validateReviewedSessionEvaluationInput({ context: frozen.context, session: frozen.session,
          proposal: envelope.proposal as ReturnType<typeof prepareEndedSessionReview>, bundle: parseApprovedKnowledgeBundle(json(p.bundleJson)),
          receipt: envelope.receipt, currentRegistry: latest ?? undefined, trustedPublicKey: reviewer!.publicKey, now: Date.parse(scope.serverNow) }));
        if (validated.receipt.actorId !== reviewer!.actorId || !latest) return reject(403, 'F_REVIEW_ACTOR_MISMATCH');
        const receiptSha256 = sha(JSON.stringify(validated.receipt));
        // Match the existing local supply boundary: a signed envelope is not
        // enough if its claim spans/packets fail the actual per-unit gate.
        // Missing F evidence remains held; invalid/changed proof is rejected
        // before any current approval or immutable review artifact is written.
        checked(() => createReviewedEvaluationKnowledgeContext(frozen.context, frozen.session, validated.bundle, {
          path: 'evaluation-artifact:' + validated.bundle.contentSha256, fileSha256: sha(p.bundleJson),
          sessionReviewReceiptSha256: receiptSha256, evaluationSpecRegistrySha256: latest.contentSha256, evaluationSpecRegistry: latest,
        }));
        result = await repository.publishApproval(selected, { ...key, ...precondition, sessionId: binding.sessionId,
          expectedApprovalGeneration: input.expectedApprovalGeneration, registrySha256: latest.contentSha256,
          bundle: artifact('bundle', validated.bundle.contentSha256, p.bundleJson), receipt: artifact('session-receipt', receiptSha256, p.reviewJson) }, cap);
      } else {
        const p = parse(z.object({ reason: z.string().min(1).max(600) }).strict(), input.payload);
        result = await repository.withdrawApproval(selected, { ...key, ...precondition, sessionId: binding.sessionId,
          expectedApprovalGeneration: input.expectedApprovalGeneration, reason: p.reason }, cap);
      }
      await options.observe?.('after-publish', { action, sessionId: binding.sessionId, key: input.key }); return receipt(result);
    },
  };
  return { mutations, prepare, reviewReaders };
}

export function createScopedEvaluationService(options: Omit<IsolatedEvaluationServiceOptions, 'environment'> & { authority: ScopedServiceAuthority }) {
  scopedServiceAuthority(options.authority);
  const core = createEvaluationServiceCore(options);
  return { ...core, mutations: bindScopedComponent(options.authority, { ...core.mutations, kind: 'scoped-db-evaluation-writer' as const,
    async command(context:AuthenticatedRequestContext,binding:SessionAccessBinding,action:EvaluationMutationAction,raw:unknown){
      const input=decodeScopedServiceCommand(raw);
      return runScopedCommand(options.authority,context,{generation:input.expectedTransitionGeneration,kind:'http',sessionId:binding.sessionId},()=>core.mutations.command(context,binding,action,input.command));
    },
  }) };
}
