import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extractBookQuestions, type BookQuestionReference } from '../server/data/book-question-reference';
import { reviewSyntheticReference, syntheticReferenceCorpus, syntheticReferenceQuestion } from './fixtures/book-references';
import { buildQuestionStrategyCatalog, buildStrategyBatchItems, finalizeStrategyProfile, loadQuestionStrategyCatalog, parseStrategyResponseText, prepareQuestionStrategyCatalog, projectQuestionStrategy, questionStrategyIdentity, type StrategySemanticProfile } from '../server/data/question-strategy-catalog';
import { observeStrategySignals, retrieveQuestionStrategies } from '../server/question-strategy-retrieval';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function profile(questionId: string, changes: Partial<StrategySemanticProfile> = {}): StrategySemanticProfile {
  return { questionId, operations: ['evidence_verification'], trigger: 'assertion', requiredClaimSlots: ['actual_answer'], expectedEvidence: 'basis', anchorMode: 'none', directness: 'direct', relation: { kind: 'unknown', targetQuestionId: null, condition: 'none', supportQuote: null }, ...changes };
}
function plainRecord(question: BookQuestionReference, changes: Partial<StrategySemanticProfile> = {}) {
  const corpus = syntheticReferenceCorpus([question]);
  return finalizeStrategyProfile(profile(question.id, changes), question, { questionId: question.id, question: question.questionText, sourceContext: question.rawText, existingOperations: [], primaryFunctions: question.primaryFunctions, precedingQuestionIds: [] }, question.rawText, corpus);
}
function sourceFixture(document: string) {
  const questions = extractBookQuestions(document, 'book.md', 'preparation').map(q => reviewSyntheticReference(q));
  const corpus = syntheticReferenceCorpus(questions);
  corpus.sourceHashes = [{ path: 'book.md', sha256: hash(document), lineCount: document.split('\n').length, documentKind: 'preparation' }];
  return corpus;
}
const document = '# 합성 자료\n#### PDF 페이지 1\n```text\n면접 질문\n본인이 자료를 선택한 기준은 무엇인가요?\n답변 예시\n저는 두 자료의 근거를 비교했습니다.\n추가 질문\n비교한 근거의 한계는 무엇인가요?\n```';

test('complete provider JSON followed by junk is recovered without fabricating truncated fields', () => {
  const output = { items: [profile('BOOKQ-test')], diagnostic: '문자열 내부의 } 와 \\" 는 경계가 아님' };
  const text = JSON.stringify(output);
  assert.deepEqual(parseStrategyResponseText(`${text}} \n junk \\`), { output, ignoredTrailingText: true });
  assert.throws(() => parseStrategyResponseText(text.slice(0, -3)), /JSON_INCOMPLETE/);
  assert.throws(() => parseStrategyResponseText('not-json'), /JSON_INVALID/);
});

test('runtime cards contain abstract strategy metadata without book facts, questions or private proof', () => {
  const question = syntheticReferenceQuestion('홍길동은 987654개의 화학 물질을 조사했습니다. 본인의 조사 방법은 무엇인가요?', { primaryFunctions: ['PROCESS'] });
  const corpus = syntheticReferenceCorpus([question]), catalog = buildQuestionStrategyCatalog(corpus, [plainRecord(question)]);
  assert.deepEqual(catalog.coverage, { total: 1, ready: 1, restricted: 0, pending: 0, complete: true, sourceBound: true, relationCounts: { answer_conditioned: 0, same_activity_deeper: 0, related_concept: 0, topic_transition: 0, unknown: 1 } });
  const runtime = JSON.stringify(projectQuestionStrategy(catalog.cards[0]));
  assert.ok(!runtime.includes('홍길동') && !runtime.includes('987654') && !runtime.includes(question.questionText));
  assert.ok(!runtime.includes('supportQuote') && !runtime.includes('evidenceRef'));
});

test('all source IDs remain accounted, restricted questions are retained and unreviewed sources stay pending', () => {
  const good = syntheticReferenceQuestion('실제로 한 행동을 설명해 주세요.');
  const restricted = syntheticReferenceQuestion('부모님의 직업을 말해 주세요.', { restrictions: ['sensitive_personal'] });
  const unreviewed = syntheticReferenceQuestion('원리를 설명해 주세요.', { reviewed: false });
  const corpus = syntheticReferenceCorpus([good, restricted, unreviewed]);
  const catalog = buildQuestionStrategyCatalog(corpus, [plainRecord(good)]);
  assert.equal(catalog.records.length, 3); assert.equal(catalog.coverage.ready, 1); assert.equal(catalog.coverage.restricted, 1); assert.equal(catalog.coverage.pending, 1); assert.equal(catalog.coverage.complete, false);
  const forged = { ...catalog.records[2], status: 'restricted' as const, restrictionReason: 'not_needed' };
  assert.throws(() => buildQuestionStrategyCatalog(corpus, [catalog.records[0], catalog.records[1], forged]), /RESTRICTION_NOT_SUPPORTED/);
});

test('actual source relation proof is bound and missing proof conservatively becomes unknown with trace', () => {
  const corpus = sourceFixture(document), sources = new Map([['book.md', document]]);
  assert.equal(corpus.questions.length, 2);
  const [parent, child] = corpus.questions, item = buildStrategyBatchItems(corpus, sources, [child])[0];
  const relation = { kind: 'answer_conditioned' as const, targetQuestionId: parent.id, condition: 'new_claim' as const, supportQuote: '저는 두 자료의 근거를 비교했습니다.' };
  const valid = finalizeStrategyProfile(profile(child.id, { relation }), child, item, document, corpus);
  assert.equal(valid.relation?.kind, 'answer_conditioned');
  const bound = valid.relation!.evidenceRef!; assert.equal(document.slice(bound.startOffset, bound.endOffset), relation.supportQuote);
  const unknown = finalizeStrategyProfile(profile(child.id, { relation: { ...relation, supportQuote: '학생은 존재하지 않는 실험을 수행했습니다.' } }), child, item, document, corpus);
  assert.equal(unknown.relation?.kind, 'unknown'); assert.equal(unknown.normalization?.reason, 'unproven_relation_left_unknown'); assert.equal(unknown.profile?.relation.supportQuote, null);
});

test('retrieval crosses source topic and function boundaries and keeps unknown applicability', () => {
  const a = syntheticReferenceQuestion('천문학 개념을 설명해 주세요.', { primaryFunctions: ['CONCEPT'] });
  const b = syntheticReferenceQuestion('봉사활동의 경험을 말해 주세요.', { primaryFunctions: ['FACT'] });
  const corpus = syntheticReferenceCorpus([a, b]);
  const catalog = buildQuestionStrategyCatalog(corpus, [plainRecord(a, { operations: ['limit'], trigger: 'uncertainty', expectedEvidence: 'boundary' }), plainRecord(b, { operations: ['numeric_verification'], trigger: 'numeric_claim', requiredClaimSlots: ['actual_measurement'] })]);
  const found = retrieveQuestionStrategies(catalog, { primaryFunction: 'EVIDENCE', targetText: '판단 근거', answerText: '그렇게 생각합니다.', limit: 4 });
  assert.ok(found.length >= 2); assert.ok(found.some(card => card.operation === 'limit')); assert.ok(found.some(card => card.operation === 'numeric_verification'));
  assert.ok(!retrieveQuestionStrategies(catalog, { unavailableSlots: ['actual_measurement'] }).some(card => card.operation === 'numeric_verification'));
  assert.deepEqual(retrieveQuestionStrategies(catalog, { remainingFollowUps: 0 }), []);
  assert.ok(observeStrategySignals('직접 측정하지 않았습니다.').includes('new_answer_claim'));
  assert.ok(!observeStrategySignals('직접 측정하지 않았습니다.').includes('numeric_claim'));
});

test('retrieval can choose source IDs outside a fixed sixty-item subset', () => {
  const questions = Array.from({ length: 90 }, (_, index) => syntheticReferenceQuestion(`사례 ${index}의 근거를 설명해 주세요.`, { id: `BOOKQ-SYNTH-${index}` }));
  const corpus = syntheticReferenceCorpus(questions), catalog = buildQuestionStrategyCatalog(corpus, questions.map(q => plainRecord(q)));
  const chosen = new Set(Array.from({ length: 200 }, (_, index) => retrieveQuestionStrategies(catalog, { seed: `seed-${index}`, limit: 1 })[0].sourceQuestionIds[0]));
  assert.ok([...chosen].some(id => Number(id.split('-').at(-1)) >= 60)); assert.equal(catalog.records.length, 90);
});

test('offline preparation persists source-bound profiles, reloads without providers and rejects changed source bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'question-strategies-'));
  try {
    await writeFile(path.join(root, 'book.md'), document);
    const corpus = sourceFixture(document); let calls = 0;
    const prepared = await prepareQuestionStrategyCatalog(corpus, { root, model: 'synthetic-model', runLive: true, requestBatch: async (_, items) => { calls++; return { items: items.map(item => profile(item.questionId)) }; } });
    assert.equal(calls, 1); assert.equal(prepared.coverage.complete, true);
    const loaded = await loadQuestionStrategyCatalog(corpus, { root, model: 'synthetic-model' }); assert.equal(loaded?.contentSha256, prepared.contentSha256);
    const reused = await prepareQuestionStrategyCatalog(corpus, { root, model: 'synthetic-model', runLive: true, requestBatch: async () => { throw new Error('must not call'); } }); assert.equal(reused.contentSha256, prepared.contentSha256);
    const identity = questionStrategyIdentity(corpus, { model: 'synthetic-model' });
    const saved = JSON.parse(await readFile(path.join(root, 'data/prepared/question-strategies', `${identity.key}.json`), 'utf8'));
    assert.equal(saved.records.length, 2); assert.ok(!saved.cards.some((card: { assessmentTarget: string }) => card.assessmentTarget.includes('자료를 선택')));
    await writeFile(path.join(root, 'book.md'), `${document}\n변경`);
    await assert.rejects(loadQuestionStrategyCatalog(corpus, { root, model: 'synthetic-model' }), /SOURCE_HASH_CHANGED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('provider failure and torn journal tail preserve valid work and retry only failed source IDs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'question-strategies-retry-'));
  try {
    await writeFile(path.join(root, 'book.md'), document); const corpus = sourceFixture(document);
    const first = await prepareQuestionStrategyCatalog(corpus, { root, model: 'synthetic-model', runLive: true, batchSize: 1, concurrency: 1, requestBatch: async (_, items) => ({ items: items.map(item => item.questionId === corpus.questions[0].id ? profile(item.questionId) : { invalid: true }) }) });
    assert.equal(first.coverage.ready, 1); assert.equal(first.coverage.pending, 1);
    const identity = questionStrategyIdentity(corpus, { model: 'synthetic-model' });
    const journalPath = path.join(root, 'data/prepared/question-strategies', `${identity.key}.jsonl`);
    await appendFile(journalPath, '{"interrupted":');
    const retried: string[] = [];
    const second = await prepareQuestionStrategyCatalog(corpus, { root, model: 'synthetic-model', runLive: true, requestBatch: async (_, items) => { retried.push(...items.map(item => item.questionId)); return { items: items.map(item => profile(item.questionId)) }; } });
    assert.deepEqual(retried, [corpus.questions[1].id]); assert.equal(second.coverage.complete, true);
    assert.equal((await loadQuestionStrategyCatalog(corpus, { root, model: 'synthetic-model' }))?.coverage.complete, true);
    assert.ok((await readFile(journalPath, 'utf8')).trim().split('\n').every(line => Boolean(JSON.parse(line))));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('one malformed profile does not discard valid siblings in a source batch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'question-strategies-partial-'));
  try {
    await writeFile(path.join(root, 'book.md'), document); const corpus = sourceFixture(document);
    const result = await prepareQuestionStrategyCatalog(corpus, { root, model: 'synthetic-model', runLive: true, requestBatch: async (_, items) => ({ items: items.map((item, index) => index === 0 ? profile(item.questionId) : { ...profile(item.questionId), operations: ['made_up_operation'] }) }) });
    assert.equal(result.coverage.ready, 1); assert.equal(result.coverage.pending, 1);
    assert.equal(result.records.find(record => record.questionId === corpus.questions[0].id)?.status, 'ready');
    assert.match(result.records.find(record => record.questionId === corpus.questions[1].id)?.failureCode ?? '', /PROFILE_SCHEMA/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
