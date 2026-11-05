/** Anonymous fixed signed inputs, independent source-root production modules,
 * actual local writers, controlled failures and ordered physical byte evidence. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { QuestionEvaluationSpecRegistry } from '../server/data/evaluation-scope-registry';

const flags = new Map(process.argv.slice(2).map(value => {
  const match = /^--(source-root|output|fixture|child-root)=(.+)$/u.exec(value); if (!match) throw new Error('PR06D_REVIEW_FLAGS_INVALID'); return [match[1], match[2]];
}));
for (const key of ['source-root', 'fixture']) assert.ok(flags.has(key));
const sourceRoot = path.resolve(flags.get('source-root')!), fixtureFile = path.resolve(flags.get('fixture')!);
const scriptFile = fileURLToPath(import.meta.url), sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const scriptSha256 = sha(await readFile(scriptFile));
const initialClock = Date.parse('2026-11-06T12:00:00.000Z'); let now = initialClock;
const NativeDate = Date;
class FixedDate extends NativeDate { constructor(value?: string | number) { super(value ?? now); } static now() { return now; } }
globalThis.Date = FixedDate as DateConstructor;
const privateKey = createPrivateKey({ key: Buffer.from('302e020100300506032b657004220420' + sha('PR06D_SYNTHETIC_REVIEW_SEED_NOT_A_REAL_REVIEWER'), 'hex'), format: 'der', type: 'pkcs8' });
const trustedPublicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
const receipt = (registry: QuestionEvaluationSpecRegistry, change: Record<string, unknown> = {}) => {
  const payload = { version: 'authenticated-bank-scope-review-v1', actorId: registry.entries[0].review.approverId,
    registrySha256: registry.contentSha256, action: 'publish_scopes', issuedAt: '2026-11-06T11:59:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z', ...change };
  return { ...payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64') };
};
// Dataset construction is done once, before either production implementation is
// exercised. Both runs then consume the same frozen anonymous fixture bytes.
let fixtureBytes: Buffer;
try { fixtureBytes = await readFile(fixtureFile); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || flags.has('child-root')) throw error;
  const fixtureApi = await import('../tests/fixtures/evaluation-supply');
  const value = await fixtureApi.evaluationSupplyFixture(), approved = fixtureApi.reviewedSupplyRegistry(value), bundle = fixtureApi.supplyRecordBundle(value.session);
  await mkdir(path.dirname(fixtureFile), { recursive: true });
  await writeFile(fixtureFile, JSON.stringify({ version: 'anonymous-review-storage-fixture-v1', value, approved, bundle }, null, 2), { flag: 'wx', mode: 0o600 });
  fixtureBytes = await readFile(fixtureFile);
}
const fixtureSha256 = sha(fixtureBytes), fixture = JSON.parse(fixtureBytes.toString('utf8')) as {
  value: Awaited<ReturnType<typeof import('../tests/fixtures/evaluation-supply')['evaluationSupplyFixture']>>;
  approved: QuestionEvaluationSpecRegistry; bundle: ReturnType<typeof import('../tests/fixtures/evaluation-supply')['supplyRecordBundle']>;
};
const load = (relative: string) => import(pathToFileURL(path.join(sourceRoot, relative)).href);
const [registryApi, contextApi, turnsApi, gateApi, supplyApi] = await Promise.all([
  load('server/data/evaluation-scope-registry.ts') as Promise<typeof import('../server/data/evaluation-scope-registry')>,
  load('server/data/reviewed-evaluation-context.ts') as Promise<typeof import('../server/data/reviewed-evaluation-context')>,
  load('server/providers/evaluation-turns.ts') as Promise<typeof import('../server/providers/evaluation-turns')>,
  load('server/providers/evaluation-knowledge-gate.ts') as Promise<typeof import('../server/providers/evaluation-knowledge-gate')>,
  load('server/evaluation-supply.ts') as Promise<typeof import('../server/evaluation-supply')>,
]);
const moduleFiles = ['server/data/evaluation-scope-registry.ts', 'server/data/reviewed-evaluation-context.ts'];
const moduleHashes = async () => Object.fromEntries(await Promise.all(moduleFiles.map(async file => [file, sha(await readFile(path.join(sourceRoot, file)))])));
const sourceModuleHashes = await moduleHashes();
const { contentSha256: ignored, ...withdrawnBody } = structuredClone(fixture.approved); void ignored;
withdrawnBody.entries[0].review = { ...withdrawnBody.entries[0].review, status: 'withdrawn', approverId: fixture.approved.entries[0].review.approverId!, reviewedAt: new Date().toISOString(), reason: 'explicit anonymous fixture withdrawal' };
const withdrawn = registryApi.sealBankScopeRegistry(withdrawnBody);
const nativeFs = createRequire(import.meta.url)('node:fs/promises'), nativeCrypto = createRequire(import.meta.url)('node:crypto');
const io = Object.fromEntries(['mkdir', 'open', 'readFile', 'writeFile', 'rename', 'unlink'].map(key => [key, nativeFs[key]])), originalUuid = nativeCrypto.randomUUID;
const gate = () => { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; };
type Event = { op: string; file: string; destination?: string; settings?: unknown; sha256?: string; bytes?: number; error?: string };
function instrument(root: string) {
  const events: Event[] = [], entered = gate(), release = gate(); let fault: string | null = null, holdLock = false, nonce = 0;
  const relative = (value: unknown) => path.relative(root, path.resolve(String(value))).replaceAll('\\', '/');
  const owned = (value: unknown) => typeof value === 'string' && !relative(value).startsWith('..') && !path.isAbsolute(relative(value));
  const observe = async <T>(row: Event, job: () => Promise<T>) => { events.push(row); try { return await job(); } catch (error) { row.error = (error as NodeJS.ErrnoException).code ?? (error as Error).name; throw error; } };
  const fail = (op: string) => { if (fault === op) { fault = null; throw Object.assign(new Error('EXPLICIT_SYNTHETIC_REVIEW_IO_FAILURE'), { code: op === 'rename' ? 'EPERM' : op === 'unlink' ? 'EACCES' : 'ENOSPC' }); } };
  nativeCrypto.randomUUID = () => `00000000-0000-4000-8000-${String(++nonce).padStart(12, '0')}`;
  for (const op of ['mkdir', 'readFile', 'writeFile', 'rename', 'unlink']) nativeFs[op] = async (...args: unknown[]) => {
    if (!owned(args[0])) return io[op](...args);
    const row: Event = { op, file: relative(args[0]), ...(op === 'rename' ? { destination: relative(args[1]) } : {}),
      ...(op === 'mkdir' ? { settings: args[1] } : op === 'writeFile' ? { settings: args[2], sha256: sha(args[1] as string | Buffer), bytes: Buffer.byteLength(args[1] as string | Buffer) } : {}) };
    return observe(row, async () => {
      if (op === 'writeFile' && (fault === 'partial-revision' && row.file.includes(`/revisions/${withdrawn.contentSha256}.json`) || fault === 'partial-pointer' && row.file.includes('/current.'))) {
        fault = null; await io.writeFile(...[args[0], '{', args[2]]); throw Object.assign(new Error('EXPLICIT_SYNTHETIC_PARTIAL_REVIEW_WRITE'), { code: 'ENOSPC' });
      }
      fail(op); return io[op](...args);
    });
  };
  nativeFs.open = async (...args: unknown[]) => {
    if (!owned(args[0])) return io.open(...args);
    const file = relative(args[0]), handle = await observe({ op: 'open', file, settings: { flags: args[1], mode: args[2] } }, async () => io.open(...args));
    if (holdLock) { holdLock = false; entered.release(); await release.promise; }
    return { async close() { return observe({ op: 'close', file }, async () => { await handle.close(); fail('close'); }); } };
  };
  syncBuiltinESMExports();
  return { events, entered, release, fault: (value: string) => { fault = value; }, holdLock: () => { holdLock = true; },
    restore: () => { release.release(); for (const [key, value] of Object.entries(io)) nativeFs[key] = value; nativeCrypto.randomUUID = originalUuid; syncBuiltinESMExports(); } };
}
async function files(root: string) {
  const result: { file: string; bytes: number; sha256: string; utf8: string }[] = [];
  async function walk(directory: string) { for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) { const file = path.join(directory, item.name); if (item.isDirectory()) await walk(file); else { const bytes = await io.readFile(file); result.push({ file: path.relative(root, file).replaceAll('\\', '/'), bytes: bytes.length, sha256: sha(bytes), utf8: bytes.toString('utf8') }); } } }
  await walk(root); return result;
}
if (flags.has('child-root')) {
  const root = path.resolve(flags.get('child-root')!); assert.ok(path.basename(root).startsWith('owned-')); const hooks = instrument(root);
  try { const registry = await registryApi.loadBankScopeRegistry(root, trustedPublicKey); console.log(JSON.stringify({ registry, freshProcess: true, events: hooks.events })); }
  finally { hooks.restore(); globalThis.Date = NativeDate; }
} else {
  assert.ok(flags.has('output')); const output = path.resolve(flags.get('output')!), base = path.join(path.dirname(output), 'review-case-roots'); await mkdir(base, { recursive: true });
  const cases = [];
  const names = ['missing-current', 'signed-publish', 'same-receipt-republish', 'stale-cas', 'competing-lock', 'invalid-signature', 'wrong-reviewer', 'expired-publish', 'stored-expired-receipt-read',
    'invalid-pointer-json', 'invalid-pointer-digest', 'missing-revision', 'corrupt-revision', 'corrupt-stored-signature', 'partial-revision', 'partial-pointer', 'rename-failure', 'lock-close-failure', 'lock-unlink-failure',
    'fresh-withdrawal', 'pure-reviewed-record', 'pure-answer-corrected', 'pure-base-context-changed', 'foreign-owner-specification', 'new-process-read'];
  for (const id of names) {
    now = initialClock; const root = await mkdtemp(path.join(base, 'owned-')), registryDirectory = path.join(root, 'data/prepared/evaluation-scope-registry'), hooks = instrument(root);
    const observations: Record<string, unknown> = {};
    const publish = (registry = fixture.approved, signed = receipt(registry), expected: string | null = null) => registryApi.publishBankScopeReview(registry, fixture.value.context, fixture.value.bank, signed, expected, root, trustedPublicKey);
    const read = () => registryApi.loadBankScopeRegistry(root, trustedPublicKey);
    const capture = async (job: () => unknown) => { try { return { status: 'returned', value: await job() }; } catch (error) { const row = error as NodeJS.ErrnoException; return { status: 'rejected', name: row.name, code: row.code ?? (/^[A-Z0-9_]+$/u.test(row.message) ? row.message : null), messageSha256: sha(row.message.replaceAll(root, '<owned-root>')) }; } };
    try {
      if (id === 'missing-current') observations.read = await capture(read);
      if (['signed-publish', 'same-receipt-republish', 'stale-cas', 'stored-expired-receipt-read', 'corrupt-revision', 'corrupt-stored-signature', 'partial-revision', 'partial-pointer', 'rename-failure', 'fresh-withdrawal', 'new-process-read'].includes(id)) observations.initial = await capture(() => publish());
      if (id === 'signed-publish') observations.aOnlyGate = gateApi.evaluateKnowledgeGate({ ...fixture.value.context, evaluationScopeRegistry: fixture.approved }, fixture.value.session, turnsApi.buildEvaluationUnits(fixture.value.session).scoredUnits[0]);
      if (id === 'same-receipt-republish') observations.repeat = await capture(() => publish(fixture.approved, receipt(fixture.approved), fixture.approved.contentSha256));
      if (id === 'stale-cas') observations.stale = await capture(() => publish());
      if (id === 'competing-lock') {
        hooks.holdLock(); const first = publish(); await hooks.entered.promise;
        try { observations.contender = await capture(() => publish()); } finally { hooks.release.release(); observations.first = await capture(() => first); }
      }
      if (id === 'invalid-signature') observations.publish = await capture(() => publish(fixture.approved, { ...receipt(fixture.approved), signature: 'invalid' }));
      if (id === 'wrong-reviewer') observations.publish = await capture(() => publish(fixture.approved, receipt(fixture.approved, { actorId: 'explicit-wrong-reviewer' })));
      if (id === 'expired-publish') observations.publish = await capture(() => publish(fixture.approved, receipt(fixture.approved, { expiresAt: new Date(now - 1).toISOString() })));
      if (id === 'stored-expired-receipt-read') now = Date.parse('2031-01-01T00:00:00.000Z');
      if (['invalid-pointer-json', 'invalid-pointer-digest', 'missing-revision'].includes(id)) {
        await io.mkdir(registryDirectory, { recursive: true }); await io.writeFile(path.join(registryDirectory, 'current.json'), id === 'invalid-pointer-json' ? '{' : JSON.stringify({ contentSha256: id === 'invalid-pointer-digest' ? 'not-a-digest' : 'f'.repeat(64) }));
      }
      if (id === 'corrupt-revision') await io.writeFile(path.join(registryDirectory, 'revisions', `${fixture.approved.contentSha256}.json`), '{');
      if (id === 'corrupt-stored-signature') await io.writeFile(path.join(registryDirectory, 'revisions', `${fixture.approved.contentSha256}.json`), JSON.stringify({ registry: fixture.approved, receipt: { ...receipt(fixture.approved), signature: 'invalid' } }, null, 2));
      if (['partial-revision', 'partial-pointer', 'rename-failure'].includes(id)) {
        hooks.fault(id === 'rename-failure' ? 'rename' : id); observations.failed = await capture(() => publish(withdrawn, receipt(withdrawn), fixture.approved.contentSha256));
        observations.retainedCurrent = await capture(read); observations.explicitRetry = await capture(() => publish(withdrawn, receipt(withdrawn), fixture.approved.contentSha256));
      }
      if (id === 'lock-close-failure' || id === 'lock-unlink-failure') {
        hooks.fault(id === 'lock-close-failure' ? 'close' : 'unlink'); observations.failed = await capture(() => publish()); observations.retry = await capture(() => publish(fixture.approved, receipt(fixture.approved), fixture.approved.contentSha256));
      }
      if (id === 'fresh-withdrawal') { observations.firstRead = await capture(read); observations.withdrawn = await capture(() => publish(withdrawn, receipt(withdrawn), fixture.approved.contentSha256)); }
      if (id.startsWith('pure-')) {
        const context = structuredClone(fixture.value.context), session = structuredClone(fixture.value.session);
        if (id === 'pure-answer-corrected') session.turns[0].rawTranscript += ' explicit correction';
        if (id === 'pure-base-context-changed') context.evaluationGuidelines += ' explicit changed context';
        const content = JSON.stringify(fixture.bundle, null, 2);
        observations.projection = await capture(() => contextApi.createReviewedEvaluationKnowledgeContext(context, session, fixture.bundle,
          { path: `data/prepared/approved-knowledge/revisions/${fixture.bundle.contentSha256}.json`, fileSha256: sha(content) }));
      }
      if (id === 'foreign-owner-specification') {
        const { contentSha256: unused, ...body } = structuredClone(fixture.approved); void unused; body.ownerId = 'explicit-foreign-owner';
        const foreign = registryApi.sealBankScopeRegistry(body); observations.publish = await capture(() => publish(foreign));
        observations.pendingEndedProposal = supplyApi.prepareEndedSessionReview(fixture.value.context, fixture.value.session, foreign);
      }
      if (id === 'new-process-read') {
        const child = await promisify(execFile)(process.execPath, ['--import', pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href, scriptFile,
          `--source-root=${sourceRoot}`, `--fixture=${fixtureFile}`, `--child-root=${root}`], { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 }); observations.reopened = JSON.parse(child.stdout);
      }
      observations.finalRead = await capture(read); cases.push({ id, observations, actualIoEvents: hooks.events, finalFiles: await files(root) });
    } finally { hooks.restore(); }
  }
  globalThis.Date = NativeDate;
  assert.deepEqual(await moduleHashes(), sourceModuleHashes); assert.equal(sha(await readFile(fixtureFile)), fixtureSha256); assert.equal(sha(await readFile(scriptFile)), scriptSha256);
  await writeFile(output, JSON.stringify({ version: 'pr06d-independent-review-storage-cases-v1', sourceRoot, sourceModuleHashes, scriptSha256, fixtureSha256,
    controlledClock: new NativeDate(initialClock).toISOString(), uuidPolicy: 'valid deterministic UUID sequence for existing pointer temporary files only',
    fixtureAuthority: 'anonymous synthetic signed test data; never actual approval', actualProviderCalls: 0, cases }, null, 2) + '\n');
  console.log(JSON.stringify({ output, cases: cases.length, actualProviderCalls: 0, sourceUnchanged: true, fixtureUnchanged: true }));
}
