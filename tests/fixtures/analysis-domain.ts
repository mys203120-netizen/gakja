/** Public synthetic existing-domain fixtures; no private source or provider call. */
import type { InterviewContext } from '../../server/data/load-interview-context';
import { createHash } from 'node:crypto';
import { decodeStudentAnalysisV2, materializeFullStudentAnalysis, type FullRecordSource, type StudentAnalysisCodecV2 } from '../../server/data/full-student-analysis';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export function analysisDomainFixture() {
  const texts = ['학생은 🧪 실험에서 온도를 달리해 전도도를 비교하고 관찰값을 기록했다.', '2학년 1학기 수학Ⅱ 원점수 95 성취도 A'];
  const text = texts.join('\n'), starts = [0, texts[0].length + 1];
  const body = { schemaVersion: 'full-record-source-v1' as const, revision: 'synthetic-analysis-extraction-v1', recordRevision: 'a'.repeat(64), studentId: 'synthetic-analysis-student', sourceDocumentId: 'synthetic-analysis-document', sourceFile: 'synthetic-analysis.pdf', pdfSha256: 'a'.repeat(64), pageCount: 1,
    pages: [{ page: 1, text, textSha256: sha(text), textStatus: 'text_extracted', items: [] }], blocks: texts.map((text, index) => ({ id: `synthetic-analysis-block-${index}`, page: 1, startOffset: starts[index], endOffset: starts[index] + text.length, text, textSha256: sha(text), processingStatus: 'pending_analysis' })),
    coverage: { expectedPages: 1, extractedPages: 1, fullPageExtraction: true, pagesRequiringOcrReview: [], independentSemanticOrOcrReview: false as const } };
  const source: FullRecordSource = { ...body, contentSha256: sha(JSON.stringify(body)) };
  const context = { target: { studentName: '합성 학생', university: '합성 대학', department: '합성 학과', track: '합성 전형', year: 2027 },
    school: { interview: { id: 'synthetic-analysis-target' }, officialInterviewCriteria: { elements: [{ name: '학업역량' }] } }, student: { pdfSha256: source.pdfSha256, evidence: [] },
    manifest: { files: [{ role: 'studentAnalysisGuidelines', sha256: 'b'.repeat(64) }], rulesVersion: 'synthetic-analysis-policy' } } as unknown as InterviewContext;
  const ref = (quoteId: number) => ({ kind: 'proof_ref' as const, quoteId });
  const span = (literal: string) => ({ proofRef: ref(2), binding: 'offsets' as const, start: texts[1].indexOf(literal), end: texts[1].indexOf(literal) + literal.length, literal });
  const wire: StudentAnalysisCodecV2 = { schemaVersion: 'student-analysis-wire-v2', codecVersion: 'student-analysis-codec-v2', quoteDictionary: texts.map((quote, index) => ({ id: index + 1, sourceKey: `B${index + 1}`, quote })),
    activities: [{ localId: 'A1', title: '온도와 전도도 비교 탐구', grade: 2, area: '과학', factProofRefs: { recordedContext: [ref(1)], studentActions: [ref(1)], teamActions: [], choiceReasons: [], outcomes: [], teacherObservations: [] }, interpretations: [{ field: 'summary', text: '관찰값을 비교한 탐구라는 모델 해석', basisProofRefs: [ref(1)] }], unknowns: ['기록에 없는 측정 도구 명칭은 확인 필요'] }],
    academicRecords: [{ localId: 'C1', grade: 2, semester: 1, subject: '수학Ⅱ', gradingSystem: 'achievement', proofRefs: [ref(2)], literalValues: [{ kind: 'academic_literal', value: '95', valueSpan: span('95'), provenance: { rowIndex: 0, columnIndex: 0, rowLabel: span('수학Ⅱ'), columnLabel: span('원점수'), grade: 2, semester: 1, subject: '수학Ⅱ', gradingSystem: 'achievement', gradeProofRefs: [ref(2)], semesterProofRefs: [ref(2)], subjectProofRefs: [ref(2)], gradingSystemProofRefs: [ref(2)], structureStatus: 'resolved' } }], tableStructure: { status: 'resolved', unresolvedReasons: [] }, interpretations: [], interpretationLimit: '단일 학기 기록이며 변화 원인이나 과학적 진실을 확정하지 않는다.' }],
    trajectories: [], sourceDispositions: texts.map((_, index) => ({ sourceKey: `B${index + 1}`, status: 'analyzed' as const, reason: '합성 원문의 문단과 성적 행을 그대로 연결했다.' })),
    activityPriorities: [{ activityLocalId: 'A1', priority: 'A', reason: '실제 탐구의 절차와 선택을 확인할 준비가 필요하다.', criterionName: '학업역량', representative: true }],
    objectives: Array.from({ length: 8 }, (_, index) => ({ originKind: index < 4 ? 'activity' as const : 'academic_record' as const, entityLocalIds: [index < 4 ? 'A1' : 'C1'], primaryFunction: 'PROCESS' as const, depth: 'D2' as const, target: `원문에 연결된 실제 확인 목적 ${index}`, requiredMeaning: `실제 수행 또는 학업 기록의 설명 ${index}`, reason: '실제 기록의 알려진 사실과 미확인 사항을 구별한다.', semanticKey: `synthetic-analysis-purpose-${index}`, anchorProofRef: ref(index < 4 ? 1 : 2), unknowns: [], forbiddenPremises: ['개인 역할이나 성적 변화 원인을 단정하지 않는다.'], openCheck: true })) };
  const v2 = materializeFullStudentAnalysis(context, source, wire, { model: 'explicit-synthetic-analysis-model', generatedAt: '2026-11-06T00:00:00.000Z' });
  const v1 = materializeFullStudentAnalysis(context, source, decodeStudentAnalysisV2(source, wire).wire, { model: 'explicit-synthetic-v1-model', generatedAt: '2026-11-06T00:00:00.000Z' });
  return { source, context, wire, v1, v2 };
}
export type AnalysisDomainFixtureCase = { name: string; contract: 'student-analysis-codec-v2' | 'full-student-analysis' | 'target-student-analysis'; input: unknown; source: FullRecordSource; expectedValid: boolean; expectedSemanticValid: boolean; category: 'shape' | 'semantic' };
export function analysisDomainFixtureCases(): AnalysisDomainFixtureCase[] {
  const { source, wire, v1, v2 } = analysisDomainFixture();
  const cases: AnalysisDomainFixtureCase[] = [
    { name: 'wire-v2-existing-typed-proof-and-literal', contract: 'student-analysis-codec-v2', input: wire, source, expectedValid: true, expectedSemanticValid: true, category: 'shape' },
    { name: 'full-v2-existing-canonical', contract: 'full-student-analysis', input: v2.common, source, expectedValid: true, expectedSemanticValid: true, category: 'shape' },
    { name: 'target-v2-existing-objective-ids', contract: 'target-student-analysis', input: v2.target, source, expectedValid: true, expectedSemanticValid: true, category: 'shape' },
    { name: 'full-v1-provenance-absent-not-upgraded', contract: 'full-student-analysis', input: v1.common, source, expectedValid: true, expectedSemanticValid: true, category: 'shape' },
    { name: 'target-v1-codec-absent-not-upgraded', contract: 'target-student-analysis', input: v1.target, source, expectedValid: true, expectedSemanticValid: true, category: 'shape' },
  ];
  const selectionV1 = Object.assign(structuredClone(v2.target), { objectivePoolSelection: { version: 'deep-question-pool-source-selection-v1', artifactPath: 'artifacts/explicit-synthetic-selection.json', artifactSha256: 'c'.repeat(64),
    baseRevisionPath: 'data/prepared/student-analysis-revisions/explicit-synthetic/analysis.json', baseRevisionFileSha256: 'd'.repeat(64), donorBankKey: 'e'.repeat(64),
    retainedObjectiveIds: [v2.target.objectives[0].id], selectedDeepObjectiveIds: [], omittedDeepObjectiveIds: [], questionApprovalGranted: false } });
  const { contentSha256: ignoredSelection, ...selectionBody } = selectionV1; void ignoredSelection; selectionV1.contentSha256 = sha(JSON.stringify(selectionBody));
  cases.push({ name: 'target-v2-historical-pool-selection-v1-no-imports-invented', contract: 'target-student-analysis', input: selectionV1, source, expectedValid: true, expectedSemanticValid: true, category: 'shape' });
  const selectionV2 = structuredClone(selectionV1) as unknown as Record<string, unknown>;
  Object.assign(selectionV2, { objectivePoolSelection: { ...selectionV1.objectivePoolSelection, version: 'deep-question-pool-source-selection-v2', reviewedDonorEvidenceImports: [] } });
  const { contentSha256: ignoredSelection2, ...selectionBody2 } = selectionV2; void ignoredSelection2; selectionV2.contentSha256 = sha(JSON.stringify(selectionBody2));
  cases.push({ name: 'target-v2-current-pool-selection-explicit-empty-imports', contract: 'target-student-analysis', input: selectionV2, source, expectedValid: true, expectedSemanticValid: true, category: 'shape' });
  const closure = Object.assign(structuredClone(v2.target), { objectiveSourceClosureReview: { version: 'explicit-academic-objective-source-closure-v1', parentRevision: 'synthetic-parent-target', parentContentSha256: 'c'.repeat(64),
    reviewArtifactPath: 'artifacts/explicit-synthetic-source-closure.json', reviewArtifactSha256: 'd'.repeat(64), changedObjectiveIds: [v2.target.objectives[0].id], addedEvidenceIds: [v2.evidence[0].id] } });
  const { contentSha256: ignoredClosure, ...closureBody } = closure; void ignoredClosure; closure.contentSha256 = sha(JSON.stringify(closureBody));
  cases.push({ name: 'target-v2-existing-source-closure-provenance', contract: 'target-student-analysis', input: closure, source, expectedValid: true, expectedSemanticValid: true, category: 'shape' });
  const missing = structuredClone(v2.common) as unknown as Record<string, unknown>; delete missing.codecVersion;
  cases.push({ name: 'full-v2-missing-required-codec', contract: 'full-student-analysis', input: missing, source, expectedValid: false, expectedSemanticValid: false, category: 'shape' });
  const nullArray = structuredClone(v2.common) as unknown as Record<string, unknown>; nullArray.activities = null;
  cases.push({ name: 'full-null-is-not-empty-activities', contract: 'full-student-analysis', input: nullArray, source, expectedValid: false, expectedSemanticValid: false, category: 'shape' });
  const unknownGrade = structuredClone(wire); unknownGrade.activities[0].grade = null;
  cases.push({ name: 'wire-null-grade-is-an-explicit-unknown', contract: 'student-analysis-codec-v2', input: unknownGrade, source, expectedValid: true, expectedSemanticValid: true, category: 'shape' });
  const missingGrade = structuredClone(wire) as unknown as { activities: Array<Record<string, unknown>> }; delete missingGrade.activities[0].grade;
  cases.push({ name: 'wire-missing-grade-is-not-null', contract: 'student-analysis-codec-v2', input: missingGrade, source, expectedValid: false, expectedSemanticValid: false, category: 'shape' });
  const shortNonBmp = structuredClone(wire); shortNonBmp.activities[0].title = '🧪a';
  cases.push({ name: 'wire-two-codepoints-fail-min3-even-with-three-UTF16-units', contract: 'student-analysis-codec-v2', input: shortNonBmp, source, expectedValid: false, expectedSemanticValid: false, category: 'shape' });
  const threeNonBmp = structuredClone(wire); threeNonBmp.activities[0].title = '🧪ab';
  cases.push({ name: 'wire-three-codepoints-pass-min3', contract: 'student-analysis-codec-v2', input: threeNonBmp, source, expectedValid: true, expectedSemanticValid: true, category: 'shape' });
  const maxNonBmp = structuredClone(wire); maxNonBmp.activities[0].title = '🧪'.repeat(90);
  cases.push({ name: 'wire-90-codepoints-valid-with-180-UTF16-units', contract: 'student-analysis-codec-v2', input: maxNonBmp, source, expectedValid: true, expectedSemanticValid: true, category: 'shape' });
  const overNonBmp = structuredClone(wire); overNonBmp.activities[0].title = '🧪'.repeat(91);
  cases.push({ name: 'wire-91-codepoints-exceed-max90', contract: 'student-analysis-codec-v2', input: overNonBmp, source, expectedValid: false, expectedSemanticValid: false, category: 'shape' });
  const narrative = structuredClone(wire) as unknown as { activities: Array<{ factProofRefs: { studentActions: unknown[] } }> }; narrative.activities[0].factProofRefs.studentActions = ['모델의 추론을 사실 참조로 쓸 수 없다.'];
  cases.push({ name: 'wire-narrative-is-not-proof-ref', contract: 'student-analysis-codec-v2', input: narrative, source, expectedValid: false, expectedSemanticValid: false, category: 'shape' });
  const badHash = structuredClone(v2.common); badHash.contentSha256 = 'f'.repeat(64);
  cases.push({ name: 'full-recomputed-shape-is-not-hash-authority', contract: 'full-student-analysis', input: badHash, source, expectedValid: true, expectedSemanticValid: false, category: 'semantic' });
  const numeric = structuredClone(wire); numeric.academicRecords[0].literalValues[0].value = '96';
  cases.push({ name: 'wire-literal-must-match-value-span', contract: 'student-analysis-codec-v2', input: numeric, source, expectedValid: true, expectedSemanticValid: false, category: 'semantic' });
  const unused = structuredClone(wire); unused.quoteDictionary.push({ id: 99, sourceKey: 'B1', quote: '원문에 없는 미검증 개인 성과를 만들었다.' });
  cases.push({ name: 'wire-unused-quote-still-source-bound', contract: 'student-analysis-codec-v2', input: unused, source, expectedValid: true, expectedSemanticValid: false, category: 'semantic' });
  return cases;
}
