import {practiceDeadline,practiceDaysLeft} from './automatic-practice';
type Item=Record<string,any>;
const coverageLabels:Record<string,string>={no_interview:'면접 미실시',date_pending:'면접일 발표 대기',unpublished:'일정 미공개',unverified:'전형 일정 확인 필요',needs_review:'날짜 확인 필요',source_missing:'일정 출처 확인 필요',not_listed:'등록된 일정 없음',year_mismatch:'지원 연도 확인 필요',campus_mismatch:'캠퍼스·모집단위 확인 필요'};

/** Keep each application distinct; reference dates never become personal appointments. */
export function dashboardDeadlineRows(targets:Item[],schedules:Item[],coverage:Item|undefined,today:string){
  return targets.map(school=>{
    const status=coverage?.targets?.find((item:Item)=>item.targetId===school.id)?.status;
    const matched=schedules.filter(item=>item.targetId===school.id&&item.applicability==='track_match'&&item.format!=='video_submission');
    const publicDay=matched.length&&matched.every(item=>item.startDate===item.endDate&&item.startDate===matched[0].startDate)?matched[0].startDate:undefined;
    const personal=practiceDeadline({...school,school_interview_date:undefined});
    const deadline=status==='no_interview'?null:personal||(!status||status==='available'?practiceDeadline(school)||practiceDeadline({...school,school_interview_date:publicDay}):null);
    const days=deadline?practiceDaysLeft(today,deadline.date):null;
    return {school,deadline,days,status,label:days!==null?(days>0?`D-${days}`:days===0?'D-day':'면접일 지남'):coverageLabels[status]||'면접일 등록',canRegister:!deadline&&(!status||status==='available')};
  });
}

export function primaryDeadlineRow<T extends {school:Item;days:number|null}>(rows:T[],targetId?:string){
  return [...rows].sort((a,b)=>{
    const futureA=a.days!==null&&a.days>=0,futureB=b.days!==null&&b.days>=0;
    if(futureA!==futureB)return futureA?-1:1;
    if(futureA&&futureB&&a.days!==b.days)return a.days!-b.days!;
    return Number(b.school.id===targetId)-Number(a.school.id===targetId);
  })[0];
}
