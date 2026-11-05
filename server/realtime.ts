import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import { interviewConfig } from "../interview.config";
import { loadInterviewContext } from "./data/load-interview-context";
import { sessionDurationSeconds } from "./data/school-context";
import { ClovaSpeechStream } from "./providers/clova-stt";
import { synthesizeSpeech, readSpeechAudio, interviewerVoiceDefaults } from "./providers/clova-tts";
import { createLocalEvaluationJobStore, evaluationJobId } from './evaluation-job-store';
import { createLocalReviewRepository } from './repositories/local-review-repository';
import { createLocalEvaluationRevisionRepository } from './repositories/local-evaluation-revision-repository';
import { loadReviewedEvaluationRevision, retryReviewedEvaluationRevision, type ReviewedEvaluationRevisionView } from './evaluation-revisions';
import { loadHistoricalCompletedEvaluation } from './evaluation-history';
import { EVALUATION_PIPELINE_VERSION, evaluationSessionSourceFingerprint } from './providers/evaluation-input';
import { loadQuestionBank, loadQuestionBankByPinnedPlan, selectNextPreparedMainQuestion, createSessionQuestionPlan } from './data/prepared-question-bank';
import { bankScopeReadiness } from './data/evaluation-scope-registry';
import { runRealtimeCore } from './providers/realtime-core';
import { approvedRestatement } from './providers/approved-restatement';
import { approvedAudioReplay } from './providers/approved-audio-replay';
import { createLocalSessionStore } from "./storage/local-session-store";
import { actualEvaluativeQuestion, mayReplayQuestion, concatenateStreamTranscript, finalizeCapturedTurnForEnd, IdempotentTurnOperations, isFinalizedAnswer, mayAskClarification, mergeTranscriptObservation, nextPosition, nextRequestSchema, safeProviderError, streamRequestSchema, type InterviewSession, type RecordedTurn, type QuestionDraft } from "./protocol";
import { observeAnswerSubmission } from "./answer-submission";
import { calculateSpeechMetrics } from "../lib/interview/speech-metrics";
import { observeSpeechHabits } from "../lib/interview/speech-habits";
import { createInterviewPlan, currentPlanSlot, mayAskFollowUp, sessionMainQuestionTarget } from "./interview-planner";
import { summarizeSessionLatency } from "./session-latency";
import { recordQuestionPresentation } from './question-presentation';
import { publicServiceError, serviceDisplayMessage } from "../lib/interview/service-errors";
import type { AnswerReaction } from "./providers/answer-reaction";
import { answerContextTrace } from './providers/answer-context';
import { bindQuestionContractToTurn, assertQuestionContractIntegrity } from './question-objective';
import { buildConversationLedger, conversationLedgerTrace } from './conversation-ledger';
import { QuestionPreparationError, QuestionValidationError } from './providers/question-grounding';
import type { SpeechSynthesisSettings } from "./providers/speech-audio-cache";
import { defaultConversationLogger, type ConversationEvent, type ConversationAppendResult } from "./storage/conversation-log";
import { createSessionRuntime, localDevelopmentOwner, snapshotHash, assertSessionOwner, assertRecoverableSession, restoreLogicalSession, checkpointSession, recoveryProjection, saveSessionSnapshot, type ClosingUtterance, type PersistedNextResult } from './session-runtime';
import { currentQuestionVocabulary } from './providers/speech-vocabulary';
import { loadGuidebookExposure } from './question-selection';
import { loadQuestionPurposeLineage } from './data/question-purpose-lineage';
import { recordSessionProviderUsage } from './observability/session-provider-ledger';
import type { ProviderUsageObservation } from './observability/provider-cost';
import { compilePolicyClauseRegistry } from './policy/compiled-runtime-policy';
import { assertSingleCoreCandidateBinding, classifySingleCoreAnswerCandidate, SINGLE_CORE_ENGINE_VERSION } from './providers/single-core-runtime';
import { answerCandidateRequestSchema, assertCandidateSource, assertCaptureConfirmed, assertCaptureMayStart, capturePart, transcriptHash, type AnswerCandidateState } from './answer-candidate-state';
import { realtimeCoreModel, runtimeFactReviewModel } from './providers/realtime-model';
import { clientConversationEventSchema, type ClientPlaybackEvent } from '../lib/interview/client-event-contract';
import { deliveredFollowUpCount } from './follow-up-count';
import { assertRepairProof, createRepairContract } from './providers/repair-contract';
import { singleCoreCandidateDecisionSchema } from './providers/single-core-contract';
import { SubmissionWorkRegistry } from './submission-work';
import { TurnWorkError, runTurnWorkStage, type TurnWorkContext } from './turn-work';

const port = Number(process.env.REALTIME_PORT ?? 3001);
const webPort = Number(process.env.WEB_PORT ?? 3000);
const workspaceId = createHash("sha256").update(path.resolve(process.cwd()).toLowerCase()).digest("hex").slice(0, 16);
const requiredKeys = ["OPENAI_API_KEY", "CLOVA_SPEECH_SECRET_KEY", "CLOVA_VOICE_CLIENT_ID", "CLOVA_VOICE_CLIENT_SECRET"];
const sessions = new Map<string, InterviewSession>();
const store = createLocalSessionStore();
const evaluationJobs = createLocalEvaluationJobStore();
const evaluationReviews = createLocalReviewRepository(), evaluationRevisions = createLocalEvaluationRevisionRepository();
function observeSessionUsage(session: InterviewSession, stage: 'core' | 'review' | 'repair' | 'evaluation', attemptId: string, observation: ProviderUsageObservation) {
  session.providerUsageLedger = recordSessionProviderUsage(session.providerUsageLedger, { stage, attemptId, observation });
  void journal(session, { eventId: journalId('provider.usage', stage, observation.responseId ?? observation.requestId ?? attemptId), type: 'provider.usage', actor: 'provider', payload: { stage, attemptId, observation, pricingBasis: 'published-rates-observed-usage', invoiceVerified: false } });
}
const nextOperations = new IdempotentTurnOperations<PersistedNextResult>();
const endOperations = new IdempotentTurnOperations<void>();
const closingOperations = new IdempotentTurnOperations<ClosingUtterance>();
const evaluationInputFrozen = (session: InterviewSession) => Boolean(session.runtime?.evaluationJob || session.runtime?.evaluationInputFrozenAt);
const candidateFlights = new Map<string, Promise<AnswerCandidateState>>();
const submissionWork = new SubmissionWorkRegistry(interviewConfig.turnWaitTimeoutMs);
const streams = new Map<string, Set<ClovaSpeechStream>>();
type EndCaptureDrain = {
  turnId: string; answerId: string; captureRevision?: number;
  receipt: Promise<void>; markFinishReceived: () => void;
  finishForEnd: () => Promise<void>;
};
const endCaptureDrains = new Map<ClovaSpeechStream, EndCaptureDrain>();
const connections = new Map<string, Set<WebSocket>>();
const allowedOrigins = new Set([`http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`, `http://localhost:${port}`, `http://127.0.0.1:${port}`]);
const contextPromise = loadInterviewContext();
// Explicit local development boundary, not a commercial authentication implementation.
const owner = localDevelopmentOwner();
const pinnedContexts = new Map<string, Awaited<typeof contextPromise>>();
const audioOwners = new Map<string, string>();
const loadingSessions = new Map<string, Promise<InterviewSession>>();
type AcknowledgementReady = { type: "acknowledgement_ready"; turnId: string; acknowledgement: string; acknowledgementAudioUrl: string; interviewerId: string };
const progressListeners = new Map<string, Set<(event: AcknowledgementReady) => void>>();
type PreparedWork = {
  id: string; sourceTurnId?: string; reaction?: AnswerReaction;
  position: NonNullable<ReturnType<typeof nextPosition>>;
  interviewerId: string; speaker: string; role: "primary" | "secondary";
  acknowledgement: string | null; acknowledgementQuote: string | null;
  draft?: QuestionDraft; draftPromise?: Promise<QuestionDraft>; llmMs?: number;
  cachedQuestionAudioUrl?: string; cachedVoiceSettings?: SpeechSynthesisSettings;
  coreTimings?: Record<string, number>; bankKey?: string; candidateId?: string;
  selectionTrace?: QuestionDraft['selectionTrace'];
  cachedAcknowledgementAudioUrl?: string; cachedAcknowledgementSettings?: SpeechSynthesisSettings;
};
const preparedDrafts = new Map<string, PreparedWork>();
type Warmup = { id: string; ownerId: string; snapshotSha256: string; session: InterviewSession; createdAt: number; consumed: boolean; bankContentSha256: string; promise: Promise<RecordedTurn> };
const preparations = new Map<string, Warmup>();
const preparationScopes = new Map<string, string>();
async function requireQuestionBank(context: Awaited<typeof contextPromise>, session?: InterviewSession) {
  const bank = session?.plan?.poolKey ? await loadQuestionBankByPinnedPlan(context, session.plan) : await loadQuestionBank(context);
  if (!bank) throw new HttpError(503, '면접 자료의 사전 준비가 필요합니다.');
  return bank;
}

class HttpError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
function publicRequestError(error: unknown) {
  if (error instanceof TurnWorkError) return error.message;
  if (error instanceof HttpError && error.code === 'PREPARATION_REQUIRED') return '다음 질문을 위한 자료 준비가 필요해요. 면접을 마치면 지금까지의 답변은 보존됩니다.';
  if (error instanceof HttpError && error.status === 503) return publicServiceError('connection');
  if (error instanceof HttpError) return serviceDisplayMessage(error, 'connection');
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return publicServiceError(/REACTION|QUESTION_PREPARATION|PLAN_MISMATCH|CITATION/u.test(code) ? 'question' : 'connection');
}
function missingKeys() { return requiredKeys.filter(key => !process.env[key]?.trim()); }
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
}
function guardRequest(req: IncomingMessage) {
  const host = req.headers.host ?? "";
  if (!new Set([`localhost:${port}`, `127.0.0.1:${port}`, `localhost:${webPort}`, `127.0.0.1:${webPort}`]).has(host)) throw new HttpError(403, "로컬 호스트 요청만 허용합니다.");
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) throw new HttpError(403, "허용되지 않은 요청 출처입니다.");
  if (req.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "외부 사이트 요청은 허용하지 않습니다.");
}
async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_000_000) throw new HttpError(413, "관찰 데이터 크기가 너무 큽니다.");
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw new HttpError(400, "요청 형식이 올바르지 않습니다."); }
}
async function sessionContext(session: InterviewSession) {
  assertSessionOwner(session, owner.id);
  const digest = session.runtime!.contextSnapshotSha256;
  let context = pinnedContexts.get(digest);
  if (!context) { context = await store.loadContext(digest, owner.id); pinnedContexts.set(digest, context); }
  if (snapshotHash(context) !== digest || context.manifest.rulesVersion !== session.runtime!.engineVersion) throw new HttpError(409, '면접 당시 자료 버전을 확인하지 못했습니다.');
  return context;
}
function registerSessionAudio(session: InterviewSession) {
  for (const turn of session.turns) for (const url of [turn.questionAudioUrl, turn.acknowledgementAudioUrl]) if (url) audioOwners.set(url, owner.id);
  if (session.runtime?.closingUtterance) audioOwners.set(session.runtime.closingUtterance.audioUrl, owner.id);
  for (const operation of Object.values(session.runtime?.operations ?? {})) {
    for (const work of [operation.prepared, ...(operation.retiredPrepared ?? [])] as Array<PreparedWork | undefined>) {
      for (const url of [work?.cachedQuestionAudioUrl, work?.cachedAcknowledgementAudioUrl]) if (url) audioOwners.set(url, owner.id);
    }
  }
}
async function acceptedEndNeedsRecovery(session: InterviewSession) {
  if (!session.runtime?.endRequestedAt || !session.runtime.acceptedEndRequest) return false;
  if (!evaluationInputFrozen(session) || !session.runtime.evaluationJob) return true;
  return !(await evaluationJobs.get(session.runtime.evaluationJob.id));
}
async function findSession(id: string) {
  const current = sessions.get(id);
  if (current) { assertSessionOwner(current, owner.id); if (current.status === 'active' && !current.runtime?.acceptedEndRequest && current.runtime?.checkpoint.disconnectedAt) { try { assertRecoverableSession(current, owner.id); } catch { throw new HttpError(409, '같은 면접을 이어갈 수 있는 10분이 지났습니다. 저장된 답변은 보존했습니다.'); } } return current; }
  if (loadingSessions.has(id)) return loadingSessions.get(id)!;
  const loading = (async () => {
    let saved: InterviewSession | null;
    try { saved = await store.load(id, owner.id); }
    catch (error) { throw new HttpError(error instanceof Error && error.message === 'SESSION_OWNER_MISMATCH' ? 403 : 409, '저장된 면접의 소유권 또는 기록 버전을 확인하지 못했습니다. 원본 기록은 보존했습니다.'); }
    if (!saved) throw new HttpError(404, '저장된 면접을 찾을 수 없습니다.');
    let restored: InterviewSession;
    const acceptedEnd = await acceptedEndNeedsRecovery(saved);
    try {
      if (acceptedEnd) {
        assertSessionOwner(saved, owner.id);
        restored = structuredClone(saved);
        // This is an already accepted end, not a new interview reconnection.
        // Provider state lost in a crash cannot be promoted to a final answer.
        const unfinished = restored.turns.at(-1);
        if (!evaluationInputFrozen(saved) && unfinished?.transcriptStatus === 'streaming') unfinished.transcriptStatus = 'error';
      } else restored = restoreLogicalSession(saved, owner.id);
    }
    catch (error) { throw new HttpError(409, error instanceof Error && error.message === 'SESSION_RECOVERY_EXPIRED' ? '같은 면접을 이어갈 수 있는 10분이 지났습니다. 저장된 답변은 보존했습니다.' : '이 면접의 소유권과 복원 상태를 확인하지 못했습니다.'); }
    await sessionContext(restored); sessions.set(id, restored); registerSessionAudio(restored);
    // Resume only the new explicitly accepted durable end. Legacy records with
    // pending/failed status have no such intent and remain read-only.
    if (acceptedEnd) await commitSessionEnd(restored, restored.runtime!.acceptedEndRequest!);
    else await syncEvaluation(restored);
    void journal(restored, { type: 'session.restored', actor: 'server', payload: { epoch: restored.runtime?.epoch, checkpoint: restored.runtime?.checkpoint, rawAudioRestored: false } });
    return restored;
  })();
  loadingSessions.set(id, loading);
  try { return await loading; } finally { loadingSessions.delete(id); }
}
function save(session: InterviewSession) { return saveSessionSnapshot(session, store); }
type JournalTurn = { questionText: string | null; acknowledgement: string | null; interviewerId: string | null; sourceTurnId?: string | null };
const journalTurns = new Map<string, Map<string, JournalTurn>>();
const journalId = (kind: string, ...parts: string[]) => `${kind}:${createHash("sha256").update(parts.join("\u0000")).digest("hex")}`;
function journalCaptureId(turn: RecordedTurn) {
  return turn.metadata.lastStreamId ?? journalId("legacy-capture", turn.rawTranscript ?? "", JSON.stringify(turn.sttObservations ?? []));
}
function journal(session: InterviewSession, event: ConversationEvent): Promise<ConversationAppendResult> {
  // Warm-up candidates do not become conversation records until a real session consumes them.
  if (!sessions.has(session.id)) return Promise.resolve({ ok: true, eventId: event.eventId ?? "warmup-skipped", skipped: true });
  const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
  if ((event.type === "question.prepared" || event.type === "acknowledgement.prepared") && event.turnId && typeof payload.text === "string") {
    if (!journalTurns.has(session.id)) journalTurns.set(session.id, new Map());
    const previous = journalTurns.get(session.id)!.get(event.turnId) ?? { questionText: null, acknowledgement: null, interviewerId: null };
    journalTurns.get(session.id)!.set(event.turnId, { ...previous, ...(event.type === "question.prepared" ? { questionText: payload.text } : { acknowledgement: payload.text }), interviewerId: event.role ?? previous.interviewerId, sourceTurnId: typeof payload.sourceTurnId === "string" ? payload.sourceTurnId : previous.sourceTurnId });
    event = { ...event, eventId: event.eventId ?? journalId(event.type, event.turnId, payload.text, String(payload.audioUrl ?? "")) };
    if (payload.voice && typeof payload.voice === "object") void defaultConversationLogger.append(session.id, { eventId: journalId("voice.config", event.turnId!, event.type, JSON.stringify(payload.voice)), type: "provider.config", actor: "server", turnId: event.turnId, role: event.role, payload: { voices: [{ interviewerId: event.role, ...(payload.voice as Record<string, unknown>) }], usage: event.type } }).catch(() => {});
  }
  return defaultConversationLogger.append(session.id, event).catch(() => ({ ok: false, eventId: event.eventId ?? "append-failed", error: { code: "LOG_APPEND_FAILED", message: "로컬 대화 로그를 기록하지 못했습니다." } }));
}
function canonicalJournalTurn(session: InterviewSession, turnId: string): JournalTurn | null {
  const closing = session.runtime?.closingUtterance ?? closingOperations.get(session.id);
  if (closing?.id === turnId) return { questionText: null, acknowledgement: closing.text, interviewerId: closing.interviewerId };
  const index = session.turns.findIndex(item => item.id === turnId);
  const turn = session.turns[index];
  if (turn) return { questionText: turn.questionText, acknowledgement: turn.acknowledgement, interviewerId: turn.interviewerId, sourceTurnId: session.turns[index - 1]?.id ?? null };
  for (const [key, work] of preparedDrafts) if (key.startsWith(`${session.id}:`) && work.id === turnId) return { questionText: work.draft?.questionText ?? null, acknowledgement: work.acknowledgement, interviewerId: work.interviewerId, sourceTurnId: work.sourceTurnId };
  for (const operation of Object.values(session.runtime?.operations ?? {})) {
    for (const work of [operation.prepared, ...(operation.retiredPrepared ?? [])] as Array<PreparedWork | undefined>) {
      if (work?.id === turnId) return { questionText: work.draft?.questionText ?? null, acknowledgement: work.acknowledgement, interviewerId: work.interviewerId, sourceTurnId: work.sourceTurnId };
    }
  }
  return journalTurns.get(session.id)?.get(turnId) ?? null;
}
function applyClientEvent(session: InterviewSession, event: z.infer<typeof clientConversationEventSchema>) {
  const canonical = event.turnId ? canonicalJournalTurn(session, event.turnId) : null;
  if (event.turnId && !canonical) throw new HttpError(409, "이 면접의 대화 턴을 확인할 수 없습니다.");
  const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
  const frozen = evaluationInputFrozen(session);
  if (!frozen && typeof payload.elapsedMs === 'number' && Number.isFinite(payload.elapsedMs) && payload.elapsedMs >= 0 && payload.elapsedMs <= 86_400_000) session.elapsedMs = Math.max(session.elapsedMs, payload.elapsedMs);
  const isClosing = event.turnId === (session.runtime?.closingUtterance ?? closingOperations.get(session.id))?.id;
  const isOpening = event.turnId === session.runtime?.opening?.questionTurnId && (event.type === 'acknowledgement_playing' || event.type === 'audio_ended' && payload.role === 'acknowledgement');
  const pendingOperation = Object.values(session.runtime?.operations ?? {}).find(operation => (operation.prepared as PreparedWork | undefined)?.id === event.turnId);
  if (!frozen && pendingOperation && event.type === 'acknowledgement_playing') pendingOperation.acknowledgementDelivery = { ...pendingOperation.acknowledgementDelivery, startedAt: new Date().toISOString() };
  if (!frozen && pendingOperation && event.type === 'audio_ended' && payload.role === 'acknowledgement') pendingOperation.acknowledgementDelivery = { ...pendingOperation.acknowledgementDelivery, completedAt: new Date().toISOString() };
  let type = "phase.changed", role: string | undefined;
  let details: Record<string, unknown> = { phase: event.phase ?? null, clientAtMs: event.atMs, clockId: event.clockId ?? null, observedBy: "browser-event", ...(frozen ? { lateAfterEvaluationFreeze: true, evaluationInputMutated: false } : {}) };
  if (event.type === "acknowledgement_playing" || event.type === "question_playing") {
    role = isClosing ? 'closing' : isOpening ? 'opening' : event.type === "acknowledgement_playing" ? "acknowledgement" : "question";
    const text = role === "acknowledgement" || role === 'closing' || role === 'opening' ? canonical?.acknowledgement : canonical?.questionText;
    if (!event.turnId || !text) throw new HttpError(409, "실제로 준비한 면접관 발화를 확인할 수 없습니다.");
    type = "playback.started";
    details = { ...details, text, interviewerId: canonical?.interviewerId ?? null, sourceTurnId: canonical?.sourceTurnId ?? null };
    if (isClosing && !frozen) session.runtime!.closingDelivery = { ...session.runtime!.closingDelivery, startedAt: new Date().toISOString() };
    if (isOpening) { if (!frozen) { session.runtime!.opening!.delivery = { ...session.runtime!.opening!.delivery, startedAt: new Date().toISOString() }; session.hasGreeted = true; } details.utteranceId = session.runtime!.opening!.id; }
  } else if (event.type === "audio_ended") {
    if (!event.turnId) throw new HttpError(409, "재생한 면접관 발화의 턴을 확인할 수 없습니다.");
    type = "playback.ended";
    role = isClosing ? 'closing' : isOpening ? 'opening' : payload.role === "question" || payload.role === "acknowledgement" ? payload.role : undefined;
    details = { ...details, text: role === "question" ? canonical?.questionText : role === "acknowledgement" || role === 'closing' || role === 'opening' ? canonical?.acknowledgement : null, interviewerId: canonical?.interviewerId ?? null };
    if (isClosing && !frozen) session.runtime!.closingDelivery = { ...session.runtime!.closingDelivery, completedAt: new Date().toISOString() };
    if (isOpening) { if (!frozen) session.runtime!.opening!.delivery = { ...session.runtime!.opening!.delivery, completedAt: new Date().toISOString() }; details.utteranceId = session.runtime!.opening!.id; }
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
        session.runtime.firstEvaluationDelivery = { eventId: journalId('first-evaluation-normal-delivery', session.id, presented.turnId), turnId: presented.turnId, observedAt: new Date().toISOString(), clockId: presented.clockId, status: 'normal_delivery_observed', entitlementLedgerImplemented: false };
        void journal(session, { eventId: session.runtime.firstEvaluationDelivery.eventId, type: 'session.first_evaluation_delivered', actor: 'server', turnId: presented.turnId, payload: session.runtime.firstEvaluationDelivery });
      }
    }
  }
  if (!frozen && event.type === 'phase_changed' && event.phase) checkpointSession(session, event.phase);
  // Persist even duplicate retries: an earlier ledger save may have failed after in-memory mutation.
  return { persist: !frozen && Boolean(pendingOperation || isOpening || event.type === 'phase_changed' || event.type === 'question_playing' || event.type === 'audio_ended' || event.type === 'client_error'), event: { eventId: event.eventId, type, actor: 'client' as const, turnId: event.turnId, role, payload: details } };
}
async function journalClientEvent(session: InterviewSession, event: z.infer<typeof clientConversationEventSchema>) {
  const applied = applyClientEvent(session, event);
  if (applied.persist) await save(session);
  return journal(session, applied.event);
}
function assertActiveObservationScope(session: InterviewSession, epoch: number) {
  if (session.status !== 'active' || session.runtime?.endRequestedAt || evaluationInputFrozen(session) || session.runtime!.epoch !== epoch) throw new HttpError(409, '중단하거나 종료한 면접의 늦은 재생 기록을 무시했습니다.');
}
/** Validate the whole batch, then apply without yielding before the route's answer/flight lock. */
function applyPlaybackBatch(session: InterviewSession, events: readonly ClientPlaybackEvent[] = []) {
  const unique = new Map<string, ClientPlaybackEvent>();
  for (const event of events) {
    const previous = unique.get(event.eventId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) throw new HttpError(409, '같은 재생 기록의 내용이 변경되었습니다.');
    unique.set(event.eventId, event);
  }
  for (const event of unique.values()) {
    const canonical = canonicalJournalTurn(session, event.turnId);
    const isClosing = event.turnId === (session.runtime?.closingUtterance ?? closingOperations.get(session.id))?.id;
    const speech = event.type === 'question_playing' ? canonical?.questionText : event.type === 'acknowledgement_playing' ? canonical?.acknowledgement : true;
    if (!canonical || !speech || isClosing) throw new HttpError(409, '이 면접에서 준비한 재생 기록을 확인하지 못했습니다.');
  }
  const acceptedIds = [...unique.keys()];
  const applied = [...unique.values()].map(event => applyClientEvent(session, event));
  return { acceptedIds, applied };
}
function appendPlaybackBatch(session: InterviewSession, batch: ReturnType<typeof applyPlaybackBatch>) {
  for (const applied of batch.applied) void journal(session, applied.event);
}
async function journalClientBackup(session: InterviewSession, metrics: Record<string, unknown>) {
  if (!Array.isArray(metrics.clientEventsBackup)) return;
  const operations: Promise<unknown>[] = [];
  for (const candidate of metrics.clientEventsBackup.slice(0, 4096)) {
    const parsed = clientConversationEventSchema.safeParse(candidate);
    if (parsed.success) operations.push(journalClientEvent(session, parsed.data).catch(() => journal(session, { type: "error", actor: "server", payload: { source: "client-event-backup", code: "UNKNOWN_TURN_EVENT" } })));
    else operations.push(journal(session, { type: "error", actor: "server", payload: { source: "client-event-backup", code: "INVALID_EVENT" } }));
  }
  await Promise.all(operations);
}
function journalSessionCreated(session: InterviewSession, context: Awaited<typeof contextPromise>) {
  void journal(session, { eventId: "session-created", type: "session.created", actor: "server", payload: { target: session.target, durationSeconds: session.durationSeconds, mainQuestionTarget: session.mainQuestionTarget, plan: session.plan, createdAt: session.createdAt } });
  void journal(session, { eventId: "sources-snapshot", type: "sources.snapshot", actor: "server", payload: { manifest: session.sourceManifest, school: context.school, studentEvidence: context.student.evidence } });
  void journal(session, { eventId: "rules-snapshot", type: "rules.snapshot", actor: "server", payload: { rulesVersion: interviewConfig.rulesVersion, questionGuidelines: context.questionGuidelines, evaluationGuidelines: context.evaluationGuidelines } });
  void journal(session, { eventId: "runtime-config", type: "provider.config", actor: "server", payload: { questionModel: process.env.OPENAI_QUESTION_MODEL || "gpt-6-luna", realtimeModel: realtimeCoreModel(), factReviewModel: runtimeFactReviewModel(), evaluationModel: process.env.OPENAI_ANALYSIS_MODEL || "gpt-6.1-terra", voiceConfiguration: { primarySpeaker: process.env.CLOVA_VOICE_SPEAKER || interviewerVoiceDefaults.primary, secondarySpeaker: process.env.CLOVA_VOICE_SECOND_SPEAKER || interviewerVoiceDefaults.secondary, primarySpeed: process.env.CLOVA_VOICE_PRIMARY_SPEED ?? null, secondarySpeed: process.env.CLOVA_VOICE_SECOND_SPEED ?? null, legacyCommonSpeed: process.env.CLOVA_VOICE_SPEED ?? null, pitch: process.env.CLOVA_VOICE_PITCH ?? null }, ports: { realtime: port, web: webPort } } });
  for (const turn of session.turns) {
    const metadata = turn.metadata as typeof turn.metadata & { voiceSettings?: { question?: SpeechSynthesisSettings; acknowledgement?: SpeechSynthesisSettings } };
    void journal(session, { type: "question.prepared", actor: "server", turnId: turn.id, role: turn.interviewerId, payload: { text: turn.questionText, audioUrl: turn.questionAudioUrl, voice: metadata.voiceSettings?.question ?? null, metadata: turn.metadata, preparedCacheHit: true } });
    if (turn.acknowledgement) void journal(session, { type: "acknowledgement.prepared", actor: "server", turnId: turn.id, role: turn.interviewerId, payload: { text: turn.acknowledgement, audioUrl: turn.acknowledgementAudioUrl, voice: metadata.voiceSettings?.acknowledgement ?? null } });
  }
  void journal(session, { type: "session.snapshot", actor: "server", payload: session });
}
function publicTurn(turn: RecordedTurn) {
  return {
    id: turn.id, questionText: turn.questionText, questionKind: turn.questionKind,
    parentMainQuestionId: turn.parentMainQuestionId, mainIndex: turn.mainIndex,
    mainCount: turn.mainCount, mainCountIsLimit: turn.mainCountIsLimit, followUpIndex: turn.followUpIndex,
    evidenceIds: turn.evidenceIds, questionAudioUrl: turn.questionAudioUrl,
    acknowledgement: turn.acknowledgement, acknowledgementAudioUrl: turn.acknowledgementAudioUrl,
    interviewerId: turn.interviewerId,
  };
}
async function prepareTurn(session: InterviewSession, forceMain = false, onAcknowledgement?: (event: AcknowledgementReady) => void, persist = true, retryKey?: string, workContext?: TurnWorkContext): Promise<RecordedTurn | null> {
  const started = performance.now();
  const context = await sessionContext(session);
  const epoch = session.runtime!.epoch;
  const durationSeconds = sessionDurationSeconds(session, context.interviewOverview?.durationSeconds ?? NaN);
  const mainTarget = sessionMainQuestionTarget(session, durationSeconds);
  const previous = session.turns.at(-1);
  const allowFollowUp = mayAskFollowUp(session, durationSeconds, interviewConfig.maxFollowUps);
  const allowClarification = mayAskClarification(session, durationSeconds);
  const assertActive = () => { workContext?.assertLive(); if (session.status !== "active" || session.runtime!.endRequestedAt || evaluationInputFrozen(session) || session.runtime!.epoch !== epoch) throw new HttpError(409, "종료하거나 복원한 면접의 늦은 질문 준비 결과를 무시했습니다."); };
  const retireUncommittedWork = async (prepared: PreparedWork, code: 'QUESTION_ACTION_BUDGET_EXHAUSTED' | 'QUESTION_REPAIR_PROOF_INVALID' | 'QUESTION_REPAIR_RECOVERY_UNAVAILABLE'): Promise<never> => {
    assertActive();
    const operation = retryKey ? session.runtime!.operations[retryKey] : undefined;
    if (operation) {
      (operation.retiredPrepared ??= []).push(structuredClone(prepared));
      delete operation.prepared; delete operation.acknowledgementDelivery;
      operation.status = code === 'QUESTION_REPAIR_RECOVERY_UNAVAILABLE' ? 'blocked' : 'retryable';
      if (code === 'QUESTION_REPAIR_RECOVERY_UNAVAILABLE') operation.failureCode = code; else delete operation.failureCode;
    }
    if (retryKey) preparedDrafts.delete(retryKey);
    checkpointSession(session, code === 'QUESTION_ACTION_BUDGET_EXHAUSTED' ? 'follow_up_budget_reconciled' : 'question_repair_cache_retired');
    await save(session); assertActive();
    throw new HttpError(409, code === 'QUESTION_REPAIR_RECOVERY_UNAVAILABLE' ? '질문 연결을 복구할 근거를 확인하지 못했습니다. 면접을 마치면 지금까지의 답변은 저장됩니다.' : '확인한 기록을 바탕으로 다음 질문을 다시 연결합니다.', code);
  };
  let work = retryKey ? preparedDrafts.get(retryKey) : undefined;
  if (!work && retryKey && session.runtime?.operations[retryKey]?.prepared) {
    const saved = session.runtime.operations[retryKey].prepared as PreparedWork;
    if (!saved.id || saved.sourceTurnId !== previous?.id || !saved.draft || saved.draft.validationStatus !== 'approved' || saved.draft.premiseValidation && saved.draft.premiseValidation.questionSha256 !== createHash('sha256').update(saved.draft.questionText).digest('hex')) throw new HttpError(409, '저장된 질문 준비 체크포인트를 확인하지 못했습니다.');
    work = structuredClone(saved); preparedDrafts.set(retryKey, work);
  }
  if (work) {
    assertActive();
    const execution = previous?.metadata.coreDecision?.execution as { surfaceOrigin?: unknown } | undefined;
    const repaired = work.position.kind !== 'main' && Boolean((work.coreTimings?.repairModelCalls ?? 0) > 0 || execution?.surfaceOrigin === 'bounded_surface_repair');
    if (work.draft) {
      const parsedSemantic = singleCoreCandidateDecisionSchema.safeParse(previous?.metadata.coreDecision?.semanticDecision);
      const original = parsedSemantic.success ? parsedSemantic.data.next : undefined;
      try {
        if (repaired && (!original || original.action !== 'FOLLOW_UP' && original.action !== 'CLARIFICATION' || work.draft.questionKind !== (original.action === 'FOLLOW_UP' ? 'follow_up' : 'clarification'))) throw new Error('REPAIR_PROOF_INVALID');
        const expected = repaired && original && (original.action === 'FOLLOW_UP' || original.action === 'CLARIFICATION') ? createRepairContract({ ...work.draft, questionText: original.question.text,
          primaryFunction: original.action === 'FOLLOW_UP' ? original.question.primaryFunction : previous!.metadata.primaryFunction,
          depth: original.action === 'FOLLOW_UP' ? original.question.depth : previous!.metadata.depth,
          targetEvidence: original.action === 'FOLLOW_UP' ? [original.question.target] : [...previous!.metadata.targetEvidence] }) : undefined;
        assertRepairProof(work.draft, repaired ? expected : undefined, repaired);
        if (work.draft.approvedQuestion) assertQuestionContractIntegrity(work.draft, work.draft.approvedQuestion);
      } catch {
        // Never retry the same unverifiable surface. A verified original
        // decision can be executed/reviewed again without another core call.
        const candidate = previous?.metadata.answerCandidateId ? session.runtime?.answerCandidates?.[previous.metadata.answerCandidateId] : undefined;
        let recoverable = false;
        if (previous && candidate?.decision?.kind === 'ADVANCE') {
          try {
            assertCandidateSource(previous, candidate);
            assertSingleCoreCandidateBinding(context, session, candidate.decision, session.runtime?.runtimePolicy?.mode ?? 'compiled');
            previous.metadata.coreDecision = { ...previous.metadata.coreDecision, sourceTurnId: previous.id, sourceAnswerId: previous.answerId,
              sourceTranscriptSha256: transcriptHash(previous.rawTranscript ?? ''), engineVersion: candidate.decision.engineVersion,
              semanticDecision: candidate.decision.semanticDecision, questionRecoveryRequired: true };
            recoverable = true;
          } catch { /* An unbound decision cannot authorize new model work. */ }
        } else if (previous && !candidate?.decision && parsedSemantic.success && parsedSemantic.data.assessment !== null) {
          const saved = previous.metadata.coreDecision;
          recoverable = saved?.sourceTurnId === previous.id && saved.sourceAnswerId === previous.answerId && saved.engineVersion === SINGLE_CORE_ENGINE_VERSION && saved.sourceTranscriptSha256 === transcriptHash(previous.rawTranscript ?? '');
          if (recoverable) saved!.questionRecoveryRequired = true;
        }
        await retireUncommittedWork(work, recoverable ? 'QUESTION_REPAIR_PROOF_INVALID' : 'QUESTION_REPAIR_RECOVERY_UNAVAILABLE');
      }
    }
    if (work.position.kind === 'follow_up' && !allowFollowUp && retryKey) {
      await retireUncommittedWork(work, 'QUESTION_ACTION_BUDGET_EXHAUSTED');
    }
  }
  const retryCacheHit = Boolean(work);
  if (!work) {
    const usageAttemptId = randomUUID();
    const usageStageAttempts = new Map<string, number>();
    const candidate = previous?.metadata.answerCandidateId ? session.runtime?.answerCandidates?.[previous.metadata.answerCandidateId] : undefined;
    const pendingCandidateDecision = candidate?.decision?.kind === 'ADVANCE' ? candidate.decision : undefined;
    let core = previous ? await runTurnWorkStage(workContext, Infinity, () => runRealtimeCore(context, session, { workContext, pendingCandidateDecision, policyMode: session.runtime?.runtimePolicy?.mode ?? 'compiled', recoveryOnly: !pendingCandidateDecision && previous.metadata.coreDecision?.questionRecoveryRequired === true && previous.metadata.coreDecision?.sourceTurnId === previous.id && previous.metadata.coreDecision?.sourceAnswerId === previous.answerId, allowFollowUp: allowFollowUp && !forceMain, allowClarification: allowClarification && !forceMain, allowReplay: !forceMain && mayReplayQuestion(session, durationSeconds), onProviderUsage: (stage, observation) => { const attempt = (usageStageAttempts.get(stage) ?? 0) + 1; usageStageAttempts.set(stage, attempt); observeSessionUsage(session, stage, `${usageAttemptId}:${stage}:${attempt}`, observation); } })) : undefined;
    assertActive();
    // Another observer can reconcile older playback while the core/review was
    // awaiting I/O. Enforce the latest delivery budget before reserving a UUID.
    if (core?.reaction.directive.startsWith('follow_up') && !mayAskFollowUp(session, durationSeconds, interviewConfig.maxFollowUps)) core = { ...core, draft: null, nextAction: 'TRANSITION', reaction: { ...core.reaction, action: 'transition', directive: 'next_main' }, ...(core.execution ? { execution: { ...core.execution, action: 'TRANSITION' } } : {}), serverGuards: [...(core.serverGuards ?? []), 'QUESTION_ACTION_BUDGET_EXHAUSTED'] };
    if (core?.nextAction === 'CONTINUE_ANSWER') throw new HttpError(409, '답변을 이어서 말씀해 주세요.', 'ANSWER_CONTINUATION_REQUIRED');
    let reaction = core?.reaction;
    let draft = core?.draft ?? undefined;
    const desired = reaction?.directive === 'clarification_same_target' ? 'clarification' as const : reaction?.directive.startsWith('follow_up') ? 'follow_up' as const : 'main' as const;
    const clarificationMode = core?.clarificationMode ?? 'rephrase';
    let restatementUnavailable = false;
    if (!core?.questionRecoveryRequired && desired === 'clarification' && draft?.questionKind !== 'clarification') {
      draft = (clarificationMode === 'repeat_audio' ? approvedAudioReplay(context, session) : approvedRestatement(context, session, context.student.evidence.filter(source => previous?.evidenceIds.includes(source.id)), reaction)) ?? undefined;
      if (!draft) {
        // An old or unverifiable approval never authorizes a runtime model chain or invented question.
        restatementUnavailable = true;
        reaction = reaction ? { ...reaction, classification: 'unassessed', reasonCode: 'REACTION_VALIDATION_FAILED', action: 'transition', directive: 'next_main', keywordQuote: null, evidenceSpan: null, missingTarget: null, reply: null } : undefined;
      }
    }
    assertActive();
    if (previous && reaction) {
      previous.metadata.answerReaction = reaction;
        const coreDecision = { sourceTurnId: previous.id, sourceAnswerId: previous.answerId ?? null, sourceTranscriptSha256: transcriptHash(previous.rawTranscript ?? ''), engineVersion: core?.engineVersion ?? 'legacy-provider', fulfillment: core?.fulfillment ?? (reaction.classification === 'relevant' ? 'met' as const : reaction.classification === 'partial' ? 'partial' as const : 'unknown' as const), nextAction: core?.nextAction ?? (reaction.directive === 'clarification_same_target' ? 'CLARIFICATION' as const : reaction.directive.startsWith('follow_up') ? 'FOLLOW_UP' as const : 'TRANSITION' as const), targetDescription: core?.targetDescription ?? null, decisionReasonCode: core?.decisionReasonCode ?? null, requestedAction: core?.requestedAction ?? null, strategyDecision: core?.strategyDecision ?? null, origin: core?.origin ?? 'deterministic', followUpGoal: core?.followUpGoal ?? null, failureCode: core?.failureCode ?? null, serverGuards: core?.serverGuards ?? [], providerTimings: core?.providerTimings ?? { coreMs: 0, coreModelCalls: 0 }, actualDirective: reaction.directive, bridge: reaction.bridge ?? null, answerRelation: core?.answerRelation ?? null };
        const persistedCoreDecision = { ...coreDecision, ...(core?.execution?.status === 'blocked' ? { actualDirective: 'preserve_current_question' } : {}), ...(core?.semanticDecision ? { semanticDecision: core.semanticDecision } : {}), ...(core?.execution ? { execution: core.execution } : {}), ...(core?.factReviewTraces ? { factReviewTraces: core.factReviewTraces } : {}), ...(core?.interpretation ? { interpretation: core.interpretation } : {}), ...(core?.failureStage ? { failureStage: core.failureStage } : {}), ...(core?.failureDetail ? { failureDetail: core.failureDetail } : {}), ...(core?.providerUnavailable ? { providerUnavailable: true } : {}), ...(core?.questionRecoveryRequired ? { questionRecoveryRequired: true } : {}), ...(core?.reviewTrace ? { reviewTrace: core.reviewTrace } : {}), ...(core?.reviewTraces ? { reviewTraces: core.reviewTraces } : {}), ...(core?.turnLocalCoverage ? { turn_local_coverage: core.turnLocalCoverage } : {}), ...(core?.policyTrace ? { policyTrace: core.policyTrace } : {}), ...(core?.providerUsage ? { providerUsage: core.providerUsage } : {}), ...(core?.candidateQuestion ? { candidateQuestion: core.candidateQuestion } : {}) };
        Object.assign(previous.metadata, { coreDecision: persistedCoreDecision });
        if (persist) journal(session, { type: 'answer.core_decision', actor: 'server', turnId: previous.id, answerId: previous.answerId, payload: persistedCoreDecision });
      if (persist) journal(session, { type: "answer.relevance", actor: "server", turnId: previous.id, answerId: previous.answerId, payload: reaction });
      const trace = answerContextTrace(session);
      previous.metadata.answerContext = trace;
      if (persist) journal(session, { type: 'answer.context', actor: 'server', turnId: previous.id, answerId: previous.answerId, payload: trace });
      session.conversationLedger = buildConversationLedger(session);
      if (persist) journal(session, { type: 'answer.ledger', actor: 'server', turnId: previous.id, answerId: previous.answerId, payload: conversationLedgerTrace(session.conversationLedger) });
    }
    if (core?.providerUnavailable) {
      // A rejected provider account/quota is not an answer-quality decision or
      // permission to advance through cached Q0. Keep the finalized answer and
      // let an explicit later request retry this same operation after recovery.
      checkpointSession(session, 'provider_unavailable');
      if (retryKey && session.runtime?.operations[retryKey]) session.runtime.operations[retryKey] = { ...session.runtime.operations[retryKey], status: 'retryable', failureCode: 'QUESTION_PROVIDER_UNAVAILABLE' };
      await save(session);
      throw new HttpError(503, '질문 연결을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.', 'QUESTION_PROVIDER_UNAVAILABLE');
    }
    if (core?.questionRecoveryRequired || restatementUnavailable) {
      checkpointSession(session, 'question_review_failed');
      if (retryKey && session.runtime?.operations[retryKey]) session.runtime.operations[retryKey] = { ...session.runtime.operations[retryKey], status: 'retryable', failureCode: 'QUESTION_REVIEW_UNAVAILABLE' };
      await save(session);
      throw new HttpError(503, '질문 연결을 다시 준비하지 못했습니다. 같은 답변으로 다시 시도해 주세요.', 'QUESTION_REVIEW_UNAVAILABLE');
    }
    if (core?.nextAction === 'CLOSING') return null;
    const position = nextPosition(session, desired, mainTarget, interviewConfig.maxFollowUps, durationSeconds, { clarificationMode });
    if (!position) return null;
    const bank = await requireQuestionBank(context, session);
    const main = position.kind === 'main' ? selectNextPreparedMainQuestion(bank, session) : null;
    if (position.kind === 'main' && !main) {
      checkpointSession(session, 'candidate_exhausted');
      if (retryKey && session.runtime?.operations[retryKey]) session.runtime.operations[retryKey] = { ...session.runtime.operations[retryKey], status: 'blocked', failureCode: 'PREPARATION_REQUIRED' };
      await save(session);
      throw new HttpError(503, '다음 질문을 위한 추가 사전 준비가 필요합니다.', 'PREPARATION_REQUIRED');
    }
    draft ??= main?.draft;
    if (!draft || draft.questionKind !== position.kind) throw new HttpError(422, '현재 면접 순서의 질문을 확인하지 못했습니다.');
    if (main) {
      const offline = draft.providerTimings ?? {};
      draft = { ...draft, providerTimings: { offlineQuestionGenerationMs: offline.questionGenerationMs ?? 0, offlinePremiseReviewMs: offline.premiseReviewMs ?? 0, offlinePremiseReviewAttempts: offline.premiseReviewAttempts ?? 0, questionGenerationMs: 0, premiseReviewMs: 0, premiseReviewAttempts: 0 } };
    }
    const slot = position.kind === "main" ? main?.slot ?? session.plan?.slots[position.mainIndex - 1] : currentPlanSlot(session);
    const interviewerId = slot?.interviewerId ?? previous?.interviewerId ?? "interviewer-1";
    const role = interviewerId === "interviewer-1" ? "primary" : "secondary";
    const speaker = role === "primary" ? process.env.CLOVA_VOICE_SPEAKER || interviewerVoiceDefaults.primary : process.env.CLOVA_VOICE_SECOND_SPEAKER || interviewerVoiceDefaults.secondary;
    const turnId = randomUUID(), preparedDraft = structuredClone(draft);
    if (context.interviewerPolicy && preparedDraft.premiseValidation) Object.assign(preparedDraft, bindQuestionContractToTurn(preparedDraft, context, session, turnId));
    work = { id: turnId, sourceTurnId: previous?.id, reaction, position, interviewerId, role, speaker, acknowledgement: !previous && !session.hasGreeted ? '안녕하세요. 면접을 시작하겠습니다.' : reaction?.reply ?? null, acknowledgementQuote: reaction?.keywordQuote ?? null,
      draft: { ...preparedDraft, ...(position.kind === 'clarification' ? { clarificationMode } : {}) }, cachedQuestionAudioUrl: clarificationMode === 'repeat_audio' && position.kind === 'clarification' ? previous?.questionAudioUrl : main?.audioUrl, cachedVoiceSettings: main?.voiceSettings, bankKey: main?.bankKey, candidateId: main?.candidateId,
      selectionTrace: main?.selectionTrace ?? undefined,
      coreTimings: core?.providerTimings ?? { coreMs: 0, coreModelCalls: 0 }, llmMs: core?.providerTimings.coreMs ?? 0 };
    // Reserve identity, progression and voice BEFORE publishing an early reaction.
    if (retryKey) {
      preparedDrafts.set(retryKey, work);
      const operation = session.runtime!.operations[retryKey];
      if (operation) operation.prepared = structuredClone(work);
      await save(session); // Publish no early speech before its exact approved draft/identity is durable.
    }
  }
  const preparedWork = work;
  const { id, position, interviewerId, speaker, role } = preparedWork;
  const parentId = position.parentId ?? id;
  const slot = position.kind === "main" ? session.plan?.slots[position.mainIndex - 1] : currentPlanSlot(session);
  const providerTimings: Record<string, number> = { reactionMs: 0, llmMs: retryCacheHit ? 0 : preparedWork.llmMs ?? 0, draftCacheHit: Number(retryCacheHit), ...preparedWork.coreTimings, ...(retryCacheHit ? { coreMs: 0, coreModelCalls: 0, originalCoreMs: preparedWork.coreTimings?.coreMs ?? 0, originalCoreModelCalls: preparedWork.coreTimings?.coreModelCalls ?? 0 } : {}), ...(preparedWork.cachedQuestionAudioUrl ? { preparedMainBankHit: 1 } : {}) };
  const voiceSettings: { question?: SpeechSynthesisSettings; acknowledgement?: SpeechSynthesisSettings } = {};
  const priorTurn = session.turns.at(-1);
  const priorVoice = (priorTurn?.metadata as { voiceSettings?: { question?: SpeechSynthesisSettings } } | undefined)?.voiceSettings?.question;
  const pinnedVoice = preparedWork.cachedVoiceSettings ?? (priorTurn?.interviewerId === interviewerId ? priorVoice : undefined);
  const synthesisSpeaker = pinnedVoice?.speaker ?? speaker;
  const recordAudio = (kind: "question" | "acknowledgement", text: string, audioUrl: string) => {
    if (persist) journal(session, { type: `${kind}.prepared`, actor: "provider", turnId: id, role: interviewerId, payload: { text, audioUrl, voice: voiceSettings[kind], providerTimings, sourceTurnId: preparedWork.sourceTurnId } });
  };
  assertActive();
  if (position.kind === 'follow_up' && !mayAskFollowUp(session, durationSeconds, interviewConfig.maxFollowUps)) await retireUncommittedWork(preparedWork, 'QUESTION_ACTION_BUDGET_EXHAUSTED');
  // One core response owns the decision; cached audio and new follow-up TTS prepare in parallel.
  const acknowledgementPromise = preparedWork.acknowledgement ? (async () => {
    const cached = preparedWork.cachedAcknowledgementAudioUrl;
    const reusable = cached && await readSpeechAudio(cached.slice('/api/audio/'.length));
    if (reusable) { voiceSettings.acknowledgement = preparedWork.cachedAcknowledgementSettings; providerTimings.acknowledgementTtsMs = 0; providerTimings.acknowledgementTtsCacheHit = 1; return cached; }
    return runTurnWorkStage(workContext, 35_000, stage => synthesizeSpeech(preparedWork.acknowledgement!, synthesisSpeaker, { signal: stage.signal, role, ...(pinnedVoice ? { settings: pinnedVoice } : {}), onTiming: timing => {
    providerTimings.acknowledgementTtsMs = timing.durationMs; providerTimings.acknowledgementTtsCacheHit = Number(timing.cache !== "provider"); voiceSettings.acknowledgement = timing.settings;
    } }));
  })().then(async audioUrl => {
      assertActive();
      preparedWork.cachedAcknowledgementAudioUrl = audioUrl; preparedWork.cachedAcknowledgementSettings = voiceSettings.acknowledgement;
      if (retryKey && session.runtime!.operations[retryKey]) { session.runtime!.operations[retryKey].prepared = structuredClone(preparedWork); audioOwners.set(audioUrl, owner.id); await save(session); }
      assertActive();
      if (session.status === "active" && session.runtime!.epoch === epoch) {
        providerTimings.ackReadyMs = performance.now() - started;
        recordAudio("acknowledgement", preparedWork.acknowledgement!, audioUrl);
        if (!retryKey || !session.runtime!.operations[retryKey]?.acknowledgementDelivery?.completedAt) onAcknowledgement?.({ type: "acknowledgement_ready", turnId: id, acknowledgement: preparedWork.acknowledgement!, acknowledgementAudioUrl: audioUrl, interviewerId });
      }
      return audioUrl;
    }) : Promise.resolve(null);
  const questionPromise = (async () => {
    const draft = structuredClone(preparedWork.draft!);
    assertActive();
    const audioUrl = preparedWork.cachedQuestionAudioUrl ?? await runTurnWorkStage(workContext, 35_000, stage => synthesizeSpeech(draft.questionText, synthesisSpeaker, { signal: stage.signal, role, ...(pinnedVoice ? { settings: pinnedVoice } : {}), onTiming: timing => { providerTimings.questionTtsMs = timing.durationMs; providerTimings.questionTtsCacheHit = Number(timing.cache !== "provider"); voiceSettings.question = timing.settings; } }));
    assertActive();
    if (preparedWork.cachedVoiceSettings) { voiceSettings.question = preparedWork.cachedVoiceSettings; providerTimings.questionTtsMs = 0; providerTimings.questionTtsCacheHit = 1; }
    providerTimings.questionReadyMs = performance.now() - started;
    recordAudio("question", draft.questionText, audioUrl);
    return { draft, audioUrl };
  })();
  const [{ draft, audioUrl: questionAudioUrl }, acknowledgementAudioUrl] = await Promise.all([questionPromise, acknowledgementPromise]);
  assertActive();
  if (position.kind === 'follow_up' && !mayAskFollowUp(session, durationSeconds, interviewConfig.maxFollowUps)) await retireUncommittedWork(preparedWork, 'QUESTION_ACTION_BUDGET_EXHAUSTED');
  const turn: RecordedTurn = {
    id, questionText: draft.questionText, questionKind: position.kind,
    parentMainQuestionId: parentId, mainIndex: position.mainIndex,
    mainCount: mainTarget, mainCountIsLimit: session.plan?.scheduling === 'time_based' ? false : undefined, followUpIndex: position.followUpIndex,
    evidenceIds: draft.evidenceIds, questionAudioUrl, acknowledgement: preparedWork.acknowledgement,
    acknowledgementAudioUrl, interviewerId,
    metadata: { acknowledgementQuote: preparedWork.acknowledgementQuote, evidenceQuotes: draft.evidenceQuotes, primaryFunction: draft.primaryFunction, questionIntent: draft.questionIntent, targetEvidence: draft.targetEvidence, depth: draft.depth, groundingRationale: draft.groundingRationale, validationStatus: "approved", validationFailures: [], rulesVersion: interviewConfig.rulesVersion, generatedAt: new Date().toISOString(), answerTurnId: position.kind !== "main" ? previous?.id ?? null : null, sourceAnswerId: position.kind !== "main" ? previous?.answerId ?? null : null, sourceRefIds: draft.evidenceIds, activityIds: [...new Set(context.student.evidence.filter(item => draft.evidenceIds.includes(item.id)).map(item => item.activityId))], supportTarget: context.target, questionClusterId: parentId, parentQuestionId: position.kind !== "main" ? previous?.id ?? null : null, nonEvaluative: position.kind === "clarification", ...(position.kind === "clarification" && previous ? { clarificationOfTurnId: actualEvaluativeQuestion(session, previous)?.id ?? previous.id, clarificationMode: draft.clarificationMode ?? 'rephrase' } : {}) },
  };
  Object.assign(turn.metadata, { commonApproval: draft.commonApproval, premiseValidation: draft.premiseValidation, followUpLanguage: draft.followUpLanguage, questionReferenceContext: draft.questionReferenceContext, questionBlueprint: draft.questionBlueprint, approvedQuestion: draft.approvedQuestion, questionRealization: draft.questionRealization, strategyTrace: draft.strategyTrace, bridge: preparedWork.reaction?.bridge ?? null, planSlotId: slot?.id, topicArea: slot?.topicArea, interviewerRole: slot?.interviewerRole, schoolConnections: slot?.schoolConnections, questionBankKey: preparedWork.bankKey, questionBankCandidateId: preparedWork.candidateId, selectionTrace: preparedWork.selectionTrace, voiceSettings, providerTimings: { ...draft.providerTimings, ...providerTimings, prepareMs: performance.now() - started } });
  if (draft.questionBlueprint) {
    turn.metadata.answerTurnId = draft.questionBlueprint.answerTurnId;
    turn.metadata.sourceAnswerId = position.kind === 'main' ? null : previous?.answerId ?? null;
  }
  const oldCounter = session.followUpCountByMainQuestion[parentId];
  const oldLedger = session.conversationLedger;
  session.turns.push(turn);
  session.conversationLedger = buildConversationLedger(session);
  if (!session.runtime || position.kind === 'main') session.followUpCountByMainQuestion[parentId] = position.followUpIndex;
  const greetedBefore = session.hasGreeted;
  if (!session.runtime) session.hasGreeted = true;
  const oldOperation = retryKey ? session.runtime?.operations[retryKey] : undefined;
  if (retryKey && session.runtime) session.runtime.operations[retryKey] = { ...oldOperation, status: 'committed', startedAt: oldOperation?.startedAt ?? new Date().toISOString(), epoch, result: { turn: structuredClone(turn), done: false } };
  try { if (persist) await save(session); }
  catch (error) {
    session.hasGreeted = greetedBefore;
    session.turns.pop();
    session.conversationLedger = oldLedger;
    if (retryKey && session.runtime) { if (oldOperation) session.runtime.operations[retryKey] = oldOperation; else delete session.runtime.operations[retryKey]; }
    if (oldCounter === undefined) delete session.followUpCountByMainQuestion[parentId];
    else session.followUpCountByMainQuestion[parentId] = oldCounter;
    throw error;
  }
  if (persist && (draft.followUpLanguage || draft.questionReferenceContext || preparedWork.reaction?.bridge)) void journal(session, {
    eventId: journalId('question.wording', turn.id), type: 'question.wording', actor: 'server', turnId: turn.id, role: turn.interviewerId,
    payload: { sourceTurnId: previous?.id ?? null, sourceAnswerId: previous?.answerId ?? null, followUpLanguage: draft.followUpLanguage ?? null, questionReferenceContext: draft.questionReferenceContext ?? null, strategyTrace: draft.strategyTrace ?? null, questionRealization: draft.questionRealization ?? null, questionBlueprint: draft.questionBlueprint ?? null, approvedQuestion: draft.approvedQuestion ?? null, bridge: preparedWork.reaction?.bridge ?? null },
  });
  if (retryKey) preparedDrafts.delete(retryKey);
  return turn;
}

function newSession(context: Awaited<typeof contextPromise>, plan = createInterviewPlan(context, randomUUID())): InterviewSession {
  if (!context.interviewOverview) throw new HttpError(422, "대상 전형의 공식 면접 시간을 확인해 주세요.");
  const now = new Date().toISOString();
  const runtime = createSessionRuntime(context, owner, now); pinnedContexts.set(runtime.contextSnapshotSha256, structuredClone(context));
  return { id: randomUUID(), createdAt: now, updatedAt: now, status: "active", evaluationStatus: "pending", target: context.target, runtime, sourceManifest: { ...structuredClone(context.manifest), interviewPlan: structuredClone(plan) }, durationSeconds: context.interviewOverview.durationSeconds, interviewOverview: structuredClone(context.interviewOverview), plan, mainQuestionTarget: plan.mainQuestionTarget, hasGreeted: false, turns: [], questionPresentations: [], questionPresentationEventIds: [], followUpCountByMainQuestion: {}, elapsedMs: 0 };
}
async function prepareFirstQuestion(preparationId?: string) {
  const missing = missingKeys();
  if (missing.length) throw new HttpError(503, `다음 환경변수를 설정해 주세요: ${missing.join(", ")}`);
  const context = await contextPromise;
  if (context.errors.length) throw new HttpError(422, context.errors.join(" "));
  const bank = await requireQuestionBank(context);
  const snapshotSha256 = snapshotHash(context), preparationScopeKey = `${owner.id}:${snapshotSha256}:${bank.contentSha256}`;
  if (preparationId) {
    const existing = preparations.get(preparationId);
    if (!existing || existing.ownerId !== owner.id || existing.snapshotSha256 !== snapshotSha256 || existing.bankContentSha256 !== bank.contentSha256 || existing.consumed || Date.now() - existing.createdAt >= 15 * 60_000) throw new HttpError(409, '준비한 학생·지원처·자료가 변경되었거나 이미 사용되었습니다. 시작 전 확인을 다시 진행해 주세요.');
    return existing;
  }
  const warmup = preparations.get(preparationScopes.get(preparationScopeKey) ?? '');
  if (warmup && !warmup.consumed && Date.now() - warmup.createdAt < 15 * 60_000) return warmup;
  await store.saveContext(context, owner.id);
  const history = [...(await store.list(owner.id)), ...sessions.values()].filter((row, index, rows) => rows.findIndex(other => other.id === row.id) === index);
  if (!context.student.studentId || !context.school.interview?.id) throw new HttpError(503, '학생 전체 분석과 지원처별 분석의 사전 준비가 필요합니다.');
  const scope = { ownerId: owner.id, studentId: context.student.studentId, supportTargetId: context.school.interview.id };
  const exposure = await loadGuidebookExposure(context, process.cwd(), { scope });
  const reviewedLineage = await loadQuestionPurposeLineage(context, bank);
  const purposeLineage = reviewedLineage && reviewedLineage.scope.ownerId === scope.ownerId && reviewedLineage.scope.studentId === scope.studentId && reviewedLineage.scope.supportTargetId === scope.supportTargetId ? reviewedLineage : undefined;
  const plan = createSessionQuestionPlan(context, bank, { sessionSeed: randomUUID(), history, mode: 'mock', scope, exposure, purposeLineage });
  const entry: Warmup = { id: randomUUID(), ownerId: owner.id, snapshotSha256, session: newSession(context, plan), createdAt: Date.now(), consumed: false, bankContentSha256: bank.contentSha256, promise: Promise.resolve(null as unknown as RecordedTurn) };
  preparations.set(entry.id, entry); preparationScopes.set(preparationScopeKey, entry.id);
  entry.promise = prepareTurn(entry.session, false, undefined, false).then(turn => { if (!turn) throw new HttpError(422, "첫 질문을 준비할 수 없습니다."); return turn; }).catch(error => { preparations.delete(entry.id); if (preparationScopes.get(preparationScopeKey) === entry.id) preparationScopes.delete(preparationScopeKey); throw error; });
  return entry;
}

async function prepareClosing(session: InterviewSession, reason: ClosingUtterance['reason'], workContext?: TurnWorkContext): Promise<ClosingUtterance> {
  workContext?.assertLive();
  if (session.runtime?.closingUtterance) return session.runtime.closingUtterance;
  const epoch = session.runtime!.epoch;
  const delivered = [...(session.questionPresentations ?? [])].reverse().find(item => item.startedAtMs !== null);
  const last = session.turns.find(turn => turn.id === delivered?.turnId) ?? session.turns.at(-1);
  const interviewerId = last?.interviewerId ?? 'interviewer-1', role = interviewerId === 'interviewer-1' ? 'primary' : 'secondary';
  const settings = (last?.metadata as { voiceSettings?: { question?: SpeechSynthesisSettings } } | undefined)?.voiceSettings;
  const speaker = settings?.question?.speaker ?? (role === 'primary' ? process.env.CLOVA_VOICE_SPEAKER || interviewerVoiceDefaults.primary : process.env.CLOVA_VOICE_SECOND_SPEAKER || interviewerVoiceDefaults.secondary);
  const text = reason === 'technical_failure' ? '연결 상태를 확인한 뒤 다시 진행해 주세요.' : '면접은 여기까지 하겠습니다. 수고하셨습니다.';
  let voiceSettings: SpeechSynthesisSettings | undefined;
  const audioUrl = await runTurnWorkStage(workContext, 35_000, stage => synthesizeSpeech(text, speaker, { signal: stage.signal, role, ...(settings?.question ? { settings: settings.question } : {}), onTiming: timing => { voiceSettings = timing.settings; } }));
  workContext?.assertLive();
  if (session.runtime!.epoch !== epoch || session.status === 'completed') throw new HttpError(409, '종료된 면접의 늦은 음성 결과를 무시했습니다.');
  const closing: ClosingUtterance = { id: randomUUID(), text, audioUrl, interviewerId, nonEvaluative: true, reason, ...(voiceSettings ? { voiceSettings } : {}) };
  session.runtime!.closingUtterance = closing; audioOwners.set(audioUrl, owner.id);
  checkpointSession(session, 'closing_prepared');
  void journal(session, { type: 'closing.prepared', actor: 'server', role: interviewerId, payload: closing });
  return closing;
}

const speechTimingSchema = z.object({ durationMs: z.number().finite().min(0).max(7_200_000), speakingMs: z.number().finite().min(0).max(7_200_000).nullable().optional(), firstSpeechMs: z.number().finite().min(0).max(7_200_000).nullable().optional() });
function answerMetrics(answerId: string, transcript: string, input: unknown) {
  const object = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const timing = speechTimingSchema.safeParse(object.speech);
  const durationMs = timing.success ? timing.data.durationMs : 0;
  const speakingMs = timing.success && timing.data.speakingMs != null && timing.data.speakingMs <= durationMs ? timing.data.speakingMs : null;
  const firstSpeechMs = timing.success && timing.data.firstSpeechMs != null && timing.data.firstSpeechMs <= durationMs ? timing.data.firstSpeechMs : null;
  return { ...object, speech: calculateSpeechMetrics({ rawTranscript: transcript, durationMs, speakingMs, firstSpeechMs }), habits: observeSpeechHabits(answerId, transcript, durationMs), timingOrigin: "client-monotonic-observed", transcriptOrigin: "CLOVA-Speech-gRPC" };
}
function recordAnswerObservation(session: InterviewSession, turn: RecordedTurn) {
  if (!isFinalizedAnswer(turn)) return;
  turn.answerObservation = observeAnswerSubmission(turn.rawTranscript, turn.metrics, turn.metadata.answerEndingObservation);
  if (!turn.answerObservation.nonAnswer) return;
  const payload = { ...turn.answerObservation, rawTranscript: turn.rawTranscript, transcriptStatus: turn.transcriptStatus,
    microphoneEnabled: turn.metadata.answerEndingObservation?.microphoneEnabled ?? null,
    reasonCode: turn.metadata.answerEndingObservation?.microphoneEnabled === false ? 'INPUT_DISABLED' : 'NO_ANSWER', scoring: "no-fabricated-content-or-independent-silence-score" };
  void journal(session, { eventId: journalId("answer.non_answer", turn.id, turn.answerId), type: "answer.non_answer", actor: "server", turnId: turn.id, answerId: turn.answerId, payload });
  if (turn.answerObservation.classification === "silence_observed") void journal(session, { eventId: journalId("answer.silence", turn.id, turn.answerId), type: "answer.silence", actor: "server", turnId: turn.id, answerId: turn.answerId, payload });
}
function publicSessionProgress(session: InterviewSession) {
  return { status: session.status, evaluationStatus: session.evaluationStatus };
}
function publicRecovery(session: InterviewSession) {
  const messages = session.turns.flatMap(turn => {
    const shown = session.questionPresentations?.some(event => event.turnId === turn.id && event.startedAtMs !== null);
    return [...(shown ? [{ id: `${turn.id}:question`, role: 'interviewer', kind: 'question', text: turn.questionText, time: 0 }] : []),
      ...(turn.transcriptStatus === 'finalized' && turn.rawTranscript?.trim() ? [{ id: `${turn.id}:answer`, role: 'candidate', kind: 'answer', text: turn.rawTranscript, time: 0 }] : [])];
  });
  const current = session.turns.at(-1), projection = current ? publicTurn(current) : null;
  if (projection && session.runtime?.opening?.questionTurnId === projection.id && session.runtime.opening.delivery?.startedAt) { projection.acknowledgement = null; projection.acknowledgementAudioUrl = null; }
  if (session.runtime?.opening?.delivery?.startedAt) messages.unshift({ id: `${session.runtime.opening.questionTurnId}:ack`, role: 'interviewer', kind: 'acknowledgement', text: session.runtime.opening.text, time: 0 });
  return { ...recoveryProjection(session), currentTurn: projection, messages };
}
const projectedEvaluationJobs = new Set<string>();
function projectReviewedEvaluation(session: InterviewSession, reviewed: ReviewedEvaluationRevisionView) {
  session.evaluationStatus = reviewed.status;
  if (reviewed.status === 'completed') {
    session.status = 'completed'; session.evaluation = reviewed.evaluation; delete session.evaluationError;
  } else {
    session.status = 'ending'; delete session.evaluation;
    if (reviewed.error) session.evaluationError = reviewed.error; else delete session.evaluationError;
  }
}
async function syncEvaluation(session: InterviewSession) {
  if (!session.runtime || session.status === 'active') return;
  const reviewed = await loadReviewedEvaluationRevision({ session, ownerId: owner.id, jobs: evaluationJobs, sessions: store, reviews: evaluationReviews, revisions: evaluationRevisions });
  if (reviewed) { projectReviewedEvaluation(session, reviewed); return; }
  const context = await sessionContext(session);
  const reference = session.runtime.evaluationJob;
  if (reference && reference.pipelineVersion !== EVALUATION_PIPELINE_VERSION) {
    const historical = await loadHistoricalCompletedEvaluation(session, context, owner.id, evaluationJobs);
    if (historical) { session.evaluationStatus = 'completed'; session.status = 'completed'; session.evaluation = historical.evaluation; delete session.evaluationError; return; }
    session.evaluationStatus = 'failed'; session.status = 'ending'; delete session.evaluation; session.evaluationError = 'EVALUATION_PIPELINE_VERSION_CHANGED'; return;
  }
  const sourceSha256 = evaluationSessionSourceFingerprint(context, session, reference?.model);
  const id = reference?.id ?? evaluationJobId(session.id, owner.id, sourceSha256, EVALUATION_PIPELINE_VERSION);
  const job = await evaluationJobs.get(id);
  if (!job) {
    if (reference) { session.evaluationStatus = 'failed'; session.evaluationError = 'EVALUATION_JOB_MISSING'; }
    return; // Legacy records retain their original status until an explicit retry.
  }
  if (job.ownerId !== owner.id || job.sourceSha256 !== sourceSha256 || job.contextSnapshotSha256 !== session.runtime.contextSnapshotSha256 ||
    reference && (reference.sourceSha256 !== job.sourceSha256 || reference.model !== job.model)) throw new Error('EVALUATION_RESULT_SOURCE_MISMATCH');
  const result = await evaluationJobs.result(job);
  session.evaluationStatus = job.status === 'queued' ? 'pending' : job.status;
  if (result) { session.evaluation = result.evaluation; session.status = 'completed'; delete session.evaluationError; }
  else { session.status = 'ending'; if (job.error) session.evaluationError = job.error.message; else delete session.evaluationError; }
  // Result files are the authoritative new revision. Do not write a stale full
  // session back over the original transcript/metrics snapshot during polling.
  if (['completed', 'failed'].includes(job.status) && !projectedEvaluationJobs.has(id + ':' + job.status)) {
    projectedEvaluationJobs.add(id + ':' + job.status);
    for (const usage of job.usage) observeSessionUsage(session, 'evaluation', usage.attemptId, usage.observation);
    void journal(session, { eventId: `evaluation-job:${id}:${job.status}`, type: 'evaluation.status', actor: 'server', payload: {
      status: session.evaluationStatus, error: session.evaluationError ?? null, jobId: id, sourceSha256, resultSha256: job.resultSha256,
      resultStorage: 'versioned-evaluation-job-result', evaluation: result?.evaluation ?? null,
    } });
    await defaultConversationLogger.flush(session.id);
  }
}
async function beginEvaluation(session: InterviewSession, retry = false) {
  session.runtime!.evaluationInputFrozenAt ??= new Date().toISOString();
  const reviewedOptions = { session, ownerId: owner.id, jobs: evaluationJobs, sessions: store, reviews: evaluationReviews, revisions: evaluationRevisions };
  const reviewed = retry ? await retryReviewedEvaluationRevision(reviewedOptions) : await loadReviewedEvaluationRevision(reviewedOptions);
  if (reviewed) { projectReviewedEvaluation(session, reviewed); return; }
  await syncEvaluation(session);
  if (session.evaluationStatus === 'completed') return;
  if (session.evaluationStatus === 'review_required') return;
  if (!retry && session.runtime?.evaluationJob && ['pending', 'running'].includes(session.evaluationStatus)) return;
  const context = await sessionContext(session);
  const model = session.runtime?.evaluationJob?.model ?? process.env.OPENAI_ANALYSIS_MODEL ?? 'gpt-6.1-terra';
  const sourceSha256 = evaluationSessionSourceFingerprint(context, session, model);
  const id = evaluationJobId(session.id, owner.id, sourceSha256, EVALUATION_PIPELINE_VERSION);
  session.runtime!.evaluationJob = { id, pipelineVersion: EVALUATION_PIPELINE_VERSION, sourceSha256, model };
  session.evaluationStatus = 'pending'; delete session.evaluationError;
  // Persist the accepted source and pointer before publishing a runnable job.
  // A crash cannot leave a queue result whose source was never durably saved.
  await save(session);
  let job = await evaluationJobs.enqueue(session, sourceSha256, EVALUATION_PIPELINE_VERSION, Date.now(), model);
  if (retry && job.status === 'failed') job = await evaluationJobs.retry(job.id) ?? job;
  session.runtime!.evaluationJob = { id: job.id, pipelineVersion: job.pipelineVersion, sourceSha256: job.sourceSha256, model: job.model };
  session.evaluationStatus = job.status === 'queued' ? 'pending' : job.status;
  delete session.evaluationError;
  void journal(session, { eventId: `evaluation-job:${job.id}:queued:${job.attempts}`, type: 'evaluation.status', actor: 'server', payload: {
    status: session.evaluationStatus, jobId: job.id, sourceSha256, pipelineVersion: EVALUATION_PIPELINE_VERSION,
    answeredTurnIds: session.turns.filter(turn => turn.rawTranscript?.trim()).map(turn => turn.id),
    finalizedTurnIds: session.turns.filter(isFinalizedAnswer).map(turn => turn.id),
  } });
}

async function commitSessionEnd(session: InterviewSession, body: { metrics?: unknown; elapsedMs?: number }) {
      await endOperations.run(session.id, async () => {
      if (evaluationInputFrozen(session) || session.status === 'completed') {
        await syncEvaluation(session);
        if (session.status !== 'completed' && (!session.runtime?.evaluationJob || session.evaluationError === 'EVALUATION_JOB_MISSING')) await beginEvaluation(session);
        return;
      }
      const suppliedMetrics = body.metrics && typeof body.metrics === 'object' ? body.metrics as Record<string, unknown> : {};
      const captureScopeSchema = z.object({ turnId: z.string().uuid(), answerId: z.string().min(1).max(160), captureRevision: z.number().int().min(1) });
      const requestedScope = suppliedMetrics.captureFinishScope === undefined ? null : captureScopeSchema.parse(suppliedMetrics.captureFinishScope);
      const capturedTurn = session.turns.at(-1);
      if (!session.runtime!.acceptedEndRequest && requestedScope && (!capturedTurn || capturedTurn.id !== requestedScope.turnId || capturedTurn.answerId !== requestedScope.answerId || capturedTurn.metadata.answerCaptureRevision !== requestedScope.captureRevision)) throw new HttpError(409, '종료할 답변의 식별자가 일치하지 않습니다.');
      session.runtime!.endRequestedAt ??= new Date().toISOString();
      submissionWork.cancelSession(session.id);
      session.runtime!.acceptedEndRequest ??= { elapsedMs: Math.max(session.elapsedMs, body.elapsedMs ?? 0), metrics: structuredClone(suppliedMetrics) };
      // Persist intent BEFORE waiting on STT, browser playback or client events.
      // A disconnected response does not cancel this server-owned operation.
      await save(session);
      const endMetrics = session.runtime!.acceptedEndRequest.metrics;
      const finishScope = endMetrics.captureFinishScope === undefined ? null : captureScopeSchema.parse(endMetrics.captureFinishScope);
      await journalClientBackup(session, endMetrics);
      const activeStreams = [...streams.get(session.id) ?? []];
      await Promise.all(activeStreams.map(async stream => {
        const drain = endCaptureDrains.get(stream);
        try {
          if (drain && finishScope && drain.turnId === finishScope.turnId && drain.answerId === finishScope.answerId && drain.captureRevision === finishScope.captureRevision) {
            // HTTP and WS are independent transports. The existing WS finish
            // marker follows flushed PCM in the socket queue; wait for that
            // marker before ending the provider stream.
            let timer: ReturnType<typeof setTimeout> | undefined;
            const received = await Promise.race([drain.receipt.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 2_000); })]);
            if (timer) clearTimeout(timer);
            if (!received) throw new Error('END_CAPTURE_FINISH_NOT_RECEIVED');
          }
          if (drain) await drain.finishForEnd(); else await stream.finish();
        } catch (error) {
          const interrupted = session.turns.find(turn => turn.id === drain?.turnId) ?? session.turns.at(-1);
          if (interrupted?.transcriptStatus === 'streaming') interrupted.transcriptStatus = 'error';
          void journal(session, { type: 'error', actor: 'server', turnId: interrupted?.id, answerId: interrupted?.answerId, payload: { source: 'end-capture-drain', code: 'END_CAPTURE_UNCONFIRMED', message: safeProviderError(error), rawTranscript: interrupted?.rawTranscript ?? '' } });
        }
      }));
      for (const stream of activeStreams) stream.close();
      for (const stream of activeStreams) endCaptureDrains.delete(stream);
      streams.delete(session.id);
      const pausedTurn = session.turns.at(-1);
      if (pausedTurn?.transcriptStatus === 'paused' && pausedTurn.metadata.answerSubmissionMode === 'staged-v2') {
        try { assertCaptureConfirmed(pausedTurn); }
        catch {
          pausedTurn.transcriptStatus = 'error';
          void journal(session, { type: 'error', actor: 'server', turnId: pausedTurn.id, answerId: pausedTurn.answerId, payload: { source: 'end-recovered-capture', code: 'END_CAPTURE_UNCONFIRMED', rawTranscript: pausedTurn.rawTranscript ?? '' } });
        }
      }
      finalizeCapturedTurnForEnd(session.turns.at(-1), activeStreams.length > 0);
      const endingTurn = session.turns.at(-1);
      if (endingTurn?.metadata.answerSubmissionMode === 'staged-v2' && endingTurn.transcriptStatus === 'finalized') endingTurn.metadata.answerCommitStatus = 'committed';
      session.status = "ending";
      session.runtime!.epoch++;
      checkpointSession(session, 'ending');
      for (const key of preparedDrafts.keys()) if (key.startsWith(`${session.id}:`)) preparedDrafts.delete(key);
      const timingBackup = z.record(z.string().uuid(), z.record(z.string().min(1), z.number().finite().min(0))).safeParse(endMetrics.clientTimingsByTurn);
      if (timingBackup.success) for (const [turnId, timings] of Object.entries(timingBackup.data)) {
        const timedTurn = session.turns.find(turn => turn.id === turnId);
        if (timedTurn) { timedTurn.metadata.clientTimings = { ...timedTurn.metadata.clientTimings, ...timings }; void journal(session, { type: "timings.observed", actor: "client", turnId, payload: { clientTimings: timedTurn.metadata.clientTimings, origin: "end-backup" } }); }
      }
      session.metrics = { ...endMetrics, latency: summarizeSessionLatency(session) };
      session.elapsedMs = session.runtime!.acceptedEndRequest.elapsedMs;
      const lastTurn = session.turns.at(-1);
      if (isFinalizedAnswer(lastTurn)) {
        const scoped = Array.isArray(endMetrics.answers) ? endMetrics.answers.find(item => item && typeof item === 'object' && (item as { turnId?: string }).turnId === lastTurn.id && (item as { answerId?: string }).answerId === lastTurn.answerId) : null;
        const currentMetrics = scoped ?? (endMetrics.lastObservedAnswerTurnId === lastTurn.id ? endMetrics : lastTurn.metrics ?? {});
        lastTurn.metrics = answerMetrics(lastTurn.answerId, lastTurn.rawTranscript, currentMetrics);
      }
      if (lastTurn) recordAnswerObservation(session, lastTurn);
      if (lastTurn?.transcriptStatus === "finalized" && lastTurn.answerId) {
        const captureAttemptId = journalCaptureId(lastTurn);
        void journal(session, { eventId: journalId("answer.submitted", lastTurn.id, lastTurn.answerId, captureAttemptId), type: "answer.submitted", actor: "candidate", turnId: lastTurn.id, answerId: lastTurn.answerId, payload: { source: "explicit-end", rawTranscript: lastTurn.rawTranscript ?? "", captureAttemptId } });
        void journal(session, { eventId: journalId("stt.final", lastTurn.id, lastTurn.answerId, captureAttemptId), type: "stt.final", actor: "candidate", turnId: lastTurn.id, answerId: lastTurn.answerId, payload: { rawTranscript: lastTurn.rawTranscript ?? "", source: "explicit-end", captureAttemptId, observations: lastTurn.sttObservations ?? null } });
      }
      void journal(session, { eventId: "session-ended", type: "session.ended", actor: "server", payload: { elapsedMs: session.elapsedMs, status: session.status, metrics: session.metrics } });
      void journal(session, { type: "session.snapshot", actor: "server", payload: session });
      await beginEvaluation(session);
      });
}

const server = http.createServer(async (req, res) => {
  let scopedSession: InterviewSession | undefined;
  try {
    guardRequest(req);
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (req.method === "GET" && url.pathname === "/api/health") return send(res, 200, { app: "each-answer-interview", ok: true, workspaceId });
    if (req.method === "GET" && url.pathname === "/api/status") {
      const context = await contextPromise;
      const missing = missingKeys();
      const mainQuestionCount = context.interviewOverview ? createInterviewPlan(context).mainQuestionTarget : null;
      const bank = !context.errors.length ? await requireQuestionBank(context).catch(() => null) : null;
      const analysisIdentityReady = Boolean(context.student.studentId && context.school.interview?.id);
      let policyReady = true; try { if (context.interviewerPolicy) compilePolicyClauseRegistry(context); } catch { policyReady = false; }
      return send(res, 200, { ready: !missing.length && !context.errors.length && Boolean(context.interviewOverview) && Boolean(bank) && analysisIdentityReady && policyReady, policyReady, missingKeys: missing, errors: [...context.errors, ...(!policyReady ? ['면접 운영 규칙의 연결 검수가 필요합니다.'] : []), ...(!bank && !context.errors.length ? ['면접 자료의 사전 준비가 필요합니다.'] : []), ...(!analysisIdentityReady ? ['학생 전체 분석과 지원처별 분석의 사전 준비가 필요합니다.'] : [])], target: context.target, realtimePort: port, durationSeconds: context.interviewOverview?.durationSeconds ?? interviewConfig.durationSeconds, interviewOverview: context.interviewOverview, mainQuestionCount, maxFollowUps: interviewConfig.maxFollowUps, turnWaitTimeoutMs: interviewConfig.turnWaitTimeoutMs, sources: { academicYear: context.manifest.academicYear, recordIds: context.manifest.recordIds, studentPageCount: context.student.pageCount, studentEvidenceCount: context.student.evidence.length, rulesVersion: context.manifest.rulesVersion, interviewerPolicy: context.manifest.interviewerPolicy ?? null, questionStrategies: context.manifest.questionStrategyCatalog ?? null, sourceFingerprint: createHash('sha256').update(JSON.stringify({ files: context.manifest.files, versions: context.manifest.guidelineSourceVersions, target: context.target })).digest('hex'), questionReferenceDigest: context.manifest.questionReferenceCatalog?.digest ?? null, questionReferenceCount: context.manifest.questionReferenceCatalog?.runtimeApprovedQuestions ?? 0, questionReferenceAnalysis: context.manifest.questionReferenceCatalog?.analysis?.coverage ?? null, questionBankKey: bank?.key ?? null, questionBankContentSha256: bank?.contentSha256 ?? null }, optionalMissing: process.env.CLOVA_SPEECH_DOMAIN_ID ? [] : ["CLOVA_SPEECH_DOMAIN_ID"], providerValidation: 'not_called', preparationReady: Boolean(bank) && analysisIdentityReady, questionBankReady: Boolean(bank), evaluationScopeReadiness: bankScopeReadiness(context, bank), analysisIdentityReady });
    }
    if (req.method === "POST" && url.pathname === "/api/prepare") {
      await readJson(req);
      const preparation = await prepareFirstQuestion();
      const prepared = await preparation.promise;
      const bank = await requireQuestionBank(await contextPromise);
      for (const slot of bank.slots) for (const candidate of slot.candidates) audioOwners.set(candidate.questionAudioUrl, owner.id);
      if (prepared.acknowledgementAudioUrl) audioOwners.set(prepared.acknowledgementAudioUrl, owner.id);
      return send(res, 200, { preparationId: preparation.id, ready: true, mainQuestionCount: preparation.session.mainQuestionTarget, durationSeconds: preparation.session.durationSeconds, questionAudioUrl: prepared.questionAudioUrl, questionAudioUrls: [prepared.questionAudioUrl, ...(prepared.acknowledgementAudioUrl ? [prepared.acknowledgementAudioUrl] : [])], questionBankKey: bank.key, runtimeModelCalls: 0 });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/audio/")) {
      if (audioOwners.get(url.pathname) !== owner.id) {
        const context = await contextPromise, bank = await requireQuestionBank(context).catch(() => null);
        for (const slot of bank?.slots ?? []) for (const candidate of slot.candidates) audioOwners.set(candidate.questionAudioUrl, owner.id);
        for (const saved of await store.list(owner.id)) registerSessionAudio(saved);
      }
      if (audioOwners.get(url.pathname) !== owner.id) throw new HttpError(404, '이 면접에서 준비한 음성을 찾을 수 없습니다.');
      const bytes = await readSpeechAudio(url.pathname.slice("/api/audio/".length));
      if (!bytes) throw new HttpError(404, "준비된 음성을 찾을 수 없습니다.");
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": bytes.length, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" });
      return void res.end(bytes);
    }
    if (req.method === "POST" && url.pathname === "/api/sessions") {
      const missing = missingKeys();
      if (missing.length) throw new HttpError(503, `다음 환경변수를 설정해 주세요: ${missing.join(", ")}`);
      const context = await contextPromise;
      if (context.errors.length) throw new HttpError(422, context.errors.join(" "));
      if (!context.interviewOverview) throw new HttpError(422, "대상 전형의 공식 면접 개요와 시간을 확인해 주세요.");
      const body = z.object({ preparationId: z.string().uuid().optional() }).parse(await readJson(req));
      // Revalidate the bank/content digest even when the browser already has a preparation ID.
      const preparation = await prepareFirstQuestion(body.preparationId);
      const prepared = await preparation.promise;
      // Atomic consumption prevents two distinct interviews from sharing turn identities.
      if (preparation.consumed) throw new HttpError(409, "첫 질문이 다른 면접에 사용되었습니다. 다시 시작해 주세요.");
      preparation.consumed = true;
      const session = newSession(context, structuredClone(preparation.session.plan!));
      const firstId = randomUUID();
      const turn: RecordedTurn = { ...structuredClone(prepared), id: firstId, parentMainQuestionId: firstId, metadata: { ...structuredClone(prepared.metadata), questionClusterId: firstId, providerTimings: { ...prepared.metadata.providerTimings, preparedCacheHit: 1 } } };
      if (context.interviewerPolicy && turn.metadata.premiseValidation) {
        const firstDraft: QuestionDraft = { ...turn.metadata, acknowledgement: null, questionText: turn.questionText, questionKind: 'main', parentMainQuestionId: null, evidenceIds: turn.evidenceIds };
        Object.assign(turn.metadata, bindQuestionContractToTurn(firstDraft, context, session, firstId));
      }
      session.turns.push(turn); session.followUpCountByMainQuestion[firstId] = 0; session.hasGreeted = false;
      if (turn.acknowledgement && turn.acknowledgementAudioUrl) session.runtime!.opening = { id: randomUUID(), questionTurnId: firstId, text: turn.acknowledgement, audioUrl: turn.acknowledgementAudioUrl, interviewerId: turn.interviewerId };
      session.conversationLedger = buildConversationLedger(session);
      sessions.set(session.id, session);
      checkpointSession(session, 'question_prepared'); registerSessionAudio(session);
      scopedSession = session;
      await save(session);
      journalSessionCreated(session, context);
      if (session.runtime?.opening) void journal(session, { type: 'opening.prepared', actor: 'server', role: turn.interviewerId, payload: session.runtime.opening });
      return send(res, 201, { sessionId: session.id, turn: publicTurn(turn), durationSeconds: session.durationSeconds, mainQuestionTarget: session.mainQuestionTarget });
    }
    const match = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})(?:\/(next|answer-candidate|end|closing|retry-evaluation|timings|events))?$/);
    if (!match) throw new HttpError(404, "요청한 기능을 찾을 수 없습니다.");
    const session = await findSession(match[1]);
    scopedSession = session;
    if (req.method === "GET" && !match[2]) { await syncEvaluation(session); return send(res, 200, { sessionId: session.id, target: session.target, ...publicSessionProgress(session), durationSeconds: sessionDurationSeconds(session, (await sessionContext(session)).interviewOverview?.durationSeconds ?? NaN), mainQuestionTarget: session.mainQuestionTarget, evaluationError: !session.evaluationError ? null : publicServiceError('evaluation'), logging: defaultConversationLogger.getStatus(session.id)[0] ?? null, recovery: publicRecovery(session), evaluation: session.status === 'completed' ? session.evaluation ?? null : null, localDevelopmentOwner: { mode: owner.mode, authentication: 'development-only-not-commercial-authentication' } }); }
    if (req.method !== "POST") throw new HttpError(405, "허용되지 않은 요청 방식입니다.");
    if (session.runtime!.engineVersion !== interviewConfig.rulesVersion && !['events', 'retry-evaluation'].includes(match[2] ?? '')) throw new HttpError(409, '저장된 면접의 실행 버전이 달라 기록 조회만 가능합니다.');
    if (match[2] === "events") {
      const event = clientConversationEventSchema.parse(await readJson(req));
      const result = await journalClientEvent(session, event);
      return send(res, 200, { accepted: true, logged: result.ok, duplicate: "duplicate" in result && Boolean(result.duplicate), logging: defaultConversationLogger.getStatus(session.id)[0] ?? null });
    }
    if (match[2] === "timings") {
      const body = z.object({ turnId: z.string().uuid(), clientTimings: z.record(z.string().min(1), z.number().finite().min(0)) }).parse(await readJson(req));
      const timedTurn = session.turns.find(turn => turn.id === body.turnId);
      if (!timedTurn) throw new HttpError(409, "기록할 답변 턴을 확인할 수 없습니다.");
      const frozen = evaluationInputFrozen(session);
      if (!frozen) timedTurn.metadata.clientTimings = { ...timedTurn.metadata.clientTimings, ...body.clientTimings };
      void journal(session, { type: "timings.observed", actor: "client", turnId: timedTurn.id, payload: { clientTimings: frozen ? body.clientTimings : timedTurn.metadata.clientTimings, origin: "client-monotonic", ...(frozen ? { lateAfterEvaluationFreeze: true, evaluationInputMutated: false } : {}) } });
      if (!frozen) await save(session);
      return send(res, 200, { saved: true });
    }
    if (match[2] === 'answer-candidate') {
      const body = answerCandidateRequestSchema.parse(await readJson(req));
      const observationEpoch = session.runtime!.epoch;
      const turn = session.turns.at(-1);
      if (session.status !== 'active' || session.runtime?.endRequestedAt || !turn || turn.id !== body.turnId || turn.answerId !== body.answerId ||
        turn.metadata.answerCaptureRevision !== body.captureRevision || turn.transcriptStatus !== 'paused') throw new HttpError(409, '현재 전사 후보와 요청이 일치하지 않습니다.');
      try { assertCaptureConfirmed(turn); } catch { throw new HttpError(409, '최종 전사 수신을 확인한 뒤 답변을 확정해 주세요.'); }
      const operationKey = `${session.id}:${turn.id}:${body.answerId}`;
      if (nextOperations.pendingResult(operationKey) || session.runtime!.operations[operationKey]?.status === 'committed' || session.runtime!.operations[operationKey]?.status === 'running') throw new HttpError(409, '이미 확정 중인 답변입니다.');
      assertActiveObservationScope(session, observationEpoch);
      const workContext = submissionWork.get(session, body, body.submissionAttemptId);
      const observationBatch = applyPlaybackBatch(session, body.clientEvents);
      const candidates = session.runtime!.answerCandidates ??= {};
      let candidate = Object.values(candidates).find(row => row.turnId === turn.id && row.answerId === body.answerId && row.captureRevision === body.captureRevision);
      if (candidate) {
        try { assertCandidateSource(turn, candidate); } catch { throw new HttpError(409, '전사 후보의 원문이 변경되었습니다.'); }
      } else {
        candidate = { id: randomUUID(), turnId: turn.id, answerId: body.answerId, captureRevision: body.captureRevision,
          sourceTranscriptSha256: transcriptHash(turn.rawTranscript ?? ''), status: 'deciding', createdAt: new Date().toISOString(), endingObservation: body.endingObservation };
        candidates[candidate.id] = candidate;
      }
      turn.metadata.answerSubmissionMode = 'staged-v2';
      turn.metadata.answerCandidateId = candidate.id;
      turn.metadata.answerEndingObservation = candidate.endingObservation;
      const response = (row: AnswerCandidateState) => {
        workContext.assertLive();
        assertActiveObservationScope(session, observationEpoch);
        if (session.turns.at(-1) !== turn) throw new HttpError(409, '이전 답변의 늦은 판단을 무시했습니다.');
        assertCandidateSource(turn, row);
        if (row.status === 'continuing') submissionWork.complete(session, body);
        return send(res, 200, { action: row.status === 'continuing' ? 'CONTINUE_ANSWER' : 'ADVANCE', candidateId: row.id, captureRevision: row.captureRevision, rawTranscript: turn.rawTranscript ?? '', acceptedClientEventIds: observationBatch.acceptedIds });
      };
      if (['continuing', 'advance_ready'].includes(candidate.status)) {
        if (observationBatch.acceptedIds.length) { await save(session); assertActiveObservationScope(session, observationEpoch); appendPlaybackBatch(session, observationBatch); }
        return response(candidate);
      }
      const flightKey = `${session.id}:${candidate.id}`;
      const existing = candidateFlights.get(flightKey);
      if (existing) {
        if (observationBatch.acceptedIds.length) { await save(session); assertActiveObservationScope(session, observationEpoch); appendPlaybackBatch(session, observationBatch); }
        return response(await existing);
      }
      const boundCandidate = candidate;
      turn.metadata.answerCommitStatus = 'deciding'; candidate.status = 'deciding';
      const epoch = session.runtime!.epoch;
      const work = (async () => {
        checkpointSession(session, 'deciding_answer_candidate');
        session.elapsedMs = Math.max(session.elapsedMs, body.elapsedMs);
        turn.metrics = answerMetrics(body.answerId, turn.rawTranscript ?? '', body.metrics);
        recordAnswerObservation(session, turn);
        await save(session);
        workContext.assertLive();
        assertActiveObservationScope(session, epoch);
        assertCandidateSource(turn, boundCandidate);
        appendPlaybackBatch(session, observationBatch);
        const context = await sessionContext(session), durationSeconds = sessionDurationSeconds(session, context.interviewOverview?.durationSeconds ?? NaN);
        assertActiveObservationScope(session, epoch);
        if (boundCandidate.decision) {
          try { assertSingleCoreCandidateBinding(context, session, boundCandidate.decision, session.runtime?.runtimePolicy?.mode ?? 'compiled'); }
          catch { throw new HttpError(409, '저장된 답변 판단의 원문과 정책 버전이 일치하지 않습니다.'); }
        } else if (session.elapsedMs < durationSeconds * 1000) {
          const attemptId = randomUUID();
          boundCandidate.decision = await workContext.run(Infinity, () => classifySingleCoreAnswerCandidate(context, session, { text: turn.rawTranscript ?? '', captureRevision: body.captureRevision,
            endingObservation: boundCandidate.endingObservation, elapsedMs: session.elapsedMs }, {
            workContext, policyMode: session.runtime?.runtimePolicy?.mode ?? 'compiled', allowFollowUp: mayAskFollowUp(session, durationSeconds, interviewConfig.maxFollowUps),
            allowClarification: mayAskClarification(session, durationSeconds), allowReplay: mayReplayQuestion(session, durationSeconds),
            onProviderUsage: (stage, observation) => observeSessionUsage(session, stage, `${attemptId}:${stage}`, observation),
          }));
        }
        workContext.assertLive();
        if (session.status !== 'active' || session.runtime!.endRequestedAt || session.runtime!.epoch !== epoch) throw new HttpError(409, '중단하거나 종료한 답변의 늦은 판단을 무시했습니다.');
        try { assertCandidateSource(turn, boundCandidate); } catch { throw new HttpError(409, '전사 후보의 원문과 버전이 일치하지 않습니다.'); }
        boundCandidate.status = boundCandidate.decision?.kind === 'CONTINUE' ? 'continuing' : 'advance_ready';
        turn.metadata.answerCommitStatus = boundCandidate.status;
        checkpointSession(session, boundCandidate.status === 'continuing' ? 'answer_continuation_ready' : 'answer_advance_ready');
        await journal(session, { eventId: journalId('answer.candidate', turn.id, body.answerId, String(body.captureRevision)), type: 'answer.candidate_decision', actor: 'server', turnId: turn.id, answerId: body.answerId,
          payload: { candidateId: boundCandidate.id, captureRevision: boundCandidate.captureRevision, sourceTranscriptSha256: boundCandidate.sourceTranscriptSha256, endingObservation: boundCandidate.endingObservation, decision: boundCandidate.decision ?? null, timeLimitReached: !boundCandidate.decision } });
        await save(session); workContext.assertLive(); return boundCandidate;
      })().catch(async error => {
        if (session.status === 'active' && session.runtime!.epoch === epoch) {
          boundCandidate.status = 'failed'; turn.metadata.answerCommitStatus = 'staged'; await save(session);
        }
        throw error;
      }).finally(() => { candidateFlights.delete(flightKey); });
      candidateFlights.set(flightKey, work);
      return response(await work);
    }
    if (match[2] === "next") {
      const body = nextRequestSchema.parse(await readJson(req));
      if (session.runtime?.endRequestedAt) throw new HttpError(409, '종료 중인 면접입니다.');
      const observationEpoch = session.runtime!.epoch;
      const key = `${session.id}:${body.turnId}:${body.answerId}`;
      const sourceTurn = session.turns.find(row => row.id === body.turnId && row.answerId === body.answerId);
      if (!sourceTurn) throw new HttpError(409, '현재 답변과 요청의 식별자가 일치하지 않습니다.');
      if (sourceTurn?.metadata.answerSubmissionMode === 'staged-v2') {
        const sourceCandidate = body.candidateId ? session.runtime?.answerCandidates?.[body.candidateId] : undefined;
        if (!sourceCandidate || sourceCandidate.id !== sourceTurn.metadata.answerCandidateId || body.captureRevision !== sourceCandidate.captureRevision) throw new HttpError(409, '답변 후보 식별자와 버전이 일치하지 않습니다.');
        try { assertCandidateSource(sourceTurn, sourceCandidate); } catch { throw new HttpError(409, '확정할 답변의 원문과 버전이 일치하지 않습니다.'); }
      }
      if (body.clientEvents?.length) assertActiveObservationScope(session, observationEpoch);
      const observationBatch = applyPlaybackBatch(session, body.clientEvents);
      const streamed = req.headers.accept?.includes("application/x-ndjson") ?? false;
      const writeEvent = (event: unknown) => { if (!res.destroyed && !res.writableEnded) { if (!res.headersSent) res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Accel-Buffering": "no" }); res.write(`${JSON.stringify(event)}\n`); } };
      const finalResponse = (result: PersistedNextResult, activeWork?: TurnWorkContext) => {
        if (result.turn) activeWork?.assertLive(); else activeWork?.assertNotCancelled();
        if (result.turn) assertActiveObservationScope(session, observationEpoch);
        const projected = result.turn ? publicTurn(result.turn) : null;
        if (projected && session.runtime?.operations[key]?.acknowledgementDelivery?.completedAt) { projected.acknowledgement = null; projected.acknowledgementAudioUrl = null; }
        const value = { turn: projected, done: result.done, ...(result.closingUtterance ? { closingUtterance: result.closingUtterance } : {}), acceptedClientEventIds: observationBatch.acceptedIds };
        if (!streamed) return send(res, 200, value);
        if (!res.headersSent) res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Accel-Buffering": "no" });
        writeEvent({ type: "turn_ready", ...value }); res.end();
      };
      const cached = session.runtime?.operations[key]?.status === 'committed' ? session.runtime.operations[key].result : session.runtime?.operations[key] && session.runtime.closingUtterance ? { turn: null, done: true, closingUtterance: session.runtime.closingUtterance } : nextOperations.get(key);
      if (cached) {
        if (observationBatch.acceptedIds.length) { await save(session); assertActiveObservationScope(session, observationEpoch); appendPlaybackBatch(session, observationBatch); }
        return finalResponse(cached);
      }
      if (session.runtime?.operations[key]?.failureCode === 'PREPARATION_REQUIRED') throw new HttpError(503, '다음 질문을 위한 추가 사전 준비가 필요합니다.', 'PREPARATION_REQUIRED');
      if (session.runtime?.operations[key]?.failureCode === 'QUESTION_REPAIR_RECOVERY_UNAVAILABLE') throw new HttpError(409, '질문 연결을 복구할 근거를 확인하지 못했습니다. 면접을 마치면 지금까지의 답변은 저장됩니다.', 'QUESTION_REPAIR_RECOVERY_UNAVAILABLE');
      const workContext = submissionWork.get(session, { turnId: body.turnId, answerId: body.answerId, captureRevision: body.captureRevision ?? sourceTurn.metadata.answerCaptureRevision ?? 1 }, body.submissionAttemptId);
      const inFlight = nextOperations.pendingResult(key);
      if (inFlight) {
        if (observationBatch.acceptedIds.length) { await save(session); assertActiveObservationScope(session, observationEpoch); appendPlaybackBatch(session, observationBatch); }
        if (streamed) {
          if (!progressListeners.has(key)) progressListeners.set(key, new Set());
          progressListeners.get(key)!.add(writeEvent);
        }
        try { return finalResponse(await inFlight, workContext); }
        finally { progressListeners.get(key)?.delete(writeEvent); if (!progressListeners.get(key)?.size) progressListeners.delete(key); }
      }
      if (session.status !== "active") throw new HttpError(409, "종료된 면접입니다.");
      const turn = session.turns.at(-1);
      if (!turn || turn.id !== body.turnId || turn.answerId !== body.answerId) throw new HttpError(409, "현재 답변과 요청의 식별자가 일치하지 않습니다.");
      let staged: AnswerCandidateState | undefined;
      if (turn.metadata.answerSubmissionMode === 'staged-v2') {
        staged = body.candidateId ? session.runtime?.answerCandidates?.[body.candidateId] : undefined;
        if (!staged || body.captureRevision !== staged.captureRevision || !['advance_ready', 'advancing'].includes(staged.status)) throw new HttpError(409, '답변 후보를 먼저 확정해 주세요.');
        try { assertCandidateSource(turn, staged); } catch { throw new HttpError(409, '확정할 답변의 원문과 버전이 일치하지 않습니다.'); }
        if (staged.decision && staged.decision.kind !== 'ADVANCE') throw new HttpError(409, '같은 답변을 이어서 말씀해 주세요.');
        // Acquire before the first await. WS start and late stream callbacks
        // cannot change this answer while question preparation is in flight.
        staged.status = 'advancing'; turn.metadata.answerCommitStatus = 'advancing'; turn.transcriptStatus = 'finalized';
      }
      if (!isFinalizedAnswer(turn)) throw new HttpError(422, "최종 전사를 확인할 수 없습니다. 같은 답변을 이어서 녹음해 주세요.");
      if (streamed) {
        if (!progressListeners.has(key)) progressListeners.set(key, new Set());
        progressListeners.get(key)!.add(writeEvent);
      }
      try {
      const result = await nextOperations.run(key, async () => {
          const epoch = session.runtime!.epoch;
          session.runtime!.operations[key] = { ...session.runtime!.operations[key], status: 'running', failureCode: undefined, startedAt: session.runtime!.operations[key]?.startedAt ?? new Date().toISOString(), epoch };
          session.elapsedMs = Math.max(session.elapsedMs, body.elapsedMs);
          checkpointSession(session, 'preparing_next'); await save(session);
          workContext!.assertLive();
          assertActiveObservationScope(session, epoch);
          if (staged) assertCandidateSource(turn, staged);
          appendPlaybackBatch(session, observationBatch);
          turn.metrics = answerMetrics(body.answerId, turn.rawTranscript ?? "", body.metrics);
          recordAnswerObservation(session, turn);
          turn.metadata.clientTimings = body.clientTimings;
          void journal(session, { eventId: journalId("answer.metrics", turn.id, body.answerId), type: "answer.metrics", actor: "server", turnId: turn.id, answerId: body.answerId, payload: { rawTranscript: turn.rawTranscript, metrics: turn.metrics, observation: turn.answerObservation, elapsedMs: session.elapsedMs } });
          if (body.clientTimings) void journal(session, { type: "timings.observed", actor: "client", turnId: turn.id, answerId: body.answerId, payload: { clientTimings: body.clientTimings, origin: "client-monotonic" } });
          const answerSave = save(session).then(() => null, error => error as unknown);
          // At time limit no further model/TTS request is needed. Last Q0 may still have a follow-up.
          const durationSeconds = sessionDurationSeconds(session, (await sessionContext(session)).interviewOverview?.durationSeconds ?? NaN);
          const next = session.elapsedMs >= durationSeconds * 1000 ? null : await prepareTurn(session, false, event => { for (const listener of progressListeners.get(key) ?? []) { try { listener(event); } catch { /* A disconnected observer cannot invalidate a prepared turn. */ } } }, true, key, workContext);
          const saveError = await answerSave;
          if (saveError) {
            if (!next) throw saveError;
            // prepareTurn persisted the full session, including these answer metrics. Keep its committed result retryable.
            void journal(session, { type: "error", actor: "server", turnId: turn.id, answerId: body.answerId, payload: { source: "answer-save", code: "EARLIER_SAVE_RECOVERED", recovered: true, message: safeProviderError(saveError) } });
          }
          if (session.runtime!.epoch !== epoch || session.runtime!.endRequestedAt || session.status !== 'active') throw new HttpError(409, '종료하거나 복원한 면접의 늦은 결과를 무시했습니다.');
           workContext!.assertLive();
           const closingUtterance = !next ? await prepareClosing(session, session.elapsedMs >= durationSeconds * 1000 ? 'time_expired' : 'candidate_exhausted', workContext) : undefined;
           workContext!.assertLive();
          const result: PersistedNextResult = { turn: next, done: !next, ...(closingUtterance ? { closingUtterance } : {}) };
          session.runtime!.operations[key] = { ...session.runtime!.operations[key], status: 'committed', startedAt: session.runtime!.operations[key].startedAt, epoch, result: structuredClone(result) };
          if (staged) { staged.status = 'committed'; turn.metadata.answerCommitStatus = 'committed'; }
          if (!next) session.status = 'ending';
          checkpointSession(session, next ? 'question_prepared' : 'closing_prepared'); registerSessionAudio(session); await save(session);
          if (next) workContext!.assertLive();
          else {
            // This operation's own terminal commit intentionally changed active→ending.
            // External end/restore/cancellation still invalidates late publication.
            workContext!.assertNotCancelled();
            if (session.runtime!.epoch !== epoch || session.runtime!.endRequestedAt || evaluationInputFrozen(session)) throw new HttpError(409, '종료하거나 복원한 면접의 늦은 결과를 무시했습니다.');
          }
          submissionWork.complete(session, { turnId: body.turnId, answerId: body.answerId, captureRevision: body.captureRevision ?? sourceTurn.metadata.answerCaptureRevision ?? 1 });
          return result;
      });
       return finalResponse(result, workContext);
      } finally { progressListeners.get(key)?.delete(writeEvent); if (!progressListeners.get(key)?.size) progressListeners.delete(key); }
    }
    if (match[2] === 'closing') {
      const requested = z.object({ reason: z.enum(['time_expired', 'user_ended']).optional(), elapsedMs: z.number().finite().min(0).max(86_400_000).optional() }).parse(await readJson(req));
      const ending = endOperations.pendingResult(session.id);
      if (ending) await ending;
      if (evaluationInputFrozen(session) || session.status === 'completed') {
        // Playback is optional presentation after a durable end. Never append a
        // closing object to the immutable session/evaluation snapshot.
        const closing = session.runtime?.closingUtterance ?? await closingOperations.run(session.id, async () => {
          const presentation = structuredClone(session);
          presentation.status = 'ending';
          const duration = sessionDurationSeconds(session, (await sessionContext(session)).interviewOverview?.durationSeconds ?? NaN);
          return prepareClosing(presentation, session.elapsedMs >= duration * 1000 ? 'time_expired' : requested.reason ?? 'user_ended');
        });
        return send(res, 200, { closingUtterance: closing });
      }
      session.elapsedMs = Math.max(session.elapsedMs, requested.elapsedMs ?? 0);
      if (!session.runtime?.closingUtterance) {
        session.runtime!.epoch++;
        session.status = 'ending';
        const active = [...streams.get(session.id) ?? []];
        await Promise.all(active.map(stream => stream.finish().catch(() => null)));
        active.forEach(stream => stream.close()); streams.delete(session.id);
        // An errored stream is preserved as a technical failure, never fabricated as a finalized answer.
        const interrupted = session.turns.at(-1);
        if (active.length && interrupted?.transcriptStatus === 'streaming') interrupted.transcriptStatus = 'error';
        if (interrupted?.transcriptStatus === 'paused' && interrupted.metadata.answerSubmissionMode === 'staged-v2') {
          finalizeCapturedTurnForEnd(interrupted, false); interrupted.metadata.answerCommitStatus = 'committed';
        }
        const duration = sessionDurationSeconds(session, (await sessionContext(session)).interviewOverview?.durationSeconds ?? NaN);
        await prepareClosing(session, session.elapsedMs >= duration * 1000 ? 'time_expired' : 'user_ended'); await save(session);
      }
      return send(res, 200, { closingUtterance: session.runtime!.closingUtterance });
    }
    if (match[2] === "end") {
      const body = z.object({ metrics: z.unknown().optional(), elapsedMs: z.number().finite().min(0).max(86_400_000).optional() }).parse(await readJson(req));
      await commitSessionEnd(session, body);
      await syncEvaluation(session);
      await defaultConversationLogger.flush(session.id);
      return send(res, 202, publicSessionProgress(session));
    }
    if (match[2] === "retry-evaluation") {
      if (session.status === "active") throw new HttpError(409, "면접을 종료한 후 평가를 다시 시도할 수 있습니다.");
      const ending = endOperations.pendingResult(session.id);
      if (ending) await ending;
      await beginEvaluation(session, true);
      return send(res, 202, publicSessionProgress(session));
    }
    throw new HttpError(404, "요청한 기능을 찾을 수 없습니다.");
  } catch (error) {
    if (scopedSession) void journal(scopedSession, { type: "error", actor: "server", payload: { source: "http", method: req.method ?? null, message: safeProviderError(error), code: error instanceof HttpError ? error.code ?? "REQUEST_ERROR" : error instanceof z.ZodError ? "INVALID_REQUEST" : "PROVIDER_ERROR", ...(error instanceof QuestionPreparationError ? { stage: 'question_validation', attemptCount: error.attemptCount, validationCode: error.lastValidationCode ?? null } : error instanceof QuestionValidationError ? { stage: 'question_validation', validationCode: error.code } : {}) } });
    if (res.headersSent) { if (!res.destroyed && !res.writableEnded) res.end(`${JSON.stringify({ type: "error", message: publicRequestError(error), code: error instanceof HttpError || error instanceof TurnWorkError ? error.code : undefined })}\n`); return; }
    if (error instanceof z.ZodError) return send(res, 400, { error: "요청 데이터 형식을 확인해 주세요.", code: "INVALID_REQUEST" });
    send(res, error instanceof HttpError || error instanceof TurnWorkError ? error.status : 502, { error: publicRequestError(error), code: error instanceof HttpError || error instanceof TurnWorkError ? error.code ?? "REQUEST_ERROR" : "PROVIDER_ERROR" });
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
server.on("upgrade", async (req, socket, head) => {
  try {
    guardRequest(req);
    if (!req.headers.origin || !allowedOrigins.has(req.headers.origin)) throw new HttpError(403, "로컬 브라우저 연결만 허용합니다.");
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname !== "/api/realtime") throw new HttpError(404, "요청 경로가 없습니다.");
    const session = await findSession(url.searchParams.get("sessionId") ?? "");
    if (session.status !== "active" || session.runtime?.endRequestedAt) throw new HttpError(409, "종료된 면접입니다.");
    if (session.runtime?.engineVersion !== interviewConfig.rulesVersion) throw new HttpError(409, '실행 버전이 달라 이어갈 수 없습니다.');
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req, session));
  } catch { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); }
});
wss.on("connection", (ws: WebSocket, _req: IncomingMessage, session: InterviewSession) => {
  const connectionEpoch = session.runtime!.epoch;
  if (!connections.has(session.id)) connections.set(session.id, new Set());
  connections.get(session.id)!.add(ws);
  delete session.runtime!.checkpoint.disconnectedAt;
  checkpointSession(session, session.runtime!.checkpoint.phase === 'suspended' ? 'connected' : session.runtime!.checkpoint.phase);
  void save(session).catch(() => {});
  let current: { stream: ClovaSpeechStream; turn: RecordedTurn; answerId: string; captureRevision?: number; prefix: string; streamId: string; currentText: string; fail: (error: Error) => void } | null = null;
  let queue = Promise.resolve();
  const emit = (value: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
  const removeStream = (stream: ClovaSpeechStream) => { streams.get(session.id)?.delete(stream); endCaptureDrains.delete(stream); };
  void journal(session, { type: "connection.opened", actor: "server", payload: { transport: "websocket" } });
  const processMessage = async (data: RawData, binary: boolean) => {
    if (session.status !== "active" || session.runtime!.epoch !== connectionEpoch) return;
    if (binary) {
      if (!current) throw new Error("답변 연결을 시작한 후 오디오를 보내 주세요.");
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (bytes.length > 32_000) throw new Error("오디오 청크가 너무 큽니다.");
      const writing = current;
      try { writing.stream.write(bytes); }
      catch (error) { writing.fail(error instanceof Error ? error : new Error('음성 데이터를 전송하지 못했습니다.')); throw error; }
      return;
    }
    const message = streamRequestSchema.parse(JSON.parse(data.toString()));
    if (message.type === 'cancel_submission') return;
    const turn = session.turns.at(-1);
    if (!turn || turn.id !== message.turnId) throw new Error("이전 질문의 음성 요청을 무시했습니다.");
    if (turn.answerId && turn.answerId !== message.answerId) throw new Error("같은 답변의 식별자가 일치하지 않습니다.");
    const recordSubmission = () => void journal(session, { eventId: journalId("answer.submitted", turn.id, message.answerId, journalCaptureId(turn)), type: "answer.submitted", actor: "candidate", turnId: turn.id, answerId: message.answerId, payload: { source: "client-finish", rawTranscript: turn.rawTranscript ?? "", captureAttemptId: journalCaptureId(turn), captureRevision: turn.metadata.answerCaptureRevision ?? null } });
    if (message.type === "start") {
      if (session.runtime!.endRequestedAt) throw new Error('종료 중인 면접에 새 답변을 시작할 수 없습니다.');
      if (current) {
        if (current.turn.id === turn.id && current.answerId === message.answerId) {
          if (message.captureRevision !== undefined && message.captureRevision !== turn.metadata.answerCaptureRevision) throw new Error('CAPTURE_REVISION_STALE');
          return;
        }
        throw new Error("이미 진행 중인 음성 연결이 있습니다.");
      }
      assertCaptureMayStart(session, turn);
      if (message.captureRevision !== undefined) {
        if (message.captureRevision <= (turn.metadata.answerCaptureRevision ?? 0)) throw new Error('CAPTURE_REVISION_STALE');
        turn.metadata.answerSubmissionMode = 'staged-v2';
        turn.metadata.answerCaptureRevision = message.captureRevision;
        turn.metadata.answerCommitStatus = 'capturing';
        delete turn.metadata.answerCandidateId;
      }
      turn.answerId = message.answerId;
      const prefix = turn.rawTranscript ?? "";
      const streamId = randomUUID();
      const captureRevision = turn.metadata.answerCaptureRevision;
      turn.metadata.lastStreamId = streamId;
      // Publish capture ownership before construction: a provider may fail synchronously.
      turn.transcriptStatus = 'streaming';
      let captureFailed = false;
      let stream: ClovaSpeechStream | undefined;
      const ownsTurn = () => turn.metadata.lastStreamId === streamId && turn.metadata.answerCaptureRevision === captureRevision && turn.answerId === message.answerId && turn.id === session.turns.at(-1)?.id;
      const captureError = (error: Error) => {
        if (captureFailed) return;
        captureFailed = true;
        if (stream) { removeStream(stream); stream.close(); }
        if (!ownsTurn() || session.status !== 'active' || session.runtime!.epoch !== connectionEpoch || turn.transcriptStatus !== 'streaming') return;
        turn.transcriptStatus = 'error';
        if (current?.streamId === streamId) current = null;
        void journal(session, { type: 'error', actor: 'provider', turnId: turn.id, answerId: message.answerId, payload: { source: 'clova-stream', code: 'STT_ERROR', streamId, message: safeProviderError(error), rawTranscript: turn.rawTranscript ?? '' } });
        const failure = { type: 'error', sessionId: session.id, turnId: turn.id, answerId: message.answerId, captureRevision, streamId, code: 'STT_ERROR', message: publicServiceError('speech'), rawTranscript: turn.rawTranscript ?? '' };
        const mayEmitFailure = () => ownsTurn() && session.status === 'active' && session.runtime!.epoch === connectionEpoch && turn.transcriptStatus === 'error';
        // A client reacting to the error must not race an older streaming snapshot on disk.
        void save(session).then(() => { if (mayEmitFailure()) emit(failure); }).catch(error => {
          void journal(session, { type: 'error', actor: 'server', turnId: turn.id, answerId: message.answerId, payload: { source: 'transcript-error-save', code: 'SAVE_ERROR', streamId, message: safeProviderError(error) } });
          if (mayEmitFailure()) { emit(failure); emit({ ...failure, code: 'SAVE_ERROR', message: publicServiceError('storage') }); }
        });
      };
      const keywords = currentQuestionVocabulary(await sessionContext(session), turn);
      void journal(session, { type: 'provider.config', actor: 'server', turnId: turn.id, payload: { stage: 'stt', vocabularyCount: keywords.length, vocabularySha256: snapshotHash(keywords), method: 'streaming-grpc-direct-keyword-boostings', rawTranscriptCorrection: false } });
      try { stream = new ClovaSpeechStream(result => {
        if (captureFailed || !ownsTurn() || session.status !== 'active' || session.runtime!.epoch !== connectionEpoch || turn.transcriptStatus !== 'streaming') return;
        turn.rawTranscript = concatenateStreamTranscript(prefix, result.rawTranscript);
        checkpointSession(session, 'listening');
        const observedNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
        turn.sttObservations = mergeTranscriptObservation(turn.sttObservations ?? [], {
          segmentId: `${streamId}:${result.position}`, revision: result.revision,
          confidence: observedNumber(result.confidence),
          startTimestamp: observedNumber(result.startTimestamp),
          endTimestamp: observedNumber(result.endTimestamp),
        });
        if (current?.streamId === streamId) current.currentText = result.rawTranscript;
        void journal(session, { eventId: journalId("stt.partial", streamId, String(result.position), String(result.revision)), type: "stt.partial", actor: "provider", turnId: turn.id, answerId: message.answerId, payload: { text: result.text, rawTranscript: turn.rawTranscript, streamId, segmentId: `${streamId}:${result.position}`, revision: result.revision, providerFinal: result.isFinal, confidence: observedNumber(result.confidence), startTimestamp: observedNumber(result.startTimestamp), endTimestamp: observedNumber(result.endTimestamp) } });
        emit({ type: "transcript", sessionId: session.id, turnId: turn.id, answerId: message.answerId, captureRevision, streamId, segmentId: `${streamId}:${result.position}`, revision: result.revision, text: result.text, isFinal: result.isFinal, rawTranscript: turn.rawTranscript });
        void save(session).catch(error => { void journal(session, { type: "error", actor: "server", turnId: turn.id, answerId: message.answerId, payload: { source: "transcript-save", code: "SAVE_ERROR", message: safeProviderError(error) } }); emit({ type: "error", code: "SAVE_ERROR", message: publicServiceError('storage') }); });
      }, captureError, { keywords }); }
      catch (error) { captureError(error instanceof Error ? error : new Error('음성 연결을 시작하지 못했습니다.')); return; }
      if (captureFailed) { stream.close(); return; }
      current = { stream, turn, answerId: message.answerId, captureRevision, prefix, streamId, currentText: "", fail: captureError };
      const liveStream = stream;
      let receiptResolve!: () => void;
      const receipt = new Promise<void>(resolve => { receiptResolve = resolve; });
      let endFlight: Promise<void> | undefined;
      endCaptureDrains.set(liveStream, {
        turnId: turn.id, answerId: message.answerId, captureRevision, receipt, markFinishReceived: receiptResolve,
        finishForEnd: () => endFlight ??= (async () => {
          const text = await liveStream.finish();
          if (!ownsTurn() || evaluationInputFrozen(session) || turn.transcriptStatus !== 'streaming') return;
          turn.rawTranscript = concatenateStreamTranscript(prefix, text);
          capturePart(turn, streamId, text);
          turn.transcriptStatus = 'finalized';
          if (turn.metadata.answerSubmissionMode === 'staged-v2') turn.metadata.answerCommitStatus = 'committed';
          await save(session);
        })(),
      });
      delete session.runtime!.checkpoint.disconnectedAt; checkpointSession(session, 'listening');
      if (!streams.has(session.id)) streams.set(session.id, new Set());
      streams.get(session.id)?.add(stream);
      void save(session).catch(error => { void journal(session, { type: "error", actor: "server", turnId: turn.id, answerId: message.answerId, payload: { source: "capture-start-save", code: "SAVE_ERROR", message: safeProviderError(error) } }); });
      void journal(session, { type: "stt.started", actor: "server", turnId: turn.id, answerId: message.answerId, payload: { streamId, resumed: Boolean(prefix), rawTranscript: prefix } });
      emit({ type: "started", sessionId: session.id, turnId: turn.id, answerId: message.answerId, captureRevision, streamId });
      return;
    }
    if (message.captureRevision !== undefined && message.captureRevision !== turn.metadata.answerCaptureRevision) throw new Error('CAPTURE_REVISION_STALE');
    if (!current || current.turn.id !== turn.id) {
      if (turn.transcriptStatus === 'paused' && message.type === 'finish' && message.staged) {
        assertCaptureConfirmed(turn);
        submissionWork.get(session, { turnId: turn.id, answerId: message.answerId, captureRevision: message.captureRevision ?? turn.metadata.answerCaptureRevision ?? 1 }, message.submissionAttemptId, true);
        recordSubmission();
        return emit({ type: 'finalized', sessionId: session.id, turnId: turn.id, answerId: message.answerId, rawTranscript: turn.rawTranscript ?? '', captureRevision: turn.metadata.answerCaptureRevision, streamId: turn.metadata.lastStreamId });
      }
      if (turn.transcriptStatus === "paused" && message.type === "finish") {
        recordSubmission();
        finalizeCapturedTurnForEnd(turn, false);
        await save(session);
        void journal(session, { eventId: journalId("stt.final", turn.id, message.answerId, journalCaptureId(turn)), type: "stt.final", actor: "candidate", turnId: turn.id, answerId: message.answerId, payload: { rawTranscript: turn.rawTranscript ?? "", source: "paused-answer-finish", captureAttemptId: journalCaptureId(turn), transcriptStatus: turn.transcriptStatus, observations: turn.sttObservations ?? null } });
        return emit({ type: "finalized", sessionId: session.id, turnId: turn.id, answerId: message.answerId, rawTranscript: turn.rawTranscript ?? "", captureRevision: turn.metadata.answerCaptureRevision, streamId: turn.metadata.lastStreamId });
      }
      if (turn.transcriptStatus === "finalized" && message.type === "finish") return emit({ type: "finalized", sessionId: session.id, turnId: turn.id, answerId: message.answerId, rawTranscript: turn.rawTranscript ?? "", captureRevision: turn.metadata.answerCaptureRevision, streamId: turn.metadata.lastStreamId });
      if (message.type === "pause") return;
      throw new Error("음성 연결이 종료되었습니다. 같은 답변을 이어서 녹음해 주세요.");
    }
    const finishing = current;
    // The ordered finish follows all PCM; its trusted clock includes STT finalization.
    // The capture producer remains separately owned so accepted /end can still drain it.
    const workContext = message.type === 'finish' && message.staged ? submissionWork.get(session, { turnId: turn.id, answerId: message.answerId, captureRevision: message.captureRevision ?? turn.metadata.answerCaptureRevision ?? 1 }, message.submissionAttemptId, true) : undefined;
    if (message.type === 'finish') { endCaptureDrains.get(finishing.stream)?.markFinishReceived(); recordSubmission(); }
    const finalizationStarted = performance.now();
    let text: string;
    try { text = await finishing.stream.finish(); }
    catch (error) { finishing.fail(error instanceof Error ? error : new Error('최종 전사를 확정하지 못했습니다.')); throw error; }
    if (session.status !== "active" || session.runtime!.epoch !== connectionEpoch) return;
    if (turn.metadata.lastStreamId !== finishing.streamId || current?.streamId !== finishing.streamId || turn.transcriptStatus !== 'streaming' || ws.readyState !== WebSocket.OPEN) {
      removeStream(finishing.stream); finishing.stream.close();
      return;
    }
    turn.rawTranscript = concatenateStreamTranscript(finishing.prefix, text);
    capturePart(turn, finishing.streamId, text);
    turn.transcriptStatus = message.type === "pause" || message.staged ? "paused" : "finalized";
    if (turn.metadata.answerSubmissionMode === 'staged-v2') turn.metadata.answerCommitStatus = message.type === 'finish' && !message.staged ? 'committed' : 'staged';
    checkpointSession(session, message.type === 'pause' ? 'suspended' : 'answer_finalized');
    if (message.type === "finish") turn.metadata.providerTimings = { ...turn.metadata.providerTimings, sttFinalizeMs: performance.now() - finalizationStarted };
    // The next capture may start on another socket while persistence is pending.
    // Terminal events and append-only logs must retain this finished capture's snapshot.
    const finalTranscript = turn.rawTranscript;
    const finalStatus = turn.transcriptStatus;
    const finalTimings = structuredClone(turn.metadata.providerTimings ?? null);
    const finalObservations = structuredClone(turn.sttObservations ?? null);
    removeStream(finishing.stream);
    if (current?.streamId === finishing.streamId) current = null;
    await save(session);
    if (workContext?.signal.aborted) {
      emit({ type: 'error', sessionId: session.id, turnId: turn.id, answerId: message.answerId, captureRevision: finishing.captureRevision, streamId: finishing.streamId, code: workContext.signal.reason?.code ?? 'TURN_WORK_CANCELLED', message: publicRequestError(workContext.signal.reason), rawTranscript: finalTranscript });
      return;
    }
    void journal(session, { eventId: message.type === "pause" ? journalId("stt.paused", finishing.streamId) : journalId("stt.final", turn.id, message.answerId, finishing.streamId), type: message.type === "pause" ? "stt.paused" : "stt.final", actor: "candidate", turnId: turn.id, answerId: message.answerId, payload: { rawTranscript: finalTranscript, captureRevision: finishing.captureRevision ?? null, streamId: finishing.streamId, captureAttemptId: finishing.streamId, transcriptStatus: finalStatus, providerTimings: finalTimings, observations: finalObservations } });
    emit({ type: message.type === "pause" ? "paused" : "finalized", sessionId: session.id, turnId: turn.id, answerId: message.answerId, rawTranscript: finalTranscript, captureRevision: finishing.captureRevision, streamId: finishing.streamId });
  };
  ws.on("message", (data, binary) => {
    let commandScope: { turnId?: string; answerId?: string; captureRevision?: number; streamId?: string } = current ? { turnId: current.turn.id, answerId: current.answerId, captureRevision: current.turn.metadata.answerCaptureRevision, streamId: current.streamId } : {};
    if (!binary) {
      try {
        const command = streamRequestSchema.safeParse(JSON.parse(data.toString()));
        if (command.success) {
          const value = command.data;
          commandScope = { turnId: value.turnId, answerId: value.answerId, captureRevision: value.captureRevision, ...(current && current.turn.id === value.turnId && current.turn.metadata.answerCaptureRevision === value.captureRevision ? { streamId: current.streamId } : {}) };
          // Cancellation must bypass a finish awaiting STT in this socket's ordered queue.
          if (value.type === 'cancel_submission') {
            const active = session.turns.at(-1);
            if (session.status === 'active' && session.runtime!.epoch === connectionEpoch && !session.runtime!.endRequestedAt && value.submissionAttemptId && value.captureRevision && active?.id === value.turnId && active.answerId === value.answerId && active.metadata.answerCaptureRevision === value.captureRevision) {
              submissionWork.cancel(session, { turnId: value.turnId, answerId: value.answerId, captureRevision: value.captureRevision }, value.submissionAttemptId);
              void save(session).catch(() => {});
            }
            return;
          }
        }
      }
      catch { /* Malformed commands have no trusted capture identity. */ }
    }
    queue = queue.then(() => processMessage(data, binary)).catch(async error => {
      const failed = current;
      void journal(session, { type: 'error', actor: 'server', turnId: failed?.turn.id, answerId: failed?.answerId, payload: { source: 'websocket-command', code: 'STT_ERROR', message: safeProviderError(error) } });
      // A finish queued behind a provider error can arrive before its asynchronous save.
      // Flush the terminal state before this second error lets the client advance.
      if (session.turns.at(-1)?.transcriptStatus === 'error') {
        try { await save(session); }
        catch (failure) { void journal(session, { type: 'error', actor: 'server', payload: { source: 'command-error-save', code: 'SAVE_ERROR', message: safeProviderError(failure) } }); emit({ type: 'error', sessionId: session.id, ...commandScope, code: 'SAVE_ERROR', message: publicServiceError('storage') }); }
      }
      emit({ type: 'error', sessionId: session.id, ...commandScope, code: 'STT_ERROR', message: publicServiceError('speech') });
    });
  });
  ws.on("close", () => {
    connections.get(session.id)?.delete(ws);
    const lastConnectionClosed = !connections.get(session.id)?.size;
    if (lastConnectionClosed) connections.delete(session.id);
    void journal(session, { type: "connection.closed", actor: "server", turnId: current?.turn.id, answerId: current?.answerId, payload: { transport: "websocket", sessionStatus: session.status } });
    if (lastConnectionClosed && session.runtime!.epoch === connectionEpoch && session.status === 'active') {
      session.runtime!.checkpoint.disconnectedAt = new Date().toISOString();
      checkpointSession(session, 'suspended');
      void save(session).catch(() => {});
    }
    if (current) {
      const closing = current;
      current = null;
      if (session.runtime!.endRequestedAt && !evaluationInputFrozen(session)) {
        const drain = endCaptureDrains.get(closing.stream);
        // A tab disappearing after accepted end must not close the provider
        // before its final text arrives. Process already-received PCM first.
        void queue.then(async () => {
          drain?.markFinishReceived();
          if (drain) await drain.finishForEnd(); else await closing.stream.finish();
        }).catch(error => {
          if (closing.turn.transcriptStatus === 'streaming') closing.turn.transcriptStatus = 'error';
          void journal(session, { type: 'error', actor: 'server', turnId: closing.turn.id, answerId: closing.answerId, payload: { source: 'end-disconnect-drain', code: 'END_CAPTURE_UNCONFIRMED', message: safeProviderError(error) } });
        });
        return;
      }
      closing.stream.close(); removeStream(closing.stream);
      if (session.status === "active" && closing.turn.metadata.lastStreamId === closing.streamId && closing.turn.transcriptStatus === "streaming") closing.turn.transcriptStatus = "error";
      void save(session).catch(error => { void journal(session, { type: "error", actor: "server", payload: { source: "disconnect-save", message: safeProviderError(error) } }); console.error("면접 기록 저장 실패:", safeProviderError(error)); });
    }
  });
  ws.on("error", () => ws.close());
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Interview realtime: http://127.0.0.1:${port}`);
  // Only new, explicitly accepted end requests are restart work. Reading the
  // historical pending/failed sessions must never silently re-evaluate them.
  void store.list(owner.id).then(async rows => {
    for (const row of rows) if (await acceptedEndNeedsRecovery(row)) {
      try { await findSession(row.id); }
      catch (error) { console.error('저장된 종료 요청 복구 실패:', safeProviderError(error)); }
    }
  }).catch(error => { console.error('저장된 종료 요청 확인 실패:', safeProviderError(error)); });
});
server.on("error", error => { console.error("실시간 서버 실행 실패:", safeProviderError(error)); process.exitCode = 1; });
function shutdown() {
  for (const group of streams.values()) for (const stream of group) stream.close();
  for (const ws of wss.clients) ws.close();
  wss.close(); server.close();
  void defaultConversationLogger.flush();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
