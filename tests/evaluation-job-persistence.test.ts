import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLocalEvaluationJobStore, EvaluationJobStore, evaluationJobId, type EvaluationRepository } from '../server/evaluation-job-store';
import { createLocalEvaluationJobPersistence } from '../server/repositories/local-evaluation-job-persistence';
import type { EvaluationJobPersistence } from '../server/repositories/evaluation-job-ports';
import type { InterviewSession } from '../server/protocol';
import { createSessionRuntime, snapshotHash } from '../server/session-runtime';
import { loadInterviewContext } from './fixtures/runtime-context';

async function workspace(t: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evaluation-job-persistence-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('evaluation-job-persistence-')); await rm(root, { recursive: true, force: true }); });
  return root;
}
async function fixture() {
  const context = await loadInterviewContext(), at = '2026-11-06T00:00:00.000Z';
  const session: InterviewSession = { id: '11111111-1111-4111-8111-111111111111', createdAt: at, updatedAt: at, status: 'ending', evaluationStatus: 'pending',
    target: context.target, sourceManifest: context.manifest, turns: [], elapsedMs: 123, followUpCountByMainQuestion: {},
    runtime: createSessionRuntime(context, { id: 'explicit-synthetic-job-owner', mode: 'local-development' }, at) };
  return { context, session, now: Date.parse(at), source: 'b'.repeat(64), pipeline: 'explicit-synthetic-pipeline', model: 'explicit-synthetic-model' };
}

test('existing EvaluationJobStore uses injected local persistence and preserves domain identities and publication order', async t => {
  const root = await workspace(t), value = await fixture(), directory = path.join(root, 'data/evaluation-jobs'), local = createLocalEvaluationJobPersistence(directory);
  const calls: string[] = [];
  const persistence: EvaluationJobPersistence = {
    read: reference => { calls.push(`read:${reference.kind}`); return local.read(reference); },
    listJobIds: () => { calls.push('list'); return local.listJobIds(); },
    atomic: (reference, payload) => { calls.push(`atomic:${reference.kind}`); return local.atomic(reference, payload); },
    locked: (id, operation) => { calls.push('locked'); return local.locked(id, operation); },
  };
  const jobs: EvaluationRepository = createLocalEvaluationJobStore(root, { persistence });
  const job = await jobs.enqueue(value.session, value.source, value.pipeline, value.now, value.model);
  assert.equal(job.id, evaluationJobId(value.session.id, value.session.runtime!.owner.id, value.source, value.pipeline));
  assert.deepEqual(calls, ['locked', 'read:job', 'atomic:snapshot', 'atomic:job']);
  assert.equal(job.snapshotSha256, snapshotHash(await jobs.snapshot(job)));
  assert.deepEqual(await jobs.enqueue(value.session, value.source, value.pipeline, value.now + 1, value.model), job);
  assert.equal(calls.filter(call => call === 'atomic:snapshot').length, 1);
  const claimed = await jobs.claim(job.id, 'explicit-synthetic-worker', value.now, 1000); assert.ok(claimed?.lease);
  assert.equal(await jobs.claim(job.id, 'another-worker', value.now + 999, 1000), null);
  const lease = claimed.lease.token;
  const waiting = await jobs.requireReview(job.id, lease, ['NO_APPROVAL', 'NO_APPROVAL', 'HELD_F']);
  assert.equal(waiting.status, 'review_required'); assert.equal(waiting.error?.message, 'NO_APPROVAL,HELD_F');
  assert.deepEqual(await jobs.pending(value.now + 10_000), []);
  await assert.rejects(jobs.complete(job.id, lease, { forbidden: 'stale result' }), /EVALUATION_LEASE_LOST/u);
  assert.deepEqual(await readFile(path.join(directory, `${job.id}.job.json`)), Buffer.from(JSON.stringify(waiting)));
  assert.deepEqual(await new EvaluationJobStore(directory).get(job.id), waiting);
});

test('partial result/job publication failure remains visible as running and cannot falsely expose a completed result', async t => {
  const root = await workspace(t), value = await fixture(), directory = path.join(root, 'data/evaluation-jobs'), local = createLocalEvaluationJobPersistence(directory);
  let rejectJobPublication = false;
  const failure = Object.assign(new Error('EXPLICIT_SYNTHETIC_JOB_PUBLICATION_FAILURE'), { code: 'ENOSPC' });
  const persistence: EvaluationJobPersistence = { ...local, async atomic(reference, payload) { if (rejectJobPublication && reference.kind === 'job') { rejectJobPublication = false; throw failure; } await local.atomic(reference, payload); } };
  const jobs = createLocalEvaluationJobStore(root, { persistence }), job = await jobs.enqueue(value.session, value.source, value.pipeline, value.now, value.model);
  const claimed = await jobs.claim(job.id, 'explicit-synthetic-worker', value.now, 1000); assert.ok(claimed?.lease);
  const originalSnapshot = await readFile(path.join(directory, `${job.id}.snapshot.json`));
  rejectJobPublication = true;
  await assert.rejects(jobs.complete(job.id, claimed.lease.token, { sessionScore: null, synthetic: true }), error => error === failure);
  const running = await jobs.get(job.id); assert.equal(running?.status, 'running');
  assert.equal(await jobs.result(running!), null);
  assert.ok((await readFile(path.join(directory, `${job.id}.result.json`))).length);
  const recovered = await jobs.claim(job.id, 'replacement-worker', value.now + 1001, 1000); assert.ok(recovered?.lease);
  await assert.rejects(jobs.complete(job.id, claimed.lease.token, {}), /EVALUATION_LEASE_LOST/u);
  const complete = await jobs.complete(job.id, recovered.lease.token, { sessionScore: null, synthetic: true });
  assert.equal(complete.status, 'completed'); assert.deepEqual((await jobs.result(complete))!.evaluation, { sessionScore: null, synthetic: true });
  assert.deepEqual(await readFile(path.join(directory, `${job.id}.snapshot.json`)), originalSnapshot);
});

test('local job reads remain fresh, corruption diagnostics preserve raw bytes and physical references reject traversal', async t => {
  const root = await workspace(t), value = await fixture(), jobs = createLocalEvaluationJobStore(root), local = createLocalEvaluationJobPersistence(jobs.directory);
  const job = await jobs.enqueue(value.session, value.source, value.pipeline, value.now, value.model), file = path.join(jobs.directory, `${job.id}.job.json`);
  assert.equal((await jobs.get(job.id))!.status, 'queued');
  const damaged = Buffer.from('{explicit synthetic invalid JSON'); await writeFile(file, damaged);
  await assert.rejects(jobs.get(job.id), SyntaxError);
  assert.deepEqual(await jobs.pending(value.now), []);
  assert.deepEqual(await readFile(file), damaged);
  const diagnostic = JSON.parse((await local.read({ id: job.id, kind: 'quarantine' })).toString('utf8'));
  assert.equal(diagnostic.originalPreserved, true); assert.equal(diagnostic.automaticRepair, false);
  assert.throws(() => local.read({ id: '../escape', kind: 'job' }), /EVALUATION_JOB_ID_INVALID/u);
  assert.throws(() => local.read({ id: job.id, kind: '../escape' as 'job' }), /EVALUATION_DOCUMENT_KIND_INVALID/u);
});
