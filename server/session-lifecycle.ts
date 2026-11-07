import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { InterviewContext } from './data/load-interview-context';
import type { InterviewPlan } from './interview-planner';
import { isFinalizedAnswer, finalizeCapturedTurnForEnd, type InterviewSession, type RecordedTurn } from './protocol';
import { checkpointSession, type SessionRuntimeState, type ClosingUtterance } from './session-runtime';
import { calculateSpeechMetrics } from '../lib/interview/speech-metrics';
import { observeSpeechHabits } from '../lib/interview/speech-habits';
import { observeAnswerSubmission } from './answer-submission';
import { assertCaptureConfirmed } from './answer-candidate-state';
import { summarizeSessionLatency } from './session-latency';
import { recordQuestionPresentation } from './question-presentation';
import { deliveredFollowUpCount } from './follow-up-count';
import type { clientConversationEventSchema } from '../lib/interview/client-event-contract';
import type { ConversationEvent } from './storage/conversation-log';
import type { PreparedWork } from './session-turn-preparer';

export class SessionDomainError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); this.name = 'SessionDomainError'; }
}
type DomainErrorConstructor = new (status: number, message: string, code?: string) => Error;
export interface TransitionOptions {
  now?: () => string;
  HttpError?: DomainErrorConstructor;
  /** E collects these required facts for the same commit; local keeps its logger. */
  onEvent?: (event: ConversationEvent) => void;
}
export const evaluationInputFrozen = (session: InterviewSession) => Boolean(session.runtime?.evaluationJob || session.runtime?.evaluationInputFrozenAt);
export const sessionEventId = (kind: string, ...parts: string[]) => `${kind}:${createHash('sha256').update(parts.join('\u0000')).digest('hex')}`;
const journalCaptureId = (turn: RecordedTurn) => turn.metadata.lastStreamId ?? sessionEventId('legacy-capture', turn.rawTranscript ?? '', JSON.stringify(turn.sttObservations ?? []));
export function createInterviewSession(context: InterviewContext, plan: InterviewPlan, runtime: SessionRuntimeState,
  options: { id?: string; now?: string; HttpError?: DomainErrorConstructor } = {}): InterviewSession {
  const HttpError = options.HttpError ?? SessionDomainError;
  if (!context.interviewOverview) throw new HttpError(422, '대상 전형의 공식 면접 시간을 확인해 주세요.');
  const now = options.now ?? new Date().toISOString();
  return { id: options.id ?? randomUUID(), createdAt: now, updatedAt: now, status: 'active', evaluationStatus: 'pending', target: context.target, runtime,
    sourceManifest: { ...structuredClone(context.manifest), interviewPlan: structuredClone(plan) }, durationSeconds: context.interviewOverview.durationSeconds,
    interviewOverview: structuredClone(context.interviewOverview), plan, mainQuestionTarget: plan.mainQuestionTarget, hasGreeted: false, turns: [], questionPresentations: [], questionPresentationEventIds: [], followUpCountByMainQuestion: {}, elapsedMs: 0 };
}
export type ClientSessionEvent = z.infer<typeof clientConversationEventSchema>;
export interface CanonicalSessionUtterance { questionText: string | null; acknowledgement: string | null; interviewerId: string | null; sourceTurnId?: string | null }
export interface ClientEventOptions extends TransitionOptions {
  canonicalTurn?: (session: InterviewSession, turnId: string) => CanonicalSessionUtterance | null;
  closingFallback?: ClosingUtterance;
}
export function canonicalSessionTurn(session: InterviewSession, turnId: string): CanonicalSessionUtterance | null {
  const closing = session.runtime?.closingUtterance;
  if (closing?.id === turnId) return { questionText: null, acknowledgement: closing.text, interviewerId: closing.interviewerId };
  const index = session.turns.findIndex(turn => turn.id === turnId), turn = session.turns[index];
  if (turn) return { questionText: turn.questionText, acknowledgement: turn.acknowledgement, interviewerId: turn.interviewerId, sourceTurnId: session.turns[index - 1]?.id ?? null };
  for (const operation of Object.values(session.runtime?.operations ?? {})) for (const work of [operation.prepared, ...(operation.retiredPrepared ?? [])] as Array<PreparedWork | undefined>)
    if (work?.id === turnId) return { questionText: work.draft?.questionText ?? null, acknowledgement: work.acknowledgement, interviewerId: work.interviewerId, sourceTurnId: work.sourceTurnId };
  return null;
}
const speechTimingSchema = z.object({ durationMs: z.number().finite().min(0).max(7_200_000), speakingMs: z.number().finite().min(0).max(7_200_000).nullable().optional(), firstSpeechMs: z.number().finite().min(0).max(7_200_000).nullable().optional() });
export function answerMetrics(answerId: string, transcript: string, input: unknown) {
  const object = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const timing = speechTimingSchema.safeParse(object.speech);
  const durationMs = timing.success ? timing.data.durationMs : 0;
  const speakingMs = timing.success && timing.data.speakingMs != null && timing.data.speakingMs <= durationMs ? timing.data.speakingMs : null;
  const firstSpeechMs = timing.success && timing.data.firstSpeechMs != null && timing.data.firstSpeechMs <= durationMs ? timing.data.firstSpeechMs : null;
  return { ...object, speech: calculateSpeechMetrics({ rawTranscript: transcript, durationMs, speakingMs, firstSpeechMs }), habits: observeSpeechHabits(answerId, transcript, durationMs), timingOrigin: "client-monotonic-observed", transcriptOrigin: "CLOVA-Speech-gRPC" };
}
export function observeFinalizedAnswer(session: InterviewSession, turn: RecordedTurn, options: TransitionOptions = {}) {
  if (!isFinalizedAnswer(turn)) return;
  turn.answerObservation = observeAnswerSubmission(turn.rawTranscript, turn.metrics, turn.metadata.answerEndingObservation);
  if (!turn.answerObservation.nonAnswer) return;
  const payload = { ...turn.answerObservation, rawTranscript: turn.rawTranscript, transcriptStatus: turn.transcriptStatus,
    microphoneEnabled: turn.metadata.answerEndingObservation?.microphoneEnabled ?? null,
    reasonCode: turn.metadata.answerEndingObservation?.microphoneEnabled === false ? 'INPUT_DISABLED' : 'NO_ANSWER', scoring: "no-fabricated-content-or-independent-silence-score" };
  options.onEvent?.( { eventId: sessionEventId("answer.non_answer", turn.id, turn.answerId), type: "answer.non_answer", actor: "server", turnId: turn.id, answerId: turn.answerId, payload });
  if (turn.answerObservation.classification === "silence_observed") options.onEvent?.( { eventId: sessionEventId("answer.silence", turn.id, turn.answerId), type: "answer.silence", actor: "server", turnId: turn.id, answerId: turn.answerId, payload });
}
export function applySessionClientEvent(session: InterviewSession, event: ClientSessionEvent, options: ClientEventOptions = {}) {
  const HttpError = options.HttpError ?? SessionDomainError;
  const now = options.now ?? (() => new Date().toISOString());
  const canonical = event.turnId ? (options.canonicalTurn ?? canonicalSessionTurn)(session, event.turnId) : null;
  if (event.turnId && !canonical) throw new HttpError(409, "이 면접의 대화 턴을 확인할 수 없습니다.");
  const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
  const frozen = evaluationInputFrozen(session);
  if (!frozen && typeof payload.elapsedMs === 'number' && Number.isFinite(payload.elapsedMs) && payload.elapsedMs >= 0 && payload.elapsedMs <= 86_400_000) session.elapsedMs = Math.max(session.elapsedMs, payload.elapsedMs);
  const isClosing = event.turnId === (session.runtime?.closingUtterance ?? options.closingFallback)?.id;
  const isOpening = event.turnId === session.runtime?.opening?.questionTurnId && (event.type === 'acknowledgement_playing' || event.type === 'audio_ended' && payload.role === 'acknowledgement');
  const pendingOperation = Object.values(session.runtime?.operations ?? {}).find(operation => (operation.prepared as PreparedWork | undefined)?.id === event.turnId);
  if (!frozen && pendingOperation && event.type === 'acknowledgement_playing') pendingOperation.acknowledgementDelivery = { ...pendingOperation.acknowledgementDelivery, startedAt: now() };
  if (!frozen && pendingOperation && event.type === 'audio_ended' && payload.role === 'acknowledgement') pendingOperation.acknowledgementDelivery = { ...pendingOperation.acknowledgementDelivery, completedAt: now() };
  let type = "phase.changed", role: string | undefined;
  let details: Record<string, unknown> = { phase: event.phase ?? null, clientAtMs: event.atMs, clockId: event.clockId ?? null, observedBy: "browser-event", ...(frozen ? { lateAfterEvaluationFreeze: true, evaluationInputMutated: false } : {}) };
  if (event.type === "acknowledgement_playing" || event.type === "question_playing") {
    role = isClosing ? 'closing' : isOpening ? 'opening' : event.type === "acknowledgement_playing" ? "acknowledgement" : "question";
    const text = role === "acknowledgement" || role === 'closing' || role === 'opening' ? canonical?.acknowledgement : canonical?.questionText;
    if (!event.turnId || !text) throw new HttpError(409, "실제로 준비한 면접관 발화를 확인할 수 없습니다.");
    type = "playback.started";
    details = { ...details, text, interviewerId: canonical?.interviewerId ?? null, sourceTurnId: canonical?.sourceTurnId ?? null };
    if (isClosing && !frozen) session.runtime!.closingDelivery = { ...session.runtime!.closingDelivery, startedAt: now() };
    if (isOpening) { if (!frozen) { session.runtime!.opening!.delivery = { ...session.runtime!.opening!.delivery, startedAt: now() }; session.hasGreeted = true; } details.utteranceId = session.runtime!.opening!.id; }
  } else if (event.type === "audio_ended") {
    if (!event.turnId) throw new HttpError(409, "재생한 면접관 발화의 턴을 확인할 수 없습니다.");
    type = "playback.ended";
    role = isClosing ? 'closing' : isOpening ? 'opening' : payload.role === "question" || payload.role === "acknowledgement" ? payload.role : undefined;
    details = { ...details, text: role === "question" ? canonical?.questionText : role === "acknowledgement" || role === 'closing' || role === 'opening' ? canonical?.acknowledgement : null, interviewerId: canonical?.interviewerId ?? null };
    if (isClosing && !frozen) session.runtime!.closingDelivery = { ...session.runtime!.closingDelivery, completedAt: now() };
    if (isOpening) { if (!frozen) session.runtime!.opening!.delivery = { ...session.runtime!.opening!.delivery, completedAt: now() }; details.utteranceId = session.runtime!.opening!.id; }
  } else if (event.type === "client_error") {
    type = "error";
    details = { ...details, source: "client", message: typeof payload.message === "string" ? payload.message.slice(0, 400) : "클라이언트 오류가 관찰되었습니다." };
  }
  if (!isClosing && !frozen) {
    recordQuestionPresentation(session, event, session.turns.find(turn => turn.id === event.turnId));
    if (session.runtime && event.type === 'question_playing') {
      const shown = session.turns.find(turn => turn.id === event.turnId);
      if (shown?.questionKind === 'follow_up') session.followUpCountByMainQuestion[shown.parentMainQuestionId] = deliveredFollowUpCount(session, shown.parentMainQuestionId);
    }
    if (session.runtime && event.type === 'audio_ended' && payload.role === 'question' && !session.runtime.firstEvaluationDelivery) {
      const presented = session.questionPresentations?.find(row => row.turnId === event.turnId);
      if (presented?.questionKind === 'main' && presented.startedAtMs !== null && presented.completedAtMs !== null && presented.completedAtMs >= presented.startedAtMs && !presented.interrupted && !presented.errorCodes?.length && presented.clockId) {
        session.runtime.firstEvaluationDelivery = { eventId: sessionEventId('first-evaluation-normal-delivery', session.id, presented.turnId), turnId: presented.turnId, observedAt: now(), clockId: presented.clockId, status: 'normal_delivery_observed', entitlementLedgerImplemented: false };
        options.onEvent?.( { eventId: session.runtime.firstEvaluationDelivery.eventId, type: 'session.first_evaluation_delivered', actor: 'server', turnId: presented.turnId, payload: session.runtime.firstEvaluationDelivery });
      }
    }
  }
  if (!frozen && event.type === 'phase_changed' && event.phase) checkpointSession(session, event.phase, now());
  // Persist even duplicate retries: an earlier ledger save may have failed after in-memory mutation.
  return { persist: !frozen && Boolean(pendingOperation || isOpening || event.type === 'phase_changed' || event.type === 'question_playing' || event.type === 'audio_ended' || event.type === 'client_error'), event: { eventId: event.eventId, type, actor: 'client' as const, turnId: event.turnId, role, payload: details } };
}
export const sessionEndCaptureScopeSchema = z.object({ turnId: z.string().uuid(), answerId: z.string().min(1).max(160), captureRevision: z.number().int().min(1) });
export function acceptSessionEndRequest(session: InterviewSession, body: { metrics?: unknown; elapsedMs?: number },
  options: TransitionOptions & { onAcceptedBeforeSnapshot?: () => void } = {}) {
  const HttpError = options.HttpError ?? SessionDomainError;
  if (!session.runtime) throw new HttpError(409, '면접 실행 상태를 확인할 수 없습니다.');
      const suppliedMetrics = body.metrics && typeof body.metrics === 'object' ? body.metrics as Record<string, unknown> : {};
      const captureScopeSchema = sessionEndCaptureScopeSchema;
      const requestedScope = suppliedMetrics.captureFinishScope === undefined ? null : captureScopeSchema.parse(suppliedMetrics.captureFinishScope);
      const capturedTurn = session.turns.at(-1);
      if (!session.runtime!.acceptedEndRequest && requestedScope && (!capturedTurn || capturedTurn.id !== requestedScope.turnId || capturedTurn.answerId !== requestedScope.answerId || capturedTurn.metadata.answerCaptureRevision !== requestedScope.captureRevision)) throw new HttpError(409, '종료할 답변의 식별자가 일치하지 않습니다.');
      session.runtime!.endRequestedAt ??= (options.now?.() ?? new Date().toISOString());
      options.onAcceptedBeforeSnapshot?.();
      session.runtime!.acceptedEndRequest ??= { elapsedMs: Math.max(session.elapsedMs, body.elapsedMs ?? 0), metrics: structuredClone(suppliedMetrics) };
  return session.runtime.acceptedEndRequest;
}
/** Called only after the already durable first end intent has drained capture
 * outside a DB transaction. This does not enqueue or issue an evaluation job. */
export function finalizeSessionEndState(session: InterviewSession,
  options: TransitionOptions & { activeStreamsFlushed: boolean; retirePreparedWork?: () => void }) {
  if (!session.runtime?.acceptedEndRequest) throw new SessionDomainError(409, '수락된 종료 입력을 확인할 수 없습니다.', 'END_INTENT_REQUIRED');
  const endMetrics = session.runtime.acceptedEndRequest.metrics;
      const pausedTurn = session.turns.at(-1);
      if (pausedTurn?.transcriptStatus === 'paused' && pausedTurn.metadata.answerSubmissionMode === 'staged-v2') {
        try { assertCaptureConfirmed(pausedTurn); }
        catch {
          pausedTurn.transcriptStatus = 'error';
          options.onEvent?.( { type: 'error', actor: 'server', turnId: pausedTurn.id, answerId: pausedTurn.answerId, payload: { source: 'end-recovered-capture', code: 'END_CAPTURE_UNCONFIRMED', rawTranscript: pausedTurn.rawTranscript ?? '' } });
        }
      }
      finalizeCapturedTurnForEnd(session.turns.at(-1), options.activeStreamsFlushed);
      const endingTurn = session.turns.at(-1);
      if (endingTurn?.metadata.answerSubmissionMode === 'staged-v2' && endingTurn.transcriptStatus === 'finalized') endingTurn.metadata.answerCommitStatus = 'committed';
      session.status = "ending";
      session.runtime!.epoch++;
      checkpointSession(session, 'ending', options.now?.());
      options.retirePreparedWork?.();
      const timingBackup = z.record(z.string().uuid(), z.record(z.string().min(1), z.number().finite().min(0))).safeParse(endMetrics.clientTimingsByTurn);
      if (timingBackup.success) for (const [turnId, timings] of Object.entries(timingBackup.data)) {
        const timedTurn = session.turns.find(turn => turn.id === turnId);
        if (timedTurn) { timedTurn.metadata.clientTimings = { ...timedTurn.metadata.clientTimings, ...timings }; options.onEvent?.( { type: "timings.observed", actor: "client", turnId, payload: { clientTimings: timedTurn.metadata.clientTimings, origin: "end-backup" } }); }
      }
      session.metrics = { ...endMetrics, latency: summarizeSessionLatency(session) };
      session.elapsedMs = session.runtime!.acceptedEndRequest.elapsedMs;
      const lastTurn = session.turns.at(-1);
      if (isFinalizedAnswer(lastTurn)) {
        const scoped = Array.isArray(endMetrics.answers) ? endMetrics.answers.find(item => item && typeof item === 'object' && (item as { turnId?: string }).turnId === lastTurn.id && (item as { answerId?: string }).answerId === lastTurn.answerId) : null;
        const currentMetrics = scoped ?? (endMetrics.lastObservedAnswerTurnId === lastTurn.id ? endMetrics : lastTurn.metrics ?? {});
        lastTurn.metrics = answerMetrics(lastTurn.answerId, lastTurn.rawTranscript, currentMetrics);
      }
      if (lastTurn) observeFinalizedAnswer(session, lastTurn, options);
      if (lastTurn?.transcriptStatus === "finalized" && lastTurn.answerId) {
        const captureAttemptId = journalCaptureId(lastTurn);
        options.onEvent?.( { eventId: sessionEventId("answer.submitted", lastTurn.id, lastTurn.answerId, captureAttemptId), type: "answer.submitted", actor: "candidate", turnId: lastTurn.id, answerId: lastTurn.answerId, payload: { source: "explicit-end", rawTranscript: lastTurn.rawTranscript ?? "", captureAttemptId } });
        options.onEvent?.( { eventId: sessionEventId("stt.final", lastTurn.id, lastTurn.answerId, captureAttemptId), type: "stt.final", actor: "candidate", turnId: lastTurn.id, answerId: lastTurn.answerId, payload: { rawTranscript: lastTurn.rawTranscript ?? "", source: "explicit-end", captureAttemptId, observations: lastTurn.sttObservations ?? null } });
      }
      options.onEvent?.( { eventId: "session-ended", type: "session.ended", actor: "server", payload: { elapsedMs: session.elapsedMs, status: session.status, metrics: session.metrics } });
      options.onEvent?.( { type: "session.snapshot", actor: "server", payload: session });
}
