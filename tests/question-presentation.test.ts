import test from 'node:test';
import assert from 'node:assert/strict';
import { recordQuestionPresentation } from '../server/question-presentation';
import type { InterviewSession, RecordedTurn } from '../server/protocol';
import { questionPresentationIssue } from '../server/providers/evaluation-aggregation';

const turn = { id: 'q0', parentMainQuestionId: 'q0', questionKind: 'main' } as RecordedTurn;
const session = () => ({ status: 'active', turns: [turn], questionPresentations: [], questionPresentationEventIds: [] } as unknown as InterviewSession);
const event = (type: string, atMs: number, extra = {}) => ({ eventId: `${type}:${atMs}`, type, atMs, turnId: turn.id, clockId: 'clock-one', ...extra });

test('only actual question playback creates a presentation, never preparation, acknowledgement or completion status', () => {
  const value = session();
  recordQuestionPresentation(value, event('acknowledgement_playing', 5), turn);
  recordQuestionPresentation(value, event('audio_ended', 9, { payload: { role: 'acknowledgement' } }), turn);
  assert.equal(value.questionPresentations?.length, 0);
  recordQuestionPresentation(value, event('question_playing', 10), turn);
  recordQuestionPresentation(value, event('audio_ended', 20, { payload: { role: 'question' } }), turn);
  assert.deepEqual(value.questionPresentations, [{ turnId: 'q0', rootTurnId: 'q0', questionKind: 'main', clockId: 'clock-one', startedAtMs: 10, completedAtMs: 20, interrupted: false, errorCodes: undefined }]);
  value.turns = [];
  assert.equal(value.questionPresentations?.[0].rootTurnId, 'q0', 'A lost started question cannot disappear from the later denominator');
});

test('out-of-order end backup retains real times, deduplicates event IDs, and cannot invent an absent start', () => {
  const value = session(), ended = event('audio_ended', 20, { payload: { role: 'question' } });
  recordQuestionPresentation(value, ended, turn);
  assert.equal(value.questionPresentations?.[0].startedAtMs, null);
  recordQuestionPresentation(value, event('question_playing', 10), turn);
  assert.equal(recordQuestionPresentation(value, ended, turn), false);
  assert.equal(value.questionPresentations?.[0].startedAtMs, 10); assert.equal(value.questionPresentations?.[0].completedAtMs, 20);
  assert.equal(value.questionPresentationEventIds?.length, 2);
});

test('different client clocks cannot be merged into a normal question delivery', () => {
  const value = session(); recordQuestionPresentation(value, event('question_playing', 100), turn);
  recordQuestionPresentation(value, event('audio_ended', 200, { clockId: 'different-page', payload: { role: 'question' } }), turn);
  assert.equal(value.questionPresentations?.[0].completedAtMs, null);
  assert.ok(value.questionPresentations?.[0].errorCodes?.includes('PRESENTATION_CLOCK_CONFLICT'));
  const legacy = session(); recordQuestionPresentation(legacy, event('question_playing', 10, { clockId: undefined }), turn);
  assert.ok(legacy.questionPresentations?.[0].errorCodes?.includes('PRESENTATION_CLOCK_UNVERIFIED'));
});

test('successful native completion recovers interrupted delivery; later answer errors cannot poison it', () => {
  const value = session(); recordQuestionPresentation(value, event('question_playing', 10), turn);
  recordQuestionPresentation(value, event('client_error', 12, { phase: 'error' }), turn);
  assert.equal(value.questionPresentations?.[0].interrupted, true);
  recordQuestionPresentation(value, event('audio_ended', 20, { payload: { role: 'question' } }), turn);
  assert.equal(value.questionPresentations?.[0].interrupted, false);
  assert.deepEqual(value.questionPresentations?.[0].errorCodes, []);
  recordQuestionPresentation(value, event('client_error', 30, { phase: 'listening' }), turn);
  assert.equal(value.questionPresentations?.[0].interrupted, false);
});

const runtimeSession = () => ({ ...session(), runtime: { version: 'session-runtime-v1' } } as InterviewSession);
test('a real replay after reload has a separate clock-bound attempt and preserves the interrupted original', () => {
  const value = runtimeSession();
  recordQuestionPresentation(value, event('question_playing', 100), turn);
  recordQuestionPresentation(value, event('client_error', 110, { phase: 'error' }), turn);
  const original = structuredClone(value.questionPresentations![0].attempts![0]);
  recordQuestionPresentation(value, event('question_playing', 10, { clockId: 'reloaded-page' }), turn);
  assert.notEqual(questionPresentationIssue(value.questionPresentations![0]), null);
  recordQuestionPresentation(value, event('audio_ended', 20, { clockId: 'reloaded-page', payload: { role: 'question' } }), turn);
  const shown = value.questionPresentations![0];
  assert.equal(shown.clockId, 'reloaded-page'); assert.equal(questionPresentationIssue(shown), null);
  assert.equal(shown.attempts!.length, 2); assert.deepEqual(shown.attempts![0], original);
  assert.equal(value.questionPresentations!.length, 1, 'A replay is not a new question or follow-up');
});
test('an end from a different page cannot establish delivery without that page actual start', () => {
  const value = runtimeSession(); recordQuestionPresentation(value, event('question_playing', 100), turn);
  recordQuestionPresentation(value, event('audio_ended', 20, { clockId: 'reloaded-page', payload: { role: 'question' } }), turn);
  assert.equal(value.questionPresentations![0].completedAtMs, null); assert.notEqual(questionPresentationIssue(value.questionPresentations![0]), null);
  assert.ok(value.questionPresentations![0].attempts![0].errorCodes?.includes('PRESENTATION_CLOCK_CONFLICT'));
  // A later end-backup of the real start may establish this new attempt, without changing the original.
  recordQuestionPresentation(value, event('question_playing', 10, { clockId: 'reloaded-page' }), turn);
  assert.equal(questionPresentationIssue(value.questionPresentations![0]), null);
  assert.equal(value.questionPresentations![0].attempts![0].completedAtMs, null);
});
test('a redundant replay does not erase an already observed normal delivery or duplicate its evaluation demand', () => {
  const value = runtimeSession(); recordQuestionPresentation(value, event('question_playing', 10), turn);
  recordQuestionPresentation(value, event('audio_ended', 20, { payload: { role: 'question' } }), turn);
  recordQuestionPresentation(value, event('question_playing', 30, { clockId: 'new-page' }), turn);
  recordQuestionPresentation(value, event('client_error', 35, { clockId: 'new-page', phase: 'error' }), turn);
  assert.equal(questionPresentationIssue(value.questionPresentations![0]), null);
  assert.equal(value.questionPresentations![0].clockId, 'clock-one'); assert.equal(value.questionPresentations![0].attempts!.length, 2);
  assert.equal(value.questionPresentations![0].attempts![1].interrupted, true);
});
test('runtime delivery attempts retain out-of-order observations and deduplicate repeated event IDs', () => {
  const value = runtimeSession(), ended = event('audio_ended', 20, { payload: { role: 'question' } });
  recordQuestionPresentation(value, ended, turn); assert.notEqual(questionPresentationIssue(value.questionPresentations![0]), null);
  recordQuestionPresentation(value, event('question_playing', 10), turn);
  assert.equal(questionPresentationIssue(value.questionPresentations![0]), null);
  assert.equal(recordQuestionPresentation(value, ended, turn), false);
  assert.equal(value.questionPresentations![0].attempts!.length, 1); assert.equal(value.questionPresentations![0].attempts![0].eventIds.length, 2);
});
