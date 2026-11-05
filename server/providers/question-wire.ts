import { z } from "zod";
import { questionDraftSchema, type QuestionDraft } from "../protocol";
import { findVerifiedSourceQuote, QuestionValidationError, type GroundingSource } from "./question-grounding";

export interface QuestionQuotePlan { evidenceId: string; quoteOptions: string[] }
export interface QuestionWireOptions {
  kinds?: QuestionDraftKind[]; targetEvidence?: string[]; questionMaxLength?: number;
  fixed?: Pick<QuestionDraft, "primaryFunction" | "depth" | "parentMainQuestionId"> & { questionIntent?: string };
  commonApproval?: QuestionDraft['commonApproval'];
}
type QuestionDraftKind = "main" | "follow_up" | "clarification" | "end";

/** Wire restrictions supplement, never replace, the independent final ID-by-ID PDF check. */
export function questionWireSchema(sources: GroundingSource[], quotePlan: QuestionQuotePlan[], options: QuestionWireOptions = {}) {
  const sourceById = new Map(sources.map(source => [source.id, source.text]));
  const verified = quotePlan.map(plan => ({ id: plan.evidenceId, quotes: [...new Set(plan.quoteOptions)].filter(quote => {
    const source = sourceById.get(plan.evidenceId);
    return source !== undefined && Boolean(findVerifiedSourceQuote(source, quote));
  }) })).filter(plan => plan.quotes.length > 0);
  const ids = [...new Set(verified.map(plan => plan.id))], quotes = [...new Set(verified.flatMap(plan => plan.quotes))];
  if ((!ids.length || !quotes.length) && options.commonApproval?.kind === 'COMMON_APPROVED') {
    return questionDraftSchema.extend({
      questionKind: z.literal('main'),
      questionText: z.string().min(8).max(options.questionMaxLength ?? 100),
      evidenceIds: z.array(z.string()).length(0),
      evidenceQuotes: z.array(z.object({ evidenceId: z.string(), quote: z.string() })).length(0),
      targetEvidence: options.targetEvidence?.length ? z.array(z.enum(options.targetEvidence as [string, ...string[]])).length(options.targetEvidence.length) : z.array(z.string().min(2).max(100)).length(1),
      ...(options.fixed ? { primaryFunction: z.literal(options.fixed.primaryFunction), depth: z.literal(options.fixed.depth), parentMainQuestionId: z.literal(null), ...(options.fixed.questionIntent ? { questionIntent: z.literal(options.fixed.questionIntent) } : {}) } : {}),
    });
  }
  if (!ids.length || !quotes.length) throw new QuestionValidationError("MISSING_EVIDENCE");
  const allowedId = z.enum(ids as [string, ...string[]]);
  const allowedQuote = z.enum(quotes as [string, ...string[]]);
  const kinds = options.kinds ?? ["main", "follow_up", "end"];
  const targets = options.targetEvidence;
  return questionDraftSchema.extend({
    questionKind: z.enum(kinds as [QuestionDraftKind, ...QuestionDraftKind[]]),
    questionText: z.string().min(8).max(options.questionMaxLength ?? 100),
    questionIntent: z.string().min(5).max(100),
    ...(options.fixed ? { primaryFunction: z.literal(options.fixed.primaryFunction), depth: z.literal(options.fixed.depth), parentMainQuestionId: z.literal(options.fixed.parentMainQuestionId), ...(options.fixed.questionIntent ? { questionIntent: z.literal(options.fixed.questionIntent) } : {}) } : {}),
    groundingRationale: z.string().min(5).max(160),
    targetEvidence: targets?.length ? z.array(z.enum(targets as [string, ...string[]])).length(targets.length) : z.array(z.string().min(2).max(100)).length(1),
    evidenceIds: z.array(allowedId).max(6),
    evidenceQuotes: z.array(z.object({ evidenceId: allowedId, quote: allowedQuote })).max(6),
  });
}
