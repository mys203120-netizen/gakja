/** Actual independent job stores with controlled domain UUID/clock inputs.
 * Native PID is retained as relational evidence only for short-lock metadata. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { InterviewSession } from '../server/protocol';
import type { EvaluationJobFileOptions } from '../server/evaluation-job-store';

const flags = new Map(process.argv.slice(2).map(argument => { const match = /^--(source-root|output|child-root|job-id)=(.+)$/u.exec(argument); if (!match) throw new Error('PR06D_JOB_FLAGS_INVALID'); return [match[1], match[2]]; }));
if (!flags.has('source-root') || !flags.has('output') && !flags.has('child-root')) throw new Error('PR06D_JOB_ROOT_OUTPUT_REQUIRED');
const sourceRoot = path.resolve(flags.get('source-root')!), sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex'), jsonSha = (value: unknown) => sha(JSON.stringify(value));
const nativeCrypto = createRequire(import.meta.url)('node:crypto') as typeof import('node:crypto'), originalUuid = nativeCrypto.randomUUID;
const NativeDate = Date, nativeTimeout = globalThis.setTimeout, nativePid = process.pid, clock = '2026-11-06T00:00:00.000Z', initialNow = Date.parse(clock);
let now = initialNow, uuidCounter = 0;
class ControlledDate extends NativeDate { constructor(value?: string | number) { super(value === undefined ? now : value); } static now() { return now; } }
nativeCrypto.randomUUID = (() => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`) as typeof nativeCrypto.randomUUID;
globalThis.Date = ControlledDate as DateConstructor; syncBuiltinESMExports();
const sourceFile = path.join(sourceRoot, 'server/evaluation-job-store.ts'), sourceSha256 = sha(await readFile(sourceFile));
const api = await import(pathToFileURL(sourceFile).href) as typeof import('../server/evaluation-job-store');
const create = (root: string, io?: EvaluationJobFileOptions) => typeof api.createLocalEvaluationJobStore === 'function' ? api.createLocalEvaluationJobStore(root, io) : new api.EvaluationJobStore(path.join(root, 'data/evaluation-jobs'), io);
if (flags.has('child-root')) {
  const store = create(path.resolve(flags.get('child-root')!)), job = await store.get(flags.get('job-id')!); assert.ok(job);
  console.log(JSON.stringify({ pid: nativePid, job, snapshot: await store.snapshot(job), result: await store.result(job) })); process.exit(0);
}
const output = path.resolve(flags.get('output')!), base = path.join(path.dirname(output), 'job-case-roots'); await mkdir(base, { recursive: true });
const session = { id: '11111111-1111-4111-8111-111111111111', createdAt: clock, updatedAt: clock, status: 'ending', evaluationStatus: 'pending', turns: [], elapsedMs: 123,
  followUpCountByMainQuestion: {}, target: { studentName: '명시적 합성 학생' }, sourceManifest: { explicitSynthetic: true },
  runtime: { version: 'session-runtime-v1', owner: { id: 'explicit-synthetic-job-owner', mode: 'local-development' }, engineVersion: 'synthetic-policy', contextSnapshotSha256: 'a'.repeat(64), epoch: 0,
    checkpoint: { phase: 'ending', at: clock, turnId: null, answerId: null }, operations: {}, acceptedEndRequest: { elapsedMs: 123, metrics: { original: true } }, evaluationInputFrozenAt: clock },
} as unknown as InterviewSession;
const source = 'b'.repeat(64), pipeline = 'explicit-synthetic-pipeline', model = 'explicit-synthetic-model', result = { sessionScore: null, held: ['synthetic F'], original: '🙂 정확한 합성 결과', nullable: null };
const fixtureSha256 = jsonSha({ session, source, pipeline, model, result, clock });
const nativeFs = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
const io = { mkdir: nativeFs.mkdir, writeFile: nativeFs.writeFile, rename: nativeFs.rename, unlink: nativeFs.unlink, open: nativeFs.open };
type Event = { operation: string; path: string; outcome: string; destination?: string; mode?: number; flag?: string; bytes?: number; sha256?: string; pidProjection?: boolean };
const nativePidEvidence: Array<{ caseId: string; path: string; rawJson: string; rawBytes: number; rawSha256: string; projectedSha256: string }> = [];
const gate = () => { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; };
const cases: Array<Record<string, unknown>> = [];
for (const id of ['roundtrip-idempotency', 'new-process-completed-read', 'lease-renew-takeover', 'retry-review-lifecycle', 'controlled-concurrent-claim', 'snapshot-tamper', 'result-tamper', 'corrupt-queue-quarantine',
  'windows-EPERM', 'windows-EACCES', 'windows-EBUSY', 'windows-seven-failures', 'permanent-EIO', 'snapshot-write-failure', 'job-write-failure', 'result-write-failure', 'completion-job-write-failure',
  'invalid-lock', 'expired-live-lock', 'expired-dead-lock', 'invalid-job-id']) {
  const root = await mkdtemp(path.join(base, 'owned-')), store = create(root), events: Event[] = [], timerDelays: number[] = [];
  now = initialNow; uuidCounter = 0;
  let fault: { kind: string; delivered: boolean } | null = null, closeHold: { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate>; used: boolean } | null = null;
  const normalizePath = (file: string) => {
    const relative = path.relative(root, path.resolve(file)); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    return relative.replaceAll('\\', '/').replace(/\.(\d+)\.([a-f0-9-]+)\.tmp$/iu, (_all, pid: string, uuid: string) => { assert.equal(Number(pid), nativePid); assert.match(uuid, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu); return `.<native-pid>.${uuid}.tmp`; });
  };
  const projectedBytes = (file: string, data: string | Buffer) => {
    const bytes = Buffer.from(data);
    if (!file.endsWith('.lock.json')) return { bytes, projected: false };
    let body: { pid?: number };
    try { body = JSON.parse(bytes.toString('utf8')); } catch { return { bytes, projected: false }; }
    if (body.pid !== nativePid) return { bytes, projected: false };
    const projected = Buffer.from(JSON.stringify({ ...body, pid: '<native-process-pid>' }));
    nativePidEvidence.push({ caseId: id, path: normalizePath(file), rawJson: bytes.toString('utf8'), rawBytes: bytes.length, rawSha256: sha(bytes), projectedSha256: sha(projected) });
    return { bytes: projected, projected: true };
  };
  const observe = async (operation: 'mkdir' | 'writeFile' | 'rename' | 'unlink', args: unknown[]) => {
    const file = String(args[0]), options = (operation === 'writeFile' ? args[2] : args[1]) as { mode?: number; flag?: string } | undefined;
    const bytes = operation === 'writeFile' ? projectedBytes(file, args[1] as string | Buffer) : null;
    const event: Event = { operation, path: normalizePath(file), outcome: 'pending', ...(operation === 'rename' ? { destination: normalizePath(String(args[1])) } : {}),
      ...(options && typeof options === 'object' ? { mode: options.mode, flag: options.flag } : {}), ...(bytes ? { bytes: bytes.bytes.length, sha256: sha(bytes.bytes), pidProjection: bytes.projected } : {}) }; events.push(event);
    try {
      if (fault && !fault.delivered && operation === 'writeFile' && file.includes(`.${fault.kind}.json.`)) { fault.delivered = true; throw Object.assign(new Error('EXPLICIT_SYNTHETIC_DOCUMENT_WRITE_FAILURE'), { code: 'ENOSPC' }); }
      const value = await (io[operation] as (...values: unknown[]) => Promise<unknown>)(...args); event.outcome = 'ok'; return value;
    } catch (error) { event.outcome = (error as NodeJS.ErrnoException).code ?? (error as Error).name; throw error; }
  };
  nativeFs.mkdir = ((...args: unknown[]) => observe('mkdir', args)) as typeof nativeFs.mkdir;
  nativeFs.writeFile = ((...args: unknown[]) => observe('writeFile', args)) as typeof nativeFs.writeFile;
  nativeFs.rename = ((...args: unknown[]) => observe('rename', args)) as typeof nativeFs.rename;
  nativeFs.unlink = ((...args: unknown[]) => observe('unlink', args)) as typeof nativeFs.unlink;
  nativeFs.open = (async (...args: Parameters<typeof io.open>) => {
    const file = String(args[0]), event: Event = { operation: 'open', path: normalizePath(file), flag: String(args[1]), mode: Number(args[2]), outcome: 'pending' }; events.push(event);
    try {
      const handle = await io.open(...args); event.outcome = 'ok';
      return new Proxy(handle, { get(target, key) {
        if (key === 'writeFile') return async (data: string | Buffer) => { const bytes = projectedBytes(file, data); const row: Event = { operation: 'handle.writeFile', path: normalizePath(file), bytes: bytes.bytes.length, sha256: sha(bytes.bytes), pidProjection: bytes.projected, outcome: 'pending' }; events.push(row); try { const value = await target.writeFile(data); row.outcome = 'ok'; return value; } catch (error) { row.outcome = (error as Error).name; throw error; } };
        if (key === 'close') return async () => { if (closeHold && !closeHold.used) { closeHold.used = true; closeHold.entered.release(); await closeHold.release.promise; } const row: Event = { operation: 'handle.close', path: normalizePath(file), outcome: 'pending' }; events.push(row); await target.close(); row.outcome = 'ok'; };
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
    } catch (error) { event.outcome = (error as NodeJS.ErrnoException).code ?? (error as Error).name; throw error; }
  }) as typeof nativeFs.open;
  globalThis.setTimeout = ((callback: (...values: unknown[]) => void, milliseconds = 0, ...args: unknown[]) => { timerDelays.push(milliseconds); return nativeTimeout(() => { now += milliseconds; callback(...args); }, 0); }) as typeof globalThis.setTimeout;
  syncBuiltinESMExports();
  const capture = async (job: () => unknown) => { try { return { status: 'returned', value: await job() }; } catch (error) { const value = error as Error & { code?: string }; return { status: 'rejected', name: value.name, code: value.code ?? (/^[A-Z0-9_]+$/u.test(value.message) ? value.message : null), messageSha256: sha(value.message.replaceAll(root, '<owned-root>')) }; } };
  const enqueue = () => store.enqueue(session, source, pipeline, initialNow, model);
  async function inventory() {
    const rows: Array<{ path: string; sha256: string; bytes: number; pidProjection: boolean }> = [];
    async function walk(directory: string) { for (const entry of await readdir(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) await walk(file); else { const bytes = projectedBytes(file, await readFile(file)); rows.push({ path: normalizePath(file), sha256: sha(bytes.bytes), bytes: bytes.bytes.length, pidProjection: bytes.projected }); } } }
    await walk(root); return rows.sort((left, right) => left.path.localeCompare(right.path));
  }
  let observations: Record<string, unknown> = {};
  try {
    if (id === 'invalid-job-id') observations = { get: await capture(() => store.get('../escape')), claim: await capture(() => store.claim('../escape', 'worker', now)), pending: await store.pending(now) };
    else if (id === 'snapshot-write-failure' || id === 'job-write-failure') {
      fault = { kind: id.startsWith('snapshot') ? 'snapshot' : 'job', delivered: false };
      const first = await capture(enqueue), firstFiles = await inventory(), pendingAfterFailure = await store.pending(now);
      observations = { first, firstFiles, pendingAfterFailure, faultDelivered: fault.delivered, resumed: await enqueue() };
    } else {
      const job = await enqueue(), jobFile = path.join(store.directory, `${job.id}.job.json`), lockFile = path.join(store.directory, `${job.id}.lock.json`);
      if (id === 'roundtrip-idempotency') { const duplicate = await enqueue(), claimed = await store.claim(job.id, 'worker-A', now, 1000); assert.ok(claimed?.lease); const completed = await store.complete(job.id, claimed.lease.token, result); observations = { job, duplicate, snapshot: await store.snapshot(job), completed, result: await store.result(completed), pending: await store.pending(now) }; }
      if (id === 'new-process-completed-read') {
        const claimed = await store.claim(job.id, 'worker-A', now, 1000); assert.ok(claimed?.lease); const completed = await store.complete(job.id, claimed.lease.token, result);
        const text = await new Promise<string>((resolve, reject) => { const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), `--source-root=${sourceRoot}`, `--child-root=${root}`, `--job-id=${job.id}`], { cwd: process.cwd(), windowsHide: true }); let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); }); child.on('error', reject); child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error('PR06D_CHILD_FAILED:' + sha(stderr)))); });
        const { pid, ...reopened } = JSON.parse(text); assert.notEqual(pid, nativePid); assert.deepEqual(reopened.job, completed); observations = { reopened, separateProcess: true };
      }
      if (id === 'lease-renew-takeover') { const claimed = await store.claim(job.id, 'worker-A', now, 500); assert.ok(claimed?.lease); const renewed = await store.renew(job.id, claimed.lease.token, now + 300, 500), pendingBeforeExpiry = await store.pending(now + 501), takeover = await store.claim(job.id, 'worker-B', now + 801, 500); assert.ok(takeover?.lease); observations = { claimed, renewed, pendingBeforeExpiry, takeover, staleComplete: await capture(() => store.complete(job.id, claimed.lease!.token, result)), completed: await store.complete(job.id, takeover.lease.token, result) }; }
      if (id === 'retry-review-lifecycle') { const claimed = await store.claim(job.id, 'worker-A', now, 500); assert.ok(claimed?.lease); const failed = await store.fail(job.id, claimed.lease.token, { code: 'SYNTHETIC_TRANSIENT', message: '합성', retryable: true }, now); const early = await store.pending(now + 1999), due = await store.pending(now + 2000), retried = await store.claim(job.id, 'worker-B', now + 2000, 500); assert.ok(retried?.lease); const terminal = await store.fail(job.id, retried.lease.token, { code: 'SYNTHETIC_FINAL', message: '합성', retryable: false }, now); const explicit = await store.retry(job.id), claimedAgain = await store.claim(job.id, 'worker-C', now, 500); assert.ok(claimedAgain?.lease); observations = { failed, early, due, terminal, explicit, parked: await store.requireReview(job.id, claimedAgain.lease.token, ['NO_B', 'HELD_F', 'NO_B']) }; }
      if (id === 'controlled-concurrent-claim') {
        closeHold = { entered: gate(), release: gate(), used: false };
        const secondStore = create(root, { readLockFile: async file => { closeHold!.release.release(); await firstPromise; return readFile(file, 'utf8'); } });
        const firstPromise = store.claim(job.id, 'worker-A', now, 1000); await closeHold.entered.promise;
        const second = await secondStore.claim(job.id, 'worker-B', now, 1000), first = await firstPromise;
        assert.ok(first?.lease); assert.equal(second, null); observations = { first, second, stored: await store.get(job.id) };
      }
      if (id === 'snapshot-tamper') { const file = path.join(store.directory, `${job.id}.snapshot.json`), payload = JSON.parse(await readFile(file, 'utf8')); payload.session.elapsedMs++; await io.writeFile(file, JSON.stringify(payload)); observations = { snapshot: await capture(() => store.snapshot(job)) }; }
      if (id === 'result-tamper') { const claimed = await store.claim(job.id, 'worker-A', now, 1000); assert.ok(claimed?.lease); const completed = await store.complete(job.id, claimed.lease.token, result), file = path.join(store.directory, `${job.id}.result.json`), payload = JSON.parse(await readFile(file, 'utf8')); payload.evaluation.original = 'changed'; await io.writeFile(file, JSON.stringify(payload)); observations = { result: await capture(() => store.result(completed)) }; }
      if (id === 'corrupt-queue-quarantine') { const damaged = Buffer.from('{explicit synthetic broken job'); await io.writeFile(jobFile, damaged); observations = { pending: await store.pending(now), rawPreserved: sha(await readFile(jobFile)) === sha(damaged), diagnostic: JSON.parse(await readFile(path.join(store.directory, `${job.id}.quarantine.json`), 'utf8')), pendingAgain: await store.pending(now) }; }
      if (id.startsWith('windows-') || id === 'permanent-EIO') {
        const code = id === 'permanent-EIO' ? 'EIO' : id === 'windows-seven-failures' ? 'EPERM' : id.slice(8), attempts: Array<{ sha256: string; outcome: string }> = [];
        const denied = create(root, { replaceFile: async (from, to) => { const event = { sha256: sha(await readFile(from)), outcome: 'pending' }; attempts.push(event); if (id === 'windows-seven-failures' || code === 'EIO' || attempts.length <= 6) { event.outcome = code; throw Object.assign(new Error('EXPLICIT_SYNTHETIC_REPLACE_FAILURE'), { code }); } await nativeFs.rename(from, to); event.outcome = 'ok'; } });
        observations = { claim: await capture(() => denied.claim(job.id, 'worker-A', now, 1000)), attempts, stored: await store.get(job.id) }; assert.equal(attempts.length, code === 'EIO' ? 1 : 7); assert.deepEqual(timerDelays, code === 'EIO' ? [] : [10, 25, 50, 100, 150, 200]);
      }
      if (id === 'result-write-failure' || id === 'completion-job-write-failure') { const claimed = await store.claim(job.id, 'worker-A', now, 500); assert.ok(claimed?.lease); fault = { kind: id.startsWith('result') ? 'result' : 'job', delivered: false }; const first = await capture(() => store.complete(job.id, claimed.lease!.token, result)), after = await store.get(job.id); observations = { first, after, unexposedResult: await store.result(after!), faultDelivered: fault.delivered, resumed: await store.complete(job.id, claimed.lease.token, result) }; }
      if (id === 'invalid-lock' || id === 'expired-live-lock' || id === 'expired-dead-lock') {
        const deadPid = 2_147_483_647; if (id === 'expired-dead-lock') assert.throws(() => process.kill(deadPid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
        await io.writeFile(lockFile, id === 'invalid-lock' ? '{broken lock' : JSON.stringify({ token: 'explicit-synthetic-existing-lock', pid: id === 'expired-live-lock' ? nativePid : deadPid, expiresAt: now - 1 }));
        const before = projectedBytes(lockFile, await readFile(lockFile)); const outcome = await capture(() => store.claim(job.id, 'worker-A', now, 500));
        observations = { outcome, existingLockProjectionSha256: sha(before.bytes), stored: await store.get(job.id) };
      }
    }
    cases.push({ id, observations, timerDelays, uuidCalls: uuidCounter, events, files: await inventory() });
  } finally { Object.assign(nativeFs, io); globalThis.setTimeout = nativeTimeout; syncBuiltinESMExports(); }
}
assert.equal(sha(await readFile(sourceFile)), sourceSha256);
globalThis.Date = NativeDate; nativeCrypto.randomUUID = originalUuid; syncBuiltinESMExports();
const report = { version: 'pr06d-independent-job-cases-v1', sourceSha256, fixtureSha256, controlledClock: clock, controlledUuid: 'valid v4 sequential synthetic input',
  nativePid, nativePidEvidence, pidComparison: 'Only validated native PID spelling in short-lock metadata and temporary filenames is relationally projected; full raw lock bytes retained above. All domain and non-lock file bytes are unmodified.', privateDataUsed: false, realProviderCalls: 0, cases };
await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, sourceSha256, fixtureSha256, cases: cases.length, nativePid, realProviderCalls: 0 }));
