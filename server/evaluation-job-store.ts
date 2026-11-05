import { createHash, randomUUID } from 'node:crypto';
import type { InterviewSession } from './protocol';
import { assertSessionOwner, snapshotHash } from './session-runtime';
import type { EvaluationClusterCheckpoint } from './providers/evaluation-input';
import type { ProviderUsageObservation } from './observability/provider-cost';
import type { EvaluationDocumentKind, EvaluationJobFileOptions, EvaluationJobPersistence, EvaluationRepository } from './repositories/evaluation-job-ports';
import { createLocalEvaluationJobPersistence, localEvaluationJobDirectory } from './repositories/local-evaluation-job-persistence';
export type { EvaluationRepository, EvaluationJobFileOptions } from './repositories/evaluation-job-ports';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const validHash = (value: string) => /^[a-f0-9]{64}$/u.test(value);
export interface EvaluationJob {
  version: 1; id: string; sessionId: string; ownerId: string; pipelineVersion: string; model: string;
  sourceSha256: string; snapshotSha256: string; contextSnapshotSha256: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'review_required'; attempts: number;
  createdAt: string; updatedAt: string; nextRetryAt: string | null;
  lease: { token: string; workerId: string; expiresAt: string } | null;
  checkpoints: EvaluationClusterCheckpoint[];
  usage: Array<{ attemptId: string; observation: ProviderUsageObservation }>;
  error: { code: string; message: string; retryable: boolean } | null;
  resultSha256: string | null;
}
export interface EvaluationJobSnapshot {
  version: 1; ownerId: string; contextSnapshotSha256: string; session: InterviewSession;
}
export interface EvaluationJobResult {
  version: 1; jobId: string; sourceSha256: string; snapshotSha256: string;
  pipelineVersion: string; model: string; evaluation: unknown; completedAt: string;
}
export function evaluationJobId(sessionId: string, ownerId: string, sourceSha256: string, pipelineVersion: string) {
  return sha(JSON.stringify([sessionId, ownerId, sourceSha256, pipelineVersion]));
}
const iso = (now: number) => new Date(now).toISOString();
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Private local queue. The worker only writes here, never to the original session files. */
export class EvaluationJobStore implements EvaluationRepository {
  /** Metadata only; raw corrupt jobs remain untouched on disk. */
  readonly scanDiagnostics = new Map<string, 'EVALUATION_JOB_DIAGNOSTIC_UNAVAILABLE'>();
  private readonly persistence: EvaluationJobPersistence;
  constructor(readonly directory = localEvaluationJobDirectory(), io: EvaluationJobFileOptions & { persistence?: EvaluationJobPersistence } = {}) {
    this.persistence = io.persistence ?? createLocalEvaluationJobPersistence(directory, io);
  }
  private reference(id: string, kind: EvaluationDocumentKind) {
    if (!validHash(id)) throw new Error('EVALUATION_JOB_ID_INVALID');
    return { id, kind };
  }
  private read(id: string, kind: EvaluationDocumentKind) {
    return this.persistence.read(this.reference(id, kind));
  }
  private atomic(id: string, kind: EvaluationDocumentKind, value: unknown) {
    return this.persistence.atomic(this.reference(id, kind), value);
  }
  private locked<T>(id: string, operation: () => Promise<T>): Promise<T> {
    return this.persistence.locked(id, operation);
  }
  async get(id: string): Promise<EvaluationJob | null> {
    let job: EvaluationJob;
    try { job = JSON.parse((await this.read(id, 'job')).toString('utf8')); }
    catch (error) { if (isMissing(error)) return null; throw error; }
    if (job.version !== 1 || job.id !== id || job.id !== evaluationJobId(job.sessionId, job.ownerId, job.sourceSha256, job.pipelineVersion) ||
      !validHash(job.snapshotSha256) || !validHash(job.contextSnapshotSha256) || typeof job.model !== 'string' || !job.model.trim() || job.model.length > 200 || !Array.isArray(job.checkpoints) || !Array.isArray(job.usage) ||
      !['queued', 'running', 'completed', 'failed', 'review_required'].includes(job.status)) throw new Error('EVALUATION_JOB_INVALID');
    return job;
  }
  async enqueue(session: InterviewSession, sourceSha256: string, pipelineVersion: string, now = Date.now(), model = process.env.OPENAI_ANALYSIS_MODEL || 'gpt-6.1-terra') {
    if (!session.runtime || session.status === 'active' || !validHash(sourceSha256)) throw new Error('EVALUATION_SNAPSHOT_NOT_ENDED');
    const ownerId = session.runtime.owner.id; assertSessionOwner(session, ownerId);
    const id = evaluationJobId(session.id, ownerId, sourceSha256, pipelineVersion);
    return this.locked(id, async () => {
      const existing = await this.get(id);
      if (existing) return existing;
      const snapshot: EvaluationJobSnapshot = { version: 1, ownerId, contextSnapshotSha256: session.runtime!.contextSnapshotSha256, session: structuredClone(session) };
      const job: EvaluationJob = { version: 1, id, sessionId: session.id, ownerId, pipelineVersion, model, sourceSha256,
        snapshotSha256: snapshotHash(snapshot), contextSnapshotSha256: snapshot.contextSnapshotSha256,
        status: 'queued', attempts: 0, createdAt: iso(now), updatedAt: iso(now), nextRetryAt: null, lease: null,
        checkpoints: [], usage: [], error: null, resultSha256: null };
      // Publish immutable input before the runnable job, so a crash cannot expose a missing snapshot.
      await this.atomic(id, 'snapshot', snapshot);
      await this.atomic(id, 'job', job);
      return job;
    });
  }
  async snapshot(job: EvaluationJob): Promise<EvaluationJobSnapshot> {
    const snapshot = JSON.parse((await this.read(job.id, 'snapshot')).toString('utf8')) as EvaluationJobSnapshot;
    if (snapshotHash(snapshot) !== job.snapshotSha256 || snapshot.version !== 1 || snapshot.ownerId !== job.ownerId ||
      snapshot.session.id !== job.sessionId || snapshot.contextSnapshotSha256 !== job.contextSnapshotSha256 ||
      snapshot.session.runtime?.contextSnapshotSha256 !== job.contextSnapshotSha256) throw new Error('EVALUATION_SNAPSHOT_CHANGED');
    assertSessionOwner(snapshot.session, job.ownerId);
    return snapshot;
  }
  async pending(now = Date.now()) {
    const candidates = await this.persistence.listJobIds();
    const scanned = await Promise.allSettled(candidates.map(async id => {
      try { return await this.get(id); }
      catch (error) {
        // Isolate the broken entry without moving, deleting or repairing its
        // bytes. One invalid JSON/job must not block every healthy queue item.
        if (isMissing(error)) return null;
        const original = await this.read(id, 'job');
        const jobFileSha256 = createHash('sha256').update(original).digest('hex');
        let previous: { jobFileSha256?: string } | null = null;
        try { previous = JSON.parse((await this.read(id, 'quarantine')).toString('utf8')); } catch { /* A diagnostic never approves or changes a job. */ }
        if (previous?.jobFileSha256 !== jobFileSha256) await this.atomic(id, 'quarantine', {
          version: 1, id, jobFileSha256, observedAt: iso(now), errorCode: 'EVALUATION_JOB_CORRUPT',
          originalPreserved: true, automaticRepair: false,
        });
        return null;
      }
    }));
    const jobs = scanned.flatMap((item, index) => {
      if (item.status === 'fulfilled') return [item.value];
      this.scanDiagnostics.set(candidates[index], 'EVALUATION_JOB_DIAGNOSTIC_UNAVAILABLE');
      return [];
    });
    return jobs.filter((job): job is EvaluationJob => Boolean(job && (job.status === 'queued' && (!job.nextRetryAt || Date.parse(job.nextRetryAt) <= now) ||
      job.status === 'running' && job.lease && Date.parse(job.lease.expiresAt) <= now))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async claim(id: string, workerId: string, now = Date.now(), leaseMs = 60_000) {
    return this.locked(id, async () => {
      const job = await this.get(id);
      if (!job || !(['queued', 'running'].includes(job.status)) || job.status === 'queued' && job.nextRetryAt && Date.parse(job.nextRetryAt) > now ||
        job.status === 'running' && job.lease && Date.parse(job.lease.expiresAt) > now) return null;
      job.status = 'running'; job.attempts++; job.updatedAt = iso(now); job.nextRetryAt = null;
      job.lease = { token: randomUUID(), workerId, expiresAt: iso(now + leaseMs) };
      await this.atomic(id, 'job', job); return job;
    });
  }
  private async mutate(id: string, token: string, apply: (job: EvaluationJob) => Promise<void> | void) {
    return this.locked(id, async () => {
      const job = await this.get(id);
      if (!job || job.status !== 'running' || job.lease?.token !== token) throw new Error('EVALUATION_LEASE_LOST');
      await apply(job); job.updatedAt = iso(Date.now()); await this.atomic(id, 'job', job); return job;
    });
  }
  async renew(id: string, token: string, now = Date.now(), leaseMs = 60_000) {
    return this.mutate(id, token, job => { job.lease!.expiresAt = iso(now + leaseMs); });
  }
  async checkpoint(id: string, token: string, checkpoint: EvaluationClusterCheckpoint) {
    return this.mutate(id, token, job => {
      const index = job.checkpoints.findIndex(row => row.clusterId === checkpoint.clusterId);
      if (index < 0) job.checkpoints.push(structuredClone(checkpoint)); else job.checkpoints[index] = structuredClone(checkpoint);
    });
  }
  async recordUsage(id: string, token: string, attemptId: string, observation: ProviderUsageObservation) {
    return this.mutate(id, token, job => {
      if (!job.usage.some(row => row.attemptId === attemptId)) job.usage.push({ attemptId, observation: structuredClone(observation) });
    });
  }
  async complete(id: string, token: string, evaluation: unknown) {
    return this.mutate(id, token, async job => {
      const result: EvaluationJobResult = { version: 1, jobId: id, sourceSha256: job.sourceSha256, snapshotSha256: job.snapshotSha256,
        pipelineVersion: job.pipelineVersion, model: job.model, evaluation, completedAt: iso(Date.now()) };
      await this.atomic(id, 'result', result);
      job.status = 'completed'; job.resultSha256 = snapshotHash(result); job.error = null; job.lease = null; job.nextRetryAt = null;
    });
  }
  async requireReview(id: string, token: string, reasons: string[]) {
    return this.mutate(id, token, job => {
      job.status = 'review_required'; job.lease = null; job.nextRetryAt = null;
      job.error = { code: 'EVALUATION_REVIEW_REQUIRED', message: [...new Set(reasons)].join(','), retryable: false };
    });
  }
  async fail(id: string, token: string, error: EvaluationJob['error'], now = Date.now(), maxAttempts = 3) {
    return this.mutate(id, token, job => {
      const retry = Boolean(error?.retryable && job.attempts < maxAttempts);
      job.status = retry ? 'queued' : 'failed'; job.error = error; job.lease = null;
      job.nextRetryAt = retry ? iso(now + Math.min(60_000, 2_000 * 2 ** Math.max(0, job.attempts - 1))) : null;
    });
  }
  async retry(id: string) {
    return this.locked(id, async () => {
      const job = await this.get(id);
      if (!job || job.status !== 'failed') return job;
      job.status = 'queued'; job.error = null; job.nextRetryAt = null; job.lease = null; job.updatedAt = iso(Date.now());
      await this.atomic(id, 'job', job); return job;
    });
  }
  async result(job: EvaluationJob): Promise<EvaluationJobResult | null> {
    if (job.status !== 'completed') return null;
    const result = JSON.parse((await this.read(job.id, 'result')).toString('utf8')) as EvaluationJobResult;
    if (snapshotHash(result) !== job.resultSha256 || result.version !== 1 || result.jobId !== job.id || result.sourceSha256 !== job.sourceSha256 ||
      result.snapshotSha256 !== job.snapshotSha256 || result.pipelineVersion !== job.pipelineVersion || result.model !== job.model) throw new Error('EVALUATION_RESULT_CHANGED');
    return result;
  }
}

/** Keep one store instance for the existing worker/server operation lifetime. */
export function createLocalEvaluationJobStore(root = process.cwd(), io: EvaluationJobFileOptions & { persistence?: EvaluationJobPersistence } = {}) {
  return new EvaluationJobStore(localEvaluationJobDirectory(root), io);
}
