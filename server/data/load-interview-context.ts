import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { interviewConfig } from "../../interview.config";
import { emptySchoolContext, selectSchoolContext, type InterviewOverview, type SchoolContext } from "./school-context";
import { verifyStudentSourceText } from './verify-student-source';
import { loadBookQuestionReferences, type BookQuestionCorpus } from './book-question-reference';
import { loadQuestionStrategyCatalog, type QuestionStrategyCatalog } from './question-strategy-catalog';
import { compileInterviewerPolicy, type InterviewerPolicyPack } from '../policy/interviewer-policy';
import { loadPreparedActivities, projectPreparedActivities, type PreparedActivities } from './prepared-activities';
import { buildStudentTrajectory, createStudentObjectiveCandidates, type StudentObjectiveCandidate, type StudentTrajectoryLink } from '../question-objective';
import { FULL_ANALYSIS_CURRENT, loadFullStudentAnalysis, type FullStudentAnalysis, type TargetStudentAnalysis } from './full-student-analysis';
import { captureFullMdPolicyOriginals, fullMdPolicyDiagnostics, type FullMdPolicyOriginals } from '../policy/full-md-policy';
import type { ApprovedKnowledgeBundle } from './approved-knowledge';
export { normalizeTrack } from "./school-context";

export interface StudentEvidence {
  id: string;
  activityId: string;
  page: number;
  grade: number;
  section: string;
  title: string;
  text: string;
  sourceRef: { file: string; pdfSha256: string; page: number; extraction: string; startOffset: number; endOffset: number; sourceRefId?: string; recordRevision?: string; extractionRevision?: string };
  sourceKind?: 'activity' | 'academic_record' | 'trajectory' | 'record_gap';
  originEntityId?: string;
  projectionProvenance?: { kind: 'legacy_verified_range_same_declared_activity_id'; legacyEvidenceId: string; analysisRevision: string };
  confirmationStatus: "confirmed_from_record";
  preparationPriority: null;
  scientificTruthVerification: "not_independently_verified";
}
interface StudentContext {
  studentName: string;
  studentId?: string;
  recordRevision?: string;
  analysisRevision?: string;
  sourceFile?: string;
  evidence: StudentEvidence[];
  pageCount: number | null;
  extractionStatus: string;
  pdfSha256?: string;
  schemaVersion?: string;
  limitations: string[];
}
export interface InterviewContext {
  manifest: {
    schemaVersion: string;
    academicYear: number;
    target: typeof interviewConfig.target;
    files: Array<{ role: string; path: string; sha256: string | null }>;
    recordIds: Record<string, string | string[] | null>;
    evidenceIds: string[];
    interviewOverview: InterviewOverview | null;
    selectionNotes: string[];
    rulesVersion: string;
    guidelineSourceVersions: typeof interviewConfig.guidelineSourceVersions;
    sourceIntegrity: { pdfHashVerified: boolean; evidenceReferencesVerified: boolean; evidenceTextVerified: boolean; evidenceCount: number; fullDocumentExtracted?: boolean; sourceBlocksAccountedFor?: boolean; independentSemanticReview?: false };
    questionReferenceCatalog?: { schemaVersion: string; policyVersion: string; digest: string; sourceHashes: BookQuestionCorpus['sourceHashes']; figuresDirectory: string; eligibleQuestions: number; excludedQuestions: number; runtimeApprovedQuestions: number; analysis?: BookQuestionCorpus['analysis']; purpose: 'wording_reference_only' } | null;
    interviewerPolicy?: { version: string; contentSha256: string; sourceFiles: InterviewerPolicyPack['sourceFiles'] } | null;
    fullMdPolicyOriginals?: ReturnType<typeof fullMdPolicyDiagnostics>;
    questionStrategyCatalog?: { version: string; key: string; contentSha256: string; coverage: QuestionStrategyCatalog['coverage'] } | null;
    errors: string[];
  };
  target: typeof interviewConfig.target;
  student: StudentContext;
  school: SchoolContext;
  interviewOverview: InterviewOverview | null;
  questionGuidelines: string;
  evaluationGuidelines: string;
  operatingGuidelines?: string;
  /** Verified reference questions only. Never substitute these for the student's evidence. */
  questionReferences?: BookQuestionCorpus | null;
  questionStrategies?: QuestionStrategyCatalog | null;
  interviewerPolicy?: InterviewerPolicyPack | null;
  /** Exact MD 1~12 originals pinned with this context; never replaced from live files mid-session. */
  fullMdPolicyOriginals?: FullMdPolicyOriginals;
  preparedActivities?: PreparedActivities | null;
  studentObjectives?: StudentObjectiveCandidate[];
  studentTrajectory?: StudentTrajectoryLink[];
  studentAnalysis?: FullStudentAnalysis;
  targetAnalysis?: TargetStudentAnalysis;
  /** Optional ended-session evaluation approval. Never student-record truth or
   * realtime question-generation authority; saved in its own context snapshot. */
  approvedKnowledge?: ApprovedKnowledgeBundle;
  errors: string[];
}
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
let cachedContext: Promise<InterviewContext> | null = null;

export async function loadInterviewContextAt(root: string, options: { writeManifest?: boolean } = {}): Promise<InterviewContext> {
  const errors: string[] = [];
  const entries = Object.entries(interviewConfig.files).filter(([role]) => role !== "sourceManifest");
  const inputs = await Promise.all(entries.map(async ([role, path]) => {
    try { const bytes = await readFile(resolve(root, path)); return { role, path, bytes, sha256: digest(bytes) }; }
    catch { errors.push(`필수 자료 없음: ${path}${role === "preparedStudent" ? " (npm run prepare:context 실행 필요)" : ""}`); return { role, path, bytes: null, sha256: null }; }
  }));
  const text = (role: string) => inputs.find(entry => entry.role === role)?.bytes?.toString("utf8") ?? "";
  for (const [role, version] of Object.entries(interviewConfig.guidelineSourceVersions)) {
    const header = text(role).split(/\r?\n/u).slice(0, 12).join('\n');
    if (!header.trim()) errors.push(`가이드 정본이 비어 있습니다: ${role}`);
    else if (header.split('\n')[0].trim() !== `# ${interviewConfig.guidelineSourceTitles[role as keyof typeof interviewConfig.guidelineSourceTitles]} v${version}`) errors.push(`가이드 정본 버전 불일치: ${role} (기대 ${version}, 문서 역할 포함)`);
  }
  function sourceJson(role: string): unknown {
    try { return JSON.parse(text(role)); }
    catch { errors.push(`대학 자료 JSON을 해석할 수 없습니다: ${inputs.find(entry => entry.role === role)?.path ?? role}`); return null; }
  }
  let school = emptySchoolContext(interviewConfig.target);
  try { school = selectSchoolContext({ universities: sourceJson("universitiesJson"), departments: sourceJson("departmentsJson"), admissionTracks: sourceJson("admissionTracksJson"), target: interviewConfig.target }); }
  catch (error) { errors.push(error instanceof Error ? error.message : "지원 대학·학과·전형 자료를 확인할 수 없습니다."); }
  let student: StudentContext = { studentName: interviewConfig.target.studentName, evidence: [], pageCount: null, extractionStatus: "not_prepared", limitations: [] };
  let pdfHashVerified = false, evidenceReferencesVerified = false, evidenceTextVerified = false;
  try {
    if (text("preparedStudent")) {
      student = JSON.parse(text("preparedStudent")) as StudentContext;
      if (student.studentName !== interviewConfig.target.studentName || student.schemaVersion !== "verified-pdf-excerpts-v2") errors.push("학생부 캐시의 학생 또는 준비 스키마가 일치하지 않습니다.");
      const expectedPdfHash = inputs.find(entry => entry.role === "studentPdf")?.sha256;
      pdfHashVerified = Boolean(expectedPdfHash && student.pdfSha256 === expectedPdfHash);
      if (!pdfHashVerified) errors.push("학생부 PDF가 변경되었습니다. npm run prepare:context로 근거를 다시 준비하세요.");
      if (!Array.isArray(student.evidence) || !student.evidence.length || student.evidence.some(entry => !entry.id || typeof entry.text !== 'string' || !entry.text.trim() || !Number.isInteger(entry.page))) errors.push("학생부 원문 근거가 비어 있거나 유효하지 않습니다.");
      evidenceReferencesVerified = pdfHashVerified && student.sourceFile === interviewConfig.files.studentPdf && Array.isArray(student.evidence) && student.evidence.length > 0 && new Set(student.evidence.map(entry => entry.id)).size === student.evidence.length && student.evidence.every(entry => {
        const source = entry.sourceRef;
        return source?.file === interviewConfig.files.studentPdf && source.pdfSha256 === expectedPdfHash && source.page === entry.page && Number.isInteger(source.page) && source.page > 0 && Number.isInteger(student.pageCount) && source.page <= student.pageCount! && Number.isInteger(source.startOffset) && source.startOffset >= 0 && Number.isInteger(source.endOffset) && source.endOffset > source.startOffset;
      });
      if (!evidenceReferencesVerified) errors.push("학생부 근거의 파일·해시·페이지·원문 범위를 확인할 수 없습니다. npm run prepare:context로 다시 준비하세요.");
      if (evidenceReferencesVerified) evidenceTextVerified = await verifyStudentSourceText(inputs.find(entry => entry.role === 'studentPdf')!.bytes!, student.evidence, student.pageCount!);
      if (evidenceReferencesVerified && !evidenceTextVerified) errors.push('학생부 캐시의 발췌문이 PDF 원문 구간과 일치하지 않습니다. npm run prepare:context로 다시 준비하세요.');
    }
  } catch { errors.push("학생부 추출 캐시가 손상되었습니다. npm run prepare:context로 다시 준비하세요."); }
  if (interviewConfig.maxFollowUps < 0 || interviewConfig.maxFollowUps > 2) errors.push("꼬리질문 상한은 0~2 범위여야 합니다.");
  const questionReferences = await loadBookQuestionReferences(root).catch(() => null);
  const questionStrategies = questionReferences ? await loadQuestionStrategyCatalog(questionReferences, { root }).catch(() => null) : null;
  let interviewerPolicy: InterviewerPolicyPack | null = null;
  try { interviewerPolicy = await compileInterviewerPolicy(root); }
  catch (error) { errors.push(error instanceof Error ? error.message : '면접 운영 규칙의 정본을 확인하지 못했습니다.'); }
  let fullMdPolicyOriginals: FullMdPolicyOriginals | undefined;
  if (interviewerPolicy) {
    try { fullMdPolicyOriginals = captureFullMdPolicyOriginals(inputs, interviewerPolicy); }
    catch (error) { errors.push(error instanceof Error ? error.message : 'FULL_MD_POLICY_SOURCE_INVALID'); }
  }
  const manifest: InterviewContext["manifest"] = {
    schemaVersion: "local-interview-source-manifest-v3", academicYear: interviewConfig.target.year, target: interviewConfig.target,
    files: inputs.map(({ role, path, sha256 }) => ({ role, path, sha256 })),
    recordIds: {
      schoolReferenceId: school.schoolReferenceId,
      departmentId: school.department?.id ?? null,
      admissionTrackId: school.interview?.id ?? null,
      departmentProfileId: school.departmentProfile?.source_profile_id ?? null,
      universityProfileId: school.universityProfile?.source_profile_id ?? null,
      catalogDepartmentIds: school.department?.catalog_department_ids ?? [],
      sourceProfileIds: school.interview?.source_profile_ids ?? [],
      sourceIds: school.sources.map(source => source.id),
      interviewTrack: school.interview?.track_name ?? null,
    },
    evidenceIds: Array.isArray(student.evidence) ? student.evidence.map(entry => entry.id) : [],
    interviewOverview: school.interviewOverview,
    selectionNotes: [
      "루트 universities.json·departments.json·admission_tracks.json을 ID로 연결; 이전 snapshot을 실행 자료로 사용하지 않음",
      "학년도는 대상의 2027학년도와 정확히 대조; 실행 연도로 치환하지 않음",
      "전형명 검색에만 NFKC·공백 제거 적용; 학생부종합Ⅱ 등 다른 전형 불포함",
      "학과명·본교·전형 record_type·학년도·대학/학과 ID를 모두 대조",
      "면접 시간·위원 수·면접 내부 평가 비중은 해당 전형의 official_2027 필드와 원천 출처로 검증",
      "면접 내부 35/40/25 비중과 전형 전체의 면접 50%를 분리; 인재상과도 구분",
      "공식 PDF p.25·46을 직접 대조한 제출서류 기반 개별·블라인드 면접 방식은 별도 검수 근거로 표시",
      "모집단위 면접 일정과 개인 고사시각을 구분; 개인별 고사시각은 미확정",
    ],
    rulesVersion: interviewConfig.rulesVersion, guidelineSourceVersions: interviewConfig.guidelineSourceVersions,
    sourceIntegrity: { pdfHashVerified, evidenceReferencesVerified, evidenceTextVerified, evidenceCount: Array.isArray(student.evidence) ? student.evidence.length : 0 }, errors,
    questionReferenceCatalog: questionReferences ? { schemaVersion: questionReferences.schemaVersion, policyVersion: questionReferences.policyVersion, digest: questionReferences.digest, sourceHashes: questionReferences.sourceHashes, figuresDirectory: questionReferences.figuresDirectory, eligibleQuestions: questionReferences.counts.eligibleQuestions, excludedQuestions: questionReferences.counts.excludedQuestions, runtimeApprovedQuestions: questionReferences.counts.runtimeApprovedQuestions, analysis: questionReferences.analysis, purpose: 'wording_reference_only' } : null,
    interviewerPolicy: interviewerPolicy ? { version: interviewerPolicy.version, contentSha256: interviewerPolicy.contentSha256, sourceFiles: interviewerPolicy.sourceFiles } : null,
    ...(fullMdPolicyOriginals ? { fullMdPolicyOriginals: fullMdPolicyDiagnostics(fullMdPolicyOriginals) } : {}),
    questionStrategyCatalog: questionStrategies ? { version: questionStrategies.schemaVersion, key: questionStrategies.key, contentSha256: questionStrategies.contentSha256, coverage: questionStrategies.coverage } : null,
  };
  const context: InterviewContext = { manifest, target: interviewConfig.target, student, school, interviewOverview: school.interviewOverview, operatingGuidelines: text('operatingGuidelines'), questionGuidelines: text("questionGuidelines"), evaluationGuidelines: text("evaluationGuidelines"), questionReferences, questionStrategies, interviewerPolicy, fullMdPolicyOriginals, errors };
  try {
    const full = await loadFullStudentAnalysis(context, root);
    if (full) {
      // Historical excerpts remain on disk. New sessions consume the new, immutable analysis.
      context.studentAnalysis = full.common; context.targetAnalysis = full.target;
      const supplement = student.evidence.flatMap(legacy => {
        const activity = full.common.activities.find(activity => activity.id === legacy.activityId && activity.mergedFromLegacyIds.includes(legacy.activityId));
        const declaredProofs = activity ? Object.values(activity.facts).flat() : [];
        // Explicit same legacy activity ID and contained, exact source ranges are required.
        // A shared keyword/topic is never sufficient to widen a question's evidence.
        if (!activity || !declaredProofs.length || !declaredProofs.every(proof => proof.page === legacy.page && proof.pageStart >= legacy.sourceRef.startOffset && proof.pageEnd <= legacy.sourceRef.endOffset && legacy.text.slice(proof.pageStart - legacy.sourceRef.startOffset, proof.pageEnd - legacy.sourceRef.startOffset) === proof.quote) || legacy.sourceRef.pdfSha256 !== student.pdfSha256 || legacy.text.length > 2200) return [];
        return [{ ...structuredClone(legacy), sourceKind: 'activity' as const, originEntityId: activity.id, projectionProvenance: { kind: 'legacy_verified_range_same_declared_activity_id' as const, legacyEvidenceId: legacy.id, analysisRevision: full.common.revision }, sourceRef: { ...legacy.sourceRef, sourceRefId: legacy.id, recordRevision: full.common.recordRevision } }];
      });
      const runtimeEvidence = [...full.evidence, ...supplement.filter(source => !full.evidence.some(evidence => evidence.id === source.id))];
      context.student = { ...student, studentId: full.common.studentId, recordRevision: full.common.recordRevision, analysisRevision: full.common.revision, evidence: runtimeEvidence, schemaVersion: 'full-record-analysis-evidence-v1', extractionStatus: full.common.coverage.needsReviewSourceCount ? 'full_document_extracted_partially_structured' : 'full_document_source_bound_structure', limitations: [...full.common.limitations] };
      const pdf = inputs.find(entry => entry.role === 'studentPdf')?.bytes;
      if (!pdf || !await verifyStudentSourceText(pdf, runtimeEvidence, student.pageCount!)) throw new Error('FULL_ANALYSIS_PDF_TEXT_MISMATCH');
      // A reviewed target contract can publish a derived envelope under the same
      // immutable common-analysis revision. Pin the exact approved pointer target.
      const analysisPointer = JSON.parse(await readFile(resolve(root, FULL_ANALYSIS_CURRENT), 'utf8')) as { path: string; revision: string };
      const analysisFile = analysisPointer.path.replace(/\\/gu, '/');
      const analysisPath = resolve(root, analysisFile), analysisBase = resolve(root, 'data/prepared/student-analysis-revisions');
      const analysisRelative = relative(analysisBase, analysisPath);
      if (analysisRelative.startsWith('..') || isAbsolute(analysisRelative) || analysisPointer.revision !== full.common.revision) throw new Error('FULL_ANALYSIS_MANIFEST_PATH_INVALID');
      const analysisBytes = await readFile(analysisPath);
      const analysisEnvelope = JSON.parse(analysisBytes.toString('utf8')) as { common: FullStudentAnalysis; target: TargetStudentAnalysis; evidence: StudentEvidence[] };
      // Fail closed if an atomic pointer update raced the initial verified load.
      if (analysisEnvelope.common.contentSha256 !== full.common.contentSha256 || analysisEnvelope.target.contentSha256 !== full.target.contentSha256 || digest(JSON.stringify(analysisEnvelope.evidence)) !== digest(JSON.stringify(full.evidence))) throw new Error('FULL_ANALYSIS_MANIFEST_REVISION_CHANGED');
      manifest.files.push({ role: 'fullStudentAnalysis', path: analysisFile, sha256: digest(analysisBytes) });
      Object.assign(manifest.recordIds, { studentId: full.common.studentId, recordRevision: full.common.recordRevision, studentAnalysisRevision: full.common.revision, targetAnalysisRevision: full.target.revision, commonAnalysisContentSha256: full.common.contentSha256, targetAnalysisContentSha256: full.target.contentSha256, admissionProfileRevision: full.target.profileRevision });
      manifest.evidenceIds = runtimeEvidence.map(evidence => evidence.id);
      Object.assign(manifest.recordIds, { evidenceProjectionVersion: 'analysis-and-explicit-legacy-range-v1', verifiedLegacySupplementCount: String(supplement.length) });
      Object.assign(manifest.sourceIntegrity, { evidenceCount: runtimeEvidence.length, fullDocumentExtracted: true, sourceBlocksAccountedFor: full.common.coverage.allSourceBlocksAccountedFor, independentSemanticReview: false });
      manifest.selectionNotes.push('전 페이지 원문 revision과 활동·학업 공통 분석 및 지원처별 준비 우선도·구체 목표를 참조; 과거 17개 발췌와 기존 회차는 변경하지 않음', '전 페이지 추출·인용 일치와 독립 의미 검수 완료는 구분; 분석의 누락·제외·미확인 범위 보존');
      manifest.selectionNotes.push(`동일한 명시적 legacy activity ID와 좌표 포함 관계가 모두 검증된 원문 ${supplement.length}개만 보완 근거로 재연결; 의미 추측 병합이나 전체 분석 완료를 뜻하지 않음`);
    }
  } catch (error) { errors.push(error instanceof Error ? error.message : 'FULL_STUDENT_ANALYSIS_INVALID'); }
  context.preparedActivities = context.studentAnalysis ? projectPreparedActivities(context, context.studentAnalysis) : await loadPreparedActivities(context, root);
  context.studentObjectives = createStudentObjectiveCandidates(context, context.preparedActivities);
  context.studentTrajectory = buildStudentTrajectory(context);
  if (options.writeManifest !== false) {
    await mkdir(dirname(resolve(root, interviewConfig.files.sourceManifest)), { recursive: true });
    await writeFile(resolve(root, interviewConfig.files.sourceManifest), JSON.stringify(manifest, null, 2), "utf8");
  }
  return context;
}

/** Server-only memoized sources: no full PDF or full university catalog per question. */
export function loadInterviewContext(): Promise<InterviewContext> { return cachedContext ??= loadInterviewContextAt(process.cwd()); }
