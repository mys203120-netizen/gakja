import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendReviewedEvaluationRevision, loadReviewedEvaluationRevision, retryReviewedEvaluationRevision } from '../server/evaluation-revisions';
import { evaluationFrozenInputHash } from '../server/evaluation-history';
import { EVALUATION_PIPELINE_VERSION, evaluationSessionSourceFingerprint } from '../server/providers/evaluation-input';
import { prepareEndedSessionReview, supplyReviewedSessionEvaluation } from '../server/evaluation-supply';
import { publishBankScopeReview, sealBankScopeRegistry } from '../server/data/evaluation-scope-registry';
import { knowledgeSessionQuestionAnswerHash } from '../server/data/approved-knowledge';
import { enqueueReviewedKnowledgeEvaluation, runEvaluationWorkerOnce } from '../server/evaluation-worker';
import { EvaluationJobStore } from '../server/evaluation-job-store';
import { LocalSessionStore } from '../server/storage/local-session-store';
import { evaluationSupplyFixture, pinSupplySnapshot, reviewedSupplyRegistry, supplyRecordBundle, supplyReviewer } from './fixtures/evaluation-supply';
import type { evaluateSession } from '../server/providers/openai';
import { prepareEvaluationScopesCli } from '../scripts/prepare-evaluation-scopes';

function cliOwner(t: TestContext, ownerId: string) {
  const previous = process.env.LOCAL_INTERVIEW_OWNER_ID; process.env.LOCAL_INTERVIEW_OWNER_ID = ownerId;
  t.after(() => { if (previous === undefined) delete process.env.LOCAL_INTERVIEW_OWNER_ID; else process.env.LOCAL_INTERVIEW_OWNER_ID = previous; });
}

async function setup(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reviewed-evaluation-revision-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('reviewed-evaluation-revision-')); await rm(root, { recursive: true, force: true }); });
  const value = await evaluationSupplyFixture(), registry = reviewedSupplyRegistry(value), keys = generateKeyPairSync('ed25519');
  const trustedPublicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const priorKey = process.env.EVALUATION_SCOPE_REVIEW_PUBLIC_KEY;
  process.env.EVALUATION_SCOPE_REVIEW_PUBLIC_KEY = trustedPublicKey;
  t.after(() => { if (priorKey === undefined) delete process.env.EVALUATION_SCOPE_REVIEW_PUBLIC_KEY; else process.env.EVALUATION_SCOPE_REVIEW_PUBLIC_KEY = priorKey; });
  const signed = (payload: Record<string, unknown>) => ({ ...payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), keys.privateKey).toString('base64') });
  const issuedAt = new Date(Date.now() - 1000).toISOString(), expiresAt = new Date(Date.now() + 60000).toISOString();
  value.context.evaluationScopeRegistry = registry; pinSupplySnapshot(value.context, value.session);
  const proposal = prepareEndedSessionReview(value.context, value.session, registry), bundle = supplyRecordBundle(value.session);
  await publishBankScopeReview(registry, value.context, value.bank, signed({ version: 'authenticated-bank-scope-review-v1', actorId: supplyReviewer,
    registrySha256: registry.contentSha256, action: 'publish_scopes', issuedAt, expiresAt }), null, root, trustedPublicKey);
  const receipt = signed({ version: 'authenticated-session-evaluation-review-v1', actorId: supplyReviewer,
    action: 'approve_session_evaluation', proposalSha256: proposal.contentSha256, bundleSha256: bundle.contentSha256,
    sessionId: value.session.id, sessionQuestionAnswerSha256: knowledgeSessionQuestionAnswerHash(value.session),
    contextSnapshotSha256: value.session.runtime!.contextSnapshotSha256, issuedAt, expiresAt });
  const sessions = new LocalSessionStore(path.join(root, 'data/sessions')), jobs = new EvaluationJobStore(path.join(root, 'data/evaluation-jobs'));
  await sessions.saveContext(value.context, value.session.runtime!.owner.id); await sessions.save(value.session);
  const originalFile = path.join(root, 'data/sessions', `${value.session.id}.json`), originalBytes = await readFile(originalFile);
  const supplied = await supplyReviewedSessionEvaluation({ ...value, root, proposal, bundle, receipt, trustedPublicKey, currentRegistry: registry, enqueue: false });
  const queued = await enqueueReviewedKnowledgeEvaluation(supplied.context, value.session, { jobs, sessions, model: 'synthetic-reviewed-revision-model' });
  const appendOptions = { root, originalSession: value.session, job: queued.job, receiptSha256: supplied.receiptSha256,
    receiptIssuedAt: issuedAt, originalContextSnapshotSha256: queued.originalContextSnapshotSha256,
    reviewedContextSnapshotSha256: queued.contextSnapshotSha256, sessionFrozenInputSha256: evaluationFrozenInputHash(value.session), jobs, sessions, trustedPublicKey };
  const record = await appendReviewedEvaluationRevision(appendOptions);
  const readOptions = { root, session: value.session, ownerId: value.session.runtime!.owner.id, jobs, sessions, trustedPublicKey };
  return { ...value, registry, proposal, bundle, root, trustedPublicKey, signed, sessions, jobs, originalFile, originalBytes, supplied, queued, record, appendOptions, readOptions, issuedAt, expiresAt };
}
const evaluation = { summary: 'actual worker persisted this explicit synthetic reviewed result', answers: [], sessionScore: null } as unknown as Awaited<ReturnType<typeof evaluateSession>>;

test('signed reviewed job becomes readable through its real worker result without replacing the original session reference or bytes', async t => {
  const value = await setup(t), original = JSON.stringify(value.session), originalRuntimeReference = value.session.runtime!.evaluationJob;
  const waiting = await loadReviewedEvaluationRevision(value.readOptions); assert.equal(waiting?.status, 'pending'); assert.equal(waiting?.evaluation, undefined);
  let providerCalls = 0;
  const worked = await runEvaluationWorkerOnce({ jobs: value.jobs, sessions: value.sessions, evaluate: async () => { providerCalls++; return evaluation; } });
  assert.equal(worked.job?.id, value.queued.job.id); assert.equal(worked.job?.status, 'completed'); assert.equal(providerCalls, 1);
  const result = await loadReviewedEvaluationRevision(value.readOptions); assert.equal(result?.status, 'completed'); assert.deepEqual(result?.evaluation, evaluation); assert.equal(result?.jobId, worked.job!.id);
  assert.equal(value.session.runtime!.evaluationJob, originalRuntimeReference); assert.equal(JSON.stringify(value.session), original); assert.deepEqual(await readFile(value.originalFile), value.originalBytes);
});

test('coverage CLI reads the verified reviewed job snapshot before and after its worker result instead of the unbound original context', async t => {
  const value = await setup(t); cliOwner(t, value.session.runtime!.owner.id);
  assert.equal((value.context.approvedKnowledge?.bindings ?? []).length, 0);
  const coverage = () => prepareEvaluationScopesCli(['coverage', '--session-id', value.session.id], value.root, { trustedPublicKey: value.trustedPublicKey });
  const waiting = await coverage(); assert.ok('snapshotScope' in waiting);
  assert.equal(waiting.snapshotScope, 'verified_reviewed_evaluation_revision'); assert.equal(waiting.boundCount, 1); assert.equal(waiting.gatePassedCount, 1);
  await runEvaluationWorkerOnce({ jobs: value.jobs, sessions: value.sessions, evaluate: async () => evaluation });
  const completed = await coverage(); assert.ok('snapshotScope' in completed);
  assert.equal(completed.snapshotScope, 'verified_reviewed_evaluation_revision'); assert.equal(completed.boundCount, 1); assert.equal(completed.gatePassedCount, 1);
  assert.deepEqual(await readFile(value.originalFile), value.originalBytes);
});

test('duplicate append is deterministic and a different equal-order reviewed job conflicts without silently replacing the chosen revision', async t => {
  const value = await setup(t), duplicate = await appendReviewedEvaluationRevision(value.appendOptions); assert.deepEqual(duplicate, value.record);
  const directory = path.join(value.root, 'data/evaluation-revisions'); assert.equal((await readdir(directory)).length, 1);
  const second = await enqueueReviewedKnowledgeEvaluation(value.supplied.context, value.session, { jobs: value.jobs, sessions: value.sessions, model: 'another-explicit-synthetic-model' });
  await assert.rejects(appendReviewedEvaluationRevision({ ...value.appendOptions, job: second.job }), /REVISION_ORDER_CONFLICT/);
  assert.equal((await loadReviewedEvaluationRevision(value.readOptions))?.jobId, value.queued.job.id);
  assert.deepEqual(await readFile(value.originalFile), value.originalBytes);
});

test('a new signed approval receipt for unchanged proposal/bundle produces a distinct job while exact receipt retries reuse that revision', async t => {
  const value = await setup(t), issuedAt = new Date(Date.now() - 10).toISOString();
  assert.ok(Date.parse(issuedAt) > Date.parse(value.issuedAt));
  const receipt = value.signed({ version: 'authenticated-session-evaluation-review-v1', actorId: supplyReviewer,
    action: 'approve_session_evaluation', proposalSha256: value.proposal.contentSha256, bundleSha256: value.bundle.contentSha256,
    sessionId: value.session.id, sessionQuestionAnswerSha256: knowledgeSessionQuestionAnswerHash(value.session),
    contextSnapshotSha256: value.session.runtime!.contextSnapshotSha256, issuedAt, expiresAt: value.expiresAt });
  const supply = () => supplyReviewedSessionEvaluation({ context: value.context, session: value.session, root: value.root,
    proposal: value.proposal, bundle: value.bundle, receipt, trustedPublicKey: value.trustedPublicKey, currentRegistry: value.registry, enqueue: false });
  const fresh = await supply();
  assert.equal(fresh.context.approvedKnowledge!.contentSha256, value.supplied.context.approvedKnowledge!.contentSha256, 'the actual reviewed bundle did not change');
  assert.notEqual(fresh.receiptSha256, value.supplied.receiptSha256);
  const next = await enqueueReviewedKnowledgeEvaluation(fresh.context, value.session, { jobs: value.jobs, sessions: value.sessions, model: value.queued.job.model });
  assert.notEqual(next.sourceSha256, value.queued.sourceSha256, 'the signed approval identity is part of the new evaluation source');
  assert.notEqual(next.job.id, value.queued.job.id);
  const nextOptions = { ...value.appendOptions, job: next.job, receiptSha256: fresh.receiptSha256, receiptIssuedAt: issuedAt, reviewedContextSnapshotSha256: next.contextSnapshotSha256 };
  const reference = await appendReviewedEvaluationRevision(nextOptions);
  const repeatedSupply = await supply(), repeatedJob = await enqueueReviewedKnowledgeEvaluation(repeatedSupply.context, value.session, { jobs: value.jobs, sessions: value.sessions, model: value.queued.job.model });
  assert.equal(repeatedJob.job.id, next.job.id);
  assert.deepEqual(await appendReviewedEvaluationRevision({ ...nextOptions, job: repeatedJob.job }), reference);
  assert.equal((await loadReviewedEvaluationRevision(value.readOptions))?.jobId, next.job.id);
  assert.deepEqual(await readFile(value.originalFile), value.originalBytes);
});

test('changed owner, finalized answer, original context reference or stored source cannot borrow a reviewed result', async t => {
  const value = await setup(t);
  const changedAnswer = structuredClone(value.session); changedAnswer.turns[0].rawTranscript += ' 다른 답변';
  await assert.rejects(loadReviewedEvaluationRevision({ ...value.readOptions, session: changedAnswer }), /ORIGINAL_INPUT_CHANGED/);
  await assert.rejects(loadReviewedEvaluationRevision({ ...value.readOptions, ownerId: '../../other-owner' }), /SESSION_OWNER_MISMATCH/);
  const changedContext = structuredClone(value.session); changedContext.runtime!.contextSnapshotSha256 = 'f'.repeat(64);
  await assert.rejects(loadReviewedEvaluationRevision({ ...value.readOptions, session: changedContext }), /ORIGINAL_INPUT_CHANGED/);
  const stored = JSON.parse(await readFile(value.originalFile, 'utf8')); stored.turns[0].rawTranscript += ' stored change'; await writeFile(value.originalFile, JSON.stringify(stored));
  await assert.rejects(loadReviewedEvaluationRevision(value.readOptions), /ORIGINAL_INPUT_CHANGED/);
});

test('latest signed specification withdrawal suppresses a completed reviewed result instead of exposing or falling back to it', async t => {
  const value = await setup(t); cliOwner(t, value.session.runtime!.owner.id); await runEvaluationWorkerOnce({ jobs: value.jobs, sessions: value.sessions, evaluate: async () => evaluation });
  assert.equal((await loadReviewedEvaluationRevision(value.readOptions))?.status, 'completed');
  const { contentSha256: ignored, ...body } = structuredClone(value.registry); void ignored;
  body.entries[0].review = { status: 'withdrawn', authority: 'explicit_reviewed_input', approverId: supplyReviewer,
    reviewedAt: new Date().toISOString(), reason: 'Explicit synthetic withdrawal for the actual latest authority check.' };
  const withdrawn = sealBankScopeRegistry(body);
  await publishBankScopeReview(withdrawn, value.context, value.bank, value.signed({ version: 'authenticated-bank-scope-review-v1', actorId: supplyReviewer,
    registrySha256: withdrawn.contentSha256, action: 'publish_scopes', issuedAt: new Date(Date.now() - 10).toISOString(), expiresAt: value.expiresAt }), value.registry.contentSha256, value.root, value.trustedPublicKey);
  const result = await loadReviewedEvaluationRevision(value.readOptions); assert.equal(result?.status, 'review_required'); assert.equal(result?.evaluation, undefined); assert.match(result!.error!, /WITHDRAWN_OR_CHANGED/);
  const coverage = await prepareEvaluationScopesCli(['coverage', '--session-id', value.session.id], value.root, { trustedPublicKey: value.trustedPublicKey });
  assert.ok('snapshotScope' in coverage); assert.equal(coverage.snapshotScope, 'reviewed_revision_not_current'); assert.equal(coverage.boundCount, 0); assert.equal(coverage.gatePassedCount, 0); assert.equal(coverage.heldCount, 1);
  assert.deepEqual(await readFile(value.originalFile), value.originalBytes);
});

test('retry targets only the actual failed reviewed worker job and preserves the failed original job and original session bytes', async t => {
  const value = await setup(t), originalModel = 'synthetic-original-unreviewed-model';
  const originalJob = await value.jobs.enqueue(value.session, evaluationSessionSourceFingerprint(value.context, value.session, originalModel), EVALUATION_PIPELINE_VERSION, Date.now(), originalModel);
  const originalClaim = await value.jobs.claim(originalJob.id, 'explicit-synthetic-original-worker');
  await value.jobs.fail(originalJob.id, originalClaim!.lease!.token, { code: 'ORIGINAL_UNREVIEWED_FAILURE', message: 'Explicit synthetic original job failure.', retryable: false });
  const originalJobFile = path.join(value.jobs.directory, `${originalJob.id}.job.json`), beforeOriginalJob = await readFile(originalJobFile);
  let attempts = 0;
  const failure = await runEvaluationWorkerOnce({ jobs: value.jobs, sessions: value.sessions, evaluate: async () => { attempts++; throw new Error('Explicit synthetic permanent reviewed-provider failure.'); } });
  assert.equal(attempts, 1); assert.equal(failure.job?.id, value.queued.job.id); assert.equal(failure.job?.status, 'failed');
  const retried = await retryReviewedEvaluationRevision(value.readOptions);
  assert.equal(retried?.jobId, value.queued.job.id); assert.equal(retried?.status, 'pending');
  assert.equal((await value.jobs.get(value.queued.job.id))!.status, 'queued');
  assert.equal((await value.jobs.get(originalJob.id))!.status, 'failed');
  assert.deepEqual(await readFile(originalJobFile), beforeOriginalJob);
  assert.deepEqual(await readFile(value.originalFile), value.originalBytes);
  const pendingBytes = await readFile(path.join(value.jobs.directory, `${value.queued.job.id}.job.json`));
  assert.equal((await retryReviewedEvaluationRevision(value.readOptions))?.status, 'pending');
  assert.deepEqual(await readFile(path.join(value.jobs.directory, `${value.queued.job.id}.job.json`)), pendingBytes, 'an already pending reviewed revision is not retried again');
});

test('withdrawn current authority prevents retry of an otherwise failed reviewed job', async t => {
  const value = await setup(t);
  const failed = await runEvaluationWorkerOnce({ jobs: value.jobs, sessions: value.sessions, evaluate: async () => { throw new Error('Explicit synthetic permanent reviewed failure.'); } });
  assert.equal(failed.job?.status, 'failed');
  const jobFile = path.join(value.jobs.directory, `${value.queued.job.id}.job.json`), beforeJob = await readFile(jobFile);
  const { contentSha256: ignored, ...body } = structuredClone(value.registry); void ignored;
  body.entries[0].review = { status: 'withdrawn', authority: 'explicit_reviewed_input', approverId: supplyReviewer,
    reviewedAt: new Date().toISOString(), reason: 'Explicit synthetic withdrawal before retry.' };
  const withdrawn = sealBankScopeRegistry(body);
  await publishBankScopeReview(withdrawn, value.context, value.bank, value.signed({ version: 'authenticated-bank-scope-review-v1', actorId: supplyReviewer,
    registrySha256: withdrawn.contentSha256, action: 'publish_scopes', issuedAt: new Date(Date.now() - 10).toISOString(), expiresAt: value.expiresAt }), value.registry.contentSha256, value.root, value.trustedPublicKey);
  const held = await retryReviewedEvaluationRevision(value.readOptions);
  assert.equal(held?.status, 'review_required'); assert.equal(held?.evaluation, undefined);
  assert.equal((await value.jobs.get(value.queued.job.id))!.status, 'failed');
  assert.deepEqual(await readFile(jobFile), beforeJob);
  assert.deepEqual(await readFile(value.originalFile), value.originalBytes);
});

for (const suffix of ['snapshot', 'result'] as const) test(`tampered reviewed ${suffix} is denied by the authoritative job store`, async t => {
  const value = await setup(t); await runEvaluationWorkerOnce({ jobs: value.jobs, sessions: value.sessions, evaluate: async () => evaluation });
  const file = path.join(value.jobs.directory, `${value.queued.job.id}.${suffix}.json`), altered = JSON.parse(await readFile(file, 'utf8'));
  if (suffix === 'snapshot') altered.session.turns[0].rawTranscript = 'tampered reviewed snapshot'; else altered.evaluation.summary = 'tampered result';
  await writeFile(file, JSON.stringify(altered));
  await assert.rejects(loadReviewedEvaluationRevision(value.readOptions), /EVALUATION_SNAPSHOT_CHANGED|EVALUATION_RESULT_CHANGED/);
});
