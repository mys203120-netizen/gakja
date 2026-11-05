import { createHash } from 'node:crypto';
import type { InterviewSession } from '../protocol';

/** An observed fragment, never a rule that short answers or unknown scientific terms are invalid. */
export function isIncompleteAnswerFragment(raw: string) {
  const text = raw.normalize('NFC').replace(/[\s,.!?。？]+/gu, '');
  return /^(?:같은|어떤|그런|이런|저런|그러한|이러한|저러한|그리고|그래서|하지만|그러면|그러니까|예를들면|왜냐하면|이를통해|그것을|이것을|그때|뭔가|그냥)$/u.test(text);
}

function observedLanguageSignals(raw: string) {
  const patterns = [
    ['correction', /정정|정확히는|아니라|앞서.{0,12}잘못/gu],
    ['negation', /아니요|아닙니다|없었습니다|않았습니다|하지\s*않|못했/gu],
    ['uncertainty', /기억.{0,8}않|모르겠|확실하지|아마|같습니다/gu],
  ] as const;
  return patterns.flatMap(([kind, pattern]) => [...raw.matchAll(pattern)].map(match => ({ kind, start: match.index!, end: match.index! + match[0].length })));
}

/** Source-bound memory shared by the fast reaction and question workers. No model summary is substituted for an answer. */
export function buildAnswerContext(session: InterviewSession) {
  const current = session.turns.at(-1);
  if (!current) return null;
  const rootId = current.parentMainQuestionId;
  const root = session.turns.find(turn => turn.id === rootId) ?? current;
  const turns = session.turns.filter(turn => turn.parentMainQuestionId === rootId);
  const answers = turns.filter(turn => turn.transcriptStatus === 'finalized' && Boolean(turn.answerId)).map(turn => ({
    turnId: turn.id, answerId: turn.answerId!, kind: turn.questionKind,
    question: turn.questionText, requestedTargets: turn.metadata.targetEvidence,
    rawTranscript: turn.rawTranscript ?? '',
    languageSignals: observedLanguageSignals(turn.rawTranscript ?? ''),
    observation: !(turn.rawTranscript ?? '').trim() ? 'no_final_words' as const : isIncompleteAnswerFragment(turn.rawTranscript!) ? 'incomplete_fragment' as const : 'final_words' as const,
  }));
  const probes = turns.flatMap(turn => {
    const reaction = turn.metadata.answerReaction;
    return reaction && reaction.sourceTurnId === turn.id && reaction.sourceAnswerId === turn.answerId ? [{
      turnId: turn.id, answerId: turn.answerId!, classification: reaction.classification,
      directive: reaction.directive, reasonCode: reaction.reasonCode,
      requestedTarget: reaction.requestedTarget ?? null, missingTarget: reaction.missingTarget,
    }] : [];
  });
  return {
    version: 'answer-context-v1' as const, rootTurnId: rootId, currentTurnId: current.id,
    rootQuestion: { text: root.questionText, intent: root.metadata.questionIntent, primaryFunction: root.metadata.primaryFunction, targetEvidence: root.metadata.targetEvidence },
    currentQuestion: { text: current.questionText, intent: current.metadata.questionIntent, targetEvidence: current.metadata.targetEvidence },
    answers, probes,
    interpretationPolicy: 'Actual finalized words only. Read all attempts together; preserve negation, correction, uncertainty and attribution. A terminology/pronunciation repair changes only its stated span; it does not retract surrounding explanations. A correction signal is not proof of a prior error or contradiction. No inferred fulfillment, facts or scores.' as const,
  };
}

/** The private journal already stores raw transcripts; this trace references them without duplicating them. */
export function answerContextTrace(session: InterviewSession) {
  const context = buildAnswerContext(session);
  if (!context) return null;
  return { version: context.version, rootTurnId: context.rootTurnId, currentTurnId: context.currentTurnId,
    answers: context.answers.map(({ turnId, answerId, rawTranscript, observation }) => ({ turnId, answerId, observation, characterCount: rawTranscript.length, transcriptSha256: createHash('sha256').update(rawTranscript).digest('hex') })),
    requestedTargets: context.currentQuestion.targetEvidence, priorProbeCount: context.probes.length,
  };
}
