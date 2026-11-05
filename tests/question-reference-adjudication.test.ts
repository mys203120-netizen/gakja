import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BookQuestionCorpus, BookQuestionReference } from '../server/data/book-question-reference';
import { finalizeQuestionReferenceBatch, questionReferenceAnalysisCoverage, questionReferenceAnalysisIdentity, QUESTION_REFERENCE_ANALYSIS_POLICY, QUESTION_REFERENCE_ANALYSIS_VERSION, type QuestionReferenceAnalysis, type QuestionReferenceAnalysisRow } from '../server/data/question-reference-analysis';
import { applyQuestionReferenceAdjudications, QUESTION_REFERENCE_ADJUDICATION_FILE, QUESTION_REFERENCE_ADJUDICATION_POLICY, QUESTION_REFERENCE_ADJUDICATION_SCHEMA, QuestionReferenceAdjudicationError, type AdjudicatedQuestionReferenceRow, type QuestionReferenceAdjudicationEntry } from '../server/data/question-reference-adjudication';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const texts = ['목소리를 제대로 전달하고 있나요?', '학생부 내용은 어떻게 준비하나요?', '탐구 변인을 선택한 기준은 무엇인가요?'];
const source = `# 독자 자기 점검\n${texts[0]}\n# 독자 FAQ\n${texts[1]}\n# 실제 면접 질문\n${texts[2]}\n`;
const sourceHash = hash(source);
function question(rawText: string, index: number) {
  const startOffset = source.indexOf(rawText);
  return { id: `SYNTH-ADJ-${index}`, questionText: rawText, rawText, provenance: 'book_example', questionKind: 'unspecified', primaryFunctions: ['FACT'], source: { path: 'book.md', sha256: sourceHash, pdfPage: 1, startLine: index * 2 + 2, endLine: index * 2 + 2, startOffset, endOffset: startOffset + rawText.length, section: '합성 면접 교재' }, eligibility: 'eligible', exclusions: [], runtimeApproved: false } as unknown as BookQuestionReference;
}
function contentHash(value: QuestionReferenceAnalysis | Omit<QuestionReferenceAnalysis, 'contentSha256'>) { return hash(JSON.stringify({ ...value, createdAt: undefined, updatedAt: undefined, contentSha256: undefined })); }
function baseAnalysis(corpus: BookQuestionCorpus, pending = false): QuestionReferenceAnalysis {
  const rows: QuestionReferenceAnalysisRow[] = finalizeQuestionReferenceBatch({ items: corpus.questions.map(item => ({ questionId: item.id, category: 'direct_example', primaryFunctions: ['CHOICE'], depth: 'D2', strategies: ['choice_basis'], domain: 'stem', demands: [{ quote: item.questionText, primaryFunction: 'CHOICE', depth: 'D2' }], dependencies: { passage: false, figure: false, priorAnswer: false, institution: false }, restrictions: [], rationale: '원문의 선택 기준을 묻는 질문으로 최초 분류했다.' })) }, corpus.questions);
  if (pending) rows[1] = { questionId: corpus.questions[1].id, status: 'pending', sourceSha256: sourceHash, questionSha256: hash(corpus.questions[1].rawText), failureCode: 'INVALID_REVIEW_BATCH' };
  const body: Omit<QuestionReferenceAnalysis, 'contentSha256'> = { schemaVersion: QUESTION_REFERENCE_ANALYSIS_VERSION, policyVersion: QUESTION_REFERENCE_ANALYSIS_POLICY, ...questionReferenceAnalysisIdentity(corpus, { model: 'synthetic-adjudication-model' }), createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', rows, coverage: questionReferenceAnalysisCoverage(corpus, rows) };
  return { ...body, contentSha256: contentHash(body) };
}
async function fixture(pending = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'question-reference-adjudication-'));
  const corpus = { sourceHashes: [{ path: 'book.md', sha256: sourceHash, lineCount: source.split('\n').length, documentKind: 'preparation' }], questions: texts.map(question) } as unknown as BookQuestionCorpus;
  const analysis = baseAnalysis(corpus, pending);
  await writeFile(path.join(root, 'book.md'), source);
  const file = path.join(root, QUESTION_REFERENCE_ADJUDICATION_FILE); await mkdir(path.dirname(file), { recursive: true });
  const evidence = { sourcePath: 'book.md', startOffset: 0, endOffset: source.indexOf('# 실제 면접 질문'), quote: source.slice(0, source.indexOf('# 실제 면접 질문')) };
  const entries: QuestionReferenceAdjudicationEntry[] = corpus.questions.slice(0, 2).map(item => ({ questionId: item.id, sourceSha256: sourceHash, questionSha256: hash(item.rawText), evidence, reason: '질문 앞의 독자 자기점검/FAQ 표제가 문서의 독자 안내 역할을 명시한다.', replacement: { category: 'out_of_scope', primaryFunctions: [], depth: 'D1', strategies: [], demands: [], dependencies: { passage: false, figure: false, priorAnswer: false, institution: false }, restrictions: ['not_a_question'], rationale: '면접관의 질문이 아니라 책 독자를 위한 점검/FAQ다.' } }));
  const sidecar = { schemaVersion: QUESTION_REFERENCE_ADJUDICATION_SCHEMA, policyVersion: QUESTION_REFERENCE_ADJUDICATION_POLICY, entries };
  return { root, file, corpus, analysis, entries, sidecar, async save() { await writeFile(file, JSON.stringify(sidecar)); }, async close() { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('question-reference-adjudication-')); await rm(root, { recursive: true, force: true }); } };
}

test('absent sidecar returns the original analysis object without mutation or replacement', async t => {
  const f = await fixture(); t.after(f.close);
  assert.equal(await applyQuestionReferenceAdjudications(f.corpus, f.analysis, { root: f.root }), f.analysis);
});

test('source role evidence corrects only named rows while preserving every original question, model row and audit origin', async t => {
  const f = await fixture(); t.after(f.close); await f.save();
  const before = structuredClone(f.analysis), journal = path.join(f.root, 'original-journal.jsonl');
  await writeFile(journal, 'original-model-journal\n');
  const result = await applyQuestionReferenceAdjudications(f.corpus, f.analysis, { root: f.root });
  assert.deepEqual(f.analysis, before); assert.equal(await readFile(journal, 'utf8'), 'original-model-journal\n');
  assert.equal(result.rows.length, 3); assert.equal(result.rows[2], f.analysis.rows[2]);
  assert.deepEqual(result.rows.map(row => row.status === 'reviewed' ? row.category : row.status), ['out_of_scope', 'out_of_scope', 'direct_example']);
  const changed = result.rows[0] as AdjudicatedQuestionReferenceRow;
  assert.equal(changed.domain, 'stem'); assert.equal(changed.reviewOrigin.originalRowSha256, hash(JSON.stringify(before.rows[0])));
  assert.equal(changed.reviewOrigin.evidence.quote, f.entries[0].evidence.quote); assert.equal(changed.reviewOrigin.analysisKey, before.key);
  assert.equal(result.key, before.key); assert.notEqual(result.contentSha256, before.contentSha256);
  assert.equal(result.coverage.byCategory.out_of_scope, 2); assert.equal(result.coverage.byCategory.direct_example, 1); assert.equal(result.coverage.exactAccounting, true);
  assert.equal(result.adjudicationSummary?.scope, 'source_role_correction_not_runtime_allowlist');
});

test('repeated application is stable, including when a source-evidenced correction resolves a pending row', async t => {
  const f = await fixture(true); t.after(f.close); await f.save();
  const a = await applyQuestionReferenceAdjudications(f.corpus, f.analysis, { root: f.root }), b = await applyQuestionReferenceAdjudications(f.corpus, f.analysis, { root: f.root });
  assert.deepEqual(a, b);
  const again = await applyQuestionReferenceAdjudications(f.corpus, a, { root: f.root });
  assert.deepEqual(again, a); assert.equal(a.coverage.complete, true); assert.equal(a.adjudicationSummary?.replacedPendingCount, 1);
  assert.equal((a.rows[1] as AdjudicatedQuestionReferenceRow).domain, 'unknown');
  assert.equal((a.rows[1] as AdjudicatedQuestionReferenceRow).reviewOrigin.originalStatus, 'pending');
});

test('unknown/duplicate/obsolete source and question entries raise explicit errors rather than silently disappearing', async t => {
  const cases: Array<[string, (f: Awaited<ReturnType<typeof fixture>>) => void, string]> = [
    ['unknown', f => { f.entries[0].questionId = 'unknown'; }, 'UNKNOWN_QUESTION'],
    ['duplicate', f => { f.entries.push(structuredClone(f.entries[0])); }, 'DUPLICATE_ENTRY'],
    ['source', f => { f.entries[0].sourceSha256 = 'f'.repeat(64); }, 'STALE_SOURCE'],
    ['question', f => { f.entries[0].questionSha256 = 'e'.repeat(64); }, 'STALE_QUESTION'],
  ];
  for (const [name, change, expected] of cases) await t.test(name, async child => {
    const f = await fixture(); child.after(f.close); change(f); await f.save();
    await assert.rejects(applyQuestionReferenceAdjudications(f.corpus, f.analysis, { root: f.root }), error => error instanceof QuestionReferenceAdjudicationError && error.code === expected);
  });
});

test('evidence must match actual source bytes, cover the question, and replacement demands retain ordinary validation', async t => {
  const changes: Array<[string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void> | void, string]> = [
    ['wrong quote', f => { f.entries[0].evidence.quote += 'invented'; }, 'INVALID_EVIDENCE'],
    ['header without question', f => { f.entries[0].evidence.endOffset = source.indexOf('\n'); f.entries[0].evidence.quote = source.slice(0, f.entries[0].evidence.endOffset); }, 'INVALID_EVIDENCE'],
    ['different path', f => { f.entries[0].evidence.sourcePath = '../other.md'; }, 'INVALID_EVIDENCE'],
    ['changed disk source', async f => { await writeFile(path.join(f.root, 'book.md'), source + 'changed'); }, 'STALE_SOURCE'],
    ['invented replacement demand', f => { Object.assign(f.entries[0].replacement, { category: 'direct_example', primaryFunctions: ['FACT'], demands: [{ quote: '원문에 없는 확인 요구', primaryFunction: 'FACT', depth: 'D1' }] }); }, 'INVALID_REPLACEMENT'],
  ];
  for (const [name, change, expected] of changes) await t.test(name, async child => {
    const f = await fixture(); child.after(f.close); await change(f); await f.save();
    await assert.rejects(applyQuestionReferenceAdjudications(f.corpus, f.analysis, { root: f.root }), error => error instanceof QuestionReferenceAdjudicationError && error.code === expected);
  });
});

test('invalid sidecar or changed analysis identity and unaccounted rows cannot receive source-context approvals', async t => {
  const f = await fixture(); t.after(f.close); await f.save();
  const unknownPolicy = { ...f.sidecar, policyVersion: 'unknown' }; await writeFile(f.file, JSON.stringify(unknownPolicy));
  await assert.rejects(applyQuestionReferenceAdjudications(f.corpus, f.analysis, { root: f.root }), error => error instanceof QuestionReferenceAdjudicationError && error.code === 'INVALID_SIDECAR');
  await f.save();
  const wrongIdentity = structuredClone(f.analysis); wrongIdentity.sourceFingerprint = 'a'.repeat(64);
  await assert.rejects(applyQuestionReferenceAdjudications(f.corpus, wrongIdentity, { root: f.root }), error => error instanceof QuestionReferenceAdjudicationError && error.code === 'ANALYSIS_SOURCE_MISMATCH');
  const missing = structuredClone(f.analysis); missing.rows.pop(); missing.contentSha256 = contentHash(missing);
  await assert.rejects(applyQuestionReferenceAdjudications(f.corpus, missing, { root: f.root }), error => error instanceof QuestionReferenceAdjudicationError && error.code === 'ANALYSIS_INTEGRITY_INVALID');
});
