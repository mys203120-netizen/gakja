import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadInterviewContextAt } from '../server/data/load-interview-context';
import { FULL_ANALYSIS_CURRENT, analysisQAManifest, loadFullRecord, loadFullStudentAnalysis, loadStagedFullStudentAnalysis, stageReviewedObjectiveExtensions, type ReviewedObjectiveExtension } from '../server/data/full-student-analysis';
import { auditStudentSourceText } from '../server/data/verify-student-source';
import { createStudentObjectiveCandidates } from '../server/question-objective';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const span = (proof: { sourceRefId: string; page: number; pageStart: number; pageEnd: number; quote: string }) => ({ sourceRefId: proof.sourceRefId, page: proof.page, start: proof.pageStart, end: proof.pageEnd, textSha256: sha(proof.quote) });

/** Read-only full-PDF comparison. Optional reviewed purposes are staged, never activated. */
export async function auditStudentSourceCli(args: string[], root = process.cwd()) {
  const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const output = option('--output') ?? `artifacts/student-source-qa-${Date.now()}.json`;
  const pointerBytes = await readFile(path.resolve(root, FULL_ANALYSIS_CURRENT));
  const context = await loadInterviewContextAt(root, { writeManifest: false });
  if (context.errors.length) throw new Error('STUDENT_SOURCE_CONTEXT_INVALID');
  const source = await loadFullRecord(root, context.student.pdfSha256);
  const current = option('--analysis') ? await loadStagedFullStudentAnalysis(context, option('--analysis')!, root) : await loadFullStudentAnalysis(context, root);
  if (!source || !current) throw new Error('STUDENT_SOURCE_ANALYSIS_MISSING');
  const pdf = await readFile(path.resolve(root, source.sourceFile));
  if (sha(pdf) !== source.pdfSha256) throw new Error('STUDENT_SOURCE_PDF_CHANGED');
  const pdfText = await auditStudentSourceText(pdf, source.pages.map(page => ({ page: page.page, text: page.text, sourceRef: { startOffset: 0, endOffset: page.text.length } })), source.pageCount);
  if (!pdfText.passed || !pdfText.fullDocumentTextCompared) throw new Error('STUDENT_SOURCE_PDF_TEXT_MISMATCH');
  const qa = analysisQAManifest(current, source, null);
  const projected = createStudentObjectiveCandidates({ ...context, studentAnalysis: current.common, targetAnalysis: current.target, student: { ...context.student, evidence: current.evidence } });
  const activities = current.common.activities.map(activity => ({ activityId: activity.id, localId: activity.localId, title: activity.title, grade: activity.grade, area: activity.area, fields: Object.fromEntries(Object.entries(activity.facts).map(([field, proofs]) => [field, proofs.map(span)])), interpretationCount: activity.interpretations?.length ?? 0, unknownsRetained: activity.unknowns.length }));
  const academicRecords = current.common.academicRecords.map(record => ({ id: record.id, grade: record.grade, semester: record.semester, subject: record.subject, gradingSystem: record.gradingSystem, tableStatus: record.tableStructure?.status, comparisonEligible: record.comparisonEligible, literals: record.literalValues?.map(cell => ({ value: cell.value, proof: span(cell.valueProof), rowIndex: cell.provenance.rowIndex, columnIndex: cell.provenance.columnIndex, rowLabel: cell.provenance.rowLabel ? span(cell.provenance.rowLabel) : null, columnLabel: cell.provenance.columnLabel ? span(cell.provenance.columnLabel) : null })) ?? [] }));
  const objectives = current.target.objectives.map(objective => {
    const bindings = objective.anchorRefs.map(ref => {
      const evidence = current.evidence.find(row => row.id === ref.sourceId);
      const valid = ref.kind === 'RECORD' && !!evidence && objective.evidenceIds.includes(evidence.id) && ref.revision === source.pdfSha256 && Number.isInteger(ref.start) && Number.isInteger(ref.end) && ref.start >= 0 && ref.end > ref.start && ref.end <= evidence.text.length && ref.claimStatus === 'record_fact' && ref.confirmationStatus === 'confirmed_from_record';
      if (!valid) throw new Error('STUDENT_SOURCE_OBJECTIVE_BINDING_INVALID');
      return { evidenceId: evidence!.id, sourceRefId: evidence!.sourceRef.sourceRefId, page: evidence!.page, start: evidence!.sourceRef.startOffset + ref.start, end: evidence!.sourceRef.startOffset + ref.end, textSha256: sha(evidence!.text.slice(ref.start, ref.end)) };
    });
    return { objectiveId: objective.id, originKind: objective.originKind, primaryFunction: objective.primaryFunction, depth: objective.depth, activityIds: objective.activityIds, bindings, requiresOpenCheck: objective.requiresOpenCheck, unknownsRetained: objective.unknowns?.length ?? 0, forbiddenPremisesRetained: objective.forbiddenPremises?.length ?? 0 };
  });
  let staged: { revisionPath: string; manifestPath: string; addedObjectiveIds: string[] } | null = null;
  const reviewFile = option('--reviewed-extension-file');
  if (reviewFile) {
    const reviewBytes = await readFile(path.resolve(root, reviewFile), 'utf8');
    const review = JSON.parse(reviewBytes) as { reviewerId: string; reviewedAt: string; sourcePdfSha256: string; commonContentSha256: string; parentTargetContentSha256: string; extensions: ReviewedObjectiveExtension[] };
    if (review.sourcePdfSha256 !== source.pdfSha256 || review.commonContentSha256 !== current.common.contentSha256 || review.parentTargetContentSha256 !== current.target.contentSha256) throw new Error('STUDENT_SOURCE_REVIEW_STALE');
    const value = await stageReviewedObjectiveExtensions(context, review.extensions, { artifactPath: reviewFile, artifactSha256: sha(reviewBytes), reviewerId: review.reviewerId, reviewedAt: review.reviewedAt }, root, option('--analysis'));
    await loadStagedFullStudentAnalysis(context, value.revisionPath, root);
    staged = { revisionPath: value.revisionPath, manifestPath: value.manifestPath, addedObjectiveIds: value.addedObjectiveIds };
  }
  const pointerUnchanged = sha(await readFile(path.resolve(root, FULL_ANALYSIS_CURRENT))) === sha(pointerBytes);
  if (!pointerUnchanged) throw new Error('STUDENT_SOURCE_ACTIVE_POINTER_CHANGED');
  const runtimeProjection = { objectives: projected.length, sourceBoundObjectives: projected.filter(row => row.originKind !== 'common_approved').length, origins: Object.fromEntries([...new Set(projected.map(row => row.originKind ?? 'unknown'))].map(origin => [origin, projected.filter(row => row.originKind === origin).length])) };
  const report = { version: 'student-source-whole-pdf-qa-v1', generatedAt: new Date().toISOString(), providerCalls: 0, recordFactsModified: false, pointerUnchanged, activated: false, pdf: { file: source.sourceFile, sha256: source.pdfSha256, text: pdfText }, source: { revision: source.revision, contentSha256: source.contentSha256, blockCount: source.blocks.length }, analysis: { commonRevision: current.common.revision, commonContentSha256: current.common.contentSha256, targetRevision: current.target.revision, targetContentSha256: current.target.contentSha256, codecVersion: current.common.codecVersion, qa, coverage: current.common.coverage }, runtimeProjection, activities, academicRecords, trajectories: current.common.trajectories.map(link => ({ id: link.id, fromEntityId: link.fromEntityId, toEntityId: link.toEntityId, relationship: link.relationship, status: link.status, proofs: link.proofs.map(span) })), objectives, staged, limits: ['PDF 원문 일치와 과학 명제의 진실·학생의 실제 기억은 별도 검증 대상이다.', `현재 정본의 needs_review 블록은 ${current.common.coverage.needsReviewSourceCount}개이다. 원문 처리와 모든 셀의 typed 전송·독립 의미 승인 범위는 구분한다.`, `현재 표 구조 resolved 행은 ${academicRecords.filter(row => row.tableStatus === 'resolved').length}개, 미해결 행은 ${qa.unresolvedAcademicRecordIds.length}개이다. 과목·학기·산정체계가 다른 값은 단순 비교하지 않는다.`] };
  await mkdir(path.dirname(path.resolve(root, output)), { recursive: true });
  await writeFile(path.resolve(root, output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { reportPath: output, reportSha256: sha(JSON.stringify(report, null, 2) + '\n'), passed: true, pages: pdfText.checkedPages, activities: activities.length, exactProofs: qa.verifiedProofCount, academicLiterals: qa.academicLiteralCount, resolvedAcademicRows: academicRecords.filter(row => row.tableStatus === 'resolved').length, unresolvedAcademicRows: qa.unresolvedAcademicRecordIds.length, objectiveAnchors: objectives.reduce((sum, row) => sum + row.bindings.length, 0), runtimeProjection, providerCalls: 0, staged, activated: false, pointerUnchanged };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) auditStudentSourceCli(process.argv.slice(2)).then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(JSON.stringify({ passed: false, error: error instanceof Error ? error.message : 'STUDENT_SOURCE_AUDIT_FAILED' })); process.exitCode = 1; });
