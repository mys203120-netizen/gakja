import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildDeepPoolSelectionArtifact, poolObjectiveBindingFailures, stageDeepQuestionPoolSelection, type PoolSelectionInput } from '../server/data/deep-bank-pool-selection';
import { deepRebindDigest } from '../server/data/deep-bank-rebind';
import type { StudentObjectiveCandidate } from '../server/question-objective';
import type { FullRecordSource } from '../server/data/full-student-analysis';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const text = '동아리 공동 탐구에 참여함.', pdf = sha('synthetic-pdf');
  const proof = { sourceRefId: 'block', page: 1, pageStart: 0, pageEnd: text.length, quote: text, sourceTextSha256: sha(text) };
  const entity = { id: 'activity', localId: 'A1', title: '합성 탐구', grade: 2, area: '동아리', facts: { recordedContext: [proof], studentActions: [], teamActions: [], choiceReasons: [], outcomes: [], teacherObservations: [] }, unknowns: ['개인 역할 미확인'], mergedFromLegacyIds: [] };
  const evidence = { id: 'e1', text, page: 1, sourceRef: { pdfSha256: pdf, startOffset: 0, endOffset: text.length } };
  const old: StudentObjectiveCandidate = { id: 'old', semanticKey: 'old-role', activityIds: ['activity'], evidenceIds: ['e1'], primaryFunction: 'ROLE', depth: 'D2', questionIntent: '본인의 실제 역할', targetDescription: '본인의 실제 역할', targetEvidence: ['본인 역할 한 가지'], anchorQuote: text, anchorRefs: [{ kind: 'RECORD', sourceId: 'e1', revision: pdf, start: 0, end: text.length, confirmationStatus: 'confirmed_from_record', claimStatus: 'record_fact' }], scope: 'record_based', requiresOpenCheck: true, selectionBasis: '역할 미기록', originKind: 'activity', originEntityId: 'activity', unknowns: ['역할 미확인'] };
  const fresh = { ...structuredClone(old), id: 'new', semanticKey: 'new-concept', primaryFunction: 'CONCEPT' as const, questionIntent: '핵심 개념의 의미', targetEvidence: ['개념 의미 한 가지'] };
  const omitted = { ...structuredClone(fresh), id: 'omitted', semanticKey: 'omitted-choice' };
  const common = { studentId: 'student', sourceContentSha256: sha('source'), contentSha256: sha('old-common'), activities: [entity], academicRecords: [], trajectories: [] };
  const base = { target: { university: '합성 대학', department: '합성 학과' }, student: { pdfSha256: pdf, evidence: [evidence] }, studentAnalysis: common, targetAnalysis: { objectives: [old], contentSha256: sha('old-target') } };
  const bankBody = { key: sha('synthetic-bank'), status: 'ready', slots: [{ candidates: [{ slotId: 'slot', draft: { evidenceIds: ['e1'] } }] }], plan: { slots: [{ id: 'slot', objective: old }] } };
  const input = { context: structuredClone(base), stagedContext: { ...structuredClone(base), studentAnalysis: { ...structuredClone(common), contentSha256: sha('new-common') }, targetAnalysis: { contentSha256: sha('new-target'), objectives: [fresh, omitted] } }, donorBank: { ...bankBody, contentSha256: deepRebindDigest(bankBody) }, baseEvidenceIds: ['e1'], selected: [{ objectiveId: fresh.id, reason: '실제 기록의 새 확인 목적을 별도로 검토함' }], pins: { donorBankFileSha256: sha('bank-file'), donorAnalysisPath: 'data/prepared/student-analysis-revisions/old/analysis.json', donorAnalysisFileSha256: sha('old-file'), baseRevisionPath: 'data/prepared/student-analysis-revisions/new/analysis.json', baseRevisionFileSha256: sha('new-file') }, reviewerId: 'synthetic-source-review', reviewedAt: '2026-11-05T00:00:00Z' } as unknown as PoolSelectionInput;
  const source = { pdfSha256: pdf, pages: [{ page: 1, text }] } as FullRecordSource;
  return { input, old, source };
}
test('source pool keeps retained IDs, records omitted purposes, and grants no question approval', () => {
  const { input } = fixture(), before = structuredClone(input);
  const artifact = buildDeepPoolSelectionArtifact(input);
  assert.deepEqual(artifact.retainedObjectives.map(row => row.objectiveId), ['old']);
  assert.deepEqual(artifact.selectedDeepObjectives.map(row => row.objectiveId), ['new']);
  assert.deepEqual(artifact.omittedDeepObjectiveIds, ['omitted']);
  assert.equal(artifact.omittedPurposesPreservedInBaseRevision, true); assert.equal(artifact.questionApprovalGranted, false);
  assert.deepEqual(input, before);
});
test('a same-key new purpose cannot erase an existing issued-demand history', () => {
  const { input } = fixture(); input.stagedContext.targetAnalysis!.objectives[0].semanticKey = 'old-role';
  assert.throws(() => buildDeepPoolSelectionArtifact(input), /DEEP_POOL_NEW_OBJECTIVE_INVALID/u);
});
test('a donor question excerpt missing from the new projection is explicitly pinned rather than silently omitted', () => {
  const { input } = fixture(); input.baseEvidenceIds = [];
  const artifact = buildDeepPoolSelectionArtifact(input);
  assert.equal(artifact.reviewedDonorEvidenceImports.length, 1);
  assert.equal(artifact.reviewedDonorEvidenceImports[0].evidenceId, 'e1');
  assert.equal(artifact.reviewedDonorEvidenceImports[0].evidenceSha256, deepRebindDigest(input.context.student.evidence[0]));
  assert.equal(artifact.questionApprovalGranted, false);
  assert.ok(input.stagedContext.student.evidence.some(row => row.id === 'e1'), 'The loader view supplement is not proof of serialized inclusion.');
  input.context.student.evidence = [];
  assert.throws(() => buildDeepPoolSelectionArtifact(input), /DEEP_POOL_DONOR_SOURCE_MISSING/u);
});
test('source dependency closure includes the approved plan anchors beyond the raw objective and spoken draft', () => {
  const { input } = fixture();
  input.context.student.evidence.push({ ...input.context.student.evidence[0], id: 'legacy-plan-only' });
  input.donorBank.plan.slots[0].objective!.evidenceIds.push('legacy-plan-only');
  const { contentSha256: ignored, ...body } = input.donorBank; void ignored;
  input.donorBank.contentSha256 = deepRebindDigest(body);
  assert.ok(!input.context.targetAnalysis!.objectives[0].evidenceIds.includes('legacy-plan-only'));
  const artifact = buildDeepPoolSelectionArtifact(input);
  assert.deepEqual(artifact.reviewedDonorEvidenceImports.map(row => row.evidenceId), ['legacy-plan-only']);
});
test('pool refuses a changed PDF, self-consistent but different student, and corrupt donor bank', () => {
  for (const change of ['pdf', 'student', 'bank'] as const) {
    const { input } = fixture();
    if (change === 'pdf') input.stagedContext.student.pdfSha256 = sha('different-pdf');
    if (change === 'student') input.stagedContext.studentAnalysis!.studentId = 'other-student';
    if (change === 'bank') input.donorBank.contentSha256 = sha('corrupt');
    assert.throws(() => buildDeepPoolSelectionArtifact(input), /DEEP_POOL_SOURCE_IDENTITY_INVALID/u);
  }
});
test('duplicate selection and multi-element required evidence are rejected before writing', () => {
  const { input } = fixture(); input.selected.push({ ...input.selected[0] });
  assert.throws(() => buildDeepPoolSelectionArtifact(input), /DEEP_POOL_EXPLICIT_SELECTION_INVALID/u);
  input.selected.pop(); input.stagedContext.targetAnalysis!.objectives[0].targetEvidence.push('다른 요구');
  assert.throws(() => buildDeepPoolSelectionArtifact(input), /DEEP_POOL_NEW_OBJECTIVE_INVALID/u);
});
test('an old source binding may add verified facts but cannot lose a donor fact or alter a source slice', () => {
  const { input, old, source } = fixture();
  const check = () => poolObjectiveBindingFailures(old, input.context.studentAnalysis!, input.stagedContext.studentAnalysis!, input.stagedContext.student.evidence, source);
  assert.deepEqual(check(), []);
  input.stagedContext.studentAnalysis!.activities[0].facts.studentActions.push({ ...input.stagedContext.studentAnalysis!.activities[0].facts.recordedContext[0] });
  assert.deepEqual(check(), []);
  input.stagedContext.studentAnalysis!.activities[0].facts.recordedContext = [];
  assert.ok(check().includes('DONOR_FACT_CHANGED:activity'));
  input.stagedContext.student.evidence[0].text = '다른 문장';
  assert.ok(check().includes('EXACT_EVIDENCE_MISSING:e1'));
});
test('missing entities and an out-of-range quote are pending bindings rather than guessed replacements', () => {
  const { input, old, source } = fixture(); input.stagedContext.studentAnalysis!.activities = []; old.anchorRefs[0].end = 999;
  const failures = poolObjectiveBindingFailures(old, input.context.studentAnalysis!, input.stagedContext.studentAnalysis!, input.stagedContext.student.evidence, source);
  assert.ok(failures.includes('ENTITY_MISSING:activity')); assert.ok(failures.includes('ANCHOR_INVALID:e1'));
});
test('a second academic source must bind its typed entity even when originEntityId names only the first', () => {
  const { input, old, source } = fixture();
  input.stagedContext.student.evidence.push({ ...input.stagedContext.student.evidence[0], id: 'e2', originEntityId: 'second-academic-row' });
  old.evidenceIds.push('e2');
  assert.ok(poolObjectiveBindingFailures(old, null, input.stagedContext.studentAnalysis!, input.stagedContext.student.evidence, source).includes('ENTITY_MISSING:second-academic-row'));
});
test('a trajectory requires both real endpoint entities rather than only the graph ID', () => {
  const { input, old, source } = fixture();
  input.stagedContext.studentAnalysis!.trajectories.push({ id: 'trajectory', fromEntityId: 'activity', toEntityId: 'missing-endpoint', relationship: 'same_topic', rationale: '합성 연결 후보', proofs: [], status: 'possible_connection_not_causal_fact' });
  old.activityIds = []; old.originEntityId = 'trajectory'; old.originKind = 'trajectory';
  assert.ok(poolObjectiveBindingFailures(old, null, input.stagedContext.studentAnalysis!, input.stagedContext.student.evidence, source).includes('ENTITY_MISSING:missing-endpoint'));
});
test('a stale source-review artifact is refused before context load or pointer mutation', async context => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deep-pool-review-')); context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'artifacts')); await writeFile(path.join(directory, 'artifacts', 'review.json'), '{}');
  const { input } = fixture();
  await assert.rejects(stageDeepQuestionPoolSelection({ context: input.context, donorBank: input.donorBank, baseRevisionPath: input.pins.baseRevisionPath, selectedDeepObjectiveIds: ['new'], review: { artifactPath: 'artifacts/review.json', artifactSha256: sha('stale'), reviewerId: input.reviewerId, reviewedAt: input.reviewedAt } }, directory), /DEEP_POOL_REVIEW_HASH_INVALID/u);
});
