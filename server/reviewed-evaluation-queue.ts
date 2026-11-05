/** Provider-free preparation of a separately reviewed evaluation job. HTTP
 * supply/read paths must not import the worker's live evaluation provider. */
import type { InterviewContext } from './data/load-interview-context';
import type { InterviewSession } from './protocol';
import { createLocalEvaluationJobStore } from './evaluation-job-store';
import type { EvaluationRepository } from './repositories/evaluation-job-ports';
import { createLocalSessionStore } from './storage/local-session-store';
import type { SessionStore } from './storage/session-store';
import { EVALUATION_PIPELINE_VERSION, evaluationSessionSourceFingerprint } from './providers/evaluation-input';
import { parseApprovedKnowledgeBundle } from './data/approved-knowledge';
import { parseBankScopeRegistry } from './data/evaluation-scope-registry';
import { snapshotHash } from './session-runtime';

/** Derivation authority is the original session's stored context, never a
 * caller-supplied base hash. Only reviewed knowledge and its provenance vary. */
function assertReviewedKnowledgeDerivation(context: InterviewContext, base: InterviewContext) {
  const bundle = parseApprovedKnowledgeBundle(context.approvedKnowledge);
  const provenance = context.manifest.files.filter(file => file.role === 'approvedEvaluationKnowledge');
  if (provenance.length > 1 || provenance.some(file => Object.keys(file).sort().join(',') !== 'path,role,sha256' ||
    typeof file.path !== 'string' || !file.path.trim() || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256))) throw new Error('APPROVED_KNOWLEDGE_CONTEXT_DERIVATION_INVALID');
  const declared = context.manifest.recordIds.approvedEvaluationKnowledgeSha256;
  if (declared !== undefined && declared !== bundle.contentSha256) throw new Error('APPROVED_KNOWLEDGE_CONTEXT_DERIVATION_INVALID');
  if (context.evaluationScopeRegistry?.contentSha256 !== base.evaluationScopeRegistry?.contentSha256 &&
    (!context.manifest.recordIds.sessionReviewReceiptSha256 || !context.evaluationScopeRegistry ||
      parseBankScopeRegistry(context.evaluationScopeRegistry).contentSha256 !== context.manifest.recordIds.evaluationSpecRegistrySha256)) throw new Error('APPROVED_KNOWLEDGE_CONTEXT_DERIVATION_INVALID');
  const withoutKnowledge = (source: InterviewContext) => {
    const copy = structuredClone(source);
    delete copy.approvedKnowledge;
    delete copy.evaluationScopeRegistry;
    copy.manifest.files = copy.manifest.files.filter(file => file.role !== 'approvedEvaluationKnowledge');
    delete copy.manifest.recordIds.approvedEvaluationKnowledgeSha256;
    delete copy.manifest.recordIds.sessionReviewReceiptSha256;
    delete copy.manifest.recordIds.evaluationSpecRegistrySha256;
    return copy;
  };
  if (snapshotHash(withoutKnowledge(context)) !== snapshotHash(withoutKnowledge(base))) throw new Error('APPROVED_KNOWLEDGE_BASE_CONTEXT_CHANGED');
}

/** Re-evaluate an ended snapshot under an explicitly reviewed knowledge context.
 * Save a new context/job only; never rewrite the historical runtime context,
 * session, question contract, transcript or already stored evaluation result. */
export async function enqueueReviewedKnowledgeEvaluation(context: InterviewContext, original: InterviewSession,
  options: { jobs?: EvaluationRepository; sessions?: SessionStore; model?: string; now?: number } = {}) {
  if (!original.runtime || original.status === 'active' || !context.approvedKnowledge) throw new Error('APPROVED_KNOWLEDGE_ENDED_CONTEXT_REQUIRED');
  parseApprovedKnowledgeBundle(context.approvedKnowledge);
  if (context.manifest.rulesVersion !== original.runtime.engineVersion) throw new Error('EVALUATION_CONTEXT_VERSION_CHANGED');
  const sessions = options.sessions ?? createLocalSessionStore();
  const base = await sessions.loadContext(original.runtime.contextSnapshotSha256, original.runtime.owner.id);
  assertReviewedKnowledgeDerivation(context, base);
  const session = structuredClone(original), model = options.model || process.env.OPENAI_ANALYSIS_MODEL || 'gpt-6.1-terra';
  const contextSnapshotSha256 = await sessions.saveContext(context, original.runtime.owner.id);
  session.runtime!.contextSnapshotSha256 = contextSnapshotSha256;
  const sourceSha256 = evaluationSessionSourceFingerprint(context, session, model);
  const job = await (options.jobs ?? createLocalEvaluationJobStore()).enqueue(session, sourceSha256, EVALUATION_PIPELINE_VERSION, options.now ?? Date.now(), model);
  return { job, contextSnapshotSha256, sourceSha256, originalContextSnapshotSha256: original.runtime.contextSnapshotSha256 };
}
