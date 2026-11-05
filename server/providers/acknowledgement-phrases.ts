import { selectNonRepeatingTemplate, type UtteranceHistoryItem } from './utterance-variation';

export const BRIDGE_POLICY_VERSION = 'interviewer-bridges-v3';
export type BridgeKind = 'topic' | 'neutral' | 'silence' | 'apology' | 'unclear' | 'transition' | 'off_topic_end' | 'stt_retry';
export interface BridgeTrace {
  policyVersion: typeof BRIDGE_POLICY_VERSION | 'interviewer-bridges-v2';
  kind: BridgeKind | 'follow_up' | 'unassessed';
  templateId: string | null;
  family: string | null;
  selection: 'seeded_shuffle' | 'suppressed';
  suppressionReason?: 'follow_up_direct' | 'no_topic_quote' | 'incomplete_topic_quote' | 'direct_transition' | 'technical_uncertainty' | 'unsafe_model_reply';
}
interface BridgeTemplate { id: string; family: string; text: (quote: string) => string | null }
const fixed = (id: string, family: string, text: string): BridgeTemplate => ({ id, family, text: () => text });
const direct = (id: string): BridgeTemplate => ({ id, family: 'direct', text: () => null });
/** The particle follows the actual quoted surface, never an inferred/paraphrased noun. */
function quoteParticle(quote: string): '이라고' | '라고' {
  const last = quote.trim().at(-1) ?? '';
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 ? '이라고' : '라고';
  return /[013678]$/u.test(last) ? '이라고' : '라고';
}

/** Common §§1,8,10 and question §§14,17: optional, short, non-evaluative speech acts only. */
const pools: Record<BridgeKind, readonly BridgeTemplate[]> = {
  neutral: [
    fixed('neutral-understood', 'neutral-receipt', '네, 알겠습니다.'),
    fixed('neutral-accepted', 'brief-acceptance', '알겠습니다.'),
    fixed('neutral-next', 'next-topic', '다음 주제로 이어가겠습니다.'),
    direct('neutral-direct'),
  ],
  topic: [
    { id: 'topic-quoted', family: 'quoted-echo', text: quote => `‘${quote}’${quoteParticle(quote)} 하셨군요.` },
    { id: 'topic-received', family: 'topic-received', text: quote => `네, ‘${quote}’ 말씀이군요.` },
    { id: 'topic-accepted', family: 'quote-receipt', text: quote => `‘${quote}’, 알겠습니다.` },
    direct('topic-direct'),
  ],
  silence: [
    fixed('silence-time', 'thinking-permission', '잠시 생각하셔도 괜찮습니다.'),
    fixed('silence-ready', 'answer-when-ready', '생각이 정리되면 말씀해 주세요.'),
    fixed('silence-more', 'more-time', '조금 더 생각하셔도 됩니다.'),
  ],
  apology: [
    fixed('apology-okay', 'brief-acceptance', '괜찮습니다.'),
    fixed('apology-steady', 'unhurried-answer', '천천히 말씀해 주세요.'),
    fixed('apology-again', 'answer-again', '다시 말씀해 주셔도 됩니다.'),
  ],
  unclear: [
    fixed('unclear-again', 'repeat-request', '다시 한번 말씀해 주세요.'),
    fixed('unclear-clearly', 'clarity-request', '조금 더 분명하게 말씀해 주세요.'),
    fixed('unclear-intent', 'meaning-request', '어떤 뜻인지 다시 말씀해 주세요.'),
  ],
  transition: [
    fixed('transition-topic', 'topic-transition', '다른 주제로 넘어가겠습니다.'),
    fixed('transition-next', 'next-topic', '다음 주제로 이어가겠습니다.'),
    fixed('transition-close', 'cluster-closing', '이 질문은 여기까지 하겠습니다.'),
    direct('transition-direct'),
  ],
  // MD8 §15(3), MD9 §16(4): this state requires an actual closing utterance.
  off_topic_end: [
    fixed('off-topic-end-question', 'close-question', '이 질문은 여기까지 하겠습니다.'),
    fixed('off-topic-end-topic', 'close-topic', '이 주제는 여기까지 하고, 다른 내용을 여쭙겠습니다.'),
    fixed('off-topic-end-next', 'close-and-move', '지금 질문은 마무리하고 다음 질문으로 이어가겠습니다.'),
  ],
  // A technical uncertainty is not evidence that the student spoke badly or gave no answer.
  stt_retry: [direct('stt-uncertain')],
};
/** The core chooses whether a bridge helps. The server never inserts a receipt
 * on every answer or converts one of these into an answer-quality judgment. */
export const approvedNeutralBridgeTexts = Object.freeze(pools.neutral.flatMap(template => {
  const text = template.text(''); return text ? [text] : [];
}));
const normalize = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim();
const maskQuote = (text: string) => normalize(text).replace(/‘[^‘’]*’/gu, '‘TOPIC’').replace('‘TOPIC’이라고', '‘TOPIC’라고');

export function isIncompleteTopicQuote(quote: string) {
  const text = normalize(quote);
  return !text || /(?:\s|^)(?:같은|어떤|이런|저런|그런|그리고|그래서|하지만|왜냐하면|예를\s*들면)$/u.test(text) || /(?:에서|으로|위해|통해|관해|대해|위한|얻은 뒤|했을 때|하기 위해)$/u.test(text);
}

export function topicBridgeTexts(quote: string): string[] {
  return pools.topic.flatMap(template => { const text = template.text(normalize(quote)); return text ? [text] : []; });
}

/** Recover family identity from a persisted spoken string even for a session without newer metadata. */
export function identifyBridgeText(text: string): UtteranceHistoryItem | null {
  const masked = maskQuote(text);
  for (const templates of Object.values(pools)) for (const template of templates) {
    const rendered = template.text('TOPIC');
    if (rendered && maskQuote(rendered) === masked) return { templateId: template.id, family: template.family };
  }
  return null;
}

export function suppressedBridge(kind: BridgeTrace['kind'], reason: NonNullable<BridgeTrace['suppressionReason']>): { text: null; trace: BridgeTrace } {
  return { text: null, trace: { policyVersion: BRIDGE_POLICY_VERSION, kind, templateId: null, family: null, selection: 'suppressed', suppressionReason: reason } };
}

export function selectBridge(input: { kind: BridgeKind; seed: string; quote?: string | null; history?: readonly UtteranceHistoryItem[]; previousTexts?: readonly string[] }): { text: string | null; trace: BridgeTrace } {
  if (input.kind === 'topic' && !input.quote) return suppressedBridge('topic', 'no_topic_quote');
  if (input.kind === 'topic' && isIncompleteTopicQuote(input.quote!)) return suppressedBridge('topic', 'incomplete_topic_quote');
  if (input.kind === 'stt_retry') return suppressedBridge('stt_retry', 'technical_uncertainty');
  const previousTexts = new Set((input.previousTexts ?? []).map(normalize));
  const unused = pools[input.kind].filter(template => { const text = template.text(normalize(input.quote ?? '')); return !text || !previousTexts.has(normalize(text)); });
  // Exhausting the phrase history cannot suppress a mandatory speech act.
  const available = input.kind === 'off_topic_end' && !unused.length ? pools.off_topic_end : unused;
  // A direct (silent) turn is a trace entry, but it is not a newly spoken
  // receipt. Keep avoiding the last audible family as well as the last trace
  // family, so selection does not propose text its receipt gate must reject.
  const lastSpoken = identifyBridgeText(input.previousTexts?.at(-1) ?? '');
  const otherSpokenFamily = available.filter(template => template.family !== lastSpoken?.family);
  const candidates = otherSpokenFamily.length ? otherSpokenFamily : available;
  const selected = selectNonRepeatingTemplate(candidates, `${BRIDGE_POLICY_VERSION}:${input.kind}:${input.seed}`, input.history);
  if (!selected) return suppressedBridge(input.kind, 'direct_transition');
  const text = selected.text(normalize(input.quote ?? ''));
  return { text, trace: { policyVersion: BRIDGE_POLICY_VERSION, kind: input.kind, templateId: selected.id, family: selected.family, selection: 'seeded_shuffle', ...(!text ? { suppressionReason: 'direct_transition' as const } : {}) } };
}
