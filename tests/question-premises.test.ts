import test from "node:test";
import assert from "node:assert/strict";
import { zodTextFormat } from "openai/helpers/zod";
import type { QuestionDraft } from "../server/protocol";
import { questionDraftSchema } from "../server/protocol";
import { findVerifiedSourceQuote, generateWithVerifiedGrounding, QuestionPreparationError, QuestionValidationError, sourceQuoteForDisplay } from "../server/providers/question-grounding";
import { buildQuestionPremiseReviewInput, finalizeQuestionPremiseReview, premiseSupportQuoteOptions, QuestionPremiseReviewError, questionPremiseReviewSchema, questionPremiseReviewWireSchema, validateQuestionPremises, type PremiseAnswerSource } from "../server/providers/question-premises";

const sources = [{ id: "E01", text: "친구들과 토론하며 방송 프로그램에 퀴즈를 도입함. 청취율 수치는 측정하지 않음." }, { id: "E02", text: "두 용액의 농도를 30mg으로 기록하고 비교함." }];
function draft(questionText = "방송 프로그램에 퀴즈를 도입한 이유는 무엇인가요?"): QuestionDraft {
  return { acknowledgement: null, acknowledgementQuote: null, questionText, questionKind: "main", parentMainQuestionId: null, evidenceIds: ["E01"], evidenceQuotes: [{ evidenceId: "E01", quote: sources[0].text }], primaryFunction: "CHOICE", questionIntent: "퀴즈를 선택한 이유 확인", targetEvidence: ["퀴즈 도입 이유"], depth: "D2", groundingRationale: "실제 기록에 퀴즈 도입이 명시됨", validationStatus: "approved", validationFailures: [] };
}
function allowed() {
  return { verdict: "allowed" as const, completeAssertionCoverage: true, coreIntentCount: 1, intentMatches: true, clarificationPreservesIntent: true, premises: [{ questionSpan: "방송 프로그램에 퀴즈를 도입", basis: "record" as const, sourceId: "E01", supportQuote: sources[0].text, supported: true }] };
}
function code(expected: string) { return (error: unknown) => error instanceof QuestionValidationError && error.code === expected; }
function finalize(output: unknown, value = draft()) { return finalizeQuestionPremiseReview(output, buildQuestionPremiseReviewInput(value, sources), "test-review-model"); }

test("independent review binds actual spoken spans to exact source ID/offset proofs without storing text", async () => {
  const value = draft(); let calls = 0;
  await validateQuestionPremises({ draft: value, sources, reviewModel: "test-review-model", requestReview: async input => { calls++; assert.equal(input.question.questionText, value.questionText); return allowed(); } });
  assert.equal(calls, 1); const trace = value.premiseValidation!;
  assert.equal(trace.guidelineVersion, "2.3"); assert.equal(trace.method, "bounded_semantic_review"); assert.equal(trace.questionSha256.length, 64);
  const proof = trace.supportedPremises[0];
  assert.equal(value.questionText.slice(proof.questionStartOffset, proof.questionEndOffset), allowed().premises[0].questionSpan);
  assert.equal(sources[0].text.slice(proof.sourceStartOffset, proof.sourceEndOffset), sources[0].text);
  const serialized = JSON.stringify(trace);
  assert.ok(!serialized.includes(sources[0].text)); assert.ok(!serialized.includes(allowed().premises[0].questionSpan)); assert.ok(!serialized.includes("supportQuote"));
  assert.equal(JSON.stringify(zodTextFormat(questionDraftSchema, "question").schema).includes("premiseValidation"), false);
  assert.ok(zodTextFormat(questionPremiseReviewSchema, "review").schema);
});

test("a valid source quote cannot overrule an independent unsupported or uncertain semantic verdict", () => {
  // These are semantic-review boundary tests; fake verdicts do not prove model accuracy.
  for (const question of ["팀 갈등을 해결할 때 어떤 기준을 세웠나요?", "본인이 청취율을 30% 높인 근거는 무엇인가요?", "퀴즈 도입으로 참여도가 높아진 이유는 무엇인가요?", "개발한 방송 시스템의 원리는 무엇인가요?"]) {
    assert.throws(() => finalize({ ...allowed(), verdict: "rewrite" }, draft(question)), code("PREMISE_UNSUPPORTED"));
  }
  assert.throws(() => finalize({ ...allowed(), verdict: "uncertain" }), code("PREMISE_UNCERTAIN"));
  assert.throws(() => finalize({ ...allowed(), completeAssertionCoverage: false }), code("PREMISE_UNCERTAIN"));
});

test("forged allowed verdict still fails on absent question spans, swapped IDs and invented source quotes", () => {
  for (const change of [{ questionSpan: "없는 발화" }, { sourceId: "E02" }, { sourceId: "invented" }, { supportQuote: "친구들과 갈등을 해결함." }, { supportQuote: null }, { supported: false }]) {
    assert.throws(() => finalize({ ...allowed(), premises: [{ ...allowed().premises[0], ...change }] }), QuestionValidationError);
  }
  assert.throws(() => finalize({ ...allowed(), premises: [] }), code("PREMISE_REVIEW_INVALID"));
  assert.throws(() => finalize({ ...allowed(), extra: "self approval" }), code("PREMISE_REVIEW_INVALID"));
  const brokenCitation = draft(); brokenCitation.evidenceQuotes[0].quote = "없는 내용을 기록함.";
  assert.throws(() => buildQuestionPremiseReviewInput(brokenCitation, sources), code("CITATION_NOT_FOUND"));
});

test('review wire correlates each actual source ID with its own verbatim quotation choices', () => {
  const value = { ...draft(), evidenceIds: ['E01', 'E02'], evidenceQuotes: sources.map(source => ({ evidenceId: source.id, quote: source.text })) };
  const input = buildQuestionPremiseReviewInput(value, sources), wire = questionPremiseReviewWireSchema(input);
  assert.equal(wire.safeParse(allowed()).success, true);
  for (const change of [{ sourceId: 'E02' }, { sourceId: 'invented' }, { supportQuote: '친구들과 토론하며 퀴즈를 만들었습니다.' }]) assert.equal(wire.safeParse({ ...allowed(), premises: [{ ...allowed().premises[0], ...change }] }).success, false);
  assert.ok(zodTextFormat(wire, 'source_correlated_review').schema);
  const missingSpan = { ...allowed(), premises: [{ ...allowed().premises[0], questionSpan: '생성기가 바꾼 표현' }] };
  assert.equal(wire.safeParse(missingSpan).success, true);
  assert.throws(() => finalizeQuestionPremiseReview(missingSpan, input, 'test'), code('PREMISE_UNSUPPORTED'), 'the final actual-question span gate remains mandatory');
});

test('review support choices cover every sentence and full source with API-safe whitespace and recoverable original offsets', () => {
  const text = '첫 번째 활동을 진행함. 두 번째 자료를 정리함. 세 번째 기록을 남김. 네 번째에서 질량을 3.14mg으로\n측정함.';
  const options = premiseSupportQuoteOptions(text);
  assert.ok(options.includes(sourceQuoteForDisplay(text)));
  assert.ok(options.includes('네 번째에서 질량을 3.14mg으로 측정함.'));
  assert.equal(options.length, 5);
  for (const option of options) {
    assert.ok(!/[\r\n\t]/u.test(option));
    const match = findVerifiedSourceQuote(text, option)!;
    assert.ok(match);
    assert.equal(text.slice(match.sourceStartOffset, match.sourceEndOffset), match.quote);
  }
  assert.ok(!options.includes('네 번째에서 질량을 3.14mg으로\n측정함.'));
  const wrapped = '실제\t질량을 3.14mg으로\r\n측정함.';
  assert.deepEqual(premiseSupportQuoteOptions(wrapped), ['실제 질량을 3.14mg으로 측정함.']);
  const value = { ...draft('질량을 3.14mg으로 측정한 방법은 무엇인가요?'), primaryFunction: 'PROCESS' as const, evidenceQuotes: [{ evidenceId: 'E01', quote: wrapped }] };
  const input = buildQuestionPremiseReviewInput(value, [{ id: 'E01', text: wrapped }]);
  const result = finalizeQuestionPremiseReview({ ...allowed(), premises: [{ questionSpan: '질량을 3.14mg으로 측정', basis: 'record', sourceId: 'E01', supportQuote: premiseSupportQuoteOptions(wrapped)[0], supported: true }] }, input, 'test');
  const proof = result.supportedPremises[0];
  assert.equal(wrapped.slice(proof.sourceStartOffset, proof.sourceEndOffset), wrapped);
});

test('correlated wire preserves unsupported and uncertain verdicts with a null-proof rejection branch', () => {
  const input = buildQuestionPremiseReviewInput(draft(), sources), wire = questionPremiseReviewWireSchema(input);
  const unsupported = { ...allowed(), verdict: 'rewrite', premises: [{ questionSpan: allowed().premises[0].questionSpan, basis: 'record', sourceId: null, supportQuote: null, supported: false }] };
  assert.equal(wire.safeParse(unsupported).success, true);
  assert.throws(() => finalizeQuestionPremiseReview(unsupported, input, 'test'), code('PREMISE_UNSUPPORTED'));
  const uncertain = { ...unsupported, verdict: 'uncertain', completeAssertionCoverage: false };
  assert.equal(wire.safeParse(uncertain).success, true);
  assert.throws(() => finalizeQuestionPremiseReview(uncertain, input, 'test'), code('PREMISE_UNCERTAIN'));
  assert.equal(wire.safeParse({ ...unsupported, verdict: 'allowed', premises: [{ ...unsupported.premises[0], supported: true }] }).success, false);
  assert.throws(() => finalizeQuestionPremiseReview({ ...unsupported, verdict: 'allowed' }, input, 'test'), code('PREMISE_UNSUPPORTED'));
});

test('proof failure diagnostics distinguish logical causes without exposing question or source text', async () => {
  const input = buildQuestionPremiseReviewInput(draft(), sources);
  for (const [change, reason] of [[{ sourceId: 'unknown' }, 'UNKNOWN_SOURCE_ID'], [{ supportQuote: '존재하지 않는 원문 문장입니다.' }, 'SUPPORT_QUOTE_NOT_FOUND'], [{ supportQuote: null }, 'MISSING_SOURCE_PROOF']] as const) {
    assert.throws(() => finalizeQuestionPremiseReview({ ...allowed(), premises: [{ ...allowed().premises[0], ...change }] }, input, 'test'), error => error instanceof QuestionPremiseReviewError && error.invalidReason === reason && error.message === 'PREMISE_REVIEW_INVALID');
  }
  const observations: unknown[] = []; let calls = 0;
  await assert.rejects(validateQuestionPremises({ draft: draft(), sources, reviewModel: 'test', requestReview: async () => { calls++; return { ...allowed(), premises: [{ ...allowed().premises[0], supportQuote: '없는 인용 문장입니다.' }] }; }, onValidationFailure: failure => { observations.push(failure); } }), code('PREMISE_REVIEW_INVALID'));
  assert.equal(calls, 1);
  assert.deepEqual(observations, [{ code: 'PREMISE_REVIEW_INVALID', invalidReason: 'SUPPORT_QUOTE_NOT_FOUND' }]);
  assert.ok(!JSON.stringify(observations).includes(sources[0].text));
});

test("exact numeric value and unit checks reject changed numbers or units despite a forged allowed verdict", () => {
  const sourceDraft = { ...draft(), evidenceIds: ["E02"], evidenceQuotes: [{ evidenceId: "E02", quote: sources[1].text }] };
  for (const questionText of ["농도를 30mL으로 기록한 이유는 무엇인가요?", "농도를 31mg으로 기록한 이유는 무엇인가요?"]) {
    const questionSpan = questionText.split(" 이유")[0];
    assert.throws(() => finalize({ ...allowed(), premises: [{ questionSpan, basis: "record", sourceId: "E02", supportQuote: sources[1].text, supported: true }] }, { ...sourceDraft, questionText }), code("PREMISE_UNSUPPORTED"));
  }
  const questionText = "농도를 30mg으로 기록한 이유는 무엇인가요?";
  assert.equal(finalize({ ...allowed(), premises: [{ questionSpan: "농도를 30mg으로 기록", basis: "record", sourceId: "E02", supportQuote: sources[1].text, supported: true }] }, { ...sourceDraft, questionText }).status, "approved");
});

test("legitimate comparison remains one purpose and an existence check needs no invented source proof", () => {
  const value = draft("토론할 때 서로 다른 의견이 있었나요?");
  const open = { questionSpan: value.questionText, basis: "open_check" as const, sourceId: null, supportQuote: null, supported: true };
  const reviewed = finalize({ ...allowed(), premises: [open] }, value);
  assert.equal(reviewed.supportedPremises.length, 0); assert.equal(reviewed.openChecks.length, 1);
  assert.throws(() => finalize({ ...allowed(), premises: [{ ...open, sourceId: "E01" }] }, value), code("PREMISE_REVIEW_INVALID"));
  const comparison = draft("방송 프로그램의 두 구성을 비교하면 어떤 차이가 있나요?");
  assert.equal(finalize({ ...allowed(), coreIntentCount: 1, premises: [{ questionSpan: comparison.questionText, basis: "hypothetical", sourceId: null, supportQuote: null, supported: true }] }, comparison).coreIntentCount, 1);
  assert.throws(() => finalize({ ...allowed(), coreIntentCount: 3 }), code("MULTIPLE_QUESTIONS"));
  assert.throws(() => finalize({ ...allowed(), intentMatches: false }), code("MULTIPLE_QUESTIONS"));
});

test("clarification must preserve the actual original intent and cannot add a new assessment task", () => {
  const value = { ...draft(), questionKind: "clarification" as const, parentMainQuestionId: "root" };
  const original = { questionText: draft().questionText, questionIntent: draft().questionIntent, targetEvidence: draft().targetEvidence, primaryFunction: draft().primaryFunction, depth: draft().depth };
  const input = buildQuestionPremiseReviewInput(value, sources, undefined, original);
  assert.equal(finalizeQuestionPremiseReview(allowed(), input, "test").status, "approved");
  assert.throws(() => finalizeQuestionPremiseReview({ ...allowed(), clarificationPreservesIntent: false }, input, "test"), code("MULTIPLE_QUESTIONS"));
  assert.throws(() => finalize(allowed(), value), code("MULTIPLE_QUESTIONS"));
});

test("actual answer claims remain attributed, exact and bound to the same finalized answer/root", () => {
  const value = { ...draft("청취율이 30% 높아졌다고 말씀하신 판단 근거는 무엇인가요?"), questionKind: "follow_up" as const, parentMainQuestionId: "root", primaryFunction: "VERIFY_CLAIM" as const };
  const answer = { turnId: "turn", answerId: "answer", parentMainQuestionId: "root", transcriptStatus: "finalized" as const, text: "청취율이 30% 높아졌다고 생각합니다." };
  const input = buildQuestionPremiseReviewInput(value, sources, answer);
  assert.equal(input.answer?.status, "student_claim_not_record_or_scientific_truth");
  const output = { ...allowed(), premises: [{ questionSpan: "청취율이 30% 높아졌다고 말씀하신", basis: "answer_turn_attributed", sourceId: input.answer!.id, supportQuote: answer.text, supported: true }] };
  const trace = finalizeQuestionPremiseReview(output, input, "test");
  assert.equal(trace.supportedPremises[0].basis, "answer_turn_attributed"); assert.ok(!JSON.stringify(trace).includes(answer.text));
  assert.throws(() => finalizeQuestionPremiseReview(output, { ...input, answer: null }, "test"), code("PREMISE_REVIEW_INVALID"));
  assert.throws(() => buildQuestionPremiseReviewInput(value, sources, { ...answer, parentMainQuestionId: "other-root" }), code("PREMISE_REVIEW_INVALID"));
  assert.throws(() => finalizeQuestionPremiseReview(output, { ...input, question: { ...input.question, questionKind: "main" } }, "test"), code("PREMISE_REVIEW_INVALID"));
});

test('a contradiction probe binds earlier and current actual answers independently and rejects crossed or fabricated proofs', async () => {
  const value = { ...draft('처음에는 혼자 기획했다고 하셨고, 뒤에는 공동으로 기획했다고 하셨는데 실제 역할은 무엇이었나요?'), questionKind: 'follow_up' as const, parentMainQuestionId: 'root', primaryFunction: 'VERIFY_CLAIM' as const };
  const earlier: PremiseAnswerSource = { turnId: 'earlier-turn', answerId: 'earlier-answer', parentMainQuestionId: 'root', transcriptStatus: 'finalized', text: '방송 퀴즈는 혼자 기획했습니다.' };
  const current: PremiseAnswerSource = { turnId: 'current-turn', answerId: 'current-answer', parentMainQuestionId: 'root', transcriptStatus: 'finalized', text: '친구와 공동으로 기획했습니다.' };
  const input = buildQuestionPremiseReviewInput(value, sources, current, undefined, [earlier]);
  assert.equal(input.answer?.id, 'ANSWER_TURN:current-turn:current-answer');
  assert.deepEqual(input.answerSources?.map(answer => [answer.id, answer.text]), [['ANSWER_TURN:earlier-turn:earlier-answer', earlier.text]]);
  const output = { ...allowed(), premises: [
    { questionSpan: '혼자 기획했다고 하셨고', basis: 'answer_turn_attributed', sourceId: input.answerSources![0].id, supportQuote: earlier.text, supported: true },
    { questionSpan: '공동으로 기획했다고 하셨는데', basis: 'answer_turn_attributed', sourceId: input.answer!.id, supportQuote: current.text, supported: true },
  ] };
  const wire = questionPremiseReviewWireSchema(input);
  assert.equal(wire.safeParse(output).success, true);
  assert.ok(zodTextFormat(wire, 'multiple_actual_answers_review').schema);
  await validateQuestionPremises({ draft: value, sources, answer: current, answerSources: [earlier], reviewModel: 'synthetic-independent-review', requestReview: async reviewed => {
    assert.equal(reviewed.answerSources?.[0].text, earlier.text);
    assert.equal(reviewed.answer?.text, current.text);
    return output;
  } });
  assert.deepEqual(value.premiseValidation?.supportedPremises.map(proof => proof.sourceId), [input.answerSources![0].id, input.answer!.id]);
  for (const [proof, answer] of value.premiseValidation!.supportedPremises.map((proof, index) => [proof, [earlier, current][index]] as const)) {
    assert.equal(answer.text.slice(proof.sourceStartOffset, proof.sourceEndOffset), answer.text);
  }
  for (const change of [
    { sourceId: input.answer!.id },
    { sourceId: 'ANSWER_TURN:invented-turn:invented-answer' },
    { supportQuote: earlier.text + ' ' + current.text },
  ]) {
    const invalid = { ...output, premises: [{ ...output.premises[0], ...change }] };
    assert.equal(wire.safeParse(invalid).success, false);
    assert.throws(() => finalizeQuestionPremiseReview(invalid, input, 'test'), code('PREMISE_REVIEW_INVALID'));
  }
  assert.ok(!JSON.stringify(value.premiseValidation).includes(earlier.text));
  assert.ok(!JSON.stringify(value.premiseValidation).includes(current.text));
});

test('additional answer sources fail closed on wrong cluster, unfinalized or empty IDs, and duplicate turn or answer identity', () => {
  const value = { ...draft(), questionKind: 'follow_up' as const, parentMainQuestionId: 'root' };
  const current: PremiseAnswerSource = { turnId: 'current-turn', answerId: 'current-answer', parentMainQuestionId: 'root', transcriptStatus: 'finalized', text: '제가 퀴즈를 기획했습니다.' };
  const prior: PremiseAnswerSource = { ...current, turnId: 'prior-turn', answerId: 'prior-answer', text: '친구와 주제를 정했습니다.' };
  const invalids: PremiseAnswerSource[][] = [
    [{ ...prior, parentMainQuestionId: 'other-root' }],
    [{ ...prior, transcriptStatus: 'pending' as 'finalized' }],
    [{ ...prior, turnId: '' }], [{ ...prior, answerId: '   ' }],
    [{ ...prior, turnId: ' prior-turn' }], [{ ...prior, answerId: 'prior\nanswer' }],
    [{ ...prior, text: '' }], [{ ...prior, text: '  ' }],
    [prior, prior],
    [{ ...prior, turnId: current.turnId }],
    [{ ...prior, answerId: current.answerId }],
    [current],
  ];
  for (const answers of invalids) assert.throws(() => buildQuestionPremiseReviewInput(value, sources, current, undefined, answers), error => error instanceof QuestionPremiseReviewError && error.invalidReason === 'ANSWER_SOURCE_INVALID');
  const sameWordsDifferentActualTurns = buildQuestionPremiseReviewInput(value, sources, current, undefined, [{ ...prior, text: current.text }]);
  assert.equal(sameWordsDifferentActualTurns.answerSources?.length, 1, 'a repeated statement is still a distinct actual source when IDs differ');
});

test('same-cluster answer collection preserves exact text within eight sources, 6000 per answer and 12000 total, without truncation', () => {
  const value = { ...draft(), questionKind: 'follow_up' as const, parentMainQuestionId: 'root' };
  const answers = Array.from({ length: 8 }, (_, index): PremiseAnswerSource => ({ turnId: `turn-${index}`, answerId: `answer-${index}`, parentMainQuestionId: 'root', transcriptStatus: 'finalized', text: '답' }));
  const maximumCount = buildQuestionPremiseReviewInput(value, sources, answers[0], undefined, answers.slice(1));
  assert.equal(1 + maximumCount.answerSources!.length, 8);
  assert.throws(() => buildQuestionPremiseReviewInput(value, sources, answers[0], undefined, [...answers.slice(1), { ...answers[0], turnId: 'turn-8', answerId: 'answer-8' }]), code('PREMISE_REVIEW_INVALID'));
  const first = { ...answers[0], text: '가'.repeat(6000) }, second = { ...answers[1], text: '나'.repeat(6000) };
  const atCharacterLimit = buildQuestionPremiseReviewInput(value, sources, first, undefined, [second]);
  assert.equal(atCharacterLimit.answer!.text, first.text);
  assert.equal(atCharacterLimit.answerSources![0].text, second.text);
  assert.throws(() => buildQuestionPremiseReviewInput(value, sources, { ...first, text: first.text + '가' }), code('PREMISE_REVIEW_INVALID'));
  assert.throws(() => buildQuestionPremiseReviewInput(value, sources, first, undefined, [second, answers[2]]), code('PREMISE_REVIEW_INVALID'));
  const earlierOnly = buildQuestionPremiseReviewInput(value, sources, undefined, undefined, [answers[1]]);
  assert.equal(earlierOnly.answer, null);
  assert.equal(earlierOnly.answerSources![0].id, 'ANSWER_TURN:turn-1:answer-1');
});

test('clarifying a follow-up can retain its actual answer attribution only with the original question and preserved intent', () => {
  const original = { questionText: '청취율이 30% 높아졌다고 말씀하신 판단 근거는 무엇인가요?', questionIntent: '청취율 개선 주장의 판단 근거 확인', targetEvidence: ['청취율 주장의 근거'], primaryFunction: 'VERIFY_CLAIM' as const, depth: 'D3' as const };
  const value = { ...draft('청취율이 30% 높아졌다고 말씀하신 근거 하나를 설명해 주세요.'), questionKind: 'clarification' as const, parentMainQuestionId: 'root', questionIntent: original.questionIntent, targetEvidence: original.targetEvidence, primaryFunction: original.primaryFunction, depth: original.depth };
  const prior: PremiseAnswerSource = { turnId: 'prior-turn', answerId: 'prior-answer', parentMainQuestionId: 'root', transcriptStatus: 'finalized', text: '청취율이 30% 높아졌다고 생각합니다.' };
  const current: PremiseAnswerSource = { ...prior, turnId: 'current-turn', answerId: 'current-answer', text: '질문을 쉽게 설명해 주세요.' };
  const input = buildQuestionPremiseReviewInput(value, sources, current, original, [prior]);
  const output = { ...allowed(), premises: [{ questionSpan: '청취율이 30% 높아졌다고 말씀하신', basis: 'answer_turn_attributed', sourceId: input.answerSources![0].id, supportQuote: prior.text, supported: true }] };
  assert.equal(questionPremiseReviewWireSchema(input).safeParse(output).success, true);
  assert.equal(finalizeQuestionPremiseReview(output, input, 'test').supportedPremises[0].sourceId, input.answerSources![0].id);
  assert.throws(() => finalizeQuestionPremiseReview({ ...output, clarificationPreservesIntent: false }, input, 'test'), code('MULTIPLE_QUESTIONS'));
  const noOriginal = { ...input, originalQuestion: null };
  assert.equal(questionPremiseReviewWireSchema(noOriginal).safeParse(output).success, false);
  assert.throws(() => finalizeQuestionPremiseReview(output, noOriginal, 'test'), code('MULTIPLE_QUESTIONS'));
  const unsupported = { ...output, verdict: 'rewrite', clarificationPreservesIntent: false };
  assert.equal(questionPremiseReviewWireSchema(input).safeParse(unsupported).success, true);
  assert.throws(() => finalizeQuestionPremiseReview(unsupported, input, 'test'), code('PREMISE_UNSUPPORTED'));
});

test("review payload is compact, only cited sources, and oversized source or answer is held rather than truncated", () => {
  const input = buildQuestionPremiseReviewInput(draft(), sources);
  assert.deepEqual(input.sources.map(source => source.id), ["E01"]); assert.equal(input.answer, null);
  assert.ok(!JSON.stringify(input).includes(sources[1].text)); assert.ok(JSON.stringify(input).length < 1200);
  const oversized = [{ ...sources[0], text: sources[0].text + "가".repeat(2200) }];
  assert.throws(() => buildQuestionPremiseReviewInput(draft(), oversized), code("PREMISE_REVIEW_INVALID"));
});

test("async premise failures share the existing two generation attempts, never reaching approval early", async () => {
  const events: string[] = []; let generationCalls = 0, reviewCalls = 0;
  const result = await generateWithVerifiedGrounding({ sources, requestDraft: async () => { generationCalls++; return draft(); }, validateDraft: async value => { await validateQuestionPremises({ draft: value, sources, reviewModel: "test", requestReview: async () => { reviewCalls++; return reviewCalls === 1 ? { ...allowed(), verdict: "rewrite" } : allowed(); } }); }, onAttempt: event => { events.push(event.code); } });
  assert.equal(generationCalls, 2); assert.equal(reviewCalls, 2); assert.equal(result.premiseValidation?.status, "approved");
  assert.deepEqual(events, ["PREMISE_UNSUPPORTED", "APPROVED"]);
  let failedCalls = 0;
  await assert.rejects(generateWithVerifiedGrounding({ sources, requestDraft: async () => draft(), validateDraft: async () => { failedCalls++; await Promise.resolve(); throw new QuestionValidationError("PREMISE_UNCERTAIN"); } }), error => error instanceof QuestionPreparationError && error.attemptCount === 2);
  assert.equal(failedCalls, 2);
});

test("review transport/auth failures keep their real cause and do not consume a rewrite retry", async () => {
  const actualCause = new Error("actual provider failure"); let calls = 0;
  await assert.rejects(generateWithVerifiedGrounding({ sources, requestDraft: async () => draft(), validateDraft: async value => validateQuestionPremises({ draft: value, sources, reviewModel: "test", requestReview: async () => { calls++; throw actualCause; } }) }), error => error === actualCause);
  assert.equal(calls, 1);
});
