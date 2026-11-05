import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { InterviewSession } from '../protocol';

export const APPROVED_KNOWLEDGE_VERSION = 'reviewed-evaluation-knowledge-v1';
export const knowledgeHash = (value: string) => createHash('sha256').update(value).digest('hex');
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const named = z.string().min(1).max(300);
const approval = z.object({ status: z.enum(['approved', 'pending', 'withdrawn']),
  authority: z.literal('explicit_reviewed_input'), approverId: named, reviewedAt: z.string().datetime() }).strict();
const span = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(),
  quote: z.string().min(1), sha256: sha }).strict();
const condition = z.object({ id: named, text: z.string().min(1).max(2000) }).strict();
const packetBody = z.object({ version: z.literal(APPROVED_KNOWLEDGE_VERSION), id: named, revision: named,
  approval, source: z.object({ id: named, version: named, locator: z.string().min(1).max(2000),
    text: z.string().min(1).max(100000), textSha256: sha }).strict(),
  sourceSpan: span, assumptions: z.array(condition).max(30), excludedScopes: z.array(condition).max(30) }).strict();
export const approvedKnowledgePacketSchema = packetBody.extend({ contentSha256: sha }).strict();
const claimReview = z.object({ sourceTurnId: named, answerId: named, answerSha256: sha, claim: span,
  packetId: named, packetSha256: sha, sourceSpanSha256: sha,
  assumptionReviews: z.array(z.object({ id: named, satisfied: z.boolean().nullable(), reason: z.string().min(1) }).strict()).max(30),
  excludedScopeReviews: z.array(z.object({ id: named, applies: z.boolean().nullable(), reason: z.string().min(1) }).strict()).max(30),
  relation: z.enum(['supported', 'contradicted', 'unresolved']), isCoreToDemand: z.boolean(),
  rationale: z.string().min(1).max(3000) }).strict();
const bindingBody = z.object({ version: z.literal(APPROVED_KNOWLEDGE_VERSION), id: named, approval,
  sessionId: named, sessionQuestionAnswerSha256: sha, turnId: named, questionSha256: sha,
  approvedContractSha256: sha, reviewedDemand: span,
  scope: z.enum(['objective_accuracy_core', 'record_consistency_only', 'unresolved']),
  claimCoverage: z.enum(['all_core_claims_reviewed', 'not_applicable', 'unresolved']),
  packetRefs: z.array(z.object({ id: named, revision: named, contentSha256: sha }).strict()).max(30),
  claimReviews: z.array(claimReview).max(100), reason: z.string().min(1).max(3000) }).strict();
export const demandKnowledgeBindingSchema = bindingBody.extend({ contentSha256: sha }).strict();
const bundleBody = z.object({ version: z.literal(APPROVED_KNOWLEDGE_VERSION),
  packets: z.array(approvedKnowledgePacketSchema).max(200),
  bindings: z.array(demandKnowledgeBindingSchema).max(500) }).strict();
export const approvedKnowledgeBundleSchema = bundleBody.extend({ contentSha256: sha }).strict();
export type ApprovedKnowledgePacket = z.infer<typeof approvedKnowledgePacketSchema>;
export type DemandKnowledgeBinding = z.infer<typeof demandKnowledgeBindingSchema>;
export type ApprovedKnowledgeBundle = z.infer<typeof approvedKnowledgeBundleSchema>;
export function freezeKnowledge<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeKnowledge(child); Object.freeze(value); }
  return value;
}
export function assertKnowledgeSpan(text: string, value: z.infer<typeof span>): void {
  if (value.end <= value.start || value.end > text.length || text.slice(value.start, value.end) !== value.quote ||
    knowledgeHash(value.quote) !== value.sha256) throw new Error('APPROVED_KNOWLEDGE_SPAN_INVALID');
}
function assertContentHash(value: { contentSha256: string }) {
  const { contentSha256, ...body } = value;
  if (contentSha256 !== knowledgeHash(JSON.stringify(body))) throw new Error('APPROVED_KNOWLEDGE_HASH_INVALID');
}
function uniqueIds(values: Array<{ id: string }>) {
  if (new Set(values.map(value => value.id)).size !== values.length) throw new Error('APPROVED_KNOWLEDGE_ID_DUPLICATED');
}
/** Verifies bytes and named review provenance only. This function never
 * independently establishes the authenticity or scientific truth of a source. */
export function parseApprovedKnowledgeBundle(input: unknown): ApprovedKnowledgeBundle {
  const bundle = approvedKnowledgeBundleSchema.parse(input);
  assertContentHash(bundle); uniqueIds(bundle.packets); uniqueIds(bundle.bindings);
  for (const packet of bundle.packets) {
    assertContentHash(packet);
    if (knowledgeHash(packet.source.text) !== packet.source.textSha256) throw new Error('APPROVED_KNOWLEDGE_SOURCE_CHANGED');
    assertKnowledgeSpan(packet.source.text, packet.sourceSpan);
    uniqueIds(packet.assumptions); uniqueIds(packet.excludedScopes);
  }
  for (const binding of bundle.bindings) {
    assertContentHash(binding); uniqueIds(binding.packetRefs);
    for (const claim of binding.claimReviews) { uniqueIds(claim.assumptionReviews); uniqueIds(claim.excludedScopeReviews); }
  }
  return freezeKnowledge(bundle);
}
/** Session identity excludes lifecycle/result ledgers, but pins every actual
 * question, approval, captured answer and clarification lineage. */
export function knowledgeSessionQuestionAnswerHash(session: InterviewSession): string {
  return knowledgeHash(JSON.stringify({ sessionId: session.id, turns: session.turns.map(turn => ({
    id: turn.id, parentMainQuestionId: turn.parentMainQuestionId, questionKind: turn.questionKind,
    questionText: turn.questionText, approvedContractSha256: turn.metadata.approvedQuestion?.contentSha256 ?? null,
    clarificationOfTurnId: turn.metadata.clarificationOfTurnId ?? null, answerId: turn.answerId ?? null,
    rawTranscript: turn.rawTranscript ?? null, transcriptStatus: turn.transcriptStatus ?? null,
  })) }));
}
