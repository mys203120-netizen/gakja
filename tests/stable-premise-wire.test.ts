import test from 'node:test';
import assert from 'node:assert/strict';
import { zodTextFormat } from 'openai/helpers/zod';
import type { QuestionDraft } from '../server/protocol';
import { QuestionValidationError } from '../server/providers/question-grounding';
import { buildQuestionPremiseReviewInput, buildStablePremiseProofOptions, finalizeQuestionPremiseReview, materializeStablePremiseReview, QuestionPremiseReviewError, questionPremiseReviewWireSchema, stableQuestionPremiseReviewSchema } from '../server/providers/question-premises';

const sources = [{ id: 'E01', text: '친구들과 퀴즈를 기획함. 청취율은 측정하지 않음.' }, { id: 'E02', text: '용액 농도를 3.14mg으로\n기록함.' }];
function draft(): QuestionDraft {
  return { acknowledgement: null, acknowledgementQuote: null, questionText: '용액 농도를 3.14mg으로 기록한 방법은 무엇인가요?', questionKind: 'main', parentMainQuestionId: null, evidenceIds: ['E02'], evidenceQuotes: [{ evidenceId: 'E02', quote: sources[1].text }], primaryFunction: 'PROCESS', questionIntent: '실제 기록한 방법 확인', targetEvidence: ['기록한 방법 한 가지'], depth: 'D2', groundingRationale: '명시된 기록 행동 하나만 확인한다.', validationStatus: 'approved', validationFailures: [] };
}
function allowed(premises: Array<{ questionSpan: string; basis: string; supported: boolean; proofId: string | null }>) {
  return { verdict: 'allowed', completeAssertionCoverage: true, coreIntentCount: 1, intentMatches: true, clarificationPreservesIntent: true, premises };
}
const validationCode = (code: string) => (error: unknown) => error instanceof QuestionValidationError && error.code === code;
const invalidReason = (reason: string) => (error: unknown) => error instanceof QuestionPremiseReviewError && error.invalidReason === reason;

test('runtime proof grammar is static while actual source and quotation choices remain per-turn request data', () => {
  const first = buildQuestionPremiseReviewInput(draft(), sources);
  const changedSource = { id: 'E02', text: '전혀 다른 원문에서 실제 관찰을 기록함.' };
  const second = buildQuestionPremiseReviewInput({ ...draft(), evidenceQuotes: [{ evidenceId: 'E02', quote: changedSource.text }] }, [changedSource]);
  const firstSchema = JSON.stringify(zodTextFormat(stableQuestionPremiseReviewSchema, 'runtime_review').schema);
  const secondSchema = JSON.stringify(zodTextFormat(stableQuestionPremiseReviewSchema, 'runtime_review').schema);
  assert.equal(firstSchema, secondSchema);
  assert.notDeepEqual(buildStablePremiseProofOptions(first), buildStablePremiseProofOptions(second));
  for (const text of [sources[1].text, '용액 농도를 3.14mg으로 기록함.', changedSource.text, 'E02']) assert.ok(!firstSchema.includes(text));
  assert.notEqual(JSON.stringify(zodTextFormat(questionPremiseReviewWireSchema(first), 'offline_review').schema), JSON.stringify(zodTextFormat(questionPremiseReviewWireSchema(second), 'offline_review').schema), 'the existing offline correlated wire stays unchanged');
});

test('stable proof selection restores exact source bindings and the original final validator recovers PDF-wrap offsets', () => {
  const value = draft(), input = buildQuestionPremiseReviewInput(value, sources), choices = buildStablePremiseProofOptions(input);
  assert.ok(choices.every((choice, index) => choice.proofId === `P${index + 1}`));
  const proof = choices.find(choice => choice.sourceId === 'E02')!;
  assert.equal(proof.supportQuote, '용액 농도를 3.14mg으로 기록함.');
  const materialized = materializeStablePremiseReview(allowed([{ questionSpan: '용액 농도를 3.14mg으로 기록', basis: 'record', supported: true, proofId: proof.proofId }]), input);
  assert.equal(materialized.premises[0].sourceId, 'E02');
  assert.equal(materialized.premises[0].supportQuote, proof.supportQuote);
  assert.equal('proofId' in materialized.premises[0], false);
  const result = finalizeQuestionPremiseReview(materialized, input, 'synthetic-independent-review');
  const bound = result.supportedPremises[0];
  assert.equal(sources[1].text.slice(bound.sourceStartOffset, bound.sourceEndOffset), sources[1].text);
  const inventedNumber = { ...input, question: { ...input.question, questionText: input.question.questionText.replace('3.14', '4.14') } };
  const changed = materializeStablePremiseReview(allowed([{ questionSpan: '용액 농도를 4.14mg으로 기록', basis: 'record', supported: true, proofId: proof.proofId }]), inventedNumber);
  assert.throws(() => finalizeQuestionPremiseReview(changed, inventedNumber, 'test'), validationCode('PREMISE_UNSUPPORTED'));
});

test('prior and current answers keep separate actual proof IDs; a source-kind swap cannot pass materialization', () => {
  const value = { ...draft(), questionKind: 'follow_up' as const, parentMainQuestionId: 'root', questionText: '혼자 기획했다고 하셨고 공동으로 기획했다고 하셨는데 실제 역할은 무엇인가요?' };
  const prior = { turnId: 'prior-turn', answerId: 'prior-answer', parentMainQuestionId: 'root', transcriptStatus: 'finalized' as const, text: '혼자 기획했습니다.' };
  const current = { turnId: 'current-turn', answerId: 'current-answer', parentMainQuestionId: 'root', transcriptStatus: 'finalized' as const, text: '공동으로 기획했습니다.' };
  const input = buildQuestionPremiseReviewInput(value, sources, current, undefined, [prior]), choices = buildStablePremiseProofOptions(input);
  const priorProof = choices.find(choice => choice.sourceId === input.answerSources![0].id)!;
  const currentProof = choices.find(choice => choice.sourceId === input.answer!.id)!;
  assert.notEqual(priorProof.proofId, currentProof.proofId);
  const selected = allowed([
    { questionSpan: '혼자 기획했다고 하셨고', basis: 'answer_turn_attributed', supported: true, proofId: priorProof.proofId },
    { questionSpan: '공동으로 기획했다고 하셨는데', basis: 'answer_turn_attributed', supported: true, proofId: currentProof.proofId },
  ]);
  const materialized = materializeStablePremiseReview(selected, input);
  const approved = finalizeQuestionPremiseReview(materialized, input, 'synthetic-independent-review');
  assert.deepEqual(approved.supportedPremises.map(proof => proof.sourceId), [priorProof.sourceId, currentProof.sourceId]);
  assert.throws(() => materializeStablePremiseReview(allowed([{ ...selected.premises[0], basis: 'record' }]), input), invalidReason('PROOF_BASIS_MISMATCH'));
  const mainInput = { ...input, question: { ...input.question, questionKind: 'main' as const } };
  assert.ok(buildStablePremiseProofOptions(mainInput).every(choice => choice.basis === 'record'));
  assert.throws(() => materializeStablePremiseReview(selected, mainInput), invalidReason('UNKNOWN_PROOF_ID'));
  const clarificationInput = { ...input, question: { ...input.question, questionKind: 'clarification' as const }, originalQuestion: { questionText: value.questionText, questionIntent: value.questionIntent, targetEvidence: value.targetEvidence, primaryFunction: value.primaryFunction, depth: value.depth } };
  assert.ok(buildStablePremiseProofOptions(clarificationInput).some(choice => choice.sourceId === priorProof.sourceId));
  assert.ok(buildStablePremiseProofOptions({ ...clarificationInput, originalQuestion: null }).every(choice => choice.basis === 'record'));
});

test('unknown proof IDs, forged source strings, supported null proofs and attributed open checks are rejected', () => {
  const input = buildQuestionPremiseReviewInput(draft(), sources), proof = buildStablePremiseProofOptions(input)[0];
  const premise = { questionSpan: '용액 농도를 3.14mg으로 기록', basis: 'record', supported: true, proofId: proof.proofId };
  assert.throws(() => materializeStablePremiseReview(allowed([{ ...premise, proofId: 'P999999' }]), input), invalidReason('UNKNOWN_PROOF_ID'));
  assert.throws(() => materializeStablePremiseReview(allowed([{ ...premise, proofId: null }]), input), invalidReason('MISSING_SOURCE_PROOF'));
  assert.throws(() => materializeStablePremiseReview({ ...allowed([premise]), premises: [{ ...premise, sourceId: 'forged-source', supportQuote: 'forged quote' }] }, input), invalidReason('REVIEW_SCHEMA_INVALID'));
  for (const basis of ['open_check', 'hypothetical']) assert.throws(() => materializeStablePremiseReview(allowed([{ ...premise, basis }]), input), invalidReason('OPEN_PROOF_HAS_SOURCE'));
});

test('rejection, uncertainty, coverage and one-intent checks remain mandatory after stable proof restoration', () => {
  const input = buildQuestionPremiseReviewInput(draft(), sources), proof = buildStablePremiseProofOptions(input)[0];
  const valid = allowed([{ questionSpan: '용액 농도를 3.14mg으로 기록', basis: 'record', supported: true, proofId: proof.proofId }]);
  const unsupported = { ...valid, verdict: 'rewrite', premises: [{ ...valid.premises[0], supported: false, proofId: null }] };
  assert.throws(() => finalizeQuestionPremiseReview(materializeStablePremiseReview(unsupported, input), input, 'test'), validationCode('PREMISE_UNSUPPORTED'));
  assert.throws(() => finalizeQuestionPremiseReview(materializeStablePremiseReview({ ...unsupported, verdict: 'uncertain' }, input), input, 'test'), validationCode('PREMISE_UNCERTAIN'));
  assert.throws(() => finalizeQuestionPremiseReview(materializeStablePremiseReview({ ...valid, completeAssertionCoverage: false }, input), input, 'test'), validationCode('PREMISE_UNCERTAIN'));
  assert.throws(() => finalizeQuestionPremiseReview(materializeStablePremiseReview({ ...valid, coreIntentCount: 2 }, input), input, 'test'), validationCode('MULTIPLE_QUESTIONS'));
  assert.throws(() => finalizeQuestionPremiseReview(materializeStablePremiseReview({ ...valid, premises: [] }, input), input, 'test'), invalidReason('EMPTY_PREMISE_COVERAGE'));
  const open = allowed([{ questionSpan: draft().questionText, basis: 'open_check', supported: true, proofId: null }]);
  assert.equal(finalizeQuestionPremiseReview(materializeStablePremiseReview(open, input), input, 'test').openChecks.length, 1);
});
