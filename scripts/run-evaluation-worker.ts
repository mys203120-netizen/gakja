import { assertLocalInternalExecution, InternalExecutionError } from '../server/internal-execution';
import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { runEvaluationWorkerOnce } from '../server/evaluation-worker';
import { EvaluationJobStore } from '../server/evaluation-job-store';
import { LocalSessionStore } from '../server/storage/local-session-store';

dotenv.config({ path: '.env.local', quiet: true });
async function main() {
  assertLocalInternalExecution();
  const workerId = `evaluation-worker-${process.pid}-${randomUUID()}`;
  const argument = (name: string) => {
    const position = process.argv.indexOf(name);
    if (position < 0) return undefined;
    const value = process.argv[position + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    return value;
  };
  const jobs = new EvaluationJobStore(argument('--jobs-directory'));
  const sessions = new LocalSessionStore(argument('--sessions-directory'));
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });
  console.log('면접 사후 평가 워커를 시작합니다.');
  while (!stopping) {
    try {
      const result = await runEvaluationWorkerOnce({ workerId, jobs, sessions });
      if (result.processed) {
        console.log(`평가 작업 ${result.job?.id.slice(0, 12)}: ${result.job?.status}`);
        if (process.argv.includes('--once')) break;
        continue;
      }
    } catch (error) { console.error('평가 작업 저장소를 확인하지 못했습니다:', error instanceof Error ? error.message : 'WORKER_ERROR'); }
    if (process.argv.includes('--once')) break;
    await new Promise(resolve => setTimeout(resolve, 700));
  }
}
void main().catch(error => {
  console.error(JSON.stringify({ passed: false, error: error instanceof InternalExecutionError ? error.code : 'INTERNAL_EXECUTION_MODE_INVALID' }));
  process.exitCode = 1;
});
