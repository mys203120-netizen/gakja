'use client';
import {useEffect,useRef} from 'react';
import gsap from 'gsap';
import {reactionFace,reactionLabel,type InterviewerReaction} from '@/lib/interviewer-reaction';
import type {Item} from './shared';

export function Interviewer({person,speaking=false,compact=false,listening=false,pending=false,reaction,receiptKey=''}:{person:Item;speaking?:boolean;compact?:boolean;listening?:boolean;pending?:boolean;reaction?:InterviewerReaction|null;receiptKey?:string}) {
  const root=useRef<HTMLDivElement>(null),lastReceipt=useRef(receiptKey);
  const female=person.gender!=='male',face=reactionFace(listening||pending?null:reaction);
  useEffect(()=>{
    const media=gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)',()=>{
      if(!root.current||compact)return;
      const gesture=root.current.querySelector('.interviewer-gesture'),eyes=root.current.querySelector('.interviewer-eyes');
      const blink=gsap.to(eyes,{scaleY:.08,transformOrigin:'50% 50%',duration:.07,repeat:1,yoyo:true,repeatDelay:.02,paused:true});
      const interval=window.setInterval(()=>{if(!document.hidden)blink.restart();},4300+(String(person.id).charCodeAt(0)%4)*370);
      if(listening&&!pending&&!speaking)gsap.to(gesture,{y:1.5,rotation:-.6,transformOrigin:'90px 92px',duration:1.4,ease:'sine.inOut',repeat:-1,yoyo:true});
      if(receiptKey&&receiptKey!==lastReceipt.current&&!pending){gsap.fromTo(gesture,{y:0,rotation:0},{y:2,rotation:1.5,transformOrigin:'90px 92px',duration:.17,ease:'power2.inOut',repeat:1,yoyo:true});}
      return()=>{clearInterval(interval);};
    });
    if(receiptKey&&!pending)lastReceipt.current=receiptKey;
    return()=>media.revert();
  },[compact,listening,pending,speaking,receiptKey,person.id]);
  return <div ref={root} className={`interviewer-avatar ${speaking?'is-speaking':''} ${listening?'is-listening':''} ${compact?'compact':''}`} data-reaction-level={face.level} data-reaction-status={reaction?.status||'not_evaluated'}><svg viewBox="0 0 180 160" aria-hidden="true"><circle cx="90" cy="80" r="74" fill={female?'#f0e9df':'#e9edf1'}/><path d="M35 158c2-37 24-53 55-53s53 16 55 53" fill={female?'#4d5851':'#424e5b'}/><g className="interviewer-gesture"><g className="interviewer-head" style={{transform:`rotate(${face.headTilt}deg)`}}>{female&&<path d="M53 69c0-52 73-52 74 0v50H53Z" fill="#44362e"/>}<ellipse cx="90" cy="72" rx="29" ry="37" fill="#e4b895"/><path d={female?'M60 65c-7-41 62-48 62-1-10-1-18-13-20-22-9 17-27 22-42 23Z':'M61 59c-5-40 66-41 61 0-17-10-37-15-61 0Z'} fill="#44362e"/><path className="interviewer-brows" d={`M73 ${face.browY}l9 ${face.browTilt}m18 ${-face.browTilt}l9 ${face.browTilt}`} stroke="#44362e" strokeWidth="2" strokeLinecap="round" fill="none"/><path className="interviewer-eyes" d={`M75 73h${face.eyeWidth}m${27-face.eyeWidth} 0h${face.eyeWidth}`} stroke="#3a3029" strokeWidth="4" strokeLinecap="round"/><path d="M89 76v10h5" stroke="#be8b6e" fill="none" strokeWidth="2" strokeLinecap="round"/><path className="interviewer-mouth" d={`M82 95q8 ${face.mouthCurve} 16 0`} stroke="#8e4e43" strokeWidth="3" fill="none" strokeLinecap="round"/></g></g><path d="m72 112 18 16 18-16" fill="#f9faf8"/></svg>{!compact&&<div><strong>{person.name}</strong><span aria-live="polite">{speaking?'질문 중':listening?'듣는 중':pending?'답변 확인 중':reactionLabel(reaction)}</span></div>}</div>;
}
