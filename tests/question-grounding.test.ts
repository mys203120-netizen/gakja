import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { zodTextFormat } from "openai/helpers/zod";
import { APIError, LengthFinishReasonError } from "openai/core/error";
import { questionDraftSchema, type QuestionDraft } from "../server/protocol";
import { rethrowQuestionOutputError } from "../server/providers/openai";
import { buildSourceQuotePlan, canonicalizeQuestionCitations, findVerifiedSourceQuote, generateWithVerifiedGrounding, QuestionPreparationError, QuestionValidationError, sourceQuoteForDisplay } from "../server/providers/question-grounding";

const source = { id: "TEST-P02-E01", text: "동아리 탐구에서 흡광\n도를 측정하며 조건에 따른 차이를 비교함.\n관찰 결과와 한계를 함께 기록함." };
function draft(quote = "흡광도를 측정하며 조건에 따른 차이를 비교함."): QuestionDraft {
  return {
    acknowledgement: null, acknowledgementQuote: null,
    questionText: "흡광도를 측정할 때 비교 조건은 어떻게 정했나요?", questionKind: "main",
    parentMainQuestionId: null, evidenceIds: [source.id], evidenceQuotes: [{ evidenceId: source.id, quote }],
    primaryFunction: "CHOICE", questionIntent: "실제 비교 조건의 선택 이유 확인", targetEvidence: ["비교 조건의 선택 기준"], depth: "D2",
    groundingRationale: "제공한 기록의 측정 과정에 대한 질문", validationStatus: "approved", validationFailures: [],
  };
}
function validationCode(error: unknown, code: string) { return error instanceof QuestionValidationError && error.code === code; }

test("exact citations retain the original contiguous source and UTF-16 offsets", () => {
  const text = "🙂 앞 문장. 실제 탐구 내용을 기록함. 뒤 문장.";
  const quote = "실제 탐구 내용을 기록함.";
  const match = findVerifiedSourceQuote(text, quote)!;
  assert.ok(match);
  assert.equal(match.matchKind, "exact");
  assert.equal(match.sourceStartOffset, text.indexOf(quote));
  assert.equal(text.slice(match.sourceStartOffset, match.sourceEndOffset), quote);
});
test("whitespace folding accepts CRLF, tabs and NBSP but returns the untouched source slice", () => {
  const text = "앞. 실제\r\n탐구\t내용을\u00a0기록함. 뒤.";
  const match = findVerifiedSourceQuote(text, "실제 탐구 내용을 기록함.")!;
  assert.ok(match);
  assert.equal(match.matchKind, "canonical_whitespace");
  assert.equal(match.quote, "실제\r\n탐구\t내용을\u00a0기록함.");
  assert.equal(text.slice(match.sourceStartOffset, match.sourceEndOffset), match.quote);
});
test("canonical Hangul Unicode composition maps back to the original decomposed span", () => {
  const quote = "탐구 내용을 기록함.";
  const text = `앞 ${quote.normalize("NFD")} 뒤`;
  const match = findVerifiedSourceQuote(text, quote)!;
  assert.ok(match);
  assert.equal(match.quote, quote.normalize("NFD"));
  assert.equal(match.quote.normalize("NFC"), quote);
  assert.equal(text.slice(match.sourceStartOffset, match.sourceEndOffset), match.quote);
});
test("mixed PDF line wraps may join letters while retaining real interword spaces", () => {
  const match = findVerifiedSourceQuote(source.text, "흡광도를 측정하며 조건에 따른 차이를 비교함. 관찰 결과와 한계를 함께 기록함.")!;
  assert.ok(match);
  assert.equal(match.matchKind, "pdf_line_wrap");
  assert.ok(match.quote.includes("흡광\n도"));
  assert.ok(match.quote.includes("비교함.\n관찰"));
});
test("paraphrase, fabricated details, changed digits and punctuation remain rejected", () => {
  const text = "흡광도를 10회 측정하고 조건을 비교함.";
  for (const proposed of ["흡광도를 열 번 측정하고 조건을 비교함.", "흡광도를 20회 측정하고 조건을 비교함.", "흡광도를 10회 측정하고 상을 받음.", "흡광도를 10회 측정하고 조건을 비교함!", "흡광도를 １０회 측정하고 조건을 비교함."]) assert.equal(findVerifiedSourceQuote(text, proposed), null);
  assert.equal(findVerifiedSourceQuote("조건을 비교함. 별도의 활동을 수행함. 결과를 기록함.", "조건을 비교함. 결과를 기록함."), null);
});
test("ordinary spaces and a numeric newline cannot be deleted to manufacture a match", () => {
  assert.equal(findVerifiedSourceQuote("진행 못 하다 기록함.", "진행 못하다 기록함."), null);
  assert.equal(findVerifiedSourceQuote("측정값 10\n20으로 기록함.", "측정값 1020으로 기록함."), null);
  assert.equal(findVerifiedSourceQuote("확인한 내용을 기록함.", ""), null);
  assert.equal(findVerifiedSourceQuote("확인한 내용👩‍👧을 기록함.", "확인한 내용👩"), null);
});
test("missing, unknown, undeclared and duplicate citation IDs are rejected", () => {
  const missing = draft(); missing.evidenceQuotes = [];
  assert.throws(() => canonicalizeQuestionCitations(missing, [source]), error => validationCode(error, "MISSING_CITATION"));
  const unknown = draft(); unknown.evidenceIds = ["NOT-A-SOURCE"];
  assert.throws(() => canonicalizeQuestionCitations(unknown, [source]), error => validationCode(error, "UNKNOWN_EVIDENCE"));
  const extra = draft(); extra.evidenceQuotes.push({ evidenceId: "NOT-DECLARED", quote: "가짜 내용입니다." });
  assert.throws(() => canonicalizeQuestionCitations(extra, [source]), error => validationCode(error, "UNDECLARED_CITATION"));
  const duplicate = draft(); duplicate.evidenceQuotes.push({ ...duplicate.evidenceQuotes[0] });
  assert.throws(() => canonicalizeQuestionCitations(duplicate, [source]), error => validationCode(error, "DUPLICATE_CITATION"));
});
test("canonicalized metadata stores verified source text, not the model-formatted citation", () => {
  const result = canonicalizeQuestionCitations(draft(), [source]);
  const citation = result.evidenceQuotes[0];
  assert.equal(citation.quote, "흡광\n도를 측정하며 조건에 따른 차이를 비교함.");
  assert.equal(source.text.slice(citation.sourceStartOffset!, citation.sourceEndOffset!), citation.quote);
  assert.equal(citation.matchKind, "pdf_line_wrap");
});
test("server quote options are verifiable original spans and do not introduce facts", () => {
  const plan = buildSourceQuotePlan([source]);
  assert.ok(plan[0].quoteOptions.length > 0);
  for (const quote of plan[0].quoteOptions) assert.ok(findVerifiedSourceQuote(source.text, quote));
});
test("failed grounding retries once with verified source options and preserves requested content", async () => {
  const attempts: Array<{ attempt: number; code: string }> = [];
  let calls = 0;
  const result = await generateWithVerifiedGrounding({
    sources: [source],
    onAttempt: event => { attempts.push(event); },
    requestDraft: async request => {
      calls++;
      if (request.attempt === 1) return draft("기록에 없는 수상 성과를 달성함.");
      assert.equal(request.previousFailure, "CITATION_NOT_FOUND");
      assert.ok(request.quotePlan[0].quoteOptions.length);
      return draft(request.quotePlan[0].quoteOptions[0]);
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.questionText, draft().questionText);
  assert.ok(source.text.includes(result.evidenceQuotes[0].quote));
  assert.deepEqual(attempts.map(event => event.code), ["CITATION_NOT_FOUND", "APPROVED"]);
});
test("repeated fabrication ends after two attempts with a retry message, never a fallback question", async () => {
  let calls = 0;
  await assert.rejects(generateWithVerifiedGrounding({ sources: [source], requestDraft: async () => { calls++; return draft("기록에 없는 수상 성과를 달성함."); } }), error => error instanceof QuestionPreparationError && error.attemptCount === 2 && /질문 준비를 완료하지 못했어요/.test(error.message));
  assert.equal(calls, 2);
});
test("provider authentication errors are not swallowed or replaced by a generated question", async () => {
  let calls = 0;
  const authenticationError = new Error("Provider rejected the configured model.");
  await assert.rejects(generateWithVerifiedGrounding({ sources: [source], requestDraft: async () => { calls++; throw authenticationError; } }), error => error === authenticationError);
  assert.equal(calls, 1);
});
test("SDK structured parse failures enter format retry while actual API errors stay unchanged", () => {
  const parseError = questionDraftSchema.safeParse({});
  assert.equal(parseError.success, false);
  const errors = [new SyntaxError("Invalid model JSON"), new LengthFinishReasonError(), !parseError.success ? parseError.error : null];
  for (const error of errors) assert.throws(() => rethrowQuestionOutputError(error), result => validationCode(result, "INVALID_FORMAT"));
  const auth = APIError.generate(401, { message: "Unauthorized" }, "Unauthorized", new Headers());
  assert.throws(() => rethrowQuestionOutputError(auth), error => error === auth);
});
test("a first valid answer needs one call and typed server metadata does not alter strict model schema", async () => {
  let calls = 0;
  await generateWithVerifiedGrounding({ sources: [source], requestDraft: async () => { calls++; return draft(); } });
  assert.equal(calls, 1);
  const format = zodTextFormat(questionDraftSchema, "question");
  const serialized = JSON.stringify(format.schema);
  assert.equal(serialized.includes("sourceStartOffset"), false);
  assert.equal(serialized.includes("matchKind"), false);
});
test("registered PDF excerpts reproduce whitespace false negatives and all match verified source slices", async () => {
  const prepared = JSON.parse(await readFile("data/prepared/student.json", "utf8")) as { evidence: Array<{ id: string; text: string }> };
  assert.equal(prepared.evidence.length, 17);
  let previousFalseNegatives = 0;
  for (const evidence of prepared.evidence) {
    const folded = sourceQuoteForDisplay(evidence.text);
    if (!evidence.text.includes(folded)) previousFalseNegatives++;
    const match = findVerifiedSourceQuote(evidence.text, folded);
    assert.ok(match, `Missing canonical match for ${evidence.id}`);
    assert.equal(evidence.text.slice(match.sourceStartOffset, match.sourceEndOffset), evidence.text);
  }
  assert.ok(previousFalseNegatives > 0);
});
