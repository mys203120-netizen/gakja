import {calendarPlanMovable,type CalendarPlan} from './calendar-edit';
import {availabilityMinutesForDate,type CurrentTrainingAvailability} from './training-availability';
import {hybridQuestionObservation,type HybridDeadline,type HybridQuestion} from './hybrid-training';
import {shiftPlanDay} from './planner-model';
import {reviewQuestionKey} from './training-review';
import type {CurriculumPolicy} from './curriculum-policy';
import {knowledgeTargetKey} from './knowledge-flow-model';
import {learningScopeIdentity} from './learning-target-scope';

export type ReviewPlacementPlan=CalendarPlan&{kind?:string};
export type ReviewPlacementCandidate={date:string;minutes:number;before:Array<{id:string;title:string;revision:number;area:string|null}>};
export type ReviewPlacementSuggestion={questionKey:string;questionId:string;title:string;reason:string;targetId:string;school:string;sourceType:'personal'|'common';sourceVersion:number;area:string;deadline:string|null;deadlineLabel:string;status:'ready'|'covered'|'blocked'|'paused';message:string;candidates:ReviewPlacementCandidate[];conflicts:Array<{date:string;reason:string}>;resolution?:{href:string;label:string}};
export type ReviewPlacementInput={today:string;availability:CurrentTrainingAvailability|null;policy:CurriculumPolicy;questions:HybridQuestion[];deadlines:HybridDeadline[];plans:ReviewPlacementPlan[];disabledTargets?:string[]};
export type ReviewPlacementPreview={label:string;questionKey:string;title:string;reason:string;school:string;area:string;sourceType:string;sourceVersion:number;deadline:string;deadlineLabel:string;date:string;minutes:number;before:ReviewPlacementCandidate['before'];after:Array<{title:string;kind:string;minutes:number;sequence:number;area:string}>;conflicts:ReviewPlacementSuggestion['conflicts']};
const active=(plan:ReviewPlacementPlan)=>plan.target?.automaticPractice?.status!=='superseded'&&plan.target?.automaticPractice?.hybrid?.kind!=='break';

/** A suggested area change is stricter than a student's explicit calendar move. */
export function reviewPlacementProtection(plan:ReviewPlacementPlan):string|null{
 if(!calendarPlanMovable(plan))return '진행·완료한 학습이 있어요.';
 if(!plan.target?.automaticPractice)return '직접 추가한 일정이 있어요.';
 if(plan.target.calendarPlacement?.operationId||plan.target.automaticPractice.hybrid?.studentOrderedAt)return '직접 날짜나 순서를 바꾼 일정이 있어요.';
 if(!plan.target.automaticPractice.hybrid?.kind||plan.target.automaticPractice.hybrid.kind==='assignment')return '받은 과제나 별도로 연결한 일정이 있어요.';
 return null;
}

/** Pure proposal: all dates are inspected, but no plans/preferences are written. */
export function reviewPlacementSuggestions(input:ReviewPlacementInput):ReviewPlacementSuggestion[]{
 const plans=input.plans.filter(active),groups=new Set<string>();
 const dueAt=(question:HybridQuestion)=>Math.max(0,...question.attempts.filter(attempt=>attempt.valid!==false).map(attempt=>Date.parse(attempt.at)||0))+(question.repetition?.intervalDays||1)*86400000;
 return input.questions.filter(question=>question.review?.needsReview||hybridQuestionObservation({...question,repetition:undefined},{},input.today).needsReview).sort((a,b)=>Number(a.repetition?.enabled===false)-Number(b.repetition?.enabled===false)||dueAt(a)-dueAt(b)||a.id.localeCompare(b.id)).flatMap(question=>{
  const group=JSON.stringify([question.targetId,question.targetKey,question.sourceType,question.sourceVersion,question.area,question.repetition?.enabled===false?'paused':'active']);
  if(groups.has(group))return [];groups.add(group);
  const deadline=input.deadlines.find(item=>item.targetId===question.targetId),area=question.area||'영역 확인 필요';
  const base:ReviewPlacementSuggestion={questionKey:reviewQuestionKey({...question,targetKey:question.targetKey||''}),questionId:question.id,title:question.title,reason:question.review?.reason||hybridQuestionObservation(question,{},input.today).reason,targetId:question.targetId,school:[deadline?.university,deadline?.department].filter(Boolean).join(' · '),sourceType:question.sourceType,sourceVersion:question.sourceVersion,area,deadline:deadline?.date||null,deadlineLabel:deadline?.label||'면접 일정',status:'blocked',message:'',candidates:[],conflicts:[]};
  const blocked=(message:string,href='/availability',label='학습 시간 설정'):ReviewPlacementSuggestion=>({...base,message,resolution:{href,label}});
  if(question.repetition?.enabled===false)return [{...blocked('이 질문의 반복 학습을 중지했어요. 설정을 유지하며 자동 편성을 제안하지 않아요.','/preparation','보완 질문과 반복 설정 확인'),status:'paused' as const}];
  if(input.disabledTargets?.includes(question.targetId))return [{...blocked('이 학교의 자동 계획을 중지했어요. 학교의 준비 계획을 다시 켜면 날짜를 제안해요.','/schools/'+encodeURIComponent(question.targetId),'학교 준비 계획 확인'),status:'paused' as const}];
  if(!question.area||question.area==='영역 확인 필요')return [blocked('활동의 학생부 영역이 확인되지 않아 다른 영역의 일정을 바꾸지 않아요.','/preparation','활동 영역 확인')];
  if(!deadline?.date||deadline.status!=='ready')return [blocked('미래의 면접일 또는 준비 목표를 먼저 확인해 주세요.','/schools/'+encodeURIComponent(question.targetId),'면접 일정 확인')];
  if(!input.availability)return [blocked('학습 가능한 시간을 등록하면 면접 전 보완 날짜를 찾을 수 있어요.')];
  const dates:string[]=[];
  for(let date=input.today;date<deadline.date&&dates.length<730;date=shiftPlanDay(date,1))dates.push(date);
  const due=(date:string)=>!question.repetition||hybridQuestionObservation(question,{},date).due||hybridQuestionObservation(question,{},date).unseen;
  const viable=dates.filter(date=>due(date)&&availabilityMinutesForDate(input.availability,date,input.today)>=input.policy.videoMinimumMinutes);
  // A pending video slot must match the school, source namespace/version and actual area.
  const covered=plans.find(plan=>viable.includes(plan.date)&&calendarPlanMovable(plan)&&plan.target?.targetId===question.targetId&&knowledgeTargetKey(learningScopeIdentity(plan.target?.targetSnapshot||{}))===question.targetKey&&plan.target?.sourceType===question.sourceType&&Number(plan.target?.sourceVersion)===question.sourceVersion&&plan.target?.automaticPractice?.hybrid?.area===area&&['focus','mixed','diagnostic','recall'].includes(plan.target?.automaticPractice?.hybrid?.kind));
  if(covered)return [{...base,status:'covered' as const,message:`${covered.date}에 같은 학교·자료 버전·영역의 화상 연습이 있어요.`}];
  if(!viable.length)return [blocked(`반복 간격을 지키면서 ${deadline.date} 전 화상 연습 ${input.policy.videoMinimumMinutes}분을 확보할 수 있는 날이 없어요. 학습 시간을 늘리거나 휴식일·반복 간격·준비 목표를 확인해 주세요.`)];
  for(const date of viable){
   const day=plans.filter(plan=>plan.date===date),reasons=[...new Set(day.map(reviewPlacementProtection).filter(Boolean))];
   if(reasons.length){base.conflicts.push({date,reason:reasons.join(' ')});continue;}
   // Replacing the complete untouched day preserves prerequisite order and prevents mixed areas.
   base.candidates.push({date,minutes:availabilityMinutesForDate(input.availability,date,input.today),before:day.sort((a,b)=>(a.target?.automaticPractice?.hybrid?.sequence||0)-(b.target?.automaticPractice?.hybrid?.sequence||0)||a.id.localeCompare(b.id)).map(plan=>({id:plan.id,title:plan.title,revision:plan.revision,area:plan.target?.automaticPractice?.hybrid?.area||null}))});
  }
  base.candidates.sort((a,b)=>Number(a.before.length>0)-Number(b.before.length>0)||a.date.localeCompare(b.date));
  if(!base.candidates.length)return [{...base,message:'가용일마다 보호된 일정이 있어 자동으로 영역을 바꿀 수 없어요. 다른 날의 학습 시간을 추가하거나 캘린더에서 직접 일정을 조정해 주세요.',resolution:{href:'/availability',label:'다른 날의 학습 시간 추가'}}];
  return [{...base,status:'ready' as const,message:'면접 전 같은 학교·자료 버전·영역의 날짜가 없어 보완 영역 편성을 제안해요. 적용하기 전에는 현재 일정을 유지해요.'}];
 });
}
