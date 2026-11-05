import { selectNonRepeatingTemplate, type UtteranceHistoryItem } from './utterance-variation';

/** Guide 2.3 §§9–10, 14–17, 23: one observed answer, one cognitive request. */
export const FOLLOW_UP_LANGUAGE_VERSION = 'answer-bound-language-v2.3-book-tone-v1';
export const followUpGoals = ['basis', 'choice', 'process', 'own_action', 'measurement', 'comparison', 'limit', 'meaning', 'motive', 'result', 'alternative', 'connection'] as const;
export type FollowUpGoal = typeof followUpGoals[number];
export const followUpGoalLabels: Record<FollowUpGoal, string> = {
  basis: '판단 근거 한 가지', choice: '선택 기준 한 가지', process: '실제로 거친 한 단계',
  own_action: '본인이 직접 한 행동 한 가지', measurement: '수치를 확인한 기준', comparison: '비교해 확인한 차이 한 가지',
  limit: '해석할 수 있는 범위', meaning: '표현의 구체적 의미', motive: '관심을 갖게 된 계기',
  result: '실제로 확인한 결과', alternative: '구체적으로 바꿀 한 가지', connection: '실제로 말한 연결 지점',
};

// These are language choices, not additional probing goals. Never choose a new goal to vary wording.
const requests: Record<FollowUpGoal, readonly string[]> = {
  basis: ['그 판단의 근거 한 가지는 무엇인가요?', '그렇게 판단한 근거를 하나 말씀해 주세요.', '어떤 근거로 그렇게 판단했나요?'],
  choice: ['그때 중요하게 본 기준은 무엇인가요?', '그 선택에서 우선한 기준은 무엇인가요?', '어떤 기준으로 선택했나요?'],
  process: ['실제로 거친 한 단계를 구체적으로 설명해 주세요.', '그 과정에서 실제로 한 단계는 무엇인가요?', '실제로 진행한 한 단계를 말씀해 주세요.'],
  own_action: ['본인이 직접 한 행동 한 가지는 무엇인가요?', '그중 본인이 직접 맡은 행동은 무엇인가요?', '본인이 직접 한 일을 하나 말씀해 주세요.'],
  measurement: ['그 값은 어떤 기준으로 확인했나요?', '그 수치를 확인한 기준은 무엇인가요?', '그 값을 확인할 때 사용한 기준을 말씀해 주세요.'],
  comparison: ['어떤 기준으로 차이를 확인했나요?', '그 비교에서 차이를 판단한 기준은 무엇인가요?', '차이를 확인할 때 사용한 비교 기준을 말씀해 주세요.'],
  limit: ['어디까지 해석할 수 있다고 보나요?', '해석할 수 있는 범위는 어디까지인가요?', '그 내용을 해석할 때 주의할 한계는 무엇인가요?'],
  meaning: ['그 표현의 의미를 구체적으로 설명해 주세요.', '그 표현은 어떤 의미인가요?', '그 말의 구체적인 의미는 무엇인가요?'],
  motive: ['그 관심을 갖게 된 계기는 무엇인가요?', '그렇게 관심을 갖게 된 이유는 무엇인가요?', '어떤 계기로 관심을 갖게 됐나요?'],
  result: ['실제로 확인한 결과 한 가지는 무엇인가요?', '그때 관찰한 결과를 하나 말씀해 주세요.', '실제로 어떤 결과를 확인했나요?'],
  alternative: ['구체적으로 바꿀 한 가지는 무엇인가요?', '다시 한다면 무엇을 하나 바꾸겠어요?', '한 가지를 보완한다면 무엇을 바꾸겠어요?'],
  connection: ['말씀하신 연결 지점을 구체적으로 설명해 주세요.', '어떤 점에서 서로 연결된다고 보나요?', '말씀하신 관련성을 구체적으로 설명해 주세요.'],
};
const attributions = [
  { id: 'quoted', before: '‘', after: '’라고 하셨는데, ' },
  { id: 'just-said', before: '방금 ‘', after: '’라고 하셨는데, ' },
  { id: 'your-words', before: '말씀하신 ‘', after: '’, ' },
] as const;

export interface FollowUpLanguageTemplate {
  id: string; family: string; goal: FollowUpGoal; request: string; before: string; after: string;
}
function quoteParticle(quote: string): '이라고' | '라고' {
  const last = quote.trim().at(-1) ?? '', code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 ? '이라고' : '라고';
  return /[013678]$/u.test(last) ? '이라고' : '라고';
}
export function followUpLanguageTemplates(goal: FollowUpGoal, quote?: string): FollowUpLanguageTemplate[] {
  return requests[goal].flatMap((request, index) => attributions.map(attribution => ({
    id: `${goal}.request-${index + 1}.${attribution.id}`, family: `${goal}.request-${index + 1}`, goal, request,
    before: attribution.before, after: quote ? attribution.after.replace('라고', quoteParticle(quote)) : attribution.after,
  })));
}

interface ObservationSpan { start: number; end: number }
/** Keep decimal punctuation; separate a negated clause from a later positive correction. */
function observationClauses(raw: string) {
  const separators = /[!?。\n;，]|(?<!\d)\.(?!\d)|(?<!\d),|,(?!\d)|지만|으나|는데|아니라|반면(?:에)?|그러나|다만|그리고|(?<=(?:았|었|했|였|없|않))고/gu;
  const clauses: Array<{ text: string; start: number }> = [];
  let start = 0;
  for (const match of raw.matchAll(separators)) {
    if (match[0] === '아니라' && /뿐만\s*$/u.test(raw.slice(start, match.index!))) continue;
    const end = match.index! + (match[0] === '아니라' ? match[0].length : 0);
    clauses.push({ text: raw.slice(start, end), start }); start = match.index! + match[0].length;
  }
  clauses.push({ text: raw.slice(start), start });
  return clauses;
}
function isNegatedOrProspective(text: string, kind: 'measurement' | 'comparison') {
  const clause = text.replace(/뿐만\s*아니라/gu, '');
  const unknownOrCorrection = /모르|모른|아니라|아닙|아니었|아닌|아니다|기억.{0,12}(?:않|없)|알\s*수\s*없/u;
  const measurementNegation = /(?:수치|값|비율|횟수|오차)(?:는|은|가|이|도|조차)?\s*(?:(?:전혀|아직|정확히|잘|별로)\s*)?(?:없(?!이)|아니)|(?:측정|계산|산출|기록|확인).{0,10}(?:않|못|안\s*(?:했|하|해))|(?:측정|계산|산출|기록|확인)(?:한|해\s*본)\s*(?:적|기록|결과)(?:이|은|도|가)?\s*없|(?:안|못)\s*(?:측정|계산|산출|기록|확인)/u;
  const comparisonNegation = /(?:비교|차이|대조).{0,16}(?:않|못|없(?!이)|안\s*(?:했|하|해))|(?:안|못)\s*(?:비교|대조)/u;
  const prospective = kind === 'measurement'
    ? /(?:측정|계산|산출|기록|확인).{0,8}(?:할\s*(?:예정|계획)|하려|하면|한다면|할\s*수|해\s*볼|해보려)/u
    : /(?:비교|대조).{0,8}(?:할\s*(?:예정|계획)|하려|하면|한다면|할\s*수|해\s*볼|해보려)/u;
  return unknownOrCorrection.test(clause) || (kind === 'measurement' ? measurementNegation : comparisonNegation).test(clause) || prospective.test(clause);
}
const numericQuantity = /[+-]?\d+(?:,\d{3})*(?:\.\d+)?\s*(?:퍼센트|%|(?:mmol|mol|mg|kg|mL|ml|mm|cm|km|kHz|Hz|℃|°C|g|L|m)(?![A-Za-z])|초|분|시간|회|번|개|명|도)/gu;
const measurementTerm = /측정값|결과값|수치|비율|횟수|오차|농도|온도|질량|무게|길이|부피|속도|값/gu;
/** Document IDs and ordinal positions are labels, not measured quantities or repetition counts. */
function isIdentifierOrOrdinalQuantity(text: string, match: RegExpMatchArray) {
  if (!/(?:번|회)$/u.test(match[0])) return false;
  const before = text.slice(0, match.index!), after = text.slice(match.index! + match[0].length);
  if (/^(?:째|차)/u.test(after)) return true;
  if (/^\s*(?:자료|문항|질문|활동|도표|표|그림|페이지|항목|논문|문서|문제|번호)/u.test(after)) return true;
  // Bare labels before 번호 are identifiers; an object particle (자료를 3번 확인) still permits a real count.
  return /번$/u.test(match[0]) && /(?:자료|문항|질문|활동|도표|표|그림|페이지|항목|논문|문서|문제|번호)(?:\s*의)?\s*(?:제\s*)?$/u.test(before);
}
function observationSpans(raw: string, kind: 'measurement' | 'comparison'): ObservationSpan[] {
  const result: ObservationSpan[] = [];
  for (const { text, start } of observationClauses(raw)) {
    if (isNegatedOrProspective(text, kind)) continue;
    const add = (match: RegExpMatchArray) => result.push({ start: start + match.index!, end: start + match.index! + match[0].length });
    if (kind === 'measurement') {
      // Dates, school grades, question numbers and document identifiers are not measured quantities.
      for (const match of text.matchAll(numericQuantity)) if (!isIdentifierOrOrdinalQuantity(text, match)) add(match);
      const completed = /(?:측정|계산|산출|기록|확인|세어).{0,6}(?:했|하였|됐|되었|한|함|하니)/u.test(text);
      const nonCalendarNumbers = text.replace(/\d+(?:\.\d+)?\s*(?:학년|년도|년|월|일)|(?:제\s*)?\d+\s*(?:번|차)\s*(?:자료|문항|질문|활동)/gu, '');
      const valueStatement = /\d/u.test(nonCalendarNumbers) && /(?:입니다|이었|였|나왔|나타났|기록|측정|확인|계산)/u.test(text);
      if (completed || valueStatement) for (const match of text.matchAll(measurementTerm)) add(match);
      // A stated completed measurement is a real action even when its numeric value was not quoted.
      for (const match of text.matchAll(/측정(?:했|하였|한|함|해|하니)/gu)) add(match);
    } else {
      for (const match of text.matchAll(/(?:비교|대조)(?:했|하였|해|한|함|하니)|달랐|다르(?:다고|다는|게|다)|차이(?:가|는|를|도|점이|점은)?\s*.{0,12}(?:있|났|확인했|관찰했|발견했|나타났)/gu)) add(match);
    }
  }
  return result;
}
function hasObserved(raw: string, kind: 'measurement' | 'comparison', quote?: string) {
  const observations = observationSpans(raw, kind);
  if (quote === undefined) return observations.length > 0;
  // findTranscriptSpan also attributes the first exact occurrence; a later repetition must not rescue a negated first one.
  const start = raw.indexOf(quote);
  return start >= 0 && observations.some(span => span.start >= start && span.end <= start + quote.length);
}
/** Optional quote binds the positive observation to the actual ANSWER_TURN attribution. */
export function hasObservedMeasurement(raw: string, quote?: string) {
  return hasObserved(raw, 'measurement', quote);
}
export function hasObservedComparison(raw: string, quote?: string) {
  return hasObserved(raw, 'comparison', quote);
}

export function renderConstrainedFollowUp(goal: FollowUpGoal, quote: string, seed: string, history: readonly UtteranceHistoryItem[] = []) {
  if (!quote || quote.length > 28 || /[\r\n“”‘’"'?？;:]/u.test(quote)) throw new Error('CORE_INVALID_OUTPUT');
  const templates = followUpLanguageTemplates(goal, quote), last = history.at(-1);
  const previousAttribution = attributions.find(attribution => last?.templateId.endsWith(`.${attribution.id}`));
  const candidates = previousAttribution ? templates.filter(template => !template.id.endsWith(`.${previousAttribution.id}`)) : templates;
  const template = selectNonRepeatingTemplate(candidates, seed, history)!;
  const text = `${template.before}${quote}${template.after}${template.request}`;
  return { text, quoteStartOffset: template.before.length, quoteEndOffset: template.before.length + quote.length,
    policyVersion: FOLLOW_UP_LANGUAGE_VERSION, templateId: template.id, family: template.family, goal };
}

// Saved approved follow-ups remain resumable; new generation uses only the policy above.
const legacyRequests: Record<FollowUpGoal, string> = {
  basis: '그 판단의 근거 한 가지는 무엇인가요?', choice: '그 선택의 기준 한 가지는 무엇인가요?',
  process: '실제로 거친 한 단계를 구체적으로 설명해 주세요.', own_action: '본인이 직접 한 행동 한 가지는 무엇인가요?',
  measurement: '그 값은 어떤 기준으로 확인한 것인가요?', comparison: '어떤 기준으로 차이를 확인했나요?',
  limit: '어디까지 해석할 수 있다고 보나요?', meaning: '그 표현의 의미를 구체적으로 설명해 주세요.',
  motive: '그 관심을 갖게 된 계기 한 가지는 무엇인가요?', result: '실제로 확인한 결과 한 가지는 무엇인가요?',
  alternative: '구체적으로 바꿀 한 가지는 무엇인가요?', connection: '말씀하신 연결 지점을 구체적으로 설명해 주세요.',
};
export function matchesConstrainedFollowUpTemplate(text: string, quote: string) {
  return followUpGoals.some(goal => text === `‘${quote}’라고 말씀하셨는데, ${legacyRequests[goal]}`
    || [...followUpLanguageTemplates(goal, quote), ...followUpLanguageTemplates(goal)].some(template => text === `${template.before}${quote}${template.after}${template.request}`));
}
