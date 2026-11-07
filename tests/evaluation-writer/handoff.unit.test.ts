import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { loadInterviewContext } from '../fixtures/runtime-context';
import { createInterviewPlan } from '../../server/interview-planner';
import { createInterviewSession } from '../../server/session-lifecycle';
import { createAuthenticatedSessionRuntime } from '../../server/session-runtime';
import { EVALUATION_PIPELINE_VERSION, evaluationSessionSourceFingerprint } from '../../server/providers/evaluation-input';
import type { SessionCommandSnapshot } from '../../server/session-writer/session-command-ports';
import type { AuthenticatedRequestContext } from '../../server/auth/request-identity';
import { decodeSessionEvaluationHandoff, evaluationTextSha256 as sha } from '../../server/evaluation-writer/e-handoff-codec';
import { parseEvaluationReviewTrust, resolveEvaluationReviewer, resolveStoredEvaluationReviewer } from '../../server/evaluation-writer/review-trust';
import type { EvaluationReviewArtifact } from '../../server/evaluation-writer/evaluation-writer-ports';

const instant = '2026-11-07T00:00:00.000Z';
async function frozen() {
  const context = await loadInterviewContext(), ownerId = 'synthetic-owner-a';
  const studentId = context.student.studentId ?? context.studentAnalysis?.studentId;
  const supportTargetId = context.targetAnalysis?.supportTargetId ?? context.school.interview?.id;
  assert.ok(studentId && supportTargetId);
  const session = createInterviewSession(context, createInterviewPlan(context, 'handoff-fixture'), createAuthenticatedSessionRuntime(context, ownerId, instant), {
    id: '11111111-1111-4111-8111-111111111111', now: instant,
  });
  session.status = 'ending'; session.evaluationStatus = 'review_required';
  session.runtime!.acceptedEndRequest = { elapsedMs: 0, metrics: { missing: null, unicode: 'A🙂한글\r\n원문' } };
  session.runtime!.endRequestedAt = instant; session.runtime!.evaluationInputFrozenAt = instant; session.runtime!.epoch = 1;
  const contextJson = JSON.stringify(context), binding = { sessionId: session.id, ownerId, studentId, supportTargetId,
    applicationTargetId: 'personal-application-a', sourceRevision: null, contextSnapshotSha256: sha(contextJson) };
  const pinsJson = JSON.stringify({ sessionAuthority: { ...binding }, models: { evaluation: 'synthetic-evaluation-v1' },
    runtimeVersion: session.runtime!.version, evaluationPipeline: EVALUATION_PIPELINE_VERSION });
  const sessionJson = JSON.stringify(session, null, 2).replaceAll('\n', '\r\n').replace('"elapsedMs": 0,', '"elapsedMs": 0e0,');
  const ending = { intentId: '22222222-2222-4222-8222-222222222222', inputJson: JSON.stringify(session.runtime!.acceptedEndRequest),
    inputSha256: sha(JSON.stringify(session.runtime!.acceptedEndRequest)), acceptedRevision: '9007199254740993', acceptedAt: instant };
  const payload = { version: 'session-evaluation-handoff-v1', sessionId: session.id, ownerId, studentId, applicationTargetId: binding.applicationTargetId,
    supportTargetId, acceptedEndIntentId: ending.intentId, acceptedEndInputSha256: ending.inputSha256, contextSnapshotSha256: binding.contextSnapshotSha256,
    frozenSessionSha256: sha(sessionJson), evaluationSourceSha256: evaluationSessionSourceFingerprint(context, session, 'synthetic-evaluation-v1'),
    model: 'synthetic-evaluation-v1', pipelineVersion: EVALUATION_PIPELINE_VERSION, sessionJson, contextJson, pinsJson,
    state: 'awaiting-evaluation-consumer', evaluationApprovalGranted: false };
  const payloadJson = JSON.stringify(payload), snapshot: SessionCommandSnapshot = {
    version: 'authenticated-session-snapshot-v1', binding, writer: 'db', writerGeneration: '1', writerToken: '33333333-3333-4333-8333-333333333333',
    revision: '9007199254740996', created: true, serverNow: instant, sessionJson, sessionSha256: sha(sessionJson), contextJson, pinsJson,
    contextSnapshotSha256: binding.contextSnapshotSha256, pinsSha256: sha(pinsJson), endIntent: ending,
    handoff: { intentId: ending.intentId, version: 'session-evaluation-handoff-v1', state: 'awaiting-evaluation-consumer', payloadJson,
      payloadSha256: sha(payloadJson), contextSnapshotSha256: binding.contextSnapshotSha256, frozenSessionSha256: sha(sessionJson), committedRevision: '9007199254740995' },
  };
  return { snapshot, payload };
}

test('F reads exact E TEXT and bigint revisions without rewriting an owner, Unicode, null or original approval fact', async () => {
  const { snapshot } = await frozen(), before = JSON.stringify(snapshot), decoded = decodeSessionEvaluationHandoff(snapshot);
  assert.equal(decoded.payload.sessionJson, snapshot.sessionJson); assert.ok(decoded.payload.sessionJson.includes('\r\n'));
  assert.equal(decoded.payload.evaluationApprovalGranted, false); assert.equal(decoded.payload.applicationTargetId, 'personal-application-a');
  assert.notEqual(decoded.payload.applicationTargetId, decoded.payload.supportTargetId);
  assert.equal(JSON.stringify(snapshot), before); assert.equal(decoded.handoff.committedRevision, '9007199254740995');
  assert.equal(decoded.session.runtime!.acceptedEndRequest!.metrics.unicode, 'A🙂한글\r\n원문');
});

test('F refuses raw corruption and independently rehashed scope, accepted input, model, pipeline or domain-source substitution', async () => {
  const { snapshot, payload } = await frozen();
  assert.throws(() => decodeSessionEvaluationHandoff({ ...snapshot, contextJson: snapshot.contextJson + ' ' }), /F_HANDOFF_RAW_BYTES_CHANGED/u);
  for (const [key, value] of Object.entries({ ownerId: 'other-owner', studentId: 'other-student', applicationTargetId: payload.supportTargetId,
    supportTargetId: payload.applicationTargetId, acceptedEndIntentId: '44444444-4444-4444-8444-444444444444', acceptedEndInputSha256: '0'.repeat(64),
    model: 'other-model', pipelineVersion: 'other-pipeline', evaluationSourceSha256: '0'.repeat(64) })) {
    const altered = JSON.stringify({ ...payload, [key]: value });
    assert.throws(() => decodeSessionEvaluationHandoff({ ...snapshot, handoff: { ...snapshot.handoff!, payloadJson: altered, payloadSha256: sha(altered) } }), /F_HANDOFF_/u, key);
  }
  assert.throws(() => decodeSessionEvaluationHandoff({ ...snapshot, handoff: { ...snapshot.handoff!, committedRevision: '9007199254740997' } }), /F_HANDOFF_REVISION_CHANGED/u);
});

test('F distinguishes E wildcard grant revision from exact enrolled document pins without normalizing absent or null', async () => {
  const { snapshot, payload } = await frozen(), originalPins = JSON.parse(snapshot.pinsJson);
  const { sourceRevision: _sourceRevision, ...authority } = originalPins.sessionAuthority;
  assert.equal(_sourceRevision, null);
  function pinned(sourceRevision: string | null, grant: Record<string, unknown> = authority, documentRevision: string | null = sourceRevision) {
    const pinsJson = JSON.stringify({ ...originalPins, sessionAuthority: grant, sourceRevision: documentRevision });
    const payloadJson = JSON.stringify({ ...payload, pinsJson });
    return { ...snapshot, binding: { ...snapshot.binding, sourceRevision }, pinsJson, pinsSha256: sha(pinsJson),
      handoff: { ...snapshot.handoff!, payloadJson, payloadSha256: sha(payloadJson) } };
  }
  const scoped = pinned('document-revision-1'), before = JSON.stringify(scoped);
  const decoded = decodeSessionEvaluationHandoff(scoped);
  assert.equal(Object.hasOwn(decoded.pins.sessionAuthority!, 'sourceRevision'), false);
  assert.equal(decoded.snapshot.binding.sourceRevision, 'document-revision-1');
  assert.equal(JSON.stringify(scoped), before);
  assert.throws(() => decodeSessionEvaluationHandoff(pinned('document-revision-1', authority, 'other-revision')), /F_HANDOFF_PINS_CHANGED/u);
  assert.throws(() => decodeSessionEvaluationHandoff(pinned('document-revision-1', { ...authority, sourceRevision: null })), /F_HANDOFF_PINS_CHANGED/u);
  assert.doesNotThrow(() => decodeSessionEvaluationHandoff(pinned(null, { ...authority, sourceRevision: null })));
});

test('F rejects correctly rehashed null, array and primitive pins as a bounded domain conflict', async () => {
  const { snapshot, payload } = await frozen();
  for (const pinsJson of ['null', '[]', '"primitive"', '17', 'false']) {
    const payloadJson = JSON.stringify({ ...payload, pinsJson });
    const changed = { ...snapshot, pinsJson, pinsSha256: sha(pinsJson), handoff: { ...snapshot.handoff!, payloadJson, payloadSha256: sha(payloadJson) } };
    assert.throws(() => decodeSessionEvaluationHandoff(changed), error => error instanceof Error && error.message === 'F_HANDOFF_DOMAIN_INVALID' && Reflect.get(error, 'status') === 409, pinsJson);
  }
});

test('F trust requires the current server-installed subject, action and key; signatures or actor labels alone grant nothing', () => {
  const key = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const context = { mode: 'authenticated', principal: { issuer: 'https://synthetic-issuer.example', subject: 'subject-a', expiresAt: Date.parse(instant) + 60_000 },
    account: { accountId: 'account-a', ownerId: 'owner-a', revision: '1', grants: [] },
    scope: { studentId: 'student-a', applicationTargetId: 'application-a', supportTargetId: 'support-a' } } as AuthenticatedRequestContext;
  const body = { version: 'evaluation-review-trust-v1', ownerId: context.account.ownerId, ...context.scope!, reviewers: [{ issuer: context.principal.issuer,
    subject: context.principal.subject, actorId: 'explicit-synthetic-reviewer', publicKey: key, actions: ['publish-spec'],
    notBefore: '2026-11-06T00:00:00.000Z', expiresAt: '2026-11-08T00:00:00.000Z', revoked: false }] };
  const contentSha256 = sha(JSON.stringify(body)), json = JSON.stringify({ ...body, contentSha256 }), artifact: EvaluationReviewArtifact = { kind: 'trust', contentSha256, json, rawSha256: sha(json) };
  assert.equal(parseEvaluationReviewTrust(artifact, context).ownerId, 'owner-a');
  assert.equal(resolveEvaluationReviewer(artifact, context, 'publish-spec', instant).actorId, 'explicit-synthetic-reviewer');
  assert.equal(resolveStoredEvaluationReviewer(artifact, context, 'explicit-synthetic-reviewer', 'publish-spec', instant).publicKeySha256.length, 64);
  assert.throws(() => resolveEvaluationReviewer(artifact, { ...context, principal: { ...context.principal, subject: 'forged-reviewer' } }, 'publish-spec', instant), /F_REVIEWER_NOT_AUTHORIZED/u);
  assert.throws(() => resolveEvaluationReviewer(artifact, context, 'supply-session', instant), /F_REVIEWER_NOT_AUTHORIZED/u);
  assert.throws(() => resolveEvaluationReviewer(artifact, context, 'publish-spec', '2026-11-09T00:00:00.000Z'), /F_REVIEWER_NOT_AUTHORIZED/u);
  assert.throws(() => parseEvaluationReviewTrust(artifact, { ...context, scope: { ...context.scope!, applicationTargetId: 'other-app' } }), /F_REVIEW_TRUST_BINDING_CHANGED/u);
});
