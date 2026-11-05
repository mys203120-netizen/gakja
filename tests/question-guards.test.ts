import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuestionAnchorCandidates, renderQuestionIR } from '../server/providers/question-realization';
import { assertQuestionIRFlow, verifyRealizedQuestion, type QuestionIRFlowContext } from '../server/providers/question-guards';

const context: QuestionIRFlowContext = { clusterId: 'q0', expectedClusterId: 'q0', parentQuestionId: 'q0', expectedParentQuestionId: 'q0', answerTurnId: 'q0', expectedAnswerTurnId: 'q0', objectiveId: 'objective-evidence', clusterObjectiveId: 'root-evidence', expectedClusterObjectiveId: 'root-evidence', subordinationRationale: '같은 판단의 근거를 확인한다.', allowedSourceIds: ['ANSWER_TURN:q0:answer0'], askedObjectiveIds: [], followUpCount: 0, maxFollowUps: 2, elapsedMs: 0, durationSeconds: 720 };

test('source-bound nonquoted questions pass structural approval without claiming independent meaning review', () => {
  const anchors = buildQuestionAnchorCandidates({ turnId: 'q0', answerId: 'answer0', rawTranscript: '자료를 찾아봤습니다.', quoteOptions: ['자료를 찾아봤습니다'] });
  const result = renderQuestionIR({ operation: 'evidence_verification', anchorId: anchors[0].id, anchorMode: 'none', secondaryAnchorId: null }, { anchors, seed: 'guard-test' });
  const approval = verifyRealizedQuestion(result, context);
  assert.ok(Object.isFrozen(approval));
  assert.equal(approval.method, 'approved_ir_surface');
  assert.equal(approval.independentSemanticReview, false);
  assert.equal(approval.anchorIds[0], anchors[0].id);
  assert.throws(() => verifyRealizedQuestion(result, { ...context, allowedSourceIds: [] }), /QUESTION_SOURCE_MISMATCH/);
});

test('flow guards enforce server cluster, original objective, parent, answer and two-followup bound', () => {
  for (const change of [
    { clusterId: 'q1' }, { clusterObjectiveId: 'different-independent-purpose' },
    { parentQuestionId: 'q9' }, { answerTurnId: 'q8' }, { objectiveId: '' }, { subordinationRationale: '' },
    { followUpCount: 2 }, { maxFollowUps: 3 }, { followUpCount: -1 },
    { askedObjectiveIds: ['objective-evidence'] }, { elapsedMs: 720000 },
    { elapsedMs: 700000, minimumRemainingSeconds: 45 },
  ]) assert.throws(() => assertQuestionIRFlow({ ...context, ...change }));
  assert.doesNotThrow(() => assertQuestionIRFlow({ ...context, followUpCount: 1 }));
});
