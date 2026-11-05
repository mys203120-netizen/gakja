import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { zodTextFormat } from 'openai/helpers/zod';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { InterviewSession, QuestionDraft, RecordedTurn } from '../server/protocol';
import { buildQuestionPremiseReviewInput, finalizeQuestionPremiseReview } from '../server/providers/question-premises';
import { reactionQuoteOptions } from '../server/providers/answer-reaction';
import { runRealtimeCore, realtimeCoreRequest, realtimeCoreWireSchema, coreQuoteOptions, RealtimeCoreSourceError } from '../server/providers/realtime-core';
import { hasObservedMeasurement, hasObservedComparison } from '../server/providers/follow-up-language';
import { extractBookQuestions } from '../server/data/book-question-reference';
import { reviewSyntheticReference, syntheticReferenceCorpus, syntheticReferenceQuestion } from './fixtures/book-references';

function fixture(raw = '자료를 비교했습니다.', primary: 'PROCESS' | 'EVIDENCE' = 'PROCESS') {
  const sources = [{ id: 'E01', text: '자료를 선택해 비교하는 탐구를 진행함.' }];
  const draft: QuestionDraft = { acknowledgement: null, acknowledgementQuote: null, questionText: primary === 'PROCESS' ? '자료를 비교한 과정은 무엇인가요?' : '자료를 보고 내린 판단의 근거는 무엇인가요?', questionKind: 'main', parentMainQuestionId: null, evidenceIds: ['E01'], evidenceQuotes: [{ evidenceId: 'E01', quote: sources[0].text }], primaryFunction: primary, questionIntent: primary === 'PROCESS' ? '실제 자료 비교 과정 확인' : '실제 판단 근거 확인', targetEvidence: [primary === 'PROCESS' ? '실제로 거친 한 단계' : '판단 근거 한 가지'], depth: 'D2', groundingRationale: '자료 비교의 실제 기록을 확인한다.', validationStatus: 'approved', validationFailures: [] };
  const audit = finalizeQuestionPremiseReview({ verdict: 'allowed', completeAssertionCoverage: true, coreIntentCount: 1, intentMatches: true, clarificationPreservesIntent: true, premises: [{ questionSpan: '자료를', basis: 'record', sourceId: 'E01', supportQuote: sources[0].text, supported: true }] }, buildQuestionPremiseReviewInput(draft, sources), 'synthetic-offline-review');
  const context = { questionReferences: null, errors: [], student: { evidence: sources }, manifest: { rulesVersion: 'singlecore-test', sourceIntegrity: { pdfHashVerified: true, evidenceReferencesVerified: true, evidenceTextVerified: true }, files: [{ role: 'studentPdf', path: 'student.pdf', sha256: 'a'.repeat(64) }] } } as unknown as InterviewContext;
  const turn = { id: 'q0', answerId: 'answer0', parentMainQuestionId: 'q0', questionText: draft.questionText, questionKind: 'main', followUpIndex: 0, evidenceIds: ['E01'], rawTranscript: raw, transcriptStatus: 'finalized', metadata: { ...draft, rulesVersion: 'singlecore-test', premiseValidation: audit, questionClusterId: 'q0' } } as unknown as RecordedTurn;
  const session = { id: 'language-test-session', turns: [turn], sourceManifest: structuredClone(context.manifest), followUpCountByMainQuestion: {}, elapsedMs: 0 } as unknown as InterviewSession;
  return { context, session, turn };
}
const relevant = { decision: { classification: 'relevant', reasonCode: 'ANSWER_RELATED', keywordQuote: null, followUpGoal: null } };

test('one core call decides a partial answer and creates a source-bound narrow follow-up without another generator or reviewer', async () => {
  const setup = fixture(); let calls = 0;
  const result = await runRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, request: async request => {
    calls++; assert.equal(request.reasoning.effort, 'none'); assert.equal(request.max_output_tokens, 360); assert.equal(request.store, false);
    const input = JSON.parse(request.input); assert.equal(input.answer.finalTranscript, setup.turn.rawTranscript); assert.deepEqual(input.allowedFollowUpGoals, ['process']);
    assert.equal('sourceActivityUnits' in input, false, 'Offline student facts cannot fill gaps in the actual spoken answer');
    return { decision: { classification: 'partial', reasonCode: 'MISSING_REQUESTED_DETAIL', keywordQuote: reactionQuoteOptions(setup.turn.rawTranscript!)[0], followUpGoal: 'process' } };
  } });
  assert.equal(calls, 1); assert.equal(result.providerTimings.coreModelCalls, 1); assert.equal(result.origin, 'model');
  assert.equal(result.reaction.directive, 'follow_up_missing_target'); assert.equal(result.draft?.questionKind, 'follow_up');
  assert.equal(result.draft?.primaryFunction, 'CLARIFY_CONTENT'); assert.equal(result.draft?.parentMainQuestionId, 'q0');
  assert.equal(result.draft?.targetEvidence.length, 1); assert.equal(result.draft?.premiseValidation?.method, 'constrained_answer_follow_up');
  assert.ok(result.draft?.questionText.includes(result.reaction.keywordQuote!));
  const proof = result.draft!.premiseValidation!.supportedPremises[0];
  assert.equal(setup.turn.rawTranscript!.slice(proof.sourceStartOffset, proof.sourceEndOffset), result.reaction.keywordQuote);
  assert.equal(proof.sourceId, 'ANSWER_TURN:q0:answer0');
  assert.equal(result.draft!.questionText.slice(proof.questionStartOffset, proof.questionEndOffset), result.reaction.keywordQuote);
  assert.equal(result.draft!.followUpLanguage?.policyVersion, 'answer-bound-language-v2.3-book-tone-v1');
  assert.equal(result.draft!.followUpLanguage?.goal, 'process');
});

test('the actual model wire requires relevance before focus selection and an unrelated utterance cannot become a claim probe', async () => {
  const setup = fixture('학교 도서 대출을 연장했습니다.');
  assert.equal(realtimeCoreWireSchema(setup.session, true).safeParse(relevant).success, false);
  const result = await runRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, request: async () => ({
    answerRelation: { kind: 'unrelated', note: '자료 비교 과정 질문과 관계없는 일상 행동이다.' },
    decision: { classification: 'partial', reasonCode: 'CLAIM_REQUIRES_DETAIL', keywordQuote: coreQuoteOptions(setup.turn.rawTranscript!)[0], followUpGoal: 'basis' },
  }) });
  assert.equal(result.reaction.classification, 'off_topic'); assert.equal(result.reaction.reasonCode, 'NO_SEMANTIC_CONNECTION');
  assert.equal(result.reaction.directive, 'clarification_same_target'); assert.equal(result.draft, null);
  assert.equal(result.providerTimings.coreModelCalls, 1); assert.deepEqual(result.serverGuards, ['ANSWER_RELATION_PRIORITY']);
  assert.equal(setup.turn.rawTranscript, '학교 도서 대출을 연장했습니다.');
});

test('conflicting relevance and decision fields use a recorded non-evaluative fallback without an extra model call', async () => {
  const setup = fixture();
  const result = await runRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, request: async () => ({
    answerRelation: { kind: 'related', note: '자료 비교의 실제 행동을 언급했다.' },
    decision: { classification: 'off_topic', reasonCode: 'NO_SEMANTIC_CONNECTION', keywordQuote: null, followUpGoal: null },
  }) });
  assert.equal(result.origin, 'fallback'); assert.equal(result.reaction.classification, 'unassessed');
  assert.equal(result.providerTimings.coreModelCalls, 1); assert.equal(result.draft, null);
  assert.equal(result.answerRelation?.kind, 'related');
});

test('book questions remain wording-only reference data and never become answer quotations or student evidence', async () => {
  const setup = fixture();
  const questions = extractBookQuestions('## 책 예시\n```text\n면접 질문\n자료를 비교한 과정은 무엇인가요?\n```', 'book-example.md', 'preparation');
  assert.equal(questions.length, 1);
  questions[0] = reviewSyntheticReference(questions[0], { primaryFunctions: ['PROCESS'] });
  const corpus = syntheticReferenceCorpus(questions);
  setup.context.questionReferences = corpus;
  const core = await runRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, request: async request => {
    const input = JSON.parse(request.input);
    assert.equal(input.bookQuestionExamples.length, 1);
    assert.equal(input.bookQuestionExamples[0].provenance, 'book_example');
    assert.equal(input.bookQuestionExamples[0].source.path, 'book-example.md');
    assert.equal(input.questionExampleRole, 'WORDING_AND_SINGLE_PURPOSE_REFERENCE_ONLY_NOT_STUDENT_FACTS');
    assert.ok(!input.answer.quoteOptions.includes(questions[0].questionText));
    return { decision: { classification: 'partial', reasonCode: 'MISSING_REQUESTED_DETAIL', keywordQuote: coreQuoteOptions(setup.turn.rawTranscript!)[0], followUpGoal: 'process' } };
  } });
  assert.equal(core.providerTimings.coreModelCalls, 1);
  assert.deepEqual(core.draft?.evidenceIds, ['E01']);
  assert.deepEqual(core.draft?.questionReferenceContext, { schemaVersion: 'book-question-reference-v1', catalogSha256: corpus.digest, exampleIds: [questions[0].id], purpose: 'wording_reference_only', analysisKey: corpus.analysis!.key, referenceUses: [{ id: questions[0].id, usage: 'direct_example' }] });
  assert.deepEqual(core.draft?.followUpLanguage?.referenceExampleIds, [questions[0].id]);
});

test('one core request receives only an atomic compound demand or context-dependent strategy and records their uses', async () => {
  const setup = fixture();
  const compound = syntheticReferenceQuestion('자료를 선택한 과정은 무엇인가요? 그 결과는 무엇인가요?', {
    sourcePath: 'synthetic-compound.md', category: 'compound_strategy', primaryFunctions: ['PROCESS', 'RESULT'],
    demands: [{ quote: '자료를 선택한 과정은 무엇인가요?', primaryFunction: 'PROCESS', depth: 'D2' }, { quote: '그 결과는 무엇인가요?', primaryFunction: 'RESULT', depth: 'D1' }],
    strategies: ['single_demand_decomposition'],
  });
  const contextual = syntheticReferenceQuestion('제시된 그래프의 자료를 비교한 과정은 어떻게 설명하나요?', {
    sourcePath: 'synthetic-contextual.md', category: 'contextual_strategy', primaryFunctions: ['PROCESS'],
    dependencies: { passage: false, figure: true, priorAnswer: false, institution: false }, strategies: ['comparison', 'context_required'],
  });
  const corpus = syntheticReferenceCorpus([compound, contextual]); setup.context.questionReferences = corpus;
  let referenceUses: Array<{ id: string; usage: 'compound_strategy' | 'contextual_strategy' }> = [];
  const core = await runRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, request: async request => {
    const input = JSON.parse(request.input);
    assert.equal(input.bookQuestionExamples.length, 2);
    const compoundExample = input.bookQuestionExamples.find((item: { id: string }) => item.id === compound.id);
    const contextualExample = input.bookQuestionExamples.find((item: { id: string }) => item.id === contextual.id);
    assert.equal(compoundExample.questionText, undefined);
    assert.equal(compoundExample.atomicDemand.quote, '자료를 선택한 과정은 무엇인가요?');
    assert.equal(contextualExample.questionText, undefined); assert.equal(contextualExample.atomicDemand, undefined);
    assert.equal(contextualExample.dependencies.figure, true);
    assert.ok(contextualExample.strategies.includes('context_required'));
    assert.ok(!JSON.stringify(input.bookQuestionExamples).includes(compound.questionText));
    referenceUses = input.bookQuestionExamples.map(({ id, usage }: { id: string; usage: 'compound_strategy' | 'contextual_strategy' }) => ({ id, usage }));
    return { decision: { classification: 'partial', reasonCode: 'MISSING_REQUESTED_DETAIL', keywordQuote: coreQuoteOptions(setup.turn.rawTranscript!)[0], followUpGoal: 'process' } };
  } });
  assert.equal(core.origin, 'model'); assert.equal(core.providerTimings.coreModelCalls, 1);
  assert.deepEqual(core.draft?.evidenceIds, ['E01']);
  assert.equal(core.draft?.questionReferenceContext?.analysisKey, corpus.analysis!.key);
  assert.deepEqual(core.draft?.questionReferenceContext?.referenceUses, referenceUses);
});

test('a negated measurement or comparison never opens that probe and a result question does not demand a new measurement method', () => {
  for (const raw of ['수치가 없었습니다. 비교하지 않았습니다.', '수치는 모르겠습니다. 차이도 없었습니다.']) {
    const setup = fixture(raw, 'EVIDENCE');
    const wire = realtimeCoreWireSchema(setup.session), quote = coreQuoteOptions(raw)[0];
    for (const goal of ['measurement', 'comparison']) assert.equal(wire.safeParse({ decision: { classification: 'partial', reasonCode: 'MISSING_REQUESTED_DETAIL', keywordQuote: quote, followUpGoal: goal } }).success, false);
    assert.equal(wire.safeParse({ decision: { classification: 'partial', reasonCode: 'CLAIM_REQUIRES_DETAIL', keywordQuote: quote, followUpGoal: 'measurement' } }).success, false);
  }
  const setup = fixture('최종 수치는 12회였습니다.'); setup.turn.metadata.primaryFunction = 'RESULT';
  const wire = realtimeCoreWireSchema(setup.session), quote = coreQuoteOptions(setup.turn.rawTranscript!)[0];
  assert.equal(wire.safeParse({ decision: { classification: 'partial', reasonCode: 'MISSING_REQUESTED_DETAIL', keywordQuote: quote, followUpGoal: 'measurement' } }).success, false);
  assert.equal(wire.safeParse({ decision: { classification: 'partial', reasonCode: 'CLAIM_REQUIRES_DETAIL', keywordQuote: quote, followUpGoal: 'measurement' } }).success, true);
});

test('wire binds measurement and comparison to their own positive exact quotation rather than unrelated words elsewhere in the answer', () => {
  const raw = '2학년 때 자료를 조사했습니다. 발표에서는 탐구 동기를 설명했습니다. 질량은 3.14mg으로 측정했습니다. 두 시료를 비교했습니다.';
  const setup = fixture(raw, 'EVIDENCE'), wire = realtimeCoreWireSchema(setup.session);
  const options = coreQuoteOptions(raw);
  const unrelated = options.find(quote => quote.startsWith('2학년') && !hasObservedMeasurement(raw, quote) && !hasObservedComparison(raw, quote))!;
  const measured = options.find(quote => quote.includes('3.14mg') && hasObservedMeasurement(raw, quote))!;
  const compared = options.find(quote => quote.includes('비교했') && hasObservedComparison(raw, quote))!;
  assert.ok(unrelated); assert.ok(measured); assert.ok(compared);
  const partial = (goal: string, quote: string, reasonCode = 'MISSING_REQUESTED_DETAIL') => ({ decision: { classification: 'partial', reasonCode, keywordQuote: quote, followUpGoal: goal } });
  assert.equal(wire.safeParse(partial('measurement', unrelated)).success, false);
  assert.equal(wire.safeParse(partial('measurement', unrelated, 'CLAIM_REQUIRES_DETAIL')).success, false);
  assert.equal(wire.safeParse(partial('comparison', unrelated)).success, false);
  assert.equal(wire.safeParse(partial('measurement', measured)).success, true);
  assert.equal(wire.safeParse(partial('measurement', measured, 'CLAIM_REQUIRES_DETAIL')).success, true);
  assert.equal(wire.safeParse(partial('comparison', compared)).success, true);
  const input = JSON.parse(realtimeCoreRequest(setup.session).input);
  assert.ok(input.answer.constrainedQuoteOptions.measurement.includes(measured));
  assert.ok(!input.answer.constrainedQuoteOptions.measurement.includes(unrelated));
  assert.ok(!input.answer.constrainedQuoteOptions.comparison.includes(unrelated));
  assert.ok(zodTextFormat(wire, 'quote_bound_core').schema);
});

test('calendar and school-grade numbers alone cannot open measurement in either missing-detail or claim verification', () => {
  const setup = fixture('2학년 때 2025년 3월 2일에 자료를 조사했습니다.', 'EVIDENCE');
  const input = JSON.parse(realtimeCoreRequest(setup.session).input);
  assert.ok(!input.allowedFollowUpGoals.includes('measurement'));
  assert.ok(!input.followUpGoalsByReason.CLAIM_REQUIRES_DETAIL.includes('measurement'));
  const wire = realtimeCoreWireSchema(setup.session), quote = coreQuoteOptions(setup.turn.rawTranscript!)[0];
  for (const reasonCode of ['MISSING_REQUESTED_DETAIL', 'CLAIM_REQUIRES_DETAIL']) assert.equal(wire.safeParse({ decision: { classification: 'partial', reasonCode, keywordQuote: quote, followUpGoal: 'measurement' } }).success, false);
});

test('explicit fragments, apologies and silence need zero model calls and preserve the original non-evaluative target', async () => {
  for (const raw of ['같은 ', '죄송합니다.', '']) {
    const setup = fixture(raw);
    const result = await runRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, request: async () => { throw new Error('Do not call'); } });
    assert.equal(result.providerTimings.coreModelCalls, 0); assert.equal(result.draft, null);
    assert.equal(result.reaction.directive, 'clarification_same_target'); assert.equal(result.reaction.keywordQuote, null);
    assert.equal(result.reaction.missingTarget, setup.turn.metadata.targetEvidence[0]);
  }
});

test('short meaningful terms and negative answers are not blanket-rejected and proceed through exactly one core call', async () => {
  for (const raw of ['백금입니다.', '아니요.', '없었습니다.', '같은 조건에서 온도를 비교했습니다.']) {
    const setup = fixture(raw); let calls = 0;
    const result = await runRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, request: async () => { calls++; return relevant; } });
    assert.equal(calls, 1); assert.equal(result.reaction.classification, 'relevant'); assert.equal(result.reaction.directive, 'next_main'); assert.equal(result.draft, null);
  }
});

test('invalid output, invented quote or provider failure gets one observed unassessed fallback with no model retry', async () => {
  for (const request of [
    async () => ({ decision: { classification: 'partial', reasonCode: 'MISSING_REQUESTED_DETAIL', keywordQuote: '없는 성과 30%', followUpGoal: 'process' } }),
    async () => ({ decision: { ...relevant.decision, questionText: '자유 생성한 새 질문' } }),
    async () => { throw Object.assign(new Error('Transport failed'), { name: 'APIConnectionTimeoutError' }); },
  ]) {
    const setup = fixture(), before = structuredClone(setup.session); let calls = 0;
    const result = await runRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, request: async () => { calls++; return request(); } });
    assert.equal(calls, 1); assert.equal(result.providerTimings.coreModelCalls, 1); assert.equal(result.providerTimings.coreFallback, 1);
    assert.equal(result.origin, 'fallback'); assert.equal(result.reaction.classification, 'unassessed'); assert.equal(result.draft, null);
    assert.equal(result.reaction.directive, 'clarification_same_target'); assert.ok(result.failureCode);
    assert.deepEqual(setup.session, before);
  }
});

test('exhausted follow-up or clarification budget transitions through the offline-main path without a new demand', async () => {
  const setup = fixture(); let calls = 0;
  const result = await runRealtimeCore(setup.context, setup.session, { allowFollowUp: false, allowClarification: false, request: async () => { calls++; return { decision: { classification: 'partial', reasonCode: 'MISSING_REQUESTED_DETAIL', keywordQuote: reactionQuoteOptions(setup.turn.rawTranscript!)[0], followUpGoal: 'process' } }; } });
  assert.equal(calls, 1); assert.equal(result.reaction.directive, 'next_main'); assert.equal(result.draft, null);
  setup.turn.rawTranscript = '';
  setup.turn.answerObservation = { classification: 'silence_observed', nonAnswer: true, durationMs: 1000, speakingMs: 0, silenceMs: 1000, firstSpeechMs: null, speechDetected: false, rawTranscriptPreserved: true, origin: 'finalized-stt-and-observed-speech-timing' };
  const silent = await runRealtimeCore(setup.context, setup.session, { allowFollowUp: false, allowClarification: false });
  assert.equal(silent.reaction.directive, 'next_main'); assert.equal(silent.providerTimings.coreModelCalls, 0);
});

test('same-root correction and earlier finalized words reach the single core together without replacing either answer', async () => {
  const setup = fixture('공식 기관의 자료를 봤습니다. 결과 수치는 없었습니다.');
  setup.turn.metadata.primaryFunction = 'CHOICE'; setup.turn.metadata.targetEvidence = ['선택 기준'];
  setup.session.turns.push({ ...setup.turn, id: 'c1', answerId: 'answer1', questionKind: 'clarification', rawTranscript: '정확히는 기관 이름이 아니라 작성 연도를 비교했습니다.' });
  let calls = 0;
  const result = await runRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, request: async request => {
    calls++; const context = JSON.parse(request.input).context;
    assert.deepEqual(context.answers.map((answer: { rawTranscript: string }) => answer.rawTranscript), setup.session.turns.map(turn => turn.rawTranscript));
    assert.ok(context.answers[1].languageSignals.some((signal: { kind: string }) => signal.kind === 'correction'));
    return relevant;
  } });
  assert.equal(calls, 1); assert.equal(result.reaction.directive, 'next_main');
});

test('wrong root, unfinalized transcript, source hashes or modified question are rejected before a core call', async () => {
  for (const change of [
    (setup: ReturnType<typeof fixture>) => { setup.turn.parentMainQuestionId = 'other'; },
    (setup: ReturnType<typeof fixture>) => { setup.turn.transcriptStatus = 'error'; },
    (setup: ReturnType<typeof fixture>) => { (setup.session.sourceManifest as InterviewContext['manifest']).files[0].sha256 = 'b'.repeat(64); },
    (setup: ReturnType<typeof fixture>) => { setup.turn.questionText = '임의로 변경한 질문'; },
  ]) {
    const setup = fixture(); change(setup); let calls = 0;
    await assert.rejects(runRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, request: async () => { calls++; return relevant; } }), RealtimeCoreSourceError);
    assert.equal(calls, 0);
  }
});

test('model wire prohibits arbitrary questions, new numeric quotes and unrelated follow-up goals', () => {
  const setup = fixture(); const wire = realtimeCoreWireSchema(setup.session);
  const partial = { classification: 'partial', reasonCode: 'MISSING_REQUESTED_DETAIL', keywordQuote: reactionQuoteOptions(setup.turn.rawTranscript!)[0], followUpGoal: 'process' };
  assert.equal(wire.safeParse({ decision: partial }).success, true);
  assert.equal(wire.safeParse({ decision: { ...partial, followUpGoal: 'own_action' } }).success, false);
  assert.equal(wire.safeParse({ decision: { ...partial, keywordQuote: '30% 상승했습니다' } }).success, false);
  assert.equal(wire.safeParse({ decision: { ...partial, questionText: '추가 자유 문장' } }).success, false);
  assert.ok(zodTextFormat(wire, 'single_core').schema);
});

test('quote budget covers late corrections and keeps decimal values and units intact', () => {
  const prefix = Array.from({ length: 18 }, (_, index) => `처음에는 자료 ${index}의 내용을 차례로 확인했습니다.`).join(' ');
  const raw = `${prefix} 정정하겠습니다. 정확히는 3.14mg의 질량을 직접 비교했습니다.`;
  const options = coreQuoteOptions(raw);
  assert.ok(options.length <= 16);
  assert.ok(options.some(quote => quote.includes('3.14mg')));
  assert.ok(options.some(quote => quote.includes('직접 비교했습니다')));
  for (const quote of options) { assert.ok(raw.includes(quote)); assert.ok(quote.length <= 28); }
  assert.deepEqual(coreQuoteOptions('같은 '), []);
});

test('a channel-only answer cannot pass an explicit basis question, while actual channel requests and concrete observations remain intact', async () => {
  const setup = fixture('인터넷에서 자료를 찾아봤습니다.', 'EVIDENCE'); let calls = 0;
  const guarded = await runRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, request: async () => { calls++; return relevant; } });
  assert.equal(calls, 1); assert.equal(guarded.reaction.classification, 'partial'); assert.equal(guarded.followUpGoal, 'basis');
  assert.equal(guarded.draft?.questionKind, 'follow_up'); assert.deepEqual(guarded.serverGuards, ['REQUESTED_BASIS_NOT_PROVIDED']);
  const channel = fixture('인터넷에서 자료를 찾아봤습니다.', 'EVIDENCE');
  channel.turn.questionText = '자료를 어디서 찾았나요?'; channel.turn.metadata.premiseValidation!.questionSha256 = createHash('sha256').update(channel.turn.questionText).digest('hex');
  const accepted = await runRealtimeCore(channel.context, channel.session, { allowFollowUp: true, allowClarification: true, request: async () => relevant });
  assert.equal(accepted.reaction.classification, 'relevant'); assert.equal(accepted.serverGuards, undefined);
  const concrete = fixture('두 자료의 작성 연도를 비교했습니다.', 'EVIDENCE');
  const observed = await runRealtimeCore(concrete.context, concrete.session, { allowFollowUp: true, allowClarification: true, request: async () => relevant });
  assert.equal(observed.reaction.classification, 'relevant'); assert.equal(observed.serverGuards, undefined);
});
