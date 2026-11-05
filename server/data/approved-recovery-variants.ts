import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { InterviewContext } from './load-interview-context';
import type { QuestionDraft, RecordedTurn } from '../protocol';
import { buildQuestionPremiseReviewInput, questionPremiseReviewSchema, resolveVerifiedCommonPremiseAuthority, validateQuestionPremises } from '../providers/question-premises';
import { assertQuestionPresentation } from '../providers/question-plan';

export const RECOVERY_VARIANT_VERSION = 'independently-reviewed-same-demand-recovery-v1';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function recoveryVariantIdentity(context: InterviewContext, original: Pick<RecordedTurn, 'questionText' | 'evidenceIds' | 'metadata'>) {
  return hash({ version: RECOVERY_VARIANT_VERSION, originalText: original.questionText, intent: original.metadata.questionIntent, targets: original.metadata.targetEvidence, primaryFunction: original.metadata.primaryFunction, depth: original.metadata.depth, commonApproval: original.metadata.commonApproval ?? null, sources: context.student.evidence.filter(source => original.evidenceIds.includes(source.id)), files: context.manifest.files, policy: context.interviewerPolicy?.contentSha256 ?? null });
}
export interface ApprovedRecoveryVariantFile {
  version: typeof RECOVERY_VARIANT_VERSION;
  identity: string;
  originalQuestionText: string;
  originalQuestionIntent: string;
  originalTargetEvidence: string[];
  variants: Array<{ questionText: string; reviewedAt: string; reviewModel: string; review: unknown }>;
  contentSha256: string;
}
export async function saveApprovedRecoveryVariants(context: InterviewContext, original: RecordedTurn, variants: ApprovedRecoveryVariantFile['variants'], root = process.cwd()) {
  const body = { version: RECOVERY_VARIANT_VERSION as typeof RECOVERY_VARIANT_VERSION, identity: recoveryVariantIdentity(context, original), originalQuestionText: original.questionText, originalQuestionIntent: original.metadata.questionIntent, originalTargetEvidence: original.metadata.targetEvidence, variants };
  const value: ApprovedRecoveryVariantFile = { ...body, contentSha256: hash(body) };
  // Re-run the same deterministic proof/intent contract before making the artifact available.
  await materialize(context, original, value);
  const directory = path.resolve(root, 'data/prepared/recovery-variants');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${value.identity}.json`);
  try { await writeFile(file, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || (await readFile(file, 'utf8')) !== JSON.stringify(value, null, 2)) throw error; }
  return value;
}
async function materialize(context: InterviewContext, original: RecordedTurn, value: ApprovedRecoveryVariantFile): Promise<QuestionDraft[]> {
  const { contentSha256, ...body } = value;
  if (value.version !== RECOVERY_VARIANT_VERSION || value.identity !== recoveryVariantIdentity(context, original) || contentSha256 !== hash(body) || value.originalQuestionText !== original.questionText || value.originalQuestionIntent !== original.metadata.questionIntent || JSON.stringify(value.originalTargetEvidence) !== JSON.stringify(original.metadata.targetEvidence) || !Array.isArray(value.variants) || value.variants.length > 3) throw new Error('RECOVERY_VARIANT_IDENTITY_INVALID');
  const drafts: QuestionDraft[] = [];
  for (const variant of value.variants) {
    if (!variant.questionText.trim() || variant.questionText === original.questionText || !variant.reviewModel || !Number.isFinite(Date.parse(variant.reviewedAt))) throw new Error('RECOVERY_VARIANT_REVIEW_INVALID');
    const draft: QuestionDraft = { acknowledgement: null, acknowledgementQuote: null, questionText: variant.questionText, questionKind: 'clarification', parentMainQuestionId: original.parentMainQuestionId, evidenceIds: [...original.evidenceIds], evidenceQuotes: structuredClone(original.metadata.evidenceQuotes), primaryFunction: original.metadata.primaryFunction, depth: original.metadata.depth, questionIntent: original.metadata.questionIntent, targetEvidence: [...original.metadata.targetEvidence], groundingRationale: '사전 독립 검수한 같은 요구의 재진술이며 새로운 평가용 꼬리질문이 아니다.', validationStatus: 'approved', validationFailures: [], ...(original.metadata.commonApproval ? { commonApproval: structuredClone(original.metadata.commonApproval) } : {}) };
    const sources = context.student.evidence.filter(source => original.evidenceIds.includes(source.id));
    const commonAuthority = resolveVerifiedCommonPremiseAuthority(context, draft);
    const originalQuestion = { questionText: original.questionText, questionIntent: original.metadata.questionIntent, targetEvidence: original.metadata.targetEvidence, primaryFunction: original.metadata.primaryFunction, depth: original.metadata.depth };
    const input = buildQuestionPremiseReviewInput(draft, sources, undefined, originalQuestion, [], commonAuthority);
    questionPremiseReviewSchema.parse(variant.review);
    await validateQuestionPremises({ draft, sources, originalQuestion, ...(commonAuthority ? { commonAuthority } : {}), reviewModel: variant.reviewModel, requestReview: async () => variant.review });
    // The proof contract is rebuilt from the exact current inputs, never accepted by file flag alone.
    if (input.question.questionIntent !== original.metadata.questionIntent) throw new Error('RECOVERY_VARIANT_DEMAND_CHANGED');
    assertQuestionPresentation(draft);
    drafts.push(draft);
  }
  return drafts;
}
/** Immutable, exact source/question/demand identity only. Loading never invokes a provider. */
export async function loadApprovedRecoveryVariants(context: InterviewContext, original: RecordedTurn, root = process.cwd()): Promise<QuestionDraft[]> {
  let value: ApprovedRecoveryVariantFile;
  try { value = JSON.parse(await readFile(path.resolve(root, 'data/prepared/recovery-variants', `${recoveryVariantIdentity(context, original)}.json`), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return materialize(context, original, value);
}
