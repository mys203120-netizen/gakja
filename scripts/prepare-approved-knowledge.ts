import { assertLocalInternalExecution } from '../server/internal-execution';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { knowledgeHash, parseApprovedKnowledgeBundle } from '../server/data/approved-knowledge';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { InterviewSession } from '../server/protocol';
import { EVALUATION_PIPELINE_VERSION, evaluationSessionSourceFingerprint } from '../server/providers/evaluation-input';
import { createReviewedEvaluationKnowledgeContext } from '../server/data/reviewed-evaluation-context';
import { supplyReviewedSessionEvaluation, type EndedSessionReviewProposal } from '../server/evaluation-supply';
export { createReviewedEvaluationKnowledgeContext } from '../server/data/reviewed-evaluation-context';
import type { ReviewRepository } from '../server/repositories/review-ports';
import { createLocalReviewRepository } from '../server/repositories/local-review-repository';

const value = (args: string[], flag: string) => {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('APPROVED_KNOWLEDGE_ARGUMENT_MISSING:' + flag);
  return args[index + 1];
};
function validateArguments(args: string[]) {
  const valued = new Set(['--reviewed-input', '--reviewer', '--session-input', '--context-input', '--model', '--proposal-input', '--receipt']), seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error('APPROVED_KNOWLEDGE_ARGUMENT_DUPLICATED:' + flag);
    seen.add(flag);
    if (flag === '--enqueue') continue;
    if (!valued.has(flag)) throw new Error('APPROVED_KNOWLEDGE_ARGUMENT_UNKNOWN:' + flag);
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('APPROVED_KNOWLEDGE_ARGUMENT_MISSING:' + flag);
    index++;
  }
}

export async function prepareApprovedKnowledgeCli(args: string[], root = process.cwd(), reviews: ReviewRepository = createLocalReviewRepository(root)) {
  assertLocalInternalExecution();
  validateArguments(args);
  const inputPath = value(args, '--reviewed-input'), reviewer = value(args, '--reviewer');
  if (!inputPath || !reviewer) throw new Error('APPROVED_KNOWLEDGE_REVIEWED_INPUT_AND_REVIEWER_REQUIRED');
  const bundle = parseApprovedKnowledgeBundle(JSON.parse(await readFile(resolve(root, inputPath), 'utf8')));
  if ([...bundle.packets, ...bundle.bindings].some(item => item.approval.status !== 'approved' || item.approval.approverId !== reviewer)) {
    throw new Error('APPROVED_KNOWLEDGE_INPUT_AUTHORITY_MISMATCH');
  }
  const sessionInput = value(args, '--session-input'), contextInput = value(args, '--context-input');
  const model = value(args, '--model') || process.env.OPENAI_ANALYSIS_MODEL || 'gpt-6.1-terra';
  if (Boolean(sessionInput) !== Boolean(contextInput) || bundle.bindings.length && !sessionInput) throw new Error('APPROVED_KNOWLEDGE_ENDED_SESSION_AND_CONTEXT_REQUIRED');
  if (args.includes('--enqueue')) {
    const proposalPath = value(args, '--proposal-input'), receiptPath = value(args, '--receipt');
    if (!sessionInput || !contextInput || !proposalPath || !receiptPath) throw new Error('AUTHENTICATED_SESSION_REVIEW_RECEIPT_REQUIRED');
    const rawSession = JSON.parse(await readFile(resolve(root, sessionInput), 'utf8')), rawContext = JSON.parse(await readFile(resolve(root, contextInput), 'utf8'));
    const supplied = await supplyReviewedSessionEvaluation({ session: rawSession.session ?? rawSession, context: rawContext.context ?? rawContext, bundle,
      proposal: JSON.parse(await readFile(resolve(root, proposalPath), 'utf8')) as EndedSessionReviewProposal,
      receipt: JSON.parse(await readFile(resolve(root, receiptPath), 'utf8')), root, enqueue: true, model, reviews });
    return { ...supplied, context: undefined, evaluationJobId: supplied.jobId, authority: 'authenticated_exact_session_review', reviewer };
  }
  const content = JSON.stringify(bundle, null, 2), fileSha256 = knowledgeHash(content);
  const path = reviews.knowledgeRevisionPath(bundle.contentSha256);
  let evaluation = null;
  if (sessionInput && contextInput) {
    const rawSession = JSON.parse(await readFile(resolve(root, sessionInput), 'utf8'));
    const rawContext = JSON.parse(await readFile(resolve(root, contextInput), 'utf8'));
    const session = (rawSession.session ?? rawSession) as InterviewSession, context = (rawContext.context ?? rawContext) as InterviewContext;
    if (!session.id || !Array.isArray(session.turns) || !context.school || !context.manifest || !['ending', 'completed'].includes(session.status)) throw new Error('APPROVED_KNOWLEDGE_ENDED_INPUT_INVALID');
    if (bundle.bindings.some(binding => binding.sessionId !== session.id)) throw new Error('APPROVED_KNOWLEDGE_SESSION_BINDING_MISMATCH');
    const projection = createReviewedEvaluationKnowledgeContext(context, session, bundle, { path, fileSha256 });
    const contextSha256 = knowledgeHash(JSON.stringify(projection.context));
    const envelope = { version: 'approved-evaluation-context-v1', pipelineVersion: EVALUATION_PIPELINE_VERSION, model,
      originalContextSha256: knowledgeHash(JSON.stringify(context)), sessionId: session.id,
      knowledgeContentSha256: bundle.contentSha256, contextSha256,
      sourceSha256: evaluationSessionSourceFingerprint(projection.context, session, model), context: projection.context };
    evaluation = { path: reviews.evaluationContextPath(contextSha256),
      envelope, session, decisions: projection.decisions };
  }
  // Validate every review and binding before publishing any output.
  if (args.includes('--enqueue') && !evaluation) throw new Error('APPROVED_KNOWLEDGE_ENDED_SESSION_AND_CONTEXT_REQUIRED');
  await reviews.writeKnowledgeRevision(bundle.contentSha256, content, { encoding: 'utf8' });
  if (evaluation) await reviews.writeEvaluationContext(evaluation.envelope.contextSha256, JSON.stringify(evaluation.envelope, null, 2), { encoding: 'utf8' });
  return { passed: true, providerCalls: 0, sourceAuthenticityIndependentlyVerified: false, scientificTruthIndependentlyVerified: false,
    authority: 'named_reviewed_input_only', reviewer, packets: bundle.packets.length, bindings: bundle.bindings.length,
    contentSha256: bundle.contentSha256, revisionPath: path,
    preparationScope: evaluation ? 'explicit_ended_evaluation_context' : 'reviewed_packet_revision_only',
    evaluationContextPath: evaluation?.path ?? null, evaluationSourceSha256: evaluation?.envelope.sourceSha256 ?? null,
    evaluationJobId: null, contextSnapshotSha256: null, publicationAuthorized: false,
    heldTurns: evaluation?.decisions.filter(decision => decision.holdReasons.length).map(({ turnId, holdReasons }) => ({ turnId, holdReasons })) ?? [],
    originalSessionModified: false, originalContextModified: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  prepareApprovedKnowledgeCli(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(JSON.stringify({ passed: false, error: error instanceof Error ? error.message : 'APPROVED_KNOWLEDGE_PREPARE_FAILED' })); process.exitCode = 1;
  });
}
