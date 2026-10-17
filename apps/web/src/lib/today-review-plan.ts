type ReviewQuestion = {id:string;prompt?:string};
type ReviewContext = {targetId?:string;sourceType:'personal'|'common';sourceVersion?:string|number};

/** A concept's application question is an interview task, not a replacement quiz item. */
export function todayReviewPlan(input:{question:ReviewQuestion;application?:ReviewQuestion|null;hasRecall:boolean;context:ReviewContext;date:string}) {
  const quiz=input.hasRecall&&!input.question.id.startsWith('concept:')&&(!input.application||input.application.id===input.question.id);
  const question=quiz?input.question:input.application||input.question;
  // Concept-only IDs are not owned interview question sources in the planner.
  if(question.id.startsWith('concept:'))return null;
  const version=Number(input.context.sourceVersion);
  return {action:'create' as const,title:String(question.prompt||input.question.prompt||'질문 복습').slice(0,160),date:input.date,kind:quiz?'quiz' as const:'interview' as const,
    target:{kind:'question' as const,id:question.id,...(input.context.targetId?{targetId:input.context.targetId}:{}),sourceType:input.context.sourceType,
      ...(Number.isSafeInteger(version)&&version>0?{sourceVersion:version}:{})}};
}

export function matchesTodayReviewPlan(existing:Record<string,any>,planned:NonNullable<ReturnType<typeof todayReviewPlan>>) {
  return existing.date===planned.date&&existing.kind===planned.kind&&existing.target?.kind==='question'&&existing.target.id===planned.target.id
    && (existing.target.targetId||null)===(planned.target.targetId||null)&&existing.target.sourceType===planned.target.sourceType
    && (existing.target.sourceVersion??null)===(planned.target.sourceVersion??null);
}
