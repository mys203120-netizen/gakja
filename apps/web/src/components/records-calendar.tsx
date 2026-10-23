'use client';

import Link from 'next/link';
import {useState} from 'react';
import {ArrowUpRight,CalendarDays,Check,ChevronLeft,ChevronRight,MessagesSquare,ListChecks} from 'lucide-react';
import {koreaToday} from '@/lib/planner-model';
import styles from './records-calendar.module.css';
import {ReportDownload} from './report-download';

export type CalendarRecord={id:string;date:string;title:string;href:string;kind:'study'|'interview';completed:boolean};

/** Dates in a student's history always follow the same Korean calendar as the planner. */
export function recordDate(value:string):string {
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return '';
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
}

function calendarRecordHref(record:CalendarRecord):string {
  const hashIndex=record.href.indexOf('#'),hash=hashIndex<0?'':record.href.slice(hashIndex);
  const address=hashIndex<0?record.href:record.href.slice(0,hashIndex);
  const queryIndex=address.indexOf('?'),path=queryIndex<0?address:address.slice(0,queryIndex);
  const params=new URLSearchParams(queryIndex<0?'':address.slice(queryIndex+1));
  params.set('date',record.date);
  return path+'?'+params.toString()+hash;
}

export function RecordsCalendar({records,hasMore,loadingMore,onMore,initialDate,currentAction}:{records:CalendarRecord[];hasMore:boolean;loadingMore:boolean;onMore:()=>void;initialDate?:string;currentAction?:{date:string;finishing:boolean;onFinish:()=>void}}) {
  const today=koreaToday();
  const days=[...new Set(records.map(record=>record.date).filter(Boolean))].sort().reverse();
  const [chosenDate,setChosenDate]=useState(initialDate&&recordDate(initialDate)===initialDate&&initialDate<=today?initialDate:'');
  const selected=chosenDate||days[0]||today;
  const [chosenMonth,setChosenMonth]=useState('');
  const month=chosenMonth||selected.slice(0,7);
  const [year,monthNumber]=month.split('-').map(Number);
  const offset=new Date(Date.UTC(year,monthNumber-1,1)).getUTCDay();
  const count=new Date(Date.UTC(year,monthNumber,0)).getUTCDate();
  const selectedRecords=records.filter(record=>record.date===selected);
  const completedDays=new Set(records.filter(record=>record.completed).map(record=>record.date));
  function changeMonth(delta:number){
    const next=new Date(Date.UTC(year,monthNumber-1+delta,1)).toISOString().slice(0,7);
    setChosenMonth(next);setChosenDate(days.find(day=>day.startsWith(next))||next+'-01');
  }
  return <section className={styles.workspace} aria-label="날짜별 학습 기록">
    <div className={styles.calendar}>
      <div className={styles.heading}><h2><CalendarDays size={18}/>학습 캘린더</h2><span>{completedDays.size}일의 기록</span></div>
      <div className={styles.month}><button type="button" aria-label="이전 달" onClick={()=>changeMonth(-1)}><ChevronLeft size={19}/></button><h3>{year}년 {monthNumber}월</h3><button type="button" aria-label="다음 달" onClick={()=>changeMonth(1)} disabled={month>=today.slice(0,7)}><ChevronRight size={19}/></button></div>
      <div className={styles.weekdays} aria-hidden="true">{['일','월','화','수','목','금','토'].map(day=><span key={day}>{day}</span>)}</div>
      <div className={styles.days}>{Array.from({length:offset},(_,index)=><span key={'empty-'+index}/>)}{Array.from({length:count},(_,index)=>{
        const date=month+'-'+String(index+1).padStart(2,'0'),entries=records.filter(record=>record.date===date),completed=completedDays.has(date);
        return <button key={date} type="button" className={styles.day} aria-label={`${monthNumber}월 ${index+1}일${date===today?', 오늘':''}${entries.length?`, 학습 기록 ${entries.length}개`:''}`} aria-pressed={date===selected} aria-current={date===today?'date':undefined} disabled={date>today} onClick={()=>setChosenDate(date)}><span>{index+1}</span>{completed?<img className={styles.stamp} src="/images/interviewers/human-clay-a.png" width={22} height={22} alt="" aria-hidden="true"/>:<span className={styles.placeholder}/>}</button>;
      })}</div>
      <p className={styles.legend}><img src="/images/interviewers/human-clay-a.png" width={22} height={22} alt=""/>훈련을 완료한 날</p>
    </div>
    <div className={styles.selection}>
      <div className={styles.selectionHeading}><div><span>선택한 날짜</span><h2>{Number(selected.slice(5,7))}월 {Number(selected.slice(8,10))}일</h2></div><span className={styles.count}>{selectedRecords.length}개 훈련</span></div>
      <p className={styles.hint}>훈련을 선택하면 질문과 답변을 볼 수 있어요.</p>
      {selectedRecords.length?<div className={styles.rows}>{selectedRecords.map(record=><Link key={record.id} href={calendarRecordHref(record)} className={styles.row}><span className={styles.icon}>{record.kind==='study'?<ListChecks size={21}/>:<MessagesSquare size={21}/>}</span><span><strong>{record.title}</strong><small>{record.completed?'학습 완료':'진행 중'}</small></span><ArrowUpRight size={18}/></Link>)}</div>:<div className={styles.empty}><CalendarDays size={27}/><p>{records.length?'이 날짜에 불러온 훈련 기록이 없어요.':'아직 저장된 훈련 기록이 없어요.'}</p>{!records.length&&!hasMore?<Link href="/practice" className={styles.more}>훈련 시작하기</Link>:<span>{hasMore?'이전 기록을 더 불러오거나 다른 날짜를 선택해 주세요.':'초록색 표시가 있는 날짜를 선택해 보세요.'}</span>}</div>}
      {currentAction?.date===selected&&<button type="button" className={styles.more} onClick={currentAction.onFinish} disabled={currentAction.finishing}>{currentAction.finishing?'저장하는 중…':'진행 중인 학습 마치기'}</button>}
      {hasMore&&<button type="button" className={styles.more} onClick={onMore} disabled={loadingMore}>{loadingMore?'기록 불러오는 중…':'이전 기록 더 불러오기'}</button>}
      {selectedRecords.length>0&&<ReportDownload date={selected}/>}
    </div>
  </section>;
}
