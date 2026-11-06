import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLocalSessionStore } from '../server/storage/local-session-store';
import { createLocalEvaluationJobStore } from '../server/evaluation-job-store';
import type { EvaluationRepository } from '../server/repositories/evaluation-job-ports';
import { createLocalReviewRepository } from '../server/repositories/local-review-repository';
import { prepareEndedSessionReview, supplyReviewedSessionEvaluation } from '../server/evaluation-supply';
import { publishBankScopeReview } from '../server/data/evaluation-scope-registry';
import { knowledgeSessionQuestionAnswerHash } from '../server/data/approved-knowledge';
import { runEvaluationWorkerOnce } from '../server/evaluation-worker';
import type { evaluateSession } from '../server/providers/openai';
import { createTrustedEvaluationWorkerExecution, type TrustedEvaluationJobBinding } from '../server/internal-execution';
import { prepareEvaluationScopesCli } from '../scripts/prepare-evaluation-scopes';
import { prepareApprovedKnowledgeCli } from '../scripts/prepare-approved-knowledge';
import { evaluationSupplyFixture, pinSupplySnapshot, reviewedSupplyRegistry, supplyRecordBundle, supplyReviewer, supplySigner } from './fixtures/evaluation-supply';

function mode(t: { after(fn: () => void): void }, value: 'service' | 'local-development') {
  const env = process.env as Record<string, string | undefined>;
  const previous = env.INTERVIEW_EXECUTION_MODE, previousNode = env.NODE_ENV;
  env.INTERVIEW_EXECUTION_MODE = value; env.NODE_ENV = 'test';
  t.after(() => {
    if (previous === undefined) delete process.env.INTERVIEW_EXECUTION_MODE; else process.env.INTERVIEW_EXECUTION_MODE = previous;
    if (previousNode === undefined) delete env.NODE_ENV; else env.NODE_ENV = previousNode;
  });
}
async function reviewedJob(t: { after(fn: () => Promise<void>): void }, ownerId = 'explicit-synthetic-worker-A') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pr07a-internal-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('pr07a-internal-')); await rm(root, { recursive: true, force: true }); });
  const value = await evaluationSupplyFixture(); value.session.runtime!.owner.id = ownerId;
  const registry = reviewedSupplyRegistry(value), signer = supplySigner(); value.context.evaluationScopeRegistry = registry; pinSupplySnapshot(value.context, value.session);
  const sessions = createLocalSessionStore(root), jobs = createLocalEvaluationJobStore(root), reviews = createLocalReviewRepository(root);
  await sessions.saveContext(value.context, ownerId); await sessions.save(value.session);
  const issuedAt = new Date(Date.now() - 1000).toISOString(), expiresAt = new Date(Date.now() + 60000).toISOString();
  await publishBankScopeReview(registry, value.context, value.bank, signer.receipt({ version: 'authenticated-bank-scope-review-v1', actorId: supplyReviewer,
    registrySha256: registry.contentSha256, action: 'publish_scopes', issuedAt, expiresAt }), null, root, signer.trustedPublicKey, reviews);
  const proposal = prepareEndedSessionReview(value.context, value.session, registry), bundle = supplyRecordBundle(value.session);
  const receipt = signer.receipt({ version: 'authenticated-session-evaluation-review-v1', actorId: supplyReviewer, action: 'approve_session_evaluation',
    proposalSha256: proposal.contentSha256, bundleSha256: bundle.contentSha256, sessionId: value.session.id,
    sessionQuestionAnswerSha256: knowledgeSessionQuestionAnswerHash(value.session), contextSnapshotSha256: value.session.runtime!.contextSnapshotSha256, issuedAt, expiresAt });
  const supplied = await supplyReviewedSessionEvaluation({ ...value, root, proposal, bundle, receipt, trustedPublicKey: signer.trustedPublicKey,
    enqueue: true, sessions, jobs, reviews, model: 'explicit-synthetic-worker-model' });
  const job = (await jobs.get(supplied.jobId!))!;
  const binding: TrustedEvaluationJobBinding = { jobId: job.id, ownerId, sessionId: value.session.id, studentId: 'student-synthetic', supportTargetId: 'track-synthetic',
    sourceSha256: job.sourceSha256, snapshotSha256: job.snapshotSha256, contextSnapshotSha256: job.contextSnapshotSha256, pipelineVersion: job.pipelineVersion, model: job.model };
  return { root, jobs, sessions, reviews, job, binding, signer };
}
const result = { summary: 'Explicit synthetic provider result only', sessionScore: null, answers: [] } as unknown as Awaited<ReturnType<typeof evaluateSession>>;
function execution(binding: TrustedEvaluationJobBinding, options: { now?: number; resolve?: () => Promise<TrustedEvaluationJobBinding | null> } = {}) {
  const now = options.now ?? Date.now();
  class Scheduler {
    subjectId = 'explicit-synthetic-scheduler'; issuedAt = now - 1000; expiresAt = now + 60000; jobIds = [binding.jobId];
    private lookup = options.resolve ?? (async () => binding);
    resolveBinding() { return this.lookup(); }
  }
  return createTrustedEvaluationWorkerExecution(new Scheduler());
}

test('service worker and operator CLIs deny before queue scans, private reads, writes or provider calls', async t => {
  mode(t, 'service'); let accesses = 0;
  const jobs = new Proxy({}, { get() { accesses++; throw new Error('private repository must not be touched'); } }) as EvaluationRepository;
  await assert.rejects(runEvaluationWorkerOnce({ jobs }), /INTERNAL_AUTHORITY_REQUIRED/u);
  await assert.rejects(runEvaluationWorkerOnce({ jobs, execution: { kind: 'trusted-evaluation-worker-v1' } }), /INTERNAL_AUTHORITY_REQUIRED/u);
  await assert.rejects(prepareEvaluationScopesCli(['coverage'], '/must-not-read-private'), /INTERNAL_OPERATION_UNSUPPORTED/u);
  await assert.rejects(prepareApprovedKnowledgeCli(['--reviewed-input', 'private.json', '--reviewer', 'not-an-operator'], '/must-not-read-private'), /INTERNAL_OPERATION_UNSUPPORTED/u);
  await assert.rejects(supplyReviewedSessionEvaluation({} as Parameters<typeof supplyReviewedSessionEvaluation>[0]), /INTERNAL_OPERATION_UNSUPPORTED/u);
  assert.equal(accesses, 0);
});

test('the real worker CLI exits once with a safe unsupported response before constructing a service queue', () => {
  const script = fileURLToPath(new URL('../scripts/run-evaluation-worker.ts', import.meta.url));
  for (const execution of ['service', 'local-development']) {
    const run = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), script, '--once', '--jobs-directory', 'must-not-scan-private'], {
      env: { ...process.env, INTERVIEW_EXECUTION_MODE: execution, NODE_ENV: 'production' }, encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    assert.equal(run.error, undefined); assert.equal(run.status, 1);
    const response = JSON.parse(run.stderr.trim());
    assert.equal(response.passed, false); assert.match(response.error, /^INTERNAL_(?:OPERATION_UNSUPPORTED|EXECUTION_MODE_INVALID)$/u);
    assert.equal(run.stdout, ''); assert.ok(!run.stderr.includes('must-not-scan-private'));
  }
});

test('two explicitly bound service workers complete their own real signed A/B jobs without a global pending scan', async t => {
  mode(t, 'local-development');
  const a = await reviewedJob(t), b = await reviewedJob(t, 'explicit-synthetic-worker-B');
  process.env.INTERVIEW_EXECUTION_MODE = 'service';
  let providerCalls = 0;
  for (const value of [a, b]) {
    const scoped = new Proxy(value.jobs, { get(target, key) { if (key === 'pending') return () => { throw new Error('service must not scan'); }; const item = Reflect.get(target, key); return typeof item === 'function' ? item.bind(target) : item; } });
    const completed = await runEvaluationWorkerOnce({ root: value.root, jobs: scoped, sessions: value.sessions, reviews: value.reviews, trustedPublicKey: value.signer.trustedPublicKey,
      execution: execution(value.binding), evaluate: async () => { providerCalls++; return result; } });
    assert.equal(completed.job?.status, 'completed');
    assert.deepEqual((await value.jobs.result(completed.job!))!.evaluation, result);
  }
  assert.equal(providerCalls, 2);
});

test('wrong owner, frozen source, student or target binding is refused before lease/provider/writer mutation', async t => {
  mode(t, 'local-development'); const value = await reviewedJob(t); process.env.INTERVIEW_EXECUTION_MODE = 'service';
  let claims = 0, providers = 0;
  const jobs = new Proxy(value.jobs, { get(target, key) { if (key === 'claim') return async () => { claims++; throw new Error('unauthorized claim'); }; const item = Reflect.get(target, key); return typeof item === 'function' ? item.bind(target) : item; } });
  for (const field of ['ownerId', 'sessionId', 'studentId', 'supportTargetId', 'sourceSha256', 'snapshotSha256', 'contextSnapshotSha256', 'pipelineVersion', 'model'] as const) {
    const binding = { ...value.binding, [field]: field.endsWith('Sha256') ? 'f'.repeat(64) : 'explicit-other-value' };
    await assert.rejects(runEvaluationWorkerOnce({ root: value.root, jobs, sessions: value.sessions, execution: execution(binding),
      evaluate: async () => { providers++; return result; } }), /INTERNAL_BINDING_DENIED/u);
  }
  assert.equal(claims, 0); assert.equal(providers, 0); assert.equal((await value.jobs.get(value.job.id))!.status, 'queued');
});

test('missing or failed trusted binding cannot probe a job even when its ID is known', async t => {
  mode(t, 'local-development'); const value = await reviewedJob(t); process.env.INTERVIEW_EXECUTION_MODE = 'service'; let reads = 0;
  const jobs = new Proxy(value.jobs, { get(target, key) { if (key === 'get') return async () => { reads++; return value.job; }; const item = Reflect.get(target, key); return typeof item === 'function' ? item.bind(target) : item; } });
  await assert.rejects(runEvaluationWorkerOnce({ jobs, execution: execution(value.binding, { resolve: async () => null }) }), /INTERNAL_BINDING_DENIED/u);
  await assert.rejects(runEvaluationWorkerOnce({ jobs, execution: execution(value.binding, { resolve: async () => { throw new Error('explicit authority dependency unavailable'); } }) }), /INTERNAL_AUTHORITY_UNAVAILABLE/u);
  assert.equal(reads, 0);
});

for (const change of ['revoked', 'expired'] as const) test(`internal authority ${change} during provider work prevents result and failure writes`, async t => {
  mode(t, 'local-development'); const value = await reviewedJob(t); process.env.INTERVIEW_EXECUTION_MODE = 'service';
  let clock = Date.now(), active = true, complete = 0, fail = 0;
  const authority = execution(value.binding, { now: clock, resolve: async () => active ? value.binding : null });
  const jobs = new Proxy(value.jobs, { get(target, key) {
    if (key === 'complete') return async () => { complete++; throw new Error('unauthorized completion'); };
    if (key === 'fail') return async () => { fail++; throw new Error('unauthorized failure'); };
    const item = Reflect.get(target, key); return typeof item === 'function' ? item.bind(target) : item;
  } });
  await assert.rejects(runEvaluationWorkerOnce({ root: value.root, jobs, sessions: value.sessions, reviews: value.reviews, trustedPublicKey: value.signer.trustedPublicKey, execution: authority, now: () => clock,
    evaluate: async () => { if (change === 'revoked') active = false; else clock += 60000; return result; } }), /INTERNAL_BINDING_DENIED|INTERNAL_AUTHORITY_EXPIRED/u);
  assert.equal(complete, 0); assert.equal(fail, 0); assert.equal((await value.jobs.get(value.job.id))!.status, 'running');
});

test('internal worker capability cannot replace the existing A/B evaluation gate or enable its test bypass seams', async t => {
  mode(t, 'local-development'); const value = await reviewedJob(t); process.env.INTERVIEW_EXECUTION_MODE = 'service';
  let providers = 0;
  await assert.rejects(runEvaluationWorkerOnce({ jobs: value.jobs, execution: execution(value.binding), reviewReadiness: () => ({ readyCount: 1, unitCount: 1, held: [], invalid: [] }) }), /INTERNAL_OPERATION_UNSUPPORTED/u);
  // Removing the actual current A registry prevents the existing signed B from
  // passing, even though the scheduler's ownership capability remains valid.
  const reviews = { ...value.reviews, readRegistryPointer: async (): Promise<string> => { throw Object.assign(new Error('explicit synthetic missing registry'), { code: 'ENOENT' }); } };
  const waiting = await runEvaluationWorkerOnce({ root: value.root, jobs: value.jobs, sessions: value.sessions, reviews, trustedPublicKey: value.signer.trustedPublicKey, execution: execution(value.binding),
    evaluate: async () => { providers++; return result; } });
  assert.equal(waiting.job?.status, 'review_required'); assert.equal(providers, 0);
});
