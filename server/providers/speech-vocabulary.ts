import type { InterviewContext } from '../data/load-interview-context';
import type { RecordedTurn } from '../protocol';

/** Acoustic hints, never a student's expected answer or a transcript rewrite.
 * Boosting every source token at 1.5 reproducibly deleted ordinary request words
 * from the same audio. Keep verified scientific terms and acronyms only.
 */
export const STREAMING_VOCABULARY_POLICY = Object.freeze({ maxTerms: 8, weight: 0.3, version: 'technical-only-low-weight-v2' });
const technicalTerms = ['변곡점','신뢰구간','메틸화율','메틸화','정전용량','약전해질','강전해질','전도도','해리도','미적분','사다리꼴','암모니아','크래킹','열역학','촉매','폴리올','전극','활성화에너지','반응속도','산화환원','상관관계','인과관계','MXene'] as const;
const technicalSet = new Set<string>(technicalTerms);
const acronym = /^(?:[A-Z][A-Z0-9+-]{1,17}|(?:[A-Z][a-z]?\d*){2,})$/u;
const isTechnical = (word: string) => technicalSet.has(word) || acronym.test(word);

/** Bounded terms from only this question and linked evidence. Generic Korean
 * extraction/OCR fragments must not compete with ordinary candidate language. */
export function currentQuestionVocabulary(context: InterviewContext, turn: Pick<RecordedTurn, 'questionText' | 'evidenceIds'>): string[] {
  const source = [turn.questionText, ...context.student.evidence.filter(row => turn.evidenceIds.includes(row.id)).map(row => row.text)].join('\n').normalize('NFC');
  const compact = source.replace(/\s+/gu, '');
  const terms = [...technicalTerms.filter(term => compact.includes(term)), ...(source.match(/[A-Za-z][A-Za-z0-9+-]{1,17}/gu) ?? []).filter(word => acronym.test(word))];
  return [...new Set(terms)].sort((a,b) => compact.indexOf(a) - compact.indexOf(b) || b.length-a.length)
    .filter((word, index, all) => !all.slice(0,index).some(longer => longer.includes(word)))
    .slice(0, STREAMING_VOCABULARY_POLICY.maxTerms);
}

/** Official streaming gRPC Config JSON supports direct boostings (not REST-only).
 * https://api.ncloud-docs.com/docs/ai-application-service-clovaspeech-grpc
 * Direct keywords and domain boostingIDs must not be supplied together. */
export function clovaStreamingConfiguration(keywords: readonly string[] = []) {
  const words = [...new Set(keywords.map(word => word.normalize('NFC').trim()).filter(word => word.length >= 2 && word.length <= 30 && !/[,\r\n]/u.test(word) && isTechnical(word)))].slice(0, STREAMING_VOCABULARY_POLICY.maxTerms);
  return { transcription: { language: 'ko' }, useDomainForbiddens: false,
    ...(words.length ? { keywordBoosting: { boostings: [{ words: words.join(','), weight: STREAMING_VOCABULARY_POLICY.weight }] } } : {}),
    semanticEpd: { skipEmptyText: false, useWordEpd: true, usePeriodEpd: true, gapThreshold: 800, durationThreshold: 5000, syllableThreshold: 0 } };
}
