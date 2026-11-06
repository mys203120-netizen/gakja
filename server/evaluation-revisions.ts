import { assertLocalInternalExecution } from './internal-execution';
/** Append-only reviewed-result references. Original sessions/contexts/results are
 * never rewritten; reads recheck exact frozen input and current review authority. */
import { z } from 'zod';
import type { InterviewSession } from './protocol';
import { createLocalEvaluationJobStore, type EvaluationJob } from './evaluation-job-store';
import type { EvaluationRepository } from './repositories/evaluation-job-ports';
import type { EvaluationRevisionRepository } from './repositories/evaluation-revision-ports';
import { createLocalEvaluationRevisionRepository } from './repositories/local-evaluation-revision-repository';
import type { ReviewRepository } from './repositories/review-ports';
import { createLocalReviewRepository } from './repositories/local-review-repository';
import { createLocalSessionStore } from './storage/local-session-store';
import type { SessionStore } from './storage/session-store';
import { assertSessionOwner, snapshotHash } from './session-runtime';
import { evaluationFrozenInputHash } from './evaluation-history';
import { knowledgeSessionQuestionAnswerHash } from './data/approved-knowledge';
import { EVALUATION_PIPELINE_VERSION, evaluationSessionSourceFingerprint } from './providers/evaluation-input';
import { assertEvaluationQuestionContracts } from './providers/evaluation-turns';

const sha = z.string().regex(/^[a-f0-9]{64}$/u), name = z.string().min(1).max(300);
const referenceBodySchema = z.object({ version: z.literal('reviewed-evaluation-revision-reference-v1'), ownerId: name, sessionId: name,
  sessionFrozenInputSha256: sha, sessionQuestionAnswerSha256: sha, originalContextSnapshotSha256: sha,
  reviewedContextSnapshotSha256: sha, receiptSha256: sha, receiptIssuedAt: z.string().datetime(),
  job: z.object({ id: sha, sourceSha256: sha, snapshotSha256: sha, pipelineVersion: name, model: name }).strict(),
}).strict();
const referenceSchema = referenceBodySchema.extend({ contentSha256: sha }).strict();
export type ReviewedEvaluationRevisionReference = z.infer<typeof referenceSchema>;
interface StorageOptions { root?: string; jobs?: EvaluationRepository; sessions?: SessionStore; trustedPublicKey?: string; revisions?: EvaluationRevisionRepository; reviews?: ReviewRepository }
export interface AppendReviewedEvaluationRevisionOptions extends StorageOptions {
  originalSession: InterviewSession; job: EvaluationJob; receiptSha256: string; receiptIssuedAt: string;
  originalContextSnapshotSha256: string; reviewedContextSnapshotSha256: string; sessionFrozenInputSha256: string;
}
export interface ReviewedEvaluationRevisionView {
  status: 'pending' | 'running' | 'review_required' | 'completed' | 'failed'; evaluation?: unknown; error?: string;
  jobId: string; sourceSha256: string; revisionSha256: string; pipelineVersion: string;
}
function stores(options: StorageOptions) { const root = options.root ?? process.cwd(); return { root, jobs: options.jobs ?? createLocalEvaluationJobStore(root), sessions: options.sessions ?? createLocalSessionStore(root), revisions: options.revisions ?? createLocalEvaluationRevisionRepository(root), reviews: options.reviews ?? createLocalReviewRepository(root) }; }
function assertFrozenSession(session: InterviewSession, ownerId: string) { assertSessionOwner(session, ownerId); if (session.status === 'active' || !session.runtime!.evaluationInputFrozenAt) throw new Error('REVIEWED_EVALUATION_FROZEN_INPUT_REQUIRED'); }
async function readReferences(revisions: EvaluationRevisionRepository, ownerId: string, sessionId: string): Promise<ReviewedEvaluationRevisionReference[]> {
  const scope = { ownerId, sessionId }, files = await revisions.list(scope).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; });
  return Promise.all(files.filter(file => /^[a-f0-9]{64}\.json$/u.test(file)).map(async file => {
    const record = referenceSchema.parse(JSON.parse(await revisions.read(scope, file.slice(0, 64)))), { contentSha256, ...body } = record;
    if (record.ownerId !== ownerId || record.sessionId !== sessionId || snapshotHash(body) !== contentSha256 || file !== `${contentSha256}.json`) throw new Error('REVIEWED_EVALUATION_REVISION_REFERENCE_CHANGED');
    return record;
  }));
}
function newestReference(references: ReviewedEvaluationRevisionReference[]) {
  if (!references.length) return null;
  const ordered = [...references].sort((a, b) => Date.parse(b.receiptIssuedAt) - Date.parse(a.receiptIssuedAt));
  if (ordered.length > 1 && Date.parse(ordered[0].receiptIssuedAt) === Date.parse(ordered[1].receiptIssuedAt) && ordered[0].contentSha256 !== ordered[1].contentSha256) throw new Error('REVIEWED_EVALUATION_REVISION_ORDER_CONFLICT');
  return ordered[0];
}
async function validateReference(record: ReviewedEvaluationRevisionReference, session: InterviewSession, options: StorageOptions) {
  const { root, jobs, sessions, reviews } = stores(options); assertFrozenSession(session, record.ownerId);
  const stored = await sessions.load(session.id, record.ownerId);
  if (!stored || record.sessionId !== session.id || record.originalContextSnapshotSha256 !== session.runtime!.contextSnapshotSha256 ||
    evaluationFrozenInputHash(session) !== record.sessionFrozenInputSha256 || evaluationFrozenInputHash(stored) !== record.sessionFrozenInputSha256 ||
    knowledgeSessionQuestionAnswerHash(session) !== record.sessionQuestionAnswerSha256) throw new Error('REVIEWED_EVALUATION_ORIGINAL_INPUT_CHANGED');
  const job = await jobs.get(record.job.id);
  if (!job || job.ownerId !== record.ownerId || job.sessionId !== session.id || job.contextSnapshotSha256 !== record.reviewedContextSnapshotSha256 ||
    Object.entries(record.job).some(([key, value]) => job[key as keyof EvaluationJob] !== value)) throw new Error('REVIEWED_EVALUATION_JOB_REFERENCE_CHANGED');
  const snapshot = await jobs.snapshot(job), normalized = structuredClone(snapshot.session);
  if (!normalized.runtime || normalized.status === 'active') throw new Error('REVIEWED_EVALUATION_JOB_INPUT_CHANGED');
  normalized.runtime.contextSnapshotSha256 = record.originalContextSnapshotSha256;
  if (evaluationFrozenInputHash(normalized) !== record.sessionFrozenInputSha256 || knowledgeSessionQuestionAnswerHash(snapshot.session) !== record.sessionQuestionAnswerSha256) throw new Error('REVIEWED_EVALUATION_JOB_INPUT_CHANGED');
  assertEvaluationQuestionContracts(session); assertEvaluationQuestionContracts(snapshot.session);
  const context = await sessions.loadContext(record.reviewedContextSnapshotSha256, record.ownerId);
  if (context.manifest.recordIds.sessionReviewReceiptSha256 !== record.receiptSha256 || evaluationSessionSourceFingerprint(context, snapshot.session, job.model) !== job.sourceSha256) throw new Error('REVIEWED_EVALUATION_CONTEXT_CHANGED');
  const envelope = JSON.parse(await reviews.readSessionReceipt(record.receiptSha256));
  if (snapshotHash(envelope.receipt) !== record.receiptSha256 || envelope.receipt.issuedAt !== record.receiptIssuedAt || envelope.receipt.contextSnapshotSha256 !== record.originalContextSnapshotSha256) throw new Error('REVIEWED_EVALUATION_RECEIPT_CHANGED');
  const isAuthorized = async () => {
    // Dynamic import avoids a module-initialization cycle: supply appends here
    // after persisting its receipt and enqueueing the separate reviewed job.
    const { verifyStoredSessionEvaluationReview } = await import('./evaluation-supply');
    return verifyStoredSessionEvaluationReview(context, snapshot.session, root, sessions, options.trustedPublicKey, reviews);
  };
  return { job, jobs, isAuthorized };
}
export async function appendReviewedEvaluationRevision(options: AppendReviewedEvaluationRevisionOptions): Promise<ReviewedEvaluationRevisionReference> {
  assertLocalInternalExecution();
  const { originalSession: session } = options, ownerId = session.runtime?.owner.id; if (!ownerId) throw new Error('REVIEWED_EVALUATION_OWNER_REQUIRED');
  const body = referenceBodySchema.parse({ version: 'reviewed-evaluation-revision-reference-v1', ownerId, sessionId: session.id,
    sessionFrozenInputSha256: options.sessionFrozenInputSha256, sessionQuestionAnswerSha256: knowledgeSessionQuestionAnswerHash(session),
    originalContextSnapshotSha256: options.originalContextSnapshotSha256, reviewedContextSnapshotSha256: options.reviewedContextSnapshotSha256,
    receiptSha256: options.receiptSha256, receiptIssuedAt: options.receiptIssuedAt,
    job: { id: options.job.id, sourceSha256: options.job.sourceSha256, snapshotSha256: options.job.snapshotSha256, pipelineVersion: options.job.pipelineVersion, model: options.job.model } });
  const record = { ...body, contentSha256: snapshotHash(body) }, validated = await validateReference(record, session, options);
  if (!await validated.isAuthorized()) throw new Error('REVIEWED_EVALUATION_REVIEW_NOT_CURRENT');
  const { revisions } = stores(options), existing = await readReferences(revisions, ownerId, session.id);
  if (existing.some(prior => Date.parse(prior.receiptIssuedAt) === Date.parse(record.receiptIssuedAt) && prior.contentSha256 !== record.contentSha256)) throw new Error('REVIEWED_EVALUATION_REVISION_ORDER_CONFLICT');
  await revisions.publish({ ownerId, sessionId: session.id }, record.contentSha256, record);
  // Concurrent equal-order writers cannot silently pick different winners.
  newestReference(await readReferences(revisions, ownerId, session.id)); return record;
}
export async function loadReviewedEvaluationRevision(options: StorageOptions & { session: InterviewSession; ownerId: string }): Promise<ReviewedEvaluationRevisionView | null> {
  const { revisions } = stores(options), { session, ownerId } = options; assertSessionOwner(session, ownerId); if (session.status === 'active') return null;
  const record = newestReference(await readReferences(revisions, ownerId, session.id)); if (!record) return null;
  const { job, jobs, isAuthorized } = await validateReference(record, session, options);
  const base = { jobId: job.id, sourceSha256: job.sourceSha256, revisionSha256: record.contentSha256, pipelineVersion: job.pipelineVersion };
  if (job.pipelineVersion !== EVALUATION_PIPELINE_VERSION) return { ...base, status: 'review_required', error: 'EVALUATION_PIPELINE_VERSION_CHANGED' };
  const result = job.status === 'completed' ? await jobs.result(job) : null;
  if (!await isAuthorized()) return { ...base, status: 'review_required', error: 'EVALUATION_APPROVAL_WITHDRAWN_OR_CHANGED' };
  if (job.status === 'completed') { if (!result) throw new Error('REVIEWED_EVALUATION_RESULT_MISSING'); return { ...base, status: 'completed', evaluation: result.evaluation }; }
  return { ...base, status: job.status === 'queued' ? 'pending' : job.status, ...(job.error ? { error: job.error.code } : {}) };
}

/** Retry the exact authorized reviewed revision, never the original session's
 * unreviewed job. A pending/review-wait/completed view has no retry side effect. */
export async function retryReviewedEvaluationRevision(options: StorageOptions & { session: InterviewSession; ownerId: string }): Promise<ReviewedEvaluationRevisionView | null> {
  assertLocalInternalExecution();
  const view = await loadReviewedEvaluationRevision(options);
  if (!view || view.status !== 'failed') return view;
  await stores(options).jobs.retry(view.jobId);
  return loadReviewedEvaluationRevision(options);
}
