import type { FullRecordSource, AnalysisQAManifest, materializeFullStudentAnalysis } from '../data/full-student-analysis';

/** Explicit unknown pins stay null; these local read contracts are not Auth/RLS.
 * Existing payload identities, source paths and serialization remain unchanged. */
export interface ReadScope {
  ownerId: string; studentId: string | null; supportTargetId: string | null;
  pdfSha256: string | null; recordRevision: string | null; sourceRevision: string | null;
  sourceContentSha256: string | null; commonRevision: string | null; targetRevision: string | null;
  profileRevision: string | null;
}
export const emptyReadScope = (ownerId: string): ReadScope => ({ ownerId, studentId: null, supportTargetId: null,
  pdfSha256: null, recordRevision: null, sourceRevision: null, sourceContentSha256: null,
  commonRevision: null, targetRevision: null, profileRevision: null });
/** A legacy provenance string is not an instruction to open a file. Local
 * adapters retain their original path field; object adapters carry a typed
 * locator and cannot masquerade as a local StoredFile path. */
export interface StoredFile { path: string; bytes: Buffer; sha256: string; locator?: never; provenancePath?: never }
export type StoredJson<T> = StoredFile & { value: T };
export interface ShadowStoredFile { path?: never; bytes: Buffer; sha256: string; provenancePath: string;
  locator: { kind: 'verified-shadow-object'; runId: string; artifactId: string; objectId: string; snapshotToken: string } }
export type LocatedStoredFile = StoredFile | ShadowStoredFile;
export type LocatedStoredJson<T> = LocatedStoredFile & { value: T };
export function storedProvenance(file: LocatedStoredFile): string {
  return file.locator ? file.provenancePath : file.path;
}
export interface FullRecordPointer { path: string; pdfSha256: string; contentSha256: string }
export interface AnalysisPointer { path: string; revision: string; sourceContentSha256: string }
export type AnalysisPayload = ReturnType<typeof materializeFullStudentAnalysis> & { sourceRevision?: string; sourceContentSha256?: string };
export interface ConfiguredSourceInput { role: string; path: string; bytes: Buffer | null; sha256: string | null; readError?: unknown }
export interface ConfiguredSourceRead { inputs: ConfiguredSourceInput[]; missing: { role: string; path: string }[] }
export type ReadPurpose = 'runtime-context' | 'staged-context' | 'analysis-validation' | 'source-validation' | 'review-validation' | 'historical-revision';
export interface ScopedRead { scope: ReadScope; purpose: ReadPurpose }
export interface SourceRepository {
  readConfiguredInputs(request: ScopedRead): Promise<ConfiguredSourceRead>;
  readPinnedInput(request: ScopedRead & { pin: { role: string; path: string; sha256: string | null } }): Promise<LocatedStoredFile>;
  readCurrentRecord(request: ScopedRead): Promise<{ pointer: LocatedStoredJson<FullRecordPointer>; document: LocatedStoredJson<FullRecordSource> } | null>;
}
export interface AnalysisRepository {
  readCurrentPointer(request: ScopedRead): Promise<LocatedStoredJson<AnalysisPointer> | null>;
  readAnalysis(request: ScopedRead & { selection: 'current' | 'staged' | 'revision' | 'review-parent'; reference: string }): Promise<LocatedStoredJson<AnalysisPayload>>;
  readQaManifest(request: ScopedRead & { analysisReference: string }): Promise<LocatedStoredJson<AnalysisQAManifest>>;
  readReviewFile(request: ScopedRead & { kind: 'parent-proposal' | 'analysis-source-review' | 'objective-source-review'; reference: string }): Promise<LocatedStoredFile>;
  /** Compare only; never select a newer pointer to assemble a mixed context. */
  currentPointerUnchanged(request: ScopedRead & { captured: LocatedStoredJson<AnalysisPointer> }): Promise<boolean>;
  analysisDocumentUnchanged(request: ScopedRead & { captured: LocatedStoredJson<AnalysisPayload> }): Promise<boolean>;
}
export interface ArtifactReadRequest extends ScopedRead { role: string; reference: string; optional?: boolean }
export interface ArtifactReadRepository {
  /** Exact planned locator lookup. It must distinguish confirmed absence from
   * access/timeout/integrity failures and never follow reference as a path. */
  read(request: ArtifactReadRequest): Promise<LocatedStoredFile | null>;
}
export interface ReadRepositories {
  ownerId: string;
  kind?: 'local' | 'shadow';
  source: SourceRepository;
  analysis: AnalysisRepository;
  artifacts?: ArtifactReadRepository;
  /** Compare the captured DB generation/mappings, including dependency reads.
   * Local adapters do not claim detection of a change-and-restore ABA. */
  assertSnapshotUnchanged?(): Promise<void>;
}
export interface AnalysisReadOptions { repositories?: ReadRepositories; scope?: Partial<ReadScope>; purpose?: ReadPurpose }
export function assertReadOwner(repositories: ReadRepositories, scope: ReadScope): void {
  if (!scope.ownerId || scope.ownerId !== repositories.ownerId) throw new Error('READ_REPOSITORY_OWNER_MISMATCH');
}
