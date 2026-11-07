import type { RequestContext, ResourceBinding } from '../auth/request-identity';

export class SessionCommandError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); this.name = 'SessionCommandError'; }
}

/** Database command authority is separate from runtime-v1's logical socket
 * epoch and from the existing five-method local SessionStore. */
export interface SessionWriterBinding extends ResourceBinding {
  sessionId: string; contextSnapshotSha256: string;
}
export type SessionCommandKind = 'create' | 'answer' | 'next' | 'event' | 'capture' | 'recover' | 'closing' | 'end-accept' | 'end-finalize';
export interface SessionCommandSnapshot {
  version: 'authenticated-session-snapshot-v1'; binding: SessionWriterBinding;
  writer: 'db' | 'read-only' | 'local'; writerGeneration: string; writerToken: string;
  revision: string; created: boolean;
  serverNow: string;
  /** Outer DB-clock observation for the current writer generation. It is not
   * a connection-presence lease and does not rewrite the frozen session body. */
  lastDisconnectedAt?: string;
  sessionJson: string; sessionSha256: string; contextJson: string; pinsJson: string;
  contextSnapshotSha256: string; pinsSha256: string;
  endIntent: SessionEndIntent | null; handoff: SessionEvaluationHandoff | null;
}
export interface SessionCommandIdentity {
  sessionId: string; key: string; kind: SessionCommandKind; inputSha256: string;
  semanticKey: string; semanticSha256: string;
}
export interface SessionCommandPrecondition {
  expectedRevision: string; writerGeneration: string; writerToken: string;
}
export interface SessionCommandRequest extends SessionCommandIdentity, SessionCommandPrecondition {
  /** Explicitly restart an unfinished attempt under a newly claimed writer.
   * Its original operation/input identity stays immutable. */
  resume?: boolean;
}
export interface SessionCommandReceipt extends SessionCommandIdentity {
  operationId: string; committedRevision: string; writerGeneration: string;
  resultJson: string; resultSha256: string; sessionSha256: string; committedAt: string;
  replay: boolean;
}
export interface SessionCommandIntent extends SessionCommandRequest {
  operationId: string; attemptId: string; operationToken: string;
}
export type SessionCommandStart =
  | { status: 'committed'; receipt: SessionCommandReceipt }
  | { status: 'pending'; intent: SessionCommandIntent; snapshot: SessionCommandSnapshot };
export interface SessionMandatoryEvent { eventId: string; kind: string; payloadJson: string }
export interface SessionAnswerFact {
  turnId: string; answerId: string; captureRevision: number; inputSha256: string;
}
export interface SessionEndIntent {
  intentId: string; inputJson: string; inputSha256: string;
  acceptedRevision: string; acceptedAt: string;
}
export interface SessionEvaluationHandoff {
  intentId: string; version: 'session-evaluation-handoff-v1'; state: 'awaiting-evaluation-consumer';
  payloadJson: string; payloadSha256: string; contextSnapshotSha256: string;
  frozenSessionSha256: string; committedRevision: string;
}
export interface SessionCommandProgress {
  sessionJson: string; events: readonly SessionMandatoryEvent[];
}
export interface SessionCommandCommit extends SessionCommandProgress {
  resultJson: string;
  /** Recovery commits its domain epoch and the database writer fence together. */
  rotateWriter?: boolean;
  answerFact?: SessionAnswerFact;
  endIntent?: { intentId: string; inputJson: string; inputSha256: string };
  handoff?: { intentId: string; payloadJson: string; payloadSha256: string; frozenSessionSha256: string };
}
export interface SessionEnrollment {
  sessionId: string; creationKey: string; inputSha256: string;
  sessionJson: string; contextJson: string; pinsJson: string;
  /** Existing verified source/bank fingerprint, not the context transport hash. */
  sourceSha256: string;
  sourceRevision?: string | null;
}
export interface SessionEnrollmentCapability { readonly kind: 'session-enrollment-capability-v1' }
export interface SessionWriterClaim extends SessionCommandPrecondition { sessionId: string }
export interface SessionPreservationBundle {
  version: 'session-preservation-v1'; payloadJson: string; sha256: string;
}
export interface SessionCommandRepository {
  enroll(context: RequestContext, input: SessionEnrollment, capability: SessionEnrollmentCapability): Promise<SessionCommandSnapshot>;
  /** This lookup permits recovery of a lost create response without issuing a
   * second logical session for the same scoped creation key. */
  findCreation(context: RequestContext, key: string, inputSha256: string): Promise<SessionCommandSnapshot | null>;
  read(context: RequestContext, sessionId: string): Promise<SessionCommandSnapshot | null>;
  list(context: RequestContext): Promise<SessionCommandSnapshot[]>;
  observeConnectionClosed(context: RequestContext, input: { sessionId: string; writerGeneration: string; connectionToken: string }): Promise<string>;
  receipt(context: RequestContext, input: SessionCommandIdentity): Promise<SessionCommandReceipt | null>;
  /** Read-only replay discovery before pure domain preflight. Semantic aliases
   * are still recorded only by the transactional begin/commit boundary. */
  findCommitted(context: RequestContext, input: SessionCommandIdentity): Promise<SessionCommandReceipt | null>;
  receiptByKey(context: RequestContext, input: { sessionId: string; key: string; inputSha256: string }): Promise<SessionCommandReceipt | null>;
  beginIntent(context: RequestContext, input: SessionCommandRequest): Promise<SessionCommandStart>;
  persistProgress(context: RequestContext, intent: SessionCommandIntent, progress: SessionCommandProgress): Promise<SessionCommandStart>;
  commit(context: RequestContext, intent: SessionCommandIntent, commit: SessionCommandCommit): Promise<SessionCommandReceipt>;
  claimWriter(context: RequestContext, input: SessionWriterClaim): Promise<SessionCommandSnapshot>;
  freeze(context: RequestContext, input: SessionWriterClaim): Promise<SessionCommandSnapshot>;
  /** No-session-revision0 only. Authenticated committed payloads cannot be
   * converted to local runtime-v1 as a rollback shortcut. */
  rollbackUncommitted(context: RequestContext, input: SessionWriterClaim): Promise<SessionCommandSnapshot>;
  exportPreservation(context: RequestContext, sessionId: string): Promise<SessionPreservationBundle>;
  /** Restores only to a new owned isolated DB where this session is absent.
   * The restored session remains read-only; original receipts replay intact. */
  restorePreservation(context: RequestContext, bundle: SessionPreservationBundle, capability: SessionEnrollmentCapability): Promise<SessionCommandSnapshot>;
}
