import test from 'node:test';
import assert from 'node:assert/strict';
import { initialSessionState, sessionReducer, type SessionAction } from '../hooks/useInterviewSession';
import { playNativeInterviewAudio } from '../lib/interview/native-audio-playback';

test('acknowledgement identity belongs to its actual speaker before the next question is revealed', () => {
  let state = sessionReducer(initialSessionState, { type: 'phase', phase: 'speaking_acknowledgement' });
  assert.equal(state.activeSpeech, null, 'a speaking phase alone does not identify playing audio');
  state = sessionReducer(state, { type: 'speech_started', turnId: 'next-turn', speakerId: 'interviewer-2' });
  assert.deepEqual(state.activeSpeech, { turnId: 'next-turn', speakerId: 'interviewer-2' });
  assert.equal(state.visibleTurn, null, 'identity does not reveal a question early');
});

test('pending audio keeps its speaker across pause and interrupted startup until native cleanup', () => {
  let state = sessionReducer(initialSessionState, { type: 'phase', phase: 'speaking_acknowledgement' });
  state = sessionReducer(state, { type: 'speech_started', turnId: 'opening', speakerId: 'interviewer-1' });
  for (const phase of ['suspended', 'device_check', 'countdown', 'preparing', 'speaking_acknowledgement'] as const) {
    state = sessionReducer(state, { type: 'phase', phase });
    assert.deepEqual(state.activeSpeech, { turnId: 'opening', speakerId: 'interviewer-1' });
  }
  state = sessionReducer(state, { type: 'speech_cleared' });
  assert.equal(state.activeSpeech, null);
});

test('student answer, retired sessions and unknown speaker IDs cannot animate an interviewer', () => {
  const speaking = sessionReducer(initialSessionState, { type: 'phase', phase: 'speaking_question' });
  const active = sessionReducer(speaking, { type: 'speech_started', turnId: 'q1', speakerId: 'interviewer-1' });
  const listening = sessionReducer(active, { type: 'phase', phase: 'listening' });
  assert.equal(listening.activeSpeech, null);
  assert.equal(sessionReducer(listening, { type: 'speech_started', turnId: 'student-answer', speakerId: 'interviewer-1' }).activeSpeech, null);
  assert.equal(sessionReducer(active, { type: 'speech_started', turnId: 'q2', speakerId: 'unknown' }).activeSpeech, null);
  for (const phase of ['ending', 'completed'] as const) {
    const ended = sessionReducer(active, { type: 'phase', phase });
    assert.equal(ended.activeSpeech, null);
    assert.equal(sessionReducer(ended, { type: 'speech_started', turnId: 'late', speakerId: 'interviewer-2' }).activeSpeech, null);
  }
  assert.equal(sessionReducer(active, { type: 'reset' }).activeSpeech, null);
  assert.equal(sessionReducer(active, { type: 'restore', sessionId: 'saved', elapsedMs: 0, messages: [] }).activeSpeech, null);
});

test('native cancellation clears old audio and cannot clear a replacement closing speaker', async () => {
  class FakeAudio extends EventTarget {
    src = '';
    async play() {}
    pause() {}
  }
  const audio = new FakeAudio();
  let state = sessionReducer(initialSessionState, { type: 'phase', phase: 'speaking_acknowledgement' });
  const dispatch = (action: SessionAction) => { state = sessionReducer(state, action); };
  let pendingCancel: (() => void) | null = null;
  const play = (turnId: string, speakerId: string) => {
    pendingCancel?.();
    return playNativeInterviewAudio({
      audio: audio as unknown as HTMLAudioElement, url: `/${turnId}`, current: () => true, action: () => 'play',
      onPlaying: () => dispatch({ type: 'speech_started', turnId, speakerId }), onEnded: () => {}, onBlocked: () => {},
      registerCancel: cancel => { pendingCancel = cancel; },
      unregisterCancel: cancel => { if (pendingCancel === cancel) { pendingCancel = null; dispatch({ type: 'speech_cleared' }); } },
    });
  };
  const old = play('question', 'interviewer-1');
  const rejected = assert.rejects(old, { name: 'AbortError' });
  assert.equal(state.activeSpeech, null, 'fetch and play request alone do not start identity');
  audio.dispatchEvent(new Event('playing'));
  assert.deepEqual(state.activeSpeech, { turnId: 'question', speakerId: 'interviewer-1' });
  const closing = play('closing', 'interviewer-2');
  await rejected;
  assert.equal(state.activeSpeech, null);
  audio.dispatchEvent(new Event('playing'));
  assert.deepEqual(state.activeSpeech, { turnId: 'closing', speakerId: 'interviewer-2' });
  audio.dispatchEvent(new Event('ended'));
  await closing;
  assert.equal(state.activeSpeech, null);
});
