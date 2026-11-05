import dotenv from 'dotenv';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareBookQuestionReferences } from '../server/data/book-question-reference';
import { analyzeQuestionReferences, loadQuestionReferenceAnalysis, questionReferenceAnalysisModel } from '../server/data/question-reference-analysis';

export async function analyzeQuestionReferencesCli(args: string[]) {
  dotenv.config({ path: '.env.local', quiet: true });
  if (args.some(value => !['--run-live', '--check', '--resume'].includes(value) && !/^--(?:batch-size|concurrency)=\d+$/u.test(value)) || args.includes('--check') && args.includes('--run-live')) throw new Error('사용법: tsx scripts/analyze-question-references.ts --check | --run-live [--resume] [--batch-size=12] [--concurrency=2]');
  const value = (name: string, fallback: number) => Number(args.find(argument => argument.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
  const corpus = await prepareBookQuestionReferences();
  const model = questionReferenceAnalysisModel();
  if (!args.includes('--run-live') || corpus.analysis?.coverage.complete) {
    const existing = await loadQuestionReferenceAnalysis(corpus, { model });
    const coverage = corpus.analysis?.coverage ?? existing?.coverage;
    console.log(JSON.stringify({ operation: 'check-whole-question-corpus-analysis', providerCalls: 0, ready: Boolean(coverage?.complete), model, key: corpus.analysis?.key ?? existing?.key ?? null, coverage: coverage ?? { total: corpus.questions.length, reviewed: 0, pending: corpus.questions.length, complete: false }, modelCoverage: existing?.coverage ?? null, sourceContextAdjudication: corpus.analysis?.adjudicationSummary ?? null, action: coverage?.complete ? null : 'tsx scripts/analyze-question-references.ts --run-live --resume' }, null, 2));
    return Boolean(coverage?.complete);
  }
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY_REQUIRED');
  const analysis = await analyzeQuestionReferences(corpus, { model, batchSize: value('batch-size', 12), concurrency: value('concurrency', 2), onProgress: progress => console.log(JSON.stringify({ operation: 'analyze-question-batch', ...progress })) });
  // Rebuild the runtime projection after new analysis rows have been durably written.
  const prepared = await prepareBookQuestionReferences();
  const coverage = prepared.analysis?.coverage ?? analysis.coverage;
  console.log(JSON.stringify({ operation: 'whole-question-corpus-analysis', ready: coverage.complete, key: analysis.key, model: analysis.model, coverage, modelCoverage: analysis.coverage, sourceContextAdjudication: prepared.analysis?.adjudicationSummary ?? null, rebuiltCorpusDigest: prepared.digest, note: '모델 가중치 학습이 아니라 원문에 연결된 질문 기능·전략 분석 및 검색 자료 구축입니다.' }, null, 2));
  return coverage.complete;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  analyzeQuestionReferencesCli(process.argv.slice(2)).then(ready => { if (!ready) process.exitCode = 1; }).catch(error => {
    console.error(JSON.stringify({ ready: false, code: error instanceof Error ? error.message : 'QUESTION_REFERENCE_ANALYSIS_FAILED' }));
    process.exitCode = 1;
  });
}
