import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createRequestIdentityBoundary, RequestAccessError, type AuthenticatedRequestContext, type PrincipalVerifier, type RequestContext } from '../../server/auth/request-identity';
import { createTrustedJwtVerifier } from '../../server/auth/jose-jwt-verifier';
import { createPostgresAccountResolver, createPostgresRequestAuthority, createPostgresTestResources, createPostgresWorkerBindingResolver } from '../../server/db/postgres-authority';
import { createPostgresObjectRepository } from '../../server/db/postgres-object-repository';
import { createTrustedEvaluationWorkerExecution, assertWorkerExecution } from '../../server/internal-execution';
import { createServiceRealtimeServer } from '../../server/request-realtime-server';
import { snapshotHash } from '../../server/session-runtime';
import { createInternalObjectCapability, createPrivateObjectService, PrivateObjectError, type InternalObjectCapability } from '../../server/storage/private-object-service';
import { createSupabaseObjectProvider } from '../../server/storage/supabase-object-provider';
import { withPrivateObjectAudio } from '../../server/storage/service-object-audio';
import type { ObjectAdmission, ObjectStorageProvider, PrivateObjectKind, PrivateObjectScope, StorageObjectRef, PrivateObjectRepository } from '../../server/storage/private-object-ports';
import { closePools, testPools } from './storage-test-database';
import { rawHash, syntheticBytes } from './fixtures';

/** This file requires real PostgreSQL and the official Supabase Storage API.
 * No missing-service skip or file-backed mock is permitted. Fault hooks wrap
 * real upload/download/copy operations and are explicitly named in cases. */
const pools = testPools(1); test.after(() => closePools(pools));
const apiUrl = process.env.PR07C_TEST_STORAGE_API_URL, credential = process.env.PR07C_TEST_STORAGE_SERVICE_KEY;
const bucket = process.env.PR07C_TEST_BUCKET, keyPrefix = process.env.PR07C_TEST_KEY_PREFIX;
if (!apiUrl || !credential || !bucket || !keyPrefix) throw new Error('PR07C_REAL_STORAGE_REQUIRED');
const issuers = { a: 'https://issuer-a.example', b: 'https://issuer-b.example', c: 'https://issuer-a.example' };
type Who = keyof typeof issuers;
const keys = await generateKeyPair('ES256');
const jwk = { ...await exportJWK(keys.publicKey), kid: 'pr07c-real-storage-signature', alg: 'ES256' };
const code = (value: PrivateObjectError['code']) => (error: unknown) => error instanceof PrivateObjectError && error.code === value;
async function fixture() {
  let clock = Date.now(); const now = () => clock;
  const candidates = ['https://issuer-a.example', 'https://issuer-b.example'].map(issuer => createTrustedJwtVerifier({ issuer, audience: 'pr07c-isolated-service', algorithms: ['ES256'], jwks: { keys: [jwk] }, now }));
  const verifier: PrincipalVerifier = { kind: 'trusted-jwt', async verify(token) {
    for (const candidate of candidates) { try { return await candidate.verify(token); } catch (error) { if (!(error instanceof RequestAccessError) || error.status === 503) throw error; } }
    throw new RequestAccessError(401, 'AUTH_INVALID');
  } };
  const identity = createRequestIdentityBoundary({ mode: 'service', verifier, accounts: createPostgresAccountResolver(pools.request, { now }), now });
  const authority = createPostgresRequestAuthority(pools.request, identity);
  const repository = createPostgresObjectRepository({ authority, boundary: identity, mappingPool: pools.mapping, bucket: bucket!, keyPrefix: keyPrefix! });
  const calls = { read: 0, upload: 0, copy: 0, remove: 0, syntheticAudio: 0 };
  const actual = createSupabaseObjectProvider({ apiUrl: apiUrl!, serviceCredential: credential!, bucket: bucket!, keyPrefix: keyPrefix!, allowLoopbackHttp: true });
  let afterRead: ((ref: StorageObjectRef) => Promise<void>) | undefined, beforeCopy: (() => Promise<void>) | undefined;
  const provider: ObjectStorageProvider = {
    async read(ref, options) { calls.read++; const bytes = await actual.read(ref, options); await afterRead?.(ref); return bytes; },
    async upload(ref, bytes, options) { calls.upload++; return actual.upload(ref, bytes, options); },
    async copy(from, to, options) { calls.copy++; await beforeCopy?.(); return actual.copy(from, to, options); },
    async remove(ref, options) { calls.remove++; return actual.remove(ref, options); },
  };
  const service = createPrivateObjectService({ repository, provider, now });
  const token = async (who: Who) => new SignJWT().setProtectedHeader({ alg: 'ES256', kid: jwk.kid }).setIssuer(issuers[who]).setSubject(who === 'c' ? 'c' : 'shared')
    .setAudience('pr07c-isolated-service').setExpirationTime(Math.floor(clock / 1000) + 3600).sign(keys.privateKey);
  async function context(who: Who, app = `app-${who}`) {
    const authenticated = await identity.authenticate(`Bearer ${await token(who)}`);
    return identity.selectScope(authenticated, { applicationTargetId: app }) as AuthenticatedRequestContext;
  }
  function admission(who: Who, kind: PrivateObjectKind = 'source-pdf', scope: 'common' | 'target' = 'common', bytes = syntheticBytes[kind]()): ObjectAdmission {
    return { kind, scope, studentId: `student-${who}`, expectedSize: bytes.length, expectedSha256: rawHash(bytes), idempotencyKey: randomUUID(),
      ...(who === 'b' ? { sourceRevision: null } : who === 'c' ? { sourceRevision: 'source-r1' } : {}) };
  }
  function scopeFor(context: AuthenticatedRequestContext, input: ObjectAdmission): PrivateObjectScope {
    return input.scope === 'common' ? { kind: 'common', ownerId: context.account.ownerId, studentId: input.studentId } :
      { kind: 'target', ownerId: context.account.ownerId, studentId: input.studentId, applicationTargetId: context.scope!.applicationTargetId, supportTargetId: context.scope!.supportTargetId };
  }
  function capability(context: AuthenticatedRequestContext, input: ObjectAdmission, objectId?: string): InternalObjectCapability {
    const who = context.account.ownerId === 'owner-a' ? 'a' : 'b', jobId = who.repeat(64), workerSubject = `worker-${who}`;
    const resolveBinding = createPostgresWorkerBindingResolver(pools.worker, workerSubject);
    const execution = createTrustedEvaluationWorkerExecution({ subjectId: workerSubject, issuedAt: clock - 1000, expiresAt: clock + 600_000, jobIds: [jobId], resolveBinding });
    return createInternalObjectCapability({ scope: scopeFor(context, input), ...(Object.hasOwn(input, 'sourceRevision') ? { sourceRevision: input.sourceRevision } : {}),
      kinds: [input.kind], idempotencyKeys: [input.idempotencyKey], objectIds: objectId ? [objectId] : [], expiresAt: clock + 600_000,
      async checkCurrent() {
        assertWorkerExecution(execution, now()); const binding = await resolveBinding(jobId);
        if (!binding || binding.ownerId !== context.account.ownerId || binding.studentId !== input.studentId || binding.supportTargetId !== context.scope?.supportTargetId) return false;
        // B's legacy domain result deliberately omits applicationTargetId.
        // Check the separately stored personal target/source relation through
        // the actual restricted worker role, never substitute supportTargetId.
        const client = await pools.worker.connect();
        try {
          await client.query('BEGIN');
          await client.query("SELECT set_config('gakja.worker_subject',$1,true),set_config('gakja.job_id',$2,true)", [workerSubject, jobId]);
          const { rows } = await client.query('SELECT application_target_id,source_present,source_revision FROM gakja.job_bindings WHERE job_id=$1', [jobId]);
          const row = rows[0];
          return rows.length === 1 && row.application_target_id === context.scope?.applicationTargetId && row.source_present === Object.hasOwn(input, 'sourceRevision') && row.source_revision === (input.sourceRevision ?? null);
        } finally { await client.query('ROLLBACK'); await client.query('RESET ALL'); client.release(); }
      },
    });
  }
  async function verified(who: Who, input = admission(who), bytes = syntheticBytes[input.kind]()) {
    const selected = await context(who);
    const accepted = input.kind === 'source-pdf' ? await service.admitStudent(selected, input) : await service.admitGenerated(selected, input, capability(selected, input));
    const cap = input.kind === 'source-pdf' ? undefined : capability(selected, input, accepted.objectId);
    await service.upload(selected, accepted.receiptId, bytes, cap); const done = await service.complete(selected, accepted.receiptId, cap);
    return { selected, input, cap, done, bytes };
  }
  function httpService(hooks: { afterAudio?: () => Promise<void>; binding?: () => void; refreshed?: () => void } = {}) {
    const synthetic = createPostgresTestResources(authority, { async readStatus() { return { review: 'review_required', score: null }; }, async readSession() { return null; }, async readAudio() { calls.syntheticAudio++; throw new Error('SYNTHETIC_AUDIO_MUST_NOT_RUN'); } });
    const storage = withPrivateObjectAudio(synthetic, service, identity);
    const resources = { ...storage,
      async audioBinding(...args: Parameters<typeof storage.audioBinding>) { const value = await storage.audioBinding(...args); hooks.binding?.(); return value; },
      async readAudio(...args: Parameters<typeof storage.readAudio>) { const value = await storage.readAudio(...args); await hooks.afterAudio?.(); return value; },
    };
    // Observe only the handler's actual preflight revalidation. Repository and
    // metadata composition continue to use the original minted boundary.
    const serviceIdentity = { ...identity, async revalidate(context: RequestContext) { const value = await identity.revalidate(context); hooks.refreshed?.(); return value; } };
    return createServiceRealtimeServer({ identity: serviceIdentity, resources, environment: 'test', now });
  }
  return { now, context, token, admission, capability, verified, repository, authority, identity, service, provider, actual, calls, httpService,
    hookRead(value: typeof afterRead) { afterRead = value; }, hookCopy(value: typeof beforeCopy) { beforeCopy = value; }, advance(ms: number) { clock += ms; } };
}

test('actual A/B common and target registrations return exact Storage API bytes with distinct ownership and source presence', async () => {
  const f = await fixture();
  for (const who of ['a', 'b', 'c'] as const) for (const scope of ['common', 'target'] as const) {
    const value = await f.verified(who, f.admission(who, 'source-pdf', scope));
    assert.deepEqual(await f.service.read(value.selected, { objectId: value.done.objectId, scope }), value.bytes);
    assert.equal(value.done.scope.kind, scope); assert.equal(Object.hasOwn(value.done, 'sourceRevision'), who !== 'a');
    if (who === 'c') assert.equal(value.done.sourceRevision, 'source-r1');
    if (scope === 'common') assert.equal('applicationTargetId' in value.done.scope, false);
  }
  const common = await pools.admin.query("SELECT count(*)::int n FROM gakja.storage_uploads WHERE scope_kind='common' AND (application_target_id IS NOT NULL OR support_target_id IS NOT NULL)"); assert.equal(common.rows[0].n, 0);
});

test('actual generated MD/JSON/analysis/WAV/bundle formats retain raw bytes and existing domain hash without granting approval', async () => {
  const f = await fixture();
  for (const kind of ['source-markdown', 'source-json', 'analysis-json', 'audio', 'review-bundle'] as const) {
    const input = f.admission('a', kind, kind === 'audio' ? 'target' : 'common'); if (kind === 'analysis-json') input.domainSha256 = snapshotHash(JSON.parse(syntheticBytes[kind]().toString('utf8')));
    const value = await f.verified('a', input); assert.deepEqual(await f.service.read(value.selected, { objectId: value.done.objectId }), value.bytes);
    assert.equal(value.done.actualSha256, rawHash(value.bytes)); if (kind === 'analysis-json') assert.notEqual(value.done.domainSha256, value.done.actualSha256);
  }
  assert.equal(f.calls.syntheticAudio, 0);
});

test('actual version and legacy lookups follow explicit byte/domain/source FKs without rewriting legacy identifiers', async () => {
  const f = await fixture();
  for (const scope of ['common', 'target'] as const) {
    const table = scope === 'common' ? 'common_versions' : 'target_versions';
    const { rows } = await pools.admin.query(`SELECT * FROM gakja.${table} WHERE owner_id='owner-a' AND version_id=$1`, [scope === 'common' ? 'same-common-version' : 'same-target-version']), original = rows[0]; assert.ok(original);
    assert.equal(snapshotHash(JSON.parse(original.original_bytes.toString('utf8'))), original.domain_sha256);
    const input = f.admission('a', 'analysis-json', scope, original.original_bytes); input.domainSha256 = original.domain_sha256;
    const value = await f.verified('a', input, original.original_bytes), versionId = randomUUID(), legacyId = `c-legacy-${randomUUID()}`, originalPin = 'controlled-synthetic-original-pin';
    const baseColumns = 'owner_id,student_id,kind,revision,version_id,source_present,source_revision,content_sha256,domain_sha256,original_ref,original_bytes,projection';
    if (scope === 'common') {
      await pools.mapping.query(`INSERT INTO gakja.common_versions(${baseColumns}) VALUES('owner-a','student-a',$1,'c-r1',$2,false,NULL,$3,$4,'synthetic://c-version',$5,$6::jsonb)`, [original.kind, versionId, rawHash(value.bytes), original.domain_sha256, value.bytes, value.bytes.toString('utf8')]);
      await pools.mapping.query('INSERT INTO gakja.common_legacy_mappings(owner_id,student_id,resource_kind,legacy_id,source_present,source_revision,original_pin,storage_id,attribution_ref) VALUES($1,$2,$3,$4,false,NULL,$5,$6,$7)', ['owner-a', 'student-a', original.kind, legacyId, originalPin, versionId, 'controlled-c-test-attribution']);
    } else {
      await pools.mapping.query(`INSERT INTO gakja.target_versions(owner_id,student_id,application_target_id,support_target_id,kind,revision,version_id,source_present,source_revision,content_sha256,domain_sha256,original_ref,original_bytes,projection) VALUES('owner-a','student-a','app-a','domain-track',$1,'c-r1',$2,false,NULL,$3,$4,'synthetic://c-version',$5,$6::jsonb)`, [original.kind, versionId, rawHash(value.bytes), original.domain_sha256, value.bytes, value.bytes.toString('utf8')]);
      await pools.mapping.query('INSERT INTO gakja.legacy_mappings(owner_id,student_id,application_target_id,support_target_id,resource_kind,legacy_id,source_present,source_revision,original_pin,storage_id,attribution_ref) VALUES($1,$2,$3,$4,$5,$6,false,NULL,$7,$8,$9)', ['owner-a', 'student-a', 'app-a', 'domain-track', original.kind, legacyId, originalPin, versionId, 'controlled-c-test-attribution']);
    }
    const linked = await f.repository.linkVersion(value.selected, value.done.receiptId, original.kind, versionId); assert.equal(linked?.objectId, value.done.objectId);
    const legacy = await f.repository.legacyObject(value.selected, scope, original.kind, legacyId, originalPin), version = await f.repository.versionObject(value.selected, scope, original.kind, versionId);
    assert.deepEqual(legacy, version); assert.deepEqual(await f.service.read(value.selected, legacy!), value.bytes);
    assert.equal(await f.repository.legacyObject(value.selected, scope, original.kind, legacyId, 'wrong-original-pin'), null);
    assert.equal(await f.repository.legacyObject(await f.context('b'), scope, original.kind, legacyId, originalPin), null);
  }
});

test('actual cross-owner, wrong selected target/source and forged own-row reference are refused before Storage fetch', async () => {
  const f = await fixture(), value = await f.verified('a'); const b = await f.context('b'), a2 = await f.context('a', 'app-a2'); f.calls.read = 0;
  await assert.rejects(f.service.read(b, { objectId: value.done.objectId })); await assert.rejects(f.service.read(a2, { objectId: value.done.objectId }));
  await assert.rejects(pools.request.query("UPDATE gakja.storage_uploads SET final_key=$1 WHERE receipt_id=$2", [`${keyPrefix}/final/${randomUUID()}`, value.done.receiptId]), error => (error as { code?: string }).code === '42501');
  const spoofed = { ...f.admission('a'), ownerId: 'owner-b', objectRef: value.done.finalRef };
  await assert.rejects(f.service.admitStudent(value.selected, spoofed), code('OBJECT_INPUT_INVALID'));
  assert.equal(f.calls.read, 0);
});

test('actual metadata-only/pending records and unuploaded completion never become readable', async () => {
  const f = await fixture(), selected = await f.context('a'), accepted = await f.service.admitStudent(selected, f.admission('a')); f.calls.read = 0;
  await assert.rejects(f.service.read(selected, { objectId: accepted.objectId }), code('OBJECT_NOT_FOUND')); assert.equal(f.calls.read, 0);
  await assert.rejects(f.service.complete(selected, accepted.receiptId)); assert.equal((await f.repository.getReceipt(selected, accepted.receiptId))?.state, 'verifying');
  await assert.rejects(f.service.read(selected, { objectId: accepted.objectId }), code('OBJECT_NOT_FOUND'));
  await f.service.cancel(selected, accepted.receiptId); await f.service.cleanup(selected, accepted.receiptId);
});

test('actual Storage integrity detects final-object byte replacement rather than trusting ETag/metadata', async () => {
  const f = await fixture(), value = await f.verified('a');
  const url = new URL(apiUrl!); url.pathname = url.pathname.replace(/\/$/u, '') + '/object/' + encodeURIComponent(value.done.finalRef.bucket) + '/' + value.done.finalRef.key.split('/').map(encodeURIComponent).join('/');
  // Explicit privileged corruption injection through the official API only.
  // Application upload/copy paths themselves never allow final upsert.
  const changed = Buffer.from(value.bytes); changed[changed.length - 3] ^= 1;
  const response = await fetch(url, { method: 'PUT', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/pdf', 'x-upsert': 'true' }, body: new Uint8Array(changed) });
  assert.ok(response.ok); await response.arrayBuffer();
  await assert.rejects(f.service.read(value.selected, { objectId: value.done.objectId }), code('OBJECT_INTEGRITY_FAILED'));
});

test('actual async read releases max1 DB pool and rejects a cancelled object before bytes return', async () => {
  const f = await fixture(), value = await f.verified('a'); let exercised = false;
  f.hookRead(async () => {
    assert.equal(pools.request.waitingCount, 0);
    await f.authority.withScope(value.selected, async client => { assert.equal((await client.query('SELECT 1 n')).rows[0].n, 1); });
    exercised = true; await f.service.cancel(value.selected, value.done.receiptId);
  });
  await assert.rejects(f.service.read(value.selected, { objectId: value.done.objectId }), code('OBJECT_STATE_CONFLICT')); assert.equal(exercised, true);
});

test('actual grant revocation while provider bytes are in flight prevents publication', async () => {
  const f = await fixture(), value = await f.verified('a');
  f.hookRead(async () => { await pools.mapping.query("UPDATE gakja.access_grants SET active=false WHERE account_id='account-a' AND application_target_id='app-a'"); });
  try { await assert.rejects(f.service.read(value.selected, { objectId: value.done.objectId })); }
  finally { await pools.mapping.query("UPDATE gakja.access_grants SET active=true WHERE account_id='account-a' AND application_target_id='app-a'"); }
});

test('actual copy succeeds before injected DB failure, then retry revalidates final bytes and commits one receipt', async () => {
  const f = await fixture(), selected = await f.context('a'), accepted = await f.service.admitStudent(selected, f.admission('a')); await f.service.upload(selected, accepted.receiptId, syntheticBytes['source-pdf']());
  let fail = true;
  const repository: PrivateObjectRepository = { ...f.repository, async finishVerification(...args) { if (fail) { fail = false; throw new Error('controlled DB failure after actual copy'); } return f.repository.finishVerification(...args); } };
  const service = createPrivateObjectService({ repository, provider: f.provider });
  await assert.rejects(service.complete(selected, accepted.receiptId)); assert.equal((await f.repository.getReceipt(selected, accepted.receiptId))?.state, 'verifying');
  assert.deepEqual(await f.actual.read(accepted.finalRef, { maxBytes: 1024 * 1024 }), syntheticBytes['source-pdf']());
  const done = await service.complete(selected, accepted.receiptId), again = await service.complete(selected, accepted.receiptId); assert.equal(done.state, 'verified'); assert.equal(done.objectId, again.objectId);
});

test('actual concurrent completion/cancel keeps a tracked tombstone and no readable/pointer promotion', async () => {
  const f = await fixture(), selected = await f.context('a'), accepted = await f.service.admitStudent(selected, f.admission('a')); await f.service.upload(selected, accepted.receiptId, syntheticBytes['source-pdf']());
  f.hookCopy(async () => { await f.service.cancel(selected, accepted.receiptId); });
  await assert.rejects(f.service.complete(selected, accepted.receiptId), code('OBJECT_STATE_CONFLICT'));
  assert.equal((await f.repository.getReceipt(selected, accepted.receiptId))?.state, 'cancelled');
  await assert.rejects(f.service.read(selected, { objectId: accepted.objectId }), code('OBJECT_NOT_FOUND')); await f.service.cleanup(selected, accepted.receiptId);
});

test('actual signed late staging upload after application cancellation remains unreadable and repeated API cleanup removes it', async () => {
  const f = await fixture(), selected = await f.context('a'), accepted = await f.service.admitStudent(selected, f.admission('a'));
  const signed = await f.actual.createSignedUpload(accepted.stagingRef); await f.service.cancel(selected, accepted.receiptId); await f.service.cleanup(selected, accepted.receiptId);
  await f.actual.uploadSigned(accepted.stagingRef, signed, syntheticBytes['source-pdf'](), 'application/pdf');
  await assert.rejects(f.service.complete(selected, accepted.receiptId), code('OBJECT_STATE_CONFLICT'));
  await assert.rejects(f.service.read(selected, { objectId: accepted.objectId }), code('OBJECT_NOT_FOUND'));
  const cleaned = await f.service.cleanup(selected, accepted.receiptId); assert.equal(cleaned.cleanupState, 'clean'); await assert.rejects(f.actual.read(accepted.stagingRef, { maxBytes: 1024 * 1024 }));
});

test('actual short application deadline expires independently of a still valid provider signed-upload permission', async () => {
  const f = await fixture(), selected = await f.context('a');
  const repository = createPostgresObjectRepository({ authority: f.authority, boundary: f.identity, mappingPool: pools.mapping, bucket: bucket!, keyPrefix: keyPrefix!, admissionTtlSeconds: 1 });
  const service = createPrivateObjectService({ repository, provider: f.provider, now: f.now });
  const accepted = await service.admitStudent(selected, f.admission('a')), signed = await f.actual.createSignedUpload(accepted.stagingRef);
  await new Promise(resolve => setTimeout(resolve, 1300)); f.advance(2000);
  await assert.rejects(service.complete(selected, accepted.receiptId), code('OBJECT_EXPIRED'));
  await f.actual.uploadSigned(accepted.stagingRef, signed, syntheticBytes['source-pdf'](), 'application/pdf');
  assert.equal((await repository.getReceipt(selected, accepted.receiptId))?.state, 'expired');
  await assert.rejects(service.read(selected, { objectId: accepted.objectId }), code('OBJECT_NOT_FOUND')); await service.cleanup(selected, accepted.receiptId);
});

test('actual finite worker job capability can read its explicitly listed object and rejects revoked job or another personal target', async () => {
  const f = await fixture(), input = f.admission('a', 'analysis-json'), value = await f.verified('a', input);
  const cap = f.capability(value.selected, input, value.done.objectId); assert.deepEqual(await f.service.readForInternal(value.selected, { objectId: value.done.objectId }, cap), value.bytes);
  const wrong = f.capability(value.selected, input, randomUUID()); f.calls.read = 0;
  await assert.rejects(f.service.readForInternal(value.selected, { objectId: value.done.objectId }, wrong), code('OBJECT_INTERNAL_AUTHORITY_REQUIRED')); assert.equal(f.calls.read, 0);
  const otherTarget = await f.context('a', 'app-a2'), otherInput = { ...f.admission('a', 'analysis-json', 'target'), sourceRevision: null };
  await assert.rejects(f.service.admitGenerated(otherTarget, otherInput, f.capability(otherTarget, otherInput)), code('OBJECT_INTERNAL_AUTHORITY_REQUIRED')); assert.equal(f.calls.read, 0);
  await pools.mapping.query("UPDATE gakja.worker_job_grants SET active=false WHERE worker_subject='worker-a'");
  try { await assert.rejects(f.service.readForInternal(value.selected, { objectId: value.done.objectId }, cap), code('OBJECT_INTERNAL_AUTHORITY_REQUIRED')); assert.equal(f.calls.read, 0); }
  finally { await pools.mapping.query("UPDATE gakja.worker_job_grants SET active=true WHERE worker_subject='worker-a'"); }
});

test('actual signed JWT to A/B DB authority to Storage-backed HTTP audio preserves bytes/no-store and Range refusal without synthetic audio fallback', async t => {
  const f = await fixture(), input = f.admission('a', 'audio', 'target'), value = await f.verified('a', input), audioId = `c-${randomUUID()}.wav`;
  await pools.mapping.query('INSERT INTO gakja.audio_bindings(owner_id,resource_id,student_id,application_target_id,support_target_id,source_present,source_revision,content_sha256) VALUES($1,$2,$3,$4,$5,false,NULL,$6)', ['owner-a', audioId, 'student-a', 'app-a', 'domain-track', rawHash(value.bytes)]);
  await f.repository.linkAudio(value.selected, value.done.receiptId, audioId);
  const service = f.httpService(); service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening'); t.after(() => service.close());
  const address = service.server.address(); assert.ok(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
  const request = async (who: Who, headers: Record<string, string> = {}) => fetch(`${base}/api/audio/${audioId}`, { headers: { Authorization: `Bearer ${await f.token(who)}`, Connection: 'close', ...headers } });
  f.calls.read = 0; const normal = await request('a'); assert.equal(normal.status, 200); assert.equal(normal.headers.get('content-type'), 'audio/wav'); assert.deepEqual(Buffer.from(await normal.arrayBuffer()), value.bytes); assert.match(normal.headers.get('cache-control')!, /private, no-store/u);
  const before = f.calls.read; const cross = await request('b'); assert.equal(cross.status, 404); await cross.arrayBuffer(); assert.equal(f.calls.read, before);
  const range = await request('a', { Range: 'bytes=0-2' }); assert.equal(range.status, 416); await range.arrayBuffer(); assert.equal(f.calls.read, before);
  await f.service.cancel(value.selected, value.done.receiptId, value.cap); const cancelled = await request('a'); assert.equal(cancelled.status, 404); await cancelled.arrayBuffer(); assert.equal(f.calls.read, before);
  assert.equal(f.calls.syntheticAudio, 0); // Byte transport test; not microphone/TTS or WAV playback certification.
});

test('actual HTTP singleflight rechecks object identity after a verified body await and suppresses both responses on cancellation', { timeout: 30_000 }, async t => {
  const f = await fixture(), input = f.admission('a', 'audio', 'target'), value = await f.verified('a', input), audioId = `race-${randomUUID()}.wav`;
  await pools.mapping.query('INSERT INTO gakja.audio_bindings(owner_id,resource_id,student_id,application_target_id,support_target_id,source_present,source_revision,content_sha256) VALUES($1,$2,$3,$4,$5,false,NULL,$6)', ['owner-a', audioId, 'student-a', 'app-a', 'domain-track', rawHash(value.bytes)]);
  await f.repository.linkAudio(value.selected, value.done.receiptId, audioId);
  let release!: () => void, entered!: () => void, secondPreflight!: () => void, refreshes = 0;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; }), joined = new Promise<void>(resolve => { secondPreflight = resolve; });
  const service = f.httpService({ async afterAudio() { entered(); await held; }, refreshed() { if (++refreshes === 2) secondPreflight(); } });
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening'); t.after(() => { release(); return service.close(); });
  const address = service.server.address(); assert.ok(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
  const token = await f.token('a'); const request = () => fetch(`${base}/api/audio/${audioId}`, { headers: { Authorization: `Bearer ${token}`, Connection: 'close' } });
  f.calls.read = 0; const first = request(); await ready; const second = request(); await joined;
  // The second handler's real DB preflight completed; drain its continuation into the
  // already pending flight before revoking the object registration.
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.calls.read, 1);
  try { await f.service.cancel(value.selected, value.done.receiptId, value.cap); } finally { release(); }
  const responses = await Promise.all([first, second]);
  for (const response of responses) { assert.equal(response.status, 404); assert.match(response.headers.get('cache-control')!, /no-store/u); await response.arrayBuffer(); }
  assert.equal(f.calls.syntheticAudio, 0);
});
