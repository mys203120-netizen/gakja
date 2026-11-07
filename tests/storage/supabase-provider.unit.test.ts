import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSupabaseObjectProvider, ObjectProviderError } from '../../server/storage/supabase-object-provider';

const object = { bucket: 'pr07c-synthetic', key: 'test_prefix/staging/11111111-1111-4111-8111-111111111111' };
const config = { apiUrl: 'https://storage.example.test/storage/v1', bucket: object.bucket, keyPrefix: 'test_prefix', serviceCredential: 'synthetic-not-a-secret' };
function code(expected: string) { return (error: unknown) => error instanceof ObjectProviderError && error.code === expected && error.message === expected; }

test('provider denies nonconfigured refs, URLs, traversal, cross-bucket and unsafe origins before any fetch', async () => {
  let calls = 0;
  const provider = createSupabaseObjectProvider({ ...config, fetch: async () => { calls++; return new Response(''); } });
  for (const key of ['../outside', '/absolute', 'C:\\secret', 'https://other/key', 'test_prefix/staging/%2e%2e', 'test_prefix/staging/..', object.key + '?token=forged']) {
    await assert.rejects(provider.read({ ...object, key }, { maxBytes: 1024 }), code('STORAGE_REFERENCE_DENIED'));
  }
  await assert.rejects(provider.read({ ...object, bucket: 'another-bucket' }, { maxBytes: 1024 }), code('STORAGE_REFERENCE_DENIED'));
  for (const apiUrl of ['file:///private', 'http://remote.example', 'https://user:password@storage.example', 'https://storage.example/?token=secret', 'not a URL']) {
    assert.throws(() => createSupabaseObjectProvider({ ...config, apiUrl }), code('STORAGE_REFERENCE_DENIED'));
  }
  assert.equal(calls, 0);
});

test('provider keeps exact bytes and only sends credential to its configured API origin', async () => {
  const bytes = Buffer.from('{"z":"합성🙂","null":null}\r\n'); let calls = 0;
  const provider = createSupabaseObjectProvider({ ...config, fetch: async (input, init) => {
    calls++; assert.equal(new URL(String(input)).origin, 'https://storage.example.test');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer ' + config.serviceCredential);
    assert.equal(init?.redirect, 'error'); assert.equal(init?.cache, 'no-store'); return new Response(bytes);
  } });
  assert.deepEqual(await provider.read(object, { maxBytes: 1024 }), bytes); assert.equal(calls, 1);
});

test('bounded body reader rejects declared/chunked excess and releases the slot after errors', async () => {
  let response = () => new Response('x', { headers: { 'content-length': '999999' } });
  const provider = createSupabaseObjectProvider({ ...config, maxConcurrent: 1, fetch: async () => response() });
  await assert.rejects(provider.read(object, { maxBytes: 8 }), code('STORAGE_LIMIT'));
  response = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(32)); controller.close(); } }));
  await assert.rejects(provider.read(object, { maxBytes: 8 }), code('STORAGE_LIMIT'));
  response = () => new Response('ok'); assert.equal((await provider.read(object, { maxBytes: 8 })).toString(), 'ok');
});

test('timeout and caller cancellation abort I/O, sanitize errors and release bounded concurrency', async () => {
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); let blocking = true;
  const provider = createSupabaseObjectProvider({ ...config, maxConcurrent: 1, timeoutMs: 100, fetch: async (_input, init) => {
    if (!blocking) return new Response('ok'); entered();
    return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('untrusted detail with synthetic credential')), { once: true }));
  } });
  const pending = provider.read(object, { maxBytes: 1024 }); await started;
  await assert.rejects(provider.read(object, { maxBytes: 1024 }), code('STORAGE_LIMIT'));
  await assert.rejects(pending, code('STORAGE_TIMEOUT'));
  const controller = new AbortController(); const cancelled = provider.read(object, { maxBytes: 1024, signal: controller.signal }); controller.abort();
  await assert.rejects(cancelled, code('STORAGE_ABORTED'));
  blocking = false; assert.equal((await provider.read(object, { maxBytes: 8 })).toString(), 'ok');
});

test('a real HTTP midstream disconnect never returns partial bytes', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '100' }); response.write('partial');
    setImmediate(() => response.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const provider = createSupabaseObjectProvider({ ...config, apiUrl: 'http://127.0.0.1:' + (server.address() as AddressInfo).port, allowLoopbackHttp: true });
    await assert.rejects(provider.read(object, { maxBytes: 1024 }), code('STORAGE_UNAVAILABLE'));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('a real HTTP redirect is rejected before any redirected destination receives a request', async () => {
  let destinationCalls = 0;
  const destination = createServer((_request, response) => { destinationCalls++; response.end('should not be read'); });
  await new Promise<void>(resolve => destination.listen(0, '127.0.0.1', resolve));
  const source = createServer((_request, response) => { response.writeHead(302, { Location: 'http://127.0.0.1:' + (destination.address() as AddressInfo).port }); response.end(); });
  await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
  try {
    const provider = createSupabaseObjectProvider({ ...config, apiUrl: 'http://127.0.0.1:' + (source.address() as AddressInfo).port, allowLoopbackHttp: true });
    await assert.rejects(provider.read(object, { maxBytes: 1024 }), code('STORAGE_UNAVAILABLE')); assert.equal(destinationCalls, 0);
  } finally {
    source.closeAllConnections(); destination.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => source.close(() => resolve())), new Promise<void>(resolve => destination.close(() => resolve()))]);
  }
});

test('signed URL responses cannot redirect credentials to foreign hosts or grant a different object path', async () => {
  for (const signedURL of ['https://foreign.example/object?token=synthetic', '/object/sign/wrong/key?token=synthetic', '/object/sign/' + object.bucket + '/' + object.key + '?token=synthetic&other=1']) {
    const provider = createSupabaseObjectProvider({ ...config, fetch: async () => new Response(JSON.stringify({ signedURL })) });
    await assert.rejects(provider.createSignedDownload(object, 2), code('STORAGE_REFERENCE_DENIED'));
  }
  const invalid = createSupabaseObjectProvider({ ...config, fetch: async () => new Response('malformed response with synthetic secret') });
  await assert.rejects(invalid.createSignedDownload(object, 2), code('STORAGE_UNAVAILABLE'));
});

test('upload and copy always disable upsert and telemetry cannot leak or change the result', async () => {
  let operations = 0;
  const provider = createSupabaseObjectProvider({ ...config, observe() { throw new Error('metrics unavailable'); }, fetch: async (_input, init) => {
    operations++; assert.equal(new Headers(init?.headers).get('x-upsert'), 'false'); return new Response('{}');
  } });
  await provider.upload(object, Buffer.from('x'), { contentType: 'application/octet-stream' });
  await provider.copy(object, { ...object, key: object.key.replace('/staging/', '/final/') }); assert.equal(operations, 2);
});

// Exact pinned upstream contract: storage-error.ts sets userStatusCode=400,
// while errors/codes.ts NoSuchKey + http/error-handler.ts retain JSON 404.
test('official HTTP 400 NoSuchKey is a missing object read and preserves raw HTTP telemetry', async () => {
  let absent = true; const events: { operation: string; status: number | null }[] = [];
  const server = createServer((request, response) => {
    assert.equal(request.method, 'GET'); assert.equal(request.headers.authorization, 'Bearer ' + config.serviceCredential);
    if (absent) { response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ statusCode: '404', code: 'NoSuchKey', error: 'not_found', message: 'Object not found' })); }
    else response.end('exact subsequent bytes');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const provider = createSupabaseObjectProvider({ ...config, apiUrl: 'http://127.0.0.1:' + (server.address() as AddressInfo).port, allowLoopbackHttp: true, maxConcurrent: 1, observe: event => { events.push(event); } });
    await assert.rejects(provider.read(object, { maxBytes: 8 }), code('STORAGE_NOT_FOUND'));
    absent = false; assert.equal((await provider.read(object, { maxBytes: 64 })).toString(), 'exact subsequent bytes');
    assert.deepEqual(events, [{ operation: 'read', status: 400 }, { operation: 'read', status: 200 }]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('structured object absence never masks auth, bucket, unavailable, malformed or excessive responses', async () => {
  const missing = { statusCode: '404', code: 'NoSuchKey', error: 'not_found', message: 'Object not found' };
  const cases = [
    { status: 401, body: missing }, { status: 403, body: missing }, { status: 503, body: missing },
    { status: 400, body: { ...missing, code: 'InvalidJWT' } },
    { status: 400, body: { ...missing, code: 'NoSuchBucket', error: 'Bucket not found', message: 'Bucket not found' } },
    { status: 400, body: { ...missing, statusCode: '403' } }, { status: 400, body: { ...missing, statusCode: 404 } },
    { status: 400, body: { ...missing, message: 'synthetic sensitive detail' } },
    { status: 400, body: null }, { status: 400, body: [missing] },
    { status: 400, body: missing, contentType: 'text/html' },
  ];
  for (const value of cases) {
    const provider = createSupabaseObjectProvider({ ...config, fetch: async () => new Response(JSON.stringify(value.body), { status: value.status, headers: { 'Content-Type': value.contentType ?? 'application/json' } }) });
    await assert.rejects(provider.read(object, { maxBytes: 8 }), code('STORAGE_UNAVAILABLE'));
  }
  for (const body of ['{broken', JSON.stringify({ ...missing, extra: 'x'.repeat(4096) })]) {
    const provider = createSupabaseObjectProvider({ ...config, fetch: async () => new Response(body, { status: 400, headers: { 'Content-Type': 'application/json' } }) });
    await assert.rejects(provider.read(object, { maxBytes: 8 }), code('STORAGE_UNAVAILABLE'));
  }
  const declared = createSupabaseObjectProvider({ ...config, fetch: async () => new Response(JSON.stringify(missing), { status: 400, headers: { 'Content-Type': 'application/json', 'Content-Length': '4097' } }) });
  await assert.rejects(declared.read(object, { maxBytes: 8 }), code('STORAGE_UNAVAILABLE'));
  const mutations = createSupabaseObjectProvider({ ...config, fetch: async () => new Response(JSON.stringify(missing), { status: 400, headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(mutations.upload(object, Buffer.from('x'), { contentType: 'text/plain' }), code('STORAGE_UNAVAILABLE'));
  await assert.rejects(mutations.copy(object, object), code('STORAGE_UNAVAILABLE'));
});

test('reading a structured error body retains timeout, cancellation and concurrency cleanup', async () => {
  let blocking = true;
  const server = createServer((_request, response) => {
    if (!blocking) { response.end('ok'); return; }
    response.writeHead(400, { 'Content-Type': 'application/json' }); response.write('{"statusCode":"404",');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const provider = createSupabaseObjectProvider({ ...config, apiUrl: 'http://127.0.0.1:' + (server.address() as AddressInfo).port, allowLoopbackHttp: true, timeoutMs: 100, maxConcurrent: 1 });
    await assert.rejects(provider.read(object, { maxBytes: 8 }), code('STORAGE_TIMEOUT'));
    const controller = new AbortController(), pending = provider.read(object, { maxBytes: 8, signal: controller.signal });
    controller.abort(); await assert.rejects(pending, code('STORAGE_ABORTED'));
    blocking = false; assert.equal((await provider.read(object, { maxBytes: 8 })).toString(), 'ok');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
