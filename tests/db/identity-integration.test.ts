import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { Pool, type PoolClient } from 'pg';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { WebSocket } from 'ws';
import { createRequestIdentityBoundary, RequestAccessError, type AuthenticatedRequestContext, type PrincipalVerifier, type RequestContext } from '../../server/auth/request-identity';
import { createTrustedJwtVerifier } from '../../server/auth/jose-jwt-verifier';
import { createServiceRealtimeServer, type ServiceRequestResources } from '../../server/request-realtime-server';
import type { InterviewSession } from '../../server/protocol';
import { createPostgresAccountResolver, createPostgresRequestAuthority, createPostgresTestResources, createPostgresWorkerBindingResolver } from '../../server/db/postgres-authority';
import { createTrustedEvaluationWorkerExecution, assertWorkerExecution } from '../../server/internal-execution';
import { createLocalSessionStore } from '../../server/storage/local-session-store';
import { createLocalEvaluationJobStore } from '../../server/evaluation-job-store';
import { createLocalReviewRepository } from '../../server/repositories/local-review-repository';
import { prepareEndedSessionReview, supplyReviewedSessionEvaluation } from '../../server/evaluation-supply';
import { publishBankScopeReview } from '../../server/data/evaluation-scope-registry';
import { knowledgeSessionQuestionAnswerHash } from '../../server/data/approved-knowledge';
import { runEvaluationWorkerOnce } from '../../server/evaluation-worker';
import type { evaluateSession } from '../../server/providers/openai';
import { evaluationSupplyFixture, pinSupplySnapshot, reviewedSupplyRegistry, supplyRecordBundle, supplyReviewer, supplySigner } from '../fixtures/evaluation-supply';
import { testPools, closePools } from './test-database';

const pools = testPools(1); after(() => closePools(pools));
const ids = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222' };
const issuers = { a: 'https://issuer-a.example', b: 'https://issuer-b.example' };
const keys = await generateKeyPair('ES256');
const jwk = { ...await exportJWK(keys.publicKey), kid: 'explicit-db-test-key', alg: 'ES256' };
async function wait(check: () => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error('DB_INTEGRATION_EVENT_TIMEOUT'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function fixture() {
  let clock = Date.now(); const now = () => clock;
  const trusted = Object.values(issuers).map(issuer => createTrustedJwtVerifier({ issuer, audience: 'pr07b-isolated-service', algorithms: ['ES256'], jwks: { keys: [jwk] }, now }));
  // The only accepted issuers/keys are fixed server test configuration. Each
  // path performs a real signature/claim check; no decoded claim is authority.
  const verifier: PrincipalVerifier = { kind: 'trusted-jwt', async verify(token) {
    for (const candidate of trusted) { try { return await candidate.verify(token); } catch (error) { if (!(error instanceof RequestAccessError) || error.status === 503) throw error; } }
    throw new RequestAccessError(401, 'AUTH_INVALID');
  } };
  const identity = createRequestIdentityBoundary({ mode: 'service', verifier, accounts: createPostgresAccountResolver(pools.request, { now }), now });
  const authority = createPostgresRequestAuthority(pools.request, identity);
  const calls = { status: 0, session: 0, audio: 0, save: 0, provider: 0 };
  let bodyBarrier: (() => Promise<void>) | undefined;
  const resources = createPostgresTestResources(authority, {
    async readStatus(context) { calls.status++; await bodyBarrier?.(); return { student: context.scope!.studentId, target: context.scope!.applicationTargetId, review: 'review_required', score: null }; },
    async readSession(context, binding) {
      calls.session++; await bodyBarrier?.();
      return { id: binding.sessionId, status: 'completed', evaluationStatus: 'review_required', createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z',
        target: { label: 'same-target-name', supportTargetId: binding.supportTargetId }, sourceManifest: { digest: 'same-source-hash' }, turns: [], elapsedMs: 0, followUpCountByMainQuestion: {},
        runtime: { version: 'session-runtime-v1', owner: { id: context.account.ownerId, mode: 'local-development' }, engineVersion: 'explicit-synthetic-policy', contextSnapshotSha256: binding.contextSnapshotSha256,
          epoch: 0, checkpoint: { phase: 'completed', at: '2026-11-06T00:00:00.000Z', turnId: null, answerId: null }, operations: {} } } satisfies InterviewSession;
    },
    async readAudio(context) { calls.audio++; await bodyBarrier?.(); return Buffer.from(`explicit-synthetic-audio:${context.account.ownerId}`); },
  });
  const sign = (who: 'a' | 'b', subject = 'shared', lifetime = 300) => new SignJWT().setProtectedHeader({ alg: 'ES256', kid: jwk.kid })
    .setIssuer(issuers[who]).setAudience('pr07b-isolated-service').setSubject(subject).setExpirationTime(Math.floor(clock / 1000) + lifetime).sign(keys.privateKey);
  const tokens = { a: await sign('a'), b: await sign('b') };
  const context = async (who: 'a' | 'b', select = true) => {
    const value = await identity.authenticate(`Bearer ${tokens[who]}`);
    assert.equal(value.mode, 'authenticated');
    return (select ? identity.selectScope(value, { applicationTargetId: `app-${who}` }) : value) as AuthenticatedRequestContext;
  };
  const makeService = (override?: ServiceRequestResources, serviceIdentity = identity) => createServiceRealtimeServer({ identity: serviceIdentity, resources: override ?? resources, environment: 'test', now, accessCheckIntervalMs: 20 });
  const service = makeService(); service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  const address = service.server.address(); assert.ok(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
  const request = (route: string, who: 'a' | 'b', init: RequestInit = {}) => fetch(base + route, { ...init, headers: { Authorization: `Bearer ${tokens[who]}`, Connection: 'close', ...init.headers } });
  return { identity, authority, resources, calls, sign, context, service, base, request, tokens, makeService,
    advance(ms: number) { clock += ms; }, blockBody(callback: () => Promise<void>) { bodyBarrier = callback; } };
}
async function activeGrant(active: boolean) {
  await pools.mapping.query('UPDATE gakja.access_grants SET active=$1 WHERE account_id=$2 AND application_target_id=$3', [active, 'account-a', 'app-a']);
}
async function socket(base: string, ticket: string, id: string) {
  const messages: Record<string, unknown>[] = [];
  const ws = new WebSocket(base.replace('http:', 'ws:') + `/api/realtime?sessionId=${id}&ticket=${ticket}`, { origin: base });
  ws.on('message', value => messages.push(JSON.parse(value.toString()))); ws.on('error', () => {});
  await once(ws, 'open'); await wait(() => messages.length > 0); return { ws, messages };
}

test('real signed issuers sharing a subject resolve to separate DB owners and preserve missing/null/string pins', async t => {
  const f = await fixture(); t.after(() => f.service.close());
  const a = await f.context('a'), b = await f.context('b');
  assert.equal(a.account.ownerId, 'owner-a'); assert.equal(b.account.ownerId, 'owner-b'); assert.notEqual(a.account.accountId, b.account.accountId);
  assert.equal(Object.hasOwn(a.scope!, 'sourceRevision'), false);
  assert.equal(Object.hasOwn(b.scope!, 'sourceRevision'), true); assert.equal(b.scope!.sourceRevision, null);
  const c = await f.identity.authenticate(`Bearer ${await f.sign('a', 'c')}`); assert.equal(c.mode, 'authenticated');
  assert.equal(f.identity.selectScope(c, { applicationTargetId: 'app-c' }).mode, 'authenticated');
  if (c.mode === 'authenticated') assert.equal(c.account.grants[0].sourceRevision, 'source-r1');
});

test('signed JWT -> DB resolver -> existing HTTP handler permits A/B own payloads and denies cross scope before body IO', async t => {
  const f = await fixture(); t.after(() => f.service.close());
  for (const who of ['a', 'b'] as const) {
    const session = await f.request(`/api/sessions/${ids[who]}`, who); assert.equal(session.status, 200);
    assert.equal((await session.json()).runtime.owner.id, `owner-${who}`);
    const audio = await f.request('/api/audio/same-audio.mp3', who); assert.equal(audio.status, 200); assert.equal(await audio.text(), `explicit-synthetic-audio:owner-${who}`);
    assert.equal(audio.headers.get('cache-control'), 'private, no-store');
    assert.equal((await f.request(`/api/status?applicationTargetId=app-${who}`, who)).status, 200);
  }
  const before = { ...f.calls };
  const other = await f.request(`/api/sessions/${ids.b}`, 'a'), missing = await f.request('/api/sessions/99999999-9999-4999-8999-999999999999', 'a');
  assert.equal(other.status, 404); assert.equal(missing.status, 404); assert.deepEqual(await other.json(), await missing.json());
  assert.equal((await f.request(`/api/sessions/${ids.a}?applicationTargetId=app-a2`, 'a')).status, 404);
  assert.equal((await f.request('/api/status?applicationTargetId=app-b', 'a')).status, 403);
  assert.equal((await f.request('/api/status?ownerId=owner-b', 'a')).status, 400);
  assert.deepEqual(f.calls, before);
  assert.equal((await f.request('/api/sessions', 'a', { method: 'POST', body: '{}' })).status, 503);
  assert.equal(f.calls.save + f.calls.provider, 0);
});

test('minted selected contexts alone enter scoped SQL; copied/unselected contexts cannot acquire private rows', async t => {
  const f = await fixture(); t.after(() => f.service.close()); let operations = 0;
  const a = await f.context('a'), unselected = await f.context('a', false);
  await assert.rejects(f.authority.withScope(structuredClone(a), async () => { operations++; }), /ACCESS_DENIED/u);
  await assert.rejects(f.authority.withScope(unselected, async () => { operations++; }), /DB_CONTEXT_REQUIRED/u);
  const rows = await f.authority.withScope(a, async client => { operations++; return (await client.query('SELECT student_id FROM gakja.students ORDER BY student_id')).rows; });
  assert.deepEqual(rows, [{ student_id: 'student-a' }]); assert.equal(operations, 1);
});

test('one physical request connection clears A/B context after commit, rollback, SQL exception and real server cancellation', async t => {
  const f = await fixture(); t.after(() => f.service.close());
  const a = await f.context('a'), b = await f.context('b'); const pids = new Set<number>();
  const probe = async () => {
    const c = await pools.request.connect();
    try {
      const state = await c.query("SELECT current_setting('gakja.owner_id',true) AS owner, current_setting('gakja.student_id',true) AS student, current_setting('gakja.application_target_id',true) AS target, pg_backend_pid() AS pid");
      assert.equal(state.rows[0].owner ?? '', ''); assert.equal(state.rows[0].student ?? '', ''); assert.equal(state.rows[0].target ?? '', ''); pids.add(state.rows[0].pid);
      assert.equal((await c.query('SELECT count(*)::int AS n FROM gakja.students')).rows[0].n, 0);
    } finally { c.release(); }
  };
  for (const context of [a, b, a, b]) {
    const rows = await f.authority.withScope(context, async client => (await client.query('SELECT student_id FROM gakja.students')).rows);
    assert.deepEqual(rows, [{ student_id: context.scope!.studentId }]); await probe();
  }
  await assert.rejects(f.authority.withScope(a, async client => { await client.query('SELECT 1/0'); })); await probe();
  await assert.rejects(f.authority.withScope(b, async client => { await client.query('SELECT pg_sleep(0.2)'); }, { timeoutMs: 20 })); await probe();
  assert.equal(pids.size, 1, 'same max=1 connection was actually reused, not just replaced by a new scope');
  const concurrent = await Promise.all(Array.from({ length: 10 }, (_, index) => f.authority.withScope(index % 2 ? a : b,
    async (client, context) => ({ rows: (await client.query('SELECT student_id FROM gakja.students')).rows, expected: context.scope!.studentId }))));
  for (const row of concurrent) assert.deepEqual(row.rows, [{ student_id: row.expected }]); await probe();
});

test('DB grant revision and revocation commit atomically and invalidate A contexts, including a blocked pool wait', async t => {
  const f = await fixture(); t.after(() => f.service.close()); const current = await f.context('a');
  const held = await pools.request.connect(); let operations = 0;
  const pending = f.authority.withScope(current, async () => { operations++; });
  await new Promise(resolve => setTimeout(resolve, 20)); await activeGrant(false); held.release();
  try { await assert.rejects(pending); assert.equal(operations, 0); assert.equal((await f.request(`/api/sessions/${ids.a}`, 'a')).status, 404); }
  finally { await activeGrant(true); }
  const fresh = await f.context('a'); assert.notEqual(fresh.account.revision, current.account.revision); assert.equal((await f.request(`/api/sessions/${ids.a}`, 'a')).status, 200);
});

test('expiry while waiting for a busy pool cannot execute an old context query', async t => {
  const f = await fixture(); t.after(() => f.service.close()); const current = await f.context('a');
  const held = await pools.request.connect(); let operations = 0;
  const pending = f.authority.withScope(current, async () => { operations++; });
  await new Promise(resolve => setTimeout(resolve, 20)); f.advance(301_000); held.release();
  await assert.rejects(pending); assert.equal(operations, 0);
});

test('expiry during metadata transaction cleanup cannot reach a synthetic body callback', async t => {
  const f = await fixture(); t.after(() => f.service.close()); const context = await f.context('a'); let privateReads = 0;
  const delayed = { ...f.authority, async withScope<T>(value: RequestContext, operation: (client: PoolClient, current: AuthenticatedRequestContext) => Promise<T>, options?: { timeoutMs?: number }) {
    const result = await f.authority.withScope(value, operation, options); f.advance(301000); return result;
  } };
  const resources = createPostgresTestResources(delayed, { async readStatus() { privateReads++; return {}; }, async readSession() { privateReads++; return null; }, async readAudio() { privateReads++; return null; } });
  await assert.rejects(resources.readStatus(context), /AUTH_EXPIRED/u); assert.equal(privateReads, 0);
});

test('DB outage and a privileged connection are safe failures, never local-owner or synthetic body fallbacks', async t => {
  const f = await fixture(); t.after(() => f.service.close());
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const address = listener.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const unavailable = new Pool({ host: '127.0.0.1', port: address.port, database: 'pr07b_unavailable_probe', user: 'explicit-test-role', password: 'explicit-test-only', max: 1, connectionTimeoutMillis: 1000 });
  t.after(() => unavailable.end());
  for (const pool of [unavailable, pools.admin]) {
    const identity = createRequestIdentityBoundary({ mode: 'service', verifier: createTrustedJwtVerifier({ issuer: issuers.a, audience: 'pr07b-isolated-service', algorithms: ['ES256'], jwks: { keys: [jwk] } }), accounts: createPostgresAccountResolver(pool) });
    const service = createServiceRealtimeServer({ identity, resources: f.resources, environment: 'test' }); service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
    try {
      const bound = service.server.address(); assert.ok(bound && typeof bound === 'object');
      const response = await fetch(`http://127.0.0.1:${bound.port}/api/sessions/${ids.a}`, { headers: { Authorization: `Bearer ${f.tokens.a}`, Connection: 'close' } });
      assert.equal(response.status, 503); const text = await response.text(); assert.ok(!text.includes('postgres:') && !text.includes('explicit-test-only') && !text.includes('owner-a'));
      assert.equal(f.calls.session + f.calls.audio + f.calls.status + f.calls.provider, 0);
    } finally { await service.close(); }
  }
});

test('revocation during metadata await is committed in DB and blocks body/provider reads entirely', async t => {
  const f = await fixture(); t.after(() => f.service.close()); let release!: () => void, entered = false;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const resources: ServiceRequestResources = { ...f.resources, async sessionBinding(context, id) {
    const binding = await f.resources.sessionBinding(context, id); entered = true; await blocked; return binding;
  } };
  const service = f.makeService(resources); service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening'); t.after(() => service.close());
  const address = service.server.address(); assert.ok(address && typeof address === 'object');
  const response = fetch(`http://127.0.0.1:${address.port}/api/sessions/${ids.a}`, { headers: { Authorization: `Bearer ${f.tokens.a}`, Connection: 'close' } });
  await wait(() => entered); await activeGrant(false); release();
  try { assert.equal((await response).status, 403); assert.equal(f.calls.session + f.calls.audio + f.calls.provider, 0); }
  finally { await activeGrant(true); }
});

test('real DB accounts with equal hashes/names never share a pending HTTP body promise', async t => {
  const f = await fixture(); t.after(() => f.service.close()); let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }); f.blockBody(() => blocked);
  const a = f.request('/api/status?applicationTargetId=app-a', 'a'), b = f.request('/api/status?applicationTargetId=app-b', 'b');
  await wait(() => f.calls.status === 2); release();
  assert.equal((await (await a).json()).student, 'student-a'); assert.equal((await (await b).json()).student, 'student-b');
  assert.equal(f.calls.status, 2);
});

test('a joined single-flight response cannot outlive a committed DB grant revocation', async t => {
  const f = await fixture(); t.after(() => f.service.close()); let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }); f.blockBody(() => blocked); t.after(() => release());
  let preflightChecks = 0, reachedSecondPreflight!: () => void;
  const secondPreflight = new Promise<void>(resolve => { reachedSecondPreflight = resolve; });
  const identity = { ...f.identity, async revalidate(context: RequestContext) {
    const current = await f.identity.revalidate(context);
    // Only the HTTP service uses this wrapper; the SQL/body adapter retains
    // the original A boundary. With the first body blocked, call two is the
    // second request's real DB preflight immediately before singleFlight.
    if (++preflightChecks === 2) reachedSecondPreflight();
    return current;
  } };
  const service = f.makeService(undefined, identity); service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening'); t.after(() => service.close());
  const address = service.server.address(); assert.ok(address && typeof address === 'object');
  const request = () => fetch(`http://127.0.0.1:${address.port}/api/status?applicationTargetId=app-a`, { headers: { Authorization: `Bearer ${f.tokens.a}`, Connection: 'close' } });
  const first = request(); await wait(() => f.calls.status === 1);
  let secondSettled = false; const second = request().then(value => { secondSettled = true; return value; });
  await Promise.all([secondPreflight, wait(() => preflightChecks === 2)]);
  // Exhaust the already-queued await continuations after the observed DB
  // preflight. The handler has no further I/O before joining the blocked flight.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(preflightChecks, 2); assert.equal(secondSettled, false); assert.equal(f.calls.status, 1);
  await activeGrant(false); release();
  try {
    for (const response of await Promise.all([first, second])) { assert.equal(response.status, 403); assert.ok(!(await response.text()).includes('student-a')); }
    assert.equal(f.calls.status, 1);
  } finally { await activeGrant(true); }
});

test('real DB-mapped WSS tickets are one use and active connections observe committed grant/resource revocation', async t => {
  const f = await fixture(); t.after(() => f.service.close());
  const ticket = async () => { const result = await f.request(`/api/sessions/${ids.a}/realtime-ticket`, 'a', { method: 'POST', body: '{}' }); assert.equal(result.status, 200); return (await result.json()).ticket as string; };
  const value = await ticket(), active = await socket(f.base, value, ids.a); t.after(() => active.ws.terminate());
  active.ws.send('{"type":"ping"}'); await wait(() => active.messages.some(message => message.type === 'pong'));
  const replay = new WebSocket(f.base.replace('http:', 'ws:') + `/api/realtime?sessionId=${ids.a}&ticket=${value}`, { origin: f.base });
  replay.on('error', () => {}); const refused = await new Promise<number>(resolve => replay.on('unexpected-response', (_req, res) => { resolve(res.statusCode!); res.resume(); replay.terminate(); })); assert.equal(refused, 403);
  const closed = once(active.ws, 'close'); await activeGrant(false);
  try { active.ws.send('{"type":"ping"}'); assert.equal((await closed)[0], 1008); }
  finally { await activeGrant(true); }
  assert.equal(f.calls.save + f.calls.provider, 0);
});

test('worker DB binding proves the personal application through its exact session and finite ACL', async () => {
  const resolver = createPostgresWorkerBindingResolver(pools.worker, 'worker-a');
  const own = await resolver('a'.repeat(64)); assert.ok(own); assert.equal(own.ownerId, 'owner-a'); assert.equal(own.sessionId, ids.a); assert.equal(own.supportTargetId, 'domain-track');
  assert.equal(Object.hasOwn(own, 'applicationTargetId'), false, 'legacy domain payload is not rewritten');
  assert.equal(await resolver('b'.repeat(64)), null); assert.equal(await resolver('f'.repeat(64)), null);
  const now = Date.now(), capability = createTrustedEvaluationWorkerExecution({ subjectId: 'worker-a', issuedAt: now - 1, expiresAt: now + 10000, jobIds: ['a'.repeat(64)], resolveBinding: resolver });
  const environment = process.env as Record<string, string | undefined>; const previous = environment.INTERVIEW_EXECUTION_MODE; environment.INTERVIEW_EXECUTION_MODE = 'service';
  try { assert.equal(assertWorkerExecution(capability, now), 'service'); }
  finally { if (previous === undefined) delete environment.INTERVIEW_EXECUTION_MODE; else environment.INTERVIEW_EXECUTION_MODE = previous; }
  await assert.rejects(pools.mapping.query('UPDATE gakja.job_bindings SET application_target_id=$1 WHERE owner_id=$2 AND job_id=$3', ['app-a2', 'owner-a', 'a'.repeat(64)]));
});

test('a DB-attested finite job reaches the real worker signed A/B gates and revocation stops later execution', async t => {
  const environment = process.env as Record<string, string | undefined>, previous = environment.INTERVIEW_EXECUTION_MODE;
  environment.INTERVIEW_EXECUTION_MODE = 'local-development';
  t.after(() => { if (previous === undefined) delete environment.INTERVIEW_EXECUTION_MODE; else environment.INTERVIEW_EXECUTION_MODE = previous; });
  const root = await mkdtemp(path.join(os.tmpdir(), 'pr07b-real-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = 'owner-db-worker-integration', app = 'app-db-worker-integration', worker = 'worker-db-integration';
  const value = await evaluationSupplyFixture(); value.session.runtime!.owner.id = owner;
  const registry = reviewedSupplyRegistry(value), signer = supplySigner(); value.context.evaluationScopeRegistry = registry; pinSupplySnapshot(value.context, value.session);
  const sessions = createLocalSessionStore(root), jobs = createLocalEvaluationJobStore(root), reviews = createLocalReviewRepository(root);
  await sessions.saveContext(value.context, owner); await sessions.save(value.session);
  const issuedAt = new Date(Date.now() - 1000).toISOString(), expiresAt = new Date(Date.now() + 60000).toISOString();
  await publishBankScopeReview(registry, value.context, value.bank, signer.receipt({ version: 'authenticated-bank-scope-review-v1', actorId: supplyReviewer,
    registrySha256: registry.contentSha256, action: 'publish_scopes', issuedAt, expiresAt }), null, root, signer.trustedPublicKey, reviews);
  const proposal = prepareEndedSessionReview(value.context, value.session, registry), bundle = supplyRecordBundle(value.session);
  const receipt = signer.receipt({ version: 'authenticated-session-evaluation-review-v1', actorId: supplyReviewer, action: 'approve_session_evaluation',
    proposalSha256: proposal.contentSha256, bundleSha256: bundle.contentSha256, sessionId: value.session.id,
    sessionQuestionAnswerSha256: knowledgeSessionQuestionAnswerHash(value.session), contextSnapshotSha256: value.session.runtime!.contextSnapshotSha256, issuedAt, expiresAt });
  const supplied = await supplyReviewedSessionEvaluation({ ...value, root, proposal, bundle, receipt, trustedPublicKey: signer.trustedPublicKey,
    enqueue: true, sessions, jobs, reviews, model: 'explicit-synthetic-db-worker-model' });
  const job = (await jobs.get(supplied.jobId!))!;
  t.after(async () => {
    await pools.admin.query('DELETE FROM gakja.worker_job_grants WHERE worker_subject=$1', [worker]);
    await pools.admin.query('DELETE FROM gakja.job_bindings WHERE owner_id=$1', [owner]);
    await pools.admin.query('DELETE FROM gakja.session_bindings WHERE owner_id=$1', [owner]);
    await pools.admin.query('DELETE FROM gakja.application_targets WHERE owner_id=$1', [owner]);
    await pools.admin.query('DELETE FROM gakja.students WHERE owner_id=$1', [owner]);
    await pools.admin.query('DELETE FROM gakja.accounts WHERE owner_id=$1', [owner]);
    await pools.admin.query('DELETE FROM gakja.target_profiles WHERE support_target_id=$1', ['track-synthetic']);
  });
  await pools.admin.query('INSERT INTO gakja.accounts(account_id,owner_id) VALUES ($1,$2)', ['account-db-worker-integration', owner]);
  await pools.admin.query('INSERT INTO gakja.students VALUES ($1,$2,$3,$4)', [owner, 'student-synthetic', 'Explicit synthetic worker', 'f'.repeat(64)]);
  await pools.admin.query('INSERT INTO gakja.target_profiles VALUES ($1,$2,$3,$4,$5,$6)', ['track-synthetic', 'worker-profile-r1', 'explicit-synthetic', 'explicit-synthetic', 'explicit-synthetic', 2027]);
  await pools.admin.query('INSERT INTO gakja.application_targets VALUES ($1,$2,$3,$4,$5,$6)', [owner, 'student-synthetic', app, 'track-synthetic', 'worker-profile-r1', 'Explicit synthetic worker']);
  await pools.admin.query('INSERT INTO gakja.session_bindings VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [owner, value.session.id, 'student-synthetic', app, 'track-synthetic', false, null, job.contextSnapshotSha256, job.sourceSha256]);
  await pools.admin.query('INSERT INTO gakja.job_bindings VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [owner, job.id, value.session.id, 'student-synthetic', app, 'track-synthetic', false, null, job.sourceSha256, job.snapshotSha256, job.contextSnapshotSha256, job.pipelineVersion, job.model]);
  await pools.admin.query('INSERT INTO gakja.worker_job_grants VALUES ($1,$2,$3,$4,$5)', [worker, owner, job.id, true, expiresAt]);
  environment.INTERVIEW_EXECUTION_MODE = 'service';
  const now = Date.now(), resolver = createPostgresWorkerBindingResolver(pools.worker, worker);
  const capability = createTrustedEvaluationWorkerExecution({ subjectId: worker, issuedAt: now - 1, expiresAt: now + 60000, jobIds: [job.id], resolveBinding: resolver });
  let providerCalls = 0;
  const scopedJobs = new Proxy(jobs, { get(target, key) { if (key === 'pending') return () => { throw new Error('GLOBAL_SCAN_FORBIDDEN'); }; const field = Reflect.get(target, key); return typeof field === 'function' ? field.bind(target) : field; } });
  const result = { summary: 'Explicit synthetic DB-attested provider only', sessionScore: null, answers: [] } as unknown as Awaited<ReturnType<typeof evaluateSession>>;
  const completed = await runEvaluationWorkerOnce({ root, jobs: scopedJobs, sessions, reviews, trustedPublicKey: signer.trustedPublicKey, execution: capability,
    evaluate: async () => { providerCalls++; return result; } });
  assert.equal(completed.job?.status, 'completed'); assert.equal(providerCalls, 1);
  assert.deepEqual((await jobs.result(completed.job!))!.evaluation, result);
  await pools.admin.query('UPDATE gakja.worker_job_grants SET active=false WHERE worker_subject=$1', [worker]);
  assert.equal(await resolver(job.id), null);
  await assert.rejects(runEvaluationWorkerOnce({ root, jobs: scopedJobs, sessions, reviews, execution: capability, evaluate: async () => { providerCalls++; return result; } }), /INTERNAL_BINDING_DENIED/u);
  assert.equal(providerCalls, 1);
});
