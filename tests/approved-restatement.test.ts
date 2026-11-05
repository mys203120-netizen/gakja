import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { InterviewSession, QuestionDraft, RecordedTurn } from '../server/protocol';
import { approvedRestatement } from '../server/providers/approved-restatement';
import { finalizeAnswerReaction } from '../server/providers/answer-reaction';
import { buildQuestionPremiseReviewInput, finalizeQuestionPremiseReview } from '../server/providers/question-premises';
import { runRealtimeCore, coreQuoteOptions } from '../server/providers/realtime-core';
import { createQuestionBlueprint, approveQuestionContract, assertQuestionContractIntegrity } from '../server/question-objective';
import { buildQuestionAnchorCandidates, renderQuestionIR, restoreQuestionIR } from '../server/providers/question-realization';

function fixture(greeting = '') {
  const sources = [{ id: 'E01', text: '실험 자료의 출처와 작성 연도를 비교함.' }];
  const draft: QuestionDraft = { acknowledgement: null, acknowledgementQuote: null, questionText: `${greeting}실험 자료를 선택한 기준은 무엇인가요?`, questionKind: 'main', parentMainQuestionId: null, evidenceIds: ['E01'], evidenceQuotes: [{ evidenceId: 'E01', quote: sources[0].text }], primaryFunction: 'CHOICE', questionIntent: '실험 자료 선택 기준 확인', targetEvidence: ['자료 선택 기준'], depth: 'D2', groundingRationale: '실제 자료 비교 기록을 질문한다.', validationStatus: 'approved', validationFailures: [] };
  const audit = finalizeQuestionPremiseReview({ verdict: 'allowed', completeAssertionCoverage: true, coreIntentCount: 1, intentMatches: true, clarificationPreservesIntent: true, premises: [{ questionSpan: '실험 자료', basis: 'record', sourceId: 'E01', supportQuote: sources[0].text, supported: true }] }, buildQuestionPremiseReviewInput(draft, sources), 'synthetic-review-fixture');
  const context = { errors: [], student: { evidence: sources }, manifest: { rulesVersion: 'test-rules', sourceIntegrity: { pdfHashVerified: true, evidenceReferencesVerified: true, evidenceTextVerified: true }, files: [{ role: 'studentPdf', path: 'student.pdf', sha256: 'a'.repeat(64) }] } } as unknown as InterviewContext;
  const turn = { id: 'q0', parentMainQuestionId: 'q0', answerId: 'a0', questionText: draft.questionText, questionKind: 'main', evidenceIds: ['E01'], transcriptStatus: 'finalized', rawTranscript: '죄송합니다.', metadata: { ...draft, rulesVersion: 'test-rules', premiseValidation: audit, questionClusterId: 'q0' } } as unknown as RecordedTurn;
  const session = { turns: [turn], sourceManifest: structuredClone(context.manifest), followUpCountByMainQuestion: {} } as unknown as InterviewSession;
  const reaction = finalizeAnswerReaction({ classification: 'non_answer', action: 'clarify', reasonCode: 'APOLOGY_ONLY', keywordQuote: null, reply: null, evidenceSpan: null, missingTarget: null }, session, true);
  return { context, session, sources, reaction, turn };
}

test('same approved words and purpose reuse their source-bound audit without new generation or review', () => {
  const setup = fixture(), snapshot = structuredClone(setup.session);
  const result = approvedRestatement(setup.context, setup.session, setup.sources, setup.reaction)!;
  assert.ok(result); assert.equal(result.questionText, setup.turn.questionText);
  assert.equal(result.questionKind, 'clarification'); assert.equal(result.primaryFunction, setup.turn.metadata.primaryFunction);
  assert.equal(result.questionIntent, setup.turn.metadata.questionIntent); assert.deepEqual(result.targetEvidence, setup.turn.metadata.targetEvidence);
  assert.equal(result.premiseValidation?.method, 'verified_approved_restatement'); assert.equal(result.premiseValidation?.reusedFrom?.turnId, 'q0');
  assert.equal(result.providerTimings?.premiseReviewAttempts, 0); assert.equal(result.providerTimings?.approvedRestatementReuse, 1);
  assert.deepEqual(setup.session, snapshot);
});

test('only a standalone greeting is safely removed, with new hash and shifted proof offsets, so no re-greeting occurs', () => {
  const setup = fixture('안녕하세요. '), result = approvedRestatement(setup.context, setup.session, setup.sources, setup.reaction)!;
  assert.ok(result); assert.equal(result.questionText, '실험 자료를 선택한 기준은 무엇인가요?');
  assert.equal(result.premiseValidation?.reusedFrom?.transform, 'remove_standalone_greeting');
  assert.equal(result.premiseValidation?.questionSha256, createHash('sha256').update(result.questionText).digest('hex'));
  const proof = result.premiseValidation!.supportedPremises[0];
  assert.equal(result.questionText.slice(proof.questionStartOffset, proof.questionEndOffset), '실험 자료');
});

test('changed question, PDF hash, rules, transcript, missing audit or malformed proof cannot reuse an approval', () => {
  const changes = [
    (setup: ReturnType<typeof fixture>) => { setup.turn.questionText = '성과가 30% 증가한 근거는 무엇인가요?'; },
    (setup: ReturnType<typeof fixture>) => { (setup.session.sourceManifest as InterviewContext['manifest']).files[0].sha256 = 'b'.repeat(64); },
    (setup: ReturnType<typeof fixture>) => { setup.turn.metadata.rulesVersion = 'different'; },
    (setup: ReturnType<typeof fixture>) => { setup.turn.transcriptStatus = 'error'; },
    (setup: ReturnType<typeof fixture>) => { delete setup.turn.metadata.premiseValidation; },
    (setup: ReturnType<typeof fixture>) => { setup.turn.metadata.premiseValidation!.supportedPremises[0].sourceEndOffset = 99999; },
    (setup: ReturnType<typeof fixture>) => { setup.context.errors.push('invalid sources'); },
  ];
  for (const change of changes) { const setup = fixture(); change(setup); assert.equal(approvedRestatement(setup.context, setup.session, setup.sources, setup.reaction), null); }
});

test('a constrained F can be restated after silence only while its earlier finalized same-root answer and exact template remain intact', async () => {
  const setup = fixture(); setup.turn.rawTranscript = '실험 자료를 비교했습니다.';
  const core = await runRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, request: async () => ({ decision: { classification: 'partial', reasonCode: 'MISSING_REQUESTED_DETAIL', keywordQuote: coreQuoteOptions(setup.turn.rawTranscript!)[0], followUpGoal: 'choice' } }) });
  assert.ok(core.draft); const followUp = core.draft;
  followUp.questionReferenceContext = { schemaVersion: 'book-question-reference-v1', catalogSha256: 'c'.repeat(64), exampleIds: ['synthetic-reference'], purpose: 'wording_reference_only' };
  setup.session.turns.push({ ...setup.turn, id: 'f1', answerId: 'f1-answer', questionKind: 'follow_up', questionText: followUp.questionText, rawTranscript: '', metadata: { ...setup.turn.metadata, ...followUp, rulesVersion: 'test-rules' } });
  const reaction = finalizeAnswerReaction({ classification: 'non_answer', action: 'clarify', reasonCode: 'NO_ANSWER', keywordQuote: null, reply: null, evidenceSpan: null, missingTarget: null }, setup.session, true);
  const result = approvedRestatement(setup.context, setup.session, setup.sources, reaction);
  assert.ok(result); assert.equal(result.questionText, followUp.questionText); assert.equal(result.questionKind, 'clarification');
  assert.equal(result.premiseValidation?.method, 'verified_approved_restatement'); assert.equal(result.premiseValidation?.reusedFrom?.turnId, 'f1');
  assert.equal(result.providerTimings?.premiseReviewAttempts, 0);
  assert.deepEqual(result.followUpLanguage, followUp.followUpLanguage);
  assert.deepEqual(result.questionReferenceContext, followUp.questionReferenceContext);
  assert.notEqual(result.followUpLanguage, followUp.followUpLanguage);
  const originalAnswer = setup.turn.rawTranscript!;
  setup.turn.rawTranscript = '이전 인용과 다른 실제 답변';
  assert.equal(approvedRestatement(setup.context, setup.session, setup.sources, reaction), null);
  setup.turn.rawTranscript = originalAnswer;
  setup.turn.answerId = 'changed-answer';
  assert.equal(approvedRestatement(setup.context, setup.session, setup.sources, reaction), null);
});

function strategyFixture(mode: 'none' | 'short_context' | 'exact_quote' = 'none') {
  const setup = fixture();
  const source = setup.context.student.evidence[0];
  Object.assign(source, { activityId: 'activity-E01', grade: 1, page: 1, section: '합성 테스트', title: '합성 자료 비교', confirmationStatus: 'confirmed_from_record', sourceRef: { file: 'student.pdf', pdfSha256: 'a'.repeat(64), page: 1, extraction: 'fixture', startOffset: 0, endOffset: source.text.length } });
  setup.turn.rawTranscript = '인터넷 자료를 찾아봤습니다.';
  const anchors = buildQuestionAnchorCandidates({ turnId: setup.turn.id, answerId: setup.turn.answerId!, rawTranscript: setup.turn.rawTranscript });
  const rendered = renderQuestionIR({ operation: 'evidence_verification', anchorId: anchors[0].id, anchorMode: mode, secondaryAnchorId: null }, { anchors, seed: 'saved-restatement' });
  const draft: QuestionDraft = { acknowledgement: null, acknowledgementQuote: null, questionText: rendered.questionText, questionKind: 'follow_up', parentMainQuestionId: 'q0', evidenceIds: ['E01'], evidenceQuotes: [{ evidenceId: 'E01', quote: source.text }], primaryFunction: rendered.primaryFunction, questionIntent: rendered.questionIntent, targetEvidence: [...rendered.targetEvidence], depth: rendered.depth, groundingRationale: '실제 답변 출처에 연결한 합성 구조 검증이다.', validationStatus: 'approved', validationFailures: [], premiseValidation: { version: 'question-premise-v1', guidelineVersion: '2.3', status: 'approved', method: 'approved_strategy_ir', reviewModel: rendered.policyVersion, questionSha256: rendered.validation.questionSha256, coreIntentCount: 1, supportedPremises: rendered.proof, openChecks: rendered.openChecks }, questionRealization: { policyVersion: rendered.policyVersion, operation: rendered.ir.operation, anchorMode: mode, anchorId: rendered.anchor.id, templateId: rendered.templateId, family: rendered.family, strategyId: null, semanticReview: 'not_independently_reviewed', anchorProof: rendered.anchorProof }, strategyTrace: { catalogDigest: null, selectedCardId: null, candidateCardIds: [], sourceQuestionIds: [], policyVersion: 'explicit-synthetic', selectionReason: '원래 판단 기준의 실제 근거를 확인한다.' } };
  draft.questionBlueprint = createQuestionBlueprint(draft, setup.context, setup.session, { questionId: 'f1', answerRefs: [{ turnId: setup.turn.id, answerId: setup.turn.answerId!, start: anchors[0].start, end: anchors[0].end }], subordinationRationale: '원래 판단 기준의 실제 근거를 확인한다.' });
  draft.approvedQuestion = approveQuestionContract(draft, draft.questionBlueprint);
  const follow = { ...setup.turn, id: 'f1', answerId: 'f1-answer', questionKind: 'follow_up' as const, questionText: draft.questionText, rawTranscript: '', metadata: { ...setup.turn.metadata, ...draft, rulesVersion: 'test-rules' } };
  setup.session.turns.push(follow);
  setup.session.followUpCountByMainQuestion.q0 = 1;
  const reaction = finalizeAnswerReaction({ classification: 'non_answer', action: 'clarify', reasonCode: 'NO_ANSWER', keywordQuote: null, reply: null, evidenceSpan: null, missingTarget: null }, setup.session, true);
  return { ...setup, draft, follow, reaction, anchors, rendered };
}

test('saved strategy IR restates none/short/exact surfaces with original internal anchors and a fresh clarification contract', () => {
  for (const mode of ['none', 'short_context', 'exact_quote'] as const) {
    const setup = strategyFixture(mode);
    assertQuestionContractIntegrity({ ...setup.follow.metadata, acknowledgement: null, acknowledgementQuote: null, questionText: setup.follow.questionText, questionKind: setup.follow.questionKind, parentMainQuestionId: setup.follow.parentMainQuestionId, evidenceIds: setup.follow.evidenceIds }, setup.follow.metadata.approvedQuestion!);
    assert.equal(restoreQuestionIR(setup.rendered.ir, { anchors: setup.anchors, templateId: setup.rendered.templateId, questionText: setup.rendered.questionText, primaryTurnId: 'q0' }).questionText, setup.rendered.questionText);
    const result = approvedRestatement(setup.context, setup.session, setup.sources, setup.reaction);
    assert.ok(result, mode);
    assert.equal(result.questionText, setup.follow.questionText);
    assert.equal(result.questionKind, 'clarification');
    assert.equal(result.premiseValidation?.method, 'verified_approved_restatement');
    assert.deepEqual(result.questionRealization, setup.follow.metadata.questionRealization);
    assert.deepEqual(result.strategyTrace, setup.follow.metadata.strategyTrace);
    assert.ok(result.questionBlueprint?.anchorRefs.some(ref => ref.kind === 'ANSWER_TURN' && ref.sourceId === 'ANSWER_TURN:q0:a0'));
    assert.equal(result.approvedQuestion?.validation.independentSemanticReview, false);
    assert.equal(result.approvedQuestion?.validation.method, 'approved_restatement');
    assert.notEqual(result.approvedQuestion?.semanticContractSha256, setup.follow.metadata.approvedQuestion?.semanticContractSha256);
    assertQuestionContractIntegrity(result, result.approvedQuestion!);
    assert.equal(result.providerTimings?.premiseReviewAttempts, 0);
  }
});

test('strategy reuse rejects missing contract, changed source revision, wrong cluster, modified IR and altered internal proof', () => {
  const changes = [
    (setup: ReturnType<typeof strategyFixture>) => { delete setup.follow.metadata.approvedQuestion; },
    (setup: ReturnType<typeof strategyFixture>) => { setup.turn.rawTranscript += ' 다른 문장'; },
    (setup: ReturnType<typeof strategyFixture>) => { setup.turn.parentMainQuestionId = 'different-root'; },
    (setup: ReturnType<typeof strategyFixture>) => { setup.follow.metadata.questionRealization!.operation = 'alternative'; },
    (setup: ReturnType<typeof strategyFixture>) => { setup.follow.metadata.questionRealization!.templateId = 'unregistered-template'; },
    (setup: ReturnType<typeof strategyFixture>) => { setup.follow.metadata.questionRealization!.anchorProof![0].sourceEndOffset--; },
    (setup: ReturnType<typeof strategyFixture>) => { setup.follow.metadata.questionRealization!.anchorProof![0].sourceSha256 = 'b'.repeat(64); },
    (setup: ReturnType<typeof strategyFixture>) => { setup.follow.metadata.targetEvidence = ['묻지 않은 새로운 요구']; },
  ];
  for (const change of changes) {
    const setup = strategyFixture(); change(setup);
    assert.equal(approvedRestatement(setup.context, setup.session, setup.sources, setup.reaction), null);
  }
});

test('a contracted main greeting is verified before removal and receives a different valid clarification contract', () => {
  const setup = fixture('안녕하세요. ');
  const source = setup.context.student.evidence[0];
  Object.assign(source, { activityId: 'activity-E01', grade: 1, page: 1, section: '합성 테스트', title: '합성 자료 비교', confirmationStatus: 'confirmed_from_record', sourceRef: { file: 'student.pdf', pdfSha256: 'a'.repeat(64), page: 1, extraction: 'fixture', startOffset: 0, endOffset: source.text.length } });
  const original: QuestionDraft = { ...setup.turn.metadata, acknowledgement: null, acknowledgementQuote: null, questionText: setup.turn.questionText, questionKind: 'main', parentMainQuestionId: null, evidenceIds: setup.turn.evidenceIds };
  original.questionBlueprint = createQuestionBlueprint(original, setup.context, { ...setup.session, turns: [] }, { questionId: 'q0' });
  original.approvedQuestion = approveQuestionContract(original, original.questionBlueprint);
  Object.assign(setup.turn.metadata, { questionBlueprint: original.questionBlueprint, approvedQuestion: original.approvedQuestion });
  const result = approvedRestatement(setup.context, setup.session, setup.sources, setup.reaction);
  assert.ok(result);
  assert.equal(result.questionText.startsWith('안녕하세요'), false);
  assert.equal(result.premiseValidation?.reusedFrom?.transform, 'remove_standalone_greeting');
  assert.notEqual(result.approvedQuestion?.finalUtteranceSha256, original.approvedQuestion.finalUtteranceSha256);
  assert.equal(result.approvedQuestion?.validation.method, 'approved_restatement');
  assertQuestionContractIntegrity(result, result.approvedQuestion!);
  setup.turn.questionText += ' 추가 요구';
  assert.equal(approvedRestatement(setup.context, setup.session, setup.sources, setup.reaction), null);
});
