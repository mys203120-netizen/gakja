import type { InterviewContext } from '../data/load-interview-context';
import { assertKnowledgeSpan, knowledgeHash, knowledgeSessionQuestionAnswerHash, parseApprovedKnowledgeBundle,
  type DemandKnowledgeBinding } from '../data/approved-knowledge';
import type { InterviewSession, QuestionDraft } from '../protocol';
import { assertQuestionContractIntegrity } from '../question-objective';
import type { EvaluationUnit } from './evaluation-turns';

export interface EvaluationKnowledgeGate {
  scope: DemandKnowledgeBinding['scope'];
  holdReasons: string[];
  bindingSha256: string | null;
  packetSha256s: string[];
  verifiedCoreError: boolean;
  verifiedCoreErrorEvidence: string | null;
  scientificTruthAuthority: 'explicit_reviewed_packet_and_claim' | 'none';
}
const held = (reason: string, binding?: DemandKnowledgeBinding): EvaluationKnowledgeGate => ({ scope: binding?.scope ?? 'unresolved',
  holdReasons: [reason], bindingSha256: binding?.contentSha256 ?? null, packetSha256s: [], verifiedCoreError: false,
  verifiedCoreErrorEvidence: null, scientificTruthAuthority: 'none' });

/** Scope comes exclusively from a reviewed, exact-demand binding. Labels,
 * regexes and the scoring model cannot authorize scientific correctness. */
export function evaluateKnowledgeGate(context: InterviewContext, session: InterviewSession, unit: EvaluationUnit,
  aQuote?: string | null): EvaluationKnowledgeGate {
  if (session.status === 'active') return held('APPROVED_KNOWLEDGE_ENDED_SESSION_REQUIRED');
  if (!context.approvedKnowledge) return held('KNOWLEDGE_SCOPE_APPROVAL_REQUIRED');
  let bundle;
  try { bundle = parseApprovedKnowledgeBundle(context.approvedKnowledge); }
  catch { return held('APPROVED_KNOWLEDGE_REGISTRY_INVALID'); }
  const bindings = bundle.bindings.filter(binding => binding.sessionId === session.id && binding.turnId === unit.turn.id);
  if (!bindings.length) return held('KNOWLEDGE_SCOPE_APPROVAL_REQUIRED');
  if (bindings.length !== 1) return held('APPROVED_KNOWLEDGE_BINDING_CONFLICT');
  const binding = bindings[0], turn = unit.turn;
  if (binding.approval.status !== 'approved') return held('KNOWLEDGE_SCOPE_APPROVAL_REQUIRED', binding);
  const draft: QuestionDraft = { ...turn.metadata, acknowledgement: null, acknowledgementQuote: null,
    questionText: turn.questionText, questionKind: turn.questionKind,
    parentMainQuestionId: turn.questionKind === 'main' ? null : turn.parentMainQuestionId, evidenceIds: [...(turn.evidenceIds ?? [])] };
  try {
    if (!turn.metadata.approvedQuestion || binding.sessionQuestionAnswerSha256 !== knowledgeSessionQuestionAnswerHash(session) ||
      binding.questionSha256 !== knowledgeHash(turn.questionText) || binding.approvedContractSha256 !== turn.metadata.approvedQuestion.contentSha256) {
      return held('APPROVED_KNOWLEDGE_DEMAND_BINDING_CHANGED', binding);
    }
    assertQuestionContractIntegrity(draft, turn.metadata.approvedQuestion);
    assertKnowledgeSpan(turn.questionText, binding.reviewedDemand);
  } catch { return held('APPROVED_KNOWLEDGE_DEMAND_BINDING_CHANGED', binding); }
  if (binding.scope === 'unresolved') return held('KNOWLEDGE_SCOPE_UNRESOLVED', binding);
  if (binding.scope === 'record_consistency_only') {
    if (binding.packetRefs.length || binding.claimReviews.length || binding.claimCoverage !== 'not_applicable') return held('APPROVED_KNOWLEDGE_SCOPE_CONFLICT', binding);
    return { scope: binding.scope, holdReasons: [], bindingSha256: binding.contentSha256, packetSha256s: [],
      verifiedCoreError: false, verifiedCoreErrorEvidence: null, scientificTruthAuthority: 'none' };
  }
  if (!binding.packetRefs.length) return held('APPROVED_KNOWLEDGE_SOURCE_UNAVAILABLE', binding);
  const packets = binding.packetRefs.map(ref => bundle.packets.find(packet => packet.id === ref.id && packet.revision === ref.revision && packet.contentSha256 === ref.contentSha256));
  if (packets.some(packet => !packet || packet.approval.status !== 'approved')) return held('APPROVED_KNOWLEDGE_SOURCE_UNAVAILABLE', binding);
  if (binding.claimCoverage !== 'all_core_claims_reviewed' || !binding.claimReviews.length) return held('APPROVED_KNOWLEDGE_CLAIM_REVIEW_REQUIRED', binding);
  const covered: Array<{ sourceTurnId: string; start: number; end: number; relation: string }> = [];
  for (const claim of binding.claimReviews) {
    const packet = packets.find(item => item!.id === claim.packetId && item!.contentSha256 === claim.packetSha256);
    const attempt = unit.answerAttempts.find(item => item.sourceTurnId === claim.sourceTurnId && item.answerId === claim.answerId);
    if (!packet || packet.sourceSpan.sha256 !== claim.sourceSpanSha256 || !attempt?.finalized || claim.answerSha256 !== knowledgeHash(attempt.rawTranscript)) return held('APPROVED_KNOWLEDGE_CLAIM_BINDING_CHANGED', binding);
    try { assertKnowledgeSpan(attempt.rawTranscript, claim.claim); }
    catch { return held('APPROVED_KNOWLEDGE_CLAIM_BINDING_CHANGED', binding); }
    const assumptionIds = packet.assumptions.map(item => item.id), exclusionIds = packet.excludedScopes.map(item => item.id);
    if (claim.assumptionReviews.length !== assumptionIds.length || claim.assumptionReviews.some(item => !assumptionIds.includes(item.id) || item.satisfied !== true) ||
      claim.excludedScopeReviews.length !== exclusionIds.length || claim.excludedScopeReviews.some(item => !exclusionIds.includes(item.id) || item.applies !== false)) return held('APPROVED_KNOWLEDGE_SCOPE_NOT_ESTABLISHED', binding);
    if (claim.relation === 'unresolved') return held('APPROVED_KNOWLEDGE_CLAIM_UNRESOLVED', binding);
    if (covered.some(prior => prior.sourceTurnId === claim.sourceTurnId && prior.start < claim.claim.end && prior.end > claim.claim.start && prior.relation !== claim.relation)) return held('APPROVED_KNOWLEDGE_CLAIM_CONFLICT', binding);
    covered.push({ sourceTurnId: claim.sourceTurnId, start: claim.claim.start, end: claim.claim.end, relation: claim.relation });
  }
  if (aQuote) {
    const source = unit.answerAttempts.find(attempt => attempt.finalized && attempt.rawTranscript.includes(aQuote));
    const start = source?.rawTranscript.indexOf(aQuote) ?? -1;
    if (!source || !binding.claimReviews.some(claim => claim.sourceTurnId === source.sourceTurnId && claim.answerId === source.answerId &&
      claim.claim.start <= start && claim.claim.end >= start + aQuote.length)) return held('APPROVED_KNOWLEDGE_A_EVIDENCE_UNREVIEWED', binding);
  }
  const coreError = binding.claimReviews.find(claim => claim.relation === 'contradicted' && claim.isCoreToDemand);
  return { scope: binding.scope, holdReasons: [], bindingSha256: binding.contentSha256,
    packetSha256s: packets.map(packet => packet!.contentSha256), verifiedCoreError: Boolean(coreError),
    verifiedCoreErrorEvidence: coreError ? 'reviewed-claim:' + binding.contentSha256 + ':' + coreError.claim.sha256 : null,
    scientificTruthAuthority: 'explicit_reviewed_packet_and_claim' };
}

/** Bounded evaluator input contains only packets authorized for this exact
 * unit; absence is an explicit hold, never an invitation for model knowledge. */
export function evaluationKnowledgeInput(context: InterviewContext, session: InterviewSession, unit: EvaluationUnit) {
  const gate = evaluateKnowledgeGate(context, session, unit);
  const binding = gate.bindingSha256 ? context.approvedKnowledge?.bindings.find(item => item.contentSha256 === gate.bindingSha256) ?? null : null;
  return { ...gate, binding, packets: (context.approvedKnowledge?.packets ?? []).filter(packet => gate.packetSha256s.includes(packet.contentSha256)) };
}
