import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createLocalReviewRepository } from '../server/repositories/local-review-repository';
import type { ReviewRepository } from '../server/repositories/review-ports';
import { loadBankScopeRegistry, publishBankScopeReview, sealBankScopeRegistry } from '../server/data/evaluation-scope-registry';
import { createReviewedEvaluationKnowledgeContext } from '../server/data/reviewed-evaluation-context';
import { buildEvaluationUnits } from '../server/providers/evaluation-turns';
import { evaluateKnowledgeGate } from '../server/providers/evaluation-knowledge-gate';
import { knowledgeHash } from '../server/data/approved-knowledge';
import { evaluationSupplyFixture, reviewedSupplyRegistry, supplyRecordBundle, supplySigner, supplyReviewer } from './fixtures/evaluation-supply';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'pr06d-review-repository-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('pr06d-review-repository-')); await rm(root, { recursive: true, force: true }); });
  const value = await evaluationSupplyFixture(), registry = reviewedSupplyRegistry(value), signer = supplySigner();
  const receipt = (row = registry) => signer.receipt({ version: 'authenticated-bank-scope-review-v1', actorId: supplyReviewer,
    registrySha256: row.contentSha256, action: 'publish_scopes', issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString() });
  const publish = (row = registry, signed = receipt(row), expected: string | null = null, repository?: ReviewRepository) =>
    publishBankScopeReview(row, value.context, value.bank, signed, expected, root, signer.trustedPublicKey, repository);
  const { contentSha256: ignored, ...body } = structuredClone(registry); void ignored;
  body.entries[0].review = { ...body.entries[0].review, status: 'withdrawn', approverId: supplyReviewer, reviewedAt: new Date().toISOString(), reason: 'explicit synthetic withdrawal' };
  const withdrawn = sealBankScopeRegistry(body);
  return { root, value, registry, withdrawn, signer, receipt, publish, base: path.join(root, 'data/prepared/evaluation-scope-registry') };
}

test('injected local review repository is fresh on repeated reads and signed A never supplies B authority', async t => {
  const h = await fixture(t), repository = createLocalReviewRepository(h.root), signed = h.receipt();
  await h.publish(h.registry, signed, null, repository);
  assert.equal((await loadBankScopeRegistry('UNUSED_ROOT', h.signer.trustedPublicKey, repository))!.contentSha256, h.registry.contentSha256);
  const gate = evaluateKnowledgeGate({ ...h.value.context, evaluationScopeRegistry: h.registry }, h.value.session, buildEvaluationUnits(h.value.session).scoredUnits[0]);
  assert.equal(gate.scope, 'unresolved'); assert.ok(gate.holdReasons.includes('KNOWLEDGE_SCOPE_APPROVAL_REQUIRED'));
  await h.publish(h.withdrawn, h.receipt(h.withdrawn), h.registry.contentSha256, repository);
  assert.equal((await loadBankScopeRegistry('UNUSED_ROOT', h.signer.trustedPublicKey, repository))!.entries[0].review.status, 'withdrawn');
});

test('signature, actor and exact source/question checks happen before any registry writer call', async t => {
  const h = await fixture(t); let writes = 0;
  const repository = createLocalReviewRepository(h.root, { io: { mkdir: (async () => { writes++; }) as typeof mkdir } });
  await assert.rejects(h.publish(h.registry, { ...h.receipt(), signature: 'invalid' }, null, repository), /AUTHENTICATED_REVIEW/);
  const wrongActor = h.signer.receipt({ ...h.receipt(), actorId: 'explicit-wrong-reviewer', signature: undefined });
  await assert.rejects(h.publish(h.registry, wrongActor, null, repository));
  const changed = structuredClone(h.value.context); changed.manifest.rulesVersion += '-changed';
  await assert.rejects(publishBankScopeReview(h.registry, changed, h.value.bank, h.receipt(), null, h.root, h.signer.trustedPublicKey, repository), /BINDING_CHANGED/);
  assert.equal(writes, 0);
});

test('actual wx publication lock and domain CAS reject competing and stale publishers without replacement', async t => {
  const h = await fixture(t); let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const repository = createLocalReviewRepository(h.root, { io: { open: async (...args) => { const handle = await open(...args); if (first) { first = false; enter(); await held; } return handle; } } });
  const signed = h.receipt(), a = h.publish(h.registry, signed, null, repository); await entered;
  try { await assert.rejects(h.publish(h.registry, signed, null, repository), { code: 'EEXIST' }); }
  finally { release(); await a; }
  await assert.rejects(h.publish(h.registry, signed, null, repository), /POINTER_STALE/);
  assert.equal((await loadBankScopeRegistry(h.root, h.signer.trustedPublicKey))!.contentSha256, h.registry.contentSha256);
  assert.equal((await readdir(h.base)).includes('publish.lock'), false);
});

test('pointer rename failure preserves the old current, immutable new revision and existing orphan-temp semantics', async t => {
  const h = await fixture(t); await h.publish();
  const error = Object.assign(new Error('synthetic-pointer-rename-denied'), { code: 'EPERM' }); let renames = 0;
  const repository = createLocalReviewRepository(h.root, { io: { rename: async () => { renames++; throw error; } } });
  const signed = h.receipt(h.withdrawn);
  await assert.rejects(h.publish(h.withdrawn, signed, h.registry.contentSha256, repository), value => value === error);
  assert.equal(renames, 1); assert.equal((await loadBankScopeRegistry(h.root, h.signer.trustedPublicKey))!.contentSha256, h.registry.contentSha256);
  assert.equal((await readdir(path.join(h.base, 'revisions'))).length, 2);
  assert.equal((await readdir(h.base)).filter(file => file.endsWith('.tmp')).length, 1); assert.equal((await readdir(h.base)).includes('publish.lock'), false);
  await h.publish(h.withdrawn, signed, h.registry.contentSha256);
  assert.equal((await loadBankScopeRegistry(h.root, h.signer.trustedPublicKey))!.contentSha256, h.withdrawn.contentSha256);
});

test('partial immutable revision failure leaves the old current valid and cannot silently repair or approve corrupt content', async t => {
  const h = await fixture(t); await h.publish();
  const error = Object.assign(new Error('synthetic-review-disk-full'), { code: 'ENOSPC' });
  const repository = createLocalReviewRepository(h.root, { io: { writeFile: async (file, content, options) => {
    if (String(file).endsWith(`${h.withdrawn.contentSha256}.json`)) { await writeFile(file, '{', options); throw error; }
    await writeFile(file, content, options);
  } } });
  const signed = h.receipt(h.withdrawn);
  await assert.rejects(h.publish(h.withdrawn, signed, h.registry.contentSha256, repository), value => value === error);
  assert.equal((await loadBankScopeRegistry(h.root, h.signer.trustedPublicKey))!.contentSha256, h.registry.contentSha256);
  await assert.rejects(h.publish(h.withdrawn, signed, h.registry.contentSha256), { code: 'EEXIST' });
  await writeFile(path.join(h.base, 'current.json'), JSON.stringify({ contentSha256: h.withdrawn.contentSha256 }));
  await assert.rejects(loadBankScopeRegistry(h.root, h.signer.trustedPublicKey), SyntaxError);
});

test('lock cleanup failure remains a publication error and does not manufacture lock recovery', async t => {
  const h = await fixture(t), error = Object.assign(new Error('synthetic-lock-unlink-denied'), { code: 'EACCES' });
  const repository = createLocalReviewRepository(h.root, { io: { unlink: async () => { throw error; } } });
  await assert.rejects(h.publish(h.registry, h.receipt(), null, repository), value => value === error);
  assert.equal((await loadBankScopeRegistry(h.root, h.signer.trustedPublicKey))!.contentSha256, h.registry.contentSha256);
  await assert.rejects(h.publish(h.registry, h.receipt(), h.registry.contentSha256), { code: 'EEXIST' });
});

test('pointer/revision corruption and missing data retain existing null versus rejection behavior', async t => {
  const h = await fixture(t), repository = createLocalReviewRepository(h.root);
  assert.equal(await loadBankScopeRegistry(h.root, h.signer.trustedPublicKey, repository), null);
  await repository.ensureRegistryRevisions(); await writeFile(path.join(h.base, 'current.json'), '{');
  await assert.rejects(loadBankScopeRegistry(h.root, h.signer.trustedPublicKey, repository), /POINTER_INVALID/);
  await writeFile(path.join(h.base, 'current.json'), JSON.stringify({ contentSha256: 'f'.repeat(64) }));
  await assert.rejects(loadBankScopeRegistry(h.root, h.signer.trustedPublicKey, repository), { code: 'ENOENT' });
});

test('shared immutable bundle/receipt/context persistence preserves exact provenance paths, bytes and conflict errors', async t => {
  const h = await fixture(t), repository = createLocalReviewRepository(h.root), digest = knowledgeHash('explicit-synthetic-review-object');
  const content = '{\n  "synthetic": true\n}';
  await repository.writeKnowledgeRevision(digest, content); await repository.writeKnowledgeRevision(digest, content);
  await repository.writeSessionReceipt(digest, content); await repository.writeEvaluationContext(digest, content, { encoding: 'utf8' });
  assert.equal(repository.knowledgeRevisionPath(digest), `data/prepared/approved-knowledge/revisions/${digest}.json`);
  assert.equal(repository.evaluationContextPath(digest), `data/prepared/approved-knowledge/evaluation-contexts/${digest}.json`);
  assert.equal(await readFile(path.join(h.root, repository.knowledgeRevisionPath(digest)), 'utf8'), content);
  assert.equal(await repository.readSessionReceipt(digest), content);
  await assert.rejects(repository.writeKnowledgeRevision(digest, content + ' '), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(h.root, repository.knowledgeRevisionPath(digest)), 'utf8'), content);
});

test('pure reviewed-context gate retains exact B bindings and rejects corrected answers', async t => {
  const h = await fixture(t), bundle = supplyRecordBundle(h.value.session), content = JSON.stringify(bundle, null, 2);
  const provenance = { path: `data/prepared/approved-knowledge/revisions/${bundle.contentSha256}.json`, fileSha256: knowledgeHash(content) };
  const before = JSON.stringify(h.value.context), projected = createReviewedEvaluationKnowledgeContext(h.value.context, h.value.session, bundle, provenance);
  assert.deepEqual(projected.decisions[0].holdReasons, []); assert.equal(JSON.stringify(h.value.context), before);
  const changed = structuredClone(h.value.session); changed.turns[0].rawTranscript += ' 답변 정정';
  assert.throws(() => createReviewedEvaluationKnowledgeContext(h.value.context, changed, bundle, provenance), /BINDING_INVALID/);
});

test('a fresh process reads the same signed registry from actual local files', async t => {
  const h = await fixture(t); await h.publish();
  const code = `import(${JSON.stringify(pathToFileURL(path.resolve('server/data/evaluation-scope-registry.ts')).href)}).then(async m=>console.log(JSON.stringify({digest:(await m.loadBankScopeRegistry(${JSON.stringify(h.root)},${JSON.stringify(h.signer.trustedPublicKey)})).contentSha256})))`;
  const child = await promisify(execFile)(process.execPath, ['--import', pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href, '-e', code], { windowsHide: true, timeout: 10_000 });
  assert.equal(JSON.parse(child.stdout).digest, h.registry.contentSha256);
});
