import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalSessionStore } from '../server/storage/local-session-store';
import { createLocalReviewRepository } from '../server/repositories/local-review-repository';
import { createLocalEvaluationRevisionRepository } from '../server/repositories/local-evaluation-revision-repository';
import type { EvaluationRevisionRepository } from '../server/repositories/evaluation-revision-ports';
import { prepareEndedSessionReview, supplyReviewedSessionEvaluation } from '../server/evaluation-supply';
import { loadReviewedEvaluationRevision } from '../server/evaluation-revisions';
import { publishBankScopeReview } from '../server/data/evaluation-scope-registry';
import { knowledgeSessionQuestionAnswerHash } from '../server/data/approved-knowledge';
import { prepareEvaluationScopesCli } from '../scripts/prepare-evaluation-scopes';
import { evaluationSupplyFixture, pinSupplySnapshot, reviewedSupplyRegistry, supplyRecordBundle, supplyReviewer, supplySigner } from './fixtures/evaluation-supply';

for (const fault of ['link', 'partial-write', 'unlink'] as const) test(`real signed supply preserves its original and retries a revision ${fault} failure through injected local ports`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pr06d-composition-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('pr06d-composition-')); await rm(root, { recursive: true, force: true }); });
  const value = await evaluationSupplyFixture(), registry = reviewedSupplyRegistry(value), signer = supplySigner();
  value.context.evaluationScopeRegistry = registry; pinSupplySnapshot(value.context, value.session);
  const sessions = createLocalSessionStore(root), ownerId = value.session.runtime!.owner.id;
  await sessions.saveContext(value.context, ownerId); await sessions.save(value.session);
  const originalFile = path.join(root, 'data/sessions', `${value.session.id}.json`), originalBytes = await readFile(originalFile);
  const issuedAt = new Date(Date.now() - 1000).toISOString(), expiresAt = new Date(Date.now() + 60000).toISOString();
  let registryReads = 0, referenceLists = 0, referenceReads = 0;
  const localReviews = createLocalReviewRepository(root);
  const reviews = { ...localReviews, readRegistryPointer: async () => { registryReads++; return localReviews.readRegistryPointer(); } };
  await publishBankScopeReview(registry, value.context, value.bank, signer.receipt({ version: 'authenticated-bank-scope-review-v1', actorId: supplyReviewer,
    registrySha256: registry.contentSha256, action: 'publish_scopes', issuedAt, expiresAt }), null, root, signer.trustedPublicKey, reviews);
  const proposal = prepareEndedSessionReview(value.context, value.session, registry), bundle = supplyRecordBundle(value.session);
  const receipt = signer.receipt({ version: 'authenticated-session-evaluation-review-v1', actorId: supplyReviewer,
    action: 'approve_session_evaluation', proposalSha256: proposal.contentSha256, bundleSha256: bundle.contentSha256,
    sessionId: value.session.id, sessionQuestionAnswerSha256: knowledgeSessionQuestionAnswerHash(value.session),
    contextSnapshotSha256: value.session.runtime!.contextSnapshotSha256, issuedAt, expiresAt });
  const error = Object.assign(new Error('owned revision fault'), { code: fault === 'partial-write' ? 'ENOSPC' : fault === 'unlink' ? 'EACCES' : 'EIO' });
  let injected = false;
  const localRevisions = createLocalEvaluationRevisionRepository(root, { io: {
    ...(fault === 'link' ? { link: async () => { injected = true; throw error; } } : {}),
    ...(fault === 'partial-write' ? { writeFile: (async (file: Parameters<typeof writeFile>[0]) => { await writeFile(file, '{"partial', { flag: 'wx', mode: 0o600 }); injected = true; throw error; }) as typeof writeFile } : {}),
    ...(fault === 'unlink' ? { unlink: async () => { injected = true; throw error; } } : {}),
  } });
  const supply = (revisions: EvaluationRevisionRepository) => supplyReviewedSessionEvaluation({ ...value, root, proposal, bundle, receipt,
    trustedPublicKey: signer.trustedPublicKey, enqueue: true, sessions, reviews, revisions, model: 'synthetic-port-composition' });
  await assert.rejects(supply(localRevisions), actual => actual === error); assert.equal(injected, true);
  assert.deepEqual(await readFile(originalFile), originalBytes);
  const referenceRoot = path.join(root, 'data/evaluation-revisions'), folder = (await readdir(referenceRoot))[0];
  const failedFiles = await readdir(path.join(referenceRoot, folder));
  assert.equal(failedFiles.filter(file => file.endsWith('.json')).length, fault === 'unlink' ? 1 : 0);
  assert.equal(failedFiles.filter(file => file.endsWith('.tmp')).length, fault === 'link' ? 0 : 1);
  const healthy = createLocalEvaluationRevisionRepository(root);
  const revisions: EvaluationRevisionRepository = { ...healthy,
    list: async scope => { referenceLists++; return healthy.list(scope); },
    read: async (scope, digest) => { referenceReads++; return healthy.read(scope, digest); } };
  const supplied = await supply(revisions), repeated = await supply(revisions);
  assert.equal(supplied.jobId, repeated.jobId); assert.equal(supplied.receiptSha256, repeated.receiptSha256);
  const view = await loadReviewedEvaluationRevision({ root, session: value.session, ownerId, sessions, reviews, revisions, trustedPublicKey: signer.trustedPublicKey });
  assert.equal(view?.status, 'pending'); assert.equal(view.jobId, supplied.jobId);
  assert.equal((await readdir(path.join(referenceRoot, folder))).filter(file => file.endsWith('.json')).length, 1);
  // The command receives the same actual local repositories; no gate or store is stubbed.
  const previousOwner = process.env.LOCAL_INTERVIEW_OWNER_ID; process.env.LOCAL_INTERVIEW_OWNER_ID = ownerId;
  try {
    const beforeReads = [registryReads, referenceLists, referenceReads];
    const coverage = await prepareEvaluationScopesCli(['coverage', '--session-id', value.session.id], root, { sessions, reviews, revisions, trustedPublicKey: signer.trustedPublicKey });
    assert.ok('snapshotScope' in coverage); assert.equal(coverage.snapshotScope, 'verified_reviewed_evaluation_revision');
    assert.equal(coverage.boundCount, 1); assert.ok(registryReads > beforeReads[0] && referenceLists > beforeReads[1] && referenceReads > beforeReads[2]);
  } finally { if (previousOwner === undefined) delete process.env.LOCAL_INTERVIEW_OWNER_ID; else process.env.LOCAL_INTERVIEW_OWNER_ID = previousOwner; }
  assert.deepEqual(await readFile(originalFile), originalBytes);
});
