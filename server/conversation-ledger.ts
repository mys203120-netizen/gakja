import { createHash } from 'node:crypto';
import type { InterviewSession, RecordedTurn } from './protocol';
import type { QuestionBlueprint } from './question-objective';
import { deliveredFollowUpCount } from './follow-up-count';

export const CONVERSATION_LEDGER_VERSION = 'source-bound-conversation-ledger-v2';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type LedgerMetadata = RecordedTurn['metadata'] & {
  questionBlueprint?: QuestionBlueprint;
  coreDecision?: { sourceTurnId: string; sourceAnswerId: string; fulfillment: 'met' | 'partial' | 'unknown'; nextAction?: string; targetDescription?: string; interpretation?: import('./providers/natural-question').DialogueInterpretation };
};
export interface LedgerClaim {
  id: string; turnId: string; answerId: string; sourceId: string; revision: string;
  start: number; end: number; text: string;
  status: 'student_claim_unverified';
  signals: Array<{ kind: 'negation' | 'correction' | 'uncertainty'; start: number; end: number }>;
}
export interface LedgerTarget {
  id: string; clusterId: string; turnId: string; questionText: string;
  intent: string; expectedEvidence: string[]; primaryFunction: RecordedTurn['metadata']['primaryFunction'];
  fulfillment: 'met' | 'partial' | 'unknown';
  observationOrigin: 'bound_core_decision' | 'bound_answer_reaction' | 'not_observed';
  nonEvaluative: boolean;
}
export interface ConversationLedger {
  version: typeof CONVERSATION_LEDGER_VERSION; rootTurnId: string | null;
  clusterObjective: { id: string; description: string } | null;
  requestedTargets: LedgerTarget[]; establishedTargets: string[]; unresolvedTargets: string[];
  claims: LedgerClaim[];
  answers: Array<{ turnId: string; answerId: string; transcriptSha256: string; rawTranscript: string; observation: 'final_words' | 'no_final_words'; sameCluster: boolean }>;
  correctionCandidates: Array<{ correctionClaimId: string; earlierClaimIds: string[]; status: 'requires_context_review' }>;
  declinedTargets: Array<{ turnId: string; answerId: string; targetId: string; reason: 'explicit_non_answer' | 'silence' }>;
  askedTargetKeys: string[]; followUpsUsed: number;
  crossClusterTurnIds: string[];
  rootRequestedTargetId: string | null; currentRequestedTargetId: string | null;
  meaningCoverage: Array<{ targetId: string; observedAtTurnId: string; sourceTurnId: string; answerId: string; start: number; end: number }>;
  limitations: string[];
  contentSha256: string;
}

function languageSignals(raw: string) {
  const patterns = [
    ['correction', /정정|정확히는|아니라|앞서.{0,12}잘못|바로잡/gu],
    ['negation', /아니요|아닙니다|없었습니다|않았습니다|하지\s*않|못했|안\s*했/gu],
    ['uncertainty', /기억.{0,8}않|모르겠|확실하지|아마|같습니다/gu],
  ] as const;
  return patterns.flatMap(([kind, pattern]) => [...raw.matchAll(pattern)].map(match => ({ kind, start: match.index!, end: match.index! + match[0].length })));
}

function turnClaims(turn: RecordedTurn): LedgerClaim[] {
  if (turn.transcriptStatus !== 'finalized' || !turn.answerId || !turn.rawTranscript?.trim()) return [];
  const raw = turn.rawTranscript, revision = hash(raw), signals = languageSignals(raw);
  return [...raw.matchAll(/[^!?。\n;]+[!?。;]?/gu)].flatMap(match => {
    const leading = match[0].length - match[0].trimStart().length;
    const start = match.index! + leading, text = match[0].trim();
    const end = start + text.length;
    if (!text) return [];
    return [{ id: 'CLAIM-' + hash(turn.id + ':' + turn.answerId + ':' + revision + ':' + start + ':' + end).slice(0, 24), turnId: turn.id, answerId: turn.answerId!, sourceId: 'ANSWER_TURN:' + turn.id + ':' + turn.answerId, revision, start, end, text, status: 'student_claim_unverified' as const, signals: signals.filter(signal => signal.start >= start && signal.end <= end) }];
  });
}

function targetObservation(turn: RecordedTurn): Pick<LedgerTarget, 'fulfillment' | 'observationOrigin'> {
  if (turn.transcriptStatus !== 'finalized' || !turn.answerId) return { fulfillment: 'unknown', observationOrigin: 'not_observed' };
  const metadata = turn.metadata as LedgerMetadata;
  const decision = metadata.coreDecision;
  if (decision?.sourceTurnId === turn.id && decision.sourceAnswerId === turn.answerId && ['met', 'partial', 'unknown'].includes(decision.fulfillment)) return { fulfillment: decision.fulfillment, observationOrigin: 'bound_core_decision' };
  const reaction = metadata.answerReaction;
  if (reaction?.sourceTurnId !== turn.id || reaction.sourceAnswerId !== turn.answerId) return { fulfillment: 'unknown', observationOrigin: 'not_observed' };
  return { fulfillment: reaction.classification === 'relevant' ? 'met' : reaction.classification === 'partial' ? 'partial' : 'unknown', observationOrigin: 'bound_answer_reaction' };
}

/** Intent/source identity supports review; it is not an embedding-based semantic duplicate verdict. */
export function ledgerTargetKey(turn: Pick<RecordedTurn, 'evidenceIds' | 'metadata'>) {
  const blueprint = (turn.metadata as LedgerMetadata).questionBlueprint;
  return blueprint?.target.id ?? 'TARGET-' + hash(JSON.stringify({ evidenceIds: [...turn.evidenceIds].sort(), function: turn.metadata.primaryFunction, intent: turn.metadata.questionIntent.normalize('NFC').replace(/\s+/gu, ' ').trim(), required: turn.metadata.targetEvidence.map(value => value.normalize('NFC').replace(/\s+/gu, ' ').trim()) })).slice(0, 24);
}

/** Reconstructs only actual finalized turns. No source document or book answer can enter this ledger. */
export function buildConversationLedger(session: InterviewSession, options: { rootTurnId?: string; crossClusterLimit?: number } = {}): ConversationLedger {
  const current = session.turns.at(-1);
  const rootId = options.rootTurnId ?? current?.parentMainQuestionId ?? null;
  const root = session.turns.find(turn => turn.id === rootId) ?? current;
  const sameCluster = session.turns.filter(turn => turn.parentMainQuestionId === rootId || turn.id === rootId);
  const evidenceIds = new Set(root?.evidenceIds ?? []), activityIds = new Set(root?.metadata.activityIds ?? []);
  const crossLimit = Math.max(0, Math.min(4, Math.floor(options.crossClusterLimit ?? 2)));
  const relatedPrior = session.turns.filter(turn => turn.parentMainQuestionId !== rootId && turn.id !== rootId && turn.transcriptStatus === 'finalized' && turn.answerId && (turn.evidenceIds.some(id => evidenceIds.has(id)) || turn.metadata.activityIds?.some(id => activityIds.has(id))));
  const crossTurns = crossLimit ? relatedPrior.slice(-crossLimit) : [];
  const chosen = [...crossTurns, ...sameCluster];
  const targets: LedgerTarget[] = sameCluster.map(turn => ({ id: ledgerTargetKey(turn), clusterId: turn.parentMainQuestionId, turnId: turn.id, questionText: turn.questionText, intent: turn.metadata.questionIntent, expectedEvidence: [...turn.metadata.targetEvidence], primaryFunction: turn.metadata.primaryFunction, ...targetObservation(turn), nonEvaluative: turn.questionKind === 'clarification' || turn.metadata.nonEvaluative === true }));
  const targetObservations = new Map<string, LedgerTarget>();
  const meaningCoverage: ConversationLedger['meaningCoverage'] = [];
  for (const [index, observed] of sameCluster.entries()) {
    const localTarget = targets[index];
    const previousTarget = targetObservations.get(localTarget.id);
    const previousObservation = previousTarget ? { ...previousTarget } : undefined;
    // Historical rows remain immutable. Replay observations in order so an old
    // partial answer cannot overwrite a later source-bound completion.
    if (!targetObservations.has(localTarget.id)) targetObservations.set(localTarget.id, { ...localTarget, fulfillment: 'unknown', observationOrigin: 'not_observed' });
    const decision = observed.metadata.coreDecision;
    const interpretation = localTarget.observationOrigin === 'bound_core_decision'
      ? decision?.interpretation as import('./providers/natural-question').DialogueInterpretation | undefined : undefined;
    for (const covered of interpretation?.covered ?? []) {
      const target = targetObservations.get(covered.targetId);
      const source = sameCluster.slice(0, index + 1).find(t => t.transcriptStatus === 'finalized' && t.answerId && t.rawTranscript?.includes(covered.answerQuote));
      if (!target || !source?.answerId || !covered.answerQuote) continue;
      const start = source.rawTranscript!.indexOf(covered.answerQuote);
      // A source-bound quote can cover a PART of one requested meaning. It is
      // not proof of complete fulfillment when that same meaning is unresolved.
      const partialCoverage = interpretation!.unresolved.some(point => point.targetId === covered.targetId);
      target.fulfillment = partialCoverage ? 'partial' : 'met'; target.observationOrigin = 'bound_core_decision';
      meaningCoverage.push({ targetId: covered.targetId, observedAtTurnId: observed.id, sourceTurnId: source.id, answerId: source.answerId, start, end: start + covered.answerQuote.length });
    }
    for (const unresolved of interpretation?.unresolved ?? []) {
      const target = targetObservations.get(unresolved.targetId);
      if (target && (target.fulfillment !== 'met' || interpretation!.corrections.length)) { target.fulfillment = 'partial'; target.observationOrigin = 'bound_core_decision'; }
    }
    // The reviewed decision owns only this question's requested target. Apply
    // it last for this observation, preserving later corrections to OTHER targets.
    // A meta request/replay with no new answer does not erase a known result.
    // Its own historical row still says unknown. Only a source-bound correction
    // with actual words can reopen that already observed requested meaning.
    if (localTarget.observationOrigin !== 'not_observed') {
      const correctedLocalTarget = Boolean(observed.rawTranscript?.trim() && interpretation?.corrections.length && interpretation.unresolved.some(point => point.targetId === localTarget.id));
      if (localTarget.fulfillment !== 'unknown' || !previousObservation || previousObservation.fulfillment === 'unknown') targetObservations.set(localTarget.id, { ...localTarget });
      else if (!correctedLocalTarget) targetObservations.set(localTarget.id, previousObservation);
    }
  }
  const targetStates = [...targetObservations.values()];
  const claims = chosen.flatMap(turnClaims);
  const corrections = claims.flatMap((claim, index) => claim.signals.some(signal => signal.kind === 'correction') ? [{ correctionClaimId: claim.id, earlierClaimIds: claims.slice(0, index).filter(earlier => chosen.find(turn => turn.id === earlier.turnId)?.parentMainQuestionId === chosen.find(turn => turn.id === claim.turnId)?.parentMainQuestionId).slice(-8).map(earlier => earlier.id), status: 'requires_context_review' as const }] : []);
  const rootBlueprint = (root?.metadata as LedgerMetadata | undefined)?.questionBlueprint;
  const answers = chosen.filter(turn => turn.transcriptStatus === 'finalized' && turn.answerId).map(turn => ({ turnId: turn.id, answerId: turn.answerId!, transcriptSha256: hash(turn.rawTranscript ?? ''), rawTranscript: turn.rawTranscript ?? '', observation: turn.rawTranscript?.trim() ? 'final_words' as const : 'no_final_words' as const, sameCluster: sameCluster.includes(turn) }));
  const declinedTargets = sameCluster.flatMap(turn => {
    if (turn.transcriptStatus !== 'finalized' || !turn.answerId) return [];
    const raw = turn.rawTranscript ?? '';
    const silence = !raw.trim() && turn.answerObservation?.classification === 'silence_observed';
    const declined = /^(?:죄송(?:합니다|해요)[,.!\s]*)?(?:잘\s*)?(?:모르겠습니다|모르겠어요|기억(?:이|나지|은)?.{0,8}(?:않습니다|없습니다|안\s*납니다)|답변.{0,8}(?:어렵습니다|못하겠습니다))[.!\s]*$/u.test(raw.trim());
    return silence || declined ? [{ turnId: turn.id, answerId: turn.answerId, targetId: ledgerTargetKey(turn), reason: silence ? 'silence' as const : 'explicit_non_answer' as const }] : [];
  });
  // Runtime sessions spend the F budget on actual delivery, never on a prepared draft.
  // The stored counter preserves legacy records which did not collect presentation events.
  const deliveredFollowUps = deliveredFollowUpCount(session, rootId);
  const followUpsUsed = session.runtime
    ? deliveredFollowUps
    : Math.max(session.followUpCountByMainQuestion?.[rootId ?? ''] ?? 0, sameCluster.filter(turn => turn.questionKind === 'follow_up').length);
  const base: Omit<ConversationLedger, 'contentSha256'> = { version: CONVERSATION_LEDGER_VERSION, rootTurnId: rootId, clusterObjective: rootBlueprint?.clusterObjective ?? (root ? { id: 'CLUSTER-' + hash(root.id).slice(0, 20), description: root.metadata.questionIntent } : null), requestedTargets: targets, establishedTargets: targetStates.filter(target => target.fulfillment === 'met').map(target => target.id), unresolvedTargets: targetStates.filter(target => target.fulfillment !== 'met' && targets.some(original => original.id === target.id && !original.nonEvaluative)).map(target => target.id), claims, answers, correctionCandidates: corrections, declinedTargets, askedTargetKeys: [...new Set(targets.filter(target => !target.nonEvaluative).map(target => target.id))], followUpsUsed, crossClusterTurnIds: crossTurns.map(turn => turn.id), rootRequestedTargetId: root ? ledgerTargetKey(root) : null, currentRequestedTargetId: current ? ledgerTargetKey(current) : null, meaningCoverage, limitations: ['학생의 실제 발화이며 공식 기록·과학적 진실의 확인이 아니다.', '정정 신호와 두 진술의 충돌 가능성은 문맥 검토 대상이며 자동 거짓 판정이 아니다.', '확인된 대상은 진행 판정이며 정식 점수가 아니다.'] };
  return { ...base, contentSha256: hash(JSON.stringify(base)) };
}

/** Persistable diagnostic projection intentionally omits private answer text. */
export function conversationLedgerTrace(ledger: ConversationLedger) {
  return { version: ledger.version, rootTurnId: ledger.rootTurnId, contentSha256: ledger.contentSha256, targetCount: ledger.requestedTargets.length, establishedTargetIds: ledger.establishedTargets, unresolvedTargetIds: ledger.unresolvedTargets, claimRefs: ledger.claims.map(({ id, turnId, answerId, revision, start, end, status }) => ({ id, turnId, answerId, revision, start, end, status })), rootRequestedTargetId: ledger.rootRequestedTargetId, currentRequestedTargetId: ledger.currentRequestedTargetId, meaningCoverage: ledger.meaningCoverage, correctionCount: ledger.correctionCandidates.length, followUpsUsed: ledger.followUpsUsed, crossClusterTurnIds: ledger.crossClusterTurnIds };
}
