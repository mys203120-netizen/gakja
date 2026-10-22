'use client';
import {ownedClassName} from './owned-class-name';

import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowLeft,BookOpen,Sparkles,X} from 'lucide-react';
import {useApp} from './app-shell';
import {Alert,api,post,type Item} from './shared';
import {ChatComposer} from './chat-composer';
import {MarkdownMessage} from './markdown-message';
import styles from './learning-help.module.css';

export type LearningHelpProps={
  questionId?:string;activityId?:string;targetId?:string;quizSessionId?:string;itemIndex?:number;
  assignmentId?:string;itemId?:string;interviewSessionId?:string;interviewTurnId?:string;
  sourceType?:'personal'|'common';sourceVersion?:number|string;snapshot?:{learning:Item;documents:Item[]};
  questionPrompt?:string;answerDraft?:string;openRequest?:number;disabled?:boolean;showEvidence?:boolean;
  beforeOpen?:()=>boolean|void|Promise<boolean|void>;onClose?:()=>void|Promise<void>;onAssisted?:()=>void|Promise<void>;
};

/** A sheet keeps the answer editor and recorder mounted under the exact owned attempt. */
export function LearningHelp(props:LearningHelpProps){
  const {data,targetId,openResource}=useApp();
  const scope=[data.user.id,props.targetId||targetId,props.interviewSessionId||props.quizSessionId||props.assignmentId||'',props.interviewTurnId??props.itemIndex??props.itemId??'',props.questionId||props.activityId,props.sourceType||'auto',props.sourceVersion||'current'].join(':');
  const scopeRef=useRef({key:scope});if(scopeRef.current.key!==scope)scopeRef.current={key:scope};const scopeToken=scopeRef.current;
  const [openedScope,setOpenedScope]=useState<object|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const opening=useRef<object|null>(null),requested=useRef(0),latest=useRef(props);latest.current=props;
  useEffect(()=>{setError('');setLoading(false);},[scopeToken]);
  async function prepare(){
    const capture=scopeRef.current;if(opening.current===capture||latest.current.disabled)return null;
    opening.current=capture;setLoading(true);setError('');
    try{return await latest.current.beforeOpen?.()!==false&&scopeRef.current===capture?capture:null;}
    catch(cause){if(scopeRef.current===capture)setError((cause as Error).message||'작성 중인 답변을 확인한 뒤 다시 열어 주세요.');return null;}
    finally{if(opening.current===capture)opening.current=null;if(scopeRef.current===capture)setLoading(false);}
  }
  async function openHelp(){const capture=await prepare();if(capture&&scopeRef.current===capture)setOpenedScope(capture);}
  useEffect(()=>{const token=props.openRequest||0;if(token>requested.current){requested.current=token;void openHelp();}},[props.openRequest]);
  const close=useCallback(()=>{const capture=scopeRef.current;setOpenedScope(null);void Promise.resolve().then(()=>{if(scopeRef.current===capture)return latest.current.onClose?.();}).catch(cause=>{if(scopeRef.current===capture)setError(cause.message);});},[]);
  async function evidence(){
    const capture=await prepare();if(!capture)return;
    setLoading(true);setError('');
    try{
      let snapshot=props.snapshot;
      if(!snapshot){
        const query=new URLSearchParams();
        if(props.interviewSessionId&&props.interviewTurnId){query.set('interviewSessionId',props.interviewSessionId);query.set('interviewTurnId',props.interviewTurnId);}
        else if(props.quizSessionId&&props.itemIndex!==undefined){query.set('quizSessionId',props.quizSessionId);query.set('quizItemIndex',String(props.itemIndex));}
        else{
          if(props.questionId)query.set('questionId',props.questionId);if(props.activityId)query.set('activityId',props.activityId);
          if(props.targetId||targetId)query.set('targetId',props.targetId||targetId);
          if(props.sourceVersion)query.set('sourceVersion',String(props.sourceVersion));if(props.sourceType)query.set('sourceType',props.sourceType);
        }
        snapshot=await api('/api/learning-help?'+query.toString());
      }
      if(scopeRef.current!==capture)return;
      if(props.interviewSessionId&&props.interviewTurnId)await post('/api/interviews',{action:'help',sessionId:props.interviewSessionId,turnId:props.interviewTurnId,helpKind:'evidence',requestId:crypto.randomUUID()});
      if(props.quizSessionId)await post('/api/quiz',{action:'assist',sessionId:props.quizSessionId,itemIndex:props.itemIndex,helpKind:'evidence'});
      if(props.assignmentId&&props.itemId)await post('/api/learning',{action:'assignment_help',assignmentId:props.assignmentId,itemId:props.itemId,helpKind:'evidence',requestId:crypto.randomUUID()});
      if(scopeRef.current!==capture)return;
      await props.onAssisted?.();if(scopeRef.current!==capture)return;openResource({kind:props.questionId?'question':'activity',id:props.questionId||props.activityId,snapshot});
    }catch(cause){if(scopeRef.current===capture)setError((cause as Error).message);}finally{if(scopeRef.current===capture)setLoading(false);}
  }
  if(!props.questionId&&!props.activityId&&!props.interviewTurnId)return null;
  return <div className={ownedClassName('learning-help',true)}>
    <div className={ownedClassName('learning-help-tools',true)}>
      {props.showEvidence!==false&&<button type="button" className={ownedClassName('text-link',true)} disabled={loading||props.disabled} onClick={()=>void evidence()}><BookOpen size={15}/>{loading?'근거 불러오는 중':'질문과 근거'}</button>}
      <button type="button" className={ownedClassName('text-link',true)} disabled={loading||props.disabled} onClick={()=>void openHelp()}><Sparkles size={15}/>AI 비서 도움받기</button>
    </div>
    {error&&<Alert>{error}</Alert>}
    {openedScope===scopeToken&&<Assistant key={scope} {...props} scope={scope} onClose={close}/>}
  </div>;
}

function Assistant({onClose,scope,...props}:LearningHelpProps&{scope:string;onClose:()=>void}){
  const {data,targetId}=useApp();const selectedTarget=props.targetId||targetId;
  const key='gakja-learning-help:'+scope;
  const visitRef=useRef({key,active:false});if(visitRef.current.key!==key)visitRef.current={key,active:false};const visit=visitRef.current;
  useEffect(()=>{visit.active=true;return()=>{visit.active=false;};},[visit]);
  const [message,setMessage]=useState(''),[messages,setMessages]=useState<Item[]>([]),[threadId,setThreadId]=useState<string>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loadedKey,setLoadedKey]=useState('');
  const dialog=useRef<HTMLElement>(null),lock=useRef(false),requestId=useRef(''),requestText=useRef(''),requestDraft=useRef('');
  useEffect(()=>{
    lock.current=false;setBusy(false);requestId.current='';requestText.current='';requestDraft.current='';
    try{
      const saved=JSON.parse(sessionStorage.getItem(key)||'{}');setMessage(typeof saved.draft==='string'?saved.draft:'');setMessages(Array.isArray(saved.messages)?saved.messages:[]);setThreadId(typeof saved.threadId==='string'?saved.threadId:undefined);
      if(typeof saved.request?.id==='string'&&saved.request.id.length>=8&&saved.request.id.length<=100&&typeof saved.request.text==='string'&&saved.request.text.length<=6000&&typeof saved.request.draft==='string'&&typeof saved.draft==='string'&&saved.request.draft===saved.draft.trim()){requestId.current=saved.request.id;requestText.current=saved.request.text;requestDraft.current=saved.request.draft;}
    }catch{setMessage('');setMessages([]);setThreadId(undefined);}setLoadedKey(key);
  },[key]);
  function persist(){try{sessionStorage.setItem(key,JSON.stringify({draft:message,messages:messages.slice(-24),threadId,...(requestId.current?{request:{id:requestId.current,text:requestText.current,draft:requestDraft.current}}:{})}));}catch{/* Server receipts remain authoritative when browser storage is unavailable. */}}
  useEffect(()=>{if(loadedKey===key)persist();},[key,loadedKey,message,messages,threadId,busy]);
  useEffect(()=>{
    const old=document.activeElement as HTMLElement|null,overflow=document.body.style.overflow;document.body.style.overflow='hidden';dialog.current?.focus();
    function keyboard(event:KeyboardEvent){
      if(event.key==='Escape'&&!lock.current)onClose();if(event.key!=='Tab')return;
      const nodes=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),a[href],summary,[tabindex="0"]')||[]);
      if(!nodes.length){event.preventDefault();return;}
      if(event.shiftKey&&(document.activeElement===nodes[0]||document.activeElement===dialog.current)){event.preventDefault();nodes.at(-1)?.focus();}
      else if(!event.shiftKey&&(document.activeElement===nodes.at(-1)||document.activeElement===dialog.current)){event.preventDefault();nodes[0].focus();}
    }
    document.addEventListener('keydown',keyboard);return()=>{document.body.style.overflow=overflow;document.removeEventListener('keydown',keyboard);old?.focus();};
  },[onClose]);
  async function send(){
    const capture=visit,current=()=>visitRef.current===capture&&capture.active;
    const text=message.trim();if(!current()||loadedKey!==key||!text||lock.current)return;lock.current=true;setBusy(true);setError('');
    const context=[props.questionPrompt?`현재 연습 중인 질문: ${props.questionPrompt}`:'',props.answerDraft?.trim()?`학생이 아직 제출하지 않은 초안: ${props.answerDraft}`:''].filter(Boolean).join('\n');
    const available=Math.max(0,6000-text.length-40),excerpt=context.slice(0,available);
    if(!requestId.current||requestDraft.current!==text){requestId.current=crypto.randomUUID();requestText.current=excerpt?`${excerpt}\n\n이 질문에 대한 도움 요청: ${text}`:text;requestDraft.current=text;}
    const payloadMessage=requestText.current;persist();
    try{
      // Interview sessions resolve question, support target and version from their frozen server context.
      const selection=props.interviewSessionId&&props.interviewTurnId?{interviewSessionId:props.interviewSessionId,interviewTurnId:props.interviewTurnId}:{questionId:props.questionId||null,activityId:props.activityId||null,targetId:selectedTarget||null,...(props.sourceType?{sourceType:props.sourceType}:{}),...(props.sourceVersion?{sourceVersion:Number(props.sourceVersion)}:{})};
      const result=await post('/api/chat',{message:payloadMessage,requestId:requestId.current,...(threadId?{threadId}:{}),...selection,...(props.quizSessionId&&props.itemIndex!==undefined?{quizSessionId:props.quizSessionId,quizItemIndex:props.itemIndex}:{}),...(props.assignmentId&&props.itemId?{assignmentId:props.assignmentId,assignmentItemId:props.itemId}:{})});
      if(!current())return;
      setThreadId(result.threadId);setMessages(previous=>{const merged=new Map(previous.map(item=>[item.id,item]));for(const item of [result.userMessage,result.message])if(item)merged.set(item.id,{...merged.get(item.id),...item});return [...merged.values()];});
      if(result.message?.status==='pending'){setError('앞선 응답을 작성 중이에요. 잠시 후 대화를 다시 불러와 주세요.');return;}
      if(result.message?.status==='failed')throw new Error(result.message?.data?.error||'답변을 가져오지 못했어요.');
      if(result.message?.role==='assistant'&&result.message.status==='completed'&&result.message.content?.trim())await props.onAssisted?.();
      if(!current())return;
      setMessage('');requestId.current='';requestText.current='';requestDraft.current='';
    }catch(cause){if(current())setError((cause as Error).message);}finally{if(current()){lock.current=false;setBusy(false);}}
  }
  async function reload(){
    const capture=visit,current=()=>visitRef.current===capture&&capture.active;
    if(!current()||!threadId||busy||lock.current)return;lock.current=true;setBusy(true);
    try{
      const result=await api('/api/chat?threadId='+encodeURIComponent(threadId));if(!current())return;
      setMessages(result.messages);setError('');
      if(result.messages?.some((item:Item)=>item.role==='assistant'&&item.status==='completed'&&item.content?.trim()))await props.onAssisted?.();
    }catch(cause){if(current())setError((cause as Error).message);}
    finally{if(current()){lock.current=false;setBusy(false);}}
  }
  return <div className={ownedClassName('learning-help-overlay',true)}>
    <button className={ownedClassName('learning-help-backdrop',true)} tabIndex={-1} aria-label="도움 닫기" disabled={busy} onClick={onClose}/>
    <section className={ownedClassName('learning-help-panel',true)} role="dialog" aria-modal="true" aria-label="AI 비서 도움" tabIndex={-1} ref={dialog}>
      <header className={ownedClassName(undefined,true)}><div className={ownedClassName(undefined,true)}><span className={ownedClassName(undefined,true)}>AI 비서</span><h2 className={ownedClassName(undefined,true)}>이 질문에서 이어가요.</h2></div><button type="button" className={ownedClassName('icon-button',true)} aria-label="AI 도움 닫기" disabled={busy} onClick={onClose}><X size={20}/></button></header>
      {props.questionPrompt&&<details className={styles.question}><summary>지금 연습하는 질문</summary><p>{props.questionPrompt}</p>{props.answerDraft?.trim()&&<><strong>작성 중인 내 답변</strong><p>{props.answerDraft}</p></>}</details>}
      <div className={ownedClassName('learning-help-messages',true)} aria-live="polite" aria-busy={busy}>
        {!messages.length&&<p className={ownedClassName('muted',true)}>어디서 막혔는지 물어보세요. 도움은 현재 질문의 기록에 연결해요.</p>}
        {messages.map(item=><article key={item.id} className={ownedClassName(item.role,true)}><strong className={ownedClassName(undefined,true)}>{item.role==='assistant'?'각자ON':'나'}</strong>{item.role==='assistant'&&item.content?<MarkdownMessage content={item.content}/>:<p className={ownedClassName(undefined,true)}>{item.content||(item.status==='pending'?'응답을 작성 중이에요.':item.status==='failed'?'응답이 중단됐어요.':'')}</p>}{(item.sources||item.data?.sources||[]).map((source:Item,index:number)=><details key={`${source.id}:${index}`} className={ownedClassName(undefined,true)}><summary className={ownedClassName(undefined,true)}>{source.title||'답변 근거'}</summary><p className={ownedClassName(undefined,true)}>{source.quote||'연결한 자료의 근거입니다.'}</p></details>)}</article>)}
        {busy&&<p role="status" className={ownedClassName(undefined,true)}>답을 정리하고 있어요.</p>}
      </div>
      {error&&<Alert>{error}{threadId&&<button className={ownedClassName('text-link',true)} disabled={busy} onClick={()=>void reload()}>대화 다시 불러오기</button>}</Alert>}
      <ChatComposer enterToSend={data.preferences?.enterToSend!==false} value={message} onChange={setMessage} onSend={send} label="AI 도움 메시지" placeholder="이 질문에 대해 물어보세요." maxLength={6000} busy={busy} disabled={loadedKey!==key}/>
      <footer className={styles.footer}><button type="button" className={ownedClassName('button secondary',true)} disabled={busy} onClick={onClose}><ArrowLeft size={16}/>같은 질문으로 돌아가기</button></footer>
    </section>
  </div>;
}
