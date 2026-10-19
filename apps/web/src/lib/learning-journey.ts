import {recordMatchesCurrentTarget,interviewMatchesLearningTarget} from './learning-target-scope';
export type JourneyItem = Record<string, any>;
export type TodayAction = { title: string; label: string; reason: string; href: string; questionId?: string; count?: number; resume?: 'quiz'|'interview' };
export type QuizDraftActivity={sessionId:string;itemIndex:number;updatedAt?:string;hasDraft:boolean};

/** Read only a server-listed session's current item, under the current student's key. */
export function localQuizDraftActivity(studentId:string,sessions:JourneyItem[],stores:Array<Pick<Storage,'getItem'>>):QuizDraftActivity[]{
  return sessions.filter(session=>session.student_id===studentId).flatMap(session=>{
    const index=Number(session.current_index),key=`gakja-quiz:${studentId}:${session.id}:${index}`;
    if(!Number.isInteger(index)||index<0)return [];
    let hasDraft=false,updatedAt:string|undefined;
    for(const storage of stores)try{
      hasDraft ||= Boolean(storage.getItem(key)?.trim());
      const activity=JSON.parse(storage.getItem(`gakja-quiz-activity:${studentId}:${session.id}`)||'null');
      hasDraft ||= activity?.itemIndex===index&&activity?.hasDraft===true&&activity?.hasRecording===true;
      if(activity?.itemIndex===index&&activity.hasDraft===true&&Number.isFinite(Date.parse(activity.updatedAt))&&(!updatedAt||Date.parse(activity.updatedAt)>Date.parse(updatedAt)))updatedAt=activity.updatedAt;
    }catch{/* An unavailable browser store must not hide server drafts. */}
    return hasDraft?[{sessionId:session.id,itemIndex:index,hasDraft,updatedAt}]:[];
  });
}

export function resumableQuizSessions(input:{studentId?:string;targets:JourneyItem[];sessions:JourneyItem[];localDrafts?:QuizDraftActivity[]}){
  return input.sessions.flatMap<JourneyItem&{hasDraft:boolean;recent:number}>(session=>{
    const index=Number(session.current_index),total=Number(session.total);
    const targetId=session.metadata?.targetId||session.metadata?.target_id||session.metadata?.targetSnapshot?.id;
    const scoped=recordMatchesCurrentTarget({targetId,targetSnapshot:session.metadata?.targetSnapshot},input.targets);
    if(!scoped||input.studentId&&session.student_id!==input.studentId||!['active','paused','ready'].includes(session.state)||!Number.isInteger(index)||index<0||index>=total)return [];
    const remote=session.metadata?.drafts?.[String(index)],remoteText=typeof remote==='string'?remote:remote?.response;
    const local=input.localDrafts?.find(draft=>draft.sessionId===session.id&&draft.itemIndex===index&&draft.hasDraft);
    const hasDraft=Boolean(String(remoteText||'').trim()||local);
    if(!index&&!hasDraft)return [];
    const recent=Math.max(...[session.updated_at,remote?.updatedAt,local?.updatedAt,session.created_at].map(value=>Date.parse(String(value||''))).filter(Number.isFinite),0);
    return [{...session,hasDraft,recent}];
  }).sort((a,b)=>b.recent-a.recent||String(b.id).localeCompare(String(a.id)));
}

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

export function chooseTodayAction(input: { studentId?:string; localDrafts?:QuizDraftActivity[]; targets: JourneyItem[]; quiz?: JourneyItem | null; study?: JourneyItem | null; assignments?: JourneyItem[]; interviews?: JourneyItem[]; hasPackage: boolean; commonQuestions?: JourneyItem[] }): TodayAction {
  if (!input.targets.length) return { title: '질문 한 개로 가볍게 시작해요.', label: '3분 · 첫 질문 답해보기', reason: '공통 질문 한 개 · 학교와 자료는 나중에 연결해도 돼요.', href: '/start' };
  const quiz = input.quiz;
  const unfinished = resumableQuizSessions({studentId:input.studentId,targets:input.targets,sessions:quiz?.sessions||[],localDrafts:input.localDrafts})[0];
  if (unfinished) return { title: unfinished.hasDraft?'작성 중인 답변을 이어가요.':unfinished.state==='ready'?'저장한 답의 확인을 이어가요.':'하던 연습을 이어가요.', label: '이어서 답하기', reason: `${unfinished.topicLabel || unfinished.metadata?.topicLabel || '퀴즈'} · ${unfinished.hasDraft?'작성 중인 답변 1개':`${Number(unfinished.total) - Number(unfinished.current_index)}문항 남았어요.`}`, href: `/quiz/session/${encodeURIComponent(unfinished.id)}`,resume:'quiz' };
  const interview = input.interviews?.find(s => s.state === 'active' && interviewMatchesLearningTarget(s,input.targets[0]));
  if (interview) return { title: '면접을 이어가요.', label: '면접 이어가기', reason: '저장한 질문과 답변에서 계속해요.', href: `/interview/${encodeURIComponent(interview.id)}?kind=${interview.kind === 'video' ? 'video' : 'chat'}`,resume:'interview' };
  const recommendation = quiz?.recommendation;
  if (recommendation?.count > 0 && (recommendation.wrong > 0 || recommendation.due > 0)) return { title: '다시 떠올려 볼 시간이에요.', label: '오늘 학습 시작', reason: recommendation.reason || `${recommendation.count}문항을 다시 확인해요.`, href: '/my/today', count: recommendation.count };
  const assignment = input.assignments?.find(a => !['submitted','reviewed','completed','cancelled'].includes(a.state));
  if (assignment) return { title: assignment.title || '오늘의 과제', label: '오늘 학습 시작', reason: `${assignment.items?.length || 0}문항 · 배정된 과제`, href: `/quiz/assignments/${encodeURIComponent(assignment.id)}` };
  const next = input.study?.nextQuestion;
  if (next?.questionId && recordMatchesCurrentTarget(next,[input.targets[0]])) return { title: '이번엔 내 말로 답해봐요.', label: '오늘 학습 이어서', reason: next.prompt || '저장한 답을 면접에서 연습해요.', href: learningHref('/my/today', { questionId: next.questionId, memoryItemId:next.memoryItemId, targetId: input.targets[0].id }), questionId: next.questionId };
  if (recommendation?.count > 0) return { title: '오늘의 답을 꺼내봐요.', label: '오늘 학습 시작', reason: recommendation.reason || `${recommendation.count}문항부터 가볍게 시작해요.`, href: '/my/today', count: recommendation.count };
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
