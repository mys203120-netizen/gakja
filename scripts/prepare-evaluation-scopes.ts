import dotenv from 'dotenv';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadInterviewContextAt, type InterviewContext } from '../server/data/load-interview-context';
import { loadQuestionBank, type PreparedQuestionBank } from '../server/data/prepared-question-bank';
import { BANK_SCOPE_REGISTRY_DIRECTORY, bankScopeReadiness, loadBankScopeRegistry, prepareBankScopeReview, validateBankScopeReview,
  publishBankScopeReview } from '../server/data/evaluation-scope-registry';
import { prepareEndedSessionReview, supplyReviewedSessionEvaluation, type EndedSessionReviewProposal } from '../server/evaluation-supply';
import type { InterviewSession } from '../server/protocol';
import { createLocalSessionStore } from '../server/storage/local-session-store';
import type { SessionStore } from '../server/storage/session-store';
import { localDevelopmentOwner } from '../server/session-runtime';
import { buildEvaluationUnits } from '../server/providers/evaluation-turns';
import { evaluateKnowledgeGate } from '../server/providers/evaluation-knowledge-gate';
import type { ApprovedKnowledgeBundle } from '../server/data/approved-knowledge';
import { knowledgeSessionQuestionAnswerHash } from '../server/data/approved-knowledge';
import { createLocalEvaluationJobStore } from '../server/evaluation-job-store';
import type { EvaluationRepository } from '../server/repositories/evaluation-job-ports';
import type { ReviewRepository } from '../server/repositories/review-ports';
import { createLocalReviewRepository } from '../server/repositories/local-review-repository';
import type { EvaluationRevisionRepository } from '../server/repositories/evaluation-revision-ports';
import { loadReviewedEvaluationRevision } from '../server/evaluation-revisions';

/** Read/prepare/validate are offline operations. Publish accepts only a signed
 * receipt from the authenticated review service and a configured trusted key.
 * This CLI cannot issue receipts or authenticate a reviewer on its own. */
export async function prepareEvaluationScopesCli(args: string[], root = process.cwd(), dependencies: {
  context?: InterviewContext; bank?: PreparedQuestionBank; trustedPublicKey?: string; sessions?: SessionStore; jobs?: EvaluationRepository; reviews?: ReviewRepository; revisions?: EvaluationRevisionRepository;
} = {}) {
  const [command, ...flags] = args;
  if (!['stage', 'validate', 'publish', 'stage-ended', 'prepare-ended', 'supply-ended', 'coverage'].includes(command)) throw new Error('EVALUATION_SCOPE_COMMAND_REQUIRED:stage|validate|publish|prepare-ended|supply-ended|coverage');
  const values = new Map<string, string>(), allowed = new Set(['--output', '--reviewed-input', '--reviewer', '--receipt', '--expected-current', '--session-input', '--context-input', '--session-id', '--proposal-input']);
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index], value = flags[index + 1];
    if (!allowed.has(flag) || !value || value.startsWith('--') || values.has(flag)) throw new Error('EVALUATION_SCOPE_ARGUMENT_INVALID:' + flag);
    values.set(flag, value);
  }
  const sessionStore = dependencies.sessions ?? createLocalSessionStore(root), reviews = dependencies.reviews ?? createLocalReviewRepository(root);
  const endedInput = async () => {
    if (values.has('--session-id')) {
      if (values.has('--session-input') || values.has('--context-input')) throw new Error('EVALUATION_ENDED_INPUT_AMBIGUOUS');
      const sessions = sessionStore, owner = localDevelopmentOwner();
      const session = await sessions.load(values.get('--session-id')!, owner.id);
      if (!session?.runtime || session.status === 'active') throw new Error('EVALUATION_FROZEN_ENDED_INPUT_REQUIRED');
      return { session, context: await sessions.loadContext(session.runtime.contextSnapshotSha256, owner.id) };
    }
    const sessionPath = values.get('--session-input'), contextPath = values.get('--context-input');
    if (!sessionPath || !contextPath) throw new Error('EVALUATION_ENDED_SESSION_AND_CONTEXT_REQUIRED');
    const rawSession = JSON.parse(await readFile(resolve(root, sessionPath), 'utf8')), rawContext = JSON.parse(await readFile(resolve(root, contextPath), 'utf8'));
    return { context: (rawContext.context ?? rawContext) as InterviewContext, session: (rawSession.session ?? rawSession) as InterviewSession };
  };
  if (['stage-ended', 'prepare-ended', 'supply-ended'].includes(command) || command === 'coverage' && values.has('--session-id')) {
    const { context, session } = await endedInput();
    const registry = await loadBankScopeRegistry(root, dependencies.trustedPublicKey, reviews) ?? undefined;
    const proposal = prepareEndedSessionReview(context, session, registry);
    if (command === 'coverage') {
      const ownerId = session.runtime!.owner.id, sessions = sessionStore, jobs = dependencies.jobs ?? createLocalEvaluationJobStore(root);
      const revision = await loadReviewedEvaluationRevision({ root, session, ownerId, sessions, jobs, trustedPublicKey: dependencies.trustedPublicKey, reviews, revisions: dependencies.revisions });
      let evaluatedContext = context, evaluatedSession = session, snapshotScope = 'original_ended_session';
      const withdrawn = revision?.status === 'review_required' && ['EVALUATION_APPROVAL_WITHDRAWN_OR_CHANGED', 'EVALUATION_PIPELINE_VERSION_CHANGED'].includes(revision.error ?? '');
      if (revision && !withdrawn) {
        const job = await jobs.get(revision.jobId);
        if (!job) throw new Error('EVALUATION_REVIEWED_JOB_MISSING');
        evaluatedSession = (await jobs.snapshot(job)).session;
        evaluatedContext = await sessions.loadContext(job.contextSnapshotSha256, ownerId);
        snapshotScope = 'verified_reviewed_evaluation_revision';
      } else if (withdrawn) snapshotScope = 'reviewed_revision_not_current';
      const units = buildEvaluationUnits(evaluatedSession).scoredUnits, decisions = units.map(unit => withdrawn
        ? { holdReasons: ['EVALUATION_APPROVAL_WITHDRAWN_OR_CHANGED'] } : evaluateKnowledgeGate(evaluatedContext, evaluatedSession, unit));
      const qaHash = knowledgeSessionQuestionAnswerHash(evaluatedSession);
      return { passed: true, command, providerCalls: 0, snapshotScope, reviewedRevisionStatus: revision?.status ?? null,
        reviewedRevisionSha256: revision?.revisionSha256 ?? null, questionApprovedCount: units.filter(unit => !!unit.turn.metadata.approvedQuestion).length,
        specApprovedCount: proposal.units.filter(unit => unit.specification?.reviewStatus === 'approved').length,
        boundCount: withdrawn ? 0 : (evaluatedContext.approvedKnowledge?.bindings ?? []).filter(binding => binding.sessionId === session.id && binding.sessionQuestionAnswerSha256 === qaHash).length,
        gatePassedCount: decisions.filter(decision => !decision.holdReasons.length).length, heldCount: decisions.filter(decision => decision.holdReasons.length).length,
        sessionEvaluationReady: !!revision && !withdrawn && decisions.length > 0 && decisions.every(decision => !decision.holdReasons.length),
        preapprovedQ0ScopeReady: false, inventoryReviewReason: 'inventory_review_required' };
    }
    if (command === 'supply-ended') {
      const bundlePath = values.get('--reviewed-input'), proposalPath = values.get('--proposal-input'), receiptPath = values.get('--receipt');
      if (!bundlePath || !proposalPath || !receiptPath) throw new Error('EVALUATION_AUTHENTICATED_SESSION_SUPPLY_INPUT_REQUIRED');
      const supplied = await supplyReviewedSessionEvaluation({ context, session, root, enqueue: true, trustedPublicKey: dependencies.trustedPublicKey, sessions: sessionStore, jobs: dependencies.jobs, reviews, revisions: dependencies.revisions,
        proposal: JSON.parse(await readFile(resolve(root, proposalPath), 'utf8')) as EndedSessionReviewProposal,
        bundle: JSON.parse(await readFile(resolve(root, bundlePath), 'utf8')) as ApprovedKnowledgeBundle,
        receipt: JSON.parse(await readFile(resolve(root, receiptPath), 'utf8')) });
      return { ...supplied, context: undefined, decisions: supplied.decisions.map(({ turnId, scope, holdReasons }) => ({ turnId, scope, holdReasons })) };
    }
    const output = values.get('--output') ?? `data/prepared/approved-knowledge/session-review-proposals/${proposal.contentSha256}.json`;
    const file = resolve(root, output), content = JSON.stringify(proposal, null, 2);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    try { await writeFile(file, content, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(file, 'utf8') !== content) throw error; }
    return { passed: true, command, output, providerCalls: 0, publicationAuthorized: false, pendingUnits: proposal.units.length, contentSha256: proposal.contentSha256 };
  }
  const context = dependencies.context ?? await loadInterviewContextAt(root, { writeManifest: false });
  const bank = dependencies.bank ?? await loadQuestionBank(context, { root });
  if (!bank || context.errors.length) throw new Error('EVALUATION_SCOPE_VERIFIED_BANK_REQUIRED');
  if (command === 'coverage') return { passed: true, command, ...bankScopeReadiness(context, bank) };
  if (command === 'stage') {
    if ([...values.keys()].some(flag => flag !== '--output')) throw new Error('EVALUATION_SCOPE_STAGE_ARGUMENT_INVALID');
    const proposal = prepareBankScopeReview(context, bank);
    const output = values.get('--output') ?? `${BANK_SCOPE_REGISTRY_DIRECTORY}/proposals/${proposal.contentSha256}.json`;
    const file = resolve(root, output), content = JSON.stringify(proposal, null, 2);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    try { await writeFile(file, content, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(file, 'utf8') !== content) throw error; }
    return { passed: true, command, output, providerCalls: 0, approvedCount: 0, pendingCount: proposal.entries.length,
      contentSha256: proposal.contentSha256, publicationAuthorized: false, currentRegistryModified: false };
  }
  const input = values.get('--reviewed-input'), reviewer = values.get('--reviewer');
  if (!input || !reviewer) throw new Error('EVALUATION_SCOPE_REVIEWED_INPUT_AND_REVIEWER_REQUIRED');
  const registry = validateBankScopeReview(JSON.parse(await readFile(resolve(root, input), 'utf8')), context, bank, reviewer);
  if (command === 'validate') {
    if (values.has('--receipt') || values.has('--expected-current') || values.has('--output')) throw new Error('EVALUATION_SCOPE_VALIDATE_ARGUMENT_INVALID');
    return { passed: true, command, providerCalls: 0, publicationAuthorized: false, currentRegistryModified: false,
      readiness: bankScopeReadiness({ ...context, evaluationScopeRegistry: registry }, bank) };
  }
  const receiptPath = values.get('--receipt'), expected = values.get('--expected-current');
  if (!receiptPath || !expected || values.has('--output')) throw new Error('EVALUATION_SCOPE_AUTHENTICATED_RECEIPT_AND_CAS_REQUIRED');
  const receipt = JSON.parse(await readFile(resolve(root, receiptPath), 'utf8'));
  if (receipt.actorId !== reviewer) throw new Error('EVALUATION_SCOPE_RECEIPT_ACTOR_MISMATCH');
  const published = await publishBankScopeReview(registry, context, bank, receipt, expected === 'none' ? null : expected, root, dependencies.trustedPublicKey, reviews);
  return { passed: true, command, providerCalls: 0, publicationAuthorized: true, currentRegistryModified: true,
    contentSha256: published.contentSha256, readiness: bankScopeReadiness({ ...context, evaluationScopeRegistry: published }, bank) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  dotenv.config({ path: '.env.local', quiet: true });
  prepareEvaluationScopesCli(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(JSON.stringify({ passed: false, error: error instanceof Error ? error.message : 'EVALUATION_SCOPE_PREPARATION_FAILED' })); process.exitCode = 1;
  });
}
