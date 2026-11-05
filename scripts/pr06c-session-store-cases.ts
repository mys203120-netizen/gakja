/** Independent actual local-store writers/readers and runtime recovery. All
 * writes/faults target owned synthetic directories, never private sessions. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { InterviewSession } from '../server/protocol';
import type { LocalSessionStoreOptions } from '../server/storage/local-session-store';

const flags = new Map(process.argv.slice(2).map(argument => { const match = /^--(source-root|output|child-root|context-sha)=(.+)$/u.exec(argument); if (!match) throw new Error('PR06C_STORE_FLAGS_INVALID'); return [match[1], match[2]]; }));
if (!flags.has('source-root') || !flags.has('output') && !flags.has('child-root')) throw new Error('PR06C_STORE_EXPLICIT_ROOT_OUTPUT_REQUIRED');
const sourceRoot = path.resolve(flags.get('source-root')!), sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex'), jsonSha = (value: unknown) => sha(JSON.stringify(value));
const sourceFile = path.join(sourceRoot, 'server/storage/local-session-store.ts'), sourceSha256 = sha(await readFile(sourceFile));
const api = await import(pathToFileURL(sourceFile).href) as typeof import('../server/storage/local-session-store');
const runtime = await import(pathToFileURL(path.join(sourceRoot, 'server/session-runtime.ts')).href) as typeof import('../server/session-runtime');
const owner = 'explicit-synthetic-session-owner', sessionId = '11111111-1111-4111-8111-111111111111', secondId = '22222222-2222-4222-8222-222222222222';
const clock = '2026-11-06T00:00:00.000Z', clockMs = Date.parse(clock);
const create = (root: string, io?: LocalSessionStoreOptions) => typeof api.createLocalSessionStore === 'function' ? api.createLocalSessionStore(root, io) : new api.LocalSessionStore(path.join(root, 'data/sessions'), io);
if (flags.has('child-root')) {
  const root = path.resolve(flags.get('child-root')!), store = create(root), session = await store.load(sessionId, owner);
  assert.ok(session); const context = await store.loadContext(flags.get('context-sha')!, owner), restored = runtime.restoreLogicalSession(session, owner, clockMs + 1000);
  console.log(JSON.stringify({ pid: process.pid, sessionSha256: jsonSha(session), contextSha256: jsonSha(context), restoredSha256: jsonSha(restored),
    checkpoint: restored.runtime!.checkpoint, epoch: restored.runtime!.epoch, answerId: restored.turns[0].answerId, transcript: restored.turns[0].rawTranscript, transcriptStatus: restored.turns[0].transcriptStatus }));
  process.exit(0);
}
const output = path.resolve(flags.get('output')!), base = path.join(path.dirname(output), 'session-store-case-roots'); await mkdir(base, { recursive: true });
const context = { target: { year: 2027, studentName: '명시적 합성 학생', university: '합성대학교', department: '합성학과', track: '합성전형' },
  manifest: { rulesVersion: 'explicit-synthetic-session-rules', files: [], recordIds: { studentId: 'explicit-synthetic-student' }, evidenceIds: [], errors: [] },
  student: { studentId: 'explicit-synthetic-student', evidence: [], studentName: '명시적 합성 학생', limitations: [] },
  questionGuidelines: '🙂 정확한 합성 원문', evaluationGuidelines: '합성 평가', errors: [], nestedUnknown: null,
} as unknown as InterviewContext;
function fixture(id = sessionId): InterviewSession {
  return { id, createdAt: clock, updatedAt: clock, status: 'active', evaluationStatus: 'pending', elapsedMs: 123, target: context.target, sourceManifest: context.manifest,
    turns: [{ id: 'fixed-synthetic-turn', answerId: 'fixed-synthetic-answer', rawTranscript: '🙂 저장된 합성 미확정 원문', transcriptStatus: 'streaming', questionKind: 'main', parentMainQuestionId: 'fixed-synthetic-turn', metadata: {} }],
    followUpCountByMainQuestion: {}, metrics: { second: null, first: '원문 순서', omitted: undefined },
    runtime: { ...runtime.createSessionRuntime(context, { id: owner, mode: 'local-development' }, clock),
      checkpoint: { phase: 'suspended', at: clock, turnId: 'fixed-synthetic-turn', answerId: 'fixed-synthetic-answer', disconnectedAt: clock },
      operations: { fixedNext: { status: 'committed', startedAt: clock, epoch: 0, result: { turn: null, done: true } } } },
  } as unknown as InterviewSession;
}
const fixtureSha256 = jsonSha({ context, session: fixture(), clock, owner });
const nativeFs = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
const io = { mkdir: nativeFs.mkdir, writeFile: nativeFs.writeFile, rename: nativeFs.rename, unlink: nativeFs.unlink };
type Event = { operation: string; path: string; destination?: string; bytes?: number; sha256?: string; mode?: number; flag?: string; outcome: string };
async function inventory(root: string) {
  const rows: Array<{ path: string; bytes: number; sha256: string }> = [];
  async function walk(directory: string) { for (const entry of await readdir(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) await walk(file); else { const bytes = await readFile(file); rows.push({ path: path.relative(root, file).replaceAll('\\', '/'), bytes: bytes.length, sha256: sha(bytes) }); } } }
  await walk(root); return rows.sort((left, right) => left.path.localeCompare(right.path));
}
const gate = () => { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; };
const cases: Array<Record<string, unknown>> = [];
for (const id of ['roundtrip-context', 'list-owner-corrupt-filtering', 'missing-session-context', 'corrupt-session-json', 'invalid-session-body', 'wrong-owner', 'context-hash-tamper', 'context-owner-tamper', 'context-wx-existing-corrupt',
  'queued-snapshot-capture', 'queued-recovery-after-failure', 'different-session-queues', 'windows-EPERM', 'windows-EACCES', 'windows-EBUSY', 'windows-seven-failures', 'permanent-EIO', 'partial-temp-ENOSPC', 'mkdir-EPERM',
  'recovery-599999', 'recovery-600000', 'recovery-600001', 'recovery-future-clock', 'recovery-other-owner', 'completed-after-window', 'new-process-restart', 'invalid-session-identifiers',
  'disconnected-anchor-precedence', 'checkpoint-fallback-boundaries', 'checkpoint-resave-no-renewal']) {
  const root = await mkdtemp(path.join(base, 'owned-')), store = create(root), session = fixture(), events: Event[] = [];
  const file = path.join(root, 'data/sessions', `${sessionId}.json`);
  let fault: { operation: 'mkdir' | 'writeFile'; code: 'EPERM' | 'ENOSPC'; partial?: boolean; delivered: boolean } | null = null, providerCalls = 0;
  const relative = (value: string) => { const result = path.relative(root, path.resolve(value)); assert.ok(result && !result.startsWith('..') && !path.isAbsolute(result)); return result.replaceAll('\\', '/'); };
  const observe = async (operation: keyof typeof io, args: unknown[]) => {
    const target = typeof args[0] === 'string' ? args[0] : ''; assert.ok(target);
    const settings = (operation === 'writeFile' ? args[2] : args[1]) as { mode?: number; flag?: string } | undefined;
    const event: Event = { operation, path: relative(target), outcome: 'pending', ...(operation === 'rename' ? { destination: relative(String(args[1])) } : {}),
      ...(operation === 'writeFile' ? { bytes: Buffer.byteLength(args[1] as string | Buffer), sha256: sha(args[1] as string | Buffer) } : {}),
      ...(settings && typeof settings === 'object' ? { mode: settings.mode, flag: settings.flag } : {}) }; events.push(event);
    try {
      if (fault && !fault.delivered && operation === fault.operation) {
        fault.delivered = true;
        if (fault.partial && operation === 'writeFile') await io.writeFile(String(args[0]), Buffer.from(args[1] as string | Buffer).subarray(0, 5), args[2] as Parameters<typeof io.writeFile>[2]);
        throw Object.assign(new Error('EXPLICIT_SYNTHETIC_SESSION_STORAGE_FAILURE'), { code: fault.code });
      }
      const value = await (io[operation] as (...values: unknown[]) => Promise<unknown>)(...args); event.outcome = 'ok'; return value;
    } catch (error) { event.outcome = (error as NodeJS.ErrnoException).code ?? (error as Error).name; throw error; }
  };
  nativeFs.mkdir = ((...args: unknown[]) => observe('mkdir', args)) as typeof nativeFs.mkdir;
  nativeFs.writeFile = ((...args: unknown[]) => observe('writeFile', args)) as typeof nativeFs.writeFile;
  nativeFs.rename = ((...args: unknown[]) => observe('rename', args)) as typeof nativeFs.rename;
  nativeFs.unlink = ((...args: unknown[]) => observe('unlink', args)) as typeof nativeFs.unlink;
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => { providerCalls++; throw new Error('PR06C_SESSION_PROVIDER_BLOCKED'); }; syncBuiltinESMExports();
  const capture = async (job: () => unknown) => { try { const value = await job(); return { status: 'returned', value, orderedJsonSha256: value === undefined ? null : jsonSha(value) }; } catch (error) { const value = error as Error & { code?: string }; return { status: 'rejected', name: value.name, code: value.code ?? (/^[A-Z0-9_]+$/u.test(value.message) ? value.message : null), messageSha256: sha(value.message.replaceAll(root, '<owned-root>')) }; } };
  let observations: Record<string, unknown> = {};
  try {
    if (id === 'roundtrip-context' || id === 'new-process-restart') {
      const hash = await store.saveContext(context, owner); await store.save(session);
      if (id === 'roundtrip-context') observations = { contextHash: hash, context: await store.loadContext(hash, owner), session: await store.load(sessionId, owner), list: await store.list(owner), secondContextHash: await store.saveContext(context, owner) };
      else {
        const stdout = await new Promise<string>((resolve, reject) => { const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), `--source-root=${sourceRoot}`, `--child-root=${root}`, `--context-sha=${hash}`], { cwd: process.cwd(), windowsHide: true }); let text = '', error = ''; child.stdout.on('data', chunk => { text += String(chunk); }); child.stderr.on('data', chunk => { error += String(chunk); }); child.on('error', reject); child.on('close', code => code === 0 ? resolve(text) : reject(new Error('PR06C_REOPEN_CHILD_FAILED:' + sha(error)))); });
        const { pid, ...reopened } = JSON.parse(stdout); assert.notEqual(pid, process.pid); assert.equal(reopened.sessionSha256, jsonSha(session)); assert.equal(reopened.contextSha256, jsonSha(context));
        observations = { reopened, separateProcess: true, providerCalls: 0 };
      }
    } else if (id === 'list-owner-corrupt-filtering') {
      await store.save(session); const other = fixture(secondId); other.runtime!.owner.id = 'another-synthetic-owner'; await store.save(other);
      await io.writeFile(path.join(root, 'data/sessions', '33333333-3333-4333-8333-333333333333.json'), '{broken'); await io.writeFile(`${file}.tmp`, 'incomplete pending snapshot');
      observations = { list: await store.list(owner), otherList: await store.list('another-synthetic-owner') };
    } else if (id === 'missing-session-context') observations = { session: await store.load(sessionId, owner), context: await capture(() => store.loadContext('a'.repeat(64), owner)), list: await store.list(owner) };
    else if (id === 'corrupt-session-json' || id === 'invalid-session-body' || id === 'wrong-owner') {
      await store.save(session);
      if (id === 'corrupt-session-json') await io.writeFile(file, '{broken');
      if (id === 'invalid-session-body') await io.writeFile(file, JSON.stringify({ ...session, elapsedMs: null }));
      observations = { load: await capture(() => store.load(sessionId, id === 'wrong-owner' ? 'another-owner' : owner)), list: await store.list(owner) };
    } else if (id.startsWith('context-')) {
      const hash = await store.saveContext(context, owner), contextFile = path.join(root, 'data/session-contexts', `${runtime.snapshotHash(owner)}-${hash}.json`);
      if (id === 'context-wx-existing-corrupt') { await io.writeFile(contextFile, '{broken'); observations.secondSave = await store.saveContext(context, owner); }
      else { const envelope = JSON.parse(await readFile(contextFile, 'utf8')); if (id === 'context-hash-tamper') envelope.context.questionGuidelines = 'changed'; else envelope.ownerId = 'another-owner'; await io.writeFile(contextFile, JSON.stringify(envelope)); }
      observations.load = await capture(() => store.loadContext(hash, owner));
    } else if (id === 'queued-snapshot-capture' || id === 'queued-recovery-after-failure' || id === 'different-session-queues') {
      const entered = gate(), release = gate(), replaceAttempts: Array<{ marker: unknown; sha256: string; outcome: string }> = []; let attempt = 0;
      const queued = create(root, { replaceFile: async (from, to) => { const bytes = await readFile(from), payload = JSON.parse(bytes.toString('utf8')); const event = { marker: payload.metrics.marker, sha256: sha(bytes), outcome: 'pending' }; replaceAttempts.push(event); if (++attempt === 1) { entered.release(); await release.promise; if (id === 'queued-recovery-after-failure') { event.outcome = 'EIO'; throw Object.assign(new Error('EXPLICIT_SYNTHETIC_QUEUED_REPLACE_FAILURE'), { code: 'EIO' }); } } await nativeFs.rename(from, to); event.outcome = 'ok'; } });
      session.metrics = { marker: 'first-captured' }; const first = capture(() => queued.save(session)); await entered.promise;
      session.metrics = { marker: 'mutated-after-first-save-call' };
      const next = id === 'different-session-queues' ? fixture(secondId) : session; next.metrics = { marker: 'second-captured' }; let secondCompleted = false;
      const second = capture(async () => { await queued.save(next); secondCompleted = true; });
      if (id === 'different-session-queues') await second;
      const secondCompletedBeforeFirstRelease = secondCompleted; release.release();
      observations = { first: await first, second: await second, secondCompletedBeforeFirstRelease, replaceAttempts, final: await queued.load(next.id, owner) };
      assert.equal(secondCompletedBeforeFirstRelease, id === 'different-session-queues');
    } else if (id.startsWith('windows-') || id === 'permanent-EIO') {
      await store.save(session); const beforeSha256 = sha(await readFile(file)), delays: number[] = [], attempts: Array<{ sha256: string; outcome: string }> = [];
      const exhausted = id === 'windows-seven-failures', code = id === 'permanent-EIO' ? 'EIO' : exhausted ? 'EPERM' : id.slice('windows-'.length);
      const denied = create(root, { replaceFile: async (from, to) => { const event = { sha256: sha(await readFile(from)), outcome: 'pending' }; attempts.push(event); if (exhausted || code === 'EIO' || attempts.length <= 6) { event.outcome = code; throw Object.assign(new Error('EXPLICIT_SYNTHETIC_WINDOWS_REPLACE_FAILURE'), { code }); } await nativeFs.rename(from, to); event.outcome = 'ok'; }, wait: async delay => { delays.push(delay); } });
      const outcome = await capture(() => denied.save({ ...session, metrics: { marker: 'replacement' } }));
      assert.deepEqual(delays, code === 'EIO' ? [] : [10, 25, 50, 100, 150, 200]); assert.equal(attempts.length, code === 'EIO' ? 1 : 7);
      observations = { outcome, delays, attempts, previousBytesPreserved: sha(await readFile(file)) === beforeSha256, current: await store.load(sessionId, owner) };
    } else if (id === 'partial-temp-ENOSPC' || id === 'mkdir-EPERM') {
      await store.save(session); const beforeSha256 = sha(await readFile(file));
      fault = id === 'mkdir-EPERM' ? { operation: 'mkdir', code: 'EPERM', delivered: false } : { operation: 'writeFile', code: 'ENOSPC', partial: true, delivered: false };
      observations = { outcome: await capture(() => store.save({ ...session, metrics: { marker: 'unpublished' } })), faultDelivered: fault.delivered, previousBytesPreserved: sha(await readFile(file)) === beforeSha256, current: await store.load(sessionId, owner) };
    } else if (id === 'disconnected-anchor-precedence' || id === 'checkpoint-resave-no-renewal' || id === 'checkpoint-fallback-boundaries') {
      const laterCheckpoint = new Date(clockMs + 500_000).toISOString();
      if (id === 'checkpoint-fallback-boundaries') delete session.runtime!.checkpoint.disconnectedAt;
      if (id !== 'checkpoint-resave-no-renewal') session.runtime!.checkpoint.at = laterCheckpoint;
      await store.save(session); const loaded = await store.load(sessionId, owner); assert.ok(loaded);
      if (id === 'checkpoint-resave-no-renewal') {
        runtime.checkpointSession(loaded, 'viewed-and-saved', laterCheckpoint);
        loaded.updatedAt = new Date(clockMs + 550_000).toISOString(); await store.save(loaded);
      }
      const reloaded = await store.load(sessionId, owner); assert.ok(reloaded);
      const beforeSha256 = sha(await readFile(file));
      if (id === 'checkpoint-fallback-boundaries') {
        const boundaries = [];
        for (const delta of [599_999, 600_000, 600_001]) {
          const outcome = await capture(() => runtime.restoreLogicalSession(reloaded, owner, Date.parse(laterCheckpoint) + delta));
          assert.equal(outcome.status, delta > 600_000 ? 'rejected' : 'returned'); boundaries.push({ deltaMs: delta, outcome });
        }
        observations = { checkpoint: reloaded.runtime!.checkpoint, boundaries, originalBytesUnchanged: sha(await readFile(file)) === beforeSha256 };
      } else {
        assert.equal(reloaded.runtime!.checkpoint.disconnectedAt, clock); assert.equal(reloaded.runtime!.checkpoint.at, laterCheckpoint);
        const outcome = await capture(() => runtime.restoreLogicalSession(reloaded, owner, clockMs + 600_001)); assert.equal(outcome.status, 'rejected');
        observations = { checkpoint: reloaded.runtime!.checkpoint, updatedAt: reloaded.updatedAt, outcome, originalBytesUnchanged: sha(await readFile(file)) === beforeSha256 };
      }
    } else if (id.startsWith('recovery-') || id === 'completed-after-window') {
      const offset = id === 'recovery-future-clock' ? -1 : id === 'completed-after-window' ? 6_000_000 : id === 'recovery-other-owner' ? 1 : Number(id.slice('recovery-'.length));
      if (id === 'completed-after-window') session.status = 'completed';
      await store.save(session); const beforeSha256 = sha(await readFile(file)), loaded = await store.load(sessionId, owner); assert.ok(loaded);
      const requestedOwner = id === 'recovery-other-owner' ? 'another-owner' : owner;
      const outcome = await capture(() => { runtime.assertRecoverableSession(loaded, requestedOwner, clockMs + offset); return runtime.restoreLogicalSession(loaded, requestedOwner, clockMs + offset); });
      assert.equal(outcome.status, ['recovery-600001', 'recovery-future-clock', 'recovery-other-owner'].includes(id) ? 'rejected' : 'returned');
      observations = { outcome, offsetMs: offset, originalBytesUnchanged: sha(await readFile(file)) === beforeSha256 };
    } else if (id === 'invalid-session-identifiers') observations = { load: await capture(() => store.load('../escape', owner)), save: await capture(() => store.save({ ...session, id: '../escape' })), uppercaseSave: await capture(() => store.save({ ...session, id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' })) };
    assert.equal(providerCalls, 0);
    cases.push({ id, observations, providerCalls, events, files: await inventory(root) });
  } finally { Object.assign(nativeFs, io); globalThis.fetch = originalFetch; syncBuiltinESMExports(); }
}
assert.equal(sha(await readFile(sourceFile)), sourceSha256);
const report = { version: 'pr06c-independent-session-store-cases-v1', sourceSha256, fixtureSha256, controlledClock: clock, privateDataUsed: false,
  realProviderCalls: 0, nativeWriterEventsAndFileBytesRetained: true, failedTemporaryFilesPreservedAsBefore: true, cases };
await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, sourceSha256, fixtureSha256, cases: cases.length, realProviderCalls: 0 }));
