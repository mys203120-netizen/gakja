import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadQuestionPurposeLineage, publishExactQuestionPurposeLineageRebind, questionPurposeLineageDigest, QUESTION_PURPOSE_LINEAGE_DIRECTORY, type QuestionPurposeLineageRegistry } from '../server/data/question-purpose-lineage';
import { questionSelectionScope, rankQuestionSlots, sessionPlanFromPool } from '../server/question-selection';
import type { PreparedQuestionBank } from '../server/data/prepared-question-bank';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { InterviewPlanSlot } from '../server/interview-planner';
import type { InterviewSession } from '../server/protocol';

const pdf = 'a'.repeat(64), currentKey = '1'.repeat(64), previousKey = '2'.repeat(64);
const target = { university: 'Synthetic University', department: 'Synthetic Department' };
const context = { target, student: { studentId: 'student-a', ownerId: 'owner-a', pdfSha256: pdf, evidence: [] }, school: { interview: { id: 'track-a' } }, manifest: { sourceIntegrity: { pdfHashVerified: true } } } as unknown as InterviewContext;
const scope = questionSelectionScope(context), proof = { sourceId: 'source-shared', revision: pdf, start: 0, end: 12 };
const bytesHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function slot(id: string, semanticKey: string): InterviewPlanSlot {
  return { id, index: 1, label: semanticKey, semanticKey, activityIds: ['same-activity'], evidenceIds: ['source-shared'], topicArea: 'evidence_limits', primaryFunction: 'EVIDENCE', questionIntent: semanticKey, depth: 'D3', interviewerId: 'interviewer-1', interviewerRole: 'academic', schoolConnections: [] };
}
function bank(key: string, semanticKey: string, text: string) {
  const planned = slot(`${key[0]}-slot`, semanticKey), questionSha256 = bytesHash(text);
  const candidate = { id: `${key[0]}-candidate`, slotId: planned.id, mainIndex: 1, variant: 0, questionSha256,
    draft: { questionText: text, validationStatus: 'approved', questionBlueprint: { anchorRefs: [{ kind: 'RECORD', ...proof }] } } };
  const content = { status: 'ready', key, target, plan: { slots: [planned], limitations: [] }, slots: [{ slotId: planned.id, candidates: [candidate] }] };
  return { ...content, contentSha256: questionPurposeLineageDigest(content) } as unknown as PreparedQuestionBank;
}
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'question-purpose-lineage-'));
  const current = bank(currentKey, 'current-basis', 'What supports the current comparison?'), previous = bank(previousKey, 'previous-basis', 'What was the earlier comparison based on?');
  const bankDirectory = path.join(root, 'data/prepared/question-banks'); await mkdir(bankDirectory, { recursive: true });
  const currentBytes = JSON.stringify(current), oldBytes = JSON.stringify(previous);
  await writeFile(path.join(bankDirectory, `${currentKey}.json`), currentBytes); await writeFile(path.join(bankDirectory, `${previousKey}.json`), oldBytes);
  const reference = (value: PreparedQuestionBank) => ({ slotId: value.plan.slots[0].id, candidateId: value.slots[0].candidates[0].id, semanticKey: value.plan.slots[0].semanticKey!, questionText: value.slots[0].candidates[0].draft.questionText, questionSha256: value.slots[0].candidates[0].questionSha256, proofKeys: [proof] });
  const content = { schemaVersion: 'reviewed-question-purpose-lineage-v1', bank: { key: currentKey, fileSha256: bytesHash(currentBytes), contentSha256: current.contentSha256 }, sourcePdfSha256: pdf, targetSha256: questionPurposeLineageDigest(target), scope,
    previousBanks: [{ key: previousKey, fileSha256: bytesHash(oldBytes), contentSha256: previous.contentSha256 }],
    links: [{ id: 'reviewed-link', current: reference(current), previous: [{ ...reference(previous), bankKey: previousKey }], previousSemanticKeys: ['previous-basis'], reviewType: 'same_q0_verification_demand', verificationDemand: 'A single comparison basis.', reviewRationale: 'Explicit synthetic review of exact utterances and shared proof.', policyBasis: ['MD9 article 2(6), article 5(4)'] }],
    review: { reviewer: 'codex-source-review', reviewedAt: '2026-11-04T00:00:00.000Z', authority: 'explicit_review_of_exact_bank_utterances_and_source_proofs' } };
  const registry = { ...content, contentSha256: questionPurposeLineageDigest(content) } as QuestionPurposeLineageRegistry;
  const registryPath = path.join(root, QUESTION_PURPOSE_LINEAGE_DIRECTORY, `${currentKey}.json`);
  const writeRegistry = async (resign = false) => { if (resign) { const { contentSha256: digest, ...rest } = registry; void digest; registry.contentSha256 = questionPurposeLineageDigest(rest); } await mkdir(path.dirname(registryPath), { recursive: true }); await writeFile(registryPath, JSON.stringify(registry)); };
  const close = async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('question-purpose-lineage-')); await rm(root, { recursive: true, force: true }); };
  return { root, current, previous, registry, registryPath, writeRegistry, close };
}

test('absence is explicit; a verified exact-purpose link transfers history without merging another purpose in the same activity', async t => {
  const fixture = await setup(); t.after(() => fixture.close());
  assert.equal(await loadQuestionPurposeLineage(context, fixture.current, fixture.root), undefined);
  await fixture.writeRegistry(); const lineage = await loadQuestionPurposeLineage(context, fixture.current, fixture.root); assert.ok(lineage);
  const current = slot('current', 'current-basis'), different = slot('different', 'same-activity-different-purpose');
  const history = { id: 'past', createdAt: '2026-11-03T00:00:00.000Z', target, plan: { poolKey: previousKey, poolContentSha256: fixture.previous.contentSha256, selectionContext: { scope } }, questionPresentations: [{ turnId: 'played', startedAtMs: 10 }], turns: [{ id: 'played', questionKind: 'main', questionText: fixture.previous.slots[0].candidates[0].draft.questionText, metadata: { selectionTrace: { semanticKey: 'previous-basis', bankKey: previousKey, bankCandidateId: fixture.previous.slots[0].candidates[0].id } } }] } as unknown as InterviewSession;
  assert.deepEqual(rankQuestionSlots([current, different], target, { scope, purposeLineage: lineage, history: [history], sessionSeed: 'fixed' }).map(row => row.semanticKey), ['same-activity-different-purpose', 'current-basis']);
  assert.equal(history.turns[0].metadata.selectionTrace?.semanticKey, 'previous-basis');
  for (const change of ['bank', 'utterance', 'candidate'] as const) {
    const unverified = structuredClone(history);
    if (change === 'bank') unverified.plan!.poolContentSha256 = 'not-the-reviewed-old-bank';
    if (change === 'utterance') unverified.turns[0].questionText = 'An unreviewed question with a reused metadata key.';
    if (change === 'candidate') unverified.turns[0].metadata.selectionTrace!.bankCandidateId = 'unreviewed-candidate';
    assert.deepEqual(rankQuestionSlots([current, different], target, { scope, purposeLineage: lineage, history: [unverified], sessionSeed: 'fixed' }), rankQuestionSlots([current, different], target, { scope, purposeLineage: lineage, sessionSeed: 'fixed' }));
  }
  const pool = { policyVersion: 'synthetic', durationSeconds: 720, mainQuestionTarget: 2, slots: [current, different], limitations: [] };
  const plan = sessionPlanFromPool(pool, target, fixture.current, { scope, purposeLineage: lineage, history: [history] });
  assert.deepEqual(plan.selectionContext?.purposeLineage, lineage); assert.notEqual(plan.selectionContext?.purposeLineage, lineage);
  assert.throws(() => sessionPlanFromPool(pool, target, { key: previousKey, contentSha256: fixture.previous.contentSha256 }, { scope, purposeLineage: lineage }), /QUESTION_PURPOSE_LINEAGE_BANK_MISMATCH/u);
});

test('tampered review bytes, exact utterance, source proof, target, owner and PDF fail closed', async t => {
  for (const mutation of ['self-hash', 'utterance', 'proof', 'target', 'scope', 'pdf'] as const) await t.test(mutation, async child => {
    const fixture = await setup(); child.after(() => fixture.close());
    if (mutation === 'self-hash') fixture.registry.links[0].reviewRationale += ' changed';
    if (mutation === 'utterance') fixture.registry.links[0].current.questionText += ' changed';
    if (mutation === 'proof') fixture.registry.links[0].current.proofKeys[0] = { ...proof, sourceId: 'unreviewed-proof' };
    if (mutation === 'target') fixture.registry.targetSha256 = 'b'.repeat(64);
    if (mutation === 'scope') fixture.registry.scope = { ...scope, ownerId: 'another-owner' };
    if (mutation === 'pdf') fixture.registry.sourcePdfSha256 = 'c'.repeat(64);
    await fixture.writeRegistry(mutation !== 'self-hash');
    await assert.rejects(loadQuestionPurposeLineage(context, fixture.current, fixture.root), /QUESTION_PURPOSE_LINEAGE_INVALID/u);
  });
});

test('old bank byte tampering and full-content tampering cannot manufacture a reviewed relation', async t => {
  const fixture = await setup(); t.after(() => fixture.close()); await fixture.writeRegistry();
  const file = path.join(fixture.root, 'data/prepared/question-banks', `${previousKey}.json`);
  await writeFile(file, `${JSON.stringify(fixture.previous)} `);
  await assert.rejects(loadQuestionPurposeLineage(context, fixture.current, fixture.root), /QUESTION_PURPOSE_LINEAGE_INVALID/u);
  const changed = { ...fixture.previous, sourceFingerprint: 'changed-original-bank' }, bytes = JSON.stringify(changed);
  await writeFile(file, bytes); fixture.registry.previousBanks[0].fileSha256 = bytesHash(bytes); await fixture.writeRegistry(true);
  await assert.rejects(loadQuestionPurposeLineage(context, fixture.current, fixture.root), /QUESTION_PURPOSE_LINEAGE_INVALID/u);
});

test('exact reviewed lineage can bind a new bank and candidate ID; changed words or proof require another review', async t => {
  const fixture = await setup(); t.after(() => fixture.close()); await fixture.writeRegistry();
  const destination = bank('3'.repeat(64), 'current-basis', fixture.current.slots[0].candidates[0].draft.questionText);
  await writeFile(path.join(fixture.root, 'data/prepared/question-banks', `${destination.key}.json`), JSON.stringify(destination));
  const result = await publishExactQuestionPurposeLineageRebind(context, fixture.current, destination, fixture.root);
  assert.equal(result.bankKey, destination.key); assert.equal(result.links[0].currentSemanticKey, 'current-basis');
  assert.deepEqual(result.links[0].previousSemanticKeys, ['previous-basis']);
  assert.deepEqual(await publishExactQuestionPurposeLineageRebind(context, fixture.current, destination, fixture.root), result, 'Republishing the same verified relation is idempotent');
  const changed = bank('4'.repeat(64), 'current-basis', 'A changed verification demand.');
  await writeFile(path.join(fixture.root, 'data/prepared/question-banks', `${changed.key}.json`), JSON.stringify(changed));
  await assert.rejects(publishExactQuestionPurposeLineageRebind(context, fixture.current, changed, fixture.root), /QUESTION_PURPOSE_LINEAGE_INVALID/u);
  const wrongProof = bank('5'.repeat(64), 'current-basis', fixture.current.slots[0].candidates[0].draft.questionText);
  wrongProof.slots[0].candidates[0].draft.questionBlueprint!.anchorRefs[0].sourceId = 'different-proof';
  const { contentSha256: digest, ...content } = wrongProof; void digest; wrongProof.contentSha256 = questionPurposeLineageDigest(content);
  await writeFile(path.join(fixture.root, 'data/prepared/question-banks', `${wrongProof.key}.json`), JSON.stringify(wrongProof));
  await assert.rejects(publishExactQuestionPurposeLineageRebind(context, fixture.current, wrongProof, fixture.root), /QUESTION_PURPOSE_LINEAGE_INVALID/u);
});

test('the reviewed real CNT relation binds both preserved bank files and all three observed histories', async () => {
  const key = 'ba50dc36ff7ad04e96bbc2d23a6baf0582faf740cb5cdd1d56aa4b2ac5989e18';
  const current = JSON.parse(await readFile(`data/prepared/question-banks/${key}.json`, 'utf8')) as PreparedQuestionBank;
  const ids = ['2c31b6ae-151c-481c-a39a-1abe97f9ef5a', 'c2d3e0bc-e332-4c10-bef0-0a39ce5106f6', 'aa8dd0b8-b372-4a70-b068-0dff607c0e7d'];
  const history = await Promise.all(ids.map(async id => JSON.parse(await readFile(`data/sessions/${id}.json`, 'utf8')) as InterviewSession));
  const actualScope = history[0].plan!.selectionContext!.scope!;
  const actualContext = { ...context, target: current.target, student: { ...context.student, studentId: actualScope.studentId, ownerId: actualScope.ownerId, pdfSha256: 'bd34721f692a6774a2242d3259757f406d30154d20dcb0d747281ead3d26555f' }, school: { interview: { id: actualScope.supportTargetId } } } as unknown as InterviewContext;
  const lineage = await loadQuestionPurposeLineage(actualContext, current); assert.ok(lineage); assert.equal(lineage.links.length, 1);
  const approved = current.plan.slots.filter(slot => current.slots.some(row => row.slotId === slot.id && !row.quarantine && row.candidates.length));
  const ranked = rankQuestionSlots(approved, current.target, { scope: actualScope, history, purposeLineage: lineage, sessionSeed: 'actual-reviewed-history' });
  const currentPurpose = lineage.links[0].currentSemanticKey;
  assert.ok(ranked.findIndex(slot => slot.semanticKey === currentPurpose) >= 22, 'The three prior CNT uses rank behind the 22 genuinely unused approved purposes');
  assert.equal(ranked.filter(slot => slot.activityIds.includes('YJW-ACT-11')).length, 2, 'The distinct oxidation-limit purpose remains available');
});
