import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeSpeech } from '../server/providers/clova-tts';
import { SpeechAudioCache, type SpeechSynthesisOptions } from '../server/providers/speech-audio-cache';

const settings = { speaker: 'vdaeseong', speed: 0, pitch: 1, volume: 0, format: 'mp3' as const };

test('CLOVA fetch uses the shared producer signal while caller cancellation belongs to the cache subscriber', async t => {
  const caller = new AbortController(), producer = new AbortController();
  let fetchSignal!: AbortSignal, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(SpeechAudioCache.prototype, 'getOrCreate', async (_id: string, load: (signal: AbortSignal) => Promise<Buffer>, options: SpeechSynthesisOptions = {}) => {
    assert.equal(options.signal, caller.signal);
    await load(producer.signal); return '/api/audio/unused-synthetic';
  });
  const request = t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
    fetchSignal = options!.signal!;
    assert.notEqual(fetchSignal, caller.signal);
    entered();
    return await new Promise<Response>((_resolve, reject) => {
      fetchSignal.addEventListener('abort', () => reject(fetchSignal.reason), { once: true });
    });
  });
  const result = synthesizeSpeech('합성 취소 테스트 질문입니다.', settings.speaker, { settings, signal: caller.signal });
  const reason = new DOMException('Synthetic producer cancellation', 'AbortError');
  const rejected = assert.rejects(result, error => error === reason);
  await started; caller.abort(); assert.equal(fetchSignal.aborted, false, 'A caller signal must not directly abort a shared provider.');
  producer.abort(reason); await rejected; assert.equal(request.mock.callCount(), 1);
});

test('the existing 35 second provider cap is combined with producer cancellation and late body bytes are rejected', async t => {
  const producer = new AbortController(), cap = new AbortController();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), bodyStarted = new Promise<void>(resolve => { entered = resolve; });
  const timeout = t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => { assert.equal(milliseconds, 35_000); return cap.signal; });
  t.mock.method(SpeechAudioCache.prototype, 'getOrCreate', async (_id: string, load: (signal: AbortSignal) => Promise<Buffer>) => {
    await load(producer.signal); return '/api/audio/unused-synthetic';
  });
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
    const signal = options!.signal!;
    assert.equal(signal.aborted, false);
    return { ok: true, headers: new Headers({ 'content-type': 'audio/mpeg' }), arrayBuffer: async () => {
      entered(); await gate; return new Uint8Array([1, 2, 3]).buffer;
    } } as Response;
  });
  const reason = new DOMException('Synthetic provider deadline', 'TimeoutError');
  const result = synthesizeSpeech('합성 제한 시간 테스트 질문입니다.', settings.speaker, { settings });
  const rejected = assert.rejects(result, error => error === reason);
  await bodyStarted; cap.abort(reason); release(); await rejected;
  assert.equal(timeout.mock.callCount(), 1); assert.equal(producer.signal.aborted, false);
});

test('an expired speech subscriber fails before cache access or any provider request', async t => {
  const controller = new AbortController(), reason = new DOMException('Synthetic turn deadline', 'TimeoutError'); controller.abort(reason);
  const cache = t.mock.method(SpeechAudioCache.prototype, 'getOrCreate', async () => { throw new Error('cache must not be reached'); });
  const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('provider must not be reached'); });
  await assert.rejects(synthesizeSpeech('기한이 지난 요청입니다.', settings.speaker, { settings, signal: controller.signal }), error => error === reason);
  assert.equal(cache.mock.callCount(), 0); assert.equal(request.mock.callCount(), 0);
});
