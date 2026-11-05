import type { InterviewContext } from './load-interview-context';
import type { InterviewSession } from '../protocol';
import { freezeKnowledge, parseApprovedKnowledgeBundle, type ApprovedKnowledgeBundle } from './approved-knowledge';
import { snapshotHash } from '../session-runtime';
import { buildEvaluationUnits } from '../providers/evaluation-turns';
import { evaluateKnowledgeGate } from '../providers/evaluation-knowledge-gate';
import { parseBankScopeRegistry, type QuestionEvaluationSpecRegistry } from './evaluation-scope-registry';

/** Preserves the interview context; authentication belongs to the supply
 * service, while this existing pure adapter validates exact reviewed bindings. */
export function createReviewedEvaluationKnowledgeContext(context: InterviewContext, session: InterviewSession,
  input: ApprovedKnowledgeBundle, provenance: { path: string; fileSha256: string; sessionReviewReceiptSha256?: string; evaluationSpecRegistrySha256?: string; evaluationSpecRegistry?: QuestionEvaluationSpecRegistry }) {
  if (session.status === 'active') throw new Error('APPROVED_KNOWLEDGE_SESSION_NOT_ENDED');
  if (!session.runtime || snapshotHash(context) !== session.runtime.contextSnapshotSha256) throw new Error('APPROVED_KNOWLEDGE_BASE_CONTEXT_CHANGED');
  const bundle = parseApprovedKnowledgeBundle(input), evaluationContext = structuredClone(context);
  evaluationContext.approvedKnowledge = bundle;
  if (provenance.evaluationSpecRegistry) evaluationContext.evaluationScopeRegistry = parseBankScopeRegistry(provenance.evaluationSpecRegistry);
  if (evaluationContext.manifest) {
    evaluationContext.manifest.files = [...evaluationContext.manifest.files.filter(file => file.role !== 'approvedEvaluationKnowledge'),
      { role: 'approvedEvaluationKnowledge', ...provenance, sha256: provenance.fileSha256 }].map(({ role, path, sha256 }) => ({ role, path, sha256 }));
    evaluationContext.manifest.recordIds = { ...evaluationContext.manifest.recordIds, approvedEvaluationKnowledgeSha256: bundle.contentSha256 };
    if (provenance.sessionReviewReceiptSha256) evaluationContext.manifest.recordIds.sessionReviewReceiptSha256 = provenance.sessionReviewReceiptSha256;
    if (provenance.evaluationSpecRegistrySha256) evaluationContext.manifest.recordIds.evaluationSpecRegistrySha256 = provenance.evaluationSpecRegistrySha256;
  }
  const decisions = buildEvaluationUnits(session).scoredUnits.map(unit => ({ turnId: unit.turn.id, ...evaluateKnowledgeGate(evaluationContext, session, unit) }));
  const invalid = decisions.find(decision => decision.holdReasons.some(reason => /INVALID|CHANGED|CONFLICT/u.test(reason)));
  if (invalid) throw new Error('APPROVED_KNOWLEDGE_REVIEW_BINDING_INVALID:' + invalid.turnId + ':' + invalid.holdReasons.join(','));
  return { context: freezeKnowledge(evaluationContext), decisions };
}
