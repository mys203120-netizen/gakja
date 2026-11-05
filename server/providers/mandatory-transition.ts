import { actualEvaluativeQuestion, type InterviewSession } from '../protocol';
import type { AnswerReaction } from './answer-reaction';
import { selectBridge } from './acknowledgement-phrases';

/** Actual semantic off-topic observations, not a keyword test or an accusation. */
export function repeatedUnrelatedAfterRephrase(session: InterviewSession) {
  const current = session.turns.at(-1);
  if (!current || current.questionKind !== 'clarification') return false;
  const original = actualEvaluativeQuestion(session, current);
  if (!original) return false;
  let unrelatedObserved = false;
  for (const turn of session.turns) {
    if (actualEvaluativeQuestion(session, turn)?.id !== original.id) continue;
    // An audio replay is not a rephrase and does not reset a prior rephrase.
    if (turn.questionKind === 'clarification' && turn.metadata.clarificationMode !== 'repeat_audio' && unrelatedObserved) return true;
    if (turn.id !== current.id && (turn.metadata.coreDecision?.answerRelation as { kind?: string } | undefined)?.kind === 'unrelated') unrelatedObserved = true;
  }
  return false;
}

export function bindRequiredTransition(reaction: AnswerReaction, session: InterviewSession): AnswerReaction {
  if (reaction.directive !== 'next_main' || reaction.classification !== 'off_topic' || !repeatedUnrelatedAfterRephrase(session)) return reaction;
  const current = session.turns.at(-1)!;
  const previousTexts = session.turns.flatMap(turn => turn.acknowledgement ? [turn.acknowledgement] : []);
  const selected = selectBridge({ kind: 'off_topic_end', seed: `${session.id}:${current.id}:${current.answerId}`, previousTexts });
  if (!selected.text) throw new Error('MANDATORY_TRANSITION_MISSING');
  return { ...reaction, reply: selected.text, keywordQuote: null, evidenceSpan: null, bridge: selected.trace };
}
