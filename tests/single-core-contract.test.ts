import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSingleCoreDecision, encodeSingleCoreDecision, singleCoreWireSchema, SINGLE_CORE_FUNCTION_GUIDANCE, SINGLE_CORE_DIALOGUE_RULE_BLOCKS, type SingleCoreWireOutput, type SingleCoreOutput } from '../server/providers/single-core-contract';
import { primaryFunctions } from '../server/protocol';

const assessment = { coverage: 'partial', response: 'answered', reason: '선택한 기준은 설명했지만 그 기준의 근거는 아직 설명하지 않았다.' } as const;
const followUp = {
  action: 'ASK_NEW_SUBPOINT',
  question: { text: '그 기준을 정한 근거는 무엇이었나요?', target: '실제 선택 기준의 근거', primaryFunction: 'EVIDENCE', depth: 'D2', strategyId: null },
} as const;
const clarification = { action: 'ASK_SAME_REQUIREMENT', question: { text: '그 활동에서 본인이 직접 한 일을 말씀해 주세요.' } } as const;
const parse = (next: unknown, override: unknown = assessment) => singleCoreWireSchema.parse({ assessment: override, next, reaction: null });

test('every function enum has one source-mapped meaning and comparison depth is distinct from basic concept explanation',()=>{
  assert.deepEqual(Object.keys(SINGLE_CORE_FUNCTION_GUIDANCE),[...primaryFunctions]);
  const block=SINGLE_CORE_DIALOGUE_RULE_BLOCKS.find(rule=>rule.id==='FUNCTION_DEPTH')!;
  assert.ok(block.md.includes('MD9:7,9,10,22'));
  for(const code of primaryFunctions)assert.equal(block.text.split(`${code}=`).length-1,1);
  assert.ok(SINGLE_CORE_FUNCTION_GUIDANCE.TRANSFER.includes('비교'));
  assert.ok(block.text.includes('D3=개념 적용·비교'));
  assert.ok(block.text.includes('최종 질문 문장을 쓴 뒤'));
});

test('wire demand relation maps literally to stored kind without examining question or answer text', () => {
  const same = parse(clarification);
  const probe = parse(followUp);
  assert.equal(decodeSingleCoreDecision(same).next.action, 'CLARIFICATION');
  assert.equal(decodeSingleCoreDecision(probe).next.action, 'FOLLOW_UP');
  for (const wire of [same, probe, parse({ action: 'REPLAY', question: null })]) {
    assert.deepEqual(encodeSingleCoreDecision(decodeSingleCoreDecision(wire)), wire);
  }
  const canonical: SingleCoreOutput = decodeSingleCoreDecision(same);
  assert.equal(singleCoreWireSchema.safeParse(canonical).success, false, 'obsolete model labels cannot silently pass the v3 wire');
  assert.equal(decodeSingleCoreDecision({ ...probe, next: { ...probe.next, question: { ...followUp.question, text: clarification.question.text } } }).next.action, 'FOLLOW_UP', 'the codec must not reclassify text');
});

test('single-core wire supports every action with only its required question contract', () => {
  const decisions: SingleCoreWireOutput['next'][] = [followUp, clarification, { action: 'REPLAY', question: null }, { action: 'TRANSITION', question: null }, { action: 'CLOSING', question: null }];
  for (const next of decisions) assert.deepEqual(parse(next).next, next);
});

test('action discriminant rejects absent evaluation/rephrase questions and invented questions on non-question actions', () => {
  for (const action of ['ASK_NEW_SUBPOINT', 'ASK_SAME_REQUIREMENT']) assert.throws(() => parse({ action, question: null }));
  for (const action of ['REPLAY', 'TRANSITION', 'CLOSING']) assert.throws(() => parse({ action, question: clarification.question }));
  assert.throws(() => parse({ action: 'PROBE', question: null }));
});

test('follow-up and clarification have independent 75 and 80 character speech budgets', () => {
  assert.equal(parse({ ...followUp, question: { ...followUp.question, text: '가'.repeat(75) } }).next.action, 'ASK_NEW_SUBPOINT');
  assert.throws(() => parse({ ...followUp, question: { ...followUp.question, text: '가'.repeat(76) } }));
  assert.equal(parse({ ...clarification, question: { text: '가'.repeat(80) } }).next.action, 'ASK_SAME_REQUIREMENT');
  assert.throws(() => parse({ ...clarification, question: { text: '가'.repeat(81) } }));
  assert.throws(() => parse({ ...followUp, question: { ...followUp.question, text: '가'.repeat(7) } }));
});

test('generation grammar rejects multiple question terminators before factual review without classifying meaning', () => {
  for (const text of ['직접 맡으신 일이 있나요? 있다면 무엇인가요?', '어떤 기준인가요？ 이유가 무엇인가요？']) {
    assert.throws(() => parse({ ...clarification, question: { text } }));
  }
  for (const text of ['직접 맡으신 일이 있다면 무엇인지 말씀해 주세요.', '선택하신 기준은 무엇인가요?']) {
    assert.equal(parse({ ...clarification, question: { text } }).next.action, 'ASK_SAME_REQUIREMENT');
  }
});

test('strict wire rejects redundant interpretation, proof and semantic bookkeeping fields', () => {
  const valid = { assessment, next: followUp, reaction: null };
  for (const key of ['answerRelation', 'interpretation', 'decision', 'coverageProof', 'demandRelation', 'demandStructure']) {
    assert.equal(singleCoreWireSchema.safeParse({ ...valid, [key]: {} }).success, false, key);
  }
  assert.equal(singleCoreWireSchema.safeParse({ ...valid, assessment: { ...assessment, necessity: '중복 설명' } }).success, false);
  assert.equal(singleCoreWireSchema.safeParse({ ...valid, next: { ...followUp, question: { ...followUp.question, matchedEstablishedTargetIds: [] } } }).success, false);
  assert.equal(singleCoreWireSchema.safeParse({ ...valid, next: { ...clarification, question: { ...clarification.question, target: '새로운 하위 과제' } } }).success, false);
});

test('partial answer with unavailable remainder preserves partial coverage while permitting transition', () => {
  const result = parse({ action: 'TRANSITION', question: null }, { coverage: 'partial', response: 'unavailable', reason: '변수는 설명했으며 나머지 측정값은 기억하지 못한다고 말했다.' });
  assert.equal(result.assessment.coverage, 'partial');
  assert.equal(result.assessment.response, 'unavailable');
  assert.equal(result.next.action, 'TRANSITION');
});

test('coverage and action stay independent for useful verification and for unnecessary repeated probes', () => {
  const fulfilledProbe = parse(followUp, { coverage: 'met', response: 'answered', reason: '현재 요구를 충족했고 같은 묶음의 새 주장에 확인 가치가 있다.' });
  assert.equal(fulfilledProbe.assessment.coverage, 'met');
  assert.equal(fulfilledProbe.next.action, 'ASK_NEW_SUBPOINT');
  const partialTransition = parse({ action: 'TRANSITION', question: null });
  assert.equal(partialTransition.assessment.coverage, 'partial');
  assert.equal(partialTransition.next.action, 'TRANSITION');
});

test('same-demand clarification and audio replay do not require follow-up metadata', () => {
  assert.equal(parse(clarification, { coverage: 'unknown', response: 'unclear', reason: '본인이 직접 한 일을 다시 쉽게 물어야 한다.' }).next.action, 'ASK_SAME_REQUIREMENT');
  assert.equal(parse({ action: 'REPLAY', question: null }, { coverage: 'unknown', response: 'answered', reason: '질문 음성을 다시 재생해 달라는 요청이다.' }).next.question, null);
});

test('question classification and short optional reaction remain bounded without model-generated identifiers', () => {
  for (const change of [{ primaryFunction: 'NEW_FUNCTION' }, { depth: 'D5' }, { target: '가나' }]) {
    assert.throws(() => parse({ ...followUp, question: { ...followUp.question, ...change } }));
  }
  const result = singleCoreWireSchema.parse({ assessment, next: followUp, reaction: { quote: '자료를 비교했습니다', text: '비교한 자료에 관해 여쭙겠습니다.' } });
  assert.equal(result.reaction?.quote, '자료를 비교했습니다');
  assert.equal(singleCoreWireSchema.safeParse({ ...result, reaction: { quote: '가'.repeat(29), text: '' } }).success, false);
  assert.equal(singleCoreWireSchema.safeParse({ ...result, reaction: { quote: '가', text: '' } }).success, false);
  assert.equal(singleCoreWireSchema.safeParse({ ...result, reaction: { quote: '자료', text: '가'.repeat(77) } }).success, false);
  assert.equal(singleCoreWireSchema.safeParse({ ...result, assessment: { ...assessment, reason: '가'.repeat(181) } }).success, false);
});
