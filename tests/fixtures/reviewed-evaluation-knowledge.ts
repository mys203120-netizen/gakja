import type { InterviewContext } from '../../server/data/load-interview-context';
import { APPROVED_KNOWLEDGE_VERSION, knowledgeHash, knowledgeSessionQuestionAnswerHash,
  parseApprovedKnowledgeBundle, type ApprovedKnowledgePacket, type DemandKnowledgeBinding } from '../../server/data/approved-knowledge';
import type { InterviewSession, QuestionDraft, RecordedTurn } from '../../server/protocol';
import { approveQuestionContract, QUESTION_OBJECTIVE_VERSION, type QuestionBlueprint } from '../../server/question-objective';
import { buildEvaluationUnits } from '../../server/providers/evaluation-turns';

export const syntheticKnowledgeApproval = { status: 'approved' as const, authority: 'explicit_reviewed_input' as const,
  approverId: 'explicit-synthetic-scope-reviewer', reviewedAt: '2026-11-05T00:00:00.000Z' };
export const sealKnowledge = <T extends object>(body: T) => ({ ...body, contentSha256: knowledgeHash(JSON.stringify(body)) });
export const knowledgeSpan = (text: string, start = 0, end = text.length) => ({ start, end, quote: text.slice(start, end), sha256: knowledgeHash(text.slice(start, end)) });
export const reviewedKnowledgeBundle = (packets: ApprovedKnowledgePacket[], bindings: DemandKnowledgeBinding[]) =>
  parseApprovedKnowledgeBundle(sealKnowledge({ version: APPROVED_KNOWLEDGE_VERSION, packets, bindings }));

export function recordScopeBinding(session: InterviewSession, turn: RecordedTurn): DemandKnowledgeBinding {
  return sealKnowledge({ version: APPROVED_KNOWLEDGE_VERSION, id: 'synthetic-scope-' + turn.id, approval: syntheticKnowledgeApproval,
    sessionId: session.id, sessionQuestionAnswerSha256: knowledgeSessionQuestionAnswerHash(session), turnId: turn.id,
    questionSha256: knowledgeHash(turn.questionText), approvedContractSha256: turn.metadata.approvedQuestion!.contentSha256,
    reviewedDemand: knowledgeSpan(turn.questionText), scope: 'record_consistency_only' as const, claimCoverage: 'not_applicable' as const,
    packetRefs: [], claimReviews: [], reason: '명시적인 합성 회귀 입력: 이 요구의 A는 실제 수행 기록·답변의 일관성만 평가한다.' });
}

/** Explicit test approvals on a clone. This is never a production fallback for
 * an unreviewed question, an absent scope binding or scientific knowledge. */
export function reviewedRecordEvaluationFixture(context: InterviewContext, source: InterviewSession) {
  const session = structuredClone(source), copiedContext = structuredClone(context);
  session.status ??= 'ending';
  for (const turn of session.turns) {
    turn.evidenceIds ??= [];
    if (turn.questionKind === 'clarification' || turn.metadata.approvedQuestion || !turn.metadata.questionIntent || turn.metadata.targetEvidence?.length !== 1) continue;
    const draft: QuestionDraft = { ...turn.metadata, acknowledgement: null, acknowledgementQuote: null, questionText: turn.questionText,
      questionKind: turn.questionKind, parentMainQuestionId: turn.questionKind === 'main' ? null : turn.parentMainQuestionId,
      evidenceIds: [...(turn.evidenceIds ?? [])], evidenceQuotes: [], groundingRationale: '명시적인 합성 회귀 질문 승인',
      validationStatus: 'approved', validationFailures: [], premiseValidation: { version: 'question-premise-v1', guidelineVersion: '2.3',
        status: 'approved', method: 'bounded_semantic_review', reviewModel: 'explicit-synthetic-question-reviewer',
        questionSha256: knowledgeHash(turn.questionText), coreIntentCount: 1, supportedPremises: [],
        openChecks: [{ questionStartOffset: 0, questionEndOffset: turn.questionText.length, kind: 'open_check' }] } };
    const blueprint: QuestionBlueprint = { version: QUESTION_OBJECTIVE_VERSION, id: 'SYNTHETIC-BLUEPRINT-' + turn.id,
      questionId: turn.id, clusterId: turn.parentMainQuestionId, clusterObjective: { id: turn.parentMainQuestionId, description: draft.questionIntent },
      parentQuestionId: turn.questionKind === 'main' ? null : turn.parentMainQuestionId, answerTurnId: null,
      questionIntent: draft.questionIntent, grounding: { kind: 'STUDENT_EVIDENCE' }, anchorRefs: [],
      target: { id: 'synthetic-target-' + turn.id, description: draft.targetEvidence[0], unresolvedReason: '합성 검토자가 명시적으로 선택한 실제 요구' },
      primaryFunction: draft.primaryFunction, depth: draft.depth, expectedEvidence: [...draft.targetEvidence],
      expansionRationale: null, subordinationRationale: null, criterionLinks: [], strategyIds: [] };
    draft.questionBlueprint = blueprint;
    Object.assign(turn.metadata, { evidenceQuotes: [], validationStatus: 'approved', validationFailures: [],
      premiseValidation: draft.premiseValidation, questionBlueprint: blueprint, approvedQuestion: approveQuestionContract(draft, blueprint) });
  }
  copiedContext.approvedKnowledge = reviewedKnowledgeBundle([], buildEvaluationUnits(session).scoredUnits
    .filter(unit => Boolean(unit.turn.metadata.approvedQuestion)).map(unit => recordScopeBinding(session, unit.turn)));
  return { context: copiedContext, session };
}
