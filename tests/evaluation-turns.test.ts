import test from "node:test";
import assert from "node:assert/strict";
import type { InterviewContext } from "../server/data/load-interview-context";
import type { InterviewSession, RecordedTurn } from "../server/protocol";
import { buildEvaluationUnits, evaluationQuoteSource } from "../server/providers/evaluation-turns";
import { evaluateSession, finalizeSessionEvaluation } from "../server/providers/openai";
import { observeAnswerSubmission } from '../server/answer-submission';
import { finalizeCapturedTurnForEnd } from '../server/protocol';

function turn(id: string, kind: RecordedTurn["questionKind"], raw: string, root = "q0", original?: string): RecordedTurn {
  return { id, questionKind: kind, parentMainQuestionId: root, answerId: `answer-${id}`, rawTranscript: raw, transcriptStatus: "finalized", questionText: "실제로 한 첫 단계를 설명해 주세요.", metrics: { speech: { durationMs: 1000, speakingMs: raw ? 500 : 0 } }, metadata: { primaryFunction: "PROCESS", questionIntent: "실제로 한 첫 단계를 확인한다.", targetEvidence: ["실제로 한 첫 단계"], depth: "D1", ...(kind === "clarification" ? { nonEvaluative: true, clarificationOfTurnId: original } : {}) } } as RecordedTurn;
}
function session(turns: RecordedTurn[]) { return { id: "synthetic-evaluation-test", status: "ending", evaluationStatus: "running", turns, metrics: {}, followUpCountByMainQuestion: {}, elapsedMs: 10000 } as InterviewSession; }
const context = { school: { schoolReferenceId: "synthetic-school" } } as InterviewContext;
function output(id: string, quote: string) { const axis = { anchor: 2, quote, rationale: "명시적인 합성 회귀 사례" }; return { summary: "합성 평가 회귀", languageClassifications: [], answers: [{ turnId: id, status: "PARTIAL", deferredReason: null, axes: { I: axis, A: axis, S: axis, R: axis, C: axis }, verifiedCoreError: false, verifiedCoreErrorEvidence: null, strengths: [], improvements: [], conflictNeedsReview: [], deliveryCoaching: [] }] }; }

test("a silent original plus a finalized restatement answer forms one original evaluation unit without mutating transcripts", () => {
  const value = session([turn("q0", "main", ""), turn("c1", "clarification", "온도를 먼저 측정했습니다.", "q0", "q0")]);
  const original = JSON.stringify(value), result = buildEvaluationUnits(value);
  assert.equal(result.scoredUnits.length, 1); assert.equal(result.scoredUnits[0].turn.id, "q0");
  assert.deepEqual(result.scoredUnits[0].clarificationTurnIds, ["c1"]);
  assert.deepEqual(result.scoredUnits[0].answerAttempts.map(attempt => attempt.rawTranscript), ["", "온도를 먼저 측정했습니다."]);
  assert.equal(JSON.stringify(value), original);
});

test("a restatement of an actual follow-up contributes to that follow-up, never a second main score", () => {
  const result = buildEvaluationUnits(session([turn("q0", "main", "방법을 정했습니다."), turn("f1", "follow_up", ""), turn("c1", "clarification", "측정 간격을 비교했습니다.", "q0", "f1")]));
  assert.deepEqual(result.scoredUnits.map(unit => unit.turn.id), ["q0", "f1"]);
  assert.equal(result.scoredUnits[0].answerAttempts.length, 1);
  assert.deepEqual(result.scoredUnits[1].clarificationTurnIds, ["c1"]);
});

test("orphan, cross-root and future restatement links cannot borrow another question's answer", () => {
  const result = buildEvaluationUnits(session([turn("q0", "main", ""), turn("c1", "clarification", "빌린 답변", "different-root", "q0"), turn("c2", "clarification", "미래 답변", "q0", "future"), turn("future", "follow_up", "")]));
  assert.equal(result.scoredUnits.length, 0); assert.deepEqual(result.unassignedClarificationTurnIds, ["c1", "c2"]);
});

test("evaluation quotes stay inside one finalized original source segment with exact offsets", () => {
  const value = session([turn("q0", "main", "첫 단계입니다."), turn("c1", "clarification", "다음은 측정입니다.", "q0", "q0")]);
  const unit = buildEvaluationUnits(value).scoredUnits[0];
  assert.deepEqual(evaluationQuoteSource(unit, "측정"), { sourceTurnId: "c1", answerId: "answer-c1", start: 4, end: 6 });
  assert.equal(evaluationQuoteSource(unit, "첫 단계입니다.\n다음은 측정입니다."), null);
  value.turns[1].transcriptStatus = "error";
  assert.equal(evaluationQuoteSource(buildEvaluationUnits(value).scoredUnits[0], "측정"), null);
});

test("the final evaluator validates clarification evidence under the original ID and rejects separate clarification scoring", () => {
  const value = session([turn("q0", "main", ""), turn("c1", "clarification", "온도를 먼저 측정했습니다.", "q0", "q0")]);
  const result = finalizeSessionEvaluation(output("q0", "온도를 먼저 측정했습니다."), context, value);
  assert.equal(result.answers.length, 1); assert.equal(result.answers[0].turnId, "q0"); assert.equal(result.answers[0].quoteSources.I?.sourceTurnId, "c1");
  assert.deepEqual(result.answers[0].answerAttemptTurnIds, ["q0", "c1"]); assert.deepEqual(result.followUpScores, []);
  assert.equal(result.observations.answers.length, 2);
  assert.throws(() => finalizeSessionEvaluation(output("c1", "온도를 먼저 측정했습니다."), context, value), /질문 ID/u);
  assert.throws(() => finalizeSessionEvaluation(output("q0", "존재하지 않는 인용"), context, value), /원문 조각/u);
});

test("only silent finalized attempts produce non-scored observations without a model request or invented zero score", async () => {
  const value = session([turn("q0", "main", ""), turn("c1", "clarification", "", "q0", "q0")]);
  for (const item of value.turns) item.answerObservation = { classification: "silence_observed", nonAnswer: true, durationMs: 1000, speakingMs: 0, silenceMs: 1000, firstSpeechMs: null, speechDetected: false, rawTranscriptPreserved: true, origin: "finalized-stt-and-observed-speech-timing" };
  const result = await evaluateSession(context, value);
  assert.deepEqual(result.answers, []); assert.equal(result.unscoredAnswers.length, 1); assert.equal(result.unscoredAnswers[0].reason, "NO_SPEECH_OBSERVED"); assert.equal(result.unscoredAnswers[0].score, null);
  assert.equal(result.observations.answers[0].transcriptObserved, false);
});

test("empty STT with detected or unknown speech is not relabeled as confirmed silence", () => {
  const value = session([turn("q0", "main", "")]);
  assert.equal(buildEvaluationUnits(value).unscoredAnswers[0].reason, "NO_TRANSCRIBED_CONTENT");
  value.turns[0].answerObservation = { classification: "empty_transcript", nonAnswer: true, durationMs: 1000, speakingMs: 500, silenceMs: 500, firstSpeechMs: 0, speechDetected: true, rawTranscriptPreserved: true, origin: "finalized-stt-and-observed-speech-timing" };
  assert.equal(buildEvaluationUnits(value).unscoredAnswers[0].reason, "NO_TRANSCRIBED_CONTENT");
  value.turns[0].transcriptStatus = "error";
  assert.equal(buildEvaluationUnits(value).unscoredAnswers[0].reason, "TRANSCRIPTION_ERROR");
});

test('explicit End of a muted empty capture remains non-evaluable without a no-speech claim or invented zero score', async () => {
  const current = turn('q0', 'main', ''); current.transcriptStatus = 'paused';
  current.metrics = { speech: { durationMs: 2000, speakingMs: 0, firstSpeechMs: null } };
  current.metadata.answerEndingObservation = { stopSource: 'button', lastSpeechMs: null, trailingSilenceMs: 2000,
    speechActiveAtEnd: false, vadAvailable: true, microphoneEnabled: false };
  const rawBefore = current.rawTranscript, metricsBefore = structuredClone(current.metrics);
  finalizeCapturedTurnForEnd(current, true);
  current.answerObservation = observeAnswerSubmission(current.rawTranscript!, current.metrics, current.metadata.answerEndingObservation);
  assert.equal(current.transcriptStatus, 'finalized'); assert.equal(current.answerObservation.classification, 'empty_transcript');
  const value = session([current]), units = buildEvaluationUnits(value);
  assert.equal(units.scoredUnits.length, 0); assert.equal(units.unscoredAnswers[0].reason, 'NO_TRANSCRIBED_CONTENT');
  assert.equal(units.unscoredAnswers[0].status, 'NOT_EVALUABLE'); assert.equal(units.unscoredAnswers[0].score, null);
  const evaluated = await evaluateSession(context, value);
  assert.deepEqual(evaluated.answers, []); assert.equal(evaluated.unscoredAnswers[0].score, null);
  assert.equal(evaluated.unscoredAnswers[0].reason, 'NO_TRANSCRIBED_CONTENT');
  assert.equal(current.rawTranscript, rawBefore); assert.deepEqual(current.metrics, metricsBefore);
});

test("legacy main and follow-up transcripts keep their separate evaluation units", () => {
  const value = session([turn("q0", "main", "방법을 정했습니다."), turn("f1", "follow_up", "한 번 비교했습니다.")]);
  const result = buildEvaluationUnits(value); assert.equal(result.scoredUnits.length, 2); assert.deepEqual(result.unassignedClarificationTurnIds, []);
  assert.deepEqual(result.scoredUnits.map(unit => unit.answerAttempts.length), [1, 1]);
});
