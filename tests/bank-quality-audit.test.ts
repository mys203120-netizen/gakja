/** Phase 3 only: run after the root's audio E2E gate. No provider or PDF parser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { InterviewContext } from '../server/data/load-interview-context';
import { createStudentObjectiveCandidates } from '../server/question-objective';
import { compactStudentAnalysisWireSchema, expandCompactStudentAnalysis, materializeFullStudentAnalysis, type AnalysisWire, type FullRecordSource } from '../server/data/full-student-analysis';
import { auditStoredBankQuality, HISTORICAL_AUDIT_BANK_PATH, HISTORICAL_AUDIT_PROPOSAL_PATH, inspectCompactTransport, inspectTypedCanonicalTransport } from '../scripts/audit-bank-quality';
import dotenv from 'dotenv';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** The phase-3 regression describes its preserved historical inputs, not the
 * independently reviewed analysis subsequently activated for new sessions. */
async function auditPreservedHistoricalBank() {
  const baseline = JSON.parse(await readFile('artifacts/phase3-bank-quality-audit.json', 'utf8')) as { inputHashes: Array<{ path: string; sha256: string }> };
  const root = await mkdtemp(path.join(os.tmpdir(), 'preserved-bank-quality-'));
  const activePointer = await readFile('data/prepared/student-analysis-current.json');
  try {
    for (const entry of baseline.inputHashes.filter(row => row.path !== 'data/prepared/student-analysis-current.json')) {
      const bytes = await readFile(entry.path); assert.equal(sha(bytes), entry.sha256, `Preserved audit input changed: ${entry.path}`);
      const file = path.resolve(root, entry.path); assert.ok(path.relative(root, file) && !path.relative(root, file).startsWith('..'));
      await mkdir(path.dirname(file), { recursive: true }); await copyFile(entry.path, file);
    }
    const analysisPath = baseline.inputHashes.find(row => row.path.startsWith('data/prepared/student-analysis-revisions/') && row.path.endsWith('/analysis.json'))!.path;
    const analysis = JSON.parse(await readFile(analysisPath, 'utf8')) as { common: { revision: string; sourceContentSha256: string } };
    await writeFile(path.join(root, 'data/prepared/student-analysis-current.json'), JSON.stringify({ path: analysisPath, revision: analysis.common.revision, sourceContentSha256: analysis.common.sourceContentSha256 }, null, 2));
    const result = await auditStoredBankQuality(root, { historical: { bankPath: HISTORICAL_AUDIT_BANK_PATH, proposalPath: HISTORICAL_AUDIT_PROPOSAL_PATH } });
    assert.deepEqual(await readFile('data/prepared/student-analysis-current.json'), activePointer, 'Historical audit must not restore or mutate the active pointer');
    return result;
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('preserved-bank-quality-'));
    await rm(root, { recursive: true, force: true });
  }
}

/** Manually supplied semantic proposals over an explicitly synthetic record.
 * These prove source/data plumbing, not real-student or model generation quality. */
function syntheticCanon() {
  const texts = ['1학년 1학기 화학 원점수 85 성취도 A.', '2학년 1학기 화학 원점수 91 성취도 A.',
    '환경과 에너지에 관심을 가지고 공개 자료를 비교하여 보고서를 작성했다.', '그 보고서에는 직접 실험을 수행했는지와 개인별 분담이 기록되어 있지 않다.'];
  const pageText = texts.join('\n'); let offset = 0;
  const blocks = texts.map((text, index) => { const startOffset = offset; offset += text.length + 1; return { id: `synthetic-source-${index + 1}`, page: 1, startOffset, endOffset: startOffset + text.length, text, textSha256: sha(text), processingStatus: 'pending_analysis' }; });
  const body = { schemaVersion: 'full-record-source-v1' as const, revision: 'explicit-synthetic-source', recordRevision: 'explicit-synthetic-record', studentId: 'synthetic-bank-quality-student', sourceDocumentId: 'synthetic-document',
    sourceFile: 'explicit-synthetic.pdf', pdfSha256: 'a'.repeat(64), pageCount: 1, pages: [{ page: 1, text: pageText, textSha256: sha(pageText), textStatus: 'synthetic_text', items: [] }], blocks,
    coverage: { expectedPages: 1, extractedPages: 1, fullPageExtraction: true, pagesRequiringOcrReview: [], independentSemanticOrOcrReview: false as const } };
  const source: FullRecordSource = { ...body, contentSha256: sha(JSON.stringify(body)) };
  const context = { errors: [], target: { studentName: '합성 학생', university: '합성 대학', department: '합성 화학과', year: 2027 },
    school: { interview: { id: 'synthetic-track' }, officialInterviewCriteria: { elements: [{ name: '학업역량' }] } }, student: { pdfSha256: source.pdfSha256, evidence: [] },
    manifest: { files: [{ role: 'studentAnalysisGuidelines', sha256: 'b'.repeat(64) }] } } as unknown as InterviewContext;
  const proof = (index: number) => ({ sourceKey: `B${index + 1}`, quote: texts[index] });
  const origins = ['academic_record', 'academic_record', 'trajectory', 'trajectory', 'trajectory', 'record_gap', 'record_gap', 'record_gap'] as const;
  const wire: AnalysisWire = { activities: [{ localId: 'A1', title: '합성 에너지 자료 비교 보고서', grade: 2, area: '진로', recordedContext: [proof(2), proof(3)], studentActions: [proof(2)], teamActions: [], choiceReasons: [], outcomes: [], teacherObservations: [], unknowns: ['직접 실험 여부와 개인 분담은 미기록'] }],
    academicRecords: [0, 1].map(index => ({ localId: `R${index + 1}`, grade: index + 1, semester: 1, subject: '화학', gradingSystem: 'achievement', recordedValues: [index ? '91' : '85', 'A'], proofs: [proof(index)], interpretationLimit: '서로 다른 학기의 성적 차이 원인이나 진로 인과를 확정하지 않는다.' })),
    trajectories: [{ fromLocalId: 'R1', toLocalId: 'A1', relationship: 'career_interest', rationale: '학업 기록과 관심 활동은 연결 후보이며 인과가 아니다.', proofs: [proof(0), proof(2)] }],
    sourceDispositions: blocks.map((_, index) => ({ sourceKey: `B${index + 1}`, status: 'analyzed', reason: '명시적인 합성 입력의 원문 좌표만 확인하는 테스트' })),
    activityPriorities: [{ activityLocalId: 'A1', priority: 'A', reason: '자료 비교의 실제 범위와 기록되지 않은 개인 역할을 준비할 필요가 있다.', criterionName: '학업역량', representative: true }],
    objectives: origins.map((originKind, index) => ({ originKind, entityLocalIds: index < 2 ? [`R${index + 1}`] : index < 5 ? ['R1', 'A1'] : ['A1'],
      primaryFunction: index < 2 ? 'PROCESS' : index < 5 ? 'MOTIVE' : 'ROLE', depth: 'D2',
      target: index < 2 ? `화학 학습에서 활용한 방법 확인 ${index + 1}` : index < 5 ? `학업과 에너지 관심이 본인에게 연결됐는지 열린 확인 ${index + 1}` : `보고서에서 개인 역할이 있었는지 열린 확인 ${index + 1}`,
      requiredMeaning: index < 2 ? '해당 학기의 실제 학습 방법 한 가지' : index < 5 ? '관심 연결 여부와 실제 연결 지점 한 가지' : '직접 수행한 개인 역할의 존재와 실제 범위',
      reason: '현재 원문에 있는 사실과 미기록 범위를 분리해 한 지점을 확인한다.', semanticKey: `explicit-synthetic-domain-${index + 1}`,
      anchor: index < 2 ? proof(index) : index < 5 ? proof(0) : proof(3),
      unknowns: ['성적 차이의 원인과 개인 활동의 연결은 확인되지 않음'], forbiddenPremises: ['성적 상승의 원인을 활동이나 진로 관심으로 단정하지 않는다.', '실험 수행과 개인 기여가 있었다고 단정하지 않는다.'], openCheck: true })) };
  return { source, context, wire };
}

function compressedFixture() {
  const f = syntheticCanon();
  const dictionary = f.source.blocks.map((block, index) => ({ id: `Q${index + 1}`, sourceKey: `B${index + 1}`, quote: block.text }));
  const compact = compactStudentAnalysisWireSchema.parse({ ...f.wire, quoteDictionary: dictionary,
    activities: [{ ...f.wire.activities[0], recordedContext: ['Q3', 'Q4'], studentActions: ['Q3'], teamActions: [], choiceReasons: [], outcomes: [], teacherObservations: [] }],
    academicRecords: f.wire.academicRecords.map((row, index) => ({ ...row, proofs: [`Q${index + 1}`] })),
    trajectories: [{ ...f.wire.trajectories[0], proofs: ['Q1', 'Q3'] }],
    objectives: f.wire.objectives.map((objective, index) => ({ ...objective, anchor: index < 2 ? `Q${index + 1}` : index < 5 ? 'Q1' : 'Q4' })),
  });
  return { ...f, compact };
}

test('the preserved historical real bank retains its seven approved objectives and failing quality gate', async () => {
  const result = await auditPreservedHistoricalBank();
  assert.equal(result.technicalGate.status, 'PASS');
  assert.equal(result.actualBank.slots, 18); assert.equal(result.actualBank.approved, 7); assert.equal(result.actualBank.quarantined, 11);
  assert.deepEqual(result.actualBank.quarantineCodes, { PREMISE_UNSUPPORTED: 6, PREMISE_UNCERTAIN: 3, FORBIDDEN_SPEECH: 2 });
  assert.equal(result.realDataQualityGate.status, 'FAIL'); assert.equal(result.realDataQualityGate.semanticCompletenessProven, false);
  assert.ok(result.realDataQualityGate.reasons.includes('ACADEMIC_LITERAL_VALUE_CONTRACT_INCOMPLETE'));
  assert.ok(result.realDataQualityGate.reasons.includes('NO_APPROVED_ACADEMIC_QUESTION'));
  assert.equal(result.actualCanon.comparableAcademicRows, 0); assert.equal(result.transport.unboundFactValues, 90); assert.equal(result.transport.idValuedAcademicRows, 8);
  assert.equal(result.technicalGate.checks.decoderMatchesCanon, true); assert.equal(result.technicalGate.checks.unchangedInputs, true);
  assert.equal(result.operations.externalProviderCalls, 0); assert.equal(result.operations.pdfExtractions, 0);
});

test('five fixed-seed real-slot simulations use presentation-aware least-used history without current-session duplicates', async () => {
  const { selectionSimulation: result } = await auditPreservedHistoricalBank();
  assert.equal(result.sessions.length, 5); assert.equal(result.selections, 15); assert.equal(result.withinSessionDuplicateCount, 0);
  assert.equal(result.allMinimumUseOrdersRespected, true); assert.equal(result.uniqueSemanticKeys, 7);
  assert.equal(result.crossSessionReuse, 8); assert.equal(result.crossSessionHardExclusion, false);
  assert.equal(result.explicitSyntheticEligibility, 'EXPLICIT_SYNTHETIC_SESSION');
  assert.equal(result.wrongStudentEligibility, 'HISTORY_SCOPE_UNVERIFIED_OR_MISMATCHED'); assert.equal(result.realHumanSessionsObserved, 0);
});

test('active audit resolves the active bank and typed canonical instead of replaying the historical Q30 proposal', async () => {
  const sourceManifestPath = 'data/prepared/source-manifest.json';
  const activePointerPath = 'data/prepared/student-analysis-current.json';
  const manifestBefore = await readFile(sourceManifestPath), pointerBefore = await readFile(activePointerPath);
  const environment = { ...process.env, ...dotenv.parse(await readFile('.env.local')) };
  const result = await auditStoredBankQuality(process.cwd(), { environment });
  assert.equal(result.scope, 'active_verified_analysis_and_active_bank_identity');
  assert.notEqual(result.bankPath, HISTORICAL_AUDIT_BANK_PATH);
  assert.equal(result.transport.status, 'SOURCE_BOUND_TYPED_TRANSPORT_ONLY');
  assert.equal(result.transport.idValuedAcademicRows, 0);
  assert.equal(result.technicalGate.status, 'PASS');
  assert.ok(result.actualBank.approved > 7);
  assert.equal(result.selectionSimulation.sessions.length, 3);
  assert.equal(result.selectionSimulation.withinSessionDuplicateCount, 0);
  assert.equal(result.selectionSimulation.reusedWhileUnseenAvailable, 0);
  assert.ok(result.selectionSimulation.sessions.every(row => row.selected.length === row.selectedCandidateIds.length && row.selected.length === row.selectedActivityIds.length));
  assert.deepEqual(await readFile(sourceManifestPath), manifestBefore, 'read-only context must not overwrite the manifest');
  assert.deepEqual(await readFile(activePointerPath), pointerBefore, 'audit must not activate or rewrite an analysis');
  const pointer = JSON.parse(pointerBefore.toString('utf8')) as { path: string };
  const canonical = JSON.parse(await readFile(pointer.path, 'utf8')) as { common: Parameters<typeof inspectTypedCanonicalTransport>[0] };
  const inconsistent = structuredClone(canonical.common); inconsistent.academicRecords[0].recordedValues = ['Q30'];
  assert.equal(inspectTypedCanonicalTransport(inconsistent).status, 'PARTIAL_TRANSPORT_CONTRACT');
});

test('separate synthetic verified canon can represent academic, career and open record-gap objectives without asserting real-bank coverage', () => {
  const f = syntheticCanon(), before = JSON.stringify(f);
  const analysis = materializeFullStudentAnalysis(f.context, f.source, f.wire, { model: 'explicit-synthetic-test' });
  const context = { ...f.context, student: { ...f.context.student, evidence: analysis.evidence }, targetAnalysis: analysis.target };
  const projected = createStudentObjectiveCandidates(context);
  assert.deepEqual(projected.map(objective => objective.id), analysis.target.objectives.map(objective => objective.id));
  assert.equal(projected.filter(objective => objective.originKind === 'academic_record').length, 2);
  assert.equal(projected.filter(objective => objective.originKind === 'trajectory').length, 3);
  assert.equal(projected.filter(objective => objective.originKind === 'record_gap').length, 3);
  assert.ok(projected.filter(objective => objective.originKind === 'academic_record').every(objective => objective.activityIds.length === 0));
  assert.ok(projected.every(objective => objective.requiresOpenCheck && objective.forbiddenPremises?.includes('성적 상승의 원인을 활동이나 진로 관심으로 단정하지 않는다.')));
  assert.equal(analysis.common.trajectories[0].status, 'possible_connection_not_causal_fact');
  assert.equal(analysis.common.coverage.independentSemanticReview, false); assert.equal(JSON.stringify(f), before);
});

test('ambiguous or unprocessed grade rows stay outside the comparable set and invented values cannot become canonical facts', () => {
  const f = syntheticCanon(); f.wire.academicRecords[0].semester = null; f.wire.academicRecords[0].gradingSystem = 'raw_table_unclear';
  f.wire.sourceDispositions[1].status = 'needs_review';
  const analysis = materializeFullStudentAnalysis(f.context, f.source, f.wire, { model: 'explicit-synthetic-test' });
  assert.equal(analysis.common.academicRecords.filter(row => row.comparisonEligible).length, 0);
  assert.ok(analysis.target.objectives.every(objective => objective.forbiddenPremises?.includes('성적 상승의 원인을 활동이나 진로 관심으로 단정하지 않는다.')));
  const invented = structuredClone(f.wire); invented.academicRecords[0].recordedValues = ['99'];
  assert.throws(() => materializeFullStudentAnalysis(f.context, f.source, invented, { model: 'explicit-synthetic-test' }), /ACADEMIC_VALUE_NOT_RECORDED/u);
});

test('valid quote IDs preserve action slots while narratives and missing action references are diagnosed as partial transport', () => {
  const f = compressedFixture();
  const valid = inspectCompactTransport(f.compact);
  assert.equal(valid.status, 'SOURCE_BOUND_TRANSPORT_ONLY'); assert.equal(valid.expanded.activities[0].studentActions.length, 1);
  assert.equal(valid.semanticCompletenessProven, false);
  for (const value of ['missing-reference', '역할을 주도했다는 근거 없는 모델 요약']) {
    const changed = structuredClone(f.compact); changed.activities[0].studentActions = [value];
    const result = inspectCompactTransport(changed);
    assert.equal(result.status, 'PARTIAL_TRANSPORT_CONTRACT'); assert.equal(result.unboundFactValues, 1);
    assert.deepEqual(result.expanded.activities[0].studentActions, []); assert.ok(result.expanded.activities[0].unknowns.some(note => note.includes(value)));
  }
  const missingContext = structuredClone(f.compact); missingContext.activities[0].recordedContext = ['missing-reference'];
  assert.throws(() => expandCompactStudentAnalysis(missingContext), /CONTEXT_QUOTE_MISSING/u);
});

test('a dictionary ID supplied as a grade value is a transport failure rather than evidence that the grade row was understood', () => {
  const f = compressedFixture(), before = JSON.stringify(f.compact);
  f.compact.academicRecords[0].recordedValues = ['Q1'];
  const result = inspectCompactTransport(f.compact);
  assert.equal(result.idValuedAcademicRows, 1); assert.equal(result.status, 'PARTIAL_TRANSPORT_CONTRACT');
  assert.deepEqual(result.expanded.academicRecords[0].recordedValues, []); assert.equal(result.expanded.academicRecords[0].gradingSystem, 'raw_table_unclear');
  assert.notEqual(JSON.stringify(f.compact), before, 'only the explicit test input was changed');
  assert.deepEqual(f.wire.academicRecords[0].recordedValues, ['85', 'A'], 'the verified literal-value fixture is unchanged');
});
