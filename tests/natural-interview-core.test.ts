import test from 'node:test';
import OpenAI from 'openai';
import assert from 'node:assert/strict';
import type { InterviewContext, StudentEvidence } from '../server/data/load-interview-context';
import type { InterviewSession, QuestionDraft, RecordedTurn } from '../server/protocol';
import { runStrategyRealtimeCore } from '../server/providers/realtime-strategy-core';
import { buildQuestionPremiseReviewInput, finalizeQuestionPremiseReview, buildStablePremiseProofOptions, type QuestionPremiseReviewInput } from '../server/providers/question-premises';
import { createQuestionBlueprint, approveQuestionContract, assertQuestionContractIntegrity } from '../server/question-objective';
import { buildConversationLedger, ledgerTargetKey } from '../server/conversation-ledger';
import { compileInterviewerPolicy } from '../server/policy/interviewer-policy';
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

function natural(raw: string) {
  return { answerRelation: { kind: 'related' as const, note: '관련 답변이나 실제 비교 기준이 아직 명확하지 않다.' },
    interpretation: { meaning: '자료를 비교했다는 실제 행동을 말했다.', dialogueRequests: [] as string[], covered: [] as Array<{targetId:string;answerQuote:string}>, unresolved: [] as Array<{targetId:string;missingMeaning:string}>, corrections: [] as string[], uncertainty: [] as string[] },
    decision: { fulfillment: 'partial' as 'met'|'partial'|'unknown', action: 'FOLLOW_UP' as 'FOLLOW_UP'|'CLARIFICATION'|'TRANSITION'|'CLOSING', reason: 'missing_requested_detail', necessity: '실제로 언급한 비교에서 어떤 기준을 사용했는지 한 지점만 확인한다.', reaction: null,
      question: { text: '자료를 비교할 때 어떤 기준을 사용했나요?', intent: '실제로 자료를 비교한 구체적인 기준을 확인한다.', target: '자료 비교에 실제 사용한 판단 기준', primaryFunction: 'CHOICE', depth: 'D2', answerQuote: raw, strategyId: null, matchedEstablishedTargetIds: [] as string[] } as {text:string;intent:string;target:string;primaryFunction:string;depth:string;answerQuote:string;strategyId:null;matchedEstablishedTargetIds:string[]}|null } };
}
function review(input: QuestionPremiseReviewInput) {
  return { verdict: 'allowed', completeAssertionCoverage: true, coreIntentCount: 1, intentMatches: true, clarificationPreservesIntent: true,
    runtimePurpose: input.question.questionKind === 'follow_up' ? { subordinateToCluster: true, hasAdditionalVerificationValue: true, repeatedEstablishedTargetIds: [] } : null,
    premises: [{ questionSpan: input.question.questionText, basis: 'open_check', proofId: null, supported: true }] };
}

function partialComparisonFixture() {
  const f = fixture('온도가 올라가면 약전해질은 해리도가 커져 전도도가 높아집니다.');
  const source = f.context.student.evidence[0];
  source.text = '약전해질과 강전해질의 전도도 변화를 비교하여 탐구함.';
  source.sourceRef.endOffset = source.sourceRef.startOffset! + source.text.length;
  const draft: QuestionDraft = { ...f.turn.metadata, acknowledgement: null, acknowledgementQuote: null,
    questionText: '온도 상승에 따른 약전해질의 전도도 변화를 강전해질과 비교해 설명해 주세요.',
    questionKind: 'main', parentMainQuestionId: null, evidenceIds: [source.id], evidenceQuotes: [{ evidenceId: source.id, quote: source.text }],
    primaryFunction: 'CONCEPT', depth: 'D3', questionIntent: '온도 상승에 따른 두 전해질 전도도 변화 비교', targetEvidence: ['두 전해질의 변화 비교'] };
  delete draft.questionBlueprint; delete draft.approvedQuestion; delete draft.questionRealization;
  draft.premiseValidation = finalizeQuestionPremiseReview({ verdict: 'allowed', completeAssertionCoverage: true,
    coreIntentCount: 1, intentMatches: true, clarificationPreservesIntent: true,
    premises: [{ questionSpan: draft.questionText, basis: 'open_check', sourceId: null, supportQuote: null, supported: true }] },
    buildQuestionPremiseReviewInput(draft, [source]), 'explicit-synthetic-offline-review');
  draft.questionBlueprint = createQuestionBlueprint(draft, f.context, f.session, { questionId: f.turn.id });
  draft.approvedQuestion = approveQuestionContract(draft, draft.questionBlueprint);
  f.turn.questionText = draft.questionText; f.turn.metadata = { ...f.turn.metadata, ...draft };
  const output = natural(f.turn.rawTranscript!);
  output.interpretation.meaning = '약전해질 설명만 했고 강전해질과의 비교가 빠졌습니다.';
  output.interpretation.covered = [{ targetId: ledgerTargetKey(f.turn), answerQuote: f.turn.rawTranscript! }];
  output.interpretation.unresolved = [{ targetId: ledgerTargetKey(f.turn), missingMeaning: '강전해질 변화와 약전해질과의 차이' }];
  output.decision.necessity = '이미 설명한 약전해질을 반복하지 않고 빠진 강전해질 변화 한 지점을 확인한다.';
  output.decision.question = { ...output.decision.question!,
    text: '강전해질은 온도가 올라갈 때 전도도가 어떻게 변하며, 약전해질과 어떤 차이가 있나요?',
    intent: '빠진 강전해질 전도도 변화 확인', target: '강전해질 전도도 변화와 비교', primaryFunction: 'CONCEPT', depth: 'D3' };
  return { ...f, output };
}

function comparisonReview(input: QuestionPremiseReviewInput, answer: string) {
  return { ...review(input), runtimePurpose: { subordinateToCluster: true, hasAdditionalVerificationValue: true, repeatedEstablishedTargetIds: [],
    demandRelation: 'missing_subpart', currentDemandFulfillment: 'partial', demandStructure: 'explicit_comparison',
    missingSubpartProof: { answeredDemandSpan: '약전해질', missingDemandSpan: '강전해질', scopeOperatorQuote: '비교해', answeredAnswerQuote: answer } } };
}
test('v3 uses answer-specific language and independent final review, not the operation template registry', async () => {
  const f=fixture('자료를 비교했습니다.');let calls=0,reviews=0;
  const result=await runStrategyRealtimeCore(f.context,f.session,{allowFollowUp:true,allowClarification:true,requestStrategy:async()=>{calls++;return natural(f.turn.rawTranscript!);},requestReview:async input=>{reviews++;assert.equal(input.answer?.answerId,'answer0');return review(input);}});
  assert.equal(result.origin,'model');assert.equal(result.nextAction,'FOLLOW_UP');assert.equal(calls,1);assert.equal(reviews,1);
  assert.equal(result.draft?.questionText,'자료를 비교할 때 어떤 기준을 사용했나요?');assert.equal(result.draft?.targetEvidence[0],'자료 비교에 실제 사용한 판단 기준');
  assert.equal(result.draft?.approvedQuestion?.validation.independentSemanticReview,true);assert.equal(result.providerTimings.premiseReviewAttempts,1);
  assert.doesNotThrow(()=>assertQuestionContractIntegrity(result.draft!,result.draft!.approvedQuestion!));
});

test('an independent review blocks a paraphrase of an established meaning despite empty generator overlap IDs', async () => {
  const f = fixture('작성 시점을 기준으로 비교했습니다.');
  const out = natural(f.turn.rawTranscript!);
  out.interpretation.covered = [{ targetId: ledgerTargetKey(f.turn), answerQuote: f.turn.rawTranscript! }];
  out.decision.fulfillment = 'met';
  const result = await runStrategyRealtimeCore(f.context, f.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async () => out,
    requestReview: async input => ({ ...review(input), runtimePurpose: { subordinateToCluster: true, hasAdditionalVerificationValue: false, repeatedEstablishedTargetIds: [ledgerTargetKey(f.turn)] } }) });
  assert.equal(result.draft, null);
  assert.equal(result.nextAction, 'TRANSITION');
  assert.equal(result.providerTimings.premiseReviewAttempts, 1);
  assert.equal(result.origin, 'model');
  assert.ok(result.serverGuards?.includes('QUESTION_REPEATED_TARGET'));
});
test('a related answer mixed with a meaning request is rephrased, not rejected or classified off-topic', async () => {
  const f=fixture('자료는 비교했는데 질문이 어떤 뜻인지 잘 모르겠습니다.');const out=natural(f.turn.rawTranscript!);
  out.interpretation.dialogueRequests=['explain_question'];out.decision.action='CLARIFICATION';out.decision.reason='meaning_request';
  out.decision.question!.text='자료를 비교할 때 어떤 순서로 진행했는지 말씀해 주세요.';
  const result=await runStrategyRealtimeCore(f.context,f.session,{allowFollowUp:true,allowClarification:true,requestStrategy:async()=>out,requestReview:async input=>{assert.equal(input.originalQuestion?.questionText,f.turn.questionText);return review(input);}});
  assert.equal(result.origin,'model');assert.equal(result.nextAction,'CLARIFICATION');assert.equal(result.draft?.questionKind,'clarification');
  assert.equal(result.draft?.questionIntent,f.turn.metadata.questionIntent);assert.deepEqual(result.draft?.targetEvidence,f.turn.metadata.targetEvidence);
  assert.notEqual(result.draft?.questionText,f.turn.questionText);assert.equal(result.answerRelation?.kind,'related');
});
test('an explicit repeat request reuses the approved question without inventing a new F or adding review calls',async()=>{
  const f=fixture('앞부분은 이해했는데 질문을 다시 들려주세요.');const out=natural(f.turn.rawTranscript!);
  out.interpretation.dialogueRequests=['repeat_audio'];out.decision.action='CLARIFICATION';out.decision.reason='repeat_request';out.decision.question=null;
  const result=await runStrategyRealtimeCore(f.context,f.session,{allowFollowUp:true,allowClarification:true,requestStrategy:async()=>out,requestReview:async()=>{throw new Error('must not call');}});
  assert.equal(result.nextAction,'CLARIFICATION');assert.equal(result.draft,null);assert.equal(result.providerTimings.premiseReviewAttempts,0);
});

test('a two-statement probe carries separately attributed prior and current answer proofs into its blueprint', async () => {
  const f = fixture('혼자 자료를 비교했습니다.');
  const first = await runStrategyRealtimeCore(f.context, f.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async () => natural(f.turn.rawTranscript!), requestReview: async input => review(input) });
  assert.ok(first.draft);
  const follow = { ...f.turn, id: 'f1', answerId: 'answer1', questionKind: 'follow_up' as const, questionText: first.draft.questionText, rawTranscript: '팀원들과 자료를 비교했습니다.', followUpIndex: 1, metadata: { ...f.turn.metadata, ...first.draft } } as RecordedTurn;
  f.session.turns.push(follow);
  const out = natural(follow.rawTranscript!);
  out.decision.reason = 'two_statements_need_confirmation';
  out.decision.question = { ...out.decision.question!, text: '앞서 혼자 비교했다고 했는데, 팀원들과 본인이 한 일을 어떻게 구분하나요?', intent: '자료 비교에서 개인 행동과 팀 행동의 차이 확인', target: '혼자 한 자료 비교와 팀원들과 한 자료 비교의 범위', primaryFunction: 'ROLE' };
  const result = await runStrategyRealtimeCore(f.context, f.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async () => out, requestReview: async input => {
    const prior = input.answerSources?.find(answer => answer.turnId === 'q0');
    assert.equal(prior?.text, f.turn.rawTranscript);
    return { ...review(input), premises: [
      { questionSpan: '혼자 비교했다고 했는데', basis: 'answer_turn_attributed', proofId: buildStablePremiseProofOptions(input).find(proof => proof.sourceId === prior!.id && proof.supportQuote === prior!.text)!.proofId, supported: true },
      { questionSpan: '팀원들과', basis: 'answer_turn_attributed', proofId: buildStablePremiseProofOptions(input).find(proof => proof.sourceId === input.answer!.id && proof.supportQuote === input.answer!.text)!.proofId, supported: true },
    ] };
  } });
  assert.equal(result.origin, 'model');
  const refs = result.draft?.questionBlueprint?.anchorRefs ?? [];
  assert.ok(refs.some(ref => ref.kind === 'ANSWER_TURN' && ref.sourceId === 'ANSWER_TURN:q0:answer0'));
  assert.ok(refs.some(ref => ref.kind === 'ANSWER_TURN' && ref.sourceId === 'ANSWER_TURN:f1:answer1'));
});
test('uncertain final review preserves the current answer when no approved distinct recovery exists',async()=>{
  const f=fixture('자료를 비교했습니다.');const out=natural(f.turn.rawTranscript!);
  const result=await runStrategyRealtimeCore(f.context,f.session,{allowFollowUp:true,allowClarification:true,requestStrategy:async()=>out,requestReview:async input=>({...review(input),verdict:'uncertain'})});
  assert.equal(result.origin,'fallback');assert.equal(result.draft,null);assert.equal(result.reaction.directive,'next_main');assert.equal(result.failureStage,'final_question_review');
  assert.equal(result.questionRecoveryRequired,true);
  assert.equal(result.providerTimings.coreModelCalls,1);assert.equal(result.providerTimings.premiseReviewAttempts,1);
});

test('a no-useful-probe verdict cannot turn a failed premise review into an automatic topic transition', async () => {
  for (const failure of ['uncertain', 'unsupported', 'invalid_proof'] as const) {
    const f = fixture('자료를 비교했습니다.');
    const result = await runStrategyRealtimeCore(f.context, f.session, {
      allowFollowUp: true, allowClarification: true, requestStrategy: async () => natural(f.turn.rawTranscript!),
      requestReview: async input => ({ ...review(input),
        verdict: failure === 'uncertain' ? 'uncertain' : 'allowed',
        runtimePurpose: { subordinateToCluster: true, hasAdditionalVerificationValue: false, repeatedEstablishedTargetIds: [] },
        premises: failure === 'invalid_proof'
          ? [{ questionSpan: '자료를', basis: 'record', proofId: 'P99999', supported: true }]
          : [{ questionSpan: input.question.questionText, basis: 'open_check', proofId: null, supported: failure !== 'unsupported' }],
      }),
    });
    assert.equal(result.origin, 'fallback', failure);
    assert.equal(result.questionRecoveryRequired, true, failure);
    assert.equal(result.draft, null, failure);
    assert.ok(!result.serverGuards?.includes('QUESTION_NO_USEFUL_PROBE'), failure);
    assert.equal(f.session.turns[0].rawTranscript, '자료를 비교했습니다.');
    assert.equal(f.session.turns.length, 1);
  }
});

test('failed review uses only a separately approved distinct same-demand recovery without another model call',async()=>{
  const f=fixture('자료를 비교했습니다.');
  const recovery={...f.turn.metadata,acknowledgement:null,acknowledgementQuote:null,questionText:'자료를 비교한 한 단계를 설명해 주세요.',questionKind:'clarification' as const,parentMainQuestionId:f.turn.id,evidenceIds:f.turn.evidenceIds} as QuestionDraft;
  const input=buildQuestionPremiseReviewInput(recovery,f.context.student.evidence);
  recovery.premiseValidation=finalizeQuestionPremiseReview({verdict:'allowed',completeAssertionCoverage:true,coreIntentCount:1,intentMatches:true,clarificationPreservesIntent:true,premises:[{questionSpan:'자료를',basis:'record',sourceId:'E01',supportQuote:f.context.student.evidence[0].text,supported:true}]},{...input,originalQuestion:{questionText:f.turn.questionText,questionIntent:f.turn.metadata.questionIntent,targetEvidence:f.turn.metadata.targetEvidence,primaryFunction:f.turn.metadata.primaryFunction,depth:f.turn.metadata.depth}},'synthetic-preapproved-recovery');
  recovery.questionBlueprint=createQuestionBlueprint(recovery,f.context,f.session,{questionId:'recovery'});
  recovery.approvedQuestion=approveQuestionContract(recovery,recovery.questionBlueprint);
  const output = natural(f.turn.rawTranscript!);
  output.decision.action = 'CLARIFICATION';
  output.decision.question = { ...output.decision.question!, text: '자료를 비교한 순서를 설명해 주세요.', primaryFunction: f.turn.metadata.primaryFunction,
    intent: f.turn.metadata.questionIntent, target: f.turn.metadata.targetEvidence[0] };
  const result=await runStrategyRealtimeCore(f.context,f.session,{allowFollowUp:true,allowClarification:true,requestStrategy:async()=>output,requestReview:async input=>({...review(input),verdict:'uncertain'}),resolveApprovedRecovery:async()=>recovery});
  assert.equal(result.nextAction,'CLARIFICATION');assert.equal(result.draft?.questionText,recovery.questionText);
  assert.equal(result.questionRecoveryRequired,undefined);assert.equal(result.providerTimings.coreModelCalls,1);assert.equal(result.providerTimings.premiseReviewAttempts,1);
  assert.ok(result.serverGuards?.includes('APPROVED_SAME_DEMAND_RECOVERY'));
});
test('semantic coverage is source-bound and does not mark the original calculation-like requirement satisfied by a different F answer',()=>{
  const f=fixture('자료를 비교했습니다.');const original=ledgerTargetKey(f.turn);
  const follow={...f.turn,id:'f1',answerId:'a1',questionKind:'follow_up' as const,questionText:'용어의 의미는 무엇인가요?',metadata:{...f.turn.metadata,questionBlueprint:undefined,approvedQuestion:undefined,questionIntent:'비교와 대조 개념 의미 확인',targetEvidence:['비교라는 용어의 뜻'],coreDecision:{sourceTurnId:'f1',sourceAnswerId:'a1',fulfillment:'met' as const,nextAction:'TRANSITION' as const,interpretation:{meaning:'개념만 설명했다.',dialogueRequests:[],covered:[],unresolved:[{targetId:original,missingMeaning:'실제로 거친 비교 단계가 남음'}],corrections:[],uncertainty:[]}}}};
  f.session.turns.push(follow);const ledger=buildConversationLedger(f.session);
  assert.ok(ledger.unresolvedTargets.includes(original));assert.notEqual(ledger.rootRequestedTargetId,ledger.currentRequestedTargetId);
});
test('a fabricated covered quote is rejected before final review can approve a question',async()=>{
  const f=fixture('자료를 비교했습니다.');const out=natural(f.turn.rawTranscript!);out.interpretation.covered=[{targetId:ledgerTargetKey(f.turn),answerQuote:'표본 오차를 검증했습니다'}];
  const result=await runStrategyRealtimeCore(f.context,f.session,{allowFollowUp:true,allowClarification:true,requestStrategy:async()=>out,requestReview:async()=>{throw new Error('must not review');}});
  assert.equal(result.origin,'fallback');assert.equal(result.draft,null);assert.equal(result.providerTimings.premiseReviewAttempts,0);
});
test('empty transcript without observed healthy silence does not become a declined answer in the ledger',()=>{
  const f=fixture('');assert.deepEqual(buildConversationLedger(f.session).declinedTargets,[]);
});
test('compiled policy maps current core requirements and explicit user overrides to all twelve current source documents',async()=>{
  const pack=await compileInterviewerPolicy();assert.equal(pack.sourceFiles.length,12);assert.ok(pack.rules.length>15);
  for(const id of ['DIALOGUE_REQUESTS','CLARIFICATION_UNIT','APPROVED_COMMON','ANSWER_BOUND_F','SAME_SESSION_RECOVERY','NO_RETROACTIVE_TARGET'])assert.ok(pack.rules.some(r=>r.id===id));
  for(const id of ['USER_EXAMPLE_PARTITION','USER_CAMERA_OPTIONAL','USER_TIME_BASED'])assert.ok(pack.userOverrides.some(r=>r.id===id));
});

test('a policy source error with a role suffix cannot authorize cached recovery speech',async()=>{
  const f=fixture();let attempts=0,recoveries=0;
  const result=await runStrategyRealtimeCore(f.context,f.session,{allowFollowUp:true,allowClarification:true,requestStrategy:async()=>{attempts++;throw new Error('FULL_MD_POLICY_SNAPSHOT_SOURCE_MISMATCH:questionGuidelines');},resolveApprovedRecovery:async()=>{recoveries++;return null;}});
  assert.equal(attempts,1);assert.equal(recoveries,0);assert.equal(result.questionRecoveryRequired,true);assert.equal(result.draft,null);
});


test('quota and authentication failures are flagged for answer-preserving runtime recovery, never an approved next question', async () => {
  for (const status of [401, 403, 429]) {
    const f = fixture('자료를 비교했습니다.');
    const result = await runStrategyRealtimeCore(f.context, f.session, { allowFollowUp: true, allowClarification: true, requestStrategy: async () => { throw OpenAI.APIError.generate(status, { error: { code: status === 429 ? 'credit_balance_exhausted' : 'authorization_failed', message: 'synthetic blocked provider' } }, undefined, new Headers()); } });
    assert.equal(result.providerUnavailable, true);
    assert.equal(result.draft, null);
    assert.equal(result.origin, 'fallback');
    assert.equal(result.failureCode, 'CORE_PROVIDER_ERROR');
    assert.match(result.failureDetail!, new RegExp('PROVIDER_HTTP_' + status));
    assert.equal(f.session.turns.length, 1);
    assert.equal(f.session.turns[0].rawTranscript, '자료를 비교했습니다.');
  }
});

test('independent same-whole-demand classification changes an apparent F into a non-F rephrase', async () => {
  const f = fixture('다 같이 열심히 비교했습니다.'), output = natural(f.turn.rawTranscript!);
  output.decision.question!.text = '자료를 비교한 과정을 조금 더 쉽게 설명해 주시겠어요?';
  const result = await runStrategyRealtimeCore(f.context, f.session, { allowFollowUp: true, allowClarification: true,
    requestStrategy: async () => output, requestReview: async input => ({ ...review(input), runtimePurpose: {
      subordinateToCluster: true, hasAdditionalVerificationValue: true, repeatedEstablishedTargetIds: [],
      demandRelation: 'same_whole_demand_rephrase', currentDemandFulfillment: 'partial',
    } }) });
  assert.equal(result.nextAction, 'CLARIFICATION'); assert.equal(result.draft?.questionKind, 'clarification');
  assert.equal(result.draft?.questionIntent, f.turn.metadata.questionIntent);
  assert.deepEqual(f.session.followUpCountByMainQuestion, {});
});

test('independent local fulfillment overrides a generator trying to reopen a root gap', async () => {
  const f = fixture('작성 시점을 기준으로 비교했습니다.'), output = natural(f.turn.rawTranscript!);
  const result = await runStrategyRealtimeCore(f.context, f.session, { allowFollowUp: true, allowClarification: true,
    requestStrategy: async () => output, requestReview: async input => ({ ...review(input), runtimePurpose: {
      subordinateToCluster: true, hasAdditionalVerificationValue: false, repeatedEstablishedTargetIds: [],
      demandRelation: 'missing_subpart', currentDemandFulfillment: 'met',
    } }) });
  assert.equal(result.nextAction, 'TRANSITION'); assert.equal(result.fulfillment, 'met');
  assert.equal(result.turnLocalCoverage?.fulfillment, 'met'); assert.equal(result.draft, null);
});

test('surface failure runs one small same-demand repair and its own independent review, without a new core', async () => {
  const f = fixture('자료를 비교했습니다.'), output = natural(f.turn.rawTranscript!);
  output.decision.action = 'CLARIFICATION';
  Object.assign(output.decision.question!, { primaryFunction: f.turn.metadata.primaryFunction, intent: f.turn.metadata.questionIntent, target: f.turn.metadata.targetEvidence[0] });
  output.decision.question!.text = '무엇을 비교했나요? 왜 그랬나요?';
  let cores = 0, repairs = 0, reviews = 0;
  const result = await runStrategyRealtimeCore(f.context, f.session, { allowFollowUp: true, allowClarification: true,
    requestStrategy: async () => { cores++; return output; },
    requestRepair: async input => { repairs++; assert.equal(input.question, f.turn.questionText); return '자료를 비교한 한 단계를 설명해 주세요.'; },
    requestReview: async input => { reviews++; assert.equal(input.question.questionKind, 'clarification'); return review(input); } });
  assert.equal(cores, 1); assert.equal(repairs, 1); assert.equal(reviews, 1);
  assert.equal(result.nextAction, 'CLARIFICATION'); assert.equal(result.providerTimings.repairModelCalls, 1);
  assert.equal(result.questionRecoveryRequired, undefined); assert.equal(f.turn.rawTranscript, '자료를 비교했습니다.');
  assert.equal(result.draft?.approvedQuestion?.validation.independentSemanticReview, true);
});

test('a rejected narrow comparison F repairs only the missing demand and never loads a whole-Q0 rephrase', async () => {
  const f = partialComparisonFixture(); let cores = 0, repairs = 0, reviews = 0, staticRephrases = 0;
  const repaired = '강전해질은 온도가 오를 때 전도도가 어떻게 변하나요?';
  const result = await runStrategyRealtimeCore(f.context, f.session, { allowFollowUp: true, allowClarification: true,
    requestStrategy: async () => { cores++; return f.output; },
    resolveApprovedRecovery: async () => { staticRephrases++; return null; },
    requestRepair: async input => {
      repairs++; assert.equal(input.action, 'FOLLOW_UP'); assert.equal(input.question, f.turn.questionText);
      assert.equal(input.candidate?.target, f.output.decision.question?.target);
      return repaired;
    },
    requestReview: async input => {
      reviews++; assert.equal(input.question.questionKind, 'follow_up');
      if (reviews === 1) return { ...comparisonReview(input, f.turn.rawTranscript!), verdict: 'rewrite',
        premises: [{ questionSpan: '강전해질은 온도가 올라갈 때 전도도가 어떻게 변하며', basis: 'record', proofId: null, supported: false }] };
      assert.equal(input.question.questionText, repaired);
      return comparisonReview(input, f.turn.rawTranscript!);
    },
  });
  assert.equal(cores, 1); assert.equal(repairs, 1); assert.equal(reviews, 2); assert.equal(staticRephrases, 0);
  assert.equal(result.nextAction, 'FOLLOW_UP'); assert.equal(result.draft?.questionKind, 'follow_up');
  assert.equal(result.draft?.questionText, repaired); assert.equal(result.draft?.targetEvidence[0], f.output.decision.question?.target);
  assert.equal(result.questionRecoveryRequired, undefined); assert.equal(result.providerTimings.coreModelCalls, 1);
  assert.equal(result.providerTimings.repairModelCalls, 1); assert.equal(result.providerTimings.premiseReviewAttempts, 2);
  assert.ok(result.serverGuards?.includes('BOUNDED_MISSING_DEMAND_REPAIR_APPROVED'));
  assert.equal(result.draft?.approvedQuestion?.validation.independentSemanticReview, true);
  assert.equal(f.turn.rawTranscript, '온도가 올라가면 약전해질은 해리도가 커져 전도도가 높아집니다.');
});

test('a still-rejected narrow F repair preserves the answer and cannot skip to a static whole-question or another topic', async () => {
  const f = partialComparisonFixture(); let cores = 0, repairs = 0, reviews = 0, staticRephrases = 0;
  const answerId = f.turn.answerId, transcript = f.turn.rawTranscript;
  const result = await runStrategyRealtimeCore(f.context, f.session, { allowFollowUp: true, allowClarification: true,
    requestStrategy: async () => { cores++; return f.output; },
    resolveApprovedRecovery: async () => { staticRephrases++; return null; },
    requestRepair: async input => { repairs++; assert.equal(input.action, 'FOLLOW_UP'); return '강전해질은 온도가 오를 때 전도도가 어떻게 변하나요?'; },
    requestReview: async input => { reviews++; return { ...comparisonReview(input, f.turn.rawTranscript!), verdict: 'uncertain' }; },
  });
  assert.equal(cores, 1); assert.equal(repairs, 1); assert.equal(reviews, 2); assert.equal(staticRephrases, 0);
  assert.equal(result.questionRecoveryRequired, true); assert.equal(result.draft, null);
  assert.ok(result.serverGuards?.includes('BOUNDED_SAME_DEMAND_REPAIR_FAILED'));
  assert.ok(result.serverGuards?.includes('QUESTION_REVIEW_PRESERVE_CURRENT_ANSWER'));
  assert.ok(!result.serverGuards?.includes('BOUNDED_MISSING_DEMAND_REPAIR_APPROVED'));
  assert.equal(f.session.turns.length, 1); assert.equal(f.turn.answerId, answerId); assert.equal(f.turn.rawTranscript, transcript);
  assert.deepEqual(f.session.followUpCountByMainQuestion, {});
});

test('a same-answer recovery retry skips the full core and still rejects a failed independent repair review', async () => {
  const f = fixture('자료를 비교했습니다.'); let cores = 0, repairs = 0;
  const result = await runStrategyRealtimeCore(f.context, f.session, { allowFollowUp: true, allowClarification: true, recoveryOnly: true,
    requestStrategy: async () => { cores++; return natural(f.turn.rawTranscript!); },
    requestRepair: async () => { repairs++; return '자료를 비교한 한 단계를 설명해 주세요.'; },
    requestReview: async input => ({ ...review(input), verdict: 'uncertain' }) });
  assert.equal(cores, 0); assert.equal(repairs, 1); assert.equal(result.providerTimings.coreModelCalls, 0);
  assert.equal(result.questionRecoveryRequired, true); assert.equal(result.draft, null);
  assert.equal(f.session.turns.length, 1); assert.equal(f.turn.rawTranscript, '자료를 비교했습니다.');
});

test('a source-bound narrow F retry restores only its saved demand with no core or whole-Q0 recovery call', async () => {
  const f = partialComparisonFixture(); let cores = 0, repairs = 0, reviews = 0, staticRephrases = 0;
  const candidate = f.output.decision.question!;
  f.turn.metadata.coreDecision = { sourceTurnId: f.turn.id, sourceAnswerId: f.turn.answerId,
    fulfillment: f.output.decision.fulfillment, requestedAction: 'FOLLOW_UP', decisionReasonCode: f.output.decision.reason,
    answerRelation: f.output.answerRelation, interpretation: f.output.interpretation,
    candidateQuestion: { ...candidate, action: 'FOLLOW_UP' } };
  const result = await runStrategyRealtimeCore(f.context, f.session, { allowFollowUp: true, allowClarification: true, recoveryOnly: true,
    requestStrategy: async () => { cores++; return f.output; },
    resolveApprovedRecovery: async () => { staticRephrases++; return null; },
    requestRepair: async input => {
      repairs++; assert.equal(input.action, 'FOLLOW_UP'); assert.equal(input.candidate?.text, candidate.text);
      assert.equal(input.candidate?.target, candidate.target); return '강전해질은 온도가 오를 때 전도도가 어떻게 변하나요?';
    },
    requestReview: async input => { reviews++; return comparisonReview(input, f.turn.rawTranscript!); },
  });
  assert.equal(cores, 0); assert.equal(repairs, 1); assert.equal(reviews, 1); assert.equal(staticRephrases, 0);
  assert.equal(result.nextAction, 'FOLLOW_UP'); assert.equal(result.draft?.questionKind, 'follow_up');
  assert.equal(result.draft?.targetEvidence[0], candidate.target); assert.equal(result.questionRecoveryRequired, undefined);
  assert.equal(result.providerTimings.coreModelCalls, 0); assert.equal(result.providerTimings.repairModelCalls, 1);
  assert.equal(result.providerTimings.premiseReviewAttempts, 1);
  assert.ok(result.serverGuards?.includes('SOURCE_BOUND_NARROW_CANDIDATE_RESTORED'));
  assert.ok(result.serverGuards?.includes('BOUNDED_MISSING_DEMAND_REPAIR_APPROVED'));
  assert.equal(f.turn.rawTranscript, '온도가 올라가면 약전해질은 해리도가 커져 전도도가 높아집니다.');
});

test('a narrow retry cannot restore a saved candidate belonging to a different turn or answer', async () => {
  for (const changedSource of ['turn', 'answer'] as const) {
    const f = partialComparisonFixture(); let cores = 0, repairs = 0, reviews = 0, staticRephrases = 0;
    const answerId = f.turn.answerId, transcript = f.turn.rawTranscript;
    f.turn.metadata.coreDecision = { sourceTurnId: changedSource === 'turn' ? 'another-turn' : f.turn.id,
      sourceAnswerId: changedSource === 'answer' ? 'another-answer' : f.turn.answerId,
      fulfillment: f.output.decision.fulfillment, requestedAction: 'FOLLOW_UP', decisionReasonCode: f.output.decision.reason,
      answerRelation: f.output.answerRelation, interpretation: f.output.interpretation,
      candidateQuestion: { ...f.output.decision.question!, action: 'FOLLOW_UP' } };
    const result = await runStrategyRealtimeCore(f.context, f.session, { allowFollowUp: true, allowClarification: true, recoveryOnly: true,
      requestStrategy: async () => { cores++; return f.output; },
      resolveApprovedRecovery: async () => { staticRephrases++; return null; },
      requestRepair: async () => { repairs++; return '강전해질은 온도가 오를 때 전도도가 어떻게 변하나요?'; },
      requestReview: async input => { reviews++; return comparisonReview(input, f.turn.rawTranscript!); },
    });
    assert.equal(cores, 0, changedSource); assert.equal(repairs, 0, changedSource);
    assert.equal(reviews, 0, changedSource); assert.equal(staticRephrases, 0, changedSource);
    assert.equal(result.failureDetail, 'POLICY_RECOVERY_SOURCE_CHANGED', changedSource);
    assert.equal(result.questionRecoveryRequired, true, changedSource); assert.equal(result.draft, null, changedSource);
    assert.ok(!result.serverGuards?.includes('SOURCE_BOUND_NARROW_CANDIDATE_RESTORED'), changedSource);
    assert.equal(f.session.turns.length, 1); assert.equal(f.turn.answerId, answerId); assert.equal(f.turn.rawTranscript, transcript);
  }
});

test('the F cap cannot skip an independently classified same-demand rephrase', async () => {
  const f = fixture('다 같이 비교했습니다.'), output = natural(f.turn.rawTranscript!);
  f.session.followUpCountByMainQuestion = { q0: 2 };
  output.decision.question!.text = '자료를 비교한 한 단계를 설명해 주시겠어요?';
  const result = await runStrategyRealtimeCore(f.context, f.session, { allowFollowUp: false, allowClarification: true,
    requestStrategy: async () => output, requestReview: async input => ({ ...review(input), runtimePurpose: {
      subordinateToCluster: true, hasAdditionalVerificationValue: true, repeatedEstablishedTargetIds: [],
      demandRelation: 'same_whole_demand_rephrase', currentDemandFulfillment: 'partial',
    } }) });
  assert.equal(result.nextAction, 'CLARIFICATION'); assert.equal(result.draft?.questionKind, 'clarification');
  assert.equal(f.session.followUpCountByMainQuestion.q0, 2);
});

test('a generator-only duplicate signal cannot authorize a topic transition without independent review', async () => {
  const f = fixture('자료를 비교했습니다.');
  f.turn.metadata.coreDecision = { sourceTurnId: f.turn.id, sourceAnswerId: f.turn.answerId, fulfillment: 'met' };
  const output = natural(f.turn.rawTranscript!);
  output.decision.question!.matchedEstablishedTargetIds = [ledgerTargetKey(f.turn)];
  let reviews = 0;
  const result = await runStrategyRealtimeCore(f.context, f.session, { allowFollowUp: true, allowClarification: true,
    requestStrategy: async () => output, requestReview: async input => { reviews++; return review(input); } });
  assert.equal(reviews, 0); assert.equal(result.origin, 'fallback');
  assert.equal(result.questionRecoveryRequired, true); assert.equal(result.draft, null);
  assert.ok(!result.serverGuards?.includes('QUESTION_REPEATED_TARGET'));
});
