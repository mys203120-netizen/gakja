import { createHash } from 'node:crypto';
import { actualEvaluativeQuestion, type InterviewSession, type QuestionDraft, type RecordedTurn } from './protocol';
import { assertQuestionContractIntegrity } from './question-objective';
import { buildConversationLedger, ledgerTargetKey } from './conversation-ledger';
import { summarizeSessionLatency } from './session-latency';
import { maskConversationSecrets } from './storage/conversation-log';

export const INTERVIEWER_QUALITY_VERSION = 'observed-interviewer-quality-v2';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const label = (value: unknown) => typeof value === 'string' && /^[a-z0-9_.:-]{1,160}$/iu.test(value) ? value : null;
const measured = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const callCount = (value: unknown): value is number => measured(value) && Number.isSafeInteger(value);
export function syntheticInterviewProvenance(sessionInput: unknown) {
  const verification = object(object(object(sessionInput).metrics).verification);
  const flags = Object.fromEntries(['syntheticTest', 'syntheticProvider', 'syntheticVoice', 'syntheticClientObservation'].filter(key => typeof verification[key] === 'boolean').map(key => [key, verification[key] as boolean]));
  return { syntheticTest: Object.values(flags).some(value => value) ? true : typeof flags.syntheticTest === 'boolean' ? flags.syntheticTest : null, declaredFlags: flags, scenario: label(verification.scenario ?? verification.syntheticScenario) };
}
export function isSyntheticInterviewSession(sessionInput: unknown) { return syntheticInterviewProvenance(sessionInput).syntheticTest === true; }
function metric(numerator: number, denominator: number) { return { count: numerator, observed: denominator, rate: denominator ? numerator / denominator : null }; }
function counts(values: Array<string | null>) { const result: Record<string, number> = {}; for (const value of values) if (value) result[value] = (result[value] ?? 0) + 1; return result; }
function repeatedPrefixes(turns: RecordedTurn[]) {
  const groups = new Map<string, { count: number; turnIds: Array<string | null> }>();
  for (const turn of turns) {
    const prefix = [...turn.questionText.normalize('NFC').replace(/\s+/gu, ' ').trim()].slice(0, 12).join('');
    const fingerprint = hash(prefix).slice(0, 20), previous = groups.get(fingerprint) ?? { count: 0, turnIds: [] };
    previous.count++; previous.turnIds.push(label(turn.id)); groups.set(fingerprint, previous);
  }
  return [...groups].filter(([, group]) => group.count > 1).map(([fingerprint, value]) => ({ fingerprint, ...value }));
}

type AnchorProof = NonNullable<NonNullable<RecordedTurn['metadata']['questionRealization']>['anchorProof']>[number];
/** Identity formats are versioned; neither format replaces source/hash/range checks below. */
function anchorIdentityMatches(turn: RecordedTurn, proof: AnchorProof, turns: RecordedTurn[]) {
  const realization = turn.metadata.questionRealization!;
  if (realization.policyVersion !== 'answer-grounded-question-v3') {
    return proof.anchorId === 'QA-' + hash(proof.sourceId + ':' + proof.sourceSha256 + ':' + proof.sourceStartOffset + ':' + proof.sourceEndOffset).slice(0, 20);
  }
  const root = turns.find(candidate => candidate.id === turn.parentMainQuestionId);
  const target = turn.metadata.targetEvidence[0];
  if (!root || root.questionKind !== 'main' || !target || turn.metadata.targetEvidence.length !== 1 || realization.anchorProof?.length !== 1 || realization.anchorMode !== 'none' || realization.semanticReview !== 'independently_reviewed') return false;
  const expected = 'PROBE-' + hash(root.id + ':' + target.normalize('NFC').replace(/\s+/gu, '')).slice(0, 24);
  if (proof.anchorId !== expected || realization.anchorId !== expected) return false;
  if (turn.questionKind === 'follow_up') {
    if (realization.semanticObjectiveId !== expected) return false;
    const currentAnswer = turns.find(candidate => candidate.id === turn.metadata.answerTurnId);
    if (!currentAnswer?.answerId || currentAnswer.id !== turn.metadata.parentQuestionId || proof.sourceId !== `ANSWER_TURN:${currentAnswer.id}:${currentAnswer.answerId}`) return false;
    const blueprint = turn.metadata.approvedQuestion?.blueprint ?? turn.metadata.questionBlueprint;
    return !blueprint || blueprint.anchorRefs.some(ref => ref.kind === 'ANSWER_TURN' && ref.sourceId === proof.sourceId && ref.revision === proof.sourceSha256 && ref.start === proof.sourceStartOffset && ref.end === proof.sourceEndOffset);
  }
  if (turn.questionKind !== 'clarification') return false;
  const original = actualEvaluativeQuestion({ turns }, turn);
  if (!original || original.parentMainQuestionId !== turn.parentMainQuestionId || JSON.stringify(original.metadata.targetEvidence) !== JSON.stringify(turn.metadata.targetEvidence) || original.metadata.questionIntent !== turn.metadata.questionIntent || original.metadata.primaryFunction !== turn.metadata.primaryFunction || original.metadata.depth !== turn.metadata.depth) return false;
  // Exact audio replay retains the original semantic ID; meaning rephrases bind
  // to the original requested target rather than inventing a new F objective.
  return turn.metadata.clarificationMode === 'repeat_audio'
    ? turn.questionText === original.questionText && realization.semanticObjectiveId === original.metadata.questionRealization?.semanticObjectiveId
    : realization.semanticObjectiveId === ledgerTargetKey(original);
}

/** Stored observations only. These metrics are not a professional rating, score, or new semantic evaluation. */
export function buildInterviewerQuality(sessionInput: unknown, eventsInput: readonly unknown[] = [], options: { malformedLogLines?: number } = {}) {
  const raw = object(sessionInput);
  const turns = array(raw.turns).filter(value => typeof object(value).questionText === 'string' && typeof object(value).id === 'string' && object(value).metadata && Array.isArray(object(value).evidenceIds)).map(value => {
    const row = object(value), metadata = object(row.metadata);
    return { ...row, metadata: { ...metadata, questionIntent: typeof metadata.questionIntent === 'string' ? metadata.questionIntent : '', targetEvidence: array(metadata.targetEvidence).filter((item): item is string => typeof item === 'string'), activityIds: array(metadata.activityIds).filter((item): item is string => typeof item === 'string') } } as unknown as RecordedTurn;
  });
  const events = eventsInput.map(object).filter(event => event.sessionId === raw.id);
  const validTurns = new Map(turns.map((turn, index) => [turn.id, { turn, index }]));
  const issues: Array<{ code: string; turnId: string | null }> = [];
  let contractsObserved = 0, legacyContractUnobserved = 0, anchorProofObserved = 0;
  const repeatedObjectives = new Map<string, string[]>();
  for (const [index, turn] of turns.entries()) {
    const metadata = turn.metadata, realization = metadata.questionRealization;
    const root = validTurns.get(turn.parentMainQuestionId);
    if (turn.questionKind !== 'main' && (!root || root.index >= index || root.turn.questionKind !== 'main')) issues.push({ code: 'PARENT_ROOT_INVALID', turnId: label(turn.id) });
    if (metadata.parentQuestionId) {
      const parent = validTurns.get(metadata.parentQuestionId);
      if (!parent || parent.index >= index || parent.turn.parentMainQuestionId !== turn.parentMainQuestionId) issues.push({ code: 'PARENT_QUESTION_INVALID', turnId: label(turn.id) });
    } else if (realization && turn.questionKind === 'follow_up') issues.push({ code: 'PARENT_QUESTION_UNOBSERVED', turnId: label(turn.id) });
    if (metadata.approvedQuestion) {
      contractsObserved++;
      try {
        const draft = { ...metadata, acknowledgement: null, acknowledgementQuote: null, questionText: turn.questionText, questionKind: turn.questionKind, parentMainQuestionId: turn.questionKind === 'main' ? null : turn.parentMainQuestionId, evidenceIds: turn.evidenceIds } as QuestionDraft;
        assertQuestionContractIntegrity(draft, metadata.approvedQuestion);
        const blueprint = metadata.approvedQuestion.blueprint;
        if (blueprint.questionId !== turn.id || blueprint.clusterId !== turn.parentMainQuestionId || blueprint.parentQuestionId !== (metadata.parentQuestionId ?? null) || blueprint.answerTurnId !== (metadata.answerTurnId ?? null)) issues.push({ code: 'CONTRACT_TURN_BINDING_INVALID', turnId: label(turn.id) });
      } catch { issues.push({ code: 'CONTRACT_INTEGRITY_INVALID', turnId: label(turn.id) }); }
    } else if (realization) issues.push({ code: 'IR_CONTRACT_MISSING', turnId: label(turn.id) });
    else legacyContractUnobserved++;
    if (realization?.policyVersion === 'answer-grounded-question-v3' && !realization.anchorProof?.length) issues.push({ code: 'INTERNAL_ANSWER_PROOF_INVALID', turnId: label(turn.id) });
    for (const proof of realization?.anchorProof ?? []) {
      anchorProofObserved++;
      const earlier = turns.find((candidate, candidateIndex) => candidateIndex < index && proof.sourceId === 'ANSWER_TURN:' + candidate.id + ':' + candidate.answerId);
      const spokenOffsets = proof.questionStartOffset === null && proof.questionEndOffset === null || typeof proof.questionStartOffset === 'number' && typeof proof.questionEndOffset === 'number' && Number.isSafeInteger(proof.questionStartOffset) && Number.isSafeInteger(proof.questionEndOffset) && proof.questionStartOffset >= 0 && proof.questionEndOffset <= turn.questionText.length && proof.questionEndOffset > proof.questionStartOffset && turn.questionText.slice(proof.questionStartOffset, proof.questionEndOffset) === earlier?.rawTranscript?.slice(proof.sourceStartOffset, proof.sourceEndOffset);
      if (!earlier || earlier.parentMainQuestionId !== turn.parentMainQuestionId || earlier.transcriptStatus !== 'finalized' || typeof earlier.rawTranscript !== 'string' || proof.sourceSha256 !== hash(earlier.rawTranscript) || !Number.isSafeInteger(proof.sourceStartOffset) || !Number.isSafeInteger(proof.sourceEndOffset) || proof.sourceStartOffset < 0 || proof.sourceEndOffset > earlier.rawTranscript.length || proof.sourceEndOffset <= proof.sourceStartOffset || !anchorIdentityMatches(turn, proof, turns) || !spokenOffsets) issues.push({ code: 'INTERNAL_ANSWER_PROOF_INVALID', turnId: label(turn.id) });
    }
    if (realization?.semanticObjectiveId && turn.questionKind === 'follow_up' && metadata.nonEvaluative !== true) {
      const key = turn.parentMainQuestionId + ':' + realization.semanticObjectiveId;
      const observed = repeatedObjectives.get(key) ?? []; observed.push(turn.id); repeatedObjectives.set(key, observed);
    }
  }
  const decisionRows = turns.flatMap(turn => {
    const decision = object(turn.metadata.coreDecision);
    if (turn.transcriptStatus !== 'finalized' || !turn.answerId || decision.sourceTurnId !== turn.id || decision.sourceAnswerId !== turn.answerId) return [];
    return [{ turn, decision }];
  });
  const decisions = decisionRows.map(({ decision }) => decision);
  const met = decisions.filter(decision => decision.fulfillment === 'met');
  const actualAction = (decision: Row) => decision.nextAction === 'CLOSING' ? 'CLOSING' : decision.actualDirective === 'next_main' ? 'TRANSITION' : typeof decision.actualDirective === 'string' && decision.actualDirective.startsWith('follow_up') ? 'FOLLOW_UP' : decision.actualDirective === 'clarification_same_target' ? 'CLARIFICATION' : label(decision.nextAction);
  const requestedAction = (decision: Row) => label(decision.requestedAction ?? decision.nextAction);
  const transitions = decisions.filter(decision => actualAction(decision) === 'TRANSITION');
  const unresolvedTransitions = transitions.filter(decision => decision.fulfillment === 'partial' || decision.fulfillment === 'unknown');
  const reason = (decision: Row) => label(decision.decisionReasonCode ?? decision.transitionReasonCode ?? decision.reasonCode);
  const providers = decisions.map(decision => object(decision.providerTimings));
  const observedCalls = providers.map(provider => provider.coreModelCalls).filter(callCount);
  const observedCoreMs = providers.map(provider => provider.coreMs).filter(measured);
  // Prepared-turn timings describe the previous answer's work and can duplicate its core-decision timing.
  // Only sessions with no bound decision records use the explicitly separate legacy snapshot counter.
  const legacyTimings = decisionRows.length ? [] : turns.map(turn => object(turn.metadata.providerTimings));
  const legacyCalls = legacyTimings.map(timing => timing.coreModelCalls).filter(callCount);
  const playbackIds = new Set(array(raw.questionPresentations).filter(value => measured(object(value).startedAtMs)).map(value => label(object(value).turnId)).filter(Boolean));
  const presented = turns.filter(turn => playbackIds.has(turn.id));
  const validMode = (turn: RecordedTurn) => ['none', 'short_context', 'exact_quote'].includes(turn.metadata.questionRealization?.anchorMode ?? '');
  const modes = (selected: RecordedTurn[]) => ({ observed: selected.filter(validMode).length, byMode: counts(selected.filter(validMode).map(turn => label(turn.metadata.questionRealization?.anchorMode))), unobserved: selected.filter(turn => !turn.metadata.questionRealization).length, invalidModeCount: selected.filter(turn => turn.metadata.questionRealization && !validMode(turn)).length });
  const session = { ...raw, turns, followUpCountByMainQuestion: object(raw.followUpCountByMainQuestion), metrics: raw.metrics } as unknown as InterviewSession;
  const ledger = buildConversationLedger(session);
  const clusterMemories = turns.filter(turn => turn.questionKind === 'main').map(turn => {
    const state = buildConversationLedger(session, { rootTurnId: turn.id, crossClusterLimit: 0 });
    return { rootTurnId: label(turn.id), requestedTargets: state.requestedTargets.length, establishedTargets: state.establishedTargets.length, unresolvedTargets: state.unresolvedTargets.length, followUpsUsed: state.followUpsUsed };
  });
  const verification = syntheticInterviewProvenance(raw);
  const duplicateObjectiveGroups = [...repeatedObjectives].filter(([, turnIds]) => turnIds.length > 1).map(([fingerprintInput, turnIds]) => ({ fingerprint: hash(fingerprintInput).slice(0, 20), occurrences: turnIds.length, turnIds: turnIds.map(label) }));
  const report = {
    version: INTERVIEWER_QUALITY_VERSION, localOnly: true, providerCalls: 0, includesOriginalText: false,
    session: { id: label(raw.id), syntheticTest: verification.syntheticTest, verificationFlags: verification.declaredFlags, scenario: verification.scenario, turns: turns.length, finalizedAnswers: turns.filter(turn => turn.transcriptStatus === 'finalized').length, actualQuestionStarts: presented.length, playbackObservationAvailable: Array.isArray(raw.questionPresentations) },
    decisions: { observed: decisions.length, unobservedFinalizedAnswers: turns.filter(turn => turn.transcriptStatus === 'finalized').length - decisions.length, actions: counts(decisions.map(actualAction)), requestedActions: counts(decisions.map(requestedAction)), requestedActualActionMismatchCount: decisions.filter(decision => requestedAction(decision) && requestedAction(decision) !== actualAction(decision)).length, fulfillment: counts(decisions.map(decision => label(decision.fulfillment))), metToFollowUp: metric(met.filter(decision => actualAction(decision) === 'FOLLOW_UP').length, met.length), partialToTransition: metric(decisions.filter(decision => decision.fulfillment === 'partial' && actualAction(decision) === 'TRANSITION').length, decisions.filter(decision => decision.fulfillment === 'partial').length), transitionReasons: { ...metric(transitions.filter(decision => reason(decision)).length, transitions.length), byReason: counts(transitions.map(reason)) }, unresolvedTransitions: { count: unresolvedTransitions.length, reasonCoverage: metric(unresolvedTransitions.filter(decision => reason(decision)).length, unresolvedTransitions.length) }, failures: counts(decisions.map(decision => label(decision.failureCode))), fallbackCount: decisions.filter(decision => decision.origin === 'fallback').length },
    questions: { repeatedSemanticObjectivesWithinCluster: duplicateObjectiveGroups, preparedAnchorModes: modes(turns), observedSpokenAnchorModes: presented.length ? modes(presented) : null, repeatedSpokenPrefixFingerprints: presented.length ? repeatedPrefixes(presented) : null, preparedTemplateFamilies: counts(turns.map(turn => label(turn.metadata.questionRealization?.family))), note: '같은 semanticObjectiveId 반복은 서버 식별자 중복이다. 표현·의미의 전체 중복률이나 불필요한 꼬리질문의 판정은 아니다.' },
    integrity: { contractsObserved, legacyContractUnobserved, internalAnchorProofsObserved: anchorProofObserved, issues, issueCounts: counts(issues.map(issue => issue.code)), note: '저장된 계약과 답변 출처를 검사한다. PDF 원문 재추출 또는 독립 의미 검수는 이 분석에 포함되지 않는다.' },
    memory: { rootTurnId: label(ledger.rootTurnId), requestedTargets: ledger.requestedTargets.length, establishedTargets: ledger.establishedTargets.length, unresolvedTargets: ledger.unresolvedTargets.length, correctionCandidates: ledger.correctionCandidates.length, followUpsUsed: ledger.followUpsUsed, crossClusterTurns: ledger.crossClusterTurnIds.length, clusters: clusterMemories },
    runtimeModelCalls: { scope: 'bound_final_turn_snapshot_observations', boundDecisionSamples: observedCalls.length, boundDecisionTotal: observedCalls.length ? observedCalls.reduce((sum, value) => sum + value, 0) : null, observedCoreDurationSamples: observedCoreMs.length, observedCoreDurationTotalMs: observedCoreMs.length ? observedCoreMs.reduce((sum, value) => sum + value, 0) : null, legacyTurnTimingSamples: legacyCalls.length, legacyTurnTimingTotal: legacyCalls.length ? legacyCalls.reduce((sum, value) => sum + value, 0) : null, perDecisionAboveOne: observedCalls.filter(value => value > 1).length, note: '묶인 최종 코어 판단을 우선하며 다음 질문의 준비 시간에 복사된 동일 호출을 다시 더하지 않는다. 과거 snapshot 합계는 별도 관찰이다. 저장되지 않은 재시도까지 포함한 공급자 청구 요청 수는 추정하지 않는다.' },
    latency: summarizeSessionLatency(session),
    log: { observedEvents: events.length, byType: counts(events.map(event => label(event.type))), malformedLines: options.malformedLogLines ?? 0 },
    interpretation: ['집계는 저장된 관찰과 구조 검증이며 사람 면접관의 전문적 품질 점수가 아니다.', '충족 후 F가 있었다는 사실만으로 적절함·부적절함을 판정하지 않는다.', '미관찰 비율·지연·호출 수는 null이며 실제 재생을 준비된 질문에서 추정하지 않는다.', '접두어는 원문이 아닌 해시로만 표시한다.'],
  };
  return maskConversationSecrets(report) as typeof report;
}
