import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { WebSocket } from 'ws';
import type { InterviewSession } from '../server/protocol';
import { createRequestIdentityBoundary, type AccountAccess } from '../server/auth/request-identity';
import { createTrustedJwtVerifier } from '../server/auth/jose-jwt-verifier';
import { createServiceRealtimeServer, type ServiceRequestResources, type SessionAccessBinding } from '../server/request-realtime-server';

const ids = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222' };
async function fixture() {
  let clock = Date.now(); const now = () => clock;
  const { privateKey, publicKey } = await generateKeyPair('EdDSA');
  const jwk = { ...await exportJWK(publicKey), kid: 'explicit-synthetic-key', alg: 'EdDSA' };
  const accounts = new Map<string, AccountAccess>();
  for (const who of ['a', 'b'] as const) accounts.set(who, { accountId: `account-${who}`, ownerId: `owner-${who}`, revision: 'grant-revision-1',
    grants: [{ studentId: `student-${who}`, applicationTargetId: `application-${who}`, supportTargetId: 'same-support-target', sourceRevision: 'same-source-hash' }] });
  const sessions = new Map<string, InterviewSession>(), bindings = new Map<string, SessionAccessBinding>();
  for (const who of ['a', 'b'] as const) {
    const access = accounts.get(who)!;
    const session: InterviewSession = { id: ids[who], createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z', status: 'active', evaluationStatus: 'review_required', target: { label: 'same-target-label', supportTargetId: 'same-support-target' }, sourceManifest: { digest: 'same-source-hash' }, turns: [], followUpCountByMainQuestion: {}, elapsedMs: 0,
      runtime: { version: 'session-runtime-v1', owner: { id: access.ownerId, mode: 'local-development' }, engineVersion: 'explicit-synthetic-policy', contextSnapshotSha256: 'a'.repeat(64), epoch: 0, checkpoint: { phase: 'prepared', at: '2026-11-06T00:00:00.000Z', turnId: null, answerId: null }, operations: {} } };
    sessions.set(session.id, session);
    bindings.set(session.id, { ...access.grants[0], ownerId: access.ownerId, sessionId: session.id, contextSnapshotSha256: session.runtime!.contextSnapshotSha256 });
  }
  const calls = { binding: 0, status: 0, session: 0, audio: 0, save: 0, recovery: 0, provider: 0 };
  let statusBarrier: (() => Promise<void>) | undefined, sessionBarrier: (() => Promise<void>) | undefined, bindingBarrier: (() => Promise<void>) | undefined;
  const resources: ServiceRequestResources = {
    kind: 'synthetic',
    async sessionBinding(_context, id) { calls.binding++; await bindingBarrier?.(); return bindings.get(id) ?? null; },
    async audioBinding(context, id) { calls.binding++; await bindingBarrier?.(); if (id !== 'same-audio.mp3') return null; return { ...context.account.grants[0], ownerId: context.account.ownerId, resourceId: id }; },
    async readStatus(context) { calls.status++; await statusBarrier?.(); return { owner: context.account.ownerId, student: context.scope!.studentId, source: 'same-source-hash', evaluationStatus: 'review_required', score: null }; },
    async readSession(_context, binding) { calls.session++; await sessionBarrier?.(); return sessions.get(binding.sessionId) ?? null; },
    async readAudio(context) { calls.audio++; return Buffer.from(`synthetic-private-audio:${context.account.ownerId}`); },
  };
  const verifier = createTrustedJwtVerifier({ issuer: 'https://issuer.example.invalid', audience: 'explicit-synthetic-service', algorithms: ['EdDSA'], jwks: { keys: [jwk] }, now });
  const identity = createRequestIdentityBoundary({ mode: 'service', verifier, accounts: { kind: 'synthetic', async resolve(principal) { return accounts.get(principal.subject) ?? null; } }, environment: 'test', now });
  const service = createServiceRealtimeServer({ identity, resources, environment: 'test', now, accessCheckIntervalMs: 20 });
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  const address = service.server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const sign = async (who: string, claims: Record<string, unknown> = {}, lifetime = 300, trust: { issuer?: string; audience?: string } = {}) => new SignJWT(claims).setProtectedHeader({ alg: 'EdDSA', kid: jwk.kid }).setIssuer(trust.issuer ?? 'https://issuer.example.invalid').setAudience(trust.audience ?? 'explicit-synthetic-service').setSubject(who).setIssuedAt(Math.floor(clock / 1000)).setExpirationTime(Math.floor(clock / 1000) + lifetime).sign(privateKey);
  const tokens = { a: await sign('a'), b: await sign('b') };
  const request = (route: string, token?: string, init: RequestInit = {}) => fetch(base + route, { ...init, headers: { Connection: 'close', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers } });
  const ticket = async (who: 'a' | 'b') => { const response = await request(`/api/sessions/${ids[who]}/realtime-ticket`, tokens[who], { method: 'POST', body: '{}' }); assert.equal(response.status, 200); return (await response.json()).ticket as string; };
  const socket = async (ticket: string, id: string) => {
    const messages: Record<string, unknown>[] = [];
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/api/realtime?sessionId=${id}&ticket=${ticket}`, { origin: base });
    ws.on('message', data => messages.push(JSON.parse(data.toString()))); ws.on('error', () => {});
    await once(ws, 'open'); await wait(() => messages.length > 0);
    return { ws, messages };
  };
  return { service, base, request, ticket, socket, sign, tokens, calls, accounts, sessions, bindings, resources,
    advance(ms: number) { clock += ms; }, setStatusBarrier(value: () => Promise<void>) { statusBarrier = value; }, setSessionBarrier(value: () => Promise<void>) { sessionBarrier = value; }, setBindingBarrier(value: () => Promise<void>) { bindingBarrier = value; } };
}
async function wait(condition: () => boolean, timeout = 2_000) {
  const end = Date.now() + timeout; while (!condition()) { if (Date.now() > end) throw new Error('Synthetic transport event timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function rejectedUpgrade(base: string, query: string) {
  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/realtime?' + query, { origin: base });
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode!); res.resume(); ws.terminate(); });
    ws.on('open', () => { ws.terminate(); reject(new Error('Unexpected authorized upgrade')); });
    ws.on('error', () => {});
  });
}

test('service startup and unauthenticated routes have zero private reads, recovery, writes or provider calls', async t => {
  const f = await fixture(); t.after(() => f.service.close());
  assert.deepEqual(f.calls, { binding: 0, status: 0, session: 0, audio: 0, save: 0, recovery: 0, provider: 0 });
  assert.deepEqual(await (await f.request('/api/health')).json(), { app: 'each-answer-interview', ok: true, mode: 'service' });
  for (const route of ['/api/status', '/api/audio/same-audio.mp3', `/api/sessions/${ids.a}`, '/api/prepare', '/api/sessions']) {
    assert.equal((await f.request(route, undefined, route.endsWith('prepare') || route === '/api/sessions' ? { method: 'POST' } : {})).status, 401);
  }
  assert.equal(f.calls.binding + f.calls.status + f.calls.session + f.calls.audio + f.calls.save + f.calls.recovery + f.calls.provider, 0);
});

test('two real signed accounts read only their own bound legacy sessions/audio without altering runtime-v1 or frozen target', async t => {
  const f = await fixture(); t.after(() => f.service.close());
  for (const who of ['a', 'b'] as const) {
    const before = JSON.stringify(f.sessions.get(ids[who]));
    const response = await f.request(`/api/sessions/${ids[who]}`, f.tokens[who]); assert.equal(response.status, 200);
    assert.equal(JSON.stringify(await response.json()), before);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(await (await f.request('/api/audio/same-audio.mp3', f.tokens[who])).text(), `synthetic-private-audio:owner-${who}`);
    assert.equal((await f.request(`/api/sessions/${ids[who]}?applicationTargetId=another-current-target`, f.tokens[who])).status, 403);
    assert.equal(JSON.stringify(f.sessions.get(ids[who])), before);
  }
  assert.equal(f.calls.save + f.calls.recovery + f.calls.provider, 0);
});

test('actual HTTP rejects signature/issuer/audience/algorithm/time/mapping failures before private IO', async t => {
  const f = await fixture(); t.after(() => f.service.close());
  const pieces = f.tokens.a.split('.'); pieces[2] = (pieces[2][0] === 'a' ? 'b' : 'a') + pieces[2].slice(1);
  const wrongAlgorithm = await new SignJWT({ sub: 'a', iss: 'https://issuer.example.invalid', aud: 'explicit-synthetic-service', exp: Math.floor(Date.now() / 1000) + 300 }).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode('explicit-synthetic-hmac-key-not-a-production-credential'));
  const invalid = [pieces.join('.'), await f.sign('a', {}, 300, { issuer: 'https://other.example.invalid' }),
    await f.sign('a', {}, 300, { audience: 'another-audience' }), wrongAlgorithm, await f.sign('a', {}, -1), await f.sign('a', { nbf: Math.floor(Date.now() / 1000) + 300 })];
  for (const token of invalid) assert.equal((await f.request(`/api/sessions/${ids.a}`, token)).status, 401);
  assert.equal((await f.request(`/api/sessions/${ids.a}`, await f.sign('unmapped-subject'))).status, 403);
  const get = f.accounts.get; f.accounts.get = () => { throw new Error('private-mapping-detail-must-not-leak'); };
  const failed = await f.request(`/api/sessions/${ids.a}`, f.tokens.a); assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes('private-mapping-detail')); f.accounts.get = get;
  assert.equal(f.calls.binding + f.calls.status + f.calls.session + f.calls.audio + f.calls.save + f.calls.recovery + f.calls.provider, 0);
});

test('actual HTTP key dependency failure never falls back to local data or account mapping', async t => {
  const f = await fixture(); t.after(() => f.service.close()); let keyCalls = 0, accountCalls = 0;
  const identity = createRequestIdentityBoundary({ mode: 'service', environment: 'test', verifier: createTrustedJwtVerifier({ issuer: 'https://issuer.example.invalid', audience: 'explicit-synthetic-service', algorithms: ['EdDSA'], keyResolver: async () => { keyCalls++; throw new Error('private-key-service-detail'); } }), accounts: { kind: 'synthetic', async resolve() { accountCalls++; return f.accounts.get('a')!; } } });
  const service = createServiceRealtimeServer({ identity, resources: f.resources, environment: 'test' }); service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening'); t.after(() => service.close());
  const address = service.server.address(); assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/status?applicationTargetId=application-a`, { headers: { Authorization: `Bearer ${f.tokens.a}` } });
  assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('private-key-service-detail'));
  assert.equal(keyCalls, 1); assert.equal(accountCalls, 0);
  assert.equal(f.calls.binding + f.calls.status + f.calls.session + f.calls.audio + f.calls.save + f.calls.recovery + f.calls.provider, 0);
});

test('other-owner and nonexistent session IDs return the same response before private session IO', async t => {
  const f = await fixture(); t.after(() => f.service.close());
  const other = await f.request(`/api/sessions/${ids.b}`, f.tokens.a), absent = await f.request('/api/sessions/33333333-3333-4333-8333-333333333333', f.tokens.a);
  assert.equal(other.status, 404); assert.equal(absent.status, 404); assert.deepEqual(await other.json(), await absent.json());
  for (const action of ['next', 'answer-candidate', 'end', 'closing', 'retry-evaluation', 'timings', 'events', 'realtime-ticket']) assert.equal((await f.request(`/api/sessions/${ids.b}/${action}`, f.tokens.a, { method: 'POST', body: '{}' })).status, 404);
  assert.equal(f.calls.session + f.calls.audio + f.calls.save + f.calls.recovery + f.calls.provider, 0);
});

test('body/header/query identity spoof cannot expand scope and authenticated persistence returns explicit unsupported', async t => {
  const f = await fixture(); t.after(() => f.service.close());
  assert.equal((await f.request('/api/status?ownerId=owner-b', f.tokens.a)).status, 400);
  assert.equal((await f.request('/api/status', f.tokens.a, { headers: { 'X-Owner-Id': 'owner-b' } })).status, 400);
  assert.equal((await f.request('/api/status?studentId=student-b', f.tokens.a)).status, 403);
  assert.equal((await f.request(`/api/sessions/${ids.a}/realtime-ticket`, f.tokens.a, { method: 'POST', body: '{"ownerId":"owner-b"}' })).status, 400);
  for (const action of ['next', 'answer-candidate', 'end', 'closing', 'retry-evaluation', 'timings', 'events']) assert.equal((await f.request(`/api/sessions/${ids.a}/${action}`, f.tokens.a, { method: 'POST', body: '{}' })).status, 503);
  assert.equal((await f.request('/api/sessions', f.tokens.a, { method: 'POST', body: '{}' })).status, 503);
  assert.equal((await f.request('/api/prepare', f.tokens.a, { method: 'POST', body: '{}' })).status, 503);
  assert.equal(f.calls.session + f.calls.save + f.calls.recovery + f.calls.provider, 0);
});

test('same hashes and target labels do not share a single-flight promise across accounts', async t => {
  const f = await fixture(); t.after(() => f.service.close());
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; }); f.setStatusBarrier(() => blocked);
  const a = f.request('/api/status?applicationTargetId=application-a', f.tokens.a), b = f.request('/api/status?applicationTargetId=application-b', f.tokens.b);
  await wait(() => f.calls.status === 2); release();
  assert.equal((await (await a).json()).owner, 'owner-a'); assert.equal((await (await b).json()).owner, 'owner-b');
  assert.equal(f.calls.status, 2);
});

test('persisted session owner/context binding is checked after authorized metadata and before returning private payload', async t => {
  const f = await fixture(); t.after(() => f.service.close());
  f.sessions.get(ids.a)!.runtime!.owner.id = 'owner-b';
  assert.equal((await f.request(`/api/sessions/${ids.a}`, f.tokens.a)).status, 404);
  f.sessions.get(ids.a)!.runtime!.owner.id = 'owner-a'; f.sessions.get(ids.a)!.runtime!.contextSnapshotSha256 = 'changed';
  assert.equal((await f.request(`/api/sessions/${ids.a}`, f.tokens.a)).status, 404);
  assert.equal(f.calls.save + f.calls.recovery + f.calls.provider, 0);
});

test('actual upgrade consumes one short ticket, binds account/session and accepts readonly messages without checkpoint writes', async t => {
  const f = await fixture(); t.after(() => f.service.close());
  const ticket = await f.ticket('a'); const { ws, messages } = await f.socket(ticket, ids.a); t.after(() => ws.terminate());
  assert.deepEqual(messages[0], { type: 'ready', sessionId: ids.a, readOnly: true });
  ws.send(JSON.stringify({ type: 'ping', sessionId: ids.a })); await wait(() => messages.some(message => message.type === 'pong'));
  assert.equal(await rejectedUpgrade(f.base, `sessionId=${ids.a}&ticket=${ticket}`), 403);
  const swapped = await f.ticket('a'); assert.equal(await rejectedUpgrade(f.base, `sessionId=${ids.b}&ticket=${swapped}`), 403);
  ws.send(Buffer.from('synthetic-audio')); await wait(() => messages.some(message => message.code === 'AUTHENTICATED_STORAGE_UNAVAILABLE'));
  assert.equal(f.calls.save + f.calls.recovery + f.calls.provider, 0);
});

test('scope mutation, expired credential/ticket and revoked access close real sockets before later work', async t => {
  const f = await fixture(); t.after(() => f.service.close());
  const changed = await f.socket(await f.ticket('a'), ids.a), closed = once(changed.ws, 'close'); changed.ws.send(JSON.stringify({ type: 'ping', ownerId: 'owner-b' })); await closed;
  const revoked = await f.socket(await f.ticket('a'), ids.a), revokedClose = once(revoked.ws, 'close'); f.accounts.delete('a'); revoked.ws.send('{"type":"ping"}'); await revokedClose;
  const expiredTicket = await f.ticket('b'); f.advance(31_000); assert.equal(await rejectedUpgrade(f.base, `sessionId=${ids.b}&ticket=${expiredTicket}`), 403);
  const expiring = await f.socket(await f.ticket('b'), ids.b), expiredClose = once(expiring.ws, 'close'); f.advance(300_000); expiring.ws.send('{"type":"ping"}'); await expiredClose;
  assert.equal(f.calls.save + f.calls.recovery + f.calls.provider, 0);
});

test('Origin/Host and long bearer query rejection remain separate from successful authentication', async t => {
  const f = await fixture(); t.after(() => f.service.close());
  assert.equal((await f.request('/api/status', f.tokens.a, { headers: { Origin: 'https://untrusted.example.invalid' } })).status, 403);
  const hostStatus = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(f.base + '/api/status', { headers: { Host: 'untrusted.example.invalid', Authorization: `Bearer ${f.tokens.a}`, Connection: 'close' } }, res => { resolve(res.statusCode!); res.resume(); });
    req.on('error', reject); req.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal(await rejectedUpgrade(f.base, `sessionId=${ids.a}&access_token=${f.tokens.a}`), 403);
  assert.equal(f.calls.status + f.calls.session + f.calls.audio + f.calls.save + f.calls.recovery + f.calls.provider, 0);
});

test('trusted metadata objects cannot mutate pending response or frozen ticket pins', async t => {
  const f = await fixture(); t.after(() => f.service.close());
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; }); f.setSessionBarrier(() => blocked);
  const pending = f.request(`/api/sessions/${ids.a}`, f.tokens.a); await wait(() => f.calls.session === 1);
  f.bindings.get(ids.a)!.contextSnapshotSha256 = 'b'.repeat(64); release();
  assert.equal((await pending).status, 404);
  f.bindings.get(ids.a)!.contextSnapshotSha256 = 'a'.repeat(64);
  const ticket = await f.ticket('a'); f.bindings.get(ids.a)!.contextSnapshotSha256 = 'b'.repeat(64);
  assert.equal(await rejectedUpgrade(f.base, `sessionId=${ids.a}&ticket=${ticket}`), 403);
  assert.equal(f.calls.save + f.calls.recovery + f.calls.provider, 0);
});

test('metadata removal revokes a real connection even when account access revision has not changed', async t => {
  const f = await fixture(); t.after(() => f.service.close());
  const { ws } = await f.socket(await f.ticket('a'), ids.a), closed = once(ws, 'close');
  f.bindings.delete(ids.a); assert.equal(f.accounts.get('a')!.revision, 'grant-revision-1');
  ws.send('{"type":"ping"}'); const [code] = await closed; assert.equal(code, 1008);
  assert.equal(f.calls.save + f.calls.recovery + f.calls.provider, 0);
});

test('mapping revocation or outage during awaited metadata lookup blocks private session/audio reads entirely', async () => {
  for (const resource of ['session', 'audio'] as const) for (const failure of ['revoked', 'outage'] as const) {
    const f = await fixture();
    try {
      let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; }); f.setBindingBarrier(() => blocked);
      const pending = f.request(resource === 'session' ? `/api/sessions/${ids.a}` : '/api/audio/same-audio.mp3', f.tokens.a);
      await wait(() => f.calls.binding === 1);
      if (failure === 'revoked') f.accounts.delete('a');
      else f.accounts.get = () => { throw new Error('private-mapping-outage-detail'); };
      release(); const response = await pending;
      assert.equal(response.status, failure === 'revoked' ? 403 : 503, `${resource}:${failure}`);
      assert.ok(!(await response.text()).includes('private-mapping-outage-detail'));
      assert.equal(f.calls.status + f.calls.session + f.calls.audio + f.calls.save + f.calls.recovery + f.calls.provider, 0, `${resource}:${failure}`);
    } finally { await f.service.close(); }
  }
});

test('status rechecks current mapping before its first private read', async () => {
  for (const failure of ['revoked', 'outage'] as const) {
    const f = await fixture();
    try {
      const get = f.accounts.get; let checks = 0;
      f.accounts.get = function (key) {
        checks++;
        if (checks === 2) { if (failure === 'outage') throw new Error('mapping dependency unavailable'); return undefined; }
        return get.call(this, key);
      };
      const response = await f.request('/api/status?applicationTargetId=application-a', f.tokens.a);
      assert.equal(response.status, failure === 'revoked' ? 403 : 503);
      assert.equal(f.calls.status + f.calls.session + f.calls.audio + f.calls.save + f.calls.recovery + f.calls.provider, 0);
    } finally { await f.service.close(); }
  }
});

test('revocation during the final metadata recheck suppresses the already-read private response', async () => {
  for (const resource of ['session', 'audio'] as const) {
    const f = await fixture();
    try {
      let release!: () => void, checks = 0; const blocked = new Promise<void>(resolve => { release = resolve; });
      f.setBindingBarrier(async () => { if (++checks === 2) await blocked; });
      const pending = f.request(resource === 'session' ? `/api/sessions/${ids.a}` : '/api/audio/same-audio.mp3', f.tokens.a);
      await wait(() => f.calls.binding === 2); f.accounts.delete('a'); release();
      const response = await pending; assert.equal(response.status, 403);
      assert.equal(f.calls.session + f.calls.audio, 1); assert.equal(f.calls.save + f.calls.recovery + f.calls.provider, 0);
      assert.ok(!(await response.text()).includes('synthetic-private-audio'));
    } finally { await f.service.close(); }
  }
});

test('unconfigured operational service refuses before resources even with a local owner setting', async t => {
  const calls = { count: 0 }; const service = createServiceRealtimeServer({ resources: { kind: 'operational', sessionBinding: async () => { calls.count++; return null; }, audioBinding: async () => { calls.count++; return null; }, readStatus: async () => { calls.count++; return {}; }, readSession: async () => { calls.count++; return null; }, readAudio: async () => { calls.count++; return null; } } });
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening'); t.after(() => service.close()); const address = service.server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(base + '/api/health')).status, 200);
  for (const route of ['/api/status', '/api/audio/private.mp3', `/api/sessions/${ids.a}`]) assert.equal((await fetch(base + route)).status, 503);
  assert.equal(calls.count, 0);
});
