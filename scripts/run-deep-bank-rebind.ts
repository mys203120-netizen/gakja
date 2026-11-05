/** Bounded offline execution. Source selection and activation are separate.
 * No branch in this module changes the active analysis pointer. */
import OpenAI from 'openai';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadInterviewContextAt, type InterviewContext } from '../server/data/load-interview-context';
import { loadStagedInterviewContextAt } from '../server/data/staged-interview-context';
import { FULL_ANALYSIS_CURRENT, analysisQAManifest, loadFullRecord, publishReviewedObjectiveContracts, type FullAnalysisBankReadiness, type ReviewedObjectiveContractCorrection } from '../server/data/full-student-analysis';
import { deepRebindDigest, deepRebindObjectiveContract, planDeepBankRebind, type DeepBankRebindRow } from '../server/data/deep-bank-rebind';
import { createPreparedQuestionReviewSession, loadQuestionBank, prepareQuestionBank, questionBankIdentity, type PreparedMainCandidate, type PreparedQuestionBank, type QuestionBankProviders } from '../server/data/prepared-question-bank';
import { loadApprovedRecoveryVariants, recoveryVariantIdentity, saveApprovedRecoveryVariants, type ApprovedRecoveryVariantFile } from '../server/data/approved-recovery-variants';
import { loadQuestionPurposeLineage, publishExactQuestionPurposeLineageRebind } from '../server/data/question-purpose-lineage';
import { approveQuestionContract, assertQuestionContractIntegrity, createQuestionBlueprint, type StudentObjectiveCandidate } from '../server/question-objective';
import { assertQuestionPresentation, attachVerifiedQuestionPlan } from '../server/providers/question-plan';
import { assertInterviewQuestionSpeech } from '../server/providers/interview-speech';
import { QUESTION_WORD_SPAN_RULES, QUESTION_SPAN_WIRE_VERSION, questionSpanPremiseReviewWireSchema, withAuthorizedQuestionReviewSources, buildQuestionSpanReviewPayload, materializeQuestionSpanPremiseReview, bindQuestionReviewSources } from '../server/providers/question-span-wire';
import { QUESTION_PREMISE_REVIEW_RULES, STABLE_PREMISE_PROOF_RULES, stableQuestionPremiseReviewSchema, buildQuestionPremiseReviewInput, finalizeQuestionPremiseReview, materializeStablePremiseReview, resolveVerifiedCommonPremiseAuthority, validateQuestionPremises } from '../server/providers/question-premises';
import { generateQuestion } from '../server/providers/openai';
import { buildRuntimeReviewPayload } from '../server/providers/natural-question';
import { readDurableSpeechAudio, speechAudioCacheId, synthesizeSpeech, type VoiceSettings } from '../server/providers/clova-tts';
import { aggregateProviderCosts, estimateProviderCost, normalizeProviderUsage, type ProviderUsageObservation } from '../server/observability/provider-cost';
import { QuestionValidationError, canonicalizeQuestionCitations } from '../server/providers/question-grounding';
import type { InterviewSession, QuestionDraft } from '../server/protocol';
import { OFFLINE_RECOVERY_GENERATION_INSTRUCTIONS, OFFLINE_RECOVERY_REVIEW_INSTRUCTIONS, OFFLINE_RECOVERY_REPORT_POLICY, prepareRuntimeRecoveryPool, recoveryOriginal } from './prepare-runtime-recovery-pool';
import { withReservedBankUpgradeReport } from './prepare-reviewed-bank-upgrade';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const same = (a: unknown, b: unknown) => deepRebindDigest(a) === deepRebindDigest(b);
const safeFailure = (error: unknown) => error instanceof QuestionValidationError ? error.code : error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : error instanceof Error ? error.name : 'DEEP_REBIND_OPERATION_FAILED';
export type DeepRebindExecutionPhase = 'retained' | 'calibration' | 'repair' | 'bank' | 'recovery' | 'gate';
export interface DeepRebindExecutionOptions {
  root?: string; phase: DeepRebindExecutionPhase; revisionPath: string; mappingPath: string; output: string;
  maxRetainedReviewCalls?: number; maxNewQuestionCalls?: number; maxNewQuestionTtsCalls?: number;
  maxNewRecoveryCalls?: number; maxNewRecoveryTtsCalls?: number; reviewModel: string;
  allowOneIncompleteWireRetry?: boolean;
  maxCalibrationCalls?: number;
  repairPlanPath?: string; maxRepairCalls?: number;
  recoveryRepairPlanPath?: string;
}
export function parseDeepRebindExecutionArgs(args: string[]): Omit<DeepRebindExecutionOptions, 'root'> {
  const names = ['phase', 'revision', 'mapping', 'output', 'review-model', 'max-retained-review-calls', 'max-calibration-calls', 'repair-plan', 'max-repair-calls', 'recovery-repair-plan', 'max-new-question-calls', 'max-new-question-tts-calls', 'max-new-recovery-calls', 'max-new-recovery-tts-calls'];
  if (args.filter(arg => arg === '--run-live').length !== 1 || args.filter(arg => arg === '--allow-one-incomplete-wire-retry').length > 1 || args.some(arg => arg !== '--run-live' && arg !== '--allow-one-incomplete-wire-retry' && !names.some(name => arg.startsWith(`--${name}=`)))) throw new Error('DEEP_REBIND_EXPLICIT_LIVE_PHASE_AND_CAPS_REQUIRED');
  const get = (name: string) => { const values = args.filter(arg => arg.startsWith(`--${name}=`)); if (values.length > 1) throw new Error('DEEP_REBIND_DUPLICATE_EXECUTION_ARGUMENT'); return values[0]?.slice(name.length + 3); };
  const phase = get('phase');
  if (!['retained', 'calibration', 'repair', 'bank', 'recovery', 'gate'].includes(phase ?? '') || ['revision', 'mapping', 'output', 'review-model'].some(name => !get(name))) throw new Error('DEEP_REBIND_EXPLICIT_LIVE_PHASE_AND_CAPS_REQUIRED');
  const cap = (name: string, required: boolean, maximum: number) => {
    const raw = get(name); if (!required && raw !== undefined || required && (!raw || !/^\d+$/u.test(raw))) throw new Error('DEEP_REBIND_EXPLICIT_LIVE_PHASE_AND_CAPS_REQUIRED');
    const value = Number(raw ?? 0); if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error('DEEP_REBIND_EXPLICIT_PHASE_CAP_OUT_OF_RANGE'); return value;
  };
  const allowOneIncompleteWireRetry = args.includes('--allow-one-incomplete-wire-retry');
  const retainedCap = cap('max-retained-review-calls', phase === 'retained', allowOneIncompleteWireRetry ? 31 : 30);
  if (allowOneIncompleteWireRetry && (phase !== 'retained' || retainedCap !== 31)) throw new Error('DEEP_REBIND_EXPLICIT_SINGLE_WIRE_RETRY_REQUIRES_CAP_31');
  if ((phase === 'repair') !== Boolean(get('repair-plan'))) throw new Error('DEEP_REBIND_EXPLICIT_REPAIR_PLAN_REQUIRED');
  if (get('recovery-repair-plan') && phase !== 'recovery') throw new Error('DEEP_REBIND_RECOVERY_REPAIR_PHASE_REQUIRED');
  return { phase: phase as DeepRebindExecutionPhase, revisionPath: get('revision')!, mappingPath: get('mapping')!, output: get('output')!, reviewModel: get('review-model')!, allowOneIncompleteWireRetry,
    maxRetainedReviewCalls: retainedCap,
    maxCalibrationCalls: cap('max-calibration-calls', phase === 'calibration', 5),
    repairPlanPath: get('repair-plan'), maxRepairCalls: cap('max-repair-calls', phase === 'repair', 8),
    maxNewQuestionCalls: cap('max-new-question-calls', phase === 'bank', 24), maxNewQuestionTtsCalls: cap('max-new-question-tts-calls', phase === 'bank', 6),
    recoveryRepairPlanPath: get('recovery-repair-plan'), maxNewRecoveryCalls: cap('max-new-recovery-calls', phase === 'recovery', 77), maxNewRecoveryTtsCalls: cap('max-new-recovery-tts-calls', phase === 'recovery', 34) };
}
export interface StoredReview {
  candidateId: string; objectiveId: string; model: string; inputSha256: string; questionSha256: string;
  requestPath: string; requestFileSha256: string; responsePath: string; responseFileSha256: string;
  review: unknown; status: 'approved' | 'rejected'; failureCode: string | null;
  wireVersion?: 'stable-proof-id-v1';
}
export interface RetainedArtifact {
  version: 'deep-bank-fresh-retained-review-v1'; sourceStagePath: string; sourceStageFileSha256: string; mappingPath: string; mappingFileSha256: string;
  donorBankKey: string; donorBankContentSha256: string; donorBankFileSha256: string; sourceCommonSha256: string; sourceTargetSha256: string;
  reviewedAt: string; recordReviewModel: string; commonReviewModel: string; reviews: StoredReview[];
  calibration?: { version: 'same-input-instruction-calibration-v1'; parentArtifactSha256: string; calibratedCandidateIds: string[]; preservedApprovedCount: number; instructionsSha256: string };
}
interface RetainedPublication { sourceArtifactPath: string; sourceArtifactFileSha256: string; derivedRevisionPath: string; derivedTargetSha256: string }
export interface DeepRepairPlan { version: 'explicit-checkpoint-question-repair-v1'; commonContentSha256: string; targetContentSha256: string;
  sourceOverlay?: { reportPath: string; reportFileSha256: string };
  items: Array<{ objectiveId: string; action: 'review_checkpoint' | 'regenerate_once' | 'review_approved_cache'; candidatePath: string; candidateFileSha256: string;
    feedback: { questionText: string; failureCode: string; reviewSummary: string } }> }
interface DeepRepairArtifact { version: 'actual-checkpoint-question-repair-v1'; commonContentSha256: string; baseTargetContentSha256: string; planPath: string; planFileSha256: string;
  approved: Array<{ objectiveId: string; model: string; binding: string; draft: QuestionDraft; inputSha256: string; requestPath: string | null; responsePath: string | null }>; reviewedAt: string }
export interface DeepRecoveryRepairPlan { version: 'actual-failed-recovery-once-plan-v1'; sourceReportPath: string; sourceReportFileSha256: string; bankKey: string; bankContentSha256: string;
  providedProposalsReview?: { remainingDefectsReportPath: string; remainingDefectsReportFileSha256: string; targetContentSha256: string; authorship: 'codex-offline-source-and-demand-reviewed-proposal'; approvalAuthority: 'none' };
  items: Array<{ candidateId: string; action: 'regenerate_once' | 'retry_review_once' | 'provided_candidate'; failedRequestPath?: string; failedRequestFileSha256?: string; questionText?: string; originalQuestionSha256?: string }> }
export function validateDeepRecoveryRepairPlan(plan: DeepRecoveryRepairPlan, source: Record<string, any>, bank: PreparedQuestionBank, missing: string[]) {
  const proposals = plan.items.length === 2 && plan.items.every(item => item.action === 'provided_candidate') && plan.providedProposalsReview?.authorship === 'codex-offline-source-and-demand-reviewed-proposal' && plan.providedProposalsReview.approvalAuthority === 'none';
  const retryBatch = plan.items.length === 4 && plan.items.filter(item => item.action === 'regenerate_once').length === 3 && plan.items.filter(item => item.action === 'retry_review_once').length === 1 && !plan.providedProposalsReview;
  if (plan.version !== 'actual-failed-recovery-once-plan-v1' || plan.bankKey !== bank.key || plan.bankContentSha256 !== bank.contentSha256 || source.bankKey !== bank.key || source.bankContentSha256 !== bank.contentSha256 || !source.newRecovery?.completedAt || !proposals && !retryBatch || new Set(plan.items.map(item => item.candidateId)).size !== plan.items.length) throw new Error('DEEP_REBIND_RECOVERY_REPAIR_PLAN_INVALID');
  return plan.items.map(item => {
    const row = source.newRecovery.questions.find((value: Record<string, any>) => value.candidateId === item.candidateId), trial = row?.attempts?.at(-1);
    const candidate = bank.slots.flatMap(slot => slot.candidates).find(candidate => candidate.id === item.candidateId);
    if (!candidate || !row || !missing.includes(item.candidateId) || row.ready || row.question !== candidate.draft.questionText || !trial?.failure || item.action === 'regenerate_once' && !trial.review || item.action === 'retry_review_once' && (trial.review || !item.failedRequestPath || !/^[a-f0-9]{64}$/u.test(item.failedRequestFileSha256 ?? '')) || item.action === 'provided_candidate' && (!trial.review || !item.questionText || item.questionText.length < 8 || item.questionText.length > 80 || item.originalQuestionSha256 !== sha(candidate.draft.questionText))) throw new Error('DEEP_REBIND_RECOVERY_REPAIR_NOT_AN_ACTUAL_FAILED_CASE');
    return { ...item, candidate, trial };
  });
}
export function deepProviderErrorDiagnostics(error: unknown) {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  return Object.fromEntries(['status', 'code', 'type', 'request_id', 'requestId'].flatMap(key => typeof value[key] === 'number' || typeof value[key] === 'string' && (value[key] as string).length <= 180 ? [[key, value[key]]] : []));
}

/** CLI requests are sequential and protected by a generation lock. Reserving a
 * request counts even when the provider fails or the process later exits. */
export class DeepRebindCallBudget {
  constructor(readonly directory: string, readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error('DEEP_REBIND_INVALID_CALL_CAP');
  }
  used() { return readdirSync(this.directory).filter(name => name.endsWith('.request.json')).length; }
  reserve(stage: string, request: unknown) {
    const count = this.used(); if (count >= this.maximum) throw new Error('DEEP_REBIND_PHYSICAL_CALL_CAP_REACHED');
    const file = path.join(this.directory, `${String(count + 1).padStart(3, '0')}-${stage}.request.json`);
    writeFileSync(file, JSON.stringify({ stage, reservedAt: new Date().toISOString(), request }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return file;
  }
}
export async function deepRebindCumulativeUsage(job: string) {
  const observations: Array<{ stage: string; requestFile: string; observation: ProviderUsageObservation }> = [];
  for (const stage of ['retained-calls', 'calibration-calls', 'repair-calls', 'new-q0-calls', 'new-recovery-calls']) {
    const directory = path.join(job, stage), files = await readdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; });
    for (const file of files.filter(file => file.endsWith('.request.json')).sort()) {
      const request = JSON.parse(await readFile(path.join(directory, file), 'utf8')) as { request: { model?: string; request?: { model?: string } } };
      const response = await optionalJson<unknown>(path.join(directory, file.replace('.request.json', '.response.json')));
      const observed = await optionalJson<{ observation: ProviderUsageObservation }>(path.join(directory, file.replace('.request.json', '.observation.json')));
      const model = request.request.model ?? request.request.request?.model ?? 'unknown';
      observations.push({ stage, requestFile: `${stage}/${file}`, observation: observed?.observation ?? normalizeProviderUsage(response, { requestedModel: model, requestedServiceTier: 'default' }) });
    }
  }
  return { scope: 'All reserved LLM requests in this immutable generation, including previous commands and failed/unknown attempts; provider usage is not an invoice.',
    requests: observations, cost: aggregateProviderCosts(observations.map(item => estimateProviderCost(item.observation))) };
}
export async function withDeepRebindGenerationLock<T>(directory: string, operation: () => Promise<T>) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'execution.lock'), token = randomUUID();
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = JSON.parse(await readFile(file, 'utf8')) as { pid?: number };
    let stale = false;
    if (Number.isSafeInteger(owner.pid) && owner.pid! > 0) try { process.kill(owner.pid!, 0); } catch (probe) { stale = (probe as NodeJS.ErrnoException).code === 'ESRCH'; }
    if (!stale) throw new Error('DEEP_REBIND_GENERATION_IS_LOCKED');
    await unlink(file); handle = await open(file, 'wx', 0o600);
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync(); return await operation(); }
  finally { await handle.close(); const owner = JSON.parse(await readFile(file, 'utf8')) as { token?: string }; if (owner.token === token) await unlink(file); }
}
async function immutableJson(file: string, value: unknown) {
  const bytes = JSON.stringify(value, null, 2) + '\n'; await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || (await readFile(file, 'utf8')) !== bytes) throw error; }
}
const optionalJson = async <T>(file: string): Promise<T | null> => { try { return JSON.parse(await readFile(file, 'utf8')) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } };
const relative = (root: string, file: string) => path.relative(root, file).replaceAll('\\', '/');

async function verifiedInputs(options: DeepRebindExecutionOptions, root: string) {
  const oldContext = await loadInterviewContextAt(root, { writeManifest: false }), bank = await loadQuestionBank(oldContext, { root });
  if (!bank || oldContext.errors.length) throw new Error('DEEP_REBIND_APPROVED_DONOR_BANK_REQUIRED');
  const { context, staged } = await loadStagedInterviewContextAt(root, options.revisionPath, { writeManifest: false });
  const source = await loadFullRecord(root, oldContext.student.pdfSha256); if (!source) throw new Error('DEEP_REBIND_FULL_RECORD_REQUIRED');
  const stageBytes = await readFile(path.resolve(root, staged.revisionPath)), mappingBytes = await readFile(path.resolve(root, options.mappingPath));
  const mapping = JSON.parse(mappingBytes.toString('utf8')) as { version?: string; donorBankKey?: string; donorBankContentSha256?: string; stagedRevisionFileSha256?: string; stagedCommonContentSha256?: string; stagedTargetContentSha256?: string; rows?: DeepBankRebindRow[] };
  const identity = questionBankIdentity(context), plan = await planDeepBankRebind({ oldContext, stagedContext: context, bank, stagedPlan: identity.plan, stagedVoices: identity.voices, source }, root);
  if (mapping.version !== plan.version || mapping.donorBankKey !== bank.key || mapping.donorBankContentSha256 !== bank.contentSha256 || mapping.stagedRevisionFileSha256 !== sha(stageBytes) || mapping.stagedCommonContentSha256 !== plan.stagedCommonContentSha256 || mapping.stagedTargetContentSha256 !== plan.stagedTargetContentSha256 || !same(mapping.rows, plan.rows)) throw new Error('DEEP_REBIND_MAPPING_REPORT_STALE');
  const oldIds = new Set(bank.slots.flatMap(row => row.candidates.map(() => bank.plan.slots.find(slot => slot.id === row.slotId)!.objective!.id)));
  if (identity.plan.slots.some(slot => !slot.objective)) throw new Error('DEEP_REBIND_TARGET_OBJECTIVE_REQUIRED');
  const newIds = identity.plan.slots.filter(slot => !oldIds.has(slot.objective!.id)).map(slot => slot.objective!.id);
  if (newIds.length > 6) throw new Error('DEEP_REBIND_REQUIRES_EXPLICIT_OLD_28_PLUS_MAX_6_TARGET_SELECTION');
  const allOldIds = bank.slots.flatMap(row => row.candidates.map(() => bank.plan.slots.find(slot => slot.id === row.slotId)!.objective!.id));
  if (allOldIds.some(id => !identity.plan.slots.some(slot => slot.objective?.id === id))) throw new Error('DEEP_REBIND_SELECTED_STAGE_IS_MISSING_RETAINED_OBJECTIVE');
  const protectedPaths = [FULL_ANALYSIS_CURRENT, `data/prepared/question-banks/${bank.key}.json`, oldContext.manifest.files.find(file => file.role === 'fullStudentAnalysis')!.path];
  const protectedFiles = await Promise.all(protectedPaths.map(async file => ({ file, sha256: sha(await readFile(path.resolve(root, file))) })));
  return { oldContext, bank, context, staged, source, stageBytes, mappingBytes, plan, identity, newIds, protectedFiles };
}

export async function verifyStoredDeepReviewFiles(root: string, row: DeepBankRebindRow, stored: StoredReview) {
  const safe = (relativePath: string) => { const resolved = path.resolve(root, relativePath), within = path.relative(path.resolve(root, 'data/prepared/deep-bank-rebind-jobs'), resolved); if (!within || within.startsWith('..') || path.isAbsolute(within)) throw new Error('DEEP_REBIND_REVIEW_ARTIFACT_PATH_INVALID'); return resolved; };
  const [requestBytes, responseBytes] = await Promise.all([readFile(safe(stored.requestPath)), readFile(safe(stored.responsePath))]);
  const request = JSON.parse(requestBytes.toString('utf8')) as { request: { candidateId: string; request: { model: string; input: string } } };
  const response = JSON.parse(responseBytes.toString('utf8')) as { status?: string; output_parsed?: unknown };
  const expectedPayload = stored.wireVersion ? deepRetainedStablePayload(row) : { ...row.reviewInput, currentSourceContext: row.currentMeaningContext };
  const canonicalReview = stored.wireVersion && response.output_parsed ? materializeStablePremiseReview(response.output_parsed, row.reviewInput!) : response.output_parsed;
  if (sha(requestBytes) !== stored.requestFileSha256 || sha(responseBytes) !== stored.responseFileSha256 || request.request.candidateId !== stored.candidateId || request.request.request.model !== stored.model ||
    request.request.request.input !== JSON.stringify(expectedPayload) || response.status !== 'completed' || !same(canonicalReview, stored.review)) throw new Error('DEEP_REBIND_REVIEW_ARTIFACT_HASH_CHANGED');
  let rejected: string | null = null;
  try { validateStoredDeepReview(row, stored, stored.model); } catch (error) { if (!(error instanceof QuestionValidationError)) throw error; rejected = error.code; }
  if (rejected ? stored.status !== 'rejected' || stored.failureCode !== rejected : stored.status !== 'approved' || stored.failureCode !== null) throw new Error('DEEP_REBIND_REVIEW_VERDICT_CHANGED');
}
export function deepRetainedStablePayload(row: DeepBankRebindRow) {
  if (!row.reviewInput) throw new Error('DEEP_REBIND_CURRENT_SOURCE_REVIEW_INPUT_REQUIRED');
  return { ...buildRuntimeReviewPayload(row.reviewInput), currentSourceContext: row.currentMeaningContext };
}

/** Only an explicitly authorized single legacy-wire truncation can be retried.
 * Raw incomplete output is preserved and never materialized as an approval. */
export async function authorizeDeepIncompleteWireRetry(job: string, row: DeepBankRebindRow, model: string, previousRequests: string[], permitted: boolean) {
  if (!permitted || previousRequests.length !== 1) throw new Error('DEEP_REBIND_PREVIOUS_REQUEST_WITHOUT_FINAL_RESULT_REQUIRES_REVIEW');
  const requestPath = previousRequests[0], responsePath = requestPath.replace('.request.json', '.response.json');
  const requestBytes = await readFile(requestPath), responseBytes = await readFile(responsePath);
  const request = JSON.parse(requestBytes.toString('utf8')) as { request: { candidateId: string; request: { model: string; input: string; text?: { format?: { name?: string } } } } };
  const response = JSON.parse(responseBytes.toString('utf8')) as { status?: string; output_parsed?: unknown; incomplete_details?: { reason?: string } };
  if (request.request.candidateId !== row.oldCandidateId || request.request.request.model !== model || request.request.request.input !== JSON.stringify({ ...row.reviewInput, currentSourceContext: row.currentMeaningContext }) ||
    request.request.request.text?.format?.name !== 'deep_current_source_premise_review' || response.status !== 'incomplete' || response.incomplete_details?.reason !== 'max_output_tokens' || response.output_parsed != null) throw new Error('DEEP_REBIND_ONLY_LEGACY_WIRE_OUTPUT_TRUNCATION_CAN_RETRY');
  const note = { version: 'explicit-single-legacy-wire-retry-v1', candidateId: row.oldCandidateId, originalRequestFile: path.basename(requestPath), originalRequestSha256: sha(requestBytes), originalResponseSha256: sha(responseBytes),
    incompleteOutputNotApproved: true, maximumExtraPhysicalRequests: 1, totalRetainedCap: 31, newWireVersion: 'stable-proof-id-v1', canonicalSourceInputSha256: deepRebindDigest({ ...row.reviewInput, currentSourceContext: row.currentMeaningContext }) };
  await immutableJson(path.join(job, 'authorized-incomplete-wire-retry.json'), note); return note;
}

/** Response reuse is allowed only for the exact captured request. This function
 * performs the ordinary independent-review proof finalizer, never self-approval. */
export function validateStoredDeepReview(row: DeepBankRebindRow, stored: StoredReview, model: string) {
  const actualInput = { ...row.reviewInput, currentSourceContext: row.currentMeaningContext };
  if (!row.reviewInput || stored.candidateId !== row.oldCandidateId || stored.objectiveId !== row.oldObjectiveId || stored.questionSha256 !== row.questionSha256 || stored.model !== model || stored.inputSha256 !== deepRebindDigest(actualInput)) throw new Error('DEEP_REBIND_REVIEW_SOURCE_BINDING_CHANGED');
  return finalizeQuestionPremiseReview(stored.review, row.reviewInput, stored.model);
}

/** Make a fresh current-source draft only after an actual stored independent
 * response is revalidated. Old contracts/approval trace are never copied. */
export function rebuildDeepReboundDraft(original: PreparedMainCandidate, row: DeepBankRebindRow, stored: StoredReview, context: InterviewContext, session: InterviewSession) {
  const slot = session.plan!.slots[session.turns.length], objective = slot?.objective;
  if (!objective || objective.id !== row.oldObjectiveId || original.id !== row.oldCandidateId || objective.questionIntent !== original.draft.questionIntent || !same(objective.targetEvidence, original.draft.targetEvidence) || objective.primaryFunction !== original.draft.primaryFunction || objective.depth !== original.draft.depth) throw new Error('DEEP_REBIND_FRESH_TARGET_CONTRACT_CHANGED');
  if (!row.currentMeaningContext || !same(deepRebindObjectiveContract(objective), deepRebindObjectiveContract(row.currentMeaningContext.objective))) throw new Error('DEEP_REBIND_FRESH_TARGET_MEANING_CONTEXT_CHANGED');
  const draft = structuredClone(original.draft); delete draft.approvedQuestion; delete draft.questionBlueprint; delete draft.premiseValidation;
  const input = buildQuestionPremiseReviewInput(draft, context.student.evidence.filter(source => draft.evidenceIds.includes(source.id)), undefined, undefined, [], resolveVerifiedCommonPremiseAuthority(context, draft));
  if (!same(input, row.reviewInput)) throw new Error('DEEP_REBIND_CURRENT_REVIEW_INPUT_CHANGED');
  draft.premiseValidation = validateStoredDeepReview(row, stored, stored.model);
  attachVerifiedQuestionPlan(draft, session);
  draft.questionBlueprint = createQuestionBlueprint(draft, context, session, { objectiveCandidate: objective, strategyIds: draft.strategyTrace?.candidateCardIds ?? [], targetDescription: draft.targetEvidence[0], expansionRationale: objective.scope === 'record_grounded_extension' ? objective.selectionBasis : null });
  draft.approvedQuestion = approveQuestionContract(draft, draft.questionBlueprint, { policyDigest: context.interviewerPolicy?.contentSha256, strategyCatalogDigest: context.questionStrategies?.contentSha256 });
  return draft;
}

export function deepNewQuestionCacheBinding(context: InterviewContext, objective: StudentObjectiveCandidate, excludedQuestionTexts: string[]) {
  return deepRebindDigest({ commonContentSha256: context.studentAnalysis?.contentSha256, sourcePdfSha256: context.student.pdfSha256,
    target: context.target, policy: context.interviewerPolicy?.contentSha256, strategy: context.questionStrategies?.contentSha256,
    objective: deepRebindObjectiveContract(objective), sources: context.student.evidence.filter(source => objective.evidenceIds.includes(source.id)), excludedQuestionTexts });
}
export function assertDeepApprovedCacheRebind(oldContext: InterviewContext, context: InterviewContext, oldObjective: StudentObjectiveCandidate, objective: StudentObjectiveCandidate, draft: QuestionDraft) {
  if (!oldContext.studentAnalysis || !context.studentAnalysis || !draft.approvedQuestion || !same(deepRebindObjectiveContract(oldObjective), deepRebindObjectiveContract(objective)) || oldContext.studentAnalysis.contentSha256 !== context.studentAnalysis.contentSha256 ||
    !same(oldContext.target, context.target) || oldContext.interviewerPolicy?.contentSha256 !== context.interviewerPolicy?.contentSha256 || oldContext.questionStrategies?.contentSha256 !== context.questionStrategies?.contentSha256) throw new Error('DEEP_REBIND_APPROVED_CACHE_SCOPE_CHANGED');
  assertQuestionContractIntegrity(draft, draft.approvedQuestion);
  const input = (ctx: InterviewContext) => buildQuestionPremiseReviewInput(structuredClone(draft), ctx.student.evidence.filter(source => draft.evidenceIds.includes(source.id)), undefined, undefined, [], resolveVerifiedCommonPremiseAuthority(ctx, draft));
  if (!same(input(oldContext), input(context))) throw new Error('DEEP_REBIND_APPROVED_CACHE_SOURCE_CHANGED');
}
export function mergeCalibratedDeepReviews(original: RetainedArtifact, calibrated: StoredReview[], parentArtifactSha256: string, reviewedAt: string, instructionsSha256: string): RetainedArtifact {
  const rejected = original.reviews.filter(review => review.status === 'rejected');
  if (rejected.length > 5 || calibrated.length !== rejected.length || new Set(calibrated.map(review => review.candidateId)).size !== calibrated.length) throw new Error('DEEP_REBIND_CALIBRATION_COHORT_INVALID');
  for (const current of calibrated) {
    const prior = rejected.find(review => review.candidateId === current.candidateId);
    if (!prior || current.objectiveId !== prior.objectiveId || current.inputSha256 !== prior.inputSha256 || current.questionSha256 !== prior.questionSha256 || current.model !== prior.model) throw new Error('DEEP_REBIND_CALIBRATION_CHANGED_ORIGINAL_INPUT');
  }
  const replacements = new Map(calibrated.map(review => [review.candidateId, review]));
  return { ...original, reviewedAt, reviews: original.reviews.map(review => replacements.get(review.candidateId) ?? review),
    calibration: { version: 'same-input-instruction-calibration-v1', parentArtifactSha256, calibratedCandidateIds: calibrated.map(review => review.candidateId), preservedApprovedCount: original.reviews.filter(review => review.status === 'approved').length, instructionsSha256 } };
}

export function validateDeepRepairPlan(value: DeepRepairPlan, context: InterviewContext) {
  if (value.version !== 'explicit-checkpoint-question-repair-v1' || value.commonContentSha256 !== context.studentAnalysis?.contentSha256 || value.targetContentSha256 !== context.targetAnalysis?.contentSha256 || ![4, 5].includes(value.items.length) ||
    new Set(value.items.map(item => item.objectiveId)).size !== value.items.length || value.items.filter(item => item.action === 'regenerate_once').length !== 1 || value.items.filter(item => item.action === 'review_checkpoint').length !== 3 || value.items.filter(item => item.action === 'review_approved_cache').length !== value.items.length - 4 || value.items.some(item => !context.targetAnalysis?.objectives.some(objective => objective.id === item.objectiveId) || !/^[a-f0-9]{64}$/u.test(item.candidateFileSha256) || !item.feedback.questionText.trim() || item.feedback.questionText.length > 320 || !item.feedback.failureCode.trim() || item.feedback.failureCode.length > 80 || !item.feedback.reviewSummary.trim() || item.feedback.reviewSummary.length > 700)) throw new Error('DEEP_REBIND_REPAIR_PLAN_INVALID');
}
export function assertDeepRepairOverlayEquivalent(base: InterviewContext, current: InterviewContext, objectiveId: string, addedEvidenceIds: string[]) {
  if (!same(base.studentAnalysis, current.studentAnalysis) || !same(base.student.evidence, current.student.evidence) || base.targetAnalysis!.objectives.length !== current.targetAnalysis!.objectives.length || !addedEvidenceIds.length || new Set(addedEvidenceIds).size !== addedEvidenceIds.length) throw new Error('DEEP_REBIND_REPAIR_OVERLAY_SOURCE_CHANGED');
  for (const previous of base.targetAnalysis!.objectives) {
    const objective = current.targetAnalysis!.objectives.find(value => value.id === previous.id);
    if (!objective) throw new Error('DEEP_REBIND_REPAIR_OVERLAY_OBJECTIVE_CHANGED');
    if (previous.id !== objectiveId) { if (!same(previous, objective)) throw new Error('DEEP_REBIND_REPAIR_OVERLAY_OTHER_OBJECTIVE_CHANGED'); continue; }
    const demand = (value: StudentObjectiveCandidate) => { const result = { ...deepRebindObjectiveContract(value) } as Record<string, unknown>; delete result.evidenceIds; delete result.anchorRefs; delete result.knownFacts; return result; };
    if (!same(demand(previous), demand(objective)) || !same(objective.evidenceIds, [...previous.evidenceIds, ...addedEvidenceIds]) || addedEvidenceIds.some(id => !base.student.evidence.some(source => source.id === id))) throw new Error('DEEP_REBIND_REPAIR_OVERLAY_DEMAND_OR_SOURCE_CHANGED');
  }
}
async function loadDeepRepairBase(root: string, publication: RetainedPublication, planPath: string) {
  const bytes = await readFile(path.resolve(root, planPath)), plan = JSON.parse(bytes.toString('utf8')) as DeepRepairPlan;
  const base = await loadStagedInterviewContextAt(root, publication.derivedRevisionPath, { writeManifest: false });
  if (!plan.sourceOverlay) return base;
  const reportBytes = await readFile(path.resolve(root, plan.sourceOverlay.reportPath));
  if (sha(reportBytes) !== plan.sourceOverlay.reportFileSha256) throw new Error('DEEP_REBIND_REPAIR_OVERLAY_REPORT_CHANGED');
  const report = JSON.parse(reportBytes.toString('utf8')) as { version: string; revisionPath: string; revisionFileSha256: string; parentPath: string; parentFileSha256: string; parentTargetContentSha256: string; targetContentSha256: string; artifactPath: string; artifactSha256: string; objectiveId: string; addedEvidenceIds: string[]; questionsApproved: number; activated: boolean };
  if (report.version !== 'academic-objective-source-closure-staged-v1' || path.resolve(root, report.parentPath) !== path.resolve(root, publication.derivedRevisionPath) || report.parentTargetContentSha256 !== publication.derivedTargetSha256 || sha(await readFile(path.resolve(root, report.parentPath))) !== report.parentFileSha256 || sha(await readFile(path.resolve(root, report.revisionPath))) !== report.revisionFileSha256 || sha(await readFile(path.resolve(root, report.artifactPath))) !== report.artifactSha256 || report.questionsApproved !== 0 || report.activated) throw new Error('DEEP_REBIND_REPAIR_OVERLAY_PIN_INVALID');
  const current = await loadStagedInterviewContextAt(root, report.revisionPath, { writeManifest: false });
  if (current.staged.target.contentSha256 !== report.targetContentSha256) throw new Error('DEEP_REBIND_REPAIR_OVERLAY_TARGET_CHANGED');
  assertDeepRepairOverlayEquivalent(base.context, current.context, report.objectiveId, report.addedEvidenceIds);
  return current;
}
function reviewOnlyReferenceTrace(draft: QuestionDraft, context: InterviewContext) {
  if (context.questionReferences) draft.questionReferenceContext = { schemaVersion: context.questionReferences.schemaVersion, catalogSha256: context.questionReferences.digest,
    exampleIds: [], purpose: 'wording_reference_only', analysisKey: context.questionReferences.analysis?.key, referenceUses: [] };
  if (context.questionStrategies) draft.strategyTrace = { catalogDigest: context.questionStrategies.contentSha256, selectedCardId: null, candidateCardIds: [], sourceQuestionIds: [], policyVersion: context.questionStrategies.policyVersion,
    selectionReason: '미검수 관찰 시점에 포함되지 않은 과거 생성 카드 선택을 꾸며내지 않는다. 이번 원문·목적 독립 검수에는 새 카드 참조를 주장하지 않으며 원 생성 request/source SHA를 별도 보존한다.' };
}
async function executeDeepCheckpointRepair(options: DeepRebindExecutionOptions, context: InterviewContext, job: string, root: string, report: Record<string, any>, progress: () => Promise<void>) {
  if (!options.repairPlanPath) throw new Error('DEEP_REBIND_EXPLICIT_REPAIR_PLAN_REQUIRED');
  const planBytes = await readFile(path.resolve(root, options.repairPlanPath)), plan = JSON.parse(planBytes.toString('utf8')) as DeepRepairPlan;
  validateDeepRepairPlan(plan, context);
  const artifactFile = path.join(job, 'repair-approved-questions.json'), complete = await optionalJson<DeepRepairArtifact>(artifactFile);
  if (complete) { if (complete.planFileSha256 !== sha(planBytes) || complete.baseTargetContentSha256 !== context.targetAnalysis!.contentSha256) throw new Error('DEEP_REBIND_REPAIR_COMPLETED_SOURCE_CHANGED'); return { artifact: complete, artifactFile }; }
  const directory = path.join(job, 'repair-calls'); await mkdir(directory, { recursive: true }); const budget = new DeepRebindCallBudget(directory, options.maxRepairCalls ?? 0);
  const identity = questionBankIdentity(context), approved: DeepRepairArtifact['approved'] = [];
  for (const item of plan.items) {
    const slot = identity.plan.slots.find(slot => slot.objective?.id === item.objectiveId)!;
    const checkpointFile = path.resolve(root, item.candidatePath), within = path.relative(job, checkpointFile);
    if (!within || within.startsWith('..') || path.isAbsolute(within)) throw new Error('DEEP_REBIND_REPAIR_CHECKPOINT_OUTSIDE_GENERATION');
    const bytes = await readFile(checkpointFile); if (sha(bytes) !== item.candidateFileSha256) throw new Error('DEEP_REBIND_REPAIR_CHECKPOINT_HASH_CHANGED');
    let checkpoint = JSON.parse(bytes.toString('utf8')) as { objectiveId: string; candidateObservation: { draft: QuestionDraft; draftSha256: string; requestSha256: string; sourceSha256: string; approvalAuthority: string } };
    if (item.action === 'review_approved_cache') {
      // The SHA-pinned cached utterance is a newly submitted UNAPPROVED
      // proposal. Its old approval/binding grants no authority in this path.
      const cached = JSON.parse(bytes.toString('utf8')) as { draft: QuestionDraft };
      checkpoint = { objectiveId: item.objectiveId, candidateObservation: { draft: cached.draft, draftSha256: sha(JSON.stringify(cached.draft)), requestSha256: '', sourceSha256: '', approvalAuthority: 'none' } };
    }
    if (checkpoint.objectiveId !== item.objectiveId || checkpoint.candidateObservation.approvalAuthority !== 'none' || sha(JSON.stringify(checkpoint.candidateObservation.draft)) !== checkpoint.candidateObservation.draftSha256) throw new Error('DEEP_REBIND_REPAIR_PROPOSAL_BINDING_INVALID');
    if (checkpoint.candidateObservation.draft.questionText !== item.feedback.questionText) throw new Error('DEEP_REBIND_REPAIR_FEEDBACK_QUESTION_CHANGED');
    const resultPath = path.join(job, `repair-approved-${item.objectiveId}.json`), cached = await optionalJson<DeepRepairArtifact['approved'][number]>(resultPath);
    if (cached) { if (cached.binding !== deepNewQuestionCacheBinding(context, slot.objective!, [])) throw new Error('DEEP_REBIND_REPAIR_APPROVAL_SOURCE_CHANGED'); assertQuestionContractIntegrity(cached.draft, cached.draft.approvedQuestion!); approved.push(cached); continue; }
    for (const file of (await readdir(directory)).filter(file => file.endsWith('.request.json'))) {
      const previous = JSON.parse(await readFile(path.join(directory, file), 'utf8')) as { request: { objectiveId?: string } };
      if (previous.request.objectiveId === item.objectiveId) throw new Error('DEEP_REBIND_REPAIR_PREVIOUS_UNAPPROVED_REQUEST_REQUIRES_REVIEW');
    }
    const session = createPreparedQuestionReviewSession(context, identity.plan, [], slot);
    let draft: QuestionDraft, requestPath: string | null = null, responsePath: string | null = null, inputSha256 = '';
    if (item.action === 'regenerate_once') {
      let currentRequest: string | undefined;
      draft = await generateQuestion(context, session, false, true, undefined, { maxRetries: 0, maxCandidateAttempts: 1, previousCandidateReview: item.feedback,
        beforeProviderRequest: stage => { currentRequest = budget.reserve(stage, { model: identity.questionModel, objectiveId: item.objectiveId, sourceManifest: context.manifest, feedback: item.feedback }); },
        onCandidate: event => immutableJson(currentRequest!.replace('.request.json', '.candidate.json'), { version: 'unreviewed-repair-generation-v1', objectiveId: item.objectiveId, candidateObservation: event, bankApprovalGranted: false }),
        onProviderUsage: event => { report.usage.push(event); if (currentRequest) writeFileSync(currentRequest.replace('.request.json', '.observation.json'), JSON.stringify(event, null, 2), { flag: 'wx', mode: 0o600 }); } });
      inputSha256 = deepNewQuestionCacheBinding(context, slot.objective!, []);
    } else {
      draft = structuredClone(checkpoint.candidateObservation.draft); delete draft.approvedQuestion; delete draft.questionBlueprint; delete draft.premiseValidation;
      canonicalizeQuestionCitations(draft, context.student.evidence.filter(source => slot.evidenceIds.includes(source.id))); assertQuestionPresentation(draft); assertInterviewQuestionSpeech(draft.questionText, { isFirstTurn: false });
      attachVerifiedQuestionPlan(draft, session, { independentReviewFollows: true });
      const initial = buildQuestionPremiseReviewInput(draft, context.student.evidence.filter(source => draft.evidenceIds.includes(source.id)));
      const input = withAuthorizedQuestionReviewSources(initial, context.student.evidence, slot.evidenceIds), payload = { ...buildQuestionSpanReviewPayload(input), previousCandidateReview: item.feedback,
        proposalProvenance: { candidateArtifactFileSha256: item.candidateFileSha256, priorApprovalNotReused: true,
          originalGeneration: item.action === 'review_approved_cache' ? null : { requestSha256: checkpoint.candidateObservation.requestSha256, sourceSha256: checkpoint.candidateObservation.sourceSha256, draftSha256: checkpoint.candidateObservation.draftSha256 } } };
      const request = { model: options.reviewModel, service_tier: 'default' as const, store: false, reasoning: { effort: 'low' as const }, instructions: QUESTION_PREMISE_REVIEW_RULES + STABLE_PREMISE_PROOF_RULES + QUESTION_WORD_SPAN_RULES,
        input: JSON.stringify(payload), text: { format: zodTextFormat(questionSpanPremiseReviewWireSchema, 'deep_checkpoint_source_review_v2') }, max_output_tokens: 4000 };
      const native = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 90000 });
      requestPath = budget.reserve('checkpoint-review', { objectiveId: item.objectiveId, candidateFileSha256: item.candidateFileSha256, request }); responsePath = requestPath.replace('.request.json', '.response.json'); await progress();
      const response = await native.responses.parse(request); await immutableJson(responsePath, response);
      report.usage.push({ stage: 'repair_review', observation: normalizeProviderUsage(response, { requestedModel: options.reviewModel, requestedServiceTier: 'default' }) });
      if (response.status !== 'completed' || !response.output_parsed) throw new Error('DEEP_REBIND_REPAIR_REVIEW_INCOMPLETE');
      const canonical = materializeQuestionSpanPremiseReview(response.output_parsed, input);
      await immutableJson(requestPath.replace('.request.json', '.canonical-review.json'), canonical);
      draft = bindQuestionReviewSources(draft, canonical, input);
      await validateQuestionPremises({ draft, sources: input.sources, reviewModel: options.reviewModel, requestReview: async () => canonical });
      reviewOnlyReferenceTrace(draft, context); attachVerifiedQuestionPlan(draft, session);
      draft.questionBlueprint = createQuestionBlueprint(draft, context, session, { objectiveCandidate: slot.objective!, strategyIds: [], targetDescription: draft.targetEvidence[0], expansionRationale: slot.objective!.scope === 'record_grounded_extension' ? slot.objective!.selectionBasis : null });
      draft.approvedQuestion = approveQuestionContract(draft, draft.questionBlueprint, { policyDigest: context.interviewerPolicy?.contentSha256, strategyCatalogDigest: context.questionStrategies?.contentSha256 }); inputSha256 = deepRebindDigest(payload);
    }
    const entry = { objectiveId: item.objectiveId, model: draft.premiseValidation!.reviewModel, binding: deepNewQuestionCacheBinding(context, slot.objective!, []), draft, inputSha256,
      requestPath: requestPath ? relative(root, requestPath) : null, responsePath: responsePath ? relative(root, responsePath) : null };
    await immutableJson(resultPath, entry); approved.push(entry); report.repairedApprovedCount = approved.length; await progress();
  }
  const artifact: DeepRepairArtifact = { version: 'actual-checkpoint-question-repair-v1', commonContentSha256: context.studentAnalysis!.contentSha256, baseTargetContentSha256: context.targetAnalysis!.contentSha256,
    planPath: options.repairPlanPath, planFileSha256: sha(planBytes), approved, reviewedAt: new Date().toISOString() };
  await immutableJson(artifactFile, artifact); return { artifact, artifactFile };
}

export async function runDeepBankRebind(options: DeepRebindExecutionOptions) {
  const root = path.resolve(options.root ?? process.cwd());
  for (const [cap, maximum] of [[options.maxRetainedReviewCalls ?? 0, options.allowOneIncompleteWireRetry ? 31 : 30], [options.maxCalibrationCalls ?? 0, 5], [options.maxRepairCalls ?? 0, 8], [options.maxNewQuestionCalls ?? 0, 24], [options.maxNewQuestionTtsCalls ?? 0, 6], [options.maxNewRecoveryCalls ?? 0, 77], [options.maxNewRecoveryTtsCalls ?? 0, 34]]) if (!Number.isSafeInteger(cap) || cap < 0 || cap > maximum) throw new Error('DEEP_REBIND_EXPLICIT_PHASE_CAP_OUT_OF_RANGE');
  if (options.allowOneIncompleteWireRetry && (options.phase !== 'retained' || options.maxRetainedReviewCalls !== 31)) throw new Error('DEEP_REBIND_EXPLICIT_SINGLE_WIRE_RETRY_REQUIRES_CAP_31');
  if (!options.reviewModel?.trim()) throw new Error('DEEP_REBIND_EXPLICIT_REVIEW_MODEL_REQUIRED');
  return withReservedBankUpgradeReport(root, options.output, async output => {
    const verified = await verifiedInputs(options, root), { oldContext, bank, staged, stageBytes, mappingBytes, plan, newIds } = verified;
    const generation = deepRebindDigest({ version: 'deep-bank-fresh-execution-v1', bank: bank.contentSha256, stage: sha(stageBytes), mapping: sha(mappingBytes), recordReviewModel: options.reviewModel, commonReviewModel: bank.questionModel });
    const job = path.resolve(root, 'data/prepared/deep-bank-rebind-jobs', generation);
    return withDeepRebindGenerationLock(job, async () => {
      const report: Record<string, any> = { version: 'deep-bank-rebind-execution-v1', phase: options.phase, generation, jobPath: relative(root, job), startedAt: new Date().toISOString(), activated: false, activePointerWrites: 0,
        originalBankKey: bank.key, originalBankContentSha256: bank.contentSha256, sourceStagePath: staged.revisionPath, sourceStageFileSha256: sha(stageBytes), mappingPath: options.mappingPath, mappingFileSha256: sha(mappingBytes),
        counts: plan.counts, newObjectiveIds: newIds, sdkRetries: 0, usage: [], physicalCalls: {}, failures: [],
        retainedOutputWire: 'stable-proof-id-v1', repairAndNewRecoveryOutputWire: QUESTION_SPAN_WIRE_VERSION, explicitSingleLegacyIncompleteRetryAllowed: Boolean(options.allowOneIncompleteWireRetry),
        callAccounting: 'Durable reservations immediately before provider invocation; failed/unknown attempts consume the cap. This is conservative attempt accounting, not a provider invoice.' };
      output.track(report);
      const progress = async () => {
        for (const pin of verified.protectedFiles) if (sha(await readFile(path.resolve(root, pin.file))) !== pin.sha256) throw new Error('DEEP_REBIND_ORIGINAL_FILE_CHANGED_DURING_EXECUTION');
        report.protectedOriginalFilesUnchanged = true;
        const stages = { retained: 'retained-calls', calibration: 'calibration-calls', repair: 'repair-calls', newQ0: 'new-q0-calls', newQ0Tts: 'new-q0-tts', newRecovery: 'new-recovery-calls', newRecoveryTts: 'new-recovery-tts' };
        for (const [name, directory] of Object.entries(stages)) report.physicalCalls[name] = (await readdir(path.join(job, directory)).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; })).filter(file => file.endsWith('.request.json')).length;
        report.cost = aggregateProviderCosts(report.usage.map((item: { observation: ProviderUsageObservation }) => estimateProviderCost(item.observation)));
        report.cumulativeProviderUsage = await deepRebindCumulativeUsage(job); await output.write(report);
      };
      const client = () => { if (!process.env.OPENAI_API_KEY) throw new Error('DEEP_REBIND_OPENAI_KEY_REQUIRED'); return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 90000 }); };
      const createBudget = async (name: string, maximum: number) => { const directory = path.join(job, name); await mkdir(directory, { recursive: true }); return new DeepRebindCallBudget(directory, maximum); };
      const retainedPath = path.join(job, 'retained-reviews.json'), publicationPath = path.join(job, 'retained-publication.json');
      let artifact = await optionalJson<RetainedArtifact>(retainedPath), publication = await optionalJson<RetainedPublication>(publicationPath);
      const originalPublication = publication;
      let selectedArtifactPath = retainedPath, selectedPublicationPath = publicationPath;
      try {
        if (options.phase === 'retained' && !artifact) {
          if (plan.rows.some(row => row.status !== 'ready_for_independent_review')) throw new Error('DEEP_REBIND_PENDING_MANUAL_MATCH_BLOCKS_EXECUTION');
          const budget = await createBudget('retained-calls', options.maxRetainedReviewCalls ?? 0);
          if (budget.maximum < plan.rows.length) throw new Error('DEEP_REBIND_RETAINED_CAP_MUST_COVER_EXACT_COHORT');
          const reviews: StoredReview[] = [];
          for (const row of plan.rows) {
            const candidate = bank.slots.flatMap(slot => slot.candidates).find(item => item.id === row.oldCandidateId)!, model = candidate.draft.commonApproval ? bank.questionModel : options.reviewModel;
            const input = { ...row.reviewInput!, currentSourceContext: row.currentMeaningContext }, inputSha256 = deepRebindDigest(input), resultFile = path.join(job, `review-${row.oldCandidateId}.json`);
            let stored = await optionalJson<StoredReview>(resultFile);
            if (!stored) {
              const previousRequests = await readdir(budget.directory);
              const previousForCandidate: string[] = [];
              for (const file of previousRequests.filter(file => file.endsWith('.request.json'))) {
                const saved = JSON.parse(await readFile(path.join(budget.directory, file), 'utf8')) as { request?: { candidateId?: string } };
                if (saved.request?.candidateId === row.oldCandidateId) previousForCandidate.push(path.join(budget.directory, file));
              }
              if (previousForCandidate.length) report.explicitWireRetry = await authorizeDeepIncompleteWireRetry(job, row, model, previousForCandidate, Boolean(options.allowOneIncompleteWireRetry));
              const request = { model, service_tier: 'default' as const, store: false, reasoning: { effort: 'low' as const }, instructions: QUESTION_PREMISE_REVIEW_RULES + STABLE_PREMISE_PROOF_RULES,
                input: JSON.stringify(deepRetainedStablePayload(row)), text: { format: zodTextFormat(stableQuestionPremiseReviewSchema, 'deep_current_source_stable_review') }, max_output_tokens: 4000 };
              const native = client(), requestFile = budget.reserve('retained-review', { candidateId: row.oldCandidateId, request }), responseFile = requestFile.replace('.request.json', '.response.json');
              await progress();
              try {
                const response = await native.responses.parse(request); await immutableJson(responseFile, response);
                report.usage.push({ stage: 'retained_review', candidateId: row.oldCandidateId, observation: normalizeProviderUsage(response, { requestedModel: model, requestedServiceTier: 'default' }) });
                if (response.status !== 'completed' || !response.output_parsed) throw new Error('DEEP_REBIND_REVIEW_OUTPUT_INCOMPLETE');
                stored = { candidateId: row.oldCandidateId, objectiveId: row.oldObjectiveId, model, inputSha256, questionSha256: row.questionSha256,
                  requestPath: relative(root, requestFile), requestFileSha256: sha(await readFile(requestFile)), responsePath: relative(root, responseFile), responseFileSha256: sha(await readFile(responseFile)),
                  review: materializeStablePremiseReview(response.output_parsed, row.reviewInput!), wireVersion: 'stable-proof-id-v1', status: 'approved', failureCode: null };
                try { validateStoredDeepReview(row, stored, model); }
                catch (error) { if (!(error instanceof QuestionValidationError)) throw error; stored.status = 'rejected'; stored.failureCode = error.code; }
                await immutableJson(resultFile, stored);
              } catch (error) { await immutableJson(requestFile.replace('.request.json', '.failure.json'), { failure: safeFailure(error), failedAt: new Date().toISOString() }); throw error; }
            }
            if (stored.inputSha256 !== inputSha256 || stored.model !== model) throw new Error('DEEP_REBIND_REVIEW_CHECKPOINT_CHANGED');
            await verifyStoredDeepReviewFiles(root, row, stored);
            if (stored.status === 'approved') validateStoredDeepReview(row, stored, model);
            reviews.push(stored); report.physicalCalls.retained = budget.used(); report.reviewedCount = reviews.length; await progress();
          }
          artifact = { version: 'deep-bank-fresh-retained-review-v1', sourceStagePath: staged.revisionPath, sourceStageFileSha256: sha(stageBytes), mappingPath: options.mappingPath, mappingFileSha256: sha(mappingBytes),
            donorBankKey: bank.key, donorBankContentSha256: bank.contentSha256, donorBankFileSha256: sha(await readFile(path.resolve(root, `data/prepared/question-banks/${bank.key}.json`))),
            sourceCommonSha256: staged.common.contentSha256, sourceTargetSha256: staged.target.contentSha256, reviewedAt: new Date().toISOString(), recordReviewModel: options.reviewModel, commonReviewModel: bank.questionModel, reviews };
          await immutableJson(retainedPath, artifact);
        }
        if (!artifact || artifact.sourceStageFileSha256 !== sha(stageBytes) || artifact.mappingFileSha256 !== sha(mappingBytes) || artifact.sourceCommonSha256 !== staged.common.contentSha256 || artifact.sourceTargetSha256 !== staged.target.contentSha256 || artifact.donorBankContentSha256 !== bank.contentSha256 || artifact.recordReviewModel !== options.reviewModel || artifact.commonReviewModel !== bank.questionModel) throw new Error('DEEP_REBIND_FRESH_RETAINED_ARTIFACT_REQUIRED');
        if (artifact.reviews.length !== plan.rows.length) throw new Error('DEEP_REBIND_FRESH_REVIEW_COVERAGE_INCOMPLETE');
        for (const row of plan.rows) { const saved = artifact.reviews.find(item => item.candidateId === row.oldCandidateId); if (!saved) throw new Error('DEEP_REBIND_REVIEW_MISSING'); await verifyStoredDeepReviewFiles(root, row, saved); if (saved.status === 'approved') validateStoredDeepReview(row, saved, bank.slots.flatMap(slot => slot.candidates).find(item => item.id === row.oldCandidateId)!.draft.commonApproval ? bank.questionModel : options.reviewModel); }
        const originalArtifact = artifact, originalArtifactSha256 = sha(await readFile(retainedPath));
        const calibrationPath = path.join(job, 'retained-calibration-reviews.json'), calibrationPublicationPath = path.join(job, 'retained-calibration-publication.json');
        let supplement = await optionalJson<RetainedArtifact>(calibrationPath);
        if (options.phase === 'calibration' && !supplement) {
          if (!originalPublication) throw new Error('DEEP_REBIND_ORIGINAL_PUBLICATION_REQUIRED_BEFORE_CALIBRATION');
          const rejected = originalArtifact.reviews.filter(review => review.status === 'rejected');
          const budget = await createBudget('calibration-calls', options.maxCalibrationCalls ?? 0);
          if (rejected.length > 5 || budget.maximum < rejected.length) throw new Error('DEEP_REBIND_CALIBRATION_CAP_MUST_COVER_REJECTED_COHORT');
          const calibrated = new Map<string, StoredReview>();
          for (const prior of rejected) {
            const row = plan.rows.find(row => row.oldCandidateId === prior.candidateId)!, resultPath = path.join(job, `calibration-review-${prior.candidateId}.json`);
            let stored = await optionalJson<StoredReview>(resultPath);
            if (!stored) {
              for (const file of (await readdir(budget.directory)).filter(file => file.endsWith('.request.json'))) {
                const request = JSON.parse(await readFile(path.join(budget.directory, file), 'utf8')) as { request: { candidateId?: string } };
                if (request.request.candidateId === prior.candidateId) throw new Error('DEEP_REBIND_CALIBRATION_INCOMPLETE_REQUEST_REQUIRES_REVIEW');
              }
              const request = { model: prior.model, service_tier: 'default' as const, store: false, reasoning: { effort: 'low' as const }, instructions: QUESTION_PREMISE_REVIEW_RULES + STABLE_PREMISE_PROOF_RULES,
                input: JSON.stringify(deepRetainedStablePayload(row)), text: { format: zodTextFormat(stableQuestionPremiseReviewSchema, 'deep_current_source_stable_review') }, max_output_tokens: 4000 };
              const native = client(), requestFile = budget.reserve('calibration-review', { candidateId: prior.candidateId, request }), responseFile = requestFile.replace('.request.json', '.response.json');
              await progress();
              try {
                const response = await native.responses.parse(request); await immutableJson(responseFile, response);
                report.usage.push({ stage: 'calibration_review', candidateId: prior.candidateId, observation: normalizeProviderUsage(response, { requestedModel: prior.model, requestedServiceTier: 'default' }) });
                if (response.status !== 'completed' || !response.output_parsed) throw new Error('DEEP_REBIND_CALIBRATION_OUTPUT_INCOMPLETE');
                stored = { candidateId: prior.candidateId, objectiveId: prior.objectiveId, model: prior.model, inputSha256: prior.inputSha256, questionSha256: prior.questionSha256,
                  requestPath: relative(root, requestFile), requestFileSha256: sha(await readFile(requestFile)), responsePath: relative(root, responseFile), responseFileSha256: sha(await readFile(responseFile)),
                  wireVersion: 'stable-proof-id-v1', review: materializeStablePremiseReview(response.output_parsed, row.reviewInput!), status: 'approved', failureCode: null };
                try { validateStoredDeepReview(row, stored, stored.model); } catch (error) { if (!(error instanceof QuestionValidationError)) throw error; stored.status = 'rejected'; stored.failureCode = error.code; }
                await immutableJson(resultPath, stored);
              } catch (error) { await immutableJson(requestFile.replace('.request.json', '.failure.json'), { failure: safeFailure(error) }); throw error; }
            }
            await verifyStoredDeepReviewFiles(root, row, stored); calibrated.set(prior.candidateId, stored); report.calibratedCount = calibrated.size; await progress();
          }
          supplement = mergeCalibratedDeepReviews(originalArtifact, [...calibrated.values()], originalArtifactSha256, new Date().toISOString(), sha(QUESTION_PREMISE_REVIEW_RULES + STABLE_PREMISE_PROOF_RULES));
          await immutableJson(calibrationPath, supplement);
        }
        if (supplement) {
          if (supplement.calibration?.parentArtifactSha256 !== originalArtifactSha256 || !same(supplement.sourceCommonSha256, originalArtifact.sourceCommonSha256) || !same(supplement.sourceTargetSha256, originalArtifact.sourceTargetSha256) || supplement.reviews.length !== originalArtifact.reviews.length) throw new Error('DEEP_REBIND_CALIBRATION_PARENT_OR_SOURCE_CHANGED');
          for (const prior of originalArtifact.reviews) {
            const current = supplement.reviews.find(review => review.candidateId === prior.candidateId), row = plan.rows.find(row => row.oldCandidateId === prior.candidateId)!;
            if (!current || prior.status === 'approved' && !same(prior, current)) throw new Error('DEEP_REBIND_CALIBRATION_MUTATED_PRIOR_APPROVAL');
            await verifyStoredDeepReviewFiles(root, row, current);
          }
          artifact = supplement; selectedArtifactPath = calibrationPath; selectedPublicationPath = calibrationPublicationPath; publication = await optionalJson<RetainedPublication>(calibrationPublicationPath);
        }
        const commonFailure = artifact.reviews.some(review => review.status !== 'approved' && bank.slots.flatMap(slot => slot.candidates).find(item => item.id === review.candidateId)?.draft.commonApproval);
        if (commonFailure) throw new Error('DEEP_REBIND_COMMON_REVIEW_REJECTED_REQUIRES_EXPLICIT_SELECTION');
        const artifactHash = sha(await readFile(selectedArtifactPath));
        if (!publication) {
          const publicationBase = supplement && originalPublication ? (await loadStagedInterviewContextAt(root, originalPublication.derivedRevisionPath, { writeManifest: false })).staged : staged;
          const corrections: ReviewedObjectiveContractCorrection[] = [], blockedObjectives: Array<{ objectiveId: string; failureCode: string }> = [];
          for (const review of artifact.reviews) {
            const objective = publicationBase.target.objectives.find(row => row.id === review.objectiveId); if (!objective) continue;
            if (review.status !== 'approved') { if (!['PREMISE_UNSUPPORTED', 'PREMISE_UNCERTAIN', 'PREMISE_REVIEW_INVALID'].includes(review.failureCode ?? '')) throw new Error('DEEP_REBIND_REJECTION_REQUIRES_EXPLICIT_TARGET_REVIEW'); blockedObjectives.push({ objectiveId: objective.id, failureCode: review.failureCode! }); continue; }
            corrections.push({ objectiveId: objective.id, previousQuestionIntent: objective.questionIntent, previousTargetEvidence: [...objective.targetEvidence], questionIntent: objective.questionIntent, targetEvidence: [objective.targetEvidence[0]], reviewedQuestionSha256: review.questionSha256 });
          }
          const review = { artifactSha256: artifactHash, model: options.reviewModel, reviewedAt: artifact.reviewedAt, blockedObjectives };
          const revision = sha(JSON.stringify({ parent: publicationBase.target.contentSha256, corrections, review }));
          const derivedPath = `data/prepared/student-analysis-revisions/${staged.common.revision}/target-${revision}/analysis.json`;
          let derived = await optionalJson<{ target: { contentSha256: string; objectiveContractRevision?: { reviewArtifactSha256: string } } }>(path.resolve(root, derivedPath));
          if (!derived) { const published = await publishReviewedObjectiveContracts(oldContext, corrections, review, root, { activate: false, baseRevisionPath: publicationBase.revisionPath }); derived = { target: published.target }; }
          if (derived.target.objectiveContractRevision?.reviewArtifactSha256 !== artifactHash) throw new Error('DEEP_REBIND_DERIVED_REVIEW_AUTHORITY_CHANGED');
          // Publication can stop between its two immutable writes. Recreate only
          // the deterministic QA manifest for this exact newly owned target;
          // never repair the donor analysis or change any facts/utterance.
          const envelope = JSON.parse(await readFile(path.resolve(root, derivedPath), 'utf8')) as Parameters<typeof analysisQAManifest>[0];
          if (!same(envelope.common, publicationBase.common) || !same(envelope.evidence, publicationBase.evidence) || envelope.target.objectives.length !== publicationBase.target.objectives.length || envelope.target.objectives.some(objective => {
            const previous = publicationBase.target.objectives.find(row => row.id === objective.id);
            return !previous || !same(deepRebindObjectiveContract(previous), deepRebindObjectiveContract(objective));
          })) throw new Error('DEEP_REBIND_NOOP_PUBLICATION_CHANGED_SOURCE_OR_DEMAND');
          const manifestFile = path.join(path.dirname(path.resolve(root, derivedPath)), 'analysis-qa.json');
          const manifest = analysisQAManifest(envelope, verified.source, staged.manifest.parentPointerSha256);
          if (!await optionalJson<unknown>(manifestFile)) await immutableJson(manifestFile, manifest);
          await loadStagedInterviewContextAt(root, derivedPath, { writeManifest: false });
          publication = { sourceArtifactPath: relative(root, selectedArtifactPath), sourceArtifactFileSha256: artifactHash, derivedRevisionPath: derivedPath, derivedTargetSha256: derived.target.contentSha256 };
          await immutableJson(selectedPublicationPath, publication);
        }
        if (publication.sourceArtifactFileSha256 !== artifactHash) throw new Error('DEEP_REBIND_PUBLISHED_REVIEW_ARTIFACT_CHANGED');
        Object.assign(report, publication); report.retainedReviewArtifactPath = relative(root, selectedArtifactPath); report.retainedReviewArtifactFileSha256 = artifactHash;
        if (options.phase === 'retained' || options.phase === 'calibration') { report.retainedComplete = true; report.readyForActivation = false; await progress(); return report; }
        const repairPublicationFile = path.join(job, 'repair-publication.json');
        let repaired = await optionalJson<DeepRepairArtifact>(path.join(job, 'repair-approved-questions.json'));
        let repairPublication = await optionalJson<RetainedPublication>(repairPublicationFile);
        if (options.phase === 'repair' && !repairPublication) {
          const base = await loadDeepRepairBase(root, publication, options.repairPlanPath!);
          const completed = await executeDeepCheckpointRepair(options, base.context, job, root, report, progress); repaired = completed.artifact;
          const repairedHash = sha(await readFile(completed.artifactFile));
          const corrections: ReviewedObjectiveContractCorrection[] = repaired.approved.filter(row => row.model === options.reviewModel).map(row => {
            const objective = base.context.targetAnalysis!.objectives.find(value => value.id === row.objectiveId)!;
            return { objectiveId: objective.id, previousQuestionIntent: objective.questionIntent, previousTargetEvidence: [...objective.targetEvidence], questionIntent: objective.questionIntent,
              targetEvidence: [objective.targetEvidence[0]], reviewedQuestionSha256: sha(row.draft.questionText) };
          });
          if (corrections.length !== repaired.approved.length - 1) throw new Error('DEEP_REBIND_REPAIR_EXACT_INDEPENDENT_COHORT_REQUIRED');
          const published = await publishReviewedObjectiveContracts(oldContext, corrections, { artifactSha256: repairedHash, model: options.reviewModel, reviewedAt: repaired.reviewedAt }, root, { activate: false, baseRevisionPath: base.staged.revisionPath });
          repairPublication = { sourceArtifactPath: relative(root, completed.artifactFile), sourceArtifactFileSha256: repairedHash, derivedRevisionPath: published.revisionPath, derivedTargetSha256: published.target.contentSha256 };
          await immutableJson(repairPublicationFile, repairPublication);
        }
        if (repairPublication) {
          if (!repaired || repaired.commonContentSha256 !== staged.common.contentSha256 || sha(await readFile(path.resolve(root, repairPublication.sourceArtifactPath))) !== repairPublication.sourceArtifactFileSha256 || sha(await readFile(path.resolve(root, repaired.planPath))) !== repaired.planFileSha256) throw new Error('DEEP_REBIND_REPAIR_PUBLICATION_BINDING_CHANGED');
          const repairBase = await loadDeepRepairBase(root, publication, repaired.planPath);
          if (repaired.baseTargetContentSha256 !== repairBase.staged.target.contentSha256) throw new Error('DEEP_REBIND_REPAIR_PUBLICATION_BASE_CHANGED');
          const repairedContext = await loadStagedInterviewContextAt(root, repairPublication.derivedRevisionPath, { writeManifest: false });
          if (repairedContext.staged.target.contentSha256 !== repairPublication.derivedTargetSha256 || !same(repairedContext.staged.common, staged.common) || !same(repairedContext.staged.evidence, staged.evidence)) throw new Error('DEEP_REBIND_REPAIR_PUBLICATION_SOURCE_CHANGED');
          publication = repairPublication; Object.assign(report, publication); report.repairedApprovedCount = repaired.approved.length;
        }
        if (options.phase === 'repair') { report.repairComplete = true; report.readyForActivation = false; await progress(); return report; }
        const derived = await loadStagedInterviewContextAt(root, publication.derivedRevisionPath, { writeManifest: false }), current = derived.context;
        if (derived.staged.target.contentSha256 !== publication.derivedTargetSha256 || derived.staged.common.contentSha256 !== staged.common.contentSha256) throw new Error('DEEP_REBIND_CURRENT_DERIVED_SOURCE_CHANGED');
        const identity = questionBankIdentity(current);
        const legacyPreparedContext = originalPublication && originalPublication.derivedRevisionPath !== publication.derivedRevisionPath
          ? (await loadStagedInterviewContextAt(root, originalPublication.derivedRevisionPath, { writeManifest: false })).context : current;
        let readyBank = await loadQuestionBank(current, { root });
        if (options.phase === 'bank' && !readyBank) {
          const llm = await createBudget('new-q0-calls', options.maxNewQuestionCalls ?? 0), tts = await createBudget('new-q0-tts', options.maxNewQuestionTtsCalls ?? 0);
          let activeQuestionRequest: string | undefined;
          const providers: QuestionBankProviders = {
            generate: async (ctx, session, excludedQuestionTexts) => {
              const slot = session.plan!.slots[session.turns.length], original = bank.slots.flatMap(row => row.candidates).find(candidate => bank.plan.slots.find(old => old.id === candidate.slotId)?.objective?.id === slot.objective?.id);
              if (original) { const row = plan.rows.find(row => row.oldCandidateId === original.id)!, review = artifact!.reviews.find(review => review.candidateId === original.id)!; return rebuildDeepReboundDraft(original, row, review, ctx, session); }
              if (!newIds.includes(slot.objective!.id)) throw new Error('DEEP_REBIND_UNSELECTED_NEW_OBJECTIVE');
              const repairedCandidate = repaired?.approved.find(row => row.objectiveId === slot.objective!.id);
              if (repairedCandidate) {
                if (repairedCandidate.binding !== deepNewQuestionCacheBinding(ctx, slot.objective!, [])) throw new Error('DEEP_REBIND_REPAIR_APPROVAL_SOURCE_CHANGED');
                assertQuestionContractIntegrity(repairedCandidate.draft, repairedCandidate.draft.approvedQuestion!);
                return structuredClone(repairedCandidate.draft);
              }
              const resultPath = path.join(job, 'new-q0-results', `${slot.objective!.id}.json`), binding = deepNewQuestionCacheBinding(ctx, slot.objective!, excludedQuestionTexts);
              const cached = await optionalJson<{ binding: string; draft: QuestionDraft }>(resultPath);
              if (cached) {
                if (cached.binding !== binding) {
                  const legacySlot = questionBankIdentity(legacyPreparedContext).plan.slots.find(old => old.objective?.id === slot.objective!.id);
                  if (!legacySlot?.objective || cached.binding !== deepRebindDigest({ sourceManifest: legacyPreparedContext.manifest, objective: legacySlot.objective, excludedQuestionTexts })) throw new Error('DEEP_REBIND_NEW_QUESTION_CHECKPOINT_CHANGED');
                  assertDeepApprovedCacheRebind(legacyPreparedContext, ctx, legacySlot.objective, slot.objective!, cached.draft);
                  await immutableJson(path.join(job, 'new-q0-cache-rebindings', `${derived.staged.target.contentSha256}-${slot.objective!.id}.json`), {
                    version: 'exact-approved-q0-cache-rebind-v1', originalCacheSha256: sha(await readFile(resultPath)), originalBinding: cached.binding, currentBinding: binding,
                    originalTargetContentSha256: legacyPreparedContext.targetAnalysis!.contentSha256, currentTargetContentSha256: ctx.targetAnalysis!.contentSha256,
                    questionSha256: sha(cached.draft.questionText), actualApprovalContractSha256: cached.draft.approvedQuestion!.contentSha256,
                    commonSourceUnchanged: true, semanticDemandAndSelectedSourceUnchanged: true, providerCalls: 0, oldCacheModified: false,
                  });
                }
                return structuredClone(cached.draft);
              }
              try {
                const draft = await generateQuestion(ctx, session, false, true, undefined, { excludedQuestionTexts, maxRetries: 0,
                  beforeProviderRequest: stage => { activeQuestionRequest = llm.reserve(stage, { model: identity.questionModel, objectiveId: slot.objective!.id, sourceManifest: ctx.manifest, targetContract: slot.objective }); report.physicalCalls.newQ0 = llm.used(); },
                  onCandidate: async event => {
                    if (!activeQuestionRequest) throw new Error('DEEP_REBIND_GENERATION_REQUEST_CHECKPOINT_REQUIRED');
                    const candidatePath = activeQuestionRequest.replace('.request.json', '.candidate.json');
                    await immutableJson(candidatePath, { version: 'unreviewed-provider-candidate-checkpoint-v1', objectiveId: slot.objective!.id,
                      commonContentSha256: ctx.studentAnalysis!.contentSha256, targetContentSha256: ctx.targetAnalysis!.contentSha256,
                      candidateObservation: event, sourceReviewComplete: false, bankApprovalGranted: false });
                    report.lastUnreviewedProposalCheckpoint = relative(root, candidatePath);
                  },
                  onProviderUsage: event => { report.usage.push(event); if (activeQuestionRequest) writeFileSync(activeQuestionRequest.replace('.request.json', '.observation.json'), JSON.stringify(event, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); } });
                await immutableJson(resultPath, { binding, draft }); return draft;
              } catch (error) { if (activeQuestionRequest) await immutableJson(activeQuestionRequest.replace('.request.json', '.failure.json'), { failure: safeFailure(error) }); throw error; }
            },
            synthesize: async (text, voice, role) => {
              const id = speechAudioCacheId(text, voice), cached = await readDurableSpeechAudio(id);
              const retained = bank.slots.flatMap(row => row.candidates).find(candidate => candidate.draft.questionText === text);
              if (retained && (!cached?.length || id !== retained.speechHash || sha(cached) !== retained.audioSha256 || !same(voice, retained.voiceSettings))) throw new Error('DEEP_REBIND_RETAINED_AUDIO_MISSING_OR_CHANGED_NO_SYNTHESIS_ALLOWED');
              if (cached?.length) return { audioUrl: `/api/audio/${id}`, bytes: cached };
              tts.reserve('new-q0-audio', { textSha256: sha(text), characters: text.length, voice }); report.physicalCalls.newQ0Tts = tts.used(); await progress();
              const audioUrl = await synthesizeSpeech(text, voice.speaker, { role, settings: voice }), bytes = await readDurableSpeechAudio(id); if (!bytes?.length) throw new Error('DEEP_REBIND_NEW_AUDIO_NOT_DURABLE'); return { audioUrl, bytes };
            },
          };
          readyBank = await prepareQuestionBank(current, { root, providers, concurrency: 1, maxNewCandidates: identity.plan.slots.length, onProgress: event => { report.bankProgress = event; } });
          report.physicalCalls.newQ0 = llm.used(); report.physicalCalls.newQ0Tts = tts.used();
        }
        if (!readyBank) throw new Error('DEEP_REBIND_NEW_DEFAULT_BANK_NOT_READY');
        report.bankKey = readyBank.key; report.bankContentSha256 = readyBank.contentSha256;
        const sourceLineage = await loadQuestionPurposeLineage(oldContext, bank, root);
        if (sourceLineage) { const lineage = await publishExactQuestionPurposeLineageRebind(current, bank, readyBank, root); report.lineage = { registryPath: lineage.registryPath, registryFileSha256: lineage.registryFileSha256, links: lineage.links.length }; }
        else report.lineage = { links: 0, sameSemanticKeysRetainHistory: true };
        report.recoveryRebind = await rebindExistingDeepRecovery(oldContext, current, bank, readyBank, root);
        if (options.phase === 'recovery') {
          const llm = await createBudget('new-recovery-calls', options.maxNewRecoveryCalls ?? 0), tts = await createBudget('new-recovery-tts', options.maxNewRecoveryTtsCalls ?? 0);
          const missing = (await deepRecoveryReadiness(current, readyBank, root)).missing;
          let repairs: ReturnType<typeof validateDeepRecoveryRepairPlan> = [];
          if (options.recoveryRepairPlanPath) {
            const planBytes = await readFile(path.resolve(root, options.recoveryRepairPlanPath)), repairPlan = JSON.parse(planBytes.toString('utf8')) as DeepRecoveryRepairPlan;
            const sourceBytes = await readFile(path.resolve(root, repairPlan.sourceReportPath));
            if (sha(sourceBytes) !== repairPlan.sourceReportFileSha256) throw new Error('DEEP_REBIND_RECOVERY_REPAIR_REPORT_CHANGED');
            repairs = validateDeepRecoveryRepairPlan(repairPlan, JSON.parse(sourceBytes.toString('utf8')), readyBank, missing);
            report.recoveryRepairPlan = { path: options.recoveryRepairPlanPath, sha256: sha(planBytes), sourceReportFileSha256: repairPlan.sourceReportFileSha256, candidateIds: repairs.map(item => item.candidateId) };
            if (repairPlan.providedProposalsReview) {
              const proof = repairPlan.providedProposalsReview, proofBytes = await readFile(path.resolve(root, proof.remainingDefectsReportPath));
              const proofValue = JSON.parse(proofBytes.toString('utf8')) as { sourceReport: { path: string; sha256: string }; remaining: Array<{ candidateId: string }> };
              if (sha(proofBytes) !== proof.remainingDefectsReportFileSha256 || proof.targetContentSha256 !== current.targetAnalysis!.contentSha256 || proofValue.sourceReport.sha256 !== repairPlan.sourceReportFileSha256 || path.resolve(root, proofValue.sourceReport.path) !== path.resolve(root, repairPlan.sourceReportPath) || !same(proofValue.remaining.map(row => row.candidateId), repairPlan.items.map(row => row.candidateId))) throw new Error('DEEP_REBIND_PROVIDED_RECOVERY_SOURCE_PIN_CHANGED');
              report.providedRecoveryProposals = { ...proof, proposalPlanFileSha256: sha(planBytes), modelGenerationCalls: 0, ordinaryIndependentReviewStillRequired: true };
            }
          }
          const candidateIds = selectMissingDeepRecoveryCandidateIds(readyBank, repairs.length ? repairs.map(item => item.candidateId) : missing);
          const request = async (stage: string, body: Parameters<OpenAI['responses']['parse']>[0], observe: (usage: ProviderUsageObservation) => void) => {
            let retryParent: { path: string; sha256: string } | undefined;
            for (const file of (await readdir(llm.directory)).filter(file => file.endsWith('.request.json'))) {
              const saved = JSON.parse(await readFile(path.join(llm.directory, file), 'utf8')) as { stage: string; request: unknown };
              if (saved.stage !== stage || !same(saved.request, body)) continue;
              const response = await optionalJson<{ status?: string; output_parsed?: unknown }>(path.join(llm.directory, file.replace('.request.json', '.response.json')));
              if (response?.status === 'completed' && response.output_parsed) return response.output_parsed;
              const authorized = repairs.find(item => item.action === 'retry_review_once' && item.failedRequestPath && path.resolve(root, item.failedRequestPath) === path.join(llm.directory, file));
              if (authorized && stage === 'review' && !response && sha(await readFile(path.join(llm.directory, file))) === authorized.failedRequestFileSha256 && await optionalJson<unknown>(path.join(llm.directory, file.replace('.request.json', '.failure.json')))) { retryParent = { path: authorized.failedRequestPath!, sha256: authorized.failedRequestFileSha256! }; continue; }
              throw new Error('DEEP_REBIND_PREVIOUS_RECOVERY_REQUEST_NOT_COMPLETED_REQUIRES_REVIEW');
            }
            const native = client(), requestFile = llm.reserve(stage, body); report.physicalCalls.newRecovery = llm.used(); await progress();
            if (retryParent) await immutableJson(requestFile.replace('.request.json', '.retry-provenance.json'), { version: 'explicit-once-identical-review-retry-v1', parentRequestPath: retryParent.path, parentRequestFileSha256: retryParent.sha256, oldResponseAbsent: true, oldFailureNotReclassified: true });
            try { const response = await native.responses.parse(body); await immutableJson(requestFile.replace('.request.json', '.response.json'), response); observe(normalizeProviderUsage(response, { requestedModel: body.model ?? 'unknown', requestedServiceTier: 'default' })); if (response.status !== 'completed' || !response.output_parsed) throw new Error('DEEP_REBIND_RECOVERY_OUTPUT_INCOMPLETE'); return response.output_parsed; }
            catch (error) { await immutableJson(requestFile.replace('.request.json', '.failure.json'), { failure: safeFailure(error), diagnostics: deepProviderErrorDiagnostics(error) }); throw error; }
          };
          report.newRecovery = await prepareRuntimeRecoveryPool(current, readyBank, {
            generate: async (original, excluded, observe) => {
              const repair = repairs.find(item => item.candidate.draft.questionText === original.questionText && item.candidate.draft.questionIntent === original.metadata.questionIntent && same(item.candidate.draft.targetEvidence, original.metadata.targetEvidence));
              if (repair?.action === 'provided_candidate') return repair.questionText!;
              const output = await request('generation', { model: readyBank!.questionModel, store: false, service_tier: 'default', reasoning: { effort: 'none' }, instructions: OFFLINE_RECOVERY_GENERATION_INSTRUCTIONS,
                input: JSON.stringify({ actualQuestion: original.questionText, intent: original.metadata.questionIntent, targetEvidence: original.metadata.targetEvidence, primaryFunction: original.metadata.primaryFunction, depth: original.metadata.depth, forbiddenIdenticalTexts: repair?.action === 'regenerate_once' ? [...excluded, repair.trial.questionText] : excluded,
                  ...(repair?.action === 'regenerate_once' ? { previousRejectedCandidate: { questionText: repair.trial.questionText, failure: repair.trial.failure, review: repair.trial.review },
                    originalApprovedPremiseBoundaries: original.metadata.premiseValidation, currentAuthorizedSources: current.student.evidence.filter(source => original.evidenceIds.includes(source.id)) } : {}) }),
                text: { format: zodTextFormat(z.object({ questionText: z.string().min(8).max(80) }).strict(), 'deep_new_recovery') }, max_output_tokens: 240 }, observe);
              return (output as { questionText: string }).questionText;
            },
            review: async (input, observe) => materializeQuestionSpanPremiseReview(await request('review', { model: options.reviewModel, store: false, service_tier: 'default', reasoning: { effort: 'low' }, instructions: OFFLINE_RECOVERY_REVIEW_INSTRUCTIONS + QUESTION_WORD_SPAN_RULES,
              input: JSON.stringify(buildQuestionSpanReviewPayload(input)), text: { format: zodTextFormat(questionSpanPremiseReviewWireSchema, 'deep_new_recovery_review_v2') }, max_output_tokens: 4000 }, observe), input),
            warm: async (text, candidate) => boundedRecoveryAudio(text, candidate.voiceSettings, tts, report, progress),
          }, { root, candidateIds, maxCandidatesPerQuestion: 1, reviewModel: options.reviewModel, policy: OFFLINE_RECOVERY_REPORT_POLICY, onProgress: async value => {
            if (report.providedRecoveryProposals) { value.generationMode = 'explicit-offline-reviewed-unapproved-proposals'; value.generationModel = null; value.modelGenerationCalls = 0; value.authorship = report.providedRecoveryProposals.authorship; }
            report.newRecovery = value; await progress();
          } });
          report.physicalCalls.newRecovery = llm.used(); report.physicalCalls.newRecoveryTts = tts.used();
        }
        report.recovery = await deepRecoveryReadiness(current, readyBank, root);
        const finalBank = await loadQuestionBank(current, { root });
        if (!finalBank || finalBank.key !== readyBank.key || finalBank.contentSha256 !== readyBank.contentSha256) throw new Error('DEEP_REBIND_FINAL_DEFAULT_BANK_RELOAD_FAILED');
        report.readyForActivation = report.recovery.missing.length === 0;
        if (report.readyForActivation) {
          const bankPath = `data/prepared/question-banks/${readyBank.key}.json`, manifestPath = `data/prepared/deep-bank-rebind-readiness/${readyBank.key}.json`;
          const manifest = { version: 'deep-bank-rebind-readiness-v1', bankKey: readyBank.key, bankContentSha256: readyBank.contentSha256, sourceReviewArtifactFileSha256: publication.sourceArtifactFileSha256, retainedReviewArtifactFileSha256: artifactHash,
            commonContentSha256: derived.staged.common.contentSha256, targetContentSha256: derived.staged.target.contentSha256, analysisQAManifestSha256: derived.staged.manifest.contentSha256,
            recovery: report.recovery, lineage: report.lineage, independentlyReviewedEntireStudentAnalysis: false };
          await immutableJson(path.resolve(root, manifestPath), manifest);
          const readiness: FullAnalysisBankReadiness = { bankPath, bankFileSha256: sha(await readFile(path.resolve(root, bankPath))), bankKey: readyBank.key, bankContentSha256: readyBank.contentSha256,
            commonContentSha256: derived.staged.common.contentSha256, targetContentSha256: derived.staged.target.contentSha256, evidenceSha256: derived.staged.manifest.evidenceSha256,
            analysisQAManifestSha256: derived.staged.manifest.contentSha256, recovery: { manifestPath, sha256: sha(await readFile(path.resolve(root, manifestPath))), bankKey: readyBank.key }, verifiedAt: new Date().toISOString() };
          report.readiness = readiness;
        }
        await progress(); return report;
      } catch (error) { report.failure = safeFailure(error); report.readyForActivation = false; report.failures.push({ at: new Date().toISOString(), failure: report.failure }); await progress(); throw error; }
    });
  }, { version: 'deep-bank-rebind-live-reservation-v1', phase: options.phase, activated: false, activePointerWrites: 0 });
}

async function boundedRecoveryAudio(text: string, voice: VoiceSettings, budget: DeepRebindCallBudget, report: Record<string, any>, progress: () => Promise<void>) {
  const id = speechAudioCacheId(text, voice), cached = await readDurableSpeechAudio(id); if (cached?.length) return { audioUrl: `/api/audio/${id}`, audioSha256: sha(cached), cacheHit: true };
  budget.reserve('new-recovery-audio', { textSha256: sha(text), characters: text.length, voice }); report.physicalCalls.newRecoveryTts = budget.used(); await progress();
  const audioUrl = await synthesizeSpeech(text, voice.speaker, { settings: voice }), bytes = await readDurableSpeechAudio(id); if (!bytes?.length) throw new Error('DEEP_REBIND_RECOVERY_AUDIO_NOT_DURABLE');
  return { audioUrl, audioSha256: sha(bytes), cacheHit: false };
}

/** An existing ready variant is excluded; a legacy objective is never silently
 * excluded merely because its ID is not part of the new six. */
export function selectMissingDeepRecoveryCandidateIds(bank: PreparedQuestionBank, missing: string[]) {
  const ids = bank.slots.flatMap(slot => slot.candidates).map(candidate => candidate.id), selected = new Set(missing);
  if (selected.size !== missing.length || missing.some(id => !ids.includes(id))) throw new Error('DEEP_REBIND_RECOVERY_MISSING_SCOPE_INVALID');
  return ids.filter(id => selected.has(id));
}

export async function rebindExistingDeepRecovery(oldContext: InterviewContext, context: InterviewContext, oldBank: PreparedQuestionBank, bank: PreparedQuestionBank, root: string) {
  const migrated: string[] = [], pending: Array<{ candidateId: string; reason: string }> = [];
  for (const candidate of bank.slots.flatMap(slot => slot.candidates)) {
    const old = oldBank.slots.flatMap(slot => slot.candidates).find(value => value.questionSha256 === candidate.questionSha256 && value.draft.questionIntent === candidate.draft.questionIntent && same(value.draft.targetEvidence, candidate.draft.targetEvidence) && value.draft.primaryFunction === candidate.draft.primaryFunction && value.draft.depth === candidate.draft.depth);
    if (!old) continue;
    try {
      const original = recoveryOriginal(candidate), previous = recoveryOriginal(old), variants = await loadApprovedRecoveryVariants(oldContext, previous, root);
      if (!variants.length) { pending.push({ candidateId: candidate.id, reason: 'NO_APPROVED_DONOR_RECOVERY' }); continue; }
      const oldFile = JSON.parse(await readFile(path.resolve(root, `data/prepared/recovery-variants/${recoveryVariantIdentity(oldContext, previous)}.json`), 'utf8')) as ApprovedRecoveryVariantFile;
      await saveApprovedRecoveryVariants(context, original, oldFile.variants, root);
      const checked = await loadApprovedRecoveryVariants(context, original, root);
      if (checked.length !== variants.length) throw new Error('DEEP_REBIND_RECOVERY_RELOAD_MISMATCH');
      for (const variant of checked) { const bytes = await readFile(path.resolve(root, 'data/audio', `${speechAudioCacheId(variant.questionText, candidate.voiceSettings)}.mp3`)); if (!bytes.length) throw new Error('DEEP_REBIND_RECOVERY_AUDIO_MISSING'); }
      migrated.push(candidate.id);
    } catch (error) { pending.push({ candidateId: candidate.id, reason: safeFailure(error) }); }
  }
  return { migrated, pending, providerCalls: 0, ttsCalls: 0 };
}
export async function deepRecoveryReadiness(context: InterviewContext, bank: PreparedQuestionBank, root: string) {
  const ready: Array<{ candidateId: string; variants: Array<{ questionSha256: string; speechHash: string; audioSha256: string }> }> = [], missing: string[] = [];
  for (const candidate of bank.slots.flatMap(slot => slot.candidates)) {
    try {
      const drafts = await loadApprovedRecoveryVariants(context, recoveryOriginal(candidate), root); if (!drafts.length) throw new Error('DEEP_REBIND_RECOVERY_MISSING');
      const variants = [];
      for (const draft of drafts) { const speechHash = speechAudioCacheId(draft.questionText, candidate.voiceSettings), bytes = await readFile(path.resolve(root, 'data/audio', `${speechHash}.mp3`)); if (!bytes.length) throw new Error('DEEP_REBIND_RECOVERY_AUDIO_MISSING'); variants.push({ questionSha256: sha(draft.questionText), speechHash, audioSha256: sha(bytes) }); }
      ready.push({ candidateId: candidate.id, variants });
    } catch { missing.push(candidate.id); }
  }
  return { approvedOriginals: bank.slots.flatMap(slot => slot.candidates).length, ready, missing };
}
