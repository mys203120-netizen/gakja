import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { InterviewContext } from '../data/load-interview-context';
import type { InterviewSession, QuestionDraft, RecordedTurn } from '../protocol';
import { approveQuestionContract, assertQuestionContractIntegrity, createQuestionBlueprint, type ApprovedQuestionContract } from '../question-objective';
import { assertEvaluationQuestionContracts } from './evaluation-turns';
import type { EvaluationSessionOptions } from './openai';

export const EVALUATION_ACTION_REVISION_VERSION = 'reviewed-evaluation-action-revision-v1';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const spanSchema = z.object({ kind: z.enum(['question', 'answer']), turnId: z.string().min(1), sourceAnswerId: z.string().nullable(),
  sourceSha256: sha, start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: z.string().min(1) }).strict();
const proofSchema = z.object({ sourceId: z.string().min(1), revision: z.string().min(1), sourceSha256: sha,
  start: z.number().int().nonnegative(), end: z.number().int().positive(), spanSha256: sha }).strict();
const changeSchema = z.object({ turnId: z.string().min(1), sourceAnswerId: z.string().min(1), originalKind: z.literal('follow_up'),
  correctedKind: z.literal('clarification'), clarificationOfTurnId: z.string().min(1), reason: z.string().min(8).max(1000),
  originalQuestionSha256: sha, originalAnswerSha256: sha, originalContractSha256: sha,
  reviewedSpans: z.array(spanSchema).min(3).max(20), sourceProofs: z.array(proofSchema).max(30) }).strict();
const revisionBodySchema = z.object({ version: z.literal(EVALUATION_ACTION_REVISION_VERSION), sessionId: z.string().min(1),
  originalSessionContentSha256: sha, originalQuestionAnswerSha256: sha, sourceManifestSha256: sha, contextSourceSha256: sha,
  reviewerAuthority: z.enum(['reviewed_model', 'developer_review']), reviewerId: z.string().min(1).max(150),
  reviewedAt: z.string().datetime(), reason: z.string().min(8).max(2000), changes: z.array(changeSchema).min(1).max(30) }).strict();
const revisionSchema = revisionBodySchema.extend({ revisionId: z.string().regex(/^EVAL-ACTION-REV-[a-f0-9]{24}$/u), contentSha256: sha }).strict();
export type EvaluationActionRevision = z.infer<typeof revisionSchema>;
export interface EvaluationActionReview {
  reviewerAuthority: EvaluationActionRevision['reviewerAuthority']; reviewerId: string; reviewedAt: string; reason: string;
  changes: Array<{ turnId: string; sourceAnswerId: string; originalKind: 'follow_up'; correctedKind: 'clarification';
    clarificationOfTurnId: string; reason: string;
    reviewedSpans: Array<{ kind: 'question' | 'answer'; turnId: string; start: number; end: number; quote: string }> }>;
}
/** The historical runtime authority is evidence for the review, never authority
 * for the corrected evaluation demand. No runtime contract fields are changed. */
export interface EvaluationRuntimeApprovalSnapshot {
  draft: QuestionDraft;
  approvedQuestion: ApprovedQuestionContract;
}
export interface EvaluationContractRevisionAudit {
  turnId: string;
  originalContractSha256: string;
  revisedContractSha256: string;
  runtimeApproval: EvaluationRuntimeApprovalSnapshot;
  authorization: {
    revisionId: string;
    revisionSha256: string;
    originalDraftSha256: string;
    originalRepairCheckSha256: string | null;
    clarificationTargetTurnId: string;
    clarificationTargetContractSha256: string;
  };
}
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
};
const questionAnswerDigest = (session: InterviewSession) => hash(JSON.stringify(session.turns.map(turn => ({
  id: turn.id, questionKind: turn.questionKind, parentMainQuestionId: turn.parentMainQuestionId, questionText: turn.questionText,
  answerId: turn.answerId ?? null, rawTranscript: turn.rawTranscript ?? null, transcriptStatus: turn.transcriptStatus ?? null,
  approvedQuestionSha256: turn.metadata.approvedQuestion?.contentSha256 ?? null,
}))));
const contextDigest = (context: InterviewContext) => hash(JSON.stringify({ manifest: context.manifest ?? null,
  target: context.target ?? null, questionGuidelines: context.questionGuidelines ?? '', evaluationGuidelines: context.evaluationGuidelines ?? '',
  evidence: context.student.evidence.map(source => ({ id: source.id, text: source.text, sourceRef: source.sourceRef })) }));
const draftFor = (turn: RecordedTurn): QuestionDraft => ({ ...turn.metadata, acknowledgement: null, acknowledgementQuote: null,
  questionText: turn.questionText, questionKind: turn.questionKind,
  parentMainQuestionId: turn.questionKind === 'main' ? null : turn.parentMainQuestionId, evidenceIds: [...turn.evidenceIds] });

function boundSpan(session: InterviewSession, span: EvaluationActionReview['changes'][number]['reviewedSpans'][number]) {
  const source = session.turns.find(turn => turn.id === span.turnId);
  const raw = span.kind === 'question' ? source?.questionText : source?.rawTranscript;
  if (!source || typeof raw !== 'string' || span.kind === 'answer' && (!source.answerId || source.transcriptStatus !== 'finalized') ||
    !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > raw.length || raw.slice(span.start, span.end) !== span.quote) throw new Error('EVALUATION_ACTION_REVIEW_SPAN_INVALID');
  return { ...span, sourceAnswerId: span.kind === 'answer' ? source.answerId! : null, sourceSha256: hash(raw) };
}

/** Provenance checks only: these checks do not decide whether two questions
 * mean the same thing. That decision must be supplied by the named reviewer. */
function sourceProofs(context: InterviewContext, session: InterviewSession, turn: RecordedTurn) {
  const turnIndex = session.turns.findIndex(item => item.id === turn.id);
  const result: z.infer<typeof proofSchema>[] = [];
  const bind = (sourceId: string, start: number, end: number, expectedRevision?: string) => {
    const record = context.student.evidence.find(source => source.id === sourceId);
    const answerIndex = session.turns.findIndex(source => sourceId === 'ANSWER_TURN:' + source.id + ':' + source.answerId);
    const answer = session.turns[answerIndex];
    const raw = record?.text ?? (answer?.transcriptStatus === 'finalized' ? answer.rawTranscript : undefined);
    const revision = record?.sourceRef.pdfSha256 ?? (typeof raw === 'string' ? hash(raw) : null);
    if (typeof raw !== 'string' || !revision || expectedRevision !== undefined && expectedRevision !== revision ||
      !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > raw.length ||
      !record && (!answer || answerIndex >= turnIndex || answer.parentMainQuestionId !== turn.parentMainQuestionId) ||
      record && !turn.evidenceIds.includes(record.id)) throw new Error('EVALUATION_ACTION_SOURCE_PROOF_INVALID');
    result.push({ sourceId, revision, sourceSha256: hash(raw), start, end, spanSha256: hash(raw.slice(start, end)) });
  };
  for (const ref of turn.metadata.approvedQuestion!.blueprint.anchorRefs) bind(ref.sourceId, ref.start, ref.end, ref.revision);
  for (const proof of turn.metadata.premiseValidation?.supportedPremises ?? []) {
    if (proof.questionStartOffset < 0 || proof.questionEndOffset <= proof.questionStartOffset || proof.questionEndOffset > turn.questionText.length) throw new Error('EVALUATION_ACTION_QUESTION_PROOF_INVALID');
    bind(proof.sourceId, proof.sourceStartOffset, proof.sourceEndOffset);
  }
  for (const proof of turn.metadata.premiseValidation?.openChecks ?? []) {
    if (proof.questionStartOffset < 0 || proof.questionEndOffset <= proof.questionStartOffset || proof.questionEndOffset > turn.questionText.length) throw new Error('EVALUATION_ACTION_QUESTION_PROOF_INVALID');
  }
  return [...new Map(result.map(proof => [JSON.stringify(proof), proof])).values()];
}

function validateChange(context: InterviewContext, session: InterviewSession, change: EvaluationActionReview['changes'][number]) {
  const index = session.turns.findIndex(turn => turn.id === change.turnId), turn = session.turns[index];
  const targetIndex = session.turns.findIndex(target => target.id === change.clarificationOfTurnId), target = session.turns[targetIndex];
  if (!turn || turn.questionKind !== change.originalKind || change.correctedKind !== 'clarification' || change.originalKind !== 'follow_up' ||
    turn.answerId !== change.sourceAnswerId || turn.transcriptStatus !== 'finalized' || typeof turn.rawTranscript !== 'string' ||
    !target || targetIndex >= index || target.parentMainQuestionId !== turn.parentMainQuestionId || target.questionKind === 'clarification' ||
    !target.metadata.questionIntent || target.metadata.targetEvidence?.length !== 1 || !target.metadata.depth ||
    !turn.metadata.approvedQuestion || !target.metadata.approvedQuestion || !turn.metadata.premiseValidation) throw new Error('EVALUATION_ACTION_REVIEW_BINDING_INVALID');
  assertQuestionContractIntegrity(draftFor(turn), turn.metadata.approvedQuestion);
  assertQuestionContractIntegrity(draftFor(target), target.metadata.approvedQuestion);
  const spans = change.reviewedSpans.map(span => boundSpan(session, span));
  if (!spans.some(span => span.kind === 'question' && span.turnId === turn.id) ||
    !spans.some(span => span.kind === 'question' && span.turnId === target.id) ||
    !spans.some(span => span.kind === 'answer' && session.turns.findIndex(source => source.id === span.turnId) < index &&
      session.turns.find(source => source.id === span.turnId)?.parentMainQuestionId === turn.parentMainQuestionId)) throw new Error('EVALUATION_ACTION_REVIEW_CONTEXT_MISSING');
  return { ...change, originalQuestionSha256: hash(turn.questionText), originalAnswerSha256: hash(turn.rawTranscript),
    originalContractSha256: turn.metadata.approvedQuestion.contentSha256, reviewedSpans: spans, sourceProofs: sourceProofs(context, session, turn) };
}

/** Explicit reviewed input, never an automatic natural-language classifier. */
export function createEvaluationActionRevision(context: InterviewContext, session: InterviewSession, review: EvaluationActionReview): EvaluationActionRevision {
  if (session.status === 'active') throw new Error('EVALUATION_ACTION_SESSION_NOT_ENDED');
  assertEvaluationQuestionContracts(session);
  if (new Set(review.changes.map(change => change.turnId)).size !== review.changes.length ||
    review.changes.some(change => review.changes.some(other => other.turnId === change.clarificationOfTurnId))) throw new Error('EVALUATION_ACTION_REVIEW_LINEAGE_INVALID');
  const body = revisionBodySchema.parse({ version: EVALUATION_ACTION_REVISION_VERSION, sessionId: session.id,
    originalSessionContentSha256: hash(JSON.stringify(session)), originalQuestionAnswerSha256: questionAnswerDigest(session),
    sourceManifestSha256: hash(JSON.stringify(session.sourceManifest ?? null)), contextSourceSha256: contextDigest(context),
    reviewerAuthority: review.reviewerAuthority, reviewerId: review.reviewerId, reviewedAt: review.reviewedAt, reason: review.reason,
    changes: review.changes.map(change => validateChange(context, session, change)) });
  const contentSha256 = hash(JSON.stringify(body));
  return deepFreeze({ ...body, revisionId: 'EVAL-ACTION-REV-' + contentSha256.slice(0, 24), contentSha256 });
}

function createEvaluationProjectionApproval(context: InterviewContext, session: InterviewSession, index: number,
  target: RecordedTurn, revision: EvaluationActionRevision) {
  const turn = session.turns[index], runtimeDraft = draftFor(turn), prior = turn.metadata.approvedQuestion!;
  assertQuestionContractIntegrity(runtimeDraft, prior);
  const runtimeApproval = deepFreeze(structuredClone({ draft: runtimeDraft, approvedQuestion: prior }));
  const facts = runtimeApproval.draft.premiseValidation!;
  const draft: QuestionDraft = { ...runtimeDraft, questionKind: 'clarification', clarificationMode: 'rephrase',
    primaryFunction: target.metadata.primaryFunction, questionIntent: target.metadata.questionIntent,
    targetEvidence: [...target.metadata.targetEvidence], depth: target.metadata.depth,
    // Carry only the reviewed facts for the exact same utterance. The runtime
    // repairCheck and single-core semantic authority remain in runtimeApproval;
    // this new restatement approval is authorized by the explicit revision.
    premiseValidation: { version: facts.version, guidelineVersion: facts.guidelineVersion, status: facts.status,
      method: 'verified_approved_restatement', questionSha256: hash(turn.questionText), coreIntentCount: 1,
      supportedPremises: structuredClone(facts.supportedPremises), openChecks: structuredClone(facts.openChecks),
      reviewModel: 'evaluation-action-review:' + revision.reviewerAuthority + ':' + revision.reviewerId,
      reusedFrom: { turnId: turn.id, questionSha256: hash(turn.questionText), transform: 'exact' } },
  };
  delete draft.approvedQuestion; delete draft.questionBlueprint;
  const prefix = { ...session, turns: session.turns.slice(0, index) };
  const blueprint = { ...createQuestionBlueprint(draft, context, prefix, { questionId: turn.id,
    grounding: prior.blueprint.grounding, targetDescription: target.metadata.targetEvidence[0] }),
    parentQuestionId: target.id, answerTurnId: target.id };
  draft.questionBlueprint = blueprint;
  const approvedQuestion = approveQuestionContract(draft, blueprint, {
    policyDigest: prior.policyDigest ?? undefined, strategyCatalogDigest: prior.strategyCatalogDigest ?? undefined });
  const repairCheck = runtimeApproval.draft.premiseValidation?.repairCheck;
  const contractRevision: EvaluationContractRevisionAudit = { turnId: turn.id,
    originalContractSha256: prior.contentSha256, revisedContractSha256: approvedQuestion.contentSha256, runtimeApproval,
    authorization: { revisionId: revision.revisionId, revisionSha256: revision.contentSha256,
      originalDraftSha256: hash(JSON.stringify(runtimeApproval.draft)),
      originalRepairCheckSha256: repairCheck ? hash(JSON.stringify(repairCheck)) : null,
      clarificationTargetTurnId: target.id, clarificationTargetContractSha256: target.metadata.approvedQuestion!.contentSha256 } };
  return { draft, blueprint, approvedQuestion, contractRevision };
}

export function applyEvaluationActionRevision(context: InterviewContext, original: InterviewSession, input: EvaluationActionRevision) {
  const revision = revisionSchema.parse(input), { revisionId, contentSha256, ...body } = revision;
  if (contentSha256 !== hash(JSON.stringify(body)) || revisionId !== 'EVAL-ACTION-REV-' + contentSha256.slice(0, 24) ||
    revision.sessionId !== original.id || revision.originalSessionContentSha256 !== hash(JSON.stringify(original)) ||
    revision.originalQuestionAnswerSha256 !== questionAnswerDigest(original) || revision.sourceManifestSha256 !== hash(JSON.stringify(original.sourceManifest ?? null)) ||
    revision.contextSourceSha256 !== contextDigest(context)) throw new Error('EVALUATION_ACTION_REVISION_SOURCE_CHANGED');
  // Rebuild every bound span/proof from the immutable original; a valid outer
  // digest alone is not permission to insert different IDs or source ranges.
  const rebound = createEvaluationActionRevision(context, original, revision);
  if (JSON.stringify(rebound) !== JSON.stringify(revision)) throw new Error('EVALUATION_ACTION_REVISION_PROOF_CHANGED');
  const session = structuredClone(original), contractRevisions: EvaluationContractRevisionAudit[] = [];
  for (const change of revision.changes) {
    const index = session.turns.findIndex(turn => turn.id === change.turnId), turn = session.turns[index];
    const target = session.turns.find(item => item.id === change.clarificationOfTurnId)!;
    const { draft, blueprint, approvedQuestion, contractRevision } = createEvaluationProjectionApproval(context, session, index, target, revision);
    turn.questionKind = 'clarification'; turn.followUpIndex = 0;
    Object.assign(turn.metadata, { primaryFunction: draft.primaryFunction, questionIntent: draft.questionIntent,
      targetEvidence: draft.targetEvidence, depth: draft.depth, nonEvaluative: true, clarificationMode: 'rephrase',
      clarificationOfTurnId: target.id, parentQuestionId: target.id,
      premiseValidation: draft.premiseValidation, questionBlueprint: blueprint, approvedQuestion });
    for (const presentation of session.questionPresentations ?? []) if (presentation.turnId === turn.id) presentation.questionKind = 'clarification';
    contractRevisions.push(contractRevision);
  }
  const counts: Record<string, number> = {}, followUpOrdinals: Array<{ turnId: string; originalIndex: number; revisedIndex: number }> = [];
  for (const turn of session.turns) if (turn.questionKind === 'follow_up') {
    counts[turn.parentMainQuestionId] = (counts[turn.parentMainQuestionId] ?? 0) + 1;
    const originalIndex = turn.followUpIndex; turn.followUpIndex = counts[turn.parentMainQuestionId];
    followUpOrdinals.push({ turnId: turn.id, originalIndex, revisedIndex: turn.followUpIndex });
  }
  session.followUpCountByMainQuestion = counts;
  delete session.evaluation; delete session.evaluationError; session.evaluationStatus = 'pending';
  assertEvaluationQuestionContracts(session);
  return { session, audit: deepFreeze({ version: EVALUATION_ACTION_REVISION_VERSION, evaluationOnly: true as const,
    revisionId, contentSha256, originalSessionContentSha256: revision.originalSessionContentSha256,
    originalQuestionAnswerSha256: revision.originalQuestionAnswerSha256, reviewerAuthority: revision.reviewerAuthority,
    reviewerId: revision.reviewerId, reviewedAt: revision.reviewedAt, reason: revision.reason,
    changes: revision.changes, contractRevisions, followUpOrdinals, projectedSessionContentSha256: hash(JSON.stringify(session)) }) };
}

export type EvaluationActionProjection = ReturnType<typeof applyEvaluationActionRevision>;

/** Rebuild from the original and the verified review, so a rehashed snapshot or
 * projection cannot replace its original repair proof, target or authorization.
 * This is an offline provenance check, not another semantic/model judgment. */
export function assertEvaluationActionProjectionProvenance(context: InterviewContext, original: InterviewSession,
  revision: EvaluationActionRevision, projection: EvaluationActionProjection): void {
  const expected = applyEvaluationActionRevision(context, original, revision);
  if (JSON.stringify(projection) !== JSON.stringify(expected)) throw new Error('EVALUATION_ACTION_PROJECTION_PROVENANCE_INVALID');
}

/** One explicit entry point retains correction provenance in the evaluated
 * result without modifying the historical session or the runtime worker. */
export async function evaluateSessionWithActionRevision(context: InterviewContext, original: InterviewSession,
  revision: EvaluationActionRevision, options: EvaluationSessionOptions = {}) {
  const projection = applyEvaluationActionRevision(context, original, revision);
  const { evaluateSession } = await import('./openai');
  const result = await evaluateSession(context, projection.session, options);
  return { ...result, evaluationActionRevision: projection.audit };
}
