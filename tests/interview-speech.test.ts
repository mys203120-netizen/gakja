import test from "node:test";
import assert from "node:assert/strict";
import { assertInterviewQuestionSpeech, findTranscriptSpan, isWholeWordTranscriptSpan, verifyAcknowledgement } from "../server/providers/interview-speech";

test('optional core reaction with a truncated surface is omitted without manufacturing an ending', () => {
  const raw = '쉬운 말이 아니라 질문을 설명해 주세요.', quote = '쉬운 말이 아니라';
  const truncated = '기록에는 겔의 카복실기가 중금속 양이온을 붙잡는 원리에 착안해 수처리 흡착제로 활용할 가능성을 제시했다고 되어 있습니다. 이 주제는 여기';
  assert.equal(truncated.length, 76);
  assert.equal(verifyAcknowledgement(raw, quote, truncated, [], { semanticGrounding: 'single_core' }), null);
  assert.ok(verifyAcknowledgement(raw, quote, '질문의 맥락을 설명해 달라는 말씀으로 이해했습니다.', [], { semanticGrounding: 'single_core' }));
});
import { generateWithVerifiedGrounding, QuestionValidationError } from "../server/providers/question-grounding";
import type { QuestionDraft } from "../server/protocol";

test("short original answer topics support neutral receipt without an interview-process announcement", () => {
  const raw = "온도 조건을 맞추고 역할 분담에 관해 이야기했습니다.";
  for (const [quote, sentence] of [
    ["온도 조건", "네, 말씀하신 ‘온도 조건’에 관한 설명을 들었습니다."],
    ["역할 분담", "‘역할 분담’을 언급하셨군요."],
    ["온도 조건", "‘온도 조건’이라고 하셨군요."],
    ["역할 분담", "네, ‘역할 분담’ 말씀이군요."],
    ["온도 조건", "‘온도 조건’, 알겠습니다."],
  ]) assert.equal(verifyAcknowledgement(raw, quote, sentence)?.text, sentence);
});
test("an actual quoted topic cannot authorize a fabricated project, evaluation or extra factual clause", () => {
  const raw = "온도 조건을 맞췄습니다.";
  for (const text of [
    "네, ‘온도 조건’을 잘 맞춰 수상하셨군요.",
    "좋은 답변입니다. ‘온도 조건’을 언급하셨군요.",
    "네, ‘온도 조건’을 언급하셨군요. 새 프로젝트도 성공했습니다.",
    "네, 말씀해 주신 내용 잘 들었습니다.",
    "안녕하세요. ‘온도 조건’을 언급하셨군요.",
    "말씀하신 ‘온도 조건’ 부분을 짚어보겠습니다.",
    "말씀하신 ‘온도 조건’을 확인해보겠습니다.",
    "‘온도 조건’을 살펴보겠습니다.",
  ]) assert.equal(verifyAcknowledgement(raw, "온도 조건", text), null);
  assert.equal(verifyAcknowledgement(raw, "압력 조건", "‘압력 조건’을 언급하셨군요."), null);
  assert.equal(verifyAcknowledgement(raw, "온도 조건", "‘온도 조건’을 언급하셨군요.", ["‘온도 조건’을 언급하셨군요."]), null);
});

test("a different quoted word cannot repeat the immediately preceding receipt sentence family", () => {
  assert.equal(verifyAcknowledgement("조건과 역할을 설명했습니다.", "역할", "‘역할’이라고 하셨군요.", ["‘조건’이라고 하셨군요."]), null);
  assert.equal(verifyAcknowledgement("차이를 설명했습니다.", "차이", "‘차이’라고 하셨군요.", ["‘조건’이라고 하셨군요."]), null);
  assert.ok(verifyAcknowledgement("조건과 역할을 설명했습니다.", "역할", "네, ‘역할’ 말씀이군요.", ["‘조건’이라고 하셨군요."]));
});

test("decimal numeric source wording remains unchanged by the receipt gate", () => {
  const raw = "시료를 3.14mg 사용했습니다.";
  const value = verifyAcknowledgement(raw, "3.14mg", "네, ‘3.14mg’ 말씀이군요.");
  assert.equal(value?.quote, "3.14mg"); assert.equal(raw.slice(value!.span.start, value!.span.end), "3.14mg");
});

test('single-core reaction quotes cannot cut a Korean source word and are never silently expanded or clipped',()=>{
  const raw='고민 있는 거 쓰시고 제출하세요 하면 제출 버튼 누르고';
  const before=raw;
  const clipped='고민 있는 거 쓰시고 제출하세요 하면 제출 버튼 누';
  const spoken='고민을 입력하고 제출하는 과정을 말씀하셨습니다.';
  const span=findTranscriptSpan(raw,clipped)!;
  assert.equal(clipped.length,28);assert.equal(isWholeWordTranscriptSpan(raw,span),false);
  assert.equal(verifyAcknowledgement(raw,clipped,spoken,[],{semanticGrounding:'single_core'}),null);
  assert.equal(verifyAcknowledgement(raw,'출 버튼 누르고',spoken,[],{semanticGrounding:'single_core'}),null);
  const complete=verifyAcknowledgement(raw,'제출 버튼 누르고',spoken,[],{semanticGrounding:'single_core'});
  assert.ok(complete);assert.equal(complete.quote,'제출 버튼 누르고');
  assert.equal(raw.slice(complete.span.start,complete.span.end),complete.quote);
  assert.equal(raw,before);
});

test('source-word boundary checks preserve whitespace, Unicode and numeric punctuation source offsets',()=>{
  const raw='CNT/MXene  3.14mg 사용했습니다.';
  for(const quote of ['CNT','MXene','3.14mg','3.14mg 사용했습니다.']){
    const span=findTranscriptSpan(raw,quote)!;assert.ok(span);assert.ok(isWholeWordTranscriptSpan(raw,span));
    const accepted=verifyAcknowledgement(raw,quote,'사용한 재료와 양을 말씀하셨습니다.',[],{semanticGrounding:'single_core'});
    assert.ok(accepted);assert.equal(raw.slice(accepted.span.start,accepted.span.end),quote);
  }
  assert.equal(isWholeWordTranscriptSpan(raw,{start:1,end:3}),false);
  assert.equal(isWholeWordTranscriptSpan(raw,{start:0,end:raw.length+1}),false);
});
test("empty, non-content and unsupported acknowledgement topics are omitted", () => {
  assert.equal(verifyAcknowledgement("", "활동", "‘활동’을 언급하셨군요."), null);
  assert.equal(verifyAcknowledgement("잘 모르겠습니다.", "모르겠습니다", "‘모르겠습니다’를 언급하셨군요."), null);
  assert.equal(verifyAcknowledgement("어 음", null, null), null);
  assert.equal(verifyAcknowledgement("아주 긴 설명입니다.", "아주 긴 설명입니다.", "‘아주 긴 설명입니다.’를 언급하셨군요."), null);
});
test("Unicode and whitespace acknowledgement matching retains exact transcript offsets without paraphrase", () => {
  const raw = `앞 ${"온도".normalize("NFD")}  조건을 맞췄습니다.`;
  const result = verifyAcknowledgement(raw, "온도 조건", "‘온도 조건’을 언급하셨군요.")!;
  assert.ok(result);
  assert.equal(raw.slice(result.span.start, result.span.end), result.quote);
  assert.equal(result.quote, `${"온도".normalize("NFD")}  조건`);
  assert.equal(findTranscriptSpan("온도 조건", "온도조건"), null);
  assert.equal(findTranscriptSpan("원문 👩‍👧 내용", "👩"), null);
});
test("only the session's first question may greet even when an interviewer voice changes", () => {
  const greeting = "안녕하세요. 조건을 선택한 이유는 무엇인가요?";
  assert.doesNotThrow(() => assertInterviewQuestionSpeech(greeting, { isFirstTurn: true }));
  for (const text of [greeting, "안녕하십니까. 조건을 선택한 이유는 무엇인가요?", "반갑습니다. 어떤 기준으로 선택했나요?"]) assert.throws(() => assertInterviewQuestionSpeech(text, { isFirstTurn: false }), error => error instanceof QuestionValidationError && error.code === "FORBIDDEN_SPEECH");
  assert.doesNotThrow(() => assertInterviewQuestionSpeech("조건을 선택한 이유는 무엇인가요?", { isFirstTurn: false }));
  assert.throws(() => assertInterviewQuestionSpeech("선택 이유를 설명해 주세요. 결과도 말씀해 주세요."), error => error instanceof QuestionValidationError && error.code === "MULTIPLE_QUESTIONS");
  for (const text of ["말씀하신 조건을 확인해보겠습니다. 어떤 기준으로 정했나요?", "그 부분을 짚어보겠습니다. 직접 한 일은 무엇인가요?", "내용을 살펴보겠습니다. 어떤 기준이었나요?"]) assert.throws(() => assertInterviewQuestionSpeech(text), error => error instanceof QuestionValidationError && error.code === "FORBIDDEN_SPEECH");
});
test("a repeated greeting uses the bounded retry and never silently edits the validated question", async () => {
  const source = { id: "E01", text: "조건을 선택하고 비교함." };
  const makeDraft = (questionText: string): QuestionDraft => ({ acknowledgement: null, acknowledgementQuote: null, questionText, questionKind: "main", parentMainQuestionId: null, evidenceIds: [source.id], evidenceQuotes: [{ evidenceId: source.id, quote: source.text }], primaryFunction: "CHOICE", questionIntent: "조건 선택 이유 확인", targetEvidence: ["선택 기준"], depth: "D2", groundingRationale: "기록된 비교 조건의 선택을 확인", validationStatus: "approved", validationFailures: [] });
  let calls = 0;
  const direct = "조건을 선택한 이유는 무엇인가요?";
  const result = await generateWithVerifiedGrounding({ sources: [source], requestDraft: async request => { calls++; return makeDraft(request.attempt === 1 ? `안녕하세요. ${direct}` : direct); }, validateDraft: draft => assertInterviewQuestionSpeech(draft.questionText, { isFirstTurn: false }) });
  assert.equal(calls, 2); assert.equal(result.questionText, direct);
});
