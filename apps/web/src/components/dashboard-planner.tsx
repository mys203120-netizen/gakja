'use client';
import {useEffect,useState,type CSSProperties} from 'react';
import {ChevronLeft,ChevronRight,Plus,Check,CalendarDays} from 'lucide-react';
import {useApp} from './app-shell';
import {api,post,Modal,Alert,type Item,targetName} from './shared';
import {koreaToday,monthDays,planWeek,shiftPlanDay,validPlanDay,type PlanTargetOption} from '@/lib/planner-model';
import {personalDate,scheduleDetails,scheduleDateLabel} from '@/lib/schedule';
import {calendarSchoolTones,calendarInterviewTime} from '@/lib/calendar-presentation';
import {visibleCalendarSourceLabel,visibleCalendarSourceText,visibleCalendarSourceUrl} from '@/lib/calendar-source-presentation';
import {SchoolLogo} from './school-logo';
import styles from './school-context.module.css';
export type InterviewScheduleItem={id:string;schoolReferenceId:string;university:string;targetId:string;admissionYear:number;campus:string;trackLabel:string;departmentLabel?:string;matchedDepartment?:string;departmentCount?:number|null;startDate:string;endDate:string;rawDate?:string;note?:string;format?:'video_submission';sourceUrl:string;sourceLabel:string;checkedAt:string;applicability:'track_match'|'school_reference';schoolHref:string};
type OfficialScheduleDecision={trackLabel:string;departments:string[];status:'no_interview'|'date_pending'|'unpublished'|'unverified';reason:string;sourceUrl:string;sourceLabel?:string;checkedAt?:string};
type ScheduleCoverageStatus='available'|'needs_review'|'not_listed'|'source_missing'|'no_interview'|'date_pending'|'unpublished'|'unverified'|'year_mismatch'|'campus_mismatch';
type ScheduleCoverageTarget={targetId:string;university:string;status:ScheduleCoverageStatus;entryCount:number;unresolvedCount:number;unresolved?:{trackLabel:string;rawDate:string;reason:string}[];officialSources?:{url:string;title:string}[];officialDecisions?:OfficialScheduleDecision[];decisionTrack?:string;decisionSourceUrl?:string;decisionSourceLabel?:string;decisionCheckedAt?:string;managed?:boolean;note?:string};
export type InterviewScheduleCoverage={source:{url:string;title:string;admissionYear:number;checkedAt:string};registeredSchools:number;matchedSchools:number;availableSchools:number;totalInterviewEntries:number;officialSchools?:number;officialCheckedAt?:string;stale?:boolean;lastRefreshFailed?:boolean;targets:ScheduleCoverageTarget[]};
const coverageStatusLabels:Record<ScheduleCoverageStatus,string>={available:'면접 일정 등록',needs_review:'날짜 확인 필요',not_listed:'등록된 일정 없음',source_missing:'일정 확인 필요',no_interview:'면접 미실시',date_pending:'날짜 미정',unpublished:'일정 미공개',unverified:'확인 필요',year_mismatch:'지원 연도 확인',campus_mismatch:'캠퍼스·모집단위 확인'};
const coverageStatusNotes:Record<ScheduleCoverageStatus,string>={available:'전형별 일정과 면접 여부를 확인해 주세요.',needs_review:'날짜를 확정할 수 없는 일정은 달력에 배치하지 않았어요.',not_listed:'해당 학교의 면접 일정이 아직 등록되지 않았어요. 면접 여부는 입학처에서 확인해 주세요.',source_missing:'선택한 전형의 면접 일정을 확인해 주세요. 일정이 없다고 면접 미실시를 뜻하지는 않아요.',no_interview:'선택한 전형은 입학처 자료에서 면접 미실시로 확인됐어요.',date_pending:'면접이 있는 전형이며, 날짜는 아직 정해지지 않았어요.',unpublished:'지원 학년도의 면접 일정이 아직 공개되지 않았어요.',unverified:'선택한 전형의 면접 일정은 확인이 필요해요.',year_mismatch:'지원 학년도와 공개 일정의 학년도가 달라요.',campus_mismatch:'선택한 캠퍼스·모집단위의 면접일은 원문에서 확인해 주세요.'};
function DecisionSource({decision,checkedAt}:{decision:OfficialScheduleDecision;checkedAt?:string}){
  const label=visibleCalendarSourceLabel(decision.sourceLabel,decision.sourceUrl),url=visibleCalendarSourceUrl(decision.sourceUrl),at=decision.checkedAt||checkedAt;
  if(!label&&!url&&!at)return null;
  return <div className="calendar-source-evidence">{url?<a href={url} target="_blank" rel="noreferrer">{label==='관리자'?'관리자 참고 출처':label==='입학처'?'입학처 원문':label?`${label} 원문`:'일정 원문'}<ChevronRight size={12}/></a>:label&&<span>{label} 설정</span>}{at&&<time dateTime={at}>{scheduleDateLabel(at)} 확인</time>}</div>;
}
type CalendarEvent={id:string;date?:string;start?:string;end?:string;title:string;kind:'plan'|'interview'|'assignment';plan?:Item;href?:string;personalAt?:string;schoolSchedule?:InterviewScheduleItem;targetId?:string};
function localDay(value?:string){if(!value)return '';const date=new Date(value);return Number.isFinite(date.getTime())?koreaToday(date):'';}
export function DashboardPlanner({plans,onPlans,tasks,interviewSchedules=[],interviewScheduleCoverage,loaded=true}:{plans:Item[];onPlans:(plans:Item[])=>void;tasks:Item[];interviewSchedules?:InterviewScheduleItem[];interviewScheduleCoverage?:InterviewScheduleCoverage;loaded?:boolean}) {
  const {data}=useApp(),today=koreaToday(),[month,setMonth]=useState(today.slice(0,7)),[selected,setSelected]=useState(today),[adding,setAdding]=useState(false),[editing,setEditing]=useState<Item|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const registeredSchools=new Set(data.targets.map(target=>target.school_reference_id||targetName(target))).size;
  const schoolSchedules=interviewSchedules.filter(item=>validPlanDay(item.startDate)&&validPlanDay(item.endDate)&&item.startDate<=item.endDate);
  const schoolTargets=new Set(schoolSchedules.map(item=>item.targetId));
  const officialNonDatedTargets=new Set((interviewScheduleCoverage?.targets||[]).filter(item=>(item.managed||Boolean(item.officialSources?.length))&&['no_interview','date_pending','unpublished','unverified'].includes(item.status)).map(item=>item.targetId));
  const combinedAppointment=(item:InterviewScheduleItem)=>{
    const target=data.targets.find(target=>target.id===item.targetId),date=target&&personalDate(target);
    const day=date?.includes('T')?localDay(date):date;
    // A verified personal appointment refines this target's matching period.
    // A school-wide reference alone cannot establish which track applies.
    return item.applicability==='track_match'&&item.format!=='video_submission'&&day&&item.startDate<=day&&day<=item.endDate?date:undefined;
  };
  const combinedTargets=new Set(schoolSchedules.filter(item=>combinedAppointment(item)).map(item=>item.targetId));
  const events:CalendarEvent[]=[
    ...plans.map(plan=>({id:plan.id,date:plan.date,title:plan.title,kind:'plan' as const,plan,href:plan.href||undefined,targetId:plan.target?.targetId||plan.target_id})),
    ...tasks.filter(t=>t.due_at).map(t=>({id:t.id,date:localDay(t.due_at),title:t.title||'퀴즈 과제',kind:'assignment' as const,href:`/quiz/assignments/${t.id}`,targetId:t.target_id||t.targetId})),
    ...data.targets.flatMap<CalendarEvent>(t=>{const date=personalDate(t),schedule=scheduleDetails(t),items:CalendarEvent[]=[];const title=[targetName(t),t.admission_type||t.track].filter(Boolean).join(' · ');if(date&&!combinedTargets.has(t.id))items.push({id:t.id,date:date.includes('T')?localDay(date):date,title,kind:'interview',personalAt:date,href:`/schools/${t.id}`,targetId:t.id});if(!schoolTargets.has(t.id)&&!officialNonDatedTargets.has(t.id)&&schedule.period_start&&!date)items.push({id:`legacy:${t.id}`,start:schedule.period_start,end:schedule.period_end||schedule.period_start,title,kind:'interview',href:`/schools/${t.id}`,targetId:t.id});return items;}),
    ...schoolSchedules.map<CalendarEvent>(item=>{const appointment=combinedAppointment(item);return {id:`${item.id}:${item.targetId}`,...(appointment?{date:appointment.includes('T')?localDay(appointment):appointment}:{start:item.startDate,end:item.endDate}),title:`${item.university} · ${item.trackLabel}${item.format==='video_submission'?' · 동영상 면접 제출':''}`,kind:'interview',personalAt:appointment||undefined,schoolSchedule:item,href:item.schoolHref,targetId:item.targetId};}),
  ];
  function schoolFor(event:CalendarEvent){
    const target=data.targets.find(target=>target.id===event.targetId);
    return {key:String(target?(target.school_reference_id||targetName(target)):(event.schoolSchedule?.schoolReferenceId||event.schoolSchedule?.university||'unknown')),university:event.schoolSchedule?.university||targetName(target),school_logo_url:target?.school_logo_url,logoUrl:target?.logoUrl};
  }
  const calendarSchools=[...new Map(data.targets.map(target=>{const school={key:String(target.school_reference_id||targetName(target)),university:targetName(target),school_logo_url:target.school_logo_url,logoUrl:target.logoUrl};return [school.key,school] as const;})).values()];
  const schoolTones=calendarSchoolTones([...calendarSchools.map(school=>school.key),...events.filter(event=>event.kind==='interview').map(event=>schoolFor(event).key)]);
  function schoolStyle(key:string):CSSProperties{const tone=schoolTones[key];return {'--calendar-school-bg':tone.background,'--calendar-school-text':tone.foreground,'--calendar-school-accent':tone.accent} as CSSProperties;}
  const timeOrder=(event:CalendarEvent)=>{if(event.kind!=='interview')return '00:00';const time=calendarInterviewTime(event.personalAt,event.schoolSchedule?.format);return /^\d{2}:\d{2}$/.test(time)?time:'99:99';};
  const compareEventTime=(a:CalendarEvent,b:CalendarEvent)=>timeOrder(a).localeCompare(timeOrder(b))||a.title.localeCompare(b.title,'ko');
  const onDay=(day:string)=>events.filter(event=>event.date===day||!!event.start&&event.start<=day&&(event.end||event.start)>=day).sort(compareEventTime);
  function changeMonth(delta:number){const [year,num]=month.split('-').map(Number),next=new Date(Date.UTC(year,num-1+delta,1)).toISOString().slice(0,7);setMonth(next);setSelected(`${next}-01`);}
  async function complete(plan:Item){if(busy)return;setBusy(true);try{const result=await post('/api/planner',{action:'update',id:plan.id,expectedRevision:plan.revision,completed:!plan.completed});onPlans(plans.map(p=>p.id===plan.id?result.plan:p));setError('');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  const week=planWeek(selected),weekPlans=plans.filter(p=>week.includes(p.date));
  const selectedEvents=onDay(selected),selectedInterviewIds=new Set(selectedEvents.filter(event=>event.kind==='interview').map(event=>event.id));
  const upcoming=events.filter(event=>event.kind==='interview'&&(event.end||event.date||event.start||'')>=today&&!selectedInterviewIds.has(event.id)).sort((a,b)=>(a.date||a.start||'').localeCompare(b.date||b.start||'')||compareEventTime(a,b));
  const coverageTargets=interviewScheduleCoverage?.targets||[],needsReview=coverageTargets.filter(item=>item.status!=='available'||item.unresolvedCount>0||Boolean(item.officialDecisions?.length));
  const hasOfficialSource=coverageTargets.some(item=>item.officialSources?.some(source=>visibleCalendarSourceUrl(source.url)));
  const hasManagedSource=coverageTargets.some(item=>item.managed);
  const nonDatedTargets=coverageTargets.filter(item=>['no_interview','date_pending','unpublished','unverified','source_missing','not_listed','year_mismatch','campus_mismatch'].includes(item.status));
  function eventRow(event:CalendarEvent,showDate=false){
    const source=event.schoolSchedule;
    const sourceLabel=visibleCalendarSourceLabel(source?.sourceLabel,source?.sourceUrl),sourceUrl=visibleCalendarSourceUrl(source?.sourceUrl),sourceNote=visibleCalendarSourceText(source?.note),eventHref=visibleCalendarSourceUrl(event.href);
    const department=source?.matchedDepartment||source?.departmentLabel;
    const longDepartment=Boolean(department&&!source?.matchedDepartment&&department.length>100);
    const target=data.targets.find(target=>target.id===event.targetId);
    const school=event.kind==='interview'?schoolFor(event):null;
    const appointmentLabel=event.personalAt?[!showDate?scheduleDateLabel(event.personalAt,true):null,!event.personalAt.includes('T')?'응시 시간 발표 대기':null].filter(Boolean).join(' · '):'';
    return <div key={`${event.kind}:${event.id}`} className={`calendar-event ${school?'calendar-school-event':''} ${event.plan?.completed?'completed':''}`} style={school?schoolStyle(school.key):undefined}>
      {event.plan?<button className="plan-check" aria-label={`${event.title} 직접 체크 ${event.plan.completed?'취소':'하기'}`} aria-pressed={event.plan.completed} disabled={busy} onClick={()=>complete(event.plan!)}>{event.plan.completed&&<Check size={13}/>}</button>:school?<SchoolLogo school={school} size={24}/>:<CalendarDays size={16}/>}
      <div>
        {showDate&&<button type="button" className="calendar-event-date" onClick={()=>{const day=event.date||event.start!;setSelected(day);setMonth(day.slice(0,7));}}>{event.date?scheduleDateLabel(event.personalAt||event.date,true):event.start===event.end?scheduleDateLabel(event.start):`${scheduleDateLabel(event.start)}–${scheduleDateLabel(event.end)}`}<ChevronRight size={13}/></button>}
        {eventHref?<a href={eventHref}>{event.title}<ChevronRight size={14}/></a>:<span>{event.title}</span>}
        {source?<>
          <small className="calendar-schedule-context">{[source.campus,!longDepartment&&department].filter(Boolean).join(' · ')}</small>
          {longDepartment&&<details className="calendar-departments"><summary>모집단위 {source.departmentCount?`${source.departmentCount}개 `:''}확인</summary><p>{department}</p></details>}
          {(!event.personalAt||appointmentLabel)&&<small>{event.personalAt?appointmentLabel:source.format==='video_submission'?'동영상 면접 제출기간':source.applicability==='track_match'?'응시 시간 발표 대기':'지원 전형 확인 필요'}</small>}
          {event.personalAt&&source.startDate!==source.endDate&&<small>전형 일정 {scheduleDateLabel(source.startDate)}–{scheduleDateLabel(source.endDate)}</small>}
          {sourceNote&&<small>{sourceNote}</small>}
          {(sourceUrl||sourceLabel||source.checkedAt)&&<div className="calendar-source-evidence">{sourceUrl?<a className="calendar-source-link" href={sourceUrl} target="_blank" rel="noreferrer" aria-label={`${source.university} ${source.trackLabel} ${sourceLabel} 일정 원문`}>{sourceLabel?`${sourceLabel} `:''}{sourceLabel==='관리자'?'참고 출처':'일정 원문'}<ChevronRight size={12}/></a>:sourceLabel&&<span>{sourceLabel} 설정</span>}{source.checkedAt&&<time dateTime={source.checkedAt}>{scheduleDateLabel(source.checkedAt)} 확인</time>}</div>}
        </>:event.kind==='interview'?<><small>{[target?.campus,target?.department||target?.major].filter(Boolean).join(' · ')}</small>{event.personalAt?appointmentLabel&&<small>{appointmentLabel}</small>:event.start&&<small>응시일·시간 발표 대기</small>}</>:null}
        {event.plan&&<div className="plan-evidence"><small>{event.plan.completed?'직접 체크함':'직접 체크 전'}</small>{event.plan.performedAt&&<small className="plan-recorded">연습 기록 있음</small>}{event.plan.target&&!event.plan.targetAvailable&&<small>연결 자료가 변경됐어요</small>}</div>}
      </div>
      {event.plan&&<button className="text-link plan-edit" onClick={()=>setEditing(event.plan!)}>수정</button>}
    </div>;
  }
  return <section className="dashboard-planner dashboard-calendar-panel" id="dashboard-planner" tabIndex={-1} aria-labelledby="dashboard-calendar-title">
    <div className="section-heading"><h2 id="dashboard-calendar-title">계획과 면접 일정</h2><button className="text-link" onClick={()=>setAdding(true)}><Plus size={15}/>계획 추가</button></div>
    {data.targets.length>0&&<div className={styles.calendarScope}><p>지원 학교 전체<span>{registeredSchools}개 학교{data.targets.length>registeredSchools?` · ${data.targets.length}개 지원처`:''}</span></p></div>}
    {interviewScheduleCoverage?.source&&<p className="calendar-source-summary"><span>{interviewScheduleCoverage.source.admissionYear}학년도 수시</span>{hasOfficialSource&&interviewScheduleCoverage.officialCheckedAt?<span>입학처 · <time dateTime={interviewScheduleCoverage.officialCheckedAt}>{scheduleDateLabel(interviewScheduleCoverage.officialCheckedAt)}</time> 확인</span>:interviewScheduleCoverage.source.checkedAt&&<span><time dateTime={interviewScheduleCoverage.source.checkedAt}>{scheduleDateLabel(interviewScheduleCoverage.source.checkedAt)}</time> 확인</span>}{hasManagedSource&&<span>관리자 설정</span>}</p>}
    {interviewScheduleCoverage?.stale&&<p className="calendar-status" role="status">{interviewScheduleCoverage.lastRefreshFailed?'최신 일정 연결이 지연되어 마지막 확인 자료를 보여드려요.':'마지막 확인 자료를 표시하고 있어요.'}{visibleCalendarSourceUrl(interviewScheduleCoverage.source.url)&&<> <a href={visibleCalendarSourceUrl(interviewScheduleCoverage.source.url)} target="_blank" rel="noreferrer">일정 원문 확인</a></>}</p>}
    {nonDatedTargets.length>0&&<ul className="calendar-coverage-statuses" aria-label="지원 전형의 면접 상태">{nonDatedTargets.map(item=>{
      const target=data.targets.find(target=>target.id===item.targetId);
      const track=item.decisionTrack==='*'?'전체 전형':item.decisionTrack||target?.admission_type||target?.track;
      const scope=[track,target?.department||target?.major].filter(value=>value&&value!=='미정').join(' · ');
      const proposedUrl=item.decisionSourceLabel==='관리자'?item.decisionSourceUrl:item.decisionSourceUrl||item.officialSources?.find(source=>visibleCalendarSourceUrl(source.url))?.url;
      const sourceLabel=visibleCalendarSourceLabel(item.decisionSourceLabel,proposedUrl)||'입학처',officialUrl=visibleCalendarSourceUrl(proposedUrl);
      const checkedAt=item.decisionCheckedAt||interviewScheduleCoverage?.officialCheckedAt;
      return <li key={item.targetId}><div><a href={`/schools/${item.targetId}`}>{item.university}<ChevronRight size={13}/></a>{scope&&<small>{scope}</small>}</div><div className="calendar-coverage-result"><span data-status={item.status}>{coverageStatusLabels[item.status]}</span>{officialUrl?<a href={officialUrl} target="_blank" rel="noreferrer" aria-label={`${item.university} ${scope} ${sourceLabel} 출처`}>{sourceLabel==='관리자'?'관리자 참고 출처':'입학처 원문'}<ChevronRight size={12}/></a>:item.managed&&<span>관리자 설정</span>}{checkedAt&&(officialUrl||item.managed)&&<time dateTime={checkedAt}>{scheduleDateLabel(checkedAt)} 확인</time>}</div></li>;
    })}</ul>}
    <div className="planner-calendar-layout"><div className="planner-month">
    <div className="calendar-heading"><strong>{Number(month.slice(0,4))}년 {Number(month.slice(5))}월</strong><div><button className="icon-button" onClick={()=>changeMonth(-1)} aria-label="이전 달"><ChevronLeft size={17}/></button><button className="calendar-today" onClick={()=>{setMonth(today.slice(0,7));setSelected(today);}}>오늘</button><button className="icon-button" onClick={()=>changeMonth(1)} aria-label="다음 달"><ChevronRight size={17}/></button></div></div>
    {calendarSchools.length>0&&<div className="calendar-school-key" aria-label="학교별 일정 색상">{calendarSchools.map(school=><span key={school.key} style={schoolStyle(school.key)}><SchoolLogo school={school} size={18}/><span>{school.university}</span></span>)}</div>}
    <div className="month-calendar"><div className="calendar-weekdays">{['일','월','화','수','목','금','토'].map(d=><span key={d}>{d}</span>)}</div><div className="calendar-days">{monthDays(month).map(day=>{
      const items=onDay(day),interviews=items.filter(item=>item.kind==='interview');
      const labels=items.map(event=>event.kind==='interview'?`${schoolFor(event).university} ${calendarInterviewTime(event.personalAt,event.schoolSchedule?.format)}${event.schoolSchedule?.applicability==='school_reference'?' · 지원 전형 확인 필요':''}`:event.title);
      return <button key={day} aria-label={`${day}${items.length?`, 일정 ${items.length}개`:''}${interviews.length?`, 면접 ${interviews.length}개`:''}${labels.length?`, ${labels.join(' / ')}`:''}`} aria-controls="planner-selected-day" aria-pressed={selected===day} className={`${day.startsWith(month)?'':'outside'} ${day===today?'today':''} ${day===selected?'selected':''}`} onClick={()=>setSelected(day)}><span className="calendar-date-number">{Number(day.slice(8))}</span><div className="calendar-day-items">{items.map(event=>{
        if(event.kind!=='interview')return <span className={`calendar-day-item calendar-task-item ${event.kind}`} key={`${event.kind}:${event.id}`} title={event.title}>{event.title}</span>;
        const school=schoolFor(event),track=event.schoolSchedule?.trackLabel||data.targets.find(target=>target.id===event.targetId)?.admission_type;
        const multipleTracks=interviews.filter(item=>schoolFor(item).key===school.key).length>1;
        const time=calendarInterviewTime(event.personalAt,event.schoolSchedule?.format);
        return <span key={`interview:${event.id}`} className="calendar-day-item calendar-interview-item" data-school={school.key} style={schoolStyle(school.key)} title={`${event.title} · ${time}${event.schoolSchedule?.applicability==='school_reference'?' · 지원 전형 확인 필요':''}`}><span className="calendar-chip-school"><SchoolLogo school={school} size={16}/><span className="calendar-chip-name">{school.university}</span></span>{multipleTracks&&track&&<span className="calendar-chip-track">{track}</span>}{event.schoolSchedule?.applicability==='school_reference'&&<span className="calendar-chip-track">참고 일정</span>}<span className="calendar-chip-time">{time}{event.start&&event.end&&event.start!==event.end&&event.schoolSchedule?.format!=='video_submission'?' · 면접 기간':''}</span></span>;
      })}</div></button>;
    })}</div></div>
    <div className="calendar-legend"><span><i className="plan"/>계획</span><span><i className="assignment"/>과제</span><span><CalendarDays size={12} aria-hidden="true"/>면접</span></div>
    </div><div className="planner-day-agenda" aria-live="polite">
    <div className="planner-selected-day" id="planner-selected-day"><div className="selected-day-heading"><strong>{Number(selected.slice(5,7))}월 {Number(selected.slice(8))}일</strong><span>{selected===today?'오늘':new Intl.DateTimeFormat('ko-KR',{weekday:'long',timeZone:'UTC'}).format(new Date(`${selected}T00:00:00Z`))}</span></div>
    <div className="calendar-events">{selectedEvents.length?selectedEvents.map(event=>eventRow(event)):!loaded?<p className="calendar-status">일정을 불러오고 있어요.</p>:<button className="calendar-empty" onClick={()=>setAdding(true)}>이날의 계획을 추가해 보세요.<Plus size={15}/></button>}</div>
    </div>
    {upcoming.length>0&&<section className="calendar-upcoming" aria-labelledby="calendar-upcoming-title"><h3 id="calendar-upcoming-title">다가오는 면접</h3>{upcoming.map(event=>eventRow(event,true))}</section>}
    {loaded&&!upcoming.length&&!selectedEvents.some(event=>event.kind==='interview')&&!needsReview.length&&<p className="calendar-status">예정된 면접 일정이 없어요.</p>}
    {needsReview.length>0&&<details className="calendar-review"><summary>전형별 일정 안내<span>{needsReview.length}개 지원처</span></summary><div>{needsReview.map(item=>{
      const officialSources=(item.officialSources||[]).flatMap(source=>{const url=visibleCalendarSourceUrl(source.url);return url?[{url,title:visibleCalendarSourceText(source.title)||'입학처 자료'}]:[];});
      return <section key={item.targetId} className="calendar-school-guidance"><a href={`/schools/${item.targetId}`}>{item.university}<ChevronRight size={13}/></a><p>{visibleCalendarSourceText(item.note)||coverageStatusNotes[item.status]}</p>{item.officialDecisions?.map((decision,i)=><div className="calendar-official-decision" key={`${decision.trackLabel}:${i}`}><div className="calendar-decision-heading"><span>{decision.trackLabel==='*'?'전체 전형':decision.trackLabel}</span><span data-status={decision.status}>{coverageStatusLabels[decision.status]}</span></div><p className="calendar-decision-scope">{decision.departments.length?decision.departments.join(', '):'전체 모집단위'}</p><p>{visibleCalendarSourceText(decision.reason)||coverageStatusNotes[decision.status]}</p><DecisionSource decision={decision} checkedAt={interviewScheduleCoverage?.officialCheckedAt}/></div>)}{item.unresolved?.map((entry,i)=><p className="calendar-unresolved" key={`${entry.trackLabel}:${i}`}>{entry.trackLabel} · {entry.rawDate}<small>{visibleCalendarSourceText(entry.reason)||coverageStatusNotes.needs_review}</small></p>)}{officialSources.length>0&&<nav className="calendar-official-sources" aria-label={`${item.university} 입학처 자료`}>{officialSources.map(source=><a href={source.url} target="_blank" rel="noreferrer" key={source.url}>{source.title}<ChevronRight size={12}/></a>)}</nav>}</section>;
    })}</div></details>}
    </div></div>
    <details className="week-plan-disclosure"><summary>주간 계획 보기<span>{weekPlans.length}개</span></summary><div className="week-plan-heading"><h3>이번 주 계획</h3><span>{Number(week[0].slice(5,7))}.{Number(week[0].slice(8))}–{Number(week[6].slice(5,7))}.{Number(week[6].slice(8))}</span><div><button className="icon-button" aria-label="이전 주" onClick={()=>{const day=shiftPlanDay(selected,-7);setSelected(day);setMonth(day.slice(0,7));}}><ChevronLeft size={15}/></button><button className="icon-button" aria-label="다음 주" onClick={()=>{const day=shiftPlanDay(selected,7);setSelected(day);setMonth(day.slice(0,7));}}><ChevronRight size={15}/></button></div></div>
    <div className="week-plan">{week.map((day,i)=><button key={day} className={day===selected?'selected':''} onClick={()=>{setSelected(day);setMonth(day.slice(0,7));}}><span>{['월','화','수','목','금','토','일'][i]}<b>{Number(day.slice(8))}</b></span><div>{weekPlans.filter(p=>p.date===day).length?weekPlans.filter(p=>p.date===day).map(p=><span className={p.completed?'completed':''} key={p.id}>{p.title}</span>):<small>—</small>}</div></button>)}</div>
    </details>
    {error&&<Alert>{error}</Alert>}
    {adding&&<Modal title="계획 추가" onClose={()=>setAdding(false)}><PlanForm initialDate={selected} onClose={()=>setAdding(false)} onSave={plan=>{onPlans([...plans,plan].sort((a,b)=>a.date.localeCompare(b.date)));setAdding(false);setSelected(plan.date);setMonth(plan.date.slice(0,7));}}/></Modal>}
    {editing&&<Modal title="계획 수정" onClose={()=>setEditing(null)}><PlanForm initialDate={editing.date} initialPlan={editing} onClose={()=>setEditing(null)} onSave={plan=>{onPlans(plans.map(item=>item.id===plan.id?plan:item).sort((a,b)=>a.date.localeCompare(b.date)));setEditing(null);setSelected(plan.date);setMonth(plan.date.slice(0,7));}}/></Modal>}
  </section>;
}
function PlanForm({initialDate,initialPlan,onClose,onSave}:{initialDate:string;initialPlan?:Item;onClose:()=>void;onSave:(plan:Item)=>void}) {
  const {targetId:selectedTargetId}=useApp();
  const [title,setTitle]=useState(initialPlan?.title||''),[date,setDate]=useState(initialDate),[kind,setKind]=useState(initialPlan?.kind||'study'),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [targets,setTargets]=useState<PlanTargetOption[]>([]),[targetValue,setTargetValue]=useState(initialPlan?.target?`${initialPlan.target.kind}:${initialPlan.target.id}`:'');
  useEffect(()=>{let alive=true;api<{targets:PlanTargetOption[]}>('/api/planner').then(result=>{if(alive)setTargets(result.targets||[]);}).catch(()=>{});return()=>{alive=false;};},[]);
  const target=targets.find(item=>`${item.kind}:${item.id}`===targetValue);
  const initialTargetValue=initialPlan?.target?`${initialPlan.target.kind}:${initialPlan.target.id}`:'';
  const preserveTarget=Boolean(initialPlan)&&targetValue===initialTargetValue;
  return <form className="plan-form" onSubmit={async event=>{event.preventDefault();if(busy)return;setBusy(true);try{const result=await post('/api/planner',{action:initialPlan?'update':'create',...(initialPlan?{id:initialPlan.id,expectedRevision:initialPlan.revision}:{}),title,date,kind,...(preserveTarget?{}:{target:target?{kind:target.kind,id:target.id,...(selectedTargetId||target.targetId?{targetId:selectedTargetId||target.targetId}:{}),...(target.sourceType?{sourceType:target.sourceType}:{}),...(target.sourceVersion?{sourceVersion:target.sourceVersion}:{})}:null})});onSave(result.plan);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}><label>연결할 학습<select aria-label="계획에서 시작할 학습" value={targetValue} onChange={event=>{const value=event.target.value,item=targets.find(item=>`${item.kind}:${item.id}`===value);setTargetValue(value);if(item){setTitle((previous:string)=>previous.trim()?previous:item.title.slice(0,160));if(!initialPlan)setKind(item.common?'interview':item.kind==='video'?'reading':item.kind==='question'||item.kind==='assignment'?'quiz':'study');}}}><option value="">직접 적을게요</option>{initialPlan?.target&&!targets.some(item=>`${item.kind}:${item.id}`===initialTargetValue)&&<option value={initialTargetValue}>{initialPlan.target.title||initialPlan.title} · 저장한 자료</option>}{[['question','질문'],['activity','활동'],['video','영상'],['assignment','과제']].map(([group,label])=><optgroup key={group} label={label}>{targets.filter(item=>item.kind===group).map(item=><option key={`${item.kind}:${item.id}`} value={`${item.kind}:${item.id}`}>{item.title}</option>)}</optgroup>)}</select></label><label>할 일<input autoFocus data-autofocus required maxLength={160} value={title} onChange={e=>setTitle(e.target.value)} placeholder="예: 수질 탐구 활동을 내 말로 설명하기"/></label><div><label>날짜<input required type="date" value={date} onChange={e=>setDate(e.target.value)}/></label><label>종류<select value={kind} onChange={e=>setKind(e.target.value)}><option value="study">공부</option><option value="quiz">퀴즈</option><option value="interview">모의면접</option><option value="reading">읽기·영상</option></select></label></div>{target&&<p className="plan-target-note">일정에서 제목을 누르면 선택한 학습으로 이동해요.</p>}{error&&<Alert>{error}</Alert>}<div className="form-actions"><button className="button secondary" type="button" onClick={onClose}>취소</button><button className="button primary" disabled={busy||!preserveTarget&&Boolean(targetValue)&&!target}>{busy?'저장 중':initialPlan?'저장':'추가'}</button></div></form>;
}

