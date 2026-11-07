import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuthenticatedRequestContext, RequestIdentityBoundary } from '../auth/request-identity';
import { RequestAccessError } from '../auth/request-identity';
import { evaluationJobId, type EvaluationJob, type EvaluationJobResult, type EvaluationJobSnapshot } from '../evaluation-job-store';
import { snapshotHash } from '../session-runtime';
import { prepareReviewedEvaluationJobInput } from '../reviewed-evaluation-queue';
import { prepareReviewedEvaluationRevisionReference } from '../evaluation-revisions';
import { evaluationFrozenInputHash } from '../evaluation-history';
import type { InterviewContext } from '../data/load-interview-context';
import type { SessionCommandSnapshot } from '../session-writer/session-command-ports';
import { decodeSessionEvaluationHandoff } from '../evaluation-writer/e-handoff-codec';
import { parseEvaluationReviewTrust } from '../evaluation-writer/review-trust';
import { EvaluationWriterError, type EvaluationWriterRepository, type EvaluationScopeBinding, type EvaluationReviewArtifact,
  type EvaluationArtifactKind, type EvaluationCommandKey, type EvaluationCommandReceipt, type EvaluationScopeControl,
  type EvaluationSessionControl, type EvaluationProjection, type EvaluationTrustAdminCapability, type EvaluationReviewerCapability,
  type EvaluationAdmissionCapability, type EvaluationWorkerCapability, type EvaluationPreservationCapability } from '../evaluation-writer/evaluation-writer-ports';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const sha = /^[a-f0-9]{64}$/u, uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u, revision = /^\d+$/u;
const kinds: readonly EvaluationArtifactKind[] = ['trust', 'registry', 'registry-receipt', 'bundle', 'session-receipt', 'reviewed-context'];
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value === value.trim();
const invalid = () => new EvaluationWriterError(400, 'EVALUATION_COMMAND_INVALID');
const denied = () => new EvaluationWriterError(403, 'EVALUATION_AUTHORITY_REQUIRED');
const absent = () => new EvaluationWriterError(404, 'EVALUATION_NOT_FOUND');
interface FiniteAuthority extends EvaluationScopeBinding { expiresAt: number; checkCurrent(): Promise<boolean> }
export interface EvaluationTrustAdminAuthority extends FiniteAuthority { trustSha256: string }
export interface EvaluationReviewerAuthority extends FiniteAuthority {
  issuer: string; subject: string; actorId: string; publicKeySha256: string;
  action: 'publish-spec' | 'supply-session' | 'withdraw'; expectedTrustGeneration: string; sessionId?: string;
}
export interface EvaluationAdmissionAuthority extends FiniteAuthority { sessionId: string; inputSha256: string; handoffIntentId: string; handoffPayloadSha256: string }
export interface EvaluationWorkerAuthority extends FiniteAuthority { subjectId: string; jobIds: readonly string[] }
export interface EvaluationPreservationAuthority extends FiniteAuthority { sessionId: string; bundleSha256: string }
type Capability = EvaluationTrustAdminCapability | EvaluationReviewerCapability | EvaluationAdmissionCapability | EvaluationWorkerCapability | EvaluationPreservationCapability;
type Authority = EvaluationTrustAdminAuthority | EvaluationReviewerAuthority | EvaluationAdmissionAuthority | EvaluationWorkerAuthority | EvaluationPreservationAuthority;
const authorities = new WeakMap<Capability, Authority>();
function mint<T extends Capability>(kind: T['kind'], input: Authority): T {
  if (![input.ownerId, input.studentId, input.applicationTargetId, input.supportTargetId].every(text) ||
    !Number.isFinite(input.expiresAt) || typeof input.checkCurrent !== 'function') throw denied();
  const value = Object.freeze({ kind }) as T;
  authorities.set(value, Object.freeze({ ...input, checkCurrent: input.checkCurrent.bind(input) })); return value;
}
export function createEvaluationTrustAdminCapability(input: EvaluationTrustAdminAuthority) {
  if (!sha.test(input.trustSha256)) throw denied();
  return mint<EvaluationTrustAdminCapability>('evaluation-trust-admin-capability-v1', input);
}
export function createEvaluationReviewerCapability(input: EvaluationReviewerAuthority) {
  if (![input.issuer, input.subject, input.actorId].every(text) || !sha.test(input.publicKeySha256) ||
    !['publish-spec', 'supply-session', 'withdraw'].includes(input.action) || !revision.test(input.expectedTrustGeneration) ||
    input.sessionId !== undefined && !uuid.test(input.sessionId)) throw denied();
  return mint<EvaluationReviewerCapability>('evaluation-reviewer-capability-v1', input);
}
export function createEvaluationAdmissionCapability(input: EvaluationAdmissionAuthority) {
  if (!uuid.test(input.sessionId) || !uuid.test(input.handoffIntentId) || !sha.test(input.inputSha256) || !sha.test(input.handoffPayloadSha256)) throw denied();
  return mint<EvaluationAdmissionCapability>('evaluation-admission-capability-v1', input);
}
export function createEvaluationWorkerCapability(input: EvaluationWorkerAuthority) {
  if (!text(input.subjectId) || !input.jobIds.length || input.jobIds.length > 64 || input.jobIds.some(id => !sha.test(id))) throw denied();
  return mint<EvaluationWorkerCapability>('evaluation-worker-capability-v1', { ...input, jobIds: Object.freeze([...new Set(input.jobIds)]) });
}
export function createEvaluationPreservationCapability(input: EvaluationPreservationAuthority) {
  if (!uuid.test(input.sessionId) || !sha.test(input.bundleSha256)) throw denied();
  return mint<EvaluationPreservationCapability>('evaluation-preservation-capability-v1', input);
}
function sameScope(value: EvaluationScopeBinding, context: AuthenticatedRequestContext) {
  if (!context.scope || value.ownerId !== context.account.ownerId || value.studentId !== context.scope.studentId ||
    value.applicationTargetId !== context.scope.applicationTargetId || value.supportTargetId !== context.scope.supportTargetId ||
    Object.hasOwn(value, 'sourceRevision') !== Object.hasOwn(context.scope, 'sourceRevision') || value.sourceRevision !== context.scope.sourceRevision) throw denied();
}
function parseJson(value: unknown, max = 16 * 1024 * 1024): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max || value.length < 2) throw invalid();
  try { JSON.parse(value); } catch { throw invalid(); } return value;
}
function artifact(value: EvaluationReviewArtifact, expected?: EvaluationArtifactKind) {
  if (!value || !kinds.includes(value.kind) || expected && value.kind !== expected || !sha.test(value.contentSha256) ||
    !sha.test(value.rawSha256) || hash(parseJson(value.json)) !== value.rawSha256) throw invalid(); return value;
}
function key(value: EvaluationCommandKey) {
  if (!value || !/^[A-Za-z0-9._:-]{1,160}$/u.test(value.key) || !sha.test(value.inputSha256)) throw invalid();
}
function job(value: unknown): EvaluationJob | null {
  if (value === null) return null;
  const result = typeof value === 'string' ? JSON.parse(value) as EvaluationJob : value as EvaluationJob;
  if (result.version !== 1 || !sha.test(result.id) || result.id !== evaluationJobId(result.sessionId, result.ownerId, result.sourceSha256, result.pipelineVersion) ||
    ![result.sourceSha256, result.snapshotSha256, result.contextSnapshotSha256].every(s => sha.test(s)) || !text(result.model) || !text(result.pipelineVersion) ||
    !['queued', 'running', 'completed', 'failed', 'review_required'].includes(result.status) || !Array.isArray(result.checkpoints) || !Array.isArray(result.usage)) throw invalid();
  return result;
}
function receipt(value: unknown): EvaluationCommandReceipt | null {
  if (value === null) return null; const result = value as EvaluationCommandReceipt; key(result);
  if (!uuid.test(result.operationId) || result.sessionId !== null && !uuid.test(result.sessionId) || !text(result.action) || !sha.test(result.resultSha256) || hash(parseJson(result.resultJson)) !== result.resultSha256 ||
    typeof result.replay !== 'boolean' || !Number.isFinite(Date.parse(result.committedAt))) throw invalid(); return result;
}
function control(value: unknown, context: AuthenticatedRequestContext): EvaluationScopeControl {
  const result = value as EvaluationScopeControl;
  if (!result || !revision.test(result.trustGeneration) || !revision.test(result.registryGeneration) || !Number.isFinite(Date.parse(result.serverNow))) throw invalid();
  sameScope(result.binding, context);
  if (result.trust) artifact(result.trust, 'trust'); if (result.registry) artifact(result.registry, 'registry'); if (result.registryReceipt) artifact(result.registryReceipt, 'registry-receipt'); return result;
}
function sessionControl(value: unknown): EvaluationSessionControl | null {
  if (value === null) return null; const result = value as EvaluationSessionControl;
  if (!uuid.test(result.sessionId) || !['db', 'read-only'].includes(result.writer) || !revision.test(result.fence) || !revision.test(result.approvalGeneration) ||
    typeof result.approvalRevoked !== 'boolean') throw invalid();
  if (result.receipt) artifact(result.receipt, 'session-receipt'); if (result.bundle) artifact(result.bundle, 'bundle'); return result;
}
function projection(value: unknown): EvaluationProjection | null {
  if (value === null) return null; const result = value as EvaluationProjection & { jobJson?: string | null; resultJson?: string | null };
  if (result.version !== 'authenticated-evaluation-projection-v1' || !uuid.test(result.sessionId) || typeof result.currentApproval !== 'boolean') throw invalid();
  result.control = sessionControl(result.control); result.job = job(result.jobJson ?? result.job ?? null);
  if (result.resultJson) {
    const parsed = JSON.parse(result.resultJson) as EvaluationJobResult;
    if (!result.job || parsed.version !== 1 || parsed.jobId !== result.job.id || parsed.sourceSha256 !== result.job.sourceSha256 ||
      parsed.snapshotSha256 !== result.job.snapshotSha256 || parsed.pipelineVersion !== result.job.pipelineVersion || parsed.model !== result.job.model ||
      snapshotHash(parsed) !== result.job.resultSha256) throw invalid(); result.result = parsed;
  } else result.result = null;
  if (result.revisionJson && hash(parseJson(result.revisionJson)) !== result.revisionRawSha256) throw invalid(); return result;
}
const settings = ['issuer', 'subject', 'account_id', 'account_revision', 'owner_id', 'student_id', 'application_target_id', 'job_id', 'worker_subject', 'reviewer_actor', 'reviewer_key', 'reviewer_action'];
function sqlError(error: unknown, committed: boolean): Error {
  if (error instanceof RequestAccessError || error instanceof EvaluationWriterError) return error;
  const code = (error as { code?: string })?.code;
  const known: Record<string, [number, string]> = {
    '42501': [404, 'EVALUATION_NOT_FOUND'], P7201: [409, 'EVALUATION_IDEMPOTENCY_CONFLICT'], P7202: [409, 'EVALUATION_REVIEW_GENERATION_CHANGED'],
    P7203: [409, 'EVALUATION_LEASE_LOST'], P7204: [409, 'EVALUATION_WRITER_FROZEN'], P7205: [409, 'EVALUATION_INPUT_CHANGED'],
    '22023': [400, 'EVALUATION_COMMAND_INVALID'], '22P02': [400, 'EVALUATION_COMMAND_INVALID'], '23505': [409, 'EVALUATION_IDEMPOTENCY_CONFLICT'],
    '23503': [409, 'EVALUATION_BINDING_CHANGED'], '23514': [409, 'EVALUATION_INVARIANT_CONFLICT'], '57014': [503, 'EVALUATION_DATABASE_TIMEOUT'],
    '55P03': [503, 'EVALUATION_DATABASE_TIMEOUT'], '40P01': [409, 'EVALUATION_REVIEW_GENERATION_CHANGED'],
  };
  return code && known[code] ? new EvaluationWriterError(...known[code]) : new EvaluationWriterError(503, committed ? 'EVALUATION_COMMIT_UNKNOWN' : 'EVALUATION_DATABASE_UNAVAILABLE');
}

/** Explicit owned-isolation composition. It never consults operating env URLs,
 * invents a local directory, scans pending owners, or owns provider calls. */
export function createPostgresEvaluationWriter(options: {
  boundary: RequestIdentityBoundary; requestPool: Pool; mappingPool?: Pool; workerPool?: Pool;
  environment: 'isolated-evaluation-writer'; now?: () => number; statementTimeoutMs?: number;
}): EvaluationWriterRepository {
  if (options.environment !== 'isolated-evaluation-writer' || process.env.NODE_ENV === 'production') throw denied();
  const now = options.now ?? Date.now, timeout = options.statementTimeoutMs ?? 5000, { boundary } = options;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000) throw invalid();
  async function current(context: AuthenticatedRequestContext) {
    const selected = await boundary.revalidate(context); if (selected.mode !== 'authenticated' || !selected.scope) throw denied(); return selected;
  }
  async function permit(context: AuthenticatedRequestContext, capability: Capability, expectedKind?: Capability['kind']) {
    const value = authorities.get(capability);
    if (!value || expectedKind && capability.kind !== expectedKind || now() >= value.expiresAt) throw denied();
    sameScope(value, context); let valid = false; try { valid = await value.checkCurrent(); } catch { /* fail closed */ }
    if (!valid || now() >= value.expiresAt) throw denied(); return value;
  }
  async function tx<T>(context: AuthenticatedRequestContext, role: 'gakja_request' | 'gakja_mapping' | 'gakja_worker', query: string, values: unknown[],
    validate: (value: unknown, context: AuthenticatedRequestContext) => T, capability?: Capability, extras: Partial<Record<typeof settings[number], string>> = {}) {
    const selected = await current(context); if (capability) await permit(selected, capability);
    const pool = role === 'gakja_mapping' ? options.mappingPool : role === 'gakja_worker' ? options.workerPool : options.requestPool;
    if (!pool) throw denied();
    let client: PoolClient | undefined, begun = false, healthy = true, committing = false, result: T;
    try {
      client = await pool.connect(); boundary.selectScope(selected, {});
      const r = (await client.query(`SELECT current_user::text current,session_user::text session,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
        EXISTS(SELECT 1 FROM pg_roles p WHERE (p.rolsuper OR p.rolbypassrls OR p.rolname='gakja_owner') AND pg_has_role(current_user,p.oid,'MEMBER')) elevated FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
      if (!r || r.current !== role || r.session !== role || r.rolsuper || r.rolbypassrls || r.rolcreaterole || r.rolcreatedb || r.elevated) throw denied();
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); begun = true;
      const vars: Record<typeof settings[number], string> = { issuer: selected.principal.issuer, subject: selected.principal.subject,
        account_id: selected.account.accountId, account_revision: selected.account.revision, owner_id: selected.account.ownerId,
        student_id: selected.scope!.studentId, application_target_id: selected.scope!.applicationTargetId, job_id: '', worker_subject: '', reviewer_actor: '', reviewer_key: '', reviewer_action: '', ...extras };
      for (const name of settings) await client.query('SELECT set_config($1,$2,true)', ['gakja.' + name, vars[name]]);
      await client.query("SELECT set_config('statement_timeout',$1,true)", [String(timeout)]);
      // The retained worker role has no general account-discovery grant. F's
      // narrow worker SQL repeats account/principal/grant checks internally.
      if (role !== 'gakja_worker') {
        const account = (await client.query('SELECT gakja.resolve_account($1,$2) value', [selected.principal.issuer, selected.principal.subject])).rows[0]?.value;
        if (!account || account.accountId !== selected.account.accountId || account.ownerId !== selected.account.ownerId || account.revision !== selected.account.revision) throw denied();
      }
      result = validate((await client.query(query, values)).rows[0]?.value ?? null, selected);
      boundary.selectScope(selected, {}); committing = true; await client.query('COMMIT'); begun = false;
    } catch (cause) {
      if (client && begun) try { await client.query('ROLLBACK'); } catch { healthy = false; } throw sqlError(cause, committing);
    } finally {
      if (client) {
        try { await client.query('RESET ALL'); healthy = healthy && (await client.query(`SELECT ${settings.map((_, i) => `coalesce(current_setting($${i + 1},true),'')=''`).join(' AND ')} clean`, settings.map(k => 'gakja.' + k))).rows[0]?.clean === true; } catch { healthy = false; }
        client.release(!healthy);
      }
    }
    await current(selected); if (capability) await permit(selected, capability); return result;
  }
  const required = <T>(value: T | null): T => { if (value === null) throw absent(); return value; };
  async function reviewer(context: AuthenticatedRequestContext, capability: EvaluationReviewerCapability, action: EvaluationReviewerAuthority['action'], expectedTrustGeneration: string, sessionId?: string) {
    const value = await permit(await current(context), capability, 'evaluation-reviewer-capability-v1') as EvaluationReviewerAuthority;
    if (value.action !== action || value.expectedTrustGeneration !== expectedTrustGeneration || value.issuer !== context.principal.issuer || value.subject !== context.principal.subject || value.sessionId !== sessionId) throw denied();
    return { reviewer_actor: value.actorId, reviewer_key: value.publicKeySha256, reviewer_action: value.action };
  }
  const repository: EvaluationWriterRepository = {
    scopeControl: context => tx(context, 'gakja_request', 'SELECT gakja.evaluation_scope_control() value', [], control),
    sessionControl: (context, sessionId) => uuid.test(sessionId) ? tx(context, 'gakja_request', 'SELECT gakja.evaluation_session_control($1) value', [sessionId], sessionControl) : Promise.resolve(null),
    readArtifact(context, kind, contentSha256) {
      if (!kinds.includes(kind) || !sha.test(contentSha256)) throw invalid();
      return tx(context, 'gakja_request', 'SELECT gakja.evaluation_read_artifact($1,$2) value', [kind, contentSha256], v => v === null ? null : artifact(v as EvaluationReviewArtifact, kind));
    },
    async installTrust(context, input, capability) {
      key(input); artifact(input.trust, 'trust'); if (!revision.test(input.expectedTrustGeneration)) throw invalid();
      const value = await permit(await current(context), capability, 'evaluation-trust-admin-capability-v1') as EvaluationTrustAdminAuthority;
      if (value.trustSha256 !== input.trust.contentSha256) throw denied();
      parseEvaluationReviewTrust(input.trust, context);
      return required(await tx(context, 'gakja_mapping', 'SELECT gakja.evaluation_install_trust($1::jsonb) value', [JSON.stringify(input)], receipt, capability));
    },
    async publishRegistry(context, input, capability) {
      key(input); artifact(input.registry, 'registry'); artifact(input.receipt, 'registry-receipt');
      return required(await tx(context, 'gakja_request', 'SELECT gakja.evaluation_publish_registry($1::jsonb) value', [JSON.stringify(input)], receipt, capability, await reviewer(context, capability, 'publish-spec', input.expectedTrustGeneration)));
    },
    async publishApproval(context, input, capability) {
      key(input); artifact(input.bundle, 'bundle'); artifact(input.receipt, 'session-receipt'); if (!uuid.test(input.sessionId) || !sha.test(input.registrySha256)) throw invalid();
      return required(await tx(context, 'gakja_request', 'SELECT gakja.evaluation_publish_approval($1::jsonb) value', [JSON.stringify(input)], receipt, capability, await reviewer(context, capability, 'supply-session', input.expectedTrustGeneration, input.sessionId)));
    },
    async withdrawApproval(context, input, capability) {
      key(input); if (!uuid.test(input.sessionId) || !text(input.reason)) throw invalid();
      return required(await tx(context, 'gakja_request', 'SELECT gakja.evaluation_withdraw_approval($1::jsonb) value', [JSON.stringify(input)], receipt, capability, await reviewer(context, capability, 'withdraw', input.expectedTrustGeneration, input.sessionId)));
    },
    async consume(context, input, capability) {
      key(input); const authority = await permit(await current(context), capability, 'evaluation-admission-capability-v1') as EvaluationAdmissionAuthority;
      if (authority.sessionId !== input.sessionId || authority.inputSha256 !== input.inputSha256 || authority.handoffIntentId !== input.handoffIntentId || authority.handoffPayloadSha256 !== input.handoffPayloadSha256) throw denied();
      const original = decodeSessionEvaluationHandoff(required(await tx(context, 'gakja_request', 'SELECT gakja.session_read($1) value', [input.sessionId], value => value as SessionCommandSnapshot | null)));
      if (original.handoff.intentId !== input.handoffIntentId || original.handoff.payloadSha256 !== input.handoffPayloadSha256 || original.payload.contextSnapshotSha256 !== input.originalContextSnapshotSha256 || original.payload.frozenSessionSha256 !== input.frozenSessionSha256) throw invalid();
      if (input.registration) {
        const r = input.registration; artifact(r.reviewedContext, 'reviewed-context');
        const reference = JSON.parse(parseJson(r.revisionJson)), { contentSha256, ...referenceBody } = reference;
        const derived = prepareReviewedEvaluationJobInput(JSON.parse(r.reviewedContext.json) as InterviewContext, original.session, original.context, r.model);
        const expectedReference = prepareReviewedEvaluationRevisionReference({ originalSession: original.session,
          job: { id: r.jobId, sourceSha256: r.sourceSha256, snapshotSha256: r.snapshotSha256, pipelineVersion: r.pipelineVersion, model: r.model },
          receiptSha256: input.approvalSha256!, receiptIssuedAt: reference.receiptIssuedAt, originalContextSnapshotSha256: original.payload.contextSnapshotSha256,
          reviewedContextSnapshotSha256: derived.contextSnapshotSha256, sessionFrozenInputSha256: evaluationFrozenInputHash(original.session) });
        if (hash(parseJson(r.snapshotJson)) !== r.snapshotSha256 || snapshotHash(JSON.parse(r.snapshotJson)) !== r.snapshotSha256 || hash(r.revisionJson) !== r.revisionRawSha256 ||
          contentSha256 !== r.revisionSha256 || snapshotHash(referenceBody) !== r.revisionSha256 || expectedReference.contentSha256 !== r.revisionSha256 ||
          r.jobId !== evaluationJobId(input.sessionId, context.account.ownerId, r.sourceSha256, r.pipelineVersion) || r.jobId !== derived.jobId || r.sourceSha256 !== derived.sourceSha256 ||
          r.snapshotJson !== derived.snapshotJson || r.snapshotSha256 !== derived.snapshotSha256 || r.reviewedContext.contentSha256 !== derived.contextSnapshotSha256 || r.pipelineVersion !== derived.pipelineVersion) throw invalid();
      }
      return required(await tx(context, 'gakja_request', 'SELECT gakja.evaluation_consume($1::jsonb) value', [JSON.stringify(input)], receipt, capability));
    },
    projection: (context, sessionId) => uuid.test(sessionId) ? tx(context, 'gakja_request', 'SELECT gakja.evaluation_projection($1,NULL) value', [sessionId], projection) : Promise.resolve(null),
    jobProjection: (context, id) => sha.test(id) ? tx(context, 'gakja_request', 'SELECT gakja.evaluation_projection(NULL,$1) value', [id], projection) : Promise.resolve(null),
    getJob: (context, id) => sha.test(id) ? tx(context, 'gakja_request', 'SELECT gakja.evaluation_get_job($1,false) value', [id], job) : Promise.resolve(null),
    receipt(context, query) { key(query); return tx(context, 'gakja_request', 'SELECT gakja.evaluation_receipt($1,$2) value', [query.key, query.inputSha256], receipt); },
    async retry(context, input) { key(input); if (!sha.test(input.jobId)) throw invalid(); return required(await tx(context, 'gakja_request', 'SELECT gakja.evaluation_retry($1::jsonb) value', [JSON.stringify(input)], receipt)); },
    async grantWorker(context, capability) {
      const value = await permit(await current(context), capability, 'evaluation-worker-capability-v1') as EvaluationWorkerAuthority;
      await tx(context, 'gakja_mapping', 'SELECT gakja.evaluation_grant_worker($1::jsonb) value', [JSON.stringify({ subjectId: value.subjectId, jobIds: value.jobIds, expiresAt: new Date(value.expiresAt).toISOString() })], () => undefined, capability);
    },
    workerJobs(context, capability) {
      const cap = authorities.get(capability) as EvaluationWorkerAuthority | undefined;
      if (!cap || capability.kind !== 'evaluation-worker-capability-v1') throw denied(); sameScope(cap, context);
      async function worker<T>(id: string, action: string, payload: unknown, validate: (value: unknown) => T) {
        const currentCap = await permit(await current(context), capability, 'evaluation-worker-capability-v1') as EvaluationWorkerAuthority;
        if (!sha.test(id) || !currentCap.jobIds.includes(id)) throw denied();
        return tx(context, 'gakja_worker', 'SELECT gakja.evaluation_worker($1,$2,$3::jsonb) value', [id, action, JSON.stringify(payload)], validate, capability, { job_id: id, worker_subject: currentCap.subjectId });
      }
      return {
        get: id => worker(id, 'get', {}, job),
        snapshot: async selected => worker(selected.id, 'snapshot', {}, value => {
          const json = parseJson(value), parsed = JSON.parse(json) as EvaluationJobSnapshot;
          if (hash(json) !== selected.snapshotSha256 || snapshotHash(parsed) !== selected.snapshotSha256 || parsed.version !== 1 || parsed.ownerId !== selected.ownerId || parsed.contextSnapshotSha256 !== selected.contextSnapshotSha256 || parsed.session.id !== selected.sessionId) throw invalid(); return parsed;
        }),
        claim: (id, workerId, _now, leaseMs = 60_000) => worker(id, 'claim', { workerId, leaseMs }, job),
        renew: async (id, token, _now, leaseMs = 60_000) => required(await worker(id, 'renew', { token, leaseMs }, job)),
        checkpoint: async (id, token, checkpoint) => required(await worker(id, 'checkpoint', { token, checkpointJson: JSON.stringify(checkpoint) }, job)),
        recordUsage: async (id, token, attemptId, observation) => required(await worker(id, 'usage', { token, attemptId, observationJson: JSON.stringify(observation) }, job)),
        complete: async (id, token, evaluation) => {
          const metadata = await worker(id, 'completion-metadata', { token }, value => {
            const parsed = JSON.parse(parseJson(value)) as { jobJson: string; serverNow: string };
            const selected = required(job(parsed.jobJson)); if (!Number.isFinite(Date.parse(parsed.serverNow))) throw invalid(); return { selected, serverNow: parsed.serverNow };
          });
          const selected = metadata.selected;
          const result: EvaluationJobResult = { version: 1, jobId: id, sourceSha256: selected.sourceSha256, snapshotSha256: selected.snapshotSha256,
            pipelineVersion: selected.pipelineVersion, model: selected.model, evaluation, completedAt: metadata.serverNow };
          const resultJson = JSON.stringify(result);
          return required(await worker(id, 'complete', { token, resultJson, rawSha256: hash(resultJson), resultSha256: snapshotHash(result) }, job));
        },
        requireReview: async (id, token, reasons) => required(await worker(id, 'review', { token, reasons }, job)),
        fail: async (id, token, error, _now, maxAttempts = 3) => required(await worker(id, 'fail', { token, error, maxAttempts }, job)),
      };
    },
    async freeze(context, sessionId, expectedFence) { if (!uuid.test(sessionId) || !revision.test(expectedFence)) throw invalid(); return required(await tx(context, 'gakja_request', 'SELECT gakja.evaluation_freeze($1,$2::bigint) value', [sessionId, expectedFence], sessionControl)); },
    async exportPreservation(context, sessionId) {
      if (!uuid.test(sessionId)) throw invalid();
      const payloadJson = await tx(context, 'gakja_request', 'SELECT gakja.evaluation_export($1)::text value', [sessionId], value => parseJson(value, 64 * 1024 * 1024));
      return { version: 'evaluation-preservation-v1', payloadJson, sha256: hash(payloadJson) };
    },
    async restorePreservation(context, bundle, capability) {
      const value = await permit(await current(context), capability, 'evaluation-preservation-capability-v1') as EvaluationPreservationAuthority;
      if (bundle.version !== 'evaluation-preservation-v1' || hash(parseJson(bundle.payloadJson, 64 * 1024 * 1024)) !== bundle.sha256 || value.bundleSha256 !== bundle.sha256) throw denied();
      const parsed = JSON.parse(bundle.payloadJson); if (parsed.sessionId !== value.sessionId) throw denied();
      return required(await tx(context, 'gakja_mapping', 'SELECT gakja.evaluation_restore($1::jsonb) value', [bundle.payloadJson], projection, capability));
    },
  };
  return Object.freeze(repository);
}
