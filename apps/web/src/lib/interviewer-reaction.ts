/** A character's coaching response, never an admissions or student-ability score. */
export const REACTION_VERSION = 'submitted-answer-v1';
export const REACTION_SIGNALS = ['attentive', 'encouraging', 'clarify', 'off_topic', 'incoherent', 'uncertain'] as const;
export type ReactionSignal = typeof REACTION_SIGNALS[number];
export type InterviewerReaction = {
  level: number;
  signal: ReactionSignal;
  status: 'evaluated' | 'not_evaluated' | 'unavailable' | 'invalidated';
  evidence: string;
  reason: string;
  version: typeof REACTION_VERSION;
  timing: 'after_submission';
};
export type ReactionInput = { question: string; answer: string; transcriptUncertain?: boolean };

export const reactionSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    engagement: { type: 'integer', minimum: 0, maximum: 100 },
    signal: { type: 'string', enum: [...REACTION_SIGNALS] },
    confidence: { type: 'string', enum: ['high', 'low'] },
    evidence: { type: 'string' }, reason: { type: 'string' },
  },
  required: ['engagement', 'signal', 'confidence', 'evidence', 'reason'],
};

export const REACTION_INSTRUCTIONS = `reaction은 직전 질문과 실제 제출 답변의 의미 관계에 근거한 가상 면접관의 호응 표현이다. 합격 가능성·학생 실력·성격·정직성 점수가 아니다.
질문에 직접 답하고 구체적 근거가 연결되면 attentive 또는 encouraging, 주장과 근거의 연결에 추가 설명이 필요하면 clarify, 질문과 무관한 내용을 분명히 말하면 off_topic, 문장들의 의미 연결이 없어 답변 의미를 확인할 수 없으면 incoherent를 사용한다.
낯선 표현·짧은 답변·비속어·키워드 유무만으로 부정적 반응을 만들지 않는다. 사실이 낯설다는 이유로 터무니없는 답변이라고 단정하지 않는다. 전사 오류 가능성·학생의 기록 정정·판단 불확실성이 있으면 uncertain과 confidence=low를 사용한다.
evidence에는 반응의 근거가 된 학생 답변의 연속된 원문 일부만 그대로 인용한다. 설명은 reason에 한국어 한 문장으로 짧게 쓴다. 근거가 없으면 evidence는 빈 문자열, signal은 uncertain, confidence는 low, engagement는 50이다.
engagement는 캐릭터의 표정 강도이며 5 단위로 정한다. attentive는 50~70, encouraging는 65~100, clarify는 35~60, off_topic 또는 incoherent는 0~40, uncertain은 50이다. 분노·조롱·모욕을 표현하지 않는다.`;

export function quantizeReactionLevel(value: number) {
  return Number.isFinite(value) ? Math.round(Math.max(0, Math.min(100, value)) / 5) * 5 : 50;
}

export function neutralReaction(status: InterviewerReaction['status'] = 'not_evaluated'): InterviewerReaction {
  return { level: 50, signal: 'uncertain', status, evidence: '', reason: '', version: REACTION_VERSION, timing: 'after_submission' };
}

/** Semantic assessment comes only from a structured coach response, not a keyword/length rule. */
export function validateInterviewerReaction(raw: unknown, input: ReactionInput): InterviewerReaction {
  if (!input.question.trim() || !input.answer.trim() || input.transcriptUncertain) return neutralReaction('unavailable');
  if (!raw || typeof raw !== 'object') return neutralReaction('unavailable');
  const value = raw as Record<string, unknown>;
  if (value.confidence !== 'high' || !REACTION_SIGNALS.includes(value.signal as ReactionSignal) || value.signal === 'uncertain') return neutralReaction('unavailable');
  if (typeof value.engagement !== 'number' || !Number.isInteger(value.engagement) || value.engagement < 0 || value.engagement > 100) return neutralReaction('unavailable');
  if (typeof value.evidence !== 'string' || typeof value.reason !== 'string') return neutralReaction('unavailable');
  const evidence = value.evidence.trim(); const reason = value.reason.trim();
  if (evidence.length < Math.min(3, input.answer.trim().length) || evidence.length > 800 || !input.answer.includes(evidence) || !reason || reason.length > 500) return neutralReaction('unavailable');
  const ranges: Record<ReactionSignal, [number, number]> = { attentive: [50, 70], encouraging: [65, 100], clarify: [35, 60], off_topic: [0, 40], incoherent: [0, 40], uncertain: [50, 50] };
  const signal = value.signal as ReactionSignal; const [min, max] = ranges[signal];
  if (value.engagement < min || value.engagement > max) return neutralReaction('unavailable');
  return { level: quantizeReactionLevel(value.engagement), signal, status: 'evaluated', evidence, reason, version: REACTION_VERSION, timing: 'after_submission' };
}

export function reactionLabel(reaction?: InterviewerReaction | null) {
  if (!reaction || reaction.status !== 'evaluated') return '차분히 듣고 있어요';
  return { attentive: '집중하고 있어요', encouraging: '고개를 끄덕여요', clarify: '조금 더 궁금해요', off_topic: '질문으로 돌아가 볼까요?', incoherent: '다시 연결해 볼까요?', uncertain: '차분히 듣고 있어요' }[reaction.signal];
}

/** Existing face geometry with small, non-hostile expression changes at 21 possible levels. */
export function reactionFace(reaction?: InterviewerReaction | null) {
  const level = reaction?.status === 'evaluated' ? quantizeReactionLevel(reaction.level) : 50;
  const warmth = (level - 50) / 50;
  const curious = reaction?.status === 'evaluated' && ['clarify', 'off_topic', 'incoherent'].includes(reaction.signal);
  return {
    level, mouthCurve: 2 + Math.max(0, warmth) * 7,
    browY: 65 - Math.abs(warmth) * 2,
    browTilt: curious ? -2 - Math.abs(warmth) * 2 : -Math.max(0, warmth),
    headTilt: curious ? -2 - Math.abs(warmth) * 3 : Math.max(0, warmth) * 2,
    eyeWidth: 4 + (curious ? Math.abs(warmth) : 0),
  };
}
