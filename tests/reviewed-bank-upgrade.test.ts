import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadReviewedBankUpgrade, offlineSurfaceReviewDiagnostics, prepareReviewedBankUpgrade, rebuiltReviewedBankDraft, withReservedBankUpgradeReport } from '../scripts/prepare-reviewed-bank-upgrade';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { InterviewSession } from '../server/protocol';

const reviewPath = 'artifacts/quality-next-bank-developer-review-20261104.json';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

test('metadata-only bank migration uses the reviewed target and preserves old source approval without copying the old semantic contract', async () => {
  const { review, bank } = await loadReviewedBankUpgrade(process.cwd(), reviewPath);
  const row = review.rows.find(row => row.developerDisposition === 'revise_contract' && row.primaryFunction === 'FACT')!;
  const original = bank.slots.flatMap(slot => slot.candidates).find(candidate => candidate.id === row.candidateId)!;
  const oldText = JSON.stringify(original), objective = structuredClone(bank.plan.slots.find(slot => slot.objective?.id === row.objectiveId)!.objective!);
  Object.assign(objective, { questionIntent: row.questionIntent, targetEvidence: row.targetEvidence, primaryFunction: row.primaryFunction, depth: row.depth });
  const session = { turns: [], plan: { slots: [{ objective }] } } as unknown as InterviewSession;
  const context = { targetAnalysis: { objectiveContractRevision: { changedObjectiveIds: [objective.id], approvedQuestions: [{ objectiveId: objective.id, questionSha256: row.questionSha256 }] } } } as unknown as InterviewContext;
  const result = rebuiltReviewedBankDraft(original, row, context, session);
  assert.equal(result.draft.questionText, original.draft.questionText);
  assert.deepEqual(result.draft.premiseValidation, original.draft.premiseValidation);
  assert.equal(result.draft.primaryFunction, 'FACT');
  assert.equal(result.draft.approvedQuestion, undefined, 'a fresh semantic contract must be built for the reviewed new metadata');
  assert.equal(JSON.stringify(original), oldText, 'the old immutable candidate remains unchanged');
  const stale = structuredClone(context); stale.targetAnalysis!.objectiveContractRevision!.approvedQuestions![0].questionSha256 = 'a'.repeat(64);
  assert.throws(() => rebuiltReviewedBankDraft(original, row, stale, session), /STAGED_REVIEW_BINDING_INVALID/u);
});

test('a proposed surface rewrite drops old premise approval and requires its exact reviewed new utterance hash', async () => {
  const { review, bank } = await loadReviewedBankUpgrade(process.cwd(), reviewPath);
  const row = review.rows.find(row => row.developerDisposition === 'rewrite_question')!;
  const original = bank.slots.flatMap(slot => slot.candidates).find(candidate => candidate.id === row.candidateId)!;
  const objective = structuredClone(bank.plan.slots.find(slot => slot.objective?.id === row.objectiveId)!.objective!);
  Object.assign(objective, { questionIntent: row.questionIntent, targetEvidence: row.targetEvidence, primaryFunction: row.primaryFunction, depth: row.depth });
  const session = { turns: [], plan: { slots: [{ objective }] } } as unknown as InterviewSession;
  const context = { targetAnalysis: { objectiveContractRevision: { changedObjectiveIds: [objective.id], approvedQuestions: [{ objectiveId: objective.id, questionSha256: sha(row.proposedQuestion!) }] } } } as unknown as InterviewContext;
  const result = rebuiltReviewedBankDraft(original, row, context, session);
  assert.equal(result.draft.questionText, row.proposedQuestion);
  assert.equal(result.draft.premiseValidation, undefined);
  assert.equal(result.draft.approvedQuestion, undefined);
  assert.equal(original.draft.premiseValidation?.status, 'approved', 'the old question keeps its own old approval');
  assert.throws(() => rebuiltReviewedBankDraft(original, { ...row, proposedQuestion: row.proposedQuestion! + ' 새 과제도 설명해 주세요.' }, context, session), /STAGED_REVIEW_BINDING_INVALID/u);
  assert.equal(sha(await readFile(review.bank.path)), review.bank.fileSha256);
});

test('an existing output fails before provider, activation or analysis staging and is never truncated', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bank-report-reservation-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('bank-report-reservation-')); await rm(root, { recursive: true, force: true }); });
  await mkdir(path.join(root, 'artifacts'));
  const file = path.join(root, 'artifacts', 'existing.json'), original = '{"preserved":"original reviewed report"}\n';
  await writeFile(file, original);
  const entered = { provider: 0, activation: 0, staging: 0 };
  await assert.rejects(withReservedBankUpgradeReport(root, 'artifacts/existing.json', async () => { entered.provider++; entered.activation++; entered.staging++; }), { code: 'EEXIST' });
  assert.deepEqual(entered, { provider: 0, activation: 0, staging: 0 });
  // This workspace deliberately lacks every context/source file and key. Seeing
  // EEXIST proves the actual entry point does not even enter its context stage.
  for (const mode of ['prepare', 'activate', 'stage_contracts'] as const) {
    await assert.rejects(prepareReviewedBankUpgrade({ root, reviewPath: 'missing-review.json', revisionPath: 'missing-analysis.json', output: 'artifacts/existing.json', mode, maxLlmCalls: 24, maxTtsCalls: 6 }), { code: 'EEXIST' });
  }
  assert.equal(await readFile(file, 'utf8'), original);
});

test('an exclusively owned report preserves operation failure and commit state, including shortening a prior reservation', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bank-report-failure-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('bank-report-failure-')); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(withReservedBankUpgradeReport(root, 'artifacts/failure.json', async report => {
    const current = { mode: 'explicit_synthetic_test', activated: true, llmRequests: [{ synthetic: true }] };
    await report.write({ ...current, longTemporaryDiagnostic: 'x'.repeat(2000) });
    report.track(current);
    throw new Error('EXPLICIT_SYNTHETIC_FAILURE');
  }), /EXPLICIT_SYNTHETIC_FAILURE/u);
  const saved = JSON.parse(await readFile(path.join(root, 'artifacts/failure.json'), 'utf8'));
  assert.equal(saved.activated, true); assert.equal(saved.llmRequests.length, 1);
  assert.equal(saved.failure, 'EXPLICIT_SYNTHETIC_FAILURE');
  assert.equal(saved.longTemporaryDiagnostic, undefined);
  let entered = false;
  await assert.rejects(withReservedBankUpgradeReport(root, '../outside.json', async () => { entered = true; }), /OUTPUT_PATH_INVALID/u);
  assert.equal(entered, false);
});

test('offline surface audit records incomplete-output diagnostics without copying unfinished private text or unrelated fields', () => {
  const diagnostics = offlineSurfaceReviewDiagnostics({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens', unrelated: 'never copy' }, output_parsed: null,
    output_text: 'unfinished-private-student-source', usage: { output_tokens: 1800, output_tokens_details: { reasoning_tokens: 141 } }, private_header: 'never copy' });
  assert.deepEqual(diagnostics, { status: 'incomplete', incompleteReason: 'max_output_tokens', outputParsedPresent: false, outputTextCharacters: 33, outputTokens: 1800, reasoningTokens: 141, configuredMaxOutputTokens: 4000 });
  assert.doesNotMatch(JSON.stringify(diagnostics), /unfinished-private|never copy/u);
  const completed = offlineSurfaceReviewDiagnostics({ status: 'completed', output_parsed: { verdict: 'allowed' }, output_text: 'parsed', usage: { output_tokens: 321 } });
  assert.equal(completed.outputParsedPresent, true); assert.equal(completed.incompleteReason, null);
  assert.equal(completed.outputTokens, 321); assert.equal(completed.reasoningTokens, null);
});
