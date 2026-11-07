import type { RequestContext } from '../auth/request-identity';
import type { PrivateObjectKind, PrivateObjectScope, VerifiedPrivateObject } from '../storage/private-object-ports';

export type ShadowSelectionMode = 'current' | 'staged' | 'pinned' | 'historical' | 'revision' | 'review-parent' | 'configured' | 'dependency';
export interface ShadowSelector { role: string; reference?: string; selection?: ShadowSelectionMode }
export interface ShadowDependency { artifactId: string; required: boolean }
export interface ShadowArtifactIdentity {
  artifactId: string; role: string; locatorId: string; reference: string; selection: ShadowSelectionMode;
  scope: 'common' | 'target'; required: boolean;
  sourceRevision?: string | null; versionId?: string | null; legacyId?: string | null; originalPin?: string | null;
  dependencies: readonly ShadowDependency[];
  /** Explicit aliases in the frozen plan, never a path rewriter. */
  aliases?: readonly ShadowSelector[];
}
export interface ShadowPresentArtifact extends ShadowArtifactIdentity {
  availability: 'present'; objectKind: PrivateObjectKind; sizeBytes: number; rawSha256: string;
  domainSha256?: string | null; mediaType?: 'audio/mpeg' | 'audio/wav' | 'image/png' | 'image/jpeg';
}
export interface ShadowAbsentArtifact extends ShadowArtifactIdentity {
  availability: 'absent'; required: false; absenceReason: 'known-absent';
}
export type ShadowArtifactPlan = ShadowPresentArtifact | ShadowAbsentArtifact;
export interface ShadowPointerPlan { name: string; selection: ShadowSelectionMode; artifactId: string }
export interface ShadowRunPlan {
  runId: string; planSha256: string; binding: 'synthetic' | 'local-verification-only';
  ownerId: string; studentId: string; applicationTargetId: string; supportTargetId: string;
  /** Provenance only. It does not grant the authenticated owner any scope. */
  provenanceOwnerId?: string;
  artifacts: readonly ShadowArtifactPlan[]; pointers?: readonly ShadowPointerPlan[];
}
export interface ShadowArtifactRecord {
  runId: string; artifactId: string; role: string; locatorId: string; reference: string; selection: ShadowSelectionMode;
  scope: PrivateObjectScope; required: boolean; availability: 'present' | 'absent';
  sourceRevision?: string | null; versionId?: string | null; legacyId?: string | null; originalPin?: string | null;
  dependencies: readonly ShadowDependency[]; aliases?: readonly ShadowSelector[];
  objectKind?: PrivateObjectKind; sizeBytes?: number; rawSha256?: string; domainSha256?: string | null;
  mediaType?: 'audio/mpeg' | 'audio/wav' | 'image/png' | 'image/jpeg'; absenceReason?: 'known-absent';
  status: 'planned' | 'staged' | 'bound' | 'quarantined' | 'absent';
  receiptId?: string; objectId?: string; objectRevision?: string; object?: VerifiedPrivateObject;
  generation: string; snapshotToken: string;
}
export interface ShadowArtifactBinding extends ShadowArtifactRecord {
  availability: 'present'; status: 'bound'; objectKind: PrivateObjectKind; sizeBytes: number; rawSha256: string;
  receiptId: string; objectId: string; objectRevision: string; object: VerifiedPrivateObject;
}
export interface ShadowPointer { name: string; selection: ShadowSelectionMode; artifactId: string; generation: string }
export interface ShadowSnapshot {
  runId: string; planSha256: string; binding: ShadowRunPlan['binding'];
  ownerId: string; studentId: string; applicationTargetId: string; supportTargetId: string;
  provenanceOwnerId?: string; state: 'open' | 'cancelled' | 'cleaned'; generation: string; snapshotToken: string;
  artifacts: readonly ShadowArtifactRecord[]; pointers: readonly ShadowPointer[];
  plannedPointers?: readonly ShadowPointerPlan[];
}

export interface ShadowImportCapability { readonly kind: 'shadow-import-capability-v1' }
/** Every implementation must revalidate A authority and snapshot generation.
 * Mutations additionally require a finite server-minted run/plan/artifact cap.
 * These methods never hold a DB connection while awaiting object API I/O. */
export interface ShadowRepository {
  registerRun(context: RequestContext, plan: ShadowRunPlan, capability: ShadowImportCapability): Promise<ShadowSnapshot>;
  /** Records an exact C receipt even after cancellation/quarantine so cleanup
   * can recover a lost admission response. Closed recovery stays quarantined;
   * it never grants read, bind, or pointer publication authority. */
  noteReceipt(context: RequestContext, runId: string, artifactId: string, receiptId: string, capability: ShadowImportCapability): Promise<ShadowArtifactRecord>;
  bindObject(context: RequestContext, runId: string, artifactId: string, receiptId: string, capability: ShadowImportCapability): Promise<ShadowArtifactBinding>;
  quarantine(context: RequestContext, runId: string, artifactId: string, capability: ShadowImportCapability): Promise<ShadowArtifactRecord>;
  setPointer(context: RequestContext, runId: string, pointer: ShadowPointerPlan, expectedGeneration: string, capability: ShadowImportCapability): Promise<ShadowPointer | null>;
  cancel(context: RequestContext, runId: string, capability: ShadowImportCapability): Promise<ShadowSnapshot>;
  markCleaned(context: RequestContext, runId: string, capability: ShadowImportCapability): Promise<ShadowSnapshot>;
  capture(context: RequestContext, runId: string): Promise<ShadowSnapshot | null>;
  resolve(context: RequestContext, runId: string, selector: ShadowSelector): Promise<ShadowArtifactBinding | null>;
  unchanged(context: RequestContext, runId: string, generation: string): Promise<boolean>;
}
