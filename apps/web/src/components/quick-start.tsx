'use client';
import {setDeviceItem} from '@/lib/client/device-storage';
import {ownedClassName} from './owned-class-name';

import Link from 'next/link';
import {useEffect,useRef,useState} from 'react';
import {useSearchParams} from 'next/navigation';
import {ArrowRight,Check,Sparkles,Square} from 'lucide-react';
import {useApp} from './app-shell';
import {api,post,ActionButton,Alert,FloatingNotice,type Item} from './shared';
import {learningScopeIdentity} from '@/lib/learning-target-scope';
import {learningTargetIdentityMatches} from '@gakja/content-contracts/workflows';
import {registerDraftSaver} from '@/lib/client/draft-save';
import {readQuickStartStream} from '@/lib/quick-start-stream';
import {resetEnterSequence,sendOnEnter} from '@/lib/client/enter-send';
import styles from './quick-start.module.css';
import {MotionSwitch} from './sliding-choice';

type Entry={question:string;answer:string};
type DraftRequest={body:{sessionId:string;targetId:string|null;thoughts:string;history:Entry[];requestId:string};entry:Entry};
const entries=(value:unknown):Entry[]=>Array.isArray(value)?value.filter(item=>item&&typeof item.question==='string'&&typeof item.answer==='string').map(item=>({question:item.question.slice(0,2000),answer:item.answer.slice(0,40000)})):[];
export function QuickStart(){
 const {data,refresh,target:currentTarget}=useApp(),params=useSearchParams(),requested=params.get('targetId');
 const general=params.get('general')==='1'||data.targets.length===0,target=general?undefined:requested?data.targets.find(item=>item.id===requested):currentTarget;
 const scope=JSON.stringify([data.user.id,target?.id||null,target?learningScopeIdentity(target):null]),key=`gakja-first-question:${data.user.id}:${target?.id||'common'}`;
 const scopeRef=useRef({key:scope});if(scopeRef.current.key!==scope)scopeRef.current={key:scope};const token=scopeRef.current;
 const [loaded,setLoaded]=useState(''),[question,setQuestion]=useState<Item|null>(null),[session,setSession]=useState<Item|null>(null),[answer,setAnswer]=useState(''),[started,setStarted]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[draftState,setDraftState]=useState(''),[done,setDone]=useState(false);
 const [aiMode,setAiMode]=useState(true),[thoughts,setThoughts]=useState(''),[conversation,setConversation]=useState<Entry[]>([]),[followup,setFollowup]=useState<string|null>(null),[aiBusy,setAiBusy]=useState(false),[preview,setPreview]=useState(''),[assisted,setAssisted]=useState(false),[edited,setEdited]=useState(false);
 const [success,setSuccess]=useState(''),composing=useRef(false);
 const heading=useRef<HTMLHeadingElement>(null),draftQueue=useRef<Promise<unknown>>(Promise.resolve()),draftTimer=useRef<ReturnType<typeof setTimeout>|null>(null),pendingAnswer=useRef<{sessionId:string;response:string;requestId:string}|null>(null),aiRequest=useRef<DraftRequest|null>(null),aiFlight=useRef<AbortController|null>(null);
 const operation=useRef<{token:typeof token;promise:Promise<void>}|null>(null),logoutSaving=useRef<typeof token|null>(null);
 const editor=useRef({token,key,scope,loaded,session,answer,aiMode,thoughts,conversation,followup,done,assisted,edited});editor.current={token,key,scope,loaded,session,answer,aiMode,thoughts,conversation,followup,done,assisted,edited};
 function storeEditor(current=editor.current){const value=JSON.stringify({scope:current.scope,sessionId:current.session?.id,answer:current.answer,updatedAt:new Date().toISOString(),aiMode:current.aiMode,thoughts:current.thoughts,conversation:current.conversation,followup:current.followup,assisted:current.assisted,edited:current.edited,pendingAI:aiRequest.current});try{setDeviceItem(localStorage,current.key,value);return localStorage.getItem(current.key)===value;}catch{return false;}}
 function acceptProposal(proposal:Item,request:DraftRequest){
  if(typeof proposal.draft!=='string'||proposal.draft.length>8000||!(proposal.followup_question===null||typeof proposal.followup_question==='string'))throw new Error('정리된 답변을 확인하지 못했어요. 다시 이어가 주세요.');
  setAnswer(proposal.draft);setConversation([...request.body.history,request.entry]);setFollowup(proposal.followup_question);setThoughts('');setEdited(false);setAssisted(true);setPreview('');aiRequest.current=null;
 }
 async function savedAnswer(current:Item,response:string){
  const saved=await api('/api/quiz?sessionId='+encodeURIComponent(current.id)),receipt=saved.responses?.find((row:Item)=>row.item_index===0&&row.response===response);
  return saved.session?.id===current.id&&saved.session.student_id===data.user.id&&saved.session.items?.[0]?.id===current.items?.[0]?.id&&receipt?{...saved,response:receipt}:null;
 }
 function acceptAnswer(result:Item,current:Item,response:string,capture:typeof token){
  if(result.session?.id!==current.id||result.session?.student_id!==data.user.id||result.session?.items?.[0]?.id!==current.items?.[0]?.id||result.session?.state!=='completed'||result.response?.response!==response)throw new Error('답변 저장 상태를 확인하지 못했어요.');
  if(scopeRef.current!==capture)return;
  const usedHelp=Boolean(result.response?.data?.assisted||result.session.metadata?.assistedIndices?.includes(0));
  pendingAnswer.current=null;aiRequest.current=null;editor.current={...editor.current,session:result.session,answer:response,done:true,assisted:usedHelp};setSession(result.session);setDone(true);setAssisted(usedHelp);setError('');setSuccess('내 답변을 저장했어요.');
 }
 useEffect(()=>{
  let alive=true;const controller=new AbortController();scopeRef.current=token;aiFlight.current?.abort();aiFlight.current=null;aiRequest.current=null;pendingAnswer.current=null;
  setLoaded('');setError('');setSuccess('');composing.current=false;setQuestion(null);setStarted(false);setDone(false);setAnswer('');setSession(null);setBusy(false);setDraftState('');setAiMode(true);setThoughts('');setConversation([]);setFollowup(null);setAiBusy(false);setPreview('');setAssisted(false);setEdited(false);
  if(requested&&!target&&!general){setError('등록된 지원 학교를 선택해 주세요.');setLoaded(scope);return()=>{controller.abort();};}
  void(async()=>{try{
   const result=await api('/api/quiz?sourceType=common'+(target?'&targetId='+encodeURIComponent(target.id):'&general=1'),{signal:controller.signal});
   const candidates=(result.library?.answer||[]).filter((item:Item)=>item.source_kind==='common'),first=candidates.find((item:Item)=>item.question_id==='common_motivation')||candidates[0];
   if(!first)throw new Error('공통 질문을 아직 준비하지 못했어요. 잠시 후 다시 열어 주세요.');if(!alive)return;setQuestion(first);
   let saved:Item|null=null;try{saved=JSON.parse(localStorage.getItem(key)||'null');}catch{}
   if(saved?.scope===scope&&saved.sessionId){try{
    const previous=await api('/api/quiz?sessionId='+encodeURIComponent(saved.sessionId),{signal:controller.signal}),value=previous.session,item=value?.items?.[0],snapshot=value?.metadata?.targetSnapshot;
    const sameTarget=target?value?.metadata?.targetId===target.id&&snapshot&&learningTargetIdentityMatches(learningScopeIdentity(snapshot),learningScopeIdentity(target)):!value?.metadata?.targetId&&!snapshot;
    if(alive&&value?.student_id===data.user.id&&value.items?.length===1&&item?.source_kind==='common'&&sameTarget&&!['ended'].includes(value.state)){
     const receipt=previous.responses?.find((row:Item)=>row.item_index===0&&typeof row.response==='string');if(value.state==='completed'&&!receipt)return;
     setSession(value);setQuestion(item);setStarted(true);setDone(value.state==='completed');setAssisted(Boolean(value.metadata?.assistedIndices?.includes(0)||receipt?.data?.assisted));
     const draft=value.metadata?.drafts?.['0'],remote=typeof draft==='string'?draft:draft?.response||'',local=typeof saved.answer==='string'?saved.answer.slice(0,10000):undefined;
     setAnswer(value.state==='completed'?receipt.response:remote&&Date.parse(String(draft?.updatedAt||''))>Date.parse(String(saved.updatedAt||''))?remote:local??remote);
     setAiMode(typeof saved.aiMode==='boolean'?saved.aiMode:true);setThoughts(typeof saved.thoughts==='string'?saved.thoughts.slice(0,40000):typeof saved.keywordText==='string'?saved.keywordText:'');setConversation(entries(saved.conversation));setFollowup(typeof saved.followup==='string'?saved.followup:null);setEdited(saved.edited===true);
     const pending=saved.pendingAI;
     if(value.state!=='completed'&&pending?.body?.sessionId===value.id&&pending.body.targetId===(target?.id||null)&&typeof pending.body.requestId==='string'&&typeof pending.body.thoughts==='string'&&typeof pending.entry?.answer==='string'){
      aiRequest.current={body:{sessionId:value.id,targetId:target?.id||null,thoughts:pending.body.thoughts,history:entries(pending.body.history),requestId:pending.body.requestId},entry:{question:String(pending.entry.question||item.prompt),answer:pending.entry.answer}};
      try{const recovered=await api('/api/quick-start/draft?'+new URLSearchParams({sessionId:value.id,requestId:pending.body.requestId,...(target?{targetId:target.id}:{})}),{signal:controller.signal,cache:'no-store'});if(alive&&scopeRef.current===token&&recovered.status==='completed'&&recovered.proposal)acceptProposal(recovered.proposal,aiRequest.current!);}catch{/* The saved thoughts and original request can be retried without losing the draft. */}
     }
    }
   }catch{/* A stale local pointer cannot open another student's attempt. */}}
  }catch(err){if(alive&&!controller.signal.aborted)setError((err as Error).message);}finally{if(alive)setLoaded(scope);}})();
  return()=>{alive=false;controller.abort();aiFlight.current?.abort();if(scopeRef.current===token)scopeRef.current={key:''};};
 },[token,key,requested,general]);
 useEffect(()=>{if(started||done)heading.current?.focus();},[started,done]);
 useEffect(()=>{if(loaded===scope&&session&&!done)storeEditor();},[loaded,scope,session,answer,aiMode,thoughts,conversation,followup,done,assisted,edited,aiBusy]);
 useEffect(()=>{
  if(!session||done||loaded!==scope)return;const remote=session.metadata?.drafts?.['0'],remoteText=typeof remote==='string'?remote:remote?.response||'';if(answer===remoteText)return;
  const currentToken=token,sessionId=session.id,text=answer;setDraftState('');
  const timer=setTimeout(()=>{draftQueue.current=draftQueue.current.catch(()=>{}).then(()=>post('/api/quiz',{action:'draft',sessionId,itemIndex:0,response:text,requestId:crypto.randomUUID()}));void draftQueue.current.catch(()=>{if(scopeRef.current===currentToken)setDraftState('서버 연결을 확인해 주세요. 이 기기의 초안은 유지돼요.');});},450);draftTimer.current=timer;return()=>clearTimeout(timer);
 },[answer,session,done,loaded,scope,token]);
 useEffect(()=>registerDraftSaver(data.user.id,async()=>{
  if(editor.current.token!==token||editor.current.loaded!==editor.current.scope)return;
  logoutSaving.current=token;setBusy(true);
  try{
   // A user-confirmed start or answer owns its receipt before logout may pause.
   const pending=operation.current;if(pending?.token===token)await pending.promise;
   if(scopeRef.current!==token)return;
   const current=editor.current,currentSession=current.session;if(current.done||!currentSession?.id)return;
   const submission=pendingAnswer.current;
   if(submission&&submission.sessionId===currentSession.id){
    const response=submission.response,recovered=await savedAnswer(currentSession,response);
    if(scopeRef.current!==token)return;
    if(!recovered)throw new Error('보낸 답변의 저장을 확인하지 못했어요. 다시 확인한 뒤 로그아웃해 주세요.');
    acceptAnswer(recovered,currentSession,response,token);await refresh();return;
   }
   aiFlight.current?.abort();aiFlight.current=null;setAiBusy(false);setPreview('');if(draftTimer.current)clearTimeout(draftTimer.current);
   const device=storeEditor(current);let server=false;await draftQueue.current.catch(()=>{});
   if(scopeRef.current!==token)return;
   try{await post('/api/quiz',{action:'draft',sessionId:currentSession.id,itemIndex:0,response:current.answer,requestId:crypto.randomUUID()});server=true;
    if(currentSession.state==='active'&&scopeRef.current===token){const paused=await post('/api/quiz',{action:'pause',sessionId:currentSession.id,itemIndex:0});if(paused.session?.id===currentSession.id&&paused.session?.student_id===data.user.id&&paused.session?.state==='paused'&&scopeRef.current===token){editor.current={...editor.current,session:paused.session};setSession(paused.session);}}
   }catch{}
   if(!device&&(!server||current.thoughts||current.conversation.length||aiRequest.current))throw new Error('작성 중인 이야기를 보관하지 못했어요.');
  }finally{if(logoutSaving.current===token)logoutSaving.current=null;if(scopeRef.current===token)setBusy(false);}
 }),[data.user.id,token]);
 async function start(){if(!question||busy||operation.current?.token===token||logoutSaving.current===token)return;const capture=token;setBusy(true);setError('');const work=(async()=>{try{
  const result=editor.current.session?.id?{session:editor.current.session}:await post('/api/quiz',{action:'create',mode:'answer',focus:'free',sourceType:'common',targetId:target?.id||null,itemIds:[question.id]});if(scopeRef.current!==capture)return;
  editor.current={...editor.current,session:result.session};setSession(result.session);
  const current=result.session.state==='active'?result.session:(await post('/api/quiz',{action:'start',sessionId:result.session.id,itemIndex:0})).session;if(scopeRef.current!==capture)return;
  editor.current={...editor.current,session:current,answer:'',done:false};
  setSession(current);setQuestion(current.items[0]);setAnswer('');setStarted(true);setAiMode(true);setAssisted(Boolean(current.metadata?.assistedIndices?.includes(0)));
 }catch(err){if(scopeRef.current===capture)setError((err as Error).message);}})();const pending={token:capture,promise:work};operation.current=pending;
 try{await work;}finally{if(operation.current===pending)operation.current=null;if(scopeRef.current===capture&&logoutSaving.current!==capture)setBusy(false);}}
 async function generate(){
  if(!session||busy||aiFlight.current||logoutSaving.current===token||!thoughts.trim())return;
  const history=[...conversation,...(edited&&answer.trim()?[{question:'직접 고친 내 답변',answer}]:[])],input=thoughts.trim();
  if(!aiRequest.current||aiRequest.current.body.sessionId!==session.id||aiRequest.current.body.thoughts!==input||JSON.stringify(aiRequest.current.body.history)!==JSON.stringify(history))aiRequest.current={body:{sessionId:session.id,targetId:target?.id||null,thoughts:input,history,requestId:crypto.randomUUID()},entry:{question:followup||question?.prompt||'',answer:input}};
  const request=aiRequest.current,capture=token,controller=new AbortController();aiFlight.current=controller;setAiBusy(true);setPreview('');setError('');
  try{const response=await fetch('/api/quick-start/draft',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...request.body,stream:true}),signal:controller.signal});
   await readQuickStartStream(response,event=>{if(scopeRef.current!==capture||controller.signal.aborted)return;if(event.type==='delta'&&event.delta){setPreview(previous=>previous+event.delta);setAssisted(true);}else if(event.type==='done'&&event.proposal)acceptProposal(event.proposal,request);else if(event.type==='error')throw new Error(event.error||'답변을 정리하지 못했어요.');});
  }catch(err){if(scopeRef.current===capture&&!controller.signal.aborted)setError((err as Error).message);}finally{if(aiFlight.current===controller){aiFlight.current=null;if(scopeRef.current===capture){setAiBusy(false);setPreview('');}}}
 }
 function cancel(){aiFlight.current?.abort();aiFlight.current=null;setAiBusy(false);setPreview('');}
 async function submit(){if(!session||!answer.trim()||busy||aiFlight.current||operation.current?.token===token||logoutSaving.current===token)return;const capture=token;setBusy(true);setError('');if(draftTimer.current)clearTimeout(draftTimer.current);
  const work=(async()=>{try{await draftQueue.current.catch(()=>{});if(scopeRef.current!==capture)return;if(session.state!=='active')await post('/api/quiz',{action:'start',sessionId:session.id,itemIndex:0});if(scopeRef.current!==capture)return;
   const response=answer.trim();if(!pendingAnswer.current||pendingAnswer.current.sessionId!==session.id||pendingAnswer.current.response!==response)pendingAnswer.current={sessionId:session.id,response,requestId:crypto.randomUUID()};let result:Item;
   try{result=await post('/api/quiz',{action:'answer',sessionId:session.id,itemIndex:0,response,recallStatus:'unchecked',requestId:pendingAnswer.current.requestId});}catch(cause){if(scopeRef.current!==capture)return;const saved=await savedAnswer(session,response);if(!saved)throw cause;result=saved;}
   if(scopeRef.current!==capture)return;acceptAnswer(result,session,response,capture);await refresh();
  }catch(err){if(scopeRef.current===capture)setError((err as Error).message);}})();const pending={token:capture,promise:work};operation.current=pending;
  try{await work;}finally{if(operation.current===pending)operation.current=null;if(scopeRef.current===capture&&logoutSaving.current!==capture)setBusy(false);}
 }
 const organizing=aiMode&&(!answer.trim()||Boolean(thoughts.trim())),canAct=organizing?Boolean(thoughts.trim()):Boolean(answer.trim());
 const actionLabel=organizing?(conversation.length?'답변에 이어서 정리':'답변 정리하기'):'답변 확인하고 저장';
 const act=()=>organizing?generate():submit();
 const enter=(event:Parameters<typeof sendOnEnter>[0],value:string)=>{sendOnEnter(event,data.preferences?.enterToSend!==false,act,{composing:composing.current,blocked:busy||aiBusy||!canAct||!value.trim()});};
 if(loaded!==scope)return <section className={ownedClassName(styles.page,true)}><p role="status" className={ownedClassName(undefined,true)}>공통 질문을 불러오고 있어요.</p></section>;
 return <section className={ownedClassName(styles.page,true)} aria-labelledby="first-question-heading">
  <header className={ownedClassName(styles.header,true)}><h1 id="first-question-heading" tabIndex={-1} ref={heading} className={ownedClassName(undefined,true)}>{done?'완성한 내 답변':'내 말로 답변 만들기'}</h1>{!done&&<p className={ownedClassName(undefined,true)}>{started?'떠오르는 생각부터 편하게 적어보세요.':'공통 질문부터 나의 이야기를 시작해요.'}</p>}</header>
  {success&&<FloatingNotice onDismiss={()=>setSuccess('')}>{success}</FloatingNotice>}
  {error&&<Alert>{error}</Alert>}
  {done?<><blockquote className={ownedClassName(styles.savedAnswer,true)}>{answer}</blockquote><div className={ownedClassName(styles.actions,true)}><Link className={ownedClassName("button primary")} href={data.targets.length?'/my':'/schools/new?onboarding=1'}>{data.targets.length?'오늘 훈련으로':'학교 등록하기'}<ArrowRight size={17}/></Link><button className={ownedClassName("text-link",true)} onClick={()=>{try{localStorage.removeItem(key);}catch{}setDone(false);setStarted(false);setSession(null);setAnswer('');setThoughts('');setConversation([]);setFollowup(null);setEdited(false);setAiMode(true);}}>다른 답변 만들기</button></div></>:<>
   <div className={ownedClassName(styles.question,true)}><h2 className={ownedClassName(undefined,true)}>{question?.prompt}</h2></div>
   {!started?<div className={ownedClassName(styles.actions,true)}><ActionButton className={ownedClassName("button primary")} pending={busy} disabled={!question} onClick={()=>void start()}>답변 시작하기<ArrowRight size={17}/></ActionButton><Link className={ownedClassName(styles.schoolLink)} href={data.targets.length?'/my':'/schools/new?onboarding=1'}>{data.targets.length?'오늘로 돌아가기':'학교부터 등록할게요'}</Link></div>:<>
    <div className={ownedClassName(styles.toggleRow,true)}><span className={ownedClassName(undefined,true)}>AI와 함께 정리</span><MotionSwitch label="AI와 함께 정리" checked={aiMode} disabled={busy||aiBusy} onChange={setAiMode}/></div>
    {aiMode&&<>
     {conversation.length>0&&<details className={ownedClassName(styles.conversation,true)}><summary className={ownedClassName(undefined,true)}>앞서 나눈 이야기</summary>{conversation.map((entry,index)=><article key={index} className={ownedClassName(undefined,true)}>{index>0&&<p className={ownedClassName(styles.priorQuestion,true)}>{entry.question}</p>}<p className={ownedClassName(undefined,true)}>{entry.answer}</p></article>)}</details>}
     {followup&&<div className={ownedClassName(styles.followup,true)}><Sparkles size={18}/><p className={ownedClassName(undefined,true)}>{followup}</p></div>}
     <label className={ownedClassName(styles.thoughts,true)} htmlFor="first-thoughts">{followup?'내 이야기':conversation.length?'더 떠오른 이야기':'생각나는 대로 적어보세요'}<textarea id="first-thoughts" value={thoughts} maxLength={40000} rows={4} disabled={busy||aiBusy} onChange={event=>{setThoughts(event.target.value);aiRequest.current=null;}} onKeyDown={event=>enter(event,thoughts)} onBlur={event=>resetEnterSequence(event.currentTarget)} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} placeholder="짧거나 매끄럽지 않은 문장도 괜찮아요." className={ownedClassName(undefined,true)}/></label>
     {aiBusy&&<div className={ownedClassName(styles.stream,true)} aria-label="정리 중인 미리보기" aria-busy="true"><p className={ownedClassName(undefined,true)}>{preview||'이야기를 읽고 있어요.'}</p><span className={ownedClassName(styles.cursor,true)} aria-hidden="true"/></div>}
    </>}
    {(!aiMode||answer||conversation.length>0)&&<label className={ownedClassName(styles.answer,true)} htmlFor="first-answer-text">{aiMode?'내가 확인할 답변':'내 답변'}<textarea id="first-answer-text" value={answer} maxLength={10000} rows={6} disabled={busy||aiBusy} onChange={event=>{setAnswer(event.target.value);setEdited(true);}} onKeyDown={event=>enter(event,answer)} onBlur={event=>resetEnterSequence(event.currentTarget)} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} placeholder="내 답변을 적어보세요." className={ownedClassName(undefined,true)}/></label>}
    {draftState&&<p className={ownedClassName(styles.status,true)} role="status">{draftState}</p>}
    <div className={ownedClassName(styles.actions,true)} data-quick-start-action><ActionButton className={ownedClassName("button primary")} pending={busy||aiBusy} pendingLabel={aiBusy?'답변 정리 중':'저장 중'} disabled={busy||aiBusy||!canAct} onClick={()=>void act()}>{actionLabel}{organizing?<Sparkles size={17}/>:<Check size={17}/>}</ActionButton>{aiBusy&&<button type="button" className={ownedClassName("text-link",true)} onClick={cancel}><Square size={13}/>멈추기</button>}<Link className={ownedClassName(styles.schoolLink)} href={data.targets.length?'/my':'/schools/new?onboarding=1'}>{data.targets.length?'오늘로 돌아가기':'학교부터 등록할게요'}<ArrowRight size={15}/></Link></div>
   </>}
  </>}
 </section>;
}
