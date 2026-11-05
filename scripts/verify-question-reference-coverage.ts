import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { loadBookQuestionReferences, bookQuestionReferenceUsage } from '../server/data/book-question-reference';
import { loadQuestionReferenceAnalysis } from '../server/data/question-reference-analysis';

const corpus = await loadBookQuestionReferences();
assert.ok(corpus?.analysis?.coverage.complete, 'Whole-corpus analysis must be complete');
assert.equal(corpus.analysis.coverage.pending, 0);
assert.ok(corpus.analysis.coverage.exactAccounting);
const sourceFiles = new Map(await Promise.all(corpus.sourceHashes.map(async source => [source.path, await readFile(source.path, 'utf8')] as const)));
const ids = new Set<string>();
for (const question of corpus.questions) {
  assert.ok(!ids.has(question.id)); ids.add(question.id);
  const source = sourceFiles.get(question.source.path)!;
  assert.equal(createHash('sha256').update(source).digest('hex'), question.source.sha256);
  assert.equal(source.slice(question.source.startOffset, question.source.endOffset), question.rawText);
  assert.equal(question.analysis?.status, 'reviewed');
  assert.equal(question.runtimeApproved, Boolean(bookQuestionReferenceUsage(question)));
  if (question.analysis?.status === 'reviewed') for (const demand of question.analysis.demandSpans) {
    assert.equal(question.rawText.slice(demand.questionStartOffset, demand.questionEndOffset), demand.quote);
    assert.equal(source.slice(demand.sourceStartOffset, demand.sourceEndOffset), demand.quote);
  }
}
assert.equal(Object.values(corpus.analysis.coverage.byCategory).reduce((sum, count) => sum + count, 0), corpus.questions.length);
assert.equal(corpus.counts.runtimeApprovedQuestions + corpus.counts.excludedQuestions, corpus.questions.length);
const model = await loadQuestionReferenceAnalysis(corpus);
assert.ok(model);
const oldSource = await readFile('server/data/book-question-reference.ts', 'utf8');
assert.doesNotMatch(oldSource, /import[^\n]+reviewed-book-questions/u);
const second = await loadBookQuestionReferences();
assert.equal(second?.digest, corpus.digest);
const report = {
  schemaVersion: 'whole-question-reference-verification-v2', passed: true,
  purpose: '전체 질문 후보의 원문·기능·깊이·전략 분석과 실제 검색 연결 검증',
  modelWeightTrainingPerformed: false, fixedManualWhitelistUsed: false,
  digest: corpus.digest, sourceHashes: corpus.sourceHashes, counts: corpus.counts,
  coverage: corpus.analysis.coverage, modelAnalysisCoverage: model.coverage,
  sourceContextAdjudication: corpus.analysis.adjudicationSummary,
  selection: { pool: 'all semantically usable questions and strategies', by: ['primaryFunction', 'atomic demand depth', 'topic', 'recent reference IDs', 'stable seed'], perRequestLimit: 3, limitIsCorpusSize: false, extraRuntimeModelCalls: 0 },
  verification: { allCandidateIdsAccountedFor: true, sourceBytesAndRawSpansVerified: true, allDemandOffsetsVerified: true, stableRepeatedLoad: true, figureFiles: corpus.counts.uniqueFigureFiles, missingFigures: corpus.counts.missingFigureFiles },
  limitations: ['전체 후보의 의미 분류는 모델이 수행하고 원문·구간·상관 조건은 코드로 검증했다. 모든 후보를 사람이 검수했다는 뜻은 아니다.', '제시문·불명확 용어·생략 맥락은 원문을 보존하고 해당 내용을 지어내지 않는 전략 참고로 사용한다.', '실제 발화의 사실은 현재 학생부·확정 답변에서만 얻는다. 책의 사례는 현재 학생의 사실이 아니다.'],
  questions: corpus.questions.map(question => ({ id: question.id, questionText: question.questionText, provenance: question.provenance, source: question.source, usage: bookQuestionReferenceUsage(question), analysis: question.analysis })),
};
await writeFile('artifacts/book-question-reference-verification.json', JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ passed: true, digest: corpus.digest, counts: corpus.counts, complete: corpus.analysis.coverage.complete, modelReviewed: model.coverage.reviewed, sourceContextCorrections: corpus.analysis.adjudicationSummary?.entryCount, providerCalls: 0 }, null, 2));
