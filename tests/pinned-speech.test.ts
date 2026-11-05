import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeSpeech, speechAudioCacheId } from '../server/providers/clova-tts';
import { SpeechAudioCache, type SpeechSynthesisOptions, type SpeechSynthesisTiming } from '../server/providers/speech-audio-cache';

test('saved voice settings control resumed and closing synthesis even if environment values change', async t => {
  const events: SpeechSynthesisTiming[] = [];
  t.mock.method(SpeechAudioCache.prototype, 'getOrCreate', async (id: string, _load: () => Promise<Buffer>, options: SpeechSynthesisOptions = {}) => {
    options.onTiming?.({ cache: 'memory', durationMs: 0, providerMs: null, audioId: id }); return `/api/audio/${id}`;
  });
  const pinned = { speaker: 'vmikyung', speed: -2, pitch: 1, volume: 0, format: 'mp3' as const };
  const old = process.env.CLOVA_VOICE_SECOND_SPEED; process.env.CLOVA_VOICE_SECOND_SPEED = '5';
  try {
    const text = '면접은 여기까지 하겠습니다. 수고하셨습니다.';
    const url = await synthesizeSpeech(text, 'vmikyung', { role: 'secondary', settings: pinned, onTiming: event => events.push(event) });
    assert.equal(url, `/api/audio/${speechAudioCacheId(text, pinned)}`); assert.deepEqual(events[0].settings, pinned);
    assert.equal(events[0].settings!.speed, -2);
  } finally { if (old === undefined) delete process.env.CLOVA_VOICE_SECOND_SPEED; else process.env.CLOVA_VOICE_SECOND_SPEED = old; }
});
test('invalid saved speech settings are rejected before any cache or provider request', async t => {
  const cache = t.mock.method(SpeechAudioCache.prototype, 'getOrCreate', async () => { throw new Error('must not be reached'); });
  await assert.rejects(synthesizeSpeech('종료합니다.', 'vmikyung', { settings: { speaker: 'vdaeseong', speed: -1, pitch: 1, volume: 0, format: 'mp3' } }), /저장된 면접관 음성 설정/);
  assert.equal(cache.mock.callCount(), 0);
});
