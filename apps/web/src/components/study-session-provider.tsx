'use client';
import { useEffect, type ReactNode } from 'react';
import {animateStudyReceipt} from './playful-flow';
let currentSessionId = '';
let finishing = false;
let pendingHeartbeat: Promise<void> | null = null;
const channel = 'gakja:study-session';

export async function finishStudySession(reason: 'manual'|'logout'='manual', expectedSessionId?:string) {
  const origin=document.activeElement?.getBoundingClientRect();
  finishing = true;
  try {
    if(pendingHeartbeat) await pendingHeartbeat;
    if(!currentSessionId) {
      const response=await fetch('/api/study-sessions',{cache:'no-store'});
      if(!response.ok) throw new Error('학습 기록을 불러오지 못했어요.');
      const result=await response.json();currentSessionId=result.current?.id||'';
    }
    if(!currentSessionId&&!expectedSessionId) return null;
    const id=expectedSessionId||currentSessionId;
    const response=await fetch('/api/study-sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'finish',reason,sessionId:id})});
    const result=await response.json();if(!response.ok) throw new Error(result.error||'학습 기록을 저장하지 못했어요.');
    if(id===currentSessionId) currentSessionId='';if(reason==='manual'&&result.session)animateStudyReceipt(origin);window.dispatchEvent(new Event(channel));return result.session;
  } finally {finishing=false;}
}

export function StudySessionProvider({userId,children}:{userId:string;children:ReactNode}) {
  useEffect(()=>{
    currentSessionId='';
    const key=`gakja-study-tab:${userId}`;
    // Per mounted document identity: duplicated tabs must not share a lease.
    const tabId=crypto.randomUUID();sessionStorage.setItem(key,tabId);
    let disposed=false;
    const heartbeat=()=>{
      if(finishing||pendingHeartbeat||disposed)return;
      pendingHeartbeat=fetch('/api/study-sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'heartbeat',tabId})}).then(async response=>{
        if(!response.ok)return;const result=await response.json();if(!disposed)currentSessionId=result.sessionId||'';
      }).catch(()=>{}).finally(()=>{pendingHeartbeat=null;});
    };
    const leave=()=>{
      const body=JSON.stringify({action:'leave',tabId});
      if(!navigator.sendBeacon('/api/study-sessions',new Blob([body],{type:'application/json'}))) void fetch('/api/study-sessions',{method:'POST',headers:{'Content-Type':'application/json'},body,keepalive:true}).catch(()=>{});
    };
    const visibility=()=>{if(document.visibilityState==='visible')heartbeat();};
    heartbeat();const timer=window.setInterval(heartbeat,30_000);
    window.addEventListener('pagehide',leave);window.addEventListener('pageshow',heartbeat);window.addEventListener('online',heartbeat);document.addEventListener('visibilitychange',visibility);
    return()=>{disposed=true;clearInterval(timer);window.removeEventListener('pagehide',leave);window.removeEventListener('pageshow',heartbeat);window.removeEventListener('online',heartbeat);document.removeEventListener('visibilitychange',visibility);};
  },[userId]);
  return children;
}
