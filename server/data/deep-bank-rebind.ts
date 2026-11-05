/** One-off, offline deep-analysis migration planning. This module cannot call a
 * provider, approve a draft, write a bank or activate a source pointer. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { InterviewContext, StudentEvidence } from './load-interview-context';
import type { FullRecordSource } from './full-student-analysis';
import type { PreparedMainCandidate, PreparedQuestionBank } from './prepared-question-bank';
import type { InterviewPlan } from '../interview-planner';
import { assertQuestionContractIntegrity, type StudentObjectiveCandidate } from '../question-objective';
import { buildQuestionPremiseReviewInput, resolveVerifiedCommonPremiseAuthority } from '../providers/question-premises';
import { assertQuestionPresentation } from '../providers/question-plan';
import { canonicalizeQuestionCitations } from '../providers/question-grounding';
import { speechAudioCacheId, type VoiceSettings } from '../providers/clova-tts';

export const DEEP_BANK_REBIND_VERSION = 'deep-analysis-exact-bank-rebind-plan-v1';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
export const deepRebindDigest = (value: unknown) => sha(JSON.stringify(stable(value)));
const same = (a: unknown, b: unknown) => deepRebindDigest(a) === deepRebindDigest(b);

/** Only revision bookkeeping and selection priority are excluded. Intent,
 * known/unknown facts, prohibited premises and source IDs are never paraphrased. */
export function deepRebindObjectiveContract(objective: StudentObjectiveCandidate) {
  const { analysisRevision, priority, priorityReason, ...contract } = objective;
  void analysisRevision; void priority; void priorityReason;
  return contract;
}
function evidenceContract(source: StudentEvidence) {
  const { projectionProvenance, ...contract } = source;
  // A new analysis pointer changes this trace, never the actual cited bytes.
  return { ...contract, ...(projectionProvenance ? { projectionProvenance: { kind: projectionProvenance.kind, legacyEvidenceId: projectionProvenance.legacyEvidenceId } } : {}) };
}
function exactEvidenceInRecord(source: StudentEvidence, record: FullRecordSource) {
  return source.sourceRef.pdfSha256 === record.pdfSha256 && source.page === source.sourceRef.page &&
    Number.isInteger(source.sourceRef.startOffset) && Number.isInteger(source.sourceRef.endOffset) && source.sourceRef.startOffset >= 0 && source.sourceRef.endOffset > source.sourceRef.startOffset &&
    record.pages.find(page => page.page === source.page)?.text.slice(source.sourceRef.startOffset, source.sourceRef.endOffset) === source.text;
}
function entitiesFor(objective: StudentObjectiveCandidate, context: InterviewContext, extraEvidenceIds: string[] = []) {
  const sourceIds = new Set([...objective.evidenceIds, ...objective.anchorRefs.map(ref => ref.sourceId), ...extraEvidenceIds]);
  const ids = [...objective.activityIds, ...(objective.originEntityId && objective.originKind !== 'common_approved' ? [objective.originEntityId] : []),
    ...context.student.evidence.flatMap(source => sourceIds.has(source.id) && source.originEntityId ? [source.originEntityId] : [])];
  // Multi-row academic evidence and both sides of a possible connection retain
  // their own typed entity context; no semantic matching or causal inference.
  for (const id of ids.slice()) {
    const link = context.studentAnalysis?.trajectories.find(row => row.id === id);
    if (link) ids.push(link.fromEntityId, link.toEntityId);
  }
  return [...new Set(ids)];
}
function entityAt(context: InterviewContext, id: string) { return [...(context.studentAnalysis?.activities ?? []), ...(context.studentAnalysis?.academicRecords ?? []), ...(context.studentAnalysis?.trajectories ?? [])].find(row => row.id === id); }
function preservedEntity(old: NonNullable<ReturnType<typeof entityAt>>, current: NonNullable<ReturnType<typeof entityAt>>) {
  if ('facts' in old) return 'facts' in current && Object.entries(old.facts).every(([field, proofs]) => proofs.every(proof => current.facts[field as keyof typeof current.facts].some(value => same(proof, value))));
  if ('literalValues' in old) return 'literalValues' in current && same({ ...old, interpretations: undefined }, { ...current, interpretations: undefined });
  return same(old, current);
}
export interface DeepBankRebindRow {
  oldCandidateId: string; oldSlotId: string; oldObjectiveId: string; semanticKey: string | null;
  questionText: string; questionSha256: string; originalApprovedContractSha256: string;
  oldPrimaryFunction: string; oldDepth: string;
  stagedSlotId: string | null; stagedObjectiveId: string | null;
  status: 'ready_for_independent_review' | 'pending_manual_match';
  reasons: string[]; objectiveContractDifferences: string[];
  exactEvidenceIds: string[]; changedEntityContextIds: string[];
  originalTargetObjective: StudentObjectiveCandidate | null;
  audio: { speechHash: string; audioSha256: string; settingsUnchanged: boolean; bytesVerified: boolean };
  reviewInput: ReturnType<typeof buildQuestionPremiseReviewInput> | null;
  currentMeaningContext: { objective: StudentObjectiveCandidate; entities: unknown[] } | null;
}
interface RebindInputs {
  oldContext: InterviewContext; stagedContext: InterviewContext; bank: PreparedQuestionBank;
  stagedPlan: InterviewPlan; stagedVoices: PreparedQuestionBank['voices']; source: FullRecordSource;
}

/** Identifier joins and exact typed/source comparisons only. A matching
 * semanticKey does not authorize importing a differently worded objective. */
export function compareDeepBankRebindQuestion(input: RebindInputs, candidate: PreparedMainCandidate, audioBytes: Buffer | null): DeepBankRebindRow {
  const { oldContext, stagedContext, bank, stagedPlan, stagedVoices, source } = input;
  const oldSlot = bank.plan.slots.find(slot => slot.id === candidate.slotId), objective = oldSlot?.objective;
  if (!oldSlot || !objective || !candidate.draft.approvedQuestion) throw new Error('DEEP_REBIND_OLD_CONTRACT_MISSING');
  assertQuestionContractIntegrity(candidate.draft, candidate.draft.approvedQuestion);
  if (candidate.questionSha256 !== sha(candidate.draft.questionText)) throw new Error('DEEP_REBIND_OLD_UTTERANCE_HASH_CHANGED');
  const matches = stagedPlan.slots.filter(slot => slot.objective?.id === objective.id && slot.objective.semanticKey === objective.semanticKey);
  const slot = matches.length === 1 ? matches[0] : undefined;
  const oldRaw = oldContext.targetAnalysis?.objectives.find(row => row.id === objective.id);
  const newRaw = stagedContext.targetAnalysis?.objectives.find(row => row.id === objective.id);
  const isCommon = objective.grounding?.kind === 'COMMON_APPROVED';
  const reasons: string[] = [], objectiveContractDifferences: string[] = [], exactEvidenceIds: string[] = [], changedEntityContextIds: string[] = [];
  if (!slot?.objective) reasons.push(matches.length > 1 ? 'AMBIGUOUS_EXACT_OBJECTIVE_ID' : 'EXACT_OBJECTIVE_ID_AND_KEY_MISSING');
  if (!isCommon && (!oldRaw || !newRaw)) reasons.push('TARGET_OBJECTIVE_NOT_IN_PINNED_ANALYSIS');
  const expected = deepRebindObjectiveContract(isCommon ? objective : oldRaw ?? objective);
  const actual = slot?.objective ? deepRebindObjectiveContract(isCommon ? slot.objective : newRaw ?? slot.objective) : null;
  if (actual) for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) if (!same(expected[key as keyof typeof expected], actual[key as keyof typeof actual])) objectiveContractDifferences.push(key);
  if (objectiveContractDifferences.length) reasons.push('OBJECTIVE_CONTRACT_CHANGED');
  if (slot && (slot.primaryFunction !== candidate.draft.primaryFunction || slot.depth !== candidate.draft.depth || slot.objective?.questionIntent !== candidate.draft.questionIntent || !same(slot.objective.targetEvidence, candidate.draft.targetEvidence))) reasons.push('SPOKEN_DEMAND_CONTRACT_CHANGED');
  for (const id of [...new Set([...candidate.draft.evidenceIds, ...objective.anchorRefs.map(ref => ref.sourceId)])]) {
    const old = oldContext.student.evidence.find(row => row.id === id), current = stagedContext.student.evidence.find(row => row.id === id);
    if (!old || !current || !same(evidenceContract(old), evidenceContract(current)) || !exactEvidenceInRecord(current, source)) reasons.push(`EXACT_RECORD_EVIDENCE_CHANGED:${id}`);
    else exactEvidenceIds.push(id);
  }
  for (const id of entitiesFor(oldRaw ?? objective, oldContext, [...candidate.draft.evidenceIds, ...objective.evidenceIds])) {
    const old = entityAt(oldContext, id), current = entityAt(stagedContext, id);
    if (!old || !current || !preservedEntity(old, current)) reasons.push(`REFERENCED_ENTITY_OR_FACT_NOT_PRESERVED:${id}`);
    else if (!same(old, current)) changedEntityContextIds.push(id);
  }
  const voice: VoiceSettings | undefined = slot ? stagedVoices[slot.interviewerId === 'interviewer-1' ? 'primary' : 'secondary'] : undefined;
  const settingsUnchanged = Boolean(voice && same(candidate.voiceSettings, voice) && candidate.speechHash === speechAudioCacheId(candidate.draft.questionText, voice));
  const bytesVerified = Boolean(audioBytes?.length && sha(audioBytes) === candidate.audioSha256 && candidate.questionAudioUrl === `/api/audio/${candidate.speechHash}`);
  if (!settingsUnchanged) reasons.push('VOICE_SETTINGS_OR_ROLE_CHANGED');
  if (!bytesVerified) reasons.push('DURABLE_AUDIO_BYTES_NOT_VERIFIED');
  let reviewInput: DeepBankRebindRow['reviewInput'] = null;
  if (!reasons.length && slot?.objective) {
    try {
      const draft = structuredClone(candidate.draft);
      // These old artifacts remain only in the preserved donor. A dry-run must
      // not present a prior source review as a current-source approval.
      delete draft.premiseValidation; delete draft.approvedQuestion; delete draft.questionBlueprint;
      const sources = stagedContext.student.evidence.filter(row => draft.evidenceIds.includes(row.id));
      canonicalizeQuestionCitations(draft, sources); assertQuestionPresentation(draft);
      reviewInput = buildQuestionPremiseReviewInput(draft, sources, undefined, undefined, [], resolveVerifiedCommonPremiseAuthority(stagedContext, draft));
    } catch { reasons.push('CURRENT_SOURCE_REVIEW_INPUT_INVALID'); }
  }
  return { oldCandidateId: candidate.id, oldSlotId: candidate.slotId, oldObjectiveId: objective.id, semanticKey: objective.semanticKey ?? null,
    questionText: candidate.draft.questionText, questionSha256: candidate.questionSha256, originalApprovedContractSha256: candidate.draft.approvedQuestion.contentSha256,
    oldPrimaryFunction: candidate.draft.primaryFunction, oldDepth: candidate.draft.depth, stagedSlotId: slot?.id ?? null, stagedObjectiveId: slot?.objective?.id ?? null,
    status: reasons.length ? 'pending_manual_match' : 'ready_for_independent_review', reasons, objectiveContractDifferences, exactEvidenceIds, changedEntityContextIds,
    originalTargetObjective: oldRaw ? structuredClone(oldRaw) : null,
    audio: { speechHash: candidate.speechHash, audioSha256: candidate.audioSha256, settingsUnchanged, bytesVerified }, reviewInput,
    currentMeaningContext: slot?.objective ? { objective: structuredClone(slot.objective), entities: entitiesFor(slot.objective, stagedContext, candidate.draft.evidenceIds).map(id => structuredClone(entityAt(stagedContext, id) ?? { missingEntityId: id })) } : null };
}

/** Caller loads both contexts/bank through the normal pinned-source validators.
 * Reading audio verifies cache reuse; it never synthesizes missing files. */
export async function planDeepBankRebind(input: RebindInputs, root = process.cwd()) {
  const { oldContext, stagedContext, bank, source } = input;
  if (!oldContext.studentAnalysis || !stagedContext.studentAnalysis || !oldContext.targetAnalysis || !stagedContext.targetAnalysis ||
    !oldContext.student.pdfSha256 || oldContext.student.pdfSha256 !== stagedContext.student.pdfSha256 || source.pdfSha256 !== oldContext.student.pdfSha256 ||
    oldContext.studentAnalysis.studentId !== stagedContext.studentAnalysis.studentId || source.studentId !== stagedContext.studentAnalysis.studentId ||
    oldContext.studentAnalysis.sourceContentSha256 !== stagedContext.studentAnalysis.sourceContentSha256 || source.contentSha256 !== stagedContext.studentAnalysis.sourceContentSha256 || !same(oldContext.target, stagedContext.target)) throw new Error('DEEP_REBIND_STUDENT_RECORD_OR_TARGET_CHANGED');
  if (oldContext.errors.length || stagedContext.errors.length || oldContext.manifest.errors.length || stagedContext.manifest.errors.length) throw new Error('DEEP_REBIND_CONTEXT_INVALID');
  const unchangedPins = (context: InterviewContext) => context.manifest.files.filter(row => row.role !== 'fullStudentAnalysis').sort((a, b) => a.role.localeCompare(b.role));
  if (!same(unchangedPins(oldContext), unchangedPins(stagedContext)) ||
    oldContext.manifest.rulesVersion !== stagedContext.manifest.rulesVersion || oldContext.interviewerPolicy?.contentSha256 !== stagedContext.interviewerPolicy?.contentSha256 || oldContext.questionStrategies?.contentSha256 !== stagedContext.questionStrategies?.contentSha256) throw new Error('DEEP_REBIND_POLICY_OR_OFFICIAL_SOURCE_CHANGED');
  const { contentSha256, ...body } = bank;
  if (bank.status !== 'ready' || contentSha256 !== deepRebindDigest(body)) throw new Error('DEEP_REBIND_DONOR_BANK_HASH_INVALID');
  const candidates = bank.slots.flatMap(row => row.candidates);
  if (!candidates.length || candidates.length > 30) throw new Error('DEEP_REBIND_REQUIRES_1_TO_30_RETAINED_QUESTIONS');
  const rows: DeepBankRebindRow[] = [];
  for (const candidate of candidates) {
    const validId = /^[a-f0-9]{64}$/u.test(candidate.speechHash);
    const bytes = validId ? await readFile(path.resolve(root, 'data/audio', `${candidate.speechHash}.mp3`)).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }) : null;
    rows.push(compareDeepBankRebindQuestion(input, candidate, bytes));
  }
  return { version: DEEP_BANK_REBIND_VERSION, mode: 'dry_run_exact_mapping_only' as const, externalProviderCalls: 0 as const, ttsCalls: 0 as const, activated: false as const,
    originalRecordsModified: false as const, approvalGranted: false as const, donorBankKey: bank.key, donorBankContentSha256: bank.contentSha256,
    oldCommonContentSha256: oldContext.studentAnalysis.contentSha256, stagedCommonContentSha256: stagedContext.studentAnalysis.contentSha256,
    stagedTargetContentSha256: stagedContext.targetAnalysis.contentSha256, sourceContentSha256: source.contentSha256, sourcePdfSha256: source.pdfSha256,
    counts: { total: rows.length, readyForIndependentReview: rows.filter(row => row.status === 'ready_for_independent_review').length, pendingManualMatch: rows.filter(row => row.status === 'pending_manual_match').length },
    paidPreparationPlan: { maxPhysicalLlmCalls: 30, sdkRetries: 0, questionGenerationCalls: 0, maxTtsCalls: 0, independentPremiseReviewsPerReadyQuestion: 1,
      nextStep: 'Explicit source/intent mapping review first; then a separately authorized preparation command must perform actual independent review and rebuild current-source approved contracts. This dry-run grants no approval and writes no bank.' },
    rows };
}
