import type { InterviewContext } from '../data/load-interview-context';
import type { RuntimeQuestionStrategy } from '../data/question-strategy-catalog';
import type { ConversationLedger } from '../conversation-ledger';
import type { InterviewSession, RecordedTurn } from '../protocol';
import { buildAnswerContext } from './answer-context';
import { questionAnchorProjection, type QuestionAnchor, type QuestionOperation, type QuestionIROptions } from './question-realization';
import { currentQuestionVocabulary } from './speech-vocabulary';
import { interpretTranscriptTerms } from './transcript-interpretation';
import { personalActionWitness } from './local-demand-witness';
import { approvedNeutralBridgeTexts } from './acknowledgement-phrases';

export const RUNTIME_PAYLOAD_VERSION = 'exact-source-runtime-payload-v1';
export interface RuntimePayloadScope {
  current: RecordedTurn;
  root: RecordedTurn;
  ledger: ConversationLedger;
  anchors: readonly QuestionAnchor[];
  strategies: readonly RuntimeQuestionStrategy[];
  operations: readonly QuestionOperation[];
  irOptions: Pick<QuestionIROptions, 'contradictionPairs'>;
}
export interface RuntimePayloadOptions {
  allowFollowUp: boolean;
  allowClarification: boolean;
  allowAudioReplay: boolean;
  remainingMs: number;
  /** The older test/injected IR protocol requires anchor and pair enumerations. */
  legacyIrProjection?: boolean;
  semanticAuthority?: 'single_core';
  answerCommitStage?: 'candidate' | 'committed';
}

/** Retrieval stays broad; a small presented set keeps operation diversity. A
 * correction signal widens presentation, never proves a contradiction. */
export function selectRuntimeStrategies(strategies: readonly RuntimeQuestionStrategy[], options: { limit?: number; hasCorrection?: boolean; remainingFollowUps?: number } = {}) {
  if (options.remainingFollowUps !== undefined && options.remainingFollowUps <= 0) return [];
  const limit = Math.max(3, Math.min(5, Math.floor(options.limit ?? 5)));
  const selected = [...strategies.slice(0, limit)];
  if (options.hasCorrection && !selected.some(card => card.operation === 'contradiction')) {
    const correction = strategies.find(card => card.operation === 'contradiction');
    if (correction) selected.splice(Math.max(0, selected.length - 1), 1, correction);
  }
  return selected;
}

/** Exact text is retained once. References are identities and offsets, never an
 * AI paraphrase substituted for the student's words. All logs stay server-side. */
export function runtimeCorePayload(context: InterviewContext, session: InterviewSession, scope: RuntimePayloadScope, options: RuntimePayloadOptions) {
  const { current, root, ledger } = scope;
  const answerContext = buildAnswerContext(session);
  const history = answerContext ? {
    version: RUNTIME_PAYLOAD_VERSION,
    rootTurnId: answerContext.rootTurnId,
    currentTurnId: answerContext.currentTurnId,
    answers: answerContext.answers.map(answer => ({
      turnId: answer.turnId, answerId: answer.answerId, kind: answer.kind,
      questionRef: answer.turnId,
      ...(answer.turnId === current.id ? { transcriptRef: 'answer.finalTranscript' } : { rawTranscript: answer.rawTranscript }),
      ...(options.semanticAuthority ? {} : { languageSignals: answer.languageSignals }),
      ...(options.semanticAuthority ? {} : { observation: answer.observation }),
    })),
    ...(options.semanticAuthority ? {} : { probes: answerContext.probes }),
    interpretationPolicy: options.semanticAuthority
      ? 'Exact provider transcript segments only. Provider finalization ends a capture segment; it does not prove the student has semantically finished the answer. The sole core reads completion first, preserving negation, unfinished qualifications, quantities, uncertainty and attribution.'
      : answerContext.interpretationPolicy,
  } : null;
  const question = (turn: RecordedTurn) => ({ turnId: turn.id, text: turn.questionText, intent: turn.metadata.questionIntent, primaryFunction: turn.metadata.primaryFunction, targetEvidence: turn.metadata.targetEvidence });
  const clusterRefs = ledger.answers.filter(answer => answer.sameCluster).map(answer => ({
    turnId: answer.turnId, answerId: answer.answerId, transcriptSha256: answer.transcriptSha256,
    transcriptRef: answer.turnId === current.id ? 'answer.finalTranscript' : 'actualAnswers.answers',
  }));
  return {
    payloadVersion: RUNTIME_PAYLOAD_VERSION,
    target: context.target,
    schoolConstraints: { academicYear: context.school.academicYear, trackId: context.school.interview?.id ?? null, campus: context.school.department?.campus ?? null, officialEvaluationElements: context.school.officialInterviewCriteria?.elements.map(element => element.name) ?? [], status: 'pinned official profile; never student facts or question-count quotas' },
    sourceEvidence: context.student.evidence.filter(source => root.evidenceIds.includes(source.id)).map(source => ({ id: source.id, activityId: source.activityId, page: source.page, text: source.text, sourceRef: { pdfSha256: source.sourceRef.pdfSha256, page: source.sourceRef.page, startOffset: source.sourceRef.startOffset, endOffset: source.sourceRef.endOffset } })),
    commonModule: root.metadata.commonApproval ?? null,
    question: question(current),
    turn_local_coverage: { ...(options.semanticAuthority ? {} : { personalActionWitness: personalActionWitness(current) }), questionId: current.id, targetId: ledger.currentRequestedTargetId,
      scope: 'Only the actual spoken current question determines fulfillment. Root gaps are separate; OR/one-example requests do not require every root activity.',
      rootTargetId: ledger.rootRequestedTargetId, rootGapsAreNotCurrentRequirements: true },
    rootQuestion: root.id === current.id ? { sameAs: 'question', turnId: root.id } : question(root),
    clusterObjective: ledger.clusterObjective ?? { description: root.metadata.questionIntent },
    answer: { turnId: current.id, answerId: current.answerId, finalTranscript: current.rawTranscript,
      pronunciationReadings: interpretTranscriptTerms(current.rawTranscript ?? '', currentQuestionVocabulary(context, current)).readings,
      contextVocabulary: currentQuestionVocabulary(context, current),
      readingPolicy: 'Context vocabulary is a reading aid, not a transcript replacement or proof of what was said. The sole core interprets terms in the actual question and answer context, preserving negation, quantities, comparison direction, speaker and uncertainty. Uncertain recognition alone does not justify an evaluative follow-up.',
      ...(options.legacyIrProjection ? { anchors: questionAnchorProjection(scope.anchors) } : {}),
    },
    actualAnswers: history,
    clusterAnswers: clusterRefs,
    memory: {
      requestedTargets: ledger.requestedTargets.map(target => ({ id: target.id, turnId: target.turnId, intent: target.intent, expectedEvidence: target.expectedEvidence, primaryFunction: target.primaryFunction, ...(options.semanticAuthority ? {} : { fulfillment: target.fulfillment }), nonEvaluative: target.nonEvaluative })),
      ...(options.semanticAuthority ? {} : { establishedTargets: ledger.establishedTargets, unresolvedTargets: ledger.unresolvedTargets }),
      // Claims contain locations only; their exact words are in the answer tables.
      ...(options.semanticAuthority ? {} : { claimRefs: ledger.claims.map(claim => ({ id: claim.id, turnId: claim.turnId, answerId: claim.answerId, sourceId: claim.sourceId, revision: claim.revision, start: claim.start, end: claim.end, signals: claim.signals, status: claim.status })) }),
      ...(options.semanticAuthority ? {} : { correctionCandidates: ledger.correctionCandidates, declinedTargets: ledger.declinedTargets }),
      crossClusterAnswers: ledger.answers.filter(answer => !answer.sameCluster),
    },
    alreadyAsked: session.turns.filter(turn => turn.parentMainQuestionId === root.id && turn.id !== current.id && turn.id !== root.id).map(turn => ({ ...question(turn), operation: turn.metadata.questionRealization?.operation ?? null })),
    strategyCandidates: scope.strategies.map(({ id, operation, trigger, requiredClaimSlots, expectedEvidence, surface, applicabilityConditions }) => ({ id, operation, trigger, requiredClaimSlots, expectedEvidence, surface, applicabilityConditions })),
    ...(options.semanticAuthority ? {} : { allowedOperations: scope.operations }),
    ...(options.legacyIrProjection ? { availableContradictionPairs: scope.irOptions.contradictionPairs } : {}),
    allowFollowUp: options.allowFollowUp, allowClarification: options.allowClarification,
    allowAudioReplay: options.allowAudioReplay,
    followUpsUsed: ledger.followUpsUsed, maxFollowUps: 2,
    remainingMs: options.remainingMs,
    referencePolicy: 'questionRef is a turnId in question/rootQuestion/alreadyAsked. Current words are answer.finalTranscript; earlier same-cluster words are actualAnswers.answers; cross-cluster words are memory.crossClusterAnswers. Claims are exact UTF-16 spans of those words, not verified facts. All original transcripts remain unchanged.',
  };
}

/** The v5 meaning input uses actual spoken questions, not the preparer's
 * unspoken intent/target checklist. All metadata remains in server storage.
 * This prevents a broad hidden objective from becoming a new answer demand. */
export function singleCoreInputPayload(context: InterviewContext, session: InterviewSession, scope: RuntimePayloadScope, options: RuntimePayloadOptions, approvedRestatements: readonly string[] = []) {
  const previous = runtimeCorePayload(context, session, scope, { ...options, semanticAuthority: 'single_core' });
  const { current, root, ledger } = scope;
  const transcriptText = previous.answer.finalTranscript;
  const answerSource = { turnId: previous.answer.turnId, answerId: previous.answer.answerId,
    pronunciationReadings: previous.answer.pronunciationReadings, contextVocabulary: previous.answer.contextVocabulary };
  const actualAnswers = previous.actualAnswers ? {
    rootTurnId: previous.actualAnswers.rootTurnId, currentTurnId: previous.actualAnswers.currentTurnId,
    answers: previous.actualAnswers.answers.map(answer => answer.turnId === current.id ? { ...answer, transcriptRef: 'answer.transcriptText' } : answer),
  } : null;
  return {
    payloadVersion: 'spoken-question-single-core-input-v6', target: previous.target, schoolConstraints: previous.schoolConstraints,
    // Hashes/offsets stay in the source-bound server contract. Source IDs and
    // exact evidence text suffice for model reading; no original is shortened.
    sourceEvidence: previous.sourceEvidence.map(({ id, activityId, page, text }) => ({ id, activityId, page, text })), commonModule: previous.commonModule,
    question: { turnId: current.id, text: current.questionText },
    rootQuestion: current.id === root.id ? { sameAs: 'question', turnId: root.id } : { turnId: root.id, text: root.questionText },
    answer: { ...answerSource, transcriptText, submissionState: options.answerCommitStage ?? 'committed' },
    actualAnswers,
    crossClusterAnswers: ledger.answers.filter(answer => !answer.sameCluster).map(({ turnId, answerId, rawTranscript }) => ({ turnId, answerId, rawTranscript })),
    alreadyAsked: session.turns.filter(turn => turn.parentMainQuestionId === root.id && turn.id !== current.id && turn.id !== root.id)
      .map(turn => ({ turnId: turn.id, text: turn.questionText, kind: turn.questionKind, replay: turn.metadata.clarificationMode === 'repeat_audio' })),
    strategyCandidates: scope.strategies.map(({ id, operation, surface }) => ({ id, operation, surface })),
    approvedRestatements,
    approvedNeutralBridges: approvedNeutralBridgeTexts,
    recentSpokenReactions: session.turns.flatMap(turn => turn.acknowledgement ? [turn.acknowledgement] : []).slice(-6),
    allowFollowUp: options.allowFollowUp, allowClarification: options.allowClarification, allowAudioReplay: options.allowAudioReplay,
    followUpsUsed: ledger.followUpsUsed, maxFollowUps: 2, remainingMs: options.remainingMs,
    technicalObservation: current.answerObservation ?? null,
    endingObservation: current.metadata.answerEndingObservation ?? null,
  };
}
