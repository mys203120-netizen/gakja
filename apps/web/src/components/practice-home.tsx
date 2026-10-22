'use client';
import {ownedClassName} from './owned-class-name';

import Link from 'next/link';
import {ArrowUpRight,MessagesSquare,Mic,Sparkles,ListChecks,Library} from 'lucide-react';
import {useApp} from './app-shell';
import {splitInterviewsByLearningTarget} from '@/lib/learning-target-scope';
import styles from './navigation-rail.module.css';
import {FocusTraining} from './focus-training';
import {TrainingHeader} from './training-hub';
import {LearningDiscovery} from './learning-discovery';

export function PracticeHome(){
 const {data,target,targetId}=useApp(),suffix=targetId?'?targetId='+encodeURIComponent(targetId):'';
 const sessions=splitInterviewsByLearningTarget(data.interviews||[],target).current.filter(row=>row.state==='active');
 const active=sessions[0];
 const resumeHref=active?.data?.trainingPlanId?'/my/train?planId='+encodeURIComponent(active.data.trainingPlanId):active?`/interview/${active.id}?kind=${active.kind}`:null;
 return <div className={ownedClassName('practice-home '+styles.practiceHome,true)}><TrainingHeader title="자유 연습"/>
 {active&&<div className={ownedClassName(styles.resume,true)}><span className={ownedClassName(undefined,true)}>{active.data?.trainingPlanId?'진행 중인 훈련':'진행 중인 면접'}</span><Link href={resumeHref!}>이어 하기<ArrowUpRight size={16}/></Link></div>}
 <div className={ownedClassName(styles.practiceChoices,true)}>
  <Link href={'/quiz'+suffix}><Sparkles size={25} strokeWidth={1.5}/><div className={ownedClassName(undefined,true)}><h2 className={ownedClassName(undefined,true)}>퀴즈</h2><p className={ownedClassName(undefined,true)}>선택하고, 떠올리고, 소리 내어 답하기</p></div><ArrowUpRight size={20}/></Link>
  <Link href={'/interview/chat'+suffix}><MessagesSquare size={25} strokeWidth={1.5}/><div className={ownedClassName(undefined,true)}><h2 className={ownedClassName(undefined,true)}>Chat 면접</h2><p className={ownedClassName(undefined,true)}>글로 답하고 꼬리질문 이어가기</p></div><ArrowUpRight size={20}/></Link>
  <Link href={'/interview/live'+suffix}><Mic size={25} strokeWidth={1.5}/><div className={ownedClassName(undefined,true)}><h2 className={ownedClassName(undefined,true)}>Live 면접</h2><p className={ownedClassName(undefined,true)}>질문을 듣고 내 목소리로 답하기</p></div><ArrowUpRight size={20}/></Link>
 </div>
 <LearningDiscovery targetId={targetId}/>
 <Link className={ownedClassName(styles.experienceEntry)} href="/armory"><Library size={19} aria-hidden="true"/><span className={ownedClassName(undefined,true)}><strong className={ownedClassName(undefined,true)}>내 경험 정리</strong></span><ArrowUpRight size={17} aria-hidden="true"/></Link>
 <FocusTraining key={targetId} targetId={targetId}/><div className={ownedClassName(styles.practiceLinks,true)}><Link href="/quiz/assignments"><ListChecks size={17}/>과제함<ArrowUpRight size={14}/></Link><Link href="/quiz/memory">복습할 질문<ArrowUpRight size={14}/></Link></div>
 <div className={ownedClassName(styles.openPaths,true)}><Link href="/records/comparisons">이전 답변과 비교하기<ArrowUpRight size={15}/></Link></div>
 </div>;
}
