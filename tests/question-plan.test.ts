import test from "node:test";
import assert from "node:assert/strict";
import { assertQuestionPresentation, assertReactionQuestionDraft, attachVerifiedQuestionPlan, questionFunctionContext, questionPlanDiagnostics, questionSpeechLimits } from "../server/providers/question-plan";
import { COMPACT_QUESTION_RULES, compactQuestionHistory } from "../server/providers/openai";
import { finalizeAnswerReaction } from "../server/providers/answer-reaction";
import { QuestionValidationError } from "../server/providers/question-grounding";
import { questionDraftSchema, type InterviewSession, type QuestionDraft, type RecordedTurn } from "../server/protocol";
import type { InterviewPlanSlot } from "../server/interview-planner";
import { zodTextFormat } from "openai/helpers/zod";

const slot: InterviewPlanSlot = { id: "main-slot-1", index: 1, topicArea: "problem_solving", label: "문제해결·선택", evidenceIds: ["E01"], activityIds: ["A01"], primaryFunction: "CHOICE", questionIntent: "기록된 조건을 선택한 판단 기준을 확인한다.", depth: "D2", interviewerId: "interviewer-1", interviewerRole: "academic", schoolConnections: [{ kind: "admission_criterion", label: "잠재역량", sourceIds: ["official-source"], rationale: "선택 기준과 연결하되 역량 보유를 전제하지 않는다." }] };
function session(): InterviewSession { return { id: "session", createdAt: "", updatedAt: "", status: "active", evaluationStatus: "pending", target: {}, sourceManifest: {}, elapsedMs: 0, turns: [], followUpCountByMainQuestion: {}, mainQuestionTarget: 2, plan: { policyVersion: "test-policy", durationSeconds: 720, mainQuestionTarget: 2, limitations: [], slots: [structuredClone(slot), { ...structuredClone(slot), id: "main-slot-2", index: 2, evidenceIds: ["E02"], activityIds: ["A02"] }] } }; }
function draft(): QuestionDraft { return { acknowledgement: null, acknowledgementQuote: null, questionText: "비교 조건을 선택한 이유는 무엇인가요?", questionKind: "main", parentMainQuestionId: null, evidenceIds: ["E01"], evidenceQuotes: [{ evidenceId: "E01", quote: "조건을 선택해 비교함." }], primaryFunction: "CHOICE", questionIntent: "비교 조건의 선택 기준 확인", targetEvidence: ["조건을 선택한 이유"], depth: "D2", groundingRationale: "실제 기록에서 비교 조건의 선택을 확인", validationStatus: "approved", validationFailures: [] }; }
function rootTurn(): RecordedTurn {
  const value = draft();
  return { id: "root", parentMainQuestionId: "root", mainIndex: 1, mainCount: 2, followUpIndex: 0, questionKind: "main", questionText: value.questionText, evidenceIds: value.evidenceIds,
    questionAudioUrl: "/api/audio/test", acknowledgement: null, acknowledgementAudioUrl: null, interviewerId: "interviewer-1",
    metadata: { ...value, rulesVersion: "test", generatedAt: "", answerTurnId: null, sourceRefIds: ["E01"], activityIds: ["A01"], supportTarget: {}, questionClusterId: "root", parentQuestionId: null } };
}
test("a main question receives only the server's actual slot and sourced school connections", () => {
  const value = draft(); attachVerifiedQuestionPlan(value, session());
  assert.equal(value.planSlotId, slot.id); assert.equal(value.topicArea, slot.topicArea);
  assert.deepEqual(value.schoolConnections, slot.schoolConnections); assert.notEqual(value.schoolConnections, slot.schoolConnections);
  assert.equal(JSON.stringify(zodTextFormat(questionDraftSchema, "question").schema).includes("schoolConnections"), false);
});

test('PROCESS accepts the actual way-of-planning wording without requiring the literal method keyword', () => {
  const value = session(); value.plan!.slots[0].primaryFunction = 'PROCESS';
  for (const questionText of ['설문조사를 어떤 방식으로 기획했는지 설명해 주세요.', '설문조사는 어떤 방식으로 기획했나요?']) {
    const candidate = { ...draft(), primaryFunction: 'PROCESS' as const, questionText, questionIntent: '설문을 기획한 방법을 확인한다.', targetEvidence: ['설문 기획 방식'] };
    assert.doesNotThrow(() => attachVerifiedQuestionPlan(candidate, value));
    assert.equal(questionPlanDiagnostics(candidate, value).spokenPurposeMatches, true);
    assert.throws(() => attachVerifiedQuestionPlan({ ...candidate, questionText: '설문을 기획한 계기는 무엇인가요?' }, value), error => error instanceof QuestionValidationError && error.code === 'PLAN_MISMATCH');
  }
});
test("wrong evidence, purpose, depth or actual task cannot bypass a planned main slot", () => {
  for (const change of [{ evidenceIds: ["E02"] }, { primaryFunction: "RESULT" as const }, { depth: "D4" as const }, { questionText: "관찰한 결과는 무엇인가요?" }]) {
    assert.throws(() => attachVerifiedQuestionPlan({ ...draft(), ...change }, session()), error => error instanceof QuestionValidationError && error.code === "PLAN_MISMATCH");
  }
});

test("LIMIT accepts interpretation-boundary equivalents from the rejected live candidate without requiring the literal word 한계", () => {
  const value = session();
  value.plan!.slots[0] = { ...value.plan!.slots[0], primaryFunction: "LIMIT", depth: "D3" };
  const candidate: QuestionDraft = { ...draft(), primaryFunction: "LIMIT", depth: "D3", questionText: "화학 평형과 착이온 색 변화 실험에서, 관찰한 붉은색 진하기만으로 평형 이동을 어디까지 해석할 수 있다고 보나요?", questionIntent: "화학 평형과 착이온 색 변화 실험에서 붉은색 진하기 관찰만으로 평형 이동을 해석할 수 있는 범위를 확인한다.", targetEvidence: ["붉은색 진하기 관찰만으로 평형 이동을 해석할 수 있는 범위"] };
  // E01 remains the synthetic local slot fixture; this test checks plan semantics, not PDF grounding.
  const checks = questionPlanDiagnostics(candidate, value);
  assert.equal(checks.spokenPurposeMatches, true); assert.equal(checks.metadataPurposeMatches, true);
  attachVerifiedQuestionPlan(candidate, value); assert.equal(candidate.planSlotId, slot.id);
  attachVerifiedQuestionPlan({ ...candidate, questionText: "평형 이동을 해석할 수 있는 범위는 어디까지라고 보나요?" }, value);
  for (const change of [{ evidenceIds: ["E02"] }, { primaryFunction: "PROCESS" as const }, { depth: "D4" as const }, { targetEvidence: ["해석할 수 있는 범위", "다른 요구"] }]) {
    assert.throws(() => attachVerifiedQuestionPlan({ ...candidate, ...change }, value), error => error instanceof QuestionValidationError && error.code === "PLAN_MISMATCH");
  }
});

test("LIMIT still rejects questions or metadata that only ask a process or evidence rather than an interpretation boundary", () => {
  const value = session(); value.plan!.slots[0] = { ...value.plan!.slots[0], primaryFunction: "LIMIT", depth: "D3" };
  const candidate: QuestionDraft = { ...draft(), primaryFunction: "LIMIT", depth: "D3", questionText: "붉은색 진하기만으로 평형 이동을 어디까지 해석할 수 있다고 보나요?", questionIntent: "평형 이동을 해석할 수 있는 범위를 확인한다.", targetEvidence: ["해석할 수 있는 범위"] };
  for (const otherTask of [
    { questionText: "붉은색 진하기의 변화는 어떤 순서로 해석했나요?", questionIntent: "붉은색 변화의 해석 과정을 확인한다.", targetEvidence: ["자료를 해석한 단계"] },
    { questionText: "평형 이동을 해석할 때 활용한 근거는 무엇인가요?", questionIntent: "해석을 뒷받침하는 관찰 근거를 확인한다.", targetEvidence: ["평형 이동 판단의 근거"] },
  ]) {
    assert.throws(() => attachVerifiedQuestionPlan({ ...candidate, questionText: otherTask.questionText }, value), error => error instanceof QuestionValidationError && error.code === "PLAN_MISMATCH");
    assert.throws(() => attachVerifiedQuestionPlan({ ...candidate, questionIntent: otherTask.questionIntent, targetEvidence: otherTask.targetEvidence }, value), error => error instanceof QuestionValidationError && error.code === "PLAN_MISMATCH");
  }
});
test("plan failure diagnostics distinguish surface and metadata checks without leaking question or source text", () => {
  const value = { ...draft(), questionText: "관찰한 결과는 무엇인가요?", questionIntent: "선택 기준 확인", targetEvidence: ["조건을 선택한 이유"] };
  const checks = questionPlanDiagnostics(value, session());
  assert.equal(checks.spokenPurposeMatches, false);
  assert.equal(checks.metadataPurposeMatches, true);
  assert.equal(checks.mainFunctionMatches, true);
  assert.equal(checks.evidenceIdsAllowed, true);
  assert.equal(checks.targetCount, 1);
  assert.ok(!JSON.stringify(checks).includes(value.questionText));
  assert.ok(!JSON.stringify(checks).includes(value.evidenceQuotes[0].quote));
  assert.ok(!JSON.stringify(checks).includes(value.questionIntent));
});
test("compact selected-function context restores its guide meaning and depth without the other fourteen definitions", () => {
  const selected = questionFunctionContext("EVIDENCE", "D2"), serialized = JSON.stringify(selected);
  assert.equal(selected.primaryFunction, "EVIDENCE");
  assert.match(selected.meaning, /무엇을 보고.+판단.+근거/);
  assert.match(selected.meaning, /결과 자체를 나열하도록 묻지/);
  assert.deepEqual(selected.depth, { code: "D2", meaning: "과정·판단 이유" });
  assert.deepEqual(selected.guidelineSections, [9, 10]);
  for (const otherCode of ["PROCESS", "RESULT", "CHOICE", "VERIFY_CLAIM", "D1", "D3", "D4"]) assert.ok(!serialized.includes(otherCode));
  assert.ok(serialized.length < 300);
  assert.match(questionFunctionContext("PROCESS", "D2").meaning, /실제로 수행한 순서나 방법/);
});
test("follow-ups keep the current root slot and cannot borrow the next main's unrelated evidence", () => {
  const value = session(); value.turns.push(rootTurn());
  const follow = { ...draft(), questionKind: "follow_up" as const, parentMainQuestionId: "root", primaryFunction: "EVIDENCE" as const };
  attachVerifiedQuestionPlan(follow, value); assert.equal(follow.planSlotId, "main-slot-1");
  assert.throws(() => attachVerifiedQuestionPlan({ ...follow, evidenceIds: ["E02"] }, value), error => error instanceof QuestionValidationError && error.code === "PLAN_MISMATCH");
  const next = { ...draft(), evidenceIds: ["E02"] }; attachVerifiedQuestionPlan(next, value); assert.equal(next.planSlotId, "main-slot-2");
});
test("a new wording cannot reopen an already covered activity and verification purpose as another main", () => {
  const value = session(); value.plan!.slots[1] = { ...structuredClone(slot), id: "main-slot-2", index: 2 };
  value.turns.push(rootTurn());
  assert.throws(() => attachVerifiedQuestionPlan({ ...draft(), questionText: "그 조건으로 결정할 때 고려한 기준은 무엇인가요?" }, value), error => error instanceof QuestionValidationError && error.code === "REPEATED_INTENT");
});
test("a required reconfirmation cannot silently become a main, an end, a different task or a different root", () => {
  const value = session(), root = rootTurn(); root.answerId = "answer"; root.rawTranscript = "죄송합니다."; root.transcriptStatus = "finalized"; value.turns.push(root);
  const reaction = finalizeAnswerReaction({ classification: "non_answer", action: "clarify", keywordQuote: null, reply: null, reasonCode: "APOLOGY_ONLY", evidenceSpan: null, missingTarget: null }, value, true);
  const follow: QuestionDraft = { ...draft(), questionText: "조건을 선택한 기준 한 가지를 말씀해 주세요.", questionKind: "clarification", parentMainQuestionId: root.id, primaryFunction: root.metadata.primaryFunction, questionIntent: root.metadata.questionIntent, targetEvidence: root.metadata.targetEvidence };
  assertReactionQuestionDraft(follow, value, reaction); attachVerifiedQuestionPlan(follow, value);
  assert.equal(follow.planSlotId, "main-slot-1"); assert.equal(follow.interviewerRole, root.metadata.interviewerRole ?? "academic");
  for (const change of [{ questionKind: "main" as const }, { questionKind: "follow_up" as const }, { questionKind: "end" as const }, { parentMainQuestionId: "different-root" }, { targetEvidence: ["새 요구"] }, { depth: "D4" as const }, { primaryFunction: "VALUE" as const }, { questionIntent: "추가 요구를 확인한다." }, { questionText: "어떤 결과를 얻었나요?" }]) assert.throws(() => assertReactionQuestionDraft({ ...follow, ...change }, value, reaction), QuestionValidationError);
  assert.throws(() => assertReactionQuestionDraft(follow, value, { ...reaction, sourceAnswerId: "stale-answer" }), QuestionValidationError);
});
test("a completed answer advances only to the next planned main rather than spending a follow-up quota", () => {
  const value = session(), root = rootTurn(); root.answerId = "answer"; root.rawTranscript = "출처와 작성 연도를 기준으로 선택했습니다."; root.transcriptStatus = "finalized"; value.turns.push(root);
  const reaction = finalizeAnswerReaction({ classification: "relevant", action: "proceed", keywordQuote: null, reply: null, reasonCode: "ANSWER_RELATED", evidenceSpan: null, missingTarget: null }, value, true);
  const next = { ...draft(), evidenceIds: ["E02"] }; assertReactionQuestionDraft(next, value, reaction); attachVerifiedQuestionPlan(next, value);
  assert.equal(next.planSlotId, "main-slot-2");
  assert.throws(() => assertReactionQuestionDraft({ ...next, questionKind: "follow_up" }, value, reaction), QuestionValidationError);
});
test("a new actual answer claim receives one VERIFY_CLAIM task in the existing root", () => {
  const value = session(), root = rootTurn(); root.answerId = "answer"; root.rawTranscript = "출처를 비교했습니다. 모든 조건에서 정확합니다."; root.transcriptStatus = "finalized"; value.turns.push(root);
  const reaction = finalizeAnswerReaction({ classification: "partial", action: "probe", keywordQuote: "모든 조건에서 정확합니다", reply: null, reasonCode: "CLAIM_REQUIRES_DETAIL", evidenceSpan: null, missingTarget: null }, value, true);
  const follow: QuestionDraft = { ...draft(), questionKind: "follow_up", parentMainQuestionId: root.id, primaryFunction: "VERIFY_CLAIM", questionText: "그 판단을 뒷받침하는 구체적인 근거 한 가지는 무엇인가요?", depth: "D2", targetEvidence: [reaction.missingTarget!] };
  assertReactionQuestionDraft(follow, value, reaction); attachVerifiedQuestionPlan(follow, value); assert.equal(follow.planSlotId, "main-slot-1");
  assert.throws(() => assertReactionQuestionDraft({ ...follow, primaryFunction: "CLARIFY_CONTENT" }, value, reaction), QuestionValidationError);
});
test("new speech budgets require one actual target and reject long or compound main questions", () => {
  assertQuestionPresentation(draft());
  assert.equal(questionSpeechLimits.main, 100);
  assert.throws(() => assertQuestionPresentation({ ...draft(), questionText: "가".repeat(101) }), QuestionValidationError);
  assert.throws(() => assertQuestionPresentation({ ...draft(), targetEvidence: ["수행 순서", "결과의 의미"] }), QuestionValidationError);
  assert.throws(() => assertQuestionPresentation({ ...draft(), questionText: "선택 기준은 무엇이며 왜 그런 결과가 나왔나요?" }), QuestionValidationError);
  assertQuestionPresentation({ ...draft(), questionKind: "clarification", targetEvidence: ["기존 의미 요소1", "기존 의미 요소2"] });
});
test("worker context keeps current-root details but omits unrelated raw answers and the full guideline", () => {
  const value = session(), first = rootTurn(); first.rawTranscript = "UNRELATED_PRIVATE_ANSWER";
  const current: RecordedTurn = { ...rootTurn(), id: "root2", parentMainQuestionId: "root2", mainIndex: 2, rawTranscript: "현재 질문의 실제 답변", transcriptStatus: 'finalized' };
  value.turns.push(first, current);
  const history = compactQuestionHistory(value), serialized = JSON.stringify(history);
  assert.ok(!serialized.includes("UNRELATED_PRIVATE_ANSWER")); assert.ok(serialized.includes("현재 질문의 실제 답변"));
  current.transcriptStatus = 'error';
  assert.ok(!JSON.stringify(compactQuestionHistory(value)).includes('현재 질문의 실제 답변'));
  assert.ok(COMPACT_QUESTION_RULES.length < 1800); assert.match(COMPACT_QUESTION_RULES, /전문 명사·수식어·숫자·단위/);
  assert.match(COMPACT_QUESTION_RULES, /순수 clarification/); assert.match(COMPACT_QUESTION_RULES, /S\/A/);
});
