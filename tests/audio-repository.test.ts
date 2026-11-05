import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emptyAudioScope } from '../server/repositories/audio-ports';
import { createLocalAudioRepository, type LocalAudioFileSystem } from '../server/repositories/local-audio-repository';
import { SpeechAudioCache } from '../server/providers/speech-audio-cache';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'pr06b-audio-repository-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('pr06b-audio-repository-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, directory: path.join(root, 'data/audio'), file: (id: string) => path.join(root, 'data/audio', `${id}.mp3`) };
}
function trace() {
  const events: { operation: string; file: string; options?: unknown; destination?: string }[] = [];
  const io: Partial<LocalAudioFileSystem> = {
    mkdir: (async (file, options) => { events.push({ operation: 'mkdir', file: String(file), options }); return mkdir(file, options); }) as typeof mkdir,
    writeFile: async (file, bytes, options) => { events.push({ operation: 'write', file: String(file), options }); await writeFile(file, bytes, options); },
    rename: async (file, destination) => { events.push({ operation: 'rename', file: String(file), destination: String(destination) }); await rename(file, destination); },
    unlink: async file => { events.push({ operation: 'unlink', file: String(file) }); await unlink(file); },
  };
  return { events, io };
}

test('local audio writers preserve the distinct plain-cache and bank-atomic operation order and exact bytes', async t => {
  const h = await fixture(t), cacheTrace = trace(), bankTrace = trace(), id = 'a'.repeat(64), bytes = Buffer.from('synthetic-audio-byte-identity');
  const cache = createLocalAudioRepository(h.root, { io: cacheTrace.io });
  await cache.publish({ id, bytes, scope: emptyAudioScope(cache.ownerId), purpose: 'speech-cache', publication: 'speech-cache' });
  assert.deepEqual(cacheTrace.events, [
    { operation: 'mkdir', file: h.directory, options: { recursive: true } },
    { operation: 'write', file: h.file(id), options: { mode: 0o600 } },
  ]);
  const bank = createLocalAudioRepository(h.root, { io: bankTrace.io, temporaryId: () => 'synthetic-publication' });
  await bank.publish({ id, bytes, scope: { ...emptyAudioScope(bank.ownerId), bankKey: 'b'.repeat(64) }, purpose: 'question-bank-preparation', publication: 'bank-atomic' });
  assert.deepEqual(bankTrace.events, [
    { operation: 'mkdir', file: h.directory, options: { recursive: true, mode: 0o700 } },
    { operation: 'write', file: `${h.file(id)}.synthetic-publication.tmp`, options: { mode: 0o600, flag: 'wx' } },
    { operation: 'rename', file: `${h.file(id)}.synthetic-publication.tmp`, destination: h.file(id) },
    { operation: 'unlink', file: `${h.file(id)}.synthetic-publication.tmp` },
  ]);
  assert.deepEqual(await bank.read({ id, scope: emptyAudioScope(bank.ownerId), purpose: 'question-bank-validation' }), bytes);
  assert.deepEqual(await readdir(h.directory), [`${id}.mp3`]);
});

test('bank rename failure preserves the old complete audio, cleans its temporary file and retries only when the caller requests it', async t => {
  const h = await fixture(t), id = 'b'.repeat(64), old = Buffer.from('old-complete-audio'), next = Buffer.from('new-complete-audio');
  await mkdir(h.directory, { recursive: true }); await writeFile(h.file(id), old);
  const error = Object.assign(new Error('explicit-synthetic-rename-denied'), { code: 'EPERM' });
  let attempts = 0;
  const repository = createLocalAudioRepository(h.root, { temporaryId: () => 'rename-failure', io: { rename: async () => { attempts++; throw error; } } });
  const request = { id, bytes: next, scope: emptyAudioScope(repository.ownerId), purpose: 'question-bank-preparation' as const, publication: 'bank-atomic' as const };
  await assert.rejects(repository.publish(request), value => value === error);
  assert.equal(attempts, 1, 'the original bank writer has no Windows retry policy');
  assert.deepEqual(await readFile(h.file(id)), old); assert.deepEqual(await readdir(h.directory), [`${id}.mp3`]);
  await createLocalAudioRepository(h.root).publish(request);
  assert.deepEqual(await readFile(h.file(id)), next);
});

test('bank temporary-write failure never publishes incomplete bytes and retains the original error', async t => {
  const h = await fixture(t), id = 'c'.repeat(64), old = Buffer.from('complete-before-write-failure');
  await mkdir(h.directory, { recursive: true }); await writeFile(h.file(id), old);
  const error = Object.assign(new Error('explicit-synthetic-disk-full'), { code: 'ENOSPC' });
  let renames = 0, cleanups = 0;
  const repository = createLocalAudioRepository(h.root, { temporaryId: () => 'write-failure', io: {
    writeFile: async (file, bytes) => { await writeFile(file, Buffer.from(bytes as Uint8Array).subarray(0, 3)); throw error; },
    rename: async () => { renames++; },
    unlink: async file => { cleanups++; await unlink(file); },
  } });
  await assert.rejects(repository.publish({ id, bytes: Buffer.from('unpublished-incomplete-audio'), scope: emptyAudioScope(repository.ownerId), purpose: 'question-bank-preparation', publication: 'bank-atomic' }), value => value === error);
  assert.equal(renames, 0); assert.equal(cleanups, 1);
  assert.deepEqual(await readFile(h.file(id)), old); assert.deepEqual(await readdir(h.directory), [`${id}.mp3`]);
});

test('bank cleanup failures preserve the original publication error and leave only an uncommitted temporary orphan', async t => {
  const h = await fixture(t), id = 'd'.repeat(64), error = new Error('synthetic-primary-rename-failure');
  const repository = createLocalAudioRepository(h.root, { temporaryId: () => 'orphan', io: {
    rename: async () => { throw error; }, unlink: async () => { throw new Error('synthetic-secondary-cleanup-failure'); },
  } });
  await assert.rejects(repository.publish({ id, bytes: Buffer.from('uncommitted-audio'), scope: emptyAudioScope(repository.ownerId), purpose: 'question-bank-preparation', publication: 'bank-atomic' }), value => value === error);
  await assert.rejects(repository.read({ id, scope: emptyAudioScope(repository.ownerId), purpose: 'question-bank-validation' }), { code: 'ENOENT' });
  assert.deepEqual(await readdir(h.directory), [`${id}.mp3.orphan.tmp`]);
});

test('cache persistence failure keeps RAM readiness and rejects durable publication through the actual local writer', async t => {
  const h = await fixture(t), id = 'e'.repeat(64), bytes = Buffer.from('memory-survives-disk-failure');
  let writes = 0, warnings = 0;
  t.mock.method(console, 'warn', () => { warnings++; });
  const repository = createLocalAudioRepository(h.root, { io: { writeFile: async () => { writes++; throw Object.assign(new Error('synthetic-cache-disk-full'), { code: 'ENOSPC' }); } } });
  const cache = new SpeechAudioCache(repository);
  assert.equal(await cache.getOrCreate(id, async () => bytes), `/api/audio/${id}`); await cache.flushWrites();
  assert.equal(writes, 1); assert.equal(warnings, 1); assert.deepEqual(await cache.read(id), bytes);
  assert.equal(await cache.readDurable(id), null); assert.equal(await new SpeechAudioCache(createLocalAudioRepository(h.root)).read(id), null);
});

test('accepted audio continues its existing background write after caller cancellation, while durable reads wait for it', async t => {
  const h = await fixture(t), id = 'f'.repeat(64), bytes = Buffer.from('accepted-before-caller-cancel');
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const repository = createLocalAudioRepository(h.root, { io: { writeFile: async (file, value, options) => { enter(); await gate; await writeFile(file, value, options); } } });
  const cache = new SpeechAudioCache(repository), controller = new AbortController();
  try {
    assert.equal(await cache.getOrCreate(id, async () => bytes, { signal: controller.signal }), `/api/audio/${id}`);
    await entered; controller.abort(); assert.deepEqual(await cache.read(id), bytes);
    let durableResolved = false;
    const durable = cache.readDurable(id).then(value => { durableResolved = true; return value; });
    await Promise.resolve(); assert.equal(durableResolved, false); release();
    assert.deepEqual(await durable, bytes); assert.deepEqual(await readFile(h.file(id)), bytes);
  } finally { release(); await cache.flushWrites(); }
});

test('repository scope/key checks precede filesystem access and synthesis; missing raw reads retain ENOENT', async t => {
  const h = await fixture(t), id = '1'.repeat(64); let reads = 0, writes = 0;
  const repository = createLocalAudioRepository(h.root, { io: {
    readFile: (async (...args: Parameters<typeof readFile>) => { reads++; return readFile(...args); }) as typeof readFile,
    writeFile: async () => { writes++; },
  } });
  const scope = emptyAudioScope(repository.ownerId);
  await assert.rejects(repository.read({ id, scope: { ...scope, ownerId: 'explicit-wrong-owner' }, purpose: 'audio-serving' }), /OWNER_MISMATCH/);
  await assert.rejects(repository.publish({ id, bytes: Buffer.from('unwanted'), scope: { ...scope, ownerId: 'explicit-wrong-owner' }, purpose: 'speech-cache', publication: 'speech-cache' }), /OWNER_MISMATCH/);
  await assert.rejects(repository.read({ id: '../outside', scope, purpose: 'audio-serving' }), /ID_INVALID/);
  assert.throws(() => new SpeechAudioCache(repository, undefined, undefined, undefined, { scope: { ownerId: 'explicit-wrong-owner' } }), /OWNER_MISMATCH/);
  assert.equal(reads, 0); assert.equal(writes, 0);
  await assert.rejects(repository.read({ id, scope, purpose: 'audio-serving' }), { code: 'ENOENT' }); assert.equal(reads, 1);
});
