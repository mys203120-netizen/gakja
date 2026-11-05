import { createHash } from 'node:crypto';

export const TRANSCRIPT_INTERPRETATION_VERSION = 'source-bound-pronunciation-hints-v1';
const aliases = [
  { term: 'CNT', pattern: /(?:씨\s*엔\s*(?:티|T)|시\s*엔\s*(?:티|T)|씨엔티|시엔티)/giu },
  { term: 'MXene', pattern: /맥신/gu },
  { term: 'STEM', pattern: /에스\s*티\s*이\s*엠/gu },
] as const;
/** A reversible reading aid, never a replacement STT record or new quotation. */
export function interpretTranscriptTerms(rawTranscript: string, verifiedVocabulary: readonly string[]) {
  const active = new Set(verifiedVocabulary.map(term => term.toLowerCase()));
  const readings: Array<{ start: number; end: number; surface: string; canonicalTerm: string; basis: 'exact_pronunciation_alias_in_current_verified_vocabulary' }> = [];
  for (const { term, pattern } of aliases) {
    if (!active.has(term.toLowerCase())) continue;
    for (const match of rawTranscript.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const start = match.index!, end = start + match[0].length;
      // Do not normalize a coincidental fragment inside another word/acronym.
      if (/[A-Za-z가-힣]/u.test(rawTranscript[start - 1] ?? '') || /[A-Za-z]/u.test(rawTranscript[end] ?? '')) continue;
      readings.push({ start, end, surface: match[0], canonicalTerm: term, basis: 'exact_pronunciation_alias_in_current_verified_vocabulary' });
    }
  }
  readings.sort((a, b) => a.start - b.start);
  let normalizedReading = rawTranscript;
  for (const reading of [...readings].reverse()) normalizedReading = normalizedReading.slice(0, reading.start) + reading.canonicalTerm + normalizedReading.slice(reading.end);
  return { version: TRANSCRIPT_INTERPRETATION_VERSION, rawTranscriptSha256: createHash('sha256').update(rawTranscript).digest('hex'),
    rawTranscriptPreserved: true as const, normalizedReading, readings,
    policy: 'Reading aid only. All answer quotes/proofs use the exact raw transcript and its original UTF-16 offsets. Never infer ambiguous 신 전극 as MXene, restore omitted words, or change numbers, negations or uncertainty.' };
}
