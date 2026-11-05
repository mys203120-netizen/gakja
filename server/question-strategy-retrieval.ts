import { createHash } from 'node:crypto';
import { projectQuestionStrategy, type QuestionStrategyCatalog, type QuestionStrategyCard, type StrategyTrigger, type RuntimeQuestionStrategy } from './data/question-strategy-catalog';
import { hasObservedComparison, hasObservedMeasurement } from './providers/follow-up-language';

export interface StrategyRetrievalInput {
  primaryFunction?: string; depth?: string; targetText?: string; answerText?: string;
  recentIds?: readonly string[]; seed?: string; limit?: number; remainingFollowUps?: number;
  availableSlots?: readonly string[];
  /** Only positively known missing resources; ordinary absence of a signal remains unknown. */
  unavailableSlots?: readonly string[];
}
/** Observations widen retrieval only. Missing a regex is never semantic disqualification. */
export function observeStrategySignals(answer: string): StrategyTrigger[] {
  const result = new Set<StrategyTrigger>(['always']);
  if (answer.trim()) result.add('new_answer_claim');
  if (/관심|노력|배웠|중요|좋|협력|리더십|성장/u.test(answer)) result.add('abstract_claim');
  if (/생각|판단|때문|결론|확인|알게|라고|다고/u.test(answer)) result.add('assertion');
  if (/선택|골랐|고른|택했|우선|기준/u.test(answer)) result.add('choice');
  if (/방법|과정|먼저|다음|했|하였|진행/u.test(answer)) result.add('method');
  if (hasObservedMeasurement(answer)) result.add('numeric_claim');
  if (hasObservedComparison(answer)) result.add('comparison_claim');
  if (/모르|확실|아마|기억|같습니다/u.test(answer)) result.add('uncertainty');
  if (/정정|정확히는|아니라|바로잡/u.test(answer)) result.add('correction');
  if (/찬성|반대|긍정|부정|동의|입장/u.test(answer)) result.add('stance');
  return [...result];
}
function stableRank(seed: string, id: string) { return createHash('sha256').update(`${seed}:${id}`).digest('hex'); }
function scoreCard(card: QuestionStrategyCard, input: StrategyRetrievalInput, signals: readonly StrategyTrigger[]) {
  const observationScore = signals.includes(card.trigger) ? card.trigger === 'always' ? 2 : 16 : 0;
  const functionScore = card.primaryFunctions.includes(input.primaryFunction as QuestionStrategyCard['primaryFunctions'][number]) ? 5 : 0;
  const depthDistance = input.depth ? Math.abs(Number(input.depth.slice(1)) - Number(card.depth.slice(1))) : 0;
  const text = `${card.assessmentTarget} ${card.expectedEvidence.join(' ')}`;
  const targetTerms = [...new Set((input.targetText ?? '').match(/[가-힣]{2,}/gu) ?? [])];
  const targetScore = Math.min(8, targetTerms.reduce((score, term) => score + Number(text.includes(term)), 0) * 2);
  const explorationScore = ['limit', 'alternative', 'transfer', 'evidence_verification', 'own_action'].includes(card.operation) ? 2 : 0;
  const observedStance = /찬성|긍정/u.test(input.answerText ?? '') ? 'affirmative_stance' : /반대|부정/u.test(input.answerText ?? '') ? 'negative_stance' : null;
  const branchScore = observedStance && card.relations.some(relation => relation.kind === 'answer_conditioned' && relation.condition === observedStance) ? 4 : 0;
  return observationScore + functionScore + targetScore + explorationScore + branchScore - depthDistance;
}
export function retrieveQuestionStrategies(catalog: QuestionStrategyCatalog | null | undefined, input: StrategyRetrievalInput): RuntimeQuestionStrategy[] {
  if (!catalog || !catalog.coverage.complete || input.remainingFollowUps !== undefined && input.remainingFollowUps <= 0) return [];
  const limit = Math.max(0, Math.min(12, Math.floor(input.limit ?? 8))), signals = observeStrategySignals(input.answerText ?? '');
  const recent = new Set(input.recentIds ?? []), seenOperations = new Set<string>(), selected: QuestionStrategyCard[] = [];
  const unavailable = new Set(input.unavailableSlots ?? []);
  const candidates = catalog.cards.filter(card => !card.requiredClaimSlots.some(slot => unavailable.has(slot))).map(card => ({ card, score: scoreCard(card, input, signals), recent: recent.has(card.id) || recent.has(card.questionId), rank: stableRank(input.seed ?? '', card.id) })).sort((a, b) => Number(a.recent) - Number(b.recent) || b.score - a.score || a.rank.localeCompare(b.rank));
  // Diversity is semantic-operation diversity, not a hard same-primary-function gate.
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    if (seenOperations.has(candidate.card.operation)) continue;
    selected.push(candidate.card); seenOperations.add(candidate.card.operation);
  }
  return selected.map(projectQuestionStrategy);
}
