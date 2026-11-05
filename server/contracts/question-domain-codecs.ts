import { createHash } from 'node:crypto';
import { z } from 'zod';
import { primaryFunctions, questionDraftSchema, type QuestionDraft } from '../protocol';
import { assertApprovedQuestionContractHashes, assertQuestionContractIntegrity,
  type ApprovedQuestionContract, type StudentObjectiveCandidate } from '../question-objective';
import type { PreparedMainCandidate } from '../data/prepared-question-bank';

export const QUESTION_DOMAIN_CODEC_VERSION = 'question-domain-codec-v1';
const text = z.string(), id = z.string().min(1), sha = z.string().regex(/^[a-f0-9]{64}$/u);
const primary = z.enum(primaryFunctions), depth = z.enum(['D1', 'D2', 'D3', 'D4']);
const offset = z.number().int().nonnegative();
export const objectiveEvidenceRefSchema = z.object({
  kind: z.enum(['RECORD', 'STUDENT_CONFIRMED', 'ANSWER_TURN']), sourceId: id, revision: id, start: offset, end: offset,
  confirmationStatus: z.enum(['confirmed_from_record', 'confirmed_by_student', 'needs_confirmation', 'student_says_different', 'cannot_confirm']),
  claimStatus: z.enum(['record_fact', 'student_confirmed', 'student_claim_unverified', 'conflict_needs_review']),
}).strict();
export const questionGroundingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('STUDENT_EVIDENCE') }).strict(),
  z.object({ kind: z.literal('COMMON_APPROVED'), moduleId: id, approvalRevision: id, supportTargetId: id }).strict(),
  z.object({ kind: z.literal('ADMISSION_VERIFIED'), sourceIds: z.array(id) }).strict(),
]);

/** The current StudentObjectiveCandidate interface, not the model wire's
 * smaller objective proposal. Empty arrays/anchorQuote remain meaningful. */
export const studentObjectiveCandidateSchema = z.object({
  id, evidenceIds: z.array(text), activityIds: z.array(text), primaryFunction: primary, depth,
  questionIntent: text, targetEvidence: z.array(text), targetDescription: text,
  anchorRefs: z.array(objectiveEvidenceRefSchema), anchorQuote: text,
  scope: z.enum(['record_based', 'record_grounded_extension', 'common_approved', 'admission_grounded']),
  requiresOpenCheck: z.boolean(), selectionBasis: text, semanticKey: text.optional(),
  originKind: z.enum(['activity', 'academic_record', 'trajectory', 'record_gap', 'common_approved']).optional(),
  originEntityId: text.optional(), grounding: questionGroundingSchema.optional(), knownFacts: z.array(text).optional(),
  unknowns: z.array(text).optional(), forbiddenPremises: z.array(text).optional(), analysisRevision: text.optional(),
  supportTargetId: text.optional(), priority: z.enum(['S', 'A', 'B', 'C', 'F']).optional(), priorityReason: text.optional(),
  sourcingStatus: z.enum(['verified_span', 'verified_span_in_partially_structured_source']).optional(),
  moduleApproval: z.object({ moduleVersion: text, questionGuidelinesSha256: text, supportTargetId: text,
    authority: z.literal('explicit_user_approved_local_registry'), sourceClauses: z.array(text) }).strict().optional(),
}).strict() satisfies z.ZodType<StudentObjectiveCandidate>;

export const questionBlueprintSchema = z.object({
  version: z.literal('question-objective-v2'), id, questionId: id, clusterId: id,
  clusterObjective: z.object({ id, description: text }).strict(), parentQuestionId: text.nullable(), answerTurnId: text.nullable(),
  questionIntent: text, grounding: questionGroundingSchema, anchorRefs: z.array(objectiveEvidenceRefSchema),
  target: z.object({ id, description: text, unresolvedReason: text }).strict(), primaryFunction: primary, depth,
  expectedEvidence: z.array(text), expansionRationale: text.nullable(), subordinationRationale: text.nullable(),
  criterionLinks: z.array(z.object({ kind: z.enum(['admission_criterion', 'department_talent', 'university_talent']),
    sourceIds: z.array(text), rationale: text }).strict()), strategyIds: z.array(text),
}).strict();
export const approvedQuestionContractSchema = z.object({
  version: z.literal('approved-question-contract-v1'), blueprint: questionBlueprintSchema,
  blueprintSha256: sha, finalUtteranceSha256: sha, semanticContractSha256: sha, reviewTraceSha256: sha,
  validation: z.object({ method: z.enum(['independent_semantic_review', 'independent_fact_review', 'approved_ir_source_and_surface', 'approved_restatement']),
    independentSemanticReview: z.boolean(), independentPremiseReview: z.boolean().optional(), semanticAuthority: z.literal('single_core').optional(), residualSemanticRisk: z.boolean() }).strict(),
  policyDigest: text.nullable(), strategyCatalogDigest: text.nullable(), contentSha256: sha,
}).strict() satisfies z.ZodType<ApprovedQuestionContract>;

const repairContractSchema = z.object({ version: z.literal('repair-contract-v1'), originalText: text, target: text,
  primaryFunction: primary, depth, action: z.enum(['FOLLOW_UP', 'CLARIFICATION']) }).strict();
export const questionPremiseValidationSchema = z.object({
  version: z.literal('question-premise-v1'), guidelineVersion: z.literal('2.3'), status: z.literal('approved'),
  method: z.enum(['bounded_semantic_review', 'bounded_fact_review', 'verified_approved_restatement', 'constrained_answer_follow_up', 'approved_strategy_ir']),
  reusedFrom: z.object({ turnId: text, questionSha256: sha, transform: z.enum(['exact', 'remove_standalone_greeting']) }).strict().optional(),
  reviewModel: text, questionSha256: sha, coreIntentCount: z.literal(1),
  coreIntentCountAuthority: z.literal('single_core_single_target_contract').optional(), semanticAuthority: z.literal('single_core').optional(),
  repairCheck: z.object({ version: z.literal('repair-check-v1'), contract: repairContractSchema,
    contractSha256: sha, candidateQuestionSha256: sha, verdict: z.literal('same') }).strict().optional(),
  supportedPremises: z.array(z.object({ questionStartOffset: offset, questionEndOffset: offset,
    basis: z.enum(['record', 'answer_turn_attributed']), sourceId: text, sourceStartOffset: offset, sourceEndOffset: offset }).strict()),
  openChecks: z.array(z.object({ questionStartOffset: offset, questionEndOffset: offset, kind: z.enum(['open_check', 'hypothetical']) }).strict()),
}).strict();
const schoolConnection = z.object({ kind: z.enum(['admission_criterion', 'department_talent', 'university_talent']), label: text, sourceIds: z.array(text), rationale: text }).strict();
/** Base model wire is authoritative; server-added metadata is explicitly mapped
 * rather than stripped by the model schema during storage/API reads. */
export const questionDraftDomainSchema = questionDraftSchema.extend({
  evidenceQuotes: z.array(z.object({ evidenceId: text, quote: z.string().min(4), sourceStartOffset: offset.optional(),
    sourceEndOffset: offset.optional(), matchKind: z.enum(['exact', 'canonical_whitespace', 'pdf_line_wrap']).optional() }).strict()).max(6),
  clarificationMode: z.enum(['repeat_audio', 'rephrase']).optional(),
  commonApproval: z.object({ kind: z.literal('COMMON_APPROVED'), moduleId: text, approvalRevision: text, supportTargetId: text }).strict().optional(),
  selectionTrace: z.object({ policyVersion: text, bankKey: text, bankCandidateId: text, objectiveId: text, semanticKey: text,
    mode: text, reasonCodes: z.array(text), exposureStatus: text, publicationRevision: text.nullable(), historySessionIds: z.array(text) }).strict().optional(),
  premiseValidation: questionPremiseValidationSchema.optional(), planSlotId: text.optional(),
  topicArea: z.enum(['academic_inquiry', 'problem_solving', 'community_values', 'career_motivation', 'evidence_limits']).optional(),
  interviewerRole: z.enum(['academic', 'community_talent']).optional(), schoolConnections: z.array(schoolConnection).optional(),
  providerTimings: z.record(text, z.number()).optional(),
  followUpLanguage: z.object({ policyVersion: text, templateId: text, family: text, goal: text, referenceExampleIds: z.array(text) }).strict().optional(),
  questionBlueprint: questionBlueprintSchema.optional(), approvedQuestion: approvedQuestionContractSchema.optional(),
  questionRealization: z.object({ policyVersion: text, operation: text, anchorMode: text, anchorId: text, templateId: text, family: text,
    strategyId: text.nullable(), semanticReview: z.enum(['not_independently_reviewed', 'independently_reviewed']),
    anchorProof: z.array(z.object({ anchorId: text, sourceId: text, sourceSha256: sha, sourceStartOffset: offset, sourceEndOffset: offset,
      questionStartOffset: offset.nullable(), questionEndOffset: offset.nullable() }).strict()).optional(), semanticObjectiveId: text.optional() }).strict().optional(),
  strategyTrace: z.object({ catalogDigest: text.nullable(), selectedCardId: text.nullable(), candidateCardIds: z.array(text), sourceQuestionIds: z.array(text),
    policyVersion: text, selectionReason: text }).strict().optional(),
  questionReferenceContext: z.object({ schemaVersion: text, catalogSha256: text, exampleIds: z.array(text), purpose: z.literal('wording_reference_only'),
    analysisKey: text.optional(), referenceUses: z.array(z.object({ id: text, usage: z.enum(['direct_example', 'compound_strategy', 'contextual_strategy']) }).strict()).optional() }).strict().optional(),
}).strict() satisfies z.ZodType<QuestionDraft>;
export const preparedMainCandidateSchema = z.object({
  id: sha, slotId: id, mainIndex: z.number().int().positive(), variant: z.union([z.literal(0), z.literal(1)]), createdAt: text,
  draft: questionDraftDomainSchema, questionSha256: sha, questionAudioUrl: text, speechHash: sha, audioSha256: sha,
  voiceSettings: z.object({ speaker: text, speed: z.number().int().min(-5).max(10), pitch: z.number().int().min(-5).max(5),
    volume: z.number().int().min(-5).max(5), format: z.literal('mp3') }).strict(),
}).strict() satisfies z.ZodType<PreparedMainCandidate>;

/** Validation-only: never return Zod's ordered/stripped parse output, introduce
 * defaults, normalize Unicode or rewrite legacy IDs/hash preimages. */
function lossless<T>(schema: z.ZodType<T>, input: unknown): T { schema.parse(input); return structuredClone(input) as T; }
export function decodeStudentObjectiveCandidate(input: unknown): StudentObjectiveCandidate {
  return lossless(studentObjectiveCandidateSchema, input);
}
export function decodeApprovedQuestionContract(input: unknown, options: { draft?: QuestionDraft } = {}): ApprovedQuestionContract {
  const value = lossless<ApprovedQuestionContract>(approvedQuestionContractSchema, input);
  assertApprovedQuestionContractHashes(value);
  if (options.draft) assertQuestionContractIntegrity(options.draft, value);
  return value;
}
export function decodePreparedMainCandidate(input: unknown): PreparedMainCandidate {
  const value = lossless<PreparedMainCandidate>(preparedMainCandidateSchema, input);
  if (value.questionSha256 !== createHash('sha256').update(value.draft.questionText).digest('hex')) throw new Error('PREPARED_CANDIDATE_QUESTION_HASH_CHANGED');
  if (value.draft.approvedQuestion) decodeApprovedQuestionContract(value.draft.approvedQuestion, { draft: value.draft });
  return value;
}
