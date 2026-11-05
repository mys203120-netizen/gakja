import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneDirector } from '../lib/live2d/director';
import { SceneCommandPlayer, type CommandAudio } from '../lib/live2d/command-player';
import { SceneBridgeGate, sceneChannel } from '../lib/live2d/bridge';
import { parseSceneManifest, sameOriginAsset } from '../lib/live2d/manifest';
import type { SceneEvent, SpeechClock } from '../lib/live2d/types';

const male: SpeechClock = { turnId: 'q1', speakerId: 'interviewer-1', src: 'https://interview.test/audio/1', timeSeconds: .5, playing: true };
test('only the actual output speaker opens their mouth; student listening, pause and ended close both', () => {
  const director = new SceneDirector();
  const speaking = director.frame('speaking', male, .15, 1, .033);
  assert.ok(speaking.parameters['interviewer-1'].ParamMouthOpenY > .1);
  assert.equal(speaking.parameters['interviewer-2'].ParamMouthOpenY, 0);
  for (const state of ['listening', 'paused', 'waiting', 'error'] as const) {
    const frame = director.frame(state, male, 1, 2, .033);
    assert.equal(frame.parameters['interviewer-1'].ParamMouthOpenY, 0);
    assert.equal(frame.parameters['interviewer-2'].ParamMouthOpenY, 0);
  }
  const paused = director.frame('speaking', { ...male, playing: false }, 1, 3, .033);
  assert.equal(paused.parameters['interviewer-1'].ParamMouthOpenY, 0);
});
test('silence closes immediately and speaker changes never carry previous mouth amplitude', () => {
  const d = new SceneDirector();
  d.frame('speaking', male, 1, 1, .1);
  assert.equal(d.frame('speaking', male, 0, 1.1, .033).parameters['interviewer-1'].ParamMouthOpenY, 0);
  const female = d.frame('speaking', { ...male, speakerId: 'interviewer-2' }, .2, 2, .033);
  assert.equal(female.parameters['interviewer-1'].ParamMouthOpenY, 0);
  assert.ok(female.parameters['interviewer-2'].ParamMouthOpenY > 0);
});
test('blink and breathing differ between speakers and listening does not add approval smiles or hand gestures', () => {
  const frame = new SceneDirector().frame('listening', null, 1, 4.45, .033);
  assert.notEqual(frame.parameters['interviewer-1'].ParamEyeLOpen, frame.parameters['interviewer-2'].ParamEyeLOpen);
  assert.notEqual(frame.parameters['interviewer-1'].ParamBreath, frame.parameters['interviewer-2'].ParamBreath);
  for (const parameters of Object.values(frame.parameters)) { assert.equal(parameters.ParamMouthForm, 0); assert.equal(parameters.ParamQuestionGesture, 0); }
});
test('malformed values cannot produce non-finite animation parameters', () => {
  const frame = new SceneDirector().frame('speaking', male, NaN, NaN, Infinity);
  assert.ok(Object.values(frame.parameters).every(p => Object.values(p).every(Number.isFinite)));
});

class FakeAudio extends EventTarget {
  src = ''; currentTime = 0; paused = true; ended = false;
  playTask: Promise<void> = Promise.resolve();
  play() { this.paused = false; this.ended = false; return this.playTask; }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  load() {}
  removeAttribute() { this.src = ''; }
  start() { this.dispatchEvent(new Event('playing')); }
  finish() { this.ended = true; this.paused = true; this.dispatchEvent(new Event('ended')); }
}
const command = (speakerId: 'interviewer-1' | 'interviewer-2', turnId: string) => ({ type: 'speak' as const, speakerId, turnId, audioUrl: '/audio/actual' });
function fixture() {
  const audio = new FakeAudio(), events: SceneEvent[] = [];
  const player = new SceneCommandPlayer(audio as CommandAudio, 'https://interview.test', event => events.push(event), () => {});
  return { audio, events, player };
}
test('speechStarted follows native playing, and a new speaker cancels the previous turn', async () => {
  const { audio, player, events } = fixture();
  await player.execute(command('interviewer-1', 'old'));
  assert.equal(events.filter(e => e.type === 'speechStarted').length, 0);
  audio.start();
  await player.execute(command('interviewer-2', 'new')); audio.start();
  assert.deepEqual(events.flatMap(e => e.type === 'speechStarted' ? [e.turnId] : []), ['old', 'new']);
  assert.deepEqual(events.flatMap(e => e.type === 'speechCancelled' ? [e.turnId] : []), ['old']);
  await player.execute({ type: 'cancel', turnId: 'old' }); assert.equal(audio.paused, false);
  audio.finish(); assert.equal(events.flatMap(e => e.type === 'speechEnded' ? [e.turnId] : []).at(-1), 'new'); player.dispose();
});
test('late rejected playback after cancellation cannot produce an error or revive speech', async () => {
  const { audio, player, events } = fixture();
  let reject!: (error: Error) => void; audio.playTask = new Promise((_, r) => { reject = r; });
  const pending = player.execute(command('interviewer-1', 'old'));
  await player.execute({ type: 'cancel', turnId: 'old' }); reject(new Error('stale'));
  await pending; audio.start();
  assert.equal(events.filter(e => e.type === 'speechStarted' || e.type === 'error').length, 0); player.dispose();
});
test('pause/resume preserves turn and emits start once; listening cancels output; dispose removes listeners', async () => {
  const { audio, player, events } = fixture();
  await player.execute(command('interviewer-1', 'q1')); audio.start();
  await player.execute({ type: 'pause' }); assert.equal(audio.paused, true);
  await player.execute({ type: 'resume' }); audio.start();
  assert.equal(events.filter(e => e.type === 'speechStarted').length, 1);
  await player.execute({ type: 'setListening', listening: true }); assert.equal(audio.paused, true);
  player.dispose(); const count = events.length; audio.start(); audio.finish(); assert.equal(events.length, count);
});
test('bridge requires prepare and rejects duplicate, reordered, foreign-session and malformed commands', () => {
  const gate = new SceneBridgeGate();
  const data = (sequence: number, command: unknown, sessionId = 'one') => JSON.stringify({ channel: sceneChannel, sessionId, sequence, command });
  assert.equal(gate.accept(data(1, { type: 'resume' })), null);
  assert.ok(gate.accept(data(2, { type: 'prepare' })));
  assert.equal(gate.accept(data(2, { type: 'pause' })), null);
  assert.equal(gate.accept(data(1, { type: 'resume' })), null);
  assert.equal(gate.accept(data(3, { type: 'prepare' }, 'old')), null);
  assert.equal(gate.accept(data(3, { type: 'speak', speakerId: 'unknown', turnId: 'x', audioUrl: '/a' })), null);
  assert.ok(gate.accept(data(4, { type: 'setListening', listening: true })));
});
test('manifest fails closed without two real model references, and asset URLs stay same-origin', () => {
  const m = { version: 1, status: 'blocked', canvas: { width: 1920, height: 1080 }, fallback: '/reference.png', runtime: null, models: [], layers: [], blockers: ['No models'] };
  assert.equal(parseSceneManifest(m, 'https://interview.test').status, 'blocked');
  assert.throws(() => parseSceneManifest({ ...m, status: 'ready', blockers: [] }, 'https://interview.test'));
  for (const url of ['https://other.test/a', 'javascript:alert(1)', 'data:audio/mp3,123', 'https://user:pass@interview.test/a']) assert.throws(() => sameOriginAsset(url, 'https://interview.test'));
});
