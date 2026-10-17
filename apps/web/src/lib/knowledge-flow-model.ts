import type { KnowledgeMatch, KnowledgeQuestion } from './knowledge-bites-catalog';

/** PostgreSQL jsonb can reorder object keys; identity is the data, not serialization order. */
export function knowledgeTargetKey(value?:Record<string,unknown>|null):string {
  function canonical(item:unknown):unknown {if(Array.isArray(item))return item.map(canonical);if(item&&typeof item==='object')return Object.fromEntries(Object.entries(item).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,canonical(v)]));return item;}
  return JSON.stringify(canonical(value || null));
}

/** Common links are explicit official-profile/question identities; personal links require actual activities. */
export function connectKnowledgeQuestions(videos: KnowledgeMatch[], questions: KnowledgeQuestion[], requested?: string | null) {
  const connected = videos.map(video => {
    const activities = new Set(video.current ? video.activities.map(item => item.id) : []);
    const relatedQuestions = questions.filter(question => video.current && (question.sourceKind === 'common' ? (video.relatedQuestionIds || []).includes(question.id) && question.targetId === video.targetId : question.activityIds.some(id => activities.has(id))))
      .sort((a, b) => Number(b.id === requested) - Number(a.id === requested) || Number(Boolean(b.needsReview)) - Number(Boolean(a.needsReview)));
    const requestedMatch = relatedQuestions.some(question => question.id === requested);
    const needsReview = relatedQuestions.some(question => question.needsReview);
    return { ...video, relatedQuestions, recommendedReason: requestedMatch ? '방금 연습한 질문과 연결돼요' : needsReview ? '다시 확인할 질문의 활동이에요' : '' };
  });
  const priority = (video: typeof connected[number]) => video.relatedQuestions.some(question => question.id === requested) ? 3 : video.relatedQuestions.some(question => question.needsReview) ? 2 : video.current ? 1 : 0;
  connected.sort((a, b) => priority(b) - priority(a));
  const result: typeof connected = [];
  const buckets = new Map<string, typeof connected>();
  for (const video of connected) {
    const key = video.focus || video.topic;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(video);
  }
  // The strongest actual question/weak-point anchors the first recommendation.
  // Alternate all available subject lenses, preserving priority inside each lens;
  // a cluster of weak science questions must not hide the rest of the record.
  while ([...buckets.values()].some(items => items.length)) {
    for (const items of buckets.values()) if (items.length) result.push(items.shift()!);
  }
  return result;
}

export function knowledgeCheckPrompt(topic: string, question?: KnowledgeQuestion | null) {
  if(question?.sourceSnapshot?.kind==='department_learning')return '개념의 뜻과 근거를 설명하고, 지원 학과와 연결한 예시·한계를 말해 보세요. 실제 경험과 앞으로 탐구할 계획을 구분해 주세요.';
  return question ? question.sourceKind === 'common' ? '배운 개념을 위 질문에 어떻게 활용할 수 있나요? 학교의 가치와 실제 경험을 연결하거나, 앞으로 실천할 방법을 말해 보세요.' : '배운 개념을 위 질문에 어떻게 활용할 수 있나요? 내 활동의 근거와 연결해 보세요.' : `${topic}에서 기억할 개념 하나와 아직 확인할 점을 내 말로 설명해 보세요.`;
}
