import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { zodTextFormat } from 'openai/helpers/zod';
import type { InterviewContext, StudentEvidence } from '../server/data/load-interview-context';
import type { InterviewSession, QuestionDraft, RecordedTurn } from '../server/protocol';
import { approveRuntimeQuestionFacts, runtimeFactReviewSchema, repairedFactReviewSchema, runtimeFactReviewInstructions, repairedFactReviewInstructions, runtimeFactReviewBudget, type RuntimeFactReviewInput, type RuntimeFactReviewTrace } from '../server/providers/runtime-fact-review';
import { createRepairContract, RepairContractError, repairContractHash } from '../server/providers/repair-contract';
import { QuestionPremiseReviewError } from '../server/providers/question-premises';
import { QuestionValidationError } from '../server/providers/question-grounding';
import { approveQuestionContract, assertQuestionContractIntegrity, createQuestionBlueprint } from '../server/question-objective';
import { attachVerifiedQuestionPlan } from '../server/providers/question-plan';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
test('the provider grammar requires the same nonempty premise coverage as the server finalizer', () => {
  assert.equal(runtimeFactReviewSchema.safeParse({ verdict: 'allowed', completeAssertionCoverage: true, premises: [] }).success, false);
  assert.equal(runtimeFactReviewSchema.safeParse({ verdict: 'allowed', completeAssertionCoverage: true, premises: [{ questionSpan: '무엇인가요?', basis: 'open_check', proofId: null, supported: true }] }).success, true);
});
function fixture() {
  const text = '자료를 비교하여 질량을 30mg으로 기록함. 팀과 탐구를 진행함.';
  const source: StudentEvidence = { id: 'E01', activityId: 'A01', text, grade: 2, page: 1, title: '합성 탐구', section: '세특',
    confirmationStatus: 'confirmed_from_record', preparationPriority: null, scientificTruthVerification: 'not_independently_verified',
    sourceRef: { file: 'synthetic.pdf', pdfSha256: 'a'.repeat(64), page: 1, extraction: 'synthetic', startOffset: 0, endOffset: text.length } };
  const draft: QuestionDraft = { acknowledgement: null, acknowledgementQuote: null, questionText: '자료를 비교할 때 어떤 기준을 썼나요?', questionKind: 'follow_up', parentMainQuestionId: 'q0',
    evidenceIds: [source.id], evidenceQuotes: [{ evidenceId: source.id, quote: source.text }], primaryFunction: 'CHOICE', questionIntent: '실제로 사용한 자료 비교 기준 확인', targetEvidence: ['실제 비교 기준'], depth: 'D2', groundingRationale: '직전 실제 비교 진술에 연결한다.', validationStatus: 'approved', validationFailures: [] };
  const turn = { id: 'q0', answerId: 'a0', parentMainQuestionId: 'q0', questionText: '이전 질문은 현재 검수에 주입하지 않는 문장입니다.', questionKind: 'main', evidenceIds: ['E01'],
    rawTranscript: '자료를 비교했습니다. 조건과 원자료는 기억나지 않습니다.', transcriptStatus: 'finalized', followUpIndex: 0,
    metadata: { ...draft, questionKind: 'main', questionIntent: '이전 질문 의도 식별자', targetEvidence: ['이전 요구 식별자'], rulesVersion: 'synthetic' } } as unknown as RecordedTurn;
  const context = { student: { evidence: [source] }, school: { sources: [] } } as unknown as InterviewContext;
  const session = { id: 'fact-review-fixture', turns: [turn], followUpCountByMainQuestion: {}, elapsedMs: 0 } as unknown as InterviewSession;
  return { source, draft, turn, context, session };
}
const open = (input: RuntimeFactReviewInput) => ({ verdict: 'allowed', completeAssertionCoverage: true,
  premises: [{ questionSpan: input.question.questionText, basis: 'open_check', proofId: null, supported: true }] });
function expectCode(expected: string) { return (error: unknown) => error instanceof QuestionValidationError && error.code === expected; }

test('fact review wire contains only factual verdict, coverage and proof bindings', () => {
  const basic = { verdict: 'allowed', completeAssertionCoverage: true, premises: [{ questionSpan: '어떤 기준을 썼나요?', basis: 'open_check', proofId: null, supported: true }] };
  assert.deepEqual(Object.keys(runtimeFactReviewSchema.parse(basic)), ['verdict', 'completeAssertionCoverage', 'premises']);
  for (const extra of ['runtimePurpose', 'intentMatches', 'coreIntentCount', 'fulfillment', 'demandRelation', 'clarificationPreservesIntent', 'demandMatch']) {
    assert.equal(runtimeFactReviewSchema.safeParse({ ...basic, [extra]: true }).success, false, extra);
  }
});

test('review projection excludes original question, ledger and all core intent metadata while retaining exact proof offsets', async () => {
  const f = fixture(); let observed = false;
  const approved = await approveRuntimeQuestionFacts(f.context, f.session, f.draft, { requestReview: async input => {
    observed = true;
    assert.deepEqual(Object.keys(input.question), ['questionText']);
    for (const forbidden of ['originalQuestion', 'questionIntent', 'targetEvidence', 'primaryFunction', 'depth', 'fulfillment', 'interpretation', 'runtimePurpose']) assert.ok(!JSON.stringify(input).includes(forbidden), forbidden);
    assert.ok(!JSON.stringify(input).includes(f.turn.questionText));
    assert.equal(input.answer?.text, f.turn.rawTranscript);
    const texts = new Map([...input.sources, input.answer!, ...input.answerSources].map(source => [source.id, source.text]));
    for (const proof of input.proofChoices) {
      assert.ok(texts.get(proof.sourceId)!.slice(proof.startOffset, proof.endOffset).trim());
      assert.ok(!('supportQuote' in proof));
    }
    return open(input);
  } });
  assert.equal(observed, true); assert.equal(approved.questionKind, f.draft.questionKind);
  assert.equal(approved.premiseValidation?.method, 'bounded_fact_review');
  assert.equal(approved.premiseValidation?.semanticAuthority, 'single_core');
  assert.equal(approved.premiseValidation?.coreIntentCountAuthority, 'single_core_single_target_contract');
  assert.equal(approved.approvedQuestion, undefined); assert.equal(approved.questionBlueprint, undefined);
  assert.equal(f.draft.premiseValidation, undefined, 'approval is returned, not attached to the caller draft');
});

test('record proofs bind to immutable raw offsets and preserve exact numbers and units', async () => {
  const f = fixture(); f.source.text = '질량을 30mg으로\n기록함.'; f.draft.evidenceQuotes[0].quote = f.source.text;
  f.draft.questionText = '질량을 30mg으로 기록한 방법은 무엇인가요?';
  const approved = await approveRuntimeQuestionFacts(f.context, f.session, f.draft, { requestReview: async input => ({
    verdict: 'allowed', completeAssertionCoverage: true, premises: [{ questionSpan: '질량을 30mg으로 기록', basis: 'record', supported: true,
      proofId: input.proofChoices.find(proof => proof.sourceId === f.source.id)!.proofId }],
  }) });
  const proof = approved.premiseValidation!.supportedPremises[0];
  assert.equal(f.source.text.slice(proof.sourceStartOffset, proof.sourceEndOffset), f.source.text);
  for (const value of ['31mg', '30%', '30kg']) {
    f.draft.questionText = `질량을 ${value}으로 기록한 방법은 무엇인가요?`;
    await assert.rejects(approveRuntimeQuestionFacts(f.context, f.session, f.draft, { requestReview: async input => ({ verdict: 'allowed', completeAssertionCoverage: true,
      premises: [{ questionSpan: `질량을 ${value}으로 기록`, basis: 'record', supported: true, proofId: input.proofChoices.find(proof => proof.sourceId === f.source.id)!.proofId }] }) }), expectCode('PREMISE_UNSUPPORTED'));
  }
});

test('current and prior answers remain separately source-bound for factual attribution', async () => {
  const f = fixture();
  f.session.turns.unshift({ ...f.turn, id: 'prior', answerId: 'a-prior', rawTranscript: '혼자 비교했습니다.' });
  f.turn.rawTranscript = '함께 비교했습니다.';
  f.draft.questionText = '혼자 비교했다는 말과 함께 비교했다는 말은 각각 어느 범위인가요?';
  const approved = await approveRuntimeQuestionFacts(f.context, f.session, f.draft, { requestReview: async input => ({ verdict: 'allowed', completeAssertionCoverage: true,
    premises: [{ questionSpan: '혼자 비교했다는 말', basis: 'answer_turn_attributed', supported: true, proofId: input.proofChoices.find(proof => proof.sourceId === 'ANSWER_TURN:prior:a-prior')!.proofId },
      { questionSpan: '함께 비교했다는 말', basis: 'answer_turn_attributed', supported: true, proofId: input.proofChoices.find(proof => proof.sourceId === 'ANSWER_TURN:q0:a0')!.proofId }] }) });
  assert.deepEqual(approved.premiseValidation!.supportedPremises.map(proof => proof.sourceId), ['ANSWER_TURN:prior:a-prior', 'ANSWER_TURN:q0:a0']);
});

test('clarification can bind an actual answer proof without receiving original demand or classifying its relation', async () => {
  const f = fixture(); f.draft.questionKind = 'clarification';
  f.draft.questionText = '자료를 비교했다고 하셨는데 어떤 기준을 썼나요?';
  const approved = await approveRuntimeQuestionFacts(f.context, f.session, f.draft, { requestReview: async input => {
    assert.ok(!('originalQuestion' in input));
    return { verdict: 'allowed', completeAssertionCoverage: true, premises: [{ questionSpan: '자료를 비교했다고 하셨는데', basis: 'answer_turn_attributed', supported: true,
      proofId: input.proofChoices.find(proof => proof.sourceId === input.answer!.id)!.proofId }] };
  } });
  assert.equal(approved.questionKind, 'clarification'); assert.equal(approved.premiseValidation?.method, 'bounded_fact_review');
});

test('unknown proof IDs, basis swaps, absent spans and sourced open checks fail mechanical binding', async () => {
  for (const failure of ['unknown', 'basis', 'span', 'open', 'empty'] as const) {
    const f = fixture();
    await assert.rejects(approveRuntimeQuestionFacts(f.context, f.session, f.draft, { requestReview: async input => ({ verdict: 'allowed', completeAssertionCoverage: true,
      premises: failure === 'empty' ? [] : [{ questionSpan: failure === 'span' ? '실제로 없는 문장' : input.question.questionText,
        basis: failure === 'basis' ? 'answer_turn_attributed' : failure === 'open' ? 'open_check' : 'record', supported: true,
        proofId: failure === 'unknown' ? 'P99999' : input.proofChoices.find(proof => proof.basis === 'record')!.proofId }] }) }), QuestionValidationError);
  }
});

test('factual rewrite, uncertainty, uncovered premises and false support remain rejected', async () => {
  for (const failure of ['rewrite', 'uncertain', 'coverage', 'support'] as const) {
    const f = fixture();
    await assert.rejects(approveRuntimeQuestionFacts(f.context, f.session, f.draft, { requestReview: async input => ({ ...open(input),
      verdict: failure === 'rewrite' || failure === 'uncertain' ? failure : 'allowed', completeAssertionCoverage: failure !== 'coverage',
      premises: [{ ...open(input).premises[0], supported: failure !== 'support' }] }) }), QuestionValidationError);
  }
});

test('cheap length, question-mark count and existing MD tone prohibitions run before review', async () => {
  for (const questionText of ['가'.repeat(76), '어떤 기준인가요? 왜인가요?', '말씀하신 부분을 확인해보겠습니다.']) {
    const f = fixture(); f.draft.questionText = questionText; let calls = 0;
    await assert.rejects(approveRuntimeQuestionFacts(f.context, f.session, f.draft, { requestReview: async input => { calls++; return open(input); } }), QuestionValidationError);
    assert.equal(calls, 0);
  }
});

test('a fact review never forges independent semantic approval in the final immutable contract', async () => {
  const f = fixture();
  const approved = await approveRuntimeQuestionFacts(f.context, f.session, f.draft, { requestReview: async input => open(input) });
  const blueprint = createQuestionBlueprint(approved, f.context, f.session, { subordinationRationale: '코어가 선택한 현재 답변의 종속 요구',
    answerRefs: [{ turnId: f.turn.id, answerId: f.turn.answerId!, start: 0, end: f.turn.rawTranscript!.length }] });
  const contract = approveQuestionContract(approved, blueprint);
  assert.deepEqual(contract.validation, { method: 'independent_fact_review', independentSemanticReview: false, independentPremiseReview: true, semanticAuthority: 'single_core', residualSemanticRisk: true });
  assertQuestionContractIntegrity(approved, contract);
  const changed = { ...approved, premiseValidation: { ...approved.premiseValidation!, semanticAuthority: undefined } };
  assert.throws(() => approveQuestionContract(changed, blueprint), /QUESTION_CONTRACT_REVIEW_INVALID/u);
  assert.throws(() => assertQuestionContractIntegrity({ ...approved, questionText: approved.questionText + '다' }, contract), /MUTATED/u);
});

test('legacy semantic contracts retain their historical validation shape and hashes', () => {
  const f = fixture(); const draft = { ...f.draft, questionKind: 'main' as const, parentMainQuestionId: null };
  draft.premiseValidation = { version: 'question-premise-v1', guidelineVersion: '2.3', status: 'approved', method: 'bounded_semantic_review', reviewModel: 'synthetic', questionSha256: hash(draft.questionText), coreIntentCount: 1, supportedPremises: [], openChecks: [] };
  const blueprint = createQuestionBlueprint(draft, f.context, { ...f.session, turns: [] });
  const contract = approveQuestionContract(draft, blueprint);
  assert.deepEqual(contract.validation, { method: 'independent_semantic_review', independentSemanticReview: true, residualSemanticRisk: false });
  const { contentSha256, ...body } = contract;
  assert.equal(contentSha256, hash(JSON.stringify(body))); assertQuestionContractIntegrity(draft, contract);
});

test('a reviewed single-core purpose bypasses purpose-word matching while preserving structural slot bindings', async () => {
  const f = fixture(); f.draft.questionKind = 'main'; f.draft.parentMainQuestionId = null;
  f.draft.primaryFunction = 'EVIDENCE'; f.draft.questionText = '선택지를 좁힐 때 무엇을 남겼나요?';
  f.session.turns = [];
  f.session.plan = { policyVersion: 'synthetic', durationSeconds: 600, mainQuestionTarget: 1, limitations: [], slots: [{ id: 'slot-1', index: 1,
    topicArea: 'problem_solving', label: '합성 선택', evidenceIds: ['E01'], activityIds: ['A01'], primaryFunction: 'EVIDENCE', questionIntent: f.draft.questionIntent, depth: 'D2', interviewerId: 'interviewer-1', interviewerRole: 'academic', schoolConnections: [] }] };
  assert.throws(() => attachVerifiedQuestionPlan(structuredClone(f.draft), f.session), expectCode('PLAN_MISMATCH'));
  const approved = await approveRuntimeQuestionFacts(f.context, f.session, f.draft, { requestReview: async input => open(input) });
  assert.doesNotThrow(() => attachVerifiedQuestionPlan(approved, f.session));
  assert.equal(approved.planSlotId, 'slot-1');
  assert.throws(() => attachVerifiedQuestionPlan({ ...approved, evidenceIds: ['not-in-slot'] }, f.session), expectCode('PLAN_MISMATCH'));
});

test('private trace retains proof hashes and offsets without source or answer bodies and cannot alter approval', async () => {
  const f = fixture(); let trace: RuntimeFactReviewTrace | undefined;
  const approved = await approveRuntimeQuestionFacts(f.context, f.session, f.draft, { requestReview: async input => ({ verdict: 'allowed', completeAssertionCoverage: true,
    premises: [{ questionSpan: '자료를 비교', basis: 'record', supported: true, proofId: input.proofChoices[0].proofId }] }),
    onReviewTrace: value => { trace = value; throw new Error('private consumer failed'); } });
  assert.equal(approved.premiseValidation?.status, 'approved'); assert.equal(trace?.accepted, true);
  assert.match(trace?.premises[0].sourceQuoteSha256 ?? '', /^[a-f0-9]{64}$/u);
  assert.ok(!JSON.stringify(trace).includes(f.source.text)); assert.ok(!JSON.stringify(trace).includes(f.turn.rawTranscript!));
});

test('unfinalized or mismatched answer identity is rejected before a factual model call', async () => {
  for (const mismatch of ['status', 'cluster']) {
    const f = fixture(); let calls = 0;
    if (mismatch === 'status') f.turn.transcriptStatus = 'streaming'; else f.draft.parentMainQuestionId = 'another-root';
    await assert.rejects(approveRuntimeQuestionFacts(f.context, f.session, f.draft, { requestReview: async input => { calls++; return open(input); } }), QuestionPremiseReviewError);
    assert.equal(calls, 0);
  }
});

test('ordinary review instructions, output format and budgets remain byte-identical to the pre-repair-gate baseline', () => {
  assert.equal(hash(runtimeFactReviewInstructions), '1fb2765b33301dc5d40427d755d3129a768a2f648caae65ce000230cf169bb27');
  assert.equal(hash(JSON.stringify(zodTextFormat(runtimeFactReviewSchema, 'runtime_fact_review'))), 'cbbb5e878c69093d15314f99f2902963e35134391f7e29c332026ce4f635e9e4');
  assert.deepEqual(runtimeFactReviewBudget, { timeoutMs: 12000, maxOutputTokens: 500, maxInputCharacters: 22000 });
});

test('only repaired review requires demand equivalence and binds it to the frozen original contract', async () => {
  const f = fixture(), reference = createRepairContract(f.draft);
  f.draft.questionText = '자료 비교에 사용한 기준 한 가지만 말씀해 주세요.';
  let calls = 0;
  const approved = await approveRuntimeQuestionFacts(f.context, f.session, f.draft, { repairContract: reference,
    requestReview: async input => {
      calls++; assert.ok(Object.isFrozen(input.repairContract));
      assert.equal(input.repairContract?.originalText, reference.originalText);
      assert.deepEqual(Object.keys(input.repairContract!).sort(), ['version', 'originalText', 'target', 'primaryFunction', 'depth', 'action'].sort());
      return { ...open(input), demandMatch: 'same' };
    },
  });
  assert.equal(calls, 1);
  assert.equal(approved.premiseValidation?.repairCheck?.contractSha256, repairContractHash(reference));
  assert.equal(approved.premiseValidation?.repairCheck?.candidateQuestionSha256, hash(f.draft.questionText));
  assert.equal(approved.premiseValidation?.repairCheck?.verdict, 'same');
  assert.equal(f.draft.premiseValidation, undefined);
  const basic = open({ question: { questionText: f.draft.questionText } } as RuntimeFactReviewInput);
  assert.equal(repairedFactReviewSchema.safeParse(basic).success, false);
  assert.equal(repairedFactReviewSchema.safeParse({ ...basic, demandMatch: 'same' }).success, true);
});

test('factually allowed repaired text still fails if demand changes or is uncertain, with one existing review call', async () => {
  for (const demandMatch of ['changed', 'uncertain'] as const) {
    const f = fixture(), repairContract = createRepairContract(f.draft); let calls = 0, trace: RuntimeFactReviewTrace | undefined;
    f.draft.questionText = '지원 학과에 관심을 갖게 된 계기는 무엇인가요?';
    await assert.rejects(approveRuntimeQuestionFacts(f.context, f.session, f.draft, { repairContract,
      requestReview: async input => { calls++; return { ...open(input), demandMatch }; }, onReviewTrace: value => { trace = value; },
    }), RepairContractError);
    assert.equal(calls, 1); assert.equal(trace?.accepted, false); assert.equal(trace?.repairCheck?.demandMatch, demandMatch);
    assert.equal(f.draft.premiseValidation, undefined);
  }
});

test('repaired review distinguishes an explanation from bare yes-no existence without relaxing factual approval', async () => {
  const originalText = '최신 자료가 더 정확하다고 판단한 근거는 무엇인가요?';
  for (const [questionText, demandMatch] of [
    ['최신 자료가 더 정확하다고 판단한 근거가 있나요?', 'changed'],
    ['최신 자료가 더 정확하다고 판단한 근거가 있다면 무엇인가요?', 'same'],
  ] as const) {
    const f = fixture();
    Object.assign(f.draft, { questionText: originalText, primaryFunction: 'EVIDENCE', depth: 'D2', questionIntent: '실제 판단의 근거 설명', targetEvidence: ['최신 자료가 더 정확하다고 판단한 근거 설명'] });
    f.turn.rawTranscript = '최신 자료가 더 정확하다고 판단했습니다.';
    const repairContract = createRepairContract(f.draft); f.draft.questionText = questionText;
    let calls = 0;
    const run = () => approveRuntimeQuestionFacts(f.context, f.session, f.draft, { repairContract,
      requestReview: async input => {
        calls++; assert.equal(input.repairContract?.originalText, originalText);
        assert.equal(input.repairContract?.primaryFunction, 'EVIDENCE');
        return { ...open(input), demandMatch };
      },
    });
    if (demandMatch === 'changed') await assert.rejects(run(), /REPAIR_MEANING_CHANGED/);
    else assert.equal((await run()).premiseValidation?.repairCheck?.verdict, 'same');
    assert.equal(calls, 1);
  }
  assert.ok(repairedFactReviewInstructions.length < runtimeFactReviewInstructions.length);
  assert.ok(repairedFactReviewInstructions.includes('인지 행위'));
  assert.ok(!repairedFactReviewInstructions.includes('검수 대상은 question.questionText의 사실 전제뿐이다.'));
});
