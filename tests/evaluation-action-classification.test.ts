import test from 'node:test';
import assert from 'node:assert/strict';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { InterviewSession, QuestionPresentation, RecordedTurn } from '../server/protocol';
import { buildEvaluationUnits, evaluationQuoteSource } from '../server/providers/evaluation-turns';
import { finalizeSessionEvaluation } from '../server/providers/openai';
import { reviewedRecordEvaluationFixture } from './fixtures/reviewed-evaluation-knowledge';

/** No model/API calls. Semantic decisions and anchor outputs are explicit test inputs. */
const context = { school: { schoolReferenceId: 'synthetic-action-weight-school' } } as InterviewContext;
function turn(id: string, kind: RecordedTurn['questionKind'], raw: string, root = id, original?: string, mode: 'rephrase' | 'repeat_audio' = 'rephrase'): RecordedTurn {
  return { id, questionKind: kind, parentMainQuestionId: root, questionText: '그 활동에서 본인이 한 일을 말씀해 주세요.', answerId: 'answer-' + id,
    questionAudioUrl: '/synthetic-audio/' + id + '.mp3', acknowledgement: null, acknowledgementAudioUrl: null, interviewerId: 'interviewer-1',
    rawTranscript: raw, transcriptStatus: 'finalized', mainIndex: root === 'q0' ? 1 : 2, mainCount: 2, followUpIndex: kind === 'follow_up' ? 1 : 0,
    evidenceIds: [], metadata: { primaryFunction: 'ROLE', questionIntent: '실제로 수행한 본인 행동 확인', targetEvidence: ['본인이 수행한 행동 한 가지'], depth: 'D2',
      ...(kind === 'clarification' ? { nonEvaluative: true, clarificationOfTurnId: original, clarificationMode: mode } : {}) } } as unknown as RecordedTurn;
}
function session(turns: RecordedTurn[]): InterviewSession {
  const presentations: QuestionPresentation[] = turns.map((item, index) => ({ turnId: item.id, rootTurnId: item.parentMainQuestionId, questionKind: item.questionKind,
    clockId: 'explicit-synthetic-clock', startedAtMs: index * 1000 + 100, completedAtMs: index * 1000 + 900 }));
  return { id: 'synthetic-action-classification', status: 'ending', evaluationStatus: 'running', turns, questionPresentations: presentations,
    metrics: {}, followUpCountByMainQuestion: {}, elapsedMs: 10000 } as InterviewSession;
}
function scored(turnId: string, quote: string, anchor: 0 | 1 | 2 | 3 | 4, status: 'SATISFIED' | 'PARTIAL' | 'NOT_SATISFIED' = anchor === 0 ? 'NOT_SATISFIED' : 'PARTIAL') {
  const axis = () => ({ anchor, quote, rationale: '입력한 질문 요구와 실제 답변 인용에 대한 명시적인 합성 평가다.' });
  return { turnId, status, deferredReason: null, axes: { I: axis(), A: axis(), S: axis(), R: axis(), C: axis() }, verifiedCoreError: false, verifiedCoreErrorEvidence: null,
    strengths: [], improvements: [], conflictNeedsReview: [], deliveryCoaching: [], strategyCoaching: [] };
}
function finalize(value: InterviewSession, answers: ReturnType<typeof scored>[]) {
  const approved = reviewedRecordEvaluationFixture(context, value);
  return finalizeSessionEvaluation({ summary: '합성 행동분류와 점수 집계 회귀', answers, languageClassifications: [] }, approved.context, approved.session);
}

test('Q0/F1/F2 each collect their linked rephrase and replay attempts but only the evaluative IDs receive 70/15/15 weights', () => {
  const turns = [turn('q0', 'main', '다같이 했습니다.'), turn('q0-rephrase', 'clarification', '제가 비교표를 작성했습니다.', 'q0', 'q0'),
    turn('f1', 'follow_up', '기준을 골랐습니다.', 'q0'), turn('f1-replay', 'clarification', '작성 시점을 기준으로 골랐습니다.', 'q0', 'f1', 'repeat_audio'),
    turn('f2', 'follow_up', '직접 측정했다고 말했습니다.', 'q0'), turn('f2-correction', 'clarification', '정확히는 공개 자료를 분석했습니다.', 'q0', 'f2'),
    turn('q1', 'main', '조사 대상을 비교했습니다.')];
  const value = session(turns), original = structuredClone(value);
  const result = finalize(value, [scored('q0', turns[1].rawTranscript!, 2), scored('f1', turns[3].rawTranscript!, 4), scored('f2', turns[5].rawTranscript!, 0), scored('q1', turns[6].rawTranscript!, 3)]);
  assert.deepEqual(result.answers.map(answer => answer.turnId), ['q0', 'f1', 'f2', 'q1']);
  assert.deepEqual(result.answers[0].answerAttemptTurnIds, ['q0', 'q0-rephrase']);
  assert.deepEqual(result.answers[1].answerAttemptTurnIds, ['f1', 'f1-replay']);
  assert.deepEqual(result.answers[2].answerAttemptTurnIds, ['f2', 'f2-correction']);
  assert.equal(result.answers[2].quoteSources.I?.sourceTurnId, 'f2-correction');
  assert.deepEqual(result.clusterScores[0].members.map(member => [member.turnId, member.weight]), [['q0', 0.7], ['f1', 0.15], ['f2', 0.15]]);
  assert.equal(result.clusterScores[0].score, 50); assert.equal(result.sessionScore, 62.5);
  assert.equal(result.aggregation.N_total, 2); assert.equal(result.aggregation.N_valid, 2); assert.deepEqual(value, original);
});

test('misclassifying the same rephrase as F creates an extra rubric and a 30 percent score influence; correct kind avoids it', () => {
  const vague = '다같이 했어요.', clarified = '제가 안내 문구를 수정했습니다.';
  const correctlyTyped = session([turn('q0', 'main', vague), turn('retry', 'clarification', clarified, 'q0', 'q0'), turn('q1', 'main', '설문 자료를 골랐습니다.')]);
  const wronglyTyped = session([turn('q0', 'main', vague), turn('retry', 'follow_up', clarified, 'q0'), turn('q1', 'main', '설문 자료를 골랐습니다.')]);
  assert.equal(correctlyTyped.turns[1].questionText, wronglyTyped.turns[1].questionText);
  const correct = finalize(correctlyTyped, [scored('q0', clarified, 4), scored('q1', '설문 자료를 골랐습니다.', 3)]);
  const wrong = finalize(wronglyTyped, [scored('q0', vague, 1), scored('retry', clarified, 4), scored('q1', '설문 자료를 골랐습니다.', 3)]);
  assert.deepEqual(correct.clusterScores[0].members.map(member => member.weight), [1]);
  assert.deepEqual(wrong.clusterScores[0].members.map(member => member.weight), [0.7, 0.3]);
  assert.equal(correct.clusterScores[0].score, 100); assert.equal(wrong.clusterScores[0].score, 47.5);
  assert.equal(correct.sessionScore, 87.5); assert.equal(wrong.sessionScore, 61.25);
  assert.deepEqual(correct.answers[0].answerAttemptTurnIds, ['q0', 'retry']);
  assert.deepEqual(wrong.answers.map(answer => answer.answerAttemptTurnIds), [['q0'], ['retry'], ['q1']]);
});

test('replay requests and a later correction are preserved as source attempts with no separate score or fabricated combined quote', () => {
  const turns = [turn('q0', 'main', '직접 측정했습니다.'), turn('replay-request', 'clarification', '다시 들려주세요.', 'q0', 'q0', 'repeat_audio'),
    turn('correction', 'clarification', '정확히는 직접 측정하지 않고 자료를 비교했습니다.', 'q0', 'q0'), turn('q1', 'main', '제가 표를 정리했습니다.')];
  const value = session(turns), units = buildEvaluationUnits(value);
  assert.deepEqual(units.scoredUnits.map(unit => unit.turn.id), ['q0', 'q1']);
  assert.deepEqual(units.units[0].clarificationTurnIds, ['replay-request', 'correction']);
  assert.deepEqual(evaluationQuoteSource(units.units[0], turns[2].rawTranscript!), { sourceTurnId: 'correction', answerId: 'answer-correction', start: 0, end: turns[2].rawTranscript!.length });
  assert.equal(evaluationQuoteSource(units.units[0], turns[0].rawTranscript! + '\n' + turns[2].rawTranscript!), null);
  const result = finalize(value, [scored('q0', turns[2].rawTranscript!, 3), scored('q1', turns[3].rawTranscript!, 3)]);
  assert.deepEqual(result.clusterScores[0].members.map(member => [member.turnId, member.weight]), [['q0', 1]]);
  assert.deepEqual(result.followUpScores, []); assert.equal(result.sessionScore, 75);
  assert.throws(() => finalize(value, [scored('q0', turns[2].rawTranscript!, 3), scored('replay-request', turns[1].rawTranscript!, 4), scored('q1', turns[3].rawTranscript!, 3)]), /질문 ID/u);
});

test('actual evaluative CLARIFY_CONTENT keeps 30 percent even when its wording resembles a rephrase', () => {
  const main = turn('q0', 'main', '제가 표를 만들었습니다.'), follow = turn('f1', 'follow_up', '작성 시점을 기준으로 비교했습니다.', 'q0'), other = turn('q1', 'main', '제가 자료를 골랐습니다.');
  follow.metadata.primaryFunction = 'CLARIFY_CONTENT';
  const result = finalize(session([main, follow, other]), [scored('q0', main.rawTranscript!, 2), scored('f1', follow.rawTranscript!, 4), scored('q1', other.rawTranscript!, 3)]);
  assert.equal(result.answers[1].questionKind, 'follow_up'); assert.equal(result.answers[1].primaryFunction, 'CLARIFY_CONTENT');
  assert.equal(result.answers[1].profile, 'EXPERIENCE'); assert.deepEqual(result.clusterScores[0].members.map(member => member.weight), [0.7, 0.3]);
  assert.equal(result.clusterScores[0].score, 65); assert.equal(result.sessionScore, 70);
});

test('observed silent attempts stay unscored while an explicit spoken inability remains evaluable at its original question', () => {
  const blank = turn('q0', 'main', ''), silentReplay = turn('silent-replay', 'clarification', '', 'q0', 'q0', 'repeat_audio'), other = turn('q1', 'main', '제가 표를 만들었습니다.');
  for (const item of [blank, silentReplay]) item.answerObservation = { classification: 'silence_observed', nonAnswer: true, durationMs: 3000, speakingMs: 0, silenceMs: 3000,
    firstSpeechMs: null, speechDetected: false, rawTranscriptPreserved: true, origin: 'finalized-stt-and-observed-speech-timing' };
  const silent = finalize(session([blank, silentReplay, other]), [scored('q1', other.rawTranscript!, 3)]);
  assert.equal(silent.unscoredAnswers.length, 1); assert.equal(silent.unscoredAnswers[0].reason, 'NO_SPEECH_OBSERVED');
  assert.equal(silent.unscoredAnswers[0].score, null); assert.deepEqual(silent.clusterScores[0].members.map(member => member.weight), [1]);
  assert.equal(silent.clusterScores[0].score, null); assert.equal(silent.sessionScore, null);
  const unavailable = turn('q0', 'main', '모르겠습니다.');
  const spoken = finalize(session([unavailable, other]), [scored('q0', unavailable.rawTranscript!, 0), scored('q1', other.rawTranscript!, 3)]);
  assert.equal(spoken.answers[0].status, 'NOT_SATISFIED'); assert.equal(spoken.answers[0].score, 0);
  assert.equal(spoken.clusterScores[0].status, 'SCORABLE'); assert.equal(spoken.sessionScore, 37.5);
});

test('a replay linked through a prior clarification contributes to the original unit without gaining independent weight', () => {
  const turns = [turn('q0', 'main', ''), turn('rephrase', 'clarification', '다시 들려주세요.', 'q0', 'q0'),
    turn('replay', 'clarification', '제가 비교표를 작성했습니다.', 'q0', 'rephrase', 'repeat_audio'), turn('q1', 'main', '자료를 정리했습니다.')];
  const value = session(turns), units = buildEvaluationUnits(value);
  assert.deepEqual(units.unassignedClarificationTurnIds, []);
  assert.deepEqual(units.units[0].answerAttempts.map(attempt => attempt.sourceTurnId), ['q0', 'rephrase', 'replay']);
  assert.deepEqual(units.units[0].clarificationTurnIds, ['rephrase', 'replay']);
  const result = finalize(value, [scored('q0', turns[2].rawTranscript!, 4), scored('q1', turns[3].rawTranscript!, 3)]);
  assert.equal(result.answers[0].quoteSources.I?.sourceTurnId, 'replay');
  assert.deepEqual(result.clusterScores[0].members.map(member => member.weight), [1]); assert.equal(result.sessionScore, 87.5);
});

test('clarification ancestry cycles, absent links and cross-root chains remain unassigned', () => {
  const main = turn('q0', 'main', '자료를 정리했습니다.');
  const cycleA = turn('cycle-a', 'clarification', '차용하면 안 되는 답변', 'q0', 'cycle-b');
  const cycleB = turn('cycle-b', 'clarification', '차용하면 안 되는 답변', 'q0', 'cycle-a', 'repeat_audio');
  const missing = turn('missing', 'clarification', '차용하면 안 되는 답변', 'q0');
  const missingChain = turn('missing-chain', 'clarification', '차용하면 안 되는 답변', 'q0', 'missing');
  const cross = turn('cross', 'clarification', '차용하면 안 되는 답변', 'other-root', 'q0');
  const crossChain = turn('cross-chain', 'clarification', '차용하면 안 되는 답변', 'q0', 'cross');
  const units = buildEvaluationUnits(session([main, cycleA, cycleB, missing, missingChain, cross, crossChain]));
  assert.deepEqual(units.unassignedClarificationTurnIds, ['cycle-a', 'cycle-b', 'missing', 'missing-chain', 'cross', 'cross-chain']);
  assert.deepEqual(units.units[0].answerAttempts.map(attempt => attempt.sourceTurnId), ['q0']);
});
