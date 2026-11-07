import type { AnalysisReadOptions } from '../repositories/analysis-read-ports';
import { readDependency } from '../repositories/artifact-read';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { BookQuestionCorpus } from './book-question-reference';
import { finalizeQuestionReferenceBatch, questionReferenceAnalysisCoverage, questionReferenceAnalysisIdentity, questionReferenceCategories, referencePrimaryFunctions, referenceRestrictions, referenceStrategies, type QuestionReferenceAnalysis, type QuestionReferenceAnalysisRow, type QuestionReferenceReviewedRow } from './question-reference-analysis';

export const QUESTION_REFERENCE_ADJUDICATION_SCHEMA = 'question-reference-adjudications-v1';
export const QUESTION_REFERENCE_ADJUDICATION_POLICY = 'source-context-adjudication-v1';
export const QUESTION_REFERENCE_ADJUDICATION_FILE = 'data/prepared/question-reference-adjudications.json';
type CorpusInput = Pick<BookQuestionCorpus, 'sourceHashes' | 'questions'>;
const depths = ['D1', 'D2', 'D3', 'D4'] as const;
const domains = ['general', 'stem', 'humanities', 'social_sciences', 'arts_sports', 'health', 'education', 'faith_context', 'mixed', 'unknown'] as const;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const evidenceSchema = z.object({ sourcePath: z.string().min(1), startOffset: z.number().int().nonnegative(), endOffset: z.number().int().positive(), quote: z.string().min(1) }).strict();
const replacementSchema = z.object({
  category: z.enum(questionReferenceCategories), primaryFunctions: z.array(z.enum(referencePrimaryFunctions)).max(5), depth: z.enum(depths), strategies: z.array(z.enum(referenceStrategies)).max(8),
  demands: z.array(z.object({ quote: z.string().min(1).max(1800), primaryFunction: z.enum(referencePrimaryFunctions), depth: z.enum(depths) }).strict()).max(8),
  dependencies: z.object({ passage: z.boolean(), figure: z.boolean(), priorAnswer: z.boolean(), institution: z.boolean() }).strict(),
  restrictions: z.array(z.enum(referenceRestrictions)).max(7), rationale: z.string().min(2).max(100), domain: z.enum(domains).optional(),
}).strict();
const entrySchema = z.object({ questionId: z.string().min(1), sourceSha256: hashSchema, questionSha256: hashSchema, evidence: evidenceSchema, reason: z.string().min(2).max(1000), replacement: replacementSchema }).strict();
export const questionReferenceAdjudicationsSchema = z.object({ schemaVersion: z.literal(QUESTION_REFERENCE_ADJUDICATION_SCHEMA), policyVersion: z.literal(QUESTION_REFERENCE_ADJUDICATION_POLICY), entries: z.array(entrySchema) }).strict();
export type QuestionReferenceAdjudicationEntry = z.infer<typeof entrySchema>;
export interface QuestionReferenceAdjudicationOrigin {
  type: 'source_context_adjudication'; policyVersion: typeof QUESTION_REFERENCE_ADJUDICATION_POLICY;
  originalRowSha256: string; originalStatus: QuestionReferenceAnalysisRow['status'];
  analysisKey: string; adjudicationEntrySha256: string;
  evidence: QuestionReferenceAdjudicationEntry['evidence']; reason: string;
}
export type AdjudicatedQuestionReferenceRow = QuestionReferenceReviewedRow & { reviewOrigin: QuestionReferenceAdjudicationOrigin };
export interface QuestionReferenceAdjudicationSummary {
  schemaVersion: typeof QUESTION_REFERENCE_ADJUDICATION_SCHEMA; policyVersion: typeof QUESTION_REFERENCE_ADJUDICATION_POLICY;
  sidecarSha256: string; entryCount: number; appliedQuestionIds: string[]; replacedPendingCount: number;
  scope: 'source_role_correction_not_runtime_allowlist';
}
export type QuestionReferenceAdjudicatedAnalysis = Omit<QuestionReferenceAnalysis, 'rows'> & {
  rows: Array<QuestionReferenceAnalysisRow | AdjudicatedQuestionReferenceRow>;
  adjudicationSummary?: QuestionReferenceAdjudicationSummary;
};
type Failure = 'INVALID_SIDECAR' | 'ANALYSIS_SOURCE_MISMATCH' | 'ANALYSIS_INTEGRITY_INVALID' | 'DUPLICATE_ENTRY' | 'UNKNOWN_QUESTION' | 'STALE_SOURCE' | 'STALE_QUESTION' | 'INVALID_EVIDENCE' | 'SOURCE_PATH_ESCAPE' | 'INVALID_REPLACEMENT';
export class QuestionReferenceAdjudicationError extends Error {
  constructor(readonly code: Failure, readonly questionId?: string) { super(code); this.name = 'QuestionReferenceAdjudicationError'; }
}
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const contentHash = (value: QuestionReferenceAdjudicatedAnalysis | Omit<QuestionReferenceAdjudicatedAnalysis, 'contentSha256'>) => sha256(JSON.stringify({ ...value, createdAt: undefined, updatedAt: undefined, contentSha256: undefined }));

/** Apply only source-evidenced corrections. Never rewrite the model journal or discard other rows. */
export async function applyQuestionReferenceAdjudications(corpus: CorpusInput, analysis: QuestionReferenceAnalysis, options: { root?: string; readOptions?: AnalysisReadOptions } = {}): Promise<QuestionReferenceAdjudicatedAnalysis> {
  const root = path.resolve(options.root ?? process.cwd());
  let bytes: Buffer;
  try { bytes = (await readDependency(root, QUESTION_REFERENCE_ADJUDICATION_FILE, 'book-adjudications', options.readOptions))!.bytes; }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return analysis;
    throw error;
  }
  let proposed: unknown;
  try { proposed = JSON.parse(bytes.toString('utf8')); } catch { throw new QuestionReferenceAdjudicationError('INVALID_SIDECAR'); }
  const parsed = questionReferenceAdjudicationsSchema.safeParse(proposed);
  if (!parsed.success) throw new QuestionReferenceAdjudicationError('INVALID_SIDECAR');
  const identity = questionReferenceAnalysisIdentity(corpus, { model: analysis.model });
  if (analysis.key !== identity.key || analysis.sourceFingerprint !== identity.sourceFingerprint) throw new QuestionReferenceAdjudicationError('ANALYSIS_SOURCE_MISMATCH');
  if (contentHash(analysis) !== analysis.contentSha256 || !questionReferenceAnalysisCoverage(corpus, analysis).exactAccounting) throw new QuestionReferenceAdjudicationError('ANALYSIS_INTEGRITY_INVALID');
  if (!parsed.data.entries.length) return analysis;

  const questionById = new Map(corpus.questions.map(question => [question.id, question]));
  const originalRows = new Map(analysis.rows.map(row => [row.questionId, row]));
  const sourceHashes = new Map(corpus.sourceHashes.map(source => [source.path, source.sha256]));
  const sourceReads = new Map<string, Promise<{ text: string; sha256: string }>>();
  const seen = new Set<string>(), replacements = new Map<string, AdjudicatedQuestionReferenceRow>();
  let replacedPendingCount = 0;
  for (const entry of parsed.data.entries) {
    const fail = (code: Failure): never => { throw new QuestionReferenceAdjudicationError(code, entry.questionId); };
    if (seen.has(entry.questionId)) fail('DUPLICATE_ENTRY');
    seen.add(entry.questionId);
    const question = questionById.get(entry.questionId), original = originalRows.get(entry.questionId);
    if (!question || !original) throw new QuestionReferenceAdjudicationError('UNKNOWN_QUESTION', entry.questionId);
    if (entry.sourceSha256 !== question.source.sha256 || sourceHashes.get(question.source.path) !== entry.sourceSha256 || original.sourceSha256 !== entry.sourceSha256) fail('STALE_SOURCE');
    if (entry.questionSha256 !== sha256(question.rawText) || original.questionSha256 !== entry.questionSha256) fail('STALE_QUESTION');
    if (entry.evidence.sourcePath !== question.source.path) fail('INVALID_EVIDENCE');
    const file = path.resolve(root, entry.evidence.sourcePath), relative = path.relative(root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('SOURCE_PATH_ESCAPE');
    let reading = sourceReads.get(entry.evidence.sourcePath);
    if (!reading) {
      reading = readDependency(root, question.source.path, 'book-source', options.readOptions).then(stored => ({ text: stored!.bytes.toString('utf8'), sha256: sha256(stored!.bytes) }));
      sourceReads.set(entry.evidence.sourcePath, reading);
    }
    const source = await reading.catch(() => { throw new QuestionReferenceAdjudicationError('STALE_SOURCE', entry.questionId); });
    if (source.sha256 !== entry.sourceSha256) fail('STALE_SOURCE');
    if (question.source.startOffset < 0 || question.source.endOffset > source.text.length || source.text.slice(question.source.startOffset, question.source.endOffset) !== question.rawText) fail('STALE_QUESTION');
    const evidence = entry.evidence;
    if (evidence.endOffset <= evidence.startOffset || evidence.endOffset > source.text.length || evidence.startOffset > question.source.startOffset || evidence.endOffset < question.source.endOffset || source.text.slice(evidence.startOffset, evidence.endOffset) !== evidence.quote) fail('INVALID_EVIDENCE');
    const domain = entry.replacement.domain ?? (original.status === 'reviewed' ? original.domain : 'unknown');
    let replacement: QuestionReferenceReviewedRow;
    try { replacement = finalizeQuestionReferenceBatch({ items: [{ ...entry.replacement, domain, questionId: question.id }] }, [question])[0]; }
    catch { fail('INVALID_REPLACEMENT'); }
    const previousOrigin = (original as Partial<AdjudicatedQuestionReferenceRow>).reviewOrigin;
    const reviewOrigin: QuestionReferenceAdjudicationOrigin = {
      type: 'source_context_adjudication', policyVersion: QUESTION_REFERENCE_ADJUDICATION_POLICY,
      originalRowSha256: previousOrigin?.type === 'source_context_adjudication' ? previousOrigin.originalRowSha256 : sha256(JSON.stringify(original)),
      originalStatus: previousOrigin?.type === 'source_context_adjudication' ? previousOrigin.originalStatus : original.status,
      analysisKey: analysis.key, adjudicationEntrySha256: sha256(JSON.stringify(entry)), evidence: structuredClone(evidence), reason: entry.reason,
    };
    if (reviewOrigin.originalStatus === 'pending') replacedPendingCount++;
    replacements.set(question.id, { ...replacement!, reviewOrigin });
  }
  const rows = analysis.rows.map(row => replacements.get(row.questionId) ?? row);
  const adjudicationSummary: QuestionReferenceAdjudicationSummary = {
    schemaVersion: QUESTION_REFERENCE_ADJUDICATION_SCHEMA, policyVersion: QUESTION_REFERENCE_ADJUDICATION_POLICY,
    sidecarSha256: sha256(bytes), entryCount: replacements.size, appliedQuestionIds: [...replacements.keys()].sort(), replacedPendingCount,
    scope: 'source_role_correction_not_runtime_allowlist',
  };
  const body: Omit<QuestionReferenceAdjudicatedAnalysis, 'contentSha256'> = { ...analysis, rows, coverage: questionReferenceAnalysisCoverage(corpus, rows), adjudicationSummary };
  const corrected = { ...body, contentSha256: contentHash(body) };
  if (!corrected.coverage.exactAccounting || corrected.rows.length !== analysis.rows.length) throw new QuestionReferenceAdjudicationError('ANALYSIS_INTEGRITY_INVALID');
  return corrected;
}
