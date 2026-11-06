import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequestIdentityBoundary, type RequestContext } from '../../server/auth/request-identity';
import { createInternalObjectCapability, createPrivateObjectService, PrivateObjectError } from '../../server/storage/private-object-service';
import type { ObjectAdmission, ObjectRegistration, PrivateObjectRepository, ObjectStorageProvider, StorageObjectRef, PrivateObjectKind, VerifiedPrivateObject } from '../../server/storage/private-object-ports';
import { validatePdfStructure, PdfStructureError } from '../../server/storage/pdf-structure';
import { rawHash, syntheticBytes, syntheticPdf, syntheticTwoPagePdf, syntheticEncryptedPdf } from './fixtures';

/** Explicit in-memory fault tests. Actual PostgreSQL + Supabase Storage API
 * integration is a separately invoked file and is never replaced by these. */
async function fixture(limits: { maxBytes?: number; maxConcurrentTransfers?: number; timeoutMs?: number } = {}) {
  let clock = Date.now(), revision = '1', allowed = true;
  const boundary = createRequestIdentityBoundary({ mode: 'service', environment: 'test', now: () => clock,
    verifier: { kind: 'trusted-jwt', async verify() { return { issuer: 'https://unit.example', subject: 'subject', expiresAt: clock + 3_600_000 }; } },
    accounts: { kind: 'synthetic', async resolve() { return allowed ? { accountId: 'account-a', ownerId: 'owner-a', revision,
      grants: [{ studentId: 'student-a', applicationTargetId: 'app-a', supportTargetId: 'profile-a' }] } : null; } },
  });
  const context = boundary.selectScope(await boundary.authenticate('Bearer synthetic-unit-only'), { applicationTargetId: 'app-a' });
  const receipts = new Map<string, ObjectRegistration>(), files = new Map<string, Buffer>();
  const calls = { read: 0, upload: 0, copy: 0, remove: 0, commits: 0 };
  let beforeRead: ((ref: StorageObjectRef, signal?: AbortSignal) => Promise<void>) | undefined;
  let beforeCopy: (() => Promise<void>) | undefined;
  let failFinish = false, loseFinishResponse = false, failRemove = false;
  const key = (ref: StorageObjectRef) => JSON.stringify(ref);
  const provider: ObjectStorageProvider = {
    async read(ref, options) { calls.read++; await beforeRead?.(ref, options.signal); const bytes = files.get(key(ref)); if (!bytes) throw new Error('synthetic missing'); if (bytes.length > options.maxBytes) throw new Error('synthetic too big'); return Buffer.from(bytes); },
    async upload(ref, bytes) { calls.upload++; if (files.has(key(ref))) throw new Error('synthetic conflict'); files.set(key(ref), Buffer.from(bytes)); },
    async copy(from, to) { calls.copy++; await beforeCopy?.(); if (files.has(key(to))) throw new Error('synthetic conflict'); const bytes = files.get(key(from)); if (!bytes) throw new Error('synthetic missing'); files.set(key(to), Buffer.from(bytes)); },
    async remove(ref) { calls.remove++; if (failRemove) throw new Error('synthetic delete outage'); files.delete(key(ref)); },
  };
  async function auth(value: RequestContext) { await boundary.revalidate(value); }
  const copy = <T>(value: T): T => structuredClone(value);
  async function cas(value: RequestContext, id: string, expected: string, state: ObjectRegistration['state']) {
    await auth(value); const found = receipts.get(id); if (!found || found.revision !== expected) return null;
    found.state = state; found.revision = String(Number(found.revision) + 1); return copy(found);
  }
  const repository: PrivateObjectRepository = {
    async admit(value, input) {
      await auth(value);
      const old = [...receipts.values()].find(receipt => Reflect.get(receipt, 'unitKey') === input.idempotencyKey);
      if (old) {
        if (old.expectedSize !== input.expectedSize || old.expectedSha256 !== input.expectedSha256 || old.kind !== input.kind) throw new Error('synthetic idempotency conflict');
        return copy(old);
      }
      const id = randomUUID(); const added: ObjectRegistration = { receiptId: id, objectId: randomUUID(),
        scope: input.scope === 'common' ? { kind: 'common', ownerId: 'owner-a', studentId: input.studentId } :
          { kind: 'target', ownerId: 'owner-a', studentId: input.studentId, applicationTargetId: 'app-a', supportTargetId: 'profile-a' },
        kind: input.kind, ...(Object.hasOwn(input, 'sourceRevision') ? { sourceRevision: input.sourceRevision } : {}),
        ...(Object.hasOwn(input, 'domainSha256') ? { domainSha256: input.domainSha256 } : {}), state: 'pending', revision: '1', expectedSize: input.expectedSize,
        expectedSha256: input.expectedSha256, actualSize: null, actualSha256: null, stagingRef: { bucket: 'unit-private', key: `unit/staging/${id}` },
        finalRef: { bucket: 'unit-private', key: `unit/final/${id}` }, expiresAt: clock + 900_000, cleanupState: 'pending' };
      Reflect.set(added, 'unitKey', input.idempotencyKey); receipts.set(id, added); return copy(added);
    },
    async getReceipt(value, id) { await auth(value); return copy(receipts.get(id) ?? null); },
    async getVerified(value, selector) { await auth(value); const found = [...receipts.values()].find(row => row.objectId === selector.objectId && row.state === 'verified' && (!selector.scope || row.scope.kind === selector.scope));
      if (!found) return null;
      return { receiptId: found.receiptId, objectId: found.objectId, scope: copy(found.scope), kind: found.kind,
        ...(Object.hasOwn(found, 'sourceRevision') ? { sourceRevision: found.sourceRevision } : {}), ...(Object.hasOwn(found, 'domainSha256') ? { domainSha256: found.domainSha256 } : {}),
        revision: found.revision, ref: copy(found.finalRef), sizeBytes: found.actualSize!, contentSha256: found.actualSha256! } satisfies VerifiedPrivateObject;
    },
    async beginUpload(value, id, expected) { await auth(value); const found = receipts.get(id); if (!found || found.revision !== expected || !['pending', 'uploading'].includes(found.state)) return null; if (found.state === 'uploading') return copy(found); return cas(value, id, expected, 'uploading'); },
    async beginVerification(value, id, expected) { await auth(value); const found = receipts.get(id); if (!found || found.revision !== expected || !['pending', 'uploading', 'verifying'].includes(found.state)) return null; return found.state === 'verifying' ? copy(found) : cas(value, id, expected, 'verifying'); },
    async finishVerification(value, id, expected, actual) { if (failFinish) { failFinish = false; throw new Error('synthetic DB outage after copy'); } const result = await cas(value, id, expected, 'verified'); if (!result) return null;
      const found = receipts.get(id)!; found.actualSize = actual.sizeBytes; found.actualSha256 = actual.contentSha256; calls.commits++; if (loseFinishResponse) { loseFinishResponse = false; throw new Error('synthetic lost commit response'); } return copy(found); },
    reject: (value, id, expected) => cas(value, id, expected, 'rejected'),
    async cancel(value, id) { await auth(value); const found = receipts.get(id); return found ? cas(value, id, found.revision, 'cancelled') : null; },
    async expire(value, id) { await auth(value); const found = receipts.get(id); return found ? cas(value, id, found.revision, 'expired') : null; },
    async markCleanup(value, id, expected, result) { await auth(value); const found = receipts.get(id); if (!found || found.revision !== expected) return null; found.cleanupState = result; return copy(found); },
    async audioObject() { return null; },
  };
  const service = createPrivateObjectService({ repository, provider, now: () => clock, ...limits });
  const admission = (kind: PrivateObjectKind = 'source-pdf', bytes = syntheticBytes[kind]()): ObjectAdmission => ({ kind, scope: 'common', studentId: 'student-a', expectedSize: bytes.length, expectedSha256: rawHash(bytes), idempotencyKey: randomUUID() });
  const cap = (input: ObjectAdmission, objectId?: string, current: () => Promise<boolean> = async () => true) => createInternalObjectCapability({ scope: input.scope === 'common' ?
    { kind: 'common', ownerId: 'owner-a', studentId: input.studentId } : { kind: 'target', ownerId: 'owner-a', studentId: input.studentId, applicationTargetId: 'app-a', supportTargetId: 'profile-a' },
    ...(Object.hasOwn(input, 'sourceRevision') ? { sourceRevision: input.sourceRevision } : {}), kinds: [input.kind], idempotencyKeys: [input.idempotencyKey], objectIds: objectId ? [objectId] : [], expiresAt: clock + 600_000, checkCurrent: current });
  async function verified(input = admission(), bytes = syntheticBytes[input.kind]()) {
    const accepted = input.kind === 'source-pdf' ? await service.admitStudent(context, input) : await service.admitGenerated(context, input, cap(input));
    const capability = input.kind === 'source-pdf' ? undefined : cap(input, accepted.objectId);
    await service.upload(context, accepted.receiptId, bytes, capability); const done = await service.complete(context, accepted.receiptId, capability); return { done, input, capability };
  }
  return { context, service, repository, provider, receipts, files, calls, key, admission, cap, verified,
    revoke() { allowed = false; revision = '2'; }, advance(ms: number) { clock += ms; },
    setReadHook(value: typeof beforeRead) { beforeRead = value; }, setCopyHook(value: typeof beforeCopy) { beforeCopy = value; },
    failFinishOnce() { failFinish = true; }, loseFinishOnce() { loseFinishResponse = true; }, failRemoval(value: boolean) { failRemove = value; } };
}
const code = (expected: PrivateObjectError['code']) => (error: unknown) => error instanceof PrivateObjectError && error.code === expected;

test('unit student admission is PDF-only and bounds/hash/source inputs fail before Storage', async () => {
  const f = await fixture(); await assert.rejects(f.service.admitStudent(f.context, f.admission('analysis-json')), code('OBJECT_INTERNAL_AUTHORITY_REQUIRED'));
  const spoofed = { ...f.admission(), bucket: 'other-owner-bucket', ownerId: 'owner-b' }; await assert.rejects(f.service.admitStudent(f.context, spoofed), code('OBJECT_INPUT_INVALID'));
  for (const input of [{ ...f.admission(), expectedSize: 0 }, { ...f.admission(), expectedSize: 17 * 1024 * 1024 }, { ...f.admission(), expectedSha256: 'bad' }, { ...f.admission(), sourceRevision: '' }]) await assert.rejects(f.service.admitStudent(f.context, input), code('OBJECT_INPUT_INVALID'));
  assert.equal(f.calls.upload + f.calls.read, 0);
});
test('unit all supported synthetic formats preserve exact raw bytes including CRLF/emoji/key order and optional pin presence', async () => {
  const f = await fixture();
  for (const kind of Object.keys(syntheticBytes) as PrivateObjectKind[]) {
    const bytes = syntheticBytes[kind](), input = f.admission(kind, bytes); if (kind === 'source-json') { input.sourceRevision = null; input.domainSha256 = 'd'.repeat(64); }
    const { done } = await f.verified(input, bytes); assert.deepEqual(await f.service.read(f.context, { objectId: done.objectId }), bytes);
    assert.equal(Object.hasOwn(done, 'sourceRevision'), kind === 'source-json'); if (kind === 'source-json') assert.notEqual(done.domainSha256, done.actualSha256);
  }
});
test('unit reader checks metadata authority before provider and current grant after async download', async () => {
  const f = await fixture(), { done } = await f.verified(); f.calls.read = 0;
  await assert.rejects(f.service.read({ mode: 'local-development', ownerId: 'owner-a' }, { objectId: done.objectId })); assert.equal(f.calls.read, 0);
  f.setReadHook(async () => { f.revoke(); }); await assert.rejects(f.service.read(f.context, { objectId: done.objectId })); assert.equal(f.calls.read, 1);
});
test('unit read corruption, post-read ref/state replacement and unsupported Range return no bytes', async () => {
  const f = await fixture(), { done } = await f.verified();
  await assert.rejects(f.service.read(f.context, { objectId: done.objectId }, { range: 'bytes=0-1' }), code('OBJECT_RANGE_UNSUPPORTED'));
  f.files.set(f.key(done.finalRef), Buffer.from('tampered')); await assert.rejects(f.service.read(f.context, { objectId: done.objectId }), code('OBJECT_INTEGRITY_FAILED'));
  f.files.set(f.key(done.finalRef), syntheticBytes['source-pdf']()); f.setReadHook(async () => { f.receipts.get(done.receiptId)!.revision = '999'; });
  await assert.rejects(f.service.read(f.context, { objectId: done.objectId }), code('OBJECT_STATE_CONFLICT'));
});
test('unit partial verification failure rejects receipt and cannot create a readable object', async () => {
  const f = await fixture(), input = f.admission(), accepted = await f.service.admitStudent(f.context, input);
  f.files.set(f.key(accepted.stagingRef), Buffer.from('corrupt staging'));
  await assert.rejects(f.service.complete(f.context, accepted.receiptId), code('OBJECT_INTEGRITY_FAILED'));
  assert.equal(f.receipts.get(accepted.receiptId)?.state, 'rejected'); await assert.rejects(f.service.read(f.context, { objectId: accepted.objectId }), code('OBJECT_NOT_FOUND'));
});
test('unit copy success followed by DB failure remains tracked and exact final bytes recover on retry', async () => {
  const f = await fixture(), input = f.admission(), accepted = await f.service.admitStudent(f.context, input);
  await f.service.upload(f.context, accepted.receiptId, syntheticBytes['source-pdf']()); f.failFinishOnce(); await assert.rejects(f.service.complete(f.context, accepted.receiptId));
  assert.equal(f.receipts.get(accepted.receiptId)?.state, 'verifying'); assert.ok(f.files.has(f.key(accepted.finalRef)));
  const done = await f.service.complete(f.context, accepted.receiptId); assert.equal(done.state, 'verified'); assert.equal(f.calls.commits, 1);
});
test('unit commit success followed by response loss and duplicate completion returns one immutable result', async () => {
  const f = await fixture(), input = f.admission(), accepted = await f.service.admitStudent(f.context, input);
  await f.service.upload(f.context, accepted.receiptId, syntheticBytes['source-pdf']()); f.loseFinishOnce(); await assert.rejects(f.service.complete(f.context, accepted.receiptId));
  const done = await f.service.complete(f.context, accepted.receiptId); const duplicate = await f.service.complete(f.context, accepted.receiptId);
  assert.deepEqual(done, duplicate); assert.equal(f.calls.commits, 1);
});
test('unit cancellation during copy tombstones and prevents completion publication', async () => {
  const f = await fixture(), input = f.admission(), accepted = await f.service.admitStudent(f.context, input);
  await f.service.upload(f.context, accepted.receiptId, syntheticBytes['source-pdf']()); f.setCopyHook(async () => { await f.service.cancel(f.context, accepted.receiptId); });
  await assert.rejects(f.service.complete(f.context, accepted.receiptId), code('OBJECT_STATE_CONFLICT')); assert.equal(f.calls.commits, 0);
  await assert.rejects(f.service.read(f.context, { objectId: accepted.objectId }), code('OBJECT_NOT_FOUND'));
});
test('unit cleanup records failed deletion, retries it and removes late staging after a previously clean tombstone', async () => {
  const f = await fixture(), { done } = await f.verified(); await f.service.cancel(f.context, done.receiptId);
  f.failRemoval(true); assert.equal((await f.service.cleanup(f.context, done.receiptId)).cleanupState, 'failed');
  f.failRemoval(false); assert.equal((await f.service.cleanup(f.context, done.receiptId)).cleanupState, 'clean'); assert.equal(f.files.size, 0);
  f.files.set(f.key(done.stagingRef), syntheticBytes['source-pdf']()); await f.service.cleanup(f.context, done.receiptId); assert.equal(f.files.size, 0);
});
test('unit expiry blocks late completion and leaves physical cleanup explicit', async () => {
  const f = await fixture(), accepted = await f.service.admitStudent(f.context, f.admission());
  f.advance(900_000); await assert.rejects(f.service.complete(f.context, accepted.receiptId), code('OBJECT_EXPIRED'));
  assert.equal(f.calls.copy, 0);
});
test('unit finite internal capability is minted, kind/source/object bound, current and expiring', async () => {
  const f = await fixture(), input = f.admission('analysis-json');
  await assert.rejects(f.service.admitGenerated(f.context, input, { kind: 'internal-object-capability-v1' }), code('OBJECT_INTERNAL_AUTHORITY_REQUIRED'));
  const { done } = await f.verified(input);
  await assert.rejects(f.service.readForInternal(f.context, { objectId: done.objectId }, f.cap(input, 'another-object')), code('OBJECT_INTERNAL_AUTHORITY_REQUIRED'));
  await assert.rejects(f.service.readForInternal(f.context, { objectId: done.objectId }, f.cap(input, done.objectId, async () => false)), code('OBJECT_INTERNAL_AUTHORITY_REQUIRED'));
  assert.deepEqual(await f.service.readForInternal(f.context, { objectId: done.objectId }, f.cap(input, done.objectId)), syntheticBytes['analysis-json']());
});
test('unit concurrency is bounded and abort releases slots without returning unverified bytes', async () => {
  const f = await fixture({ maxConcurrentTransfers: 1 }), { done } = await f.verified(); let entered!: () => void;
  const entry = new Promise<void>(resolve => { entered = resolve; });
  f.setReadHook(async (_ref, signal) => { entered(); await new Promise<void>((_resolve, reject) => { signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }); });
  const control = new AbortController(), first = f.service.read(f.context, { objectId: done.objectId }, { signal: control.signal }); await entry;
  await assert.rejects(f.service.read(f.context, { objectId: done.objectId }), code('OBJECT_BUSY')); control.abort(); await assert.rejects(first, code('OBJECT_PROVIDER_UNAVAILABLE'));
  f.setReadHook(undefined); assert.deepEqual(await f.service.read(f.context, { objectId: done.objectId }), syntheticBytes['source-pdf']());
});
test('unit PDF magic and EOF without a valid document cannot be uploaded or marked verified', async () => {
  const f = await fixture(), bytes = Buffer.from('%PDF-1.7\nnot-a-document\n%%EOF\n'), input = f.admission('source-pdf', bytes), accepted = await f.service.admitStudent(f.context, input);
  await assert.rejects(f.service.upload(f.context, accepted.receiptId, bytes), code('OBJECT_INPUT_INVALID')); assert.equal(f.calls.upload, 0);
  await assert.rejects(validatePdfStructure(Buffer.from('%PDF-junk\n%%EOF')), error => error instanceof PdfStructureError && error.code === 'PDF_FORMAT_INVALID');
});
test('unit password-protected PDF is rejected by the existing PDF.js parser without requesting or logging a password', async () => {
  await assert.rejects(validatePdfStructure(syntheticEncryptedPdf()), error => error instanceof PdfStructureError && error.code === 'PDF_ENCRYPTION_UNSUPPORTED');
});
test('unit actual PDF page-tree opening obeys the explicit page limit and preserves original bytes', async () => {
  const bytes = syntheticTwoPagePdf(), before = rawHash(bytes); assert.equal(await validatePdfStructure(syntheticPdf()), 1);
  assert.equal(await validatePdfStructure(bytes), 2); await assert.rejects(validatePdfStructure(bytes, { maxPages: 1 }), error => error instanceof PdfStructureError && error.code === 'PDF_PAGE_LIMIT');
  assert.equal(rawHash(bytes), before);
});
test('unit process-wide PDF worker bound rejects excess work before allocation and releases slots', async () => {
  const bytes = syntheticPdf(), first = validatePdfStructure(bytes), second = validatePdfStructure(bytes);
  await assert.rejects(validatePdfStructure(bytes), error => error instanceof PdfStructureError && error.code === 'PDF_VALIDATION_BUSY');
  assert.deepEqual(await Promise.all([first, second]), [1, 1]); assert.equal(await validatePdfStructure(bytes), 1);
});
test('unit PDF worker timeout terminates parsing and releases its bounded worker slot', async () => {
  await assert.rejects(validatePdfStructure(syntheticPdf(), { timeoutMs: 1 }), error => error instanceof PdfStructureError && error.code === 'PDF_PARSE_TIMEOUT');
  assert.equal(await validatePdfStructure(syntheticPdf()), 1);
});
