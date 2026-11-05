import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SpeechAudioCache, type SpeechSynthesisTiming } from "../server/providers/speech-audio-cache";

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "each-answer-audio-test-"));
  return { directory, clean: async () => { assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith("each-answer-audio-test-")); await rm(directory, { recursive: true, force: true }); } };
}
test("concurrent audio requests share one synthesis and real bytes are immediately readable from RAM", async () => {
  const { directory, clean } = await fixture(); const cache = new SpeechAudioCache(directory);
  try {
    const id = "a".repeat(64), timings: SpeechSynthesisTiming[] = [];
    let calls = 0, release!: () => void, entered!: () => void;
    const providerEntered = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const load = async () => { calls++; entered(); await gate; return Buffer.from("actual-test-audio"); };
    const first = cache.getOrCreate(id, load, { onTiming: event => { timings.push(event); } });
    const second = cache.getOrCreate(id, load, { onTiming: event => { timings.push(event); } });
    await providerEntered; assert.equal(calls, 1); release();
    assert.deepEqual(await Promise.all([first, second]), [`/api/audio/${id}`, `/api/audio/${id}`]);
    assert.deepEqual(await cache.read(id), Buffer.from("actual-test-audio"));
    assert.deepEqual(timings.map(item => item.cache).sort(), ["provider", "shared"]);
    assert.ok(timings.every(item => item.durationMs >= 0));
    assert.equal(timings.find(item => item.cache === "shared")?.providerMs, null);
    await cache.getOrCreate(id, load, { onTiming: event => { timings.push(event); } });
    assert.equal(timings.at(-1)?.cache, "memory"); assert.equal(calls, 1);
  } finally { await cache.flushWrites(); await clean(); }
});
test("persisted audio is reusable after a fresh process cache, without another provider call", async () => {
  const { directory, clean } = await fixture(); const first = new SpeechAudioCache(directory);
  try {
    const id = "b".repeat(64); await first.getOrCreate(id, async () => Buffer.from("disk-audio")); await first.flushWrites();
    const fresh = new SpeechAudioCache(directory); let providerCalls = 0; let observed: SpeechSynthesisTiming | null = null;
    await fresh.getOrCreate(id, async () => { providerCalls++; return Buffer.from("unexpected"); }, { onTiming: event => { observed = event; } });
    assert.equal(providerCalls, 0); assert.equal((observed as SpeechSynthesisTiming | null)?.cache, "disk");
    assert.deepEqual(await fresh.read(id), Buffer.from("disk-audio"));
    assert.equal(await fresh.read("../../secret"), null);
  } finally { await first.flushWrites(); await clean(); }
});
test("failed synthesis is retryable, observers cannot break playback, and RAM eviction is bounded", async () => {
  const { directory, clean } = await fixture(); const cache = new SpeechAudioCache(directory, 6, 2);
  try {
    const a = "c".repeat(64), b = "d".repeat(64);
    await assert.rejects(cache.getOrCreate(a, async () => { throw new Error("provider unavailable"); }));
    await cache.getOrCreate(a, async () => Buffer.from("aaaa"), { onTiming: () => { throw new Error("observer failure"); } });
    await cache.getOrCreate(b, async () => Buffer.from("bbbb")); await cache.flushWrites();
    await unlink(path.join(directory, `${a}.mp3`));
    assert.equal(await cache.read(a), null); assert.deepEqual(await cache.read(b), Buffer.from("bbbb"));
  } finally { await cache.flushWrites(); await clean(); }
});

test("RAM-ready playback stays immediate while offline bank audio waits for the actual delayed disk write", async () => {
  const { directory, clean } = await fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), persistenceEntered = new Promise<void>(resolve => { entered = resolve; });
  const cache = new SpeechAudioCache(directory, 32 * 1024 * 1024, 192, async (file, bytes) => { entered(); await gate; await writeFile(file, bytes); });
  const id = 'e'.repeat(64), bytes = Buffer.from('explicit-synthetic-delayed-disk-audio');
  try {
    await cache.getOrCreate(id, async () => bytes); await persistenceEntered;
    assert.deepEqual(await cache.read(id), bytes, 'real-time playback is already ready from RAM');
    await assert.rejects(readFile(path.join(directory, `${id}.mp3`)), { code: 'ENOENT' });
    let durableResolved = false;
    const durable = cache.readDurable(id).then(bytes => { durableResolved = true; return bytes; });
    await Promise.resolve(); assert.equal(durableResolved, false, 'offline publication must not mistake memory readiness for durable audio');
    release(); assert.deepEqual(await durable, bytes);
    assert.deepEqual(await readFile(path.join(directory, `${id}.mp3`)), bytes);
    const fresh = new SpeechAudioCache(directory);
    assert.deepEqual(await fresh.readDurable(id), bytes, 'a fresh cache/process can read the same published bytes');
    assert.equal(await fresh.readDurable('../../outside'), null);
  } finally { release(); await cache.flushWrites(); await clean(); }
});

test('canceling one subscriber leaves the shared provider and surviving subscriber intact', async () => {
  const { directory, clean } = await fixture(), cache = new SpeechAudioCache(directory);
  const firstController = new AbortController(), secondController = new AbortController(), id = '1'.repeat(64);
  let entered!: () => void, release!: () => void, producerSignal!: AbortSignal, calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const load = async (signal: AbortSignal) => { producerSignal = signal; calls++; entered(); await gate; return Buffer.from('shared-survivor-audio'); };
  const timings: SpeechSynthesisTiming[] = [];
  try {
    const first = cache.getOrCreate(id, load, { signal: firstController.signal, onTiming: value => timings.push(value) });
    const rejected = assert.rejects(first, { name: 'AbortError' });
    const second = cache.getOrCreate(id, load, { signal: secondController.signal, onTiming: value => timings.push(value) });
    await started; firstController.abort(); await rejected;
    assert.notEqual(producerSignal, firstController.signal); assert.notEqual(producerSignal, secondController.signal);
    assert.equal(producerSignal.aborted, false); assert.equal(calls, 1);
    release(); assert.equal(await second, `/api/audio/${id}`);
    assert.deepEqual(await cache.read(id), Buffer.from('shared-survivor-audio'));
    assert.deepEqual(timings.map(value => value.cache), ['shared'], 'A canceled caller cannot report successful readiness.');
  } finally { release(); await cache.flushWrites(); await clean(); }
});

test('a subscriber deadline does not cancel a longer-lived joiner', async () => {
  const { directory, clean } = await fixture(), cache = new SpeechAudioCache(directory), id = '2'.repeat(64);
  let release!: () => void, entered!: () => void, producerSignal!: AbortSignal;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const load = async (signal: AbortSignal) => { producerSignal = signal; entered(); await gate; return Buffer.from('deadline-survivor'); };
  try {
    const expired = cache.getOrCreate(id, load, { signal: AbortSignal.timeout(5) });
    const rejected = assert.rejects(expired, { name: 'TimeoutError' });
    const survivor = cache.getOrCreate(id, load);
    await started; await new Promise(resolve => setTimeout(resolve, 15)); await rejected;
    assert.equal(producerSignal.aborted, false); release(); assert.equal(await survivor, `/api/audio/${id}`);
  } finally { release(); await cache.flushWrites(); await clean(); }
});

test('last subscriber cancellation aborts the producer and ignores late provider bytes without a cache write', async () => {
  const { directory, clean } = await fixture(); let writes = 0;
  const cache = new SpeechAudioCache(directory, 1024, 10, async () => { writes++; });
  const a = new AbortController(), b = new AbortController(), id = '3'.repeat(64);
  let release!: () => void, entered!: () => void, producerSignal!: AbortSignal;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const load = async (signal: AbortSignal) => { producerSignal = signal; entered(); await gate; return Buffer.from('late-ignored-audio'); };
  try {
    const first = cache.getOrCreate(id, load, { signal: a.signal }), second = cache.getOrCreate(id, load, { signal: b.signal });
    const rejected = Promise.all([assert.rejects(first, { name: 'AbortError' }), assert.rejects(second, { name: 'AbortError' })]);
    await started; a.abort(); assert.equal(producerSignal.aborted, false); b.abort(); assert.equal(producerSignal.aborted, true); await rejected;
    release(); await new Promise(resolve => setImmediate(resolve)); await cache.flushWrites();
    assert.equal(await cache.read(id), null); assert.equal(await cache.readDurable(id), null); assert.equal(writes, 0);
  } finally { release(); await cache.flushWrites(); await clean(); }
});

test('retry after cancellation starts a new producer and an abandoned late result cannot overwrite it', async () => {
  const { directory, clean } = await fixture(), cache = new SpeechAudioCache(directory), id = '4'.repeat(64), controller = new AbortController();
  let release!: () => void, entered!: () => void, oldSignal!: AbortSignal, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  try {
    const first = cache.getOrCreate(id, async signal => { oldSignal = signal; calls++; entered(); await gate; return Buffer.from('stale-audio'); }, { signal: controller.signal });
    const rejected = assert.rejects(first, { name: 'AbortError' }); await started; controller.abort(); await rejected; assert.equal(oldSignal.aborted, true);
    assert.equal(await cache.getOrCreate(id, async signal => { calls++; assert.equal(signal.aborted, false); return Buffer.from('retry-audio'); }), `/api/audio/${id}`);
    release(); await new Promise(resolve => setImmediate(resolve)); await cache.flushWrites();
    assert.equal(calls, 2); assert.deepEqual(await cache.read(id), Buffer.from('retry-audio'));
    assert.deepEqual(await cache.readDurable(id), Buffer.from('retry-audio'));
  } finally { release(); await cache.flushWrites(); await clean(); }
});

test('already aborted callers cannot receive memory or disk cache hits or start a new synthesis', async () => {
  const { directory, clean } = await fixture(), cache = new SpeechAudioCache(directory), id = '5'.repeat(64);
  let calls = 0, timingCalls = 0;
  const controller = new AbortController(), reason = new DOMException('Synthetic expired caller', 'TimeoutError'); controller.abort(reason);
  try {
    await cache.getOrCreate(id, async () => Buffer.from('existing-audio')); await cache.flushWrites();
    for (const candidate of [cache, new SpeechAudioCache(directory)]) {
      await assert.rejects(candidate.getOrCreate(id, async () => { calls++; return Buffer.from('unwanted'); }, { signal: controller.signal, onTiming: () => { timingCalls++; } }), error => error === reason);
    }
    await assert.rejects(cache.getOrCreate('6'.repeat(64), async () => { calls++; return Buffer.from('unwanted'); }, { signal: controller.signal }), error => error === reason);
    assert.equal(calls, 0); assert.equal(timingCalls, 0); assert.deepEqual(await cache.read(id), Buffer.from('existing-audio'));
  } finally { await cache.flushWrites(); await clean(); }
});

test('a shared provider error rejects all active subscribers and remains retryable with legacy no-options calls', async () => {
  const { directory, clean } = await fixture(), cache = new SpeechAudioCache(directory), id = '7'.repeat(64);
  let entered!: () => void, release!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const error = new Error('Synthetic provider failure');
  const load = async () => { calls++; entered(); await gate; throw error; };
  try {
    const first = cache.getOrCreate(id, load), second = cache.getOrCreate(id, load);
    const rejected = Promise.all([assert.rejects(first, value => value === error), assert.rejects(second, value => value === error)]);
    await started; release(); await rejected; assert.equal(calls, 1);
    await cache.getOrCreate(id, async () => { calls++; return Buffer.from('recovered-audio'); }); assert.equal(calls, 2);
    assert.deepEqual(await cache.read(id), Buffer.from('recovered-audio'));
  } finally { release(); await cache.flushWrites(); await clean(); }
});
