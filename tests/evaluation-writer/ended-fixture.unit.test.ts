import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthenticatedRequestContext } from '../../server/auth/request-identity';
import { encodeAuthenticatedSessionEnvelope } from '../../server/contracts/authenticated-session-codec';
import { assertEvaluationQuestionContracts, buildEvaluationUnits } from '../../server/providers/evaluation-turns';
import { prepareControlledEvaluationFixture } from './ended-fixture';

const requestContext = { mode: 'authenticated', account: { ownerId: 'explicit-controlled-fixture-owner' },
  scope: { studentId: 'explicit-controlled-fixture-student', applicationTargetId: 'personal-application-fixture', supportTargetId: 'domain-support-fixture' } } as AuthenticatedRequestContext;

test('controlled public Q0/F1/F2 fixture retains real contract checks, authenticated binding and separate source hash meanings', async () => {
  const value = await prepareControlledEvaluationFixture({ requestContext }), { session, context } = value;
  assertEvaluationQuestionContracts(session);
  assert.equal(encodeAuthenticatedSessionEnvelope(session, context).contextSha256, session.runtime!.contextSnapshotSha256);
  assert.equal(session.runtime!.owner.mode, 'authenticated'); assert.equal(session.runtime!.owner.id, requestContext.account.ownerId);
  assert.equal(context.student.studentId, requestContext.scope!.studentId);
  assert.equal(context.targetAnalysis?.supportTargetId ?? context.school.interview?.id, requestContext.scope!.supportTargetId);
  assert.equal(value.pins.sessionAuthority.applicationTargetId, requestContext.scope!.applicationTargetId);
  assert.notEqual(value.pins.sessionAuthority.applicationTargetId, value.pins.sessionAuthority.supportTargetId);
  assert.deepEqual(session.turns.map(turn => [turn.questionKind, turn.followUpIndex]), [['main', 0], ['follow_up', 1], ['follow_up', 2]]);
  assert.equal(buildEvaluationUnits(session).scoredUnits.length, 3);
  assert.equal(value.sourceSha256, value.bankSourceFingerprint);
  assert.equal(value.qualification, 'controlled-public-E-repository/shared-lifecycle-fixture');
  assert.equal(value.pins.verificationFixture.generatedQuestions, false); assert.equal(value.pins.verificationFixture.streamedMedia, false);
  assert.equal(session.runtime!.evaluationJob, undefined); assert.equal(session.runtime!.evaluationInputFrozenAt, undefined);
});
