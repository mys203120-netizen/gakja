import test from 'node:test';
import assert from 'node:assert/strict';
import { bookQuestionReferenceUsage, selectBookQuestionExamples } from '../server/data/book-question-reference';
import { syntheticReferenceCorpus, syntheticReferenceQuestion } from './fixtures/book-references';

test('all one hundred reviewed source questions are searchable without a manually enumerated sixty-question ceiling', () => {
  const entries = Array.from({ length: 100 }, (_, index) => {
    const topic = `과학표본${String.fromCharCode(0xac00 + index)}탐구`;
    return { topic, question: syntheticReferenceQuestion(`${topic}에서 조건을 선택한 기준은 무엇인가요?`, { sourcePath: `synthetic-source-${index}.md`, primaryFunctions: ['CHOICE'] }) };
  });
  const corpus = syntheticReferenceCorpus(entries.map(entry => entry.question));
  assert.equal(corpus.analysis?.coverage.reviewed, 100);
  const reached = new Set<string>();
  for (const entry of entries) {
    const [selected] = selectBookQuestionExamples(corpus, { primaryFunction: 'CHOICE', topicText: entry.topic, limit: 1 });
    assert.equal(selected?.id, entry.question.id);
    reached.add(selected.id);
  }
  assert.equal(reached.size, 100);
  assert.equal(selectBookQuestionExamples(corpus, { primaryFunction: 'CHOICE' }).length, 3);
  assert.ok(selectBookQuestionExamples(corpus, { primaryFunction: 'CHOICE', limit: 100 }).length <= 8);
});

test('functional match is required and the closest requested depth is ranked ahead of other depths', () => {
  const questions = (['D1', 'D2', 'D4'] as const).map(depth => syntheticReferenceQuestion('관찰 자료의 판단 근거를 설명해 주세요.', { primaryFunctions: ['EVIDENCE'], depth, sourcePath: `synthetic-${depth}.md` }));
  questions.push(syntheticReferenceQuestion('관찰 자료를 선택한 기준은 무엇인가요?', { primaryFunctions: ['CHOICE'], sourcePath: 'synthetic-choice.md' }));
  const corpus = syntheticReferenceCorpus(questions);
  for (const depth of ['D1', 'D2', 'D4']) {
    const [selected] = selectBookQuestionExamples(corpus, { primaryFunction: 'EVIDENCE', depth, limit: 1 });
    assert.equal(selected?.depth, depth);
    assert.deepEqual(selected?.primaryFunctions, ['EVIDENCE']);
  }
  assert.deepEqual(selectBookQuestionExamples(corpus, { primaryFunction: 'ROLE' }), []);
});

test('equal relevance uses stable seeded variation and excludes recent source IDs or duplicate wording', () => {
  const questions = Array.from({ length: 24 }, (_, index) => syntheticReferenceQuestion(`자료${String.fromCharCode(0xac00 + index)}에서 조건을 선택한 기준은 무엇인가요?`, { sourcePath: `synthetic-seed-${index}.md`, primaryFunctions: ['CHOICE'] }));
  const corpus = syntheticReferenceCorpus(questions), seen = new Set<string>();
  for (let index = 0; index < 100; index++) {
    const input = { primaryFunction: 'CHOICE', seed: `synthetic-answer:${index}`, limit: 1 };
    const first = selectBookQuestionExamples(corpus, input);
    assert.deepEqual(selectBookQuestionExamples(corpus, input), first);
    seen.add(first[0].id);
    const continued = selectBookQuestionExamples(corpus, { ...input, recentIds: [first[0].id] });
    assert.notEqual(continued[0].id, first[0].id);
  }
  assert.ok(seen.size >= 10, `Expected broad seeded reference coverage, saw ${seen.size}`);
  const original = questions[0];
  const duplicate = syntheticReferenceQuestion(original.questionText, { sourcePath: 'synthetic-duplicate-occurrence.md', primaryFunctions: ['CHOICE'] });
  const duplicated = syntheticReferenceCorpus([original, duplicate, questions[1]]);
  const examples = selectBookQuestionExamples(duplicated, { primaryFunction: 'CHOICE', limit: 3 });
  assert.equal(examples.length, 2);
  assert.equal(new Set(examples.map(example => example.questionText)).size, 2);
  const continued = selectBookQuestionExamples(duplicated, { primaryFunction: 'CHOICE', limit: 1, recentIds: [original.id] });
  assert.equal(continued[0].id, questions[1].id);
});

test('manual approval flags, pending analysis and forged source bindings cannot authorize runtime reference use', () => {
  const reviewed = syntheticReferenceQuestion('자료를 비교한 과정은 무엇인가요?', { primaryFunctions: ['PROCESS'] });
  const withoutFlag = structuredClone(reviewed); withoutFlag.runtimeApproved = false;
  assert.equal(bookQuestionReferenceUsage(withoutFlag), 'direct_example');
  const mutations = [
    (question: typeof reviewed) => { delete question.analysis; question.runtimeApproved = true; },
    (question: typeof reviewed) => { question.analysis = { questionId: question.id, status: 'pending', sourceSha256: question.source.sha256, questionSha256: 'a'.repeat(64), failureCode: 'NOT_REVIEWED' }; },
    (question: typeof reviewed) => { question.analysis!.sourceSha256 = 'a'.repeat(64); },
    (question: typeof reviewed) => { question.analysis!.questionSha256 = 'b'.repeat(64); },
    (question: typeof reviewed) => { question.analysis!.questionId = 'unrelated-source-question'; },
    (question: typeof reviewed) => { if (question.analysis?.status === 'reviewed') question.analysis.category = 'review_required'; },
  ];
  for (const mutate of mutations) {
    const question = structuredClone(reviewed); mutate(question);
    assert.equal(bookQuestionReferenceUsage(question), null);
    assert.deepEqual(selectBookQuestionExamples(syntheticReferenceCorpus([question]), { primaryFunction: 'PROCESS' }), []);
  }
});

test('compound sources supply one exact matching demand with its own depth and never the complete multi-task question', () => {
  const question = syntheticReferenceQuestion('자료를 선택한 기준은 무엇인가요? 그 결과의 한계는 무엇인가요?', {
    category: 'compound_strategy', primaryFunctions: ['CHOICE', 'LIMIT'], depth: 'D4', strategies: ['single_demand_decomposition', 'limit'],
    demands: [{ quote: '자료를 선택한 기준은 무엇인가요?', primaryFunction: 'CHOICE', depth: 'D2' }, { quote: '그 결과의 한계는 무엇인가요?', primaryFunction: 'LIMIT', depth: 'D4' }],
  });
  const corpus = syntheticReferenceCorpus([question]);
  for (const [primaryFunction, expectedDepth, quote] of [['CHOICE', 'D2', '자료를 선택한 기준은 무엇인가요?'], ['LIMIT', 'D4', '그 결과의 한계는 무엇인가요?']]) {
    const [example] = selectBookQuestionExamples(corpus, { primaryFunction, depth: expectedDepth });
    assert.equal(example.usage, 'compound_strategy');
    assert.equal(example.questionText, undefined);
    assert.equal(example.atomicDemand?.quote, quote);
    assert.equal(example.atomicDemand?.primaryFunction, primaryFunction);
    assert.equal(example.atomicDemand?.depth, expectedDepth);
    assert.equal(example.depth, expectedDepth);
    assert.ok(!JSON.stringify(example).includes(question.questionText));
  }
});

test('passage, figure, prior-answer and institution dependencies expose strategies without missing-context question text', () => {
  for (const dependency of ['passage', 'figure', 'priorAnswer', 'institution'] as const) {
    const dependencies = { passage: false, figure: false, priorAnswer: false, institution: false, [dependency]: true };
    const question = syntheticReferenceQuestion('주어진 자료를 비교한 근거는 무엇인가요?', {
      category: dependency === 'institution' ? 'direct_example' : 'contextual_strategy', primaryFunctions: ['EVIDENCE'], dependencies, strategies: ['comparison', 'evidence_verification', 'context_required'],
    });
    const [example] = selectBookQuestionExamples(syntheticReferenceCorpus([question]), { primaryFunction: 'EVIDENCE' });
    assert.equal(example.usage, 'contextual_strategy');
    assert.equal(example.questionText, undefined); assert.equal(example.atomicDemand, undefined);
    assert.equal(example.dependencies?.[dependency], true);
    assert.ok(example.strategies?.includes('context_required'));
    assert.ok(!JSON.stringify(example).includes(question.questionText));
  }
});

test('semantic restrictions distinguish personal inquiries from academic religious topics and numeric science questions', () => {
  const academic = syntheticReferenceQuestion('종교 개념이 역사에서 갖는 의미를 설명해 주세요.', { primaryFunctions: ['CONCEPT'], restrictions: ['student_fact_binding_required'] });
  const numeric = syntheticReferenceQuestion('5% 설탕용액에서 삼투 현상의 원리를 설명해 주세요.', { primaryFunctions: ['CONCEPT'], restrictions: ['student_fact_binding_required'] });
  const personal = syntheticReferenceQuestion('본인의 개인 종교에 대해 설명해 주세요.', { primaryFunctions: ['FACT'], restrictions: ['sensitive_personal'] });
  const administrative = syntheticReferenceQuestion('평가 항목의 배점은 무엇인가요?', { category: 'out_of_scope', primaryFunctions: [], demands: [], restrictions: ['not_a_question'] });
  const corpus = syntheticReferenceCorpus([academic, numeric, personal, administrative]);
  assert.equal(bookQuestionReferenceUsage(academic), 'direct_example');
  assert.equal(bookQuestionReferenceUsage(numeric), 'direct_example');
  assert.equal(bookQuestionReferenceUsage(personal), null); assert.equal(bookQuestionReferenceUsage(administrative), null);
  const examples = selectBookQuestionExamples(corpus, { primaryFunction: 'CONCEPT', limit: 8 });
  assert.deepEqual(new Set(examples.map(example => example.id)), new Set([academic.id, numeric.id]));
});
