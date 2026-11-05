import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { InterviewContext } from './load-interview-context';
import type { PreparedQuestionBank } from './prepared-question-bank';
import { questionSelectionScope, type QuestionSelectionScope } from '../question-selection';

export const QUESTION_PURPOSE_LINEAGE_VERSION = 'reviewed-question-purpose-lineage-v1';
export const QUESTION_PURPOSE_LINEAGE_DIRECTORY = 'data/prepared/question-purpose-lineages';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
export const questionPurposeLineageDigest = (value: unknown) => sha(JSON.stringify(stable(value)));
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const scopeSchema = z.object({ ownerId: z.string().min(1), studentId: z.string().min(1), supportTargetId: z.string().min(1) }).strict();
const proofSchema = z.object({ sourceId: z.string().min(1), revision: hashSchema, start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict();
const questionSchema = z.object({ slotId: z.string().min(1), candidateId: z.string().min(1), semanticKey: z.string().min(1), questionText: z.string().min(1), questionSha256: hashSchema, proofKeys: z.array(proofSchema).min(1) }).strict();
const bankSchema = z.object({ key: hashSchema, fileSha256: hashSchema, contentSha256: hashSchema }).strict();
const linkSchema = z.object({
  id: z.string().min(1), current: questionSchema,
  previous: z.array(questionSchema.extend({ bankKey: hashSchema }).strict()).min(1),
  previousSemanticKeys: z.array(z.string().min(1)).min(1),
  reviewType: z.literal('same_q0_verification_demand'),
  verificationDemand: z.string().min(1), reviewRationale: z.string().min(1),
  policyBasis: z.array(z.string().min(1)).min(1),
}).strict();
export const questionPurposeLineageRegistrySchema = z.object({
  schemaVersion: z.literal(QUESTION_PURPOSE_LINEAGE_VERSION),
  bank: bankSchema, sourcePdfSha256: hashSchema, targetSha256: hashSchema, scope: scopeSchema,
  previousBanks: z.array(bankSchema).min(1), links: z.array(linkSchema).min(1),
  review: z.object({ reviewer: z.literal('codex-source-review'), reviewedAt: z.string().datetime(), authority: z.literal('explicit_review_of_exact_bank_utterances_and_source_proofs') }).strict(),
  rebinding: z.object({ sourceBankKey: hashSchema, sourceRegistryFileSha256: hashSchema, boundAt: z.string().datetime(), method: z.literal('exact_semantic_key_utterance_and_source_proofs') }).strict().optional(),
  contentSha256: hashSchema,
}).strict();
export type QuestionPurposeLineageRegistry = z.infer<typeof questionPurposeLineageRegistrySchema>;
export interface QuestionPurposeLineageSnapshot {
  schemaVersion: typeof QUESTION_PURPOSE_LINEAGE_VERSION;
  bankKey: string; bankContentSha256: string; sourcePdfSha256: string;
  scope: QuestionSelectionScope; target: InterviewContext['target'];
  registryPath: string; registryFileSha256: string; registryContentSha256: string;
  previousBanks: Array<{ key: string; fileSha256: string; contentSha256: string }>;
  links: Array<{ currentSemanticKey: string; previousSemanticKeys: string[]; previousQuestions: Array<{ bankKey: string; candidateId: string; semanticKey: string; questionSha256: string }>; reviewType: 'same_q0_verification_demand'; reviewRecordSha256: string }>;
}

const invalid = () => new Error('QUESTION_PURPOSE_LINEAGE_INVALID');
const same = (a: unknown, b: unknown) => questionPurposeLineageDigest(a) === questionPurposeLineageDigest(b);
function assertBank(bank: PreparedQuestionBank, expected: z.infer<typeof bankSchema>) {
  const { contentSha256, ...content } = bank;
  if (bank.status !== 'ready' || bank.key !== expected.key || contentSha256 !== expected.contentSha256 || questionPurposeLineageDigest(content) !== contentSha256) throw invalid();
}
function verifiedQuestion(bank: PreparedQuestionBank, reference: z.infer<typeof questionSchema>, pdfSha256: string) {
  const slot = bank.plan.slots.find(row => row.id === reference.slotId), prepared = bank.slots.find(row => row.slotId === reference.slotId);
  const candidate = prepared?.candidates.find(row => row.id === reference.candidateId);
  if (!slot || !candidate || prepared?.quarantine || candidate.draft.validationStatus !== 'approved' || (slot.semanticKey ?? slot.objective?.semanticKey) !== reference.semanticKey ||
    candidate.draft.questionText !== reference.questionText || candidate.questionSha256 !== reference.questionSha256 || sha(reference.questionText) !== reference.questionSha256) throw invalid();
  const anchors = candidate.draft.questionBlueprint?.anchorRefs;
  if (!anchors?.length || anchors.some(proof => proof.kind !== 'RECORD' || proof.revision !== pdfSha256)) throw invalid();
  const proofKeys = anchors.map(({ sourceId, revision, start, end }) => ({ sourceId, revision, start, end }));
  if (!same(proofKeys, reference.proofKeys) || reference.proofKeys.some(proof => proof.end <= proof.start)) throw invalid();
}

/** Load reviewed ID relations only. No text similarity, activity/function merge,
 * provider call, bank rewrite or history mutation occurs on this path. */
export async function loadQuestionPurposeLineage(context: InterviewContext, bank: PreparedQuestionBank, root = process.cwd()): Promise<QuestionPurposeLineageSnapshot | undefined> {
  if (!/^[a-f0-9]{64}$/u.test(bank.key)) throw invalid();
  const registryPath = `${QUESTION_PURPOSE_LINEAGE_DIRECTORY}/${bank.key}.json`;
  let bytes: Buffer;
  try { bytes = await readFile(path.resolve(root, registryPath)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw invalid(); }
  try {
    const registry = questionPurposeLineageRegistrySchema.parse(JSON.parse(bytes.toString('utf8')));
    const { contentSha256, ...content } = registry;
    if (contentSha256 !== questionPurposeLineageDigest(content) || registry.bank.key !== bank.key || !same(registry.scope, questionSelectionScope(context)) ||
      registry.targetSha256 !== questionPurposeLineageDigest(context.target) || !same(bank.target, context.target)) throw invalid();
    const pdfs = new Set([context.student.pdfSha256, ...context.student.evidence.map(evidence => evidence.sourceRef.pdfSha256)].filter((value): value is string => !!value));
    if (pdfs.size !== 1 || !pdfs.has(registry.sourcePdfSha256) || context.manifest.sourceIntegrity.pdfHashVerified !== true) throw invalid();
    const bankBytes = await readFile(path.resolve(root, `data/prepared/question-banks/${bank.key}.json`));
    if (sha(bankBytes) !== registry.bank.fileSha256 || !same(JSON.parse(bankBytes.toString('utf8')), bank)) throw invalid();
    assertBank(bank, registry.bank);
    const oldBanks = new Map<string, PreparedQuestionBank>();
    for (const descriptor of registry.previousBanks) {
      if (oldBanks.has(descriptor.key) || descriptor.key === bank.key) throw invalid();
      const oldBytes = await readFile(path.resolve(root, `data/prepared/question-banks/${descriptor.key}.json`));
      if (sha(oldBytes) !== descriptor.fileSha256) throw invalid();
      const old = JSON.parse(oldBytes.toString('utf8')) as PreparedQuestionBank;
      assertBank(old, descriptor);
      if (!same(old.target, context.target)) throw invalid();
      oldBanks.set(descriptor.key, old);
    }
    const currentKeys = new Set(bank.plan.slots.map(slot => slot.semanticKey ?? slot.objective?.semanticKey));
    const previousKeys = new Set<string>(), currentLinks = new Set<string>(), linkIds = new Set<string>();
    for (const link of registry.links) {
      if (linkIds.has(link.id) || currentLinks.has(link.current.semanticKey)) throw invalid();
      linkIds.add(link.id); currentLinks.add(link.current.semanticKey);
      verifiedQuestion(bank, link.current, registry.sourcePdfSha256);
      if (!same([...new Set(link.previous.map(row => row.semanticKey))].sort(), [...link.previousSemanticKeys].sort())) throw invalid();
      for (const previous of link.previous) {
        const old = oldBanks.get(previous.bankKey);
        if (!old || currentKeys.has(previous.semanticKey) || previousKeys.has(previous.semanticKey)) throw invalid();
        previousKeys.add(previous.semanticKey);
        verifiedQuestion(old, previous, registry.sourcePdfSha256);
        if (!previous.proofKeys.some(proof => link.current.proofKeys.some(current => same(current, proof)))) throw invalid();
      }
    }
    return { schemaVersion: QUESTION_PURPOSE_LINEAGE_VERSION, bankKey: bank.key, bankContentSha256: bank.contentSha256, sourcePdfSha256: registry.sourcePdfSha256,
      scope: structuredClone(registry.scope), target: structuredClone(context.target), registryPath, registryFileSha256: sha(bytes), registryContentSha256: contentSha256,
      previousBanks: structuredClone(registry.previousBanks), links: registry.links.map(link => ({ currentSemanticKey: link.current.semanticKey, previousSemanticKeys: [...link.previousSemanticKeys], previousQuestions: link.previous.map(previous => ({ bankKey: previous.bankKey, candidateId: previous.candidateId, semanticKey: previous.semanticKey, questionSha256: previous.questionSha256 })), reviewType: link.reviewType, reviewRecordSha256: questionPurposeLineageDigest(link) })) };
  } catch { throw invalid(); }
}

/** Republish an already reviewed relation only when its current Q0 demand is
 * byte-for-byte unchanged in another approved bank. Changed wording, proof or
 * purpose IDs require another explicit review rather than an inferred alias. */
export async function publishExactQuestionPurposeLineageRebind(context: InterviewContext, sourceBank: PreparedQuestionBank, destinationBank: PreparedQuestionBank, root = process.cwd()): Promise<QuestionPurposeLineageSnapshot> {
  const source = await loadQuestionPurposeLineage(context, sourceBank, root);
  if (!source || sourceBank.key === destinationBank.key || !/^[a-f0-9]{64}$/u.test(destinationBank.key) || !same(sourceBank.target, destinationBank.target)) throw invalid();
  const registryBytes = await readFile(path.resolve(root, source.registryPath));
  if (sha(registryBytes) !== source.registryFileSha256) throw invalid();
  const reviewed = questionPurposeLineageRegistrySchema.parse(JSON.parse(registryBytes.toString('utf8')));
  const destinationBytes = await readFile(path.resolve(root, `data/prepared/question-banks/${destinationBank.key}.json`));
  const descriptor = { key: destinationBank.key, fileSha256: sha(destinationBytes), contentSha256: destinationBank.contentSha256 };
  assertBank(destinationBank, descriptor);
  if (!same(JSON.parse(destinationBytes.toString('utf8')), destinationBank)) throw invalid();
  const links = reviewed.links.map(link => {
    const matches = destinationBank.plan.slots.flatMap(slot => {
      if ((slot.semanticKey ?? slot.objective?.semanticKey) !== link.current.semanticKey) return [];
      const prepared = destinationBank.slots.find(row => row.slotId === slot.id);
      if (prepared?.quarantine) return [];
      return (prepared?.candidates ?? []).filter(candidate => candidate.draft.questionText === link.current.questionText && candidate.questionSha256 === link.current.questionSha256)
        .map(candidate => ({ ...link.current, slotId: slot.id, candidateId: candidate.id }));
    });
    if (matches.length !== 1) throw invalid();
    verifiedQuestion(destinationBank, matches[0], reviewed.sourcePdfSha256);
    return { ...link, current: matches[0] };
  });
  const prior = await loadQuestionPurposeLineage(context, destinationBank, root);
  if (prior) {
    if (!same(prior.links.map(link => ({ currentSemanticKey: link.currentSemanticKey, previousSemanticKeys: link.previousSemanticKeys })),
      source.links.map(link => ({ currentSemanticKey: link.currentSemanticKey, previousSemanticKeys: link.previousSemanticKeys })))) throw invalid();
    return prior;
  }
  const { contentSha256: originalDigest, ...original } = reviewed; void originalDigest;
  const content = { ...original, bank: descriptor, links, rebinding: { sourceBankKey: sourceBank.key, sourceRegistryFileSha256: source.registryFileSha256, boundAt: new Date().toISOString(), method: 'exact_semantic_key_utterance_and_source_proofs' as const } };
  const rebound = questionPurposeLineageRegistrySchema.parse({ ...content, contentSha256: questionPurposeLineageDigest(content) });
  const file = path.resolve(root, `${QUESTION_PURPOSE_LINEAGE_DIRECTORY}/${destinationBank.key}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(rebound, null, 2)}\n`, { flag: 'wx' });
  const verified = await loadQuestionPurposeLineage(context, destinationBank, root);
  if (!verified) throw invalid();
  return verified;
}
