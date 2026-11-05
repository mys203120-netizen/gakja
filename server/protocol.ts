import { z } from "zod";
import { mayAskFollowUp, sessionMainQuestionTarget, MAIN_QUESTION_RESERVE_SECONDS, FOLLOW_UP_RESERVE_SECONDS, type InterviewPlan, type InterviewTopicArea, type InterviewerRole, type SchoolConnection } from "./interview-planner";
import type { AnswerReaction } from "./providers/answer-reaction";
import { playbackEventBatchSchema } from "../lib/interview/client-event-contract";
import { deliveredFollowUpCount } from "./follow-up-count";

export const primaryFunctions = ["FACT", "MOTIVE", "ROLE", "PROCESS", "CHOICE", "CONCEPT", "EVIDENCE", "RESULT", "LIMIT", "ALTERNATIVE", "TRANSFER", "CONNECTION", "VALUE", "CLARIFY_CONTENT", "VERIFY_CLAIM"] as const;
export const questionDraftSchema = z.object({
  acknowledgement: z.string().nullable(),
  acknowledgementQuote: z.string().nullable(),
  questionText: z.string().min(8).max(320),
  questionKind: z.enum(["main", "follow_up", "clarification", "end"]),
  parentMainQuestionId: z.string().nullable(),
  evidenceIds: z.array(z.string()).max(6),
  evidenceQuotes: z.array(z.object({ evidenceId: z.string(), quote: z.string().min(4) })).max(6),
  primaryFunction: z.enum(primaryFunctions),
  questionIntent: z.string().min(5),
  targetEvidence: z.array(z.string().min(2)).min(1).max(3),
  depth: z.enum(["D1", "D2", "D3", "D4"]),
  groundingRationale: z.string().min(5),
  validationStatus: z.literal("approved"),
  validationFailures: z.array(z.string()),
});
// Metadata is attached by server validation only; the model's strict schema above stays unchanged.
export type QuestionDraft = Omit<z.infer<typeof questionDraftSchema>, "evidenceQuotes"> & {
  clarificationMode?: 'repeat_audio' | 'rephrase';
  commonApproval?: { kind: 'COMMON_APPROVED'; moduleId: string; approvalRevision: string; supportTargetId: string };
  selectionTrace?: { policyVersion: string; bankKey: string; bankCandidateId: string; objectiveId: string; semanticKey: string; mode: string; reasonCodes: string[]; exposureStatus: string; publicationRevision: string | null; historySessionIds: string[] };
  /** Server-owned review trace. References and offsets only; never source/answer text. */
  premiseValidation?: QuestionPremiseValidation;
  planSlotId?: string;
  topicArea?: InterviewTopicArea;
  interviewerRole?: InterviewerRole;
  schoolConnections?: SchoolConnection[];
  providerTimings?: Record<string, number>;
  followUpLanguage?: { policyVersion: string; templateId: string; family: string; goal: string; referenceExampleIds: string[] };
  questionBlueprint?: import('./question-objective').QuestionBlueprint;
  approvedQuestion?: import('./question-objective').ApprovedQuestionContract;
  questionRealization?: {
    policyVersion: string; operation: string; anchorMode: string; anchorId: string;
    templateId: string; family: string; strategyId: string | null;
    semanticReview: 'not_independently_reviewed' | 'independently_reviewed';
    anchorProof?: Array<{ anchorId: string; sourceId: string; sourceSha256: string; sourceStartOffset: number; sourceEndOffset: number; questionStartOffset: number | null; questionEndOffset: number | null }>;
    semanticObjectiveId?: string;
  };
  strategyTrace?: {
    catalogDigest: string | null; selectedCardId: string | null;
    candidateCardIds: string[]; sourceQuestionIds: string[];
    policyVersion: string; selectionReason: string;
  };
  questionReferenceContext?: { schemaVersion: string; catalogSha256: string; exampleIds: string[]; purpose: 'wording_reference_only'; analysisKey?: string; referenceUses?: Array<{ id: string; usage: 'direct_example' | 'compound_strategy' | 'contextual_strategy' }> };
  evidenceQuotes: Array<z.infer<typeof questionDraftSchema>["evidenceQuotes"][number] & {
    sourceStartOffset?: number;
    sourceEndOffset?: number;
    matchKind?: "exact" | "canonical_whitespace" | "pdf_line_wrap";
  }>;
};
export interface QuestionPremiseValidation {
  version: "question-premise-v1";
  guidelineVersion: "2.3";
  status: "approved";
  method: "bounded_semantic_review" | "bounded_fact_review" | "verified_approved_restatement" | "constrained_answer_follow_up" | "approved_strategy_ir";
  reusedFrom?: { turnId: string; questionSha256: string; transform: "exact" | "remove_standalone_greeting" };
  reviewModel: string;
  questionSha256: string;
  coreIntentCount: 1;
  /** Fact-only reviews retain the legacy count from the core's single target;
   * the factual reviewer does not independently judge the number of demands. */
  coreIntentCountAuthority?: 'single_core_single_target_contract';
  semanticAuthority?: 'single_core';
  /** Present only after a generated surface was repaired; binds that final
   * utterance to the immutable demand selected by the original core. */
  repairCheck?: {
    version: 'repair-check-v1';
    contract: import('./providers/repair-contract').RepairContract;
    contractSha256: string;
    candidateQuestionSha256: string;
    verdict: 'same';
  };
  supportedPremises: Array<{
    questionStartOffset: number; questionEndOffset: number;
    basis: "record" | "answer_turn_attributed";
    sourceId: string; sourceStartOffset: number; sourceEndOffset: number;
  }>;
  openChecks: Array<{ questionStartOffset: number; questionEndOffset: number; kind: "open_check" | "hypothetical" }>;
}
export interface PreparedTurn {
  id: string;
  questionText: string;
  questionKind: "main" | "follow_up" | "clarification";
  parentMainQuestionId: string;
  mainIndex: number;
  mainCount: number;
  mainCountIsLimit?: boolean;
  followUpIndex: number;
  evidenceIds: string[];
  questionAudioUrl: string;
  acknowledgement: string | null;
  acknowledgementAudioUrl: string | null;
  interviewerId: string;
}
export interface RecordedTurn extends PreparedTurn {
  metadata: Omit<QuestionDraft, "acknowledgement" | "questionText" | "questionKind" | "parentMainQuestionId" | "evidenceIds"> & {
    rulesVersion: string;
    generatedAt: string;
    /** Source RecordedTurn ID. sourceAnswerId separately identifies its capture/submission. */
    answerTurnId: string | null;
    sourceAnswerId?: string | null;
    sourceRefIds: string[];
    activityIds: string[];
    supportTarget: unknown;
    questionClusterId: string;
    parentQuestionId: string | null;
    clientTimings?: Record<string, number>;
    answerReaction?: AnswerReaction;
    /** Expression policy of the bridge preceding this question; a null reply may be deliberate. */
    bridge?: AnswerReaction['bridge'] | null;
    answerContext?: ReturnType<typeof import('./providers/answer-context').answerContextTrace>;
    coreDecision?: {
      sourceTurnId?: string; sourceAnswerId?: string | null;
      fulfillment?: 'met' | 'partial' | 'unknown';
      nextAction?: 'FOLLOW_UP' | 'CLARIFICATION' | 'TRANSITION' | 'CLOSING';
      targetDescription?: string | null;
      [key: string]: unknown;
    };
    /** A same-meaning restatement links to its actual original question and carries no independent score. */
    clarificationOfTurnId?: string;
    nonEvaluative?: boolean;
    /** Actual capture attempt identity; changes on resume without changing the answer ID. */
    lastStreamId?: string;
    /** Provider capture and user answer commitment are separate state machines. */
    answerCaptureRevision?: number;
    answerSubmissionMode?: 'staged-v2';
    answerCommitStatus?: 'capturing' | 'staged' | 'deciding' | 'continuing' | 'advance_ready' | 'advancing' | 'committed';
    answerCandidateId?: string;
    answerEndingObservation?: import('./answer-candidate-state').AnswerEndingObservation;
    captureParts?: Array<{ streamId: string; captureRevision: number; rawTranscript: string; sha256: string; endedAt: string }>;
  };
  answerId?: string;
  rawTranscript?: string;
  transcriptStatus?: "streaming" | "paused" | "finalized" | "error";
  sttObservations?: TranscriptObservation[];
  metrics?: unknown;
  answerObservation?: AnswerSubmissionObservation;
}
export interface AnswerSubmissionObservation {
  classification: "speech_transcribed" | "silence_observed" | "empty_transcript";
  nonAnswer: boolean;
  durationMs: number | null;
  speakingMs: number | null;
  silenceMs: number | null;
  firstSpeechMs: number | null;
  speechDetected: boolean | null;
  rawTranscriptPreserved: true;
  origin: "finalized-stt-and-observed-speech-timing";
}
export interface TranscriptObservation {
  segmentId: string;
  revision: number;
  confidence: number | null;
  startTimestamp: number | null;
  endTimestamp: number | null;
}

/** Retain only the latest supplied revision of each stream/position observation. */
export function mergeTranscriptObservation(previous: TranscriptObservation[], observation: TranscriptObservation) {
  const index = previous.findIndex(item => item.segmentId === observation.segmentId);
  if (index < 0) return [...previous, observation];
  if (previous[index].revision > observation.revision) return previous;
  return previous.map((item, itemIndex) => itemIndex === index ? observation : item);
}
export interface QuestionPresentation {
  turnId: string;
  rootTurnId: string;
  questionKind: PreparedTurn['questionKind'];
  clockId?: string;
  startedAtMs: number | null;
  completedAtMs: number | null;
  interrupted?: boolean;
  errorCodes?: string[];
  attempts?: Array<{
    attemptId: string; clockId?: string;
    startedAtMs: number | null; completedAtMs: number | null;
    interrupted?: boolean; errorCodes?: string[]; eventIds: string[];
  }>;
  activeAttemptId?: string;
}
export interface InterviewSession {
  /** Server-owned provider charges; never accepted from candidate metrics. */
  providerUsageLedger?: import('./observability/session-provider-ledger').ProviderSessionLedger;
  runtime?: import('./session-runtime').SessionRuntimeState;
  id: string;
  createdAt: string;
  updatedAt: string;
  status: "active" | "ending" | "completed";
  evaluationStatus: "pending" | "running" | "completed" | "failed";
  evaluationError?: string;
  target: unknown;
  sourceManifest: unknown;
  /** Pinned at creation from the verified admission track, separate from elapsed active time. */
  durationSeconds?: number;
  mainQuestionTarget?: number;
  plan?: InterviewPlan;
  hasGreeted?: boolean;
  latency?: Record<string, number>;
  interviewOverview?: unknown;
  turns: RecordedTurn[];
  /** Actual browser question delivery, retained independently of prepared turns. */
  questionPresentations?: QuestionPresentation[];
  questionPresentationEventIds?: string[];
  followUpCountByMainQuestion: Record<string, number>;
  elapsedMs: number;
  metrics?: unknown;
  evaluation?: unknown;
  conversationLedger?: ReturnType<typeof import('./conversation-ledger').buildConversationLedger>;
}
export const clientTimingsSchema = z.record(z.string().min(1), z.number().finite().min(0));
export const nextRequestSchema = z.object({ turnId: z.string().uuid(), answerId: z.string().min(1).max(160), metrics: z.unknown().optional(), elapsedMs: z.number().finite().min(0).max(86_400_000), clientTimings: clientTimingsSchema.optional(), candidateId: z.string().uuid().optional(), captureRevision: z.number().int().positive().optional(), submissionAttemptId: z.string().uuid().optional(), clientEvents: playbackEventBatchSchema.optional() });
export const streamRequestSchema = z.object({ type: z.enum(["start", "finish", "pause", "cancel_submission"]), turnId: z.string().uuid(), answerId: z.string().min(1).max(160), captureRevision: z.number().int().positive().optional(), staged: z.boolean().optional(), submissionAttemptId: z.string().uuid().optional() });

/** Counters are authoritative server state. A follow-up always belongs to Q0. */
export function nextPosition(session: InterviewSession, desired: "main" | "follow_up" | "clarification" | "end", mainCount: number, maxFollowUps: number, durationSeconds: number, options: { clarificationMode?: 'repeat_audio' | 'rephrase' } = {}) {
  if (!Number.isInteger(maxFollowUps) || maxFollowUps < 0 || maxFollowUps > 2) throw new Error("꼬리질문 상한은 0~2이어야 합니다.");
  const previous = session.turns.at(-1);
  if (!previous) return { kind: "main" as const, mainIndex: 1, followUpIndex: 0, parentId: null };
  if (desired === "end" || session.elapsedMs >= durationSeconds * 1000) return null;
  const pinnedMainCount = sessionMainQuestionTarget(session, durationSeconds, mainCount);
  const timeBased = session.plan?.scheduling === 'time_based';
  const used = session.runtime ? deliveredFollowUpCount(session, previous.parentMainQuestionId) : session.followUpCountByMainQuestion[previous.parentMainQuestionId] ?? 0;
  if (desired === "clarification" && (options.clarificationMode === 'repeat_audio' ? mayReplayQuestion(session, durationSeconds) : mayAskClarification({ ...session, mainQuestionTarget: pinnedMainCount }, durationSeconds))) return { kind: "clarification" as const, mainIndex: previous.mainIndex, followUpIndex: used, parentId: previous.parentMainQuestionId };
  if (desired === "follow_up" && mayAskFollowUp({ ...session, mainQuestionTarget: pinnedMainCount }, durationSeconds, maxFollowUps)) return { kind: "follow_up" as const, mainIndex: previous.mainIndex, followUpIndex: used + 1, parentId: previous.parentMainQuestionId };
  if (!timeBased && previous.mainIndex >= pinnedMainCount) return null;
  return { kind: "main" as const, mainIndex: previous.mainIndex + 1, followUpIndex: 0, parentId: null };
}

/** Resolve actual Q0/F ancestry; a clarification may point through earlier non-evaluative attempts. */
export function actualEvaluativeQuestion(session: Pick<InterviewSession, 'turns'>, from = session.turns.at(-1)): RecordedTurn | null {
  let current = from; const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id)) return null; seen.add(current.id);
    if (current.questionKind !== 'clarification' && current.metadata?.nonEvaluative !== true) return current;
    const nextId = current.metadata?.clarificationOfTurnId;
    if (!nextId) return session.turns.find(turn => turn.id === current!.parentMainQuestionId && turn.questionKind === 'main') ?? null; // Conservative legacy linkage only.
    const parent = session.turns.find(turn => turn.id === nextId);
    if (!parent || parent.parentMainQuestionId !== current.parentMainQuestionId) return null;
    current = parent;
  }
  return null;
}
/** Pure re-listening consumes neither the meaning-rephrase allowance nor an evaluative F. No new count policy is invented. */
export function mayReplayQuestion(session: InterviewSession, durationSeconds: number) {
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds <= 0) throw new Error('면접 진행 시간을 확인할 수 없습니다.');
  return Boolean(actualEvaluativeQuestion(session) && session.elapsedMs < durationSeconds * 1000);
}
/** One meaning rephrase per actual evaluative question; a Q0 rephrase does not block an F1 rephrase. */
export function mayAskClarification(session: InterviewSession, durationSeconds: number) {
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds <= 0) throw new Error("면접 진행 시간을 확인할 수 없습니다.");
  const previous = session.turns.at(-1), original = actualEvaluativeQuestion(session);
  if (!previous || !original || session.turns.some(turn => turn.questionKind === 'clarification' && turn.metadata?.clarificationMode !== 'repeat_audio' && actualEvaluativeQuestion(session, turn)?.id === original.id)) return false;
  const remainingMains = session.plan?.scheduling === 'time_based' ? 0 : Math.max(0, sessionMainQuestionTarget(session, durationSeconds) - previous.mainIndex);
  return durationSeconds * 1000 - session.elapsedMs > (remainingMains * MAIN_QUESTION_RESERVE_SECONDS + FOLLOW_UP_RESERVE_SECONDS) * 1000;
}

/** Empty is a valid finalized observation. An absent transcript or a failed live stream is not. */
export function isFinalizedAnswer(turn: RecordedTurn | undefined): turn is RecordedTurn & { answerId: string; rawTranscript: string } {
  return Boolean(turn && typeof turn.answerId === "string" && turn.answerId.trim() && turn.transcriptStatus === "finalized" && typeof turn.rawTranscript === "string");
}

/** CLOVA position replaces a revision in the current stream; never cumulative append. */
export function replaceTranscriptAt(previous: string, text: string, position: number) {
  if (!Number.isInteger(position) || position < 0 || position > previous.length) throw new Error("CLOVA 전사 위치가 유효하지 않습니다.");
  return previous.slice(0, position) + text;
}
export function concatenateStreamTranscript(prefix: string, current: string) {
  if (!prefix) return current;
  if (!current) return prefix;
  // Streams do not replay PCM. Only add a boundary space; repeated real speech remains intact.
  return prefix + (/\s$/.test(prefix) || /^\s|^[,.!?;:]/.test(current) ? "" : " ") + current;
}
export function safeProviderError(error: unknown) {
  let message = error instanceof Error ? error.message : "연결 처리 중 오류가 발생했습니다.";
  for (const key of ["OPENAI_API_KEY", "CLOVA_SPEECH_SECRET_KEY", "CLOVA_VOICE_CLIENT_ID", "CLOVA_VOICE_CLIENT_SECRET"]) {
    const secret = process.env[key];
    if (secret) message = message.split(secret).join("[비공개]");
  }
  return message.replace(/sk-[A-Za-z0-9_-]+/g, "[비공개]").slice(0, 700);
}

/** Share an in-flight operation and retain its success. Failed operations may retry. */
export class IdempotentTurnOperations<T> {
  private pending = new Map<string, Promise<T>>();
  private results = new Map<string, T>();
  get(key: string) { return this.results.get(key); }
  pendingResult(key: string) { return this.pending.get(key); }
  run(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.results.has(key)) return Promise.resolve(this.results.get(key)!);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = Promise.resolve().then(operation).then(result => {
      this.results.set(key, result);
      return result;
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, promise);
    return promise;
  }
}

/** Explicit ending accepts already-flushed paused audio, never an errored/incomplete capture. */
export function finalizeCapturedTurnForEnd(turn: RecordedTurn | undefined, activeStreamsFlushed: boolean) {
  if (!turn || !turn.answerId) return;
  if (turn.transcriptStatus === "paused" || (turn.transcriptStatus === "streaming" && activeStreamsFlushed)) turn.transcriptStatus = "finalized";
}
