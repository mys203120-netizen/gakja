import type { RequestContext } from '../auth/request-identity';

/** These references are returned by the trusted registration ledger, never URLs
 * or filesystem paths supplied by a browser. Provider implementations enforce
 * the configured origin, bucket and generated key namespace again. */
export interface StorageObjectRef { readonly bucket: string; readonly key: string }
export interface StorageReadOptions { maxBytes: number; timeoutMs?: number; signal?: AbortSignal }
export interface ObjectStorageProvider {
  read(ref: StorageObjectRef, options: StorageReadOptions): Promise<Buffer>;
  upload(ref: StorageObjectRef, bytes: Buffer, options: { contentType: string; signal?: AbortSignal }): Promise<void>;
  copy(from: StorageObjectRef, to: StorageObjectRef, options?: { signal?: AbortSignal }): Promise<void>;
  remove(ref: StorageObjectRef, options?: { signal?: AbortSignal }): Promise<void>;
}

export const privateObjectKinds = ['source-pdf', 'source-markdown', 'source-json', 'analysis-json', 'audio', 'review-bundle', 'source-image', 'review-journal'] as const;
export type PrivateObjectKind = typeof privateObjectKinds[number];
export type PrivateObjectScope =
  | { readonly kind: 'common'; readonly ownerId: string; readonly studentId: string }
  | { readonly kind: 'target'; readonly ownerId: string; readonly studentId: string; readonly applicationTargetId: string; readonly supportTargetId: string };
export type ObjectRegistrationState = 'pending' | 'uploading' | 'verifying' | 'verified' | 'rejected' | 'cancelled' | 'expired';
export interface PrivateObjectSelector { objectId: string; scope?: 'common' | 'target' }
export interface ObjectAdmission {
  kind: PrivateObjectKind;
  scope: 'common' | 'target';
  /** Selection remains restricted by the existing selected A grant. */
  studentId: string;
  sourceRevision?: string | null;
  expectedSize: number;
  expectedSha256: string;
  /** Existing authoritative codec hash, if applicable. Never recomputed here. */
  domainSha256?: string | null;
  idempotencyKey: string;
  /** Expected format, independently checked against the complete bytes. */
  mediaType?: 'audio/mpeg' | 'audio/wav' | 'image/png' | 'image/jpeg';
}
export interface ObjectRegistration {
  receiptId: string;
  objectId: string;
  scope: PrivateObjectScope;
  kind: PrivateObjectKind;
  sourceRevision?: string | null;
  domainSha256?: string | null;
  mediaType?: 'audio/mpeg' | 'audio/wav' | 'image/png' | 'image/jpeg';
  state: ObjectRegistrationState;
  revision: string;
  expectedSize: number;
  expectedSha256: string;
  actualSize: number | null;
  actualSha256: string | null;
  stagingRef: StorageObjectRef;
  finalRef: StorageObjectRef;
  expiresAt: number;
  cleanupState: 'pending' | 'clean' | 'failed';
}
export interface VerifiedPrivateObject {
  receiptId: string;
  objectId: string;
  scope: PrivateObjectScope;
  kind: PrivateObjectKind;
  sourceRevision?: string | null;
  domainSha256?: string | null;
  mediaType?: 'audio/mpeg' | 'audio/wav' | 'image/png' | 'image/jpeg';
  revision: string;
  ref: StorageObjectRef;
  sizeBytes: number;
  contentSha256: string;
}
/** Every method is an authority boundary: implementations revalidate an A-minted
 * context and use a short, scoped SQL transaction. No connection is returned to
 * the orchestrator or held while it awaits a Storage API. All mutation methods
 * use narrow server-only registration functions, never arbitrary request DML. */
export interface PrivateObjectRepository {
  admit(context: RequestContext, input: ObjectAdmission): Promise<ObjectRegistration>;
  /** D-only metadata CAS; old C implementations remain read-compatible. */
  setMediaType?(context: RequestContext, receiptId: string, revision: string, mediaType: NonNullable<ObjectAdmission['mediaType']>): Promise<ObjectRegistration | null>;
  getReceipt(context: RequestContext, receiptId: string): Promise<ObjectRegistration | null>;
  getVerified(context: RequestContext, selector: PrivateObjectSelector): Promise<VerifiedPrivateObject | null>;
  /** CAS transitions; null means the receipt changed concurrently. A verifying
   * retry can return its current claim, but cannot change its immutable refs. */
  beginUpload(context: RequestContext, receiptId: string, revision: string): Promise<ObjectRegistration | null>;
  beginVerification(context: RequestContext, receiptId: string, revision: string): Promise<ObjectRegistration | null>;
  finishVerification(context: RequestContext, receiptId: string, revision: string, actual: { sizeBytes: number; contentSha256: string }): Promise<ObjectRegistration | null>;
  reject(context: RequestContext, receiptId: string, revision: string): Promise<ObjectRegistration | null>;
  cancel(context: RequestContext, receiptId: string): Promise<ObjectRegistration | null>;
  expire(context: RequestContext, receiptId: string): Promise<ObjectRegistration | null>;
  markCleanup(context: RequestContext, receiptId: string, revision: string, result: 'clean' | 'failed'): Promise<ObjectRegistration | null>;
  /** Explicit metadata relation; implementations require scope/kind/source/raw
   * hash agreement with the existing audio binding, not equal filename IDs. */
  audioObject(context: RequestContext, audioId: string): Promise<PrivateObjectSelector | null>;
}
