import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';
import type { AuthenticatedRequestContext, RequestIdentityBoundary } from '../auth/request-identity';
import type { ServiceRequestResources, SessionAccessBinding } from '../request-realtime-server';
import type { InterviewContext } from '../data/load-interview-context';
import { createSessionQuestionPlan, type PreparedQuestionBank } from '../data/prepared-question-bank';
import { answerCandidateRequestSchema, answerEndingObservationSchema, assertCaptureConfirmed, assertCaptureMayStart, assertCandidateSource, capturePart, transcriptHash } from '../answer-candidate-state';
import { concatenateStreamTranscript, finalizeCapturedTurnForEnd, isFinalizedAnswer, mayAskClarification, mayReplayQuestion, mergeTranscriptObservation, nextRequestSchema, type InterviewSession, type RecordedTurn, type TranscriptObservation } from '../protocol';
import { clientConversationEventSchema } from '../../lib/interview/client-event-contract';
import { checkpointSession, createAuthenticatedSessionRuntime, assertAuthenticatedSessionOwner, restoreAuthenticatedSession, recoveryProjection, snapshotHash, type ClosingUtterance } from '../session-runtime';
import { acceptSessionEndRequest, answerMetrics, applySessionClientEvent, createInterviewSession, evaluationInputFrozen, finalizeSessionEndState, observeFinalizedAnswer, SessionDomainError, sessionEndCaptureScopeSchema } from '../session-lifecycle';
import { createSessionEndDrainer, type SessionEndCaptureScope } from '../session-end-drain';
import { createSessionTurnPreparer, type PreparedWork, type SessionTurnProviders } from '../session-turn-preparer';
import { buildConversationLedger } from '../conversation-ledger';
import { recordSessionProviderUsage } from '../observability/session-provider-ledger';
import { getDurableSubmissionWork, completeDurableSubmissionWork } from './submission-deadline';
import { cachedCaptureFinish, captureFinishForEnd, captureFinishMayPublish, type CaptureFinishCache } from './capture-finish-cache';
import { sessionDurationSeconds } from '../data/school-context';
import { mayAskFollowUp } from '../interview-planner';
import { interviewConfig } from '../../interview.config';
import { createSessionClosingPreparer } from '../session-closing';
import { EVALUATION_PIPELINE_VERSION, evaluationSessionSourceFingerprint } from '../providers/evaluation-input';
import type { ConversationEvent } from '../storage/conversation-log';
import type { ServiceSessionMutations } from './service-session-mutations';
import { SessionCommandError, type SessionCommandCommit, type SessionCommandIdentity, type SessionCommandIntent, type SessionCommandKind, type SessionCommandReceipt, type SessionCommandRepository, type SessionCommandSnapshot, type SessionEnrollment, type SessionEnrollmentCapability, type SessionMandatoryEvent } from './session-command-ports';
import { AUTHENTICATED_SESSION_ENVELOPE_VERSION, decodeAuthenticatedSessionEnvelope } from '../contracts/authenticated-session-codec';
import { AUTHENTICATED_SESSION_COMMAND_VERSION, authenticatedSessionCommandSchema, sessionCommandInputSha256, type AuthenticatedSessionCommand } from './session-command-codec';
export { AUTHENTICATED_SESSION_COMMAND_VERSION, authenticatedSessionCommandSchema, sessionCommandInputSha256 } from './session-command-codec';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const serialized = (value: unknown) => JSON.stringify(value);
const error = (status: number, code: string): never => { throw new SessionCommandError(status, code); };
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => { const result = schema.safeParse(input); return result.success ? result.data : error(400, 'SESSION_COMMAND_INVALID'); };
const idempotentSessionId = (context: AuthenticatedRequestContext, key: string) => {
  const bytes = createHash('sha256').update(JSON.stringify(['isolated-session-v1', context.account.ownerId, context.scope, key])).digest();
  bytes[6] = bytes[6] & 15 | 80; bytes[8] = bytes[8] & 63 | 128; const h = bytes.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export interface VerifiedSessionPreparation {
  context: InterviewContext; bank: PreparedQuestionBank;
  /** Actual D run/version/source/target/profile pins supplied by the trusted
   * preparation reader, not by a browser JSON object. */
  pins: Record<string, unknown>; sourceRevision?: string | null;
  assertCurrent(): Promise<void>;
}
export interface SyntheticCapture {
  write(bytes: Buffer): Promise<void> | void;
  finish(): Promise<{ rawTranscript: string; observations?: TranscriptObservation[]; confirmed: boolean; errorCode?: string }>;
  close(): Promise<void> | void;
}
export interface IsolatedSessionProviders {
  kind: 'synthetic';
  forSession(pins: Readonly<Record<string, unknown>>): SessionTurnProviders;
  classify: typeof import('../providers/single-core-runtime').classifySingleCoreAnswerCandidate;
  openCapture(input: { sessionId: string; turnId: string; answerId: string; captureRevision: number; streamId: string; writerGeneration: string }): Promise<SyntheticCapture>;
}
export interface IsolatedSessionServiceOptions {
  environment: 'isolated-session-writer'; identity: RequestIdentityBoundary; repository: SessionCommandRepository;
  prepare(context: AuthenticatedRequestContext): Promise<VerifiedSessionPreparation>;
  readPinnedBank(context: AuthenticatedRequestContext, snapshot: SessionCommandSnapshot, session: InterviewSession, fixedContext: InterviewContext): Promise<PreparedQuestionBank>;
  assertPinned(context: AuthenticatedRequestContext, snapshot: SessionCommandSnapshot): Promise<void>;
  mintEnrollment(context: AuthenticatedRequestContext, input: SessionEnrollment): SessionEnrollmentCapability;
  providers: IsolatedSessionProviders;
  /** Frozen when a new session is enrolled. No command reads later env values. */
  models: Readonly<{ question: string; realtime: string; review: string; evaluation: string }>;
  now?: () => number;
  /** Trusted fault/barrier hook; never selected by any request/document field. */
  observe?: (phase: 'before-begin' | 'after-begin' | 'before-external' | 'after-external' | 'before-commit' | 'after-commit', detail: { action: string; sessionId: string; key: string; operationId?: string }) => Promise<void>;
}
type Capture = { provider: SyntheticCapture; streamId: string; turnId: string; answerId: string; captureRevision: number; generation: string; baseTranscript: string; bytes: number; connectionToken?: string;
  finishCache: CaptureFinishCache<Awaited<ReturnType<SyntheticCapture['finish']>>>; closed?: boolean; receipt: Promise<void>; markFinishReceived(serverNowMs: number): void; markerReceivedAt?: number };
const captureStartSchema = z.object({ turnId: z.string().uuid(), answerId: z.string().min(1).max(160), captureRevision: z.number().int().positive(), staged: z.boolean().optional() }).strict();
const answerSchema = captureStartSchema.omit({ staged: true }).extend({ candidateId: z.string().uuid().optional(), submissionAttemptId: z.string().uuid().optional(), metrics: z.unknown().optional(), elapsedMs: z.number().finite().min(0).max(86_400_000), endingObservation: answerEndingObservationSchema.optional() });
const endSchema = z.object({ metrics: z.unknown().optional(), elapsedMs: z.number().finite().min(0).max(86_400_000).optional() }).strict();
/** The answer fact pins captured text/parts. End-time metric backups have their
 * own session/event/frozen-input hashes under the unchanged local policy. */
const answerSourceSha = (turn: RecordedTurn) => sha(serialized({ rawTranscript: turn.rawTranscript, captureParts: turn.metadata.captureParts, endingObservation: turn.metadata.answerEndingObservation }));
class DurableReceiptReplay { constructor(readonly receipt: SessionCommandReceipt) {} }

/** E composition only. It owns no filesystem SessionStore/evaluation queue and
 * cannot be auto-enabled by operational env vars. Domain transitions and the
 * full question preparer are the same functions used by local realtime. */
export function createIsolatedSessionService(options: IsolatedSessionServiceOptions) {
  if (options.environment !== 'isolated-session-writer' || options.providers.kind !== 'synthetic' || process.env.NODE_ENV === 'production' ||
    !['question', 'realtime', 'review', 'evaluation'].every(key => typeof Reflect.get(options.models ?? {}, key) === 'string' && Reflect.get(options.models, key).trim().length)) error(503, 'ISOLATED_SESSION_COMPOSITION_REQUIRED');
  const { identity, repository } = options, now = options.now ?? Date.now;
  const captures = new Map<string, Capture>();
  const finalizations = new Map<string, Promise<unknown>>();
  const counters = { localSessionWrites: 0, localEvaluationEnqueues: 0, paidProviderCalls: 0, syntheticCaptureBytes: 0, providerAttempts: 0 };
  async function current(context: AuthenticatedRequestContext) {
    const value = await identity.revalidate(context); if (value.mode !== 'authenticated' || !value.scope) return error(403, 'SESSION_SCOPE_REQUIRED'); return value;
  }
  async function read(context: AuthenticatedRequestContext, id: string) {
    const checked = await current(context), value = await repository.read(checked, id); if (!value) return error(404, 'SESSION_NOT_FOUND');
    identity.assertResource(checked, value.binding); return value;
  }
  function decode(snapshot: SessionCommandSnapshot) {
    if (sha(snapshot.sessionJson) !== snapshot.sessionSha256 || sha(snapshot.contextJson) !== snapshot.contextSnapshotSha256 || sha(snapshot.pinsJson) !== snapshot.pinsSha256) error(409, 'SESSION_SNAPSHOT_INTEGRITY');
    const { session, context } = decodeAuthenticatedSessionEnvelope({ version: AUTHENTICATED_SESSION_ENVELOPE_VERSION, sessionJson: snapshot.sessionJson,
      sessionSha256: snapshot.sessionSha256, contextJson: snapshot.contextJson, contextSha256: snapshot.contextSnapshotSha256 }, snapshot.binding.ownerId);
    assertAuthenticatedSessionOwner(session, snapshot.binding.ownerId);
    if (session.id !== snapshot.binding.sessionId || session.runtime!.contextSnapshotSha256 !== snapshot.contextSnapshotSha256 || snapshotHash(context) !== snapshot.contextSnapshotSha256 || session.runtime!.engineVersion !== context.manifest.rulesVersion) error(409, 'SESSION_CONTEXT_MISMATCH');
    return { session, context, pins: JSON.parse(snapshot.pinsJson) as Record<string, unknown>, serverNowMs: Date.parse(snapshot.serverNow), lastDisconnectedAt: snapshot.lastDisconnectedAt };
  }
  function response(snapshot: SessionCommandSnapshot) {
    const { session } = decode(snapshot);
    return { version: AUTHENTICATED_SESSION_COMMAND_VERSION, sessionId: session.id, revision: snapshot.revision, writerGeneration: snapshot.writerGeneration,
      status: session.status, evaluationStatus: session.evaluationStatus, contextSnapshotSha256: snapshot.contextSnapshotSha256,
      recovery: recoveryProjection(session), evaluationHandoff: snapshot.handoff ? { state: snapshot.handoff.state, intentId: snapshot.handoff.intentId, payloadSha256: snapshot.handoff.payloadSha256 } : null,
      evaluationJob: null, writer: snapshot.writer };
  }
  function receiptValue(receipt: SessionCommandReceipt) {
    if (sha(receipt.resultJson) !== receipt.resultSha256) error(409, 'SESSION_RECEIPT_INTEGRITY');
    return { version: AUTHENTICATED_SESSION_COMMAND_VERSION, operationId: receipt.operationId, revision: receipt.committedRevision, writerGeneration: receipt.writerGeneration,
      key: receipt.key, inputSha256: receipt.inputSha256, replay: receipt.replay, result: JSON.parse(receipt.resultJson) as unknown };
  }
  function acceptedCaptureScope(snapshot: SessionCommandSnapshot): SessionEndCaptureScope | null {
    if (!snapshot.endIntent) return null;
    const accepted = JSON.parse(snapshot.endIntent.inputJson) as { metrics?: { captureFinishScope?: unknown } };
    return accepted.metrics?.captureFinishScope === undefined ? null : parse(sessionEndCaptureScopeSchema, accepted.metrics.captureFinishScope);
  }
  function captureMatches(scope: SessionEndCaptureScope | null, capture: Capture) {
    return Boolean(scope && scope.turnId === capture.turnId && scope.answerId === capture.answerId && scope.captureRevision === capture.captureRevision);
  }
  function mayReceiveEndTail(snapshot: SessionCommandSnapshot, capture: Capture, connectionToken: string) {
    return Boolean(snapshot.endIntent && !snapshot.handoff && capture.generation === snapshot.writerGeneration &&
      capture.connectionToken && capture.connectionToken === connectionToken && captureMatches(acceptedCaptureScope(snapshot), capture) &&
      Date.parse(snapshot.serverNow) <= Date.parse(snapshot.endIntent.acceptedAt) + 2_000);
  }
  async function closeCapture(capture: Capture) { if (!capture.closed) { capture.closed = true; await capture.provider.close(); } }
  function actionKind(action: string): SessionCommandKind {
    if (action === 'events' || action === 'timings') return 'event'; if (action.startsWith('capture-')) return 'capture'; if (action === 'closing') return 'closing';
    if (action === 'answer-candidate' || action === 'answer') return 'answer'; if (action === 'end') return 'end-accept';
    if (['create', 'next', 'recover', 'end-finalize'].includes(action)) return action as SessionCommandKind;
    return error(503, 'SESSION_OPERATION_UNSUPPORTED');
  }
  function commandIdentity(sessionId: string, action: string, input: AuthenticatedSessionCommand): SessionCommandIdentity {
    const p = input.payload && typeof input.payload === 'object' ? input.payload as Record<string, unknown> : {};
    const semantic = action === 'end' || action === 'end-finalize' ? action : action === 'events' ? `${action}:${String(p.eventId)}` :
      ['answer', 'answer-candidate', 'next', 'capture-start', 'capture-finish'].includes(action) ? `${action}:${String(p.turnId)}:${String(p.answerId)}:${String(p.captureRevision ?? 0)}` : `${action}:${input.key}`;
    return { sessionId, kind: actionKind(action), key: input.key, inputSha256: sessionCommandInputSha256(action, input.payload), semanticKey: semantic,
      semanticSha256: sessionCommandInputSha256(action, input.payload) };
  }
  const hook = async (phase: Parameters<NonNullable<typeof options.observe>>[0], action: string, id: string, key: string, intent?: SessionCommandIntent) => options.observe?.(phase, { action, sessionId: id, key, operationId: intent?.operationId });
  async function execute(context: AuthenticatedRequestContext, snapshot: SessionCommandSnapshot, action: string, input: AuthenticatedSessionCommand,
    transition: (state: ReturnType<typeof decode>, save: () => Promise<void>, emit: (event: ConversationEvent) => void, intent: () => SessionCommandIntent,
      disposeOnFailure: (close: () => Promise<void>) => void) => Promise<Partial<SessionCommandCommit> & { result: unknown; afterCommit?: () => Promise<void> }>) {
    const identifier = commandIdentity(snapshot.binding.sessionId, action, input);
    // Historical receipts precede current-state/version/stale checks. The
    // authoritative begin still creates aliases and rechecks access itself.
    if (!await repository.findCommitted(context, identifier)) preflight(decode(snapshot), action, input.payload);
    await hook('before-begin', action, identifier.sessionId, input.key);
    const start = await repository.beginIntent(context, { ...identifier, expectedRevision: input.expectedRevision, writerGeneration: input.writerGeneration, writerToken: snapshot.writerToken, resume: input.resume });
    if (start.status === 'committed') return receiptValue(start.receipt);
    let pending = start; const state = decode(start.snapshot), originalTurnCount = state.session.turns.length, events: SessionMandatoryEvent[] = [];
    preflight(state, action, input.payload);
    const emit = (event: ConversationEvent) => events.push({ eventId: event.eventId ?? `${pending.intent.operationId}:${events.length}:${randomUUID()}`, kind: event.type, payloadJson: serialized(event) });
    const checkpointEvent = () => ({ eventId: `${pending.intent.operationId}:checkpoint:${pending.snapshot.revision}`, kind: 'session.checkpoint', payloadJson: serialized({ action, operationId: pending.intent.operationId, attemptId: pending.intent.attemptId, sessionSha256: sha(serialized(state.session)) }) });
    const save = async () => {
      // The shared preparer saves its terminal turn as well as unfinished
      // checkpoints. Publish that new turn only in commit together with its
      // mandatory facts and durable response; a progress row is not success.
      if ((action === 'create' || action === 'next') && state.session.turns.length > originalTurnCount) return;
      if (!evaluationInputFrozen(state.session)) state.session.updatedAt = new Date(now()).toISOString();
      const result = await repository.persistProgress(context, pending.intent, { sessionJson: serialized(state.session), events: [...events.splice(0), checkpointEvent()] });
      if (result.status === 'committed') return error(409, 'SESSION_OPERATION_ALREADY_COMMITTED'); pending = result; state.serverNowMs = Date.parse(result.snapshot.serverNow);
    };
    await hook('after-begin', action, identifier.sessionId, input.key, pending.intent);
    const releases: (() => Promise<void>)[] = []; let committed = false;
    try {
      const result = await transition(state, save, emit, () => pending.intent, close => releases.push(close));
      await options.assertPinned(context, pending.snapshot);
      const { result: value, afterCommit, ...extra } = result;
      const commit: SessionCommandCommit = { ...extra, sessionJson: serialized(state.session), events: [...events, checkpointEvent()], resultJson: serialized(value) };
      await hook('before-commit', action, identifier.sessionId, input.key, pending.intent);
      const receipt = await repository.commit(context, pending.intent, commit); committed = true;
      await afterCommit?.(); await hook('after-commit', action, identifier.sessionId, input.key, pending.intent);
      releases.length = 0; return receiptValue(receipt);
    } catch (cause) {
      await Promise.all(releases.map(close => close().catch(() => {})));
      if (cause instanceof DurableReceiptReplay) { await read(context, identifier.sessionId); return receiptValue(cause.receipt); }
      if (committed) throw new SessionCommandError(503, 'SESSION_COMMIT_RESULT_UNAVAILABLE');
      throw cause;
    }
  }

  async function create(context: AuthenticatedRequestContext, raw: unknown) {
    const input = parse(authenticatedSessionCommandSchema, raw); parse(z.object({}).strict(), input.payload);
    const checked = await current(context), inputSha256 = sessionCommandInputSha256('create', input.payload);
    let snapshot = await repository.findCreation(checked, input.key, inputSha256);
    if (!snapshot) {
      const prepared = await options.prepare(checked); await prepared.assertCurrent();
      if (prepared.context.errors.length || !prepared.context.interviewOverview || prepared.bank.status !== 'ready') error(409, 'SESSION_PREPARATION_REQUIRED');
      const id = idempotentSessionId(checked, input.key), runtime = createAuthenticatedSessionRuntime(prepared.context, checked.account.ownerId, new Date(now()).toISOString());
      const history = 'list' in repository && typeof repository.list === 'function' ? (await repository.list(checked) as SessionCommandSnapshot[]).map(row => decode(row).session) : [];
      const plan = createSessionQuestionPlan(prepared.context, prepared.bank, { sessionSeed: id, history, mode: 'mock', scope: { ownerId: checked.account.ownerId, studentId: checked.scope!.studentId, supportTargetId: checked.scope!.supportTargetId } });
      const session = createInterviewSession(prepared.context, plan, runtime, { id, now: new Date(now()).toISOString() });
      const pins = { ...prepared.pins, models: { ...options.models }, sessionAuthority: { sessionId: id, ownerId: checked.account.ownerId, ...checked.scope }, bank: { key: prepared.bank.key, contentSha256: prepared.bank.contentSha256, sourceFingerprint: prepared.bank.sourceFingerprint, questionModel: prepared.bank.questionModel },
        runtimeVersion: runtime.version, commandVersion: AUTHENTICATED_SESSION_COMMAND_VERSION, evaluationPipeline: EVALUATION_PIPELINE_VERSION };
      const enrollment: SessionEnrollment = { sessionId: id, creationKey: input.key, inputSha256, sessionJson: serialized(session), contextJson: serialized(prepared.context), pinsJson: serialized(pins), sourceSha256: prepared.bank.sourceFingerprint,
        ...(Object.hasOwn(prepared, 'sourceRevision') ? { sourceRevision: prepared.sourceRevision } : {}) };
      snapshot = await repository.enroll(checked, enrollment, options.mintEnrollment(checked, enrollment));
    }
    // A lost creation response replays before current CAS/source selection.
    if (!snapshot.created && input.resume) snapshot = await repository.claimWriter(checked, { sessionId: snapshot.binding.sessionId, expectedRevision: snapshot.revision, writerGeneration: snapshot.writerGeneration, writerToken: snapshot.writerToken });
    return execute(checked, snapshot, 'create', { ...input, expectedRevision: input.resume && !snapshot.created ? snapshot.revision : input.expectedRevision, writerGeneration: input.resume && !snapshot.created ? snapshot.writerGeneration : input.writerGeneration }, async (state, save, emit, intent) => {
      const preparer = makePreparer(checked, snapshot!, state, save, emit);
      let first: RecordedTurn | undefined = state.session.turns[0];
      if (state.session.turns.length > 1) return error(409, 'SESSION_CREATE_ALREADY_PREPARED');
      if (!first) {
        counters.providerAttempts++; await hook('before-external', 'create', state.session.id, input.key, intent());
        first = (await preparer(state.session, false, undefined, true)) ?? undefined;
        await hook('after-external', 'create', state.session.id, input.key, intent());
      }
      if (!first) return error(409, 'SESSION_FIRST_QUESTION_REQUIRED');
      if (first.acknowledgement && first.acknowledgementAudioUrl) state.session.runtime!.opening = { id: randomUUID(), questionTurnId: first.id, text: first.acknowledgement, audioUrl: first.acknowledgementAudioUrl, interviewerId: first.interviewerId };
      checkpointSession(state.session, 'question_prepared'); state.session.conversationLedger = buildConversationLedger(state.session);
      emit({ eventId: 'session-created', type: 'session.created', actor: 'server', payload: { contextSnapshotSha256: snapshot!.contextSnapshotSha256, bankKey: state.session.plan!.poolKey } });
      return { result: { sessionId: state.session.id, turn: first, durationSeconds: state.session.durationSeconds, mainQuestionTarget: state.session.mainQuestionTarget, contextSnapshotSha256: snapshot!.contextSnapshotSha256 } };
    });
  }
  function makePreparer(context: AuthenticatedRequestContext, snapshot: SessionCommandSnapshot, state: ReturnType<typeof decode>, save: () => Promise<void>, emit: (event: ConversationEvent) => void) {
    const providers = options.providers.forSession(state.pins);
    return createSessionTurnPreparer({ ownerId: snapshot.binding.ownerId, contextFor: async () => state.context,
      async requireQuestionBank() {
        const bank = await options.readPinnedBank(context, snapshot, state.session, state.context);
        if (bank.key !== state.session.plan?.poolKey || bank.contentSha256 !== state.session.plan?.poolContentSha256) return error(409, 'SESSION_PINNED_BANK_CHANGED'); return bank;
      }, save: async () => save(), journal: (_session, event) => emit(event), observeSessionUsage: (_session, stage, attemptId, observation) => {
        state.session.providerUsageLedger = recordSessionProviderUsage(state.session.providerUsageLedger, { stage, attemptId, observation });
        emit({ eventId: `provider:${attemptId}`, type: 'provider.usage', actor: 'provider', payload: { stage, attemptId, observation } });
      },
      preparedDrafts: new Map<string, PreparedWork>(), audioOwners: new Map<string, string>(), HttpError: SessionDomainError, providers });
  }
  function selectedTurn(session: InterviewSession, p: { turnId: string; answerId: string; captureRevision: number }) {
    const turn = session.turns.at(-1); if (!turn || turn.id !== p.turnId || turn.answerId !== p.answerId || turn.metadata.answerCaptureRevision !== p.captureRevision) return error(409, 'SESSION_CAPTURE_SCOPE_CHANGED'); return turn;
  }
  function answerSource(state: ReturnType<typeof decode>, payload: unknown) {
    const session = state.session, p = parse(answerSchema, payload), turn = selectedTurn(session, p); assertCaptureConfirmed(turn);
    if (!['paused', 'finalized'].includes(turn.transcriptStatus ?? '')) error(409, 'CAPTURE_FINAL_NOT_CONFIRMED');
    const candidate = turn.metadata.answerCandidateId ? session.runtime!.answerCandidates?.[turn.metadata.answerCandidateId] : undefined;
    if (turn.metadata.answerSubmissionMode === 'staged-v2') {
      if (!candidate || p.candidateId !== candidate.id || !['advance_ready', 'advancing'].includes(candidate.status)) return error(409, 'ANSWER_CANDIDATE_REQUIRED');
      assertCandidateSource(turn, candidate);
      if (p.endingObservation !== undefined && !isDeepStrictEqual(p.endingObservation, candidate.endingObservation)) error(409, 'ANSWER_CANDIDATE_ENDING_CHANGED');
      if (candidate.decision) options.providers.forSession(state.pins).assertSingleCoreCandidateBinding(state.context, session, candidate.decision, session.runtime!.runtimePolicy?.mode ?? 'compiled');
    }
    if (candidate?.status === 'continuing') error(409, 'ANSWER_CONTINUATION_REQUIRED');
    return { p, turn, candidate };
  }
  function nextSource(session: InterviewSession, payload: unknown) {
    const p = parse(nextRequestSchema, payload), turn = session.turns.at(-1);
    if (!turn || turn.id !== p.turnId || turn.answerId !== p.answerId || !isFinalizedAnswer(turn)) return error(409, 'ANSWER_FINAL_REQUIRED');
    if (p.captureRevision !== undefined && p.captureRevision !== turn.metadata.answerCaptureRevision) error(409, 'SESSION_CAPTURE_SCOPE_CHANGED');
    if (turn.metadata.answerSubmissionMode === 'staged-v2') {
      const candidate = p.candidateId ? session.runtime!.answerCandidates?.[p.candidateId] : undefined;
      if (!candidate || candidate.id !== turn.metadata.answerCandidateId || candidate.captureRevision !== p.captureRevision || !['advance_ready', 'advancing'].includes(candidate.status)) return error(409, 'ANSWER_CANDIDATE_REQUIRED');
      assertCandidateSource(turn, candidate);
      if (candidate.decision && candidate.decision.kind !== 'ADVANCE') error(409, 'ANSWER_CONTINUATION_REQUIRED');
    }
    return { p, turn };
  }
  /** Synchronous domain gates only; no intent/key is written for a request that
   * cannot act on the current turn. Actual transitions repeat the same gates
   * after begin, and final SQL CAS remains the write authority. */
  function preflight(state: ReturnType<typeof decode>, action: string, payload: unknown) {
    const session = state.session, frozen = evaluationInputFrozen(session);
    if (action !== 'events' && session.runtime!.engineVersion !== interviewConfig.rulesVersion) error(409, 'SESSION_ENGINE_VERSION_CHANGED');
    if (frozen && action === 'recover') error(409, 'SESSION_FROZEN_RECOVERY_READ_ONLY');
    if (!['create', 'end', 'end-finalize', 'events', 'timings', 'closing', 'recover'].includes(action) && (frozen || session.runtime!.endRequestedAt)) error(409, 'SESSION_END_ACCEPTED');
    if (action === 'answer') answerSource(state, payload);
    if (action === 'next') nextSource(session, payload);
    if (action === 'capture-start') {
      const p = parse(captureStartSchema, payload), turn = session.turns.at(-1); if (!turn || turn.id !== p.turnId) return error(409, 'SESSION_TURN_NOT_FOUND');
      if (turn.answerId && turn.answerId !== p.answerId) error(409, 'SESSION_ANSWER_ID_CHANGED');
      assertCaptureMayStart(session, turn); if (p.captureRevision !== (turn.metadata.answerCaptureRevision ?? 0) + 1) error(409, 'SESSION_CAPTURE_REVISION');
    }
    if (action === 'capture-finish') {
      const p = parse(captureStartSchema.omit({ staged: true }).extend({ submissionAttemptId: z.string().uuid().optional() }), payload), turn = selectedTurn(session, p), capture = captures.get(session.id);
      // Database generation is a separate authority from the runtime epoch.
      // Refuse another server inventing a failed finish for this PCM producer.
      if (!capture || capture.streamId !== turn.metadata.lastStreamId) error(409, 'SESSION_CAPTURE_OWNER_REQUIRED');
    }
    if (action === 'answer-candidate') {
      const p = parse(answerCandidateRequestSchema, payload), turn = selectedTurn(session, p); if (turn.transcriptStatus !== 'paused') error(409, 'CAPTURE_FINAL_NOT_CONFIRMED'); assertCaptureConfirmed(turn);
    }
  }
  async function finishCapture(session: InterviewSession, snapshot: SessionCommandSnapshot, end?: { deadlineAt: string; serverNowMs: number; attemptId: string }) {
    const turn = session.turns.at(-1), capture = captures.get(session.id);
    if (!turn || !capture || capture.generation !== snapshot.writerGeneration || capture.streamId !== turn.metadata.lastStreamId) {
      if (turn?.transcriptStatus === 'streaming') turn.transcriptStatus = 'error'; return false;
    }
    try {
      const finish: () => ReturnType<SyntheticCapture['finish']> = () => capture.provider.finish().catch(() => ({ rawTranscript: '', confirmed: false, errorCode: 'CAPTURE_PROVIDER_FAILED' }));
      const result = end ? await captureFinishForEnd(capture.finishCache, finish, end) : await cachedCaptureFinish(capture.finishCache, finish);
      if (evaluationInputFrozen(session) || !captureFinishMayPublish(capture.finishCache)) return false;
      turn.rawTranscript = concatenateStreamTranscript(capture.baseTranscript, result.rawTranscript);
      turn.sttObservations = (result.observations ?? []).reduce(mergeTranscriptObservation, turn.sttObservations ?? []);
      if (!result.confirmed || result.errorCode) { turn.transcriptStatus = 'error'; return false; }
      capturePart(turn, capture.streamId, result.rawTranscript); turn.transcriptStatus = turn.metadata.answerSubmissionMode === 'staged-v2' ? 'paused' : 'finalized'; return true;
    } finally {
      // Keep a confirmed result until its command commits or the owned socket
      // closes. A CAS/95s failure must not erase bytes that an accepted /end can
      // still drain; the provider itself is finished exactly once per capture.
      await closeCapture(capture);
    }
  }

  async function command(context: AuthenticatedRequestContext, binding: SessionAccessBinding, action: string, raw: unknown, connectionToken?: string): Promise<unknown> {
    const input = parse(authenticatedSessionCommandSchema, raw), checked = await current(context), snapshot = await read(checked, binding.sessionId);
    if (action === 'retry-evaluation') return error(503, 'SESSION_OPERATION_UNSUPPORTED');
    if (action === 'end') return end(checked, snapshot, input);
    return execute(checked, snapshot, action, input, async (state, save, emit, intent, disposeOnFailure) => {
      const session = state.session, frozen = evaluationInputFrozen(session);
      if (frozen && action === 'recover') return error(409, 'SESSION_FROZEN_RECOVERY_READ_ONLY');
      if (!['events', 'timings', 'closing', 'recover'].includes(action) && (frozen || session.runtime!.endRequestedAt)) error(409, 'SESSION_END_ACCEPTED');
      if (action === 'recover') {
        parse(z.object({}).strict(), input.payload);
        if (state.lastDisconnectedAt) session.runtime!.checkpoint.disconnectedAt = state.lastDisconnectedAt;
        const restored = restoreAuthenticatedSession(session, binding.ownerId, now());
        delete restored.runtime!.checkpoint.disconnectedAt;
        Object.assign(session, restored); checkpointSession(session, 'recovered', new Date(now()).toISOString());
        emit({ type: 'session.restored', actor: 'server', payload: { epoch: session.runtime!.epoch, rawAudioRestored: false } });
        return { rotateWriter: true, result: { recovery: recoveryProjection(session) } };
      }
      if (action === 'events') {
        const event = parse(clientConversationEventSchema, input.payload);
        const reference = event.payload && typeof event.payload === 'object' ? (event.payload as { closingReceipt?: { key?: string; inputSha256?: string } }).closingReceipt : undefined;
        let closing: ClosingUtterance | undefined;
        if (reference) {
          if (!reference.key || !/^[a-f0-9]{64}$/u.test(reference.inputSha256 ?? '')) return error(400, 'SESSION_CLOSING_RECEIPT_INVALID');
          const receipt = await repository.receiptByKey(checked, { sessionId: session.id, key: reference.key, inputSha256: reference.inputSha256! });
          if (!receipt || receipt.kind !== 'closing') return error(409, 'SESSION_CLOSING_RECEIPT_INVALID');
          closing = (JSON.parse(receipt.resultJson) as { closingUtterance?: ClosingUtterance }).closingUtterance;
          if (!closing || closing.id !== event.turnId) return error(409, 'SESSION_CLOSING_RECEIPT_INVALID');
        }
        const result = applySessionClientEvent(session, event, { now: () => new Date(now()).toISOString(), onEvent: emit,
          ...(closing ? { closingFallback: closing, canonicalTurn: (_session: InterviewSession, id: string) => id === closing!.id ? { questionText: null, acknowledgement: closing!.text, interviewerId: closing!.interviewerId } : null } : {}) }); emit(result.event);
        return { result: { accepted: true, frozenInputUnchanged: frozen } };
      }
      if (action === 'timings') {
        const p = parse(z.object({ turnId: z.string().uuid(), clientTimings: z.record(z.string(), z.number().finite().nonnegative()) }).strict(), input.payload), turn = session.turns.find(t => t.id === p.turnId);
        if (!turn) error(409, 'SESSION_TURN_NOT_FOUND'); if (!frozen) turn!.metadata.clientTimings = { ...turn!.metadata.clientTimings, ...p.clientTimings };
        emit({ type: 'timings.observed', actor: 'client', turnId: p.turnId, payload: { ...p, lateAfterEvaluationFreeze: frozen } }); return { result: { observed: true, frozenInputUnchanged: frozen } };
      }
      if (action === 'closing') {
        const p = parse(z.object({ reason: z.enum(['time_expired', 'user_ended']).optional(), elapsedMs: z.number().finite().nonnegative().max(86_400_000).optional() }).strict(), input.payload);
        const presentation = frozen ? structuredClone(session) : session;
        if (!frozen) {
          presentation.elapsedMs = Math.max(presentation.elapsedMs, p.elapsedMs ?? 0); presentation.runtime!.epoch++; presentation.status = 'ending';
          if (captures.has(session.id)) await finishCapture(presentation, snapshot);
          const captured = presentation.turns.at(-1); if (captured?.transcriptStatus === 'paused') assertCaptureConfirmed(captured);
          finalizeCapturedTurnForEnd(captured, false); checkpointSession(presentation, 'closing_prepared'); await save();
        }
        const duration = sessionDurationSeconds(presentation, state.context.interviewOverview?.durationSeconds ?? NaN);
        const providers = options.providers.forSession(state.pins), closing = createSessionClosingPreparer({ ownerId: binding.ownerId,
          synthesizeSpeech: providers.synthesizeSpeech, interviewerVoiceDefaults: providers.interviewerVoiceDefaults, audioOwners: new Map(), journal: (_session, event) => emit(event), HttpError: SessionDomainError });
        const value = await closing(presentation, presentation.elapsedMs >= duration * 1000 ? 'time_expired' : p.reason ?? 'user_ended');
        return { result: { closingUtterance: value } };
      }
      if (action === 'capture-start') {
        const p = parse(captureStartSchema, input.payload), turn = session.turns.at(-1); if (!turn || turn.id !== p.turnId) error(409, 'SESSION_TURN_NOT_FOUND');
        if (turn!.answerId && turn!.answerId !== p.answerId) error(409, 'SESSION_ANSWER_ID_CHANGED');
        assertCaptureMayStart(session, turn!); if (p.captureRevision !== (turn!.metadata.answerCaptureRevision ?? 0) + 1) error(409, 'SESSION_CAPTURE_REVISION');
        const streamId = randomUUID(), baseTranscript = turn!.rawTranscript ?? '';
        turn!.answerId = p.answerId; turn!.metadata.answerCaptureRevision = p.captureRevision; turn!.metadata.lastStreamId = streamId;
        delete turn!.metadata.answerCandidateId;
        if (p.staged) turn!.metadata.answerSubmissionMode = 'staged-v2'; turn!.metadata.answerCommitStatus = 'capturing'; turn!.transcriptStatus = 'streaming';
        checkpointSession(session, 'starting_capture'); await save();
        counters.providerAttempts++; await hook('before-external', action, session.id, input.key, intent());
        const provider = await options.providers.openCapture({ sessionId: session.id, ...p, streamId, writerGeneration: snapshot.writerGeneration });
        disposeOnFailure(async () => { await provider.close(); if (captures.get(session.id)?.provider === provider) captures.delete(session.id); });
        await hook('after-external', action, session.id, input.key, intent());
        checkpointSession(session, 'listening');
        emit({ type: 'stt.started', actor: 'provider', turnId: p.turnId, answerId: p.answerId, payload: { streamId, captureRevision: p.captureRevision, attemptId: intent().attemptId } });
        return { afterCommit: async () => {
          const latest = await read(checked, session.id), active = decode(latest).session.turns.at(-1);
          if (latest.writerGeneration !== snapshot.writerGeneration || active?.metadata.lastStreamId !== streamId || latest.endIntent || latest.handoff) { await provider.close(); return; }
          let received!: () => void;
          const capture: Capture = { provider, streamId, turnId: p.turnId, answerId: p.answerId, captureRevision: p.captureRevision, generation: snapshot.writerGeneration, baseTranscript, bytes: 0, connectionToken, finishCache: {},
            receipt: new Promise<void>(resolve => { received = resolve; }), markFinishReceived(serverNowMs) { if (capture.markerReceivedAt === undefined) { capture.markerReceivedAt = serverNowMs; received(); } } };
          captures.set(session.id, capture);
        }, result: { started: true, turnId: p.turnId, answerId: p.answerId, captureRevision: p.captureRevision } };
      }
      if (action === 'capture-finish') {
        const p = parse(captureStartSchema.omit({ staged: true }).extend({ submissionAttemptId: z.string().uuid().optional() }), input.payload), turn = selectedTurn(session, p);
        const work = turn.metadata.answerSubmissionMode === 'staged-v2' ? getDurableSubmissionWork(session, p, p.submissionAttemptId, state.serverNowMs, { allowCreate: true }) : undefined;
        if (work) { checkpointSession(session, 'finalizing_capture'); await save(); }
        let confirmed: boolean;
        try {
          await hook('before-external', action, session.id, input.key, intent());
          confirmed = work ? await work.workContext.run(Infinity, () => finishCapture(session, snapshot)) : await finishCapture(session, snapshot);
          await hook('after-external', action, session.id, input.key, intent()); work?.workContext.assertLive();
        } finally { work?.workContext.complete(); }
        checkpointSession(session, confirmed ? 'transcript_received' : 'capture_error');
        emit({ type: confirmed ? 'stt.final' : 'error', actor: 'provider', turnId: turn.id, answerId: turn.answerId, payload: { confirmed, rawTranscript: turn.rawTranscript ?? '', transcriptStatus: turn.transcriptStatus } });
        return { result: { confirmed, transcriptStatus: turn.transcriptStatus, rawTranscript: turn.rawTranscript ?? '', captureRevision: p.captureRevision, ...(work ? { submissionAttemptId: work.record.attemptId } : {}) } };
      }
      if (action === 'answer-candidate') {
        const p = parse(answerCandidateRequestSchema, input.payload), turn = selectedTurn(session, p); if (turn.transcriptStatus !== 'paused') error(409, 'CAPTURE_FINAL_NOT_CONFIRMED'); assertCaptureConfirmed(turn);
        for (const event of p.clientEvents ?? []) emit(applySessionClientEvent(session, event, { onEvent: emit }).event);
        const candidate = { id: randomUUID(), turnId: p.turnId, answerId: p.answerId, captureRevision: p.captureRevision, sourceTranscriptSha256: transcriptHash(turn.rawTranscript ?? ''), status: 'deciding' as const, createdAt: new Date(now()).toISOString(), endingObservation: p.endingObservation };
        session.runtime!.answerCandidates ??= {}; session.runtime!.answerCandidates[candidate.id] = candidate;
        turn.metadata.answerCandidateId = candidate.id; turn.metadata.answerEndingObservation = p.endingObservation; turn.metadata.answerCommitStatus = 'deciding';
        const submission = getDurableSubmissionWork(session, p, p.submissionAttemptId, state.serverNowMs), work = submission.workContext;
        session.elapsedMs = Math.max(session.elapsedMs, p.elapsedMs); turn.metrics = answerMetrics(p.answerId, turn.rawTranscript ?? '', p.metrics); await save();
        const duration = sessionDurationSeconds(session, state.context.interviewOverview?.durationSeconds ?? NaN);
        try {
          await hook('before-external', action, session.id, input.key, intent()); counters.providerAttempts++;
          const decision = session.elapsedMs < duration * 1000 ? await work.run(Infinity, () => options.providers.classify(state.context, session, { text: turn.rawTranscript ?? '', captureRevision: p.captureRevision, endingObservation: p.endingObservation, elapsedMs: session.elapsedMs },
            { workContext: work, policyMode: session.runtime!.runtimePolicy?.mode ?? 'compiled', allowFollowUp: mayAskFollowUp(session, duration, interviewConfig.maxFollowUps), allowClarification: mayAskClarification(session, duration), allowReplay: mayReplayQuestion(session, duration) })) : undefined;
          await hook('after-external', action, session.id, input.key, intent()); work.assertLive(); assertCandidateSource(turn, candidate);
          const completed = { ...candidate, decision, status: decision?.kind === 'CONTINUE' ? 'continuing' as const : 'advance_ready' as const }; session.runtime!.answerCandidates[candidate.id] = completed; turn.metadata.answerCommitStatus = completed.status;
          if (completed.status === 'continuing') completeDurableSubmissionWork(session, p, submission.record.attemptId);
          return { result: { action: completed.status === 'continuing' ? 'CONTINUE_ANSWER' : 'ADVANCE', candidateId: completed.id, captureRevision: p.captureRevision } };
        } finally { work.complete(); }
      }
      if (action === 'answer') {
        const { p, turn, candidate } = answerSource(state, input.payload);
        if (turn.metadata.answerSubmissionMode === 'staged-v2') {
          const deadline = getDurableSubmissionWork(session, p, p.submissionAttemptId, state.serverNowMs); deadline.workContext.assertLive(); deadline.workContext.complete();
        }
        if (turn.metadata.answerSubmissionMode === 'staged-v2') turn.metadata.answerEndingObservation = candidate!.endingObservation;
        else if (p.endingObservation) turn.metadata.answerEndingObservation = p.endingObservation;
        turn.transcriptStatus = 'finalized'; turn.metadata.answerCommitStatus = 'committed'; turn.metrics = answerMetrics(p.answerId, turn.rawTranscript ?? '', p.metrics);
        session.elapsedMs = Math.max(session.elapsedMs, p.elapsedMs); observeFinalizedAnswer(session, turn, { onEvent: emit }); checkpointSession(session, 'answer_committed');
        const answerHash = answerSourceSha(turn);
        return { answerFact: { turnId: p.turnId, answerId: p.answerId, captureRevision: p.captureRevision, inputSha256: answerHash }, result: { submitted: true, turnId: p.turnId, answerId: p.answerId, captureRevision: p.captureRevision, observation: turn.answerObservation } };
      }
      if (action === 'next') {
        const { p, turn } = nextSource(session, input.payload);
        const scope = { turnId: p.turnId, answerId: p.answerId, captureRevision: p.captureRevision ?? turn!.metadata.answerCaptureRevision ?? 1 };
        const submission = getDurableSubmissionWork(session, scope, p.submissionAttemptId, state.serverNowMs, { allowCreate: turn!.metadata.answerSubmissionMode !== 'staged-v2' }), work = submission.workContext;
        session.elapsedMs = Math.max(session.elapsedMs, p.elapsedMs); const key = `${session.id}:${p.turnId}:${p.answerId}`, epoch = session.runtime!.epoch;
        session.runtime!.operations[key] = { ...session.runtime!.operations[key], status: 'running', startedAt: session.runtime!.operations[key]?.startedAt ?? new Date(now()).toISOString(), epoch }; checkpointSession(session, 'preparing_next'); await save();
        try {
          await hook('before-external', action, session.id, input.key, intent()); counters.providerAttempts++;
          const next = await makePreparer(checked, snapshot, state, save, emit)(session, false, undefined, true, key, work);
          await hook('after-external', action, session.id, input.key, intent());
          let closingUtterance: ClosingUtterance | undefined;
          if (!next) {
            const duration = sessionDurationSeconds(session, state.context.interviewOverview?.durationSeconds ?? NaN), providers = options.providers.forSession(state.pins);
            const prepareClosing = createSessionClosingPreparer({ ownerId: binding.ownerId, synthesizeSpeech: providers.synthesizeSpeech,
              interviewerVoiceDefaults: providers.interviewerVoiceDefaults, audioOwners: new Map(), journal: (_session, event) => emit(event), HttpError: SessionDomainError });
            closingUtterance = await prepareClosing(session, session.elapsedMs >= duration * 1000 ? 'time_expired' : 'candidate_exhausted', work);
            session.status = 'ending';
          }
          const result = { turn: next, done: !next, ...(closingUtterance ? { closingUtterance } : {}) };
          work.assertNotCancelled(); completeDurableSubmissionWork(session, scope, submission.record.attemptId);
          session.runtime!.operations[key] = { ...session.runtime!.operations[key], status: 'committed', result }; checkpointSession(session, next ? 'question_prepared' : 'closing_prepared');
          return { result };
        } finally { work.complete(); }
      }
      return error(503, 'SESSION_OPERATION_UNSUPPORTED');
    });
  }
  async function end(context: AuthenticatedRequestContext, snapshot: SessionCommandSnapshot, input: AuthenticatedSessionCommand) {
    parse(endSchema, input.payload);
    await execute(context, snapshot, 'end', input, async (state, _save, emit, intent) => {
      const accepted = acceptSessionEndRequest(state.session, input.payload as z.infer<typeof endSchema>, { now: () => new Date(now()).toISOString() });
      emit({ type: 'session.end_requested', actor: 'server', payload: accepted }); const inputJson = serialized(accepted);
      return { endIntent: { intentId: intent().operationId, inputJson, inputSha256: sha(inputJson) }, result: { accepted: true, firstInput: accepted, evaluationHandoff: 'not-frozen-yet' } };
    });
    return finalizeEnd(context, await read(context, snapshot.binding.sessionId));
  }
  function finalizationInput(accepted: SessionCommandSnapshot): AuthenticatedSessionCommand {
    if (!accepted.endIntent) return error(409, 'END_INTENT_REQUIRED');
    return { version: AUTHENTICATED_SESSION_COMMAND_VERSION, key: 'finalize:' + accepted.endIntent.intentId, payload: { intentId: accepted.endIntent.intentId },
      expectedRevision: accepted.revision, writerGeneration: accepted.writerGeneration, resume: true };
  }
  async function finalizationReceipt(context: AuthenticatedRequestContext, snapshot: SessionCommandSnapshot) {
    const input = finalizationInput(snapshot);
    const receipt = await repository.receiptByKey(context, { sessionId: snapshot.binding.sessionId, key: input.key, inputSha256: sessionCommandInputSha256('end-finalize', input.payload) });
    if (receipt) await read(context, snapshot.binding.sessionId);
    return receipt;
  }
  /** A server without this PCM producer must not freeze a made-up empty answer
   * while its owner receives the ordered marker. A durable drain checkpoint
   * extends only the provider's existing 15s final-response cap, not the 2s
   * marker admission window. Polling holds no database transaction or client. */
  async function waitForCaptureOwner(context: AuthenticatedRequestContext, accepted: SessionCommandSnapshot) {
    const realDeadline = performance.now() + 17_000;
    let latest = accepted;
    while (true) {
      const receipt = await finalizationReceipt(context, latest); if (receipt) return { latest, receipt };
      const { session, serverNowMs } = decode(latest), last = session.turns.at(-1), scope = acceptedCaptureScope(latest);
      if (!scope || last?.transcriptStatus !== 'streaming' || performance.now() >= realDeadline) return { latest };
      const drain = session.runtime?.version === 'authenticated-session-runtime-v1' ? session.runtime.endCaptureDrain : undefined;
      const claimed = drain?.intentId === latest.endIntent!.intentId && drain.streamId === last.metadata.lastStreamId && drain.turnId === scope.turnId && drain.answerId === scope.answerId && drain.captureRevision === scope.captureRevision;
      const deadline = claimed ? Date.parse(drain!.providerDeadlineAt) : Date.parse(latest.endIntent!.acceptedAt) + 2_000;
      if (!Number.isFinite(deadline) || serverNowMs >= deadline) return { latest };
      await wait(Math.min(25, Math.max(1, deadline - serverNowMs)));
      latest = await read(context, accepted.binding.sessionId);
    }
  }
  async function finalizeEnd(context: AuthenticatedRequestContext, accepted: SessionCommandSnapshot): Promise<unknown> {
    const input = finalizationInput(accepted), flightKey = accepted.binding.sessionId + ':' + accepted.endIntent!.intentId;
    const existing = finalizations.get(flightKey); if (existing) return existing;
    const pending = (async () => {
      const last = decode(accepted).session.turns.at(-1), local = captures.get(accepted.binding.sessionId);
      const ownsCapture = local && local.generation === accepted.writerGeneration && local.streamId === last?.metadata.lastStreamId && last.transcriptStatus === 'streaming';
      if (!ownsCapture) {
        const remote = await waitForCaptureOwner(context, accepted);
        if (remote.receipt) return receiptValue(remote.receipt);
        accepted = remote.latest;
      }
      const finalize = { ...input, expectedRevision: accepted.revision, writerGeneration: accepted.writerGeneration };
      return execute(context, accepted, 'end-finalize', finalize, async (state, save, emit, intent, disposeOnFailure) => {
      await hook('before-external', 'end-finalize', state.session.id, finalize.key, intent());
      const active = state.session.turns.at(-1), owned = captures.get(state.session.id), scope = acceptedCaptureScope(accepted);
      const capture = owned && owned.generation === accepted.writerGeneration && owned.streamId === active?.metadata.lastStreamId && active.transcriptStatus === 'streaming' ? owned : undefined;
      if (capture) disposeOnFailure(async () => {
        await closeCapture(capture);
        // A failed final CAS has not published the drained words. Retain this
        // closed result for the same accepted intent to resume; a completed or
        // replaced writer may release it without touching a newer producer.
        const latest = await read(context, state.session.id).catch(() => null);
        if (latest && (latest.handoff || latest.writerGeneration !== capture.generation || decode(latest).session.turns.at(-1)?.metadata.lastStreamId !== capture.streamId) && captures.get(state.session.id) === capture) captures.delete(state.session.id);
      });
      const drainer = createSessionEndDrainer<Capture>({
        drainFor: currentCapture => ({ ...currentCapture, markFinishReceived: () => currentCapture.markFinishReceived(state.serverNowMs), finishForEnd: async () => {
          const latest = await read(context, state.session.id), receipt = await finalizationReceipt(context, latest); if (receipt) throw new DurableReceiptReplay(receipt);
          if (latest.writerGeneration !== accepted.writerGeneration) error(409, 'SESSION_WRITER_STALE');
          {
            const receivedAt = currentCapture.markerReceivedAt ?? (scope ? undefined : Date.parse(latest.serverNow));
            if (captureMatches(scope, currentCapture) && (receivedAt === undefined || receivedAt > Date.parse(accepted.endIntent!.acceptedAt) + 2_000)) throw new Error('END_CAPTURE_FINISH_NOT_RECEIVED');
            const runtime = state.session.runtime!;
            if (runtime.version !== 'authenticated-session-runtime-v1') return error(409, 'AUTHENTICATED_SESSION_OWNER_MISMATCH');
            if (runtime.endCaptureDrain) {
              if (runtime.endCaptureDrain.intentId !== accepted.endIntent!.intentId || runtime.endCaptureDrain.streamId !== currentCapture.streamId) return error(409, 'SESSION_CAPTURE_SCOPE_CHANGED');
            } else {
              runtime.endCaptureDrain = { intentId: accepted.endIntent!.intentId, streamId: currentCapture.streamId, turnId: currentCapture.turnId, answerId: currentCapture.answerId,
                captureRevision: currentCapture.captureRevision, markerReceivedAt: new Date(receivedAt ?? Date.parse(latest.serverNow)).toISOString(), providerDeadlineAt: new Date(Date.parse(latest.serverNow) + 15_000).toISOString() };
              checkpointSession(state.session, 'end_capture_draining', latest.serverNow); await save();
            }
          }
          const runtime = state.session.runtime!, deadlineAt = runtime.version === 'authenticated-session-runtime-v1' ? runtime.endCaptureDrain?.providerDeadlineAt : undefined;
          await finishCapture(state.session, accepted, { deadlineAt: deadlineAt ?? new Date(Date.parse(latest.serverNow) + 15_000).toISOString(), serverNowMs: state.serverNowMs, attemptId: intent().attemptId });
        } }),
        finish: async () => false, close: closeCapture,
        onFailure: (_capture, _drain, cause) => {
          if (cause instanceof DurableReceiptReplay || cause instanceof SessionCommandError) throw cause;
          if (active?.transcriptStatus === 'streaming') active.transcriptStatus = 'error';
          emit({ type: 'error', actor: 'server', turnId: active?.id, answerId: active?.answerId, payload: { source: 'end-capture-drain', code: 'END_CAPTURE_UNCONFIRMED', rawTranscript: active?.rawTranscript ?? '' } });
        },
      });
      const drained = await drainer({ captures: capture ? [capture] : [], finishScope: scope });
      if (!capture && active?.transcriptStatus === 'streaming') {
        active.transcriptStatus = 'error';
        emit({ type: 'error', actor: 'server', turnId: active.id, answerId: active.answerId, payload: { source: 'end-recovered-capture', code: 'END_CAPTURE_UNCONFIRMED', rawTranscript: active.rawTranscript ?? '' } });
      }
      await hook('after-external', 'end-finalize', state.session.id, finalize.key, intent());
      finalizeSessionEndState(state.session, { activeStreamsFlushed: drained.activeStreamsFlushed, onEvent: emit, now: () => new Date(now()).toISOString() });
      state.session.runtime!.evaluationInputFrozenAt = new Date(now()).toISOString(); state.session.evaluationStatus = 'review_required'; state.session.evaluationError = 'EVALUATION_HANDOFF_PENDING';
      delete state.session.runtime!.evaluationJob; delete state.session.evaluation;
      const sessionJson = serialized(state.session), frozenSessionSha256 = sha(sessionJson), model = (state.pins.models as { evaluation: string }).evaluation;
      const payloadJson = serialized({ version: 'session-evaluation-handoff-v1', sessionId: state.session.id, ownerId: accepted.binding.ownerId,
        studentId: accepted.binding.studentId, applicationTargetId: accepted.binding.applicationTargetId, supportTargetId: accepted.binding.supportTargetId,
        acceptedEndIntentId: accepted.endIntent!.intentId, acceptedEndInputSha256: accepted.endIntent!.inputSha256, contextSnapshotSha256: accepted.contextSnapshotSha256,
        frozenSessionSha256, evaluationSourceSha256: evaluationSessionSourceFingerprint(state.context, state.session, model), model, pipelineVersion: state.pins.evaluationPipeline,
        sessionJson, contextJson: accepted.contextJson, pinsJson: accepted.pinsJson, state: 'awaiting-evaluation-consumer', evaluationApprovalGranted: false });
      const last = state.session.turns.at(-1);
      return { ...(isFinalizedAnswer(last) ? { answerFact: { turnId: last.id, answerId: last.answerId, captureRevision: last.metadata.answerCaptureRevision ?? 1, inputSha256: answerSourceSha(last) } } : {}),
        afterCommit: async () => { if (capture && captures.get(state.session.id) === capture) captures.delete(state.session.id); },
        handoff: { intentId: accepted.endIntent!.intentId, payloadJson, payloadSha256: sha(payloadJson), frozenSessionSha256 }, result: { status: 'ending', evaluationStatus: 'review_required', handoff: 'awaiting-evaluation-consumer', evaluationJob: null } };
      });
    })();
    finalizations.set(flightKey, pending);
    try { return await pending; } finally { if (finalizations.get(flightKey) === pending) finalizations.delete(flightKey); }
  }
  const mutations: ServiceSessionMutations = {
    kind: 'isolated-db-session-writer', create, command,
    async read(context, binding) { return response(await read(context, binding.sessionId)); },
    async context(context, binding) { const snapshot = await read(context, binding.sessionId); decode(snapshot);
      return { version: 'authenticated-session-context-v1', contextJson: snapshot.contextJson, contextSha256: snapshot.contextSnapshotSha256, pinsJson: snapshot.pinsJson, pinsSha256: snapshot.pinsSha256 }; },
    async receipt(context, binding, query) {
      if (!/^[a-f0-9]{64}$/u.test(query.inputSha256) || !/^[A-Za-z0-9._:-]{1,160}$/u.test(query.key)) error(400, 'SESSION_RECEIPT_QUERY_INVALID');
      await read(context, binding.sessionId);
      const receipt = await repository.receiptByKey(context, { sessionId: binding.sessionId, ...query });
      if (!receipt) return error(404, 'SESSION_RECEIPT_NOT_FOUND'); return receiptValue(receipt);
    },
    async connect(context, binding) {
      const snapshot = await read(context, binding.sessionId);
      if (snapshot.writer !== 'db') error(409, 'SESSION_STALE_SOCKET');
      if (decode(snapshot).session.runtime!.engineVersion !== interviewConfig.rulesVersion) error(409, 'SESSION_ENGINE_VERSION_CHANGED');
      return { writerGeneration: snapshot.writerGeneration, connectionToken: randomUUID() };
    },
    async assertSocketCurrent(context, binding, generation) { const snapshot = await read(context, binding.sessionId); if (snapshot.writerGeneration !== generation || snapshot.writer !== 'db') error(409, 'SESSION_STALE_SOCKET'); },
    async socket(context, binding, generation, raw, connectionToken) {
      const p = parse(z.object({ type: z.literal('command'), action: z.enum(['capture-start', 'capture-finish', 'answer', 'answer-candidate', 'events', 'next', 'end']), command: authenticatedSessionCommandSchema }).strict(), raw);
      if (p.command.writerGeneration !== generation) error(409, 'SESSION_STALE_SOCKET');
      const capture = captures.get(binding.sessionId);
      if (p.action === 'capture-finish' && capture?.connectionToken && capture.connectionToken !== connectionToken) error(409, 'SESSION_CAPTURE_SOCKET_MISMATCH');
      if (p.action === 'capture-finish' && capture) {
        const scope = parse(captureStartSchema.omit({ staged: true }).extend({ submissionAttemptId: z.string().uuid().optional() }), p.command.payload);
        const snapshot = await read(context, binding.sessionId), { session } = decode(snapshot);
        selectedTurn(session, scope);
        if (snapshot.writerGeneration !== generation || capture.generation !== generation || session.turns.at(-1)?.metadata.lastStreamId !== capture.streamId) error(409, 'SESSION_STALE_SOCKET');
        if (snapshot.endIntent) {
          if (!mayReceiveEndTail(snapshot, capture, connectionToken)) error(409, 'SESSION_END_CAPTURE_MARKER_EXPIRED');
          capture.markFinishReceived(Date.parse(snapshot.serverNow));
          return { type: 'command_result', action: p.action, value: { endDrainAccepted: true, finalization: await finalizeEnd(context, snapshot) } };
        }
        capture.markFinishReceived(Date.parse(snapshot.serverNow));
      }
      return { type: 'command_result', action: p.action, value: await command(context, binding, p.action, p.command, connectionToken) };
    },
    async audio(context, binding, generation, bytes, connectionToken) {
      const snapshot = await read(context, binding.sessionId), capture = captures.get(binding.sessionId);
      if (snapshot.writerGeneration !== generation || !capture || capture.generation !== generation || snapshot.handoff) error(409, 'SESSION_CAPTURE_NOT_ACTIVE');
      if (snapshot.endIntent && !mayReceiveEndTail(snapshot, capture!, connectionToken)) error(409, 'SESSION_END_CAPTURE_TAIL_EXPIRED');
      const { session } = decode(snapshot); if (session.turns.at(-1)?.metadata.lastStreamId !== capture!.streamId) error(409, 'SESSION_CAPTURE_SCOPE_CHANGED');
      if (capture!.finishCache.promise) error(409, 'SESSION_CAPTURE_ALREADY_FINISHING');
      if (capture!.connectionToken && capture!.connectionToken !== connectionToken) error(409, 'SESSION_CAPTURE_SOCKET_MISMATCH'); capture!.connectionToken = connectionToken;
      if (capture!.bytes + bytes.length > 16 * 1024 * 1024) error(413, 'SESSION_CAPTURE_LIMIT'); capture!.bytes += bytes.length; counters.syntheticCaptureBytes += bytes.length; await capture!.provider.write(bytes);
    },
    async disconnect(context, binding, generation, connectionToken) {
      const capture = captures.get(binding.sessionId);
      let observationFailure: unknown;
      try { await repository.observeConnectionClosed(context, { sessionId: binding.sessionId, writerGeneration: generation, connectionToken }); }
      catch (cause) { observationFailure = cause; }
      if (capture?.generation === generation && capture.connectionToken === connectionToken) {
        try {
          if (observationFailure) throw observationFailure;
          const snapshot = await read(context, binding.sessionId);
          if (snapshot.writerGeneration === generation && snapshot.endIntent && !snapshot.handoff) {
            // The socket queue has already consumed every received PCM frame.
            // Losing the tab after accepted end cannot discard those bytes.
            if (mayReceiveEndTail(snapshot, capture, connectionToken)) capture.markFinishReceived(Date.parse(snapshot.serverNow));
            await finalizeEnd(context, snapshot);
          } else { await closeCapture(capture); if (captures.get(binding.sessionId) === capture) captures.delete(binding.sessionId); }
        } catch (cause) { await closeCapture(capture); if (captures.get(binding.sessionId) === capture) captures.delete(binding.sessionId); throw cause; }
      }
      if (observationFailure) throw observationFailure;
    },
  };
  const resources: ServiceRequestResources = {
    kind: 'synthetic', async sessionBinding(context, id) { const snapshot = await repository.read(context, id); return snapshot?.created ? snapshot.binding : null; },
    async readSession(context, binding) { return decode(await read(context, binding.sessionId)).session; },
    async readStatus(context) { await current(context); return { mode: 'isolated-session-writer', evaluationApprovalGranted: false, paidProviderCalls: 0 }; },
    async audioBinding() { return null; }, async readAudio() { return null; },
  };
  return { mutations, resources, inspect: async (context: AuthenticatedRequestContext, id: string) => response(await read(context, id)), diagnostics: () => ({ ...counters }),
    async close() { const pending = [...captures.values()]; captures.clear(); await Promise.all(pending.map(capture => Promise.resolve(capture.provider.close()).catch(() => {}))); } };
}
