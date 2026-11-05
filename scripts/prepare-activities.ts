import dotenv from 'dotenv';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { loadInterviewContext } from '../server/data/load-interview-context';
import { ACTIVITY_EXTRACTION_RULES, activitySourceSpans, activitySpanSelectionSchema, buildPreparedActivities, loadPreparedActivities, materializeActivitySpanSelection, preparedActivitiesModel, savePreparedActivities } from '../server/data/prepared-activities';
import { loadFullRecord } from '../server/data/full-student-analysis';
import { prepareStudentAnalysisCli } from './prepare-student-analysis';

dotenv.config({ path: '.env.local', quiet: true });
const live = process.argv.includes('--run-live');
const context = await loadInterviewContext();
if (context.errors.length) throw new Error('원천 자료 검증에 실패했습니다. 먼저 npm run verify:context를 실행하세요.');
const model = preparedActivitiesModel();
if (await loadFullRecord(process.cwd(), context.student.pdfSha256) && !process.argv.includes('--legacy-excerpts')) {
  const result = await prepareStudentAnalysisCli(process.argv.slice(2), context);
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
} else {
const existing = await loadPreparedActivities(context);
if (existing && !process.argv.includes('--force')) {
  console.log(JSON.stringify({ passed: true, cacheHit: true, providerCalls: 0, sourceUnits: existing.units.length, syntheticTest: false, operation: 'offline-source-preparation' }, null, 2));
} else if (!live) {
  console.log(JSON.stringify({ passed: false, cacheHit: false, providerCalls: 0, syntheticTest: false, operation: 'offline-source-preparation', action: 'npx tsx scripts/prepare-activities.ts --run-live' }, null, 2));
  process.exitCode = 1;
} else {
  try {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY가 필요합니다.');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 90_000, maxRetries: 0 });
  const sources = context.student.evidence;
  if (sources.length > 20 || sources.some(source => source.text.length > 2200)) throw new Error('구조화 입력 범위를 초과했습니다.');
  const started = performance.now();
  // One bounded ID-classification request. The model never generates quoted text or offsets.
  const spans = activitySourceSpans(sources);
  const response = await client.responses.parse({ model, store: false, service_tier: 'default', reasoning: { effort: 'low' },
    input: [{ role: 'system', content: ACTIVITY_EXTRACTION_RULES }, { role: 'user', content: JSON.stringify({ sources: sources.map(source => ({ sourceId: source.id, title: source.title, page: source.page, section: source.section, spans: spans.filter(span => span.sourceId === source.id) })) }) }],
    text: { format: zodTextFormat(activitySpanSelectionSchema(sources), 'offline_source_activity_spans') }, max_output_tokens: 6500,
  });
  if (!response.output_parsed) throw new Error('활동 구조화 모델이 검증 가능한 결과를 반환하지 않았습니다.');
  const cache = buildPreparedActivities(context, materializeActivitySpanSelection(sources, response.output_parsed), { model });
  const actionQuotes = cache.units.flatMap(unit => unit.facts.studentActions);
  if (!actionQuotes.some(fact => /조사|작성|정리|발표|분석|탐구|제안|진행|비교|계획|제작|선정|실천|읽/u.test(fact.quote))) throw new Error('실제 행동 구간을 전혀 구조화하지 못했습니다. 빈 결과를 성공으로 저장하지 않습니다.');
  await savePreparedActivities(cache, context);
  const loaded = await loadPreparedActivities(context);
  if (!loaded || loaded.contentSha256 !== cache.contentSha256) throw new Error('저장한 활동 캐시를 다시 검증할 수 없습니다.');
  console.log(JSON.stringify({ passed: true, cacheHit: false, actualProviders: true, providerCalls: 1, sourceUnits: loaded.units.length, individualActionQuotes: actionQuotes.length, independentActivityCount: null, sourceFingerprint: loaded.sourceFingerprint, elapsedMs: Math.round(performance.now() - started), syntheticTest: false, userInterviewSessionCreated: false, operation: 'offline-source-preparation' }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ passed: false, cacheHit: false, actualProviders: true, syntheticTest: false, userInterviewSessionCreated: false, operation: 'offline-source-preparation', error: error instanceof Error ? error.message : 'OFFLINE_ACTIVITY_PREPARATION_FAILED' }, null, 2));
    process.exitCode = 1;
  }
}
}
