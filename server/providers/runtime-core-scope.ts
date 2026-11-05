import type { InterviewContext } from '../data/load-interview-context';
import type { InterviewSession } from '../protocol';
import { buildConversationLedger } from '../conversation-ledger';
import { retrieveQuestionStrategies } from '../question-strategy-retrieval';
import { coreQuoteOptions } from './realtime-core';
import { buildQuestionAnchorCandidates, availableQuestionOperations } from './question-realization';
import { selectRuntimeStrategies } from './runtime-core-payload';

/** Source/identity retrieval only. Semantic decisions belong to the core. */
export function buildRuntimeCoreScope(context: InterviewContext, session: InterviewSession, compact = true) {
  const current = session.turns.at(-1)!, root = session.turns.find(turn => turn.id === current.parentMainQuestionId)!;
  const currentAnchors = buildQuestionAnchorCandidates({ turnId: current.id, answerId: current.answerId!, rawTranscript: current.rawTranscript!, quoteOptions: coreQuoteOptions(current.rawTranscript!) });
  const priorTurns = session.turns.filter(turn => turn.id !== current.id && turn.parentMainQuestionId === root.id && turn.transcriptStatus === 'finalized' && turn.answerId && turn.rawTranscript?.trim());
  const priorAnchors = priorTurns.flatMap(turn => buildQuestionAnchorCandidates({ turnId: turn.id, answerId: turn.answerId!, rawTranscript: turn.rawTranscript!, quoteOptions: coreQuoteOptions(turn.rawTranscript!).slice(-3) })).slice(-6);
  const anchors = [...currentAnchors, ...priorAnchors];
  const contradictionPairs = currentAnchors.flatMap(currentAnchor => priorAnchors.map(prior => [currentAnchor.id, prior.id] as const));
  const irOptions = { primaryTurnId: current.id, contradictionPairs };
  const ledger = buildConversationLedger(session);
  const recent = session.turns.flatMap(turn => turn.metadata.strategyTrace?.selectedCardId ? [turn.metadata.strategyTrace.selectedCardId] : []);
  const retrieved = retrieveQuestionStrategies(context.questionStrategies, { primaryFunction: current.metadata.primaryFunction, depth: current.metadata.depth, targetText: current.metadata.targetEvidence.join(' '), answerText: current.rawTranscript, recentIds: recent, seed: `${session.id}:${current.id}:${current.answerId}`, limit: 8, remainingFollowUps: 2 - ledger.followUpsUsed });
  const strategies = compact ? selectRuntimeStrategies(retrieved, { remainingFollowUps: 2 - ledger.followUpsUsed }) : retrieved;
  return { current, root, anchors, currentAnchors, irOptions, operations: availableQuestionOperations(anchors, irOptions), ledger, strategies };
}
