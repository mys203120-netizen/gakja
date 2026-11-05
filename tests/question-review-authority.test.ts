import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { InterviewContext } from '../server/data/load-interview-context';
import { createQuestionReviewAuthorityScope, resolveQuestionReviewAuthority } from '../server/data/question-review-authority';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const withHash = <T extends object>(body: T) => ({ ...body, contentSha256: sha(JSON.stringify(body)) });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'question-review-chain-'));
  const common = withHash({ revision: sha('common'), sourceContentSha256: sha('exact-source-record'), activities: [] });
  const questionSha256 = sha('이미 독립 승인된 합성 질문'), evidence = [{ id: 'source-1', text: '동일한 합성 원문', pdfSha256: sha('synthetic-pdf') }];
  const objective = { id: 'objective-keep', semanticKey: 'same-purpose', questionIntent: '합성 기록의 해석 범위', targetEvidence: ['해석할 수 있는 범위'], primaryFunction: 'LIMIT', depth: 'D4', anchorRefs: [{ sourceId: 'source-1', start: 0, end: 10 }] };
  const previous = withHash({ revision: `target-${sha('previous')}`, objectives: [objective], objectiveContractRevision: { version: 'independently-reviewed-objective-contract-v1', parentRevision: `target-${sha('before-previous')}`, parentContentSha256: sha('before-previous'), reviewModel: 'synthetic-precision-reviewer', reviewArtifactSha256: sha('explicit-old-review'), reviewedAt: '2026-11-03T00:00:00.000Z', changedObjectiveIds: [objective.id], approvedQuestions: [{ objectiveId: objective.id, questionSha256 }], blockedObjectives: [] } });
  const current = withHash({ revision: `target-${sha('current')}`, objectives: [objective], objectiveContractRevision: { ...previous.objectiveContractRevision, parentRevision: previous.revision, parentContentSha256: previous.contentSha256, reviewModel: 'synthetic-new-contract-reviewer', reviewArtifactSha256: sha('new-unrelated-review'), changedObjectiveIds: ['another-objective'], approvedQuestions: [] } });
  const directory = path.join(root, 'data/prepared/student-analysis-revisions', common.revision), parentPath = path.join(directory, previous.revision, 'analysis.json'), currentPath = path.join(directory, current.revision, 'analysis.json');
  await mkdir(path.dirname(parentPath), { recursive: true }); await mkdir(path.dirname(currentPath), { recursive: true });
  await writeFile(parentPath, JSON.stringify({ common, target: previous, evidence })); await writeFile(currentPath, JSON.stringify({ common, target: current, evidence }));
  const context = { targetAnalysis: current, studentAnalysis: common, manifest: { files: [{ role: 'fullStudentAnalysis', path: path.relative(root, currentPath), sha256: sha(await readFile(currentPath, 'utf8')) }] } } as unknown as InterviewContext;
  return { root, common, previous, current, evidence, objective, questionSha256, parentPath, currentPath, context,
    async close() { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('question-review-chain-')); await rm(root, { recursive: true, force: true }); } };
}

test('an unchanged independently reviewed question keeps its exact ancestor authority after an unrelated target-contract revision', async t => {
  const f = await fixture(); t.after(f.close);
  const authority = await resolveQuestionReviewAuthority(f.context, f.objective.id, f.questionSha256, 'synthetic-precision-reviewer', f.root);
  assert.equal(authority?.kind, 'unchanged_objective_ancestor_review');
  assert.equal(authority?.sourceRevision, f.previous.revision);
  assert.equal(authority?.reviewArtifactSha256, sha('explicit-old-review'));
  assert.equal(authority?.chain.length, 2);
  assert.equal(await resolveQuestionReviewAuthority(f.context, f.objective.id, sha('another-question'), 'synthetic-precision-reviewer', f.root), null);
  assert.equal(await resolveQuestionReviewAuthority(f.context, f.objective.id, f.questionSha256, 'unapproved-model', f.root), null);
});

test('newer changes or blocks supersede old approvals and cannot fall back through source-review ancestry', async t => {
  const f = await fixture(); t.after(f.close);
  const changed = structuredClone(f.context); changed.targetAnalysis!.objectiveContractRevision!.changedObjectiveIds = [f.objective.id];
  changed.targetAnalysis!.objectiveSourceReview = { version: 'source-reviewed-objective-extension-v1', parentRevision: f.previous.revision, parentContentSha256: f.previous.contentSha256, reviewArtifactPath: 'synthetic', reviewArtifactSha256: sha('synthetic'), reviewerId: 'synthetic', reviewedAt: '2026-11-04T00:00:00.000Z', addedObjectiveIds: ['unrelated-new-purpose'] };
  assert.equal(await resolveQuestionReviewAuthority(changed, f.objective.id, f.questionSha256, 'synthetic-precision-reviewer', f.root), null);
  const blocked = structuredClone(f.context); blocked.targetAnalysis!.objectiveContractRevision!.blockedObjectives = [{ objectiveId: f.objective.id, failureCode: 'PREMISE_UNSUPPORTED' }];
  assert.equal(await resolveQuestionReviewAuthority(blocked, f.objective.id, f.questionSha256, 'synthetic-precision-reviewer', f.root), null);
});

test('changed record snapshots, parent bytes, manifest hash or objective contracts cannot inherit an old reviewer approval', async t => {
  const f = await fixture(); t.after(f.close);
  const originalBytes = await readFile(f.parentPath, 'utf8');
  const wrongEvidence = JSON.parse(originalBytes); wrongEvidence.evidence[0].text = '다른 학생 원문';
  await writeFile(f.parentPath, JSON.stringify(wrongEvidence));
  assert.equal(await resolveQuestionReviewAuthority(f.context, f.objective.id, f.questionSha256, 'synthetic-precision-reviewer', f.root), null);
  const wrongCommon = JSON.parse(originalBytes); wrongCommon.common.sourceContentSha256 = sha('other-source');
  await writeFile(f.parentPath, JSON.stringify(wrongCommon));
  assert.equal(await resolveQuestionReviewAuthority(f.context, f.objective.id, f.questionSha256, 'synthetic-precision-reviewer', f.root), null);
  const wrongTarget = JSON.parse(originalBytes); wrongTarget.target.objectives[0].targetEvidence = ['새로운 필수 요구'];
  await writeFile(f.parentPath, JSON.stringify(wrongTarget));
  assert.equal(await resolveQuestionReviewAuthority(f.context, f.objective.id, f.questionSha256, 'synthetic-precision-reviewer', f.root), null);
  await writeFile(f.parentPath, originalBytes);
  const manifest = structuredClone(f.context); manifest.manifest.files[0].sha256 = sha('wrong-manifest');
  assert.equal(await resolveQuestionReviewAuthority(manifest, f.objective.id, f.questionSha256, 'synthetic-precision-reviewer', f.root), null);
});

test('one explicit loading scope shares exact file snapshots and serialization across repeated authority lookups without changing results', async t => {
  const f = await fixture(); t.after(f.close);
  const scope = createQuestionReviewAuthorityScope(f.context, f.root);
  const uncached = await resolveQuestionReviewAuthority(f.context, f.objective.id, f.questionSha256, 'synthetic-precision-reviewer', f.root);
  const first = await resolveQuestionReviewAuthority(f.context, f.objective.id, f.questionSha256, 'synthetic-precision-reviewer', f.root, scope);
  assert.deepEqual(first, uncached);
  const afterFirst = scope.diagnostics();
  for (let index = 0; index < 35; index++) assert.deepEqual(await resolveQuestionReviewAuthority(f.context, f.objective.id, f.questionSha256, 'synthetic-precision-reviewer', f.root, scope), uncached);
  assert.equal(scope.diagnostics().totalFileReads, 2);
  assert.deepEqual(scope.diagnostics(), afterFirst, 'common/evidence/objective JSON is not repeated for the same captured objects');
  assert.equal(scope.diagnostics().fileReads[f.currentPath], 1); assert.equal(scope.diagnostics().fileReads[f.parentPath], 1);
  assert.equal(await resolveQuestionReviewAuthority(f.context, f.objective.id, sha('unapproved-question'), 'synthetic-precision-reviewer', f.root, scope), null);
  assert.equal(await resolveQuestionReviewAuthority(f.context, f.objective.id, f.questionSha256, 'wrong-reviewer', f.root, scope), null);
});

test('a subsequent loading scope detects current or parent disk corruption instead of reusing an earlier approval', async t => {
  const f = await fixture(); t.after(f.close);
  const firstScope = createQuestionReviewAuthorityScope(f.context, f.root);
  assert.ok(await resolveQuestionReviewAuthority(f.context, f.objective.id, f.questionSha256, 'synthetic-precision-reviewer', f.root, firstScope));
  const originalParent = await readFile(f.parentPath, 'utf8'), parent = JSON.parse(originalParent);
  parent.evidence[0].text = '추가 로딩 전에 바뀐 원문'; await writeFile(f.parentPath, JSON.stringify(parent));
  assert.equal(await resolveQuestionReviewAuthority(f.context, f.objective.id, f.questionSha256, 'synthetic-precision-reviewer', f.root, createQuestionReviewAuthorityScope(f.context, f.root)), null);
  await writeFile(f.parentPath, originalParent);
  const current = JSON.parse(await readFile(f.currentPath, 'utf8')); current.target.objectives[0].targetEvidence = ['파일에서 바뀐 요구']; await writeFile(f.currentPath, JSON.stringify(current));
  assert.equal(await resolveQuestionReviewAuthority(f.context, f.objective.id, f.questionSha256, 'synthetic-precision-reviewer', f.root, createQuestionReviewAuthorityScope(f.context, f.root)), null);
});

test('distinct objectives share the same verified common/evidence envelopes while retaining individual utterance authority', async t => {
  const f = await fixture(); t.after(f.close);
  const second = { ...f.objective, id: 'objective-second', semanticKey: 'second-purpose', targetEvidence: ['두 번째 별도 요구'] }, secondQuestion = sha('두 번째 독립 승인 합성 질문');
  const { contentSha256: _previousHash, ...previousBody } = f.previous; void _previousHash;
  const previous = withHash({ ...previousBody, objectives: [f.objective, second], objectiveContractRevision: { ...previousBody.objectiveContractRevision, changedObjectiveIds: [f.objective.id, second.id], approvedQuestions: [{ objectiveId: f.objective.id, questionSha256: f.questionSha256 }, { objectiveId: second.id, questionSha256: secondQuestion }] } });
  const { contentSha256: _currentHash, ...currentBody } = f.current; void _currentHash;
  const current = withHash({ ...currentBody, objectives: [f.objective, second], objectiveContractRevision: { ...currentBody.objectiveContractRevision, parentContentSha256: previous.contentSha256 } });
  await writeFile(f.parentPath, JSON.stringify({ common: f.common, target: previous, evidence: f.evidence }));
  await writeFile(f.currentPath, JSON.stringify({ common: f.common, target: current, evidence: f.evidence }));
  f.context.targetAnalysis = current as unknown as InterviewContext['targetAnalysis']; f.context.manifest.files[0].sha256 = sha(await readFile(f.currentPath, 'utf8'));
  const scope = createQuestionReviewAuthorityScope(f.context, f.root);
  for (const [objectiveId, question] of [[f.objective.id, f.questionSha256], [second.id, secondQuestion]]) {
    const ordinary = await resolveQuestionReviewAuthority(f.context, objectiveId, question, 'synthetic-precision-reviewer', f.root);
    assert.ok(ordinary); assert.deepEqual(await resolveQuestionReviewAuthority(f.context, objectiveId, question, 'synthetic-precision-reviewer', f.root, scope), ordinary);
  }
  assert.equal(scope.diagnostics().totalFileReads, 2);
  assert.equal(await resolveQuestionReviewAuthority(f.context, second.id, f.questionSha256, 'synthetic-precision-reviewer', f.root, scope), null, 'one objective cannot borrow another objective utterance hash');
});

test('a scoped snapshot cannot authorize another context/root or hide mutations of the caller target, blocked set or manifest', async t => {
  const f = await fixture(); t.after(f.close);
  const scope = createQuestionReviewAuthorityScope(f.context, f.root);
  assert.ok(await resolveQuestionReviewAuthority(f.context, f.objective.id, f.questionSha256, 'synthetic-precision-reviewer', f.root, scope));
  assert.equal(await resolveQuestionReviewAuthority(structuredClone(f.context), f.objective.id, f.questionSha256, 'synthetic-precision-reviewer', f.root, scope), null);
  assert.equal(await resolveQuestionReviewAuthority(f.context, f.objective.id, f.questionSha256, 'synthetic-precision-reviewer', path.join(f.root, 'other-root'), scope), null);
  const original = f.context.targetAnalysis!.objectives[0].targetEvidence[0];
  f.context.targetAnalysis!.objectives[0].targetEvidence[0] = '같은 contentSHA를 유지한 악성 변경';
  assert.equal(await resolveQuestionReviewAuthority(f.context, f.objective.id, f.questionSha256, 'synthetic-precision-reviewer', f.root, scope), null);
  f.context.targetAnalysis!.objectives[0].targetEvidence[0] = original;
  f.context.targetAnalysis!.objectiveContractRevision!.blockedObjectives.push({ objectiveId: f.objective.id, failureCode: 'PREMISE_UNSUPPORTED' });
  assert.equal(await resolveQuestionReviewAuthority(f.context, f.objective.id, f.questionSha256, 'synthetic-precision-reviewer', f.root, scope), null);
});
