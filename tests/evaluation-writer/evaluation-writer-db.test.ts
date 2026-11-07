/** Actual PostgreSQL repository tests. The signed inputs are explicit public
 * synthetic domain fixtures; full HTTP/worker/Storage proof is a separate suite. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createRequestIdentityBoundary, type AuthenticatedRequestContext, type PrincipalVerifier } from '../../server/auth/request-identity';
import { createTrustedJwtVerifier } from '../../server/auth/jose-jwt-verifier';
import { createPostgresAccountResolver } from '../../server/db/postgres-authority';
import { createPostgresSessionCommandRepository, createSessionEnrollmentCapability } from '../../server/db/postgres-session-writer';
import { createPostgresEvaluationWriter, createEvaluationTrustAdminCapability, createEvaluationReviewerCapability, createEvaluationAdmissionCapability, createEvaluationWorkerCapability, createEvaluationPreservationCapability } from '../../server/db/postgres-evaluation-writer';
import { EvaluationWriterError, type EvaluationReviewArtifact, type EvaluationConsumptionInput } from '../../server/evaluation-writer/evaluation-writer-ports';
import { evaluationReviewerKeySha256 } from '../../server/evaluation-writer/review-trust';
import { decodeSessionEvaluationHandoff } from '../../server/evaluation-writer/e-handoff-codec';
import { createAuthenticatedSessionRuntime, snapshotHash } from '../../server/session-runtime';
import { prepareEndedSessionReview, validateReviewedSessionEvaluationInput } from '../../server/evaluation-supply';
import { prepareReviewedEvaluationJobInput } from '../../server/reviewed-evaluation-queue';
import { prepareReviewedEvaluationRevisionReference } from '../../server/evaluation-revisions';
import { createReviewedEvaluationKnowledgeContext } from '../../server/data/reviewed-evaluation-context';
import { verifyBankScopeReviewReceipt } from '../../server/data/evaluation-scope-registry';
import { EVALUATION_PIPELINE_VERSION, evaluationSessionSourceFingerprint } from '../../server/providers/evaluation-input';
import { evaluationSupplyFixture, reviewedSupplyRegistry, supplyRecordBundle, supplyReviewer, supplySigner } from '../fixtures/evaluation-supply';
import { testPools, closePools } from './evaluation-writer-test-database';
import { normalizeProviderUsage } from '../../server/observability/provider-cost';

const pools = testPools(1), hash = (s: string) => createHash('sha256').update(s).digest('hex');
const keys = await generateKeyPair('ES256'), jwk = { ...await exportJWK(keys.publicKey), kid: 'f-sql', alg: 'ES256' };
const verifiers = (['a', 'b'] as const).map(who => createTrustedJwtVerifier({ issuer: `https://issuer-${who}.example`, audience: 'f-sql', algorithms: ['ES256'], jwks: { keys: [jwk] } }));
const verifier: PrincipalVerifier = { kind: 'trusted-jwt', async verify(token) { for (const v of verifiers) try { return await v.verify(token); } catch { /* explicit other synthetic issuer */ } throw new Error('F_SQL_TOKEN_INVALID'); } };
const identity = createRequestIdentityBoundary({ mode: 'service', verifier, accounts: createPostgresAccountResolver(pools.request) });
const sessions = createPostgresSessionCommandRepository({ boundary: identity, requestPool: pools.request, mappingPool: pools.mapping, environment: 'isolated-session-writer' });
const repository = createPostgresEvaluationWriter({ boundary: identity, requestPool: pools.request, mappingPool: pools.mapping, workerPool: pools.worker, environment: 'isolated-evaluation-writer' });
const contexts = new Map<string, AuthenticatedRequestContext>(), signers = new Map<string, ReturnType<typeof supplySigner>>();
const command = (payload: unknown, key = randomUUID()) => ({ key, inputSha256: snapshotHash(payload) });
const rawArtifact = (kind: EvaluationReviewArtifact['kind'], value: unknown, domainSha = snapshotHash(value)): EvaluationReviewArtifact => {
  const json = JSON.stringify(value); return { kind, contentSha256: domainSha, json, rawSha256: hash(json) };
};
const context = (who = 'a') => contexts.get(who)!;
const authority = (c: AuthenticatedRequestContext) => ({ ownerId: c.account.ownerId, ...c.scope!, expiresAt: Date.now() + 300_000,
  async checkCurrent() { try { await identity.revalidate(c); return true; } catch { return false; } } });
test.before(async () => {
  for (const who of ['a', 'b'] as const) {
    const token = await new SignJWT().setProtectedHeader({ alg: 'ES256', kid: jwk.kid }).setIssuer(`https://issuer-${who}.example`).setSubject('shared').setAudience('f-sql').setExpirationTime('1h').sign(keys.privateKey);
    contexts.set(who, identity.selectScope(await identity.authenticate('Bearer ' + token), { applicationTargetId: 'app-' + who }) as AuthenticatedRequestContext);
    signers.set(who, supplySigner());
  }
});
test.after(async () => { await closePools(pools); });

async function ended(who = 'a') {
  const c = context(who), fixture = await evaluationSupplyFixture(), { context: data, session } = fixture;
  data.student = { ...data.student, studentId: c.scope!.studentId };
  if (data.targetAnalysis) data.targetAnalysis = { ...data.targetAnalysis, supportTargetId: c.scope!.supportTargetId };
  else data.school = { ...data.school, interview: { ...data.school.interview!, id: c.scope!.supportTargetId } };
  session.runtime = createAuthenticatedSessionRuntime(data, c.account.ownerId);
  session.sourceManifest = structuredClone(data.manifest); session.status = 'active'; session.evaluationStatus = 'pending';
  const contextJson = JSON.stringify(data), model = 'synthetic-f-sql-model';
  const pinsJson = JSON.stringify({ sessionAuthority: { sessionId: session.id, ownerId: c.account.ownerId, ...c.scope! }, models: { evaluation: model }, runtimeVersion: session.runtime.version, evaluationPipeline: EVALUATION_PIPELINE_VERSION });
  const input = { sessionId: session.id, creationKey: randomUUID(), inputSha256: hash(session.id), sessionJson: JSON.stringify(session), contextJson, pinsJson, sourceSha256: fixture.bank.sourceFingerprint,
    ...(Object.hasOwn(c.scope!, 'sourceRevision') ? { sourceRevision: c.scope!.sourceRevision } : {}) };
  let snapshot = await sessions.enroll(c, input, createSessionEnrollmentCapability({ ...authority(c), sessionId: session.id, creationKey: input.creationKey, inputSha256: input.inputSha256 }));
  const events = () => [{ eventId: randomUUID(), kind: 'synthetic.sql.checkpoint', payloadJson: '{"synthetic":true}' }];
  async function begin(kind: 'create' | 'end-accept' | 'end-finalize') {
    const started = await sessions.beginIntent(c, { sessionId: session.id, key: randomUUID(), inputSha256: hash(kind), semanticKey: kind, semanticSha256: hash(kind), kind,
      expectedRevision: snapshot.revision, writerGeneration: snapshot.writerGeneration, writerToken: snapshot.writerToken });
    assert.equal(started.status, 'pending'); if (started.status !== 'pending') throw new Error('F_SQL_PENDING_REQUIRED'); return started.intent;
  }
  await sessions.commit(c, await begin('create'), { sessionJson: snapshot.sessionJson, events: events(), resultJson: '{"created":true}' });
  snapshot = (await sessions.read(c, session.id))!;
  const end = await begin('end-accept'); session.runtime.endRequestedAt = new Date().toISOString(); session.runtime.acceptedEndRequest = { elapsedMs: session.elapsedMs, metrics: {} };
  const acceptedJson = JSON.stringify(session.runtime.acceptedEndRequest);
  await sessions.commit(c, end, { sessionJson: JSON.stringify(session), events: events(), resultJson: '{"accepted":true}', endIntent: { intentId: end.operationId, inputJson: acceptedJson, inputSha256: hash(acceptedJson) } });
  snapshot = (await sessions.read(c, session.id))!;
  const finalize = await begin('end-finalize'); session.status = 'ending'; session.evaluationStatus = 'review_required'; session.runtime.epoch++;
  session.runtime.evaluationInputFrozenAt = new Date().toISOString();
  const sessionJson = JSON.stringify(session), frozenSessionSha256 = hash(sessionJson);
  const payloadJson = JSON.stringify({ version: 'session-evaluation-handoff-v1', sessionId: session.id, ownerId: c.account.ownerId, studentId: c.scope!.studentId,
    applicationTargetId: c.scope!.applicationTargetId, supportTargetId: c.scope!.supportTargetId,
    acceptedEndIntentId: end.operationId, acceptedEndInputSha256: hash(acceptedJson), contextSnapshotSha256: hash(contextJson), frozenSessionSha256,
    evaluationSourceSha256: evaluationSessionSourceFingerprint(data, session, model), model, pipelineVersion: EVALUATION_PIPELINE_VERSION,
    sessionJson, contextJson, pinsJson, state: 'awaiting-evaluation-consumer', evaluationApprovalGranted: false });
  await sessions.commit(c, finalize, { sessionJson, events: events(), resultJson: '{"handoff":"awaiting-evaluation-consumer"}',
    handoff: { intentId: end.operationId, payloadJson, payloadSha256: hash(payloadJson), frozenSessionSha256 } });
  snapshot = (await sessions.read(c, session.id))!; decodeSessionEvaluationHandoff(snapshot);
  return { ...fixture, snapshot, model, who, auth: c };
}
type Ended = Awaited<ReturnType<typeof ended>>;
function admission(c: AuthenticatedRequestContext, input: EvaluationConsumptionInput) {
  return createEvaluationAdmissionCapability({ ...authority(c), sessionId: input.sessionId, inputSha256: input.inputSha256, handoffIntentId: input.handoffIntentId, handoffPayloadSha256: input.handoffPayloadSha256 });
}
async function consumeInput(value: Ended, approvalSha256: string | null, registration?: EvaluationConsumptionInput['registration']): Promise<EvaluationConsumptionInput> {
  const scope = await repository.scopeControl(value.auth), f = await repository.sessionControl(value.auth, value.session.id);
  return { ...command({ sessionId: value.session.id, handoff: value.snapshot.handoff!.payloadSha256, approvalSha256 }),
    sessionId: value.session.id, handoffIntentId: value.snapshot.handoff!.intentId, handoffPayloadSha256: value.snapshot.handoff!.payloadSha256,
    frozenSessionSha256: value.snapshot.sessionSha256, originalContextSnapshotSha256: value.snapshot.contextSnapshotSha256,
    expectedTrustGeneration: scope.trustGeneration, expectedRegistryGeneration: scope.registryGeneration, expectedApprovalGeneration: f?.approvalGeneration ?? '0',
    approvalSha256, state: registration ? 'registered' : 'review_required', reasons: registration ? [] : ['AUTHENTICATED_SESSION_REVIEW_REQUIRED'], ...(registration ? { registration } : {}) };
}
async function reviewed(value: Ended) {
  const { auth: c, who } = value, signer = signers.get(who)!, scope = await repository.scopeControl(c);
  if (!scope.trust) {
    const body = { version: 'evaluation-review-trust-v1', ownerId: c.account.ownerId, studentId: c.scope!.studentId, applicationTargetId: c.scope!.applicationTargetId, supportTargetId: c.scope!.supportTargetId,
      reviewers: [{ issuer: c.principal.issuer, subject: c.principal.subject, actorId: supplyReviewer, publicKey: signer.trustedPublicKey, actions: ['publish-spec', 'supply-session', 'withdraw'],
        notBefore: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), revoked: false }] };
    const trust = { ...body, contentSha256: snapshotHash(body) }, artifact = rawArtifact('trust', trust, trust.contentSha256);
    await repository.installTrust(c, { ...command(trust), expectedTrustGeneration: scope.trustGeneration, trust: artifact }, createEvaluationTrustAdminCapability({ ...authority(c), trustSha256: trust.contentSha256 }));
  }
  const registry = reviewedSupplyRegistry(value), signedA = signer.receipt({ version: 'authenticated-bank-scope-review-v1', actorId: supplyReviewer, registrySha256: registry.contentSha256,
    action: 'publish_scopes', issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  verifyBankScopeReviewReceipt(signedA, registry, signer.trustedPublicKey);
  const beforeA = await repository.scopeControl(c);
  const reviewer = (action: 'publish-spec' | 'supply-session' | 'withdraw', trustGeneration: string, sessionId?: string) => createEvaluationReviewerCapability({ ...authority(c), issuer: c.principal.issuer, subject: c.principal.subject,
    actorId: supplyReviewer, publicKeySha256: evaluationReviewerKeySha256(signer.trustedPublicKey), action, expectedTrustGeneration: trustGeneration, ...(sessionId ? { sessionId } : {}) });
  await repository.publishRegistry(c, { ...command({ registry: registry.contentSha256, receipt: signedA }), expectedTrustGeneration: beforeA.trustGeneration, expectedRegistryGeneration: beforeA.registryGeneration,
    registry: rawArtifact('registry', registry, registry.contentSha256), receipt: rawArtifact('registry-receipt', signedA) }, reviewer('publish-spec', beforeA.trustGeneration));
  const proposal = prepareEndedSessionReview(value.context, value.session, registry), bundle = supplyRecordBundle(value.session);
  const signedB = signer.receipt({ version: 'authenticated-session-evaluation-review-v1', actorId: supplyReviewer, action: 'approve_session_evaluation', proposalSha256: proposal.contentSha256,
    bundleSha256: bundle.contentSha256, sessionId: value.session.id, sessionQuestionAnswerSha256: proposal.sessionQuestionAnswerSha256, contextSnapshotSha256: proposal.contextSnapshotSha256,
    issuedAt: new Date(Date.now() - 500).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  validateReviewedSessionEvaluationInput({ context: value.context, session: value.session, proposal, bundle, receipt: signedB, currentRegistry: registry, trustedPublicKey: signer.trustedPublicKey });
  const beforeB = await repository.scopeControl(c), existing = await repository.sessionControl(c, value.session.id), receiptSha256 = snapshotHash(signedB);
  await repository.publishApproval(c, { ...command({ sessionId: value.session.id, receipt: signedB }), expectedTrustGeneration: beforeB.trustGeneration, expectedRegistryGeneration: beforeB.registryGeneration,
    sessionId: value.session.id, expectedApprovalGeneration: existing?.approvalGeneration ?? '0', registrySha256: registry.contentSha256,
    bundle: rawArtifact('bundle', bundle, bundle.contentSha256), receipt: rawArtifact('session-receipt', { receipt: signedB, proposal }, receiptSha256) }, reviewer('supply-session', beforeB.trustGeneration, value.session.id));
  const bundleJson = JSON.stringify(bundle);
  const projected = createReviewedEvaluationKnowledgeContext(value.context, value.session, bundle, { path: 'evaluation-db-artifact:bundle:' + bundle.contentSha256, fileSha256: hash(bundleJson),
    sessionReviewReceiptSha256: receiptSha256, evaluationSpecRegistrySha256: registry.contentSha256, evaluationSpecRegistry: registry });
  const prepared = prepareReviewedEvaluationJobInput(projected.context, value.session, value.context, value.model);
  const reference = prepareReviewedEvaluationRevisionReference({ originalSession: value.session,
    job: { id: prepared.jobId, sourceSha256: prepared.sourceSha256, snapshotSha256: prepared.snapshotSha256, pipelineVersion: prepared.pipelineVersion, model: prepared.model }, receiptSha256, receiptIssuedAt: String(Reflect.get(signedB, 'issuedAt')),
    originalContextSnapshotSha256: prepared.originalContextSnapshotSha256, reviewedContextSnapshotSha256: prepared.contextSnapshotSha256, sessionFrozenInputSha256: proposal.sessionSnapshotSha256 });
  const revisionJson = JSON.stringify(reference);
  const input = await consumeInput(value, receiptSha256, { jobId: prepared.jobId, sourceSha256: prepared.sourceSha256, snapshotJson: prepared.snapshotJson, snapshotSha256: prepared.snapshotSha256,
    reviewedContext: rawArtifact('reviewed-context', projected.context), pipelineVersion: prepared.pipelineVersion, model: prepared.model, revisionJson, revisionSha256: reference.contentSha256, revisionRawSha256: hash(revisionJson) });
  await repository.consume(c, input, admission(c, input));
  return { ...value, registry, signedA, signedB, receiptSha256, prepared, input, reviewer };
}
async function worker(value: Awaited<ReturnType<typeof reviewed>>, subjectId = 'f-sql-worker-' + randomUUID()) {
  const capability = createEvaluationWorkerCapability({ ...authority(value.auth), subjectId, jobIds: [value.prepared.jobId] });
  await repository.grantWorker(value.auth, capability); return { capability, jobs: repository.workerJobs(value.auth, capability) };
}

test('F-DB-01 unconfigured reads are pure and repeated missing-approval consumption creates one durable wait and zero jobs', async () => {
  const before = (await pools.admin.query('SELECT count(*)::int n FROM gakja.evaluation_scopes')).rows[0].n;
  const control = await repository.scopeControl(context()); assert.equal(control.trust, null); assert.equal(control.trustGeneration, '0');
  assert.equal((await pools.admin.query('SELECT count(*)::int n FROM gakja.evaluation_scopes')).rows[0].n, before);
  const value = await ended(), first = await consumeInput(value, null), one = await repository.consume(value.auth, first, admission(value.auth, first));
  const second = await consumeInput(value, null), two = await repository.consume(value.auth, second, admission(value.auth, second));
  assert.equal(JSON.parse(one.resultJson).consumptionId, JSON.parse(two.resultJson).consumptionId);
  assert.equal((await pools.admin.query('SELECT count(*)::int n FROM gakja.evaluation_jobs WHERE session_id=$1', [value.session.id])).rows[0].n, 0);
  assert.equal((await repository.projection(value.auth, value.session.id))!.state, 'review_required');
  const after = (await sessions.read(value.auth, value.session.id))!; assert.equal(after.sessionJson, value.snapshot.sessionJson); assert.deepEqual(after.handoff, value.snapshot.handoff);
  assert.equal(await repository.projection(context('b'), value.session.id), null);
});
test('F-DB-02 A/B signed bindings register separately, preserve original E bytes and reject forged capabilities', async () => {
  for (const who of ['a', 'b']) {
    const value = await reviewed(await ended(who)), view = (await repository.projection(value.auth, value.session.id))!;
    assert.equal(view.state, 'queued'); assert.equal(view.job!.id, value.prepared.jobId); assert.equal(view.revisionSha256, value.input.registration!.revisionSha256);
    assert.equal((await sessions.read(value.auth, value.session.id))!.sessionJson, value.snapshot.sessionJson);
    assert.equal(await repository.getJob(context(who === 'a' ? 'b' : 'a'), value.prepared.jobId), null);
    await assert.rejects(repository.grantWorker(value.auth, { kind: 'evaluation-worker-capability-v1' }), e => e instanceof EvaluationWriterError && e.status === 403);
  }
});
test('F-DB-03 same input aliases preserve one job; different idempotency input conflicts and source/model tampering is refused', async () => {
  const value = await reviewed(await ended()), repeated = await repository.consume(value.auth, value.input, admission(value.auth, value.input)); assert.equal(repeated.replay, true);
  assert.equal(repeated.sessionId, value.session.id); assert.equal(repeated.action, 'consume');
  const alias = { ...value.input, key: randomUUID() }; const reused = await repository.consume(value.auth, alias, admission(value.auth, alias));
  assert.equal(JSON.parse(reused.resultJson).jobId, value.prepared.jobId);
  const conflict = { ...value.input, inputSha256: hash('changed') }; await assert.rejects(repository.consume(value.auth, conflict, admission(value.auth, conflict)), e => e instanceof EvaluationWriterError && e.code === 'EVALUATION_IDEMPOTENCY_CONFLICT');
  const changed = structuredClone(value.input); changed.key = randomUUID(); changed.registration!.sourceSha256 = 'e'.repeat(64);
  await assert.rejects(repository.consume(value.auth, changed, admission(value.auth, changed)));
  assert.equal((await pools.admin.query('SELECT count(*)::int n FROM gakja.evaluation_jobs WHERE session_id=$1', [value.session.id])).rows[0].n, 1);
});
test('F-DB-04 DB-clock claim fences expiration and reassignment across every stale mutation', async () => {
  const value = await reviewed(await ended()), one = await worker(value), two = await worker(value), id = value.prepared.jobId;
  const claimed = (await one.jobs.claim(id, 'worker-one', Date.now() + 86_400_000, 1000))!; assert.equal(claimed.status, 'running');
  assert.ok(Date.parse(claimed.lease!.expiresAt) - Date.now() < 2000, 'Node now argument is not lease authority');
  await pools.admin.query("UPDATE gakja.evaluation_jobs SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE job_id=$1", [id]);
  for (const act of [() => one.jobs.renew(id, claimed.lease!.token), () => one.jobs.checkpoint(id, claimed.lease!.token, { version: EVALUATION_PIPELINE_VERSION, clusterId: value.turn.id, inputSha256: hash('request'), output: {}, completedAt: new Date().toISOString() }),
    () => one.jobs.recordUsage(id, claimed.lease!.token, 'stale', normalizeProviderUsage({})), () => one.jobs.complete(id, claimed.lease!.token, {}), () => one.jobs.fail(id, claimed.lease!.token, null), () => one.jobs.requireReview(id, claimed.lease!.token, ['stale'])])
    await assert.rejects(act(), e => e instanceof EvaluationWriterError && e.code === 'EVALUATION_LEASE_LOST');
  const reclaimed = (await two.jobs.claim(id, 'worker-two'))!; assert.notEqual(reclaimed.lease!.token, claimed.lease!.token);
  await assert.rejects(one.jobs.renew(id, claimed.lease!.token));
  await two.jobs.requireReview(id, reclaimed.lease!.token, ['synthetic-control']);
});
test('F-DB-05 checkpoints and usage retain exact bytes; complete publishes result/job/revision in one transaction', async () => {
  const value = await reviewed(await ended()), { jobs } = await worker(value), id = value.prepared.jobId, claimed = (await jobs.claim(id, 'worker-complete'))!, token = claimed.lease!.token;
  const checkpoint = { version: EVALUATION_PIPELINE_VERSION as typeof EVALUATION_PIPELINE_VERSION, clusterId: value.turn.parentMainQuestionId, inputSha256: hash('exact-synthetic-request'), output: { quote: '한글😀\r\n', nullValue: null }, completedAt: new Date().toISOString() };
  await jobs.checkpoint(id, token, checkpoint); await jobs.recordUsage(id, token, 'same-attempt', normalizeProviderUsage({})); await jobs.recordUsage(id, token, 'same-attempt', normalizeProviderUsage({}));
  assert.deepEqual((await jobs.get(id))!.checkpoints, [checkpoint]); assert.equal((await jobs.get(id))!.usage.length, 1);
  const before = await repository.projection(value.auth, value.session.id); assert.equal(before!.result, null); assert.equal(before!.resultRevisionId, null);
  const completed = await jobs.complete(id, token, { syntheticRepositoryResult: true, quote: '한글😀\r\n' }); assert.equal(completed.status, 'completed');
  const view = (await repository.projection(value.auth, value.session.id))!; assert.equal(view.state, 'completed'); assert.ok(view.resultRevisionId);
  assert.equal(snapshotHash(view.result), completed.resultSha256); assert.equal(view.result!.jobId, id); assert.equal(view.revisionJson, value.input.registration!.revisionJson);
  assert.equal((await pools.admin.query('SELECT count(*)::int n FROM gakja.evaluation_results WHERE job_id=$1', [id])).rows[0].n, 1);
  await assert.rejects(jobs.complete(id, token, {}));
});
test('F-DB-06 withdrawal blocks current result display and every worker mutation without rewriting historical result bytes', async () => {
  const value = await reviewed(await ended()), { jobs } = await worker(value), id = value.prepared.jobId, claimed = (await jobs.claim(id, 'revoked-worker'))!;
  await jobs.complete(id, claimed.lease!.token, { syntheticRepositoryResult: true });
  const original = (await pools.admin.query('SELECT result_json FROM gakja.evaluation_results WHERE job_id=$1', [id])).rows[0].result_json;
  const scope = await repository.scopeControl(value.auth), f = (await repository.sessionControl(value.auth, value.session.id))!;
  await repository.withdrawApproval(value.auth, { ...command({ sessionId: value.session.id, withdraw: true }), sessionId: value.session.id, expectedTrustGeneration: scope.trustGeneration, expectedRegistryGeneration: scope.registryGeneration,
    expectedApprovalGeneration: f.approvalGeneration, reason: 'Explicit synthetic withdrawal' }, value.reviewer('withdraw', scope.trustGeneration, value.session.id));
  const view = (await repository.projection(value.auth, value.session.id))!; assert.equal(view.state, 'review_required'); assert.equal(view.result, null); assert.equal(view.currentApproval, false);
  const historical = (await repository.jobProjection(value.auth, id))!;
  assert.equal(historical.currentApproval, false); assert.equal(historical.state, 'review_required'); assert.deepEqual(historical.result, JSON.parse(original)); assert.ok(historical.resultRevisionId);
  assert.equal((await pools.admin.query('SELECT result_json FROM gakja.evaluation_results WHERE job_id=$1', [id])).rows[0].result_json, original);
  await assert.rejects(jobs.get(id), e => e instanceof EvaluationWriterError && e.code === 'EVALUATION_REVIEW_GENERATION_CHANGED');
});

test('F-DB-07 a result-revision insertion failure rolls back result and completion together', async () => {
  const value = await reviewed(await ended()), { jobs } = await worker(value), id = value.prepared.jobId, claimed = (await jobs.claim(id, 'atomic-result-worker'))!;
  assert.match(id, /^[a-f0-9]{64}$/u);
  await pools.admin.query(`ALTER TABLE gakja.evaluation_result_revisions ADD CONSTRAINT f_test_reject_revision CHECK(job_id <> '${id}') NOT VALID`);
  try {
    await assert.rejects(jobs.complete(id, claimed.lease!.token, { syntheticAtomicFailure: true }));
    const view = (await repository.projection(value.auth, value.session.id))!;
    assert.equal(view.job!.status, 'running'); assert.equal(view.result, null); assert.equal(view.resultRevisionId, null);
    assert.equal((await pools.admin.query('SELECT count(*)::int n FROM gakja.evaluation_results WHERE job_id=$1', [id])).rows[0].n, 0);
  } finally { await pools.admin.query('ALTER TABLE gakja.evaluation_result_revisions DROP CONSTRAINT f_test_reject_revision'); }
  const result = await jobs.complete(id, claimed.lease!.token, { syntheticAtomicRecovery: true }); assert.equal(result.status, 'completed');
});

test('F-DB-08 freeze/export/restore preserves exact E bytes and all fourteen F collections in a separate owned read-only database', { }, async () => {
  const value = await reviewed(await ended()), { jobs } = await worker(value), id = value.prepared.jobId, claimed = (await jobs.claim(id, 'archive-worker'))!, token = claimed.lease!.token;
  await jobs.checkpoint(id, token, { version: EVALUATION_PIPELINE_VERSION, clusterId: value.turn.parentMainQuestionId, inputSha256: hash('archive-cluster-input'), output: { quote: '원문😀\r\n', absentMeaning: null }, completedAt: new Date().toISOString() });
  await jobs.recordUsage(id, token, 'archive-attempt', normalizeProviderUsage({}));
  await jobs.complete(id, token, { syntheticArchiveResult: true, quote: '원문😀\r\n' });
  await assert.rejects(repository.exportPreservation(value.auth, value.session.id), e => e instanceof EvaluationWriterError && e.code === 'EVALUATION_WRITER_FROZEN');
  const f = (await repository.sessionControl(value.auth, value.session.id))!;
  await repository.freeze(value.auth, value.session.id, f.fence);
  await assert.rejects(jobs.renew(id, token), e => e instanceof EvaluationWriterError && e.code === 'EVALUATION_WRITER_FROZEN');
  const bundle = await repository.exportPreservation(value.auth, value.session.id), payload = JSON.parse(bundle.payloadJson);
  assert.equal(hash(bundle.payloadJson), bundle.sha256); assert.equal(Object.keys(payload.fTables).length, 14); assert.equal(payload.manifest.length, 14);
  assert.equal(hash(payload.sourceDependenciesJson), payload.sourceDependenciesSha256); assert.deepEqual(payload.newResultObjects, []);
  const dependencies = JSON.parse(payload.sourceDependenciesJson); assert.equal(dependencies.state, 'no-D-pin'); assert.deepEqual(dependencies.objects, []);
  assert.equal(dependencies.sessionId, value.session.id); assert.equal(dependencies.policy.objectBytesRestored, false);
  await assert.rejects(pools.admin.query('UPDATE gakja.evaluation_sessions SET source_dependencies_json=$1 WHERE owner_id=$2 AND session_id=$3', [JSON.stringify({ corrupted: true }), value.auth.account.ownerId, value.session.id]), e => Reflect.get(e as object, 'code') === '23514');
  for (const name of ['evaluation_jobs', 'evaluation_consumptions', 'evaluation_consumption_history', 'evaluation_command_receipts', 'evaluation_worker_grants', 'evaluation_checkpoints', 'evaluation_usage', 'evaluation_results', 'evaluation_result_revisions', 'evaluation_projection_pointers', 'evaluation_audit_events']) assert.ok(payload.fTables[name].length > 0, name);
  assert.equal(payload.eSession.session.session_json, value.snapshot.sessionJson); assert.equal(payload.eSession.session.context_json, value.snapshot.contextJson);
  const restoredPools = testPools(1, 'restore');
  try {
    const restoredIdentity = createRequestIdentityBoundary({ mode: 'service', verifier, accounts: createPostgresAccountResolver(restoredPools.request) });
    const token = await new SignJWT().setProtectedHeader({ alg: 'ES256', kid: jwk.kid }).setIssuer('https://issuer-a.example').setSubject('shared').setAudience('f-sql').setExpirationTime('1h').sign(keys.privateKey);
    const auth = restoredIdentity.selectScope(await restoredIdentity.authenticate('Bearer ' + token), { applicationTargetId: 'app-a' }) as AuthenticatedRequestContext;
    const restored = createPostgresEvaluationWriter({ boundary: restoredIdentity, requestPool: restoredPools.request, mappingPool: restoredPools.mapping, workerPool: restoredPools.worker, environment: 'isolated-evaluation-writer' });
    const restoreAuthority = { ownerId: auth.account.ownerId, ...auth.scope!, sessionId: value.session.id, bundleSha256: bundle.sha256, expiresAt: Date.now() + 300_000,
      async checkCurrent() { try { await restoredIdentity.revalidate(auth); return true; } catch { return false; } } };
    const cap = createEvaluationPreservationCapability(restoreAuthority), view = await restored.restorePreservation(auth, bundle, cap);
    assert.equal(view.state, 'completed'); assert.equal(view.control!.writer, 'read-only'); assert.equal(view.result!.jobId, id);
    const copy = JSON.parse((await restored.exportPreservation(auth, value.session.id)).payloadJson);
    assert.deepEqual(copy.fTables, payload.fTables); assert.deepEqual(copy.manifest, payload.manifest);
    assert.equal(copy.sourceDependenciesJson, payload.sourceDependenciesJson); assert.equal(copy.sourceDependenciesSha256, payload.sourceDependenciesSha256); assert.deepEqual(copy.newResultObjects, []);
    assert.deepEqual(copy.eSession, { ...payload.eSession, session: { ...payload.eSession.session, writer: 'read-only' } });
    assert.equal((await restored.receipt(auth, value.input))!.operationId, (await repository.receipt(value.auth, value.input))!.operationId);
    await assert.rejects(restored.restorePreservation(auth, bundle, cap));
    const source = (await sessions.read(value.auth, value.session.id))!;
    assert.equal(source.writer, 'db'); assert.equal(source.sessionJson, value.snapshot.sessionJson); assert.deepEqual(source.handoff, value.snapshot.handoff);
  } finally { await closePools(restoredPools); }
});

test('F-DB-09 finite worker methods and SQL privileges refuse arbitrary jobs, table access and global listing', async () => {
  const value = await reviewed(await ended()), { jobs } = await worker(value);
  await assert.rejects(jobs.get('f'.repeat(64)), e => e instanceof EvaluationWriterError && e.status === 403);
  assert.equal('pending' in jobs, false); assert.equal('directory' in jobs, false); assert.equal('enqueue' in jobs, false);
  for (const role of [pools.request, pools.mapping, pools.worker, pools.bypass]) {
    await assert.rejects(role.query('SELECT * FROM gakja.evaluation_jobs'), e => Reflect.get(e as object, 'code') === '42501');
    await assert.rejects(role.query('UPDATE gakja.evaluation_sessions SET writer=\'db\''), e => Reflect.get(e as object, 'code') === '42501');
  }
  await assert.rejects(pools.request.query("SELECT gakja.evaluation_worker($1,'get','{}'::jsonb)", [value.prepared.jobId]), e => Reflect.get(e as object, 'code') === '42501');
  await assert.rejects(pools.worker.query('SELECT gakja.evaluation_scope_control()'), e => Reflect.get(e as object, 'code') === '42501');
  for (const role of [pools.request, pools.mapping, pools.worker]) assert.equal((await role.query("SELECT coalesce(current_setting('gakja.worker_subject',true),'')='' AND coalesce(current_setting('gakja.reviewer_actor',true),'')='' clean")).rows[0].clean, true);
});

test('F-DB-10 F replay rejects changed SQL and live schema drift without rewriting historical checkpoints', async () => {
  const modulePath = '../../scripts/' + 'pr07f-migration.mjs';
  const { applyEvaluationWriterMigration } = await import(modulePath);
  const before = (await pools.admin.query('SELECT version,checksum,fingerprint FROM pr07b_control.migrations ORDER BY version')).rows;
  const client = await pools.admin.connect(); const dir = await mkdtemp(path.join(tmpdir(), 'gakja-f-migration-'));
  try {
    const replay = await applyEvaluationWriterMigration(client); assert.equal(replay.applied, false);
    const sql = await readFile(new URL('../../db/migrations/0005_evaluation_writer.sql', import.meta.url), 'utf8'), changed = path.join(dir, 'changed.sql');
    await writeFile(changed, sql + '\n-- controlled checksum-negative fixture\n', 'utf8');
    await assert.rejects(applyEvaluationWriterMigration(client, changed), /PR07F_MIGRATION_CHECKSUM_CHANGED/u);
    await client.query('ALTER TABLE gakja.evaluation_jobs ADD COLUMN controlled_drift text');
    try { await assert.rejects(applyEvaluationWriterMigration(client), /PR07F_MIGRATION_SCHEMA_DRIFT/u); }
    finally { await client.query('ALTER TABLE gakja.evaluation_jobs DROP COLUMN controlled_drift'); }
    assert.equal((await applyEvaluationWriterMigration(client)).applied, false);
    assert.deepEqual((await client.query('SELECT version,checksum,fingerprint FROM pr07b_control.migrations ORDER BY version')).rows, before);
  } finally { client.release(); assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir(), 'gakja-f-migration-'))); await rm(dir, { recursive: true, force: true }); }
});

test('F-DB-11 a persisted approval withdrawal winning the final SQL lock race prevents every result/revision publication', async () => {
  const value = await reviewed(await ended()), { jobs, capability } = await worker(value), id = value.prepared.jobId, claimed = (await jobs.claim(id, 'final-race-worker'))!;
  const admin = await pools.admin.connect(), workerClient = await pools.worker.connect(); let adminTransaction = false, workerTransaction = false;
  try {
    await admin.query('BEGIN'); adminTransaction = true;
    await admin.query('SELECT 1 FROM gakja.evaluation_scopes WHERE owner_id=$1 AND student_id=$2 AND application_target_id=$3 FOR UPDATE', [value.auth.account.ownerId, value.auth.scope!.studentId, value.auth.scope!.applicationTargetId]);
    await admin.query('UPDATE gakja.evaluation_sessions SET approval_revoked=true,approval_generation=approval_generation+1 WHERE owner_id=$1 AND session_id=$2', [value.auth.account.ownerId, value.session.id]);
    await workerClient.query('BEGIN'); workerTransaction = true;
    const subject = (await admin.query('SELECT worker_subject FROM gakja.evaluation_worker_grants WHERE owner_id=$1 AND job_id=$2 ORDER BY worker_subject LIMIT 1', [value.auth.account.ownerId, id])).rows[0].worker_subject;
    const vars = { issuer: value.auth.principal.issuer, subject: value.auth.principal.subject, account_id: value.auth.account.accountId, account_revision: value.auth.account.revision, owner_id: value.auth.account.ownerId,
      student_id: value.auth.scope!.studentId, application_target_id: value.auth.scope!.applicationTargetId, worker_subject: subject, job_id: id };
    for (const [key, v] of Object.entries(vars)) await workerClient.query('SELECT set_config($1,$2,true)', ['gakja.' + key, v]);
    await workerClient.query("SET LOCAL statement_timeout='5s'");
    const pid = (await workerClient.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    const result = { version: 1, jobId: id, sourceSha256: claimed.sourceSha256, snapshotSha256: claimed.snapshotSha256, pipelineVersion: claimed.pipelineVersion, model: claimed.model, evaluation: { syntheticRace: true }, completedAt: new Date().toISOString() };
    const json = JSON.stringify(result), finalize = workerClient.query("SELECT gakja.evaluation_worker($1,'complete',$2::jsonb)", [id, JSON.stringify({ token: claimed.lease!.token, resultJson: json, rawSha256: hash(json), resultSha256: snapshotHash(result) })]).then(() => null, error => error as { code: string });
    const deadline = Date.now() + 3000; let blocked = false;
    while (Date.now() < deadline) {
      blocked = (await admin.query("SELECT wait_event_type='Lock' blocked FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.blocked === true;
      if (blocked) break; await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true, 'real final SQL waits on persisted review generation row lock');
    await admin.query('COMMIT'); adminTransaction = false;
    assert.equal((await finalize)?.code, 'P7202'); await workerClient.query('ROLLBACK'); workerTransaction = false;
    assert.equal((await admin.query('SELECT count(*)::int n FROM gakja.evaluation_results WHERE job_id=$1', [id])).rows[0].n, 0);
    assert.equal((await admin.query('SELECT count(*)::int n FROM gakja.evaluation_result_revisions WHERE job_id=$1', [id])).rows[0].n, 0);
    assert.equal((await admin.query('SELECT status FROM gakja.evaluation_jobs WHERE job_id=$1', [id])).rows[0].status, 'running');
    assert.equal((await sessions.read(value.auth, value.session.id))!.sessionJson, value.snapshot.sessionJson);
    assert.equal(capability.kind, 'evaluation-worker-capability-v1');
  } finally {
    if (adminTransaction) await admin.query('ROLLBACK'); if (workerTransaction) await workerClient.query('ROLLBACK');
    admin.release(); workerClient.release();
  }
});

test('F-DB-12 composite FKs refuse a same-owner job or consumption being attached to a different session', async () => {
  const one = await reviewed(await ended()), two = await reviewed(await ended());
  await assert.rejects(pools.admin.query('UPDATE gakja.evaluation_projection_pointers SET job_id=$1 WHERE owner_id=$2 AND session_id=$3', [one.prepared.jobId, two.auth.account.ownerId, two.session.id]), e => Reflect.get(e as object, 'code') === '23503');
  const consumptionId = (await pools.admin.query('SELECT consumption_id FROM gakja.evaluation_consumptions WHERE owner_id=$1 AND session_id=$2 AND job_id=$3', [one.auth.account.ownerId, one.session.id, one.prepared.jobId])).rows[0].consumption_id;
  const raw = JSON.stringify({ syntheticForeignSession: true });
  await assert.rejects(pools.admin.query('INSERT INTO gakja.evaluation_consumption_history(owner_id,session_id,consumption_id,history_sha256,history_json) VALUES($1,$2,$3,$4,$5)', [two.auth.account.ownerId, two.session.id, consumptionId, hash(raw), raw]), e => Reflect.get(e as object, 'code') === '23503');
  assert.equal((await repository.projection(two.auth, two.session.id))!.job!.id, two.prepared.jobId);
});

test('F-DB-13 an account revision revocation winning the final SQL authority lock prevents stale result publication', async () => {
  const value = await reviewed(await ended()), { jobs } = await worker(value), id = value.prepared.jobId, claimed = (await jobs.claim(id, 'final-account-race-worker'))!;
  const admin = await pools.admin.connect(), workerClient = await pools.worker.connect(); let adminTransaction = false, workerTransaction = false, accountRestored = false;
  const originalAccount = (await admin.query('SELECT active,revision::text revision FROM gakja.accounts WHERE account_id=$1', [value.auth.account.accountId])).rows[0];
  try {
    await admin.query('BEGIN'); adminTransaction = true;
    await admin.query('UPDATE gakja.accounts SET active=false WHERE account_id=$1', [value.auth.account.accountId]);
    await workerClient.query('BEGIN'); workerTransaction = true;
    const subject = (await admin.query('SELECT worker_subject FROM gakja.evaluation_worker_grants WHERE owner_id=$1 AND job_id=$2 ORDER BY worker_subject LIMIT 1', [value.auth.account.ownerId, id])).rows[0].worker_subject;
    const vars = { issuer: value.auth.principal.issuer, subject: value.auth.principal.subject, account_id: value.auth.account.accountId, account_revision: value.auth.account.revision, owner_id: value.auth.account.ownerId,
      student_id: value.auth.scope!.studentId, application_target_id: value.auth.scope!.applicationTargetId, worker_subject: subject, job_id: id };
    for (const [key, v] of Object.entries(vars)) await workerClient.query('SELECT set_config($1,$2,true)', ['gakja.' + key, v]);
    await workerClient.query("SET LOCAL statement_timeout='5s'"); const pid = (await workerClient.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    const result = { version: 1, jobId: id, sourceSha256: claimed.sourceSha256, snapshotSha256: claimed.snapshotSha256, pipelineVersion: claimed.pipelineVersion, model: claimed.model, evaluation: { syntheticAccountRace: true }, completedAt: new Date().toISOString() };
    const json = JSON.stringify(result), finalize = workerClient.query("SELECT gakja.evaluation_worker($1,'complete',$2::jsonb)", [id, JSON.stringify({ token: claimed.lease!.token, resultJson: json, rawSha256: hash(json), resultSha256: snapshotHash(result) })]).then(() => null, error => error as { code: string });
    const deadline = Date.now() + 3000; let blocked = false;
    while (Date.now() < deadline) {
      blocked = (await admin.query("SELECT wait_event_type='Lock' blocked FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.blocked === true;
      if (blocked) break; await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true, 'real final SQL waits on the account authority row lock');
    await admin.query('COMMIT'); adminTransaction = false;
    assert.equal((await finalize)?.code, '42501'); await workerClient.query('ROLLBACK'); workerTransaction = false;
    assert.equal((await admin.query('SELECT count(*)::int n FROM gakja.evaluation_results WHERE job_id=$1', [id])).rows[0].n, 0);
    assert.equal((await admin.query('SELECT count(*)::int n FROM gakja.evaluation_result_revisions WHERE job_id=$1', [id])).rows[0].n, 0);
    assert.equal((await admin.query('SELECT session_json FROM gakja.session_command_sessions WHERE owner_id=$1 AND session_id=$2', [value.auth.account.ownerId, value.session.id])).rows[0].session_json, value.snapshot.sessionJson);
    await admin.query('UPDATE gakja.accounts SET active=$2 WHERE account_id=$1', [value.auth.account.accountId, originalAccount.active]); accountRestored = true;
    const restored = (await admin.query('SELECT active,revision::text revision FROM gakja.accounts WHERE account_id=$1', [value.auth.account.accountId])).rows[0];
    assert.equal(restored.active, originalAccount.active); assert.ok(BigInt(restored.revision) > BigInt(originalAccount.revision));
  } finally {
    if (adminTransaction) await admin.query('ROLLBACK'); if (workerTransaction) await workerClient.query('ROLLBACK');
    if (!accountRestored) await admin.query('UPDATE gakja.accounts SET active=$2 WHERE account_id=$1', [value.auth.account.accountId, originalAccount.active]);
    admin.release(); workerClient.release();
  }
});
