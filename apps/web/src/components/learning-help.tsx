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
  const [open,setOpen]=useState(false),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const opening=useRef(false),requested=useRef(0),latest=useRef(props);latest.current=props;
  async function prepare(){
    if(opening.current||latest.current.disabled)return false;
    opening.current=true;setLoading(true);setError('');
    try{return await latest.current.beforeOpen?.()!==false;}
    catch(cause){setError((cause as Error).message||'작성 중인 답변을 확인한 뒤 다시 열어 주세요.');return false;}
    finally{opening.current=false;setLoading(false);}
  }
  async function openHelp(){if(await prepare())setOpen(true);}
  useEffect(()=>{const token=props.openRequest||0;if(token>requested.current){requested.current=token;void openHelp();}},[props.openRequest]);
  const close=useCallback(()=>{setOpen(false);void Promise.resolve().then(()=>latest.current.onClose?.()).catch(cause=>setError(cause.message));},[]);
  async function evidence(){
    if(!await prepare())return;
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
      if(props.interviewSessionId&&props.interviewTurnId)await post('/api/interviews',{action:'help',sessionId:props.interviewSessionId,turnId:props.interviewTurnId,helpKind:'evidence',requestId:crypto.randomUUID()});
      if(props.quizSessionId)await post('/api/quiz',{action:'assist',sessionId:props.quizSessionId,itemIndex:props.itemIndex,helpKind:'evidence'});
      if(props.assignmentId&&props.itemId)await post('/api/learning',{action:'assignment_help',assignmentId:props.assignmentId,itemId:props.itemId,helpKind:'evidence',requestId:crypto.randomUUID()});
      await props.onAssisted?.();openResource({kind:props.questionId?'question':'activity',id:props.questionId||props.activityId,snapshot});
    }catch(cause){setError((cause as Error).message);}finally{setLoading(false);}
  }
  if(!props.questionId&&!props.activityId&&!props.interviewTurnId)return null;
  const scope=[data.user.id,props.targetId||targetId,props.interviewSessionId||props.quizSessionId||props.assignmentId||'',props.interviewTurnId??props.itemIndex??props.itemId??'',props.questionId||props.activityId,props.sourceType||'auto',props.sourceVersion||'current'].join(':');
  return <div className={ownedClassName('learning-help',true)}>
    <div className={ownedClassName('learning-help-tools',true)}>
      {props.showEvidence!==false&&<button type="button" className={ownedClassName('text-link',true)} disabled={loading||props.disabled} onClick={()=>void evidence()}><BookOpen size={15}/>{loading?'근거 불러오는 중':'질문과 근거'}</button>}
      <button type="button" className={ownedClassName('text-link',true)} disabled={loading||props.disabled} onClick={()=>void openHelp()}><Sparkles size={15}/>AI 비서 도움받기</button>
    </div>
    {error&&<Alert>{error}</Alert>}
    {open&&<Assistant key={scope} {...props} scope={scope} onClose={close}/>}
  </div>;
}

function Assistant({onClose,scope,...props}:LearningHelpProps&{scope:string;onClose:()=>void}){
  const {data,targetId}=useApp();const selectedTarget=props.targetId||targetId;
  const key='gakja-learning-help:'+scope;
  const [message,setMessage]=useState(''),[messages,setMessages]=useState<Item[]>([]),[threadId,setThreadId]=useState<string>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loadedKey,setLoadedKey]=useState('');
  const dialog=useRef<HTMLElement>(null),lock=useRef(false),requestId=useRef(''),requestText=useRef('');
  useEffect(()=>{try{const saved=JSON.parse(sessionStorage.getItem(key)||'{}');setMessage(typeof saved.draft==='string'?saved.draft:'');setMessages(Array.isArray(saved.messages)?saved.messages:[]);setThreadId(typeof saved.threadId==='string'?saved.threadId:undefined);}catch{setMessage('');setMessages([]);setThreadId(undefined);}setLoadedKey(key);},[key]);
  useEffect(()=>{if(loadedKey===key)try{sessionStorage.setItem(key,JSON.stringify({draft:message,messages:messages.slice(-24),threadId}));}catch{/* Server receipts remain authoritative when browser storage is unavailable. */}},[key,loadedKey,message,messages,threadId]);
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
    const text=message.trim();if(!text||lock.current)return;lock.current=true;setBusy(true);setError('');
    const context=[props.questionPrompt?`현재 연습 중인 질문: ${props.questionPrompt}`:'',props.answerDraft?.trim()?`학생이 아직 제출하지 않은 초안: ${props.answerDraft}`:''].filter(Boolean).join('\n');
    const available=Math.max(0,6000-text.length-40),excerpt=context.slice(0,available);
    const payloadMessage=excerpt?`${excerpt}\n\n이 질문에 대한 도움 요청: ${text}`:text;
    if(requestText.current!==payloadMessage){requestId.current=crypto.randomUUID();requestText.current=payloadMessage;}
    try{
      // Interview sessions resolve question, support target and version from their frozen server context.
      const selection=props.interviewSessionId&&props.interviewTurnId?{interviewSessionId:props.interviewSessionId,interviewTurnId:props.interviewTurnId}:{questionId:props.questionId||null,activityId:props.activityId||null,targetId:selectedTarget||null,...(props.sourceType?{sourceType:props.sourceType}:{}),...(props.sourceVersion?{sourceVersion:Number(props.sourceVersion)}:{})};
      const result=await post('/api/chat',{message:payloadMessage,requestId:requestId.current,...(threadId?{threadId}:{}),...selection,...(props.quizSessionId&&props.itemIndex!==undefined?{quizSessionId:props.quizSessionId,quizItemIndex:props.itemIndex}:{}),...(props.assignmentId&&props.itemId?{assignmentId:props.assignmentId,assignmentItemId:props.itemId}:{})});
      setThreadId(result.threadId);setMessages(previous=>{const known=new Set(previous.map(item=>item.id));return [...previous,...[result.userMessage,result.message].filter(item=>item&&!known.has(item.id))];});
      if(result.message?.status==='pending'){setError('앞선 응답을 작성 중이에요. 잠시 후 대화를 다시 불러와 주세요.');return;}
      if(result.message?.status==='failed')throw new Error(result.message?.data?.error||'답변을 가져오지 못했어요.');
      if(result.message?.role==='assistant'&&result.message.status==='completed'&&result.message.content?.trim())await props.onAssisted?.();
      setMessage('');requestId.current='';requestText.current='';
    }catch(cause){setError((cause as Error).message);}finally{lock.current=false;setBusy(false);}
  }
  async function reload(){if(!threadId||busy)return;setBusy(true);try{const result=await api('/api/chat?threadId='+encodeURIComponent(threadId));setMessages(result.messages);setError('');if(result.messages?.some((item:Item)=>item.role==='assistant'&&item.status==='completed'&&item.content?.trim()))await props.onAssisted?.();}catch(cause){setError((cause as Error).message);}finally{setBusy(false);}}
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
