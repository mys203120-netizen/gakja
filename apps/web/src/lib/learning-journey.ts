export type JourneyItem = Record<string, any>;
export type TodayAction = { title: string; label: string; reason: string; href: string; questionId?: string; count?: number };

export function learningHref(path: string, context: { questionId?: string; memoryItemId?: string; activityId?: string; targetId?: string; mode?: string; sourceType?: 'personal'|'common'; sourceVersion?: string }) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(context)) if (value) params.set(key, value);
  params.set('flow', 'today');
  return `${path}${path.includes('?') ? '&' : '?'}${params.toString()}`;
}

/** Legacy concept records retain their own identity; only an explicit current mapping opens an interview question. */
export function resolveJourneyQuestion(id:string,candidates:JourneyItem[],memory:JourneyItem[],library:JourneyItem[],memoryItemId?:string) {
  const exact=candidates.find(q=>q.id===id);
  const item=memory.find(m=>m.id===(memoryItemId|| (id.startsWith('concept:')?id.slice(8):'')))||memory.find(m=>m.question_id===id);
  const practice=library.find(m=>m.id===item?.id);
  const current=item&&candidates.find(q=>q.id===item.question_id&&q.question_types?.includes('concept'));
  if(exact)return {question:exact,memoryItem:item,interviewQuestion:exact,sameQuestion:true};
  if(!id.startsWith('concept:')||!item||!practice)return null;
  const question={id,prompt:practice.practice_prompt||practice.prompt,activity_ids:item.activity_ids||[],support_target_ids:current?.support_target_ids||[]};
  const application=current||candidates.find(q=>q.activity_ids?.some((a:string)=>item.activity_ids?.includes(a)));
  return {question,memoryItem:item,interviewQuestion:application,sameQuestion:Boolean(current&&current.prompt===question.prompt)};
}

export function chooseTodayAction(input: { targets: JourneyItem[]; quiz?: JourneyItem | null; study?: JourneyItem | null; assignments?: JourneyItem[]; interviews?: JourneyItem[]; hasPackage: boolean; commonQuestions?: JourneyItem[] }): TodayAction {
  if (!input.targets.length) return { title: '지원 학교부터 골라볼까요?', label: '학교 등록하기', reason: '면접 안내를 보고 첫 질문을 연습해요.', href: '/schools/new' };
  const quiz = input.quiz;
  const unfinished = quiz?.sessions?.find((s: JourneyItem) => s.state === 'active' && Number(s.current_index) > 0 && Number(s.current_index) < Number(s.total));
  if (unfinished) return { title: '하던 연습을 이어가요.', label: '오늘 학습 이어서', reason: `${unfinished.topicLabel || unfinished.metadata?.topicLabel || '퀴즈'} · ${Number(unfinished.total) - Number(unfinished.current_index)}문항 남았어요.`, href: `/quiz/session/${encodeURIComponent(unfinished.id)}` };
  const recommendation = quiz?.recommendation;
  if (recommendation?.count > 0 && (recommendation.wrong > 0 || recommendation.due > 0)) return { title: '다시 떠올려 볼 시간이에요.', label: '오늘 학습 시작', reason: recommendation.reason || `${recommendation.count}문항을 다시 확인해요.`, href: '/my/today', count: recommendation.count };
  const assignment = input.assignments?.find(a => !['submitted','reviewed','completed','cancelled'].includes(a.state));
  if (assignment) return { title: assignment.title || '오늘의 과제', label: '오늘 학습 시작', reason: `${assignment.items?.length || 0}문항 · 배정된 과제`, href: `/quiz/assignments/${encodeURIComponent(assignment.id)}` };
  const next = input.study?.nextQuestion;
  if (next?.questionId && (!next.targetId||next.targetId===input.targets[0].id)) return { title: '이번엔 내 말로 답해봐요.', label: '오늘 학습 이어서', reason: next.prompt || '저장한 답을 면접에서 연습해요.', href: learningHref('/my/today', { questionId: next.questionId, memoryItemId:next.memoryItemId, targetId: input.targets[0].id }), questionId: next.questionId };
  if (recommendation?.count > 0) return { title: '오늘의 답을 꺼내봐요.', label: '오늘 학습 시작', reason: recommendation.reason || `${recommendation.count}문항부터 가볍게 시작해요.`, href: '/my/today', count: recommendation.count };
  const interview = input.interviews?.find(s => s.state === 'active');
  if (interview) return { title: '면접을 이어가요.', label: '오늘 학습 이어서', reason: '저장한 질문과 답변에서 계속해요.', href: `/interview/${encodeURIComponent(interview.id)}?kind=${interview.kind === 'video' ? 'video' : 'chat'}` };
  if (input.commonQuestions?.length) return { title: '첫 면접을 시작해요.', label: '오늘 학습 시작', reason: '공통 질문 한 개 · 생기부 없이 시작할 수 있어요.', href: learningHref('/interview/chat', { questionId: input.commonQuestions[0].id, targetId: input.targets[0].id }) + '&questionCount=1', questionId: input.commonQuestions[0].id, count: 1 };
  return { title: '면접 안내를 확인해요.', label: '학교 면접 안내', reason: '등록한 지원처에서 다음 준비를 찾아봐요.', href: `/schools/${encodeURIComponent(input.targets[0].id)}` };
}

/** A saved attempt is practice; only an explicit reviewed correct result is verification. */
export function verifiedMemoryQuestions(attempts: JourneyItem[], memory: JourneyItem[]) {
  const latest = new Map<string, JourneyItem>();
  for (const attempt of [...attempts].sort((a,b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)))) if (!latest.has(attempt.memory_item_id)) latest.set(attempt.memory_item_id, attempt);
  const approved=new Set(['verified','approved','confirmed','synthetic_reviewed','confirmed_from_record','confirmed_by_student']);
  return new Set([...latest.values()].filter(a => {
    const item=memory.find(m=>m.id===a.memory_item_id);
    return item && item.category!=='experiential' && approved.has(item.verification_status) && item.evaluation_method==='reviewed_correct_answer'
      && a.data?.correct===true && a.data?.hint_used!==true && a.data?.hintUsed!==true && a.data?.assisted!==true && a.data?.aiAssisted!==true;
  }).map(a=>memory.find(m=>m.id===a.memory_item_id)?.question_id).filter(Boolean));
}
