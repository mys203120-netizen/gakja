import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { EvaluationJobStore, evaluationJobId } from '../server/evaluation-job-store';
import { runEvaluationWorkerOnce } from '../server/evaluation-worker';
import { EVALUATION_PIPELINE_VERSION, evaluationSessionSourceFingerprint, type EvaluationClusterCheckpoint } from '../server/providers/evaluation-input';
import type { evaluateSession } from '../server/providers/openai';
import { createSessionRuntime } from '../server/session-runtime';
import { loadInterviewContext } from './fixtures/runtime-context';
import type { InterviewSession } from '../server/protocol';
import { normalizeProviderUsage } from '../server/observability/provider-cost';
import { LocalSessionStore } from '../server/storage/local-session-store';

const sourceSha = 'b'.repeat(64);
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'interview-evaluation-worker-'));
  t.after(async () => { if (path.resolve(directory).startsWith(path.join(os.tmpdir(), 'interview-evaluation-worker-'))) await rm(directory, { recursive: true, force: true }); });
  const context = await loadInterviewContext();
  const session: InterviewSession = { id: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: 'ending', evaluationStatus: 'pending', turns: [], elapsedMs: 2500, followUpCountByMainQuestion: {}, target: context.target,
    sourceManifest: context.manifest, runtime: createSessionRuntime(context, { id: 'synthetic-queue-owner', mode: 'local-development' }) };
  const jobs = new EvaluationJobStore(directory);
  const enqueue = () => jobs.enqueue(session, sourceSha, EVALUATION_PIPELINE_VERSION);
  const options = { jobs, loadContext: async () => context, fingerprint: () => sourceSha };
  return { directory, context, session, jobs, enqueue, options };
}
function checkpoint(id: string): EvaluationClusterCheckpoint {
  return { version: EVALUATION_PIPELINE_VERSION, clusterId: id, inputSha256: 'c'.repeat(64), output: { answers: [] }, completedAt: new Date().toISOString() };
}
const evaluation = { summary: '합성 평가 결과', answers: [], sessionScore: null } as unknown as Awaited<ReturnType<typeof evaluateSession>>;

test('enqueue is durable, immutable, owner/version scoped and idempotent', async t => {
  const value = await fixture(t), original = JSON.stringify(value.session);
  const first = await value.enqueue(); value.session.evaluationStatus = 'running';
  const second = await value.enqueue();
  assert.equal(first.id, second.id); assert.equal(second.attempts, 0);
  const restarted = new EvaluationJobStore(value.directory), loaded = await restarted.get(first.id);
  assert.ok(loaded); assert.equal(JSON.stringify((await restarted.snapshot(loaded)).session), original);
  assert.notEqual(evaluationJobId(value.session.id, 'another-owner', sourceSha, EVALUATION_PIPELINE_VERSION), first.id);
  assert.notEqual(evaluationJobId(value.session.id, first.ownerId, sourceSha, 'next-version'), first.id);
});

test('only one concurrent claimant acquires a job and expired owners cannot write', async t => {
  const { jobs, enqueue } = await fixture(t), job = await enqueue(), now = Date.now();
  const claims = await Promise.all([jobs.claim(job.id, 'worker-A', now, 500), jobs.claim(job.id, 'worker-B', now, 500)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const first = claims.find(Boolean)!;
  assert.equal(await jobs.claim(job.id, 'worker-C', now + 499, 500), null);
  const replacement = await jobs.claim(job.id, 'worker-C', now + 501, 500);
  assert.ok(replacement?.lease); assert.equal(replacement.attempts, 2);
  await assert.rejects(jobs.complete(job.id, first.lease!.token, evaluation), /EVALUATION_LEASE_LOST/u);
  await jobs.complete(job.id, replacement.lease.token, evaluation);
  assert.deepEqual((await jobs.result((await jobs.get(job.id))!))?.evaluation, evaluation);
});

for (const code of ['EPERM', 'EACCES', 'EBUSY']) test(`concurrent claims survive a transient Windows ${code} lock read without a second lease`, async t => {
  const value = await fixture(t), job = await value.enqueue(), now = Date.now();
  let denied = 0;
  const jobs = new EvaluationJobStore(value.directory, { readLockFile: async file => {
    if (!denied) { denied++; throw Object.assign(new Error('explicit synthetic Windows lock read denial'), { code }); }
    return readFile(file, 'utf8');
  } });
  const claims = await Promise.all([jobs.claim(job.id, 'worker-A', now, 500), jobs.claim(job.id, 'worker-B', now, 500)]);
  assert.equal(denied, 1); assert.equal(claims.filter(Boolean).length, 1);
  assert.equal((await jobs.get(job.id))!.attempts, 1);
  const winner = claims.find(Boolean)!;
  assert.equal((await jobs.get(job.id))!.lease!.token, winner.lease!.token);
});

test('permanent invalid or unreadable locks and an expired live-PID lock remain untouched after bounded refusal', async t => {
  const cases = await Promise.all(['invalid-json', 'permanent-denial', 'live-pid'].map(async kind => {
    const value = await fixture(t), job = await value.enqueue(), file = path.join(value.directory, `${job.id}.lock.json`);
    const bytes = kind === 'invalid-json' ? '{"token":' : JSON.stringify({ token: randomUUID(), pid: process.pid, expiresAt: Date.now() - 1 });
    await writeFile(file, bytes);
    let denied = 0;
    const jobs = kind === 'permanent-denial' ? new EvaluationJobStore(value.directory, { readLockFile: async () => {
      denied++; throw Object.assign(new Error('explicit permanent synthetic lock read denial'), { code: 'EACCES' });
    } }) : value.jobs;
    await assert.rejects(jobs.claim(job.id, 'must-not-steal'), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, kind === 'live-pid' ? 'EVALUATION_JOB_BUSY' : 'EVALUATION_LOCK_INVALID');
      if (kind === 'permanent-denial') assert.equal((error.cause as NodeJS.ErrnoException).code, 'EACCES');
      if (kind === 'invalid-json') assert.ok(error.cause instanceof SyntaxError);
      return true;
    });
    assert.equal(await readFile(file, 'utf8'), bytes);
    assert.equal((await jobs.get(job.id))!.status, 'queued'); assert.equal((await jobs.get(job.id))!.attempts, 0);
    if (kind === 'permanent-denial') assert.ok(denied > 1 && denied < 256, 'the same three-second budget bounds read retries');
    return kind;
  }));
  assert.equal(cases.length, 3);
});

test('renewed leases remain exclusive and killed-worker jobs can be recovered after expiry', async t => {
  const { jobs, enqueue } = await fixture(t), job = await enqueue(), now = Date.now();
  const claimed = (await jobs.claim(job.id, 'worker-A', now, 500))!;
  await jobs.renew(job.id, claimed.lease!.token, now + 300, 500);
  assert.equal((await jobs.pending(now + 501)).length, 0);
  const restarted = new EvaluationJobStore(jobs.directory);
  assert.equal((await restarted.pending(now + 801)).length, 1);
  assert.ok(await restarted.claim(job.id, 'worker-after-restart', now + 801));
});

test('transient failure resumes completed cluster checkpoints and preserves original session bytes', async t => {
  const value = await fixture(t), job = await value.enqueue();
  const originalFile = path.join(value.directory, 'original-session.json');
  await writeFile(originalFile, JSON.stringify(value.session)); const original = await readFile(originalFile);
  let now = Date.now(), calls = 0;
  const providerUsage = normalizeProviderUsage({ model: 'gpt-6.1-terra', id: 'synthetic-response-1', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 } } });
  const evaluate: typeof evaluateSession = async (_context, _session, options = {}) => {
    calls++;
    if (calls === 1) {
      options.onProviderUsage?.(providerUsage);
      await options.onClusterComplete?.(checkpoint('q0-completed'));
      throw Object.assign(new Error('synthetic temporary upstream failure'), { status: 502 });
    }
    assert.deepEqual(options.resumeClusters?.map(item => item.clusterId), ['q0-completed']);
    return evaluation;
  };
  const first = await runEvaluationWorkerOnce({ ...value.options, evaluate, now: () => now });
  assert.equal(first.job?.status, 'queued'); assert.equal(first.job?.checkpoints.length, 1); assert.equal(first.job?.usage.length, 1);
  assert.equal((await runEvaluationWorkerOnce({ ...value.options, evaluate, now: () => now })).processed, false);
  now += 2100;
  const resumed = await runEvaluationWorkerOnce({ ...value.options, jobs: new EvaluationJobStore(value.directory), evaluate, now: () => now });
  assert.equal(resumed.job?.status, 'completed'); assert.equal(calls, 2);
  assert.deepEqual((await value.jobs.result((await value.jobs.get(job.id))!))?.evaluation, evaluation);
  assert.deepEqual(await readFile(originalFile), original);
  assert.equal((await runEvaluationWorkerOnce({ ...value.options, evaluate })).processed, false);
});

test('nonretryable 400 is failed without a retry loop and explicit retry retains checkpoints', async t => {
  const value = await fixture(t), job = await value.enqueue();
  const result = await runEvaluationWorkerOnce({ ...value.options, evaluate: async () => { throw Object.assign(new Error('synthetic invalid input'), { status: 400 }); } });
  assert.equal(result.job?.status, 'failed'); assert.equal(result.job?.error?.retryable, false);
  assert.equal((await value.jobs.pending()).length, 0);
  const retried = await value.jobs.retry(job.id);
  assert.equal(retried?.status, 'queued'); assert.equal((await value.jobs.pending()).length, 1);
});

test('snapshot or source binding tampering never reaches the evaluator', async t => {
  const value = await fixture(t), job = await value.enqueue(); let calls = 0;
  const file = path.join(value.directory, `${job.id}.snapshot.json`);
  const snapshot = JSON.parse(await readFile(file, 'utf8')); snapshot.session.elapsedMs++;
  await writeFile(file, JSON.stringify(snapshot));
  const result = await runEvaluationWorkerOnce({ ...value.options, evaluate: async () => { calls++; return evaluation; } });
  assert.equal(result.job?.status, 'failed'); assert.equal(calls, 0);
  assert.match(result.job?.error?.message ?? '', /EVALUATION_SNAPSHOT_CHANGED/u);
});

test('changed contextual source fingerprint fails before a model request', async t => {
  const value = await fixture(t); await value.enqueue(); let calls = 0;
  const result = await runEvaluationWorkerOnce({ ...value.options, fingerprint: () => 'd'.repeat(64), evaluate: async () => { calls++; return evaluation; } });
  assert.equal(result.job?.status, 'failed'); assert.equal(calls, 0);
});

test('the durable model pin is used for source validation and execution', async t => {
  const value = await fixture(t), pinnedModel = 'synthetic-pinned-evaluator';
  const job = await value.jobs.enqueue(value.session, sourceSha, EVALUATION_PIPELINE_VERSION, Date.now(), pinnedModel);
  const result = await runEvaluationWorkerOnce({ ...value.options,
    fingerprint: (_context, _session, model) => { assert.equal(model, pinnedModel); return sourceSha; },
    evaluate: async (_context, _session, options = {}) => { assert.equal(options.model, pinnedModel); return evaluation; },
  });
  assert.equal(result.job?.status, 'completed');
  assert.equal((await value.jobs.result((await value.jobs.get(job.id))!))?.model, pinnedModel);
});

test('a result is a separately verified revision and tampering is rejected', async t => {
  const value = await fixture(t), job = await value.enqueue();
  const result = await runEvaluationWorkerOnce({ ...value.options, evaluate: async () => evaluation });
  assert.equal(result.job?.status, 'completed');
  const file = path.join(value.directory, `${job.id}.result.json`);
  const altered = JSON.parse(await readFile(file, 'utf8')); altered.evaluation.summary = 'tampered'; await writeFile(file, JSON.stringify(altered));
  await assert.rejects(value.jobs.result((await value.jobs.get(job.id))!), /EVALUATION_RESULT_CHANGED/u);
});

test('a corrupt queue entry is isolated with diagnostics while healthy jobs still complete', async t => {
  const value = await fixture(t), healthy = await value.enqueue(), brokenId = 'e'.repeat(64);
  const brokenFile = path.join(value.directory, `${brokenId}.job.json`), original = Buffer.from('{broken queue json, preserve these bytes');
  await writeFile(brokenFile, original);
  assert.deepEqual((await value.jobs.pending()).map(job => job.id), [healthy.id]);
  const diagnostic = JSON.parse(await readFile(path.join(value.directory, `${brokenId}.quarantine.json`), 'utf8'));
  assert.equal(diagnostic.errorCode, 'EVALUATION_JOB_CORRUPT'); assert.equal(diagnostic.originalPreserved, true);
  const completed = await runEvaluationWorkerOnce({ ...value.options, evaluate: async () => evaluation });
  assert.equal(completed.job?.id, healthy.id); assert.equal(completed.job?.status, 'completed');
  assert.deepEqual(await readFile(brokenFile), original);
});

test('transient Windows replacement denial retries the same temporary bytes while retaining published state', async t => {
  const value = await fixture(t), job = await value.enqueue(), attemptedSources: string[] = [];
  const published = path.join(value.directory, `${job.id}.job.json`), before = await readFile(published);
  let failures = 2;
  const jobs = new EvaluationJobStore(value.directory, { replaceFile: async (from, to) => {
    attemptedSources.push(from);
    if (failures-- > 0) { assert.deepEqual(await readFile(published), before); throw Object.assign(new Error('synthetic transient file lock'), { code: 'EPERM' }); }
    await rename(from, to);
  } });
  const claimed = await jobs.claim(job.id, 'worker-with-transient-reader');
  assert.equal(claimed?.status, 'running'); assert.equal(attemptedSources.length, 3);
  assert.equal(new Set(attemptedSources).size, 1);
});

test('the real worker process loads a pinned context and persists a no-answer evaluation without rewriting its session', async t => {
  const value = await fixture(t), sessionsDirectory = path.join(value.directory, 'sessions');
  const sessions = new LocalSessionStore(sessionsDirectory);
  const contextSha = await sessions.saveContext(value.context, value.session.runtime!.owner.id);
  assert.equal(value.session.runtime!.contextSnapshotSha256, contextSha);
  await sessions.save(value.session);
  const originalFile = path.join(sessionsDirectory, `${value.session.id}.json`), before = await readFile(originalFile);
  const source = evaluationSessionSourceFingerprint(value.context, value.session);
  const job = await value.jobs.enqueue(value.session, source, EVALUATION_PIPELINE_VERSION);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/run-evaluation-worker.ts', '--once', '--jobs-directory', value.directory, '--sessions-directory', sessionsDirectory], {
      cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      // The no-answer path must not depend on a real API credential.
      env: { ...process.env, OPENAI_API_KEY: '' },
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Synthetic worker process timed out')); }, 12_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); if (code === 0) resolve(); else reject(new Error(`Synthetic worker failed: ${output}`)); });
  });
  const completed = (await value.jobs.get(job.id))!;
  assert.equal(completed.status, 'completed');
  assert.equal(((await value.jobs.result(completed))?.evaluation as { sessionScore: number | null }).sessionScore, null);
  assert.deepEqual(await readFile(originalFile), before);
});
