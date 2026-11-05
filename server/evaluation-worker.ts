import { randomUUID } from 'node:crypto';
import type { InterviewContext } from './data/load-interview-context';
import { safeProviderError, type InterviewSession } from './protocol';
import { EvaluationJobStore, type EvaluationJob } from './evaluation-job-store';
import { LocalSessionStore } from './storage/local-session-store';
import { EVALUATION_PIPELINE_VERSION, evaluationSessionSourceFingerprint } from './providers/evaluation-input';
import { evaluateSession } from './providers/openai';
import { parseApprovedKnowledgeBundle } from './data/approved-knowledge';
import { snapshotHash } from './session-runtime';

export interface EvaluationWorkerOptions {
  jobs?: EvaluationJobStore; sessions?: LocalSessionStore; workerId?: string; leaseMs?: number;
  evaluate?: typeof evaluateSession;
  loadContext?: (sha256: string, ownerId: string) => Promise<InterviewContext>;
  fingerprint?: (context: InterviewContext, session: InterviewSession, model?: string) => string;
  now?: () => number;
  onCompleted?: (job: EvaluationJob) => void;
}

/** Derivation authority is the original session's stored context, never a
 * caller-supplied base hash. Only reviewed knowledge and its provenance vary. */
function assertReviewedKnowledgeDerivation(context: InterviewContext, base: InterviewContext) {
  const bundle = parseApprovedKnowledgeBundle(context.approvedKnowledge);
  const provenance = context.manifest.files.filter(file => file.role === 'approvedEvaluationKnowledge');
  if (provenance.length > 1 || provenance.some(file => Object.keys(file).sort().join(',') !== 'path,role,sha256' ||
    typeof file.path !== 'string' || !file.path.trim() || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256))) throw new Error('APPROVED_KNOWLEDGE_CONTEXT_DERIVATION_INVALID');
  const declared = context.manifest.recordIds.approvedEvaluationKnowledgeSha256;
  if (declared !== undefined && declared !== bundle.contentSha256) throw new Error('APPROVED_KNOWLEDGE_CONTEXT_DERIVATION_INVALID');
  const withoutKnowledge = (source: InterviewContext) => {
    const copy = structuredClone(source);
    delete copy.approvedKnowledge;
    copy.manifest.files = copy.manifest.files.filter(file => file.role !== 'approvedEvaluationKnowledge');
    delete copy.manifest.recordIds.approvedEvaluationKnowledgeSha256;
    return copy;
  };
  if (snapshotHash(withoutKnowledge(context)) !== snapshotHash(withoutKnowledge(base))) throw new Error('APPROVED_KNOWLEDGE_BASE_CONTEXT_CHANGED');
}

/** Re-evaluate an ended snapshot under an explicitly reviewed knowledge context.
 * Save a new context/job only; never rewrite the historical runtime context,
 * session, question contract, transcript or already stored evaluation result. */
export async function enqueueReviewedKnowledgeEvaluation(context: InterviewContext, original: InterviewSession,
  options: { jobs?: EvaluationJobStore; sessions?: LocalSessionStore; model?: string; now?: number } = {}) {
  if (!original.runtime || original.status === 'active' || !context.approvedKnowledge) throw new Error('APPROVED_KNOWLEDGE_ENDED_CONTEXT_REQUIRED');
  parseApprovedKnowledgeBundle(context.approvedKnowledge);
  if (context.manifest.rulesVersion !== original.runtime.engineVersion) throw new Error('EVALUATION_CONTEXT_VERSION_CHANGED');
  const sessions = options.sessions ?? new LocalSessionStore();
  const base = await sessions.loadContext(original.runtime.contextSnapshotSha256, original.runtime.owner.id);
  assertReviewedKnowledgeDerivation(context, base);
  const session = structuredClone(original), model = options.model || process.env.OPENAI_ANALYSIS_MODEL || 'gpt-6.1-terra';
  const contextSnapshotSha256 = await sessions.saveContext(context, original.runtime.owner.id);
  session.runtime!.contextSnapshotSha256 = contextSnapshotSha256;
  const sourceSha256 = evaluationSessionSourceFingerprint(context, session, model);
  const job = await (options.jobs ?? new EvaluationJobStore()).enqueue(session, sourceSha256, EVALUATION_PIPELINE_VERSION, options.now ?? Date.now(), model);
  return { job, contextSnapshotSha256, sourceSha256, originalContextSnapshotSha256: original.runtime.contextSnapshotSha256 };
}
function failure(error: unknown) {
  const item = error as { status?: number; name?: string; message?: string; code?: string };
  const retryable = item.status === 408 || item.status === 409 || item.status === 429 && !/credit_balance_exhausted|insufficient_quota/u.test(item.message ?? '') ||
    (item.status ?? 0) >= 500 || ['APIConnectionError', 'APIConnectionTimeoutError'].includes(item.name ?? '');
  const message = safeProviderError(error).slice(0, 600);
  return { code: typeof item.code === 'string' ? item.code : typeof item.status === 'number' ? `PROVIDER_${item.status}` : 'EVALUATION_PROCESSING_FAILED', message, retryable };
}

/** Executes at most one durable job. No session file or live interview object is written. */
export async function runEvaluationWorkerOnce(options: EvaluationWorkerOptions = {}) {
  const jobs = options.jobs ?? new EvaluationJobStore(), sessions = options.sessions ?? new LocalSessionStore();
  const workerId = options.workerId ?? `evaluation-worker-${process.pid}-${randomUUID()}`, leaseMs = options.leaseMs ?? 60_000;
  const now = options.now ?? Date.now;
  for (const available of await jobs.pending(now())) {
    const job = await jobs.claim(available.id, workerId, now(), leaseMs);
    if (!job?.lease) continue;
    const token = job.lease.token;
    let persistence = Promise.resolve();
    const persist = (action: () => Promise<unknown>) => { persistence = persistence.then(async () => { await action(); }); return persistence; };
    const heartbeat = setInterval(() => { void persist(() => jobs.renew(job.id, token, now(), leaseMs)).catch(() => {}); }, Math.max(100, Math.floor(leaseMs / 3)));
    heartbeat.unref();
    try {
      if (job.pipelineVersion !== EVALUATION_PIPELINE_VERSION) throw new Error('EVALUATION_PIPELINE_VERSION_CHANGED');
      const snapshot = await jobs.snapshot(job);
      const context = await (options.loadContext ?? ((hash, owner) => sessions.loadContext(hash, owner)))(job.contextSnapshotSha256, job.ownerId);
      if (context.manifest.rulesVersion !== snapshot.session.runtime?.engineVersion) throw new Error('EVALUATION_CONTEXT_VERSION_CHANGED');
      if ((options.fingerprint ?? evaluationSessionSourceFingerprint)(context, snapshot.session, job.model) !== job.sourceSha256) throw new Error('EVALUATION_INPUT_SOURCE_CHANGED');
      let usageIndex = 0;
      const evaluation = await (options.evaluate ?? evaluateSession)(context, snapshot.session, {
        maxRetries: 0, model: job.model, resumeClusters: job.checkpoints,
        onClusterComplete: checkpoint => persist(() => jobs.checkpoint(job.id, token, checkpoint)),
        onProviderUsage: observation => { const attemptId = `${job.id}:${job.attempts}:${usageIndex++}`; void persist(() => jobs.recordUsage(job.id, token, attemptId, observation)).catch(() => {}); },
      });
      clearInterval(heartbeat); await persistence;
      const completed = await jobs.complete(job.id, token, evaluation); options.onCompleted?.(completed);
      return { processed: true as const, job: completed };
    } catch (error) {
      clearInterval(heartbeat);
      try { await persistence; } catch { /* Failure below is separately persisted while this lease still belongs to us. */ }
      if (error instanceof Error && error.message === 'EVALUATION_LEASE_LOST') return { processed: true as const, job: await jobs.get(job.id) };
      const failed = await jobs.fail(job.id, token, failure(error), now());
      return { processed: true as const, job: failed };
    } finally { clearInterval(heartbeat); }
  }
  return { processed: false as const, job: null };
}
