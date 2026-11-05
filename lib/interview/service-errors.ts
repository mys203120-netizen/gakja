/** Public service copy is deliberately separate from masked, private provider diagnostics. */
export type InterviewServiceStage = 'connection' | 'speech' | 'question' | 'evaluation' | 'storage';
const messages: Record<InterviewServiceStage, string> = {
  connection: '연결에 문제가 생겼어요. 잠시 후 다시 시도해 주세요.',
  speech: '음성 연결에 문제가 생겼어요. 잠시 후 다시 시도해 주세요.',
  question: '다음 질문을 준비하지 못했어요. 잠시 후 다시 시도해 주세요.',
  evaluation: '평가 결과를 준비하지 못했어요. 잠시 후 다시 시도해 주세요.',
  storage: '면접 기록을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.',
};
export function publicServiceError(stage: InterviewServiceStage = 'connection') { return messages[stage]; }

/** Also contain diagnostic strings from an older server or a native browser rejection. */
export function serviceDisplayMessage(error: unknown, stage: InterviewServiceStage = 'connection') {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  if (/clova|naveropenapi|ntruss|grpc|ECONN\w*|UNAVAILABLE|DEADLINE_EXCEEDED|STT_ERROR/iu.test(message)) return messages.speech;
  if (/INVALID_REACTION|UNVERIFIED_REACTION|NO_FINAL_ANSWER|PLAN_MISMATCH|CITATION_NOT_FOUND|OPENAI|sk-[a-z0-9_-]+|\b(?:401|403|429|502|503)\b|https?:\/\/|\b(?:TypeError|SyntaxError|APIError|stack|fetch failed|Failed to fetch)\b/iu.test(message)) return messages[stage];
  // Existing application-authored Korean guidance (permissions, retry, fullscreen) stays useful.
  return /^[가-힣‘“]/u.test(message) && message.length <= 320 ? message : messages[stage];
}
