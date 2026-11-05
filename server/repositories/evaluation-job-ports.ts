import type { EvaluationJob, EvaluationJobResult, EvaluationJobSnapshot } from '../evaluation-job-store';
import type { InterviewSession } from '../protocol';
import type { EvaluationClusterCheckpoint } from '../providers/evaluation-input';
import type { ProviderUsageObservation } from '../observability/provider-cost';

/** Existing job-store lifecycle, now structural for actual callers. A job ID is
 * not owner authentication; callers retain their current session/owner gates. */
export interface EvaluationRepository {
  readonly directory: string;
  readonly scanDiagnostics: Map<string, 'EVALUATION_JOB_DIAGNOSTIC_UNAVAILABLE'>;
  get(id: string): Promise<EvaluationJob | null>;
  enqueue(session: InterviewSession, sourceSha256: string, pipelineVersion: string, now?: number, model?: string): Promise<EvaluationJob>;
  snapshot(job: EvaluationJob): Promise<EvaluationJobSnapshot>;
  pending(now?: number): Promise<EvaluationJob[]>;
  claim(id: string, workerId: string, now?: number, leaseMs?: number): Promise<EvaluationJob | null>;
  renew(id: string, token: string, now?: number, leaseMs?: number): Promise<EvaluationJob>;
  checkpoint(id: string, token: string, checkpoint: EvaluationClusterCheckpoint): Promise<EvaluationJob>;
  recordUsage(id: string, token: string, attemptId: string, observation: ProviderUsageObservation): Promise<EvaluationJob>;
  complete(id: string, token: string, evaluation: unknown): Promise<EvaluationJob>;
  requireReview(id: string, token: string, reasons: string[]): Promise<EvaluationJob>;
  fail(id: string, token: string, error: EvaluationJob['error'], now?: number, maxAttempts?: number): Promise<EvaluationJob>;
  retry(id: string): Promise<EvaluationJob | null>;
  result(job: EvaluationJob): Promise<EvaluationJobResult | null>;
}
export type EvaluationDocumentKind = 'job' | 'snapshot' | 'result' | 'quarantine';
export interface EvaluationDocumentReference { id: string; kind: EvaluationDocumentKind }
/** Physical local persistence only. Lifecycle, identity, hashes and evaluation
 * leases remain in EvaluationJobStore; this lock is its old short file lock. */
export interface EvaluationJobPersistence {
  read(reference: EvaluationDocumentReference): Promise<Buffer>;
  listJobIds(): Promise<string[]>;
  atomic(reference: EvaluationDocumentReference, value: unknown): Promise<void>;
  locked<T>(id: string, operation: () => Promise<T>): Promise<T>;
}
export interface EvaluationJobFileOptions {
  replaceFile?: (source: string, destination: string) => Promise<void>;
  readLockFile?: (file: string) => Promise<string>;
}
