import { z } from 'zod';
import { verify } from 'node:crypto';
import type { InterviewContext } from './load-interview-context';
import type { PreparedQuestionBank } from './prepared-question-bank';
import { assertQuestionContractIntegrity, bindQuestionContractToTurn, type ApprovedQuestionContract } from '../question-objective';
import type { InterviewSession, QuestionDraft, RecordedTurn } from '../protocol';
import { APPROVED_KNOWLEDGE_VERSION, approvedKnowledgePacketSchema, assertKnowledgeSpan, freezeKnowledge, knowledgeHash, parseApprovedKnowledgeBundle } from './approved-knowledge';
import { localDevelopmentOwner } from '../session-runtime';
import { compileEvaluationScopePolicy } from '../policy/evaluation-scope-policy';
import type { ReviewRepository, BankScopeRegistryReader } from '../repositories/review-ports';
import { createLocalReviewRepository } from '../repositories/local-review-repository';

export const BANK_SCOPE_REGISTRY_VERSION = 'question-evaluation-specs-v2';
export { BANK_SCOPE_REGISTRY_DIRECTORY } from '../repositories/local-review-repository';
const sha = z.string().regex(/^[a-f0-9]{64}$/u), name = z.string().min(1).max(300);
const span = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: z.string().min(1), sha256: sha }).strict();
const packetRef = z.object({ id: name, revision: name, contentSha256: sha }).strict();
const review = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), authority: z.literal('explicit_reviewed_input'), approverId: z.null(), reviewedAt: z.null(), reason: z.null() }).strict(),
  z.object({ status: z.enum(['approved', 'rejected', 'withdrawn']), authority: z.literal('explicit_reviewed_input'), approverId: name, reviewedAt: z.string().datetime(), reason: z.string().min(1).max(3000) }).strict(),
]);
const entry = z.object({ evaluationSpecId: name, revision: sha, candidateId: sha, objectiveId: name, questionRevisionId: name,
  questionSha256: sha, bankContractSha256: sha, bankApprovedContract: z.custom<ApprovedQuestionContract>(value => !!value && typeof value === 'object'), semanticContractSha256: sha, questionText: z.string().min(8), questionIntent: z.string().min(1),
  targetEvidence: z.array(z.string()).length(1), reviewedDemand: span, policyVersion: name, rubricVersion: name,
  scope: z.enum(['record_consistency_only', 'objective_accuracy_core', 'unresolved']),
  assessableCriteria: z.array(z.string().min(1)).max(30), excludedCriteria: z.array(z.string().min(1)).max(30),
  packetRefs: z.array(packetRef).max(30), evidenceExpectations: z.array(z.string().min(1)).max(30), review,
}).strict();
const body = z.object({ version: z.literal(BANK_SCOPE_REGISTRY_VERSION), ownerId: name, studentId: name, targetScopeSha256: sha,
  bankKey: sha, bankContentSha256: sha, sourceFingerprint: sha, sourceManifestSha256: sha, policySha256: sha, rubricSha256: sha,
  packets: z.array(approvedKnowledgePacketSchema).max(200), entries: z.array(entry).max(2000) }).strict();
const sealed = body.extend({ contentSha256: sha }).strict();
export type QuestionEvaluationSpecRegistry = z.infer<typeof sealed>;
export type BankEvaluationScopeRegistry = QuestionEvaluationSpecRegistry;
const receiptSchema = z.object({ version: z.literal('authenticated-bank-scope-review-v1'), actorId: name,
  registrySha256: sha, action: z.literal('publish_scopes'), issuedAt: z.string().datetime(), expiresAt: z.string().datetime(), signature: z.string().min(1) }).strict();
export type BankScopeReviewReceipt = z.infer<typeof receiptSchema>;
export function verifyBankScopeReviewReceipt(input: unknown, registry: BankEvaluationScopeRegistry,
  trustedPublicKey = process.env.EVALUATION_SCOPE_REVIEW_PUBLIC_KEY, now = Date.now()) {
  const receipt = receiptSchema.parse(input), { signature, ...payload } = receipt;
  if (!trustedPublicKey || receipt.registrySha256 !== registry.contentSha256 || Date.parse(receipt.issuedAt) > now || Date.parse(receipt.expiresAt) <= now ||
    !verify(null, Buffer.from(JSON.stringify(payload)), trustedPublicKey, Buffer.from(signature, 'base64'))) throw new Error('BANK_SCOPE_AUTHENTICATED_REVIEW_RECEIPT_REQUIRED');
  return receipt;
}
const seal = <T extends object>(value: T) => ({ ...value, contentSha256: knowledgeHash(JSON.stringify(value)) });
export function sealBankScopeRegistry(input: z.infer<typeof body>): BankEvaluationScopeRegistry {
  const parsed = body.parse(input);
  parsed.entries = parsed.entries.map(row => { const { revision: _revision, ...content } = row; void _revision;
    return { ...row, revision: knowledgeHash(JSON.stringify(content)) }; });
  return freezeKnowledge(seal(body.parse(parsed)));
}
export function parseBankScopeRegistry(input: unknown) {
  const registry = sealed.parse(input), { contentSha256, ...value } = registry;
  if (contentSha256 !== knowledgeHash(JSON.stringify(value)) || new Set(registry.entries.map(row => row.candidateId)).size !== registry.entries.length) throw new Error('BANK_SCOPE_REGISTRY_INVALID');
  parseApprovedKnowledgeBundle(seal({ version: APPROVED_KNOWLEDGE_VERSION, packets: registry.packets, bindings: [] }));
  for (const row of registry.entries) {
    const { revision, ...content } = row;
    if (revision !== knowledgeHash(JSON.stringify(content))) throw new Error('BANK_SCOPE_SPEC_REVISION_CHANGED');
    assertKnowledgeSpan(row.questionText, row.reviewedDemand);
  }
  return freezeKnowledge(registry);
}

/** A-stage inventory only. All proposed demands/scopes remain pending and no
 * session IDs, answer approvals or invented reviewer identities are created. */
export function prepareBankScopeReview(context: InterviewContext, bank: PreparedQuestionBank, scope: { ownerId?: string } = {}): BankEvaluationScopeRegistry {
  if (!context.student.studentId) throw new Error('BANK_SCOPE_STUDENT_ID_REQUIRED');
  const policy = compileEvaluationScopePolicy(context);
  return sealBankScopeRegistry({ version: BANK_SCOPE_REGISTRY_VERSION, ownerId: scope.ownerId ?? localDevelopmentOwner().id,
    studentId: context.student.studentId, targetScopeSha256: knowledgeHash(JSON.stringify(context.target)), bankKey: bank.key,
    bankContentSha256: bank.contentSha256, sourceFingerprint: bank.sourceFingerprint, sourceManifestSha256: policy.sourceManifestSha256,
    policySha256: policy.contentSha256, rubricSha256: policy.rubricSha256, packets: [],
    entries: bank.slots.flatMap(slot => slot.candidates.map(candidate => {
      const draft = candidate.draft, contract = draft.approvedQuestion;
      if (!contract) throw new Error('BANK_SCOPE_APPROVED_QUESTION_REQUIRED');
      assertQuestionContractIntegrity(draft, contract);
      const objectiveId = bank.plan.slots.find(item => item.id === slot.slotId)?.objective?.id ?? slot.slotId;
      const identity = { candidateId: candidate.id, questionSha256: candidate.questionSha256, bankContractSha256: contract.contentSha256, bankApprovedContract: structuredClone(contract),
        semanticContractSha256: contract.semanticContractSha256, questionText: draft.questionText, questionIntent: draft.questionIntent, targetEvidence: [...draft.targetEvidence] };
      return { evaluationSpecId: 'EVALSPEC-' + knowledgeHash(`${bank.key}:${candidate.id}`), revision: knowledgeHash(JSON.stringify(identity)), ...identity, objectiveId,
        questionRevisionId: 'CONTRACT-' + contract.contentSha256, reviewedDemand: { start: 0, end: draft.questionText.length, quote: draft.questionText, sha256: knowledgeHash(draft.questionText) },
        policyVersion: policy.version, rubricVersion: `sha256:${policy.rubricSha256}`, scope: 'unresolved' as const,
        assessableCriteria: [], excludedCriteria: [], packetRefs: [], evidenceExpectations: [],
        review: { status: 'pending' as const, authority: 'explicit_reviewed_input' as const, approverId: null, reviewedAt: null, reason: null } };
    })) });
}

/** Mechanical consistency validation; this does not authenticate an actor or
 * approve any actual session. Publication separately requires a signed receipt. */
export function validateBankScopeReview(input: unknown, context: InterviewContext, bank: PreparedQuestionBank, reviewer: string) {
  const registry = parseBankScopeRegistry(input), proposed = prepareBankScopeReview(context, bank, { ownerId: registry.ownerId });
  const header = (value: BankEvaluationScopeRegistry) => ({ version: value.version, ownerId: value.ownerId, studentId: value.studentId,
    targetScopeSha256: value.targetScopeSha256, bankKey: value.bankKey, bankContentSha256: value.bankContentSha256, sourceFingerprint: value.sourceFingerprint,
    sourceManifestSha256: value.sourceManifestSha256, policySha256: value.policySha256, rubricSha256: value.rubricSha256 });
  if (!reviewer.trim() || JSON.stringify(header(registry)) !== JSON.stringify(header(proposed)) || registry.entries.length !== proposed.entries.length) throw new Error('BANK_SCOPE_REVIEW_BINDING_CHANGED');
  const identity = (row: BankEvaluationScopeRegistry['entries'][number]) => ({ evaluationSpecId: row.evaluationSpecId,
    candidateId: row.candidateId, objectiveId: row.objectiveId, questionRevisionId: row.questionRevisionId, questionSha256: row.questionSha256,
    bankContractSha256: row.bankContractSha256, bankApprovedContract: row.bankApprovedContract, semanticContractSha256: row.semanticContractSha256, questionText: row.questionText,
    questionIntent: row.questionIntent, targetEvidence: row.targetEvidence, policyVersion: row.policyVersion, rubricVersion: row.rubricVersion });
  for (const row of registry.entries) {
    const original = proposed.entries.find(item => item.candidateId === row.candidateId);
    if (!original || JSON.stringify(identity(row)) !== JSON.stringify(identity(original))) throw new Error('BANK_SCOPE_REVIEW_BINDING_CHANGED');
    if (row.review.status === 'pending' && row.scope !== 'unresolved') throw new Error('BANK_SCOPE_PENDING_CANNOT_APPROVE');
    if (row.review.status !== 'pending' && row.review.approverId !== reviewer) throw new Error('BANK_SCOPE_REVIEW_AUTHORITY_MISMATCH');
    if (row.review.status === 'approved') {
      if (row.scope === 'unresolved' || !row.assessableCriteria.length || !row.excludedCriteria.length) throw new Error('BANK_SCOPE_REVIEW_SCOPE_UNRESOLVED');
      if (row.scope === 'record_consistency_only' && row.packetRefs.length) throw new Error('BANK_SCOPE_RECORD_PACKET_CONFLICT');
      if (row.scope === 'objective_accuracy_core' && (!row.packetRefs.length || !row.evidenceExpectations.length || row.packetRefs.some(ref =>
        !registry.packets.some(packet => packet.id === ref.id && packet.revision === ref.revision && packet.contentSha256 === ref.contentSha256 && packet.approval.status === 'approved')))) throw new Error('BANK_SCOPE_KNOWLEDGE_PACKET_REQUIRED');
    }
  }
  return registry;
}

export async function loadBankScopeRegistry(root = process.cwd(), trustedPublicKey = process.env.EVALUATION_SCOPE_REVIEW_PUBLIC_KEY,
  reviews: BankScopeRegistryReader = createLocalReviewRepository(root)): Promise<BankEvaluationScopeRegistry | null> {
  let pointer: { contentSha256: string };
  try { pointer = JSON.parse(await reviews.readRegistryPointer()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('BANK_SCOPE_REGISTRY_POINTER_INVALID', { cause: error }); }
  if (!sha.safeParse(pointer.contentSha256).success) throw new Error('BANK_SCOPE_REGISTRY_POINTER_INVALID');
  const envelope = JSON.parse(await reviews.readRegistryRevision(pointer.contentSha256));
  const registry = parseBankScopeRegistry(envelope.registry), receipt = receiptSchema.parse(envelope.receipt);
  if (Date.parse(receipt.issuedAt) > Date.now() || registry.entries.some(row => row.review.status !== 'pending' && row.review.approverId !== receipt.actorId)) throw new Error('BANK_SCOPE_AUTHENTICATED_REVIEW_RECEIPT_REQUIRED');
  verifyBankScopeReviewReceipt(receipt, registry, trustedPublicKey, Date.parse(receipt.issuedAt));
  if (registry.contentSha256 !== pointer.contentSha256) throw new Error('BANK_SCOPE_REGISTRY_POINTER_CHANGED');
  return registry;
}
export async function publishBankScopeReview(input: unknown, context: InterviewContext, bank: PreparedQuestionBank,
  receiptInput: unknown, expectedCurrent: string | null, root = process.cwd(), trustedPublicKey = process.env.EVALUATION_SCOPE_REVIEW_PUBLIC_KEY,
  reviews: ReviewRepository = createLocalReviewRepository(root)) {
  const parsed = parseBankScopeRegistry(input), receipt = verifyBankScopeReviewReceipt(receiptInput, parsed, trustedPublicKey);
  const registry = validateBankScopeReview(parsed, context, bank, receipt.actorId);
  await reviews.ensureRegistryRevisions();
  const lock = await reviews.acquireRegistryPublishLock();
  try {
    const current = await loadBankScopeRegistry(root, trustedPublicKey, reviews);
    if ((current?.contentSha256 ?? null) !== expectedCurrent) throw new Error('BANK_SCOPE_REGISTRY_POINTER_STALE');
    await reviews.writeRegistryRevision(registry.contentSha256, JSON.stringify({ registry, receipt }, null, 2));
    await reviews.publishRegistryPointer(JSON.stringify({ contentSha256: registry.contentSha256 })); return registry;
  } finally { await lock.release(); }
}

export function bankScopeReadiness(context: InterviewContext, bank: PreparedQuestionBank | null) {
  const candidates = bank?.slots.flatMap(slot => slot.candidates) ?? [], registry = context.evaluationScopeRegistry;
  const sameBank = bank && registry?.bankKey === bank.key && registry.bankContentSha256 === bank.contentSha256 && registry.policySha256 === compileEvaluationScopePolicy(context).contentSha256;
  const rows = sameBank ? registry.entries : [], approved = rows.filter(row => row.review.status === 'approved').length;
  return { status: candidates.length && approved === candidates.length ? 'question_specs_ready' : 'scope_review_required',
    questionApprovedCount: candidates.length, specApprovedCount: approved, candidateCount: candidates.length, pendingScopeCount: candidates.length - approved,
    allCandidateSpecsApproved: !!candidates.length && approved === candidates.length,
    preapprovedQ0ScopeReady: false, inventoryReviewReason: 'inventory_review_required', sessionEvaluationReady: false,
    scopeSetupRequired: approved < candidates.length, registrySha256: sameBank ? registry.contentSha256 : null, providerCalls: 0 };
}

/** Exact original approval or its deterministic server turn-ID rebind only.
 * Similar wording, semantic hashes alone, and changed review/policy/proof are insufficient. */
export function findExactQuestionEvaluationSpec(context: InterviewContext, session: InterviewSession, turn: RecordedTurn,
  registry: QuestionEvaluationSpecRegistry) {
  const trace = turn.metadata.selectionTrace, contract = turn.metadata.approvedQuestion;
  if (!trace || turn.questionKind !== 'main' || session.plan?.poolKey !== registry.bankKey || session.plan.poolContentSha256 !== registry.bankContentSha256 || trace.bankKey !== registry.bankKey) return undefined;
  return registry.entries.find(row => {
    if (row.candidateId !== trace.bankCandidateId || row.objectiveId !== trace.objectiveId || row.questionSha256 !== knowledgeHash(turn.questionText) ||
      row.semanticContractSha256 !== contract?.semanticContractSha256 || row.bankApprovedContract.contentSha256 !== row.bankContractSha256) return false;
    try {
      const draft: QuestionDraft = { ...turn.metadata, acknowledgement: null, acknowledgementQuote: null, questionText: turn.questionText,
        questionKind: turn.questionKind, parentMainQuestionId: null, evidenceIds: [...turn.evidenceIds],
        questionBlueprint: row.bankApprovedContract.blueprint, approvedQuestion: row.bankApprovedContract };
      assertQuestionContractIntegrity(draft, row.bankApprovedContract);
      if (contract.contentSha256 === row.bankContractSha256) return true;
      const prior = { ...session, turns: session.turns.slice(0, session.turns.indexOf(turn)) };
      return bindQuestionContractToTurn(draft, context, prior, turn.id).approvedQuestion.contentSha256 === contract.contentSha256;
    } catch { return false; }
  });
}
