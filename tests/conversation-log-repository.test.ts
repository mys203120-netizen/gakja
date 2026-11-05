import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationLogger } from '../server/storage/conversation-log';
import { createLocalConversationLogRepository, type ConversationLogFileSystem } from '../server/repositories/local-conversation-log-repository';

const sessionId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const event = (eventId: string) => ({ eventId, type: 'phase.changed', actor: 'server' as const, payload: { phase: 'synthetic' } });
const gate = () => { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; };
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'pr06c-log-repository-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('pr06c-log-repository-')); await rm(root, { recursive: true, force: true }); });
  return { root, directory: path.join(root, 'data/conversation-logs'), file: (id = sessionId) => path.join(root, 'data/conversation-logs', `${id}.jsonl`) };
}
type Handle = Awaited<ReturnType<typeof open>>;
function observedOpen(events: string[], overrides: Partial<Pick<Handle, 'writeFile' | 'chmod' | 'sync'>> = {}): typeof open {
  return async (file, flags, mode) => {
    events.push(`open:${flags}:${mode ?? ''}`); const handle = await open(file, flags, mode);
    return {
      async chmod(value: Parameters<Handle['chmod']>[0]) { events.push(`chmod:${value}`); if (overrides.chmod) await overrides.chmod(value); else await handle.chmod(value); },
      async writeFile(value: Parameters<Handle['writeFile']>[0]) { events.push('write'); if (overrides.writeFile) await overrides.writeFile(value); else await handle.writeFile(value); },
      async sync() { events.push('sync'); if (overrides.sync) await overrides.sync(); else await handle.sync(); },
      async close() { events.push('close'); await handle.close(); },
    } as unknown as Handle;
  };
}

test('actual log adapter preserves mkdir/load/open/chmod/write/close and explicit flush sync ordering', async t => {
  const h = await fixture(t), events: string[] = [];
  const io: Partial<ConversationLogFileSystem> = {
    mkdir: (async (file, options) => { events.push(`mkdir:${JSON.stringify(options)}`); return mkdir(file, options); }) as typeof mkdir,
    readFile: (async (...args: Parameters<typeof readFile>) => { events.push('read'); return readFile(...args); }) as typeof readFile,
    open: observedOpen(events),
  };
  const repository = createLocalConversationLogRepository(h.root, { io }), logger = new ConversationLogger({ repository });
  assert.deepEqual(await logger.append(sessionId, event('first')), { ok: true, eventId: 'first', seq: 1 });
  await logger.flush(sessionId);
  assert.deepEqual(events, ['mkdir:{"recursive":true,"mode":448}', 'read', 'open:a:384', 'chmod:384', 'write', 'close', 'open:r+:', 'sync', 'close']);
  const rows = (await readFile(h.file(), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows[0].eventId, 'first'); assert.equal(rows[0].seq, 1); assert.equal(rows[0].schemaVersion, 1);
});

test('separate adapters/loggers for one physical file retain global serialization and version-aware duplicate detection', { timeout: 5000 }, async t => {
  const h = await fixture(t), entered = gate(), release = gate(); let opened = 0;
  const firstRepository = createLocalConversationLogRepository(h.root, { io: { open: async (...args) => {
    opened++; const handle = await open(...args);
    return { async chmod(mode: number) { await handle.chmod(mode); }, async writeFile(value: string) { entered.release(); await release.promise; await handle.writeFile(value); }, async close() { await handle.close(); } } as unknown as Handle;
  } } });
  const secondRepository = createLocalConversationLogRepository(h.root, { io: { open: async (...args) => { opened++; return open(...args); } } });
  const first = new ConversationLogger({ repository: firstRepository }), second = new ConversationLogger({ repository: secondRepository });
  const a = first.append(sessionId, event('shared-first')); await entered.promise;
  const b = second.append(sessionId, event('shared-second'));
  try {
    await Promise.resolve(); assert.equal(opened, 1); release.release();
    assert.deepEqual((await Promise.all([a, b])).map(row => row.seq), [1, 2]);
    assert.deepEqual(await first.append(sessionId, event('shared-second')), { ok: true, eventId: 'shared-second', seq: 2, duplicate: true });
    assert.deepEqual((await readFile(h.file(), 'utf8')).trim().split('\n').map(line => JSON.parse(line).seq), [1, 2]);
  } finally { release.release(); await Promise.all([a, b]); }
});

test('different physical directories with the same session ID do not share a blocked append queue', { timeout: 5000 }, async t => {
  const h = await fixture(t), entered = gate(), release = gate();
  const blocked = createLocalConversationLogRepository(h.root, { directory: path.join(h.root, 'first'), io: { open: async (...args) => {
    const handle = await open(...args);
    return { async chmod(mode: number) { await handle.chmod(mode); }, async writeFile(value: string) { entered.release(); await release.promise; await handle.writeFile(value); }, async close() { await handle.close(); } } as unknown as Handle;
  } } });
  const first = new ConversationLogger({ repository: blocked }), second = new ConversationLogger({ repository: createLocalConversationLogRepository(h.root, { directory: path.join(h.root, 'second') }) });
  const a = first.append(sessionId, event('independent-first')); await entered.promise;
  try { assert.equal((await second.append(sessionId, event('independent-second'))).seq, 1); }
  finally { release.release(); await a; }
  assert.equal(JSON.parse((await readFile(path.join(h.root, 'first', `${sessionId}.jsonl`), 'utf8')).trim()).eventId, 'independent-first');
  assert.equal(JSON.parse((await readFile(path.join(h.root, 'second', `${sessionId}.jsonl`), 'utf8')).trim()).eventId, 'independent-second');
});

test('partial append failure closes its handle, stays optional, retains old bytes and reloads malformed tail on retry', async t => {
  const h = await fixture(t), events: string[] = []; let fail = true;
  const error = Object.assign(new Error('synthetic-partial-log-write'), { code: 'EIO' });
  const repository = createLocalConversationLogRepository(h.root, { io: { open: async (...args) => {
    const handle = await open(...args);
    return { async chmod(mode: number) { await handle.chmod(mode); }, async writeFile(value: string) { if (fail) { fail = false; await handle.writeFile('{"partial":'); throw error; } await handle.writeFile(value); }, async close() { events.push('close'); await handle.close(); } } as unknown as Handle;
  } } });
  const logger = new ConversationLogger({ repository });
  const failed = await logger.append(sessionId, event('retryable-event'));
  assert.equal(failed.ok, false); assert.equal(failed.error?.code, 'EIO'); assert.deepEqual(events, ['close']);
  assert.equal(logger.getStatus()[0].queued, 0); assert.equal(logger.getStatus()[0].failedCount, 1);
  assert.equal(await readFile(h.file(), 'utf8'), '{"partial":');
  const retry = await logger.append(sessionId, event('retryable-event')); assert.equal(retry.ok, true); assert.equal(retry.seq, 1);
  assert.ok((await readFile(h.file(), 'utf8')).startsWith('{"partial":\n'));
  assert.equal(logger.getStatus()[0].malformedLines, 1); assert.equal(logger.getStatus()[0].available, true);
});

test('chmod and flush sync failures close handles and return existing optional diagnostics', async t => {
  const h = await fixture(t), events: string[] = []; let failChmod = true, failSync = true;
  const repository = createLocalConversationLogRepository(h.root, { io: { open: observedOpen(events, {
    async chmod() { if (failChmod) { failChmod = false; throw Object.assign(new Error('synthetic-chmod-denied'), { code: 'EACCES' }); } },
    async sync() { if (failSync) { failSync = false; throw Object.assign(new Error('synthetic-sync-failed'), { code: 'EIO' }); } },
  }) } });
  const logger = new ConversationLogger({ repository });
  const denied = await logger.append(sessionId, event('same-event')); assert.equal(denied.ok, false); assert.equal(denied.error?.code, 'EACCES');
  assert.deepEqual(events, ['open:a:384', 'chmod:384', 'close']);
  assert.equal((await logger.append(sessionId, event('same-event'))).seq, 1);
  const status = await logger.flush(sessionId); assert.equal(status[0].available, false); assert.equal(status[0].lastError?.code, 'EIO');
  assert.deepEqual(events.slice(-3), ['open:r+:', 'sync', 'close']);
});

test('log scope/path validation happens before local I/O; session files and counters remain separate', async t => {
  const h = await fixture(t); let reads = 0;
  const repository = createLocalConversationLogRepository(h.root, { io: { readFile: (async (...args: Parameters<typeof readFile>) => { reads++; return readFile(...args); }) as typeof readFile } });
  assert.throws(() => new ConversationLogger({ repository, ownerId: 'explicit-wrong-owner' }), /OWNER_MISMATCH/);
  await assert.rejects(repository.read({ ownerId: 'explicit-wrong-owner', sessionId }), /OWNER_MISMATCH/);
  await assert.rejects(repository.read({ ownerId: repository.ownerId, sessionId: '../escape' }), /SESSION_INVALID/);
  assert.equal(reads, 0);
  const logger = new ConversationLogger({ repository });
  assert.equal((await logger.append('../escape', event('invalid'))).error?.code, 'INVALID_LOG_EVENT'); assert.equal(reads, 0);
  assert.equal((await logger.append(sessionId, event('same-event'))).seq, 1);
  assert.equal((await logger.append(otherId, event('same-event'))).seq, 1);
  assert.equal(JSON.parse((await readFile(h.file(otherId), 'utf8')).trim()).sessionId, otherId);
  assert.equal(logger.getStatus().length, 2);
});
