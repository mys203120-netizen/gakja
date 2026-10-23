import {planWeek,shiftPlanDay,validPlanDay} from './planner-model';

export type CalendarPlan={id:string;title:string;date:string;revision:number;completed?:boolean;performedAt?:unknown;locked?:boolean;target?:Record<string,any>|null};
export type CalendarEditRequest={ids?:string[];fromDate?:string;toDate:string;endDate?:string;mode:'move'|'merge'|'shift'|'spread'};
export type CalendarDateChange={id:string;title:string;from:string;to:string;revision:number};
export type CalendarEditPreview={changes:CalendarDateChange[];excluded:number;sourceDates:string[];label:string;mode:CalendarEditRequest['mode'];replacement?:{date:string;before:string[];after:string[]}};
export function calendarPlanMovable(plan:CalendarPlan){
 const automatic=plan.target?.automaticPractice;
 return !plan.completed&&!plan.performedAt&&!plan.locked&&automatic?.status!=='superseded'&&automatic?.hybrid?.kind!=='break'&&!automatic?.startedAt&&!automatic?.hybrid?.startedAt;
}
function distance(a:string,b:string){return Math.round((Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'))/86400000);}
/** Dates change independently; merging never deletes or combines learning records. */
export function previewCalendarEdit(plans:CalendarPlan[],request:CalendarEditRequest,today:string):CalendarEditPreview{
 if(!validPlanDay(request.toDate)||request.toDate<today)throw new Error('오늘 이후의 날짜로 배치해 주세요.');
 if(request.fromDate&&!validPlanDay(request.fromDate)||request.endDate&&!validPlanDay(request.endDate))throw new Error('변경할 날짜를 확인해 주세요.');
 if(!request.ids?.length&&!request.fromDate)throw new Error('이동할 계획을 선택해 주세요.');
 if(request.endDate&&(!request.fromDate||request.endDate<request.fromDate||distance(request.fromDate,request.endDate)>31))throw new Error('한 번에 31일 이내의 일정을 선택해 주세요.');
 const wanted=new Set(request.ids||[]);
 if(wanted.size>200||request.ids?.some(id=>!plans.some(plan=>plan.id===id)))throw new Error('현재 계획을 다시 불러와 선택해 주세요.');
 const source=plans.filter(plan=>wanted.size?wanted.has(plan.id):plan.date>=request.fromDate!&&plan.date<=(request.endDate||request.fromDate!));
 const movable=source.filter(calendarPlanMovable).sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
 if(!movable.length)throw new Error('이동할 미완료 계획이 없어요. 진행하거나 완료한 학습은 그대로 보관해요.');
 if(movable.length>200)throw new Error('한 번에 200개 이내의 계획을 선택해 주세요.');
 const first=request.fromDate||movable[0].date,offset=distance(first,request.toDate),ids=new Set(movable.map(plan=>plan.id));
 const changed=new Map<string,CalendarDateChange>();
 for(let index=0;index<movable.length;index++){
  const plan=movable[index],to=request.mode==='merge'?request.toDate:request.mode==='spread'?shiftPlanDay(request.toDate,index):shiftPlanDay(plan.date,offset);
  if(!validPlanDay(to)||to<today)throw new Error('오늘 이후의 날짜로 배치해 주세요.');
  if(to!==plan.date)changed.set(plan.id,{id:plan.id,title:plan.title,from:plan.date,to,revision:plan.revision});
 }
 if(request.mode==='shift'){
  // The occupied destination and following days move as a block, preserving their order.
  const destinations=[...changed.values()].map(change=>change.to).sort();
  if(destinations.length){
   const start=destinations[0],days=distance(start,destinations[destinations.length-1])+1;
   for(const plan of plans){
    if(ids.has(plan.id)||!calendarPlanMovable(plan)||plan.date<start)continue;
    const to=shiftPlanDay(plan.date,days);if(!validPlanDay(to))throw new Error('배치 가능한 날짜 범위를 벗어났어요.');
    changed.set(plan.id,{id:plan.id,title:plan.title,from:plan.date,to,revision:plan.revision});
   }
  }
 }
 if(changed.size>200)throw new Error('밀리는 일정이 많아요. 날짜 범위를 줄여서 변경해 주세요.');
 if(!changed.size)throw new Error('이미 선택한 날짜에 배치되어 있어요.');
 const changes=[...changed.values()].sort((a,b)=>a.from.localeCompare(b.from)||a.id.localeCompare(b.id));
 return {changes,excluded:source.length-movable.length,sourceDates:[...new Set(movable.map(plan=>plan.date))],label:request.mode==='spread'?'계획 나눠 배치':request.mode==='shift'?'기존 일정 밀어 배치':request.mode==='merge'?'같은 날에 모으기':'일정 이동',mode:request.mode};
}

/** A deliberately bounded grammar produces a preview, never an unchecked AI mutation. */
export function calendarRequestFromText(text:string,today:string):CalendarEditRequest{
 const input=text.trim().replace(/\s+/g,'');
 if(!input||input.length>300)throw new Error('변경할 일정과 날짜를 짧게 적어 주세요.');
 const dayTerms:Record<string,string>={'오늘':today,'내일':shiftPlanDay(today,1),'모레':shiftPlanDay(today,2),'어제':shiftPlanDay(today,-1)};
 const weekTerms:Record<string,string[]>={'이번주':planWeek(today),'다음주':planWeek(shiftPlanDay(today,7)),'다다음주':planWeek(shiftPlanDay(today,14))};
 const matched=input.match(/^(오늘|내일|모레|어제|이번주|다음주)(?:의)?(?:일정|계획)(?:은|을|는|이)?(오늘|내일|모레|이번주|다음주|다다음주)(?:로|으로)(?:미뤄|옮겨|이동|보내|변경|배치)(?:줘|주세요|해줘|해주세요|해|해요|해줄래|해줄래요)?[.!?。]*$/);
 if(matched){
  const from=matched[1],to=matched[2],source=weekTerms[from];
  if(source&&!weekTerms[to])throw new Error('주간 일정은 다음 주처럼 주 단위로 옮겨 주세요.');
  return {fromDate:source?source[0]:dayTerms[from],...(source?{endDate:source[6]}:{}),toDate:weekTerms[to]?.[0]||dayTerms[to],mode:'move'};
 }
 const byDays=input.match(/^(오늘|내일|이번주|다음주)(?:의)?(?:일정|계획)(?:은|을|는|이)?(\d{1,2})일(?:만큼)?(?:뒤로)?(?:미뤄|옮겨)(?:줘|주세요|해줘|해주세요|해|해요)?[.!?。]*$/);
 if(byDays){const source=weekTerms[byDays[1]],from=source?.[0]||dayTerms[byDays[1]],offset=Number(byDays[2]);if(offset<1||offset>31)throw new Error('1일에서 31일 사이로 옮겨 주세요.');return {fromDate:from,...(source?{endDate:source[6]}:{}),toDate:shiftPlanDay(from,offset),mode:'move'};}
 const dated=input.match(/^(\d{1,2})월(\d{1,2})일(?:의)?(?:일정|계획)(?:은|을|는|이)?(\d{1,2})월(\d{1,2})일(?:로|으로)(?:미뤄|옮겨|이동|변경|배치)(?:줘|주세요|해줘|해주세요|해|해요)?[.!?。]*$/);
 if(dated){const year=today.slice(0,4),fromDate=`${year}-${dated[1].padStart(2,'0')}-${dated[2].padStart(2,'0')}`,toDate=`${year}-${dated[3].padStart(2,'0')}-${dated[4].padStart(2,'0')}`;if(validPlanDay(fromDate)&&validPlanDay(toDate))return {fromDate,toDate,mode:'move'};}
 throw new Error('예: “오늘 일정은 내일로 미뤄줘” 또는 “이번 주 일정을 다음 주로 미뤄줘”.');
}
