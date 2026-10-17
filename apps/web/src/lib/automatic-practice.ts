import {koreaToday,shiftPlanDay,validPlanDay} from './planner-model';
import {personalDate} from './schedule';

export type PracticeQuestion={id:string;title:string;practiced:boolean;priority?:number;category?:'personal'|'major'|'talent';lastPracticedAt?:string};
export type PracticePhase='foundation'|'connection'|'rehearsal'|'final';
export const practicePhaseLabels:Record<PracticePhase,string>={foundation:'기록·전공 개념 익히기',connection:'경험과 전공 연결하기',rehearsal:'실전 답변과 약점 보완',final:'가벼운 최종 점검'};
export const practiceDaysLeft=(today:string,date:string)=>Math.round((Date.parse(date+'T00:00:00Z')-Date.parse(today+'T00:00:00Z'))/86400000);
export const practicePhase=(days:number):PracticePhase=>days<=1?'final':days<=7?'rehearsal':days<=21?'connection':'foundation';
/** Personal appointments override a goal. A public period is never an individual day. */
export function practiceDeadline(target:Record<string,any>,settings?:Record<string,any>|null){
  const personal=personalDate(target),personalDay=personal?(personal.includes('T')?koreaToday(new Date(personal)):personal):null;
  if(personal&&validPlanDay(personal.slice(0,10))&&personalDay&&validPlanDay(personalDay))return {date:personalDay,source:'personal' as const,label:'개별 면접일'};
  const publicDay=String(target.school_interview_date||'');
  if(validPlanDay(publicDay))return {date:publicDay,source:'public_day' as const,label:'학교 공개 면접일 · 개별 일정 확인 필요'};
  const goal=String(settings?.interviewDate||'');
  return validPlanDay(goal)?{date:goal,source:'goal' as const,label:'내가 정한 준비 목표일'}:null;
}
/** Rebuild a bounded week with spacing and D-day stages. */
export function automaticPracticeDays(today:string,interviewDate:string,minutes:number,questions:PracticeQuestion[]){
  if(!validPlanDay(today)||!validPlanDay(interviewDate)||interviewDate<=today)throw new Error('면접일은 내일 이후로 선택해 주세요.');
  if(interviewDate>shiftPlanDay(today,180))throw new Error('면접일은 오늘부터 180일 이내로 선택해 주세요.');
  if(![10,20,30].includes(minutes))throw new Error('하루 연습 시간을 선택해 주세요.');
  if(!questions.length)throw new Error('이 지원처에서 연습할 질문이 아직 없어요. 질문 자료를 먼저 준비해 주세요.');
  const ordered=[...new Map(questions.map(question=>[question.id,question])).values()],planned=new Map<string,string>();
  const plans:Array<{date:string;questionId:string;title:string;kind:'quiz'|'interview';minutes:number;reason:string;phase:PracticePhase}>=[];
  const until=interviewDate<shiftPlanDay(today,7)?interviewDate:shiftPlanDay(today,7);
  for(let date=today;date<until;date=shiftPlanDay(date,1)){
    const days=practiceDaysLeft(date,interviewDate),phase=practicePhase(days),count=phase==='final'?1:Math.min(minutes/10,ordered.length),used=new Set<string>();
    for(let slot=0;slot<count;slot++){
      const preferred=(['major','personal','talent'] as const)[(practiceDaysLeft(today,date)+slot)%3];
      const rank=(question:PracticeQuestion)=>{const saved=question.lastPracticedAt,last=planned.get(question.id)||(saved?(saved.includes('T')?koreaToday(new Date(saved)):saved):undefined),recent=last?Math.max(0,3-practiceDaysLeft(last,date)):0;return (question.priority||0)*5+Number(!question.practiced&&!planned.has(question.id))*8+Number(question.category===preferred)*3-recent*8;};
      const question=ordered.filter(question=>!used.has(question.id)).sort((a,b)=>rank(b)-rank(a)||a.id.localeCompare(b.id))[0];
      const review=question.practiced||planned.has(question.id),kind=phase==='final'||phase==='rehearsal'||review?'interview':'quiz';
      const reason=phase==='final'?'면접 전날은 새 과제 대신 핵심 답변 하나를 10분만 점검해요.':phase==='rehearsal'?'D-7부터는 실제로 말하고, 확인된 약점과 근거를 보완해요.':phase==='connection'?'남은 3주에는 학생부 경험과 지원 학과의 개념·이유를 연결해요.':'학생부의 사실과 지원 학과의 기초 개념부터 차근차근 익혀요.';
      plans.push({date,questionId:question.id,title:`${phase==='final'?'가벼운 최종 점검':kind==='interview'?'내 말로 답하기':'핵심 개념·기록 익히기'} · ${question.title}`.slice(0,160),kind,minutes:10,reason,phase});
      planned.set(question.id,date);used.add(question.id);
    }
  }
  return plans;
}
/** Manual overdue work remains visible; superseded automatic work stays in history. */
export function todayPlanAgenda<T extends Record<string,any>>(plans:T[],today:string,targetId?:string|null){
  return plans.filter(plan=>plan.date<=today&&(!plan.target?.targetId||plan.target.targetId===targetId)&&plan.target?.automaticPractice?.status!=='superseded'&&(plan.date===today||!plan.target?.automaticPractice&&!plan.completed&&!plan.performedAt))
    .map(plan=>({...plan,overdue:plan.date<today})).sort((a,b)=>Number(Boolean(a.completed||a.performedAt))-Number(Boolean(b.completed||b.performedAt))||a.date.localeCompare(b.date)||String(a.id).localeCompare(String(b.id)));
}
