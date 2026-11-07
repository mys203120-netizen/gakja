import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthenticatedSessionRuntime, snapshotHash } from '../../server/session-runtime';
import { prepareEndedSessionReview, validateReviewedSessionEvaluationInput, supplyReviewedSessionEvaluation, verifyStoredSessionEvaluationReviewFromReaders } from '../../server/evaluation-supply';
import { createReviewedEvaluationKnowledgeContext } from '../../server/data/reviewed-evaluation-context';
import { knowledgeHash, knowledgeSessionQuestionAnswerHash } from '../../server/data/approved-knowledge';
import { prepareReviewedEvaluationJobInput } from '../../server/reviewed-evaluation-queue';
import { prepareReviewedEvaluationRevisionReference, parseReviewedEvaluationRevisionReference } from '../../server/evaluation-revisions';
import { evaluationFrozenInputHash } from '../../server/evaluation-history';
import { createTrustedAuthenticatedEvaluationWorkerExecution } from '../../server/internal-execution';
import { runEvaluationWorkerOnce } from '../../server/evaluation-worker';
import type { EvaluationWorkerJobs } from '../../server/evaluation-writer/evaluation-writer-ports';
import type { EvaluationJob } from '../../server/evaluation-job-store';
import { evaluateSession } from '../../server/providers/openai';
import { normalizeProviderUsage } from '../../server/observability/provider-cost';
import { evaluationSupplyFixture, reviewedSupplyRegistry, supplyRecordBundle, supplyReviewer, supplySigner } from '../fixtures/evaluation-supply';

const model = 'explicit-synthetic-f-evaluation-model';
function serviceMode(t: { after(fn: () => void): void }) {
  const old = process.env.INTERVIEW_EXECUTION_MODE;
  process.env.INTERVIEW_EXECUTION_MODE = 'service';
  t.after(() => { if (old === undefined) delete process.env.INTERVIEW_EXECUTION_MODE; else process.env.INTERVIEW_EXECUTION_MODE = old; });
}
async function fixture() {
  const value = await evaluationSupplyFixture(), prior = value.session.runtime!;
  value.session.runtime = { ...createAuthenticatedSessionRuntime(value.context, prior.owner.id, value.session.createdAt),
    endRequestedAt: prior.endRequestedAt, evaluationInputFrozenAt: prior.evaluationInputFrozenAt, acceptedEndRequest: prior.acceptedEndRequest };
  const registry = reviewedSupplyRegistry(value), signer = supplySigner(), issuedAt = new Date(Date.now() - 1000).toISOString(), expiresAt = new Date(Date.now() + 60_000).toISOString();
  const registryReceipt = signer.receipt({ version: 'authenticated-bank-scope-review-v1', actorId: supplyReviewer, registrySha256: registry.contentSha256,
    action: 'publish_scopes', issuedAt, expiresAt });
  const proposal = prepareEndedSessionReview(value.context, value.session, registry), bundle = supplyRecordBundle(value.session);
  const receipt = signer.receipt({ version: 'authenticated-session-evaluation-review-v1', actorId: supplyReviewer, action: 'approve_session_evaluation',
    proposalSha256: proposal.contentSha256, bundleSha256: bundle.contentSha256, sessionId: value.session.id,
    sessionQuestionAnswerSha256: knowledgeSessionQuestionAnswerHash(value.session), contextSnapshotSha256: value.session.runtime!.contextSnapshotSha256, issuedAt, expiresAt });
  const validated = validateReviewedSessionEvaluationInput({ ...value, proposal, bundle, receipt, currentRegistry: registry, trustedPublicKey: signer.trustedPublicKey });
  const receiptSha256 = snapshotHash(receipt), content = JSON.stringify(bundle, null, 2);
  const projection = createReviewedEvaluationKnowledgeContext(value.context, value.session, validated.bundle, {
    path: 'evaluation-db-artifact-v1:' + bundle.contentSha256, fileSha256: knowledgeHash(content), sessionReviewReceiptSha256: receiptSha256,
    evaluationSpecRegistrySha256: registry.contentSha256, evaluationSpecRegistry: registry });
  const registration = prepareReviewedEvaluationJobInput(projection.context, value.session, value.context, model);
  const job: EvaluationJob = { version: 1, id: registration.jobId, sessionId: value.session.id, ownerId: value.session.runtime!.owner.id,
    pipelineVersion: registration.pipelineVersion, model, sourceSha256: registration.sourceSha256, snapshotSha256: registration.snapshotSha256,
    contextSnapshotSha256: registration.contextSnapshotSha256, status: 'queued', attempts: 0, createdAt: issuedAt, updatedAt: issuedAt,
    nextRetryAt: null, lease: null, checkpoints: [], usage: [], error: null, resultSha256: null };
  const scope = { ownerId: job.ownerId, studentId: value.context.student.studentId!, applicationTargetId: 'synthetic-personal-application',
    supportTargetId: value.context.targetAnalysis?.supportTargetId ?? value.context.school.interview!.id };
  const readers = { trustedPublicKey: signer.trustedPublicKey,
    async loadContext(hash: string, owner: string) { assert.equal(owner, job.ownerId); if (hash === snapshotHash(value.context)) return value.context; if (hash === registration.contextSnapshotSha256) return registration.context; throw new Error('UNKNOWN_SYNTHETIC_CONTEXT'); },
    reviews: { async readSessionReceipt(hash: string) { assert.equal(hash, receiptSha256); return JSON.stringify({ receipt, proposal }); },
      async readRegistryPointer() { return JSON.stringify({ contentSha256: registry.contentSha256 }); },
      async readRegistryRevision(hash: string) { assert.equal(hash, registry.contentSha256); return JSON.stringify({ registry, receipt: registryReceipt }); } } };
  const binding = { ...scope, jobId: job.id, sessionId: job.sessionId, sourceSha256: job.sourceSha256, snapshotSha256: job.snapshotSha256,
    contextSnapshotSha256: job.contextSnapshotSha256, pipelineVersion: job.pipelineVersion, model };
  const execution = () => createTrustedAuthenticatedEvaluationWorkerExecution({ subjectId: 'synthetic-f-worker', issuedAt: Date.now() - 1000,
    expiresAt: Date.now() + 60_000, jobIds: [job.id], scope, async resolveBinding() { return binding; } });
  return { ...value, registry, signer, proposal, bundle, receipt: validated.receipt, receiptSha256, projection, registration, job, scope, readers, binding, execution };
}
function modelOutput(turnId: string, transcript: string) {
  const axis = { anchor: 2, quote: transcript, rationale: '실제 확정 답변의 범위에 한정한 합성 결과다.' };
  return { summary: '모델 I/O만 교체한 명시적 합성 평가', languageClassifications: [], answers: [{ turnId, status: 'PARTIAL', deferredReason: null,
    axes: { I: axis, A: axis, S: axis, R: axis, C: axis }, verifiedCoreError: false, verifiedCoreErrorEvidence: null,
    strengths: [], improvements: [], conflictNeedsReview: [], deliveryCoaching: [], strategyCoaching: [] }] };
}

test('F pure signed supply preserves the frozen original and local supply still refuses authenticated sessions', async t => {
  const value = await fixture(), original = JSON.stringify(value.session), base = JSON.stringify(value.context);
  assert.equal(value.session.runtime!.owner.mode, 'authenticated');
  assert.equal(value.registration.session.runtime!.contextSnapshotSha256, value.registration.contextSnapshotSha256);
  assert.equal(JSON.stringify(value.session), original); assert.equal(JSON.stringify(value.context), base);
  const old = process.env.INTERVIEW_EXECUTION_MODE; process.env.INTERVIEW_EXECUTION_MODE = 'local-development';
  t.after(() => { if (old === undefined) delete process.env.INTERVIEW_EXECUTION_MODE; else process.env.INTERVIEW_EXECUTION_MODE = old; });
  let writes = 0;
  await assert.rejects(supplyReviewedSessionEvaluation({ ...value, currentRegistry: value.registry, trustedPublicKey: value.signer.trustedPublicKey,
    reviews: new Proxy({}, { get() { writes++; throw new Error('NO_LOCAL_REVIEW_IO'); } }) as never }), /SESSION_OWNER_MISMATCH/u);
  assert.equal(writes, 0);
});

test('F reviewed context/receipt lineage uses the existing job ID and reference hashes without rewriting E input', async () => {
  const value = await fixture(), original = JSON.stringify(value.session);
  const reference = prepareReviewedEvaluationRevisionReference({ originalSession: value.session, job: value.job, receiptSha256: value.receiptSha256,
    receiptIssuedAt: String(value.receipt.issuedAt), originalContextSnapshotSha256: value.session.runtime!.contextSnapshotSha256,
    reviewedContextSnapshotSha256: value.registration.contextSnapshotSha256, sessionFrozenInputSha256: evaluationFrozenInputHash(value.session) });
  assert.deepEqual(parseReviewedEvaluationRevisionReference(reference), reference);
  assert.equal(prepareReviewedEvaluationJobInput(value.projection.context, value.session, value.context, model).jobId, value.job.id);
  const changed = structuredClone(value.projection.context); changed.manifest.recordIds.sessionReviewReceiptSha256 = 'a'.repeat(64);
  assert.notEqual(prepareReviewedEvaluationJobInput(changed, value.session, value.context, model).jobId, value.job.id);
  assert.throws(() => parseReviewedEvaluationRevisionReference({ ...reference, receiptSha256: 'b'.repeat(64) }), /REFERENCE_CHANGED/u);
  const otherBase = structuredClone(value.context); otherBase.questionGuidelines += '\n다른 원문';
  assert.throws(() => prepareReviewedEvaluationJobInput(value.projection.context, value.session, otherBase, model), /BASE_CONTEXT_CHANGED/u);
  assert.equal(JSON.stringify(value.session), original);
});

test('F stored receipt verification retains issued-time validity; expired supply is not automatically reissued', async () => {
  const value = await fixture(), later = Date.now() + 3_600_000;
  assert.equal(await verifyStoredSessionEvaluationReviewFromReaders(value.registration.context, value.registration.session, { ...value.readers, now: () => later }), true);
  assert.throws(() => validateReviewedSessionEvaluationInput({ ...value, currentRegistry: value.registry, trustedPublicKey: value.signer.trustedPublicKey, now: later }), /RECEIPT_REQUIRED/u);
  assert.equal(snapshotHash(value.receipt), value.receiptSha256);
});

test('F finite authenticated worker binds personal target separately and never accesses a directory or global queue', async t => {
  serviceMode(t); const value = await fixture(); let reads = 0;
  assert.throws(() => createTrustedAuthenticatedEvaluationWorkerExecution({ subjectId: 'bad-scope', issuedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000,
    jobIds: [value.job.id], scope: {} as never, async resolveBinding() { return value.binding; } }), /INTERNAL_AUTHORITY_REQUIRED/u);
  const jobs = new Proxy({}, { get(_target, key) { if (key === 'get') return async () => { reads++; return null; }; throw new Error('FORBIDDEN_WORKER_METADATA:' + String(key)); } }) as EvaluationWorkerJobs;
  const empty = await runEvaluationWorkerOnce({ jobs, execution: value.execution(), reviewInputs: value.readers });
  assert.equal(empty.processed, false); assert.equal(reads, 1);
  const other = createTrustedAuthenticatedEvaluationWorkerExecution({ subjectId: 'synthetic-other', issuedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000,
    jobIds: [value.job.id], scope: value.scope, async resolveBinding() { return { ...value.binding, applicationTargetId: value.scope.supportTargetId }; } });
  await assert.rejects(runEvaluationWorkerOnce({ jobs, execution: other, reviewInputs: value.readers }), /INTERNAL_BINDING_DENIED/u);
  assert.equal(reads, 1);
  await assert.rejects(runEvaluationWorkerOnce({ jobs, execution: value.execution(), reviewInputs: value.readers, evaluate: async () => { throw new Error('WHOLE_ENGINE_STUB_FORBIDDEN'); } }), /INTERNAL_OPERATION_UNSUPPORTED/u);
});

test('F actual evaluator refuses ignored-abort model responses before parsing and checkpoint publication', async () => {
  const value = await fixture(), controller = new AbortController(), reason = new Error('synthetic-cancel'); let release!: (value: unknown) => void, called!: () => void, checkpoints = 0;
  const started = new Promise<void>(resolve => { called = resolve; });
  const pending = evaluateSession(value.registration.context, value.registration.session, { model, signal: controller.signal,
    requestEvaluation: async request => { assert.equal(request.signal, controller.signal); called(); return new Promise(resolve => { release = resolve; }); },
    onClusterComplete() { checkpoints++; } });
  await started; controller.abort(reason); release({ deliberately: 'invalid late model response' });
  await assert.rejects(pending, error => error === reason); assert.equal(checkpoints, 0);
});

test('F worker aborts its in-flight real evaluator when the DB lease is lost', async t => {
  serviceMode(t); const value = await fixture(); let calls = 0, completions = 0, failures = 0, checkpoints = 0, release!: (value: unknown) => void;
  let current = structuredClone(value.job); let lost = false;
  const jobs: EvaluationWorkerJobs = { async get() { return current; }, async snapshot() { return value.registration.snapshot; },
    async claim(_id, workerId) { current = { ...current, status: 'running', attempts: 1, lease: { token: 'synthetic-lease-token', workerId, expiresAt: new Date(Date.now() + 300).toISOString() } }; return current; },
    async renew() { if (lost) throw new Error('EVALUATION_LEASE_LOST'); return current; },
    async checkpoint() { checkpoints++; return current; }, async recordUsage() { return current; },
    async complete() { completions++; return current; }, async requireReview() { assert.fail('valid exact A/B must reach the evaluator'); },
    async fail() { failures++; return current; } };
  const pending = runEvaluationWorkerOnce({ jobs, leaseMs: 300, execution: value.execution(), reviewInputs: value.readers,
    requestEvaluation: async () => { calls++; lost = true; return new Promise(resolve => { release = resolve; }); } });
  const result = await pending; assert.equal(result.processed, true); assert.equal(calls, 1); assert.equal(completions, 0); assert.equal(failures, 0); assert.equal(checkpoints, 0);
  release(modelOutput(value.turn.id, value.turn.rawTranscript!)); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(completions, 0); assert.equal(checkpoints, 0);
});


test('F actual worker parses and aggregates a raw model response and persists normalized provider usage', async t => {
  serviceMode(t); const value = await fixture(); let current = structuredClone(value.job), calls = 0, checkpoints = 0, usage = 0;
  let result: Awaited<ReturnType<typeof evaluateSession>> | undefined;
  const jobs: EvaluationWorkerJobs = { async get() { return current; }, async snapshot() { return value.registration.snapshot; },
    async claim(_id, workerId) { current = { ...current, status: 'running', attempts: 1, lease: { token: 'synthetic-lease-token', workerId, expiresAt: new Date(Date.now() + 60_000).toISOString() } }; return current; },
    async renew() { return current; }, async checkpoint(_id, _token, checkpoint) { checkpoints++; assert.equal(checkpoint.version, value.job.pipelineVersion); return current; },
    async recordUsage(_id, _token, attemptId, observation) { usage++; assert.equal(attemptId, value.job.id + ':1:0'); assert.equal(observation.validity, 'complete'); assert.equal(observation.usage?.input_tokens, 123); return current; },
    async complete(_id, _token, evaluation) { result = evaluation as typeof result; current = { ...current, status: 'completed' }; return current; },
    async requireReview() { assert.fail('exact signed input is ready'); }, async fail(_id, _token, error) { assert.fail('valid raw provider fixture failed: ' + JSON.stringify(error)); } };
  const completed = await runEvaluationWorkerOnce({ jobs, execution: value.execution(), reviewInputs: value.readers,
    requestEvaluation: async (_request, execution) => { calls++; execution?.onProviderUsage?.(normalizeProviderUsage({ model, usage: { input_tokens: 123, output_tokens: 45, total_tokens: 168, input_tokens_details: { cached_tokens: 0 } } }, { requestedModel: model }));
      return modelOutput(value.turn.id, value.turn.rawTranscript!); } });
  assert.equal(completed.job?.status, 'completed'); assert.equal(calls, 1); assert.equal(checkpoints, 1); assert.equal(usage, 1);
  assert.ok(result); assert.equal(result.answers.length, 1); assert.equal(result.answers[0].turnId, value.turn.id);
  assert.ok('evaluationPipeline' in result); assert.equal(result.evaluationPipeline.model, model); assert.equal(result.evaluationPipeline.version, value.job.pipelineVersion);
  assert.equal(typeof result.answers[0].score, 'number'); assert.ok(result.clusterScores.length);
});


test('F stored A and B signatures may use different explicit trusted keys without substituting either authority', async () => {
  const value = await fixture(), aSigner = supplySigner();
  const aReceipt = aSigner.receipt({ version: 'authenticated-bank-scope-review-v1', actorId: supplyReviewer,
    registrySha256: value.registry.contentSha256, action: 'publish_scopes', issuedAt: value.receipt.issuedAt, expiresAt: value.receipt.expiresAt });
  const readers = { ...value.readers, reviews: { ...value.readers.reviews,
    async readRegistryRevision(hash: string) { assert.equal(hash, value.registry.contentSha256); return JSON.stringify({ registry: value.registry, receipt: aReceipt }); } } };
  assert.equal(await verifyStoredSessionEvaluationReviewFromReaders(value.registration.context, value.registration.session, readers), false);
  assert.equal(await verifyStoredSessionEvaluationReviewFromReaders(value.registration.context, value.registration.session, { ...readers, trustedRegistryPublicKey: aSigner.trustedPublicKey }), true);
});


test('F finite worker delegates running eligibility to the DB claim even when local lease metadata looks future-dated', async t => {
  serviceMode(t); const value = await fixture(); let claims = 0;
  const current = { ...value.job, status: 'running' as const, lease: { token: 'other-worker-token', workerId: 'other-worker', expiresAt: new Date(Date.now() + 600_000).toISOString() } };
  const jobs = { async get() { return current; }, async snapshot() { return value.registration.snapshot; },
    async claim() { claims++; return null; } } as unknown as EvaluationWorkerJobs;
  const result = await runEvaluationWorkerOnce({ jobs, execution: value.execution(), reviewInputs: value.readers });
  assert.equal(claims, 1); assert.equal(result.processed, false);
});
