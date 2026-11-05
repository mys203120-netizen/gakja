import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GUIDEBOOK_EXPOSURE_REGISTRY, loadGuidebookExposure, questionHistoryEligibility, questionSelectionScope, rankQuestionSlots, selectionEligibility, sessionPlanFromPool, type GuidebookExposure } from '../server/question-selection';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { InterviewPlanSlot, InterviewPlan } from '../server/interview-planner';
import type { InterviewSession } from '../server/protocol';

// Synthetic records only: no student document or provider is consumed.
const context = { target: { university: '합성 대학', department: '합성 학과' }, student: { studentId: 'student-a', ownerId: 'owner-a' }, school: { interview: { id: 'track-a' } } } as unknown as InterviewContext;
const scope = questionSelectionScope(context);
function slot(id: string, target = id): InterviewPlanSlot {
  return { id, index: Number(id.replace(/\D/g, '')) || 1, label: target, topicArea: 'academic_inquiry', evidenceIds: ['source-a'], activityIds: ['same-activity'], primaryFunction: 'EVIDENCE', questionIntent: target, depth: 'D2', interviewerId: 'interviewer-1', interviewerRole: 'academic', schoolConnections: [], semanticKey: target };
}
const published: GuidebookExposure = { status: 'published', registryStatus: 'explicit_fixture', scope, publicationRevision: 'publication-v1', reason: 'Synthetic published example.', questions: [{ questionId: 'public-example', questionText: '결론의 판단 근거는 무엇인가요?', semanticKey: 'evidence-for-conclusion', semanticAliases: ['same-target-regenerated-id'] }] };

test('public examples exclude exact and reviewed same-purpose descendants, not their entire activity or practice reuse', () => {
  assert.equal(selectionEligibility(slot('1', 'unrelated'), '결론의 판단 근거는 무엇인가요?', { mode: 'mock', exposure: published, scope }).reason, 'GUIDEBOOK_SAME_UTTERANCE');
  assert.equal(selectionEligibility(slot('1', 'evidence-for-conclusion'), '무엇을 보고 그 결론을 내렸나요?', { mode: 'mock', exposure: published, scope }).allowed, false);
  assert.equal(selectionEligibility(slot('1', 'same-target-regenerated-id'), '결론에 도달한 근거를 말씀해 주세요.', { mode: 'mock', exposure: published, scope }).allowed, false);
  assert.equal(selectionEligibility(slot('2', 'measurement-trustworthiness'), '측정값을 믿을 수 있다고 판단한 근거는 무엇인가요?', { mode: 'mock', exposure: published, scope }).allowed, true);
  assert.equal(selectionEligibility(slot('1', 'evidence-for-conclusion'), '결론의 판단 근거는 무엇인가요?', { mode: 'practice', exposure: published, scope }).allowed, true);
  assert.equal(selectionEligibility(slot('1'), '합성 질문의 내용은 무엇인가요?', { mode: 'mock', exposure: { ...published, status: 'mapping_required' }, scope }).reason, 'PUBLICATION_MAPPING_REQUIRED');
});

test('publication absence is explicit, another owner is ignored, and an unmapped published registry never becomes an empty history', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'question-exposure-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await rm(root, { recursive: true, force: true }); });
  assert.deepEqual((await loadGuidebookExposure(context, root)).questions, []);
  assert.equal((await loadGuidebookExposure(context, root)).registryStatus, 'absent');
  const file = path.join(root, GUIDEBOOK_EXPOSURE_REGISTRY); await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ schemaVersion: 'guidebook-exposure-v1', publications: [{ scope: { ...scope, studentId: 'student-b' }, status: 'published', publicationRevision: 'other-student', questions: published.questions }] }));
  assert.equal((await loadGuidebookExposure(context, root)).status, 'not_published');
  await writeFile(file, JSON.stringify({ schemaVersion: 'guidebook-exposure-v1', publications: [{ scope, status: 'published', publicationRevision: 'v2', questions: [{ questionId: 'unmapped', questionText: '목적 계보가 아직 연결되지 않은 질문입니다.' }] }] }));
  assert.equal((await loadGuidebookExposure(context, root)).status, 'mapping_required');
});

test('session ordering uses unseen purposes and separates owner/target history; seeds diversify only equally used candidates', () => {
  const slots = ['1', '2', '3', '4', '5', '6'].map(id => slot(id));
  const history = { id: 'past-session', target: context.target, plan: { selectionContext: { scope } }, questionPresentations: [{ turnId: 'actually-presented', startedAtMs: 100, completedAtMs: 200 }], turns: [{ id: 'actually-presented', questionKind: 'main', metadata: { selectionTrace: { semanticKey: '1' } } }] } as unknown as InterviewSession;
  const ranked = rankQuestionSlots(slots, context.target, { scope, history: [history], sessionSeed: 'round-a' });
  assert.equal(ranked.at(-1)?.semanticKey, '1');
  assert.deepEqual(ranked, rankQuestionSlots(slots, context.target, { scope, history: [history], sessionSeed: 'round-a' }));
  const other = structuredClone(history); other.plan!.selectionContext!.scope!.studentId = 'student-b';
  assert.deepEqual(rankQuestionSlots(slots, context.target, { scope, history: [other], sessionSeed: 'round-a' }), rankQuestionSlots(slots, context.target, { scope, sessionSeed: 'round-a' }));
  const onlyPrepared = structuredClone(history); onlyPrepared.questionPresentations = [];
  assert.deepEqual(rankQuestionSlots(slots, context.target, { scope, history: [onlyPrepared], sessionSeed: 'round-a' }), rankQuestionSlots(slots, context.target, { scope, sessionSeed: 'round-a' }));
  const orders = new Set(Array.from({ length: 8 }, (_, index) => rankQuestionSlots(slots, context.target, { sessionSeed: `round-${index}` }).map(item => item.id).join(',')));
  assert.ok(orders.size > 1);
});

test('a session plan pins the pool and publication snapshot independently of its candidate preparation order', () => {
  const pool = { policyVersion: 'synthetic', durationSeconds: 720, mainQuestionTarget: 6, slots: ['1', '2', '3', '4', '5', '6'].map(id => slot(id)), limitations: [] } satisfies InterviewPlan;
  const session = sessionPlanFromPool(pool, context.target, { key: 'pool-a', contentSha256: 'immutable-pool' }, { scope, exposure: published, sessionSeed: 'round-a' });
  assert.equal(session.scheduling, 'time_based'); assert.equal(session.purpose, 'session');
  assert.equal(session.poolKey, 'pool-a'); assert.equal(session.selectionContext!.exposure!.publicationRevision, 'publication-v1');
  assert.deepEqual(session.slots.map(item => item.index), [1, 2, 3, 4, 5, 6]);
  assert.ok(session.slots.every(item => item.candidateSlotId === item.id));
  assert.notEqual(session.selectionContext!.exposure, published);
});

test('every explicit synthetic verification flag excludes E2E history from real question ranking without deleting its observations', () => {
  const slots = ['1', '2', '3', '4', '5', '6'].map(id => slot(id));
  const pool = { policyVersion: 'synthetic', durationSeconds: 720, mainQuestionTarget: slots.length, slots, limitations: [] } satisfies InterviewPlan;
  const baseline = rankQuestionSlots(slots, context.target, { scope, sessionSeed: 'synthetic-exclusion' });
  const firstPurpose = baseline[0].semanticKey!;
  const history = { id: 'observed-past-session', target: context.target, plan: { selectionContext: { scope } }, questionPresentations: [{ turnId: 'played-question', startedAtMs: 100 }], turns: [{ id: 'played-question', questionKind: 'main', metadata: { selectionTrace: { semanticKey: firstPurpose } } }] } as unknown as InterviewSession;
  for (const flag of ['syntheticTest', 'syntheticProvider', 'syntheticVoice', 'syntheticClientObservation']) {
    const marked = { ...structuredClone(history), metrics: { verification: { syntheticTest: false, [flag]: true, scenario: `explicit-${flag}` } } } as unknown as InterviewSession;
    const before = JSON.stringify(marked);
    const eligibility = questionHistoryEligibility(marked, context.target, { scope });
    assert.equal(eligibility.allowed, false, `${flag}=true must not be overridden by syntheticTest=false`);
    assert.equal(eligibility.reason, 'EXPLICIT_SYNTHETIC_SESSION');
    assert.equal(eligibility.provenance.declaredFlags[flag], true);
    assert.deepEqual(rankQuestionSlots(slots, context.target, { scope, history: [marked], sessionSeed: 'synthetic-exclusion' }), baseline);
    const plan = sessionPlanFromPool(pool, context.target, { key: 'pool', contentSha256: 'hash' }, { scope, history: [marked], sessionSeed: 'synthetic-exclusion' });
    assert.deepEqual(plan.selectionContext!.historySessionIds, []);
    assert.equal(JSON.stringify(marked), before, 'the stored E2E session and playback evidence remain intact');
  }
});

test('unknown scoped legacy provenance stays unknown and is not reclassified as a verified real interview', () => {
  const slots = ['1', '2', '3', '4', '5', '6'].map(id => slot(id));
  const baseline = rankQuestionSlots(slots, context.target, { scope, sessionSeed: 'legacy-provenance' });
  const used = baseline[0].semanticKey!;
  const history = { id: 'unknown-legacy', target: context.target, plan: { selectionContext: { scope } }, questionPresentations: [{ turnId: 'observed-question', startedAtMs: 100 }], turns: [{ id: 'observed-question', questionKind: 'main', metadata: { selectionTrace: { semanticKey: used } } }] } as unknown as InterviewSession;
  const unknown = questionHistoryEligibility(history, context.target, { scope });
  assert.equal(unknown.allowed, true);
  assert.equal(unknown.reason, 'HISTORY_PROVENANCE_UNKNOWN');
  assert.equal(unknown.provenance.syntheticTest, null);
  assert.deepEqual(unknown.provenance.declaredFlags, {});
  assert.equal(rankQuestionSlots(slots, context.target, { scope, history: [history], sessionSeed: 'legacy-provenance' }).at(-1)?.semanticKey, used);
  const notMarkedSynthetic = { ...history, metrics: { verification: { syntheticTest: false, syntheticProvider: false, syntheticVoice: false, syntheticClientObservation: false } } } as unknown as InterviewSession;
  const declared = questionHistoryEligibility(notMarkedSynthetic, context.target, { scope });
  assert.equal(declared.allowed, true);
  assert.equal(declared.reason, 'HISTORY_NOT_MARKED_SYNTHETIC');
  assert.equal(declared.provenance.syntheticTest, false);
  const missingScope = structuredClone(history); delete missingScope.plan!.selectionContext!.scope;
  assert.equal(questionHistoryEligibility(missingScope, context.target, { scope }).reason, 'HISTORY_SCOPE_UNVERIFIED_OR_MISMATCHED');
});

test('topic variety never moves a more recently exposed purpose ahead of an equally used older purpose', () => {
  const a = { ...slot('1'), activityIds: ['activity-a'] }, b = { ...slot('2'), activityIds: ['activity-b'] },
    c = { ...slot('3'), activityIds: ['activity-c'], topicArea: 'community_values' as const };
  const history = [a, b, c].map((item, index) => ({ id: `history-${index}`, createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(), target: context.target,
    plan: { selectionContext: { scope } }, questionPresentations: [{ turnId: `played-${index}`, startedAtMs: 100 }],
    turns: [{ id: `played-${index}`, questionKind: 'main', metadata: { selectionTrace: { semanticKey: item.semanticKey } } }] }) as unknown as InterviewSession);
  assert.deepEqual(rankQuestionSlots([c, b, a], context.target, { scope, history, sessionSeed: 'recency-before-topic' }).map(row => row.id), ['1', '2', '3']);
});

test('an independent reviewed purpose from the same activity is eligible while the answered purpose is suppressed', () => {
  const current = [{ id: 'main-role', questionText: '이 활동에서 직접 맡은 부분이 있나요?', questionKind: 'main',
    metadata: { activityIds: ['same-activity'], selectionTrace: { semanticKey: 'personal-role' } } }] as unknown as InterviewSession['turns'];
  assert.equal(selectionEligibility(slot('1', 'personal-role'), '본인이 한 일은 무엇인가요?', {}, current).reason, 'CURRENT_SESSION_ALREADY_ASKED');
  assert.equal(selectionEligibility(slot('2', 'evidence-for-conclusion'), '이 결론은 어떤 자료를 보고 판단했나요?', {}, current).allowed, true);
});
