import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { freezeKnowledge, knowledgeHash,
  parseApprovedKnowledgeBundle, type ApprovedKnowledgeBundle } from '../server/data/approved-knowledge';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { InterviewSession } from '../server/protocol';
import { buildEvaluationUnits } from '../server/providers/evaluation-turns';
import { evaluateKnowledgeGate } from '../server/providers/evaluation-knowledge-gate';
import { EVALUATION_PIPELINE_VERSION, evaluationSessionSourceFingerprint } from '../server/providers/evaluation-input';
import { enqueueReviewedKnowledgeEvaluation } from '../server/evaluation-worker';
import { EvaluationJobStore } from '../server/evaluation-job-store';
import { LocalSessionStore } from '../server/storage/local-session-store';
import { snapshotHash } from '../server/session-runtime';

const value = (args: string[], flag: string) => {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('APPROVED_KNOWLEDGE_ARGUMENT_MISSING:' + flag);
  return args[index + 1];
};
function validateArguments(args: string[]) {
  const valued = new Set(['--reviewed-input', '--reviewer', '--session-input', '--context-input', '--model']), seen = new Set<string>();
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
async function immutableFile(file: string, content: string) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try { await writeFile(file, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(file, 'utf8') !== content) throw error;
  }
}

/** A separate ended-session context preserves the original interview context.
 * The caller supplies existing reviewed input; this creates no knowledge,
 * source approval, scientific verdict, model output or runtime decision. */
export function createReviewedEvaluationKnowledgeContext(context: InterviewContext, session: InterviewSession,
  input: ApprovedKnowledgeBundle, provenance: { path: string; fileSha256: string }) {
  if (session.status === 'active') throw new Error('APPROVED_KNOWLEDGE_SESSION_NOT_ENDED');
  if (!session.runtime || snapshotHash(context) !== session.runtime.contextSnapshotSha256) throw new Error('APPROVED_KNOWLEDGE_BASE_CONTEXT_CHANGED');
  const bundle = parseApprovedKnowledgeBundle(input), evaluationContext = structuredClone(context);
  evaluationContext.approvedKnowledge = bundle;
  if (evaluationContext.manifest) {
    evaluationContext.manifest.files = [...evaluationContext.manifest.files.filter(file => file.role !== 'approvedEvaluationKnowledge'),
      { role: 'approvedEvaluationKnowledge', ...provenance, sha256: provenance.fileSha256 }].map(({ role, path, sha256 }) => ({ role, path, sha256 }));
    evaluationContext.manifest.recordIds = { ...evaluationContext.manifest.recordIds, approvedEvaluationKnowledgeSha256: bundle.contentSha256 };
  }
  const units = buildEvaluationUnits(session).scoredUnits;
  const decisions = units.map(unit => ({ turnId: unit.turn.id, ...evaluateKnowledgeGate(evaluationContext, session, unit) }));
  const invalid = decisions.find(decision => decision.holdReasons.some(reason => /INVALID|CHANGED|CONFLICT/u.test(reason)));
  if (invalid) throw new Error('APPROVED_KNOWLEDGE_REVIEW_BINDING_INVALID:' + invalid.turnId + ':' + invalid.holdReasons.join(','));
  return { context: freezeKnowledge(evaluationContext), decisions };
}

export async function prepareApprovedKnowledgeCli(args: string[], root = process.cwd()) {
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
  const content = JSON.stringify(bundle, null, 2), fileSha256 = knowledgeHash(content);
  const path = `data/prepared/approved-knowledge/revisions/${bundle.contentSha256}.json`;
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
    evaluation = { path: `data/prepared/approved-knowledge/evaluation-contexts/${contextSha256}.json`,
      envelope, session, decisions: projection.decisions };
  }
  // Validate every review and binding before publishing any output.
  if (args.includes('--enqueue') && !evaluation) throw new Error('APPROVED_KNOWLEDGE_ENDED_SESSION_AND_CONTEXT_REQUIRED');
  await immutableFile(resolve(root, path), content);
  if (evaluation) await immutableFile(resolve(root, evaluation.path), JSON.stringify(evaluation.envelope, null, 2));
  const queued = args.includes('--enqueue') && evaluation ? await enqueueReviewedKnowledgeEvaluation(evaluation.envelope.context, evaluation.session, {
    jobs: new EvaluationJobStore(resolve(root, 'data/evaluation-jobs')), sessions: new LocalSessionStore(resolve(root, 'data/sessions')),
    model,
  }) : null;
  return { passed: true, providerCalls: 0, sourceAuthenticityIndependentlyVerified: false, scientificTruthIndependentlyVerified: false,
    authority: 'named_reviewed_input_only', reviewer, packets: bundle.packets.length, bindings: bundle.bindings.length,
    contentSha256: bundle.contentSha256, revisionPath: path,
    preparationScope: evaluation ? 'explicit_ended_evaluation_context' : 'reviewed_packet_revision_only',
    evaluationContextPath: evaluation?.path ?? null, evaluationSourceSha256: evaluation?.envelope.sourceSha256 ?? null,
    evaluationJobId: queued?.job.id ?? null, contextSnapshotSha256: queued?.contextSnapshotSha256 ?? null,
    heldTurns: evaluation?.decisions.filter(decision => decision.holdReasons.length).map(({ turnId, holdReasons }) => ({ turnId, holdReasons })) ?? [],
    originalSessionModified: false, originalContextModified: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  prepareApprovedKnowledgeCli(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(JSON.stringify({ passed: false, error: error instanceof Error ? error.message : 'APPROVED_KNOWLEDGE_PREPARE_FAILED' })); process.exitCode = 1;
  });
}
