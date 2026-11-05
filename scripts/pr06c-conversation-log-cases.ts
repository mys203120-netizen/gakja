/** Independent old/new logger execution. Only anonymous owned fixture files are
 * written; production modules are selected exclusively by --source-root. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ConversationEvent } from '../server/storage/conversation-log';

const flags = new Map(process.argv.slice(2).map(value => {
  const match = /^--(source-root|output|reopen-root)=(.+)$/u.exec(value);
  if (!match) throw new Error('PR06C_LOG_FLAGS_INVALID'); return [match[1], match[2]];
}));
assert.ok(flags.has('source-root'));
const sourceRoot = path.resolve(flags.get('source-root')!), sourceFile = path.join(sourceRoot, 'server/storage/conversation-log.ts');
const fixtureFile = fileURLToPath(import.meta.url), hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sourceSha256 = hash(await readFile(sourceFile)), fixtureSha256 = hash(await readFile(fixtureFile));
const { ConversationLogger } = await import(pathToFileURL(sourceFile).href) as typeof import('../server/storage/conversation-log');
const nativeFs = createRequire(import.meta.url)('node:fs/promises');
const io = Object.fromEntries(['mkdir', 'readFile', 'open'].map(key => [key, nativeFs[key]]));
const clock = '2026-11-06T12:00:00.000Z', NativeDate = Date;
class FixedDate extends NativeDate { constructor(value?: string | number) { super(value ?? clock); } static now() { return NativeDate.parse(clock); } }
globalThis.Date = FixedDate as DateConstructor;
const session = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const event = (eventId: string): ConversationEvent => ({ eventId, type: 'phase.changed', actor: 'server', payload: { phase: 'anonymous-synthetic' } });
const gate = () => { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; };
type Operation = { op: string; file: string; flags?: unknown; mode?: unknown; sha256?: string; bytes?: number; error?: string };
function instrument(root: string) {
  const events: Operation[] = [], entered = gate(), release = gate();
  let fault: string | null = null, hold = false;
  const owned = (file: unknown) => typeof file === 'string' && !path.relative(root, path.resolve(file)).startsWith('..') && !path.isAbsolute(path.relative(root, path.resolve(file)));
  const fail = (operation: string) => { if (fault === operation) { fault = null; throw Object.assign(new Error('EXPLICIT_SYNTHETIC_LOG_FAILURE'), { code: operation === 'mkdir' || operation === 'read' || operation === 'chmod' ? 'EACCES' : 'EIO' }); } };
  const observe = async <T>(row: Operation, run: () => Promise<T>) => {
    events.push(row); try { return await run(); } catch (error) { row.error = (error as NodeJS.ErrnoException).code ?? (error as Error).name; throw error; }
  };
  nativeFs.mkdir = async (...args: unknown[]) => owned(args[0]) ? observe({ op: 'mkdir', file: path.relative(root, String(args[0])).replaceAll('\\', '/'), mode: args[1] }, async () => { fail('mkdir'); return io.mkdir(...args); }) : io.mkdir(...args);
  nativeFs.readFile = async (...args: unknown[]) => owned(args[0]) ? observe({ op: 'read', file: path.relative(root, String(args[0])).replaceAll('\\', '/') }, async () => { fail('read'); return io.readFile(...args); }) : io.readFile(...args);
  nativeFs.open = async (...args: unknown[]) => {
    if (!owned(args[0])) return io.open(...args);
    const file = path.relative(root, String(args[0])).replaceAll('\\', '/');
    const handle = await observe({ op: 'open', file, flags: args[1], mode: args[2] }, async () => { fail('open'); return io.open(...args); });
    return {
      async chmod(mode: number) { return observe({ op: 'chmod', file, mode }, async () => { fail('chmod'); await handle.chmod(mode); }); },
      async writeFile(text: string) {
        return observe({ op: 'write', file, sha256: hash(text), bytes: Buffer.byteLength(text) }, async () => {
          if (hold) { hold = false; entered.release(); await release.promise; }
          if (fault === 'partial-write') { fault = null; await handle.writeFile('{"partial":'); throw Object.assign(new Error('EXPLICIT_SYNTHETIC_PARTIAL_LOG_WRITE'), { code: 'EIO' }); }
          fail('write'); await handle.writeFile(text);
        });
      },
      async sync() { return observe({ op: 'sync', file }, async () => { fail('sync'); await handle.sync(); }); },
      async close() { return observe({ op: 'close', file }, async () => { await handle.close(); fail('close'); }); },
    };
  };
  syncBuiltinESMExports();
  return { events, entered, release, fault: (value: string) => { fault = value; }, hold: () => { hold = true; },
    restore: () => { release.release(); for (const [key, value] of Object.entries(io)) nativeFs[key] = value; syncBuiltinESMExports(); } };
}
async function files(root: string) {
  const rows: { file: string; utf8: string; sha256: string }[] = [];
  async function walk(directory: string) {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await walk(file);
      else { const bytes = await io.readFile(file); rows.push({ file: path.relative(root, file).replaceAll('\\', '/'), utf8: bytes.toString('utf8'), sha256: hash(bytes) }); }
    }
  }
  await walk(root); return rows;
}

if (flags.has('reopen-root')) {
  const root = path.resolve(flags.get('reopen-root')!); assert.ok(path.basename(root).startsWith('owned-'));
  const hooks = instrument(root);
  try {
    const logger = new ConversationLogger({ directory: path.join(root, 'logs'), environment: {} });
    const duplicate = await logger.append(session, event('before-process-restart'));
    const next = await logger.append(session, event('after-process-restart'));
    const status = await logger.flush();
    console.log(JSON.stringify({ duplicate, next, status, events: hooks.events, files: await files(root), freshProcess: true }));
  } finally { hooks.restore(); globalThis.Date = NativeDate; }
} else {
  assert.ok(flags.has('output')); const output = path.resolve(flags.get('output')!);
  const base = path.join(path.dirname(output), 'conversation-log-case-roots'); await mkdir(base, { recursive: true });
  const cases = [];
  for (const id of ['shared-file-instances', 'different-directories', 'different-sessions', 'valid-tail-no-newline', 'malformed-foreign-tail', 'redaction-and-invalid-events', 'mkdir-failure', 'read-failure', 'open-failure', 'chmod-failure', 'partial-write-failure', 'close-failure', 'flush-sync-failure', 'new-process-reopen']) {
    const root = await mkdtemp(path.join(base, 'owned-')), directory = path.join(root, 'logs'), file = path.join(directory, `${session}.jsonl`);
    if (id === 'valid-tail-no-newline' || id === 'malformed-foreign-tail') {
      await io.mkdir(directory, { recursive: true });
      const valid = JSON.stringify({ schemaVersion: 1, sessionId: session, seq: 7, eventId: 'old-event', type: 'phase.changed', actor: 'server', timestamp: clock });
      const content = id === 'valid-tail-no-newline' ? valid : `${valid}\ninvalid\n${JSON.stringify({ sessionId: other, seq: 99, eventId: 'foreign' })}\n{"unfinished":`;
      await writeFile(file, content);
    }
    const hooks = instrument(root), logger = new ConversationLogger({ directory, environment: { SYNTHETIC_API_KEY: 'explicit-synthetic-secret' } });
    const observations: Record<string, unknown> = {};
    try {
      if (id === 'shared-file-instances') {
        const second = new ConversationLogger({ directory, environment: {} }); hooks.hold();
        const first = logger.append(session, event('event-0')); await hooks.entered.promise;
        const pending = Array.from({ length: 9 }, (_, index) => (index % 2 ? logger : second).append(session, event(`event-${index + 1}`)));
        hooks.release.release(); observations.replies = await Promise.all([first, ...pending]);
        observations.duplicate = await logger.append(session, event('event-9')); observations.secondStatus = second.getStatus();
      }
      if (id === 'different-directories') {
        const second = new ConversationLogger({ directory: path.join(root, 'separate'), environment: {} }); hooks.hold();
        const blocked = logger.append(session, event('first-directory')); await hooks.entered.promise;
        observations.second = await second.append(session, event('second-directory')); hooks.release.release(); observations.first = await blocked;
        observations.secondStatus = await second.flush();
      }
      if (id === 'different-sessions') observations.replies = [await logger.append(session, event('same-event')), await logger.append(other, event('same-event'))];
      if (id === 'valid-tail-no-newline') observations.replies = [await logger.append(session, event('old-event')), await logger.append(session, event('new-event'))];
      if (id === 'malformed-foreign-tail') observations.reply = await logger.append(session, event('after-malformed'));
      if (id === 'redaction-and-invalid-events') {
        const circular: Record<string, unknown> = {}; circular.self = circular;
        observations.reply = await logger.append(session, { ...event('redacted'), payload: { text: 'explicit-synthetic-secret Bearer synthetic-token', accessToken: 'hidden', inputTokens: 12, binary: Buffer.from('synthetic-binary'), bigint: 12n, circular, error: Object.assign(new Error('synthetic safe message'), { apiKey: 'hidden-key' }) } });
        const unsafe = Object.defineProperty({}, 'nested', { enumerable: true, get() { throw new Error('EXPLICIT_SYNTHETIC_SERIALIZATION_FAILURE'); } });
        observations.invalid = [await logger.append('../invalid', event('invalid-session')), await logger.append(session, { ...event('invalid-type'), type: 'invalid type' }), await logger.append(session, { ...event('invalid-id'), eventId: 'invalid id' }), await logger.append(session, { ...event('serialization-failure'), payload: unsafe })];
      }
      if (['mkdir-failure', 'read-failure', 'open-failure', 'chmod-failure', 'partial-write-failure', 'close-failure'].includes(id)) {
        hooks.fault(id === 'partial-write-failure' ? 'partial-write' : id.replace('-failure', ''));
        observations.failed = await logger.append(session, event('retryable-event')); observations.failedStatus = logger.getStatus();
        observations.retry = await logger.append(session, event('retryable-event'));
      }
      if (id === 'flush-sync-failure') {
        observations.first = await logger.append(session, event('before-sync')); hooks.fault('sync'); observations.failedFlush = await logger.flush(); observations.skippedFlush = await logger.flush();
        observations.next = await logger.append(session, event('after-sync-failure'));
      }
      if (id === 'new-process-reopen') {
        observations.first = await logger.append(session, event('before-process-restart')); observations.beforeRestart = await logger.flush();
        const loader = pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href;
        const child = await promisify(execFile)(process.execPath, ['--import', loader, fixtureFile, `--source-root=${sourceRoot}`, `--reopen-root=${root}`], { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 });
        observations.reopened = JSON.parse(child.stdout);
      }
      observations.status = await logger.flush();
      cases.push({ id, observations, actualIoEvents: hooks.events, finalFiles: await files(root) });
    } finally { hooks.restore(); }
  }
  globalThis.Date = NativeDate;
  assert.equal(hash(await readFile(sourceFile)), sourceSha256); assert.equal(hash(await readFile(fixtureFile)), fixtureSha256);
  const report = { version: 'pr06c-independent-conversation-log-cases-v1', sourceRoot, sourceSha256, fixtureSha256, controlledClock: clock,
    clockPolicy: 'fixed Date for existing event timestamps; explicit event IDs; no log event sort/drop', actualProviderCalls: 0, cases };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, cases: cases.length, actualProviderCalls: 0, sourceUnchanged: true, fixtureUnchanged: true }));
}
