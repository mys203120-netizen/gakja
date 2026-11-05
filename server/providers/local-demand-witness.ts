import type { RecordedTurn } from '../protocol';

/** A high-precision minimum witness for the spoken "what did YOU do" demand.
 * It confirms a source-bound claimed action, never its truth/quality or a score.
 * Unmatched language stays with the semantic core, rather than guessing met.
 */
export function personalActionWitness(turn: Pick<RecordedTurn, 'questionText' | 'rawTranscript' | 'metadata'>) {
  const asked = turn.questionText.normalize('NFC'), raw = turn.rawTranscript ?? '';
  if (turn.metadata.primaryFunction !== 'ROLE' || !/본인|직접|맡/u.test(asked) || !/한 일|어떤 일|맡.{0,8}일|역할/u.test(asked)) return null;
  if (/각각|모두|둘\s*다|양쪽|비교(?:해|하여|하시오|하세|할|한)|차이|다른지|구분|왜|이유|근거|기준|과정|방법|순서|어떻게|얼마|몇/u.test(asked)) return null;
  const stop = /^(?:본인(?:이|은)?|직접|실제로|스스로|어떤|무엇|활동|있다면|무엇인가요|말씀|준비|당시|한가지|해주세요)$/u;
  const topics = [...asked.matchAll(/[가-힣A-Za-z]{3,}/gu)].map(match => match[0].replace(/(?:에서는|에서|에게|을|를|의|과|와)$/u, '')).filter(word => word.length >= 3 && !stop.test(word));
  const action = /(?:고쳤|수정했|조정했|작성했|제작했|설명했|설명해\s*드렸|분석했|정리했|설계했|실험했|측정했|비교했|만들었|바꾸었|바꿨|계산했|발표했|안내했)(?:습니다|어요|고|으며|는데|던)/u;
  for (const sentence of raw.matchAll(/[^.!?。\n]+/gu)) {
    const firstPerson = [...sentence[0].matchAll(/저는|제가|본인은|본인이/gu)].at(-1);
    const personal = firstPerson ? sentence[0].slice(firstPerson.index) : sentence[0];
    if (/없|않|못|아니|기억|모르|(?:했|셨|쳤|졌|었)다고|라고|했다는|하셨|들었/u.test(personal)) continue;
    if (!firstPerson && /다\s*같이|함께|저희|우리|팀원|친구|조원|선생|교사/u.test(personal)) continue;
    if (!action.test(personal) || !topics.some(topic => personal.replace(/\s/gu, '').includes(topic))) continue;
    const leading = personal.length - personal.trimStart().length;
    const start = sentence.index! + (firstPerson?.index ?? 0) + leading;
    const quote = personal.trim();
    if (!quote || quote.length > 240) continue;
    return { version: 'spoken-one-personal-action-v1', start, end: start + quote.length, quote,
      fulfillment: 'met' as const, authority: 'one_claimed_action_only_not_truth_or_score' as const };
  }
  return null;
}
