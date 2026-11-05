import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeSessionEvaluation } from '../server/providers/openai';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { InterviewSession } from '../server/protocol';
import { reviewedRecordEvaluationFixture } from './fixtures/reviewed-evaluation-knowledge';

test('target preparation priorities enable separate coaching without changing the same actual answer score', () => {
  const text = '먼저 온도를 측정했습니다.';
  const axis = { anchor: 3, quote: text, rationale: '실제 질문의 수행 단계를 구체적으로 설명했다.' };
  const output = { summary: '합성 평가', languageClassifications: [], answers: [{ turnId: 'q0', status: 'SATISFIED', deferredReason: null, axes: { I: axis, A: axis, S: axis, R: axis, C: axis }, verifiedCoreError: false, verifiedCoreErrorEvidence: null, strengths: [], improvements: [], conflictNeedsReview: [], deliveryCoaching: [], strategyCoaching: ['질문의 요구를 설명할 수 있는 실제 수행 경험을 준비해 보세요.'] }] };
  const session = { id: 'synthetic-session', turns: [{ id: 'q0', parentMainQuestionId: 'q0', questionKind: 'main', questionText: '실제로 진행한 첫 단계는 무엇인가요?', evidenceIds: ['record-a'], answerId: 'answer-q0', rawTranscript: text, transcriptStatus: 'finalized', metadata: { primaryFunction: 'PROCESS', depth: 'D2', questionIntent: '실제로 수행한 첫 단계를 확인한다.', targetEvidence: ['수행한 첫 단계'] } }], questionPresentations: [{ turnId: 'q0', rootTurnId: 'q0', questionKind: 'main', clockId: 'synthetic-clock', startedAtMs: 1, completedAtMs: 2 }] } as unknown as InterviewSession;
  const base = { school: { schoolReferenceId: 'synthetic-school' } } as InterviewContext;
  const withPriority = (priority: 'S' | 'C') => ({ ...base, targetAnalysis: { revision: 'target-analysis-v1', supportTargetId: 'synthetic-target', activityPriorities: [{ activityId: 'activity-a', priority, reason: '해당 지원처를 위한 준비 필요성을 설명하는 합성 사유입니다.' }] } }) as unknown as InterviewContext;
  const firstInput = reviewedRecordEvaluationFixture(withPriority('S'), session), secondInput = reviewedRecordEvaluationFixture(withPriority('C'), session);
  const first = finalizeSessionEvaluation(output, firstInput.context, firstInput.session);
  const second = finalizeSessionEvaluation(output, secondInput.context, secondInput.session);
  assert.equal(first.answers[0].score, second.answers[0].score);
  assert.equal(first.answers[0].score, 75);
  assert.equal(first.strategyStatus, 'TARGET_STRATEGY_AVAILABLE');
  assert.equal(first.strategyContext!.scoreInfluence, false);
  assert.deepEqual(first.answers[0].strategyCoaching, output.answers[0].strategyCoaching);
  const unavailableInput = reviewedRecordEvaluationFixture(base, session);
  const unavailable = finalizeSessionEvaluation(output, unavailableInput.context, unavailableInput.session);
  assert.equal(unavailable.strategyStatus, 'STRATEGY_UNAVAILABLE');
  assert.deepEqual(unavailable.answers[0].strategyCoaching, []);
});
