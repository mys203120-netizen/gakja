'use client';
import {ownedClassName} from './owned-class-name';

import {useEffect,useRef} from 'react';
import {interviewerPortrait} from '@/lib/interviewer-portraits';
import type {InterviewerAvatarSignal} from '@/lib/client/interviewer-avatar';
import {Live2DInterviewer} from './live2d-interviewer';
import {PortraitMouth} from './portrait-mouth';
import {PortraitExpression} from './portrait-expression';
import type {Item} from './shared';
import styles from './interviewer-character.module.css';

/** Stable adult identity; measured interviewer output animates only the original mouth region. */
export function Interviewer({person,speaking=false,compact=false,listening=false,pending=false,portraitIndex,avatarSignal}:{person:Item;speaking?:boolean;compact?:boolean;listening?:boolean;pending?:boolean;portraitIndex?:number;avatarSignal?:InterviewerAvatarSignal}) {
  const root=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(!avatarSignal)return;return avatarSignal.subscribe(frame=>{const element=root.current;if(!element)return;const current=frame.speakerId===String(person.id||'');element.dataset.avatarState=current?frame.state:frame.state==='listening'?'listening':'idle';element.dataset.dimmed=String(!current&&frame.state==='speaking'&&frame.mouthOpen>.025);element.style.setProperty('--interviewer-output',String(current&&frame.state==='speaking'?frame.mouthOpen:0));});},[avatarSignal,person.id]);
  const portrait=interviewerPortrait(String(person.id||''),portraitIndex);
  const status=speaking?'질문 중':listening?'듣는 중':pending?'답변 확인 중':'함께 준비해요';
  return <div ref={root} className={ownedClassName(`interviewer-avatar ${styles.avatar} ${compact?'compact':''}`,true)} data-portrait={portrait.id} data-speaking={speaking||undefined}>
    <div className={ownedClassName(styles.portraitFrame,true)}>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img className={ownedClassName(styles.portrait,true)} src={portrait.src} width={640} height={640} alt={`${person.name||'면접관'}의 클레이 3D 캐릭터`} decoding="async" draggable={false}/>
    {avatarSignal&&<PortraitExpression portraitId={portrait.id} src={portrait.src} personId={String(person.id||'')} signal={avatarSignal}/>}
    {avatarSignal&&<PortraitMouth portraitId={portrait.id} src={portrait.src} personId={String(person.id||'')} signal={avatarSignal}/>}
    {avatarSignal&&process.env.NEXT_PUBLIC_LIVE2D_ENABLED==='true'&&<Live2DInterviewer index={portraitIndex??0} personId={String(person.id||'')} signal={avatarSignal}/>}
    </div>
    {!compact&&<div className={ownedClassName(styles.identity,true)}><strong className={ownedClassName(undefined,true)}>{person.name}</strong><span aria-live="polite" className={ownedClassName(undefined,true)}>{status}</span></div>}
  </div>;
}
