import { randomUUID } from 'node:crypto';
import type { InterviewContext } from './data/load-interview-context';
import { safeProviderError, type InterviewSession } from './protocol';
import { createLocalEvaluationJobStore, type EvaluationJob, type EvaluationJobSnapshot, type EvaluationRepository } from './evaluation-job-store';
import { createLocalSessionStore } from './storage/local-session-store';
import type { SessionStore } from './storage/session-store';
import { EVALUATION_PIPELINE_VERSION, evaluationSessionSourceFingerprint, buildEvaluationClusterInputs } from './providers/evaluation-input';
import { localEvaluationReviewRoot } from './repositories/local-evaluation-job-persistence';
import type { ReviewRepository } from './repositories/review-ports';
import { evaluateSession } from './providers/openai';
import { assertWorkerExecution, authorizedWorkerCandidates, assertWorkerJobBinding, assertWorkerMetadataBinding, InternalExecutionError, type TrustedEvaluationWorkerExecution } from './internal-execution';
export { enqueueReviewedKnowledgeEvaluation } from './reviewed-evaluation-queue';

export interface EvaluationWorkerOptions {
  jobs?: EvaluationRepository; sessions?: SessionStore; workerId?: string; leaseMs?: number; root?: string; reviews?: ReviewRepository; trustedPublicKey?: string;
  evaluate?: typeof evaluateSession;
  execution?: TrustedEvaluationWorkerExecution;
  loadContext?: (sha256: string, ownerId: string) => Promise<InterviewContext>;
  fingerprint?: (context: InterviewContext, session: InterviewSession, model?: string) => string;
  now?: () => number;
  onCompleted?: (job: EvaluationJob) => void;
  /** Explicit trusted seam for isolated synthetic provider fixtures only. */
  reviewReadiness?: (context: InterviewContext, session: InterviewSession) => Promise<{ readyCount: number; unitCount: number; held: string[]; invalid: string[] }> | { readyCount: number; unitCount: number; held: string[]; invalid: string[] };
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
  const now = options.now ?? Date.now, mode = assertWorkerExecution(options.execution, now());
  if (mode === 'service' && (options.reviewReadiness || options.fingerprint)) throw new InternalExecutionError('INTERNAL_OPERATION_UNSUPPORTED');
  const jobs = options.jobs ?? createLocalEvaluationJobStore(options.root), sessions = options.sessions ?? createLocalSessionStore(options.root);
  const reviewRoot = options.root ?? localEvaluationReviewRoot(jobs.directory);
  const workerId = options.workerId ?? `evaluation-worker-${process.pid}-${randomUUID()}`, leaseMs = options.leaseMs ?? 60_000;
  for (const available of await authorizedWorkerCandidates(options.execution, jobs, now)) {
    // The authority first selects this exact job. Frozen payload binding is
    // checked before claim/heartbeat can write anything. Local behavior stays unchanged.
    let prepared: { snapshot: EvaluationJobSnapshot; context: InterviewContext } | null = null;
    if (mode === 'service') {
      await assertWorkerMetadataBinding(options.execution, available, now);
      const snapshot = await jobs.snapshot(available);
      await assertWorkerMetadataBinding(options.execution, available, now);
      const context = await (options.loadContext ?? ((hash, owner) => sessions.loadContext(hash, owner)))(available.contextSnapshotSha256, available.ownerId);
      prepared = { snapshot, context };
    }
    if (prepared) await assertWorkerJobBinding(options.execution, available, prepared.snapshot, prepared.context, now);
    assertWorkerExecution(options.execution, now());
    const job = await jobs.claim(available.id, workerId, now(), leaseMs);
    if (!job?.lease) continue;
    const token = job.lease.token;
    const authorizeCurrent = async () => {
      if (prepared) await assertWorkerJobBinding(options.execution, job, prepared.snapshot, prepared.context, now);
      assertWorkerExecution(options.execution, now());
    };
    let persistence = Promise.resolve();
    const persist = (action: () => Promise<unknown>) => { persistence = persistence.then(async () => { await authorizeCurrent(); await action(); }); return persistence; };
    const heartbeat = setInterval(() => { void persist(() => jobs.renew(job.id, token, now(), leaseMs)).catch(() => {}); }, Math.max(100, Math.floor(leaseMs / 3)));
    heartbeat.unref();
    try {
      if (job.pipelineVersion !== EVALUATION_PIPELINE_VERSION) throw new Error('EVALUATION_PIPELINE_VERSION_CHANGED');
      const snapshot = prepared?.snapshot ?? await jobs.snapshot(job);
      const context = prepared?.context ?? await (options.loadContext ?? ((hash, owner) => sessions.loadContext(hash, owner)))(job.contextSnapshotSha256, job.ownerId);
      if (context.manifest.rulesVersion !== snapshot.session.runtime?.engineVersion) throw new Error('EVALUATION_CONTEXT_VERSION_CHANGED');
      if ((options.fingerprint ?? evaluationSessionSourceFingerprint)(context, snapshot.session, job.model) !== job.sourceSha256) throw new Error('EVALUATION_INPUT_SOURCE_CHANGED');
      const readiness = options.reviewReadiness ?? ((source: InterviewContext, session: InterviewSession) => {
        const answers = buildEvaluationClusterInputs(source, session).flatMap(input => input.answers), held = answers.flatMap(answer => answer.knowledge.holdReasons);
        return { unitCount: answers.length, readyCount: answers.filter(answer => !answer.knowledge.holdReasons.length).length,
          held, invalid: held.filter(reason => /INVALID|CHANGED|CONFLICT|MISMATCH/u.test(reason)) };
      });
      const required = await readiness(context, snapshot.session);
      if (required.invalid.length) throw new Error('EVALUATION_REVIEW_INPUT_INVALID:' + required.invalid.join(','));
      const receiptCurrent = async () => {
        if (options.reviewReadiness || !required.unitCount || !required.readyCount) return true;
        const { verifyStoredSessionEvaluationReview } = await import('./evaluation-supply');
        return verifyStoredSessionEvaluationReview(context, snapshot.session, reviewRoot, sessions, options.trustedPublicKey, options.reviews);
      };
      if (required.unitCount && (!required.readyCount || !await receiptCurrent())) {
        clearInterval(heartbeat); await persistence;
        await authorizeCurrent();
        const waiting = await jobs.requireReview(job.id, token, [...required.held, 'AUTHENTICATED_SESSION_REVIEW_REQUIRED']);
        return { processed: true as const, job: waiting };
      }
      await authorizeCurrent();
      let usageIndex = 0;
      const evaluation = await (options.evaluate ?? evaluateSession)(context, snapshot.session, {
        maxRetries: 0, model: job.model, resumeClusters: job.checkpoints,
        onClusterComplete: checkpoint => persist(() => jobs.checkpoint(job.id, token, checkpoint)),
        onProviderUsage: observation => { const attemptId = `${job.id}:${job.attempts}:${usageIndex++}`; void persist(() => jobs.recordUsage(job.id, token, attemptId, observation)).catch(() => {}); },
      });
      clearInterval(heartbeat); await persistence;
      await authorizeCurrent();
      if (!await receiptCurrent()) {
        await authorizeCurrent();
        return { processed: true as const, job: await jobs.requireReview(job.id, token, ['EVALUATION_APPROVAL_WITHDRAWN_OR_CHANGED']) };
      }
      await authorizeCurrent();
      const completed = await jobs.complete(job.id, token, evaluation);
      await authorizeCurrent(); options.onCompleted?.(completed);
      return { processed: true as const, job: completed };
    } catch (error) {
      clearInterval(heartbeat);
      try { await persistence; } catch { /* Failure below is separately persisted while this lease still belongs to us. */ }
      if (error instanceof InternalExecutionError) throw error;
      await authorizeCurrent();
      if (error instanceof Error && error.message === 'EVALUATION_LEASE_LOST') return { processed: true as const, job: await jobs.get(job.id) };
      const failed = await jobs.fail(job.id, token, failure(error), now());
      return { processed: true as const, job: failed };
    } finally { clearInterval(heartbeat); }
  }
  return { processed: false as const, job: null };
}
