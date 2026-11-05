import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { repairPartialBankSurface, validatePartialSurfaceProposal, validateResumablePartialSurfaceReview, type PartialSurfaceProposal, type PartialSurfaceResumeBinding } from '../scripts/repair-partial-bank-surface';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const question = '두 경험이 관심에서 연결된 부분이 있나요?';
  const candidate = { id: 'candidate-1', questionSha256: sha(question), draft: { questionText: question, questionIntent: '두 경험의 관심 연결 여부', targetEvidence: ['연결 여부에 대한 본인의 설명'], primaryFunction: 'CONNECTION', depth: 'D2', evidenceIds: ['source-1', 'source-2'] } };
  const partial = { key: 'a'.repeat(64), status: 'preparing', plan: { slots: [{ id: 'slot-1', objective: { id: 'objective-1' } }] }, slots: [{ slotId: 'slot-1', mainIndex: 1, candidates: [candidate] }] } as unknown as Parameters<typeof validatePartialSurfaceProposal>[0];
  const partialSha256 = sha(JSON.stringify(partial));
  const proposal: PartialSurfaceProposal = { version: 'reviewed-partial-surface-proposal-v1', bankKey: partial.key, revisionPath: 'synthetic-analysis', partialSha256, slotId: 'slot-1', objectiveId: 'objective-1', candidateId: candidate.id, candidateContentSha256: sha(JSON.stringify(candidate)), previousQuestion: question, previousQuestionSha256: candidate.questionSha256,
    proposedQuestion: '두 경험이 관심에서 연결된 부분이 있다면 어떤 점인가요?', semanticContract: { questionIntent: candidate.draft.questionIntent, targetEvidence: candidate.draft.targetEvidence, primaryFunction: 'CONNECTION', depth: 'D2', evidenceIds: candidate.draft.evidenceIds }, reviewArtifact: { path: 'artifacts/synthetic-review.json', sha256: sha('synthetic-review') }, reason: '명시적인 합성 부분은행 경계 검사이며 실제 발화 승인이 아니다.' };
  return { partial, proposal, partialSha256 };
}

test('one partial surface proposal pins the complete checkpoint, candidate bytes, question hash and unchanged semantic contract', () => {
  const f = fixture(), before = JSON.stringify(f.partial);
  assert.equal(validatePartialSurfaceProposal(f.partial, f.proposal, f.partialSha256).candidate.id, f.proposal.candidateId);
  assert.equal(JSON.stringify(f.partial), before);
  assert.throws(() => validatePartialSurfaceProposal(f.partial, f.proposal, sha('another-checkpoint')), /CHECKPOINT_CHANGED/u);
  for (const change of [{ candidateId: 'another-candidate' }, { objectiveId: 'another-objective' }, { previousQuestionSha256: sha('another-question') }, { candidateContentSha256: sha('altered-candidate') }, { semanticContract: { ...f.proposal.semanticContract, targetEvidence: ['새로운 근거도 함께 설명'] } }]) {
    assert.throws(() => validatePartialSurfaceProposal(f.partial, { ...f.proposal, ...change }, f.partialSha256), /REVIEW_BINDING_INVALID/u);
  }
  const ready = { ...f.partial, status: 'ready' } as unknown as typeof f.partial;
  assert.throws(() => validatePartialSurfaceProposal(ready, f.proposal, f.partialSha256), /CHECKPOINT_CHANGED/u);
  const quarantine = structuredClone(f.partial); quarantine.slots[0].quarantine = { status: 'quarantined' } as never;
  assert.throws(() => validatePartialSurfaceProposal(quarantine, f.proposal, f.partialSha256), /REVIEW_BINDING_INVALID/u);
});

test('a ready immutable bank or existing report blocks this operation before any provider or partial write', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'partial-surface-boundary-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('partial-surface-boundary-')); await rm(root, { recursive: true, force: true }); });
  await mkdir(path.join(root, 'artifacts')); await mkdir(path.join(root, 'data/prepared/question-banks'), { recursive: true });
  const bankKey = 'a'.repeat(64), readyPath = path.join(root, `data/prepared/question-banks/${bankKey}.json`), bytes = '{"immutable":"ready bank"}';
  await writeFile(readyPath, bytes); await writeFile(path.join(root, 'proposal.json'), JSON.stringify({ bankKey }));
  await assert.rejects(repairPartialBankSurface({ root, proposalPath: 'proposal.json', output: 'artifacts/attempt.json', runLive: true, maxLlmCalls: 1, maxTtsCalls: 1 }), /READY_BANK_IMMUTABLE/u);
  assert.equal(await readFile(readyPath, 'utf8'), bytes);
  const report = JSON.parse(await readFile(path.join(root, 'artifacts/attempt.json'), 'utf8'));
  assert.equal(report.externalProviderCalls, 0); assert.equal(report.committed, false);
  assert.equal(report.failure, 'PARTIAL_SURFACE_READY_BANK_IMMUTABLE');
  await assert.rejects(repairPartialBankSurface({ root, proposalPath: 'missing-proposal.json', output: 'artifacts/attempt.json', runLive: true, maxLlmCalls: 1, maxTtsCalls: 1 }), { code: 'EEXIST' });
});

test('zero-provider resume requires the exact failed review, proposal, speech, model and original checkpoint snapshot', () => {
  const current = { bankKey: 'a'.repeat(64), proposalSha256: sha('frozen-proposal'), candidateId: 'candidate-1', objectiveId: 'objective-1', originalPartialSha256: sha('original-checkpoint'), originalQuestion: '기존 합성 질문인가요?', proposedQuestion: '조건이 맞는다면 어떤 점인가요?', reviewModel: 'synthetic-bank-reviewer' };
  const wire = { verdict: 'allowed', premises: [{ sourceId: 'synthetic-source' }] };
  const previous: PartialSurfaceResumeBinding = { ...current, failure: 'PARTIAL_SURFACE_STANDARD_VALIDATION_FAILED', committed: false, semanticContractPreserved: true, llmCalls: 1, finalPremiseReview: wire };
  assert.equal(validateResumablePartialSurfaceReview(current, previous, current.originalPartialSha256), wire);
  for (const change of [{ failure: 'PREMISE_UNSUPPORTED' }, { committed: true }, { semanticContractPreserved: false }, { llmCalls: 0 }, { proposalSha256: sha('another-proposal') }, { proposedQuestion: '다른 새 평가 요구인가요?' }, { reviewModel: 'unrelated-model' }, { finalPremiseReview: null }]) {
    assert.throws(() => validateResumablePartialSurfaceReview(current, { ...previous, ...change }, current.originalPartialSha256), /RESUME_REVIEW_UNBOUND/u);
  }
  assert.throws(() => validateResumablePartialSurfaceReview(current, previous, sha('changed-snapshot')), /RESUME_REVIEW_UNBOUND/u);
});
