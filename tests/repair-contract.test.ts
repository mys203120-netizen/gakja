import test from 'node:test';
import assert from 'node:assert/strict';
import type { QuestionDraft, InterviewSession } from '../server/protocol';
import { assertRepairProof, createRepairCheck, createRepairContract, RepairContractError, repairContractHash } from '../server/providers/repair-contract';
import { approveQuestionContract, assertQuestionContractIntegrity, createQuestionBlueprint } from '../server/question-objective';
import type { InterviewContext } from '../server/data/load-interview-context';

function draft(): QuestionDraft {
  return { acknowledgement: null, acknowledgementQuote: null, questionText: '실제 비교에 사용한 기준을 말씀해 주세요.',
    questionKind: 'follow_up', parentMainQuestionId: 'q0', evidenceIds: [], evidenceQuotes: [], primaryFunction: 'CHOICE', depth: 'D2',
    questionIntent: '실제로 사용한 비교 기준', targetEvidence: ['실제로 사용한 비교 기준'], groundingRationale: '합성 답변의 비교 기준 확인', validationStatus: 'approved', validationFailures: [],
    premiseValidation: { version: 'question-premise-v1', guidelineVersion: '2.3', status: 'approved', method: 'bounded_fact_review', reviewModel: 'synthetic', questionSha256: '',
      coreIntentCount: 1, coreIntentCountAuthority: 'single_core_single_target_contract', semanticAuthority: 'single_core', supportedPremises: [], openChecks: [] } };
}

test('repair proof binds the original frozen demand, final text and semantic metadata', () => {
  const original = draft(), contract = createRepairContract(original), repaired = { ...original, questionText: '자료 비교의 기준 한 가지만 말씀해 주세요.' };
  assert.ok(Object.isFrozen(contract));
  repaired.premiseValidation = { ...original.premiseValidation!, repairCheck: createRepairCheck(contract, repaired, 'same') };
  assert.doesNotThrow(() => assertRepairProof(repaired, contract, true));
  for (const mutate of [
    (value: QuestionDraft) => { value.questionText = '지원 학과에 관심을 갖게 된 계기는 무엇인가요?'; },
    (value: QuestionDraft) => { value.targetEvidence = ['지원 계기']; },
    (value: QuestionDraft) => { value.primaryFunction = 'MOTIVE'; },
    (value: QuestionDraft) => { value.depth = 'D4'; },
    (value: QuestionDraft) => { value.premiseValidation!.repairCheck!.contractSha256 = '0'.repeat(64); },
    (value: QuestionDraft) => { value.premiseValidation!.repairCheck!.contract = { ...contract, originalText: '다른 요구를 확인하는 원문입니다.' }; },
  ]) {
    const changed = structuredClone(repaired); mutate(changed);
    assert.throws(() => assertRepairProof(changed, contract, true), RepairContractError);
  }
  const differentBaseline = createRepairContract({ ...original, questionText: '비교하지 않은 다른 기준을 말씀해 주세요.' });
  assert.notEqual(repairContractHash(contract), repairContractHash(differentBaseline));
  assert.throws(() => assertRepairProof(repaired, differentBaseline, true), RepairContractError);
});

test('a cached repaired draft cannot omit its proof while unrepaired historical drafts retain their shape', () => {
  const ordinary = draft(), before = structuredClone(ordinary);
  assert.doesNotThrow(() => assertRepairProof(ordinary));
  assert.deepEqual(ordinary, before);
  assert.throws(() => assertRepairProof(ordinary, undefined, true), RepairContractError);
  assert.throws(() => assertRepairProof(ordinary, createRepairContract(ordinary)), RepairContractError);
});

test('meaning changed or uncertain cannot produce an approval proof', () => {
  const value = draft(), contract = createRepairContract(value);
  assert.throws(() => createRepairCheck(contract, value, 'changed'), /REPAIR_MEANING_CHANGED/);
  assert.throws(() => createRepairCheck(contract, value, 'uncertain'), /REPAIR_MEANING_UNCERTAIN/);
});

test('question-contract approval requires the expected repair proof and seals the proof hash', () => {
  const original = draft(), contract = createRepairContract(original), value = structuredClone(original);
  value.premiseValidation!.questionSha256 = createRepairCheck(contract, value, 'same').candidateQuestionSha256;
  const rawTranscript = '작성 시점을 비교했습니다.';
  const session = { id: 'synthetic', turns: [{ id: 'q0', answerId: 'a0', transcriptStatus: 'finalized', rawTranscript, parentMainQuestionId: 'q0', questionKind: 'main', metadata: { questionIntent: '자료 비교 확인' } }] } as unknown as InterviewSession;
  const context = { student: { evidence: [] }, school: { sources: [] } } as unknown as InterviewContext;
  const blueprint = createQuestionBlueprint(value, context, session, { subordinationRationale: '실제 비교 답변에 종속됨', answerRefs: [{ turnId: 'q0', answerId: 'a0', start: 0, end: rawTranscript.length }] });
  assert.throws(() => approveQuestionContract(value, blueprint, { repairContract: contract }), RepairContractError);
  value.premiseValidation!.repairCheck = createRepairCheck(contract, value, 'same');
  const approved = approveQuestionContract(value, blueprint, { repairContract: contract });
  assert.doesNotThrow(() => assertQuestionContractIntegrity(value, approved));
  const changed = structuredClone(value);
  changed.premiseValidation!.repairCheck!.contractSha256 = 'f'.repeat(64);
  assert.throws(() => assertQuestionContractIntegrity(changed, approved), RepairContractError);
});
