'use client';

import Link from 'next/link';
import {useEffect, useRef, useState} from 'react';
import {ArrowUpRight, BookOpen, Newspaper, Pause, Play} from 'lucide-react';
import type {KnowledgeMatch} from '@/lib/knowledge-bites-catalog';
import type {DepartmentNewsData} from '@/lib/department-news-model';
import {useApp} from './app-shell';
import {api} from './shared';
import {ownedClassName} from './owned-class-name';
import styles from './learning-discovery.module.css';

type Preview = {id:string; title:string; source:string; href:string};
type Previews = {scope:string; knowledge:Preview[]; news:Preview[]};

/** The cards preview the same authenticated resources that their links open. */
export function LearningDiscovery({targetId}:{targetId?:string}){
 const {data, learningRevision=0}=useApp();
 const scope=JSON.stringify([data.user?.id,targetId,learningRevision,data.package?.active_version]);
 const [previews,setPreviews]=useState<Previews>({scope:'',knowledge:[],news:[]});
 const knowledgeHref='/knowledge'+(targetId?'?targetId='+encodeURIComponent(targetId):'');
 useEffect(()=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  setPreviews({scope,knowledge:[],news:[]});
  const suffix=targetId?'?targetId='+encodeURIComponent(targetId):'';
  void api<{videos:KnowledgeMatch[]}>('/api/knowledge-bites'+suffix,{signal:controller.signal}).then(result=>{
   if(controller.signal.aborted)return;
   const knowledge=(result.videos||[]).filter(item=>item.current).slice(0,8).map(item=>({id:item.id,title:item.label||item.title,source:item.channel,href:`/knowledge/${encodeURIComponent(item.id)}${suffix}`}));
   setPreviews(previous=>previous.scope===scope?{...previous,knowledge}:previous);
  }).catch(()=>{/* The resource link stays available when its preview is offline. */});
  const news=async(attempt=0)=>{
   try{
    const result=await api<DepartmentNewsData&{refreshPending?:boolean;refreshDue?:boolean}>('/api/news'+suffix,{signal:controller.signal});
    if(controller.signal.aborted)return;
    setPreviews(previous=>previous.scope===scope?{...previous,news:(result.articles||[]).slice(0,8).map(item=>({id:item.id,title:item.title,source:item.publisher,href:`/materials/briefings/news/${encodeURIComponent(item.id)}`}))}:previous);
    if((result.refreshPending||result.refreshDue)&&attempt<3)timer=setTimeout(()=>{void news(attempt+1);},[1500,2500,8000][attempt]);
   }catch{/* A delayed publisher must not block training or its other card. */}
  };
  void news();
  return()=>{controller.abort();if(timer)clearTimeout(timer);};
 },[scope,targetId]);
 const current=previews.scope===scope?previews:{knowledge:[],news:[]};
 return <nav className={ownedClassName(styles.entries,true)} aria-label="개념과 시사">
  <ResourcePreview key={`knowledge:${scope}`} label="지식한입" href={knowledgeHref} fallback="학과·활동 개념" items={current.knowledge} kind="knowledge"/>
  <ResourcePreview key={`news:${scope}`} label="시사 브리핑" href="/materials/briefings" fallback="전공 관련 이슈" items={current.news} kind="news"/>
 </nav>;
}

function ResourcePreview({label,href,fallback,items,kind}:{label:string;href:string;fallback:string;items:Preview[];kind:'knowledge'|'news'}){
 const root=useRef<HTMLElement|null>(null);
 const [step,setStep]=useState(0),[paused,setPaused]=useState(false),[hovered,setHovered]=useState(false),[focused,setFocused]=useState(false);
 const [visible,setVisible]=useState(false),[reduced,setReduced]=useState(true),[pageVisible,setPageVisible]=useState(true);
 useEffect(()=>{
  const motion=window.matchMedia('(prefers-reduced-motion: reduce)');
  const syncMotion=()=>setReduced(motion.matches),syncPage=()=>setPageVisible(!document.hidden);
  syncMotion();syncPage();motion.addEventListener('change',syncMotion);document.addEventListener('visibilitychange',syncPage);
  const observer=typeof IntersectionObserver==='undefined'?null:new IntersectionObserver(entries=>setVisible(entries.some(entry=>entry.isIntersecting)),{threshold:.15});
  if(observer&&root.current)observer.observe(root.current);else setVisible(true);
  return()=>{motion.removeEventListener('change',syncMotion);document.removeEventListener('visibilitychange',syncPage);observer?.disconnect();};
 },[]);
 useEffect(()=>{
  if(items.length<2||paused||hovered||focused||reduced||!visible||!pageVisible)return;
  const timer=setInterval(()=>setStep(value=>value+1),3600);return()=>clearInterval(timer);
 },[items.length,paused,hovered,focused,reduced,visible,pageVisible]);
 const current=items[step%Math.max(1,items.length)],previous=step>0?items[(step-1)%Math.max(1,items.length)]:null;
 const Icon=kind==='knowledge'?BookOpen:Newspaper;
 return <section ref={root} className={ownedClassName(`${styles.entry} ${kind==='news'?styles.news:styles.knowledge}`,true)} aria-label={label} onMouseEnter={()=>setHovered(true)} onMouseLeave={()=>setHovered(false)} onFocusCapture={()=>setFocused(true)} onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget))setFocused(false);}}>
  <div className={ownedClassName(styles.entryHeading,true)}><Link href={href} className={ownedClassName(styles.headingLink)}><Icon size={20} aria-hidden="true"/><strong className={ownedClassName(undefined,true)}>{label}</strong><ArrowUpRight size={15} aria-hidden="true"/></Link>{items.length>1&&!reduced&&<button type="button" className={ownedClassName(styles.motionControl,true)} onClick={()=>setPaused(value=>!value)} aria-pressed={paused} aria-label={`${label} 자동 전환 ${paused?'재생':'일시정지'}`}>{paused?<Play size={13} aria-hidden="true"/>:<Pause size={13} aria-hidden="true"/>}</button>}</div>
  {current?<div className={ownedClassName(styles.preview,true)} aria-live="off" key={step}>
   {previous&&!reduced&&<div className={ownedClassName(styles.previous,true)} aria-hidden="true"><span className={ownedClassName(styles.previewTitle,true)}>{previous.title}</span><span className={ownedClassName(styles.source,true)}>{previous.source}</span></div>}
   <Link className={ownedClassName(`${styles.current} ${step>0?styles.entering:''}`)} href={current.href}><span className={ownedClassName(styles.previewTitle,true)}>{current.title}</span><span className={ownedClassName(styles.source,true)}>{current.source}</span></Link>
  </div>:<Link className={ownedClassName(styles.fallback)} href={href}>{fallback}</Link>}
 </section>;
}
