import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { interviewConfig } from "../interview.config";
import { loadInterviewContext } from "../server/data/load-interview-context";
import { selectSchoolContext, sessionDurationSeconds } from "../server/data/school-context";
import { nextPosition, type InterviewSession, type RecordedTurn } from "../server/protocol";

const [universities, departments, admissionTracks] = await Promise.all(["universities.json", "departments.json", "admission_tracks.json"].map(async file => JSON.parse(await readFile(file, "utf8")) as Array<Record<string, unknown>>));
const university = universities.find(row => row.id === "bible_854beb619660d235")!;
const department = departments.find(row => row.id === "dept_7ce7fba69ac8b83c64d4")!;
const track = admissionTracks.find(row => row.id === "track_afc9619a17b66c2765c9")!;
const select = (overrides: Partial<{ universities: unknown; departments: unknown; admissionTracks: unknown }> = {}) => selectSchoolContext({ universities: [university], departments: [department], admissionTracks: [track], target: interviewConfig.target, ...overrides });

test("the three root collections join the exact 2027 university, department and interview track", () => {
  const context = selectSchoolContext({ universities, departments, admissionTracks, target: interviewConfig.target });
  assert.equal(context.schoolReferenceId, university.id);
  assert.equal(context.department?.id, department.id);
  assert.equal(context.interview?.id, track.id);
  assert.equal(context.interview?.academic_year, 2027);
  assert.equal(context.interviewOverview?.durationSeconds, 720);
  assert.deepEqual(context.interviewOverview?.lines, ["제출 서류 기반 개별 면접", "면접위원 2명 · 약 12분", "학업역량 · 잠재역량 · 사회역량 평가"]);
  assert.equal(context.interviewFormat?.verificationStatus, "official_pdf_reviewed");
});
test("within-interview 35/40/25 weights remain separate from the overall selection's 50 percent", () => {
  const context = select();
  assert.equal(context.officialInterviewCriteria?.basis, "within_interview");
  assert.deepEqual(context.officialInterviewCriteria?.elements.map(element => element.percent), [35, 40, 25]);
  assert.equal(context.selectionInterviewWeightPercent, 50);
  assert.ok(context.interviewOverview?.lines.every(line => !line.includes("%")));
});
test("other years, similarly named tracks and different department IDs cannot match the target", () => {
  assert.throws(() => select({ admissionTracks: [{ ...track, academic_year: 2026 }] }), /유일하게/);
  assert.throws(() => select({ admissionTracks: [{ ...track, canonical_track_name: "학생부종합전형Ⅱ(서류형)", track_name: "학생부종합전형Ⅱ(서류형)" }] }), /유일하게/);
  assert.throws(() => select({ admissionTracks: [{ ...track, department_id: "different-department" }] }), /유일하게/);
  assert.throws(() => select({ admissionTracks: [{ ...track, record_type: "university_track" }] }), /유일하게/);
  assert.throws(() => select({ admissionTracks: [track, { ...track, id: "duplicate-target" }] }), /유일하게/);
});
test("a source status or source year mismatch blocks official time and criterion claims", () => {
  const unknown = structuredClone(track) as any;
  unknown.field_status.duration = "not_verified";
  assert.throws(() => select({ admissionTracks: [unknown] }), /공식 duration 근거/);
  const wrongYear = structuredClone(track) as any;
  wrongYear.field_sources.evaluation[0].academic_year = 2026;
  assert.throws(() => select({ admissionTracks: [wrongYear] }), /공식 evaluation 근거/);
  const wrongUniversity = structuredClone(track) as any;
  wrongUniversity.field_sources.panel[0].school_reference_id = "different-university";
  assert.throws(() => select({ admissionTracks: [wrongUniversity] }), /공식 panel 근거/);
});
test("ambiguous durations and invalid evaluation bases cannot silently become this interview's settings", () => {
  const ranged = structuredClone(track) as any;
  ranged.duration.max_minutes = 15;
  assert.throws(() => select({ admissionTracks: [ranged] }), /시간 범위/);
  const wrongBasis = structuredClone(track) as any;
  wrongBasis.evaluation.basis = "selection_total";
  assert.throws(() => select({ admissionTracks: [wrongBasis] }), /필수 면접 정보/);
  const badWeights = structuredClone(track) as any;
  badWeights.evaluation.elements[0].percent = 50;
  assert.throws(() => select({ admissionTracks: [badWeights] }), /100%/);
});
test("new 12-minute sessions continue after ten minutes and stop at their pinned duration", () => {
  const session = {
    id: "test-session", createdAt: "", updatedAt: "", status: "active", evaluationStatus: "pending", target: {}, sourceManifest: {},
    turns: [{ id: "q1", parentMainQuestionId: "q1", mainIndex: 1 } as RecordedTurn], followUpCountByMainQuestion: {}, elapsedMs: 660_000, durationSeconds: 720,
  } satisfies InterviewSession;
  const duration = sessionDurationSeconds(session, 600);
  assert.equal(duration, 720);
  assert.equal(nextPosition(session, "main", 4, 2, duration)?.mainIndex, 2);
  session.elapsedMs = 720_000;
  assert.equal(nextPosition(session, "main", 4, 2, duration), null);
  assert.equal(sessionDurationSeconds(JSON.parse(JSON.stringify(session)), 900), 720);
});
test("a previously started session keeps its own duration when preparation sources change", () => {
  assert.equal(sessionDurationSeconds({ durationSeconds: 600 }, 720), 600);
  assert.equal(sessionDurationSeconds({}, 720), 720);
  assert.throws(() => sessionDurationSeconds({ durationSeconds: 0 }, 720));
  assert.throws(() => sessionDurationSeconds({}, NaN));
});
test("the manifest reads the root files, preserves verified duration, and never uses the old snapshot", async () => {
  const context = await loadInterviewContext();
  assert.deepEqual(context.errors, []);
  const files = context.manifest.files.map(file => file.path);
  for (const file of ["universities.json", "departments.json", "admission_tracks.json"]) assert.ok(files.includes(file));
  assert.ok(files.every(file => !file.includes("university-interviews-talents")));
  assert.equal(context.manifest.interviewOverview?.durationSeconds, 720);
  assert.equal(context.manifest.recordIds.admissionTrackId, track.id);
  assert.equal(context.manifest.sourceIntegrity.evidenceCount, context.student.evidence.length);
  assert.ok(context.student.evidence.length > 0);
  if (context.studentAnalysis) {
    assert.equal(context.student.pageCount, context.studentAnalysis.coverage.extractedPages);
    assert.ok(context.student.evidence.every(source => source.sourceRef.pdfSha256 === context.student.pdfSha256));
    assert.ok(context.studentObjectives?.some(objective => objective.grounding?.kind === 'COMMON_APPROVED'));
  }
});
