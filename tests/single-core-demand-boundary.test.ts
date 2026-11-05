import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SINGLE_CORE_CONTRACT_VERSION, SINGLE_CORE_DIALOGUE_RENDERING_VERSION, SINGLE_CORE_DIALOGUE_RULE_BLOCKS, SINGLE_CORE_DIALOGUE_RULES, SINGLE_CORE_FUNCTION_GUIDANCE, singleCoreWireSchema, singleCoreCandidateWireSchema } from '../server/providers/single-core-contract';

const labels = JSON.parse(readFileSync(new URL('./fixtures/single-core-demand-boundary-cases.json', import.meta.url), 'utf8')) as {
  policyVersion: string;
  cases: Array<{ id: string; provenance: string; source?: { path: string; sha256: string; turnId: string; answerId: string };
    question: string; rawTranscript: string; rawTranscriptSha256: string;
    expected: { coverage: string[]; actions: string[]; answered: string[]; missing: string[]; followUpScope?: string | null } }>;
  wholeCausalDemandContrasts: { provenance: string; cases: Array<{ id: string; question: string; rawTranscript: string; rawTranscriptSha256: string;
    expected: { coverage: string[]; actions: string[]; answered: string[]; missing: string[]; followUpScope: null } }> };
  finalUtteranceQa: { provenance: string; cases: Array<{ id: string; inputCaseId: string; action: string; coreText: string | null; finalText: string | null;
    surfaceOrigin: string; expectedVerdict: string; failedChecks: string[] }> };
  continuousE2EProposal: { forceActionOrStubModel: boolean; bankPath: string; candidateId: string; rootQuestion: string };
};
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

test('demand-boundary human labels retain exact historical words and distinguish synthetic contrasts', () => {
  assert.equal(new Set(labels.cases.map(row => row.id)).size, labels.cases.length);
  for (const row of labels.cases) {
    assert.equal(hash(row.rawTranscript), row.rawTranscriptSha256, row.id);
    assert.ok(row.expected.actions.length && row.expected.coverage.length, row.id);
    if (!row.source) {
      assert.equal(row.provenance, 'synthetic_human_labeled_contrast_not_a_user_record');
      continue;
    }
    const bytes = readFileSync(row.source.path);
    assert.equal(hash(bytes), row.source.sha256);
    const session = JSON.parse(bytes.toString('utf8')) as { turns: Array<{ id: string; answerId: string; questionText: string; rawTranscript: string }> };
    const turn = session.turns.find(turn => turn.id === row.source!.turnId)!;
    assert.equal(turn.answerId, row.source.answerId);
    assert.equal(turn.questionText, row.question);
    assert.equal(turn.rawTranscript, row.rawTranscript);
  }
});

test('complete, missing-subpoint, whole-demand and corrected-answer gold cases remain separate', () => {
  const byId = new Map(labels.cases.map(row => [row.id, row]));
  for (const id of ['HIST-Q15', 'HIST-Q18', 'CONTRAST-CI-FULL', 'CONTRAST-62-FULL', 'CONTRAST-62-UNAVAILABLE', 'CONTRAST-CORRECTION-FULL']) {
    assert.deepEqual(byId.get(id)!.expected.actions, ['TRANSITION'], id);
  }
  for (const id of ['HIST-Q12', 'CONTRAST-CI-MEANING-REQUEST']) assert.deepEqual(byId.get(id)!.expected.actions, ['CLARIFICATION']);
  assert.ok(byId.get('HIST-Q14')!.expected.followUpScope);
  assert.ok(byId.get('CONTRAST-CI-ONLY-DIRECTION')!.expected.followUpScope);
  assert.notDeepEqual(byId.get('HIST-Q14')!.expected.missing, byId.get('CONTRAST-CI-ONLY-DIRECTION')!.expected.missing);
  assert.ok(!byId.get('CONTRAST-CORRECTION-ONLY')!.expected.actions.includes('FOLLOW_UP'));
  assert.deepEqual(byId.get('CONTRAST-ROLE-NEW-CLAIM')!.expected.coverage, ['met']);
});

test('source-mapped compact prompt addresses demand differences without adding semantic output fields', () => {
  assert.equal(labels.policyVersion, 'source-bound-dialogue-policy-v15', 'Historical human labels remain frozen at their introduced version.');
  assert.equal(SINGLE_CORE_DIALOGUE_RENDERING_VERSION, 'source-bound-dialogue-policy-v18');
  const rule = SINGLE_CORE_DIALOGUE_RULE_BLOCKS.find(rule => rule.id === 'ACTION')!;
  assert.ok(rule.md.includes('MD10:10,11'));
  assert.ok(rule.text.includes('이미 답한 범위와 실제 남은 범위'));
  assert.ok(rule.text.includes("'왜'를 '어떻게'로 바꾸고 깊이를 낮춰도 SAME"));
  assert.ok(rule.text.includes('그 변화 관계만 묻는다'));
  assert.ok(rule.text.includes('met을 유지한 F'));
  assert.ok(SINGLE_CORE_DIALOGUE_RULE_BLOCKS.find(row => row.id === 'RESPONSE')!.text.includes('관련성과 정오는 구별한다'));
  assert.ok(SINGLE_CORE_DIALOGUE_RULES.length < 6100, 'The clarification stays compact rather than appending a second decision protocol.');
  assert.deepEqual(Object.keys(singleCoreWireSchema.shape), ['assessment', 'next', 'reaction']);
});

test('v18 changes only prompt rendering while both exact provider JSON schemas and contract version stay frozen', () => {
  assert.equal(SINGLE_CORE_CONTRACT_VERSION, 'single-core-contract-v7');
  assert.equal(hash(JSON.stringify(z.toJSONSchema(singleCoreWireSchema))), 'a6f7ccd23806f1e413cde19531d9176d8b265920f34aaf1573d25e18ed94fdf0');
  assert.equal(hash(JSON.stringify(z.toJSONSchema(singleCoreCandidateWireSchema))), 'd5637d4e39953fd504bb437316daaf68769b349008b3324e134d324988293a4f');
  assert.ok(SINGLE_CORE_DIALOGUE_RULE_BLOCKS.find(rule => rule.id === 'ACTION')!.text.length <= 1043);
  assert.ok(SINGLE_CORE_DIALOGUE_RULES.length <= 6071, 'Replace duplicate instructions rather than adding a second decision protocol.');
});

test('whole causal WHY-to-HOW contrasts remain separate from Q14 missing-subpoint and full-coverage cases', () => {
  assert.equal(labels.wholeCausalDemandContrasts.provenance, 'synthetic_model_authored_contrast_not_a_user_record_or_human_signoff');
  const [whole, complete] = labels.wholeCausalDemandContrasts.cases;
  for (const row of [whole, complete]) assert.equal(hash(row.rawTranscript), row.rawTranscriptSha256, row.id);
  assert.deepEqual(whole.expected.actions, ['CLARIFICATION', 'TRANSITION']);
  assert.equal(whole.expected.followUpScope, null);
  assert.deepEqual(complete.expected.actions, ['TRANSITION']); assert.deepEqual(complete.expected.coverage, ['met']);
  const q14 = labels.cases.find(row => row.id === 'HIST-Q14')!;
  assert.ok(q14.expected.actions.includes('FOLLOW_UP')); assert.ok(q14.expected.followUpScope);
  assert.notDeepEqual(whole.expected.missing, q14.expected.missing);
  assert.equal(labels.finalUtteranceQa.provenance, 'synthetic_model_authored_qa_not_human_signoff');
  assert.equal(new Set(labels.finalUtteranceQa.cases.map(row => row.id)).size, labels.finalUtteranceQa.cases.length);
  const allInputs = new Set([...labels.cases, ...labels.wholeCausalDemandContrasts.cases].map(row => row.id));
  for (const row of labels.finalUtteranceQa.cases) {
    assert.ok(allInputs.has(row.inputCaseId), row.id);
    assert.equal(row.expectedVerdict === 'fail', row.failedChecks.length > 0, row.id);
    if (row.finalText !== null) assert.ok(row.finalText.length <= (row.action === 'FOLLOW_UP' ? 75 : 80), row.id);
    if (row.surfaceOrigin === 'repair') {
      assert.notEqual(row.finalText, row.coreText); assert.ok(row.failedChecks.includes('repairedMeaningPreserved'));
    }
  }
});

test('v16 keeps brief complete reactions, literal vague expressions and function definitions in the sole prompt', () => {
  const surface = SINGLE_CORE_DIALOGUE_RULE_BLOCKS.find(rule => rule.id === 'SURFACE')!.text;
  const action = SINGLE_CORE_DIALOGUE_RULE_BLOCKS.find(rule => rule.id === 'ACTION')!.text;
  assert.ok(surface.includes('통상20~45자, 최대76자'));
  assert.ok(surface.includes('한도를 채우려 문장을 자르지 않는다'));
  assert.ok(action.includes('학생이 쓴 표현 자체를 짧게 인용'));
  assert.ok(action.includes('모델이 추측한 역할로 바꿔 귀속하지 않는다'));
  assert.ok(SINGLE_CORE_FUNCTION_GUIDANCE.CONNECTION.includes('경험·교과·활동·진로 사이 학습 연계'));
  assert.ok(SINGLE_CORE_FUNCTION_GUIDANCE.CONNECTION.includes('같은 탐구의 원인·변수 관계 아님'));
  const base = { assessment: { coverage: 'met', response: 'answered', reason: '' }, next: { action: 'TRANSITION', question: null }, reaction: { quote: '알겠습니다', text: '가'.repeat(76) } };
  assert.equal(singleCoreWireSchema.safeParse(base).success, true, '20–45 is a soft speech guideline, not a new hard limit.');
  assert.equal(singleCoreWireSchema.safeParse({ ...base, reaction: { ...base.reaction, text: '가'.repeat(77) } }).success, false);
});

test('continuous F proposal names an actual approved bank surface without forcing model actions', () => {
  const proposed = labels.continuousE2EProposal;
  assert.equal(proposed.forceActionOrStubModel, false);
  const bank = JSON.parse(readFileSync(proposed.bankPath, 'utf8')) as { slots: Array<{ candidates: Array<{ id: string; draft: { questionText: string } }> }> };
  const candidate = bank.slots.flatMap(slot => slot.candidates).find(candidate => candidate.id === proposed.candidateId);
  assert.equal(candidate?.draft.questionText, proposed.rootQuestion);
});
