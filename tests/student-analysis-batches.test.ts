import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { encodePreservedAnalysis, combineDeepBatches, expandDeepAcademicRow, verifyDeepBatchQuotes, studentDeepBatchSchema, materializeDeepWire,applyReviewedDeepQuoteCorrections,mergeSourceReviewedAcademicCatalog } from '../server/data/student-analysis-batches';
import { decodeStudentAnalysisV2, STUDENT_ANALYSIS_CODEC_VERSION, studentAnalysisCodecV2Schema, type FullRecordSource, type FullStudentAnalysis } from '../server/data/full-student-analysis';
import { prepareStudentDeepAnalysis } from '../scripts/prepare-student-deep-analysis';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const ref = (quoteId: number) => ({ kind: 'proof_ref' as const, quoteId });
function fixture() {
  const texts = ['학생은 온도를 달리해 전도도를 비교하고 관찰값을 기록했다.', '2학년 1학기 수학Ⅱ 원점수 95 성취도 A'];
  const text = texts.join('\n'), starts = [0, texts[0].length + 1];
  const blocks = texts.map((text, i) => ({ id: `source-${i}`, page: 1, startOffset: starts[i], endOffset: starts[i] + text.length, text, textSha256: sha(text), processingStatus: 'pending_analysis' }));
  const body = { schemaVersion: 'full-record-source-v1' as const, revision: 'synthetic-source', recordRevision: 'a'.repeat(64), studentId: 'synthetic-student', sourceDocumentId: 'synthetic-document', sourceFile: 'synthetic.pdf', pdfSha256: 'a'.repeat(64), pageCount: 1, pages: [{ page: 1, text, textSha256: sha(text), textStatus: 'text_extracted', items: [] }], blocks, coverage: { expectedPages: 1, extractedPages: 1, fullPageExtraction: true, pagesRequiringOcrReview: [], independentSemanticOrOcrReview: false as const } };
  const source: FullRecordSource = { ...body, contentSha256: sha(JSON.stringify(body)) };
  const proof = (index: number, quote = texts[index]) => { const start = texts[index].indexOf(quote); return { sourceRefId: blocks[index].id, page: 1, pageStart: starts[index] + start, pageEnd: starts[index] + start + quote.length, quote, sourceTextSha256: blocks[index].textSha256 }; };
  const common = { activities: [{ id: 'ACT-existing', localId: 'A0', title: '온도에 따른 전도도 비교', grade: 2, area: '과학', facts: { recordedContext: [proof(0)], studentActions: [proof(0)], teamActions: [], choiceReasons: [], outcomes: [], teacherObservations: [] }, unknowns: [] }], academicRecords: [{ id: 'ACA-existing', localId: 'C0', grade: 2, semester: 1, subject: '수학Ⅱ', gradingSystem: 'achievement', recordedValues: ['95'], proofs: [proof(1)], interpretationLimit: '기록된 한 학기의 수치만 확인한다.', comparisonEligible: true, tableStructure: { status: 'resolved', unresolvedReasons: [] }, literalValues: [{ kind: 'academic_literal', value: '95', valueProof: proof(1, '95'), provenance: { rowIndex: 0, columnIndex: 0, rowLabel: proof(1, '수학Ⅱ'), columnLabel: proof(1, '원점수'), grade: 2, semester: 1, subject: '수학Ⅱ', gradingSystem: 'achievement', structureStatus: 'resolved', gradeProofs: [proof(1, '2학년')], semesterProofs: [proof(1, '1학기')], subjectProofs: [proof(1, '수학Ⅱ')], gradingSystemProofs: [proof(1, '성취도')] } }] }] } as unknown as FullStudentAnalysis;
  return { source, common };
}
function emptyBatch() {
  return { schemaVersion: 'student-source-deep-batch-v1' as const, quoteDictionary: [], activities: [], academicRecords: [], sourceReviews: ['B1', 'B2'].map((sourceKey, index) => ({ sourceKey, status: 'analyzed' as const, reason: '기존 확인된 원문 내용을 다시 읽고 분해했다.', units: [{ title: index ? '수학 성적 행' : '전도도 탐구', kind: index ? 'academic_table' as const : 'activity' as const, proofRefs: [], entityLocalIds: [index ? 'C0' : 'A0'], disposition: 'structured' as const, reason: '보존된 seed의 동일 원문 사실에 연결했다.' }] })) };
}

test('deep transport preserves old literal provenance and fact coordinates through a v2 round trip', () => {
  const { source, common } = fixture(), seed = encodePreservedAnalysis(common, source);
  const anchor = seed.activities[0].factProofRefs.recordedContext[0];
  const wire = { schemaVersion: 'student-analysis-wire-v2', codecVersion: STUDENT_ANALYSIS_CODEC_VERSION, ...seed, trajectories: [], sourceDispositions: [{ sourceKey: 'B1', status: 'analyzed', reason: '실제 탐구 내용을 읽어 구조화했다.' }, { sourceKey: 'B2', status: 'analyzed', reason: '실제 성적 행과 열을 확인했다.' }], activityPriorities: [], objectives: Array.from({ length: 8 }, (_, i) => ({ originKind: 'activity', entityLocalIds: ['A0'], primaryFunction: 'PROCESS', depth: 'D2', target: `실제 전도도 탐구 과정의 구체 확인 목적 ${i}`, requiredMeaning: '실제 기록된 수행 과정을 설명한다.', reason: '해당 탐구에서 실제로 수행한 의미를 확인한다.', semanticKey: `synthetic-purpose-${i}`, anchorProofRef: anchor, unknowns: [], forbiddenPremises: [], openCheck: false })) };
  const { seedActivityIds: ignoredA, seedAcademicIds: ignoredC, sourceReviews: ignoredS,preservedTrajectories:ignoredT, ...body } = wire; void ignoredA; void ignoredC; void ignoredS;void ignoredT;
  const decoded = decodeStudentAnalysisV2(source, body);
  assert.deepEqual(decoded.academicDetails.get('C0')?.literalValues, common.academicRecords[0].literalValues);
  assert.equal(decoded.wire.activities[0].studentActions[0].quote, common.activities[0].facts.studentActions[0].quote);
});

test('deep batch rejects an invented unused quote and dictionary/source ownership violations', () => {
  const { source } = fixture();
  const batch = emptyBatch();
  const invented = { ...batch, quoteDictionary: [{ id: 1, sourceKey: 'B1', quote: '학생이 실제로 하지 않은 분석을 했다.' }] };
  assert.throws(() => verifyDeepBatchQuotes(source, invented, ['B1','B2']), /QUOTE_UNVERIFIED/);
  assert.throws(() => verifyDeepBatchQuotes(source, { ...invented, quoteDictionary: [{ id: 1, sourceKey: 'B2', quote: source.blocks[1].text }] }, ['B1']), /OUTSIDE_SOURCE/);
});

test('all source units must remain bound and unresolved source units cannot become analyzed', () => {
  const { source, common } = fixture(), seed = encodePreservedAnalysis(common, source);
  assert.equal(combineDeepBatches(seed, [{ sourceKeys: ['B1','B2'], namespace: 'N1-', output: emptyBatch() }], source).sourceReviews.length, 2);
  const missing = emptyBatch(); missing.sourceReviews[0].units[0].entityLocalIds = ['invented-entity'];
  assert.throws(() => combineDeepBatches(seed, [{ sourceKeys: ['B1','B2'], namespace: 'N1-', output: missing }], source), /BINDING_INVALID/);
  const unresolved = emptyBatch() as unknown as { sourceReviews: Array<{ units: Array<{ disposition: string }> }> };
  unresolved.sourceReviews[0].units[0].disposition = 'needs_review';
  assert.throws(() => combineDeepBatches(seed, [{ sourceKeys: ['B1','B2'], namespace: 'N1-', output: unresolved }], source), /UNRESOLVED_UNIT_MARKED_ANALYZED/);
});

test('dense academic row keeps a literal namespace separate from proof IDs and shares only row provenance', () => {
  const row = expandDeepAcademicRow({ localId: 'C1', grade: 2, semester: 1, subject: '수학Ⅱ', gradingSystem: 'achievement', proofRefs: [ref(1)], interpretationLimit: '기록된 값만 사용한다.', tableStructure: { status: 'resolved', unresolvedReasons: [] }, interpretations: [], rowIndex: 0, rowLabel: { proofRef: ref(1), binding: 'unique_literal', start: null, end: null, literal: '수학Ⅱ' }, metadataProofRefs: { grade: [ref(1)], semester: [ref(1)], subject: [ref(1)], gradingSystem: [ref(1)] }, cells: [{ kind: 'academic_literal', value: '95', valueSpan: { proofRef: ref(1), binding: 'unique_literal', start: null, end: null, literal: '95' }, columnIndex: 1, columnLabel: { proofRef: ref(1), binding: 'unique_literal', start: null, end: null, literal: '원점수' } }] });
  assert.equal(row.literalValues[0].value, '95'); assert.equal(row.literalValues[0].valueSpan.proofRef.quoteId, 1);
  const invalid = { ...emptyBatch(), academicRecords: [{ ...row, cells: [{ kind: 'academic_literal', value: 'Q30' }] }] };
  assert.equal(studentDeepBatchSchema.safeParse(invalid).success, false);
});

test('synthesis cannot discard or merge away a preserved verified entity', () => {
  const { source, common } = fixture(), seed = encodePreservedAnalysis(common, source), parts = combineDeepBatches(seed, [{ sourceKeys: ['B1','B2'], namespace: 'N1-', output: emptyBatch() }], source);
  const anchor = seed.activities[0].factProofRefs.recordedContext[0];
  const axes = ['interest_start','recurring_topic','deepening','cross_subject','grade_year_change','career_change','inquiry_method','community_behavior','strength_evidence','record_gap','fact_check'];
  const input = { schemaVersion: 'student-source-deep-synthesis-v1', activityGroups: [], academicGroups: [{ canonicalLocalId: 'C0', memberLocalIds: ['C0'], reason: '보존된 실제 성적 행을 유지한다.' }], trajectories: [], activityPriorities: [],
    objectives: Array.from({ length: 8 }, (_, i) => ({ originKind: 'activity', entityLocalIds: ['A0'], primaryFunction: 'ROLE', depth: 'D1', target: `기록된 전도도 탐구의 실제 역할 확인 ${i}`, requiredMeaning: '실제 수행한 내용을 설명한다.', reason: '기록된 개인 수행을 확인할 준비가 필요하다.', semanticKey: `synthetic-purpose-${i}`, anchorProofRef: anchor, unknowns: [], forbiddenPremises: [], openCheck: false })),
    wholeRecordAxes: axes.map(axis => ({ axis, interpretation: '이 합성 사례에 기록된 범위만 해석한다.', basisProofRefs: [anchor], unknowns: [], status: 'source_bound_interpretation_not_causal_fact' })) };
  assert.throws(() => materializeDeepWire(parts, input, source), /ENTITY_GROUP_COVERAGE_OR_PRESERVATION_INVALID/);
});

test('duplicate report output fails before loading context or creating a provider/checkpoint', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deep-analysis-output-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('deep-analysis-output-')); await rm(root, { recursive: true, force: true }); });
  await mkdir(path.join(root,'artifacts')); const file = path.join(root,'artifacts','existing.json'); await writeFile(file,'original report');
  await assert.rejects(prepareStudentDeepAnalysis(['--run-live','--output=artifacts/existing.json'], root), { code: 'EEXIST' });
  assert.equal(await readFile(file,'utf8'),'original report');
});

test('explicit transcription correction binds exact old/new quote hashes, raw reply and original coordinates', () => {
  const {source}=fixture(),batch=emptyBatch(),actual=source.blocks[0].text,before=actual.replace('전도도','전도度');
  const input={...batch,quoteDictionary:[{id:1,sourceKey:'B1',quote:before}]};
  const proof={sourceRefId:source.blocks[0].id,page:1,pageStart:0,pageEnd:actual.length,quote:actual,sourceTextSha256:source.blocks[0].textSha256};
  const review={schemaVersion:'bounded-deep-source-quote-review-v1',phase:'extract-1',sourcePdfSha256:source.pdfSha256,sourceContentSha256:source.contentSha256,responseFileSha256:'b'.repeat(64),corrections:[{quoteId:1,sourceKey:'B1',previousQuote:before,previousQuoteSha256:sha(before),replacementQuote:actual,replacementQuoteSha256:sha(actual),replacementProof:proof}]};
  assert.equal(applyReviewedDeepQuoteCorrections(input,review,source,'b'.repeat(64),'extract-1').quoteDictionary[0].quote,actual);
  assert.equal(input.quoteDictionary[0].quote,before,'provider text is preserved');
  assert.throws(()=>applyReviewedDeepQuoteCorrections(input,review,source,'c'.repeat(64),'extract-1'),/CONTEXT_MISMATCH/);
  const shifted=structuredClone(review);shifted.corrections[0].replacementProof.pageEnd--;
  assert.throws(()=>applyReviewedDeepQuoteCorrections(input,shifted,source,'b'.repeat(64),'extract-1'),/RANGE_MISMATCH/);
});

test('source table catalog keeps reviewed seed literals and rejects a changed existing scalar',()=>{
  const{source,common}=fixture(),seed=encodePreservedAnalysis(common,source),parentSha='d'.repeat(64);
  const catalog={schemaVersion:'reviewed-complete-academic-catalog-v1',status:'requires_independent_review',sourcePdfSha256:source.pdfSha256,sourceContentSha256:source.contentSha256,parentCommonContentSha256:parentSha,quoteDictionary:seed.quoteDictionary,academicRecords:seed.academicRecords,catalog:[{localId:'C0',rowProof:common.academicRecords[0].proofs[0]}]};
  const joined=mergeSourceReviewedAcademicCatalog(seed,catalog,source,parentSha);
  assert.equal(joined.verifiedCatalogRows,1);assert.equal(joined.parts.academicRecords[0].literalValues[0].value,'95');
  const changed=structuredClone(catalog);changed.academicRecords[0].literalValues[0].value='Q30';
  assert.throws(()=>mergeSourceReviewedAcademicCatalog(seed,changed,source,parentSha),/CHANGED_PRESERVED_ROW/);
  assert.throws(()=>mergeSourceReviewedAcademicCatalog(seed,catalog,source,'e'.repeat(64)),/CONTEXT_MISMATCH/);
});

test('full-record transport retains 161 separate real experiences instead of forcing unrelated merges',()=>{
  const {source,common}=fixture(),seed=encodePreservedAnalysis(common,source);
  const rows=Array.from({length:161},(_,i)=>({...seed.activities[0],localId:`A${i}`}));
  assert.equal(studentAnalysisCodecV2Schema.shape.activities.parse(rows).length,161);
  assert.throws(()=>studentAnalysisCodecV2Schema.shape.activities.parse(Array.from({length:201},(_,i)=>({...rows[0],localId:`A${i}`}))));
});
