import type { InterviewContext } from './data/load-interview-context';
import type { EvaluationJob, EvaluationJobSnapshot } from './evaluation-job-store';
import type { EvaluationRepository } from './repositories/evaluation-job-ports';
import { snapshotHash } from './session-runtime';
import { resolveExecutionMode } from './auth/request-identity';

/** Internal execution is configured by the server, never by a request/job DTO. */
export class InternalExecutionError extends Error {
  constructor(readonly code: 'INTERNAL_AUTHORITY_REQUIRED' | 'INTERNAL_AUTHORITY_EXPIRED' | 'INTERNAL_AUTHORITY_UNAVAILABLE' | 'INTERNAL_BINDING_DENIED' | 'INTERNAL_OPERATION_UNSUPPORTED') {
    super(code); this.name = 'InternalExecutionError';
  }
}
/** Trusted finite-job permission, not a browser account/application DTO.
 * supportTargetId is the existing domain target pinned by the context hash;
 * legacy jobs have no personal applicationTargetId. An operational mapping
 * adapter is still required to attest that separate relation in PR07-B/E. */
export interface TrustedEvaluationJobBinding {
  jobId: string; ownerId: string; sessionId: string; studentId: string; supportTargetId: string;
  sourceSha256: string; snapshotSha256: string; contextSnapshotSha256: string; pipelineVersion: string; model: string;
}
export interface TrustedEvaluationWorkerExecution { readonly kind: 'trusted-evaluation-worker-v1' }
interface WorkerAuthority {
  subjectId: string; issuedAt: number; expiresAt: number; jobIds: readonly string[];
  resolveBinding(jobId: string): Promise<TrustedEvaluationJobBinding | null>;
}
const authorities = new WeakMap<TrustedEvaluationWorkerExecution, WorkerAuthority>();
const hash = /^[a-f0-9]{64}$/u;

/** Composition-only seam for a trusted scheduler/account binding adapter.
 * Nothing in production auto-installs this adapter or obtains it from a token. */
export function createTrustedEvaluationWorkerExecution(authority: WorkerAuthority): TrustedEvaluationWorkerExecution {
  if (!authority.subjectId.trim() || !Number.isFinite(authority.issuedAt) || !Number.isFinite(authority.expiresAt) ||
    authority.expiresAt <= authority.issuedAt || !authority.jobIds.length || authority.jobIds.some(id => !hash.test(id)) || typeof authority.resolveBinding !== 'function') {
    throw new InternalExecutionError('INTERNAL_AUTHORITY_REQUIRED');
  }
  const context = Object.freeze({ kind: 'trusted-evaluation-worker-v1' as const });
  authorities.set(context, { ...authority, jobIds: Object.freeze([...new Set(authority.jobIds)]), resolveBinding: authority.resolveBinding.bind(authority) });
  return context;
}
function authorityFor(execution: TrustedEvaluationWorkerExecution | undefined, now: number) {
  const authority = execution && authorities.get(execution);
  if (!authority) throw new InternalExecutionError('INTERNAL_AUTHORITY_REQUIRED');
  if (now < authority.issuedAt || now >= authority.expiresAt) throw new InternalExecutionError('INTERNAL_AUTHORITY_EXPIRED');
  return authority;
}
export function assertLocalInternalExecution() {
  if (resolveExecutionMode() !== 'local-development') throw new InternalExecutionError('INTERNAL_OPERATION_UNSUPPORTED');
}
export function assertWorkerExecution(execution: TrustedEvaluationWorkerExecution | undefined, now: number) {
  if (resolveExecutionMode() === 'local-development') {
    if (execution) throw new InternalExecutionError('INTERNAL_AUTHORITY_REQUIRED');
    return 'local-development' as const;
  }
  authorityFor(execution, now); return 'service' as const;
}
async function bindingFor(execution: TrustedEvaluationWorkerExecution, jobId: string, now: () => number) {
  const authority = authorityFor(execution, now());
  if (!authority.jobIds.includes(jobId)) throw new InternalExecutionError('INTERNAL_BINDING_DENIED');
  let binding: TrustedEvaluationJobBinding | null;
  try { binding = await authority.resolveBinding(jobId); } catch { throw new InternalExecutionError('INTERNAL_AUTHORITY_UNAVAILABLE'); }
  authorityFor(execution, now());
  if (!binding || binding.jobId !== jobId || !binding.ownerId || !binding.sessionId || !binding.studentId || !binding.supportTargetId ||
    ![binding.jobId, binding.sourceSha256, binding.snapshotSha256, binding.contextSnapshotSha256].every(value => hash.test(value)) ||
    !binding.pipelineVersion || !binding.model) throw new InternalExecutionError('INTERNAL_BINDING_DENIED');
  return { ...binding };
}
function matchesJob(binding: TrustedEvaluationJobBinding, job: EvaluationJob) {
  return binding.jobId === job.id && binding.ownerId === job.ownerId && binding.sessionId === job.sessionId &&
    binding.sourceSha256 === job.sourceSha256 && binding.snapshotSha256 === job.snapshotSha256 &&
    binding.contextSnapshotSha256 === job.contextSnapshotSha256 && binding.pipelineVersion === job.pipelineVersion && binding.model === job.model;
}
export async function assertWorkerMetadataBinding(execution: TrustedEvaluationWorkerExecution | undefined, job: EvaluationJob, now: () => number) {
  if (assertWorkerExecution(execution, now()) === 'local-development') return;
  const binding = await bindingFor(execution!, job.id, now);
  if (!matchesJob(binding, job)) throw new InternalExecutionError('INTERNAL_BINDING_DENIED');
}
/** Service mode never scans pending(): it can quarantine and disclose other owners. */
export async function authorizedWorkerCandidates(execution: TrustedEvaluationWorkerExecution | undefined, jobs: EvaluationRepository, now: () => number) {
  if (assertWorkerExecution(execution, now()) === 'local-development') return jobs.pending(now());
  const authority = authorityFor(execution, now()), candidates: EvaluationJob[] = [];
  for (const id of authority.jobIds) {
    const binding = await bindingFor(execution!, id, now), job = await jobs.get(id);
    if (!job) continue;
    if (!matchesJob(binding, job)) throw new InternalExecutionError('INTERNAL_BINDING_DENIED');
    if (job.status === 'queued' && (!job.nextRetryAt || Date.parse(job.nextRetryAt) <= now()) ||
      job.status === 'running' && job.lease && Date.parse(job.lease.expiresAt) <= now()) candidates.push(job);
  }
  return candidates;
}
export async function assertWorkerJobBinding(execution: TrustedEvaluationWorkerExecution | undefined, job: EvaluationJob,
  snapshot: EvaluationJobSnapshot, context: InterviewContext, now: () => number) {
  if (assertWorkerExecution(execution, now()) === 'local-development') return;
  const binding = await bindingFor(execution!, job.id, now);
  if (!matchesJob(binding, job) || snapshot.ownerId !== binding.ownerId || snapshot.session.id !== binding.sessionId ||
    snapshot.session.runtime?.owner.id !== binding.ownerId || snapshot.contextSnapshotSha256 !== binding.contextSnapshotSha256 ||
    snapshotHash(snapshot) !== binding.snapshotSha256 || snapshotHash(context) !== binding.contextSnapshotSha256 ||
    (context.student.studentId ?? context.studentAnalysis?.studentId ?? null) !== binding.studentId ||
    (context.targetAnalysis?.supportTargetId ?? context.school?.interview?.id ?? null) !== binding.supportTargetId) {
    throw new InternalExecutionError('INTERNAL_BINDING_DENIED');
  }
}
