import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileEvaluationScopePolicy } from '../server/policy/evaluation-scope-policy';
import { evaluateKnowledgeGate } from '../server/providers/evaluation-knowledge-gate';
import { buildEvaluationUnits } from '../server/providers/evaluation-turns';
import { bankScopeReadiness, loadBankScopeRegistry, publishBankScopeReview, sealBankScopeRegistry,
  validateBankScopeReview } from '../server/data/evaluation-scope-registry';
import { prepareEvaluationScopesCli } from '../scripts/prepare-evaluation-scopes';
import { evaluationSupplyFixture, pinSupplySnapshot, reviewedSupplyRegistry, signSupplyReceipt, supplyReviewer } from './fixtures/evaluation-supply';

async function directory(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evaluation-scope-contract-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('evaluation-scope-contract-')); await rm(root, { recursive: true, force: true }); });
  return root;
}
test('evaluation policy is version/hash metadata and never a source of automatic scope approval', async () => {
  const value = await evaluationSupplyFixture(), policy = compileEvaluationScopePolicy(value.context);
  assert.equal('templates' in policy, false); assert.equal('authority' in policy, false);
  value.context.evaluationScopePolicy = policy; pinSupplySnapshot(value.context, value.session);
  const gate = evaluateKnowledgeGate(value.context, value.session, buildEvaluationUnits(value.session).scoredUnits[0]);
  assert.deepEqual(gate.holdReasons, ['KNOWLEDGE_SCOPE_APPROVAL_REQUIRED']); assert.equal(gate.scientificTruthAuthority, 'none');
  const original = compileEvaluationScopePolicy(value.context);
  value.context.evaluationGuidelines += ' 합성 rubric 수정';
  assert.notDeepEqual(compileEvaluationScopePolicy(value.context), original);
});

test('question inventory starts pending and a reviewer name cannot publish evaluation approval', async t => {
  const root = await directory(t), value = await evaluationSupplyFixture();
  const staged = await prepareEvaluationScopesCli(['stage', '--output', 'pending.json'], root, { context: value.context, bank: value.bank });
  assert.equal(staged.approvedCount, 0); assert.equal(staged.pendingCount, 1); assert.equal(staged.publicationAuthorized, false);
  const proposed = JSON.parse(await readFile(path.join(root, 'pending.json'), 'utf8'));
  assert.equal(proposed.entries[0].scope, 'unresolved'); assert.equal(proposed.entries[0].review.approverId, null);
  const reviewed = reviewedSupplyRegistry(value);
  assert.throws(() => validateBankScopeReview(reviewed, value.context, value.bank, 'different-reviewer'), /AUTHORITY|REVIEW/);
  await assert.rejects(publishBankScopeReview(reviewed, value.context, value.bank, null, null, root), /RECEIPT|AUTHENTICATED|expected object/);
  assert.equal(await loadBankScopeRegistry(root), null);
});

test('an exact signed Q0 specification publishes by CAS but cannot approve a future session binding', async t => {
  const root = await directory(t), value = await evaluationSupplyFixture(), reviewed = reviewedSupplyRegistry(value);
  const signed = signSupplyReceipt({ version: 'authenticated-bank-scope-review-v1', actorId: supplyReviewer,
    registrySha256: reviewed.contentSha256, action: 'publish_scopes',
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
  await publishBankScopeReview(reviewed, value.context, value.bank, signed.receipt, null, root, signed.trustedPublicKey);
  assert.equal((await loadBankScopeRegistry(root, signed.trustedPublicKey))!.contentSha256, reviewed.contentSha256);
  await assert.rejects(publishBankScopeReview(reviewed, value.context, value.bank, signed.receipt, null, root, signed.trustedPublicKey), /STALE/);
  value.context.evaluationScopeRegistry = reviewed; pinSupplySnapshot(value.context, value.session);
  const readiness = bankScopeReadiness(value.context, value.bank);
  assert.equal(readiness.specApprovedCount, 1); assert.equal(readiness.sessionEvaluationReady, false);
  assert.equal(evaluateKnowledgeGate(value.context, value.session, buildEvaluationUnits(value.session).scoredUnits[0]).scope, 'unresolved');
  assert.ok(evaluateKnowledgeGate(value.context, value.session, buildEvaluationUnits(value.session).scoredUnits[0]).holdReasons.length);
});

test('question text, contract, source and missing criteria cannot inherit a prior exact Q0 specification', async () => {
  const value = await evaluationSupplyFixture(), reviewed = reviewedSupplyRegistry(value);
  assert.doesNotThrow(() => validateBankScopeReview(reviewed, value.context, value.bank, supplyReviewer));
  for (const mutate of [
    (copy: typeof value) => { copy.bank.slots[0].candidates[0].draft.questionText += '?'; },
    (copy: typeof value) => { copy.bank.slots[0].candidates[0].draft.approvedQuestion!.semanticContractSha256 = '0'.repeat(64); },
    (copy: typeof value) => { copy.context.manifest.rulesVersion += '-changed'; },
  ]) {
    const copy = structuredClone(value); mutate(copy);
    assert.throws(() => validateBankScopeReview(reviewed, copy.context, copy.bank, supplyReviewer));
  }
  const { contentSha256: ignored, ...body } = structuredClone(reviewed); void ignored;
  body.entries[0].excludedCriteria = [];
  assert.throws(() => validateBankScopeReview(sealBankScopeRegistry(body), value.context, value.bank, supplyReviewer));
});
