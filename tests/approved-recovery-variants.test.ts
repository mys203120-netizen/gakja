import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { loadApprovedRecoveryVariants, recoveryVariantIdentity, saveApprovedRecoveryVariants } from '../server/data/approved-recovery-variants';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { QuestionDraft, RecordedTurn } from '../server/protocol';

function fixture() {
  const context = { student: { evidence: [{ id: 'E1', text: '자료를 비교했다.' }] }, manifest: { files: [{ role: 'studentPdf', path: 'synthetic.pdf', sha256: 'a'.repeat(64) }] } } as unknown as InterviewContext;
  const draft: QuestionDraft = { questionText: '자료를 비교할 때 어떤 기준을 사용했나요?', questionKind: 'main', parentMainQuestionId: null, acknowledgement: null, acknowledgementQuote: null, evidenceIds: ['E1'], evidenceQuotes: [{ evidenceId: 'E1', quote: '자료를 비교했다.' }], primaryFunction: 'CHOICE', depth: 'D2', questionIntent: '자료 비교 기준 한 가지', targetEvidence: ['자료 비교 기준 한 가지'], groundingRationale: '명시된 자료 비교의 선택 기준을 확인한다.', validationStatus: 'approved', validationFailures: [] };
  const original = { id: 'original', parentMainQuestionId: 'original', evidenceIds: ['E1'], questionText: draft.questionText, questionKind: 'main', metadata: draft } as unknown as RecordedTurn;
  const review = { verdict: 'allowed', completeAssertionCoverage: true, coreIntentCount: 1, intentMatches: true, clarificationPreservesIntent: true, premises: [{ questionSpan: '자료 비교', basis: 'record', sourceId: 'E1', supportQuote: '자료를 비교했다.', supported: true }] };
  return { context, original, variant: { questionText: '자료 비교에 사용한 기준 한 가지만 말씀해 주세요.', reviewedAt: new Date().toISOString(), reviewModel: 'explicit-synthetic-review', review } };
}

test('reviewed recovery variants retain the exact same demand and are source/version bound without provider calls', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-variant-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('recovery-variant-')); await rm(root, { recursive: true, force: true }); });
  const { context, original, variant } = fixture();
  assert.deepEqual(await loadApprovedRecoveryVariants(context, original, root), []);
  const saved = await saveApprovedRecoveryVariants(context, original, [variant], root);
  const loaded = await loadApprovedRecoveryVariants(context, original, root);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].questionKind, 'clarification');
  assert.notEqual(loaded[0].questionText, original.questionText);
  assert.equal(loaded[0].questionIntent, original.metadata.questionIntent);
  assert.deepEqual(loaded[0].targetEvidence, original.metadata.targetEvidence);
  assert.equal(loaded[0].premiseValidation?.method, 'bounded_semantic_review');
  const changed = structuredClone(original); changed.metadata.targetEvidence = ['새 근거를 요구한다'];
  assert.notEqual(recoveryVariantIdentity(context, changed), saved.identity);
  assert.deepEqual(await loadApprovedRecoveryVariants(context, changed, root), []);
  const file = path.join(root, 'data/prepared/recovery-variants', `${saved.identity}.json`);
  const tampered = JSON.parse(await readFile(file, 'utf8')); tampered.variants[0].review.clarificationPreservesIntent = false;
  const { contentSha256: oldHash, ...body } = tampered; assert.ok(oldHash);
  tampered.contentSha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  await writeFile(file, JSON.stringify(tampered));
  await assert.rejects(loadApprovedRecoveryVariants(context, original, root));
});

test('an identical replay or a rejected independent review is not a recovery variant', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-variant-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('recovery-variant-')); await rm(root, { recursive: true, force: true }); });
  const { context, original, variant } = fixture();
  await assert.rejects(saveApprovedRecoveryVariants(context, original, [{ ...variant, questionText: original.questionText }], root), /REVIEW_INVALID/u);
  await assert.rejects(saveApprovedRecoveryVariants(context, original, [{ ...variant, review: { ...variant.review, verdict: 'rewrite' } }], root));
});
