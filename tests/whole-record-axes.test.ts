import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { projectWholeRecordAxes } from '../server/data/whole-record-axes';
import { materializeFullStudentAnalysis, type FullRecordSource, type StudentAnalysisCodecV2 } from '../server/data/full-student-analysis';
import type { InterviewContext } from '../server/data/load-interview-context';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const axes = ['interest_start', 'recurring_topic', 'deepening', 'cross_subject', 'grade_year_change', 'career_change', 'inquiry_method', 'community_behavior', 'strength_evidence', 'record_gap', 'fact_check'];
function fixture() {
  const text = '학생은 온도를 달리해 전도도를 비교하고 관찰값을 기록했다.', proof = { kind: 'proof_ref' as const, quoteId: 1 };
  const sourceBody = { schemaVersion: 'full-record-source-v1' as const, revision: 'synthetic-source-v1', recordRevision: 'a'.repeat(64), studentId: 'synthetic-student', sourceDocumentId: 'synthetic-document', sourceFile: 'synthetic.pdf', pdfSha256: 'a'.repeat(64), pageCount: 1, pages: [{ page: 1, text, textSha256: sha(text), textStatus: 'text_extracted', items: [] }], blocks: [{ id: 'synthetic-block-1', page: 1, startOffset: 0, endOffset: text.length, text, textSha256: sha(text), processingStatus: 'pending_analysis' }], coverage: { expectedPages: 1, extractedPages: 1, fullPageExtraction: true, pagesRequiringOcrReview: [], independentSemanticOrOcrReview: false as const } };
  const source: FullRecordSource = { ...sourceBody, contentSha256: sha(JSON.stringify(sourceBody)) };
  const context = { target: { studentName: 'synthetic', university: '합성 대학', department: '합성 학과', track: '합성 전형', year: 2027 }, school: { interview: { id: 'synthetic-target' }, officialInterviewCriteria: { elements: [{ name: '학업역량' }] } }, student: { pdfSha256: source.pdfSha256, evidence: [] }, manifest: { files: [{ role: 'studentAnalysisGuidelines', sha256: 'b'.repeat(64) }] } } as unknown as InterviewContext;
  const output: StudentAnalysisCodecV2 = { schemaVersion: 'student-analysis-wire-v2', codecVersion: 'student-analysis-codec-v2', quoteDictionary: [{ id: 1, sourceKey: 'B1', quote: text }], activities: [{ localId: 'A1', title: '온도와 전도도 비교 탐구', grade: 2, area: '과학', factProofRefs: { recordedContext: [proof], studentActions: [proof], teamActions: [], choiceReasons: [], outcomes: [], teacherObservations: [] }, interpretations: [], unknowns: ['측정 장치의 명칭은 미기록'] }], academicRecords: [], trajectories: [], sourceDispositions: [{ sourceKey: 'B1', status: 'analyzed', reason: '합성 원문 전체를 읽고 원문 사실을 연결했다.' }], activityPriorities: [{ activityLocalId: 'A1', priority: 'A', reason: '실제 탐구의 절차를 확인할 준비가 필요하다.', criterionName: '학업역량', representative: true }], objectives: Array.from({ length: 8 }, (_, index) => ({ originKind: 'activity', entityLocalIds: ['A1'], primaryFunction: 'PROCESS', depth: 'D2', target: `실제 탐구의 구체적인 확인 목적 ${index}`, requiredMeaning: '실제 수행 절차의 구체적인 설명', reason: '기록된 탐구의 실제 수행 내용을 확인한다.', semanticKey: `synthetic-purpose-${index}`, anchorProofRef: proof, unknowns: [], forbiddenPremises: [], openCheck: true })) };
  const generatedAt = '2026-11-06T00:00:00.000Z', value = materializeFullStudentAnalysis(context, source, output, { model: 'explicit-synthetic-offline-fixture', generatedAt, derivationVersion: 'full-record-deep-v1' });
  const artifact = { schemaVersion: 'unapproved-full-analysis-proposal-v2', codecVersion: 'student-analysis-codec-v2', model: value.common.model, generatedAt, sourceContentSha256: source.contentSha256, status: 'completed', output, wholeRecordAxes: axes.map(axis => ({ axis, interpretation: '합성 원문에 연결된 관찰이며 인과 사실이 아니다.', basisProofRefs: [proof], unknowns: ['독립적인 의미 검수는 아직 없다.'], status: 'source_bound_interpretation_not_causal_fact' })) };
  const bytes = Buffer.from(JSON.stringify(artifact)); return { source, value, artifact, bytes };
}

test('existing eleven axes project with exact original revisions, IDs, UTF-16 proofs and zero provider calls', () => {
  const { source, value, bytes } = fixture(), before = JSON.stringify(value), projection = projectWholeRecordAxes(value.common, source, bytes, sha(bytes));
  assert.equal(projection.axes.length, 11); assert.equal(projection.commonRevision, value.common.revision); assert.equal(projection.commonContentSha256, value.common.contentSha256); assert.equal(projection.providerCalls, 0); assert.equal(projection.independentlyReviewedSemantics, false);
  const proof = projection.axes[0].proofs[0]; assert.equal(source.pages[0].text.slice(proof.pageStart, proof.pageEnd), proof.quote); assert.equal(proof.sourceRefId, source.blocks[0].id); assert.equal(JSON.stringify(value), before, 'common, target and all objective IDs remain unchanged');
});

test('an unrelated or changed proposal cannot be attached to the canonical common revision', () => {
  const { source, value, artifact, bytes } = fixture(); assert.throws(() => projectWholeRecordAxes(value.common, source, bytes, 'f'.repeat(64)), /ARTIFACT_HASH_MISMATCH/);
  const changed = structuredClone(artifact); changed.output.objectives[0].target += ' 다른 목적'; const changedBytes = Buffer.from(JSON.stringify(changed)); assert.throws(() => projectWholeRecordAxes(value.common, source, changedBytes, sha(changedBytes)), /PROPOSAL_OUTPUT_MISMATCH/);
  const foreign = structuredClone(value.common); foreign.studentId = 'another-student'; const { contentSha256: ignored, ...body } = foreign; void ignored; foreign.contentSha256 = sha(JSON.stringify(body)); assert.throws(() => projectWholeRecordAxes(foreign, source, bytes, sha(bytes)), /REVISION_MISMATCH/);
});

test('missing axes, invalid dictionary references, and fabricated unused source quotations fail closed', () => {
  const { source, value, artifact } = fixture();
  const missing = structuredClone(artifact); missing.wholeRecordAxes.pop(); const missingBytes = Buffer.from(JSON.stringify(missing)); assert.throws(() => projectWholeRecordAxes(value.common, source, missingBytes, sha(missingBytes)));
  const ref = structuredClone(artifact); ref.wholeRecordAxes[0].basisProofRefs = [{ kind: 'proof_ref', quoteId: 999 }]; const refBytes = Buffer.from(JSON.stringify(ref)); assert.throws(() => projectWholeRecordAxes(value.common, source, refBytes, sha(refBytes)), /PROOF_MISSING/);
  const fabricated = structuredClone(artifact); fabricated.output.quoteDictionary.push({ id: 99, sourceKey: 'B1', quote: '원문에 존재하지 않는 수행 결과를 만들었다.' }); const fabricatedBytes = Buffer.from(JSON.stringify(fabricated)); assert.throws(() => projectWholeRecordAxes(value.common, source, fabricatedBytes, sha(fabricatedBytes)), /QUOTE_UNVERIFIED/);
});
