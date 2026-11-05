/** Explicit offline migration. It preserves old banks, analysis and interviews.
 * Staging, paid preparation and activation are separate commands. */
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadInterviewContextAt, type InterviewContext } from '../server/data/load-interview-context';
import { activateStagedFullStudentAnalysis, loadStagedFullStudentAnalysis, publishReviewedObjectiveContracts, type FullAnalysisBankReadiness, type ReviewedObjectiveContractCorrection } from '../server/data/full-student-analysis';
import { loadQuestionBank, prepareQuestionBank, questionBankIdentity, type PreparedMainCandidate, type PreparedQuestionBank, type QuestionBankProviders } from '../server/data/prepared-question-bank';
import { projectPreparedActivities } from '../server/data/prepared-activities';
import { approveQuestionContract, assertQuestionContractIntegrity, buildStudentTrajectory, createQuestionBlueprint, createStudentObjectiveCandidates } from '../server/question-objective';
import { attachVerifiedQuestionPlan } from '../server/providers/question-plan';
import { QUESTION_PREMISE_REVIEW_RULES, questionPremiseReviewWireSchema, resolveVerifiedCommonPremiseAuthority, validateQuestionPremises } from '../server/providers/question-premises';
import { generateQuestion } from '../server/providers/openai';
import { readSpeechAudio, speechAudioCacheId, synthesizeSpeech } from '../server/providers/clova-tts';
import { loadApprovedRecoveryVariants, recoveryVariantIdentity, saveApprovedRecoveryVariants, type ApprovedRecoveryVariantFile } from '../server/data/approved-recovery-variants';
import { publishExactQuestionPurposeLineageRebind } from '../server/data/question-purpose-lineage';
import { resolveQuestionReviewAuthority, type QuestionReviewAuthority } from '../server/data/question-review-authority';
import { aggregateProviderCosts, estimateProviderCost, normalizeProviderUsage, type ProviderUsageObservation } from '../server/observability/provider-cost';
import type { InterviewSession, QuestionDraft, RecordedTurn } from '../server/protocol';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** Offline revised-Q0 audit only. Runtime/core and other reviewers are unchanged. */
export const OFFLINE_REVISED_SURFACE_REVIEW_MAX_OUTPUT_TOKENS = 4000;
export function offlineSurfaceReviewDiagnostics(response: unknown) {
  const raw = response && typeof response === 'object' ? response as Record<string, unknown> : {};
  const incomplete = raw.incomplete_details && typeof raw.incomplete_details === 'object' ? raw.incomplete_details as Record<string, unknown> : {};
  const usage = raw.usage && typeof raw.usage === 'object' ? raw.usage as Record<string, unknown> : {};
  const output = usage.output_tokens_details && typeof usage.output_tokens_details === 'object' ? usage.output_tokens_details as Record<string, unknown> : {};
  return { status: typeof raw.status === 'string' ? raw.status : null,
    incompleteReason: typeof incomplete.reason === 'string' ? incomplete.reason : null,
    outputParsedPresent: raw.output_parsed != null, outputTextCharacters: typeof raw.output_text === 'string' ? raw.output_text.length : null,
    outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : null,
    reasoningTokens: typeof output.reasoning_tokens === 'number' ? output.reasoning_tokens : null,
    configuredMaxOutputTokens: OFFLINE_REVISED_SURFACE_REVIEW_MAX_OUTPUT_TOKENS };
}
interface ReviewedBankRow {
  candidateId: string; objectiveId: string; semanticKey: string; questionSha256: string; questionText: string;
  developerDisposition: 'keep' | 'revise_contract' | 'rewrite_question'; questionIntent: string; targetEvidence: [string];
  primaryFunction: QuestionDraft['primaryFunction']; depth: QuestionDraft['depth']; proposedQuestion: string | null;
}
interface DeveloperBankReview {
  version: 'developer-reviewed-bank-quality-v1'; reviewedAt: string;
  parentModelAudit: { path: string; sha256: string; model: string };
  bank: { path: string; key: string; contentSha256: string; fileSha256: string };
  coverage: { expected: number; reviewed: number; missing: string[] }; rows: ReviewedBankRow[];
  corrections: ReviewedObjectiveContractCorrection[];
}
async function writeNew(root: string, relative: string, value: unknown, directory = 'artifacts') {
  const full = path.resolve(root, relative), within = path.relative(path.resolve(root, directory), full);
  if (!within || within.startsWith('..') || path.isAbsolute(within)) throw new Error('BANK_UPGRADE_OUTPUT_PATH_INVALID');
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

function safeUpgradeFailure(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return /^[A-Z0-9_]+$/u.test(code) ? code : error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : error instanceof Error ? error.name : 'BANK_UPGRADE_NOT_COMPLETED';
}
export interface OwnedBankUpgradeReport {
  /** Track the live in-memory report so a later error retains call/commit state. */
  track(value: object): void;
  write(value: object): Promise<void>;
}
/** Reserve the report before the operation can load/stage/charge/activate.
 * Only this newly created, exclusively owned handle may ever be truncated.
 * A pre-existing report is never opened for writing or modified. */
export async function withReservedBankUpgradeReport<T>(root: string, relative: string, operation: (report: OwnedBankUpgradeReport) => Promise<T>, initial: object = {}) {
  const full = path.resolve(root, relative), within = path.relative(path.resolve(root, 'artifacts'), full);
  if (!within || within.startsWith('..') || path.isAbsolute(within)) throw new Error('BANK_UPGRADE_OUTPUT_PATH_INVALID');
  await mkdir(path.dirname(full), { recursive: true });
  const handle = await open(full, 'wx', 0o600);
  let current: object = { version: 'reviewed-bank-upgrade-reservation-v1', startedAt: new Date().toISOString(), status: 'reserved_before_operation', ...initial };
  const report: OwnedBankUpgradeReport = {
    track(value) { current = value; },
    async write(value) {
      current = value;
      const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
      let offset = 0;
      while (offset < bytes.length) {
        const written = await handle.write(bytes, offset, bytes.length - offset, offset);
        if (!written.bytesWritten) throw new Error('BANK_UPGRADE_REPORT_WRITE_INCOMPLETE');
        offset += written.bytesWritten;
      }
      await handle.truncate(bytes.length);
      await handle.sync();
    },
  };
  try {
    await report.write(current);
    return await operation(report);
  } catch (error) {
    await report.write({ ...current, failure: safeUpgradeFailure(error), failedAt: new Date().toISOString() });
    throw error;
  } finally { await handle.close(); }
}

export async function loadReviewedBankUpgrade(root: string, reviewPath: string) {
  const reviewBytes = await readFile(path.resolve(root, reviewPath)), review = JSON.parse(reviewBytes.toString('utf8')) as DeveloperBankReview;
  if (review.version !== 'developer-reviewed-bank-quality-v1' || review.coverage.expected !== review.coverage.reviewed || review.coverage.missing.length || new Set(review.rows.map(row => row.candidateId)).size !== review.coverage.expected) throw new Error('BANK_UPGRADE_REVIEW_COVERAGE_INVALID');
  const modelBytes = await readFile(path.resolve(root, review.parentModelAudit.path));
  if (sha(modelBytes) !== review.parentModelAudit.sha256) throw new Error('BANK_UPGRADE_MODEL_REVIEW_CHANGED');
  const bankBytes = await readFile(path.resolve(root, review.bank.path)), bank = JSON.parse(bankBytes.toString('utf8')) as PreparedQuestionBank;
  if (sha(bankBytes) !== review.bank.fileSha256 || bank.key !== review.bank.key || bank.contentSha256 !== review.bank.contentSha256) throw new Error('BANK_UPGRADE_PARENT_BANK_CHANGED');
  const candidates = bank.slots.flatMap(slot => slot.candidates);
  if (candidates.length !== review.rows.length || review.rows.some(row => !candidates.some(candidate => candidate.id === row.candidateId && candidate.questionSha256 === row.questionSha256 && candidate.draft.questionText === row.questionText))) throw new Error('BANK_UPGRADE_PARENT_UTTERANCE_CHANGED');
  return { review, bank, reviewSha256: sha(reviewBytes) };
}

/** Staged common facts and exact runtime evidence must be the same; only target
 * objectives change. The final manifest points at the immutable new envelope. */
export async function stagedBankUpgradeContext(context: InterviewContext, revision: string, root = process.cwd()) {
  const staged = await loadStagedFullStudentAnalysis(context, revision, root);
  if (staged.common.contentSha256 !== context.studentAnalysis?.contentSha256) throw new Error('BANK_UPGRADE_COMMON_FACTS_CHANGED');
  const updated = structuredClone(context), file = updated.manifest.files.find(row => row.role === 'fullStudentAnalysis');
  if (!file) throw new Error('BANK_UPGRADE_ANALYSIS_MANIFEST_MISSING');
  updated.studentAnalysis = staged.common; updated.targetAnalysis = staged.target;
  file.path = staged.revisionPath.replaceAll('\\', '/'); file.sha256 = sha(await readFile(path.resolve(root, revision)));
  Object.assign(updated.manifest.recordIds, { targetAnalysisRevision: staged.target.revision, targetAnalysisContentSha256: staged.target.contentSha256 });
  updated.preparedActivities = projectPreparedActivities(updated, staged.common);
  updated.studentObjectives = createStudentObjectiveCandidates(updated, updated.preparedActivities);
  updated.studentTrajectory = buildStudentTrajectory(updated);
  return { context: updated, staged };
}

/** New semantic contract comes from the explicit independently reviewed target
 * revision. Old premise/source approval is preserved only for identical speech. */
export function rebuiltReviewedBankDraft(original: PreparedMainCandidate, row: ReviewedBankRow, context: InterviewContext, session: InterviewSession) {
  if (!original.draft.approvedQuestion) throw new Error('BANK_UPGRADE_OLD_APPROVAL_MISSING');
  assertQuestionContractIntegrity(original.draft, original.draft.approvedQuestion);
  if (original.id !== row.candidateId || original.questionSha256 !== row.questionSha256 || sha(original.draft.questionText) !== row.questionSha256) throw new Error('BANK_UPGRADE_REVIEWED_UTTERANCE_CHANGED');
  const slot = session.plan?.slots[session.turns.length], objective = slot?.objective;
  const trace = context.targetAnalysis?.objectiveContractRevision;
  const finalText = row.proposedQuestion ?? original.draft.questionText;
  if (!slot || !objective || objective.id !== row.objectiveId || !trace?.changedObjectiveIds.includes(objective.id) || !trace.approvedQuestions?.some(question => question.objectiveId === objective.id && question.questionSha256 === sha(finalText)) || objective.questionIntent !== row.questionIntent || JSON.stringify(objective.targetEvidence) !== JSON.stringify(row.targetEvidence) || objective.primaryFunction !== row.primaryFunction || objective.depth !== row.depth) throw new Error('BANK_UPGRADE_STAGED_REVIEW_BINDING_INVALID');
  const draft = structuredClone(original.draft);
  draft.questionText = finalText; draft.questionIntent = row.questionIntent; draft.targetEvidence = [...row.targetEvidence];
  draft.primaryFunction = row.primaryFunction; draft.depth = row.depth;
  delete draft.approvedQuestion; delete draft.questionBlueprint;
  if (row.proposedQuestion) delete draft.premiseValidation;
  return { draft, slot, objective };
}

function reviewedOriginal(candidate: PreparedMainCandidate): RecordedTurn {
  // Ephemeral original-question scope for cache validation, never a persisted
  // interview or evidence that this question was actually played to a student.
  const id = randomUUID(); return { id, parentMainQuestionId: id, questionText: candidate.draft.questionText, evidenceIds: candidate.draft.evidenceIds, metadata: structuredClone(candidate.draft), questionKind: 'main' } as unknown as RecordedTurn;
}

async function recoveryReadiness(oldContext: InterviewContext, context: InterviewContext, oldBank: PreparedQuestionBank, bank: PreparedQuestionBank, root: string) {
  const source = oldBank.slots.flatMap(slot => slot.candidates).find(candidate => candidate.draft.commonApproval?.moduleId === 'common-major-selection-motive');
  const destination = bank.slots.flatMap(slot => slot.candidates).find(candidate => candidate.draft.commonApproval?.moduleId === 'common-major-selection-motive');
  if (!source || !destination || source.questionSha256 !== destination.questionSha256 || JSON.stringify(source.voiceSettings) !== JSON.stringify(destination.voiceSettings)) throw new Error('BANK_UPGRADE_RECOVERY_PARENT_CHANGED');
  const oldOriginal = reviewedOriginal(source), original = reviewedOriginal(destination);
  const prior = await loadApprovedRecoveryVariants(oldContext, oldOriginal, root);
  if (!prior.length) throw new Error('BANK_UPGRADE_APPROVED_RECOVERY_MISSING');
  const sourcePath = `data/prepared/recovery-variants/${recoveryVariantIdentity(oldContext, oldOriginal)}.json`;
  const sourceBytes = await readFile(path.resolve(root, sourcePath)), sourceFile = JSON.parse(sourceBytes.toString('utf8')) as ApprovedRecoveryVariantFile;
  // The helper re-runs the full deterministic proof/intent bindings against the
  // new exact context; no copied "approved" flag is trusted on its own.
  const saved = await saveApprovedRecoveryVariants(context, original, sourceFile.variants, root);
  const checked = await loadApprovedRecoveryVariants(context, original, root);
  if (checked.length !== prior.length) throw new Error('BANK_UPGRADE_RECOVERY_REBIND_FAILED');
  const audio = await Promise.all(checked.map(async draft => { const id = speechAudioCacheId(draft.questionText, destination.voiceSettings), bytes = await readSpeechAudio(id); if (!bytes?.length) throw new Error('BANK_UPGRADE_RECOVERY_AUDIO_MISSING'); return { textSha256: sha(draft.questionText), speechHash: id, audioSha256: sha(bytes) }; }));
  const manifestPath = `data/prepared/bank-upgrade-readiness/${bank.key}.json`;
  const manifest = { version: 'bank-upgrade-approved-recovery-v1', bankKey: bank.key, sourcePath, sourceFileSha256: sha(sourceBytes), identity: saved.identity, variants: audio };
  try { await writeNew(root, manifestPath, manifest, 'data/prepared/bank-upgrade-readiness'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(path.resolve(root, manifestPath), 'utf8') !== JSON.stringify(manifest, null, 2) + '\n') throw error; }
  return { manifestPath, sha256: sha(await readFile(path.resolve(root, manifestPath))), bankKey: bank.key };
}

export async function prepareReviewedBankUpgrade(options: { root?: string; reviewPath: string; revisionPath: string; output: string; mode: 'stage_contracts' | 'check' | 'prepare' | 'activate'; maxLlmCalls?: number; maxTtsCalls?: number }) {
  const root = options.root ?? process.cwd();
  return withReservedBankUpgradeReport(root, options.output, async reportFile => {
  const oldContext = await loadInterviewContextAt(root, { writeManifest: false });
  if (oldContext.errors.length) throw new Error('BANK_UPGRADE_ACTIVE_CONTEXT_INVALID');
  const { review, bank: oldBank, reviewSha256 } = await loadReviewedBankUpgrade(root, options.reviewPath);
  const activeBank = await loadQuestionBank(oldContext, { root });
  if (activeBank?.key !== oldBank.key) throw new Error('BANK_UPGRADE_ACTIVE_BANK_CHANGED');
  if (options.mode === 'stage_contracts') {
    const result = await publishReviewedObjectiveContracts(oldContext, review.corrections, { artifactSha256: reviewSha256, model: review.parentModelAudit.model, reviewedAt: review.reviewedAt }, root, { activate: false, baseRevisionPath: options.revisionPath });
    const staged = await stagedBankUpgradeContext(oldContext, result.revisionPath, root);
    const report = { version: 'reviewed-bank-upgrade-stage-v1', revisionPath: result.revisionPath, manifestPath: result.manifestPath, bankKey: questionBankIdentity(staged.context).key, corrections: review.corrections.length, providerCalls: 0, activated: false };
    await reportFile.write(report); return report;
  }
  const { context, staged } = await stagedBankUpgradeContext(oldContext, options.revisionPath, root);
  if (context.targetAnalysis?.objectiveContractRevision?.reviewArtifactSha256 !== reviewSha256) throw new Error('BANK_UPGRADE_REVIEW_ARTIFACT_UNBOUND');
  const identity = questionBankIdentity(context), existing = await loadQuestionBank(context, { root });
  const report = { version: 'reviewed-bank-upgrade-preparation-v1', createdAt: new Date().toISOString(), revisionPath: options.revisionPath, reviewPath: options.reviewPath, reviewSha256,
    bankKey: identity.key, oldBankKey: oldBank.key, mode: options.mode, maxLlmCalls: options.maxLlmCalls ?? 0, maxTtsCalls: options.maxTtsCalls ?? 0,
    llmRequests: [] as Array<{ stage: string; candidateId: string | null; at: string }>, usage: [] as Array<{ stage: string; observation: ProviderUsageObservation }>,
    ttsRequests: [] as Array<{ textSha256: string }>, migrated: [] as Array<{ objectiveId: string; candidateId: string; originalQuestionSha256: string; finalQuestionSha256: string; premiseSourceApprovalPreserved: boolean }>,
    preparationEvents: [] as unknown[], surfaceReviews: [] as Array<{ candidateId: string; input: unknown; review: unknown; validationFailure: unknown; responseDiagnostics: ReturnType<typeof offlineSurfaceReviewDiagnostics> }>, reviewAuthorities: [] as QuestionReviewAuthority[],
    failure: null as string | null, activated: false, readiness: null as FullAnalysisBankReadiness | null,
    summary: null as null | { approved: number; quarantined: number; preservedOriginalUtterances: number; newUtterances: number; costs: ReturnType<typeof aggregateProviderCosts> } };
  reportFile.track(report);
  if (options.mode === 'check') { await reportFile.write({ ...report, existingBankVerified: Boolean(existing), proposedExistingCorrections: review.corrections.length, proposedNewObjectives: identity.plan.slots.filter(slot => !oldBank.plan.slots.some(old => old.id === slot.id)).length }); return report; }
  const beforeRequest = (stage: string, candidateId: string | null = null) => {
    if (report.llmRequests.length >= report.maxLlmCalls) throw new Error('BANK_UPGRADE_LLM_CALL_CAP_REACHED');
    report.llmRequests.push({ stage, candidateId, at: new Date().toISOString() });
  };
  if (options.mode === 'prepare' && (!Number.isInteger(report.maxLlmCalls) || report.maxLlmCalls < 1 || report.maxLlmCalls > 24 || !Number.isInteger(report.maxTtsCalls) || report.maxTtsCalls < 1 || report.maxTtsCalls > 6)) throw new Error('BANK_UPGRADE_EXPLICIT_PROVIDER_CAP_REQUIRED');
  const client = options.mode === 'prepare' ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 45000, maxRetries: 0 }) : null;
  const providers: QuestionBankProviders = {
    generate: async (ctx, session, excludedQuestionTexts) => {
      const slot = session.plan!.slots[session.turns.length], oldSlot = oldBank.plan.slots.find(item => item.id === slot.id);
      if (!oldSlot) return generateQuestion(ctx, session, false, true, undefined, { excludedQuestionTexts, maxRetries: 0,
        beforeProviderRequest: stage => beforeRequest(stage), onProviderUsage: event => report.usage.push(event) });
      const original = oldBank.slots.find(row => row.slotId === slot.id)?.candidates[0], row = review.rows.find(row => row.objectiveId === slot.objective?.id);
      if (!original || !row || row.developerDisposition === 'keep') throw new Error('BANK_UPGRADE_UNREVIEWED_EXISTING_CHANGE');
      const { draft, objective } = rebuiltReviewedBankDraft(original, row, ctx, session);
      if (row.proposedQuestion) {
        const sources = ctx.student.evidence.filter(source => draft.evidenceIds.includes(source.id)), commonAuthority = resolveVerifiedCommonPremiseAuthority(ctx, draft);
        await validateQuestionPremises({ draft, sources, commonAuthority, reviewModel: review.parentModelAudit.model,
          onValidationFailure: failure => { const row = report.surfaceReviews.findLast(row => row.candidateId === original.id); if (row) row.validationFailure = failure; },
          requestReview: async input => {
          beforeRequest('revised_surface_premise_review', original.id);
          const response = await client!.responses.parse({ model: review.parentModelAudit.model, service_tier: 'default', store: false, reasoning: { effort: 'low' }, instructions: QUESTION_PREMISE_REVIEW_RULES,
            input: JSON.stringify(input), text: { format: zodTextFormat(questionPremiseReviewWireSchema(input), 'revised_bank_surface_review') }, max_output_tokens: OFFLINE_REVISED_SURFACE_REVIEW_MAX_OUTPUT_TOKENS }).catch(error => {
              report.usage.push({ stage: 'revised_surface_premise_review', observation: normalizeProviderUsage(null, { requestedModel: review.parentModelAudit.model, requestedServiceTier: 'default' }) });
              throw error;
            });
          report.usage.push({ stage: 'revised_surface_premise_review', observation: normalizeProviderUsage(response, { requestedModel: review.parentModelAudit.model, requestedServiceTier: 'default' }) });
          report.surfaceReviews.push({ candidateId: original.id, input, review: response.output_parsed, validationFailure: null, responseDiagnostics: offlineSurfaceReviewDiagnostics(response) });
          if (!response.output_parsed) throw new Error('BANK_UPGRADE_SURFACE_REVIEW_MISSING');
          return response.output_parsed;
        } });
      }
      attachVerifiedQuestionPlan(draft, session);
      const blueprint = createQuestionBlueprint(draft, ctx, session, { objectiveCandidate: objective, strategyIds: draft.strategyTrace?.candidateCardIds ?? [], targetDescription: draft.targetEvidence[0], expansionRationale: objective.scope === 'record_grounded_extension' ? objective.selectionBasis : null });
      draft.questionBlueprint = blueprint;
      draft.approvedQuestion = approveQuestionContract(draft, blueprint, { policyDigest: ctx.interviewerPolicy?.contentSha256, strategyCatalogDigest: ctx.questionStrategies?.contentSha256 });
      report.migrated.push({ objectiveId: objective.id, candidateId: original.id, originalQuestionSha256: original.questionSha256, finalQuestionSha256: sha(draft.questionText), premiseSourceApprovalPreserved: !row.proposedQuestion && JSON.stringify(draft.premiseValidation) === JSON.stringify(original.draft.premiseValidation) });
      return draft;
    },
    synthesize: async (text, voice, role) => {
      const id = speechAudioCacheId(text, voice), bytes = await readSpeechAudio(id);
      if (bytes?.length) return { audioUrl: `/api/audio/${id}`, bytes };
      if (report.ttsRequests.length >= report.maxTtsCalls) throw new Error('BANK_UPGRADE_TTS_CALL_CAP_REACHED');
      report.ttsRequests.push({ textSha256: sha(text) });
      const audioUrl = await synthesizeSpeech(text, voice.speaker, { role, settings: voice });
      const saved = await readSpeechAudio(id); if (!saved?.length) throw new Error('BANK_UPGRADE_TTS_AUDIO_MISSING');
      return { audioUrl, bytes: saved };
    },
  };
  try {
    const bank = existing ?? (options.mode === 'prepare' ? await prepareQuestionBank(context, { root, providers, reuseFromBankKey: oldBank.key, maxNewCandidates: review.corrections.length + identity.plan.slots.filter(slot => !oldBank.plan.slots.some(old => old.id === slot.id)).length, concurrency: 1, onProgress: event => report.preparationEvents.push(event) }) : null);
    if (!bank || !(await loadQuestionBank(context, { root }))) throw new Error('BANK_UPGRADE_BANK_NOT_READY');
    for (const row of bank.slots) for (const candidate of row.candidates) {
      const model = candidate.draft.premiseValidation?.reviewModel;
      if (!model || model === bank.questionModel) continue;
      const objectiveId = bank.plan.slots.find(slot => slot.id === row.slotId)?.objective?.id ?? row.slotId;
      const authority = await resolveQuestionReviewAuthority(context, objectiveId, candidate.questionSha256, model, root);
      if (!authority) throw new Error('BANK_UPGRADE_INDEPENDENT_REVIEW_AUTHORITY_MISSING');
      report.reviewAuthorities.push(authority);
    }
    const recovery = await recoveryReadiness(oldContext, context, oldBank, bank, root);
    await publishExactQuestionPurposeLineageRebind(context, oldBank, bank, root);
    const bankPath = `data/prepared/question-banks/${bank.key}.json`;
    report.readiness = { bankPath, bankFileSha256: sha(await readFile(path.resolve(root, bankPath))), bankKey: bank.key, bankContentSha256: bank.contentSha256,
      commonContentSha256: staged.common.contentSha256, targetContentSha256: staged.target.contentSha256, evidenceSha256: staged.manifest.evidenceSha256,
      analysisQAManifestSha256: staged.manifest.contentSha256, recovery, verifiedAt: new Date().toISOString() };
    const oldQuestions = new Set(oldBank.slots.flatMap(slot => slot.candidates.map(candidate => candidate.questionSha256))), candidates = bank.slots.flatMap(slot => slot.candidates);
    report.summary = { approved: candidates.length, quarantined: bank.slots.filter(row => row.quarantine).length, preservedOriginalUtterances: candidates.filter(candidate => oldQuestions.has(candidate.questionSha256)).length, newUtterances: candidates.filter(candidate => !oldQuestions.has(candidate.questionSha256)).length,
      costs: aggregateProviderCosts(report.usage.map(row => estimateProviderCost(row.observation))) };
    if (options.mode === 'activate') {
      await activateStagedFullStudentAnalysis(oldContext, options.revisionPath, report.readiness, root); report.activated = true;
      const committed = await loadInterviewContextAt(root, { writeManifest: false });
      if (committed.errors.length || (await loadQuestionBank(committed, { root }))?.key !== bank.key) throw new Error('BANK_UPGRADE_COMMITTED_BANK_NOT_READY');
    }
  } catch (error) {
    report.failure = safeUpgradeFailure(error);
  }
  await reportFile.write(report);
  return report;
  }, { mode: options.mode, revisionPath: options.revisionPath, reviewPath: options.reviewPath, externalProviderCalls: 0, activated: false });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  dotenv.config({ path: '.env.local', quiet: true });
  const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  const modes = ['--stage-contracts', '--run-live', '--activate', '--check'].filter(value => process.argv.includes(value));
  if (modes.length !== 1 || !arg('revision') || !arg('review') || !arg('output')) throw new Error('BANK_UPGRADE_EXPLICIT_MODE_REVISION_REVIEW_OUTPUT_REQUIRED');
  prepareReviewedBankUpgrade({ mode: modes[0] === '--stage-contracts' ? 'stage_contracts' : modes[0] === '--run-live' ? 'prepare' : modes[0] === '--activate' ? 'activate' : 'check',
    revisionPath: arg('revision')!, reviewPath: arg('review')!, output: arg('output')!, maxLlmCalls: Number(arg('max-llm-calls') ?? 0), maxTtsCalls: Number(arg('max-tts-calls') ?? 0) }).then(report => {
      const completed = report as { failure?: string | null; summary?: unknown; activated: boolean; revisionPath: string; bankKey: string; llmRequests?: unknown[]; ttsRequests?: unknown[] };
      console.log(JSON.stringify({ revisionPath: completed.revisionPath, bankKey: completed.bankKey, failure: completed.failure ?? null, summary: completed.summary ?? null, activated: completed.activated, llmCalls: completed.llmRequests?.length ?? 0, ttsCalls: completed.ttsRequests?.length ?? 0 }));
      if (completed.failure) process.exitCode = 1;
    }).catch(() => { console.error('BANK_UPGRADE_FAILED_BEFORE_PROVIDER_OR_REPORT'); process.exitCode = 1; });
}
