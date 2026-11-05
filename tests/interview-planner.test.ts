import test from "node:test";
import assert from "node:assert/strict";
import { createInterviewPlan, currentPlanSlot, nextMainPlanSlot, mainQuestionTargetForDuration, sessionMainQuestionTarget, mayAskFollowUp } from "../server/interview-planner";
import type { InterviewContext, StudentEvidence } from "../server/data/load-interview-context";
import type { InterviewSession, RecordedTurn } from "../server/protocol";

// Explicit synthetic fixtures. No student PDF, media device or provider request is used.
const evidence = [
  ["academic", "교과세특", "용액 실험", "용액 실험의 수행 과정과 사용 개념을 조사했다."],
  ["problem", "자율활동", "자료 불확실성 보완", "자료를 비교하고 불확실성을 보완하는 방법을 선택했다."],
  ["community", "행동특성", "학급 의견 조율", "학급 행사에서 다양한 의견을 듣고 조율하며 협력했다."],
  ["career", "진로활동", "진로 자료 조사", "관심 있는 진로에 관한 자료를 찾아 학습했다."],
  ["limits", "통계 교과세특", "설문 해석", "설문 자료의 유효 응답을 분류하고 해석 한계를 분석했다."],
  ["second-academic", "교과세특", "측정 탐구", "과학 실험에서 측정 과정을 정리했다."],
].map(([id, section, title, text]) => ({ id, activityId: `activity-${id}`, section, title, text, page: 1, grade: 1, confirmationStatus: "confirmed_from_record", preparationPriority: null, scientificTruthVerification: "not_independently_verified", sourceRef: { file: "synthetic.pdf", pdfSha256: "fixture", page: 1, extraction: "fixture", startOffset: 0, endOffset: text.length } } satisfies StudentEvidence));
function context(durationSeconds = 720): InterviewContext {
  const profile = (source: string, points: string[]) => ({ points, source: { id: source }, verification_status: "verified_current_official" });
  return {
    student: { evidence }, interviewOverview: { durationSeconds },
    school: {
      officialInterviewCriteria: { basis: "within_interview", elements: [{ name: "학업역량", percent: 35 }, { name: "잠재역량", percent: 40 }, { name: "사회역량", percent: 25 }], sourceIds: ["test-track-source"] },
      departmentProfile: profile("test-department-source", ["과학·수학 소양", "자율 탐색", "공동체 책임"]),
      universityProfile: profile("test-university-source", ["학업역량", "잠재역량", "사회역량"]),
    },
  } as unknown as InterviewContext;
}
function session(changes: Partial<InterviewSession> = {}): InterviewSession {
  return { turns: [], followUpCountByMainQuestion: {}, elapsedMs: 0, ...changes } as InterviewSession;
}
function turn(mainIndex = 1, mainCount?: number): RecordedTurn {
  return { id: `question-${mainIndex}`, parentMainQuestionId: `root-${mainIndex}`, mainIndex, ...(mainCount ? { mainCount } : {}) } as RecordedTurn;
}

test("new preparation pools are independent of the old duration denominator and do not stop an interview at five roots", () => {
  for (const [seconds, target] of [[600, 4], [720, 5], [900, 6]]) {
    assert.equal(mainQuestionTargetForDuration(seconds), target);
    const plan = createInterviewPlan(context(seconds));
    assert.ok(plan.slots.length > target);
    assert.equal(plan.mainQuestionTarget, plan.slots.length);
    assert.equal(plan.scheduling, 'time_based');
    assert.equal(plan.purpose, 'candidate_pool');
    assert.ok(plan.limitations.some(text => text.includes("공식 문항 수가 아닙니다")));
  }
  for (const value of [0, -1, NaN, Infinity, 0.5]) assert.throws(() => mainQuestionTargetForDuration(value));
});

test("a seeded plan spreads actual evidence, functions and roles instead of forcing A-B order", () => {
  const plan = createInterviewPlan(context(), "round-one");
  assert.deepEqual(plan, createInterviewPlan(context(), "round-one"));
  assert.equal(new Set(plan.slots.flatMap(slot => slot.activityIds)).size, 6);
  assert.equal(new Set(plan.slots.map(slot => slot.topicArea)).size, 5);
  assert.ok(new Set(plan.slots.map(slot => slot.primaryFunction)).size >= 4);
  assert.ok(plan.slots.some(slot => slot.interviewerRole === 'community_talent'));
  assert.ok(plan.slots.some(slot => slot.interviewerRole === 'academic'));
  assert.notDeepEqual(plan.slots, createInterviewPlan(context(), "round-two").slots);
  for (const slot of plan.slots) {
    assert.ok(slot.evidenceIds.every(id => evidence.some(item => item.id === id)));
    assert.ok(slot.activityIds.every(id => evidence.some(item => item.activityId === id)));
    assert.ok(slot.schoolConnections.length > 0);
    assert.ok(slot.schoolConnections.every(connection => connection.sourceIds.every(id => ["test-track-source", "test-department-source", "test-university-source"].includes(id))));
  }
});

test("official evaluation percentages never become question quotas or local score weights", () => {
  const first = context(), second = context();
  second.school.officialInterviewCriteria = structuredClone(first.school.officialInterviewCriteria);
  second.school.officialInterviewCriteria!.elements.forEach((element, index) => { element.percent = [80, 10, 10][index]; });
  assert.deepEqual(createInterviewPlan(first), createInterviewPlan(second));
});

test("missing community evidence is not replaced by an invented activity", () => {
  const input = context(); input.student.evidence = evidence.filter(item => item.id !== "community");
  const plan = createInterviewPlan(input);
  assert.ok(plan.slots.length > 5);
  assert.ok(plan.slots.every(slot => slot.topicArea !== "community_values"));
  assert.ok(plan.slots.flatMap(slot => slot.evidenceIds).every(id => id !== "community"));
  input.student.evidence = [];
  assert.throws(() => createInterviewPlan(input), /검증된 학생부 근거/);
});

test("one actual activity can support distinct sourced objectives while preserving each exact source binding", () => {
  const input = context(600);
  input.student.evidence = [evidence[0], { ...evidence[0], id: "another-reference", section: "진로활동", text: "진로 탐구의 자료와 실험 결과를 비교하며 한계를 분석했다." }];
  const plan = createInterviewPlan(input);
  assert.equal(new Set(plan.slots.map(slot => slot.objective!.id)).size, plan.slots.length);
  assert.ok(plan.slots.every(slot => slot.activityIds[0] === evidence[0].activityId));
  assert.ok(plan.slots.every(slot => slot.evidenceIds.every(id => ['academic', 'another-reference'].includes(id))));
});

test("new session targets stay pinned while legacy sessions retain their recorded denominator", () => {
  const plan = createInterviewPlan(context());
  assert.equal(sessionMainQuestionTarget(session({ mainQuestionTarget: 5, plan, turns: [turn(1, 4)] }), 900), 5);
  assert.equal(sessionMainQuestionTarget(session({ plan }), 600), plan.slots.length);
  assert.equal(sessionMainQuestionTarget(session({ turns: [turn(1, 4)] }), 720), 4);
  assert.equal(sessionMainQuestionTarget(session(), 720), 5);
  assert.equal(sessionMainQuestionTarget(session(), 720, 4), 4);
});

test("follow-up lookup retains its root role while the next main selects the next slot", () => {
  const plan = createInterviewPlan(context());
  const active = session({ plan, turns: [turn(1, 5), { ...turn(1, 5), id: "follow-up", followUpIndex: 1 }] });
  assert.equal(currentPlanSlot(active), plan.slots[0]);
  assert.equal(nextMainPlanSlot(active), plan.slots[1]);
  assert.equal(currentPlanSlot(session({ plan })), null);
  assert.equal(nextMainPlanSlot(session({ plan, turns: [turn(plan.slots.length, plan.slots.length)] })), null);
});

test("follow-up budget reserves unasked mains and preserves the final root cap", () => {
  const active = session({ mainQuestionTarget: 5, turns: [turn()], elapsedMs: 374000 });
  assert.equal(mayAskFollowUp(active, 720, 2), true);
  assert.equal(mayAskFollowUp({ ...active, elapsedMs: 375000 }, 720, 2), false);
  const final = { ...active, turns: [turn(5)], elapsedMs: 674000 };
  assert.equal(mayAskFollowUp(final, 720, 2), true);
  assert.equal(mayAskFollowUp({ ...final, elapsedMs: 675000 }, 720, 2), false);
  assert.equal(mayAskFollowUp({ ...final, followUpCountByMainQuestion: { "root-5": 2 } }, 720, 2), false);
  assert.equal(mayAskFollowUp(session(), 720, 2), false);
});

test('time-based sessions do not reserve time for a fixed count of unasked main slots', () => {
  const plan = createInterviewPlan(context());
  const active = session({ plan, mainQuestionTarget: plan.slots.length, turns: [turn()], elapsedMs: 500000 });
  assert.equal(mayAskFollowUp(active, 720, 2), true);
  assert.equal(mayAskFollowUp({ ...active, elapsedMs: 675000 }, 720, 2), false);
});
