import { z } from "zod";

export const normalizeTrack = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "");

const sourceSchema = z.object({
  id: z.string().min(1), title: z.string().min(1), url: z.string().url(),
  kind: z.string().optional(), academic_year: z.number().int().nullable().optional(),
  school_reference_id: z.string().optional(), location: z.string().nullable().optional(),
  checked_at: z.string().optional(), evidence: z.array(z.string()).optional(),
}).passthrough();
const profileSchema = z.object({
  source_profile_id: z.string(), definition_kind: z.string(), points: z.array(z.string()),
  academic_year: z.number().int().nullable(), verification_status: z.string(),
  source: sourceSchema, notes: z.array(z.string()).optional(),
}).passthrough();
const universitySchema = z.object({ id: z.string(), name: z.string(), talent_profile: profileSchema.nullable() });
const departmentSchema = z.object({
  id: z.string(), university_id: z.string(), name: z.string(), campus: z.string(),
  college: z.string().nullable(), field: z.string().nullable(), category: z.string().nullable(),
  catalog_department_ids: z.array(z.string()), identity_status: z.string(),
  talent_status: z.string(), talent_profile: profileSchema.nullable(),
  use_university_shared_profile: z.boolean(),
});
const trackSchema = z.object({
  id: z.string(), university_id: z.string(), department_id: z.string(), record_type: z.literal("department_track"),
  track_name: z.string(), canonical_track_name: z.string(), academic_year: z.number().int(), season: z.string(), campus: z.string(),
  interview_dates: z.array(z.string()), personal_appointment_confirmed: z.boolean(), schedule_status: z.string(),
  duration: z.object({ min_minutes: z.number().positive(), max_minutes: z.number().positive(), qualifier: z.string() }),
  panel: z.object({ count_min: z.number().int().positive(), count_max: z.number().int().positive(), composition: z.string(), qualifier: z.string() }),
  evaluation: z.object({ basis: z.literal("within_interview"), elements: z.array(z.object({ name: z.string(), percent: z.number().min(0).max(100), points: z.number().nullable() })).min(1), total_points: z.number().nullable() }),
  selection_interview_weight_percent: z.number().min(0).max(100).nullable(),
  field_status: z.object({ duration: z.string(), panel: z.string(), evaluation: z.string() }),
  field_sources: z.object({ duration: z.array(sourceSchema).min(1), panel: z.array(sourceSchema).min(1), evaluation: z.array(sourceSchema).min(1) }),
  schedule_sources: z.array(sourceSchema), source_profile_ids: z.array(z.string()), notes: z.array(z.string()),
});

export type SchoolSource = z.infer<typeof sourceSchema>;
export type SchoolProfile = z.infer<typeof profileSchema>;
export type SchoolDepartment = z.infer<typeof departmentSchema>;
export type AdmissionTrack = z.infer<typeof trackSchema>;
export interface SchoolTarget { university: string; department: string; track: string; year: number }
export interface InterviewOverview {
  lines: [string, string, string];
  durationSeconds: number;
  trackId: string;
  source: { id: string; title: string; url: string; academicYear: number; location: string; verificationStatus: string; checkedAt: string | null };
}
export interface SchoolContext {
  academicYear: number;
  schoolReferenceId: string | null;
  university: string;
  department: SchoolDepartment | null;
  interview: AdmissionTrack | null;
  departmentProfile: SchoolProfile | null;
  universityProfile: SchoolProfile | null;
  sources: SchoolSource[];
  officialInterviewCriteria: { basis: "within_interview"; elements: AdmissionTrack["evaluation"]["elements"]; totalPoints: number | null; sourceIds: string[] } | null;
  selectionInterviewWeightPercent: number | null;
  interviewFormat: { kind: "document_based_individual"; blind: boolean; verificationStatus: "official_pdf_reviewed"; sourceId: string; pdfPages: number[] } | null;
  interviewOverview: InterviewOverview | null;
  limitations: string[];
}

// Reviewed directly against the official 2027 PDF, pages 25 and 46, on 2026-11-02.
// The root JSON records duration/panel/weights but has no format field; keep this provenance explicit.
const reviewedFormat = {
  universityId: "bible_854beb619660d235", academicYear: 2027,
  track: "학생부종합전형Ⅰ(면접형)", sourceId: "src_b7c1b8ff9c4752cb",
  url: "https://file.uos.ac.kr/upload/admission/2027%ED%95%99%EB%85%84%EB%8F%84%20%EC%88%98%EC%8B%9C%EB%AA%A8%EC%A7%91%20%EC%8B%A0%EC%9E%85%EC%83%9D%20%EB%AA%A8%EC%A7%91%EC%9A%94%EA%B0%95_260831.pdf",
} as const;

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function collection(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}의 최상위 배열 형식이 올바르지 않습니다.`);
  return value;
}
function unique(values: unknown[], label: string): unknown {
  if (values.length !== 1) throw new Error(`${label} 레코드를 유일하게 확인할 수 없습니다.`);
  return values[0];
}
function parsed<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${label}의 필수 면접 정보 또는 출처 형식이 올바르지 않습니다.`);
  return result.data;
}

/** Select exact related IDs before validating: unrelated universities are never model context. */
export function selectSchoolContext(input: { universities: unknown; departments: unknown; admissionTracks: unknown; target: SchoolTarget }): SchoolContext {
  const { target } = input;
  const university = parsed(universitySchema, unique(collection(input.universities, "universities.json").filter(value => object(value).name === target.university), target.university), "지원 대학");
  const department = parsed(departmentSchema, unique(collection(input.departments, "departments.json").filter(value => object(value).university_id === university.id && object(value).name === target.department && object(value).campus === "본교"), `${target.university} ${target.department}`), "지원 학과");
  const track = parsed(trackSchema, unique(collection(input.admissionTracks, "admission_tracks.json").filter(value => {
    const row = object(value);
    return row.university_id === university.id && row.department_id === department.id && row.record_type === "department_track" && row.academic_year === target.year && row.campus === department.campus && typeof row.canonical_track_name === "string" && normalizeTrack(row.canonical_track_name) === normalizeTrack(target.track);
  }), `${target.year}학년도 ${target.track}`), "지원 전형");
  if (normalizeTrack(track.track_name) !== normalizeTrack(target.track)) throw new Error("전형의 원래 이름과 표준 이름이 대상 전형과 일치하지 않습니다.");
  if (!department.talent_profile || department.talent_profile.academic_year !== target.year || department.talent_profile.verification_status !== "verified_current_official") throw new Error("지원 학과의 해당 학년도 공식 인재상을 확인할 수 없습니다.");
  if (university.talent_profile && university.talent_profile.verification_status !== "verified_current_official") throw new Error("대학 공통 인재상의 검증 상태를 확인해 주세요.");
  for (const field of ["duration", "panel", "evaluation"] as const) {
    if (track.field_status[field] !== `official_${target.year}` || track.field_sources[field].some(source => source.academic_year !== target.year || source.school_reference_id !== university.id)) throw new Error(`해당 학년도 전형의 공식 ${field} 근거를 확인할 수 없습니다.`);
  }
  if (track.duration.min_minutes !== track.duration.max_minutes) throw new Error("면접 시간 범위에 대한 로컬 진행 시간 정책을 먼저 확인해 주세요.");
  if (track.panel.count_min !== track.panel.count_max) throw new Error("면접위원 수 범위에 대한 표시 정책을 먼저 확인해 주세요.");
  if (Math.abs(track.evaluation.elements.reduce((sum, element) => sum + element.percent, 0) - 100) > .001) throw new Error("면접 내부 평가요소 비중의 합계가 100%가 아닙니다.");
  const sources = [...new Map([
    department.talent_profile.source, ...(university.talent_profile ? [university.talent_profile.source] : []),
    ...track.field_sources.duration, ...track.field_sources.panel, ...track.field_sources.evaluation, ...track.schedule_sources,
  ].map(source => [source.id, source])).values()];
  const officialSource = sources.find(source => source.id === reviewedFormat.sourceId && source.url === reviewedFormat.url);
  const formatReviewed = university.id === reviewedFormat.universityId && target.year === reviewedFormat.academicYear && normalizeTrack(track.canonical_track_name) === normalizeTrack(reviewedFormat.track) && Boolean(officialSource);
  if (!formatReviewed || !officialSource) throw new Error("대상 전형의 면접 방식을 확인한 공식 근거가 연결되지 않았습니다.");
  const minutes = track.duration.min_minutes;
  const durationSeconds = minutes * 60;
  if (!Number.isInteger(durationSeconds)) throw new Error("공식 면접 시간을 초 단위로 변환할 수 없습니다.");
  const overview: InterviewOverview = {
    lines: ["제출 서류 기반 개별 면접", `면접위원 ${track.panel.count_min}명 · ${track.duration.qualifier === "about" ? "약 " : ""}${minutes}분`, `${track.evaluation.elements.map(element => element.name).join(" · ")} 평가`],
    durationSeconds, trackId: track.id,
    source: { id: officialSource.id, title: officialSource.title, url: officialSource.url, academicYear: target.year, location: "PDF p.25(인쇄 p.23), p.46(인쇄 p.44)", verificationStatus: `official_${target.year}`, checkedAt: officialSource.checked_at ?? null },
  };
  return {
    academicYear: target.year, schoolReferenceId: university.id, university: university.name, department, interview: track,
    departmentProfile: department.talent_profile, universityProfile: university.talent_profile, sources,
    officialInterviewCriteria: { basis: "within_interview", elements: track.evaluation.elements, totalPoints: track.evaluation.total_points, sourceIds: track.field_sources.evaluation.map(source => source.id) },
    selectionInterviewWeightPercent: track.selection_interview_weight_percent,
    interviewFormat: { kind: "document_based_individual", blind: true, verificationStatus: "official_pdf_reviewed", sourceId: officialSource.id, pdfPages: [25, 46] },
    interviewOverview: overview,
    limitations: ["면접 평가요소 내부 비중과 전형 전체에서 면접이 차지하는 비중은 별도입니다.", "대학의 면접 평가기준은 질문 맥락이며 각자의답 내부 답변 완성도 산식을 대체하지 않습니다.", ...(track.personal_appointment_confirmed ? [] : ["개인별 고사시각·입실시각은 아직 확인되지 않았습니다."])],
  };
}

export function emptySchoolContext(target: SchoolTarget): SchoolContext {
  return { academicYear: target.year, schoolReferenceId: null, university: target.university, department: null, interview: null, departmentProfile: null, universityProfile: null, sources: [], officialInterviewCriteria: null, selectionInterviewWeightPercent: null, interviewFormat: null, interviewOverview: null, limitations: ["대상 대학·학과·학년도·전형의 자료 확인이 필요합니다."] };
}

/** Started sessions retain their own duration even if the current school source changes. */
export function sessionDurationSeconds(session: { durationSeconds?: number }, currentSourceDurationSeconds: number) {
  const duration = session.durationSeconds ?? currentSourceDurationSeconds;
  if (!Number.isInteger(duration) || duration <= 0) throw new Error("면접 진행 시간을 확인할 수 없습니다.");
  return duration;
}
