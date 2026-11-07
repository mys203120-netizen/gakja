import { createHash, randomUUID } from 'node:crypto';
import { interviewConfig } from '../interview.config';
import type { InterviewContext } from './data/load-interview-context';
import type { PreparedQuestionBank } from './data/prepared-question-bank';
import { sessionDurationSeconds } from './data/school-context';
import { actualEvaluativeQuestion, mayAskClarification, mayReplayQuestion, nextPosition, type InterviewSession, type RecordedTurn, type QuestionDraft } from './protocol';
import { currentPlanSlot, mayAskFollowUp, sessionMainQuestionTarget } from './interview-planner';
import { checkpointSession } from './session-runtime';
import { evaluationInputFrozen, sessionEventId as journalId } from './session-lifecycle';
import { buildConversationLedger, conversationLedgerTrace } from './conversation-ledger';
import { answerContextTrace } from './providers/answer-context';
import { assertQuestionContractIntegrity, bindQuestionContractToTurn } from './question-objective';
import { assertCandidateSource, transcriptHash } from './answer-candidate-state';
import { assertRepairProof, createRepairContract } from './providers/repair-contract';
import { singleCoreCandidateDecisionSchema } from './providers/single-core-contract';
import { runTurnWorkStage, type TurnWorkContext } from './turn-work';
import type { AnswerReaction } from './providers/answer-reaction';
import type { SpeechSynthesisSettings } from './providers/speech-audio-cache';
import type { ConversationEvent } from './storage/conversation-log';
import type { ProviderUsageObservation } from './observability/provider-cost';

export type AcknowledgementReady = { type: 'acknowledgement_ready'; turnId: string; acknowledgement: string; acknowledgementAudioUrl: string; interviewerId: string };
export type PreparedWork = {
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

export interface SessionTurnProviders {
  runRealtimeCore: typeof import('./providers/realtime-core').runRealtimeCore;
  approvedRestatement: typeof import('./providers/approved-restatement').approvedRestatement;
  approvedAudioReplay: typeof import('./providers/approved-audio-replay').approvedAudioReplay;
  synthesizeSpeech: typeof import('./providers/clova-tts').synthesizeSpeech;
  readSpeechAudio: typeof import('./providers/clova-tts').readSpeechAudio;
  interviewerVoiceDefaults: typeof import('./providers/clova-tts').interviewerVoiceDefaults;
  selectNextPreparedMainQuestion: typeof import('./data/prepared-question-bank').selectNextPreparedMainQuestion;
  assertSingleCoreCandidateBinding: typeof import('./providers/single-core-runtime').assertSingleCoreCandidateBinding;
  SINGLE_CORE_ENGINE_VERSION: typeof import('./providers/single-core-runtime').SINGLE_CORE_ENGINE_VERSION;
}
export interface SessionTurnPreparerDependencies {
  ownerId: string;
  contextFor(session: InterviewSession): Promise<InterviewContext>;
  requireQuestionBank(context: InterviewContext, session?: InterviewSession): Promise<PreparedQuestionBank>;
  /** Local saves keep their existing behavior. E supplies explicit progress
   * commits bound to its durable operation token/generation/revision. */
  save(session: InterviewSession): Promise<void>;
  journal(session: InterviewSession, event: ConversationEvent): unknown;
  observeSessionUsage(session: InterviewSession, stage: 'core' | 'review' | 'repair' | 'evaluation', attemptId: string, observation: ProviderUsageObservation): void;
  preparedDrafts: Map<string, PreparedWork>;
  audioOwners: Map<string, string>;
  HttpError: new (status: number, message: string, code?: string) => Error;
  providers: SessionTurnProviders;
}
/** The actual existing question engine, extracted without a second policy or
 * persistence adapter. Every provider and persistence action is explicit. */
export function createSessionTurnPreparer(dependencies: SessionTurnPreparerDependencies) {
  const { contextFor: sessionContext, requireQuestionBank, save, journal, observeSessionUsage, preparedDrafts, audioOwners, HttpError } = dependencies;
  const owner = { id: dependencies.ownerId };
  const { runRealtimeCore, approvedRestatement, approvedAudioReplay, synthesizeSpeech, readSpeechAudio, interviewerVoiceDefaults, selectNextPreparedMainQuestion, assertSingleCoreCandidateBinding, SINGLE_CORE_ENGINE_VERSION } = dependencies.providers;
  return async function prepareTurn(session: InterviewSession, forceMain = false, onAcknowledgement?: (event: AcknowledgementReady) => void, persist = true, retryKey?: string, workContext?: TurnWorkContext): Promise<RecordedTurn | null> {
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

}
