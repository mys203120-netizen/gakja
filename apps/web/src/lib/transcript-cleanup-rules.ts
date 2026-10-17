/** Automatic display formatting cannot re-hear or correct the recorded words. */
export const MAX_TRANSCRIPT_CLEANUP_CHARACTERS = 18000;
// Retained for historical metadata compatibility; current formatting requires no lexical edits.
export type TranscriptCopyEdit = { original: string; replacement: string; occurrence: number; kind: 'spelling' | 'disfluency' };
export type TranscriptCleanupCandidate = { display_text: string; edits: TranscriptCopyEdit[] };
export type ValidatedTranscriptCleanup = { text: string; edits: Array<TranscriptCopyEdit & { start: number; end: number }> };

// Preserve mathematical signs, brackets, hyphens, slashes and Unicode symbols.
const typography = /[\s.,!?;:'"“”‘’…。！？、，：；]/gu;
const lexical = (text: string) => text.normalize('NFC').replace(typography, '');
// Decimal/group separators may look like punctuation but change numeric values.
const numbers = (text: string) => text.match(/[-+]?\d+(?:[.,]\d+)*/gu) || [];

export function validateTranscriptCleanup(rawText: string, candidate: unknown): ValidatedTranscriptCleanup {
  if (!rawText.trim() || rawText.length > MAX_TRANSCRIPT_CLEANUP_CHARACTERS) throw new Error('TRANSCRIPT_LENGTH_INVALID');
  if (!candidate || typeof candidate !== 'object') throw new Error('CLEANUP_SCHEMA_INVALID');
  const value = candidate as Partial<TranscriptCleanupCandidate>;
  if (typeof value.display_text !== 'string' || !value.display_text.trim() || !Array.isArray(value.edits)) throw new Error('CLEANUP_SCHEMA_INVALID');
  const display = value.display_text.trim();
  if (display.length > rawText.length * 1.5 + 80 || /\p{Cc}/u.test(display.replace(/[\n\r\t]/g, ''))) throw new Error('CLEANUP_LENGTH_INVALID');
  // Small edit distance is not evidence: 양극→음극 changes the statement.
  // Preserve fillers, repetitions and possible recognition errors for audio review.
  if (value.edits.length || lexical(rawText) !== lexical(display)) throw new Error('CLEANUP_UNSUPPORTED_CHANGE');
  if (JSON.stringify(numbers(rawText)) !== JSON.stringify(numbers(display))) throw new Error('CLEANUP_MEANING_CHANGED');
  return { text: display, edits: [] };
}
