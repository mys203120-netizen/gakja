'use client';
import {ownedClassName} from './owned-class-name';


import {useEffect,useState} from 'react';
import {RefreshCw} from 'lucide-react';
import {koreaToday} from '@/lib/planner-model';
import {useApp} from './app-shell';
import {api,Alert,type Item} from './shared';
import {DashboardPlanner,type InterviewScheduleItem,type InterviewScheduleCoverage} from './dashboard-planner';
import styles from './training-calendar.module.css';

type CalendarData={plans:Item[];interviewSchedules:InterviewScheduleItem[];interviewScheduleCoverage?:InterviewScheduleCoverage};

/** Keep one calendar for every registered school, including personal plans and real interview dates. */
export function TrainingCalendar({revision,onPlanChange}:{revision?:string;onPlanChange?:()=>void}){
  const {data,learningRevision}=useApp();
  const [month,setMonth]=useState(koreaToday().slice(0,7));
  const scope=JSON.stringify([data.user.id,data.targets.map(target=>[target.id,target.university,target.department,target.admission_type,target.admission_calendar_registration,target.schedule]),learningRevision,revision,month]);
  const [loaded,setLoaded]=useState<{scope:string;value:CalendarData}|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();setError('');
    void api<CalendarData>('/api/planner?month='+encodeURIComponent(month),{signal:controller.signal,cache:'no-store'}).then(value=>{if(!controller.signal.aborted)setLoaded({scope,value});}).catch(err=>{if(!controller.signal.aborted)setError((err as Error).message);});
    return()=>controller.abort();
  },[scope,retry]);
  const value=loaded?.scope===scope?loaded.value:null;
  function updatePlans(plans:Item[]){setLoaded(previous=>previous?.scope===scope?{scope,value:{...previous.value,plans}}:previous);onPlanChange?.();}
  return <div className={ownedClassName(styles.calendar,true)} id="training-calendar" aria-label="훈련과 학교 면접 캘린더">
    <DashboardPlanner onMonthChange={setMonth} hybrid plans={value?.plans||[]} onPlans={updatePlans} tasks={[]} loaded={Boolean(value)} interviewSchedules={value?.interviewSchedules||[]} interviewScheduleCoverage={value?.interviewScheduleCoverage}/>
    {error&&<div className={ownedClassName(styles.error,true)}><Alert>{error}</Alert><button className={ownedClassName("text-link",true)} type="button" onClick={()=>setRetry(value=>value+1)}><RefreshCw size={14}/>일정 다시 불러오기</button></div>}
  </div>;
}
