import test from "node:test";
import assert from "node:assert/strict";
import { buildEvaluationObservations, finalizeLanguageObservations, observeTranscriptRepetitions } from "../server/providers/answer-observations";
import { finalizeSessionEvaluation } from "../server/providers/openai";
import type { InterviewContext } from "../server/data/load-interview-context";
import type { InterviewSession, RecordedTurn } from "../server/protocol";

function session(raw = "어, 그 활동에서 이제 다음 단계로 갔습니다. 촉매를 비교했습니다. 촉매를 다시 비교했습니다."): InterviewSession {
  const turn = { id: "turn-1", answerId: "answer-1", questionKind: "main", parentMainQuestionId: "turn-1", rawTranscript: raw, transcriptStatus: "finalized", metrics: { speech: { durationMs: 60000, speakingMs: null } }, metadata: { primaryFunction: "PROCESS", targetEvidence: ["비교 방법"] }, sttObservations: [{ segmentId: "stream-1:0", revision: 1, confidence: null, startTimestamp: null, endTimestamp: null }] } as RecordedTurn;
  return { id: "session", createdAt: "", updatedAt: "", status: "ending", evaluationStatus: "running", target: {}, sourceManifest: {}, turns: [turn], followUpCountByMainQuestion: {}, elapsedMs: 60000 };
}
test("repeated vocabulary and endings retain every exact source span without declaring a habit", () => {
  const raw = session().turns[0].rawTranscript!;
  const observations = observeTranscriptRepetitions("turn-1", raw);
  assert.equal(observations.find(item => item.surface === "촉매를")?.observedCount, 2);
  assert.equal(observations.find(item => item.kind === "repeated_ending" && item.surface === "했습니다")?.observedCount, 2);
  for (const item of observations) for (const span of item.spans) assert.equal(raw.slice(span.start, span.end), span.surface);
  assert.deepEqual(observations, observeTranscriptRepetitions("turn-1", raw));
});
test("context labels may exclude meaningful words and only verified filler spans change the count", () => {
  const observed = buildEvaluationObservations(session());
  const candidates = observed.answers[0].languageCandidates;
  const fillerCandidates = candidates.filter(item => item.kind === "context_filler");
  assert.deepEqual(fillerCandidates.map(item => item.surface), ["그", "이제"]);
  const classifications = fillerCandidates.map(item => ({ turnId: item.turnId, candidateId: item.id, classification: "meaningful" as const, reason: "실제 활동과 다음 단계를 가리킨다." }));
  const vocabulary = candidates.find(item => item.surface === "촉매를")!;
  const result = finalizeLanguageObservations(observed, [...classifications, { turnId: "turn-1", candidateId: vocabulary.id, classification: "topic_required", reason: "질문의 실험 대상을 지칭한다." }])[0];
  assert.equal(result.confirmedFillerCount, 1); assert.equal(result.confirmedFillersPerMinute, 1);
  assert.equal(result.repeatedVocabulary.find(item => item.id === vocabulary.id)?.classification, "topic_required");
  assert.equal(result.repeatedEndings[0].classification, "uncertain");
});
test("fabricated IDs, duplicate classifications, cross-turn labels and repetition-as-filler are rejected", () => {
  const observed = buildEvaluationObservations(session()); const candidate = observed.answers[0].languageCandidates[0];
  const valid = { turnId: candidate.turnId, candidateId: candidate.id, classification: "meaningful" as const, reason: "문맥상 지시어" };
  for (const values of [[{ ...valid, candidateId: "invented" }], [valid, valid], [{ ...valid, turnId: "other-turn" }]]) assert.throws(() => finalizeLanguageObservations(observed, values));
  const repeated = observed.answers[0].languageCandidates.find(item => item.kind === "repeated_vocabulary")!;
  assert.throws(() => finalizeLanguageObservations(observed, [{ ...valid, candidateId: repeated.id, classification: "filler" }]));
});
test("missing timing, VAD, vision, provider confidence and unobserved answers stay unavailable", () => {
  const value = session(""); delete value.turns[0].metrics; delete value.turns[0].sttObservations; value.turns[0].transcriptStatus = "paused";
  const result = finalizeLanguageObservations(buildEvaluationObservations(value), [])[0];
  assert.equal(result.speech, null); assert.equal(result.vision, null); assert.equal(result.sttObservations, null);
  assert.equal(result.confirmedFillerCount, null); assert.equal(result.confirmedFillersPerMinute, null);
  assert.equal(result.finalized, false); assert.ok(Object.values(result.unavailable).every(Boolean));
});
test("explicit unmeasured vision objects stay unavailable and session records are scoped to the actual answer", () => {
  const value = session();
  value.metrics = { vision: { method: "not_measured", records: [], summary: null } };
  assert.equal(buildEvaluationObservations(value).answers[0].unavailable.vision, true);
  value.metrics = { vision: { method: "webcam_gaze_deviation_estimate", records: [
    { turnId: "turn-1", phase: "listening", durationMs: 500, validFrameCount: 2, gazeValidFrameCount: 2, gazeValidDurationMs: 500, gazeOffFrameCount: 0, gazeOffDurationMs: 0 },
    { turnId: "other-turn", phase: "listening", durationMs: 500, validFrameCount: 2, gazeValidFrameCount: 2, gazeValidDurationMs: 500, gazeOffFrameCount: 2, gazeOffDurationMs: 500 },
  ], summary: { gazeOffFrameRatio: 0.5 } } };
  const observed = buildEvaluationObservations(value).answers[0];
  assert.equal(observed.unavailable.vision, false);
  const vision = observed.vision as { records: unknown[]; summary: { gazeOffFrameRatio: number } };
  assert.equal(vision.records.length, 1); assert.equal(vision.summary.gazeOffFrameRatio, 0);
});
test("the final answer's explicit whole-session vision is filtered and camera-off nulls cannot inherit another turn's ratios", () => {
  const value = session();
  const wholeSessionVision = { method: "webcam_gaze_deviation_estimate", records: [
    { turnId: "other-turn", phase: "listening", durationMs: 500, validFrameCount: 2, gazeValidFrameCount: 2, gazeValidDurationMs: 500, gazeOffFrameCount: 2, gazeOffDurationMs: 500 },
    { turnId: "turn-1", phase: "listening", durationMs: 500, validFrameCount: 0, gazeValidFrameCount: 0, gazeValidDurationMs: 0, gazeOffFrameCount: 0, gazeOffDurationMs: 0, gazeOff: null, smileScore: null, qualityReason: "camera_off" },
  ], summary: { gazeOffFrameRatio: 1, smileObservedFrameRatio: 0.8 } };
  value.turns[0].metrics = { vision: wholeSessionVision };
  const observed = buildEvaluationObservations(value).answers[0];
  const vision = observed.vision as { records: Array<{ turnId: string; gazeOff: null; smileScore: null }>; summary: { gazeOffFrameRatio: number | null; smileObservedFrameRatio: number | null } };
  assert.equal(vision.records.length, 1); assert.equal(vision.records[0].turnId, "turn-1");
  assert.equal(vision.records[0].gazeOff, null); assert.equal(vision.records[0].smileScore, null);
  assert.equal(vision.summary.gazeOffFrameRatio, null); assert.equal(vision.summary.smileObservedFrameRatio, null);
  assert.equal(observed.unavailable.vision, true);
  assert.equal(wholeSessionVision.records.length, 2); assert.equal(wholeSessionVision.summary.gazeOffFrameRatio, 1);
  value.turns[0].metrics = { vision: { method: "not_measured", records: [], summary: null } };
  const missing = buildEvaluationObservations(value).answers[0];
  assert.equal((missing.vision as { summary: null }).summary, null); assert.equal(missing.unavailable.vision, true);
});
test("actual client timing metadata takes priority while old metric records remain compatible", () => {
  const value = session();
  value.turns[0].metrics = { clientTimings: { submittedAt: 900 } };
  value.turns[0].metadata.clientTimings = { submittedAt: 0, finalizedAt: 250 };
  assert.deepEqual(buildEvaluationObservations(value).answers[0].clientTimings, { submittedAt: 0, finalizedAt: 250 });
  delete value.turns[0].metadata.clientTimings;
  assert.deepEqual(buildEvaluationObservations(value).answers[0].clientTimings, { submittedAt: 900 });
  delete value.turns[0].metrics;
  assert.equal(buildEvaluationObservations(value).answers[0].clientTimings, null);
});
test("evaluation stores actual observation limits and keeps unavailable concept scoring deferred", () => {
  const value = session("촉매를 비교했습니다."); value.turns[0].metadata.primaryFunction = "CONCEPT";
  const axis = { anchor: 4, quote: "촉매를 비교했습니다.", rationale: "실제 답변 인용" };
  const output = { summary: "관찰된 답변", languageClassifications: [], answers: [{ turnId: "turn-1", status: "SATISFIED", deferredReason: null, axes: { I: axis, A: axis, S: axis, R: axis, C: axis }, verifiedCoreError: false, verifiedCoreErrorEvidence: null, strengths: [], improvements: [], conflictNeedsReview: [], deliveryCoaching: [] }] };
  const context = { school: { schoolReferenceId: "school-1" } } as InterviewContext;
  const result = finalizeSessionEvaluation(output, context, value);
  assert.equal(result.answers[0].score, null); assert.equal(result.answers[0].status, "NOT_EVALUABLE");
  assert.equal(result.observations.answers[0].unavailable.providerConfidence, true);
  assert.equal(result.observations.answers[0].unavailable.vad, true);
  assert.equal(result.observations.answers[0].sttObservations?.[0].confidence, null);
  assert.equal(result.observations.sessionMetrics, null);
  assert.throws(() => finalizeSessionEvaluation({ ...output, answers: [] }, context, value));
});
