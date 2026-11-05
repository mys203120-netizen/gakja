import dotenv from 'dotenv';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareBookQuestionReferences } from '../server/data/book-question-reference';
import { prepareQuestionStrategyCatalog } from '../server/data/question-strategy-catalog';

export async function prepareQuestionStrategiesCli(args: string[]) {
  dotenv.config({ path: '.env.local', quiet: true });
  if (args.some(arg => !['--run-live', '--check', '--resume'].includes(arg) && !/^--(?:batch-size|concurrency)=\d+$/u.test(arg)) || args.includes('--check') && args.includes('--run-live')) throw new Error('사용법: tsx scripts/prepare-question-strategies.ts --check | --run-live [--resume] [--batch-size=16] [--concurrency=2]');
  const corpus = await prepareBookQuestionReferences();
  const numeric = (name: string, fallback: number) => Number(args.find(arg => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
  const catalog = await prepareQuestionStrategyCatalog(corpus, { runLive: args.includes('--run-live'), batchSize: numeric('batch-size', 16), concurrency: numeric('concurrency', 2), onProgress: progress => console.log(JSON.stringify({ operation: 'prepare-question-strategies', ...progress })) });
  console.log(JSON.stringify({ ready: catalog.coverage.complete, key: catalog.key, corpusDigest: catalog.corpusDigest, model: catalog.model, cards: catalog.cards.length, coverage: catalog.coverage, interpretation: catalog.interpretation }, null, 2));
  return catalog.coverage.complete;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) prepareQuestionStrategiesCli(process.argv.slice(2)).then(ready => { if (!ready) process.exitCode = 1; }).catch(error => { console.error(JSON.stringify({ ready: false, code: error instanceof Error ? error.message : 'QUESTION_STRATEGY_PREPARATION_FAILED' })); process.exitCode = 1; });
