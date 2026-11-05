import dotenv from 'dotenv';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadInterviewContext } from '../server/data/load-interview-context';
import { loadQuestionBank, loadQuestionBankPreparationSummary, prepareQuestionBank, questionBankIdentity } from '../server/data/prepared-question-bank';

/** Explicit offline command. Runtime preparation never calls this function. */
export async function prepareInterviewBankCli(args: string[]) {
  dotenv.config({ path: '.env.local', quiet: true });
  if (args.some(value => !['--run-live', '--check', '--concurrency=1', '--concurrency=2'].includes(value) && !/^--max-new-candidates=\d+$/u.test(value)) || args.includes('--check') && args.includes('--run-live')) throw new Error('사용법: npm run prepare:interview -- --check | --run-live [--concurrency=1|2] [--max-new-candidates=N]');
  const maxNewCandidates = args.find(value => value.startsWith('--max-new-candidates='))?.split('=')[1];
  const context = await loadInterviewContext();
  const identity = questionBankIdentity(context);
  const cached = await loadQuestionBank(context);
  const variants = identity.plan.purpose === 'candidate_pool' ? 1 : 2;
  const total = identity.plan.slots.length * variants;
  if (cached || !args.includes('--run-live')) {
    const summary = await loadQuestionBankPreparationSummary(context);
    console.log(JSON.stringify({ ready: Boolean(cached), bankKey: identity.key, ...summary, preparedCandidates: summary.availableApprovedCount, alternatives: total - identity.plan.slots.length, stoppingRule: 'time-and-available-objectives', providerCalls: 0, preparationCommand: cached ? null : 'npm run prepare:interview -- --run-live', runtimeGeneration: false }, null, 2));
    return Boolean(cached);
  }
  const missing = ['OPENAI_API_KEY', 'CLOVA_VOICE_CLIENT_ID', 'CLOVA_VOICE_CLIENT_SECRET'].filter(key => !process.env[key]);
  if (missing.length) throw new Error(`질문 은행 준비에 필요한 환경변수: ${missing.join(', ')}`);
  console.log(JSON.stringify({ stage: 'offline-preparation', independentObjectives: identity.plan.slots.length, alternatives: total - identity.plan.slots.length, candidateCapacity: total, existingValidationAttemptsPerCandidate: 2, concurrency: args.includes('--concurrency=1') ? 1 : 2, note: '준비 용량은 실제 API 호출 횟수나 면접 문항 수가 아닙니다. 두 번 검수 거부된 목표는 격리하고 다른 목표를 준비합니다. 전송·인증·예산 중단은 완료로 처리하지 않습니다. 실제 질문·검수·음성 API를 호출하며 면접·답변·재생 기록은 생성하지 않습니다.' }));
  try {
    const bank = await prepareQuestionBank(context, { maxNewCandidates: maxNewCandidates === undefined ? undefined : Number(maxNewCandidates), concurrency: args.includes('--concurrency=1') ? 1 : 2, onProgress: event => console.log(JSON.stringify({ stage: 'offline-progress', ...event })) });
    const summary = await loadQuestionBankPreparationSummary(context);
    console.log(JSON.stringify({ ready: true, bankKey: bank.key, ...summary, candidates: summary.availableApprovedCount, completedAt: bank.completedAt, runtimeGeneration: false }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ stage: 'offline-incomplete', ready: false, bankKey: identity.key, ...await loadQuestionBankPreparationSummary(context), runtimeGeneration: false }, null, 2));
    throw error;
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  prepareInterviewBankCli(process.argv.slice(2)).then(ready => { if (!ready) process.exitCode = 1; }).catch(error => {
    // Keys and provider response bodies are deliberately excluded from the CLI error output.
    const code = error && typeof error === 'object' && 'lastValidationCode' in error ? String(error.lastValidationCode) : error && typeof error === 'object' && 'code' in error && /^[A-Z0-9_]+$/u.test(String(error.code)) ? String(error.code) : error instanceof Error ? error.name : 'PREPARATION_FAILED';
    console.error(JSON.stringify({ ready: false, code, message: '질문 은행 준비를 완료하지 못했습니다. 원문·검수·음성 설정과 내부 진단을 확인한 뒤 같은 명령으로 재개하세요.' }));
    process.exitCode = 1;
  });
}
