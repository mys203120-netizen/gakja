/** One explicitly reviewed, unactivated build-checkpoint surface only.
 * No ready bank, analysis revision, student record or active pointer is changed. */
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { createHash, randomUUID } from 'node:crypto';
import { access, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadInterviewContextAt } from '../server/data/load-interview-context';
import { createPreparedQuestionReviewSession, questionBankIdentity, verifyPreparedMainCandidate, type PreparedQuestionBank, type PreparedMainCandidate } from '../server/data/prepared-question-bank';
import { stagedBankUpgradeContext, withReservedBankUpgradeReport } from './prepare-reviewed-bank-upgrade';
import { approveQuestionContract, assertQuestionContractIntegrity, createQuestionBlueprint } from '../server/question-objective';
import { attachVerifiedQuestionPlan } from '../server/providers/question-plan';
import { QUESTION_PREMISE_REVIEW_RULES, questionPremiseReviewWireSchema, validateQuestionPremises } from '../server/providers/question-premises';
import { readDurableSpeechAudio, speechAudioCacheId, synthesizeSpeech } from '../server/providers/clova-tts';
import { estimateProviderCost, normalizeProviderUsage } from '../server/observability/provider-cost';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type PartialBank = Omit<PreparedQuestionBank, 'status' | 'completedAt' | 'contentSha256'> & { status: 'preparing' };
export interface PartialSurfaceProposal {
  version: 'reviewed-partial-surface-proposal-v1'; bankKey: string; revisionPath: string;
  partialSha256: string; slotId: string; objectiveId: string; candidateId: string; candidateContentSha256: string;
  previousQuestion: string; previousQuestionSha256: string; proposedQuestion: string;
  semanticContract: { questionIntent: string; targetEvidence: string[]; primaryFunction: string; depth: string; evidenceIds: string[] };
  reviewArtifact: { path: string; sha256: string }; reason: string;
}
export interface PartialSurfaceResumeBinding {
  failure?: string | null; committed: boolean; semanticContractPreserved: boolean; llmCalls: number;
  bankKey: string; proposalSha256: string; candidateId: string; objectiveId: string;
  originalPartialSha256: string; originalQuestion: string; proposedQuestion: string; reviewModel: string; finalPremiseReview: unknown;
}
/** This only binds a cached wire response to the exact failed operation. The
 * ordinary premise codec must still revalidate every selected proof below. */
export function validateResumablePartialSurfaceReview(current: Omit<PartialSurfaceResumeBinding, 'failure' | 'committed' | 'semanticContractPreserved' | 'llmCalls' | 'finalPremiseReview'>, previous: PartialSurfaceResumeBinding, snapshotSha256: string) {
  if (previous.failure !== 'PARTIAL_SURFACE_STANDARD_VALIDATION_FAILED' || previous.committed || !previous.semanticContractPreserved || previous.llmCalls !== 1 || previous.bankKey !== current.bankKey || previous.proposalSha256 !== current.proposalSha256 || previous.candidateId !== current.candidateId || previous.objectiveId !== current.objectiveId || previous.originalPartialSha256 !== current.originalPartialSha256 || previous.originalQuestion !== current.originalQuestion || previous.proposedQuestion !== current.proposedQuestion || previous.reviewModel !== current.reviewModel || !previous.finalPremiseReview || snapshotSha256 !== current.originalPartialSha256) throw new Error('PARTIAL_SURFACE_RESUME_REVIEW_UNBOUND');
  return previous.finalPremiseReview;
}
function stable(value: unknown): unknown { return Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)])) : value; }
const same = (a: unknown, b: unknown) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const semantic = (candidate: PreparedMainCandidate) => ({ questionIntent: candidate.draft.questionIntent, targetEvidence: candidate.draft.targetEvidence, primaryFunction: candidate.draft.primaryFunction, depth: candidate.draft.depth, evidenceIds: candidate.draft.evidenceIds });
const absent = async (file: string) => { try { await access(file); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; } };

export function validatePartialSurfaceProposal(partial: PartialBank, proposal: PartialSurfaceProposal, partialBytesSha256: string) {
  if (proposal.version !== 'reviewed-partial-surface-proposal-v1' || partial.status !== 'preparing' || partial.key !== proposal.bankKey || partialBytesSha256 !== proposal.partialSha256 || !/^[a-f0-9]{64}$/u.test(proposal.bankKey)) throw new Error('PARTIAL_SURFACE_CHECKPOINT_CHANGED');
  const row = partial.slots.find(row => row.slotId === proposal.slotId), slot = partial.plan.slots.find(row => row.id === proposal.slotId);
  const candidate = row?.candidates.find(row => row.id === proposal.candidateId);
  if (!slot?.objective || slot.objective.id !== proposal.objectiveId || !row || row.quarantine || row.candidates.length !== 1 || !candidate || candidate.questionSha256 !== proposal.previousQuestionSha256 || candidate.draft.questionText !== proposal.previousQuestion || sha(candidate.draft.questionText) !== proposal.previousQuestionSha256 || sha(JSON.stringify(candidate)) !== proposal.candidateContentSha256 || !same(semantic(candidate), proposal.semanticContract)) throw new Error('PARTIAL_SURFACE_REVIEW_BINDING_INVALID');
  if (!proposal.proposedQuestion.trim() || proposal.proposedQuestion === proposal.previousQuestion) throw new Error('PARTIAL_SURFACE_NEW_UTTERANCE_REQUIRED');
  return { slot, row, candidate };
}

export async function repairPartialBankSurface(options: { root?: string; proposalPath: string; output: string; runLive?: boolean; maxLlmCalls: number; maxTtsCalls: number; resumeFrom?: string }) {
  const root = options.root ?? process.cwd();
  return withReservedBankUpgradeReport(root, options.output, async output => {
    const proposalBytes = await readFile(path.resolve(root, options.proposalPath)), proposal = JSON.parse(proposalBytes.toString('utf8')) as PartialSurfaceProposal;
    if (!/^[a-f0-9]{64}$/u.test(proposal.bankKey)) throw new Error('PARTIAL_SURFACE_BANK_KEY_INVALID');
    const directory = path.resolve(root, 'data/prepared/question-banks'), partialFile = path.join(directory, `${proposal.bankKey}.partial.json`), readyFile = path.join(directory, `${proposal.bankKey}.json`);
    if (!await absent(readyFile)) throw new Error('PARTIAL_SURFACE_READY_BANK_IMMUTABLE');
    const originalBytes = await readFile(partialFile), partial = JSON.parse(originalBytes.toString('utf8')) as PartialBank;
    const original = validatePartialSurfaceProposal(partial, proposal, sha(originalBytes));
    const reviewBytes = await readFile(path.resolve(root, proposal.reviewArtifact.path));
    const review = JSON.parse(reviewBytes.toString('utf8')) as { candidateSnapshots?: Array<{ candidateId: string; questionSha256: string; candidateContentSha256: string }> };
    if (sha(reviewBytes) !== proposal.reviewArtifact.sha256 || !review.candidateSnapshots?.some(row => row.candidateId === proposal.candidateId && row.questionSha256 === proposal.previousQuestionSha256 && row.candidateContentSha256 === proposal.candidateContentSha256)) throw new Error('PARTIAL_SURFACE_INDEPENDENT_REVIEW_CHANGED');
    const oldContext = await loadInterviewContextAt(root, { writeManifest: false }), { context } = await stagedBankUpgradeContext(oldContext, proposal.revisionPath, root);
    const identity = questionBankIdentity(context);
    if (identity.key !== proposal.bankKey || partial.sourceFingerprint !== identity.sourceFingerprint || partial.questionModel !== identity.questionModel || !same(partial.plan, identity.plan) || !same(partial.voices, identity.voices)) throw new Error('PARTIAL_SURFACE_IDENTITY_CHANGED');
    const previous = partial.slots.filter(row => row.mainIndex < original.slot.index).flatMap(row => row.candidates.slice(0, 1));
    if (!await verifyPreparedMainCandidate(context, original.candidate, { root, previous })) throw new Error('PARTIAL_SURFACE_ORIGINAL_CANDIDATE_INVALID');
    const report = { version: 'bounded-partial-bank-surface-repair-v1', startedAt: new Date().toISOString(), proposalPath: options.proposalPath, proposalSha256: sha(proposalBytes), bankKey: identity.key,
      candidateId: original.candidate.id, objectiveId: proposal.objectiveId, originalPartialSha256: sha(originalBytes), snapshotPath: options.output.replace(/\.json$/u, '') + '.partial-before.json',
      originalQuestion: proposal.previousQuestion, proposedQuestion: proposal.proposedQuestion, semanticContractPreserved: false, llmCalls: 0, ttsCalls: 0, reviewModel: identity.questionModel,
      finalPremiseReview: null as unknown, premiseInputSha256: null as string | null, validationFailure: null as unknown, usage: null as ReturnType<typeof normalizeProviderUsage> | null, cost: null as ReturnType<typeof estimateProviderCost> | null,
      reusedReview: null as null | { path: string; sha256: string; binding: string }, speechHash: null as string | null, audioSha256: null as string | null,
      standardCandidateVerified: false, committed: false, finalPartialSha256: null as string | null, failure: null as string | null };
    output.track(report);
    if (!options.runLive) { await output.write(report); return report; }
    if (options.resumeFrom ? options.maxLlmCalls !== 0 || options.maxTtsCalls !== 0 : options.maxLlmCalls !== 1 || options.maxTtsCalls !== 1) throw new Error('PARTIAL_SURFACE_EXPLICIT_SINGLE_CALL_CAP_REQUIRED');
    let reusedReview: unknown = null;
    if (options.resumeFrom) {
      const file = path.resolve(root, options.resumeFrom), relative = path.relative(path.resolve(root, 'artifacts'), file);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('PARTIAL_SURFACE_RESUME_PATH_INVALID');
      const bytes = await readFile(file), previousReport = JSON.parse(bytes.toString('utf8')) as typeof report;
      reusedReview = validateResumablePartialSurfaceReview(report, previousReport, sha(await readFile(path.resolve(root, previousReport.snapshotPath))));
      report.reusedReview = { path: options.resumeFrom, sha256: sha(bytes), binding: 'exact_proposal_bank_identity_candidate_and_original_checkpoint_revalidated_by_standard_premise_codec' };
    }
    // Persist the exact original checkpoint before any paid work or replacement.
    const snapshotFile = path.resolve(root, report.snapshotPath), snapshotRelative = path.relative(path.resolve(root, 'artifacts'), snapshotFile);
    if (!snapshotRelative || snapshotRelative.startsWith('..') || path.isAbsolute(snapshotRelative)) throw new Error('PARTIAL_SURFACE_SNAPSHOT_PATH_INVALID');
    const snapshot = await open(snapshotFile, 'wx', 0o600);
    try { await snapshot.writeFile(originalBytes); await snapshot.sync(); } finally { await snapshot.close(); }
    const session = createPreparedQuestionReviewSession(context, identity.plan, previous, original.slot);
    const draft = structuredClone(original.candidate.draft); draft.questionText = proposal.proposedQuestion;
    delete draft.premiseValidation; delete draft.approvedQuestion; delete draft.questionBlueprint;
    const client = options.resumeFrom ? null : new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 45000, maxRetries: 0 });
    await validateQuestionPremises({ draft, sources: context.student.evidence.filter(source => draft.evidenceIds.includes(source.id)), reviewModel: identity.questionModel,
      onValidationFailure: failure => { report.validationFailure = failure; }, requestReview: async input => {
        report.premiseInputSha256 = sha(JSON.stringify(input));
        if (options.resumeFrom) { report.finalPremiseReview = reusedReview; return reusedReview; }
        if (report.llmCalls >= options.maxLlmCalls) throw new Error('PARTIAL_SURFACE_LLM_CAP_REACHED'); report.llmCalls++;
        const response = await client!.responses.parse({ model: identity.questionModel, service_tier: 'default', store: false, reasoning: { effort: 'low' }, instructions: QUESTION_PREMISE_REVIEW_RULES,
          input: JSON.stringify(input), text: { format: zodTextFormat(questionPremiseReviewWireSchema(input), 'partial_surface_final_independent_review') }, max_output_tokens: 1800 }).catch(error => { report.usage = normalizeProviderUsage(null, { requestedModel: identity.questionModel, requestedServiceTier: 'default' }); report.cost = estimateProviderCost(report.usage); throw error; });
        report.usage = normalizeProviderUsage(response, { requestedModel: identity.questionModel, requestedServiceTier: 'default' }); report.cost = estimateProviderCost(report.usage); report.finalPremiseReview = response.output_parsed;
        if (!response.output_parsed) throw new Error('PARTIAL_SURFACE_REVIEW_MISSING'); return response.output_parsed;
      } });
    attachVerifiedQuestionPlan(draft, session);
    const blueprint = createQuestionBlueprint(draft, context, session, { objectiveCandidate: original.slot.objective, strategyIds: draft.strategyTrace?.candidateCardIds ?? [], targetDescription: draft.targetEvidence[0], expansionRationale: original.slot.objective?.scope === 'record_grounded_extension' ? original.slot.objective.selectionBasis : null });
    draft.questionBlueprint = blueprint; draft.approvedQuestion = approveQuestionContract(draft, blueprint, { policyDigest: context.interviewerPolicy?.contentSha256, strategyCatalogDigest: context.questionStrategies?.contentSha256 });
    const voice = original.candidate.voiceSettings, speechHash = speechAudioCacheId(draft.questionText, voice);
    let bytes = await readDurableSpeechAudio(speechHash);
    if (!bytes?.length && options.resumeFrom) throw new Error('PARTIAL_SURFACE_REUSED_DURABLE_AUDIO_MISSING');
    if (!bytes?.length) { if (report.ttsCalls >= options.maxTtsCalls) throw new Error('PARTIAL_SURFACE_TTS_CAP_REACHED'); report.ttsCalls++; await synthesizeSpeech(draft.questionText, voice.speaker, { settings: voice, role: original.slot.interviewerId === 'interviewer-1' ? 'primary' : 'secondary' }); bytes = await readDurableSpeechAudio(speechHash); }
    if (!bytes?.length) throw new Error('PARTIAL_SURFACE_AUDIO_MISSING');
    report.speechHash = speechHash; report.audioSha256 = sha(bytes);
    const candidate: PreparedMainCandidate = { ...structuredClone(original.candidate), createdAt: new Date().toISOString(), draft, questionSha256: sha(draft.questionText), speechHash, questionAudioUrl: `/api/audio/${speechHash}`, audioSha256: sha(bytes) };
    report.semanticContractPreserved = same(semantic(candidate), proposal.semanticContract);
    assertQuestionContractIntegrity(candidate.draft, candidate.draft.approvedQuestion!);
    if (!report.semanticContractPreserved || !await verifyPreparedMainCandidate(context, candidate, { root, previous })) throw new Error('PARTIAL_SURFACE_STANDARD_VALIDATION_FAILED');
    report.standardCandidateVerified = true;
    const updated = structuredClone(partial); updated.slots.find(row => row.slotId === proposal.slotId)!.candidates = [candidate];
    if (!await absent(readyFile) || sha(await readFile(partialFile)) !== report.originalPartialSha256) throw new Error('PARTIAL_SURFACE_CONCURRENT_WRITER_DETECTED');
    const temporary = `${partialFile}.${randomUUID()}.tmp`, bytesOut = Buffer.from(JSON.stringify(updated, null, 2));
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytesOut); await handle.sync(); await handle.close();
      if (!await absent(readyFile) || sha(await readFile(partialFile)) !== report.originalPartialSha256) throw new Error('PARTIAL_SURFACE_CONCURRENT_WRITER_DETECTED');
      await rename(temporary, partialFile); report.committed = true; report.finalPartialSha256 = sha(await readFile(partialFile));
    } finally { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
    await output.write(report); return report;
  }, { operation: 'one_reviewed_unactivated_partial_surface', proposalPath: options.proposalPath, externalProviderCalls: 0, committed: false });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  dotenv.config({ path: '.env.local', quiet: true });
  const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!arg('proposal') || !arg('output')) throw new Error('PARTIAL_SURFACE_PROPOSAL_AND_OUTPUT_REQUIRED');
  repairPartialBankSurface({ proposalPath: arg('proposal')!, output: arg('output')!, runLive: process.argv.includes('--run-live'), maxLlmCalls: Number(arg('max-llm-calls') ?? 0), maxTtsCalls: Number(arg('max-tts-calls') ?? 0), resumeFrom: arg('resume-from') }).then(report => {
    console.log(JSON.stringify({ bankKey: report.bankKey, candidateId: report.candidateId, llmCalls: report.llmCalls, ttsCalls: report.ttsCalls, committed: report.committed, standardCandidateVerified: report.standardCandidateVerified, failure: report.failure }));
  }).catch(() => { console.error('PARTIAL_SURFACE_REPAIR_FAILED_SEE_RESERVED_REPORT'); process.exitCode = 1; });
}
