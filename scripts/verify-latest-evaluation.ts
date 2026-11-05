import dotenv from 'dotenv';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { InterviewSession } from '../server/protocol';
import { loadInterviewContext } from '../server/data/load-interview-context';
import { buildEvaluationUnits } from '../server/providers/evaluation-turns';
import { buildEvaluationObservations } from '../server/providers/answer-observations';
import { buildEvaluationClusterInputs, buildEvaluationObservationSummary, EVALUATION_PIPELINE_VERSION, evaluationPolicyProjection, evaluationSessionSourceFingerprint } from '../server/providers/evaluation-input';
import { EvaluationJobStore } from '../server/evaluation-job-store';
import { LocalSessionStore } from '../server/storage/local-session-store';
import { createSessionRuntime } from '../server/session-runtime';
import { aggregateProviderCosts, estimateProviderCost } from '../server/observability/provider-cost';
import { evaluateSession } from '../server/providers/openai';
import { LATEST_HUMAN_SESSION } from './benchmark-latest-interview';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const sessionFile = `data/sessions/${LATEST_HUMAN_SESSION}.json`, journalFile = `data/conversation-logs/${LATEST_HUMAN_SESSION}.jsonl`;
const originalBytes = await readFile(sessionFile), journalBytes = await readFile(journalFile);
const original = JSON.parse(originalBytes.toString('utf8')) as InterviewSession;
const context = await loadInterviewContext();
if (context.errors.length) throw new Error('LATEST_EVALUATION_CONTEXT_INVALID');
const inputs = buildEvaluationClusterInputs(context, original);
const oldAnswers = buildEvaluationUnits(original).scoredUnits.map(unit => ({ ...unit.turn, answerAttempts: unit.answerAttempts, clarificationTurnIds: unit.clarificationTurnIds }));
const report = {
  version: 'latest-human-isolated-evaluation-v1', startedAt: new Date().toISOString(), sourceSessionId: LATEST_HUMAN_SESSION,
  sourceSha256: sha(originalBytes), journalSha256: sha(journalBytes), originalFilesModified: false,
  inputComparison: { rawAnswerCharacters: original.turns.reduce((sum, turn) => sum + (turn.rawTranscript ?? '').length, 0),
    oldSerializedAnswersCharacters: JSON.stringify(oldAnswers).length,
    oldSerializedObservationsCharacters: JSON.stringify(buildEvaluationObservations(original)).length,
    newClusterInputCharacters: inputs.reduce((sum, value) => sum + JSON.stringify(value).length, 0),
    newStoredObservationsCharacters: JSON.stringify(buildEvaluationObservationSummary(original)).length,
    clusters: inputs.length, scoredUnits: inputs.reduce((sum, value) => sum + value.answers.length, 0),
    policy: evaluationPolicyProjection(context.evaluationGuidelines).trace },
  providerCallsRequested: process.argv.includes('--run-live'), evaluation: null as unknown, job: null as unknown,
  completedAt: null as string | null, failure: null as string | null,
};
const suffix = new Date().toISOString().replace(/[-:.]/gu, '');
const output = `artifacts/latest-human-evaluation-${suffix}.json`;
await mkdir('artifacts', { recursive: true });
const save = () => writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
const resumePath = process.argv.find(value => value.startsWith('--resume='))?.slice('--resume='.length);
if (resumePath) {
  if (process.argv.includes('--run-live')) throw new Error('RESUME_VERIFY_MUST_NOT_REQUEST_LIVE_PROVIDER');
  const previous = JSON.parse(await readFile(resumePath, 'utf8')) as { job: { jobsDirectory: string; id: string } };
  const jobs = new EvaluationJobStore(previous.job.jobsDirectory), job = await jobs.get(previous.job.id);
  if (!job || job.status !== 'completed') throw new Error('RESUME_VERIFY_SOURCE_INCOMPLETE');
  const result = await evaluateSession(context, original, { model: job.model, resumeClusters: job.checkpoints,
    requestEvaluation: async () => { throw new Error('FINAL_CHECKPOINT_VERIFICATION_MUST_NOT_CALL_MODEL'); } });
  if (!('evaluationPipeline' in result) || result.evaluationPipeline.reusedClusters !== inputs.length) throw new Error('FINAL_CHECKPOINT_INPUT_DRIFTED');
  report.evaluation = result;
  report.job = { id: job.id, status: 'completed', reusedClusters: result.evaluationPipeline.reusedClusters,
    providerCalls: 0, finalInputContractRevalidated: true, resultSha256: job.resultSha256 };
}
if (process.argv.includes('--run-live')) {
  dotenv.config({ path: '.env.local', quiet: true });
  const root = path.resolve('.local/engine-refactor-evaluation', suffix);
  const sessionsDirectory = path.join(root, 'sessions'), jobsDirectory = path.join(root, 'jobs');
  const sessions = new LocalSessionStore(sessionsDirectory), jobs = new EvaluationJobStore(jobsDirectory);
  const derived = structuredClone(original);
  derived.id = randomUUID(); derived.status = 'ending'; derived.evaluationStatus = 'pending';
  delete derived.evaluation; delete derived.evaluationError; delete derived.providerUsageLedger;
  const ownerId = `synthetic-isolated-evaluation-${suffix}`;
  derived.runtime = createSessionRuntime(context, { id: ownerId, mode: 'local-development' });
  const contextHash = await sessions.saveContext(context, ownerId);
  if (contextHash !== derived.runtime.contextSnapshotSha256) throw new Error('DERIVED_EVALUATION_CONTEXT_HASH_CHANGED');
  const job = await jobs.enqueue(derived, evaluationSessionSourceFingerprint(context, derived), EVALUATION_PIPELINE_VERSION);
  report.job = { id: job.id, jobsDirectory, sessionId: derived.id, ownerId, provenance: 'Derived immutable evaluation snapshot only; no original session or journal write.' };
  await save();
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/run-evaluation-worker.ts', '--once', '--jobs-directory', jobsDirectory, '--sessions-directory', sessionsDirectory],
    { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let workerTail = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { workerTail = (workerTail + String(value)).slice(-2000); });
  try {
    const deadline = Date.now() + 360_000;
    let lastCheckpointCount = -1;
    while (Date.now() < deadline) {
      const state = await jobs.get(job.id);
      if (!state) throw new Error('ISOLATED_EVALUATION_JOB_LOST');
      if (state.checkpoints.length !== lastCheckpointCount) {
        lastCheckpointCount = state.checkpoints.length;
        console.log(JSON.stringify({ status: state.status, completedClusters: lastCheckpointCount, totalClusters: inputs.length, observedCalls: state.usage.length }));
      }
      if (state.status === 'completed' || state.status === 'failed') {
        const result = await jobs.result(state);
        report.evaluation = result?.evaluation ?? null;
        report.job = { ...(report.job as Record<string, unknown>), status: state.status, attempts: state.attempts, resultSha256: state.resultSha256,
          completedClusters: state.checkpoints.length, observedCalls: state.usage.length, usage: state.usage,
          publicRateCost: aggregateProviderCosts(state.usage.map(item => estimateProviderCost(item.observation))), error: state.error };
        if (state.status !== 'completed' || !result) report.failure = state.error?.code ?? 'ISOLATED_EVALUATION_INCOMPLETE';
        break;
      }
      if (child.exitCode !== null) throw new Error('ISOLATED_EVALUATION_WORKER_EXITED');
      await sleep(800);
    }
    if (!report.evaluation && !report.failure) throw new Error('ISOLATED_EVALUATION_DEADLINE');
  } catch (error) {
    report.failure = error instanceof Error ? error.message : 'ISOLATED_EVALUATION_ERROR';
    report.job = { ...(report.job as Record<string, unknown>), workerTail };
  } finally { child.kill(); }
}
if (sha(await readFile(sessionFile)) !== report.sourceSha256 || sha(await readFile(journalFile)) !== report.journalSha256) throw new Error('ORIGINAL_HUMAN_RECORD_CHANGED');
report.completedAt = new Date().toISOString(); await save();
console.log(JSON.stringify({ output, inputComparison: { ...report.inputComparison, policy: undefined }, job: report.job ? { ...(report.job as Record<string, unknown>), usage: undefined } : null, failure: report.failure }));
if (report.failure) process.exitCode = 1;
