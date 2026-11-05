import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { InterviewContext } from '../server/data/load-interview-context';
import { FULL_ANALYSIS_CURRENT, FULL_ANALYSIS_VERSION_V2, STUDENT_ANALYSIS_CODEC_VERSION, studentAnalysisCodecV2Schema, decodeStudentAnalysisV2, fullAnalysisIdentity, materializeFullStudentAnalysis, saveFullStudentAnalysis, loadStagedFullStudentAnalysis, loadFullStudentAnalysis, activateStagedFullStudentAnalysis, activateReviewedObjectiveContracts, publishReviewedObjectiveContracts, analysisQAManifest, loadFullRecord, stageReviewedObjectiveExtensions, type FullRecordSource, type FullAnalysisBankReadiness, type StudentAnalysisCodecV2 } from '../server/data/full-student-analysis';
import { loadPinnedAnalysisGuidelines } from '../scripts/prepare-student-analysis';
import { loadPreparedActivities } from '../server/data/prepared-activities';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const ref = (quoteId: number) => ({ kind: 'proof_ref' as const, quoteId });
function fixture() {
  const texts = ['학생은 온도를 달리해 전도도를 비교하고 관찰값을 기록했다.', '2학년 1학기 수학Ⅱ 원점수 95 성취도 A'];
  const text = texts.join('\n'), sourceBlocks = texts.map((text, index) => ({ id: `source-${index}`, page: 1, startOffset: index ? texts[0].length + 1 : 0, endOffset: (index ? texts[0].length + 1 : 0) + text.length, text, textSha256: sha(text), processingStatus: 'pending_analysis' }));
  const body = { schemaVersion: 'full-record-source-v1' as const, revision: 'source-fixture', recordRevision: 'a'.repeat(64), studentId: 'STUDENT-codec-fixture', sourceDocumentId: 'DOC-fixture', sourceFile: 'synthetic.pdf', pdfSha256: 'a'.repeat(64), pageCount: 1, pages: [{ page: 1, text, textSha256: sha(text), textStatus: 'text_extracted', items: [] }], blocks: sourceBlocks, coverage: { expectedPages: 1, extractedPages: 1, fullPageExtraction: true, pagesRequiringOcrReview: [], independentSemanticOrOcrReview: false as const } };
  const source: FullRecordSource = { ...body, contentSha256: sha(JSON.stringify(body)) };
  const context = { errors: [], target: { studentName: 'fixture', university: '합성 대학', department: '합성 학과', track: '합성 전형', year: 2027 }, school: { interview: { id: 'TARGET-codec-fixture' }, officialInterviewCriteria: { elements: [{ name: '학업역량' }] } }, student: { pdfSha256: source.pdfSha256, evidence: [] }, manifest: { files: [{ role: 'studentAnalysisGuidelines', sha256: 'b'.repeat(64) }] } } as unknown as InterviewContext;
  const span = (literal: string) => ({ proofRef: ref(2), binding: 'offsets' as const, start: texts[1].indexOf(literal), end: texts[1].indexOf(literal) + literal.length, literal });
  const wire: StudentAnalysisCodecV2 = {
    schemaVersion: 'student-analysis-wire-v2', codecVersion: STUDENT_ANALYSIS_CODEC_VERSION,
    quoteDictionary: texts.map((quote, index) => ({ id: index + 1, sourceKey: `B${index + 1}`, quote })),
    activities: [{ localId: 'A1', title: '온도와 전도도 비교 탐구', grade: 2, area: '과학', factProofRefs: { recordedContext: [ref(1)], studentActions: [ref(1)], teamActions: [], choiceReasons: [], outcomes: [], teacherObservations: [] }, interpretations: [{ field: 'summary', text: '변인을 통제한 탐구라는 모델 해석', basisProofRefs: [ref(1)] }], unknowns: ['구체적인 측정 도구는 미기록'] }],
    academicRecords: [{ localId: 'C1', grade: 2, semester: 1, subject: '수학Ⅱ', gradingSystem: 'achievement', proofRefs: [ref(2)], literalValues: [{ kind: 'academic_literal', value: '95', valueSpan: span('95'), provenance: { rowIndex: 0, columnIndex: 0, rowLabel: span('수학Ⅱ'), columnLabel: span('원점수'), grade: 2, semester: 1, subject: '수학Ⅱ', gradingSystem: 'achievement', gradeProofRefs: [ref(2)], semesterProofRefs: [ref(2)], subjectProofRefs: [ref(2)], gradingSystemProofRefs: [ref(2)], structureStatus: 'resolved' } }], tableStructure: { status: 'resolved', unresolvedReasons: [] }, interpretations: [], interpretationLimit: '한 학기의 원점수이며 상승 원인이나 과학 명제의 진실을 확정하지 않는다.' }],
    trajectories: [], sourceDispositions: sourceBlocks.map((_, index) => ({ sourceKey: `B${index + 1}`, status: 'analyzed' as const, reason: '해당 합성 원문을 모두 구조화했다.' })), activityPriorities: [{ activityLocalId: 'A1', priority: 'A', reason: '탐구 과정의 판단과 관찰 기록을 확인할 준비가 필요하다.', criterionName: '학업역량', representative: true }],
    objectives: Array.from({ length: 8 }, (_, index) => ({ originKind: index < 4 ? 'activity' as const : 'academic_record' as const, entityLocalIds: [index < 4 ? 'A1' : 'C1'], primaryFunction: 'PROCESS' as const, depth: 'D2' as const, target: `실제로 기록된 경험의 구체적인 과정 ${index + 1}`, requiredMeaning: `기록과 연결된 설명 의미 ${index + 1}`, reason: '지원처의 학업 관점에서 실제 경험의 구체적 판단을 확인한다.', semanticKey: `unique-purpose-${index}`, anchorProofRef: ref(index < 4 ? 1 : 2), unknowns: [], forbiddenPremises: ['성적 변화 원인을 단정하지 않는다.'], openCheck: true })),
  };
  return { source, context, wire };
}

async function workspace(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'analysis-codec-v2-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('analysis-codec-v2-')); await rm(root, { recursive: true, force: true }); });
  return root;
}
async function saveSource(root: string, source: FullRecordSource) {
  const sourcePath = 'data/prepared/record-revisions/source-fixture/source.json';
  await mkdir(path.dirname(path.join(root, sourcePath)), { recursive: true });
  await writeFile(path.join(root, sourcePath), JSON.stringify(source));
  await writeFile(path.join(root, 'data/prepared/full-record-current.json'), JSON.stringify({ path: sourcePath, pdfSha256: source.pdfSha256, contentSha256: source.contentSha256 }));
}

test('v2 typed references retain exact fact slots and keep model interpretations separate', () => {
  const { source, context, wire } = fixture(), value = materializeFullStudentAnalysis(context, source, wire, { model: 'synthetic', generatedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(value.common.schemaVersion, FULL_ANALYSIS_VERSION_V2);
  assert.equal(value.common.activities[0].facts.studentActions.length, 1);
  assert.equal(value.common.activities[0].interpretations?.[0].status, 'model_interpretation_not_record_fact');
  assert.equal(value.common.activities[0].facts.studentActions.some(proof => proof.quote.includes('모델 해석')), false);
  const cell = value.common.academicRecords[0].literalValues![0];
  assert.deepEqual(value.common.academicRecords[0].recordedValues, ['95']);
  assert.equal(cell.valueProof.quote, '95');
  assert.equal(source.pages[0].text.slice(cell.valueProof.pageStart, cell.valueProof.pageEnd), '95');
  assert.equal(cell.provenance.columnLabel?.quote, '원점수');
  assert.equal(cell.provenance.grade, 2);
  assert.ok(value.evidence.every(row => row.scientificTruthVerification === 'not_independently_verified'));
  assert.notEqual(fullAnalysisIdentity(context, source, 'synthetic'), fullAnalysisIdentity(context, source, 'synthetic', 'v1'));
  const changed = structuredClone(wire); changed.activities[0].interpretations[0].text += ' 변경';
  assert.notEqual(materializeFullStudentAnalysis(context, source, changed, { model: 'synthetic' }).common.revision, value.common.revision);
});

test('deep typed derivation preserves both actual academic rows as explicit objective anchors', async () => {
  const {source,context,wire}=fixture(),text='2학년 2학기 수학Ⅱ 원점수 88 성취도 B',start=source.pages[0].text.length+1;
  source.pages[0].text+='\n'+text;source.pages[0].textSha256=sha(source.pages[0].text);
  source.blocks.push({id:'source-2',page:1,startOffset:start,endOffset:start+text.length,text,textSha256:sha(text),processingStatus:'pending_analysis'});
  const {contentSha256:ignored,...sourceBody}=source;void ignored;source.contentSha256=sha(JSON.stringify(sourceBody));
  wire.quoteDictionary.push({id:3,sourceKey:'B3',quote:text});wire.sourceDispositions.push({sourceKey:'B3',status:'analyzed',reason:'두 번째 학기의 원문 행과 열을 확인했다.'});
  const span=(literal:string)=>({proofRef:ref(3),binding:'offsets' as const,start:text.indexOf(literal),end:text.indexOf(literal)+literal.length,literal});
  const second=structuredClone(wire.academicRecords[0]);second.localId='C2';second.semester=2;second.proofRefs=[ref(3)];
  second.literalValues=[{kind:'academic_literal',value:'88',valueSpan:span('88'),provenance:{rowIndex:1,columnIndex:0,rowLabel:span('수학Ⅱ'),columnLabel:span('원점수'),grade:2,semester:2,subject:'수학Ⅱ',gradingSystem:'achievement',gradeProofRefs:[ref(3)],semesterProofRefs:[ref(3)],subjectProofRefs:[ref(3)],gradingSystemProofRefs:[ref(3)],structureStatus:'resolved'}}];wire.academicRecords.push(second);
  wire.objectives[0]={...wire.objectives[0],originKind:'academic_record',entityLocalIds:['C1','C2'],primaryFunction:'CONNECTION',anchorProofRef:ref(2)};
  const old=materializeFullStudentAnalysis(context,source,wire,{model:'synthetic'}),deep=materializeFullStudentAnalysis(context,source,wire,{model:'synthetic',derivationVersion:'full-record-deep-v1'});
  assert.notEqual(deep.common.revision,old.common.revision);
  assert.equal(deep.target.objectives[0].anchorRefs.length,2);assert.equal(deep.target.objectives[0].activityIds.length,0);
  assert.ok(deep.target.objectives[0].knownFacts?.some(text=>text.includes('95')));assert.ok(deep.target.objectives[0].knownFacts?.some(text=>text.includes('88')));
  const runtime={...context,student:{...context.student,evidence:deep.evidence},targetAnalysis:deep.target};
  const {createStudentObjectiveCandidates}=await import('../server/question-objective');
  assert.equal(createStudentObjectiveCandidates(runtime)[0].anchorRefs.length,2);
});

test('v2 rejects narratives in fact refs, dictionary IDs as literals, missing refs and unverified unused dictionary entries', () => {
  const { source, wire } = fixture();
  const narrative = structuredClone(wire) as unknown as { activities: Array<{ factProofRefs: { studentActions: unknown[] } }> };
  narrative.activities[0].factProofRefs.studentActions = ['학생이 팀장을 맡았다는 서술'];
  assert.equal(studentAnalysisCodecV2Schema.safeParse(narrative).success, false);
  const badLiteral = structuredClone(wire); badLiteral.academicRecords[0].literalValues[0].value = 'Q2';
  assert.throws(() => decodeStudentAnalysisV2(source, badLiteral), /LITERAL_MISMATCH/);
  const shiftedLiteral = structuredClone(wire); shiftedLiteral.academicRecords[0].literalValues[0].valueSpan.start!++;
  assert.throws(() => decodeStudentAnalysisV2(source, shiftedLiteral), /SPAN_MISMATCH/);
  const missing = structuredClone(wire); missing.activities[0].factProofRefs.studentActions = [ref(999)];
  assert.throws(() => decodeStudentAnalysisV2(source, missing), /QUOTE_ID_MISSING/);
  const forgedUnused = structuredClone(wire); forgedUnused.quoteDictionary.push({ id: 99, sourceKey: 'B1', quote: '학생이 없는 성과를 만들었다.' });
  assert.throws(() => decodeStudentAnalysisV2(source, forgedUnused), /QUOTE_UNVERIFIED/);
  const repeated = structuredClone(wire); repeated.quoteDictionary.push(repeated.quoteDictionary[0]);
  assert.throws(() => decodeStudentAnalysisV2(source, repeated), /ID_DUPLICATE/);
  const unique = structuredClone(wire); unique.academicRecords[0].literalValues[0].valueSpan = { ...unique.academicRecords[0].literalValues[0].valueSpan, binding: 'unique_literal', start: null, end: null };
  assert.equal(decodeStudentAnalysisV2(source, unique).academicDetails.get('C1')?.literalValues[0].valueProof.quote, '95');
  unique.academicRecords[0].literalValues[0].valueSpan.literal = '학'; unique.academicRecords[0].literalValues[0].value = '학';
  assert.throws(() => decodeStudentAnalysisV2(source, unique), /LITERAL_NOT_UNIQUE/);
});

test('academic structure needs explicit provenance and unresolved rows cannot claim analyzed/comparable status', () => {
  const { source, context, wire } = fixture();
  const missingColumn = structuredClone(wire); missingColumn.academicRecords[0].literalValues[0].provenance.columnLabel = null;
  assert.throws(() => decodeStudentAnalysisV2(source, missingColumn), /PROVENANCE_INCOMPLETE/);
  const unresolved = structuredClone(wire);
  unresolved.academicRecords[0].tableStructure = { status: 'unresolved', unresolvedReasons: ['원문의 표 열 순서를 독립 확인하지 못했다.'] };
  unresolved.academicRecords[0].literalValues[0].provenance.structureStatus = 'unresolved';
  assert.throws(() => decodeStudentAnalysisV2(source, unresolved), /UNRESOLVED_SOURCE_ANALYZED/);
  unresolved.sourceDispositions[1].status = 'needs_review';
  const result = materializeFullStudentAnalysis(context, source, unresolved, { model: 'synthetic' });
  assert.equal(result.common.academicRecords[0].comparisonEligible, false);
  assert.equal(result.common.academicRecords[0].literalValues![0].value, '95');
});

test('persisted resolved rows cannot lose table provenance or substitute an unrelated exact source quote', () => {
  const { source, context, wire } = fixture();
  const value = materializeFullStudentAnalysis(context, source, wire, { model: 'synthetic' });
  const rehash = (copy: typeof value) => { const { contentSha256: ignored, ...body } = copy.common; void ignored; copy.common.contentSha256 = sha(JSON.stringify(body)); return copy; };
  for (const mutate of [
    (copy: typeof value) => { copy.common.academicRecords[0].literalValues![0].provenance.columnLabel = null; },
    (copy: typeof value) => { copy.common.academicRecords[0].literalValues![0].provenance.semesterProofs = []; },
    (copy: typeof value) => { copy.common.academicRecords[0].literalValues![0].provenance.rowIndex = -1; },
  ]) { const copy = structuredClone(value); mutate(copy); assert.throws(() => analysisQAManifest(rehash(copy), source, null), /PROVENANCE_INCOMPLETE/); }
  const foreign = structuredClone(value), cell = foreign.common.academicRecords[0].literalValues![0];
  cell.provenance.rowLabel = foreign.common.activities[0].facts.studentActions[0];
  assert.throws(() => analysisQAManifest(rehash(foreign), source, null), /PROVENANCE_NOT_IN_RECORD/);
  const incomparable = structuredClone(value); incomparable.common.academicRecords[0].comparisonEligible = false;
  assert.throws(() => analysisQAManifest(rehash(incomparable), source, null), /COMPARISON_INVALID/);
});

test('decoder and persisted QA both accept separate row and header quotes from one table source block', async t => {
  const root = await workspace(t), { source, context, wire } = fixture();
  const academicText = '2학년 1학기 원점수 성취도\n수학Ⅱ 95 A', block = source.blocks[1];
  block.text = academicText; block.endOffset = block.startOffset + academicText.length; block.textSha256 = sha(academicText);
  source.pages[0].text = source.blocks[0].text + '\n' + academicText; source.pages[0].textSha256 = sha(source.pages[0].text);
  const { contentSha256: ignored, ...body } = source; void ignored; source.contentSha256 = sha(JSON.stringify(body));
  wire.quoteDictionary[1].quote = academicText;
  wire.quoteDictionary.push({ id: 3, sourceKey: 'B2', quote: '수학Ⅱ 95 A' });
  const record = wire.academicRecords[0], cell = record.literalValues[0];
  record.proofRefs = [ref(3)];
  cell.valueSpan = { proofRef: ref(3), binding: 'unique_literal', start: null, end: null, literal: '95' };
  cell.provenance.rowLabel = { proofRef: ref(3), binding: 'unique_literal', start: null, end: null, literal: '수학Ⅱ' };
  cell.provenance.columnLabel = { proofRef: ref(2), binding: 'unique_literal', start: null, end: null, literal: '원점수' };
  const decoded = decodeStudentAnalysisV2(source, wire);
  assert.equal(decoded.academicDetails.get('C1')?.literalValues[0].provenance.columnLabel?.quote, '원점수');
  const value = materializeFullStudentAnalysis(context, source, wire, { model: 'synthetic' });
  assert.equal(analysisQAManifest(value, source, null).academicLiteralCount, 1);
  await saveSource(root, source);
  const staged = await saveFullStudentAnalysis(value, source, root);
  assert.equal((await loadStagedFullStudentAnalysis(context, staged.revisionPath, root)).common.academicRecords[0].comparisonEligible, true);
});

test('full-record page identity is checked even if a modified outer digest is recomputed', async t => {
  const root = await workspace(t), { source } = fixture();
  source.pages[0].textSha256 = '0'.repeat(64);
  const { contentSha256: ignored, ...body } = source; void ignored; source.contentSha256 = sha(JSON.stringify(body));
  await saveSource(root, source);
  await assert.rejects(loadFullRecord(root), /PAGE_IDENTITY_INVALID/);
});

test('v2 immutable staging preserves current pointer and requires exact bank/recovery binding for separate activation', async t => {
  const root = await workspace(t), { source, context, wire } = fixture();
  await saveSource(root, source);
  const historical = materializeFullStudentAnalysis(context, source, decodeStudentAnalysisV2(source, wire).wire, { model: 'synthetic-v1' });
  const historicalSaved = await saveFullStudentAnalysis(historical, source, root);
  await assert.rejects(readFile(path.join(root, FULL_ANALYSIS_CURRENT)), /ENOENT/, 'saving a legacy import also only stages');
  await writeFile(path.join(root, FULL_ANALYSIS_CURRENT), JSON.stringify({ path: historicalSaved.revisionPath, revision: historical.common.revision, sourceContentSha256: source.contentSha256 }));
  const oldPointer = await readFile(path.join(root, FULL_ANALYSIS_CURRENT), 'utf8');
  assert.deepEqual(await loadFullStudentAnalysis(context, root), historical);
  const prepared = materializeFullStudentAnalysis(context, source, wire, { model: 'synthetic' });
  const saved = await saveFullStudentAnalysis(prepared, source, root);
  assert.equal(await readFile(path.join(root, FULL_ANALYSIS_CURRENT), 'utf8'), oldPointer);
  const staged = await loadStagedFullStudentAnalysis(context, saved.revisionPath, root);
  assert.equal(staged.manifest.exactSourceSpansVerified, true);
  assert.equal(staged.manifest.academicLiteralCount, 1);
  assert.equal(staged.manifest.scientificTruthVerified, false);
  assert.deepEqual(staged.manifest.unresolvedAcademicRecordIds, []);
  await assert.rejects(activateReviewedObjectiveContracts(context, staged.revisionPath, root), /ENOENT|PARENT_CHANGED/, 'the target-only correction route cannot activate a new common analysis');
  const bankBody = { key: 'fixture-bank', status: 'ready' };
  const bank = { ...bankBody, contentSha256: sha(JSON.stringify(bankBody)) }, bankBytes = JSON.stringify(bank), bankPath = 'data/prepared/question-banks/fixture.json';
  await mkdir(path.dirname(path.join(root, bankPath)), { recursive: true });
  await writeFile(path.join(root, bankPath), bankBytes);
  const recoveryPath = 'data/prepared/fixture-recovery.json', recoveryBytes = JSON.stringify({ bankKey: bank.key });
  await writeFile(path.join(root, recoveryPath), recoveryBytes);
  const readiness: FullAnalysisBankReadiness = { bankPath, bankFileSha256: sha(bankBytes), bankKey: bank.key, bankContentSha256: bank.contentSha256, commonContentSha256: prepared.common.contentSha256, targetContentSha256: prepared.target.contentSha256, evidenceSha256: staged.manifest.evidenceSha256, analysisQAManifestSha256: staged.manifest.contentSha256, recovery: { manifestPath: recoveryPath, sha256: sha(recoveryBytes), bankKey: bank.key }, verifiedAt: new Date().toISOString() };
  await assert.rejects(activateStagedFullStudentAnalysis(context, staged.revisionPath, { ...readiness, targetContentSha256: 'wrong' }, root), /BANK_BINDING_INVALID/);
  assert.equal(await readFile(path.join(root, FULL_ANALYSIS_CURRENT), 'utf8'), oldPointer);
  await activateStagedFullStudentAnalysis(context, staged.revisionPath, readiness, root);
  assert.deepEqual(await loadFullStudentAnalysis(context, root), prepared);
  await assert.rejects(activateStagedFullStudentAnalysis(context, staged.revisionPath, readiness, root), /PARENT_POINTER_CHANGED/);
});

test('staged QA detects mutated fact coordinates even when an attacker recomputes the common body hash', async t => {
  const root = await workspace(t), { source, context, wire } = fixture();
  await saveSource(root, source);
  const prepared = materializeFullStudentAnalysis(context, source, wire, { model: 'synthetic' });
  const saved = await saveFullStudentAnalysis(prepared, source, root), file = path.join(root, saved.revisionPath);
  const payload = JSON.parse(await readFile(file, 'utf8'));
  payload.common.activities[0].facts.studentActions[0].pageStart++;
  const { contentSha256: ignored, ...body } = payload.common;
  void ignored;
  payload.common.contentSha256 = sha(JSON.stringify(body));
  await writeFile(file, JSON.stringify(payload));
  await assert.rejects(loadStagedFullStudentAnalysis(context, saved.revisionPath, root), /PROOF_RANGE_INVALID/);
});

test('offline preparation uses both complete pinned MD policies and rejects changed policy bytes', async t => {
  const root = await workspace(t), { context } = fixture();
  const contents = ['# Full MD5 synthetic\n세부 규칙\nTAIL-MD5', '# Full MD9 synthetic\n목적 규칙\nTAIL-MD9'];
  context.manifest.files = await Promise.all(['studentAnalysisGuidelines', 'questionGuidelines'].map(async (role, index) => {
    const file = `${role}.md`; await writeFile(path.join(root, file), contents[index]);
    return { role, path: file, sha256: sha(contents[index]) };
  }));
  const loaded = await loadPinnedAnalysisGuidelines(context, root);
  assert.deepEqual(loaded.map(row => row.text), contents);
  await writeFile(path.join(root, 'questionGuidelines.md'), '# changed');
  await assert.rejects(loadPinnedAnalysisGuidelines(context, root), /POLICY_SOURCE_CHANGED/);
});

test('bounded source reviews retain immutable parent/artifact provenance and resolved rows survive partially reviewed surrounding blocks', async t => {
  const root = await workspace(t), { source, context, wire } = fixture();
  await saveSource(root, source);
  wire.sourceDispositions[1].status = 'needs_review';
  const parentProposalPath = 'data/prepared/student-analysis-proposals/parent.json', artifactPath = 'artifacts/review.json';
  await mkdir(path.dirname(path.join(root, parentProposalPath)), { recursive: true }); await mkdir(path.join(root, 'artifacts'));
  const parentBytes = JSON.stringify({ model: 'synthetic-parent-model', codecVersion: STUDENT_ANALYSIS_CODEC_VERSION, sourceContentSha256: source.contentSha256, status: 'completed' });
  await writeFile(path.join(root, parentProposalPath), parentBytes); await writeFile(path.join(root, artifactPath), 'synthetic-review');
  const sourceReview = { version: 'bounded-academic-source-review-v1' as const, reviewer: 'codex-source-review' as const, parentProposalPath, parentProposalSha256: sha(parentBytes), parentAnalysisRevision: 'synthetic-parent-revision', artifactPath, artifactSha256: sha('synthetic-review'), reviewedAt: new Date().toISOString(), scope: 'explicit_visually_reviewed_academic_rows_only' as const };
  const value = materializeFullStudentAnalysis(context, source, wire, { model: 'codex-source-review', sourceReview });
  assert.equal(value.common.academicRecords[0].comparisonEligible, true, 'exact resolved row provenance is distinct from unreviewed surrounding content');
  assert.deepEqual(value.common.sourceReview, sourceReview);
  const saved = await saveFullStudentAnalysis(value, source, root);
  assert.deepEqual((await loadStagedFullStudentAnalysis(context, saved.revisionPath, root)).common.sourceReview, sourceReview);
  const runtime = { ...context, student: { ...context.student, evidence: value.evidence, analysisRevision: value.common.revision }, studentAnalysis: value.common, targetAnalysis: value.target, manifest: { ...context.manifest, files:[...context.manifest.files,{role:'fullStudentAnalysis',path:saved.revisionPath,sha256:sha(await readFile(path.join(root,saved.revisionPath),'utf8'))}], errors: [], guidelineSourceVersions: {}, sourceIntegrity: { pdfHashVerified: true, evidenceReferencesVerified: true, evidenceTextVerified: true, evidenceCount: value.evidence.length } } } as unknown as InterviewContext;
  const projected = await loadPreparedActivities(runtime, root, 'synthetic-parent-model');
  assert.equal(projected?.model, 'codex-source-review');
  assert.equal(projected?.provenance.actualProvider, false);
  assert.deepEqual(projected?.provenance.sourceReview, sourceReview);
  assert.equal((await loadPreparedActivities(runtime, root, 'different-legacy-extractor-model'))?.model,'codex-source-review','the pinned typed analysis owns its actual model identity; compatibility projection is not another legacy extraction');
  await writeFile(path.join(root,FULL_ANALYSIS_CURRENT),JSON.stringify({path:'not-the-snapshot.json',revision:'a-new-active-revision'}));
  assert.equal((await loadPreparedActivities(runtime,root,'different-legacy-extractor-model'))?.contentSha256,projected?.contentSha256,'a verified snapshot pin is validated independently of a later active pointer');
  const forged=structuredClone(runtime);forged.manifest.files=forged.manifest.files.filter(file=>file.role!=='fullStudentAnalysis');
  assert.equal(await loadPreparedActivities(forged,root,'synthetic-parent-model'),null,'an in-memory body and model name do not substitute for a verified file/QA pin');
  const wrongPin=structuredClone(runtime);wrongPin.manifest.files.find(file=>file.role==='fullStudentAnalysis')!.sha256='0'.repeat(64);
  assert.equal(await loadPreparedActivities(wrongPin,root,'synthetic-parent-model'),null);
  const changedEvidence=structuredClone(runtime);changedEvidence.student.evidence[0].text+=' invented';
  assert.equal(await loadPreparedActivities(changedEvidence,root,'synthetic-parent-model'),null);
  await writeFile(path.join(root, artifactPath), 'tampered-review');
  await assert.rejects(loadStagedFullStudentAnalysis(context, saved.revisionPath, root), /SOURCE_REVIEW_ARTIFACT_INVALID/);
  assert.equal(await loadPreparedActivities(runtime, root, 'synthetic-parent-model'), null);
});

test('a target-only correction can derive a fully loadable v2 staged envelope without activating or changing common facts', async t => {
  const root = await workspace(t), { source, context, wire } = fixture();
  await saveSource(root, source);
  const prepared = materializeFullStudentAnalysis(context, source, wire, { model: 'synthetic' });
  const base = await saveFullStudentAnalysis(prepared, source, root), originalBytes = await readFile(path.join(root, base.revisionPath), 'utf8');
  const before = prepared.target.objectives[0];
  const corrections = [{ objectiveId: before.id, previousQuestionIntent: before.questionIntent, previousTargetEvidence: before.targetEvidence, questionIntent: '실제로 발화된 수행 과정 한 가지', targetEvidence: ['실제로 발화된 수행 과정 한 가지'] as [string], reviewedQuestionSha256: sha('합성 독립 검수 발화') }];
  const review = { artifactSha256: sha('합성 정합성 검수'), model: 'synthetic-independent-review', reviewedAt: new Date().toISOString() };
  await assert.rejects(publishReviewedObjectiveContracts(context, corrections, review, root, { baseRevisionPath: base.revisionPath }), /ACTIVATION_REQUIRES_BANK_GATE/);
  const derived = await publishReviewedObjectiveContracts(context, corrections, review, root, { activate: false, baseRevisionPath: base.revisionPath });
  const loaded = await loadStagedFullStudentAnalysis(context, derived.revisionPath, root);
  assert.deepEqual(loaded.common, prepared.common);
  assert.deepEqual(loaded.evidence, prepared.evidence);
  assert.equal(loaded.manifest.commonContentSha256, base.manifest?.commonContentSha256);
  assert.equal(loaded.manifest.evidenceSha256, base.manifest?.evidenceSha256);
  assert.equal(loaded.manifest.parentPointerSha256, base.manifest?.parentPointerSha256);
  assert.notEqual(loaded.manifest.targetContentSha256, base.manifest?.targetContentSha256);
  assert.equal(loaded.target.objectiveContractRevision?.parentRevision, prepared.target.revision);
  assert.deepEqual(loaded.target.objectiveContractRevision?.approvedQuestions, [{ objectiveId: before.id, questionSha256: corrections[0].reviewedQuestionSha256 }]);
  assert.equal(await readFile(path.join(root, base.revisionPath), 'utf8'), originalBytes);
  await assert.rejects(readFile(path.join(root, FULL_ANALYSIS_CURRENT)), /ENOENT/);
});

test('reviewed function and depth changes preserve stale checks and leave unmodified contracts intact', async t => {
  const root = await workspace(t), { source, context, wire } = fixture();
  await saveSource(root, source);
  const prepared = materializeFullStudentAnalysis(context, source, wire, { model: 'synthetic' });
  const base = await saveFullStudentAnalysis(prepared, source, root), objective = prepared.target.objectives[0];
  const correction = { objectiveId: objective.id, previousQuestionIntent: objective.questionIntent, previousTargetEvidence: objective.targetEvidence, questionIntent: '현재 질문에서 실제로 요구한 역할 한 가지', targetEvidence: ['현재 질문에서 실제로 요구한 역할 한 가지'] as [string], reviewedQuestionSha256: sha('독립 검수한 역할 질문'), previousPrimaryFunction: objective.primaryFunction, primaryFunction: 'ROLE' as const, previousDepth: objective.depth, depth: 'D1' as const };
  const review = { artifactSha256: sha('검수 결과'), model: 'synthetic-independent-review', reviewedAt: new Date().toISOString() };
  await assert.rejects(publishReviewedObjectiveContracts(context, [{ ...correction, previousPrimaryFunction: 'FACT' }], review, root, { activate: false, baseRevisionPath: base.revisionPath }), /FUNCTION_CORRECTION_STALE/);
  const staged = await publishReviewedObjectiveContracts(context, [correction], review, root, { activate: false, baseRevisionPath: base.revisionPath });
  const loaded = await loadStagedFullStudentAnalysis(context, staged.revisionPath, root);
  assert.equal(loaded.target.objectives[0].primaryFunction, 'ROLE');
  assert.equal(loaded.target.objectives[0].depth, 'D1');
  assert.deepEqual(loaded.target.objectives.slice(1), prepared.target.objectives.slice(1));
  assert.deepEqual(loaded.common, prepared.common);
});

test('source-reviewed gap purposes stage over unchanged facts and require source, parent and artifact binding', async t => {
  const root = await workspace(t), { source, context, wire } = fixture();
  await saveSource(root, source);
  const prepared = materializeFullStudentAnalysis(context, source, wire, { model: 'synthetic' });
  const base = await saveFullStudentAnalysis(prepared, source, root);
  const extension = { originKind: 'record_gap' as const, entityIds: [prepared.common.activities[0].id], evidenceIds: [prepared.evidence.find(row => row.originEntityId === prepared.common.activities[0].id)!.id], primaryFunction: 'ROLE' as const, depth: 'D1' as const, questionIntent: '기록된 공동 탐구에서 직접 맡은 범위 확인', targetEvidence: ['직접 맡은 범위의 존재와 내용'] as [string], semanticKey: 'individually-performed-role-gap', selectionBasis: '공동 수행 기록과 개인 귀속의 미확인 범위를 분리한다.', unknowns: ['개인 수행 범위'], forbiddenPremises: ['학생이 팀 전체 작업을 직접 했다고 단정함'] };
  const artifactPath = 'artifacts/source-review.json', reviewedAt = new Date().toISOString();
  const artifact = { version: 'bounded-record-source-purpose-review-v1', reviewerId: 'synthetic-developer-review', reviewedAt, sourcePdfSha256: source.pdfSha256, commonContentSha256: prepared.common.contentSha256, parentTargetContentSha256: prepared.target.contentSha256, parentAnalysisPath: base.revisionPath, extensions: [extension] };
  const artifactBytes = JSON.stringify(artifact);
  await mkdir(path.join(root, 'artifacts')); await writeFile(path.join(root, artifactPath), artifactBytes);
  const review = { artifactPath, artifactSha256: sha(artifactBytes), reviewerId: artifact.reviewerId, reviewedAt };
  for (const changed of [
    { ...extension, questionIntent: '검수하지 않은 다른 질문 목적' }, { ...extension, targetEvidence: ['검수하지 않은 요구'] as [string] }, { ...extension, primaryFunction: 'FACT' as const }, { ...extension, depth: 'D2' as const },
    { ...extension, entityIds: ['another-student-entity'] }, { ...extension, evidenceIds: [prepared.evidence.find(row => row.sourceKind === 'academic_record')!.id] }, { ...extension, unknowns: ['다른 미확인 범위'] }, { ...extension, forbiddenPremises: ['다른 단정 금지'] },
  ]) await assert.rejects(stageReviewedObjectiveExtensions(context, [changed], review, root, base.revisionPath), /SOURCE_REVIEW_BINDING_MISMATCH/);
  for (const changed of [{ ...artifact, sourcePdfSha256: '0'.repeat(64) }, { ...artifact, commonContentSha256: '0'.repeat(64) }, { ...artifact, parentTargetContentSha256: '0'.repeat(64) }]) {
    const bytes = JSON.stringify(changed); await writeFile(path.join(root, artifactPath), bytes);
    await assert.rejects(stageReviewedObjectiveExtensions(context, [extension], { ...review, artifactSha256: sha(bytes) }, root, base.revisionPath), /SOURCE_REVIEW_CONTEXT_MISMATCH/);
  }
  await writeFile(path.join(root, artifactPath), artifactBytes);
  const staged = await stageReviewedObjectiveExtensions(context, [extension], review, root, base.revisionPath);
  const loaded = await loadStagedFullStudentAnalysis(context, staged.revisionPath, root);
  assert.deepEqual(loaded.common, prepared.common); assert.deepEqual(loaded.evidence, prepared.evidence);
  assert.deepEqual(loaded.target.objectives.slice(0, prepared.target.objectives.length), prepared.target.objectives);
  assert.equal(loaded.target.objectives.at(-1)?.requiresOpenCheck, true);
  assert.equal(loaded.target.objectives.at(-1)?.originKind, 'record_gap');
  await assert.rejects(readFile(path.join(root, FULL_ANALYSIS_CURRENT)), /ENOENT/, 'staging never activates');
  const file = path.join(root, staged.revisionPath), manifestFile = path.join(root, staged.manifestPath);
  const originalPayload = await readFile(file, 'utf8'), originalManifest = await readFile(manifestFile, 'utf8');
  for (const mutate of [
    (row: typeof loaded.target.objectives[number]) => { row.questionIntent += ' 변조'; },
    (row: typeof loaded.target.objectives[number]) => { row.targetEvidence = ['검수되지 않은 추가 요구']; },
    (row: typeof loaded.target.objectives[number]) => { row.primaryFunction = 'FACT'; },
    (row: typeof loaded.target.objectives[number]) => { row.depth = 'D2'; },
    (row: typeof loaded.target.objectives[number]) => { row.activityIds = ['다른 활동']; },
    (row: typeof loaded.target.objectives[number]) => { row.anchorRefs[0].start++; },
    (row: typeof loaded.target.objectives[number]) => { row.unknowns!.push('검수되지 않은 해석'); },
    (row: typeof loaded.target.objectives[number]) => { row.forbiddenPremises = ['다른 금지 조건']; },
  ]) {
    const payload = JSON.parse(originalPayload); mutate(payload.target.objectives.at(-1));
    const { contentSha256: ignored, ...body } = payload.target; void ignored; payload.target.contentSha256 = sha(JSON.stringify(body));
    const manifest = analysisQAManifest(payload, source, JSON.parse(originalManifest).parentPointerSha256);
    await writeFile(file, JSON.stringify(payload)); await writeFile(manifestFile, JSON.stringify(manifest));
    await assert.rejects(loadStagedFullStudentAnalysis(context, staged.revisionPath, root), /SOURCE_REVIEW_BINDING_MISMATCH/);
  }
  await writeFile(file, originalPayload); await writeFile(manifestFile, originalManifest);
  const first = loaded.target.objectives[0];
  const corrected = await publishReviewedObjectiveContracts(context, [{ objectiveId: first.id, previousQuestionIntent: first.questionIntent, previousTargetEvidence: first.targetEvidence, questionIntent: '기존 문항의 실제 요구 한 가지', targetEvidence: ['기존 문항의 실제 요구 한 가지'], reviewedQuestionSha256: sha('기존 문항의 승인 발화') }], { artifactSha256: sha('기존 문항 재검수'), model: 'synthetic-independent-review', reviewedAt }, root, { activate: false, baseRevisionPath: staged.revisionPath });
  assert.deepEqual((await loadStagedFullStudentAnalysis(context, corrected.revisionPath, root)).target.objectives.at(-1), loaded.target.objectives.at(-1), 'later corrections to other objectives preserve reviewed extensions');
  await writeFile(path.join(root, artifactPath), 'altered review');
  await assert.rejects(loadStagedFullStudentAnalysis(context, staged.revisionPath, root), /SOURCE_REVIEW_ARTIFACT_INVALID/);
});
