/** Controlled PUBLIC Q0/F1/F2 inputs for F's held-unit/lineage cases.
 * This seeds newly owned rows through the real E repository and shared session
 * lifecycle. It is not evidence of generated questions, live capture, or the
 * normal HTTP/D preparation path; the integration suite runs those separately.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthenticatedRequestContext } from '../../server/auth/request-identity';
import { createInterviewPlan } from '../../server/interview-planner';
import { createAuthenticatedSessionRuntime, snapshotHash } from '../../server/session-runtime';
import { createInterviewSession, acceptSessionEndRequest, finalizeSessionEndState, observeFinalizedAnswer } from '../../server/session-lifecycle';
import type { ConversationEvent } from '../../server/storage/conversation-log';
import type { SessionCommandRepository, SessionCommandReceipt, SessionCommandCommit, SessionCommandKind, SessionEnrollment, SessionEnrollmentCapability } from '../../server/session-writer/session-command-ports';
import { EVALUATION_PIPELINE_VERSION, evaluationSessionSourceFingerprint } from '../../server/providers/evaluation-input';
import { assertEvaluationQuestionContracts, buildEvaluationUnits } from '../../server/providers/evaluation-turns';
import { compileEvaluationScopePolicy } from '../../server/policy/evaluation-scope-policy';
import { decodeSessionEvaluationHandoff } from '../../server/evaluation-writer/e-handoff-codec';
import { evaluationSupplyFixture, appendSupplyTurn } from '../fixtures/evaluation-supply';

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const qualification = 'controlled-public-E-repository/shared-lifecycle-fixture' as const;
export const CONTROLLED_HANDOFF_FAULTS = ['owner', 'student', 'application-target', 'support-target', 'accepted-intent', 'accepted-input',
  'context-json', 'session-json', 'pins-json', 'model', 'pipeline', 'source'] as const;
export type ControlledHandoffFault = typeof CONTROLLED_HANDOFF_FAULTS[number];
export interface ControlledEndedFixtureOptions {
  requestContext: AuthenticatedRequestContext;
  /** This is the E source/bank fingerprint, not a document PDF byte hash.
   * Omission uses the newly created controlled bank's own fingerprint. */
  sourceSha256?: string;
  model?: string;
  followUps?: 0 | 1 | 2;
  /** Explicit malformed-input seeding for F's HTTP boundary tests only. No
   * already committed row is changed and the original E bytes stay intact. */
  handoffFault?: ControlledHandoffFault;
  now?: () => number;
}
export async function prepareControlledEvaluationFixture(options: ControlledEndedFixtureOptions) {
  const scope = options.requestContext.scope;
  if (!scope) throw new Error('F_CONTROLLED_FIXTURE_SCOPE_REQUIRED');
  const followUps = options.followUps ?? 2, fixture = await evaluationSupplyFixture({ followUp: followUps > 0 });
  const { context, bank } = fixture;
  context.student = { ...context.student, studentId: scope.studentId };
  if (context.targetAnalysis) context.targetAnalysis = { ...context.targetAnalysis, supportTargetId: scope.supportTargetId };
  else context.school = { ...context.school, interview: { ...context.school.interview!, id: scope.supportTargetId } };
  context.evaluationScopePolicy = compileEvaluationScopePolicy(context);
  if (followUps === 2) appendSupplyTurn(context, fixture.session, { followUp: true });
  const now = new Date((options.now ?? Date.now)()).toISOString();
  const runtime = createAuthenticatedSessionRuntime(context, options.requestContext.account.ownerId, now);
  const plan = { ...createInterviewPlan(context, fixture.session.id), poolKey: bank.key, poolContentSha256: bank.contentSha256,
    purpose: 'session' as const, mode: 'mock' as const, selectionContext: { scope: { ownerId: options.requestContext.account.ownerId,
      studentId: scope.studentId, supportTargetId: scope.supportTargetId }, historySessionIds: [] } };
  const session = createInterviewSession(context, plan, runtime, { id: fixture.session.id, now });
  session.turns = fixture.session.turns;
  session.questionPresentations = fixture.session.questionPresentations;
  session.elapsedMs = fixture.session.elapsedMs;
  session.followUpCountByMainQuestion = { [session.turns[0].id]: followUps };
  session.turns.forEach((turn, index) => { turn.followUpIndex = index; turn.mainCount = plan.mainQuestionTarget; });
  assertEvaluationQuestionContracts(session);
  assert.equal(buildEvaluationUnits(session).scoredUnits.length, followUps + 1);
  const model = options.model ?? 'synthetic-evaluation-pinned-v1';
  if (!model || model !== model.trim()) throw new Error('F_CONTROLLED_FIXTURE_MODEL_REQUIRED');
  const sourceSha256 = options.sourceSha256 ?? bank.sourceFingerprint;
  if (!/^[a-f0-9]{64}$/u.test(sourceSha256)) throw new Error('F_CONTROLLED_FIXTURE_SOURCE_REQUIRED');
  const pins = { verificationFixture: { version: 'pr07f-public-ended-fixture-v1', qualification, generatedQuestions: false, streamedMedia: false },
    sessionAuthority: { sessionId: session.id, ownerId: options.requestContext.account.ownerId, ...scope },
    models: { question: 'synthetic-question-v1', realtime: 'synthetic-core-v1', review: 'synthetic-review-v1', evaluation: model },
    bank: { key: bank.key, contentSha256: bank.contentSha256, sourceFingerprint: bank.sourceFingerprint }, sourceSha256,
    runtimeVersion: runtime.version, evaluationPipeline: EVALUATION_PIPELINE_VERSION };
  return { context, session, bank, turn: session.turns[0], model, sourceSha256, bankSourceFingerprint: bank.sourceFingerprint,
    documentPdfSha256: context.student.pdfSha256 ?? null, pins, pinsJson: JSON.stringify(pins), contextJson: JSON.stringify(context), qualification };
}

export async function seedControlledEndedEvaluation(options: ControlledEndedFixtureOptions & {
  sessions: SessionCommandRepository;
  mintEnrollment(context: AuthenticatedRequestContext, input: SessionEnrollment): SessionEnrollmentCapability;
}) {
  if (process.env.PR07F_TEST_DISPOSABLE !== '1' || !process.env.PR07F_TEST_RUN_ID || process.env.NODE_ENV === 'production')
    throw new Error('F_CONTROLLED_OWNED_TEST_DATABASE_REQUIRED');
  return seedControlledEndedEvaluationCore(options);
}

export async function seedControlledEndedEvaluationForScopedTransition(options: Parameters<typeof seedControlledEndedEvaluation>[0] & { assertOwnedDatabase(): Promise<void> }) {
  if(process.env.PR07G_TEST_DISPOSABLE!=='1'||!/^([a-z0-9_]{8,48})$/u.test(process.env.PR07G_TEST_RUN_ID??'')||process.env.NODE_ENV==='production')
    throw new Error('G_CONTROLLED_OWNED_TEST_DATABASE_REQUIRED');
  await options.assertOwnedDatabase();return seedControlledEndedEvaluationCore(options);
}

async function seedControlledEndedEvaluationCore(options: Parameters<typeof seedControlledEndedEvaluation>[0]) {
  if (options.handoffFault !== undefined && !CONTROLLED_HANDOFF_FAULTS.includes(options.handoffFault))
    throw new Error('F_CONTROLLED_HANDOFF_FAULT_INVALID');
  const value = await prepareControlledEvaluationFixture(options), { requestContext: auth, sessions } = options, { session, context, model } = value;
  const enrollment: SessionEnrollment = { sessionId: session.id, creationKey: 'f-controlled-' + randomUUID(), inputSha256: snapshotHash({ qualification, sessionId: session.id }),
    sessionJson: JSON.stringify(session), contextJson: value.contextJson, pinsJson: value.pinsJson, sourceSha256: value.sourceSha256,
    ...(Object.hasOwn(auth.scope!, 'sourceRevision') ? { sourceRevision: auth.scope!.sourceRevision } : {}) };
  let snapshot = await sessions.enroll(auth, enrollment, options.mintEnrollment(auth, enrollment));
  const domainEvents: ConversationEvent[] = [];
  const collect = (event: ConversationEvent) => domainEvents.push(structuredClone(event));
  async function commit(kind: SessionCommandKind, extra: Partial<SessionCommandCommit> | ((operationId: string) => Partial<SessionCommandCommit>) = {}, semantic: string = kind): Promise<SessionCommandReceipt> {
    const sessionJson = JSON.stringify(session), inputSha256 = snapshotHash({ qualification, kind, semantic, sessionSha256: hash(sessionJson) }), key = 'f-controlled-' + randomUUID();
    const started = await sessions.beginIntent(auth, { sessionId: session.id, key, inputSha256, kind, semanticKey: semantic, semanticSha256: inputSha256,
      expectedRevision: snapshot.revision, writerGeneration: snapshot.writerGeneration, writerToken: snapshot.writerToken });
    if (started.status !== 'pending') throw new Error('F_CONTROLLED_NEW_INTENT_REQUIRED');
    const events = domainEvents.splice(0).map((event, index) => ({ eventId: event.eventId ?? started.intent.operationId + ':' + index,
      kind: event.type, payloadJson: JSON.stringify(event) }));
    const details = typeof extra === 'function' ? extra(started.intent.operationId) : extra;
    const receipt = await sessions.commit(auth, started.intent, { sessionJson,
      events: [...events, { eventId: started.intent.operationId + ':fixture', kind: 'synthetic.controlled.fixture.' + kind, payloadJson: JSON.stringify({ qualification }) }],
      resultJson: JSON.stringify({ qualification, kind, sessionId: session.id }), ...details });
    const current = await sessions.read(auth, session.id); if (!current) throw new Error('F_CONTROLLED_SESSION_DISAPPEARED'); snapshot = current;
    return receipt;
  }
  const created = await commit('create');
  const answers: SessionCommandReceipt[] = [];
  for (const turn of session.turns) {
    observeFinalizedAnswer(session, turn, { onEvent: collect });
    const inputSha256 = snapshotHash({ rawTranscript: turn.rawTranscript, captureParts: turn.metadata.captureParts, endingObservation: turn.metadata.answerEndingObservation });
    answers.push(await commit('answer', { answerFact: { turnId: turn.id, answerId: turn.answerId!, captureRevision: turn.metadata.answerCaptureRevision ?? 1, inputSha256 } }, 'answer:' + turn.id));
  }
  const accepted = acceptSessionEndRequest(session, { elapsedMs: session.elapsedMs, metrics: {} }, { now: () => new Date((options.now ?? Date.now)()).toISOString() });
  const acceptedJson = JSON.stringify(accepted);
  collect({ type: 'session.end_requested', actor: 'server', payload: accepted });
  const endAccept = await commit('end-accept', operationId => ({ endIntent: { intentId: operationId, inputJson: acceptedJson, inputSha256: hash(acceptedJson) } }));
  finalizeSessionEndState(session, { activeStreamsFlushed: false, now: () => new Date((options.now ?? Date.now)()).toISOString(), onEvent: collect });
  session.runtime!.evaluationInputFrozenAt = new Date((options.now ?? Date.now)()).toISOString();
  session.evaluationStatus = 'review_required'; session.evaluationError = 'EVALUATION_HANDOFF_PENDING';
  delete session.runtime!.evaluationJob; delete session.evaluation;
  const sessionJson = JSON.stringify(session), frozenSessionSha256 = hash(sessionJson);
  const payload = { version: 'session-evaluation-handoff-v1', sessionId: session.id, ownerId: auth.account.ownerId,
    studentId: auth.scope!.studentId, applicationTargetId: auth.scope!.applicationTargetId, supportTargetId: auth.scope!.supportTargetId,
    acceptedEndIntentId: snapshot.endIntent!.intentId, acceptedEndInputSha256: snapshot.endIntent!.inputSha256,
    contextSnapshotSha256: hash(value.contextJson), frozenSessionSha256, evaluationSourceSha256: evaluationSessionSourceFingerprint(context, session, model),
    model, pipelineVersion: EVALUATION_PIPELINE_VERSION, sessionJson, contextJson: value.contextJson, pinsJson: value.pinsJson,
    state: 'awaiting-evaluation-consumer', evaluationApprovalGranted: false };
  // Fault injection is restricted to this public disposable test helper. E's
  // actual commit validator still runs; only the new handoff payload changes.
  switch (options.handoffFault) {
    case 'owner': payload.ownerId += ':wrong-owner'; break;
    case 'student': payload.studentId += ':wrong-student'; break;
    case 'application-target': payload.applicationTargetId += ':wrong-application'; break;
    case 'support-target': payload.supportTargetId += ':wrong-support'; break;
    case 'accepted-intent': payload.acceptedEndIntentId = randomUUID(); break;
    case 'accepted-input': payload.acceptedEndInputSha256 = '0'.repeat(64); break;
    case 'context-json': payload.contextJson += ' '; break;
    case 'session-json': payload.sessionJson += ' '; break;
    case 'pins-json': payload.pinsJson += ' '; break;
    case 'model': payload.model += ':wrong-model'; break;
    case 'pipeline': payload.pipelineVersion += ':wrong-pipeline'; break;
    case 'source': payload.evaluationSourceSha256 = '0'.repeat(64); break;
  }
  const payloadJson = JSON.stringify(payload);
  const endFinalize = await commit('end-finalize', { handoff: { intentId: snapshot.endIntent!.intentId, payloadJson, payloadSha256: hash(payloadJson), frozenSessionSha256 } });
  // A successful malformed seed is not a successful F decode. Its HTTP test
  // must observe the refusal before any F job/result/provider call.
  if (!options.handoffFault) decodeSessionEvaluationHandoff(snapshot);
  return { ...value, snapshot, testOnlyMalformedHandoff: options.handoffFault ?? null, receipts: { create: created, answers, endAccept, endFinalize } };
}
export type ControlledEndedEvaluationFixture = Awaited<ReturnType<typeof seedControlledEndedEvaluation>>;
