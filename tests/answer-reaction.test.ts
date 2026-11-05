import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { zodTextFormat } from "openai/helpers/zod";
import { AnswerReactionError, finalizeAnswerReaction, reactToAnswer, reactionRequest, reactionQuoteOptions, reactionWireSchema } from "../server/providers/answer-reaction";
import type { InterviewContext } from "../server/data/load-interview-context";
import type { InterviewSession, RecordedTurn } from "../server/protocol";
import { BRIDGE_POLICY_VERSION, topicBridgeTexts } from "../server/providers/acknowledgement-phrases";

function session(answer = "조건을 비교했습니다.", question = "자료를 선택한 기준은 무엇인가요?"): InterviewSession {
  return { turns: [{ id: "q0", answerId: "answer", parentMainQuestionId: "q0", mainIndex: 1, mainCount: 5, questionKind: "main", followUpIndex: 0, interviewerId: "interviewer-1", questionText: question, rawTranscript: answer, transcriptStatus: "finalized", sttObservations: [{ confidence: null }], metadata: { primaryFunction: "CHOICE", questionIntent: "자료를 선택한 기준 확인", targetEvidence: ["선택 기준", "구체적 행동"], depth: "D2" } } as RecordedTurn], elapsedMs: 0, followUpCountByMainQuestion: {} } as InterviewSession;
}
const model = (changes: Record<string, unknown> = {}) => ({ classification: "relevant", action: "proceed", keywordQuote: null, reply: null, reasonCode: changes.classification === "partial" ? "MISSING_REQUESTED_DETAIL" : "ANSWER_RELATED", evidenceSpan: null, missingTarget: null, ...changes });
const context = { student: { evidence: [{ text: "DO_NOT_SEND_PRIVATE_PDF" }] }, school: { private: "DO_NOT_SEND_SCHOOL_CATALOG" } } as unknown as InterviewContext;

test("whole greetings, apologies, unrelated numbers, abuse and exact question echoes use no model", async () => {
  for (const answer of ["안녕하세요.", "죄송합니다.", "12345", "씨발", "자료를 선택한 기준은 무엇인가요?"]) {
    const value = session(answer);
    const reaction = await reactToAnswer(context, value, true, { request: async () => { throw new Error("Obvious non-answer must not call a model"); } });
    assert.equal(reaction.directive, "clarification_same_target"); assert.equal(reaction.action, "clarify"); assert.equal(reaction.origin, "deterministic");
    assert.equal(reaction.keywordQuote, null); assert.equal(reaction.sourceTurnId, "q0"); assert.equal(reaction.sourceAnswerId, "answer");
  }
});
test("a substantive answer with a greeting or apology prefix is still semantically classified", async () => {
  for (const answer of ["안녕하세요. 자료의 작성 연도를 비교했습니다.", "죄송합니다만 출처가 명확한 자료를 선택했습니다."]) {
    let calls = 0;
    const reaction = await reactToAnswer(context, session(answer), true, { request: async () => { calls++; return model(); } });
    assert.equal(calls, 1); assert.equal(reaction.directive, "next_main");
  }
});
test("valid negative existence answers and requested numeric values are not treated as nonsense", async () => {
  for (const [answer, question] of [["없었습니다.", "이 경험이 진로 관심과 연결된 부분이 있었나요?"], ["아니요.", "다른 기준도 있었나요?"], ["3", "실험은 몇 번 수행했나요?"], ["3.14", "원주율의 값은 얼마인가요?"]]) {
    let calls = 0;
    const reaction = await reactToAnswer(context, session(answer, question), true, { request: async () => { calls++; return model(); } });
    assert.equal(calls, 1); assert.equal(reaction.classification, "relevant"); assert.equal(reaction.action, "proceed");
  }
});
test("reaction request is short, reasoning-none, model-preserving and excludes student/school material", async () => {
  const value = session(); let calls = 0;
  const reaction = await reactToAnswer(context, value, true, { request: async request => {
    calls++; assert.equal(request.model, process.env.OPENAI_QUESTION_MODEL || "gpt-6-luna"); assert.equal(request.reasoning.effort, "none"); assert.equal(request.max_output_tokens, 600);
    assert.equal(request.store, false); assert.ok(!request.input.includes("DO_NOT_SEND"));
    const payload = JSON.parse(request.input); assert.deepEqual(Object.keys(payload).sort(), ["answer", "question"]);
    assert.match(request.instructions, /과학적 정답/); assert.match(request.instructions, /confidence가 null/);
    await sleep(5); return model();
  } });
  assert.equal(calls, 1); assert.ok(reaction.durationMs >= 0);
});
test("partial answers focus on an actual answer quote, and an identical repeated answer is not chased twice", () => {
  const value = session(), initial = finalizeAnswerReaction(model({ classification: "partial", missingTarget: "선택 기준", keywordQuote: "조건을 비교했습니다", reasonCode: "MISSING_REQUESTED_DETAIL" }), value, true);
  assert.equal(initial.action, "probe"); assert.equal(initial.directive, "follow_up_missing_target");
  value.turns[0].metadata.answerReaction = initial;
  value.turns.push({ ...value.turns[0], id: "f1", answerId: "f1-answer", followUpIndex: 1, metadata: { ...value.turns[0].metadata, targetEvidence: ["선택 기준"] } });
  const repeated = finalizeAnswerReaction(model({ classification: "partial", missingTarget: "선택 기준", keywordQuote: "조건을 비교했습니다" }), value, true);
  assert.equal(repeated.action, "transition"); assert.equal(repeated.reasonCode, "MISSING_TARGET_ALREADY_PROBED");
});
test("off-topic reconfirmation stays in the current root once, then transitions with a recorded reason", () => {
  const value = session("안녕하세요."), initial = finalizeAnswerReaction(model(), value, true);
  value.turns[0].metadata.answerReaction = initial;
  value.turns.push({ ...value.turns[0], id: "f1", answerId: "f1-answer", followUpIndex: 1 });
  const repeated = finalizeAnswerReaction(model(), value, true);
  assert.equal(repeated.directive, "next_main"); assert.equal(repeated.reasonCode, "RECONFIRMATION_ALREADY_USED");
  const noBudget = finalizeAnswerReaction(model(), session("죄송합니다."), false);
  assert.equal(noBudget.classification, "non_answer"); assert.equal(noBudget.reasonCode, "CLARIFICATION_BUDGET_EXHAUSTED");
});
test("the last main's non-answer still receives a permitted non-evaluative clarification", () => {
  const value = session("죄송합니다."); value.turns[0].mainIndex = 5;
  assert.equal(finalizeAnswerReaction(model(), value, true).directive, "clarification_same_target");
  assert.equal(finalizeAnswerReaction(model(), value, false).directive, "next_main");
});
test("an absent provider confidence is not a technical STT error", () => {
  const reaction = finalizeAnswerReaction(model({ classification: "possible_stt_error", reasonCode: "TECHNICAL_TRANSCRIPT_SIGNAL" }), session(), true);
  assert.equal(reaction.classification, "unclear"); assert.equal(reaction.reasonCode, "UNINTELLIGIBLE_CONTENT");
  const realSignal = finalizeAnswerReaction(model({ classification: "possible_stt_error", reasonCode: "TECHNICAL_TRANSCRIPT_SIGNAL" }), session("전사가 잘못됐습니다."), true);
  assert.equal(realSignal.classification, "possible_stt_error");
});
test("invented answer quotes, offsets, new tasks and unsupported reply associations are rejected", () => {
  assert.throws(() => finalizeAnswerReaction(model({ reasonCode: "NO_SEMANTIC_CONNECTION" }), session(), true), error => error instanceof AnswerReactionError && error.code === "INVALID_REACTION");
  assert.throws(() => finalizeAnswerReaction(model({ keywordQuote: "없는 결과" }), session(), true), error => error instanceof AnswerReactionError && error.code === "UNVERIFIED_REACTION_QUOTE");
  assert.throws(() => finalizeAnswerReaction(model({ keywordQuote: "조건", evidenceSpan: { start: 1, end: 3 } }), session(), true), AnswerReactionError);
  assert.throws(() => finalizeAnswerReaction(model({ classification: "partial", missingTarget: "새로운 논문의 정확성" }), session(), true), error => error instanceof AnswerReactionError && error.code === "INVALID_REACTION_TARGET");
  const reaction = finalizeAnswerReaction(model({ keywordQuote: "조건", reply: "조건을 바꿔 수상하셨군요." }), session(), true);
  assert.equal(reaction.reply, null); assert.equal(reaction.keywordQuote, null);
});
test("a valid quote remains an exact original span and never judges truth or awards points", () => {
  const reaction = finalizeAnswerReaction(model({ keywordQuote: "조건", reply: "말씀하신 ‘조건’에 관한 설명을 들었습니다." }), session(), true);
  assert.ok(reaction.reply === null || topicBridgeTexts("조건").includes(reaction.reply));
  assert.equal(reaction.bridge?.policyVersion, BRIDGE_POLICY_VERSION);
  assert.equal(reaction.bridge?.selection, "seeded_shuffle");
  assert.deepEqual(reaction.evidenceSpan, { start: 0, end: 2 });
  assert.equal(reactionRequest(session()).input.includes("DO_NOT_SEND"), false);
});
test("a fulfilled original request can still probe an actual new claim without calling it false", () => {
  const value = session("출처와 연도를 비교했습니다. 모든 조건에서 정확합니다.");
  const reaction = finalizeAnswerReaction(model({ classification: "partial", reasonCode: "CLAIM_REQUIRES_DETAIL", keywordQuote: "모든 조건에서 정확합니다" }), value, true);
  assert.equal(reaction.directive, "follow_up_missing_target"); assert.equal(reaction.probeBasis, "answer_claim");
  assert.ok(reaction.missingTarget!.includes(reaction.keywordQuote!)); assert.equal(reaction.reply, null);
  assert.ok(reaction.evidenceSpan); assert.equal(reaction.bridge?.suppressionReason, "follow_up_direct");
  assert.throws(() => finalizeAnswerReaction(model({ classification: "partial", reasonCode: "CLAIM_REQUIRES_DETAIL" }), value, true), error => error instanceof AnswerReactionError && error.code === "UNVERIFIED_REACTION_QUOTE");
});
test("reaction quote options are short source spans and preserve numeric wording", () => {
  const raw = "발행 기관과 작성 연도를 비교했습니다. 모든 조건을 백퍼센트 확정할 수 있습니다.";
  const options = reactionQuoteOptions(raw); assert.ok(options.length > 0);
  for (const quote of options) { assert.ok(quote.length >= 2 && quote.length <= 28); assert.ok(raw.includes(quote)); assert.ok(!quote.includes("100%")); }
});
test("model wire limits quotes to offered exact options and prohibits generated offsets", () => {
  const value = session("이 자료 하나만으로 모든 조건의 값을 오차 없이 확정할 수 있습니다."), options = reactionQuoteOptions(value.turns[0].rawTranscript!);
  const wire = reactionWireSchema(value);
  assert.equal(wire.safeParse({ decision: model({ keywordQuote: options[0] }) }).success, true);
  assert.equal(wire.safeParse({ decision: model({ keywordQuote: "존재하지 않는 인용" }) }).success, false);
  assert.equal(wire.safeParse({ decision: model({ evidenceSpan: { start: 0, end: 2 } }) }).success, false);
  assert.equal(reactionWireSchema(session("")).safeParse({ decision: model({ keywordQuote: "없는 인용" }) }).success, false);
});

test("model wire correlates decision reasons and actions, restricts targets, and excludes server-owned reasons", () => {
  const wire = reactionWireSchema(session());
  assert.equal(wire.safeParse({ decision: model({ reasonCode: "NO_SEMANTIC_CONNECTION" }) }).success, false);
  assert.equal(wire.safeParse({ decision: model({ action: "probe" }) }).success, false);
  assert.equal(wire.safeParse({ decision: model({ missingTarget: "모델이 만든 새로운 요구" }) }).success, false);
  for (const reasonCode of ["RECONFIRMATION_ALREADY_USED", "MISSING_TARGET_ALREADY_PROBED", "FOLLOW_UP_BUDGET_EXHAUSTED", "CLARIFICATION_BUDGET_EXHAUSTED", "REACTION_VALIDATION_FAILED"]) assert.equal(wire.safeParse({ decision: model({ reasonCode }) }).success, false);
  assert.equal(wire.safeParse({ decision: model({ classification: "off_topic", action: "clarify", reasonCode: "NO_SEMANTIC_CONNECTION" }) }).success, true);
  assert.equal(wire.safeParse({ decision: model({ classification: "partial", action: "probe", missingTarget: "선택 기준" }) }).success, true);
  const format = zodTextFormat(wire, "answer_reaction");
  assert.equal(format.schema.type, "object"); assert.equal(format.schema.anyOf, undefined);
  assert.doesNotMatch(JSON.stringify(format.schema), /REACTION_VALIDATION_FAILED|RECONFIRMATION_ALREADY_USED/);
});

test("invalid model reaction repairs once using logical feedback and preserves the final answer", async () => {
  const value = session(), original = value.turns[0].rawTranscript;
  let calls = 0; const observations: unknown[] = [];
  const reaction = await reactToAnswer(context, value, true, { onAttempt: observation => { observations.push(observation); }, request: async request => {
    calls++;
    const payload = JSON.parse(request.input);
    if (calls === 1) { assert.equal(payload.repair, undefined); return model({ reasonCode: "NO_SEMANTIC_CONNECTION" }); }
    assert.deepEqual(payload.repair, { attempt: 2, previousFailure: "INVALID_REACTION" });
    assert.equal(payload.answer.finalTranscript, original);
    return { decision: model() };
  } });
  assert.equal(calls, 2); assert.equal(reaction.origin, "model"); assert.equal(reaction.classification, "relevant");
  assert.deepEqual(reaction.recovery, { status: "repaired", modelAttempts: 2, validationFailures: ["INVALID_REACTION"] });
  assert.equal(value.turns[0].rawTranscript, original); assert.equal(observations.length, 2);
  assert.ok(!JSON.stringify(observations).includes(original!));
});

test("two invalid reactions fall back to one non-evaluative clarification without misclassifying the answer", async () => {
  const value = session(), original = value.turns[0].rawTranscript; let calls = 0;
  const fallback = await reactToAnswer(context, value, false, { allowClarification: true, request: async () => { calls++; return calls === 1 ? model({ keywordQuote: "없는 인용" }) : model({ missingTarget: "없는 질문 표적" }); } });
  assert.equal(calls, 2); assert.equal(fallback.origin, "fallback"); assert.equal(fallback.classification, "unassessed");
  assert.equal(fallback.reasonCode, "REACTION_VALIDATION_FAILED"); assert.equal(fallback.directive, "clarification_same_target");
  assert.equal(fallback.keywordQuote, null); assert.equal(fallback.evidenceSpan, null); assert.equal(fallback.probeBasis, null);
  assert.deepEqual(fallback.recovery, { status: "fallback", modelAttempts: 2, validationFailures: ["UNVERIFIED_REACTION_QUOTE", "INVALID_REACTION_TARGET"] });
  assert.equal(value.turns[0].rawTranscript, original); assert.deepEqual(value.followUpCountByMainQuestion, {});
  assert.equal(fallback.reply, null); assert.equal(fallback.bridge?.kind, "unassessed");
  assert.equal(fallback.bridge?.suppressionReason, "technical_uncertainty");
  value.turns[0].metadata.answerReaction = fallback;
  value.turns.push({ ...value.turns[0], id: "c1", answerId: "c1-answer", questionKind: "clarification", metadata: { ...value.turns[0].metadata } });
  const repeated = await reactToAnswer(context, value, false, { allowClarification: true, request: async () => null });
  assert.equal(repeated.origin, "fallback"); assert.equal(repeated.directive, "next_main"); assert.equal(repeated.reasonCode, "RECONFIRMATION_ALREADY_USED");
  assert.equal(repeated.classification, "unassessed"); assert.equal(repeated.keywordQuote, null); assert.deepEqual(value.followUpCountByMainQuestion, {});
});

test("reaction fallback obeys the clarification budget and cannot be selected by a model", async () => {
  const value = session();
  const fallback = await reactToAnswer(context, value, true, { allowClarification: false, request: async () => null });
  assert.equal(fallback.directive, "next_main"); assert.equal(fallback.reasonCode, "CLARIFICATION_BUDGET_EXHAUSTED");
  assert.equal(fallback.classification, "unassessed"); assert.equal(fallback.recovery?.status, "fallback");
  assert.throws(() => finalizeAnswerReaction(model({ classification: "unassessed", reasonCode: "REACTION_VALIDATION_FAILED" }), value, true), AnswerReactionError);
});

test("parser output errors get only one repair while real provider errors and unfinalized answers retain their cause", async () => {
  let calls = 0;
  const repaired = await reactToAnswer(context, session(), true, { request: async () => { if (++calls === 1) throw new SyntaxError("invalid model JSON"); return { decision: model() }; } });
  assert.equal(calls, 2); assert.equal(repaired.recovery?.status, "repaired");
  for (const afterValidation of [false, true]) {
    calls = 0; const providerError = Object.assign(new Error("provider transport/authentication failure"), { status: 401 });
    await assert.rejects(reactToAnswer(context, session(), true, { request: async () => { calls++; if (afterValidation && calls === 1) return null; throw providerError; } }), error => error === providerError);
    assert.equal(calls, afterValidation ? 2 : 1);
  }
  calls = 0; const unfinalized = session(); unfinalized.turns[0].transcriptStatus = "streaming";
  await assert.rejects(reactToAnswer(context, unfinalized, true, { request: async () => { calls++; return model(); } }), error => error instanceof AnswerReactionError && error.code === "NO_FINAL_ANSWER");
  assert.equal(calls, 0);
});
test("a finalized empty answer gets one non-evaluative clarification independently of follow-up budget", async () => {
  const value = session("");
  const reaction = await reactToAnswer(context, value, false, { allowClarification: true, request: async () => { throw new Error("Silence needs no model call"); } });
  assert.equal(reaction.reasonCode, "NO_ANSWER"); assert.equal(reaction.directive, "clarification_same_target");
  assert.match(reaction.reply!, /^(?:잠시 생각하셔도 괜찮습니다|생각이 정리되면 말씀해 주세요|조금 더 생각하셔도 됩니다)\.$/u);
  assert.equal(reaction.bridge?.kind, "silence"); assert.equal(reaction.keywordQuote, null); assert.equal(reaction.evidenceSpan, null);
  assert.doesNotMatch(reaction.reply!, /마이크|오류|고장|못\s*들/u);
});
test("unable to recall is distinct from silence, off-topic speech and a technical error", async () => {
  for (const answer of ["모르겠습니다.", "기억이 안 납니다.", "잘 모르겠어요."]) {
    const reaction = await reactToAnswer(context, session(answer), true, { allowClarification: true, request: async () => { throw new Error("Literal recall answer needs no model"); } });
    assert.equal(reaction.reasonCode, "UNABLE_TO_RECALL"); assert.equal(reaction.classification, "non_answer"); assert.equal(reaction.action, "transition");
  }
});
test("a label-only sequence is a question echo, not a newly evaluative detail request", async () => {
  const reaction = await reactToAnswer(context, session("1차 2차 3차 순서로 진행했습니다.", "자료를 어떤 순서로 처리했나요?"), true, { allowClarification: true, request: async () => { throw new Error("A label-only sequence needs no model"); } });
  assert.equal(reaction.reasonCode, "QUESTION_ECHO_ONLY"); assert.equal(reaction.directive, "clarification_same_target");
});
test("new substantive details are not discarded just because the old broad target is unchanged", () => {
  const value = session("자료를 비교했습니다.", "자료를 어떤 순서로 처리했나요?"); value.turns[0].metadata.primaryFunction = "PROCESS";
  const first = finalizeAnswerReaction(model({ classification: "partial", keywordQuote: "자료를 비교했습니다", missingTarget: "선택 기준" }), value, true);
  value.turns[0].metadata.answerReaction = first;
  value.turns.push({ ...value.turns[0], id: "f1", answerId: "f1-answer", questionKind: "follow_up", rawTranscript: "날씨 자료를 정리하고 근사식을 얻은 뒤 그래프를 그렸습니다.", metadata: { ...value.turns[0].metadata } });
  const next = finalizeAnswerReaction(model({ classification: "partial", keywordQuote: "근사식을 얻은 뒤", missingTarget: "선택 기준" }), value, true);
  assert.equal(next.directive, "follow_up_missing_target"); assert.equal(next.probeBasis, "answer_detail");
  assert.equal(next.requestedTarget, "선택 기준"); assert.notEqual(next.reasonCode, "MISSING_TARGET_ALREADY_PROBED");
  assert.ok(next.missingTarget!.includes(next.keywordQuote!)); assert.equal(next.reply, null);
  assert.equal(next.bridge?.suppressionReason, "follow_up_direct");
  const fulfilled = finalizeAnswerReaction(model(), value, true); assert.equal(fulfilled.directive, "next_main");
});

test("the current source reaction never changes a retry choice, and later answers avoid its sentence family", () => {
  const value = session("온도 조건을 비교했습니다."); value.id = "bridge-retry-session";
  let previousFamily: string | null = null;
  const seen = new Set<string>();
  for (let answer = 0; answer < 24; answer++) {
    const current = value.turns.at(-1)!;
    const quote = `${answer % 2 ? "역할 분담" : "온도 조건"} ${answer}`;
    current.rawTranscript = `${quote}을 비교했습니다.`;
    const candidate = model({ keywordQuote: quote });
    const chosen = finalizeAnswerReaction(candidate, value, true);
    assert.equal(chosen.classification, "relevant"); assert.equal(chosen.reasonCode, "ANSWER_RELATED");
    assert.equal(chosen.keywordQuote, quote); assert.ok(chosen.evidenceSpan);
    assert.notEqual(chosen.bridge?.family, previousFamily);
    assert.ok(chosen.bridge?.templateId); seen.add(chosen.bridge.templateId);
    current.metadata.answerReaction = chosen;
    assert.deepEqual(finalizeAnswerReaction(candidate, value, true), chosen);
    previousFamily = chosen.bridge.family;
    value.turns.push({ ...current, id: `q${answer + 1}`, answerId: `a${answer + 1}`, parentMainQuestionId: `q${answer + 1}`, acknowledgement: chosen.reply, metadata: { ...current.metadata } });
  }
  assert.equal(seen.size, 4);
});
