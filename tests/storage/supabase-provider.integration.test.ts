import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSupabaseObjectProvider, ObjectProviderError } from '../../server/storage/supabase-object-provider';
import type { StorageObjectRef } from '../../server/storage/private-object-ports';
import { syntheticPdf, syntheticWav } from './fixtures';

function required(name: string) { const value = process.env['PR07C_TEST_' + name]; if (!value) throw new Error('PR07C_REAL_STORAGE_ENVIRONMENT_REQUIRED'); return value; }
const apiUrl = required('STORAGE_API_URL'), bucket = required('BUCKET'), keyPrefix = required('KEY_PREFIX');
const events: Array<{ operation: string; status: number | null }> = [];
const provider = createSupabaseObjectProvider({ apiUrl, bucket, keyPrefix, serviceCredential: required('STORAGE_SERVICE_KEY'), allowLoopbackHttp: true,
  observe: event => events.push(event) });
const refs: StorageObjectRef[] = [];
function ref(part: 'staging' | 'final' = 'staging') { const value = { bucket, key: keyPrefix + '/' + part + '/' + randomUUID() }; refs.push(value); return value; }
async function raw(url: string, init: RequestInit = {}) {
  try { return await fetch(url, { ...init, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5_000) }); }
  catch { throw new Error('PR07C_PROVIDER_REQUEST_FAILED'); }
}
const hashes: Array<{ kind: string; bytes: number; sha256: string }> = [];
test.after(async () => {
  for (const value of refs) await provider.remove(value);
  const output = path.resolve(process.env.PR07C_TEST_OUTPUT ?? 'artifacts/pr07c/storage');
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'provider-observations.json'), JSON.stringify({
    provider: 'supabase/storage-api:v1.89.12', backend: 'official Storage API with internal file backend; no direct filesystem reads',
    image: process.env.PR07C_TEST_STORAGE_IMAGE ?? null, keyNamespaceGenerated: true, bucketPrivate: true,
    fixtures: hashes, requests: events, credentialsOrSignedUrlsRecorded: false,
    downloadExpiry: 'actual elapsed local origin test', uploadExpiry: '7200 second configured/token contract; no two-hour elapsed claim',
    hostedProviderAndCdnTested: false,
  }, null, 2) + '\n');
});

test('real official API preserves PDF, UTF8 markdown/JSON, WAV and review bundle bytes through upload/read/copy/delete', async () => {
  const fixtures = [
    ['pdf', 'application/pdf', syntheticPdf()],
    ['markdown', 'text/markdown', Buffer.from('# 합성 문서🙂\r\n\r\n| 표 | 원문 |\r\n|---|---|\r\n| A | 보존 |\r\n')],
    ['json', 'application/json', Buffer.from('{"z":"한글🙂","nullable":null,"a":1}\r\n')],
    ['wav', 'audio/wav', syntheticWav()],
    ['bundle', 'application/json', Buffer.from('{"review":"synthetic-only","approved":false,"notes":"검수 아님🙂"}\n')],
  ] as const;
  for (const [kind, contentType, bytes] of fixtures) {
    const source = ref(), destination = ref('final');
    await provider.upload(source, bytes, { contentType });
    assert.deepEqual(await provider.read(source, { maxBytes: 1024 * 1024 }), bytes);
    await provider.copy(source, destination);
    assert.deepEqual(await provider.read(destination, { maxBytes: 1024 * 1024 }), bytes);
    await provider.remove(source);
    await assert.rejects(provider.read(source, { maxBytes: 1024 }), ObjectProviderError);
    hashes.push({ kind, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
});

test('actual provider refuses duplicate upload/copy and missing object; existing final bytes remain intact', async () => {
  const staging = ref(), final = ref('final'), bytes = Buffer.from('{"synthetic":true}\n');
  await provider.upload(staging, bytes, { contentType: 'application/json' }); await provider.copy(staging, final);
  await assert.rejects(provider.upload(staging, Buffer.from('replacement'), { contentType: 'application/json' }), ObjectProviderError);
  await assert.rejects(provider.copy(staging, final), ObjectProviderError);
  assert.deepEqual(await provider.read(final, { maxBytes: 1024 }), bytes);
  await assert.rejects(provider.read(ref(), { maxBytes: 1024 }), ObjectProviderError);
});

test('private bucket blocks unsigned/public reads and anonymous metadata listing', async () => {
  const object = ref(), bytes = Buffer.from('private synthetic bytes'); await provider.upload(object, bytes, { contentType: 'text/plain' });
  const objectPath = encodeURIComponent(bucket) + '/' + object.key;
  for (const prefix of ['/object/', '/object/public/', '/object/authenticated/']) {
    const result = await raw(apiUrl + prefix + objectPath); assert.equal(result.ok, false); await result.body?.cancel();
  }
  const list = await raw(apiUrl + '/object/list/' + encodeURIComponent(bucket), { method: 'POST',
    headers: { Authorization: 'Bearer ' + required('STORAGE_ANON_KEY'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: keyPrefix, limit: 100 }) });
  if (list.ok) assert.deepEqual(await list.json(), []); else await list.body?.cancel();
  const metadata = await raw(apiUrl + '/bucket/' + bucket, { headers: { Authorization: 'Bearer ' + required('STORAGE_SERVICE_KEY') } });
  assert.equal(metadata.ok, true); assert.equal((await metadata.json()).public, false);
});

test('signed download is bearer access and actually expires at the local origin after elapsed time', async () => {
  const object = ref('final'), bytes = Buffer.from('short signed synthetic download');
  await provider.upload(object, bytes, { contentType: 'text/plain' });
  const signed = await provider.createSignedDownload(object, 2);
  const first = await raw(signed); assert.equal(first.ok, true); assert.deepEqual(Buffer.from(await first.arrayBuffer()), bytes);
  const token = new URL(signed).searchParams.get('token')!;
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  const waitMs = Math.max(0, payload.exp * 1000 - Date.now() + 1200);
  assert.ok(waitMs <= 5000); await new Promise(resolve => setTimeout(resolve, waitMs));
  const expired = await raw(signed); assert.equal(expired.ok, false); await expired.body?.cancel();
});

test('signed upload is reusable staging authority, not completion: no-upsert, final isolation and late staging recreation are real API behavior', async () => {
  const staging = ref(), final = ref('final'), original = Buffer.from('synthetic-original'), late = Buffer.from('late-staging');
  const signed = await provider.createSignedUpload(staging);
  const token = new URL(signed).searchParams.get('token')!;
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(payload.exp - payload.iat, 7200); assert.equal(payload.upsert, false);
  await provider.uploadSigned(staging, signed, original, 'application/octet-stream');
  await assert.rejects(provider.uploadSigned(staging, signed, late, 'application/octet-stream'), ObjectProviderError);
  await provider.copy(staging, final); await provider.remove(staging);
  await provider.uploadSigned(staging, signed, late, 'application/octet-stream');
  assert.deepEqual(await provider.read(staging, { maxBytes: 1024 }), late);
  assert.deepEqual(await provider.read(final, { maxBytes: 1024 }), original);
  // No token forgery is used as a substitute for expiry. The two-hour elapsed
  // upload expiry is deliberately not claimed by this short CI test.
});

test('bounded actual download refuses excess bytes and subsequent requests still succeed', async () => {
  const object = ref(), bytes = Buffer.alloc(8192, 67); await provider.upload(object, bytes, { contentType: 'application/octet-stream' });
  await assert.rejects(provider.read(object, { maxBytes: 1024 }), error => error instanceof ObjectProviderError && error.code === 'STORAGE_LIMIT');
  assert.deepEqual(await provider.read(object, { maxBytes: 8192 }), bytes);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(provider.read(object, { maxBytes: 8192, signal: aborted.signal }), error => error instanceof ObjectProviderError && error.code === 'STORAGE_ABORTED');
});
