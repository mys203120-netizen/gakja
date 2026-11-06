import test from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { createTrustedJwtVerifier, trustedJwtVerifierFromEnv } from '../server/auth/jose-jwt-verifier';
import { cacheScopeKey, createRequestIdentityBoundary, privateResponseHeaders, RequestAccessError, resolveExecutionMode,
  type AccountAccess, type ResourceBinding } from '../server/auth/request-identity';

const issuer = 'https://explicit-synthetic-issuer.invalid', audience = 'explicit-synthetic-api';
const originTime = Date.parse('2026-11-06T00:00:00.000Z');
const access = (id: string): AccountAccess => ({ accountId: `account-${id}`, ownerId: `owner-${id}`, revision: 'access-1',
  grants: [{ studentId: `student-${id}`, applicationTargetId: `application-${id}`, supportTargetId: 'same-public-target', sourceRevision: 'same-source-revision' }] });
const binding = (id: string): ResourceBinding => ({ ownerId: `owner-${id}`, studentId: `student-${id}`, applicationTargetId: `application-${id}`,
  supportTargetId: 'same-public-target', sourceRevision: 'same-source-revision', sessionId: `session-${id}` });
async function fixture() {
  let time = originTime, mappingCalls = 0;
  const pair = await generateKeyPair('ES256'), publicKey = await exportJWK(pair.publicKey);
  const accounts = new Map<string, AccountAccess>([['A', access('A')], ['B', access('B')]]);
  const verifier = createTrustedJwtVerifier({ issuer, audience, algorithms: ['ES256'], jwks: { keys: [{ ...publicKey, kid: 'synthetic-key' }] }, now: () => time });
  const boundary = createRequestIdentityBoundary({ mode: 'service', environment: 'test', verifier, now: () => time,
    accounts: { kind: 'synthetic', async resolve(principal) { mappingCalls++; return accounts.get(principal.subject) ?? null; } } });
  const sign = async (subject = 'A', claims: JWTPayload = {}, header: Record<string, unknown> = {}) => new SignJWT({ iss: issuer, sub: subject, aud: audience,
    exp: originTime / 1000 + 60, nbf: originTime / 1000, iat: originTime / 1000, ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'synthetic-key', ...header }).sign(pair.privateKey);
  return { pair, publicKey, verifier, boundary, accounts, sign, setTime: (value: number) => { time = value; }, mappingCalls: () => mappingCalls };
}
const rejection = (code: string, status?: number) => (error: unknown) => error instanceof RequestAccessError && error.code === code && (status === undefined || error.status === status);

test('two real-signature synthetic principals map to independent owners and explicit student/application scopes', async () => {
  const f = await fixture();
  const a = await f.boundary.authenticate(`Bearer ${await f.sign('A', { ownerId: 'owner-B', email: 'shared@example.invalid', role: 'admin' })}`);
  const b = await f.boundary.authenticate(`Bearer ${await f.sign('B', { ownerId: 'owner-A', email: 'shared@example.invalid' })}`);
  assert.equal(a.mode, 'authenticated'); assert.equal(b.mode, 'authenticated');
  if (a.mode !== 'authenticated' || b.mode !== 'authenticated') throw new Error('Synthetic authenticated fixture required');
  assert.equal(a.account.ownerId, 'owner-A'); assert.equal(b.account.ownerId, 'owner-B');
  assert.equal(a.scope, null); assert.equal(b.scope, null);
  f.boundary.assertResource(a, binding('A')); f.boundary.assertResource(b, binding('B'));
  assert.throws(() => f.boundary.assertResource(a, binding('B')), rejection('RESOURCE_NOT_FOUND', 404));
  assert.throws(() => f.boundary.assertResource(b, binding('A')), rejection('RESOURCE_NOT_FOUND', 404));
  const selected = f.boundary.selectScope(a, { studentId: 'student-A', applicationTargetId: 'application-A' });
  f.boundary.assertResource(selected, binding('A'));
  assert.throws(() => f.boundary.selectScope(a, { studentId: 'student-B' }), rejection('ACCESS_DENIED'));
  assert.notEqual(cacheScopeKey(a, binding('A')), cacheScopeKey(b, binding('B')));
});

test('actual JOSE verifier rejects invalid signature, issuer, audience, algorithm, expiry, future nbf and missing subject', async t => {
  const f = await fixture();
  const foreign = await generateKeyPair('ES256');
  const samples: [string, string, string][] = [
    ['issuer', await f.sign('A', { iss: 'https://foreign.invalid' }), 'AUTH_INVALID'],
    ['audience', await f.sign('A', { aud: 'foreign-api' }), 'AUTH_INVALID'],
    ['expired', await f.sign('A', { exp: originTime / 1000 }), 'AUTH_EXPIRED'],
    ['future nbf', await f.sign('A', { nbf: originTime / 1000 + 10 }), 'AUTH_INVALID'],
    ['future iat', await f.sign('A', { iat: originTime / 1000 + 10 }), 'AUTH_INVALID'],
    ['empty subject', await f.sign(''), 'AUTH_INVALID'],
    ['missing expiry', await f.sign('A', { exp: undefined }), 'AUTH_INVALID'],
    ['invalid compact token', 'not-a-compact-jwt', 'AUTH_INVALID'],
    ['signature', await new SignJWT({ iss: issuer, sub: 'A', aud: audience, exp: originTime / 1000 + 60 }).setProtectedHeader({ alg: 'ES256', kid: 'synthetic-key' }).sign(foreign.privateKey), 'AUTH_INVALID'],
    ['symmetric algorithm', await new SignJWT({ iss: issuer, sub: 'A', aud: audience, exp: originTime / 1000 + 60 }).setProtectedHeader({ alg: 'HS256' }).sign(new Uint8Array(32).fill(5)), 'AUTH_INVALID'],
  ];
  for (const [name, token, code] of samples) await t.test(name, () => assert.rejects(f.boundary.authenticate(`Bearer ${token}`), rejection(code, 401)));
  assert.equal(f.mappingCalls(), 0);
});

test('token-provided key endpoints are ignored and trusted key outages remain distinct from invalid credentials', async () => {
  const f = await fixture();
  const token = await f.sign('A', {}, { jku: 'https://request-controlled.invalid/keys', x5u: 'https://request-controlled.invalid/cert' });
  // Only the fixed local public JWKS is available. A header endpoint cannot be followed.
  assert.equal((await f.boundary.authenticate(`Bearer ${token}`)).mode, 'authenticated');
  const verifier = createTrustedJwtVerifier({ issuer, audience, algorithms: ['ES256'], now: () => originTime,
    keyResolver: async () => { throw new Error('synthetic unavailable key material'); } });
  await assert.rejects(verifier.verify(token), rejection('AUTH_UNAVAILABLE', 503));
});

test('missing credentials and unmapped principals never select the local development owner', async () => {
  const f = await fixture();
  for (const header of [undefined, '', 'Basic explicit-synthetic', 'Bearer a, Bearer b', 'Bearer a b']) {
    await assert.rejects(f.boundary.authenticate(header), error => error instanceof RequestAccessError && error.status === 401);
  }
  assert.equal(f.mappingCalls(), 0);
  await assert.rejects(f.boundary.authenticate(`Bearer ${await f.sign('unmapped')}`), rejection('ACCOUNT_UNMAPPED', 403));
});

test('service composition refuses missing or test-only mapping before invoking any verifier', async () => {
  let calls = 0;
  const verifier = { kind: 'trusted-jwt' as const, async verify() { calls++; throw new Error('must not execute'); } };
  for (const options of [
    { mode: 'service' as const }, { mode: 'service' as const, verifier },
    { mode: 'service' as const, verifier, accounts: { kind: 'synthetic' as const, async resolve() { return access('A'); } } },
  ]) await assert.rejects(createRequestIdentityBoundary(options).authenticate('Bearer synthetic'), rejection('AUTH_UNAVAILABLE', 503));
  assert.equal(calls, 0);
});

test('mapping dependency failure and malformed authority fail closed without public private paths', async () => {
  const f = await fixture(), token = await f.sign();
  for (const resolve of [async () => { throw new Error('private path /not-exported'); }, async () => ({ ...access('A'), ownerId: '' })]) {
    const boundary = createRequestIdentityBoundary({ mode: 'service', verifier: f.verifier, accounts: { kind: 'operational', resolve }, now: () => originTime });
    await assert.rejects(boundary.authenticate(`Bearer ${token}`), error => rejection('AUTH_UNAVAILABLE', 503)(error) && error instanceof Error && !error.message.includes('/not-exported'));
  }
});

test('scope selection rejects ambiguity, null/empty selectors and resources outside source revision pins', async () => {
  const f = await fixture();
  f.accounts.set('A', { ...access('A'), grants: [...access('A').grants, { studentId: 'student-A', applicationTargetId: 'application-A-2', supportTargetId: 'same-public-target', sourceRevision: 'revision-2' }] });
  const context = await f.boundary.authenticate(`Bearer ${await f.sign()}`);
  assert.throws(() => f.boundary.selectScope(context, { supportTargetId: 'same-public-target' }), rejection('ACCESS_DENIED'));
  assert.throws(() => f.boundary.selectScope(context, { studentId: '' }), rejection('ACCESS_DENIED'));
  assert.throws(() => f.boundary.selectScope(context, { studentId: null } as unknown as { studentId: string }), rejection('ACCESS_DENIED'));
  assert.throws(() => f.boundary.assertResource(context, { ...binding('A'), sourceRevision: 'revision-2' }), rejection('RESOURCE_NOT_FOUND'));
  assert.throws(() => f.boundary.assertResource(context, { ...binding('A'), sourceRevision: null }), rejection('RESOURCE_NOT_FOUND'));
  const selected = f.boundary.selectScope(context, { applicationTargetId: 'application-A' });
  assert.throws(() => f.boundary.assertResource(selected, { ...binding('A'), applicationTargetId: 'application-A-2', sourceRevision: 'revision-2' }), rejection('RESOURCE_NOT_FOUND'));
});

test('request contexts are minted, frozen capabilities; JSON clones and altered DTO owner are not authority', async () => {
  const f = await fixture(), context = await f.boundary.authenticate(`Bearer ${await f.sign()}`);
  assert.ok(Object.isFrozen(context));
  if (context.mode !== 'authenticated') throw new Error('Expected authenticated fixture');
  assert.ok(Object.isFrozen(context.account)); assert.ok(Object.isFrozen(context.account.grants));
  assert.throws(() => f.boundary.assertResource(structuredClone(context), binding('A')), rejection('ACCESS_DENIED'));
  assert.throws(() => f.boundary.assertResource(context, { ...binding('B'), ownerId: 'owner-A' }), rejection('RESOURCE_NOT_FOUND'));
});

test('expiry and account revision/grant revocation invalidate already authenticated contexts', async () => {
  const f = await fixture(), context = await f.boundary.authenticate(`Bearer ${await f.sign()}`);
  assert.equal((await f.boundary.revalidate(context)).mode, 'authenticated');
  f.accounts.set('A', { ...access('A'), revision: 'access-2' });
  await assert.rejects(f.boundary.revalidate(context), rejection('ACCESS_DENIED'));
  f.accounts.set('A', { ...access('A'), grants: [] });
  const selectedFixture = await fixture();
  const selected = selectedFixture.boundary.selectScope(await selectedFixture.boundary.authenticate(`Bearer ${await selectedFixture.sign()}`), { studentId: 'student-A' });
  selectedFixture.accounts.set('A', { ...access('A'), grants: [] });
  await assert.rejects(selectedFixture.boundary.revalidate(selected), rejection('ACCESS_DENIED'));
  f.setTime(originTime + 60_000);
  assert.throws(() => f.boundary.assertResource(context, binding('A')), rejection('AUTH_EXPIRED'));
  await assert.rejects(f.boundary.revalidate(context), rejection('AUTH_EXPIRED'));
});

test('expiry during awaited mapping is checked again before returning authority', async () => {
  const f = await fixture();
  let now = originTime;
  const boundary = createRequestIdentityBoundary({ mode: 'service', verifier: f.verifier, now: () => now,
    accounts: { kind: 'operational', async resolve() { await Promise.resolve(); now = originTime + 61_000; return access('A'); } } });
  await assert.rejects(boundary.authenticate(`Bearer ${await f.sign()}`), rejection('AUTH_EXPIRED'));
});

test('execution mode has no absent/production development fallback and private response caching is disabled', async () => {
  assert.equal(resolveExecutionMode({}), 'service'); assert.equal(resolveExecutionMode({ INTERVIEW_EXECUTION_MODE: '' }), 'service');
  assert.equal(resolveExecutionMode({ INTERVIEW_EXECUTION_MODE: 'local-development', NODE_ENV: 'development' }), 'local-development');
  assert.throws(() => resolveExecutionMode({ INTERVIEW_EXECUTION_MODE: 'local-development', NODE_ENV: 'production' }), rejection('EXECUTION_MODE_INVALID'));
  assert.throws(() => resolveExecutionMode({ INTERVIEW_EXECUTION_MODE: 'mistyped' }), rejection('EXECUTION_MODE_INVALID'));
  assert.equal(privateResponseHeaders['Cache-Control'], 'private, no-store');
  const local = createRequestIdentityBoundary({ mode: 'local-development', localOwnerId: 'explicit-synthetic-local-owner' });
  assert.deepEqual(await local.authenticate(undefined), { mode: 'local-development', ownerId: 'explicit-synthetic-local-owner' });
});

test('trusted JWT environment is all-or-nothing and never accepts an insecure or credential-bearing key URL', () => {
  assert.equal(trustedJwtVerifierFromEnv({}), undefined);
  assert.throws(() => trustedJwtVerifierFromEnv({ INTERVIEW_AUTH_ISSUER: issuer }), rejection('AUTH_UNAVAILABLE'));
  for (const jwksUrl of ['http://request.invalid/keys', 'https://name:password@request.invalid/keys', 'https://request.invalid/keys#fragment']) {
    assert.throws(() => createTrustedJwtVerifier({ issuer, audience, algorithms: ['ES256'], jwksUrl }), rejection('AUTH_UNAVAILABLE'));
  }
  assert.throws(() => createTrustedJwtVerifier({ issuer, audience, algorithms: ['HS256'], jwks: { keys: [] } }), rejection('AUTH_UNAVAILABLE'));
});
