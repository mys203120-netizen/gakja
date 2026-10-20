'use client';
import {ownedClassName} from './owned-class-name';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Sparkles, X } from 'lucide-react';
import { useApp } from './app-shell';
import { Alert, api, post, type Item } from './shared';
import { ChatComposer } from './chat-composer';
import { MarkdownMessage } from './markdown-message';
type HelpProps={questionId?:string;activityId?:string;targetId?:string;quizSessionId?:string;itemIndex?:number;assignmentId?:string;itemId?:string;sourceType?:'personal'|'common';sourceVersion?:number|string;snapshot?:{learning:Item;documents:Item[]};openRequest?:number;onAssisted?:()=>void|Promise<void>};
export function LearningHelp(props:HelpProps) {
  const {data,targetId,openResource}=useApp(),[open,setOpen]=useState(false),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  useEffect(()=>{if((props.openRequest||0)>0)setOpen(true);},[props.openRequest]);
  const close=useCallback(()=>setOpen(false),[]);
  async function evidence(){
    setLoading(true);setError('');
    try {let snapshot=props.snapshot;if(!snapshot){const p=new URLSearchParams();if(props.questionId)p.set('questionId',props.questionId);if(props.activityId)p.set('activityId',props.activityId);if(props.targetId||targetId)p.set('targetId',props.targetId||targetId);if(props.sourceVersion)p.set('sourceVersion',String(props.sourceVersion));if(props.sourceType)p.set('sourceType',props.sourceType);snapshot=await api('/api/learning-help?'+p.toString());}if(props.quizSessionId)await post('/api/quiz',{action:'assist',sessionId:props.quizSessionId,itemIndex:props.itemIndex,helpKind:'evidence'});if(props.assignmentId&&props.itemId)await post('/api/learning',{action:'assignment_help',assignmentId:props.assignmentId,itemId:props.itemId,helpKind:'evidence',requestId:crypto.randomUUID()});await props.onAssisted?.();openResource({kind:props.questionId?'question':'activity',id:props.questionId||props.activityId,snapshot});}
    catch(err){setError((err as Error).message);}finally{setLoading(false);}
  }
  if(!props.questionId&&!props.activityId)return null;
  return <div className={ownedClassName("learning-help",true)}><div className={ownedClassName("learning-help-tools",true)}><button className={ownedClassName("text-link",true)} disabled={loading} onClick={evidence}><BookOpen size={15}/>{loading?'근거 불러오는 중':'질문과 근거'}</button><button className={ownedClassName("text-link",true)} onClick={()=>setOpen(true)}><Sparkles size={15}/>AI 도움</button></div>{error&&<Alert>{error}</Alert>}{open&&<Assistant key={`${data.user.id}:${props.questionId||props.activityId}:${props.quizSessionId||props.assignmentId||''}:${props.itemIndex??props.itemId??''}`} {...props} onClose={close}/>}</div>;
}
function Assistant({onClose,...props}:HelpProps&{onClose:()=>void}) {
  const {data,targetId}=useApp();const selectedTarget=props.targetId||targetId;
  const key=`gakja-learning-help:${data.user.id}:${selectedTarget}:${props.quizSessionId||props.assignmentId||''}:${props.itemIndex??props.itemId??''}:${props.questionId||props.activityId}:${props.sourceType||'auto'}:${props.sourceVersion||'current'}`;
  const [message,setMessage]=useState(''),[messages,setMessages]=useState<Item[]>([]),[threadId,setThreadId]=useState<string>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loadedKey,setLoadedKey]=useState('');
  const dialog=useRef<HTMLElement>(null),lock=useRef(false),requestId=useRef(''),requestText=useRef('');
  useEffect(()=>{try{const saved=JSON.parse(sessionStorage.getItem(key)||'{}');setMessage(typeof saved.draft==='string'?saved.draft:'');setMessages(Array.isArray(saved.messages)?saved.messages:[]);setThreadId(typeof saved.threadId==='string'?saved.threadId:undefined);}catch{setMessage('');setMessages([]);setThreadId(undefined);}setLoadedKey(key);},[key]);
  useEffect(()=>{if(loadedKey===key)sessionStorage.setItem(key,JSON.stringify({draft:message,messages:messages.slice(-24),threadId}));},[key,loadedKey,message,messages,threadId]);
  useEffect(()=>{const old=document.activeElement as HTMLElement|null,overflow=document.body.style.overflow;document.body.style.overflow='hidden';dialog.current?.focus();function keyboard(e:KeyboardEvent){if(e.key==='Escape'&&!lock.current)onClose();if(e.key!=='Tab')return;const nodes=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),a[href],summary,[tabindex="0"]')||[]);if(!nodes.length){e.preventDefault();return;}if(e.shiftKey&&(document.activeElement===nodes[0]||document.activeElement===dialog.current)){e.preventDefault();nodes.at(-1)?.focus();}else if(!e.shiftKey&&(document.activeElement===nodes.at(-1)||document.activeElement===dialog.current)){e.preventDefault();nodes[0].focus();}}document.addEventListener('keydown',keyboard);return()=>{document.body.style.overflow=overflow;document.removeEventListener('keydown',keyboard);old?.focus();};},[onClose]);
  async function send(){
    const text=message.trim();if(!text||lock.current)return;lock.current=true;setBusy(true);setError('');
    if(requestText.current!==text){requestId.current=crypto.randomUUID();requestText.current=text;}
    try{
      const result=await post('/api/chat',{message:text,requestId:requestId.current,...(threadId?{threadId}:{}),questionId:props.questionId||null,activityId:props.activityId||null,targetId:selectedTarget||null,...(props.sourceType?{sourceType:props.sourceType}:{}),...(props.sourceVersion?{sourceVersion:Number(props.sourceVersion)}:{}),...(props.quizSessionId&&props.itemIndex!==undefined?{quizSessionId:props.quizSessionId,quizItemIndex:props.itemIndex}:{}),...(props.assignmentId&&props.itemId?{assignmentId:props.assignmentId,assignmentItemId:props.itemId}:{})});
      setThreadId(result.threadId);setMessages(prev=>{const known=new Set(prev.map(m=>m.id));return [...prev,...[result.userMessage,result.message].filter(m=>m&&!known.has(m.id))];});
      if(result.message?.status==='pending'){setError('앞선 응답을 작성 중이에요. 잠시 후 대화를 다시 불러와 주세요.');return;}
      if(result.message?.status==='failed')throw new Error(result.message?.data?.error||'답변을 가져오지 못했어요.');
      if(result.message?.role==='assistant'&&result.message.status==='completed'&&result.message.content?.trim()){await props.onAssisted?.();}
      setMessage('');requestId.current='';requestText.current='';
    }catch(err){setError((err as Error).message);}finally{lock.current=false;setBusy(false);}
  }
  async function reload(){if(!threadId||busy)return;setBusy(true);try{const r=await api('/api/chat?threadId='+encodeURIComponent(threadId));setMessages(r.messages);setError('');}catch(err){setError((err as Error).message);}finally{setBusy(false);}}
  return <div className={ownedClassName("learning-help-overlay",true)}><button className={ownedClassName("learning-help-backdrop",true)} tabIndex={-1} aria-label="도움 닫기" disabled={busy} onClick={onClose}/><section className={ownedClassName("learning-help-panel",true)} role="dialog" aria-modal="true" aria-label="AI 도움" tabIndex={-1} ref={dialog}><header className={ownedClassName(undefined,true)}><div className={ownedClassName(undefined,true)}><span className={ownedClassName(undefined,true)}>AI 도움</span><h2 className={ownedClassName(undefined,true)}>이 질문에서 이어가요.</h2></div><button className={ownedClassName("icon-button",true)} aria-label="AI 도움 닫기" disabled={busy} onClick={onClose}><X size={20}/></button></header><div className={ownedClassName("learning-help-messages",true)} aria-live="polite" aria-busy={busy}>{!messages.length&&<p className={ownedClassName("muted",true)}>내 답을 다듬거나 연결된 근거를 물어보세요.</p>}{messages.map(m=><article key={m.id} className={ownedClassName(m.role,true)}><strong className={ownedClassName(undefined,true)}>{m.role==='assistant'?'각자ON':'나'}</strong>{m.role==='assistant'&&m.content?<MarkdownMessage content={m.content}/>:<p className={ownedClassName(undefined,true)}>{m.content|| (m.status==='pending'?'응답을 작성 중이에요.':m.status==='failed'?'응답이 중단됐어요.':'')}</p>}{(m.sources||m.data?.sources||[]).map((s:Item,i:number)=><details key={`${s.id}:${i}`} className={ownedClassName(undefined,true)}><summary className={ownedClassName(undefined,true)}>{s.title||'답변 근거'}</summary><p className={ownedClassName(undefined,true)}>{s.quote||'연결한 자료의 근거입니다.'}</p></details>)}</article>)}{busy&&<p role="status" className={ownedClassName(undefined,true)}>답을 정리하고 있어요.</p>}</div>{error&&<Alert>{error}{threadId&&<button className={ownedClassName("text-link",true)} disabled={busy} onClick={reload}>대화 다시 불러오기</button>}</Alert>}<ChatComposer value={message} onChange={setMessage} onSend={send} label="AI 도움 메시지" placeholder="이 질문에 대해 물어보세요." maxLength={6000} busy={busy} disabled={loadedKey!==key}/><footer className={ownedClassName(undefined,true)}>닫으면 작성하던 답변으로 돌아가요.</footer></section></div>;
}

