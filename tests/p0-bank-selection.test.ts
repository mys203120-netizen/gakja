import test from 'node:test';
import assert from 'node:assert/strict';
import { createInterviewPlan, type InterviewPlanSlot } from '../server/interview-planner';
import { rankQuestionSlots } from '../server/question-selection';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { InterviewSession } from '../server/protocol';

test('the offline pool keeps all reviewed student purposes plus optional common purposes beyond the former18 cap', () => {
  const objectives = Array.from({ length: 30 }, (_, i) => ({ id: `purpose-${i}`, semanticKey: `verified-purpose-${i}`, evidenceIds: ['source'], activityIds: [`activity-${i}`], primaryFunction: 'PROCESS', targetDescription: `합성 활동 ${i}의 수행 방법 하나`, depth: 'D2' }));
  const optional = { id: 'optional-common', semanticKey: 'approved-common', evidenceIds: [], activityIds: [], primaryFunction: 'MOTIVE', targetDescription: '승인 공통 질문', depth: 'D2', grounding: { kind: 'COMMON_APPROVED' } };
  const context = { studentObjectives: [...objectives, optional], student: { evidence: [{ id: 'source', confirmationStatus: 'confirmed_from_record', text: '합성 활동을 진행했다.', title: '합성', section: '탐구' }] }, interviewOverview: { durationSeconds: 720 }, school: {} } as unknown as InterviewContext;
  const plan = createInterviewPlan(context, 'complete-pool');
  assert.equal(plan.slots.length, 31);
  assert.ok(objectives.every(objective => plan.slots.some(slot => slot.objective?.id === objective.id)));
  assert.equal(plan.slots.filter(slot => slot.objective?.id === optional.id).length, 1);
  assert.equal(plan.scheduling, 'time_based');
});

test('equal-use purposes prefer older verified exposures and keep a new purpose on the same activity eligible', () => {
  const scope = { ownerId: 'fixture-owner', studentId: 'fixture-student', supportTargetId: 'fixture-support' };
  const slot = (id: string) => ({ id, semanticKey: id, topicArea: 'academic_inquiry', activityIds: ['same-activity'] }) as InterviewPlanSlot;
  const history = (id: string, date: string) => ({ id, createdAt: date, target: {}, plan: { selectionContext: { scope } }, questionPresentations: [{ turnId: id, startedAtMs: 1 }], turns: [{ id, questionKind: 'main', questionText: id, metadata: { selectionTrace: { semanticKey: id } } }] }) as unknown as InterviewSession;
  const ranked = rankQuestionSlots([slot('recent'), slot('older'), slot('new-purpose')], {}, { scope, sessionSeed: 'test', history: [history('recent', '2026-11-03T03:00:00Z'), history('older', '2026-11-01T03:00:00Z')] });
  assert.deepEqual(ranked.map(item => item.id), ['new-purpose', 'older', 'recent']);
});
