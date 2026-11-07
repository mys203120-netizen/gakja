import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { captureRecoveryArchive, createRestoredObjectProvider, restoreRecoveryArchive, verifyRecoveryArchive, type RecoveryLimits } from '../../server/transition/recovery';
import { ObjectProviderError } from '../../server/storage/supabase-object-provider';
import type { ObjectStorageProvider, StorageObjectRef } from '../../server/storage/private-object-ports';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const policy: RecoveryLimits = { maxMetadataBytes: 1024 * 1024, maxObjects: 10, maxObjectBytes: 1024, maxTotalBytes: 4096 };
function provider() {
  const objects = new Map<string, Buffer>(); let writes = 0; let reads = 0;
  const key = (ref: StorageObjectRef) => JSON.stringify([ref.bucket, ref.key]);
  const value: ObjectStorageProvider = {
    async read(ref, options) { reads++; const bytes = objects.get(key(ref)); if (!bytes) throw new ObjectProviderError('STORAGE_NOT_FOUND'); assert.ok(bytes.length <= options.maxBytes); return Buffer.from(bytes); },
    async upload(ref, bytes) { writes++; if (objects.has(key(ref))) throw new ObjectProviderError('STORAGE_CONFLICT'); objects.set(key(ref), Buffer.from(bytes)); },
    async copy() { throw new Error('unused'); }, async remove() { throw new Error('unused'); },
  };
  return { value, objects, key, get writes() { return writes; }, get reads() { return reads; } };
}
async function fixture() {
  const source = provider(); const bytes = Buffer.from('원문🙂\r\nexact canonical bytes');
  const object = { objectId: randomUUID(), logicalRef: { bucket: 'source-private', key: 'originalprefix/final/' + randomUUID() }, sizeBytes: bytes.length, contentSha256: hash(bytes) };
  source.objects.set(source.key(object.logicalRef), bytes);
  const metadataJson = JSON.stringify({ version: 'transition-recovery-metadata-v1', objects: [object], rawSignedText: '{ "id": "unchanged" }\r\n', missing: {}, nullable: { sourceRevision: null } });
  const metadata = { metadataJson, metadataSha256: hash(metadataJson) };
  return { source, bytes, object, metadata, archive: await captureRecoveryArchive(metadata, source.value, policy) };
}
test('recovery preserves exact metadata and object bytes while mapping only physical references', async () => {
  const f = await fixture(), destination = provider(); let publications = 0;
  const result = await restoreRecoveryArchive({ archive: f.archive, destination: destination.value, bucket: 'restored-private', keyPrefix: 'restoredprefix', policy,
    publication: { async publish(value) { publications++; assert.equal(value.metadataJson, f.metadata.metadataJson); assert.equal(value.metadataSha256, f.metadata.metadataSha256); } } });
  assert.equal(publications, 1); assert.equal(result.measurement.objects, 1); assert.ok(result.measurement.elapsedMs >= 0);
  const restored = createRestoredObjectProvider({ destination: destination.value, locations: result.locations });
  assert.deepEqual(await restored.read(f.object.logicalRef, { maxBytes: 1024 }), f.bytes);
  assert.equal(f.source.reads, 1); assert.equal(result.locations[0].logicalRef.key, f.object.logicalRef.key);
  await assert.rejects(restored.read({ bucket: 'source-private', key: 'originalprefix/final/' + randomUUID() }, { maxBytes: 1024 }), /TRANSITION_RECOVERY_INVALID/u);
  await assert.rejects(restored.upload(f.object.logicalRef, f.bytes, { contentType: 'text/plain' }), /READ_ONLY/u);
  await assert.rejects(restored.copy(f.object.logicalRef, f.object.logicalRef), /READ_ONLY/u);
  await assert.rejects(restored.remove(f.object.logicalRef), /READ_ONLY/u);
});
test('missing, tampered, extra and noncanonical object bytes fail before any destination write or publication', async () => {
  const f = await fixture();
  for (const mutate of [
    (a: typeof f.archive) => { a.objects = []; },
    (a: typeof f.archive) => { a.objects[0].bytesBase64 = Buffer.from('tampered').toString('base64'); },
    (a: typeof f.archive) => { a.objects[0].bytesBase64 += '\n'; },
    (a: typeof f.archive) => { a.objects.push(a.objects[0]); },
    (a: typeof f.archive) => { a.metadataJson += ' '; },
    (a: typeof f.archive) => { a.objects[0].logicalRef = { ...a.objects[0].logicalRef, key: a.objects[0].logicalRef.key + 'x' }; },
  ]) {
    const archive = structuredClone(f.archive); mutate(archive); const destination = provider();
    await assert.rejects(restoreRecoveryArchive({ archive, destination: destination.value, bucket: 'restored-private', keyPrefix: 'restoredprefix', policy,
      publication: { async publish() { assert.fail('invalid archive must not publish'); } } }), /TRANSITION_RECOVERY_INVALID/u);
    assert.equal(destination.writes, 0);
  }
});
test('interrupted restore leaves no publication and retry verifies existing bytes before atomic publication', async () => {
  const f = await fixture(), destination = provider(); let publications = 0;
  const input = { archive: f.archive, destination: destination.value, bucket: 'restored-private', keyPrefix: 'restoredprefix', policy,
    publication: { async publish() { publications++; } } };
  await assert.rejects(restoreRecoveryArchive({ ...input, async onObjectVerified() { throw new Error('controlled interruption'); } }), /controlled interruption/u);
  assert.equal(publications, 0); assert.equal(destination.writes, 1);
  await restoreRecoveryArchive(input); assert.equal(publications, 1); assert.equal(destination.writes, 1);
  const ref = { bucket: input.bucket, key: input.keyPrefix + '/final/' + f.object.objectId };
  destination.objects.set(destination.key(ref), Buffer.from('bad destination bytes'));
  await assert.rejects(restoreRecoveryArchive(input), /TRANSITION_RECOVERY_INVALID/u); assert.equal(publications, 1);
});
test('source mutation, metadata limits and duplicate refs fail closed', async () => {
  const f = await fixture(); f.source.objects.set(f.source.key(f.object.logicalRef), Buffer.from('different'));
  await assert.rejects(captureRecoveryArchive(f.metadata, f.source.value, policy), /TRANSITION_RECOVERY_INVALID/u);
  assert.throws(() => verifyRecoveryArchive(f.archive, { ...policy, maxTotalBytes: 1 }), /TRANSITION_RECOVERY_INVALID/u);
  assert.throws(() => createRestoredObjectProvider({ destination: provider().value,
    locations: [1, 2].map(() => ({ ...f.object, physicalRef: { bucket: 'restored-private', key: 'restoredprefix/final/' + randomUUID() } })) }), /TRANSITION_RECOVERY_INVALID/u);
});
