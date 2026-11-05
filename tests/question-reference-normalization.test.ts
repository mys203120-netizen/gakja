import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBookQuestions } from '../server/data/book-question-reference';
import { materializeQuestionReferenceBatch } from '../server/data/question-reference-analysis';

const questions = extractBookQuestions('```text\n면접 질문\n관찰 자료를 선택한 기준은 무엇인가요?\n```', 'synthetic-reference.md', 'preparation');
function item() { return { questionId: questions[0].id, category: 'direct_example', primaryFunctions: ['CHOICE'], depth: 'D2', strategies: ['choice_basis'], domain: 'general', demands: [{ quote: questions[0].questionText, primaryFunction: 'CHOICE', depth: 'D2' }], dependencies: { passage: false, figure: false, priorAnswer: false, institution: false }, restrictions: [], rationale: '명시된 단일 선택 기준 질문이다.' }; }

test('metadata follows verified demands and retains the original model labels', () => {
  const candidate = { ...item(), primaryFunctions: ['CHOICE', 'EVIDENCE'], depth: 'D3' };
  const result = materializeQuestionReferenceBatch({ items: [candidate] }, questions)[0];
  assert.equal(result.status, 'reviewed');
  if (result.status !== 'reviewed') return;
  assert.deepEqual(result.primaryFunctions, ['CHOICE']); assert.equal(result.depth, 'D2');
  assert.deepEqual(result.normalization?.modelReported.primaryFunctions, ['CHOICE', 'EVIDENCE']);
  assert.equal(result.normalization?.modelReported.depth, 'D3');
  assert.equal(result.demandSpans[0].quote, questions[0].rawText);
});

test('an observed dependency makes usage more restrictive and never promotes an out-of-scope item', () => {
  const candidate = item(); candidate.dependencies.figure = true;
  const result = materializeQuestionReferenceBatch({ items: [candidate] }, questions)[0];
  assert.equal(result.status, 'reviewed');
  if (result.status !== 'reviewed') return;
  assert.equal(result.category, 'contextual_strategy'); assert.ok(result.restrictions.includes('figure_required'));
  const excluded = materializeQuestionReferenceBatch({ items: [{ ...candidate, category: 'out_of_scope' }] }, questions)[0];
  assert.equal(excluded.status === 'reviewed' && excluded.category, 'out_of_scope');
});

test('normalization cannot repair invented source words or hide invalid request cardinality', () => {
  const invalidQuote = item(); invalidQuote.demands[0].quote = '원문에 없는 변인을 직접 조작한 기준';
  assert.equal(materializeQuestionReferenceBatch({ items: [invalidQuote] }, questions)[0].status, 'pending');
  assert.equal(materializeQuestionReferenceBatch({ items: [{ ...item(), category: 'compound_strategy' }] }, questions)[0].status, 'pending');
  assert.equal(materializeQuestionReferenceBatch({ items: [{ ...item(), category: 'direct_example', demands: [] }] }, questions)[0].status, 'pending');
});
