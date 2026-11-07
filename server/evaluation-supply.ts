import { assertLocalInternalExecution } from './internal-execution';
import { verify } from 'node:crypto';
import { z } from 'zod';
import type { InterviewContext } from './data/load-interview-context';
import type { InterviewSession } from './protocol';
import { assertSessionOwner, assertAuthenticatedSessionOwner, AUTHENTICATED_SESSION_RUNTIME_VERSION, snapshotHash } from './session-runtime';
import { evaluationFrozenInputHash } from './evaluation-history';
import { buildEvaluationUnits, assertEvaluationQuestionContracts } from './providers/evaluation-turns';
import { parseBankScopeRegistry, loadBankScopeRegistry, loadBankScopeRegistryFromReader, findExactQuestionEvaluationSpec, type QuestionEvaluationSpecRegistry } from './data/evaluation-scope-registry';
import { freezeKnowledge, knowledgeHash, knowledgeSessionQuestionAnswerHash, parseApprovedKnowledgeBundle, type ApprovedKnowledgeBundle } from './data/approved-knowledge';
import { createReviewedEvaluationKnowledgeContext } from './data/reviewed-evaluation-context';
import { enqueueReviewedKnowledgeEvaluation } from './reviewed-evaluation-queue';
import { createLocalEvaluationJobStore } from './evaluation-job-store';
import type { EvaluationRepository } from './repositories/evaluation-job-ports';
import type { ReviewRepository } from './repositories/review-ports';
import { createLocalReviewRepository } from './repositories/local-review-repository';
import type { EvaluationRevisionRepository } from './repositories/evaluation-revision-ports';
import { createLocalSessionStore } from './storage/local-session-store';
import type { SessionStore } from './storage/session-store';

export const ENDED_SESSION_REVIEW_VERSION = 'ended-session-evaluation-review-v1';
const hash = (value: unknown) => knowledgeHash(JSON.stringify(value));
export function prepareEndedSessionReview(context: InterviewContext, session: InterviewSession,
  registry: QuestionEvaluationSpecRegistry | undefined = context.evaluationScopeRegistry) {
  if (!session.runtime || session.status === 'active' || !session.runtime.evaluationInputFrozenAt || snapshotHash(context) !== session.runtime.contextSnapshotSha256) throw new Error('EVALUATION_FROZEN_ENDED_INPUT_REQUIRED');
  assertEvaluationQuestionContracts(session);
  const checked = registry ? parseBankScopeRegistry(registry) : undefined;
  const ownerId = session.runtime.owner.id, studentId = context.student.studentId ?? null, targetScopeSha256 = hash(context.target);
  const { interviewPlan, ...sessionManifest } = session.sourceManifest as InterviewContext['manifest'] & { interviewPlan?: unknown };
  const planIdentity = (value: unknown) => {
    const plan = value as InterviewSession['plan'];
    return { poolKey: plan?.poolKey ?? null, poolContentSha256: plan?.poolContentSha256 ?? null, policyVersion: plan?.policyVersion ?? null,
      selectionPolicyVersion: plan?.selectionPolicyVersion ?? null, durationSeconds: plan?.durationSeconds ?? null,
      purpose: plan?.purpose ?? null, mode: plan?.mode ?? null, ownerTargetScope: plan?.selectionContext?.scope ?? null };
  };
  if (hash(sessionManifest) !== hash(context.manifest) || interviewPlan !== undefined && hash(planIdentity(interviewPlan)) !== hash(planIdentity(session.plan))) throw new Error('EVALUATION_SESSION_MANIFEST_CHANGED');
  const scopeMatches = checked && checked.ownerId === ownerId && checked.studentId === studentId && checked.targetScopeSha256 === targetScopeSha256 &&
    checked.sourceManifestSha256 === hash(context.manifest);
  const units = buildEvaluationUnits(session).scoredUnits.map(unit => {
    const turn = unit.turn, contract = turn.metadata.approvedQuestion;
    const candidate = scopeMatches ? findExactQuestionEvaluationSpec(context, session, turn, checked) : undefined;
    return { turnId: turn.id, questionKind: turn.questionKind, parentMainQuestionId: turn.parentMainQuestionId,
      questionText: turn.questionText, questionSha256: knowledgeHash(turn.questionText), approvedContractSha256: contract?.contentSha256 ?? null,
      reviewedDemand: { start: 0, end: turn.questionText.length, quote: turn.questionText, sha256: knowledgeHash(turn.questionText) },
      specification: candidate ? { evaluationSpecId: candidate.evaluationSpecId, revision: candidate.revision, reviewStatus: candidate.review.status,
        bankContractSha256: candidate.bankContractSha256, scope: candidate.scope, reviewedDemand: candidate.reviewedDemand,
        assessableCriteria: candidate.assessableCriteria, excludedCriteria: candidate.excludedCriteria, packetRefs: candidate.packetRefs,
        evidenceExpectations: candidate.evidenceExpectations } : null,
      holdReasons: turn.questionKind === 'main' && (!candidate || candidate.review.status !== 'approved') ? ['QUESTION_EVALUATION_SPEC_APPROVAL_REQUIRED'] : [],
      answerAttempts: unit.answerAttempts.map(attempt => ({ ...attempt, answerSha256: knowledgeHash(attempt.rawTranscript) })),
      clarificationTurnIds: unit.clarificationTurnIds,
      presentations: (session.questionPresentations ?? []).filter(item => item.turnId === turn.id || unit.clarificationTurnIds.includes(item.turnId)),
      reviewStatus: 'pending' as const, approverId: null,
    };
  });
  const body = { version: ENDED_SESSION_REVIEW_VERSION, status: 'pending' as const, ownerId, studentId, targetScopeSha256,
    sessionId: session.id, contextSnapshotSha256: session.runtime.contextSnapshotSha256, sessionSnapshotSha256: evaluationFrozenInputHash(session),
    sessionQuestionAnswerSha256: knowledgeSessionQuestionAnswerHash(session), sourceManifestSha256: hash(session.sourceManifest),
    registrySha256: checked?.contentSha256 ?? null, units };
  return freezeKnowledge({ ...body, contentSha256: hash(body) });
}
export type EndedSessionReviewProposal = ReturnType<typeof prepareEndedSessionReview>;
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const receiptSchema = z.object({ version: z.literal('authenticated-session-evaluation-review-v1'), actorId: z.string().min(1),
  action: z.literal('approve_session_evaluation'), proposalSha256: sha, bundleSha256: sha, sessionId: z.string().min(1),
  sessionQuestionAnswerSha256: sha, contextSnapshotSha256: sha, issuedAt: z.string().datetime(), expiresAt: z.string().datetime(), signature: z.string().min(1) }).strict();
export type SessionEvaluationReviewReceipt = z.infer<typeof receiptSchema>;

export interface ReviewedSessionEvaluationInputOptions {
  context: InterviewContext; session: InterviewSession; proposal: EndedSessionReviewProposal;
  bundle: ApprovedKnowledgeBundle; receipt: unknown; currentRegistry?: QuestionEvaluationSpecRegistry;
  trustedPublicKey: string | undefined; now?: number;
}
/** Exact existing B-stage domain checks, with no storage, authority minting,
 * enqueue or environment-key lookup. Authenticated callers separately provide
 * current reviewer/account authority and atomically bind the returned evidence.
 * JSON/signature/hash targets and the existing issued-vs-stored expiry rules
 * are retained. A valid signature alone is not service reviewer authorization. */
export function validateReviewedSessionEvaluationInput(options: ReviewedSessionEvaluationInputOptions) {
  const { context, session } = options, latest = options.currentRegistry;
  if ((latest?.contentSha256 ?? null) !== options.proposal.registrySha256) throw new Error('EVALUATION_SPEC_REVISION_CHANGED');
  const expected = prepareEndedSessionReview(context, session, latest);
  if (JSON.stringify(expected) !== JSON.stringify(options.proposal)) throw new Error('EVALUATION_SESSION_REVIEW_INPUT_CHANGED');
  const bundle = parseApprovedKnowledgeBundle(options.bundle), receipt = receiptSchema.parse(options.receipt), { signature, ...payload } = receipt;
  const publicKey = options.trustedPublicKey;
  if (!publicKey || Date.parse(receipt.issuedAt) > (options.now ?? Date.now()) || Date.parse(receipt.expiresAt) <= (options.now ?? Date.now()) ||
    receipt.proposalSha256 !== expected.contentSha256 || receipt.bundleSha256 !== bundle.contentSha256 || receipt.sessionId !== session.id ||
    receipt.sessionQuestionAnswerSha256 !== expected.sessionQuestionAnswerSha256 || receipt.contextSnapshotSha256 !== expected.contextSnapshotSha256 ||
    !verify(null, Buffer.from(JSON.stringify(payload)), publicKey, Buffer.from(signature, 'base64'))) throw new Error('AUTHENTICATED_SESSION_REVIEW_RECEIPT_REQUIRED');
  if (session.runtime?.version === AUTHENTICATED_SESSION_RUNTIME_VERSION) assertAuthenticatedSessionOwner(session, expected.ownerId);
  else assertSessionOwner(session, expected.ownerId);
  for (const item of [...bundle.packets, ...bundle.bindings]) if (item.approval.status !== 'approved' || item.approval.approverId !== receipt.actorId) throw new Error('SESSION_REVIEW_ACTOR_MISMATCH');
  for (const binding of bundle.bindings) {
    const unit = expected.units.find(item => item.turnId === binding.turnId);
    if (!unit || binding.sessionId !== session.id || binding.sessionQuestionAnswerSha256 !== expected.sessionQuestionAnswerSha256 ||
      binding.questionSha256 !== unit.questionSha256 || binding.approvedContractSha256 !== unit.approvedContractSha256) throw new Error('SESSION_REVIEW_BINDING_CHANGED');
    if (unit.questionKind === 'main') {
      const spec = unit.specification;
      if (!spec || spec.reviewStatus !== 'approved' || unit.holdReasons.length) throw new Error('QUESTION_EVALUATION_SPEC_APPROVAL_REQUIRED');
      if (spec.scope !== binding.scope || JSON.stringify(spec.reviewedDemand) !== JSON.stringify(binding.reviewedDemand) ||
        spec.packetRefs.length !== binding.packetRefs.length || spec.packetRefs.some(ref => !binding.packetRefs.some(item => JSON.stringify(item) === JSON.stringify(ref)))) throw new Error('SESSION_REVIEW_SPEC_SCOPE_MISMATCH');
    }
  }
  return { expected, bundle, receipt };
}

/** B-stage authority: the signed review covers the actual frozen session and
 * actual ApprovedKnowledgeBundle. A-stage approval is never copied here. */
export async function supplyReviewedSessionEvaluation(options: {
  context: InterviewContext; session: InterviewSession; proposal: EndedSessionReviewProposal; bundle: ApprovedKnowledgeBundle; receipt: unknown;
  root?: string; trustedPublicKey?: string; enqueue?: boolean; model?: string; currentRegistry?: QuestionEvaluationSpecRegistry; sessions?: SessionStore;
  jobs?: EvaluationRepository; reviews?: ReviewRepository; revisions?: EvaluationRevisionRepository;
}) {
  assertLocalInternalExecution();
  const { context, session } = options, root = options.root ?? process.cwd(), reviews = options.reviews ?? createLocalReviewRepository(root);
  const latest = options.currentRegistry ?? (options.root ? await loadBankScopeRegistry(root, options.trustedPublicKey, reviews) ?? undefined : context.evaluationScopeRegistry);
  const { expected, bundle, receipt } = validateReviewedSessionEvaluationInput({ context, session, proposal: options.proposal,
    bundle: options.bundle, receipt: options.receipt, currentRegistry: latest,
    trustedPublicKey: options.trustedPublicKey ?? process.env.EVALUATION_SCOPE_REVIEW_PUBLIC_KEY });
  assertSessionOwner(session, expected.ownerId);
  const content = JSON.stringify(bundle, null, 2), relative = reviews.knowledgeRevisionPath(bundle.contentSha256), receiptHash = hash(receipt);
  const projection = createReviewedEvaluationKnowledgeContext(context, session, bundle, { path: relative, fileSha256: knowledgeHash(content),
    sessionReviewReceiptSha256: receiptHash, ...(expected.registrySha256 ? { evaluationSpecRegistrySha256: expected.registrySha256, evaluationSpecRegistry: latest } : {}) });
  const sessions = options.sessions ?? createLocalSessionStore(root);
  if (options.enqueue) {
    // A signed receipt cannot authorize replacing an original or choosing an
    // unrelated base context. The existing adapter verifies stored derivation.
    const original = await sessions.load(session.id, expected.ownerId);
    if (!original || evaluationFrozenInputHash(original) !== expected.sessionSnapshotSha256) throw new Error('EVALUATION_STORED_INPUT_CHANGED');
  }
  await reviews.writeKnowledgeRevision(bundle.contentSha256, content);
  await reviews.writeSessionReceipt(receiptHash, JSON.stringify({ receipt, proposal: expected }, null, 2));
  const queued = options.enqueue ? await enqueueReviewedKnowledgeEvaluation(projection.context, session, {
    jobs: options.jobs ?? createLocalEvaluationJobStore(root), sessions, model: options.model,
  }) : null;
  if (queued) {
    const { appendReviewedEvaluationRevision } = await import('./evaluation-revisions');
    await appendReviewedEvaluationRevision({ root, originalSession: session, job: queued.job, receiptSha256: receiptHash,
      receiptIssuedAt: receipt.issuedAt, originalContextSnapshotSha256: queued.originalContextSnapshotSha256,
      reviewedContextSnapshotSha256: queued.contextSnapshotSha256, sessionFrozenInputSha256: expected.sessionSnapshotSha256,
      trustedPublicKey: options.trustedPublicKey, sessions, jobs: options.jobs, reviews, revisions: options.revisions });
  }
  return { passed: true, providerCalls: 0, context: projection.context, decisions: projection.decisions, receiptSha256: receiptHash,
    jobId: queued?.job.id ?? null, contextSnapshotSha256: queued?.contextSnapshotSha256 ?? snapshotHash(projection.context),
    heldTurns: projection.decisions.filter(item => item.holdReasons.length).map(({ turnId, holdReasons }) => ({ turnId, holdReasons })),
    originalSessionModified: false, originalContextModified: false };
}

/** Re-check authenticated actual-session approval and latest spec withdrawal
 * before execution and again before result publication. No approval is minted. */
export interface StoredSessionEvaluationReviewReaders {
  loadContext(sha256: string, ownerId: string): Promise<InterviewContext>;
  reviews: Pick<ReviewRepository, 'readSessionReceipt' | 'readRegistryPointer' | 'readRegistryRevision'>;
  trustedPublicKey: string | undefined;
  /** A registry may be signed by a different currently trusted actor/key. */
  trustedRegistryPublicKey?: string;
  now?: () => number;
}
/** Actual stored B signature/proposal/bundle/registry verification with no
 * inferred local root, directory, writer, or boolean approval override. */
export async function verifyStoredSessionEvaluationReviewFromReaders(context: InterviewContext, session: InterviewSession,
  options: StoredSessionEvaluationReviewReaders) {
  try {
    const receiptHash = context.manifest.recordIds.sessionReviewReceiptSha256;
    if (!receiptHash || !sha.safeParse(receiptHash).success || !context.approvedKnowledge) return false;
    const envelope = JSON.parse(await options.reviews.readSessionReceipt(receiptHash as string));
    const receipt = receiptSchema.parse(envelope.receipt), { signature, ...payload } = receipt;
    if (!options.trustedPublicKey || hash(receipt) !== receiptHash || Date.parse(receipt.issuedAt) > (options.now ?? Date.now)() || Date.parse(receipt.expiresAt) <= Date.parse(receipt.issuedAt) ||
      receipt.sessionId !== session.id || receipt.sessionQuestionAnswerSha256 !== knowledgeSessionQuestionAnswerHash(session) ||
      receipt.bundleSha256 !== parseApprovedKnowledgeBundle(context.approvedKnowledge).contentSha256 ||
      !verify(null, Buffer.from(JSON.stringify(payload)), options.trustedPublicKey, Buffer.from(signature, 'base64'))) return false;
    const originalContext = await options.loadContext(receipt.contextSnapshotSha256, session.runtime!.owner.id), original = structuredClone(session);
    original.runtime!.contextSnapshotSha256 = receipt.contextSnapshotSha256;
    const latest = await loadBankScopeRegistryFromReader(options.reviews, options.trustedRegistryPublicKey ?? options.trustedPublicKey, options.now) ?? undefined;
    if ((latest?.contentSha256 ?? null) !== envelope.proposal.registrySha256) return false;
    const expected = prepareEndedSessionReview(originalContext, original, latest);
    if (JSON.stringify(expected) !== JSON.stringify(envelope.proposal) || expected.contentSha256 !== receipt.proposalSha256) return false;
    return context.approvedKnowledge.bindings.every(binding => binding.approval.status === 'approved' && binding.approval.approverId === receipt.actorId &&
      (expected.units.find(unit => unit.turnId === binding.turnId)?.questionKind !== 'main' ||
        expected.units.find(unit => unit.turnId === binding.turnId)?.specification?.reviewStatus === 'approved'));
  } catch { return false; }
}

export async function verifyStoredSessionEvaluationReview(context: InterviewContext, session: InterviewSession, root: string,
  sessions: SessionStore = createLocalSessionStore(root), trustedPublicKey = process.env.EVALUATION_SCOPE_REVIEW_PUBLIC_KEY,
  reviews: ReviewRepository = createLocalReviewRepository(root)) {
  return verifyStoredSessionEvaluationReviewFromReaders(context, session, { loadContext: (hash, owner) => sessions.loadContext(hash, owner),
    trustedPublicKey, reviews });
}
