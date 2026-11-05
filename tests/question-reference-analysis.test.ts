import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zodTextFormat } from 'openai/helpers/zod';
import type { BookQuestionCorpus, BookQuestionReference } from '../server/data/book-question-reference';
import { analyzeQuestionReferences, finalizeQuestionReferenceBatch, loadQuestionReferenceAnalysis, materializeQuestionReferenceBatch, questionReferenceAnalysisCoverage, questionReferenceAnalysisIdentity, questionReferenceBatchSchema, type QuestionReferenceAnalysis, type QuestionReferenceReviewedRow } from '../server/data/question-reference-analysis';

// Explicit synthetic MD and classifications: no external model, speech API or user session is used.
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const texts = ['5% 설탕 용액의 농도를 어떻게 계산했나요?', '선택한 동기와 실제 수행 과정은 무엇인가요?', '다음 제시문을 비교해 판단 근거를 설명해 보세요.', '종교 용어를 학술적으로 어떻게 정의했나요?'];
function corpus(text = texts.join('\n\n')) {
  const sourceHash = hash(text);
  return { sourceHashes: [{ path: 'book.md', sha256: sourceHash, lineCount: text.split('\n').length, documentKind: 'preparation' }], questions: texts.map((rawText, index) => {
    const startOffset = text.indexOf(rawText);
    return { id: `SYNTH-Q${index + 1}`, rawText, questionText: rawText, provenance: 'book_example', questionKind: 'unspecified', primaryFunctions: ['FACT'], source: { path: 'book.md', sha256: sourceHash, pdfPage: 1, startLine: index * 2 + 1, endLine: index * 2 + 1, startOffset, endOffset: startOffset + rawText.length, section: '합성 질문' }, eligibility: 'excluded', exclusions: ['administrative_content'], runtimeApproved: false };
  }) } as unknown as BookQuestionCorpus;
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'question-reference-analysis-'));
  const input = corpus(); await writeFile(path.join(root, 'book.md'), texts.join('\n\n'));
  return { root, corpus: input, async close() { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('question-reference-analysis-')); await rm(root, { recursive: true, force: true }); } };
}
function item(question: BookQuestionReference) {
  const base = { questionId: question.id, category: 'direct_example', primaryFunctions: ['PROCESS'], depth: 'D2', strategies: ['process'], domain: 'stem', demands: [{ quote: question.questionText, primaryFunction: 'PROCESS', depth: 'D2' }], dependencies: { passage: false, figure: false, priorAnswer: false, institution: false }, restrictions: [], rationale: '원문에서 실제로 묻는 단일 절차를 확인한다.' };
  if (question.id === 'SYNTH-Q2') return { ...base, category: 'compound_strategy', primaryFunctions: ['MOTIVE', 'PROCESS'], strategies: ['motivation', 'process', 'single_demand_decomposition'], demands: [{ quote: '동기', primaryFunction: 'MOTIVE', depth: 'D2' }, { quote: '실제 수행 과정', primaryFunction: 'PROCESS', depth: 'D2' }] };
  if (question.id === 'SYNTH-Q3') return { ...base, category: 'contextual_strategy', primaryFunctions: ['EVIDENCE'], strategies: ['evidence_verification', 'context_required'], demands: [{ quote: '판단 근거를 설명해 보세요.', primaryFunction: 'EVIDENCE', depth: 'D2' }], dependencies: { passage: true, figure: false, priorAnswer: false, institution: false } };
  if (question.id === 'SYNTH-Q4') return { ...base, primaryFunctions: ['CONCEPT'], strategies: ['concept_clarification'], domain: 'faith_context', demands: [{ quote: question.questionText, primaryFunction: 'CONCEPT', depth: 'D2' }] };
  return base;
}
const output = (questions: readonly BookQuestionReference[]) => ({ items: questions.map(item) });

test('all corpus candidates are analyzed regardless of old whitelist, percent heuristics or academic religious vocabulary', async t => {
  const f = await fixture(); t.after(f.close);
  let calls = 0;
  const analysis = await analyzeQuestionReferences(f.corpus, { root: f.root, model: 'synthetic-model', batchSize: 2, requestBatch: async (request, questions) => { calls++; assert.equal(request.model, 'synthetic-model'); assert.equal(request.store, false); assert.ok(!request.input.includes('runtimeApproved')); return output(questions); } });
  assert.equal(calls, 2); assert.equal(analysis.coverage.reviewed, 4); assert.equal(analysis.coverage.pending, 0); assert.equal(analysis.coverage.complete, true);
  assert.deepEqual(analysis.rows.map(row => row.questionId), f.corpus.questions.map(question => question.id));
  assert.equal((analysis.rows[0] as QuestionReferenceReviewedRow).category, 'direct_example');
  assert.deepEqual((analysis.rows[3] as QuestionReferenceReviewedRow).restrictions, []);
  assert.equal((analysis.rows[3] as QuestionReferenceReviewedRow).domain, 'faith_context');
});

test('short demand anchors and compound/context strategies retain exact MD offsets without inventing standalone questions', () => {
  const input = corpus(), rows = finalizeQuestionReferenceBatch(output(input.questions), input.questions);
  assert.equal(rows[1].category, 'compound_strategy'); assert.equal(rows[1].demandSpans[0].quote, '동기');
  assert.equal(rows[2].category, 'contextual_strategy'); assert.ok(rows[2].restrictions.includes('passage_required'));
  for (const row of rows) for (const span of row.demandSpans) {
    const question = input.questions.find(candidate => candidate.id === row.questionId)!;
    assert.equal(question.rawText.slice(span.questionStartOffset, span.questionEndOffset), span.quote);
    assert.equal(texts.join('\n\n').slice(span.sourceStartOffset, span.sourceEndOffset), span.quote);
  }
  const bad = output(input.questions); bad.items[2] = { ...bad.items[2], category: 'direct_example' };
  assert.throws(() => finalizeQuestionReferenceBatch(bad, input.questions), /INVALID_REVIEW_BATCH/u);
});

test('fabricated demand quotes, duplicate or absent IDs hold only affected items while verified rows survive', () => {
  const input = corpus(), proposed = output(input.questions);
  proposed.items[1].demands = [{ quote: '원문에 없는 새로운 결과', primaryFunction: 'PROCESS', depth: 'D2' }];
  const rows = materializeQuestionReferenceBatch(proposed, input.questions);
  assert.equal(rows[0].status, 'reviewed'); assert.equal(rows[1].status, 'pending'); assert.equal(rows[2].status, 'reviewed');
  assert.equal(rows[1].status === 'pending' ? rows[1].failureDetail : null, 'COMPOUND_DEMAND_COUNT');
  const duplicate = materializeQuestionReferenceBatch({ items: [item(input.questions[0]), item(input.questions[0]), item(input.questions[2])] }, input.questions);
  assert.deepEqual(duplicate.map(row => row.status), ['pending', 'pending', 'reviewed', 'pending']);
  assert.equal(duplicate[0].status === 'pending' ? duplicate[0].failureDetail : null, 'DUPLICATE_REVIEW_ID');
  assert.equal(duplicate[1].status === 'pending' ? duplicate[1].failureDetail : null, 'MISSING_REVIEW_ID');
});

test('resume requests only unresolved IDs, and source-bound snapshots and repeated loads have stable identity', async t => {
  const f = await fixture(); t.after(f.close);
  let calls = 0;
  const first = await analyzeQuestionReferences(f.corpus, { root: f.root, model: 'synthetic-model', batchSize: 2, concurrency: 1, requestBatch: async (_request, questions) => { calls++; if (calls === 2) throw new Error('synthetic provider interruption'); return output(questions); } });
  assert.equal(first.coverage.reviewed, 2); assert.equal(first.coverage.pending, 2); assert.equal(first.coverage.complete, false);
  const second = await analyzeQuestionReferences(f.corpus, { root: f.root, model: 'synthetic-model', batchSize: 2, requestBatch: async (_request, questions) => { assert.deepEqual(questions.map(question => question.id), ['SYNTH-Q3', 'SYNTH-Q4']); return output(questions); } });
  assert.equal(second.coverage.complete, true);
  const a = await loadQuestionReferenceAnalysis(f.corpus, { root: f.root, model: 'synthetic-model' }), b = await loadQuestionReferenceAnalysis(f.corpus, { root: f.root, model: 'synthetic-model' });
  assert.deepEqual(a, b); assert.equal(a!.contentSha256, second.contentSha256);
  const noCalls = await analyzeQuestionReferences(f.corpus, { root: f.root, model: 'synthetic-model', requestBatch: async () => { throw new Error('completed analysis must not call a provider'); } });
  assert.deepEqual(noCalls, a);
  const identity = questionReferenceAnalysisIdentity(f.corpus, { model: 'synthetic-model' });
  assert.equal(identity.key, questionReferenceAnalysisIdentity({ ...f.corpus, digest: 'unrelated-runtime-projection' } as BookQuestionCorpus, { model: 'synthetic-model' }).key);
  assert.notEqual(identity.key, questionReferenceAnalysisIdentity(f.corpus, { model: 'other-model' }).key);
});

test('journal recovery preserves complete rows after a torn tail and a missing snapshot', async t => {
  const f = await fixture(); t.after(f.close);
  const result = await analyzeQuestionReferences(f.corpus, { root: f.root, model: 'synthetic-model', requestBatch: async (_request, questions) => output(questions) });
  const directory = path.join(f.root, 'data/prepared/question-reference-analysis'), journal = path.join(directory, `${result.key}.jsonl`), snapshot = path.join(directory, `${result.key}.json`);
  await appendFile(journal, '{"torn":'); await unlink(snapshot);
  const first = await loadQuestionReferenceAnalysis(f.corpus, { root: f.root, model: 'synthetic-model' }), second = await loadQuestionReferenceAnalysis(f.corpus, { root: f.root, model: 'synthetic-model' });
  assert.equal(first!.coverage.complete, true); assert.equal(first!.contentSha256, result.contentSha256); assert.deepEqual(first, second);
});

test('source-byte changes, fabricated source spans, duplicate input IDs and workspace escapes fail before any model call', async t => {
  const f = await fixture(); t.after(f.close);
  let calls = 0;
  const options = { root: f.root, model: 'synthetic-model', requestBatch: async () => { calls++; return {}; } };
  const badSpan = structuredClone(f.corpus); badSpan.questions[0].source.startOffset++;
  await assert.rejects(analyzeQuestionReferences(badSpan, options), /REFERENCE_QUESTION_SOURCE_MISMATCH/u);
  const duplicate = structuredClone(f.corpus); duplicate.questions.push(duplicate.questions[0]);
  await assert.rejects(analyzeQuestionReferences(duplicate, options), /DUPLICATE_SOURCE_QUESTION_ID/u);
  const escaped = structuredClone(f.corpus); escaped.sourceHashes[0].path = '../book.md';
  await assert.rejects(analyzeQuestionReferences(escaped, options), /SOURCE_PATH_ESCAPES_WORKSPACE/u);
  await writeFile(path.join(f.root, 'book.md'), 'changed source bytes');
  await assert.rejects(analyzeQuestionReferences(f.corpus, options), /REFERENCE_SOURCE_BYTES_CHANGED/u);
  assert.equal(calls, 0);
});

test('a held provider batch is not retried in a run, pending accounting is explicit, and duplicate rows cannot claim coverage', async t => {
  const f = await fixture(); t.after(f.close);
  let calls = 0;
  const result = await analyzeQuestionReferences(f.corpus, { root: f.root, model: 'synthetic-model', requestBatch: async () => { calls++; throw Object.assign(new Error('synthetic timeout'), { name: 'APIConnectionTimeoutError' }); } });
  assert.equal(calls, 1); assert.equal(result.coverage.pending, 4); assert.equal(result.coverage.reviewed, 0); assert.equal(result.coverage.exactAccounting, true);
  assert.ok(result.rows.every(row => row.status === 'pending' && row.failureCode === 'PROVIDER_TIMEOUT'));
  assert.equal(questionReferenceAnalysisCoverage(f.corpus, [...result.rows, result.rows[0]]).exactAccounting, false);
  const file = path.join(f.root, 'data/prepared/question-reference-analysis', `${result.key}.json`);
  assert.equal((JSON.parse(await readFile(file, 'utf8')) as QuestionReferenceAnalysis).coverage.total, 4);
});

test('the structured wire contains question IDs only, never raw PDF newline/tab literals, and bounds concurrency', async t => {
  const f = await fixture(); t.after(f.close);
  const format = zodTextFormat(questionReferenceBatchSchema(f.corpus.questions), 'synthetic_question_review');
  const walk = (value: unknown) => { if (!value || typeof value !== 'object') return; if ('enum' in value && Array.isArray(value.enum)) assert.ok(value.enum.every(item => typeof item !== 'string' || !/[\r\n\t]/u.test(item))); for (const item of Object.values(value)) walk(item); };
  walk(format.schema);
  let active = 0, maximum = 0;
  const result = await analyzeQuestionReferences(f.corpus, { root: f.root, model: 'synthetic-model', concurrency: 2, batchSize: 1, requestBatch: async (_request, questions) => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 3)); active--; return output(questions); } });
  assert.equal(result.coverage.complete, true); assert.equal(maximum, 2);
  await assert.rejects(analyzeQuestionReferences(f.corpus, { root: f.root, model: 'synthetic-model', concurrency: 5 }), /INVALID_ANALYSIS_LIMITS/u);
});
