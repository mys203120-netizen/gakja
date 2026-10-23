'use client';

import Link from 'next/link';
import {useEffect,useState} from 'react';
import {ArrowRight,ArrowUpRight,CalendarDays,ChevronDown,History,Settings2,Target} from 'lucide-react';
import {useApp} from './app-shell';
import {useTrainingData} from './training-hub';
import {Alert,Spinner,api} from './shared';
import {ownedClassName} from './owned-class-name';
import {TrainingCalendar} from './training-calendar';
import {ProgressRing,LearningDistribution,ActivityBars} from './learning-charts';
import {trainingTaskDone} from '@/lib/training-flow';
import {koreaToday,shiftPlanDay} from '@/lib/planner-model';
import styles from './preparation-dashboard.module.css';

function shortDate(value:string) { return new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'long',day:'numeric'}).format(new Date(value.slice(0,10)+'T12:00:00+09:00')); }

export function PreparationDashboard() {
  const {data,targetId,learningRevision}=useApp(),{value,error,reload}=useTrainingData();
  const today=koreaToday();
  const [activity,setActivity]=useState<{days:Array<{day:string;count:number}>;owner:string}|null>(null),[activityError,setActivityError]=useState('');
  useEffect(()=>{const controller=new AbortController();setActivityError('');void api<{days:Array<{day:string;count:number}>}>('/api/dashboard',{signal:controller.signal,cache:'no-store'}).then(result=>{if(!controller.signal.aborted)setActivity({...result,owner:data.user.id});}).catch(()=>{if(!controller.signal.aborted)setActivityError('면접 기록을 불러오지 못했어요.');});return()=>controller.abort();},[data.user.id,learningRevision,today]);
  const currentActivity=activity?.owner===data.user.id?activity:null;
  const weekRows=Array.from({length:7},(_,index)=>{const day=shiftPlanDay(today,index-6);return {label:['일','월','화','수','목','금','토'][new Date(day+'T12:00:00+09:00').getUTCDay()],value:currentActivity?.days.find(row=>row.day===day)?.count||0,current:day===today};});
  const weeklyCount=weekRows.reduce((total,row)=>total+row.value,0);
  const rows=value?.readiness?.items||[],practiced=value?.readiness?.summary?.practiced??rows.filter(row=>row.mainAnswers+row.followupAnswers>0).length;
  const review=rows.filter(row=>row.reviewStatus==='active'||row.needsReview?.length).length;
  const unseen=Math.max(0,rows.length-practiced);
  const practicedClear=Math.max(0,practiced-rows.filter(row=>(row.mainAnswers+row.followupAnswers>0)&&(row.reviewStatus==='active'||row.needsReview?.length)).length);
  const practicedReview=Math.max(0,practiced-practicedClear);
  const todayTasks=(value?.today.tasks||[]).filter(task=>task.kind!=='break'),finished=todayTasks.filter(trainingTaskDone).length;
  const nearest=[...(value?.deadlines||[])].filter(item=>item.status!=='no_interview'&&item.daysLeft!==null&&item.daysLeft>=0).sort((a,b)=>(a.daysLeft||0)-(b.daysLeft||0))[0];
  const deadlines=[...(value?.deadlines||[])].sort((a,b)=>Number(b.targetId===targetId)-Number(a.targetId===targetId));
  return <div className={styles.dashboard}>
    <header className={styles.heading}><div><p className={styles.eyebrow}>나의 면접 준비</p><h1>마이 대시보드</h1><p>쌓아 온 연습과 앞으로의 일정을 살펴보세요.</p></div><Link href="/account" className={styles.settings} aria-label="계정·개인 설정"><Settings2 size={19}/></Link></header>
    {!value?<div className={styles.loading}>{error?<><Alert>{error}</Alert><button className={ownedClassName('button secondary',true)} onClick={reload}>다시 불러오기</button></>:<Spinner/>}</div>:<>
      {error&&<Alert>{error}</Alert>}
      <div className={styles.summary}>
        <section className={`${styles.card} ${styles.today}`}><div className={styles.cardHeading}><span className={styles.symbol}><Target size={19}/></span><h2>오늘의 훈련</h2></div><ProgressRing completed={finished} total={todayTasks.length} label="오늘 계획 완료"/><Link className={ownedClassName('button primary')} href={value.needsAvailability?'/availability':'/training'}>{value.needsAvailability?'학습 시간 설정':'이어서 훈련'}<ArrowRight size={16}/></Link></section>
        <section className={`${styles.card} ${styles.deadlineCard}`}><div className={styles.cardHeading}><span className={styles.symbol}><CalendarDays size={19}/></span><h2>가장 가까운 일정</h2></div>{nearest?<><strong className={styles.countdown}>{nearest.daysLeft===0?'D-day':`D-${nearest.daysLeft}`}</strong><p className={styles.school}>{nearest.university}</p><p className={styles.caption}>{nearest.department}</p><p className={styles.date}>{nearest.date?shortDate(nearest.date):'날짜 확인 필요'}{nearest.source==='goal'||nearest.source==='public_period'?' · 준비 목표':' · 면접 예정'}</p></>:<><strong className={styles.emptyNumber}>—</strong><p className={styles.caption}>등록한 면접 일정을 확인해 주세요.</p><Link className={styles.inlineLink} href="/schools">학교·일정 등록<ArrowUpRight size={14}/></Link></>}</section>
        <section className={`${styles.card} ${styles.activityCard}`}><div className={styles.cardHeading}><h2>최근 7일 면접</h2><strong className={styles.weekTotal}>{currentActivity?weeklyCount:'—'}<small>회</small></strong></div>{currentActivity?<ActivityBars rows={weekRows} label="최근 7일 완료한 면접 횟수"/>:<p className={styles.caption} role="status">{activityError||'면접 기록을 불러오고 있어요.'}</p>}<p className={styles.chartNote}>완료한 면접 기록 기준</p></section>
      </div>
      <div className={styles.middle}>
        <section className={`${styles.card} ${styles.readiness}`}><div className={styles.cardHeading}><h2>활동별 준비</h2><span className={styles.caption}>{rows.length}개 활동·질문</span></div><p className={styles.description}>답변을 남긴 항목 <strong>{practiced}개</strong></p><LearningDistribution rows={[{label:'답변한 항목',value:practicedClear},{label:'답변 후 보완',value:practicedReview},{label:'아직 답변 전',value:unseen}]}/><details className={styles.details}><summary>보완할 항목 {review}개<ChevronDown size={15}/></summary>{rows.filter(row=>row.reviewStatus==='active'||row.needsReview?.length).slice(0,8).map(row=><Link key={row.id} href={'/records/comparisons?activityId='+encodeURIComponent(row.id)+'&targetId='+encodeURIComponent(targetId)}><span>{row.title}<small>{row.reviewReasons?.[0]||row.needsReview?.[0]||'답변 근거를 다시 확인해요.'}</small></span><ArrowUpRight size={15}/></Link>)}{!review&&<p>현재 보완 요청이 있는 항목이 없어요.</p>}</details></section>
        <section className={`${styles.card} ${styles.schoolCard}`}><div className={styles.cardHeading}><h2>지원 학교 일정</h2><Link href="/schools" aria-label="학교·일정 수정"><Settings2 size={16}/></Link></div>{deadlines.length?<div className={styles.schools}>{deadlines.map(item=><Link key={item.targetId} href={'/schools/'+encodeURIComponent(item.targetId)}><span><strong>{item.university}</strong><small>{item.department}</small></span><span className={styles.schoolDate}>{item.status==='no_interview'?'면접 없음':item.date?shortDate(item.date):'일정 확인'}<ArrowUpRight size={13}/></span></Link>)}</div>:<p className={styles.caption}>지원 학교를 등록하면 일정이 여기에 모여요.</p>}</section>
      </div>
      <section className={styles.calendarSection} aria-label="나의 학습 일정"><TrainingCalendar revision={`${value.availability?.savedAt||''}:${value.today?.date||''}`} onPlanChange={reload}/></section>
      <Link className={styles.recordsEntry} href="/records"><span className={styles.recordSymbol}><History size={22}/></span><span><strong>학습 기록과 리포트</strong><small>날짜를 골라 나의 답변과 피드백을 확인해요.</small></span><ArrowRight size={20}/></Link>
      <nav className={styles.tools} aria-label="준비 자료"><Link href="/student-document">내 생기부<ArrowUpRight size={13}/></Link><Link href="/materials">학습 자료<ArrowUpRight size={13}/></Link><Link href="/availability">학습 시간<ArrowUpRight size={13}/></Link></nav>
    </>}
  </div>;
}
