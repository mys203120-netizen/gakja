'use client';
import Link from 'next/link';
import {ArrowUpRight,MessagesSquare,Mic,Sparkles,ListChecks} from 'lucide-react';
import {useApp} from './app-shell';
import {splitInterviewsByLearningTarget} from '@/lib/learning-target-scope';
import styles from './navigation-rail.module.css';
import {FocusTraining} from './focus-training';

export function PracticeHome(){
 const {data,target,targetId}=useApp(),suffix=targetId?'?targetId='+encodeURIComponent(targetId):'';
 const sessions=splitInterviewsByLearningTarget(data.interviews||[],target).current.filter(row=>row.state==='active');
 const active=sessions[0];
 return <div className={'practice-home '+styles.practiceHome}><header><p>{[target?.university,target?.department||target?.major].filter(Boolean).join(' · ')||'나의 면접 준비'}</p><h1>연습</h1></header>
 {active&&<div className={styles.resume}><span>하던 면접이 있어요</span><Link href={`/interview/${active.id}?kind=${active.kind}`}>저장한 답에서 이어가기<ArrowUpRight size={16}/></Link></div>}
 <div className={styles.practiceChoices}>
  <Link href={'/quiz'+suffix}><Sparkles size={25} strokeWidth={1.5}/><div><h2>퀴즈</h2><p>선택하고, 떠올리고, 소리 내어 답하기</p><span>10초 퀴즈 · Q&amp;A · 답변 녹음</span></div><ArrowUpRight size={20}/></Link>
  <Link href={'/interview'+suffix}><Mic size={25} strokeWidth={1.5}/><div><h2>모의면접</h2><p>질문을 듣고 내 경험으로 답하기</p><span>Chat · Live</span></div><ArrowUpRight size={20}/></Link>
 </div>
 <FocusTraining key={targetId} targetId={targetId}/><div className={styles.practiceLinks}><Link href="/quiz/assignments"><ListChecks size={17}/>받은 과제<ArrowUpRight size={14}/></Link><Link href="/quiz/memory">복습할 질문<ArrowUpRight size={14}/></Link><Link href="/on"><MessagesSquare size={17}/>AI 비서에게 물어보기<ArrowUpRight size={14}/></Link></div>
 <div className={styles.openPaths}><Link href="/armory">무기고에서 내 경험 정리하기<ArrowUpRight size={15}/></Link><Link href="/knowledge">답에 더할 자료 찾기<ArrowUpRight size={15}/></Link><Link href="/records/comparisons">이전 답변과 비교하기<ArrowUpRight size={15}/></Link></div>
 </div>;
}
