import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { interviewConfig } from '../../interview.config';
import { createInterviewPlan, QUESTION_SELECTION_POLICY_VERSION, type InterviewPlan, type InterviewPlanSlot } from '../interview-planner';
import { questionDraftSchema, type InterviewSession, type QuestionDraft, type RecordedTurn } from '../protocol';
import { interviewerVoiceDefaults, resolveVoiceSettings, speechAudioCacheId, type VoiceSettings } from '../providers/clova-tts';
import { assertInterviewQuestionSpeech } from '../providers/interview-speech';
import { canonicalizeQuestionCitations, QuestionPreparationError, type QuestionValidationCode } from '../providers/question-grounding';
import { QUESTION_PREMISE_REVIEW_POLICY_VERSION } from '../providers/question-premises';
import { assertQuestionPresentation, attachVerifiedQuestionPlan } from '../providers/question-plan';
import type { InterviewContext } from './load-interview-context';
import { loadPreparedActivities } from './prepared-activities';
import { bookQuestionReferenceUsage } from './book-question-reference';
import { assertQuestionContractIntegrity, QUESTION_OBJECTIVE_VERSION } from '../question-objective';
import { questionSelectionScope, selectionEligibility, sessionPlanFromPool, slotSemanticKey, type QuestionSelectionOptions } from '../question-selection';
import { createQuestionReviewAuthorityScope, resolveQuestionReviewAuthority, type QuestionReviewAuthorityScope } from './question-review-authority';
import { decodePreparedMainCandidate } from '../contracts/question-domain-codecs';
import { emptyReadScope } from '../repositories/analysis-read-ports';
import type { QuestionBankRepository, QuestionBankScope, QuestionBankPurpose } from '../repositories/question-bank-ports';
import { createLocalQuestionBankRepository } from '../repositories/local-question-bank-repository';
import type { AudioRepository } from '../repositories/audio-ports';
import { createLocalAudioRepository } from '../repositories/local-audio-repository';

export const QUESTION_BANK_POLICY_VERSION = 'prepared-q0-objective-pool-v2';
export const QUESTION_GENERATION_POLICY_VERSION = 'independently-reviewed-objective-q0-v3';
export const QUESTION_PREPARATION_POLICY_VERSION = 'bounded-objective-quarantine-v1';
const DEFAULT_PLAN_SEED = 'prepared-objective-pool-v2';
type Environment = Record<string, string | undefined>;
type BankRole = 'primary' | 'secondary';
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonicalQuestion = (text: string) => text.normalize('NFC').replace(/\s+/gu, '').replace(/[.!?。？]+$/u, '');
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)]));
  return value;
}
const fingerprint = (value: unknown) => sha256(JSON.stringify(stable(value)));

export interface PreparedMainCandidate {
  id: string;
  slotId: string;
  mainIndex: number;
  variant: 0 | 1;
  createdAt: string;
  draft: QuestionDraft;
  questionSha256: string;
  questionAudioUrl: string;
  speechHash: string;
  audioSha256: string;
  voiceSettings: VoiceSettings;
}
export interface QuarantinedQuestionObjective {
  status: 'quarantined';
  slotId: string;
  objectiveId: string;
  objectiveSha256: string;
  failureCode: QuestionValidationCode;
  validationAttempts: 1 | 2;
  independentReaudit?: { reviewArtifactSha256: string; reviewedAt: string };
  quarantinedAt: string;
  preparationPolicyVersion: typeof QUESTION_PREPARATION_POLICY_VERSION;
}
interface PreparedQuestionSlot {
  slotId: string;
  mainIndex: number;
  candidates: PreparedMainCandidate[];
  /** An objective preparation was started; this is not an exact provider-call counter. */
  attemptedAt?: string;
  quarantine?: QuarantinedQuestionObjective;
}
export interface PreparedQuestionBank {
  schemaVersion: typeof QUESTION_BANK_POLICY_VERSION;
  status: 'ready';
  key: string;
  createdAt: string;
  completedAt: string;
  plan: InterviewPlan;
  target: InterviewContext['target'];
  rulesVersion: string;
  /** Exact offline extraction artifact used when preparing these questions. */
  activitiesContentSha256: string | null;
  questionReferenceDigest?: string | null;
  sourceFingerprint: string;
  questionModel: string;
  voices: Record<BankRole, VoiceSettings>;
  slots: PreparedQuestionSlot[];
  contentSha256: string;
}
export interface QuestionBankPartial extends Omit<PreparedQuestionBank, 'status' | 'completedAt' | 'contentSha256'> { status: 'preparing' }
export interface QuestionBankProviders {
  /** Must return the ordinary, independently premise-reviewed draft. Never a self-approved replacement. */
  generate(context: InterviewContext, session: InterviewSession, excludedQuestionTexts: string[]): Promise<QuestionDraft>;
  synthesize(text: string, voice: VoiceSettings, role: BankRole): Promise<{ audioUrl: string; bytes: Buffer }>;
}
export interface BankOptions { root?: string; plan?: InterviewPlan; environment?: Environment;
  bankRepository?: QuestionBankRepository; audioRepository?: AudioRepository; scope?: Partial<QuestionBankScope> }
export interface PrepareQuestionBankOptions extends BankOptions {
  concurrency?: 1 | 2;
  /** Explicit per-command cost cap; an incomplete pool remains unavailable at runtime. */
  maxNewCandidates?: number;
  providers?: QuestionBankProviders;
  /** Explicit offline migration only: unchanged objectives are fully revalidated, never self-approved. */
  reuseFromBankKey?: string;
  onProgress?: (event: { key: string; completed: number; total: number; slotId: string; objectiveId: string; variant: 0 | 1; cacheHit: boolean; status: 'approved' | 'quarantined'; attemptedObjectives: number; quarantinedObjectives: number; failureCode?: QuestionValidationCode }) => void;
}
export class QuestionPreparationBudgetError extends Error {
  readonly code = 'QUESTION_PREPARATION_BUDGET_REACHED';
  constructor(readonly newCandidates: number) { super('질문 준비 예산에 도달했습니다. 검증된 부분 체크포인트는 보존하며 같은 명령으로 이어서 준비할 수 있습니다.'); this.name = 'QuestionPreparationBudgetError'; }
}
export class QuestionPoolUnavailableError extends Error {
  readonly code = 'NO_APPROVED_QUESTION_CANDIDATES';
  constructor() { super('검수를 통과한 면접 질문이 없습니다. 격리된 목표의 근거와 분석을 수정한 뒤 새 자료 버전으로 준비해 주세요.'); this.name = 'QuestionPoolUnavailableError'; }
}

const validationFailureCodes = new Set<QuestionValidationCode>(['INVALID_FORMAT', 'MISSING_EVIDENCE', 'UNKNOWN_EVIDENCE', 'MISSING_CITATION', 'DUPLICATE_CITATION', 'UNDECLARED_CITATION', 'CITATION_NOT_FOUND', 'FIRST_QUESTION_KIND', 'FOLLOW_UP_RULE', 'UNAPPROVED_QUESTION', 'FORBIDDEN_SPEECH', 'MULTIPLE_QUESTIONS', 'REPEATED_QUESTION', 'PLAN_MISMATCH', 'REPEATED_INTENT', 'PREMISE_UNSUPPORTED', 'PREMISE_UNCERTAIN', 'PREMISE_REVIEW_INVALID']);
const validTimestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function validQuarantine(value: QuarantinedQuestionObjective | undefined, slot: InterviewPlanSlot, plan: InterviewPlan, context: InterviewContext): value is QuarantinedQuestionObjective {
  const trace = context.targetAnalysis?.objectiveContractRevision;
  const attemptsValid = value?.validationAttempts === 2 || value?.validationAttempts === 1 && Boolean(value.independentReaudit && trace && trace.reviewArtifactSha256 === value.independentReaudit.reviewArtifactSha256 && trace.reviewedAt === value.independentReaudit.reviewedAt && trace.blockedObjectives.some(row => row.objectiveId === (slot.objective?.id ?? slot.id) && row.failureCode === value.failureCode) && /^[a-f0-9]{64}$/u.test(value.independentReaudit.reviewArtifactSha256) && validTimestamp(value.independentReaudit.reviewedAt));
  return Boolean(plan.purpose === 'candidate_pool' && value && value.status === 'quarantined' && value.slotId === slot.id && value.objectiveId === (slot.objective?.id ?? slot.id) && value.objectiveSha256 === fingerprint(slot.objective ?? slot) && attemptsValid && validTimestamp(value.quarantinedAt) && value.preparationPolicyVersion === QUESTION_PREPARATION_POLICY_VERSION && validationFailureCodes.has(value.failureCode));
}
function validPreparedRow(row: PreparedQuestionSlot | undefined, slot: InterviewPlanSlot, plan: InterviewPlan, context: InterviewContext): row is PreparedQuestionSlot {
  if (!row || row.slotId !== slot.id || row.mainIndex !== slot.index || !Array.isArray(row.candidates)) return false;
  if (row.quarantine) return row.candidates.length === 0 && validQuarantine(row.quarantine, slot, plan, context);
  return row.candidates.length === variantsPerObjective(plan) && row.candidates.every((candidate, index) => candidate.variant === index);
}

export function defaultQuestionBankPlan(context: InterviewContext) { return createInterviewPlan(context, DEFAULT_PLAN_SEED); }
function variantsPerObjective(plan: InterviewPlan) { return plan.purpose === 'candidate_pool' ? 1 : 2; }
function isCommonSlot(slot: InterviewPlanSlot) { return slot.objective && 'grounding' in slot.objective && (slot.objective.grounding as { kind?: string } | undefined)?.kind === 'COMMON_APPROVED'; }
function sourceFingerprintForContext(context: InterviewContext) {
  return fingerprint({ schemaVersion: context.manifest.schemaVersion, target: context.target, rulesVersion: context.manifest.rulesVersion, guidelineSourceVersions: context.manifest.guidelineSourceVersions, files: [...context.manifest.files].sort((a, b) => a.role.localeCompare(b.role)), recordIds: context.manifest.recordIds, evidenceIds: context.manifest.evidenceIds, studentEvidence: context.student.evidence, sourceIntegrity: context.manifest.sourceIntegrity });
}

export function questionBankIdentity(context: InterviewContext, options: Pick<BankOptions, 'plan' | 'environment'> = {}) {
  const integrity = context.manifest.sourceIntegrity;
  if (context.errors.length || context.manifest.errors.length || !integrity.pdfHashVerified || !integrity.evidenceReferencesVerified || !integrity.evidenceTextVerified || !context.student.evidence.length || integrity.evidenceCount !== context.student.evidence.length || context.manifest.files.some(file => !file.sha256 || !/^[a-f0-9]{64}$/iu.test(file.sha256))) throw new Error('질문 은행의 검증된 원문 자료를 확인할 수 없습니다.');
  if (context.manifest.rulesVersion !== interviewConfig.rulesVersion) throw new Error('질문 은행의 실행 규칙과 자료 버전이 일치하지 않습니다.');
  const plan = structuredClone(options.plan ?? defaultQuestionBankPlan(context));
  const duration = context.interviewOverview?.durationSeconds;
  if (!duration || plan.durationSeconds !== duration || plan.slots.length !== plan.mainQuestionTarget || !plan.slots.length) throw new Error('질문 은행의 공식 면접 시간과 질문 계획을 확인할 수 없습니다.');
  if (new Set(plan.slots.map(slot => slot.id)).size !== plan.slots.length || plan.slots.some((slot, index) => slot.index !== index + 1 || !slot.evidenceIds.length && !isCommonSlot(slot) || slot.evidenceIds.some(id => !context.student.evidence.some(evidence => evidence.id === id)) || !['interviewer-1', 'interviewer-2'].includes(slot.interviewerId))) throw new Error('질문 은행의 원문·슬롯 연결이 유효하지 않습니다.');
  const environment = options.environment ?? process.env;
  const voices = {
    primary: resolveVoiceSettings(environment.CLOVA_VOICE_SPEAKER || interviewerVoiceDefaults.primary, environment, { role: 'primary' }),
    secondary: resolveVoiceSettings(environment.CLOVA_VOICE_SECOND_SPEAKER || interviewerVoiceDefaults.secondary, environment, { role: 'secondary' }),
  };
  const sourceFingerprint = sourceFingerprintForContext(context);
  const questionModel = environment.OPENAI_QUESTION_MODEL || 'gpt-6-luna';
  const questionReferenceDigest = context.manifest.questionReferenceCatalog?.digest ?? null;
  if (questionReferenceDigest && (!context.questionReferences || !context.questionReferences.counts.runtimeApprovedQuestions || context.questionReferences.digest !== questionReferenceDigest || context.questionReferences.schemaVersion !== context.manifest.questionReferenceCatalog?.schemaVersion)) throw new Error('검수된 질문 참고 자료의 검증 결과와 실행 맥락이 일치하지 않습니다.');
  const interviewerPolicyDigest = context.interviewerPolicy?.contentSha256 ?? null;
  const questionStrategyDigest = context.questionStrategies?.contentSha256 ?? null;
  if ((context.manifest.interviewerPolicy?.contentSha256 ?? null) !== interviewerPolicyDigest || (context.manifest.questionStrategyCatalog?.contentSha256 ?? null) !== questionStrategyDigest) throw new Error('질문 은행의 정책·전략 자료가 원천 명세와 일치하지 않습니다.');
  if (context.questionStrategies && !context.questionStrategies.coverage.complete) throw new Error('전체 질문 전략의 분석이 아직 완료되지 않았습니다.');
  const key = fingerprint({ policy: QUESTION_BANK_POLICY_VERSION, generationPolicy: QUESTION_GENERATION_POLICY_VERSION, preparationPolicy: QUESTION_PREPARATION_POLICY_VERSION, premiseReviewPolicy: QUESTION_PREMISE_REVIEW_POLICY_VERSION, selectionPolicy: QUESTION_SELECTION_POLICY_VERSION, objectiveVersion: QUESTION_OBJECTIVE_VERSION, planSeed: DEFAULT_PLAN_SEED, sourceFingerprint, plan, questionModel, voices, questionReferenceDigest, interviewerPolicyDigest, questionStrategyDigest, variantsPerSlot: variantsPerObjective(plan), greetingPolicy: 'no-greeting-in-bank' });
  return { key, plan, target: structuredClone(context.target), sourceFingerprint, questionModel, voices, questionReferenceDigest };
}

function bankStorage(context: InterviewContext, identity: { key: string; sourceFingerprint: string }, options: BankOptions, purpose: QuestionBankPurpose, contentSha256: string | null = null) {
  const root = path.resolve(options.root ?? process.cwd()), bankRepository = options.bankRepository ?? createLocalQuestionBankRepository(root), audioRepository = options.audioRepository ?? createLocalAudioRepository(root);
  const scope: QuestionBankScope = { ...emptyReadScope(bankRepository.ownerId), studentId: context.student.studentId ?? context.studentAnalysis?.studentId ?? null,
    supportTargetId: context.targetAnalysis?.supportTargetId ?? context.school?.interview?.id ?? null, pdfSha256: context.student.pdfSha256 ?? null,
    recordRevision: context.student.recordRevision ?? context.studentAnalysis?.recordRevision ?? null, sourceContentSha256: context.studentAnalysis?.sourceContentSha256 ?? null,
    commonRevision: context.studentAnalysis?.revision ?? context.student.analysisRevision ?? null, targetRevision: context.targetAnalysis?.revision ?? null,
    profileRevision: context.targetAnalysis?.profileRevision ?? null, bankKey: identity.key, bankContentSha256: contentSha256, sourceFingerprint: identity.sourceFingerprint };
  for (const [key, supplied] of Object.entries(options.scope ?? {}) as Array<[keyof QuestionBankScope, string | null | undefined]>) {
    if (supplied == null) continue;
    if (key === 'bankContentSha256' && scope[key] === null) scope[key] = supplied;
    else if (scope[key] === null || scope[key] !== supplied) throw new Error('QUESTION_BANK_READ_SCOPE_MISMATCH');
  }
  if (!scope.ownerId || scope.ownerId !== bankRepository.ownerId || scope.ownerId !== audioRepository.ownerId) throw new Error('QUESTION_BANK_REPOSITORY_OWNER_MISMATCH');
  return { root, bankRepository, audioRepository, scope, request: { scope, purpose } };
}
type BankStorage = ReturnType<typeof bankStorage>;
function matchesRequestedBank(value: PreparedQuestionBank, storage: BankStorage) {
  return value.key === storage.scope.bankKey && (storage.scope.bankContentSha256 === null || value.contentSha256 === storage.scope.bankContentSha256) &&
    (storage.scope.sourceFingerprint === null || value.sourceFingerprint === storage.scope.sourceFingerprint);
}
function historySession(context: InterviewContext, plan: InterviewPlan, previous: PreparedMainCandidate[], nextSlot?: InterviewPlanSlot): InterviewSession {
  const now = new Date().toISOString();
  // Rejected pool objectives are not fictitious previous questions. For offline
  // generation only, bind the next position to the actual requested objective.
  // The durable bank keeps its original, complete plan and source-slot indexes.
  const previousSlots = previous.map(candidate => plan.slots.find(slot => slot.id === candidate.slotId)!);
  const orderedSlots = plan.purpose === 'candidate_pool' && nextSlot
    ? [...previousSlots, nextSlot, ...plan.slots.filter(slot => slot.id !== nextSlot.id && !previousSlots.some(previousSlot => previousSlot.id === slot.id))].map((slot, index) => ({ ...slot, index: index + 1 }))
    : plan.slots;
  const sessionPlan = { ...plan, slots: orderedSlots };
  const turns = previous.map((candidate, index) => {
    const slot = plan.purpose === 'candidate_pool' && nextSlot ? orderedSlots[index] : plan.slots[candidate.mainIndex - 1], id = randomUUID(), draft = candidate.draft;
    return { id, questionText: draft.questionText, questionKind: 'main', parentMainQuestionId: id, mainIndex: slot.index, mainCount: plan.mainQuestionTarget, followUpIndex: 0, evidenceIds: draft.evidenceIds, questionAudioUrl: candidate.questionAudioUrl, acknowledgement: null, acknowledgementAudioUrl: null, interviewerId: slot.interviewerId,
      metadata: { ...structuredClone(draft), acknowledgementQuote: null, rulesVersion: context.manifest.rulesVersion, generatedAt: candidate.createdAt, answerTurnId: null, sourceRefIds: draft.evidenceIds, activityIds: slot.activityIds, supportTarget: context.target, questionClusterId: id, parentQuestionId: null, nonEvaluative: false } } satisfies RecordedTurn;
  });
  // Q0 bank preparation is not a user interview or a playback event. No answers are fabricated.
  return { id: randomUUID(), createdAt: now, updatedAt: now, status: 'active', evaluationStatus: 'pending', target: context.target, sourceManifest: context.manifest, durationSeconds: plan.durationSeconds, plan: sessionPlan, mainQuestionTarget: plan.mainQuestionTarget, hasGreeted: true, turns, questionPresentations: [], questionPresentationEventIds: [], followUpCountByMainQuestion: {}, elapsedMs: 0 };
}
function roleFor(slot: InterviewPlanSlot): BankRole { return slot.interviewerId === 'interviewer-1' ? 'primary' : 'secondary'; }

/** Disk reads, hashes and deterministic validators only; never a model, speech or network call. */
export interface PreparedCandidateDiagnostic { valid: boolean; gate: string; failureCode: string | null }
async function validCandidate(value: PreparedMainCandidate, context: InterviewContext, identity: ReturnType<typeof questionBankIdentity>, slot: InterviewPlanSlot, previous: PreparedMainCandidate[], storage: BankStorage, diagnose?: (value: PreparedCandidateDiagnostic) => void, authorityScope?: QuestionReviewAuthorityScope): Promise<boolean> {
  let gate = 'CANDIDATE_IDENTITY', valid = false, failureCode: string | null = null;
  try {
    gate = 'CURRENT_DOMAIN_CODEC';
    decodePreparedMainCandidate(value);
    gate = 'CANDIDATE_IDENTITY';
    if (!value || ![0, 1].includes(value.variant) || value.slotId !== slot.id || value.mainIndex !== slot.index || value.id !== fingerprint({ bankKey: identity.key, slotId: slot.id, variant: value.variant })) return false;
    gate = 'OBJECTIVE_BLOCK_STATUS';
    if (context.targetAnalysis?.objectiveContractRevision?.blockedObjectives.some(item => item.objectiveId === (slot.objective?.id ?? slot.id))) return false;
    gate = 'DRAFT_SCHEMA_AND_SLOT';
    const parsed = questionDraftSchema.safeParse(value.draft);
    if (!parsed.success || value.draft.questionKind !== 'main' || value.draft.acknowledgement !== null || value.draft.acknowledgementQuote !== null || value.draft.parentMainQuestionId !== null || value.draft.primaryFunction !== slot.primaryFunction || value.draft.depth !== slot.depth) return false;
    gate = 'OBJECTIVE_SEMANTIC_CONTRACT';
    if (identity.plan.purpose === 'candidate_pool' && slot.objective && (value.draft.questionIntent !== slot.objective.questionIntent || JSON.stringify(value.draft.targetEvidence) !== JSON.stringify(slot.objective.targetEvidence))) return false;
    gate = 'COMMON_AUTHORITY';
    if (isCommonSlot(slot) && fingerprint(value.draft.commonApproval) !== fingerprint(slot.objective!.grounding)) return false;
    if (!isCommonSlot(slot) && value.draft.commonApproval) return false;
    if (identity.questionReferenceDigest) {
      gate = 'REFERENCE_CATALOG_BINDING';
      const trace = value.draft.questionReferenceContext, corpus = context.questionReferences!;
      if (!trace || trace.purpose !== 'wording_reference_only' || trace.schemaVersion !== corpus.schemaVersion || trace.catalogSha256 !== identity.questionReferenceDigest || !Array.isArray(trace.exampleIds) || trace.exampleIds.length > 8 || new Set(trace.exampleIds).size !== trace.exampleIds.length || trace.exampleIds.some(id => !corpus.questions.some(question => question.id === id && bookQuestionReferenceUsage(question)))) return false;
      if (corpus.analysis && (trace.analysisKey !== corpus.analysis.key || !trace.referenceUses || trace.referenceUses.length !== trace.exampleIds.length || trace.referenceUses.some((use, index) => use.id !== trace.exampleIds[index] || use.usage !== bookQuestionReferenceUsage(corpus.questions.find(question => question.id === use.id)!)))) return false;
    }
    const audit = value.draft.premiseValidation;
    if (context.interviewerPolicy) {
      gate = 'APPROVED_QUESTION_CONTRACT';
      if (!value.draft.questionBlueprint || !value.draft.approvedQuestion || value.draft.approvedQuestion.policyDigest !== context.interviewerPolicy.contentSha256 || value.draft.approvedQuestion.strategyCatalogDigest !== (context.questionStrategies?.contentSha256 ?? null)) return false;
      assertQuestionContractIntegrity(value.draft, value.draft.approvedQuestion);
    }
    if (context.questionStrategies) {
      gate = 'STRATEGY_CATALOG_BINDING';
      const trace = value.draft.strategyTrace;
      if (!context.questionStrategies.coverage.complete || !trace || trace.catalogDigest !== context.questionStrategies.contentSha256 || new Set(trace.candidateCardIds).size !== trace.candidateCardIds.length || trace.candidateCardIds.some(id => !context.questionStrategies!.cards.some(card => card.id === id)) || trace.selectedCardId !== null && !trace.candidateCardIds.includes(trace.selectedCardId)) return false;
      const expectedSources = [...new Set(trace.candidateCardIds.flatMap(id => context.questionStrategies!.cards.find(card => card.id === id)!.sourceBindings.map(binding => binding.questionId)))].slice(0, 8);
      if (JSON.stringify(trace.sourceQuestionIds) !== JSON.stringify(expectedSources) || JSON.stringify(value.draft.questionReferenceContext?.exampleIds ?? []) !== JSON.stringify(expectedSources)) return false;
      if (JSON.stringify(value.draft.questionBlueprint?.strategyIds ?? []) !== JSON.stringify(trace.candidateCardIds)) return false;
    }
    const questionHash = sha256(value.draft.questionText);
    const objectiveId = slot.objective?.id ?? slot.id;
    gate = 'PREMISE_REVIEW_AUTHORITY';
    const independentlyReviewedCorrection = Boolean(audit && audit.reviewModel !== identity.questionModel &&
      await resolveQuestionReviewAuthority(context, objectiveId, questionHash, audit.reviewModel, storage.root, authorityScope));
    if (!audit || audit.version !== 'question-premise-v1' || audit.status !== 'approved' || audit.method !== 'bounded_semantic_review' || audit.guidelineVersion !== '2.3' || audit.reviewModel !== identity.questionModel && !independentlyReviewedCorrection || audit.coreIntentCount !== 1 || audit.questionSha256 !== questionHash || value.questionSha256 !== questionHash) return false;
    if (!Array.isArray(audit.supportedPremises) || !Array.isArray(audit.openChecks) || !audit.supportedPremises.length && !audit.openChecks.length) return false;
    gate = 'PREMISE_SUPPORT_OFFSETS';
    for (const support of audit.supportedPremises) {
      const source = context.student.evidence.find(item => item.id === support.sourceId);
      if (support.basis !== 'record' || !source || !value.draft.evidenceIds.includes(support.sourceId) || !Number.isInteger(support.questionStartOffset) || !Number.isInteger(support.questionEndOffset) || support.questionStartOffset < 0 || support.questionEndOffset <= support.questionStartOffset || support.questionEndOffset > value.draft.questionText.length || !Number.isInteger(support.sourceStartOffset) || !Number.isInteger(support.sourceEndOffset) || support.sourceStartOffset < 0 || support.sourceEndOffset <= support.sourceStartOffset || support.sourceEndOffset > source.text.length) return false;
    }
    gate = 'OPEN_CHECK_OFFSETS';
    for (const check of audit.openChecks) if (!['open_check', 'hypothetical'].includes(check.kind) || !Number.isInteger(check.questionStartOffset) || !Number.isInteger(check.questionEndOffset) || check.questionStartOffset < 0 || check.questionEndOffset <= check.questionStartOffset || check.questionEndOffset > value.draft.questionText.length) return false;
    const sources = context.student.evidence.filter(source => slot.evidenceIds.includes(source.id));
    gate = 'CITATION_BINDING';
    canonicalizeQuestionCitations(value.draft, sources);
    gate = 'QUESTION_PRESENTATION';
    assertQuestionPresentation(value.draft);
    gate = 'INTERVIEW_SPEECH';
    assertInterviewQuestionSpeech(value.draft.questionText, { isFirstTurn: false });
    gate = 'FORMAL_PLAN_BINDING';
    attachVerifiedQuestionPlan(structuredClone(value.draft), historySession(context, identity.plan, previous, slot));
    gate = 'PREVIOUS_UTTERANCE_DUPLICATE';
    if (previous.some(item => canonicalQuestion(item.draft.questionText) === canonicalQuestion(value.draft.questionText))) return false;
    const voice = identity.voices[roleFor(slot)];
    gate = 'VOICE_AND_AUDIO_IDENTITY';
    if (fingerprint(value.voiceSettings) !== fingerprint(voice) || value.speechHash !== speechAudioCacheId(value.draft.questionText, voice) || value.questionAudioUrl !== `/api/audio/${value.speechHash}`) return false;
    gate = 'DURABLE_AUDIO_BYTES';
    const bytes = await storage.audioRepository.read({ id: value.speechHash, scope: storage.scope, purpose: 'question-bank-validation' });
    valid = bytes.length > 0 && sha256(bytes) === value.audioSha256;
    return valid;
  } catch (error) {
    failureCode = error && typeof error === 'object' && 'code' in error && /^[A-Z0-9_]+$/u.test(String(error.code)) ? String(error.code) : error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : error instanceof Error ? error.name : 'CANDIDATE_VALIDATION_FAILED';
    return false;
  } finally { try { diagnose?.({ valid, gate, failureCode }); } catch { /* Read-only diagnostics cannot change approval. */ } }
}

function matchesIdentity(value: QuestionBankPartial | PreparedQuestionBank, identity: ReturnType<typeof questionBankIdentity>) {
  return value && value.schemaVersion === QUESTION_BANK_POLICY_VERSION && value.key === identity.key && value.sourceFingerprint === identity.sourceFingerprint && value.questionModel === identity.questionModel && (value.questionReferenceDigest ?? null) === identity.questionReferenceDigest && fingerprint(value.plan) === fingerprint(identity.plan) && fingerprint(value.target) === fingerprint(identity.target) && fingerprint(value.voices) === fingerprint(identity.voices) && value.rulesVersion === interviewConfig.rulesVersion && Array.isArray(value.slots);
}

/** Offline tooling reuses the ordinary validator; this never approves a model
 * output or writes a bank. Candidate IDs, sources, contract and audio all bind. */
export async function verifyPreparedMainCandidate(context: InterviewContext, candidate: PreparedMainCandidate, options: BankOptions & { previous?: PreparedMainCandidate[] } = {}) {
  const identity = questionBankIdentity(context, options), slot = identity.plan.slots.find(slot => slot.id === candidate.slotId);
  const storage = bankStorage(context, identity, options, 'current');
  return Boolean(slot && await validCandidate(candidate, context, identity, slot, options.previous ?? [], storage));
}
/** Same validator and guards, with only a private machine-readable failure gate.
 * No model, synthesis, mutation, extra semantic judgment or guard bypass. */
export async function inspectPreparedMainCandidate(context: InterviewContext, candidate: PreparedMainCandidate, options: BankOptions & { previous?: PreparedMainCandidate[] } = {}): Promise<PreparedCandidateDiagnostic> {
  const identity = questionBankIdentity(context, options), slot = identity.plan.slots.find(slot => slot.id === candidate.slotId);
  if (!slot) return { valid: false, gate: 'SLOT_LOOKUP', failureCode: null };
  const storage = bankStorage(context, identity, options, 'current');
  let result: PreparedCandidateDiagnostic = { valid: false, gate: 'VALIDATOR_NOT_REACHED', failureCode: null };
  await validCandidate(candidate, context, identity, slot, options.previous ?? [], storage, diagnostic => { result = diagnostic; });
  return result;
}
/** Ephemeral, answer-free review scope; never a persisted student session. */
export function createPreparedQuestionReviewSession(context: InterviewContext, plan: InterviewPlan, previous: PreparedMainCandidate[], slot: InterviewPlanSlot) {
  return historySession(context, plan, previous, slot);
}

export async function loadQuestionBank(context: InterviewContext, options: BankOptions = {}): Promise<PreparedQuestionBank | null> {
  const identity = questionBankIdentity(context, options), storage = bankStorage(context, identity, options, 'current'), root = storage.root;
  const authorityScope = createQuestionReviewAuthorityScope(context, root);
  const activitiesContentSha256 = (await loadPreparedActivities(context, root))?.contentSha256 ?? null;
  const bank = await storage.bankRepository.readReady(storage.request);
  try {
    if (!bank || !matchesRequestedBank(bank, storage) || bank.status !== 'ready' || !matchesIdentity(bank, identity) || bank.activitiesContentSha256 !== activitiesContentSha256 || bank.slots.length !== identity.plan.slots.length) return null;
    const { contentSha256, ...content } = bank;
    if (contentSha256 !== fingerprint(content)) return null;
    const previous: PreparedMainCandidate[] = [];
    for (const [index, slot] of identity.plan.slots.entries()) {
      const row = bank.slots[index];
      if (!validPreparedRow(row, slot, identity.plan, context)) return null;
      for (const candidate of row.candidates) if (!await validCandidate(candidate, context, identity, slot, previous, { ...storage, scope: { ...storage.scope, bankContentSha256: bank.contentSha256 } }, undefined, authorityScope)) return null;
      if (row.candidates[1] && canonicalQuestion(row.candidates[0].draft.questionText) === canonicalQuestion(row.candidates[1].draft.questionText)) return null;
      if (row.candidates[0]) previous.push(row.candidates[0]);
    }
    if (!previous.length) return null;
    return structuredClone(bank);
  } catch { return null; }
}

/** Resume against the immutable context/voice/model snapshot, not today's environment. */
export async function loadQuestionBankByPinnedPlan(context: InterviewContext, plan: InterviewPlan, options: Omit<BankOptions, 'plan' | 'environment'> = {}): Promise<PreparedQuestionBank | null> {
  if (!plan.poolKey || !/^[a-f0-9]{64}$/u.test(plan.poolKey) || !plan.poolContentSha256) return null;
  const storage = bankStorage(context, { key: plan.poolKey, sourceFingerprint: sourceFingerprintForContext(context) }, options, 'pinned', plan.poolContentSha256), root = storage.root;
  const authorityScope = createQuestionReviewAuthorityScope(context, root);
  const bank = await storage.bankRepository.readReady(storage.request);
  try {
    if (!bank || !matchesRequestedBank(bank, storage) || bank.schemaVersion !== QUESTION_BANK_POLICY_VERSION || bank.status !== 'ready' || bank.key !== plan.poolKey || bank.contentSha256 !== plan.poolContentSha256 || bank.rulesVersion !== context.manifest.rulesVersion || fingerprint(bank.target) !== fingerprint(context.target) || bank.sourceFingerprint !== sourceFingerprintForContext(context)) return null;
    const { contentSha256, ...content } = bank;
    if (contentSha256 !== fingerprint(content) || bank.slots.length !== bank.plan.slots.length) return null;
    if (bank.activitiesContentSha256 && context.preparedActivities?.contentSha256 !== bank.activitiesContentSha256) return null;
    const identity = { key: bank.key, plan: bank.plan, target: bank.target, sourceFingerprint: bank.sourceFingerprint, questionModel: bank.questionModel, voices: bank.voices, questionReferenceDigest: bank.questionReferenceDigest ?? null };
    const previous: PreparedMainCandidate[] = [];
    for (const slot of bank.plan.slots) {
      const row = bank.slots.find(item => item.slotId === slot.id);
      if (!validPreparedRow(row, slot, bank.plan, context)) return null;
      for (const candidate of row.candidates) if (!await validCandidate(candidate, context, identity, slot, previous, storage, undefined, authorityScope)) return null;
      if (row.candidates[0]) previous.push(row.candidates[0]);
    }
    if (!previous.length) return null;
    return structuredClone(bank);
  } catch { return null; }
}

export interface QuestionBankPreparationSummary {
  status: 'absent' | 'preparing' | 'ready';
  independentObjectives: number;
  candidateCapacity: number;
  attemptedObjectives: number;
  approvedObjectives: number;
  availableApprovedCount: number;
  quarantinedObjectives: number;
  pendingObjectives: number;
  quarantines: QuarantinedQuestionObjective[];
}

/** Private preparation diagnostics. Only source-verified candidates count as available. */
export async function loadQuestionBankPreparationSummary(context: InterviewContext, options: BankOptions = {}): Promise<QuestionBankPreparationSummary> {
  const identity = questionBankIdentity(context, options), storage = bankStorage(context, identity, options, 'preparation-summary'), root = storage.root;
  const ready = await loadQuestionBank(context, { ...options, bankRepository: storage.bankRepository, audioRepository: storage.audioRepository });
  if (!ready && storage.scope.bankContentSha256 !== null) throw new Error('QUESTION_BANK_READ_SCOPE_MISMATCH');
  const old = ready ?? await storage.bankRepository.readPartial(storage.request);
  const activitiesHash = (await loadPreparedActivities(context, root))?.contentSha256 ?? null;
  const value = old && matchesIdentity(old, identity) && old.activitiesContentSha256 === activitiesHash ? old : null;
  const summary: QuestionBankPreparationSummary = { status: ready ? 'ready' : value ? 'preparing' : 'absent', independentObjectives: identity.plan.slots.length, candidateCapacity: identity.plan.slots.length * variantsPerObjective(identity.plan), attemptedObjectives: 0, approvedObjectives: 0, availableApprovedCount: 0, quarantinedObjectives: 0, pendingObjectives: identity.plan.slots.length, quarantines: [] };
  const previous: PreparedMainCandidate[] = [];
  for (const slot of identity.plan.slots) {
    const row = value?.slots.find(item => item.slotId === slot.id);
    if (!row || row.mainIndex !== slot.index || !Array.isArray(row.candidates)) continue;
    if (validTimestamp(row.attemptedAt) || row.candidates.length || row.quarantine) summary.attemptedObjectives++;
    if (row.quarantine) {
      if (row.candidates.length === 0 && validQuarantine(row.quarantine, slot, identity.plan, context)) { summary.quarantinedObjectives++; summary.quarantines.push(structuredClone(row.quarantine)); }
      continue;
    }
    const approved: PreparedMainCandidate[] = [];
    for (const candidate of row.candidates) if (await validCandidate(candidate, context, identity, slot, previous, ready ? { ...storage, scope: { ...storage.scope, bankContentSha256: ready.contentSha256 } } : storage)) approved.push(candidate);
    if (approved.length) { summary.approvedObjectives++; summary.availableApprovedCount += approved.length; previous.push(approved.find(candidate => candidate.variant === 0) ?? approved[0]); }
  }
  summary.pendingObjectives -= summary.approvedObjectives + summary.quarantinedObjectives;
  return summary;
}

const preparing = new Map<string, Promise<PreparedQuestionBank>>();
export async function createQuestionBankProductionProviders(): Promise<QuestionBankProviders> {
  const [{ generateQuestion }, { synthesizeSpeech, readSpeechAudio }] = await Promise.all([import('../providers/openai'), import('../providers/clova-tts')]);
  return {
    generate: (context, session, excludedQuestionTexts) => generateQuestion(context, session, false, true, undefined, { excludedQuestionTexts }),
    synthesize: async (text, voice, role) => {
      let observed: VoiceSettings | undefined;
      const audioUrl = await synthesizeSpeech(text, voice.speaker, { role, onTiming: timing => { observed = timing.settings; } });
      if (!observed || fingerprint(observed) !== fingerprint(voice)) throw new Error('질문 은행 음성의 실제 설정이 일치하지 않습니다.');
      const id = speechAudioCacheId(text, voice), bytes = await readSpeechAudio(id);
      if (!bytes?.length) throw new Error('질문 은행 음성 파일을 읽을 수 없습니다.');
      return { audioUrl, bytes };
    },
  };
}

export async function prepareQuestionBank(context: InterviewContext, options: PrepareQuestionBankOptions = {}): Promise<PreparedQuestionBank> {
  if (options.maxNewCandidates !== undefined && (!Number.isSafeInteger(options.maxNewCandidates) || options.maxNewCandidates < 0)) throw new Error('질문 준비 예산은 0 이상의 정수여야 합니다.');
  const identity = questionBankIdentity(context, options), storage = bankStorage(context, identity, options, 'preparation'), root = storage.root;
  const composedOptions = { ...options, bankRepository: storage.bankRepository, audioRepository: storage.audioRepository };
  const cached = await loadQuestionBank(context, composedOptions);
  if (cached) return cached;
  // An explicitly pinned ready revision is a read authority, never permission
  // to generate or resume different content under the same bank key.
  if (storage.scope.bankContentSha256 !== null) throw new Error('QUESTION_BANK_READ_SCOPE_MISMATCH');
  const operationKey = `${root}:${identity.key}`, pending = preparing.get(operationKey);
  if (pending) return pending;
  const operation = (async () => {
    const activitiesContentSha256 = (await loadPreparedActivities(context, root))?.contentSha256 ?? null;
    if (!options.providers && !activitiesContentSha256) throw new Error('질문 은행 준비 전에 검증된 활동 구조화 캐시를 준비해야 합니다.');
    if (!options.providers && !identity.questionReferenceDigest) throw new Error('질문 은행 준비 전에 검증된 면접 질문 참고 자료를 준비해야 합니다.');
    if (!options.providers && !context.questionReferences?.analysis?.coverage.complete) throw new Error('질문 은행 준비 전에 전체 질문 후보의 분석 결과와 누락 없는 처리 현황을 확인해야 합니다.');
    if (!options.providers && (!context.interviewerPolicy || !context.questionStrategies?.coverage.complete)) throw new Error('질문 은행 준비 전에 실행 정책과 전체 질문 전략의 출처 검증을 완료해야 합니다.');
    const providers = options.providers ?? await createQuestionBankProductionProviders(), limit = options.concurrency ?? 2;
    if (limit !== 1 && limit !== 2) throw new Error('질문 은행 동시 준비 수는 1 또는 2여야 합니다.');
    const old = await storage.bankRepository.readPartial(storage.request) ?? await storage.bankRepository.readReady(storage.request);
    const resumable = old && ['preparing', 'ready'].includes(old.status) && matchesIdentity(old, identity) && old.activitiesContentSha256 === activitiesContentSha256 ? old : null;
    const donorValue = options.reuseFromBankKey ? await storage.bankRepository.readReady({ purpose: 'donor-reuse', scope: { ...emptyReadScope(storage.scope.ownerId),
      studentId: storage.scope.studentId, supportTargetId: storage.scope.supportTargetId, bankKey: options.reuseFromBankKey, bankContentSha256: null, sourceFingerprint: null } }) : null;
    const donor = donorValue && donorValue.schemaVersion === QUESTION_BANK_POLICY_VERSION && donorValue.status === 'ready' && donorValue.key === options.reuseFromBankKey && donorValue.rulesVersion === context.manifest.rulesVersion && donorValue.questionModel === identity.questionModel && fingerprint(donorValue.voices) === fingerprint(identity.voices) && fingerprint(donorValue.target) === fingerprint(identity.target) && (() => { const { contentSha256, ...body } = donorValue; return contentSha256 === fingerprint(body); })() ? donorValue : null;
    if (options.reuseFromBankKey && !donor) throw new Error('기존 질문 은행의 불변 리비전과 문장·모델·음성 계약을 확인하지 못했습니다.');
    const partial: QuestionBankPartial = { schemaVersion: QUESTION_BANK_POLICY_VERSION, status: 'preparing', key: identity.key, createdAt: resumable?.createdAt ?? new Date().toISOString(), plan: identity.plan, target: structuredClone(context.target), rulesVersion: context.manifest.rulesVersion, activitiesContentSha256, questionReferenceDigest: identity.questionReferenceDigest, sourceFingerprint: identity.sourceFingerprint, questionModel: identity.questionModel, voices: identity.voices, slots: identity.plan.slots.map(slot => ({ slotId: slot.id, mainIndex: slot.index, candidates: [] })) };
    let writes = Promise.resolve(), active = 0, newCandidates = 0;
    const waiting: Array<() => void> = [];
    const limited = async <T>(job: () => Promise<T>) => {
      if (active >= limit) await new Promise<void>(resolve => waiting.push(resolve));
      else active++;
      try { return await job(); } finally { const next = waiting.shift(); if (next) next(); else active--; }
    };
    const checkpoint = () => { const snapshot = structuredClone(partial); writes = writes.then(() => storage.bankRepository.writePartial({ ...storage.request, value: snapshot })); return writes; };
    const report = (slot: InterviewPlanSlot, variant: 0 | 1, cacheHit: boolean, status: 'approved' | 'quarantined', failureCode?: QuestionValidationCode) => {
      try { options.onProgress?.({ key: identity.key, completed: partial.slots.reduce((sum, item) => sum + item.candidates.length, 0), total: identity.plan.slots.length * variantsPerObjective(identity.plan), slotId: slot.id, objectiveId: slot.objective?.id ?? slot.id, variant, cacheHit, status, attemptedObjectives: partial.slots.filter(row => row.attemptedAt || row.quarantine || row.candidates.length).length, quarantinedObjectives: partial.slots.filter(row => row.quarantine).length, ...(failureCode ? { failureCode } : {}) }); } catch { /* Progress reporting cannot alter an approved bank. */ }
    };
    const previous: PreparedMainCandidate[] = [], alternates: Promise<void>[] = [];
    let primaryError: unknown;
    const prepareCandidate = async (slot: InterviewPlanSlot, variant: 0 | 1, history: PreparedMainCandidate[], excluded: string[]) => limited(async () => {
      const donorSlot = donor?.plan.slots.find(previousSlot => previousSlot.id === slot.id);
      const unchangedDonorObjective = donorSlot && fingerprint(donorSlot.objective ?? donorSlot) === fingerprint(slot.objective ?? slot);
      const resumableRow = resumable?.slots.find(row => row.slotId === slot.id);
      const donorRow = unchangedDonorObjective ? donor?.slots.find(row => row.slotId === slot.id) : undefined;
      // Every checkpoint contains empty placeholders for unfinished objectives.
      // They are not prepared work and must not hide an unchanged donor row.
      // Completed candidates and valid explicit quarantines still take priority.
      const hasResumableWork = resumableRow && (resumableRow.candidates.length > 0 || validQuarantine(resumableRow.quarantine, slot, identity.plan, context));
      const oldRow = hasResumableWork ? resumableRow : donorRow ?? resumableRow, row = partial.slots[slot.index - 1];
      const reaudit = context.targetAnalysis?.objectiveContractRevision;
      const blocked = reaudit?.blockedObjectives.find(item => item.objectiveId === (slot.objective?.id ?? slot.id));
      if (blocked && validationFailureCodes.has(blocked.failureCode as QuestionValidationCode)) {
        row.quarantine = { status: 'quarantined', slotId: slot.id, objectiveId: slot.objective?.id ?? slot.id, objectiveSha256: fingerprint(slot.objective ?? slot), failureCode: blocked.failureCode as QuestionValidationCode, validationAttempts: 1, quarantinedAt: reaudit!.reviewedAt, preparationPolicyVersion: QUESTION_PREPARATION_POLICY_VERSION, independentReaudit: { reviewArtifactSha256: reaudit!.reviewArtifactSha256, reviewedAt: reaudit!.reviewedAt } };
        await checkpoint(); report(slot, variant, false, 'quarantined', row.quarantine.failureCode); return null;
      }
      if (validTimestamp(resumableRow?.attemptedAt)) row.attemptedAt = resumableRow.attemptedAt;
      else if (validTimestamp(oldRow?.attemptedAt)) row.attemptedAt = oldRow.attemptedAt;
      if (oldRow?.candidates.length === 0 && validQuarantine(oldRow.quarantine, slot, identity.plan, context)) {
        row.quarantine = structuredClone(oldRow.quarantine);
        await checkpoint(); report(slot, variant, true, 'quarantined', row.quarantine.failureCode);
        return null;
      }
      const priorCandidate = oldRow?.candidates.find(candidate => candidate.variant === variant);
      // A new bank revision owns new candidate identity. The question's approved
      // semantic/source contract is unchanged and every ordinary validator still runs.
      const oldCandidate = priorCandidate ? { ...structuredClone(priorCandidate), id: fingerprint({ bankKey: identity.key, slotId: slot.id, variant }), mainIndex: slot.index } : undefined;
      const validOld = oldCandidate && !excluded.some(text => canonicalQuestion(text) === canonicalQuestion(oldCandidate.draft.questionText)) && await validCandidate(oldCandidate, context, identity, slot, history, storage);
      let candidate: PreparedMainCandidate;
      if (validOld) candidate = structuredClone(oldCandidate);
      else {
        if (options.maxNewCandidates !== undefined && newCandidates >= options.maxNewCandidates) throw new QuestionPreparationBudgetError(newCandidates);
        newCandidates++;
        row.attemptedAt ??= new Date().toISOString();
        if (identity.plan.purpose === 'candidate_pool') await checkpoint();
        const session = historySession(context, identity.plan, history, slot);
        let draft: QuestionDraft;
        try { draft = await providers.generate(context, session, excluded); }
        catch (error) {
          // Only an exhausted ordinary generation/review rejection is terminal for
          // this objective. Transport/auth/TTS/cost failures remain resumable.
          if (identity.plan.purpose !== 'candidate_pool' || !(error instanceof QuestionPreparationError) || error.attemptCount !== 2 || !error.lastValidationCode || !validationFailureCodes.has(error.lastValidationCode)) throw error;
          row.quarantine = { status: 'quarantined', slotId: slot.id, objectiveId: slot.objective?.id ?? slot.id, objectiveSha256: fingerprint(slot.objective ?? slot), failureCode: error.lastValidationCode, validationAttempts: 2, quarantinedAt: new Date().toISOString(), preparationPolicyVersion: QUESTION_PREPARATION_POLICY_VERSION };
          await checkpoint(); report(slot, variant, false, 'quarantined', error.lastValidationCode);
          return null;
        }
        if (excluded.some(text => canonicalQuestion(text) === canonicalQuestion(draft.questionText))) throw new Error(`질문 은행 대체 후보가 중복되었습니다: ${slot.id}`);
        const voice = identity.voices[roleFor(slot)], audio = await providers.synthesize(draft.questionText, voice, roleFor(slot)), speechHash = speechAudioCacheId(draft.questionText, voice);
        if (audio.audioUrl !== `/api/audio/${speechHash}` || !audio.bytes.length) throw new Error('질문 은행 음성의 문장·설정 해시가 일치하지 않습니다.');
        // Ensure bytes are durable even if the speech provider's memory cache is all that survived.
        await storage.audioRepository.publish({ id: speechHash, bytes: audio.bytes, scope: storage.scope, purpose: 'question-bank-preparation', publication: 'bank-atomic' });
        candidate = { id: fingerprint({ bankKey: identity.key, slotId: slot.id, variant }), slotId: slot.id, mainIndex: slot.index, variant, createdAt: new Date().toISOString(), draft: structuredClone(draft), questionSha256: sha256(draft.questionText), questionAudioUrl: audio.audioUrl, speechHash, audioSha256: sha256(audio.bytes), voiceSettings: structuredClone(voice) };
        if (!await validCandidate(candidate, context, identity, slot, history, storage)) throw new Error(`질문 은행 후보의 검수·출처·음성 계약을 확인할 수 없습니다: ${slot.id}`);
      }
      row.candidates = [...row.candidates.filter(item => item.variant !== variant), candidate].sort((a, b) => a.variant - b.variant);
      delete row.quarantine;
      await checkpoint();
      report(slot, variant, Boolean(validOld), 'approved');
      return candidate;
    });
    try {
      for (const slot of identity.plan.slots) {
        const history = [...previous], primary = await prepareCandidate(slot, 0, history, []);
        if (!primary) continue;
        previous.push(primary);
        if (variantsPerObjective(identity.plan) > 1) {
          const alternate = prepareCandidate(slot, 1, history, [primary.draft.questionText]).then(() => {});
          // Legacy explicitly supplied plans can retain their already tested alternate policy.
          void alternate.catch(() => {}); alternates.push(alternate);
        }
      }
    } catch (error) { primaryError = error; }
    const results = await Promise.allSettled(alternates);
    await writes;
    if (primaryError) throw primaryError;
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    if (fingerprint(questionBankIdentity(context, options)) !== fingerprint(identity)) throw new Error('질문 은행 준비 중 원천 또는 음성 설정이 변경되었습니다.');
    if (((await loadPreparedActivities(context, root))?.contentSha256 ?? null) !== activitiesContentSha256) throw new Error('질문 은행 준비 중 활동 구조화 캐시가 변경되었습니다.');
    if (!partial.slots.some(row => row.candidates.length)) throw new QuestionPoolUnavailableError();
    const complete = { ...partial, status: 'ready' as const, completedAt: new Date().toISOString() };
    const bank: PreparedQuestionBank = { ...complete, contentSha256: fingerprint(complete) };
    if (storage.scope.bankContentSha256 !== null && storage.scope.bankContentSha256 !== bank.contentSha256) throw new Error('QUESTION_BANK_READ_SCOPE_MISMATCH');
    await storage.bankRepository.publishReady({ ...storage.request, scope: { ...storage.scope, bankContentSha256: bank.contentSha256 }, value: bank });
    const verified = await loadQuestionBank(context, composedOptions);
    if (!verified) throw new Error('완성된 질문 은행을 다시 검증하지 못했습니다.');
    await storage.bankRepository.removePartial(storage.request);
    return verified;
  })();
  preparing.set(operationKey, operation);
  try { return await operation; } finally { if (preparing.get(operationKey) === operation) preparing.delete(operationKey); }
}

/** Select without rewriting or attaching a session/root ID to the cached draft. Caller owns progression. */
export function selectPreparedMainQuestion(bank: PreparedQuestionBank, session: Pick<InterviewSession, 'plan' | 'turns' | 'target'>, mainIndex: number, options: { alternateIndex?: 0 | 1 } = {}) {
  if (bank.status !== 'ready' || !session.plan || fingerprint(session.target) !== fingerprint(bank.target) || !Number.isInteger(mainIndex) || mainIndex < 1) return null;
  const planned = session.plan.slots.find(slot => slot.index === mainIndex);
  const sessionPool = session.plan.poolKey === bank.key && session.plan.poolContentSha256 === bank.contentSha256;
  if (!sessionPool && fingerprint(session.plan) !== fingerprint(bank.plan)) return null;
  const slot = bank.plan.slots.find(item => item.id === (planned?.candidateSlotId ?? planned?.id));
  const row = bank.slots.find(item => item.slotId === slot?.id), candidate = row?.candidates.find(item => item.variant === (options.alternateIndex ?? 0));
  if (!slot || !candidate || row?.quarantine || row?.slotId !== slot.id || candidate.slotId !== slot.id || candidate.mainIndex !== slot.index) return null;
  if (!selectionEligibility(slot, candidate.draft.questionText, { mode: session.plan.mode ?? 'mock' }, session.turns).allowed) return null;
  if (!sessionPool && session.turns.some(turn => turn.questionKind === 'main' && turn.metadata.primaryFunction === candidate.draft.primaryFunction && turn.metadata.activityIds.some(id => slot.activityIds.includes(id)))) return null;
  return { draft: structuredClone(candidate.draft), audioUrl: candidate.questionAudioUrl, voiceSettings: structuredClone(candidate.voiceSettings), bankKey: bank.key, candidateId: candidate.id, variant: candidate.variant, slot: structuredClone({ ...slot, index: mainIndex, candidateSlotId: slot.id }) };
}

export function createSessionQuestionPlan(context: InterviewContext, bank: PreparedQuestionBank, options: QuestionSelectionOptions = {}) {
  if (fingerprint(context.target) !== fingerprint(bank.target)) throw new Error('QUESTION_POOL_TARGET_MISMATCH');
  const approvedSlots = bank.plan.slots.filter(slot => {
    const row = bank.slots.find(item => item.slotId === slot.id);
    return row && !row.quarantine && row.candidates.length > 0;
  }).map((slot, index) => ({ ...slot, index: index + 1, candidateSlotId: slot.id }));
  if (!approvedSlots.length) throw new QuestionPoolUnavailableError();
  const availablePool = { ...bank.plan, slots: approvedSlots, mainQuestionTarget: approvedSlots.length };
  return sessionPlanFromPool(availablePool, context.target, bank, { ...options, scope: options.scope ?? questionSelectionScope(context) });
}

/** Select a reviewed objective, not one of two rewrites tied to a fixed five-slot plan. */
export function selectNextPreparedMainQuestion(bank: PreparedQuestionBank, session: InterviewSession, options: QuestionSelectionOptions = {}) {
  if (session.plan?.poolKey !== bank.key || session.plan.poolContentSha256 !== bank.contentSha256) return null;
  if (fingerprint(session.target) !== fingerprint(bank.target)) return null;
  options = { ...session.plan.selectionContext, ...options, exposure: options.exposure ?? session.plan.selectionContext?.exposure, scope: options.scope ?? session.plan.selectionContext?.scope };
  const mainIndex = Math.max(0, ...session.turns.map(turn => turn.mainIndex)) + 1;
  const remaining = session.plan.slots.filter(slot => slot.index >= mainIndex);
  const diagnostics = { mainIndex, eligibleCandidates: 0, excluded: [] as Array<{ candidateId: string; slotId: string; reason: string }> };
  for (const planned of remaining) {
    const sourceSlot = bank.plan.slots.find(slot => slot.id === (planned.candidateSlotId ?? planned.id));
    const row = bank.slots.find(row => row.slotId === sourceSlot?.id);
    for (const candidate of row && !row.quarantine ? row.candidates : []) {
      const check = selectionEligibility(sourceSlot!, candidate.draft.questionText, { ...options, mode: options.mode ?? session.plan.mode ?? 'mock' }, session.turns);
      if (check.allowed) diagnostics.eligibleCandidates++;
      else diagnostics.excluded.push({ candidateId: candidate.id, slotId: sourceSlot!.id, reason: check.reason });
    }
  }
  session.plan.selectionContext ??= { historySessionIds: [] };
  session.plan.selectionContext.lastSelection = diagnostics;
  for (const planned of remaining) {
    const poolSlot = bank.plan.slots.find(slot => slot.id === (planned.candidateSlotId ?? planned.id));
    const row = bank.slots.find(item => item.slotId === poolSlot?.id);
    if (!poolSlot || !row || row.quarantine) continue;
    for (const candidate of row.candidates) {
      const eligibility = selectionEligibility(poolSlot, candidate.draft.questionText, { ...options, mode: options.mode ?? session.plan.mode ?? 'mock' }, session.turns);
      if (!eligibility.allowed) continue;
      const currentPosition = session.plan.slots.findIndex(slot => slot.index === mainIndex), chosenPosition = session.plan.slots.indexOf(planned);
      if (currentPosition < 0) return null;
      if (chosenPosition !== currentPosition) {
        const displaced = session.plan.slots[currentPosition];
        session.plan.slots[currentPosition] = { ...planned, index: mainIndex };
        session.plan.slots[chosenPosition] = { ...displaced, index: planned.index };
      }
      const selected = selectPreparedMainQuestion(bank, session, mainIndex, { alternateIndex: candidate.variant });
      if (!selected) continue;
      const selectionTrace = { policyVersion: QUESTION_SELECTION_POLICY_VERSION, bankKey: bank.key, bankCandidateId: candidate.id, objectiveId: poolSlot.objective?.id ?? poolSlot.id, semanticKey: slotSemanticKey(poolSlot), mode: options.mode ?? session.plan.mode ?? 'mock', reasonCodes: ['APPROVED_SOURCE_BOUND_OBJECTIVE', eligibility.reason, 'SESSION_HISTORY_RANKED'], exposureStatus: options.exposure?.status ?? 'not_published', publicationRevision: options.exposure?.publicationRevision ?? null, historySessionIds: session.plan.selectionContext?.historySessionIds ?? [] };
      selected.draft.selectionTrace = selectionTrace;
      return { ...selected, selectionTrace };
    }
  }
  return null;
}
