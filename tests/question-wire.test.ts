import test from "node:test";
import assert from "node:assert/strict";
import { zodTextFormat } from "openai/helpers/zod";
import { questionDraftSchema, type QuestionDraft } from "../server/protocol";
import { buildSourceQuotePlan, canonicalizeQuestionCitations, QuestionValidationError } from "../server/providers/question-grounding";
import { questionWireSchema } from "../server/providers/question-wire";

const sources = [{ id: "A", text: "비교 조건을 하나씩 바꾸며 자료를 확인했습니다." }, { id: "B", text: "학급에서 서로의 의견을 듣고 계획을 조율했습니다." }];
function draft(): QuestionDraft { return { acknowledgement: null, acknowledgementQuote: null, questionText: "비교 조건을 선택한 기준 한 가지는 무엇인가요?", questionKind: "main", parentMainQuestionId: null, evidenceIds: ["A"], evidenceQuotes: [{ evidenceId: "A", quote: sources[0].text }], primaryFunction: "CHOICE", questionIntent: "자료의 선택 기준을 확인한다.", targetEvidence: ["선택 기준"], depth: "D2", groundingRationale: "합성 검증 근거에 기록된 선택 확인", validationStatus: "approved", validationFailures: [] }; }

test("model wire can only select supplied evidence IDs and verified source quote options", () => {
  const schema = questionWireSchema(sources, buildSourceQuotePlan(sources));
  assert.equal(schema.safeParse(draft()).success, true);
  assert.equal(schema.safeParse({ ...draft(), evidenceIds: ["invented"] }).success, false);
  assert.equal(schema.safeParse({ ...draft(), evidenceQuotes: [{ evidenceId: "invented", quote: sources[0].text }] }).success, false);
  assert.equal(schema.safeParse({ ...draft(), evidenceQuotes: [{ evidenceId: "A", quote: "조건을 조정해 자료를 검토했습니다." }] }).success, false);
  const encoded = JSON.stringify(zodTextFormat(schema, "question").schema);
  assert.ok(encoded.includes(sources[0].text)); assert.ok(encoded.includes('"enum"'));
});
test("wire never trusts a fabricated quote option and leaves the production validation schema compatible", () => {
  const schema = questionWireSchema(sources, [{ evidenceId: "A", quoteOptions: [sources[0].text, "없는 실험을 성공했습니다."] }, { evidenceId: "UNKNOWN", quoteOptions: [sources[1].text] }]);
  assert.equal(schema.safeParse({ ...draft(), evidenceQuotes: [{ evidenceId: "A", quote: "없는 실험을 성공했습니다." }] }).success, false);
  assert.equal(schema.safeParse({ ...draft(), evidenceIds: ["UNKNOWN"] }).success, false);
  // The external persisted/model draft contract stays unchanged: the final independent check rejects it.
  const malicious = { ...draft(), evidenceQuotes: [{ evidenceId: "A", quote: "없는 실험을 성공했습니다." }] };
  assert.equal(questionDraftSchema.safeParse(malicious).success, true);
  assert.throws(() => canonicalizeQuestionCitations(malicious, sources), QuestionValidationError);
});
test("the final per-ID source check still rejects a quote selected from another valid source", () => {
  const schema = questionWireSchema(sources, buildSourceQuotePlan(sources));
  const wrongPair = { ...draft(), evidenceQuotes: [{ evidenceId: "A", quote: sources[1].text }] };
  assert.equal(schema.safeParse(wrongPair).success, true);
  assert.throws(() => canonicalizeQuestionCitations(wrongPair, sources), error => error instanceof QuestionValidationError && error.code === "CITATION_NOT_FOUND");
});
test("wire accepts approved PDF whitespace options and preserves original offsets after final validation", () => {
  const original = [{ id: "A", text: "비교 조건을\r\n하나씩 바꾸며 자료를 확인했습니다." }], quotePlan = buildSourceQuotePlan(original);
  const value = { ...draft(), evidenceQuotes: [{ evidenceId: "A", quote: quotePlan[0].quoteOptions[0] }] };
  assert.equal(questionWireSchema(original, quotePlan).safeParse(value).success, true);
  const checked = canonicalizeQuestionCitations(value, original);
  assert.ok(checked.evidenceQuotes[0].quote.includes("\r\n")); assert.equal(checked.evidenceQuotes[0].sourceStartOffset, 0);
});
test("missing verifiable source choices are blocked rather than falling back to free-form quotes", () => {
  assert.throws(() => questionWireSchema(sources, []), QuestionValidationError);
  assert.throws(() => questionWireSchema(sources, [{ evidenceId: "A", quoteOptions: ["없는 내용입니다."] }]), QuestionValidationError);
});
