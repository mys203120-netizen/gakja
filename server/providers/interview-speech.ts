import { QuestionValidationError } from "./question-grounding";
import { identifyBridgeText, isIncompleteTopicQuote, topicBridgeTexts } from './acknowledgement-phrases';

const forbiddenSpeech = /훌륭|좋은\s*답변|정답입니다|뛰어나|잘하셨|합격|점수|불안해|거짓말|자신감이\s*부족|왜\s*못|틀렸/u;
const normalize = (value: string) => value.normalize("NFC").replace(/\s+/gu, " ").trim();

export interface TranscriptSpan { start: number; end: number; surface: string }
const transcriptWords = new Intl.Segmenter('ko', { granularity: 'word' });
/** Formatting integrity only: do not approve a proof whose start or end cuts
 * through a source word. There is no interpretation, correction, expansion or
 * clipping of the model's chosen quote. */
export function isWholeWordTranscriptSpan(raw: string, span: Pick<TranscriptSpan, 'start' | 'end'>) {
  if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end > raw.length || span.start >= span.end) return false;
  for (const word of transcriptWords.segment(raw)) {
    if (!word.isWordLike) continue;
    const end = word.index + word.segment.length;
    if (word.index < span.start && span.start < end || word.index < span.end && span.end < end) return false;
  }
  return true;
}
/** NFC and whitespace folding only. Offsets always point into the untouched transcript. */
export function findTranscriptSpan(raw: string, proposed: string): TranscriptSpan | null {
  const candidate = normalize(proposed);
  if (!candidate) return null;
  const units: Array<{ character: string; start: number; end: number }> = [];
  for (const part of new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(raw)) {
    for (const character of part.segment.normalize("NFC")) {
      const folded = /\s/u.test(character) ? " " : character;
      const previous = units.at(-1);
      if (folded === " " && previous?.character === " ") previous.end = part.index + part.segment.length;
      else units.push({ character: folded, start: part.index, end: part.index + part.segment.length });
    }
  }
  const letters = [...candidate];
  for (let index = 0; index + letters.length <= units.length; index++) {
    if (letters.some((character, offset) => units[index + offset].character !== character)) continue;
    const start = units[index].start, end = units[index + letters.length - 1].end;
    if ((units[index - 1]?.end ?? 0) > start || (units[index + letters.length]?.start ?? raw.length) < end) continue;
    return { start, end, surface: raw.slice(start, end) };
  }
  return null;
}

export function assertInterviewQuestionSpeech(text: string, options: { isFirstTurn?: boolean; semanticTaskCount?: boolean } = {}) {
  // Words such as 합격/점수/틀렸 can be part of a student's attributed claim
  // or a legitimate hypothetical. The core policy and factual-premise review
  // own that distinction; a bare-word blacklist is not a meaning judge.
  const speech = normalize(text);
  if (/(?:확인해|짚어|살펴)\s*보겠습니다/u.test(speech)) throw new QuestionValidationError("FORBIDDEN_SPEECH");
  if (options.isFirstTurn === false && /안녕(?:하세요|하십니까)|반갑습니다|처음\s*뵙겠습니다|다시\s*인사|저는.{0,15}면접관/u.test(speech)) throw new QuestionValidationError("FORBIDDEN_SPEECH");
  const sentences = speech.split(/[.!?。]/u).map(sentence => sentence.trim());
  const hasAnnouncement = sentences.some(sentence => {
    const simplified = sentence.replace(/\s+/gu, "");
    const interviewProcess = /질문|여쭤|여쭈어|물어|면접/u.test(simplified) || /(?:학생부|생활기록부|활동).*(?:부터|대해|관해)/u.test(simplified);
    return interviewProcess && /(?:드리겠습니다|하겠습니다|보겠습니다|묻겠습니다|드릴게요|할게요|볼게요|해보죠|들어보겠습니다|드리도록하겠습니다|드리려고합니다)$/u.test(simplified);
  });
  if (hasAnnouncement) throw new QuestionValidationError("FORBIDDEN_SPEECH");
  if ((speech.match(/[?？]/gu) ?? []).length > 1 || options.semanticTaskCount !== false && (speech.match(/(?:설명해|말씀해|알려)\s*주(?:세요|시겠|십시오)/gu) ?? []).length > 1) throw new QuestionValidationError("MULTIPLE_QUESTIONS");
}

const acknowledgementPrefix = /^(?:네[,，]?\s*)?(?:(?:방금|앞서)\s*)?(?:(?:말씀하신|말씀해\s*주신|언급하신)\s*)?$/u;
// Only neutral speech acts surround the quoted topic. No free-standing new factual clause is accepted.
const acknowledgementSuffix = /^(?:에\s*(?:대한|관한)\s*(?:설명|말씀)(?:을\s*들었습니다|이군요|이었군요)|(?:을|를)\s*언급(?:하셨군요|해\s*주셨군요)|(?:와|과)\s*관련된\s*말씀이군요|(?:라는|이라고\s*하신)\s*부분이군요)[.!。]?$/u;
const contentUnavailable = /^(?:네|아니요|어|음|어어|음음|저|저기|그|잘\s*모르겠습니다|모르겠습니다|기억(?:이)?\s*나지\s*않습니다|모르겠어요|잘\s*모르겠어요|생각이\s*안\s*납니다)(?:[\s,.!?。]|어|음)*$/u;

/** Keep the model's short sentence only when its topic and every surrounding speech act are safe. */
export function verifyAcknowledgement(rawAnswer: string, quote: string | null, proposed: string | null, previous: string[] = [], options: { semanticGrounding?: 'single_core' } = {}) {
  const coreGrounded = options.semanticGrounding === 'single_core';
  if (!quote || !proposed || !rawAnswer.trim() || !coreGrounded && contentUnavailable.test(normalize(rawAnswer))) return null;
  const topic = normalize(quote), sentence = normalize(proposed);
  // Optional core speech has a complete-sentence output contract. Drop a
  // truncated surface without retrying the decision or changing its meaning.
  if (coreGrounded && !/[.!。！]$/u.test(sentence)) return null;
  if (!coreGrounded && isIncompleteTopicQuote(topic)) return null;
  if (topic.length < 2 || topic.length > 28 || /[\r\n]/u.test(quote)) return null;
  // In a core decision, quote is an exact evidence span, not a topic that will
  // be read aloud. Punctuation and word count do not invalidate that proof.
  if (!coreGrounded && (topic.split(" ").length > 6 || /[“”‘’"'!?。;:]|(?<!\d)\.|\.(?!\d)/u.test(quote) || forbiddenSpeech.test(topic))) return null;
  const span = findTranscriptSpan(rawAnswer, quote);
  if (coreGrounded && span && !isWholeWordTranscriptSpan(rawAnswer, span)) return null;
  if (!span || sentence.length > 76 || /[\r\n?？]/u.test(proposed) || forbiddenSpeech.test(sentence) || /잘\s*들었습니다|안녕하세요|안녕하십니까|반갑습니다|(?:확인해|짚어|살펴)\s*보겠습니다/u.test(sentence)) return null;
  const at = sentence.indexOf(topic);
  if (!coreGrounded && (at < 0 || sentence.indexOf(topic, at + topic.length) >= 0)) return null;
  const clean = (value: string) => value.replace(/[“”‘’"']/gu, "").trim();
  const serverTemplate = topicBridgeTexts(topic).some(text => normalize(text) === sentence);
  if (!coreGrounded && !serverTemplate && (!acknowledgementPrefix.test(clean(sentence.slice(0, at))) || !acknowledgementSuffix.test(clean(sentence.slice(at + topic.length))))) return null;
  // Paraphrase grounding is part of the same core decision. The server checks
  // source integrity and one short utterance, never classifies that meaning a
  // second time. Legacy independent reaction callers keep their bounded gate.
  if (previous.some(text => normalize(text) === sentence)) return null;
  const family = identifyBridgeText(sentence)?.family;
  if (family && identifyBridgeText(previous.at(-1) ?? '')?.family === family) return null;
  return { text: proposed.trim(), quote: span.surface, span };
}

export function groundedAcknowledgement(rawAnswer: string, quote: string | null, proposed: string | null = null, previous: string[] = []) {
  return verifyAcknowledgement(rawAnswer, quote, proposed, previous)?.text ?? null;
}
