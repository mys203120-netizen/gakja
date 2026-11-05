/** Execute real independent SpeechAudioCache implementations with synthetic
 * providers and actual isolated default filesystem writers. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setImmediate as tick } from 'node:timers/promises';

const flags = new Map(process.argv.slice(2).map(value => { const match = /^--(source-root|output|uncontrolled-keys)=(.+)$/u.exec(value); if (!match) throw new Error('PR06B_AUDIO_FLAGS_INVALID'); return [match[1], match[2]]; }));
if (!flags.has('source-root') || !flags.has('output')) throw new Error('PR06B_AUDIO_ROOT_OUTPUT_REQUIRED');
const sourceRoot = path.resolve(flags.get('source-root')!), output = path.resolve(flags.get('output')!);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sourceFile = path.join(sourceRoot, 'server/providers/speech-audio-cache.ts'), sourceShaBefore = sha(await readFile(sourceFile));
const { SpeechAudioCache } = await import(pathToFileURL(sourceFile).href) as typeof import('../server/providers/speech-audio-cache');
const nativeFs = createRequire(import.meta.url)('node:fs/promises');
const ioKeys = ['mkdir', 'writeFile', 'rename', 'unlink']; const io = Object.fromEntries(ioKeys.map(key => [key, nativeFs[key]]));
const base = path.join(path.dirname(output), 'audio-case-roots'); await mkdir(base, { recursive: true });
const gate = () => { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; };
const audio = Buffer.from('explicit-synthetic-complete-audio-bytes'), fresh = Buffer.from('explicit-synthetic-retry-audio-bytes');
type Event = { op: string; file: string; sha256?: string; bytes?: number; mode?: number; flag?: string; error?: string };
const results = [];
for (const name of ['hit-memory-disk', 'same-key-sharing', 'different-key-sharing', 'one-subscriber-cancel', 'all-subscribers-cancel', 'pre-aborted-hits', 'late-result-cannot-overwrite-retry', 'persist-error-memory-survives', 'cancel-after-ready-during-persistence', 'empty-disk-miss', 'nonempty-corrupt-disk-hit', 'durable-ram-disk-mismatch', 'bounded-memory-eviction', 'shared-provider-failure-retry', 'invalid-id', 'empty-provider-result', 'partial-write-failure']) {
  const root = await mkdtemp(path.join(base, 'owned-')), directory = path.join(root, 'audio'), id = sha(name), other = sha(name + ':other');
  const events: Event[] = [], warnings: string[] = []; let writeFault: 'once' | 'partial' | null = null, writeHold: ReturnType<typeof gate> | null = null;
  const writeEntered = gate(), originalWarn = console.warn; console.warn = (...args) => { warnings.push(sha(args.map(String).join(' '))); };
  for (const key of ioKeys) nativeFs[key] = async (...args: unknown[]) => {
    const file = typeof args[0] === 'string' ? args[0] : '';
    if (!path.relative(root, path.resolve(file)).startsWith('..')) {
      const options = (key === 'writeFile' ? args[2] : args[1]) as { mode?: number; flag?: string } | undefined;
      const event: Event = { op: key, file: path.relative(root, file).replaceAll('\\', '/'), ...(key === 'writeFile' ? { sha256: sha(Buffer.from(args[1] as Buffer)), bytes: Buffer.byteLength(args[1] as Buffer) } : {}), ...(options && typeof options === 'object' ? { mode: options.mode, flag: options.flag } : {}) }; events.push(event);
      if (key === 'writeFile') { writeEntered.release(); if (writeHold) await writeHold.promise; if (writeFault) { const fault = writeFault; writeFault = null; if (fault === 'partial') await io.writeFile(file, Buffer.from(args[1] as Buffer).subarray(0, 3), args[2]); event.error = 'EIO'; throw Object.assign(new Error('EXPLICIT_SYNTHETIC_AUDIO_WRITE_FAILURE'), { code: 'EIO' }); } }
    }
    return io[key](...args);
  };
  syncBuiltinESMExports();
  const cache = new SpeechAudioCache(directory), timing: { cache: string; providerMsNull: boolean; boundsValid: boolean }[] = [];
  const observe = { onTiming: (row: { cache: string; providerMs: number | null; durationMs: number }) => timing.push({ cache: row.cache, providerMsNull: row.providerMs === null, boundsValid: Number.isFinite(row.durationMs) && row.durationMs >= 0 && (row.providerMs === null || Number.isFinite(row.providerMs) && row.providerMs >= 0) }) };
  let providerCalls = 0; const provider = async () => { providerCalls++; return audio; }; let details: Record<string, unknown> = {};
  try {
    if (name === 'hit-memory-disk') { await cache.getOrCreate(id, provider, observe); await cache.flushWrites(); await cache.getOrCreate(id, provider, observe); const disk = new SpeechAudioCache(directory); await disk.getOrCreate(id, provider, observe); details = { readSha256: sha((await disk.read(id))!), durableSha256: sha((await disk.readDurable(id))!) }; }
    if (name === 'same-key-sharing') {
      const entered = gate(), release = gate(); let active = 0;
      const load = async () => { providerCalls++; active++; if (active === (name === 'same-key-sharing' ? 1 : 2)) entered.release(); await release.promise; return audio; };
      const a = cache.getOrCreate(id, load, observe), b = cache.getOrCreate(name === 'same-key-sharing' ? id : other, load, observe); await entered.promise; release.release(); details = { urls: await Promise.all([a, b]) };
    }
    if (name === 'different-key-sharing') {
      const entered = gate(), releaseFirst = gate(), releaseSecond = gate(); let enteredCount = 0;
      const load = (release: ReturnType<typeof gate>) => async () => { providerCalls++; enteredCount++; if (enteredCount === 2) entered.release(); await release.promise; return audio; };
      const a = cache.getOrCreate(id, load(releaseFirst), observe), b = cache.getOrCreate(other, load(releaseSecond), observe);
      await entered.promise; const concurrentProducersBeforeRelease = enteredCount;
      // Both producers are already active. Control fixture release/commit order
      // rather than sorting away the OS-dependent inter-key writer interleaving.
      if (flags.get('uncontrolled-keys') === 'true') { releaseFirst.release(); releaseSecond.release(); details = { urls: await Promise.all([a, b]) }; }
      else { releaseFirst.release(); await a; await cache.flushWrites(); releaseSecond.release(); details = { urls: await Promise.all([a, b]), concurrentProducersBeforeRelease, controlledReleaseOrder: 'first-key-commit-before-second-key-release' }; }
    }
    if (name === 'one-subscriber-cancel' || name === 'all-subscribers-cancel') {
      const a = new AbortController(), b = new AbortController(), entered = gate(), release = gate(); let signal!: AbortSignal;
      const load = async (value: AbortSignal) => { providerCalls++; signal = value; entered.release(); await release.promise; return audio; };
      const outcomes = Promise.allSettled([cache.getOrCreate(id, load, { ...observe, signal: a.signal }), cache.getOrCreate(id, load, { ...observe, signal: b.signal })]);
      await entered.promise; a.abort(); const survivingProducerAbortedAfterFirst = signal.aborted; if (name === 'all-subscribers-cancel') b.abort(); const producerAbortedBeforeRelease = signal.aborted; release.release();
      details = { outcomes: (await outcomes).map(row => row.status === 'fulfilled' ? 'fulfilled' : row.reason.name), survivingProducerAbortedAfterFirst, producerAbortedBeforeRelease }; await tick();
    }
    if (name === 'pre-aborted-hits') { await cache.getOrCreate(id, provider); await cache.flushWrites(); const c = new AbortController(); c.abort(); const outcomes = await Promise.allSettled([cache.getOrCreate(id, provider, { ...observe, signal: c.signal }), new SpeechAudioCache(directory).getOrCreate(id, provider, { ...observe, signal: c.signal })]); details = { outcomes: outcomes.map(row => row.status === 'rejected' ? row.reason.name : row.status) }; }
    if (name === 'late-result-cannot-overwrite-retry') {
      const c = new AbortController(), entered = gate(), release = gate(); let abandoned!: AbortSignal;
      const first = cache.getOrCreate(id, async signal => { providerCalls++; abandoned = signal; entered.release(); await release.promise; return audio; }, { signal: c.signal }); const settled = Promise.allSettled([first]); await entered.promise; c.abort(); await settled;
      await cache.getOrCreate(id, async () => { providerCalls++; return fresh; }); release.release(); await tick(); await cache.flushWrites(); details = { abandonedAborted: abandoned.aborted, readSha256: sha((await cache.read(id))!), durableSha256: sha((await cache.readDurable(id))!) };
    }
    if (name === 'persist-error-memory-survives' || name === 'partial-write-failure') {
      writeFault = name === 'partial-write-failure' ? 'partial' : 'once'; await cache.getOrCreate(id, provider, observe); await cache.flushWrites();
      details = { readyReadSha256: sha((await cache.read(id))!), durableNull: await cache.readDurable(id) === null };
      const reopened = new SpeechAudioCache(directory); await reopened.getOrCreate(id, async () => { providerCalls++; return fresh; }, observe); await reopened.flushWrites(); details.reopenedReadSha256 = sha((await reopened.read(id))!);
      if (name === 'partial-write-failure') details.legacyPartialNonemptyDiskAcceptedOnReopen = providerCalls === 1;
    }
    if (name === 'cancel-after-ready-during-persistence') {
      writeHold = gate(); const c = new AbortController(); await cache.getOrCreate(id, provider, { ...observe, signal: c.signal }); await writeEntered.promise; c.abort();
      let resolved = false; const durable = cache.readDurable(id).then(value => { resolved = true; return value; }); await Promise.resolve(); details = { playbackReadyBeforeDisk: Boolean((await cache.read(id))?.equals(audio)), durablePendingBeforeRelease: !resolved };
      writeHold.release(); details.durableSha256 = sha((await durable)!);
    }
    if (name === 'empty-disk-miss' || name === 'nonempty-corrupt-disk-hit') { await io.mkdir(directory, { recursive: true }); await io.writeFile(path.join(directory, id + '.mp3'), name === 'empty-disk-miss' ? Buffer.alloc(0) : Buffer.from('corrupt-but-nonempty')); await cache.getOrCreate(id, provider, observe); details = { readSha256: sha((await cache.read(id))!), legacyNonemptyDiskNotContentVerified: name === 'nonempty-corrupt-disk-hit' }; }
    if (name === 'durable-ram-disk-mismatch') { await cache.getOrCreate(id, provider); await cache.flushWrites(); await io.writeFile(path.join(directory, id + '.mp3'), Buffer.from('corrupt-but-nonempty')); details = { playbackMemorySha256: sha((await cache.read(id))!), durableNull: await cache.readDurable(id) === null, reopenedCorruptReadSha256: sha((await new SpeechAudioCache(directory).read(id))!) }; }
    if (name === 'bounded-memory-eviction') { const bounded = new SpeechAudioCache(directory, 6, 2); await bounded.getOrCreate(id, async () => { providerCalls++; return Buffer.from('aaaa'); }); await bounded.getOrCreate(other, async () => { providerCalls++; return Buffer.from('bbbb'); }); await bounded.flushWrites(); await io.unlink(path.join(directory, id + '.mp3')); details = { evictedMissingReadNull: await bounded.read(id) === null, retainedSha256: sha((await bounded.read(other))!) }; }
    if (name === 'shared-provider-failure-retry') { const entered = gate(), release = gate(), error = new Error('EXPLICIT_SYNTHETIC_PROVIDER_FAILURE'); const load = async () => { providerCalls++; entered.release(); await release.promise; throw error; }; const outcomes = Promise.allSettled([cache.getOrCreate(id, load), cache.getOrCreate(id, load)]); await entered.promise; release.release(); details = { originalErrorObjectPreservedForBoth: (await outcomes).every(row => row.status === 'rejected' && row.reason === error) }; await cache.getOrCreate(id, provider, observe); }
    if (name === 'invalid-id') { details = { readNull: await cache.read('../invalid') === null, durableNull: await cache.readDurable('../invalid') === null }; const outcome = await Promise.allSettled([cache.getOrCreate('../invalid', provider)]); details.rejected = outcome[0].status === 'rejected'; }
    if (name === 'empty-provider-result') { const outcome = await Promise.allSettled([cache.getOrCreate(id, async () => { providerCalls++; return Buffer.alloc(0); })]); details = { rejected: outcome[0].status === 'rejected', readableNull: await cache.read(id) === null }; await cache.getOrCreate(id, provider, observe); }
    await cache.flushWrites();
    const files = []; try { for (const file of (await readdir(directory)).sort()) { const bytes = await readFile(path.join(directory, file)); files.push({ file, bytes: bytes.length, sha256: sha(bytes) }); } } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    assert.ok(timing.every(row => row.boundsValid)); results.push({ name, providerCalls, timing, details, writerEvents: events, warningHashes: warnings, files });
  } finally { writeHold?.release(); await cache.flushWrites(); for (const [key, value] of Object.entries(io)) nativeFs[key] = value; console.warn = originalWarn; syncBuiltinESMExports(); }
}
assert.equal(sha(await readFile(sourceFile)), sourceShaBefore);
const report = { version: 'pr06b-independent-audio-cache-cases-v1', sourceRoot, sourceSha256: sourceShaBefore, dependencyReuse: true, freshInstall: false, actualProviderCalls: 0,
  media: 'synthetic bytes; actual cache orchestration/default local filesystem writer', timingComparison: 'cache categories/nullability/nonnegative finite bounds only; wall timings are not domain bytes', cases: results };
await writeFile(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ output, cases: results.length, findings: results.filter(row => row.name.includes('partial') || row.name.includes('corrupt')).map(row => ({ name: row.name, providerCalls: row.providerCalls, details: row.details })) }, null, 2));
