import test from "node:test";
import assert from "node:assert/strict";
import type { InterviewSession, RecordedTurn } from "../server/protocol";
import type { InterviewContext } from "../server/data/load-interview-context";
import { aggregateSessionEvaluation, type AggregationAnswer, type EvaluationQuestionPresentation } from "../server/providers/evaluation-aggregation";
import { evaluateSession, finalizeSessionEvaluation } from "../server/providers/openai";
import { reviewedKnowledgeBundle, reviewedRecordEvaluationFixture } from './fixtures/reviewed-evaluation-knowledge';

function turn(id: string, kind: RecordedTurn["questionKind"] = "main", root = id): RecordedTurn {
  return { id, questionKind: kind, parentMainQuestionId: root, questionText: "실제로 한 첫 단계를 설명해 주세요.", answerId: `answer-${id}`, rawTranscript: "온도를 먼저 측정했습니다.", transcriptStatus: "finalized", metadata: { primaryFunction: "PROCESS", questionIntent: "실제로 한 첫 단계를 확인한다.", targetEvidence: ["실제로 한 첫 단계"], depth: "D1" } } as RecordedTurn;
}
function presented(item: RecordedTurn, patch: Partial<EvaluationQuestionPresentation> = {}): EvaluationQuestionPresentation {
  return { turnId: item.id, rootTurnId: item.parentMainQuestionId, questionKind: item.questionKind, clockId: "synthetic-clock", startedAtMs: 100, completedAtMs: 200, ...patch };
}
function session(turns: RecordedTurn[], presentations: EvaluationQuestionPresentation[] | undefined = turns.map(item => presented(item))) {
  return { id: "synthetic-aggregation", status: "ending", turns, questionPresentations: presentations, metrics: {} } as InterviewSession;
}
function answer(id: string, score: number | null, status = score === null ? "NOT_EVALUABLE" : "PARTIAL"): AggregationAnswer { return { turnId: id, status, score, deferredReason: score === null ? "합성 기술 오류" : null }; }
function close(actual: number | null, expected: number) { assert.ok(actual !== null && Math.abs(actual - expected) < 1e-10, `${actual} ≠ ${expected}`); }
function modelAnswer(id: string, anchor = 2) {
  const axis = { anchor, quote: "온도를 먼저 측정했습니다.", rationale: "요구한 실제 첫 단계를 명시한 합성 답변이다." };
  return { turnId: id, status: "PARTIAL", deferredReason: null, axes: { I: { ...axis }, A: { ...axis }, S: { ...axis }, R: { ...axis }, C: { ...axis } }, verifiedCoreError: false, verifiedCoreErrorEvidence: null, strengths: [], improvements: [], conflictNeedsReview: [], deliveryCoaching: [] };
}
const context = { school: { schoolReferenceId: "synthetic-school" } } as InterviewContext;

for (const scores of [[81], [81, 92], [81, 92, 77]]) {
  test(`${scores.length - 1} actual evaluative follow-ups use the approved weights without intermediate rounding`, () => {
    const turns = scores.map((_, index) => turn(index ? `f${index}` : "q0", index ? "follow_up" : "main", "q0"));
    const value = session(turns), snapshot = JSON.stringify(value);
    const result = aggregateSessionEvaluation(value, scores.map((score, index) => answer(turns[index].id, score)));
    const expectedWeights = scores.length === 1 ? [1] : scores.length === 2 ? [0.7, 0.3] : [0.7, 0.15, 0.15];
    assert.deepEqual(result.clusterScores[0].members.map(member => member.weight), expectedWeights);
    close(result.clusterScores[0].score, scores.reduce((sum, score, index) => sum + score * expectedWeights[index], 0));
    assert.equal(result.sessionScore, null); assert.equal(result.aggregation.N_valid, 1);
    assert.equal(JSON.stringify(value), snapshot);
  });
}

test("a failed actual F2 excludes its entire cluster without renormalization or a synthetic zero", () => {
  const turns = [turn("q0"), turn("f1", "follow_up", "q0"), turn("f2", "follow_up", "q0")];
  turns[2].transcriptStatus = "error";
  const result = aggregateSessionEvaluation(session(turns), [answer("q0", 80), answer("f1", 90)], [{ turnId: "f2", reason: "TRANSCRIPTION_ERROR" }]);
  assert.equal(result.clusterScores[0].status, "CLUSTER_NOT_EVALUABLE"); assert.equal(result.clusterScores[0].score, null);
  assert.deepEqual(result.clusterScores[0].members.map(member => member.weight), [0.7, 0.15, 0.15]);
  assert.equal(result.clusterScores[0].members[2].score, null);
  assert.ok(result.clusterScores[0].exclusionReasons.some(reason => reason.code === "TRANSCRIPTION_ERROR"));
});

test("the 60% ratio and two valid cluster conditions apply together", () => {
  const cases = [{ total: 5, valid: 3, passes: true }, { total: 4, valid: 2, passes: false }, { total: 3, valid: 2, passes: true }, { total: 1, valid: 1, passes: false }];
  for (const item of cases) {
    const turns = Array.from({ length: item.total }, (_, index) => turn(`q${index}`));
    const result = aggregateSessionEvaluation(session(turns), turns.map((current, index) => answer(current.id, index < item.valid ? 80 : null)));
    assert.equal(result.sessionScore, item.passes ? 80 : null, JSON.stringify(item));
    assert.equal(result.aggregation.N_total, item.total); assert.equal(result.aggregation.N_valid, item.valid);
    assert.equal(result.partialReport, item.total !== item.valid);
  }
});

test("valid clusters are equally weighted regardless of their follow-up count", () => {
  const turns = [turn("q0"), turn("f1", "follow_up", "q0"), turn("q1")];
  const result = aggregateSessionEvaluation(session(turns), [answer("q0", 80), answer("f1", 90), answer("q1", 70)]);
  close(result.clusterScores[0].score, 83); close(result.sessionScore, 76.5);
  assert.equal(result.overallWeightedScore, result.sessionScore);
});

test("unstarted prepared candidates are absent from the denominator and F weights", () => {
  const turns = [turn("q0"), turn("q1"), turn("draft-main"), turn("draft-f", "follow_up", "q0")];
  for (const draft of turns.slice(2)) { delete draft.answerId; delete draft.rawTranscript; delete draft.transcriptStatus; }
  const result = aggregateSessionEvaluation(session(turns, [presented(turns[0]), presented(turns[1])]), [answer("q0", 80), answer("q1", 90)]);
  assert.equal(result.aggregation.N_total, 2); close(result.sessionScore, 85);
  assert.deepEqual(result.clusterScores[0].members.map(member => member.weight), [1]);
});

test("a started root lost from turn state remains in the denominator", () => {
  const q0 = turn("q0"), q1 = turn("q1"), lost = turn("lost");
  const result = aggregateSessionEvaluation(session([q0, q1], [presented(q0), presented(q1), presented(lost, { completedAtMs: null, interrupted: true })]), [answer("q0", 80), answer("q1", 90)]);
  assert.equal(result.aggregation.N_total, 3); assert.equal(result.aggregation.N_valid, 2); close(result.sessionScore, 85);
  assert.equal(result.partialReport, true);
  assert.ok(result.clusterScores[2].exclusionReasons.some(reason => reason.code === "QUESTION_RECORD_MISSING"));
});

test("an entire missing playback record cannot hide a captured main root", () => {
  const turns = [turn("q0"), turn("q1"), turn("q2")];
  const result = aggregateSessionEvaluation(session(turns, [presented(turns[0]), presented(turns[1])]), turns.map(current => answer(current.id, 80)));
  assert.equal(result.aggregation.N_total, 3); assert.equal(result.aggregation.N_valid, 2);
  assert.equal(result.partialReport, true); assert.equal(result.clusterScores[2].score, null);
  assert.ok(result.clusterScores[2].exclusionReasons.some(reason => reason.code === "CAPTURED_QUESTION_PRESENTATION_UNVERIFIED"));
  const missingAll = aggregateSessionEvaluation(session(turns, []), turns.map(current => answer(current.id, 80)));
  assert.equal(missingAll.aggregation.N_total, 3); assert.equal(missingAll.aggregation.N_valid, 0); assert.equal(missingAll.sessionScore, null);
});

test("corrupted non-evaluative flags cannot remove actually presented or captured evaluative roots", () => {
  const q0 = turn("q0"), f1 = turn("f1", "follow_up", "q0");
  q0.metadata.nonEvaluative = true; f1.metadata.nonEvaluative = true;
  for (const ledger of [[presented(q0), presented(f1)], []]) {
    const result = aggregateSessionEvaluation(session([q0, f1], ledger), [answer("q0", 80), answer("f1", 90)]);
    assert.equal(result.aggregation.N_total, 1); assert.equal(result.aggregation.N_valid, 0);
    assert.ok(result.clusterScores[0].exclusionReasons.some(reason => reason.code === "QUESTION_EVALUATION_IDENTITY_INVALID"));
  }
});

test("a caller-provided numeric score cannot make an errored or unfinished capture valid", () => {
  const q0 = turn("q0");
  for (const status of ["streaming", "paused", "error"] as const) {
    q0.transcriptStatus = status;
    const result = aggregateSessionEvaluation(session([q0]), [answer("q0", 80)]);
    assert.equal(result.clusterScores[0].score, null); assert.equal(result.aggregation.N_valid, 0);
  }
  const clarification = turn("c1", "clarification", "q0");
  clarification.metadata.nonEvaluative = true; clarification.metadata.clarificationOfTurnId = "q0";
  const repaired = aggregateSessionEvaluation(session([q0, clarification]), [answer("q0", 80)]);
  close(repaired.clusterScores[0].score, 80);
});

test("a presented F missing its turn record or a captured F missing presentation cannot disappear", () => {
  const q0 = turn("q0"), f1 = turn("f1", "follow_up", "q0");
  const missingTurn = aggregateSessionEvaluation(session([q0], [presented(q0), presented(f1)]), [answer("q0", 80)]);
  assert.equal(missingTurn.clusterScores[0].status, "CLUSTER_NOT_EVALUABLE");
  const missingPresentation = aggregateSessionEvaluation(session([q0, f1], [presented(q0)]), [answer("q0", 80), answer("f1", 90)]);
  assert.ok(missingPresentation.clusterScores[0].exclusionReasons.some(reason => reason.code === "CAPTURED_QUESTION_PRESENTATION_UNVERIFIED"));
});

test("a follow-up with no presented Q0 cannot create a valid cluster", () => {
  const q0 = turn("q0"), f1 = turn("f1", "follow_up", "q0");
  const result = aggregateSessionEvaluation(session([q0, f1], [presented(f1)]), [answer("q0", 80), answer("f1", 90)]);
  assert.equal(result.aggregation.N_total, 1); assert.equal(result.aggregation.N_valid, 0);
  assert.ok(result.clusterScores[0].exclusionReasons.some(reason => reason.code === "MAIN_QUESTION_NOT_PRESENTED"));
});

test("clarification adds no member or denominator while evaluative CLARIFY_CONTENT remains a follow-up", () => {
  const q0 = turn("q0"), f1 = turn("f1", "follow_up", "q0"), clarification = turn("c1", "clarification", "q0");
  f1.metadata.primaryFunction = "CLARIFY_CONTENT";
  const result = aggregateSessionEvaluation(session([q0, f1, clarification]), [answer("q0", 80), answer("f1", 90)]);
  assert.equal(result.aggregation.N_total, 1); assert.equal(result.clusterScores[0].members.length, 2); close(result.clusterScores[0].score, 83);
  const onlyClarification = aggregateSessionEvaluation(session([clarification]), []);
  assert.equal(onlyClarification.aggregation.N_total, 0);
});

test("more than two actual follow-ups invalidate the cluster", () => {
  const turns = [turn("q0"), ...[1, 2, 3].map(index => turn(`f${index}`, "follow_up", "q0"))];
  const result = aggregateSessionEvaluation(session(turns), turns.map(current => answer(current.id, 80)));
  assert.equal(result.clusterScores[0].score, null);
  assert.ok(result.clusterScores[0].exclusionReasons.some(reason => reason.code === "FOLLOW_UP_LIMIT_EXCEEDED"));
});

test("legacy sessions without a presentation ledger keep an explicitly unavailable denominator", () => {
  const value = session([turn("q0"), turn("q1")]); delete value.questionPresentations;
  const result = aggregateSessionEvaluation(value, [answer("q0", 80), answer("q1", 90)]);
  assert.equal(result.sessionScore, null); assert.equal(result.aggregation.N_total, null); assert.equal(result.aggregation.N_valid, null);
  assert.deepEqual(result.aggregation.reasonCodes, ["PRESENTATION_UNVERIFIED"]);
});

test("incomplete, interrupted, failed and clock-invalid presentation cannot score", () => {
  const q0 = turn("q0");
  for (const patch of [{ completedAtMs: null }, { interrupted: true }, { errorCodes: ["PLAYBACK_FAILED"] }, { completedAtMs: 50 }, { startedAtMs: null }, { clockId: undefined }]) {
    const result = aggregateSessionEvaluation(session([q0], [presented(q0, patch)]), [answer("q0", 80)]);
    assert.equal(result.aggregation.N_total, 1); assert.equal(result.aggregation.N_valid, 0); assert.equal(result.clusterScores[0].score, null);
  }
  const clockUnknown = aggregateSessionEvaluation(session([q0], [presented(q0, { clockId: undefined })]), [answer("q0", 80)]);
  assert.ok(clockUnknown.clusterScores[0].exclusionReasons.some(reason => reason.code === "PRESENTATION_CLOCK_UNVERIFIED"));
});

test("identical backup records deduplicate while conflicting records do not hide delivery faults", () => {
  const q0 = turn("q0"), original = presented(q0);
  const repeated = aggregateSessionEvaluation(session([q0], [original, { ...original }]), [answer("q0", 80)]);
  assert.equal(repeated.aggregation.N_total, 1); assert.equal(repeated.clusterScores[0].members.length, 1); close(repeated.clusterScores[0].score, 80);
  const conflict = aggregateSessionEvaluation(session([q0], [original, { ...original, clockId: "different-clock" }]), [answer("q0", 80)]);
  assert.equal(conflict.clusterScores[0].score, null);
});

test("missing, null, non-finite, out-of-range and duplicate scores never become zero", () => {
  const q0 = turn("q0");
  for (const rows of [[], [answer("q0", null)], [answer("q0", NaN)], [answer("q0", 101)], [answer("q0", 0, "unknown")], [answer("q0", 80), answer("q0", 90)]]) {
    const result = aggregateSessionEvaluation(session([q0]), rows);
    assert.equal(result.clusterScores[0].score, null); assert.equal(result.aggregation.N_valid, 0);
  }
  assert.equal(aggregateSessionEvaluation(session([q0]), [answer("q0", 0, "NOT_SATISFIED")]).clusterScores[0].score, 0);
});

test("final evaluation connects the latest rubric to cluster and session results", () => {
  const turns = [turn("q0"), turn("f1", "follow_up", "q0"), turn("q1")];
  turns[1].metadata.primaryFunction = "CLARIFY_CONTENT";
  const approved = reviewedRecordEvaluationFixture(context, session(turns));
  const result = finalizeSessionEvaluation({ summary: "합성 결과", answers: [modelAnswer("q0", 2), modelAnswer("f1", 4), modelAnswer("q1", 3)], languageClassifications: [] }, approved.context, approved.session);
  assert.equal(result.rulesVersion, "answer-v2.3"); close(result.sessionScore, 70); close(result.mainQuestionAverage, 62.5);
  assert.equal(result.answers[1].profile, "EXPERIENCE"); assert.equal(result.partialReport, false);
});

test("axis evidence and target metadata guards hold unsupported scores without claiming semantic verification", () => {
  const q0 = turn("q0"), draft = modelAnswer("q0"); draft.axes.A.quote = "";
  let result = finalizeSessionEvaluation({ summary: "합성 결과", answers: [draft], languageClassifications: [] }, context, session([q0]));
  assert.equal(result.answers[0].score, null); assert.equal(result.answers[0].grade, null);
  assert.ok(result.answers[0].holdReasons.includes("AXIS_EVIDENCE_MISSING"));
  q0.metadata.targetEvidence = [];
  result = finalizeSessionEvaluation({ summary: "합성 결과", answers: [modelAnswer("q0")], languageClassifications: [] }, context, session([q0]));
  assert.ok(result.answers[0].holdReasons.includes("QUESTION_TARGET_METADATA_MISSING"));
  assert.equal(result.answers[0].evaluationBasis.semanticSupportIndependentlyVerified, false);
});

test("missing reviewed scope remains held and a model core-error claim never overrides approved record consistency scope", () => {
  const q0 = turn("q0"), q1 = turn("q1"); q0.metadata.primaryFunction = "CONCEPT";
  const draft = modelAnswer("q1", 4); draft.verifiedCoreError = true;
  const approved = reviewedRecordEvaluationFixture(context, session([q0, q1]));
  approved.context.approvedKnowledge = reviewedKnowledgeBundle([], approved.context.approvedKnowledge!.bindings.filter(binding => binding.turnId !== 'q0'));
  const result = finalizeSessionEvaluation({ summary: "합성 결과", answers: [modelAnswer("q0"), draft], languageClassifications: [] }, approved.context, approved.session);
  assert.equal(result.answers[0].score, null); assert.equal(result.answers[1].score, 100);
  assert.equal(result.answers[1].verifiedCoreError, false); assert.equal(result.sessionScore, null);
});

test("empty finalized STT with playback completion still lacks proof of actual student nonresponse", async () => {
  const q0 = turn("q0"); q0.rawTranscript = "";
  const result = await evaluateSession(context, session([q0]));
  assert.deepEqual(result.answers, []); assert.equal(result.unscoredAnswers[0].score, null);
  assert.equal(result.clusterScores[0].score, null); assert.equal(result.aggregation.N_total, 1);
});
