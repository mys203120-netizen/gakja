import { questionDraftSchema, type QuestionDraft } from "../protocol";

export interface GroundingSource { id: string; text: string }
export interface VerifiedSourceQuote {
  quote: string;
  /** UTF-16 offsets within the supplied evidence.text, before normalization. */
  sourceStartOffset: number;
  sourceEndOffset: number;
  matchKind: "exact" | "canonical_whitespace" | "pdf_line_wrap";
}
interface TextUnit { character: string; start: number; end: number; lineBreak: boolean }

/** Canonical Unicode only: compatibility folding, punctuation changes and paraphrases are excluded. */
function textUnits(text: string): TextUnit[] {
  const units: TextUnit[] = [];
  const segmenter = new Intl.Segmenter("ko", { granularity: "grapheme" });
  for (const part of segmenter.segment(text)) {
    for (const character of part.segment.normalize("NFC")) {
      const whitespace = /\s/u.test(character);
      const previous = units.at(-1);
      const lineBreak = /[\r\n\u2028\u2029]/u.test(character);
      if (whitespace && previous?.character === " ") {
        previous.end = part.index + part.segment.length;
        previous.lineBreak ||= lineBreak;
      } else units.push({ character: whitespace ? " " : character, start: part.index, end: part.index + part.segment.length, lineBreak });
    }
  }
  return units;
}

export function sourceQuoteForDisplay(text: string) { return text.normalize("NFC").replace(/\s+/gu, " ").trim(); }

function isGraphemeBoundary(text: string, offset: number) {
  if (offset === 0 || offset === text.length) return true;
  for (const part of new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(text)) if (part.index === offset) return true;
  return false;
}

/**
 * A citation must remain one contiguous original span. PDF line breaks can represent
 * either a space or a break inside a word, but ordinary word spaces cannot disappear.
 * The returned text always comes from source.slice(), never from the model.
 */
export function findVerifiedSourceQuote(source: string, proposedQuote: string): VerifiedSourceQuote | null {
  if (!proposedQuote.trim() || [...proposedQuote.replace(/\s/gu, "")].length < 4) return null;
  const exact = source.indexOf(proposedQuote);
  if (exact >= 0 && isGraphemeBoundary(source, exact) && isGraphemeBoundary(source, exact + proposedQuote.length)) return { quote: source.slice(exact, exact + proposedQuote.length), sourceStartOffset: exact, sourceEndOffset: exact + proposedQuote.length, matchKind: "exact" };
  const original = textUnits(source);
  const candidate = textUnits(proposedQuote);
  while (candidate[0]?.character === " ") candidate.shift();
  while (candidate.at(-1)?.character === " ") candidate.pop();
  if (!candidate.length) return null;
  for (let start = 0; start < original.length; start++) {
    if (original[start].character !== candidate[0].character) continue;
    let cursor = start, proposed = 0, joined = false;
    while (cursor < original.length && proposed < candidate.length) {
      const unit = original[cursor];
      if (unit.character === candidate[proposed].character) { cursor++; proposed++; continue; }
      // Only an actual PDF line break between letters may join a wrapped word.
      // In particular, 10\n20 cannot become 1020 and an ordinary space is significant.
      if (unit.character === " " && unit.lineBreak &&
          /\p{L}/u.test(original[cursor - 1]?.character ?? "") &&
          /\p{L}/u.test(original[cursor + 1]?.character ?? "")) {
        joined = true; cursor++; continue;
      }
      break;
    }
    if (proposed === candidate.length) {
      const sourceStartOffset = original[start].start;
      const sourceEndOffset = original[cursor - 1].end;
      // A Unicode grapheme is indivisible; do not add or drop a partial emoji/combining cluster.
      if ((original[start - 1]?.end ?? 0) > sourceStartOffset || (original[cursor]?.start ?? source.length) < sourceEndOffset) continue;
      return { quote: source.slice(sourceStartOffset, sourceEndOffset), sourceStartOffset, sourceEndOffset, matchKind: joined ? "pdf_line_wrap" : "canonical_whitespace" };
    }
  }
  return null;
}

export type QuestionValidationCode = "INVALID_FORMAT" | "MISSING_EVIDENCE" | "UNKNOWN_EVIDENCE" | "MISSING_CITATION" | "DUPLICATE_CITATION" | "UNDECLARED_CITATION" | "CITATION_NOT_FOUND" | "FIRST_QUESTION_KIND" | "FOLLOW_UP_RULE" | "UNAPPROVED_QUESTION" | "FORBIDDEN_SPEECH" | "MULTIPLE_QUESTIONS" | "REPEATED_QUESTION" | "PLAN_MISMATCH" | "REPEATED_INTENT" | "PREMISE_UNSUPPORTED" | "PREMISE_UNCERTAIN" | "PREMISE_REVIEW_INVALID";
export class QuestionValidationError extends Error {
  constructor(public code: QuestionValidationCode) { super(code); this.name = "QuestionValidationError"; }
}
export class QuestionPreparationError extends Error {
  readonly code = "QUESTION_PREPARATION_RETRY";
  constructor(public attemptCount: number, public lastValidationCode?: QuestionValidationCode) {
    super("질문 준비를 완료하지 못했어요. ‘다시 시도’를 눌러 주세요.");
    this.name = "QuestionPreparationError";
  }
}

export function canonicalizeQuestionCitations(draft: QuestionDraft, sources: GroundingSource[]): QuestionDraft {
  if (draft.questionKind === "end") return draft;
  if (!draft.evidenceIds.length && draft.commonApproval?.kind === 'COMMON_APPROVED') {
    const approval = draft.commonApproval;
    if (!approval.moduleId || !approval.approvalRevision || !approval.supportTargetId || draft.evidenceQuotes.length || draft.validationFailures.length) throw new QuestionValidationError('MISSING_EVIDENCE');
    return draft;
  }
  if (!draft.evidenceIds.length) throw new QuestionValidationError("MISSING_EVIDENCE");
  if (draft.validationFailures.length) throw new QuestionValidationError("UNAPPROVED_QUESTION");
  const sourceById = new Map(sources.map(source => [source.id, source.text]));
  if (draft.evidenceIds.some(id => !sourceById.has(id))) throw new QuestionValidationError("UNKNOWN_EVIDENCE");
  if (new Set(draft.evidenceIds).size !== draft.evidenceIds.length) throw new QuestionValidationError("DUPLICATE_CITATION");
  if (draft.evidenceQuotes.some(citation => !draft.evidenceIds.includes(citation.evidenceId))) throw new QuestionValidationError("UNDECLARED_CITATION");
  const evidenceQuotes = draft.evidenceIds.map(id => {
    const citations = draft.evidenceQuotes.filter(citation => citation.evidenceId === id);
    if (!citations.length) throw new QuestionValidationError("MISSING_CITATION");
    if (citations.length !== 1) throw new QuestionValidationError("DUPLICATE_CITATION");
    const match = findVerifiedSourceQuote(sourceById.get(id)!, citations[0].quote);
    if (!match) throw new QuestionValidationError("CITATION_NOT_FOUND");
    return { evidenceId: id, ...match };
  });
  return { ...draft, evidenceQuotes };
}

/** Short, server-owned source choices reduce transcription-by-model errors. */
export function buildSourceQuotePlan(sources: GroundingSource[]) {
  return sources.map(source => {
    const options: string[] = [];
    for (const sentence of source.text.matchAll(/[^.!?。]+[.!?。]?/gu)) {
      const start = sentence.index;
      const fragment = source.text.slice(start, start + Math.min(sentence[0].length, 180)).trim();
      const quote = sourceQuoteForDisplay(fragment);
      if ([...quote.replace(/\s/gu, "")].length >= 12 && findVerifiedSourceQuote(source.text, quote)) options.push(quote);
      if (options.length === 3) break;
    }
    if (!options.length) {
      const quote = sourceQuoteForDisplay(source.text.slice(0, 180));
      if (findVerifiedSourceQuote(source.text, quote)) options.push(quote);
    }
    // A verified short source preserves a qualifier/target beyond the first excerpt option.
    const fullSource = sourceQuoteForDisplay(source.text);
    if (source.text.length <= 600 && !options.includes(fullSource) && findVerifiedSourceQuote(source.text, fullSource)) options.push(fullSource);
    return { evidenceId: source.id, quoteOptions: options };
  });
}

export interface GroundedQuestionRequest { attempt: number; previousFailure: QuestionValidationCode | null; quotePlan: ReturnType<typeof buildSourceQuotePlan> }
export async function generateWithVerifiedGrounding(options: {
  sources: GroundingSource[];
  requestDraft: (request: GroundedQuestionRequest) => Promise<unknown>;
  validateDraft?: (draft: QuestionDraft) => Promise<void> | void;
  onAttempt?: (result: { attempt: number; code: QuestionValidationCode | "APPROVED" }) => Promise<void> | void;
  maxAttempts?: number;
  /** Server-provided approval, never accepted from the model's JSON. */
  trustedCommonApproval?: NonNullable<QuestionDraft['commonApproval']>;
}): Promise<QuestionDraft> {
  const maxAttempts = options.maxAttempts ?? 2;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error("Question generation attempts must be between 1 and 3.");
  const quotePlan = buildSourceQuotePlan(options.sources);
  let previousFailure: QuestionValidationCode | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await options.requestDraft({ attempt, previousFailure, quotePlan });
      const parsed = questionDraftSchema.safeParse(response);
      if (!parsed.success) throw new QuestionValidationError("INVALID_FORMAT");
      if (options.trustedCommonApproval) Object.assign(parsed.data, { commonApproval: structuredClone(options.trustedCommonApproval) });
      const grounded = canonicalizeQuestionCitations(parsed.data, options.sources);
      await options.validateDraft?.(grounded);
      await options.onAttempt?.({ attempt, code: "APPROVED" });
      return grounded;
    } catch (error) {
      if (!(error instanceof QuestionValidationError)) throw error;
      previousFailure = error.code;
      await options.onAttempt?.({ attempt, code: error.code });
    }
  }
  throw new QuestionPreparationError(maxAttempts, previousFailure ?? undefined);
}
