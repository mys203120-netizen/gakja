import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { InterviewContext } from '../server/data/load-interview-context';
import { createStudentObjectiveCandidates } from '../server/question-objective';
import { FULL_ANALYSIS_CURRENT, compactStudentAnalysisWireSchema, expandCompactStudentAnalysis, loadFullStudentAnalysis, materializeFullStudentAnalysis, saveFullStudentAnalysis, publishReviewedObjectiveContracts, activateReviewedObjectiveContracts, type AnalysisWire, type FullRecordSource } from '../server/data/full-student-analysis';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
async function saveLegacyFixture(value: ReturnType<typeof materializeFullStudentAnalysis>, source: FullRecordSource, root: string) {
  const saved = await saveFullStudentAnalysis(value, source, root);
  // Explicit historical-pointer fixture setup; the production saver only stages.
  await writeFile(path.join(root, FULL_ANALYSIS_CURRENT), JSON.stringify({ path: saved.revisionPath, revision: value.common.revision, sourceContentSha256: source.contentSha256 }));
}
function fixture() {
  const texts = ['팀과 함께 소금물 실험에서 온도를 달리해 전도도를 비교했다.', '같은 탐구의 후속 발표에서 전도도와 온도의 관계를 설명했다.', '2학년 1학기 수학Ⅱ 원점수 95 성취도 A.'];
  const pageText = texts.join('\n'); let offset = 0;
  const blocks = texts.map((text, index) => { const start = offset; offset += text.length + 1; return { id: `source-${index}`, page: 1, startOffset: start, endOffset: start + text.length, text, textSha256: sha(text), processingStatus: 'pending_analysis' }; });
  const body = { schemaVersion: 'full-record-source-v1' as const, revision: 'source-revision', recordRevision: 'a'.repeat(64), studentId: 'STUDENT-server-owned-fixture', sourceDocumentId: 'DOC-fixture', sourceFile: 'fixture.pdf', pdfSha256: 'a'.repeat(64), pageCount: 1, pages: [{ page: 1, text: pageText, textSha256: sha(pageText), textStatus: 'text_extracted', items: [] }], blocks, coverage: { expectedPages: 1, extractedPages: 1, fullPageExtraction: true, pagesRequiringOcrReview: [], independentSemanticOrOcrReview: false as const } };
  const source: FullRecordSource = { ...body, contentSha256: sha(JSON.stringify(body)) };
  const context = { errors: [], target: { studentName: 'fixture', university: '합성 대학', department: '합성 학과', track: '합성 전형', year: 2027 }, school: { interview: { id: 'TARGET-fixture' }, officialInterviewCriteria: { elements: [{ name: '학업역량' }] } }, student: { pdfSha256: source.pdfSha256, evidence: [{ id: 'legacy-1', activityId: 'same-real-activity', text: texts[0], page: 1 }, { id: 'legacy-2', activityId: 'same-real-activity', text: texts[1], page: 1 }] }, manifest: { files: [{ role: 'studentAnalysisGuidelines', sha256: 'b'.repeat(64) }] } } as unknown as InterviewContext;
  const proof = (index: number) => ({ sourceKey: `B${index + 1}`, quote: texts[index] });
  const wire: AnalysisWire = {
    activities: [{ localId: 'A1', title: '전도도와 온도 탐구·후속 발표', grade: 2, area: '동아리·교과', recordedContext: [proof(0), proof(1)], studentActions: [], teamActions: [proof(0)], choiceReasons: [], outcomes: [], teacherObservations: [], unknowns: ['개인 역할은 확인 필요'] }],
    academicRecords: [{ localId: 'C1', grade: 2, semester: 1, subject: '수학Ⅱ', gradingSystem: 'achievement', recordedValues: ['95', 'A'], proofs: [proof(2)], interpretationLimit: '한 학기의 한 과목이며 학년 간 상승을 확정하지 않는다.' }],
    trajectories: [], sourceDispositions: blocks.map((_, index) => ({ sourceKey: `B${index + 1}`, status: 'analyzed', reason: '실제 원문 범위를 구조화함' })),
    activityPriorities: [{ activityLocalId: 'A1', priority: 'A', reason: '전도도 비교와 후속 설명에서 학업 탐구 방법을 확인할 준비가 필요하다.', criterionName: '학업역량', representative: true }],
    objectives: Array.from({ length: 8 }, (_, index) => ({ originKind: index < 5 ? 'activity' : 'academic_record', entityLocalIds: [index < 5 ? 'A1' : 'C1'], primaryFunction: index % 2 ? 'PROCESS' : 'CHOICE', depth: 'D2', target: index < 5 ? `전도도 탐구에서 확인할 구체 판단 ${index + 1}` : `수학Ⅱ 학업 선택에서 확인할 구체 판단 ${index + 1}`, requiredMeaning: `원문에 연결된 구체 의미 ${index + 1}`, reason: '지원처의 학업 관점에 맞춰 실제 경험의 한 지점을 확인한다.', semanticKey: `independent-purpose-${index}`, anchor: index < 5 ? proof(0) : proof(2), unknowns: ['선택 이유는 미기록'], forbiddenPremises: ['개인 실험 수행을 단정하지 않는다.'], openCheck: true })),
  };
  return { context, source, wire };
}
test('full-record analysis merges records of the same experience and keeps academic entities outside activity IDs', () => {
  const { context, source, wire } = fixture(), original = structuredClone(context.student.evidence);
  const result = materializeFullStudentAnalysis(context, source, wire, { model: 'synthetic' });
  assert.equal(result.common.activities.length, 1);
  assert.equal(result.common.activities[0].id, 'same-real-activity');
  assert.equal(result.common.activities[0].facts.recordedContext.length, 2);
  assert.equal(result.common.activities[0].facts.studentActions.length, 0);
  assert.equal(result.common.academicRecords.length, 1);
  assert.equal(result.target.activityPriorities[0].priority, 'A');
  assert.equal(result.target.objectives.filter(objective => !objective.activityIds.length).length, 3);
  assert.equal(result.common.coverage.allSourceBlocksAccountedFor, true);
  assert.equal(result.common.coverage.independentSemanticReview, false);
  assert.deepEqual(context.student.evidence, original, 'historical excerpts are not edited');
  const runtime = { ...context, student: { ...context.student, evidence: result.evidence }, targetAnalysis: result.target };
  const projected = createStudentObjectiveCandidates(runtime);
  assert.deepEqual(projected.map(objective => [objective.id, objective.targetDescription, objective.targetEvidence]), result.target.objectives.map(objective => [objective.id, objective.targetDescription, objective.targetEvidence]), 'source expansion does not change the concrete purpose');
  assert.equal(projected[0].evidenceIds.length, 2, 'same-entity source context survives instead of only the first anchor');
  assert.equal(projected[0].evidenceIds[0], result.target.objectives[0].evidenceIds[0]);
  for (const evidence of result.evidence) assert.equal(source.pages[0].text.slice(evidence.sourceRef.startOffset, evidence.sourceRef.endOffset), evidence.text);
});
test('missing source dispositions, invented academic values and unrelated objective sources fail closed', () => {
  const { context, source, wire } = fixture();
  assert.throws(() => materializeFullStudentAnalysis(context, source, { ...wire, sourceDispositions: wire.sourceDispositions.slice(1) }, { model: 'synthetic' }), /COVERAGE_INCOMPLETE/);
  const changed = structuredClone(wire); changed.academicRecords[0].recordedValues = ['99'];
  assert.throws(() => materializeFullStudentAnalysis(context, source, changed, { model: 'synthetic' }), /VALUE_NOT_RECORDED/);
  const unrelated = structuredClone(wire); unrelated.objectives[0].anchor = wire.academicRecords[0].proofs[0];
  assert.throws(() => materializeFullStudentAnalysis(context, source, unrelated, { model: 'synthetic' }), /ANCHOR_NOT_IN_ENTITY/);
  const falseQuote = structuredClone(wire); falseQuote.objectives[0].anchor.quote = '팀장이 되어 실험을 지휘했다.';
  assert.throws(() => materializeFullStudentAnalysis(context, source, falseQuote, { model: 'synthetic' }), /QUOTE_UNVERIFIED/);
});

test('multi-source objective anchors retain a distinct secondary quote and reject stale secondary coordinates', () => {
  const { context, source, wire } = fixture();
  const value = materializeFullStudentAnalysis(context, source, wire, { model: 'synthetic' });
  const objective = value.target.objectives[0];
  const first = value.evidence.find(row => row.originEntityId === value.common.activities[0].id)!;
  const secondary = value.evidence.find(row => row.originEntityId === value.common.activities[0].id && row.id !== first.id)!;
  objective.evidenceIds = [first.id, secondary.id];
  objective.anchorRefs = [first, secondary].map(row => ({ kind: 'RECORD' as const, sourceId: row.id, revision: row.sourceRef.pdfSha256, start: 0, end: row.text.length, confirmationStatus: 'confirmed_from_record' as const, claimStatus: 'record_fact' as const }));
  objective.anchorQuote = first.text;
  assert.notEqual(first.text, secondary.text);
  const runtime = { ...context, student: { ...context.student, evidence: value.evidence }, targetAnalysis: value.target };
  const selected = createStudentObjectiveCandidates(runtime)[0];
  assert.deepEqual(selected.evidenceIds.slice(0, 2), [first.id, secondary.id]);
  assert.deepEqual(selected.anchorRefs.slice(0, 2).map(ref => ref.sourceId), [first.id, secondary.id]);
  objective.anchorRefs[1].end++;
  assert.throws(() => createStudentObjectiveCandidates(runtime), /OBJECTIVE_ANALYSIS_SOURCE_STALE/);
});
test('academic missing terms remain null and do not become comparable performance or ability grades', () => {
  const { context, source, wire } = fixture(); wire.academicRecords[0].semester = null; wire.academicRecords[0].gradingSystem = 'raw_table_unclear';
  const result = materializeFullStudentAnalysis(context, source, wire, { model: 'synthetic' });
  assert.equal(result.common.academicRecords[0].comparisonEligible, false);
  assert.deepEqual(result.common.academicRecords[0].recordedValues, ['95', 'A']);
  assert.equal(result.target.activityPriorities[0].reason.includes('준비'), true);
});
test('provider quote compression reuses verified source quotes without dropping facts or allowing invented quote IDs', () => {
  const { wire } = fixture(), dictionary = wire.sourceDispositions.map((_, index) => ({ id: `P${index + 1}`, sourceKey: `B${index + 1}`, quote: index === 0 ? wire.activities[0].recordedContext[0].quote : index === 1 ? wire.activities[0].recordedContext[1].quote : wire.academicRecords[0].proofs[0].quote }));
  const compressed: ReturnType<typeof compactStudentAnalysisWireSchema.parse> = { ...wire, quoteDictionary: dictionary,
    activities: [{ ...wire.activities[0], recordedContext: ['P1', 'P2'], studentActions: [], teamActions: ['P1'], choiceReasons: [], outcomes: [], teacherObservations: [] }],
    academicRecords: [{ ...wire.academicRecords[0], proofs: ['P3'] }],
    trajectories: [],
    objectives: wire.objectives.map((objective, index) => ({ ...objective, anchor: index < 5 ? 'P1' : 'P3' })),
  };
  assert.doesNotThrow(() => compactStudentAnalysisWireSchema.parse(compressed));
  assert.deepEqual(expandCompactStudentAnalysis(compressed), wire);
  compressed.activities[0].studentActions = ['원문에 없는 팀장 역할을 수행했다는 모델 요약'];
  const conservative = expandCompactStudentAnalysis(compressed);
  assert.deepEqual(conservative.activities[0].studentActions, []);
  assert.ok(conservative.activities[0].unknowns.some(note => note.includes('미검증 모델 해석') && note.includes('팀장')));
  compressed.academicRecords[0].recordedValues.push('99');
  const academic = expandCompactStudentAnalysis(compressed).academicRecords[0];
  assert.deepEqual(academic.recordedValues, ['95', 'A']);
  assert.equal(academic.gradingSystem, 'raw_table_unclear');
  compressed.objectives[0].anchor = 'not-a-real-quote';
  assert.throws(() => expandCompactStudentAnalysis(compressed), /QUOTE_ID_MISSING/);
});
test('partial source structure preserves provider narratives as unverified, and only exact anchors can support objectives', () => {
  const { context, source, wire } = fixture();
  wire.sourceDispositions[0].status = 'needs_review';
  const partial = materializeFullStudentAnalysis(context, source, wire, { model: 'synthetic' });
  assert.equal(partial.target.objectives[0].sourcingStatus, 'verified_span_in_partially_structured_source');
  assert.equal(partial.common.coverage.needsReviewSourceCount, 1);
  assert.equal(partial.common.coverage.partiallyStructuredSourceCount, 1);
  const excluded = structuredClone(wire); excluded.sourceDispositions[0].status = 'identity_excluded';
  assert.throws(() => materializeFullStudentAnalysis(context, source, excluded, { model: 'synthetic' }), /SOURCE_EXCLUDED/);
});
test('immutable full analysis is reloaded by exact source/profile revisions; altered evidence is rejected', async t => {
  const { context, source, wire } = fixture(), root = await mkdtemp(path.join(os.tmpdir(), 'full-student-analysis-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('full-student-analysis-')); await rm(root, { recursive: true, force: true }); });
  const sourcePath = 'data/prepared/record-revisions/source-revision/source.json';
  await mkdir(path.dirname(path.join(root, sourcePath)), { recursive: true });
  await writeFile(path.join(root, sourcePath), JSON.stringify(source));
  await writeFile(path.join(root, 'data/prepared/full-record-current.json'), JSON.stringify({ path: sourcePath, pdfSha256: source.pdfSha256, contentSha256: source.contentSha256 }));
  const prepared = materializeFullStudentAnalysis(context, source, wire, { model: 'synthetic' });
  await saveLegacyFixture(prepared, source, root);
  assert.deepEqual(await loadFullStudentAnalysis(context, root), prepared);
  const changed = structuredClone(context); changed.school.interview!.id = 'different-target';
  await assert.rejects(loadFullStudentAnalysis(changed, root), /STALE/);
  const pointer = JSON.parse(await readFile(path.join(root, FULL_ANALYSIS_CURRENT), 'utf8'));
  const saved = JSON.parse(await readFile(path.join(root, pointer.path), 'utf8')); saved.evidence[0].text = '원문에 없는 역할';
  await writeFile(path.join(root, pointer.path), JSON.stringify(saved));
  await assert.rejects(loadFullStudentAnalysis(context, root), /EVIDENCE_INVALID/);
});

test('a reviewed demand correction publishes only a derived target revision and preserves original source/common analysis', async t => {
  const { context, source, wire } = fixture(), root = await mkdtemp(path.join(os.tmpdir(), 'full-student-analysis-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('full-student-analysis-')); await rm(root, { recursive: true, force: true }); });
  const sourcePath = 'data/prepared/record-revisions/source-revision/source.json';
  await mkdir(path.dirname(path.join(root, sourcePath)), { recursive: true });
  await writeFile(path.join(root, sourcePath), JSON.stringify(source));
  await writeFile(path.join(root, 'data/prepared/full-record-current.json'), JSON.stringify({ path: sourcePath, pdfSha256: source.pdfSha256, contentSha256: source.contentSha256 }));
  const prepared = materializeFullStudentAnalysis(context, source, wire, { model: 'synthetic' });
  await saveLegacyFixture(prepared, source, root);
  const oldPointer = JSON.parse(await readFile(path.join(root, FULL_ANALYSIS_CURRENT), 'utf8')), oldBytes = await readFile(path.join(root, oldPointer.path), 'utf8');
  const objective = prepared.target.objectives[0];
  const correction = { objectiveId: objective.id, previousQuestionIntent: objective.questionIntent, previousTargetEvidence: objective.targetEvidence, questionIntent: '실제로 선택한 기준 한 가지', targetEvidence: ['실제로 선택한 기준 한 가지'] as [string], reviewedQuestionSha256: sha('합성 독립 검수 질문') };
  const revised = await publishReviewedObjectiveContracts(context, [correction], { artifactSha256: sha('explicit synthetic independent review'), model: 'synthetic-review', reviewedAt: new Date().toISOString() }, root, { activate: false });
  assert.equal((await loadFullStudentAnalysis(context, root))?.target.revision, prepared.target.revision, 'staging cannot make the running bank unavailable');
  await activateReviewedObjectiveContracts(context, revised.revisionPath, root);
  assert.deepEqual(revised.common, prepared.common);
  assert.deepEqual(revised.evidence, prepared.evidence);
  assert.equal(await readFile(path.join(root, oldPointer.path), 'utf8'), oldBytes);
  assert.notEqual(revised.target.revision, prepared.target.revision);
  assert.deepEqual((await loadFullStudentAnalysis(context, root))?.target, revised.target);
  await assert.rejects(activateReviewedObjectiveContracts(context, revised.revisionPath, root), /PARENT_CHANGED/u, 'a stale publication cannot overwrite a newer pointer');
  await assert.rejects(publishReviewedObjectiveContracts(context, [correction], { artifactSha256: sha('review'), model: 'synthetic-review', reviewedAt: new Date().toISOString() }, root), /CORRECTION_STALE/u);
});
