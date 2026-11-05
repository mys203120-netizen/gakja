import test from 'node:test';
import assert from 'node:assert/strict';
import type { InterviewContext, StudentEvidence } from '../server/data/load-interview-context';
import type { InterviewSession, QuestionDraft, RecordedTurn } from '../server/protocol';
import type { QuestionStrategyCatalog } from '../server/data/question-strategy-catalog';
import type { QuestionOperation } from '../server/providers/question-realization';
import { questionOperationProfile } from '../server/providers/question-realization';
import type { RealtimeCoreRequest } from '../server/providers/realtime-core';
import { RealtimeCoreSourceError } from '../server/providers/realtime-core';
import { runStrategyRealtimeCore } from '../server/providers/realtime-strategy-core';
import { buildQuestionPremiseReviewInput, finalizeQuestionPremiseReview } from '../server/providers/question-premises';
import { createQuestionBlueprint, approveQuestionContract, assertQuestionContractIntegrity, bindQuestionContractToTurn } from '../server/question-objective';

function fixture(raw = '자료의 작성 시점과 조사 대상을 비교했습니다.', primary: 'PROCESS' | 'EVIDENCE' = 'PROCESS') {
  const source: StudentEvidence = { id: 'E01', activityId: 'A01', page: 3, grade: 2, section: '세특', title: '자료 조사', text: '자료를 선택해 비교하는 탐구를 진행함.', sourceRef: { file: 'synthetic-student.pdf', pdfSha256: 'a'.repeat(64), page: 3, extraction: 'synthetic-test', startOffset: 10, endOffset: 33 }, confirmationStatus: 'confirmed_from_record', preparationPriority: null, scientificTruthVerification: 'not_independently_verified' };
  const draft: QuestionDraft = { acknowledgement: null, acknowledgementQuote: null, questionText: primary === 'PROCESS' ? '자료를 비교한 과정은 무엇인가요?' : '자료를 보고 내린 판단의 근거는 무엇인가요?', questionKind: 'main', parentMainQuestionId: null, evidenceIds: ['E01'], evidenceQuotes: [{ evidenceId: 'E01', quote: source.text }], primaryFunction: primary, questionIntent: primary === 'PROCESS' ? '실제 자료 비교 과정 확인' : '실제 판단 근거 확인', targetEvidence: [primary === 'PROCESS' ? '실제로 거친 한 단계' : '판단 근거 한 가지'], depth: 'D2', groundingRationale: '기록된 자료 비교의 한 가지 목적을 확인한다.', validationStatus: 'approved', validationFailures: [] };
  const audit = finalizeQuestionPremiseReview({ verdict: 'allowed', completeAssertionCoverage: true, coreIntentCount: 1, intentMatches: true, clarificationPreservesIntent: true, premises: [{ questionSpan: '자료를', basis: 'record', sourceId: 'E01', supportQuote: source.text, supported: true }] }, buildQuestionPremiseReviewInput(draft, [source]), 'explicit-synthetic-offline-review');
  draft.premiseValidation = audit;
  const context = { questionReferences: null, questionStrategies: null, errors: [], student: { evidence: [source] }, school: { sources: [] }, interviewOverview: null, manifest: { rulesVersion: 'target-first-test', sourceIntegrity: { pdfHashVerified: true, evidenceReferencesVerified: true, evidenceTextVerified: true, evidenceCount: 1 }, files: [{ role: 'studentPdf', path: 'synthetic-student.pdf', sha256: source.sourceRef.pdfSha256 }] } } as unknown as InterviewContext;
  const session = { id: 'target-first-synthetic-session', sourceManifest: structuredClone(context.manifest), followUpCountByMainQuestion: {}, elapsedMs: 0, durationSeconds: 720, turns: [] } as unknown as InterviewSession;
  const blueprint = createQuestionBlueprint(draft, context, session, { questionId: 'q0' });
  draft.questionBlueprint = blueprint;
  draft.approvedQuestion = approveQuestionContract(draft, blueprint);
  const turn = { id: 'q0', answerId: 'answer0', parentMainQuestionId: 'q0', mainIndex: 1, mainCount: 5, questionText: draft.questionText, questionKind: 'main', followUpIndex: 0, evidenceIds: ['E01'], rawTranscript: raw, transcriptStatus: 'finalized', metadata: { ...draft, rulesVersion: 'target-first-test', questionClusterId: 'q0', activityIds: ['A01'] } } as unknown as RecordedTurn;
  session.turns.push(turn);
  return { context, session, turn };
}

function followUp(request: RealtimeCoreRequest, operation: QuestionOperation = 'process', fulfillment: 'met' | 'partial' = 'partial', overrides: Record<string, unknown> = {}) {
  const input = JSON.parse(request.input);
  const anchor = input.answer.anchors.find((candidate: { sourceId: string }) => candidate.sourceId === `ANSWER_TURN:${input.actualAnswers.currentTurnId}:${input.actualAnswers.answers.at(-1).answerId}`) ?? input.answer.anchors[0];
  return { answerRelation: { kind: 'related', note: '현재 질문의 실제 답변과 연결되는 한 요소를 확인한다.' }, decision: { fulfillment, action: 'FOLLOW_UP', reason: fulfillment === 'met' ? 'same_objective_extension' : 'missing_requested_detail', questionIR: { operation, anchorId: anchor.id, anchorMode: 'none', secondaryAnchorId: null }, strategyId: null, subordinationRationale: '같은 묶음에서 실제 설명의 확인 범위를 한 지점 더 살펴본다.', ...overrides } };
}

function appendFollowUp(setup: ReturnType<typeof fixture>, draft: QuestionDraft, raw = '자료의 작성 목적도 살펴봤습니다.') {
  const next = { ...setup.turn, id: 'q1', answerId: 'answer1', questionText: draft.questionText, questionKind: 'follow_up', followUpIndex: 1, rawTranscript: raw, metadata: { ...draft, rulesVersion: 'target-first-test', questionClusterId: 'q0', activityIds: ['A01'] } } as unknown as RecordedTurn;
  setup.session.turns.push(next);
  setup.session.followUpCountByMainQuestion.q0 = 1;
  return next;
}

function syntheticCatalog() {
  const card = { id: 'SC-explicit-synthetic', questionId: 'BOOKQ-explicit-synthetic', operation: 'evidence_verification', primaryFunctions: ['EVIDENCE'], depth: 'D2', assessmentTarget: '판단의 근거', trigger: 'always', triggerDescription: '실제 답변의 판단 근거 확인', requiredClaimSlots: ['actual_answer'], notApplicableWhen: [], expectedEvidence: ['판단을 지지하는 근거 한 가지'], prohibitedPresuppositions: [], surface: { anchorMode: 'none', directness: 'direct', cognitiveDemandCount: 1 }, sourceBindings: [{ questionId: 'BOOKQ-explicit-synthetic' }], relations: [], questionText: 'BOOK_PRIVATE_STUDENT_FACT_999' };
  return { card, catalog: { schemaVersion: 'question-strategy-catalog-v1', key: 'explicit-synthetic-key', cards: [card], coverage: { complete: true }, contentSha256: 'explicit-synthetic-catalog' } as unknown as QuestionStrategyCatalog };
}

function attachCatalog(setup: ReturnType<typeof fixture>, catalog: QuestionStrategyCatalog) {
  setup.context.questionStrategies = catalog;
  setup.context.manifest.questionStrategyCatalog = { version: catalog.schemaVersion, key: catalog.key, contentSha256: catalog.contentSha256, coverage: catalog.coverage };
  setup.session.sourceManifest = structuredClone(setup.context.manifest);
}

test('the target-first core uses one call and creates a nonquoted partial-answer F with internal source proof and pinned evaluation contract', async () => {
  const setup = fixture(); let calls = 0;
  const original = setup.turn.rawTranscript;
  const result = await runStrategyRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async request => {
    calls++;
    assert.equal(request.store, false); assert.equal(request.reasoning.effort, 'none');
    const input = JSON.parse(request.input);
    assert.equal(input.answer.finalTranscript, original);
    assert.equal(input.allowedOperations.includes('limit'), true, 'later operations are not locked to the original goal');
    assert.equal('bookQuestionExamples' in input, false);
    assert.equal('sourceActivityUnits' in input, false);
    return followUp(request);
  } });
  assert.equal(calls, 1); assert.equal(result.origin, 'model');
  assert.equal(result.providerTimings.coreModelCalls, 1); assert.equal(result.fulfillment, 'partial');
  assert.equal(result.nextAction, 'FOLLOW_UP'); assert.equal(result.draft?.primaryFunction, 'PROCESS');
  assert.equal(result.draft?.questionRealization?.anchorMode, 'none');
  assert.equal(result.draft?.premiseValidation?.supportedPremises.length, 0);
  assert.equal(result.draft?.premiseValidation?.method, 'approved_strategy_ir');
  const proof = result.draft!.questionRealization!.anchorProof![0];
  assert.equal(proof.sourceId, 'ANSWER_TURN:q0:answer0');
  assert.equal(proof.questionStartOffset, null);
  assert.equal(original!.slice(proof.sourceStartOffset, proof.sourceEndOffset), result.reaction.keywordQuote);
  assert.ok(!result.draft!.questionText.includes(result.reaction.keywordQuote!));
  assert.equal(result.draft!.approvedQuestion!.validation.independentSemanticReview, false);
  assert.doesNotThrow(() => assertQuestionContractIntegrity(result.draft!, result.draft!.approvedQuestion!));
  assert.equal(setup.turn.rawTranscript, original);
});

test('a sufficient answer can receive one useful subordinate extension without being mislabeled partial', async () => {
  const setup = fixture('조사 대상이 같고 작성 시점이 가까운 자료라서 판단했습니다.', 'EVIDENCE');
  const result = await runStrategyRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async request => followUp(request, 'limit', 'met') });
  assert.equal(result.origin, 'model'); assert.equal(result.fulfillment, 'met');
  assert.equal(result.reaction.classification, 'relevant'); assert.equal(result.reaction.action, 'probe');
  assert.equal(result.nextAction, 'FOLLOW_UP'); assert.equal(result.draft?.primaryFunction, 'LIMIT');
  assert.equal(result.draft?.depth, 'D4');
  assert.equal(result.draft?.questionBlueprint?.clusterObjective.id, setup.turn.metadata.questionBlueprint?.clusterObjective.id);
  assert.equal(result.providerTimings.coreModelCalls, 1);
});

test('a concrete fulfilled basis cannot be requested again under the same-objective-extension label', async () => {
  const raw = '조사 대상이 같은 최신 자료이고 출처가 확인되어 판단했습니다.';
  const setup = fixture(raw, 'EVIDENCE'); let calls = 0;
  const result = await runStrategyRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async request => {
    calls++;
    const input = JSON.parse(request.input);
    assert.equal(input.answer.finalTranscript, raw);
    return followUp(request, 'evidence_verification', 'met');
  } });
  assert.equal(result.origin, 'model'); assert.equal(result.fulfillment, 'met');
  assert.equal(result.requestedAction, 'FOLLOW_UP'); assert.equal(result.nextAction, 'TRANSITION');
  assert.equal(result.decisionReasonCode, 'same_objective_extension');
  assert.ok(result.serverGuards?.includes('SATISFIED_TARGET_ALREADY_MET'));
  assert.equal(result.reaction.classification, 'relevant'); assert.equal(result.reaction.action, 'proceed');
  assert.equal(result.reaction.directive, 'next_main'); assert.equal(result.draft, null);
  assert.equal(result.failureCode, undefined); assert.equal(result.providerTimings.coreFallback, 0);
  assert.equal(result.providerTimings.coreModelCalls, 1); assert.equal(calls, 1);
  assert.equal(setup.turn.rawTranscript, raw);
  assert.equal(setup.session.turns.length, 1);
});

test('a fulfilled F1 meaning request cannot be repeated through a different-function same-goal alias', async () => {
  const setup = fixture();
  const first = await runStrategyRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async request => followUp(request, 'answer_anchor', 'partial') });
  assert.equal(first.origin, 'model'); assert.ok(first.draft);
  const raw = '조사 대상은 설문에 참여한 사람의 범위를 뜻합니다.';
  const current = appendFollowUp(setup, first.draft!, raw);
  const aliasProfile = questionOperationProfile('concept_clarification');
  assert.notEqual(aliasProfile.primaryFunction, current.metadata.primaryFunction, 'this case exercises the same-goal branch rather than the same-function branch');
  assert.equal(aliasProfile.goal, current.metadata.followUpLanguage?.goal);
  let calls = 0;
  const result = await runStrategyRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async request => {
    calls++;
    const input = JSON.parse(request.input); assert.equal(input.answer.finalTranscript, raw);
    return followUp(request, 'concept_clarification', 'met');
  } });
  assert.equal(result.origin, 'model'); assert.equal(result.fulfillment, 'met');
  assert.equal(result.requestedAction, 'FOLLOW_UP'); assert.equal(result.nextAction, 'TRANSITION');
  assert.equal(result.decisionReasonCode, 'same_objective_extension');
  assert.ok(result.serverGuards?.includes('SATISFIED_TARGET_ALREADY_MET'));
  assert.equal(result.reaction.classification, 'relevant'); assert.equal(result.reaction.directive, 'next_main');
  assert.equal(result.draft, null); assert.equal(result.failureCode, undefined);
  assert.equal(result.providerTimings.coreFallback, 0); assert.equal(result.providerTimings.coreModelCalls, 1); assert.equal(calls, 1);
  assert.equal(current.rawTranscript, raw); assert.equal(setup.session.turns.length, 2);
});

test('a fulfilled answer may verify an actual new numeric claim without treating it as a repeated explanation', async () => {
  const raw = '작성 시점과 조사 대상이 같아 판단했습니다. 온도는 12도로 측정했습니다.';
  const setup = fixture(raw, 'EVIDENCE'); let calls = 0;
  const result = await runStrategyRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async request => {
    calls++;
    const input = JSON.parse(request.input);
    const numericAnchor = input.answer.anchors.find((anchor: { quote: string }) => anchor.quote.includes('12도'));
    assert.ok(numericAnchor);
    return followUp(request, 'numeric_verification', 'met', { reason: 'verify_actual_claim', questionIR: { operation: 'numeric_verification', anchorId: numericAnchor.id, anchorMode: 'none', secondaryAnchorId: null }, subordinationRationale: '이미 설명한 판단 이유를 반복하지 않고 새로 말한 온도 측정값의 확인 기준을 검증한다.' });
  } });
  assert.equal(result.origin, 'model'); assert.equal(result.fulfillment, 'met');
  assert.equal(result.requestedAction, 'FOLLOW_UP'); assert.equal(result.nextAction, 'FOLLOW_UP');
  assert.equal(result.decisionReasonCode, 'verify_actual_claim');
  assert.equal(result.serverGuards?.includes('SATISFIED_TARGET_ALREADY_MET') ?? false, false);
  assert.equal(result.reaction.classification, 'relevant'); assert.equal(result.draft?.questionRealization?.operation, 'numeric_verification');
  assert.equal(result.failureCode, undefined); assert.equal(result.providerTimings.coreFallback, 0);
  assert.equal(result.providerTimings.coreModelCalls, 1); assert.equal(calls, 1);
  assert.equal(setup.turn.rawTranscript, raw);
});

test('an unrelated answer cannot become a new claim probe even if the model proposes a valid F', async () => {
  const setup = fixture('오늘 점심에 피자를 먹었습니다.');
  const result = await runStrategyRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async request => ({ ...followUp(request), answerRelation: { kind: 'unrelated', note: '자료 비교 과정과 관계없는 식사 이야기이다.' } }) });
  assert.equal(result.origin, 'model'); assert.equal(result.fulfillment, 'unknown');
  assert.equal(result.reaction.classification, 'off_topic'); assert.equal(result.nextAction, 'CLARIFICATION');
  assert.equal(result.draft, null); assert.equal(result.reaction.keywordQuote, null);
  assert.deepEqual(result.serverGuards, ['ANSWER_RELATION_PRIORITY']);
  assert.equal(result.providerTimings.coreModelCalls, 1);
});

test('finalized silence is non-evaluative and invokes no model', async () => {
  const setup = fixture(''); let calls = 0;
  const result = await runStrategyRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async () => { calls++; throw new Error('Must not request'); } });
  assert.equal(calls, 0); assert.equal(result.origin, 'deterministic');
  assert.equal(result.providerTimings.coreModelCalls, 0); assert.equal(result.reaction.classification, 'non_answer');
  assert.equal(result.nextAction, 'CLARIFICATION'); assert.equal(result.draft, null);
  assert.equal(setup.turn.rawTranscript, '');
});

test('F2 can choose a different operation from F1 while retaining the original objective and two-question budget', async () => {
  const setup = fixture();
  const first = await runStrategyRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async request => followUp(request, 'process') });
  assert.ok(first.draft, JSON.stringify(first));
  const current = appendFollowUp(setup, first.draft!);
  const next = await runStrategyRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async request => {
    const input = JSON.parse(request.input);
    assert.equal(input.followUpsUsed, 1); assert.equal(input.allowedOperations.includes('alternative'), true);
    return followUp(request, 'alternative', 'met');
  } });
  assert.equal(next.origin, 'model'); assert.equal(next.nextAction, 'FOLLOW_UP');
  assert.equal(next.draft?.questionRealization?.operation, 'alternative');
  assert.equal(next.draft?.parentMainQuestionId, 'q0');
  assert.equal(next.draft?.questionBlueprint?.parentQuestionId, current.id);
  assert.equal(next.draft?.questionBlueprint?.answerTurnId, current.id);
  assert.equal(next.draft?.questionBlueprint?.clusterObjective.id, setup.turn.metadata.questionBlueprint?.clusterObjective.id);
  assert.equal(next.providerTimings.coreModelCalls, 1);
});

test('a nonquoted F survives actual turn UUID rebinding and remains valid for the next core call', async () => {
  for (const anchorMode of ['none', 'short_context'] as const) {
    const setup = fixture();
    const first = await runStrategyRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async request => {
      const output = followUp(request, 'process'); output.decision.questionIR.anchorMode = anchorMode; return output;
    } });
    assert.equal(first.origin, 'model'); assert.ok(first.draft);
    const actualTurnId = `actual-prepared-uuid-${anchorMode}`;
    const bound = bindQuestionContractToTurn(first.draft!, setup.context, setup.session, actualTurnId);
    const rebound = { ...first.draft!, ...bound };
    assert.equal(rebound.questionBlueprint.questionId, actualTurnId);
    assert.equal(rebound.questionBlueprint.clusterId, 'q0');
    assert.ok(rebound.questionBlueprint.anchorRefs.some(ref => ref.sourceId === 'ANSWER_TURN:q0:answer0'));
    assert.doesNotThrow(() => assertQuestionContractIntegrity(rebound, rebound.approvedQuestion));
    const current = appendFollowUp(setup, rebound); current.id = actualTurnId;
    const next = await runStrategyRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async request => followUp(request, 'alternative', 'met') });
    assert.equal(next.origin, 'model'); assert.equal(next.nextAction, 'FOLLOW_UP');
    assert.equal(next.draft?.questionBlueprint?.answerTurnId, actualTurnId);
    assert.equal(next.draft?.questionBlueprint?.clusterObjective.id, rebound.questionBlueprint.clusterObjective.id);
  }
});

test('a repeated operation target transitions rather than asking the same question with new wording', async () => {
  const setup = fixture();
  const first = await runStrategyRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async request => followUp(request, 'process') });
  assert.ok(first.draft);
  appendFollowUp(setup, first.draft!);
  const result = await runStrategyRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async request => followUp(request, 'process') });
  assert.equal(result.origin, 'model'); assert.equal(result.nextAction, 'TRANSITION'); assert.equal(result.draft, null);
  assert.ok(result.serverGuards?.includes('QUESTION_REPEATED_TARGET'));
  assert.equal(result.providerTimings.coreModelCalls, 1);
});

test('invented anchors and freely supplied speech produce a recorded fallback without retrying the provider', async () => {
  for (const change of [{ questionIR: { operation: 'process', anchorId: 'invented-book-anchor', anchorMode: 'none', secondaryAnchorId: null } }, { freeQuestion: '성공한 수치를 설명해 주세요.' }]) {
    const setup = fixture(); let calls = 0;
    const result = await runStrategyRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async request => { calls++; return followUp(request, 'process', 'partial', change); } });
    assert.equal(calls, 1); assert.equal(result.origin, 'fallback'); assert.equal(result.failureCode, 'CORE_INVALID_OUTPUT');
    assert.equal(result.reaction.classification, 'unassessed'); assert.equal(result.draft, null);
    assert.equal(result.nextAction, 'CLARIFICATION');
  }
});

test('a book strategy is methodology only and cannot authorize a different operation or insert book facts', async () => {
  const setup = fixture();
  const { card, catalog } = syntheticCatalog();
  attachCatalog(setup, catalog);
  const result = await runStrategyRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async request => {
    const input = JSON.parse(request.input);
    assert.equal(input.strategyCandidates[0].id, card.id);
    assert.equal(request.input.includes('BOOK_PRIVATE_STUDENT_FACT_999'), false);
    assert.equal('questionText' in input.strategyCandidates[0], false);
    return followUp(request, 'process', 'partial', { strategyId: card.id });
  } });
  assert.equal(result.origin, 'fallback'); assert.equal(result.failureCode, 'CORE_INVALID_OUTPUT');
  assert.equal(result.draft, null); assert.equal(result.providerTimings.coreModelCalls, 1);
});

test('a missing reference card is a normal path and does not require a fabricated book source ID', async () => {
  const setup = fixture();
  const result = await runStrategyRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async request => followUp(request, 'answer_anchor') });
  assert.equal(result.origin, 'model'); assert.equal(result.strategyDecision?.selectedCardId, null);
  assert.deepEqual(result.strategyDecision?.candidateCardIds, []);
  assert.deepEqual(result.draft?.strategyTrace?.sourceQuestionIds, []);
  assert.equal(result.draft?.questionBlueprint?.strategyIds.length, 0);
});

test('a matching methodology card retains source IDs in metadata without becoming a student evidence reference', async () => {
  const setup = fixture();
  const { card, catalog } = syntheticCatalog(); attachCatalog(setup, catalog);
  const result = await runStrategyRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async request => followUp(request, 'evidence_verification', 'partial', { strategyId: card.id }) });
  assert.equal(result.origin, 'model'); assert.equal(result.strategyDecision?.selectedCardId, card.id);
  assert.deepEqual(result.draft?.strategyTrace?.sourceQuestionIds, [card.questionId]);
  assert.deepEqual(result.draft?.evidenceIds, ['E01']);
  assert.equal(result.draft?.questionBlueprint?.anchorRefs.some(ref => ref.sourceId === card.questionId), false);
  assert.deepEqual(result.draft?.questionBlueprint?.strategyIds, [card.id]);
});

test('dates and negated comparison claims cannot become measurement or comparison probes', async () => {
  for (const [raw, operation] of [['2학년 때 자료를 조사했습니다.', 'numeric_verification'], ['자료를 비교하지 않았습니다.', 'comparison']] as const) {
    const setup = fixture(raw);
    const result = await runStrategyRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async request => followUp(request, operation) });
    assert.equal(result.origin, 'fallback'); assert.equal(result.failureCode, 'CORE_INVALID_OUTPUT');
    assert.equal(result.draft, null); assert.equal(result.providerTimings.coreModelCalls, 1);
    assert.equal(setup.turn.rawTranscript, raw);
  }
});

test('server-expired interview closing is kept as CLOSING in the core trace', async () => {
  const setup = fixture(); setup.session.elapsedMs = 720000;
  const result = await runStrategyRealtimeCore(setup.context, setup.session, { allowFollowUp: false, allowClarification: false, requestStrategy: async () => ({ answerRelation: { kind: 'related', note: '현재 답변은 질문에 관련되고 서버 시간이 종료되었다.' }, decision: { fulfillment: 'met', action: 'CLOSING', reason: 'time_or_interview_complete', questionIR: null, strategyId: null, subordinationRationale: null } }) });
  assert.equal(result.origin, 'model'); assert.equal(result.nextAction, 'CLOSING');
  assert.equal(result.draft, null); assert.equal(result.providerTimings.coreModelCalls, 1);
});

test('a model closing proposal cannot prematurely end the actual remaining interview', async () => {
  const setup = fixture(); setup.session.mainQuestionTarget = 5;
  const result = await runStrategyRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async () => ({ answerRelation: { kind: 'related', note: '현재 질문의 요구가 충족되었다.' }, decision: { fulfillment: 'met', action: 'CLOSING', reason: 'time_or_interview_complete', questionIR: null, strategyId: null, subordinationRationale: null } }) });
  assert.equal(result.origin, 'model'); assert.equal(result.nextAction, 'TRANSITION');
  assert.ok(result.serverGuards?.includes('EARLY_CLOSING_IGNORED'));
  assert.equal(result.providerTimings.coreModelCalls, 1);
});

test('disabled F or exhausted F count cannot be bypassed by a model proposal', async () => {
  for (const exhausted of [false, true]) {
    const setup = fixture();
    if (exhausted) setup.session.followUpCountByMainQuestion.q0 = 2;
    const result = await runStrategyRealtimeCore(setup.context, setup.session, { allowFollowUp: exhausted, allowClarification: true, requestStrategy: async request => followUp(request) });
    assert.equal(result.origin, 'model'); assert.equal(result.nextAction, 'TRANSITION'); assert.equal(result.draft, null);
    assert.ok(result.serverGuards?.includes(exhausted ? 'QUESTION_FOLLOW_UP_LIMIT' : 'FOLLOW_UP_BUDGET_EXHAUSTED'));
    assert.equal(result.providerTimings.coreModelCalls, 1);
  }
});

test('provider timeout yields one recoverable unassessed response and preserves every raw word', async () => {
  const setup = fixture('처음에는 비교했다고 했지만 정정하겠습니다. 실제로는 목차만 봤습니다.'); let calls = 0;
  const original = setup.turn.rawTranscript;
  const result = await runStrategyRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async () => { calls++; const error = new Error('Synthetic timeout'); error.name = 'TimeoutError'; throw error; } });
  assert.equal(calls, 1); assert.equal(result.origin, 'fallback'); assert.equal(result.failureCode, 'CORE_TIMEOUT');
  assert.equal(result.reaction.classification, 'unassessed'); assert.equal(result.nextAction, 'CLARIFICATION');
  assert.equal(setup.turn.rawTranscript, original);
});

test('source and approved question integrity failures stop before any model call', async () => {
  const setup = fixture(); let calls = 0;
  setup.turn.questionText = '근거 없는 새로운 질문인가요?';
  await assert.rejects(() => runStrategyRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async () => { calls++; return {}; } }));
  assert.equal(calls, 0);
});

test('strategy catalog changes cannot silently alter the session-pinned source manifest', async () => {
  const setup = fixture(); let calls = 0;
  const { catalog } = syntheticCatalog(); attachCatalog(setup, catalog);
  setup.context.questionStrategies = { ...catalog, contentSha256: 'changed-after-session-start' };
  await assert.rejects(() => runStrategyRealtimeCore(setup.context, setup.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async () => { calls++; return {}; } }), error => error instanceof RealtimeCoreSourceError);
  assert.equal(calls, 0);
});
