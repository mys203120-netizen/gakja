import type { AuthenticatedRequestContext, ResourceBinding } from '../auth/request-identity';
import type { EvaluationJob, EvaluationJobResult, EvaluationJobSnapshot } from '../evaluation-job-store';
import type { EvaluationClusterCheckpoint } from '../providers/evaluation-input';
import type { ProviderUsageObservation } from '../observability/provider-cost';

export class EvaluationWriterError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); this.name = 'EvaluationWriterError'; }
}
export type EvaluationArtifactKind = 'trust' | 'registry' | 'registry-receipt' | 'bundle' | 'session-receipt' | 'reviewed-context';
/** The raw transport hash and the existing domain identity are separate. */
export interface EvaluationReviewArtifact { kind: EvaluationArtifactKind; contentSha256: string; json: string; rawSha256: string }
export interface EvaluationScopeBinding extends ResourceBinding { ownerId: string; studentId: string; applicationTargetId: string; supportTargetId: string }
export interface EvaluationScopeControl {
  binding: EvaluationScopeBinding; serverNow: string;
  trustGeneration: string; registryGeneration: string;
  trust: EvaluationReviewArtifact | null; registry: EvaluationReviewArtifact | null; registryReceipt: EvaluationReviewArtifact | null;
}
export interface EvaluationSessionControl {
  sessionId: string; writer: 'db' | 'read-only'; fence: string; approvalGeneration: string;
  approvalSha256: string | null; approvalRevoked: boolean;
  approvalAcceptedAt: string | null;
  registrySha256: string | null; receipt: EvaluationReviewArtifact | null; bundle: EvaluationReviewArtifact | null;
}
export interface EvaluationCommandKey { key: string; inputSha256: string }
export interface EvaluationCommandReceipt {
  key: string; inputSha256: string; operationId: string; sessionId: string | null; action: string;
  resultJson: string; resultSha256: string; replay: boolean; committedAt: string;
}
export interface EvaluationTrustAdminCapability { readonly kind: 'evaluation-trust-admin-capability-v1' }
export interface EvaluationReviewerCapability { readonly kind: 'evaluation-reviewer-capability-v1' }
export interface EvaluationAdmissionCapability { readonly kind: 'evaluation-admission-capability-v1' }
export interface EvaluationWorkerCapability { readonly kind: 'evaluation-worker-capability-v1' }
export interface EvaluationPreservationCapability { readonly kind: 'evaluation-preservation-capability-v1' }
export interface EvaluationReviewPrecondition { expectedTrustGeneration: string; expectedRegistryGeneration: string }
export interface EvaluationJobRegistration {
  jobId: string; sourceSha256: string; snapshotJson: string; snapshotSha256: string;
  reviewedContext: EvaluationReviewArtifact; pipelineVersion: string; model: string;
  /** Existing reviewed revision reference, before any result publication. */
  revisionJson: string; revisionSha256: string; revisionRawSha256: string;
}
export interface EvaluationConsumptionInput extends EvaluationCommandKey, EvaluationReviewPrecondition {
  sessionId: string; handoffIntentId: string; handoffPayloadSha256: string; frozenSessionSha256: string;
  originalContextSnapshotSha256: string; expectedApprovalGeneration: string;
  approvalSha256: string | null;
  state: 'review_required' | 'registered'; reasons: readonly string[];
  registration?: EvaluationJobRegistration;
}
/** The existing worker lifecycle, without filesystem metadata, arbitrary
 * enqueue or global pending scans. Every method is bound to one finite grant. */
export interface EvaluationWorkerJobs {
  get(id: string): Promise<EvaluationJob | null>;
  snapshot(job: EvaluationJob): Promise<EvaluationJobSnapshot>;
  claim(id: string, workerId: string, now?: number, leaseMs?: number): Promise<EvaluationJob | null>;
  renew(id: string, token: string, now?: number, leaseMs?: number): Promise<EvaluationJob>;
  checkpoint(id: string, token: string, checkpoint: EvaluationClusterCheckpoint): Promise<EvaluationJob>;
  recordUsage(id: string, token: string, attemptId: string, observation: ProviderUsageObservation): Promise<EvaluationJob>;
  complete(id: string, token: string, evaluation: unknown): Promise<EvaluationJob>;
  requireReview(id: string, token: string, reasons: string[]): Promise<EvaluationJob>;
  fail(id: string, token: string, error: EvaluationJob['error'], now?: number, maxAttempts?: number): Promise<EvaluationJob>;
}
export interface EvaluationProjection {
  version: 'authenticated-evaluation-projection-v1'; sessionId: string;
  state: 'awaiting-evaluation-consumer' | 'review_required' | 'queued' | 'running' | 'completed' | 'failed';
  control: EvaluationSessionControl | null; currentApproval: boolean;
  job: EvaluationJob | null; result: EvaluationJobResult | null;
  revisionJson: string | null; revisionSha256: string | null; revisionRawSha256: string | null; resultRevisionId: string | null;
}
export interface EvaluationPreservationBundle { version: 'evaluation-preservation-v1'; payloadJson: string; sha256: string }
export interface EvaluationWriterRepository {
  scopeControl(context: AuthenticatedRequestContext): Promise<EvaluationScopeControl>;
  sessionControl(context: AuthenticatedRequestContext, sessionId: string): Promise<EvaluationSessionControl | null>;
  readArtifact(context: AuthenticatedRequestContext, kind: EvaluationArtifactKind, contentSha256: string): Promise<EvaluationReviewArtifact | null>;
  installTrust(context: AuthenticatedRequestContext, input: EvaluationCommandKey & { expectedTrustGeneration: string; trust: EvaluationReviewArtifact }, capability: EvaluationTrustAdminCapability): Promise<EvaluationCommandReceipt>;
  publishRegistry(context: AuthenticatedRequestContext, input: EvaluationCommandKey & EvaluationReviewPrecondition & { registry: EvaluationReviewArtifact; receipt: EvaluationReviewArtifact }, capability: EvaluationReviewerCapability): Promise<EvaluationCommandReceipt>;
  publishApproval(context: AuthenticatedRequestContext, input: EvaluationCommandKey & EvaluationReviewPrecondition & { sessionId: string; expectedApprovalGeneration: string; registrySha256: string; bundle: EvaluationReviewArtifact; receipt: EvaluationReviewArtifact }, capability: EvaluationReviewerCapability): Promise<EvaluationCommandReceipt>;
  withdrawApproval(context: AuthenticatedRequestContext, input: EvaluationCommandKey & EvaluationReviewPrecondition & { sessionId: string; expectedApprovalGeneration: string; reason: string }, capability: EvaluationReviewerCapability): Promise<EvaluationCommandReceipt>;
  consume(context: AuthenticatedRequestContext, input: EvaluationConsumptionInput, capability: EvaluationAdmissionCapability): Promise<EvaluationCommandReceipt>;
  projection(context: AuthenticatedRequestContext, sessionId: string): Promise<EvaluationProjection | null>;
  jobProjection(context: AuthenticatedRequestContext, jobId: string): Promise<EvaluationProjection | null>;
  getJob(context: AuthenticatedRequestContext, jobId: string): Promise<EvaluationJob | null>;
  receipt(context: AuthenticatedRequestContext, query: EvaluationCommandKey): Promise<EvaluationCommandReceipt | null>;
  retry(context: AuthenticatedRequestContext, input: EvaluationCommandKey & { jobId: string }): Promise<EvaluationCommandReceipt>;
  /** The grant is created from server authority, never a browser role string. */
  grantWorker(context: AuthenticatedRequestContext, capability: EvaluationWorkerCapability): Promise<void>;
  workerJobs(context: AuthenticatedRequestContext, capability: EvaluationWorkerCapability): EvaluationWorkerJobs;
  freeze(context: AuthenticatedRequestContext, sessionId: string, expectedFence: string): Promise<EvaluationSessionControl>;
  exportPreservation(context: AuthenticatedRequestContext, sessionId: string): Promise<EvaluationPreservationBundle>;
  restorePreservation(context: AuthenticatedRequestContext, bundle: EvaluationPreservationBundle, capability: EvaluationPreservationCapability): Promise<EvaluationProjection>;
}
