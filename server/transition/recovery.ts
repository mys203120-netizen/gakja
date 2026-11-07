import { createHash } from 'node:crypto';
import type { ObjectStorageProvider, StorageObjectRef, StorageReadOptions } from '../storage/private-object-ports';
import { ObjectProviderError } from '../storage/supabase-object-provider';

/** Metadata is kept as the exact SQL-produced TEXT. In particular, embedded E/F
 * canonical/signed TEXT is never parsed and serialized as a replacement value. */
export interface RecoveryMetadata { metadataJson: string; metadataSha256: string }
export interface RecoveryObject {
  objectId: string; logicalRef: StorageObjectRef; sizeBytes: number; contentSha256: string;
}
export interface RecoveryObjectBytes extends RecoveryObject { bytesBase64: string }
export interface RecoveryArchive extends RecoveryMetadata {
  version: 'transition-recovery-v1'; objects: RecoveryObjectBytes[]; manifestSha256: string;
}
export interface RecoveryLocation extends RecoveryObject { physicalRef: StorageObjectRef }
export interface RecoveryLimits { maxMetadataBytes: number; maxObjectBytes: number; maxTotalBytes: number; maxObjects: number }
export interface RecoveryPublication {
  /** This must atomically validate the frozen manifest and publish all C/D/E/F
   * rows and the read-only G state. No ready marker may be written earlier. */
  publish(input: RecoveryMetadata & { manifestSha256: string; locations: readonly RecoveryLocation[] }): Promise<void>;
}
export interface RecoveryMeasurement {
  startedAt: string; completedAt: string; elapsedMs: number; objects: number; bytes: number;
  /** A measured restore duration is evidence for this run, never an SLA. */
  kind: 'measured-rehearsal';
}
const sha = /^[a-f0-9]{64}$/u;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function denied(): never { throw new Error('TRANSITION_RECOVERY_INVALID'); }
function key(ref: StorageObjectRef) { return JSON.stringify([ref.bucket, ref.key]); }
function validRef(ref: StorageObjectRef) {
  return ref && /^[a-z0-9][a-z0-9_-]{2,62}$/u.test(ref.bucket) && /^[a-zA-Z0-9_-]{8,64}\/(?:staging|final)\/[a-f0-9-]{36}$/u.test(ref.key);
}
function limits(input: RecoveryLimits) {
  if (!input || !Object.values(input).every(n => Number.isSafeInteger(n) && n > 0)) denied();
}
function objectsFromMetadata(input: RecoveryMetadata, policy: RecoveryLimits): RecoveryObject[] {
  limits(policy);
  if (typeof input.metadataJson !== 'string' || Buffer.byteLength(input.metadataJson) > policy.maxMetadataBytes ||
    !sha.test(input.metadataSha256) || hash(input.metadataJson) !== input.metadataSha256) denied();
  let metadata: { version?: unknown; objects?: RecoveryObject[] };
  try { metadata = JSON.parse(input.metadataJson); } catch { return denied(); }
  if (metadata.version !== 'transition-recovery-metadata-v1' || !Array.isArray(metadata.objects) || metadata.objects.length > policy.maxObjects) denied();
  const ids = new Set<string>(); const refs = new Set<string>(); let total = 0;
  for (const object of metadata.objects) {
    if (!object || !uuid.test(object.objectId) || !validRef(object.logicalRef) || !sha.test(object.contentSha256) ||
      !Number.isSafeInteger(object.sizeBytes) || object.sizeBytes < 1 || object.sizeBytes > policy.maxObjectBytes ||
      ids.has(object.objectId) || refs.has(key(object.logicalRef))) denied();
    ids.add(object.objectId); refs.add(key(object.logicalRef)); total += object.sizeBytes;
    if (!Number.isSafeInteger(total) || total > policy.maxTotalBytes) denied();
  }
  return metadata.objects;
}
function manifest(input: RecoveryMetadata, objects: readonly RecoveryObject[]) {
  return hash(JSON.stringify({ version: 'transition-recovery-manifest-v1', metadataSha256: input.metadataSha256,
    objects: objects.map(({ objectId, logicalRef, sizeBytes, contentSha256 }) => ({ objectId, logicalRef, sizeBytes, contentSha256 })) }));
}
function checkedBytes(object: RecoveryObject, bytes: Buffer) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== object.sizeBytes || hash(bytes) !== object.contentSha256) denied();
  return bytes;
}

/** Call only with the metadata returned by the finite, frozen-scope SQL export.
 * The SQL transaction defines the checkpoint; this function copies every object
 * named by that checkpoint and fails if its current bytes no longer match. */
export async function captureRecoveryArchive(input: RecoveryMetadata, source: ObjectStorageProvider, policy: RecoveryLimits): Promise<RecoveryArchive> {
  const descriptors = objectsFromMetadata(input, policy); const objects: RecoveryObjectBytes[] = [];
  for (const object of descriptors) {
    const bytes = checkedBytes(object, await source.read(object.logicalRef, { maxBytes: object.sizeBytes }));
    objects.push({ ...object, logicalRef: { ...object.logicalRef }, bytesBase64: bytes.toString('base64') });
  }
  return { version: 'transition-recovery-v1', ...input, objects, manifestSha256: manifest(input, objects) };
}

/** Complete validation precedes the first provider mutation. Base64 decoding is
 * strict: Buffer's permissive decoder alone must not silently drop characters. */
export function verifyRecoveryArchive(archive: RecoveryArchive, policy: RecoveryLimits): readonly RecoveryObject[] {
  if (!archive || archive.version !== 'transition-recovery-v1' || !Array.isArray(archive.objects)) denied();
  const expected = objectsFromMetadata(archive, policy);
  if (archive.objects.length !== expected.length || !sha.test(archive.manifestSha256) || archive.manifestSha256 !== manifest(archive, expected)) denied();
  for (let i = 0; i < expected.length; i += 1) {
    const object = archive.objects[i];
    const wanted = expected[i];
    if (object.objectId !== wanted.objectId || key(object.logicalRef) !== key(wanted.logicalRef) || object.sizeBytes !== wanted.sizeBytes || object.contentSha256 !== wanted.contentSha256 ||
      typeof object.bytesBase64 !== 'string' || object.bytesBase64.length > Math.ceil(policy.maxObjectBytes / 3) * 4) denied();
    const bytes = Buffer.from(object.bytesBase64, 'base64');
    if (bytes.toString('base64') !== object.bytesBase64) denied();
    checkedBytes(object, bytes);
  }
  return expected;
}

/** Copy into an independently configured private provider. The caller supplies
 * no source provider here, so restoration cannot fall back to the old endpoint.
 * On interruption there can be verified staged objects, but never published DB
 * rows. A retry rechecks existing destination bytes before reusing them. */
export async function restoreRecoveryArchive(input: {
  archive: RecoveryArchive; destination: ObjectStorageProvider; publication: RecoveryPublication;
  bucket: string; keyPrefix: string; policy: RecoveryLimits;
  onObjectVerified?: (location: RecoveryLocation) => Promise<void>;
}): Promise<{ locations: readonly RecoveryLocation[]; measurement: RecoveryMeasurement }> {
  const start = performance.now(); const startedAt = new Date().toISOString();
  const expected = verifyRecoveryArchive(input.archive, input.policy);
  if (!/^[a-z0-9][a-z0-9_-]{2,62}$/u.test(input.bucket) || !/^[a-zA-Z0-9_-]{8,64}$/u.test(input.keyPrefix)) denied();
  const locations: RecoveryLocation[] = [];
  for (let i = 0; i < expected.length; i += 1) {
    const object = expected[i]; const physicalRef = { bucket: input.bucket, key: input.keyPrefix + '/final/' + object.objectId };
    if (key(physicalRef) === key(object.logicalRef)) denied();
    let found = false;
    try { checkedBytes(object, await input.destination.read(physicalRef, { maxBytes: object.sizeBytes })); found = true; }
    catch (error) { if (!(error instanceof ObjectProviderError) || error.code !== 'STORAGE_NOT_FOUND') throw error; }
    if (!found) {
      await input.destination.upload(physicalRef, Buffer.from(input.archive.objects[i].bytesBase64, 'base64'), { contentType: 'application/octet-stream' });
      checkedBytes(object, await input.destination.read(physicalRef, { maxBytes: object.sizeBytes }));
    }
    const location = { ...object, physicalRef }; locations.push(location);
    await input.onObjectVerified?.(location);
  }
  await input.publication.publish({ metadataJson: input.archive.metadataJson, metadataSha256: input.archive.metadataSha256,
    manifestSha256: input.archive.manifestSha256, locations });
  return { locations, measurement: { kind: 'measured-rehearsal', startedAt, completedAt: new Date().toISOString(),
    elapsedMs: performance.now() - start, objects: locations.length, bytes: locations.reduce((sum, item) => sum + item.sizeBytes, 0) } };
}

/** Logical refs in C rows and signed E/F TEXT stay original. Only this provider
 * boundary translates to an explicit immutable recovery locator. There is no
 * original-provider argument and no identity fallback for an unmapped ref. */
export function createRestoredObjectProvider(input: { destination: ObjectStorageProvider; locations: readonly RecoveryLocation[] }): ObjectStorageProvider {
  const byLogical = new Map<string, RecoveryLocation>(); const physical = new Set<string>();
  for (const location of input.locations) {
    if (!uuid.test(location.objectId) || !validRef(location.logicalRef) || !validRef(location.physicalRef) || !sha.test(location.contentSha256) ||
      !Number.isSafeInteger(location.sizeBytes) || location.sizeBytes < 1 || byLogical.has(key(location.logicalRef)) || physical.has(key(location.physicalRef)) ||
      key(location.logicalRef) === key(location.physicalRef)) denied();
    byLogical.set(key(location.logicalRef), { ...location, logicalRef: { ...location.logicalRef }, physicalRef: { ...location.physicalRef } });
    physical.add(key(location.physicalRef));
  }
  async function writeDenied(): Promise<never> { throw new Error('TRANSITION_RECOVERY_READ_ONLY'); }
  return Object.freeze({
    async read(ref: StorageObjectRef, options: StorageReadOptions) {
      const location = byLogical.get(key(ref));
      if (!location || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < location.sizeBytes) denied();
      return checkedBytes(location, await input.destination.read(location.physicalRef, { ...options, maxBytes: location.sizeBytes }));
    }, upload: writeDenied, copy: writeDenied, remove: writeDenied,
  });
}
