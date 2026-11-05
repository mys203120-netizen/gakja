import test from 'node:test';
import assert from 'node:assert/strict';
import { AnswerCaptureLifecycle, answerCaptureTailAction, shouldDrainAnswerTail, SpeechCaptureClock } from '../lib/interview/answer-capture';

const scope = { turnId: 'question-1', answerId: 'answer-1', captureRevision: 1 };

test('end request, STT final, candidate and advance are separate irreversible stages', () => {
  const capture = new AnswerCaptureLifecycle();
  capture.begin(scope.turnId, scope.answerId);
  assert.equal(capture.lockAdvance(), null);
  assert.equal(capture.stageCandidate(scope, 'candidate-1'), false);
  assert.equal(capture.requestEnd()?.stage, 'end_requested');
  assert.equal(capture.requestEnd(), null);
  assert.equal(capture.lockAdvance(), null);
  assert.equal(capture.finalize(scope), true);
  assert.equal(capture.snapshot()?.stage, 'stt_final');
  assert.equal(capture.acceptsTranscript(scope), false);
  assert.equal(capture.stageCandidate(scope, 'candidate-1'), true);
  assert.equal(capture.lockAdvance()?.stage, 'advance_locked');
  assert.equal(capture.continueAnswer(), null);
  assert.equal(capture.acceptsTranscript(scope), false);
});

test('continuation retains the logical answer and rejects previous stream and revision results', () => {
  const capture = new AnswerCaptureLifecycle();
  capture.begin(scope.turnId, scope.answerId);
  assert.equal(capture.bindStream({ ...scope, streamId: 'stream-1' }), true);
  capture.requestEnd(); capture.finalize({ ...scope, streamId: 'stream-1' });
  const continued = capture.continueAnswer();
  assert.equal(continued?.turnId, scope.turnId);
  assert.equal(continued?.answerId, scope.answerId);
  assert.equal(continued?.captureRevision, 2);
  assert.equal(capture.acceptsTranscript({ ...scope, streamId: 'stream-1' }), false);
  const next = { ...scope, captureRevision: 2, streamId: 'stream-2' };
  assert.equal(capture.bindStream(next), true);
  assert.equal(capture.acceptsTranscript(next), true);
  assert.equal(capture.acceptsTranscript({ ...scope, captureRevision: 2 }), false);
  assert.equal(capture.acceptsTranscript({ ...next, streamId: 'stream-1' }), false);
  assert.equal(capture.acceptsTranscript({ turnId: scope.turnId, answerId: scope.answerId }), false);
});

test('pause resume changes capture identity without reopening an advance lock', () => {
  const capture = new AnswerCaptureLifecycle();
  capture.begin(scope.turnId, scope.answerId);
  assert.equal(capture.continueAnswer()?.captureRevision, 2);
  capture.restore({ ...scope, captureRevision: 4 }, 'advance_locked', 'candidate-4');
  // A failed/aborted HTTP response has no authority to rewind this state.
  assert.equal(capture.continueAnswer(), null);
  assert.equal(capture.snapshot()?.candidateId, 'candidate-4');
  assert.equal(capture.acceptsTranscript({ ...scope, captureRevision: 4 }), false);
});

test('staged recovery can retry the same candidate while committed recovery cannot capture', () => {
  const capture = new AnswerCaptureLifecycle();
  capture.restore(scope, 'stt_final');
  assert.equal(capture.stageCandidate({ ...scope, captureRevision: 2 }, 'stale-candidate'), false);
  assert.equal(capture.stageCandidate(scope, 'candidate-1'), true);
  capture.lockAdvance();
  capture.restore(scope, 'advance_locked', 'candidate-1');
  assert.equal(capture.continueAnswer(), null);
  capture.reset();
  assert.equal(capture.acceptsTranscript(scope), false);
});

test('VAD observations preserve active duration and speech across pause resume, excluding pause silence', () => {
  const clock = new SpeechCaptureClock();
  clock.reset(100, true, true);
  clock.frame(.9, 32, 200);
  clock.frame(.9, 32, 232);
  clock.frame(.1, 32, 264);
  clock.setListening(false, 400, true);
  const paused = clock.snapshot(8_000, true);
  assert.equal(paused.durationMs, 300);
  assert.equal(paused.speakingMs, 64);
  assert.equal(paused.firstSpeechMs, 100);
  assert.equal(paused.lastSpeechMs, 132);
  assert.equal(paused.trailingSilenceMs, 168);
  clock.setListening(true, 10_000, true);
  clock.frame(.8, 32, 10_100);
  clock.frame(.1, 32, 10_132);
  const resumed = clock.snapshot(10_300, true);
  assert.equal(resumed.durationMs, 600);
  assert.equal(resumed.speakingMs, 96);
  assert.equal(resumed.firstSpeechMs, 100);
  assert.equal(resumed.lastSpeechMs, 400);
  assert.equal(resumed.trailingSilenceMs, 200);
  assert.equal(resumed.speechActiveAtEnd, false);
});

test('missing VAD coverage remains unknown instead of inventing ending silence', () => {
  const clock = new SpeechCaptureClock();
  clock.reset(0, true, false);
  clock.frame(.9, 32, 100);
  const observation = clock.snapshot(200, true);
  assert.equal(observation.speakingMs, null);
  assert.equal(observation.lastSpeechMs, null);
  assert.equal(observation.trailingSilenceMs, null);
  assert.equal(observation.speechActiveAtEnd, null);
  clock.reset(200, true, true);
  clock.frame(.9, 32, 300);
  clock.loseCoverage();
  assert.equal(clock.snapshot(400, true).lastSpeechMs, null);
});

test('Space drains only a bounded technical speech tail and never classifies answer text', () => {
  const spoken = { durationMs: 1_000, speakingMs: 600, firstSpeechMs: 100, lastSpeechMs: 990, trailingSilenceMs: 10, speechActiveAtEnd: true, vadAvailable: true, vadCoverageComplete: true };
  assert.equal(shouldDrainAnswerTail('space', spoken, 0), true);
  assert.equal(shouldDrainAnswerTail('space', spoken, 800), false);
  assert.equal(answerCaptureTailAction('space', spoken, 800), 'continue_capture');
  assert.equal(shouldDrainAnswerTail('space', { ...spoken, speechActiveAtEnd: false, trailingSilenceMs: 200 }, 100), false);
  assert.equal(shouldDrainAnswerTail('space', undefined, 0), true);
  assert.equal(shouldDrainAnswerTail('space', undefined, 160), false);
  assert.equal(shouldDrainAnswerTail('button', spoken, 0), false);
  assert.equal(shouldDrainAnswerTail('session_end', spoken, 0), false);
});

test('ongoing speech at the Space deadline cancels only the end request and sends neither finish nor a candidate request', () => {
  const capture = new AnswerCaptureLifecycle(), clock = new SpeechCaptureClock();
  capture.begin(scope.turnId, scope.answerId); capture.bindStream({ ...scope, streamId: 'unchanged-stream' });
  clock.reset(0, true, true); clock.frame(.9, 32, 32);
  const requested = capture.requestEnd()!;
  assert.equal(capture.requestEnd(), null, 'Repeated Space cannot start another finalization while the first tail is draining');
  for (let now = 64; now <= 832; now += 32) clock.frame(.9, 32, now);
  let phase = 'finalizing_transcript', pcmEnabled = true, providerFinishes = 0, candidateRequests = 0;
  const action = answerCaptureTailAction('space', clock.snapshot(832, true), 800);
  if (action === 'continue_capture' && capture.cancelEnd(requested)) phase = 'listening';
  else { pcmEnabled = false; providerFinishes++; candidateRequests++; }
  assert.equal(phase, 'listening'); assert.equal(pcmEnabled, true);
  assert.equal(providerFinishes, 0); assert.equal(candidateRequests, 0);
  assert.equal(capture.snapshot()?.captureRevision, 1); assert.equal(capture.snapshot()?.streamId, 'unchanged-stream');
  assert.equal(capture.snapshot()?.stage, 'capturing'); assert.equal(clock.snapshot(832, true).durationMs, 832);
  assert.equal(capture.acceptsTranscript({ ...scope, streamId: 'unchanged-stream' }), true);
  const nextRequest = capture.requestEnd()!;
  clock.frame(.1, 32, 864);
  assert.equal(answerCaptureTailAction('space', clock.snapshot(1_032, true), 200), 'finalize', 'An observed quiet tail reaches the normal provider-final path');
  assert.equal(capture.finalize({ ...nextRequest, streamId: 'unchanged-stream' }), true);
  assert.equal(capture.cancelEnd(nextRequest), false);
  capture.stageCandidate(scope, 'candidate-1'); capture.lockAdvance();
  assert.equal(capture.cancelEnd(scope), false);
});

test('end-request cancellation requires its exact capture scope and cannot rewind STT finality', () => {
  const capture = new AnswerCaptureLifecycle(); capture.begin(scope.turnId, scope.answerId); capture.requestEnd();
  assert.equal(capture.cancelEnd({ ...scope, captureRevision: 2 }), false);
  assert.equal(capture.cancelEnd({ ...scope, answerId: 'another-answer' }), false);
  capture.finalize(scope);
  assert.equal(capture.cancelEnd(scope), false);
  assert.equal(answerCaptureTailAction('space', undefined, 160), 'finalize', 'Unknown VAD retains the existing bounded technical fallback');
});
