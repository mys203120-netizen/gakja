/** Bounded source review, not a reusable semantic table parser. The explicit row
 * specifications below were visually checked against PDF pages 9/14/20/21 and
 * the grade continuation labels on pages 13/19. No provider is called. */
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadInterviewContextAt } from '../server/data/load-interview-context';
import { loadFullRecord, loadStagedFullStudentAnalysis, materializeFullStudentAnalysis, saveFullStudentAnalysis, studentAnalysisCodecV2Schema, type StudentAnalysisCodecV2, type AnalysisSourceReview } from '../server/data/full-student-analysis';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const root = process.cwd(), summary = JSON.parse(await readFile(path.join(root, 'artifacts/phase4-student-analysis-v2-run.json'), 'utf8'));
const context = await loadInterviewContextAt(root), source = await loadFullRecord(root, context.student.pdfSha256);
if (!source) throw new Error('ANALYSIS_FULL_SOURCE_MISSING');
const parent = await loadStagedFullStudentAnalysis(context, summary.revisionPath, root);
const proposalDirectory = path.join(root, 'data/prepared/student-analysis-proposals');
const proposals = await Promise.all((await readdir(proposalDirectory)).map(async name => ({ name, bytes: await readFile(path.join(proposalDirectory, name)) })));
const original = proposals.map(row => ({ ...row, body: JSON.parse(row.bytes.toString('utf8')) })).find(row => row.body.codecVersion === 'student-analysis-codec-v2' && row.body.model === parent.common.model && row.body.generatedAt === parent.common.generatedAt);
if (!original) throw new Error('SOURCE_REVIEW_PARENT_PROPOSAL_MISSING');
const wire = studentAnalysisCodecV2Schema.parse(structuredClone(original.body.output));
const ref = (quoteId: number) => ({ kind: 'proof_ref' as const, quoteId });
let nextId = Math.max(...wire.quoteDictionary.map(row => row.id)) + 1;
const quote = (page: number, text: string) => {
  const matches = source.blocks.flatMap((block, index) => block.page === page && block.text.includes(text) ? [{ block, index }] : []);
  if (matches.length !== 1 || matches[0].block.text.indexOf(text) !== matches[0].block.text.lastIndexOf(text)) throw new Error('SOURCE_REVIEW_EXPLICIT_SPAN_NOT_UNIQUE');
  const sourceKey = `B${matches[0].index + 1}`, existing = wire.quoteDictionary.find(row => row.sourceKey === sourceKey && row.quote === text);
  if (existing) return ref(existing.id);
  const id = nextId++; wire.quoteDictionary.push({ id, sourceKey, quote: text }); return ref(id);
};
const span = (proofRef: ReturnType<typeof ref>, literal: string, start?: number) => {
  const text = wire.quoteDictionary.find(row => row.id === proofRef.quoteId)!.quote;
  const begin = start ?? text.indexOf(literal);
  if (begin < 0 || text.slice(begin, begin + literal.length) !== literal || start === undefined && text.indexOf(literal, begin + 1) >= 0) throw new Error('SOURCE_REVIEW_LITERAL_NOT_UNIQUE');
  return { proofRef, binding: 'offsets' as const, start: begin, end: begin + literal.length, literal };
};
const ordinaryHeader = '학기 교과 과목 학점수 원점수/과목평균\n(표준편차)\n성취도\n(수강자수) 석차등급 비고';
const careerHeader = '학기 교과 과목 학점수 원점수/과목평균 성취도\n(수강자수)\n성취도별\n분포비율 비고';
const grades = { 1: quote(9, '[1학년]'), 2: quote(13, '[2학년]'), 3: quote(19, '[3학년]') };
const semesters = {
  '9:1': quote(9, '1\n국어 국어 4 88/71.2(11.0) A(162) 2'), '9:2': quote(9, '2\n국어 국어 4 94/72.6(12.8) A(161) 2'),
  '14:1': quote(14, '1\n국어 문학 4 85/77.7(12.0) B(154) 4'), '14:2': quote(14, '2\n국어 화법과 작문 4 85/73.0(14.3) B(138) 3'),
  '20:1': quote(20, '1\n수학 기하 3 87/73.4 A(36) A(44.4) B(36.1) C(19.4)'), '21:1': quote(21, '1 과학 화학Ⅱ 3 77/62.3 B(46) A(13.0) B(45.7) C(41.3)'),
};
// Explicit visually reviewed source rows: grade, semester, page, page-table row index,
// subject, complete source row, raw-score cell, achievement cell, rank cell (or null).
const rows = [
  [1,1,9,1,'수학','수학 수학 4 90/66.9(13.3) A(162) 1','90/66.9(13.3)','A(162)','1'],
  [1,2,9,9,'수학','수학 수학 4 85/61.8(18.6) A(161) 3','85/61.8(18.6)','A(161)','3'],
  [1,1,9,5,'통합과학','과학 통합과학 4 92/75.4(13.8) A(162) 3','92/75.4(13.8)','A(162)','3'],
  [1,2,9,13,'통합과학','과학 통합과학 4 94/69.6(15.8) A(161) 2','94/69.6(15.8)','A(161)','2'],
  [2,1,14,1,'수학Ⅰ','수학 수학Ⅰ 3 92/58.8(19.1) A(154) 2','92/58.8(19.1)','A(154)','2'],
  [2,1,14,2,'수학Ⅱ','수학 수학Ⅱ 4 87/58.8(15.6) A(154) 1','87/58.8(15.6)','A(154)','1'],
  [2,2,14,9,'미적분','수학 미적분 3 67/64.6(14.3) B(50) 5','67/64.6(14.3)','B(50)','5'],
  [2,2,14,10,'확률과 통계','수학 확률과 통계 4 79/61.6(18.3) A(150) 3','79/61.6(18.3)','A(150)','3'],
  [2,1,14,4,'화학Ⅰ','과학 화학Ⅰ 4 87/60.8(16.9) A(65) 2','87/60.8(16.9)','A(65)','2'],
  [3,1,20,0,'기하','수학 기하 3 87/73.4 A(36) A(44.4) B(36.1) C(19.4)','87/73.4','A(36)',null],
  [3,1,20,1,'심화 수학Ⅰ','수학 심화 수학Ⅰ 4 79/69.2 B(138) A(18.1) B(68.1) C(13.8)','79/69.2','B(138)',null],
  [3,1,20,2,'심화 수학Ⅱ','수학 심화 수학Ⅱ 2 100/98.4 A(11) A(100.0) B(0.0) C(0.0)','100/98.4','A(11)',null],
  [3,1,21,0,'화학Ⅱ','1 과학 화학Ⅱ 3 77/62.3 B(46) A(13.0) B(45.7) C(41.3)','77/62.3','B(46)',null],
] as const;
const reviewedRows: Array<{ localId: string; page: number; grade: number; semester: number; subject: string; rowProofRef: ReturnType<typeof ref>; cells: unknown[] }> = [];
for (const [index, spec] of rows.entries()) {
  const [grade, semester, page, rowIndex, subject, text, raw, achievement, rank] = spec;
  const localId = `REVIEW-ACA-${index + 1}`, rowRef = quote(page, text), headerRef = quote(page, rank === null ? careerHeader : ordinaryHeader);
  const semesterRef = semesters[`${page}:${semester}` as keyof typeof semesters], gradeRef = grades[grade];
  const subjectStart = text.indexOf(subject, text.indexOf('과학 ') >= 0 ? text.indexOf('과학 ') + 3 : 3);
  const rowLabel = span(rowRef, subject, subjectStart), gradingSystem = rank === null ? 'achievement' as const : 'nine_grade' as const;
  const cell = (value: string, columnIndex: number, columnLabel: string, start?: number) => ({ kind: 'academic_literal' as const, value, valueSpan: span(rowRef, value, start), provenance: { rowIndex, columnIndex, rowLabel, columnLabel: span(headerRef, columnLabel, wire.quoteDictionary.find(row => row.id === headerRef.quoteId)!.quote.indexOf(columnLabel)), grade, semester, subject, gradingSystem, gradeProofRefs: [gradeRef], semesterProofRefs: [semesterRef], subjectProofRefs: [rowRef], gradingSystemProofRefs: [headerRef], structureStatus: 'resolved' as const } });
  const cells = [cell(raw,4,'원점수/과목평균'),cell(achievement,5,'성취도'),...(rank === null ? [] : [cell(rank,6,'석차등급',text.length - rank.length)])];
  wire.academicRecords.push({ localId, grade, semester, subject, gradingSystem, proofRefs: [...new Map([rowRef,headerRef,gradeRef,semesterRef].map(value=>[value.quoteId,value])).values()], literalValues: cells, tableStructure: { status: 'resolved', unresolvedReasons: [] }, interpretations: [], interpretationLimit: 'codex-source-review가 해당 행과 열·학년·학기·산정체계를 PDF에서 직접 대조한 한정 전사다. 다른 과목/산정체계의 수치 비교 및 원인·능력 판단을 하지 않는다.' });
  reviewedRows.push({ localId, page, grade, semester, subject, rowProofRef: rowRef, cells });
}
// Replace an offline extraction-task objective with actual student-facing academic purposes.
wire.objectives = wire.objectives.filter(row => row.originKind !== 'record_gap' || !row.entityLocalIds.some(id => ['R01','R02','R03'].includes(id)));
const objective = (localIds: string[], primaryFunction: StudentAnalysisCodecV2['objectives'][number]['primaryFunction'], target: string, requiredMeaning: string, semanticKey: string, unknowns: string[], forbiddenPremises: string[]) => ({ originKind: 'academic_record' as const, entityLocalIds: localIds, primaryFunction, depth: 'D2' as const, target, requiredMeaning, reason: '직접 대조한 교과 성적 행에서 학업 준비의 실제 과정 한 가지를 확인한다.', semanticKey, anchorProofRef: reviewedRows.find(row=>row.localId===localIds[0])!.rowProofRef, unknowns, forbiddenPremises, openCheck: true });
wire.objectives.push(
  objective(['REVIEW-ACA-1','REVIEW-ACA-2'],'PROCESS','1학년 수학 두 학기의 학습 과정과 학습 방식 변화 여부','같은 과목의 학기별 기록과 당시 실제 학습 방식을 구분해 설명한다.','review-math-first-year-learning-process',['학기별 학습 방식의 변화 여부와 이유'],['석차등급 변화가 노력 부족이나 능력 저하를 입증함','성적 변화의 원인이 이미 확인됨']),
  objective(['REVIEW-ACA-7'],'PROCESS','2학년 2학기 미적분을 공부한 과정에서 조정한 학습 방법이 있었는지','기록된 미적분 수강을 출발점으로 조정 경험의 존재와 실제 방법을 확인한다.','review-calculus-learning-adjustment',['어려움이나 보완 경험의 존재 여부'],['미적분에서 어려움을 겪었다고 단정함','석차등급 5가 학업 능력을 확정함']),
  objective(['REVIEW-ACA-8','A09'],'CONNECTION','확률과 통계 수업에서 배운 내용과 실제 설문 분석의 연결','교과 학습에서 설문 분석에 활용한 내용 한 가지를 확인한다.','review-statistics-course-to-survey',['성적과 활동 사이의 인과 관계','실제 활용한 개념'],['성적이 설문 분석 능력을 입증함']),
  objective(['REVIEW-ACA-9','REVIEW-ACA-13'],'PROCESS','화학Ⅰ과 화학Ⅱ를 학습할 때 달리 접근한 내용이나 방법이 있었는지','서로 다른 과목과 산정체계를 섞어 성적 증감을 단정하지 않고 실제 학습 차이를 확인한다.','review-chemistry-course-learning-differences',['학습 접근의 차이 여부','과목 개설과 수강 결정 과정'],['화학Ⅰ 석차등급과 화학Ⅱ 성취도를 같은 척도로 비교함','성취도 차이의 원인이 확인됨']),
  objective(['REVIEW-ACA-10','REVIEW-ACA-11','REVIEW-ACA-12'],'CHOICE','기하와 심화 수학 과목을 배우며 관심을 둔 학습 내용','수강 기록을 출발점으로 관심 내용과 과목 선택에 관여한 경험이 있는지 확인한다.','review-advanced-math-course-interest',['학생에게 과목 선택권이 있었는지','선택 이유'],['학생이 모든 과목을 자유롭게 선택함','서로 다른 과목의 원점수가 직접 비교 가능함']),
);
const reviewedAt = new Date().toISOString(), originalProposalPath = path.relative(root,path.join(proposalDirectory,original.name));
const artifactPath = `artifacts/phase4-academic-source-review-${Date.now()}.json`;
const report = { schemaVersion:'bounded-academic-source-review-v1', reviewer:'codex-source-review', reviewedAt, sourcePdfSha256:source.pdfSha256, sourceContentSha256:source.contentSha256, parentProposalPath:originalProposalPath,parentProposalSha256:sha(original.bytes),parentAnalysisRevision:parent.common.revision, visuallyReviewedPages:[9,13,14,19,20,21], reviewedRows, retainedUnresolvedAcademicRecordIds:['R01','R02','R03'], noScientificTruthReview:true, noCauseInference:true, rowIndexConvention:'zero-based visible row order in the page table; continuation page starts at zero', scope:'Only the 13 explicitly specified math/general-science/chemistry rows. Other grade cells remain unreviewed.', tableExtractionFinding:'Original text rows and PDF item geometry were preserved. The Terra proposal retained only three headers and did not resolve cells. Projection supplied block text but not item geometry.', objectiveAnchorWarnings:[{objectiveId:'OBJ-4fc9b9281a186f904d6d0bb6',reason:'Liposome topic is not named by the chosen acid/base-forum anchor; independent bank review/quarantine required.'},{objectiveId:'OBJ-fbbcc888790aa529d3f13f3d',reason:'Ionic-liquid wording occurs in the surrounding raw block, not the selected anchor; independent bank review/quarantine required.'}], removedOfflineDiagnosticObjective:'OBJ-c6f82ed688b4d553274be0e0', pointerActivation:false };
const reportBytes=JSON.stringify(report,null,2);await writeFile(path.join(root,artifactPath),reportBytes,{flag:'wx',mode:0o600});
const sourceReview:AnalysisSourceReview={version:'bounded-academic-source-review-v1',reviewer:'codex-source-review',parentProposalPath:originalProposalPath,parentProposalSha256:sha(original.bytes),parentAnalysisRevision:parent.common.revision,artifactPath,artifactSha256:sha(reportBytes),reviewedAt,scope:'explicit_visually_reviewed_academic_rows_only'};
const value=materializeFullStudentAnalysis(context,source,wire,{model:'codex-source-review',generatedAt:reviewedAt,sourceReview});
const proposalPath=`data/prepared/student-analysis-proposals/source-reviewed-${value.common.revision}.json`;
await writeFile(path.join(root,proposalPath),JSON.stringify({schemaVersion:'source-reviewed-full-analysis-proposal-v2',codecVersion:'student-analysis-codec-v2',sourceReview,sourceContentSha256:source.contentSha256,model:'codex-source-review',generatedAt:reviewedAt,output:wire},null,2),{flag:'wx',mode:0o600});
const staged=await saveFullStudentAnalysis(value,source,root);
console.log(JSON.stringify({passed:true,providerCalls:0,staged:true,activated:false,revisionPath:staged.revisionPath,manifestPath:staged.manifestPath,proposalPath,reviewArtifactPath:artifactPath,analysisRevision:value.common.revision,reviewedAcademicRows:rows.length,reviewedAcademicLiterals:value.common.academicRecords.reduce((n,row)=>n+(row.literalValues?.length??0),0),retainedUnresolvedAcademicRecords:3,objectives:value.target.objectives.length,sourceReview},null,2));

