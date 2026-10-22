'use client';
import {ownedClassName} from './owned-class-name';

import Link from 'next/link';
import {ArrowUpRight,MessagesSquare,Mic,Sparkles,ListChecks,Library} from 'lucide-react';
import {useApp} from './app-shell';
import {splitInterviewsByLearningTarget} from '@/lib/learning-target-scope';
import styles from './navigation-rail.module.css';
import {FocusTraining} from './focus-training';
import {PageTitle} from './shared';

export function PracticeHome(){
 const {data,target,targetId}=useApp(),suffix=targetId?'?targetId='+encodeURIComponent(targetId):'';
 const sessions=splitInterviewsByLearningTarget(data.interviews||[],target).current.filter(row=>row.state==='active');
 const active=sessions[0];
 const resumeHref=active?.data?.trainingPlanId?'/my/train?planId='+encodeURIComponent(active.data.trainingPlanId):active?`/interview/${active.id}?kind=${active.kind}`:null;
 return <div className={ownedClassName('practice-home '+styles.practiceHome,true)}><PageTitle title="자유 연습"/>
 {active&&<div className={ownedClassName(styles.resume,true)}><span className={ownedClassName(undefined,true)}>{active.data?.trainingPlanId?'이어서 할 오늘 훈련이 있어요':'하던 면접이 있어요'}</span><Link href={resumeHref!}>저장한 답에서 이어가기<ArrowUpRight size={16}/></Link></div>}
 <div className={ownedClassName(styles.practiceChoices,true)}>
  <Link href={'/quiz'+suffix}><Sparkles size={25} strokeWidth={1.5}/><div className={ownedClassName(undefined,true)}><h2 className={ownedClassName(undefined,true)}>퀴즈</h2><p className={ownedClassName(undefined,true)}>선택하고, 떠올리고, 소리 내어 답하기</p><span className={ownedClassName(undefined,true)}>10초 퀴즈 · Q&amp;A · 답변 녹음</span></div><ArrowUpRight size={20}/></Link>
  <Link href={'/interview/chat'+suffix}><MessagesSquare size={25} strokeWidth={1.5}/><div className={ownedClassName(undefined,true)}><h2 className={ownedClassName(undefined,true)}>Chat 면접</h2><p className={ownedClassName(undefined,true)}>글로 답하고 꼬리질문 이어가기</p><span className={ownedClassName(undefined,true)}>질문별 답변 · 피드백</span></div><ArrowUpRight size={20}/></Link>
  <Link href={'/interview/live'+suffix}><Mic size={25} strokeWidth={1.5}/><div className={ownedClassName(undefined,true)}><h2 className={ownedClassName(undefined,true)}>Live 면접</h2><p className={ownedClassName(undefined,true)}>질문을 듣고 내 목소리로 답하기</p><span className={ownedClassName(undefined,true)}>음성 답변 · 연결 질문</span></div><ArrowUpRight size={20}/></Link>
 </div>
 <Link className={ownedClassName(styles.experienceEntry)} href="/armory"><Library size={19} aria-hidden="true"/><span className={ownedClassName(undefined,true)}><strong className={ownedClassName(undefined,true)}>내 경험 정리</strong><span className={ownedClassName(undefined,true)}>내 경험에 모아 둔 이야기를 면접 답변으로 연결해요.</span></span><ArrowUpRight size={17} aria-hidden="true"/></Link>
 <FocusTraining key={targetId} targetId={targetId}/><div className={ownedClassName(styles.practiceLinks,true)}><Link href="/quiz/assignments"><ListChecks size={17}/>과제함<ArrowUpRight size={14}/></Link><Link href="/quiz/memory">복습할 질문<ArrowUpRight size={14}/></Link></div>
 <div className={ownedClassName(styles.openPaths,true)}><Link href="/knowledge">답에 더할 자료 찾기<ArrowUpRight size={15}/></Link><Link href="/records/comparisons">이전 답변과 비교하기<ArrowUpRight size={15}/></Link></div>
 </div>;
}
