import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { InterviewContext, StudentEvidence } from '../server/data/load-interview-context';
import type { InterviewSession, QuestionDraft, RecordedTurn } from '../server/protocol';
import { runStrategyRealtimeCore, type StrategyCoreOptions } from '../server/providers/realtime-strategy-core';
import { encodeSingleCoreDecision, type SingleCoreOutput } from '../server/providers/single-core-contract';
import { SINGLE_CORE_ENGINE_VERSION } from '../server/providers/single-core-runtime';
import { type RuntimeFactReviewInput } from '../server/providers/runtime-fact-review';
import { buildQuestionPremiseReviewInput, finalizeQuestionPremiseReview } from '../server/providers/question-premises';
import { approveQuestionContract, assertQuestionContractIntegrity, createQuestionBlueprint } from '../server/question-objective';
import { buildEvaluationUnits } from '../server/providers/evaluation-turns';
import { createTurnWorkContext } from '../server/turn-work';
import { WorkTestClock } from './fixtures/work-test-clock';

/** Explicit synthetic sources and provider seams: no private documents or APIs. */
function fixture(raw = '작성 시점을 비교했습니다.', primary: 'EVIDENCE' | 'ROLE' = 'EVIDENCE', options: { sourceText?: string; draft?: Partial<QuestionDraft> } = {}) {
  const sourceText = options.sourceText ?? '자료를 선택하고 비교하는 탐구를 진행함.';
  const source: StudentEvidence = { id: 'E1', activityId: 'A1', page: 1, grade: 2, section: '세특', title: '합성 자료 비교',
    text: sourceText, sourceRef: { file: 'synthetic.pdf', pdfSha256: 'a'.repeat(64), page: 1, extraction: 'explicit-synthetic-test', startOffset: 0, endOffset: sourceText.length },
    confirmationStatus: 'confirmed_from_record', preparationPriority: null, scientificTruthVerification: 'not_independently_verified' };
  const draft: QuestionDraft = { questionText: primary === 'ROLE' ? '자료 비교에서 본인이 맡은 일은 무엇인가요?' : '자료를 비교해 내린 판단의 근거는 무엇인가요?',
    questionKind: 'main', parentMainQuestionId: null, acknowledgement: null, acknowledgementQuote: null, evidenceIds: [source.id], evidenceQuotes: [{ evidenceId: source.id, quote: source.text }],
    primaryFunction: primary, depth: 'D2', questionIntent: primary === 'ROLE' ? '본인이 맡은 일 확인' : '판단의 실제 근거 확인', targetEvidence: [primary === 'ROLE' ? '본인이 한 일 한 가지' : '판단 근거 한 가지'],
    groundingRationale: '기록된 자료 비교 경험의 한 요구를 확인한다.', validationStatus: 'approved', validationFailures: [], ...options.draft };
  draft.premiseValidation = finalizeQuestionPremiseReview({ verdict: 'allowed', completeAssertionCoverage: true, coreIntentCount: 1, intentMatches: true, clarificationPreservesIntent: true,
    premises: [{ questionSpan: options.draft ? draft.questionText.slice(0, 4) : '자료', basis: 'record', sourceId: source.id, supportQuote: source.text, supported: true }] }, buildQuestionPremiseReviewInput(draft, [source]), 'explicit-synthetic-offline-review');
  const context = { target: { university: '합성 대학', department: '합성 학과' }, questionReferences: null, questionStrategies: null, errors: [], student: { evidence: [source] }, school: { sources: [] }, interviewOverview: null,
    manifest: { rulesVersion: 'single-core-synthetic', sourceIntegrity: { pdfHashVerified: true, evidenceReferencesVerified: true, evidenceTextVerified: true, evidenceCount: 1 },
      files: [{ role: 'studentPdf', path: 'synthetic.pdf', sha256: source.sourceRef.pdfSha256 }] } } as unknown as InterviewContext;
  const session = { id: 'single-core-synthetic-session', sourceManifest: structuredClone(context.manifest), followUpCountByMainQuestion: {}, elapsedMs: 0, durationSeconds: 720, turns: [] } as unknown as InterviewSession;
  draft.questionBlueprint = createQuestionBlueprint(draft, context, session, { questionId: 'q0' });
  draft.approvedQuestion = approveQuestionContract(draft, draft.questionBlueprint);
  const turn = { id: 'q0', answerId: 'a0', parentMainQuestionId: 'q0', mainIndex: 1, mainCount: 5, followUpIndex: 0, questionKind: 'main', questionText: draft.questionText,
    evidenceIds: [source.id], rawTranscript: raw, transcriptStatus: 'finalized', metadata: { ...draft, rulesVersion: context.manifest.rulesVersion, questionClusterId: 'q0', activityIds: ['A1'] } } as unknown as RecordedTurn;
  session.turns.push(turn);
  return { context, session, turn };
}

function followUp(coverage: SingleCoreOutput['assessment']['coverage'] = 'partial'): SingleCoreOutput {
  return { assessment: { coverage, response: 'answered', reason: '실제로 언급한 자료 비교에서 선택 기준 한 지점을 확인한다.' },
    next: { action: 'FOLLOW_UP', question: { text: '자료를 비교할 때 어떤 기준을 사용했나요?', target: '실제로 사용한 비교 기준', primaryFunction: 'CHOICE', depth: 'D2', strategyId: null } }, reaction: null };
}
function allowed(input: RuntimeFactReviewInput) {
  return { verdict: 'allowed', completeAssertionCoverage: true,
    ...(input.repairContract ? { demandMatch: 'same' } : {}),
    premises: [{ questionSpan: input.question.questionText, basis: 'open_check', proofId: null, supported: true }] };
}
function rejected(input: RuntimeFactReviewInput) {
  return { verdict: 'rewrite', completeAssertionCoverage: true,
    premises: [{ questionSpan: input.question.questionText, basis: 'open_check', proofId: null, supported: false }] };
}
function providers(output: SingleCoreOutput, overrides: Partial<StrategyCoreOptions> = {}): StrategyCoreOptions {
  const options: StrategyCoreOptions = { engineMode: 'single_core', allowFollowUp: true, allowClarification: true, allowReplay: true,
    requestSingleCore: async () => output, requestFactReview: async input => allowed(input),
    requestSurfaceRepair: async () => { throw new Error('UNEXPECTED_SURFACE_REPAIR'); }, ...overrides };
  const injected = options.requestSingleCore!;
  return { ...options, requestSingleCore: async (request, stage) => encodeSingleCoreDecision(await injected(request, stage) as SingleCoreOutput) };
}

test('a rejected rephrase reuses an independently approved same-demand surface without another model or changing the core decision', async () => {
  const f = fixture('다 같이 자료를 비교했습니다.', 'ROLE');
  const cached = { ...f.turn.metadata, acknowledgement: null, acknowledgementQuote: null, questionText: '자료 비교에서 직접 맡으신 일이 있다면 말씀해 주세요.', questionKind: 'clarification', parentMainQuestionId: f.turn.id, evidenceIds: [...f.turn.evidenceIds] } as QuestionDraft;
  // Actual recovery-pool materialization supplies a reviewed sentence before
  // its new session/turn contract is bound.
  delete cached.questionBlueprint; delete cached.approvedQuestion;
  const originalQuestion = { questionText: f.turn.questionText, questionIntent: f.turn.metadata.questionIntent, targetEvidence: f.turn.metadata.targetEvidence, primaryFunction: f.turn.metadata.primaryFunction, depth: f.turn.metadata.depth };
  cached.premiseValidation = finalizeQuestionPremiseReview({ verdict: 'allowed', completeAssertionCoverage: true, coreIntentCount: 1, intentMatches: true, clarificationPreservesIntent: true,
    premises: [{ questionSpan: cached.questionText, basis: 'open_check', sourceId: null, supportQuote: null, supported: true }] }, buildQuestionPremiseReviewInput(cached, f.context.student.evidence, undefined, originalQuestion), 'explicit-synthetic-offline-review');
  const output: SingleCoreOutput = { assessment: { coverage: 'partial', response: 'answered', reason: '원래 물은 본인 행동 요구를 쉽게 재안내한다.' }, next: { action: 'CLARIFICATION', question: { text: '본인이 직접 자료의 오류를 고친 일은 무엇인가요?' } }, reaction: null };
  let coreCalls = 0, reviews = 0, repairs = 0;
  const result = await runStrategyRealtimeCore(f.context, f.session, providers(output, {
    requestSingleCore: async () => { coreCalls++; return output; }, resolveApprovedRecovery: async () => cached,
    requestFactReview: async input => { reviews++; return rejected(input); }, requestSurfaceRepair: async () => { repairs++; throw new Error('MUST_REUSE_APPROVED_SURFACE'); },
  }));
  assert.equal(coreCalls, 1); assert.equal(reviews, 1); assert.equal(repairs, 0);
  assert.equal(result.draft?.questionText, cached.questionText); assert.equal(result.nextAction, 'CLARIFICATION'); assert.equal(result.fulfillment, 'partial');
  assert.deepEqual(result.semanticDecision, output); assert.equal(result.execution?.surfaceOrigin, 'approved_restatement'); assert.equal(result.execution?.status, 'ready');
  assert.equal(result.questionRecoveryRequired, undefined); assert.equal(result.factReviewTraces?.[0].accepted, false);
  assert.equal(f.turn.rawTranscript, '다 같이 자료를 비교했습니다.'); assert.doesNotThrow(() => assertQuestionContractIntegrity(result.draft!, result.draft!.approvedQuestion!));
  f.turn.metadata.coreDecision = { sourceTurnId: f.turn.id, sourceAnswerId: f.turn.answerId, engineVersion: SINGLE_CORE_ENGINE_VERSION, semanticDecision: output, questionRecoveryRequired: true };
  const retry = await runStrategyRealtimeCore(f.context, f.session, providers(output, { recoveryOnly: true, resolveApprovedRecovery: async () => cached,
    requestSingleCore: async () => { throw new Error('MUST_NOT_REPEAT_CORE'); }, requestFactReview: async () => { throw new Error('MUST_NOT_REVIEW_APPROVED_SURFACE'); } }));
  assert.equal(retry.draft?.questionText, cached.questionText); assert.equal(retry.execution?.status, 'ready');
  assert.equal(retry.providerTimings.coreModelCalls, 0); assert.equal(retry.providerTimings.premiseReviewAttempts, 0); assert.equal(retry.providerTimings.repairModelCalls, 0);
  assert.ok(retry.serverGuards?.includes('SAVED_RESTATEMENT_APPROVED_SURFACE'));
});

test('a partial unavailable answer follows the sole core transition without another review or changing raw words', async () => {
  const f = fixture('두 자료를 비교했지만 당시 조건과 원자료는 기억나지 않습니다.');
  const output: SingleCoreOutput = { assessment: { coverage: 'partial', response: 'unavailable', reason: '비교는 답했고 남은 조건은 기억 불가라고 밝혔다.' }, next: { action: 'TRANSITION', question: null }, reaction: null };
  let cores = 0, reviews = 0;
  const result = await runStrategyRealtimeCore(f.context, f.session, providers(output, {
    requestSingleCore: async () => { cores++; return output; }, requestFactReview: async input => { reviews++; return allowed(input); },
  }));
  assert.equal(result.engineVersion, SINGLE_CORE_ENGINE_VERSION); assert.equal(cores, 1); assert.equal(reviews, 0);
  assert.equal(result.fulfillment, 'partial'); assert.equal(result.nextAction, 'TRANSITION'); assert.equal(result.draft, null);
  assert.equal(result.execution?.status, 'ready'); assert.deepEqual(result.semanticDecision, output);
  assert.equal(f.turn.answerId, 'a0'); assert.equal(f.turn.rawTranscript, '두 자료를 비교했지만 당시 조건과 원자료는 기억나지 않습니다.');
});

test('a vague role answer keeps the core clarification and hides meaning metadata from factual review', async () => {
  const f = fixture('그냥 다같이 했어요.', 'ROLE');
  const output: SingleCoreOutput = { assessment: { coverage: 'partial', response: 'answered', reason: '본인이 맡은 일은 아직 구체화되지 않았다.' },
    next: { action: 'CLARIFICATION', question: { text: '그 활동에서 본인이 한 일을 말씀해 주세요.' } }, reaction: null };
  let reviews = 0;
  const result = await runStrategyRealtimeCore(f.context, f.session, providers(output, { requestFactReview: async input => {
    reviews++;
    assert.deepEqual(Object.keys(input).sort(), ['question', 'sources', 'answer', 'answerSources', 'proofChoices'].sort());
    assert.deepEqual(Object.keys(input.question), ['questionText']);
    assert.equal(input.answer?.text, f.turn.rawTranscript); return allowed(input);
  } }));
  assert.equal(reviews, 1); assert.equal(result.fulfillment, 'partial'); assert.equal(result.nextAction, 'CLARIFICATION');
  assert.equal(result.draft?.questionKind, 'clarification'); assert.equal(result.draft?.primaryFunction, 'ROLE');
  assert.equal(result.draft?.questionText, output.next.question!.text); assert.deepEqual(result.draft?.targetEvidence, f.turn.metadata.targetEvidence);
  assert.equal(result.draft?.approvedQuestion?.validation.independentSemanticReview, false);
  assert.doesNotThrow(() => assertQuestionContractIntegrity(result.draft!, result.draft!.approvedQuestion!));
});

test('a clarification may refer to the actual ambiguous answer wording without changing the role requirement',async()=>{
  const f=fixture('자료 비교에서는 제가 머리를 담당했습니다.','ROLE');
  const wording='머리를 담당했다는 말씀은 실제로 어떤 일을 하셨다는 뜻인가요?';
  const decision:SingleCoreOutput={assessment:{coverage:'partial',response:'answered',reason:'역할의 추상 표현을 실제 행동의 뜻으로 다시 묻는다.'},next:{action:'CLARIFICATION',question:{text:wording}},reaction:null};
  let cores=0,reviews=0;
  const result=await runStrategyRealtimeCore(f.context,f.session,providers(decision,{
    requestSingleCore:async()=>{cores++;return decision;},requestFactReview:async input=>{reviews++;assert.equal(input.question.questionText,wording);return allowed(input);},
  }));
  assert.equal(cores,1);assert.equal(reviews,1);assert.equal(result.nextAction,'CLARIFICATION');
  assert.equal(result.draft?.questionText,wording);assert.equal(result.draft?.primaryFunction,'ROLE');
  assert.deepEqual(result.draft?.targetEvidence,f.turn.metadata.targetEvidence);
  assert.equal(result.execution?.status,'ready');assert.equal(result.questionRecoveryRequired,undefined);
  assert.equal(f.turn.rawTranscript,'자료 비교에서는 제가 머리를 담당했습니다.');
});

test('an invalid reaction quote cannot block an approved next question or repeat the core',async()=>{
  const raw='자료를 보고 계산하고 결과를 다시 검토했습니다.';
  const f=fixture(raw),decision=followUp();
  decision.reaction={quote:'결과를 다시 검',text:'자료를 계산하고 검토한 과정을 말씀하셨습니다.'};
  let cores=0,reviews=0,repairs=0;
  const result=await runStrategyRealtimeCore(f.context,f.session,providers(decision,{
    requestSingleCore:async()=>{cores++;return decision;},requestFactReview:async input=>{reviews++;return allowed(input);},
    requestSurfaceRepair:async()=>{repairs++;throw new Error('QUOTE_MUST_NOT_RETRY_QUESTION');},
  }));
  assert.equal(cores,1);assert.equal(reviews,1);assert.equal(repairs,0);
  assert.equal(result.nextAction,'FOLLOW_UP');assert.equal(result.draft?.questionText,decision.next.question?.text);
  assert.equal(result.execution?.status,'ready');assert.equal(result.questionRecoveryRequired,undefined);
  assert.equal(result.reaction.reply,null);assert.equal(result.reaction.keywordQuote,null);
  assert.deepEqual(result.semanticDecision?.reaction,decision.reaction,'The original model output stays auditable instead of being silently repaired.');
  assert.equal(f.turn.rawTranscript,raw);
});

test('the executor preserves the core judgment of an intelligible but incomplete claim rather than applying lexical meaning rules',async()=>{
  for(const raw of ['가설은 언제까지나 타당할 것이라고 생각했습니다.','분해할 때 나온 열이 다시 에너지로 이어진다고 생각했습니다.']){
    const f=fixture(raw),decision:SingleCoreOutput={assessment:{coverage:'partial',response:'answered',reason:'관련된 판단은 말했지만 현재 요구의 근거가 빠졌다.'},next:{action:'CLARIFICATION',question:{text:'그렇게 판단하신 근거를 말씀해 주시겠어요?'}},reaction:null};
    const result=await runStrategyRealtimeCore(f.context,f.session,providers(decision));
    assert.equal(result.fulfillment,'partial');assert.equal(result.semanticDecision?.assessment?.response,'answered');
    assert.equal(result.nextAction,'CLARIFICATION');assert.equal(result.execution?.status,'ready');
    assert.equal(f.turn.rawTranscript,raw);
  }
});

test('core-selected follow-ups preserve partial and met judgments alike without a second fulfillment classifier', async () => {
  for (const coverage of ['partial', 'met'] as const) {
    const f = fixture('작성 시점을 비교했고 다른 자료를 제외했습니다.');
    const output = followUp(coverage);
    const result = await runStrategyRealtimeCore(f.context, f.session, providers(output));
    assert.equal(result.nextAction, 'FOLLOW_UP'); assert.equal(result.fulfillment, coverage);
    assert.equal(result.draft?.questionKind, 'follow_up'); assert.equal(result.draft?.questionText, output.next.question!.text);
    assert.equal(result.draft?.targetEvidence[0], output.next.action === 'FOLLOW_UP' ? output.next.question.target : null);
    assert.equal(result.draft?.premiseValidation?.method, 'bounded_fact_review');
    assert.equal(result.draft?.approvedQuestion?.validation.independentSemanticReview, false);
    assert.deepEqual(result.semanticDecision, output);
  }
});

test('an ordinary core rephrase needs no purpose keywords or F-versus-rephrase canonicalizer', async () => {
  const f = fixture('인터넷에서 찾아봤습니다.');
  const output: SingleCoreOutput = { assessment: { coverage: 'partial', response: 'answered', reason: '판단한 내용을 다시 쉽게 확인한다.' },
    next: { action: 'CLARIFICATION', question: { text: '그 자료에서 무엇을 보고 그렇게 생각했나요?' } }, reaction: null };
  const result = await runStrategyRealtimeCore(f.context, f.session, providers(output));
  assert.equal(result.nextAction, 'CLARIFICATION'); assert.equal(result.draft?.questionText, output.next.question!.text);
  assert.equal(result.fulfillment, 'partial'); assert.deepEqual(result.semanticDecision, output);
});

test('fact reviewers cannot add forbidden dialogue judgments or turn their rejection into a topic transition', async () => {
  const f = fixture(), output = followUp(); let reviews = 0;
  const result = await runStrategyRealtimeCore(f.context, f.session, providers(output, { requestFactReview: async input => {
    reviews++; return { ...allowed(input), demandRelation: 'same_whole_demand_rephrase', currentDemandFulfillment: 'met' };
  } }));
  assert.equal(reviews, 1); assert.equal(result.execution?.status, 'blocked'); assert.equal(result.execution?.action, null);
  assert.equal(result.questionRecoveryRequired, true); assert.equal(result.draft, null);
  assert.equal(result.fulfillment, 'partial'); assert.deepEqual(result.semanticDecision, output);
});

test('empty unobserved STT blocks before the core, while observed silence replays without any model call', async () => {
  for (const observed of [false, true]) {
    const f = fixture(''); let cores = 0, reviews = 0;
    if (observed) f.turn.answerObservation = { classification: 'silence_observed', nonAnswer: true, durationMs: 3000, speakingMs: 0, silenceMs: 3000, firstSpeechMs: null, speechDetected: false, rawTranscriptPreserved: true, origin: 'finalized-stt-and-observed-speech-timing' };
    const result = await runStrategyRealtimeCore(f.context, f.session, providers(followUp(), { requestSingleCore: async () => { cores++; return followUp(); }, requestFactReview: async input => { reviews++; return allowed(input); } }));
    assert.equal(cores, 0); assert.equal(reviews, 0); assert.equal(result.fulfillment, 'unknown');
    assert.equal(result.execution?.status, observed ? 'ready' : 'blocked'); assert.equal(result.execution?.action, observed ? 'REPLAY' : null);
    assert.equal(f.turn.rawTranscript, ''); assert.equal(f.turn.answerId, 'a0');
  }
});

test('the actual 80-character unterminated clarification preserves the core decision and repairs once before one final fact review', async () => {
  // Exact rejected v13 candidate, on an explicit synthetic source/Q0 binding.
  // This proves the terminal-symbol execution contract, not scientific truth.
  const bad = '겔의 카복실기가 중금속 양이온을 포집하는 원리를 바탕으로 수처리 활용을 제시한 내용입니다. 이 제안만으로 실제 제거 효과를 어디까지 판단할 수있';
  assert.equal(bad.length, 80);
  const raw = '알긴산 하이드로겔 수철이 흡착제로 제안한 내용이 무엇인지 여쭤봐도 괜찮을까요 ';
  const f = fixture(raw, 'EVIDENCE', { sourceText: '알긴산 하이드로겔의 카복실기가 중금속 양이온을 포집하는 원리를 바탕으로 수처리 활용을 제안함.',
    draft: { questionText: '알긴산 하이드로겔의 수처리 제안만으로 실제 제거 효과를 어디까지 판단할 수 있나요?', primaryFunction: 'LIMIT', depth: 'D4',
      questionIntent: '수처리 제안의 실제 제거 효과 판단 범위를 확인한다.', targetEvidence: ['제안만으로 판단 가능한 실제 제거 효과의 범위'] } });
  const before = structuredClone(f.session), repaired = '기록에는 겔을 활용한 수처리 제안이 있습니다. 실제 제거 효과는 어디까지 판단할 수 있나요?';
  const output: SingleCoreOutput = { assessment: { coverage: 'unknown', response: 'answered', reason: '제안 내용의 맥락을 요청했으며 효과의 판단 범위는 아직 답하지 않았다.' },
    next: { action: 'CLARIFICATION', question: { text: bad } }, reaction: null };
  let cores = 0, repairs = 0, reviews = 0;
  const result = await runStrategyRealtimeCore(f.context, f.session, providers(output, {
    requestSingleCore: async () => { cores++; return output; },
    requestSurfaceRepair: async input => { repairs++; const surface = input as { action: string; question: string; requiredMeaning: string; rejection: string };
      assert.equal(surface.action, 'CLARIFICATION'); assert.equal(surface.question, bad);
      assert.equal(surface.requiredMeaning, f.turn.metadata.targetEvidence[0]); assert.equal(surface.rejection, 'INVALID_FORMAT'); return repaired; },
    requestFactReview: async input => { reviews++; assert.equal(input.question.questionText, repaired); return allowed(input); },
  }));
  assert.equal(cores, 1); assert.equal(repairs, 1); assert.equal(reviews, 1);
  assert.equal(result.execution?.status, 'ready'); assert.equal(result.execution?.surfaceOrigin, 'bounded_surface_repair');
  assert.equal(result.nextAction, 'CLARIFICATION'); assert.equal(result.draft?.questionKind, 'clarification');
  assert.equal(result.draft?.questionText, repaired); assert.deepEqual(result.draft?.targetEvidence, f.turn.metadata.targetEvidence);
  assert.equal(result.draft?.questionIntent, f.turn.metadata.questionIntent); assert.equal(result.draft?.depth, 'D4');
  assert.equal(result.draft?.primaryFunction, 'LIMIT'); assert.deepEqual(result.semanticDecision, output);
  assert.equal(result.providerTimings.coreModelCalls, 1); assert.equal(result.providerTimings.repairModelCalls, 1); assert.equal(result.providerTimings.premiseReviewAttempts, 1);
  assert.equal(result.factReviewTraces?.[0].failureCode, 'INVALID_FORMAT'); assert.equal(result.factReviewTraces?.at(-1)?.accepted, true);
  assert.deepEqual(f.session, before); assert.equal(f.turn.rawTranscript, raw); assert.equal(f.session.followUpCountByMainQuestion.q0 ?? 0, 0);
  const clarification = { ...f.turn, id: 'repaired-c1', questionKind: 'clarification', questionText: repaired,
    metadata: { ...f.turn.metadata, ...result.draft!, nonEvaluative: true, clarificationOfTurnId: f.turn.id } } as RecordedTurn;
  const evaluation = buildEvaluationUnits({ turns: [f.turn, clarification] });
  assert.equal(evaluation.units.length, 1); assert.deepEqual(evaluation.units[0].clarificationTurnIds, ['repaired-c1']);
});

test('a normally terminated core question reaches one factual review without any repair', async () => {
  const f = fixture(), output = followUp(); let reviews = 0;
  const result = await runStrategyRealtimeCore(f.context, f.session, providers(output, {
    requestFactReview: async input => { reviews++; return allowed(input); },
    requestSurfaceRepair: async () => { throw new Error('NORMAL_QUESTION_MUST_NOT_REPAIR'); },
  }));
  assert.equal(reviews, 1); assert.equal(result.providerTimings.coreModelCalls, 1); assert.equal(result.providerTimings.repairModelCalls, 0);
  assert.equal(result.draft?.questionText, output.next.question!.text); assert.equal(result.execution?.status, 'ready');
});

test('a still unterminated repair cannot reach factual review or become spoken by appending punctuation', async () => {
  const f = fixture(), output = followUp();
  output.next.question!.text = '자료를 선택한 기준에 대해 어떤';
  let repairs = 0, reviews = 0;
  const result = await runStrategyRealtimeCore(f.context, f.session, providers(output, {
    requestSurfaceRepair: async () => { repairs++; return '자료를 선택한 기준은'; },
    requestFactReview: async input => { reviews++; return allowed(input); },
  }));
  assert.equal(repairs, 1); assert.equal(reviews, 0); assert.equal(result.draft, null);
  assert.equal(result.execution?.status, 'blocked'); assert.equal(result.questionRecoveryRequired, true);
  assert.deepEqual(result.semanticDecision, output); assert.equal(result.providerTimings.coreModelCalls, 1);
  assert.equal(f.turn.rawTranscript, '작성 시점을 비교했습니다.');
});

test('a failed fact surface gets one rewrite and one fact recheck while action, coverage and target stay fixed', async () => {
  const f = fixture(), output = followUp('met'); let cores = 0, reviews = 0, repairs = 0;
  const repaired = '자료를 선택한 기준 한 가지만 말씀해 주세요.';
  const result = await runStrategyRealtimeCore(f.context, f.session, providers(output, {
    requestSingleCore: async () => { cores++; return output; },
    requestFactReview: async input => { reviews++; return reviews === 1 ? rejected(input) : allowed(input); },
    requestSurfaceRepair: async input => { repairs++; const surface = input as { action: string; requiredMeaning: string };
      assert.equal(surface.action, 'FOLLOW_UP'); assert.equal(surface.requiredMeaning, '실제로 사용한 비교 기준');
      assert.deepEqual(Object.keys(surface).sort(), ['action', 'question', 'requiredMeaning', 'rejection', 'factTraces'].sort());
      for (const key of ['questionContext', 'sourceTexts', 'actualAnswers']) assert.equal(Object.hasOwn(surface, key), false);
      return repaired; },
  }));
  assert.equal(cores, 1); assert.equal(reviews, 2); assert.equal(repairs, 1); assert.equal(result.fulfillment, 'met');
  assert.equal(result.nextAction, 'FOLLOW_UP'); assert.equal(result.draft?.questionText, repaired);
  assert.equal(result.draft?.targetEvidence[0], '실제로 사용한 비교 기준'); assert.deepEqual(result.semanticDecision, output);
  assert.equal(result.execution?.surfaceOrigin, 'bounded_surface_repair'); assert.equal(result.execution.status, 'ready');
  assert.equal(result.providerTimings.coreModelCalls, 1); assert.equal(result.providerTimings.premiseReviewAttempts, 2); assert.equal(result.providerTimings.repairModelCalls, 1);
});

test('two fact rejections stop with the same answer and decision, never silently selecting another topic', async () => {
  const f = fixture(), output = followUp(); const before = structuredClone(f.session); let reviews = 0, repairs = 0;
  const result = await runStrategyRealtimeCore(f.context, f.session, providers(output, {
    requestFactReview: async input => { reviews++; return rejected(input); },
    requestSurfaceRepair: async () => { repairs++; return '자료를 선택한 기준 한 가지만 말씀해 주세요.'; },
  }));
  assert.equal(reviews, 2); assert.equal(repairs, 1); assert.equal(result.questionRecoveryRequired, true);
  assert.equal(result.execution?.status, 'blocked'); assert.equal(result.execution?.action, null); assert.equal(result.draft, null);
  assert.deepEqual(result.semanticDecision, output); assert.deepEqual(f.session, before);
});

test('an explicit retry restores the exact source-bound semantic decision with zero core calls', async () => {
  const f = fixture(), output = followUp('partial'); let cores = 0, reviews = 0, repairs = 0;
  f.turn.metadata.coreDecision = { sourceTurnId: f.turn.id, sourceAnswerId: f.turn.answerId, engineVersion: SINGLE_CORE_ENGINE_VERSION, semanticDecision: output };
  const result = await runStrategyRealtimeCore(f.context, f.session, providers(output, { recoveryOnly: true,
    requestSingleCore: async () => { cores++; return output; }, requestFactReview: async input => { reviews++; return allowed(input); },
    requestSurfaceRepair: async () => { repairs++; return '자료를 선택한 기준 한 가지만 말씀해 주세요.'; },
  }));
  assert.equal(cores, 0); assert.equal(reviews, 1); assert.equal(repairs, 1); assert.equal(result.nextAction, 'FOLLOW_UP');
  assert.equal(result.fulfillment, 'partial'); assert.deepEqual(result.semanticDecision, output); assert.equal(result.execution?.status, 'ready');
  assert.equal(f.turn.rawTranscript, '작성 시점을 비교했습니다.'); assert.equal(f.turn.answerId, 'a0');
});

test('a source-bound retry restores only the failed original surface review, without replaying old provider timings or other question proofs', async () => {
  const f = fixture(), output = followUp();
  const rejectedSpan = '자료를 비교할 때';
  const saved = { questionSha256: createHash('sha256').update(output.next.question!.text).digest('hex'), accepted: false,
    failureCode: 'PREMISE_UNSUPPORTED', verdict: 'rewrite', premises: [{ questionSpan: rejectedSpan, basis: 'record', proofId: null, supported: false }] };
  f.turn.metadata.coreDecision = { sourceTurnId: f.turn.id, sourceAnswerId: f.turn.answerId, engineVersion: SINGLE_CORE_ENGINE_VERSION, semanticDecision: output,
    factReviewTraces: [saved, { ...saved, accepted: true }, { ...saved, questionSha256: 'b'.repeat(64) }, { invalid: true }] };
  const result = await runStrategyRealtimeCore(f.context, f.session, providers(output, { recoveryOnly: true,
    requestSingleCore: async () => { throw new Error('MUST_NOT_REPEAT_CORE'); }, requestSurfaceRepair: async input => {
      const surface = input as { rejection: string; factTraces: Array<{ verdict: string; premises: unknown[] }> };
      assert.equal(surface.rejection, 'PREMISE_UNSUPPORTED');
      assert.deepEqual(surface.factTraces, [{ verdict: 'rewrite', premises: saved.premises }]);
      return '자료를 선택한 기준 한 가지만 말씀해 주세요.';
    },
  }));
  assert.equal(result.execution?.status, 'ready'); assert.equal(result.providerTimings.coreModelCalls, 0);
  assert.equal(result.providerTimings.premiseReviewAttempts, 1); assert.equal(result.factReviewTraces?.length, 1);
  assert.ok(result.serverGuards?.includes('SOURCE_BOUND_REJECTION_RESTORED'));
});

test('wrong retry source identity blocks before any core, repair or fact review call', async () => {
  for (const wrong of ['turn', 'answer'] as const) {
    const f = fixture(), output = followUp(); let calls = 0;
    f.turn.metadata.coreDecision = { sourceTurnId: wrong === 'turn' ? 'other-turn' : f.turn.id, sourceAnswerId: wrong === 'answer' ? 'other-answer' : f.turn.answerId,
      engineVersion: SINGLE_CORE_ENGINE_VERSION, semanticDecision: output };
    const result = await runStrategyRealtimeCore(f.context, f.session, providers(output, { recoveryOnly: true,
      requestSingleCore: async () => { calls++; return output; }, requestFactReview: async input => { calls++; return allowed(input); }, requestSurfaceRepair: async () => { calls++; return '다시 한 단계만 설명해 주세요.'; },
    }));
    assert.equal(calls, 0); assert.equal(result.execution?.status, 'blocked'); assert.equal(result.draft, null);
    assert.equal(result.failureDetail, 'POLICY_RECOVERY_SOURCE_CHANGED'); assert.equal(f.turn.answerId, 'a0');
  }
});

test('a source-bound legacy failure gets one new v5 semantic decision rather than inheriting legacy judgment', async () => {
  const f = fixture('조건과 원자료는 기억나지 않습니다.'); let cores = 0, reviews = 0;
  f.turn.metadata.coreDecision = { sourceTurnId: f.turn.id, sourceAnswerId: f.turn.answerId, engineVersion: 'target-first-single-core-v4', fulfillment: 'met', requestedAction: 'FOLLOW_UP' };
  const output: SingleCoreOutput = { assessment: { coverage: 'partial', response: 'unavailable', reason: '현재 요구의 미답 범위를 기억하지 못한다고 했다.' }, next: { action: 'TRANSITION', question: null }, reaction: null };
  const result = await runStrategyRealtimeCore(f.context, f.session, providers(output, { recoveryOnly: true,
    requestSingleCore: async () => { cores++; return output; }, requestFactReview: async input => { reviews++; return allowed(input); },
  }));
  assert.equal(cores, 1); assert.equal(reviews, 0); assert.equal(result.fulfillment, 'partial'); assert.equal(result.nextAction, 'TRANSITION');
  assert.equal(result.execution?.status, 'ready'); assert.deepEqual(result.semanticDecision, output);
});

test('hard F and rephrase budgets restrict execution without rewriting the core meaning decision', async () => {
  for (const action of ['FOLLOW_UP', 'CLARIFICATION'] as const) {
    const f = fixture(); let reviews = 0;
    const output: SingleCoreOutput = action === 'FOLLOW_UP' ? followUp('met') : { assessment: { coverage: 'partial', response: 'answered', reason: '동일 요구를 쉽게 재진술한다.' },
      next: { action: 'CLARIFICATION', question: { text: '판단의 근거를 한 가지만 말씀해 주세요.' } }, reaction: null };
    if (action === 'FOLLOW_UP') f.session.followUpCountByMainQuestion.q0 = 2;
    const result = await runStrategyRealtimeCore(f.context, f.session, providers(output, { allowClarification: action !== 'CLARIFICATION', requestFactReview: async input => { reviews++; return allowed(input); } }));
    assert.equal(reviews, 0); assert.equal(result.execution?.action, 'TRANSITION'); assert.equal(result.draft, null);
    assert.deepEqual(result.semanticDecision, output); assert.equal(result.fulfillment, output.assessment.coverage);
    assert.ok(result.serverGuards?.includes('QUESTION_ACTION_BUDGET_EXHAUSTED'));
  }
});

test('the actual source gate still rejects a changed PDF manifest before invoking the single core', async () => {
  const f = fixture(); let calls = 0;
  (f.session.sourceManifest as InterviewContext['manifest']).files[0].sha256 = 'b'.repeat(64);
  await assert.rejects(runStrategyRealtimeCore(f.context, f.session, providers(followUp(), { requestSingleCore: async () => { calls++; return followUp(); } })), /확정 답변의 질문·자료 연결/u);
  assert.equal(calls, 0);
});

test('a pinned policy revision mismatch blocks even a no-question transition before invoking the core', async () => {
  const f = fixture(); let calls = 0;
  f.session.runtime = { runtimePolicy: { mode: 'compiled', registrySha256: 'different-registry' } } as NonNullable<InterviewSession['runtime']>;
  const output: SingleCoreOutput = { assessment: { coverage: 'met', response: 'answered', reason: '실제 요구에 답했다.' }, next: { action: 'TRANSITION', question: null }, reaction: null };
  const result = await runStrategyRealtimeCore(f.context, f.session, providers(output, { requestSingleCore: async () => { calls++; return output; } }));
  assert.equal(calls, 0); assert.equal(result.execution?.status, 'blocked'); assert.equal(result.draft, null);
  assert.equal(result.failureDetail, 'POLICY_RUNTIME_REVISION_CHANGED'); assert.equal(f.turn.rawTranscript, '작성 시점을 비교했습니다.');
});

test('missing full policy originals cannot authorize core execution or fallback speech', async () => {
  const f = fixture(); let calls = 0;
  f.context.interviewerPolicy = { contentSha256: 'synthetic-policy' } as NonNullable<InterviewContext['interviewerPolicy']>;
  const manifest = f.session.sourceManifest as InterviewContext['manifest'];
  manifest.interviewerPolicy = { contentSha256: 'synthetic-policy' } as NonNullable<typeof manifest.interviewerPolicy>;
  const result = await runStrategyRealtimeCore(f.context, f.session, providers(followUp(), { requestSingleCore: async () => { calls++; return followUp(); } }));
  assert.equal(calls, 0); assert.equal(result.execution?.status, 'blocked'); assert.equal(result.draft, null);
  assert.equal(result.failureDetail, 'FULL_MD_POLICY_ORIGINALS_REQUIRED'); assert.equal(f.turn.answerId, 'a0');
});

test('full-mode original integrity is checked before observed silence or restoring a saved v5 decision', async () => {
  for (const path of ['silence', 'saved_decision'] as const) {
    const f = fixture(path === 'silence' ? '' : '작성 시점을 비교했습니다.'); let calls = 0;
    f.context.interviewerPolicy = { contentSha256: 'synthetic-policy' } as NonNullable<InterviewContext['interviewerPolicy']>;
    const manifest = f.session.sourceManifest as InterviewContext['manifest'];
    manifest.interviewerPolicy = { contentSha256: 'synthetic-policy' } as NonNullable<typeof manifest.interviewerPolicy>;
    const output: SingleCoreOutput = { assessment: { coverage: 'met', response: 'answered', reason: '원래 요구를 충족했다.' }, next: { action: 'TRANSITION', question: null }, reaction: null };
    if (path === 'silence') f.turn.answerObservation = { classification: 'silence_observed', nonAnswer: true, durationMs: 3000, speakingMs: 0, silenceMs: 3000,
      firstSpeechMs: null, speechDetected: false, rawTranscriptPreserved: true, origin: 'finalized-stt-and-observed-speech-timing' };
    else f.turn.metadata.coreDecision = { sourceTurnId: f.turn.id, sourceAnswerId: f.turn.answerId, engineVersion: SINGLE_CORE_ENGINE_VERSION, semanticDecision: output };
    const result = await runStrategyRealtimeCore(f.context, f.session, providers(output, { policyMode: 'full', recoveryOnly: path === 'saved_decision',
      requestSingleCore: async () => { calls++; return output; }, requestFactReview: async input => { calls++; return allowed(input); },
      requestSurfaceRepair: async () => { calls++; return '판단한 근거 한 가지만 말씀해 주세요.'; },
    }));
    assert.equal(calls, 0); assert.equal(result.execution?.status, 'blocked'); assert.equal(result.execution?.action, null);
    assert.equal(result.draft, null); assert.equal(result.failureDetail, 'FULL_MD_POLICY_ORIGINALS_REQUIRED');
    assert.equal(result.semanticDecision, undefined); assert.equal(result.providerTimings.coreModelCalls, 0); assert.equal(f.turn.answerId, 'a0');
  }
});

test('the single-core input excludes regex-derived language signals and completion witnesses', async () => {
  const f = fixture('정확히는 조건은 기억나지 않습니다.');
  const output: SingleCoreOutput = { assessment: { coverage: 'partial', response: 'unavailable', reason: '명시한 불가 범위를 존중한다.' }, next: { action: 'TRANSITION', question: null }, reaction: null };
  const result = await runStrategyRealtimeCore(f.context, f.session, providers(output, { requestSingleCore: async request => {
    const payload = JSON.parse(request.input);
    assert.equal(Object.hasOwn(payload, 'turn_local_coverage'), false);
    assert.equal(Object.hasOwn(payload, 'memory'), false);
    assert.equal(Object.hasOwn(payload, 'clusterObjective'), false);
    assert.equal(Object.hasOwn(payload.question, 'intent'), false);
    assert.equal(Object.hasOwn(payload.question, 'targetEvidence'), false);
    assert.equal(payload.question.text, f.turn.questionText);
    assert.ok(payload.actualAnswers.answers.every((answer: object) => !Object.hasOwn(answer, 'languageSignals')));
    return output;
  } }));
  assert.equal(result.fulfillment, 'partial'); assert.equal(result.nextAction, 'TRANSITION');
});

test('an unrelated but factually open repaired question cannot inherit the original demand contract', async () => {
  for (const demandMatch of ['changed', 'uncertain'] as const) {
    const f = fixture(), output = followUp(), before = structuredClone(f.session);
    const unrelated = '지원 학과에 관심을 갖게 된 계기는 무엇인가요?';
    let cores = 0, repairs = 0, reviews = 0;
    const result = await runStrategyRealtimeCore(f.context, f.session, providers(output, {
      requestSingleCore: async () => { cores++; return output; },
      requestSurfaceRepair: async () => { repairs++; return unrelated; },
      requestFactReview: async input => {
        reviews++;
        if (reviews === 1) { assert.equal(Object.hasOwn(input, 'repairContract'), false); return rejected(input); }
        assert.equal(input.question.questionText, unrelated);
        assert.equal(input.repairContract?.originalText, output.next.question!.text);
        assert.equal(input.repairContract?.target, '실제로 사용한 비교 기준');
        assert.equal(input.repairContract?.primaryFunction, 'CHOICE');
        assert.equal(input.repairContract?.action, 'FOLLOW_UP');
        assert.ok(Object.isFrozen(input.repairContract));
        return { ...allowed(input), demandMatch };
      },
    }));
    assert.equal(cores, 1); assert.equal(repairs, 1); assert.equal(reviews, 2);
    assert.equal(result.execution?.status, 'blocked'); assert.equal(result.execution?.action, null);
    assert.equal(result.draft, null); assert.equal(result.questionRecoveryRequired, true);
    assert.equal(result.failureDetail, demandMatch === 'changed' ? 'REPAIR_MEANING_CHANGED' : 'REPAIR_MEANING_UNCERTAIN');
    assert.equal(result.factReviewTraces?.[1].repairCheck?.demandMatch, demandMatch);
    assert.deepEqual(result.semanticDecision, output); assert.deepEqual(f.session, before);
  }
});

test('same-demand repair stores a hashed proof and a retry always compares against the original core wording', async () => {
  const f = fixture(), output = followUp(), originalText = output.next.question!.text;
  const repaired = '자료를 비교한 기준 한 가지만 말씀해 주세요.';
  let reviews = 0;
  const result = await runStrategyRealtimeCore(f.context, f.session, providers(output, {
    requestSurfaceRepair: async () => repaired,
    requestFactReview: async input => { reviews++; return reviews === 1 ? rejected(input) : allowed(input); },
  }));
  assert.equal(result.execution?.status, 'ready');
  const proof = result.draft?.premiseValidation?.repairCheck;
  assert.equal(proof?.verdict, 'same'); assert.equal(proof?.contract.originalText, originalText);
  assert.equal(proof?.candidateQuestionSha256, createHash('sha256').update(repaired).digest('hex'));
  assert.doesNotThrow(() => assertQuestionContractIntegrity(result.draft!, result.draft!.approvedQuestion!));
  f.turn.metadata.coreDecision = { sourceTurnId: f.turn.id, sourceAnswerId: f.turn.answerId, engineVersion: SINGLE_CORE_ENGINE_VERSION,
    semanticDecision: output, factReviewTraces: result.factReviewTraces, questionRecoveryRequired: true };
  let cores = 0, retryReviews = 0, retryRepairs = 0;
  const retry = await runStrategyRealtimeCore(f.context, f.session, providers(output, { recoveryOnly: true,
    requestSingleCore: async () => { cores++; return output; },
    requestSurfaceRepair: async () => { retryRepairs++; return '자료 비교에 사용한 기준을 말씀해 주세요.'; },
    requestFactReview: async input => {
      retryReviews++; assert.equal(input.repairContract?.originalText, originalText);
      assert.notEqual(input.repairContract?.originalText, repaired); return allowed(input);
    },
  }));
  assert.equal(cores, 0); assert.equal(retryRepairs, 1); assert.equal(retryReviews, 1);
  assert.equal(retry.execution?.status, 'ready'); assert.deepEqual(retry.semanticDecision, output);
  assert.equal(retry.draft?.premiseValidation?.repairCheck?.contractSha256, proof?.contractSha256);
});

test('a missing repaired-review demand verdict fails closed without another repair or review', async () => {
  const f = fixture(), output = followUp(); let reviews = 0, repairs = 0;
  const result = await runStrategyRealtimeCore(f.context, f.session, providers(output, {
    requestSurfaceRepair: async () => { repairs++; return '비교에 사용한 기준은 무엇인가요?'; },
    requestFactReview: async input => {
      reviews++;
      if (reviews === 1) return rejected(input);
      return { verdict: 'allowed', completeAssertionCoverage: true,
        premises: [{ questionSpan: input.question.questionText, basis: 'open_check', proofId: null, supported: true }] };
    },
  }));
  assert.equal(reviews, 2); assert.equal(repairs, 1); assert.equal(result.execution?.status, 'blocked');
  assert.equal(result.draft, null); assert.equal(result.questionRecoveryRequired, true);
});


test('core/review/repair/review consume one technical context without adding provider calls or changing model output', async () => {
  const f = fixture('자료를 비교했습니다. 기준은 설명하지 못했습니다.'), clock = new WorkTestClock();
  const work = createTurnWorkContext({ attemptId: 'synthetic-budget-chain', timeoutMs: 95_000, clock });
  const caps: number[] = []; let calls = 0, reviews = 0, repairs = 0;
  const result = await runStrategyRealtimeCore(f.context, f.session, providers(followUp(), { workContext: work,
    requestSingleCore: async (_request, stage) => { calls++; caps.push(stage!.timeoutMs); clock.advance(14_000); return followUp(); },
    requestFactReview: async (input, stage) => { reviews++; caps.push(stage!.timeoutMs); clock.advance(11_000); return reviews === 1 ? rejected(input) : allowed(input); },
    requestSurfaceRepair: async (_input, stage) => { repairs++; caps.push(stage!.timeoutMs); clock.advance(5_000); return '자료를 비교할 때 사용한 기준을 설명해 주세요.'; },
  }));
  assert.deepEqual(caps, [15_000, 12_000, 6_000, 12_000]);
  assert.deepEqual([calls, reviews, repairs], [1, 2, 1]); assert.equal(work.remainingMs(), 54_000);
  assert.equal(result.execution?.status, 'ready'); assert.deepEqual(result.semanticDecision, followUp());
  work.complete();
});

test('STT-spent total deadline caps fact review and ignores late approval without repair or output commit', async () => {
  const f = fixture('자료를 비교했습니다. 기준은 설명하지 못했습니다.'), original = structuredClone(f.turn), clock = new WorkTestClock();
  const work = createTurnWorkContext({ attemptId: 'synthetic-late-review', timeoutMs: 95_000, clock }); clock.advance(80_000);
  let entered!: () => void, release!: () => void, observedSignal!: AbortSignal, reviewCap = 0, repairs = 0, reviewInput!: RuntimeFactReviewInput;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const result = runStrategyRealtimeCore(f.context, f.session, providers(followUp(), { workContext: work,
    requestSingleCore: async (_request, stage) => { assert.equal(stage!.timeoutMs, 15_000); clock.advance(10_000); return followUp(); },
    requestFactReview: async (input, stage) => { reviewInput = input; reviewCap = stage!.timeoutMs; observedSignal = stage!.signal; entered(); await gate; return allowed(input); },
    requestSurfaceRepair: async () => { repairs++; return '자료의 비교 기준은 무엇인가요?'; },
  }));
  await started; assert.equal(reviewCap, 5_000);
  const failure = assert.rejects(result, { code: 'TURN_WORK_TIMEOUT' }); clock.advance(5_000); await failure;
  assert.equal(observedSignal.aborted, true); release(); await Promise.resolve();
  assert.equal(repairs, 0); assert.deepEqual(f.turn, original); assert.ok(reviewInput);
});
