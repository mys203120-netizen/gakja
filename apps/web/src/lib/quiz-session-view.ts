export type RecallStatus = 'remembered' | 'uncertain' | 'needs_confirmation' | 'unchecked';

export function recallRating(status: RecallStatus): 'again' | 'hard' | 'good' {
  return status === 'remembered' ? 'good' : status === 'unchecked' ? 'hard' : 'again';
}

export function quizResponseNeedsReview(response: Record<string, any>): boolean {
  if (response.outcome === false || response.timed_out || response.rating === 'again') return true;
  if (response.outcome === true) return false;
  const status = response.data?.recall_state ?? response.data?.recallStatus;
  return status !== 'remembered';
}

export function quizAssistanceLabel(response: Record<string, any>): string {
  const facts = response.data || {};
  const names: Record<string, string> = { evidence: '근거 확인', ai: 'AI 도움', ai_partial: 'AI 도움 일부 확인', hint: '힌트 사용', video: '영상 확인', writing:'작성 도움' };
  const kinds = Array.isArray(facts.helpKinds) ? facts.helpKinds : Array.isArray(facts.help_kinds) ? facts.help_kinds : [];
  const labels = [...new Set<string>(kinds.map((kind: string) => names[kind]).filter(Boolean))];
  if (response.hint_used && !labels.includes(names.hint)) labels.push(names.hint);
  if (facts.assisted && !labels.length) labels.push('도움 사용');
  if (labels.length) return labels.join(' · ');
  return facts.assistance_recorded === true || facts.assistanceRecorded === true ? '' : '도움 기록 미확인';
}

export function savedQuizSubmission(responses: Record<string, any>[], request: Record<string, any>): Record<string, any> | undefined {
  return responses.find(response => response.item_index === request.itemIndex && (response.data?.requestId === request.requestId || response.data?.request_id === request.requestId));
}
