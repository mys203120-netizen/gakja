import test from 'node:test';
import assert from 'node:assert/strict';
import { playNativeInterviewAudio } from '../lib/interview/native-audio-playback';
import { ProgressiveInterviewAudio } from '../lib/interview/progressive-audio';
import { InterviewPlaybackGate } from '../lib/interview/audio-preload';
import { browserInterruptionAction, isPreQuestionStartupPhase, phaseAfterAcknowledgement, startupPlaybackAction } from '../lib/interview/startup-flow';
import { initialSessionState, sessionReducer, type Phase } from '../hooks/useInterviewSession';
import type { PreparedTurn } from '../server/protocol';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
class FakeAudio extends EventTarget {
  src = '';
  pauses = 0;
  async play() {}
  pause() { this.pauses++; }
  playing() { this.dispatchEvent(new Event('playing')); }
  ended() { this.dispatchEvent(new Event('ended')); }
}
const first: PreparedTurn = { id: 'q0', questionText: '이 방법을 선택한 이유는 무엇인가요?', questionKind: 'main', parentMainQuestionId: 'q0', mainIndex: 1, mainCount: 18, mainCountIsLimit: false, followUpIndex: 0, evidenceIds: ['test:e1'], questionAudioUrl: '/question', acknowledgement: '안녕하세요. 면접을 시작하겠습니다.', acknowledgementAudioUrl: '/opening', interviewerId: 'one' };

function startupPlayback() {
  const audio = new FakeAudio(), gate = new InterviewPlaybackGate(), target = {};
  let state = { ...initialSessionState, phase: 'preparing' as Phase }, hadBegun = false;
  let fullscreenElement: unknown = target, hidden = false, current = true, pendingCancel: (() => void) | null = null;
  let openingStarts = 0, questionStarts = 0;
  const phase = (value: Phase) => { state = sessionReducer(state, { type: 'phase', phase: value }); };
  const interrupt = () => { if (!hadBegun && isPreQuestionStartupPhase(state.phase)) { gate.pause(); audio.pause(); phase('device_check'); } };
  const action = () => startupPlaybackAction({ phase: state.phase, fullscreenElement, startupTarget: target, hidden, hadBegun, paused: gate.paused });
  const player = new ProgressiveInterviewAudio({
    prepare: async url => url, wait: () => gate.wait(), current: () => current,
    play: (url, onPlaying) => {
      pendingCancel?.();
      return playNativeInterviewAudio({
        audio: audio as unknown as HTMLAudioElement, url, current: () => current, action, onPlaying,
        onEnded: () => {}, onBlocked: interrupt,
        registerCancel: cancel => { pendingCancel = cancel; },
        unregisterCancel: cancel => { if (pendingCancel === cancel) pendingCancel = null; },
      });
    },
    acknowledgementPlaying: () => { openingStarts++; phase('speaking_acknowledgement'); },
    acknowledgementEnded: () => { if (state.phase === 'speaking_acknowledgement') phase(phaseAfterAcknowledgement(hadBegun)); },
    questionPlaying: turn => { hadBegun = true; questionStarts++; phase('speaking_question'); state = sessionReducer(state, { type: 'reveal', turn }); },
  });
  return {
    audio, player, gate, action, phase,
    state: () => state, begun: () => hadBegun, openingStarts: () => openingStarts, questionStarts: () => questionStarts,
    loseFullscreen: () => { fullscreenElement = null; interrupt(); }, hide: () => { hidden = true; interrupt(); },
    restore: () => { fullscreenElement = target; hidden = false; },
    retire: () => { current = false; pendingCancel?.(); gate.dispose(); },
  };
}

test('actual progressive opening callbacks return startup to preparing and allow first question reveal exactly once', async () => {
  const f = startupPlayback();
  try {
    const playing = f.player.playTurn(first);
    await tick(); assert.equal(f.audio.src, '/opening');
    f.audio.playing(); assert.equal(f.state().phase, 'speaking_acknowledgement'); assert.equal(f.begun(), false);
    assert.equal(f.state().visibleTurn, null); assert.equal(f.state().elapsedMs, 0);
    assert.equal(f.action(), 'play', 'Opening may resume while confirmed fullscreen remains visible');
    f.audio.ended(); await tick();
    assert.equal(f.state().phase, 'preparing'); assert.equal(f.audio.src, '/question');
    assert.equal(f.state().visibleTurn, null); assert.equal(f.begun(), false);
    f.audio.playing(); assert.equal(f.state().phase, 'speaking_question'); assert.equal(f.begun(), true);
    assert.equal(f.state().visibleTurn?.id, first.id);
    f.audio.playing(); f.audio.ended(); await playing;
    assert.equal(f.openingStarts(), 1); assert.equal(f.questionStarts(), 1);
    assert.equal(phaseAfterAcknowledgement(true), 'preparing_next', 'Later acknowledgement keeps normal turn phase');
  } finally { f.retire(); }
});

for (const interruption of ['fullscreen', 'visibility'] as const) test(`opening ${interruption} interruption returns to device check and resumes through a fresh countdown`, async () => {
  const f = startupPlayback();
  try {
    const playing = f.player.playTurn(first); await tick(); f.audio.playing();
    assert.equal(browserInterruptionAction(f.state().phase), 'pause');
    if (interruption === 'fullscreen') f.loseFullscreen(); else f.hide();
    assert.equal(f.state().phase, 'device_check'); assert.equal(f.gate.paused, true);
    assert.equal(f.state().visibleTurn, null); assert.equal(f.begun(), false);
    f.audio.playing(); assert.equal(f.state().phase, 'device_check');
    f.restore(); f.phase('countdown'); f.audio.playing();
    assert.equal(f.state().phase, 'countdown'); assert.equal(f.questionStarts(), 0);
    f.phase('preparing'); f.gate.resume();
    // useInterviewSession.resumePlayback restores the pending audio role.
    f.phase('speaking_acknowledgement'); f.audio.playing(); assert.equal(f.action(), 'play');
    f.audio.ended(); await tick(); assert.equal(f.state().phase, 'preparing');
    f.audio.playing(); f.audio.ended(); await playing;
    assert.equal(f.openingStarts(), 1); assert.equal(f.questionStarts(), 1); assert.equal(f.begun(), true);
  } finally { f.retire(); }
});

test('opening ended queued during interruption cannot override device check or start a question before the next countdown', async () => {
  const f = startupPlayback();
  try {
    const playing = f.player.playTurn(first); await tick(); f.audio.playing(); f.loseFullscreen();
    f.audio.ended(); await tick(); assert.equal(f.state().phase, 'device_check'); assert.equal(f.audio.src, '/opening');
    f.restore(); f.phase('countdown'); assert.equal(f.questionStarts(), 0);
    f.phase('preparing'); f.gate.resume(); await tick(); assert.equal(f.audio.src, '/question');
    f.audio.playing(); f.audio.ended(); await playing;
    assert.equal(f.openingStarts(), 1); assert.equal(f.questionStarts(), 1);
  } finally { f.retire(); }
});

test('native playing callback failures reject their own promise without escaping the DOM event handler', async () => {
  const audio = new FakeAudio(); let settled = 0;
  const playing = playNativeInterviewAudio({ audio: audio as unknown as HTMLAudioElement, url: '/old-question', current: () => true, action: () => 'play', onPlaying: () => { throw new DOMException('종료한 면접의 음성을 무시했습니다.', 'AbortError'); }, onEnded: () => {}, onBlocked: () => {}, registerCancel: () => {}, unregisterCancel: () => { settled++; } });
  const rejection = assert.rejects(playing, { name: 'AbortError' });
  assert.doesNotThrow(() => audio.playing()); await rejection;
  audio.playing(); audio.ended(); assert.equal(settled, 1);
});

test('closing can replace pending first-question playback without inheriting its native listeners', async () => {
  const audio = new FakeAudio(); let cancel: (() => void) | null = null, oldStarts = 0, closingStarts = 0;
  const options = { audio: audio as unknown as HTMLAudioElement, current: () => true, action: () => 'play' as const, onEnded: () => {}, onBlocked: () => {}, registerCancel: (value: () => void) => { cancel = value; }, unregisterCancel: (value: () => void) => { if (cancel === value) cancel = null; } };
  const pending = playNativeInterviewAudio({ ...options, url: '/question', onPlaying: () => { oldStarts++; } });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  const cancelOld = cancel as unknown as () => void; cancelOld();
  const closing = playNativeInterviewAudio({ ...options, url: '/closing', onPlaying: () => { closingStarts++; } });
  audio.playing(); audio.ended(); await Promise.all([rejected, closing]);
  assert.equal(oldStarts, 0); assert.equal(closingStarts, 1); assert.equal(cancel, null);
});
