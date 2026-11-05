/** Run the real public CLOVA/cache/storage chain in an isolated child process.
 * Fetch is synthetic; source-root selects independent BEFORE or AFTER modules. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SpeechSynthesisTiming } from '../../server/providers/speech-audio-cache';

const flags = new Map(process.argv.slice(2).map(argument => {
  const match = /^--(source-root|mode)=(.+)$/u.exec(argument);
  if (!match) throw new Error('SYNTHETIC_AUDIO_CALLER_ARGUMENT_INVALID');
  return [match[1], match[2]];
}));
assert.ok(flags.has('source-root'));
assert.ok(path.basename(process.cwd()).startsWith('pr06b-clova-'), 'Synthetic writes require the owned temporary directory.');
const sourceRoot = path.resolve(flags.get('source-root')!);
const mode = flags.get('mode') ?? 'generate';
assert.ok(mode === 'generate' || mode === 'reopen');
const speech = await import(pathToFileURL(path.join(sourceRoot, 'server/providers/clova-tts.ts')).href) as typeof import('../../server/providers/clova-tts');
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const settings = { speaker: 'vdaeseong', speed: 0, pitch: 1, volume: 0, format: 'mp3' as const };
const text = '익명 합성 사례에서 자료를 비교한 과정을 설명해 주세요.';
const otherText = '익명 합성 사례에서 자료를 선택한 기준을 설명해 주세요.';
const id = speech.speechAudioCacheId(text, settings), otherId = speech.speechAudioCacheId(otherText, settings);
let fetchCount = 0, signalAborted = false, release!: () => void, entered!: () => void;
const gate = new Promise<void>(resolve => { release = resolve; });
const started = new Promise<void>(resolve => { entered = resolve; });
const timings: Record<string, SpeechSynthesisTiming> = {};
const binary = (value: string) => Buffer.from(`explicit-synthetic-audio:${value}`, 'utf8');
globalThis.fetch = async (_url, options) => {
  assert.equal(mode, 'generate', 'A disk hit must not call the provider.');
  assert.equal(String(_url), 'https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts');
  const body = options?.body;
  assert.ok(body instanceof URLSearchParams);
  assert.equal(body.get('speaker'), settings.speaker);
  const value = body.get('text'); assert.ok(value === text || value === otherText);
  fetchCount++;
  if (fetchCount === 2) entered();
  await gate;
  signalAborted ||= Boolean(options?.signal?.aborted);
  return new Response(new Uint8Array(binary(value)), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
};

let primaryCancelled = false;
if (mode === 'generate') {
  const controller = new AbortController();
  const requests = Promise.allSettled([
    speech.synthesizeSpeech(text, settings.speaker, { settings, signal: controller.signal }),
    speech.synthesizeSpeech(text, settings.speaker, { settings, onTiming: timing => { timings.sameKey = timing; } }),
    speech.synthesizeSpeech(otherText, settings.speaker, { settings, onTiming: timing => { timings.otherKey = timing; } }),
  ]);
  await started;
  controller.abort(new DOMException('Synthetic one-subscriber cancellation', 'AbortError'));
  release();
  const results = await requests;
  primaryCancelled = results[0].status === 'rejected' && results[0].reason.name === 'AbortError';
  assert.equal(primaryCancelled, true);
  assert.deepEqual(results.slice(1).map(result => result.status === 'fulfilled' ? result.value : 'rejected'), [`/api/audio/${id}`, `/api/audio/${otherId}`]);
  assert.equal(fetchCount, 2); assert.equal(signalAborted, false);
} else {
  assert.equal(await speech.synthesizeSpeech(text, settings.speaker, { settings, onTiming: timing => { timings.sameKey = timing; } }), `/api/audio/${id}`);
  assert.equal(await speech.synthesizeSpeech(otherText, settings.speaker, { settings, onTiming: timing => { timings.otherKey = timing; } }), `/api/audio/${otherId}`);
  assert.equal(fetchCount, 0);
}
const memory = await speech.readSpeechAudio(id), durable = await speech.readDurableSpeechAudio(id);
const otherDurable = await speech.readDurableSpeechAudio(otherId);
assert.deepEqual(memory, binary(text)); assert.deepEqual(durable, memory); assert.deepEqual(otherDurable, binary(otherText));
assert.deepEqual(await readFile(path.join(process.cwd(), 'data/audio', `${id}.mp3`)), durable);
assert.equal(await speech.readSpeechAudio('../invalid'), null);
assert.equal(await speech.readDurableSpeechAudio('f'.repeat(64)), null);
assert.deepEqual(timings.sameKey.settings, settings); assert.deepEqual(timings.otherKey.settings, settings);
console.log(JSON.stringify({ mode, fetchCount, primaryCancelled, survivingProducerAborted: signalAborted,
  audioId: id, otherAudioId: otherId, audioSha256: hash(durable!), otherAudioSha256: hash(otherDurable!),
  sameKeyCache: timings.sameKey.cache, otherKeyCache: timings.otherKey.cache,
  timingBoundsValid: Object.values(timings).every(row => Number.isFinite(row.durationMs) && row.durationMs >= 0 && (row.providerMs === null || Number.isFinite(row.providerMs) && row.providerMs >= 0)),
  durableMatchesPlayback: true, speechSettingsPreserved: true, invalidAndMissingReadNull: true,
  actualProviderCalls: 0, mediaKind: 'synthetic-bytes-not-device-or-real-speech' }));
