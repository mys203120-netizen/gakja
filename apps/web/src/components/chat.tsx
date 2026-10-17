'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Plus, MessagesSquare, Bookmark, LoaderCircle, ArrowUpRight, BookOpen, Play, Search, Paperclip, X, Square, ArchiveRestore } from 'lucide-react';
import { useApp } from './app-shell';
import { api, post, action, PageTitle, Alert, Logo, targetName, targetMajor, type Item } from './shared';
import { InterviewSetup, InterviewSession } from './interview';
import { ChatComposer } from './chat-composer';
import { ChatHistory } from './chat-history';
import { readAssistantStream } from '@/lib/assistant-stream-model';
import { createAssistantDeltaBuffer } from '@/lib/assistant-delta-buffer';
import { MarkdownMessage } from './markdown-message';
import styles from './assistant-page.module.css';
type ChatSelection={sourceType?:'personal'|'common';questionId?:string;activityId?:string;briefingId?:string;targetId?:string;sourceVersion?:number};
function version(value:unknown){const number=Number(value);return Number.isInteger(number)&&number>0&&number<=100000?number:undefined;}
export function chatSelection(params:Pick<URLSearchParams,'get'>,data:Item,globalTargetId:string,thread?:Item|null,assisted?:Item|null):ChatSelection{
 const context=thread?.context||assisted?.session?.data?.context||{};
 const briefingId=thread?context.briefingId||context.briefing_id||thread.briefingId:params.get('briefingId')||context.briefingId||context.briefing_id;
 const questionId=thread?context.questionId||context.question_id||thread.questionId:params.get('questionId')||(!briefingId?assisted?.question?.rootQuestionId:undefined)||context.questionId||context.question_id;
 const activityId=thread?context.activityId||context.activity_id||thread.activityId:params.get('activityId')||context.activityId||context.activity_id;
 const currentQuestion=(data.learning?.questions||[]).find((item:Item)=>item.id===questionId);
 const matchingTarget=currentQuestion?.support_target_ids?.includes(globalTargetId)?globalTargetId:data.targets?.find((item:Item)=>currentQuestion?.support_target_ids?.includes(item.id))?.id;
 const selectedTarget=thread?.target_id||context.targetId||assisted?.session?.target_id||assisted?.session?.supportTarget?.id||params.get('targetId')||matchingTarget||globalTargetId;
 const selectedQuestion=(thread?.resources?.learning?.questions||assisted?.session?.data?.context?.questions||data.learning?.questions||[]).find((item:Item)=>item.id===questionId);
 const commonRevision=version(selectedQuestion?.common_revision);
 const sourceVersion=commonRevision||(thread?version(thread.content_version||context.contentVersion):version(assisted?.session?.content_version||context.contentVersion||params.get('sourceVersion')));
 return{questionId:questionId||undefined,activityId:activityId||undefined,briefingId:briefingId||undefined,targetId:selectedTarget||undefined,sourceVersion,...(commonRevision?{sourceType:'common' as const}:{})};
}
export function chatDraftKey(userId:string,threadId:string|undefined,selection:ChatSelection,sessionId:string|null){return`gakja-on:${userId}:${JSON.stringify([threadId||'new',selection.targetId||'',selection.questionId||'',selection.activityId||'',selection.briefingId||'',selection.sourceVersion||'current',sessionId||''])}`;}
export function canSaveChatCandidate(data:Item,selection:ChatSelection,pinnedVersion:unknown){return Boolean(selection.questionId&&data.package&&(data.learning?.questions||[]).some((item:Item)=>item.id===selection.questionId&&(!item.support_target_ids?.length||item.support_target_ids.includes(selection.targetId)))&&version(pinnedVersion)===version(data.package.active_version));}
// A visible nonempty partial is help too. Server receipts, not this display helper, are authoritative.
export function chatReplyAssisted(reply:Item|undefined,selection:ChatSelection,paused:ChatSelection){return Boolean(reply?.role==='assistant'&&['pending','completed','failed'].includes(reply.status)&&typeof reply.content==='string'&&reply.content.trim()&&selection.targetId===paused.targetId&&selection.sourceVersion===paused.sourceVersion&&selection.questionId===paused.questionId&&selection.activityId===paused.activityId&&selection.briefingId===paused.briefingId);}
export function ChatPages({slug=[]}:{slug?:string[]}) {
 if(slug[0]==='interviews')return slug[1]&&slug[1]!=='new'?<InterviewSession id={slug[1]} kind="chat"/>:<InterviewSetup kind="chat"/>;
 return <Chat threadId={slug[0]}/>;
}
export function chatThreadFromPath(path:string,fallback?:string){if(path==='/on'||path==='/on/')return undefined;return path.match(/^\/on\/([^/]+)\/?$/)?.[1]||fallback;}
function Chat({threadId:routeThreadId}:{threadId?:string}) {
 const {data,targetId,target,refresh,toast,openResource:openAppResource}=useApp(); const router=useRouter(),params=useSearchParams();
 const threadId=chatThreadFromPath(usePathname(),routeThreadId);
 const [messages,setMessages]=useState<Item[]>([]),[thread,setThread]=useState<Item|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(!!threadId),[error,setError]=useState(''),[changed,setChanged]=useState(false),[assisted,setAssisted]=useState<Item|null>(null),[resuming,setResuming]=useState(false),[draftLoaded,setDraftLoaded]=useState(''),[activitySearch,setActivitySearch]=useState('');
 const [preview,setPreview]=useState<Item|null>(null),[previewKey,setPreviewKey]=useState(''),[previewLoading,setPreviewLoading]=useState(false),[previewError,setPreviewError]=useState('');
 const bottom=useRef<HTMLDivElement>(null),textarea=useRef<HTMLTextAreaElement>(null),sending=useRef(false),request=useRef({key:'',text:'',id:''});
 const [replyAnnouncement,setReplyAnnouncement]=useState(''); const announcedReply=useRef('');
 const [attachments,setAttachments]=useState<Item[]>([]),[uploading,setUploading]=useState(false);
 const attachmentInput=useRef<HTMLInputElement>(null),streamController=useRef<AbortController|null>(null),followReply=useRef(true),streamGeneration=useRef(0);
 const [quizAssisted,setQuizAssisted]=useState<Item|null>(null);
 const [threads,setThreads]=useState<Item[]>(data.threads||[]);
 const streamHandoff=useRef<{thread:Item;contextChanged:boolean}|null>(null),threadListSequence=useRef(0);
 const sessionId=params.get('sessionId'),quizSessionId=params.get('quizSessionId'),quizItemIndex=params.has('quizItemIndex')?Number(params.get('quizItemIndex')):undefined;
 const selection:ChatSelection=quizSessionId&&!thread&&quizAssisted?.selection?quizAssisted.selection:chatSelection(params,data,targetId,thread,assisted);
 const {activityId,questionId,briefingId}=selection;
 const commonQuestion=Boolean(questionId?.startsWith('common_')||questionId?.startsWith('bible_'));
 const commonContext=commonQuestion||assisted?.session?.sourceKind==='common'||!data.package&&!threadId||Boolean(thread?.resources?.learning?.questions?.length&&thread.resources.learning.questions.every((q:Item)=>q.id?.startsWith('common_')||q.id?.startsWith('bible_'))&&!thread.resources.learning.activities?.length);
 const pinnedTarget=thread?.target||quizAssisted?.supportTarget||assisted?.session?.supportTarget||data.targets.find(t=>t.id===selection.targetId)||target;
 const query=new URLSearchParams();if(questionId)query.set('questionId',questionId);if(activityId)query.set('activityId',activityId);if(briefingId)query.set('briefingId',briefingId);if(selection.targetId)query.set('targetId',selection.targetId);if(selection.sourceVersion&&(!commonContext||commonQuestion))query.set('sourceVersion',String(selection.sourceVersion));
 const selectionKey=query.toString(),needsPreview=!threadId&&Boolean(questionId||activityId||briefingId||params.get('sourceVersion')||!data.package&&selection.targetId);
 const currentPreview=previewKey===selectionKey?preview:null,resources=thread?.resources||currentPreview;
 const openResource=async(resource:Parameters<typeof openAppResource>[0])=>{try{if(quizSessionId&&quizItemIndex!==undefined)await post('/api/quiz',{action:'assist',sessionId:quizSessionId,itemIndex:quizItemIndex,helpKind:'evidence',requestId:crypto.randomUUID()});if(sessionId&&assisted?.question?.turnId)await post('/api/interviews',{action:'help',sessionId,turnId:assisted.question.turnId,helpKind:'evidence',requestId:crypto.randomUUID()});openAppResource({...resource,snapshot:resources?{...resources,...((thread?.context?.briefing||currentPreview?.briefing)?{briefings:[thread?.context?.briefing||currentPreview?.briefing]}:{})}:undefined});}catch(err){setError((err as Error).message);}};
 const learning=resources?.learning||(needsPreview||threadId?{}:data.learning); const activities:Item[]=learning?.activities||[],questions:Item[]=learning?.questions||[];
 const activity=activities.find(a=>a.id===activityId),question=questions.find(q=>q.id===questionId);
 const pinnedVersion=selection.sourceVersion||currentPreview?.contentVersion||data.package?.active_version,canSaveCandidate=Boolean(threadId)&&canSaveChatCandidate(data,selection,pinnedVersion);
 const requestVersion=commonContext&&!commonQuestion?undefined:version(pinnedVersion);
 const draftScope=sessionId||(quizSessionId?`quiz:${quizSessionId}:${quizItemIndex??''}`:null);
 const draftKey=chatDraftKey(data.user.id,threadId,{...selection,sourceVersion:version(pinnedVersion)},draftScope),pendingResponse=messages.some(m=>m.role==='assistant'&&m.status==='pending');
 const ready=Boolean(threadId?thread?.resources:needsPreview?currentPreview:data.package)&&!previewError;
 const archived=Boolean(thread?.archived_at),disabled=!ready||loading||previewLoading||busy||uploading||pendingResponse||archived||Boolean(sessionId&&!assisted)||Boolean(quizSessionId&&!quizAssisted)||draftLoaded!==draftKey;
 const interviewParams=new URLSearchParams({kind:'chat'});if(questionId||activityId||briefingId)interviewParams.set('count','1');if(questionId)interviewParams.set('questionId',questionId);if(activityId)interviewParams.set('activityId',activityId);if(briefingId)interviewParams.set('briefingId',briefingId);if(selection.targetId)interviewParams.set('targetId',selection.targetId);if(pinnedVersion)interviewParams.set('sourceVersion',String(pinnedVersion));if(commonContext)interviewParams.set('sourceType','common');
 useEffect(()=>{const handoff=streamHandoff.current;if(threadId&&handoff?.thread.id===threadId){streamHandoff.current=null;setThread(handoff.thread);setChanged(handoff.contextChanged);setLoading(false);return;}let disposed=false;setMessages([]);setThread(null);setError('');setChanged(false);setLoading(!!threadId);if(threadId)api(`/api/chat?threadId=${encodeURIComponent(threadId)}`).then(r=>{if(!disposed){setMessages(r.messages);setThread(r.thread);setChanged(r.contextChanged);}}).catch(err=>{if(!disposed)setError(err.message);}).finally(()=>{if(!disposed)setLoading(false);});return()=>{disposed=true;};},[threadId]);
 useEffect(()=>{setThreads(data.threads||[]);},[data.threads]);
 async function refreshThreads(){const sequence=++threadListSequence.current;const result=await api('/api/chat');if(sequence===threadListSequence.current)setThreads(result.threads||[]);}
 useEffect(()=>{void refreshThreads().catch(()=>{});return()=>{threadListSequence.current++;};},[data.user.id]);
 useEffect(()=>{let disposed=false;setQuizAssisted(null);if(quizSessionId&&quizItemIndex!==undefined)api(`/api/learning-help?quizSessionId=${encodeURIComponent(quizSessionId)}&quizItemIndex=${quizItemIndex}`).then(r=>{if(!disposed)setQuizAssisted(r);}).catch(err=>{if(!disposed)setError(err.message);});return()=>{disposed=true;};},[quizSessionId,quizItemIndex]);
 useEffect(()=>{let disposed=false;setAssisted(null);if(sessionId)api(`/api/interviews?id=${encodeURIComponent(sessionId)}`).then(r=>{if(!disposed)setAssisted(r);}).catch(err=>{if(!disposed)setError(err.message);});return()=>{disposed=true;};},[sessionId]);
 // A query can change the learning context without remounting this page.
 // Detach the old controller before aborting so its late frames cannot update the new context.
 useEffect(()=>{sending.current=false;setBusy(false);if(!threadId)setMessages([]);return()=>{streamGeneration.current++;const previous=streamController.current;streamController.current=null;sending.current=false;previous?.abort();};},[draftKey]);
 useEffect(()=>{let disposed=false;setPreview(null);setPreviewKey('');setPreviewError('');setPreviewLoading(needsPreview);if(!needsPreview)return;if(params.get('sourceVersion')&&!version(params.get('sourceVersion'))){setPreviewError('자료 발행본을 확인해 주세요.');setPreviewLoading(false);return;}if(sessionId&&!assisted||quizSessionId&&!quizAssisted)return;api(sessionId&&assisted?.question?.turnId?`/api/learning-help?interviewSessionId=${encodeURIComponent(sessionId)}&interviewTurnId=${encodeURIComponent(assisted.question.turnId)}`:`/api/learning-help?${selectionKey}${selection.sourceType?'&sourceType='+selection.sourceType:''}`).then(r=>{if(!disposed){setPreview(r);setPreviewKey(selectionKey);}}).catch(err=>{if(!disposed)setPreviewError(err.message);}).finally(()=>{if(!disposed)setPreviewLoading(false);});return()=>{disposed=true;};},[needsPreview,selectionKey,sessionId,assisted?.session?.id,quizSessionId,quizAssisted?.quizScope?.sessionId]);
 useEffect(()=>{try{const saved=sessionStorage.getItem(draftKey)||'';let restored:Item|undefined;try{restored=JSON.parse(saved);}catch{}setMessage(restored&&typeof restored.draft==='string'?restored.draft:saved);request.current={key:draftKey,text:typeof restored?.requestText==='string'?restored.requestText:'',id:typeof restored?.requestId==='string'?restored.requestId:''};}catch{setMessage('');request.current={key:draftKey,text:'',id:''};}setDraftLoaded(draftKey);},[draftKey]);
 useEffect(()=>{if(draftLoaded!==draftKey)return;if(message)sessionStorage.setItem(draftKey,JSON.stringify({draft:message,requestId:request.current.key===draftKey?request.current.id:'',requestText:request.current.key===draftKey?request.current.text:''}));else sessionStorage.removeItem(draftKey);},[message,draftKey,draftLoaded,busy]);
 useEffect(()=>{const frame=requestAnimationFrame(()=>{const scroller=bottom.current?.closest('.chat-messages');if(scroller&&followReply.current)scroller.scrollTo({top:messages.length?scroller.scrollHeight:0,behavior:'instant'});});return()=>cancelAnimationFrame(frame);},[messages]);
 // Announce newly completed requests, never the full saved history or a pending reply.
 function announceCompletedReply(reply:Item|undefined){if(reply?.role!=='assistant'||reply.status!=='completed'||typeof reply.content!=='string'||!reply.content.trim())return;const receipt=String(reply.id||reply.request_id||'');if(!receipt||announcedReply.current===receipt)return;announcedReply.current=receipt;setReplyAnnouncement('AI 비서 답변이 도착했어요.');}
 async function resume(){if(!assisted?.session||resuming||busy||pendingResponse)return;setResuming(true);try{await post('/api/interviews',{action:'resume',sessionId:assisted.session.id,turnId:assisted.question?.turnId});router.push(`/interview/${assisted.session.id}?kind=${assisted.session.kind}`);}catch(err){setError((err as Error).message);}finally{setResuming(false);}}
 async function reload(){if(!threadId||sending.current)return;setReplyAnnouncement('');setBusy(true);try{const r=await api(`/api/chat?threadId=${encodeURIComponent(threadId)}`);setMessages(r.messages);setThread(r.thread);setChanged(r.contextChanged);setError('');const receipt=r.messages.find((m:Item)=>m.role==='assistant'&&m.request_id===request.current.id);if(receipt?.status==='completed'){announceCompletedReply(receipt);setMessage('');sessionStorage.removeItem(draftKey);request.current={key:draftKey,text:'',id:''};}if(receipt?.status==='failed'){setError(receipt.error||receipt.data?.error||'응답이 중단됐어요. 다시 질문해 주세요.');request.current={key:draftKey,text:'',id:''};}}catch(err){setError((err as Error).message);}finally{setBusy(false);}}
 async function send(recommendedText?:string){
  const text=(recommendedText??message).trim();
  if(!text||sending.current||disabled)return;
  const restoreInputFocus=Boolean(textarea.current&&document.activeElement===textarea.current&&!window.matchMedia('(pointer: coarse)').matches);
  if(recommendedText!==undefined)setMessage(text);
  sending.current=true;followReply.current=true;setReplyAnnouncement('');setBusy(true);setError('');
  const attachmentKey=attachments.map(item=>item.id).join(',');
  const requestText=attachmentKey?`${text}\n[attachments:${attachmentKey}]`:text;
  if(request.current.key!==draftKey||request.current.text!==requestText||!request.current.id)request.current={key:draftKey,text:requestText,id:crypto.randomUUID()};
  const optimistic={id:`pending-${request.current.id}`,role:'user',content:text,attachments};
  setMessages(items=>[...items,optimistic]);
  let resolvedThreadId=threadId,resolvedThread:Item|null=null,assistantId='',completed=false,terminalFailure=false,contextChanged=false;
  const controller=new AbortController(),generation=streamGeneration.current;streamController.current=controller;
  const deltas=createAssistantDeltaBuffer(delta=>{if(streamController.current===controller)setMessages(items=>items.map(item=>item.id===assistantId?{...item,content:(item.content||'')+delta,status:'pending'}:item));},{schedule:callback=>setTimeout(callback,32),cancel:handle=>clearTimeout(handle)});
  try{
   const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text,threadId,targetId:selection.targetId,activityId,questionId,briefingId,...(requestVersion?{sourceVersion:requestVersion}:{}),requestId:request.current.id,...(selection.sourceType?{sourceType:selection.sourceType}:{}),...(quizSessionId&&quizItemIndex!==undefined?{quizSessionId,quizItemIndex}:{}),...(sessionId&&assisted?.question?.turnId?{interviewSessionId:sessionId,interviewTurnId:assisted.question.turnId}:{}),stream:true,attachmentIds:attachments.map(item=>item.id)}),signal:controller.signal});
   await readAssistantStream(response,async event=>{
    if(streamController.current!==controller)return;
    if(event.threadId)resolvedThreadId=event.threadId;
    if(event.thread)resolvedThread=event.thread;
    if(event.type==='start'){
     assistantId=event.assistantId||`assistant-${request.current.id}`;
     setMessages(items=>{const kept=items.filter(item=>item.id!==optimistic.id&&item.id!==event.userMessage?.id&&item.id!==assistantId);return[...kept,event.userMessage||optimistic,{id:assistantId,role:'assistant',content:'',status:'pending'}];});
    }else if(event.type==='delta'&&event.delta){
     deltas.append(event.delta);
    }else if(event.type==='done'){
     deltas.discard();completed=true;contextChanged=Boolean(event.contextChanged);
     setMessages(items=>{const kept=items.filter(item=>item.id!==optimistic.id&&item.id!==assistantId&&item.id!==event.message?.id);const known=new Set(kept.map(item=>item.id));return[...kept,...[event.userMessage,event.message].filter((item):item is Item=>Boolean(item&&!known.has(item.id)))];});
     setChanged(contextChanged);announceCompletedReply(event.message);
     setMessage('');setAttachments([]);sessionStorage.removeItem(draftKey);request.current={key:draftKey,text:'',id:''};
    }else if(event.type==='pending'){
     deltas.discard();setMessages(items=>items.map(item=>item.id===assistantId?{...item,...event.message}:item));
     setError('이전 답변을 작성 중이에요. 잠시 후 대화를 다시 불러와 주세요.');
    }else if(event.type==='error'){
     deltas.flush();terminalFailure=true;
     setMessages(items=>items.map(item=>item.id===assistantId?{...item,status:'failed',error:event.error||'응답이 중단됐어요.'}:item));
     throw new Error(event.error||'응답이 중단됐어요. 대화를 다시 불러올 수 있어요.');
    }
   });
  }catch(err){
   deltas.flush();if(streamController.current!==controller)return;
   const stopped=controller.signal.aborted;
   // A confirmed failure or explicit stop can be retried; an ambiguous network loss
   // keeps its identity so the server can return the original request instead of duplicating it.
   if(terminalFailure||stopped)request.current={key:draftKey,text:'',id:''};
   setError(stopped?'응답을 멈췄어요. 대화에서 다시 이어갈 수 있어요.':(err as Error).message);
   setMessages(items=>items.filter(item=>assistantId||item.id!==optimistic.id).map(item=>item.id===assistantId&&item.status==='pending'?{...item,status:'failed',error:stopped?'응답을 멈췄어요.':'응답이 중단됐어요.'}:item));
  }finally{
   deltas.discard();if(streamController.current!==controller)return;
   if(generation!==streamGeneration.current||streamController.current!==controller)return;
   streamController.current=null;sending.current=false;setBusy(false);
   if(!threadId&&resolvedThreadId){
    const next=new URLSearchParams();if(sessionId)next.set('sessionId',sessionId);if(quizSessionId){next.set('quizSessionId',quizSessionId);if(quizItemIndex!==undefined)next.set('quizItemIndex',String(quizItemIndex));}
    if(!completed)sessionStorage.setItem(chatDraftKey(data.user.id,resolvedThreadId,{...selection,sourceVersion:version(pinnedVersion)},draftScope),JSON.stringify({draft:text,requestId:request.current.id,requestText:request.current.text}));
    const savedThread={...(resolvedThread||{id:resolvedThreadId,target_id:selection.targetId,content_version:requestVersion,target:pinnedTarget,context:selection}),resources:resources||{learning,documents:data.documents||[]}};
    streamHandoff.current={thread:savedThread,contextChanged};
    setThread(savedThread);
    setThreads(items=>[savedThread,...items.filter(item=>item.id!==savedThread.id)]);
    // Keep the streamed DOM when the first response becomes a saved conversation.
    window.history.replaceState(null,'',`/on/${resolvedThreadId}${next.size?`?${next}`:''}`);
   }
   if(restoreInputFocus&&document.activeElement===document.body)textarea.current?.focus({preventScroll:true});
   void refreshThreads().catch(()=>{});
  }
 }
 async function uploadAttachments(files:FileList|null){
  if(!files?.length||uploading||busy)return;
  if(attachments.length+files.length>3){setError('파일은 한 번에 3개까지 첨부할 수 있어요.');return;}
  setUploading(true);setError('');
  try{const form=new FormData();for(const file of Array.from(files))form.append('files',file);const result=await api('/api/chat/attachments',{method:'POST',body:form});setAttachments(items=>[...items,...result.attachments]);}
  catch(err){setError((err as Error).message);}finally{setUploading(false);if(attachmentInput.current)attachmentInput.current.value='';}
 }
 async function removeAttachment(id:string){
  if(busy||uploading)return;
  try{await api(`/api/chat/attachments?id=${encodeURIComponent(id)}`,{method:'DELETE'});setAttachments(items=>items.filter(item=>item.id!==id));}
  catch(err){setError((err as Error).message);}
 }
 async function manageThread(id:string,actionName:'rename'|'archive'|'restore'|'delete'){
  await refreshThreads();
  if(id===threadId&&(actionName==='archive'||actionName==='delete'))router.push('/on');
  else if(id===threadId){const result=await api(`/api/chat?threadId=${encodeURIComponent(id)}`);setThread(result.thread);}
 }

 async function saveCandidate(m:Item){if(!canSaveCandidate||!threadId||!questionId||m.status==='pending'||m.status==='failed')return;try{const current=data.answers.find(a=>a.question_id===questionId);await action('save_answer',{questionId,structure:current?.structure||'',script:m.content,expectedRevision:current?.revision||0,chatThreadId:threadId,chatMessageId:m.id});await refresh();toast('답변 후보를 저장했어요.');}catch(err){toast((err as Error).message);}}
 function sourceKind(s:Item):'source'|'question'|'briefing'|'activity'{if(s.type==='source'||s.type==='source_ref'||learning?.source_refs?.some((r:Item)=>r.id===s.id))return 'source';return s.type==='question'?'question':s.type==='briefing'?'briefing':'activity';}
 function activityHref(id:string){const next=new URLSearchParams({activityId:id});if(selection.targetId)next.set('targetId',selection.targetId);if(pinnedVersion)next.set('sourceVersion',String(pinnedVersion));return`/on?${next}`;}
 const hasDocuments=resources?resources.documents?.length>0:!needsPreview&&!threadId;
 const selectedBriefing=thread?.context?.briefing||currentPreview?.briefing;
 const starterPrompts=briefingId?['이 기사와 지원 전공의 연결점을 정리하고 싶어','기사에 대한 내 생각의 근거를 확인해줘','이 주제를 면접 답변으로 연습하고 싶어']:questionId?.startsWith('common_')||questionId?.startsWith('bible_')||(question?.question_types||[]).includes('concept')?['이 질문이 무엇을 묻는지 확인하고 싶어','이 질문에 답할 때 필요한 근거를 찾아줘','내 답변을 직접 써보고 다듬고 싶어']:['이 경험에서 내가 맡은 역할을 정리하고 싶어','이 질문에 답할 때 필요한 근거를 찾아줘','내 답변을 직접 써보고 다듬고 싶어'];
 return <div className={`assistant-page ${styles.page}`}><PageTitle title="AI 비서" aside={!sessionId&&!quizSessionId&&ready&&<Link className="text-link" href={`/interview/new?${interviewParams}`}>면접으로 이어가기<ArrowUpRight size={16}/></Link>}/>
 {quizSessionId&&quizAssisted?.quizScope&&<div className="assisted-banner"><div><strong>잠시 멈춘 퀴즈</strong><p>같은 문항과 작성하던 답으로 돌아갑니다.</p></div><Link className={`button ghost${busy||pendingResponse?' disabled':''}`} aria-disabled={busy||pendingResponse} onClick={event=>{if(busy||pendingResponse)event.preventDefault();}} href={`/quiz/session/${encodeURIComponent(quizSessionId)}`}>퀴즈 돌아가기</Link></div>}
 {assisted?.session?.state==='active'&&<div className="assisted-banner"><div><strong>잠시 멈춘 면접</strong><p>답변 초안을 저장했어요.</p></div><button className="button ghost" disabled={resuming||busy||pendingResponse} onClick={resume}><Play size={14}/>면접 돌아가기</button></div>}
 <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{replyAnnouncement}</div>
 <div className={`chat-workspace on-workspace ${styles.workspace}`}><ChatHistory threads={threads} currentId={threadId} busy={busy||pendingResponse} onChange={manageThread}/>
 <section className="chat-main" aria-label="AI 비서 대화 작업 공간"><div className="chat-context"><div className={styles.targetContext}><span>{threadId?'이 대화의 지원처':'대화할 지원처'}</span><span>{targetName(pinnedTarget)}{targetMajor(pinnedTarget)?` · ${targetMajor(pinnedTarget)}`:''}</span>{threadId&&selection.targetId!==targetId&&<small>현재 선택과 다른 지원처</small>}</div><div className="on-reference-tools">{hasDocuments&&<><button onClick={()=>openResource({kind:'guidebook'})}><BookOpen size={14}/>가이드북</button><button onClick={()=>openResource({kind:'handbook'})}>핸드북</button></>}{activity&&<button onClick={()=>openResource({kind:'activity',id:activity.id})}>활동 근거</button>}{question&&<button onClick={()=>openResource({kind:'question',id:question.id})}>질문 근거</button>}</div></div>
 {changed&&<div className="inline-notice">새 자료가 발행됐어요. 이 대화는 시작 당시 자료를 사용합니다.<Link href="/on">새 대화</Link></div>}
 {archived&&<div className="inline-notice">보관한 대화예요.<button className="text-link" onClick={async()=>{try{await api('/api/chat',{method:'PATCH',body:JSON.stringify({threadId,action:'restore'})});if(threadId)await manageThread(threadId,'restore');}catch(err){setError((err as Error).message);}}}><ArchiveRestore size={14}/>보관 해제하고 이어가기</button></div>}
 <div className="chat-messages" role="region" aria-label="대화 메시지" tabIndex={0} aria-busy={busy||loading||previewLoading} onScroll={event=>{const area=event.currentTarget;followReply.current=area.scrollHeight-area.scrollTop-area.clientHeight<100;}}>{loading||previewLoading?<LoaderCircle size={24} className="spin"/>:!messages.length&&!error&&!previewError&&<div className="chat-welcome on-welcome"><span className="eyebrow">{briefingId?'기사에서 면접으로':data.package?'내 기록에서 시작하기':'질문에서 시작하기'}</span><h2>{selectedBriefing?.title||question?.prompt||activity?.title||(data.package?'어떤 경험을 이야기할까요?':'어떤 질문을 준비할까요?')}</h2>{question||activity||briefingId?<div className="on-starter-list">{starterPrompts.map(p=><button key={p} disabled={disabled} onClick={()=>void send(p)}>{p}<ArrowUpRight size={16}/></button>)}</div>:<div className="on-activity-list">{activities.length>0&&<div className="search-field"><Search size={16}/><input aria-label="활동 검색" placeholder="활동 검색" value={activitySearch} onChange={e=>setActivitySearch(e.target.value)}/></div>}{activities.filter(a=>`${a.title} ${a.activity_summary||''}`.includes(activitySearch)).map(a=><Link href={activityHref(a.id)} key={a.id}><span><strong>{a.title}</strong><small>{[a.grade&&`${a.grade}학년`,a.area].filter(Boolean).join(' · ')}</small></span><ArrowUpRight size={18}/></Link>)}{!activities.length&&questions.map(q=>{const next=new URLSearchParams({questionId:q.id});if(selection.targetId)next.set('targetId',selection.targetId);if(pinnedVersion)next.set('sourceVersion',String(pinnedVersion));return<Link href={`/on?${next}`} key={q.id}><strong>{q.prompt}</strong><ArrowUpRight size={18}/></Link>;})}{!activities.length&&!questions.length&&<p className="muted">{data.targets.length?'질문이나 활동을 선택해 주세요.':<Link href="/schools/new">지원 학교 등록하기</Link>}</p>}</div>}</div>}
 {messages.map(m=><div key={m.id} className={`message ${m.role}`} role="article" aria-label={`${m.role==='assistant'?'AI 비서':data.user.name} 메시지`}>
  <div className="message-avatar">{m.role==='assistant'?<Logo size={23} wordmark={false}/>:data.user.name.slice(0,1)}</div>
  <div className="message-body"><span className="message-author">{m.role==='assistant'?'AI 비서':data.user.name}</span>
   {(m.attachments||m.data?.attachments)?.length>0&&<div className="chat-attached-sources">{(m.attachments||m.data.attachments).map((file:Item)=><a key={file.id} href={file.url||`/api/chat/attachments/${file.id}`} target="_blank" rel="noopener"><Paperclip size={14}/>{file.name}</a>)}</div>}
   <div className="message-content" data-streaming={m.status==='pending'}>{m.role==='assistant'&&m.content?<MarkdownMessage content={m.content} humanizeLearningStatuses/>:m.content||(m.status==='pending'?<span className="typing-dots" aria-label="응답 작성 중"><i/><i/><i/></span>:m.status==='failed'?m.error||m.data?.error||'응답이 중단됐어요.':'')}{m.status==='pending'&&m.content&&<span className="chat-stream-cursor" aria-hidden="true"/>}</div>
   {m.status==='failed'&&m.content&&<small className="chat-interrupted-note">응답이 여기서 중단됐어요.</small>}
   {(m.sources||m.data?.sources)?.length>0&&<div className="message-sources">{(m.sources||m.data.sources).map((s:Item,i:number)=><button key={i} onClick={()=>openResource({kind:sourceKind(s),id:s.id})}><Bookmark size={13}/>{s.title||s.label||'연결 근거'}<ArrowUpRight size={12}/></button>)}</div>}
   {m.role==='assistant'&&canSaveCandidate&&m.status!=='pending'&&m.status!=='failed'&&<button className="message-save" onClick={()=>saveCandidate(m)}><Bookmark size={13}/>답변 후보 저장</button>}
  </div>
 </div>)}{busy&&!pendingResponse&&<div className="message assistant"><Logo size={24} wordmark={false}/><div className="typing-dots"><i/><i/><i/></div></div>}<div ref={bottom}/></div>
 {(error||previewError)&&<Alert>{previewError||error}{threadId&&!previewError&&<button className="text-link" disabled={busy} onClick={reload}>대화 다시 불러오기</button>}</Alert>}
 {pendingResponse&&!busy&&!error&&<button className="text-link" onClick={reload}>대화 다시 불러오기</button>}
 <input ref={attachmentInput} type="file" className="sr-only" tabIndex={-1} aria-label="첨부 파일 선택" accept=".pdf,.docx,.txt,.md,image/png,image/jpeg,image/webp,image/gif" multiple onChange={event=>void uploadAttachments(event.target.files)}/>
 {(attachments.length>0||uploading)&&<div className="chat-attachment-queue">{attachments.map(file=><div key={file.id}><Paperclip size={14}/><span>{file.name}</span><small>{Math.max(1,Math.round(file.size/1024))} KB</small><button type="button" disabled={busy||uploading} aria-label={`${file.name} 첨부 취소`} onClick={()=>void removeAttachment(file.id)}><X size={14}/></button></div>)}{uploading&&<span><LoaderCircle size={14} className="spin"/>자료 읽는 중</span>}</div>}
 <ChatComposer textareaRef={textarea} label="AI 비서 메시지" placeholder={ready?briefingId?'이 기사에 대해 이야기해 보세요.':question||!data.package?'이 질문에 대해 물어보세요.':'내 경험에 대해 물어보세요.':previewLoading||loading?'질문을 불러오는 중이에요.':'질문이나 활동을 먼저 선택해 주세요.'} value={message} onChange={setMessage} onSend={send} maxLength={6000} busy={busy} disabled={disabled} actions={<><button type="button" className="button ghost small" disabled={disabled||attachments.length>=3} onClick={()=>attachmentInput.current?.click()}><Paperclip size={15}/>자료 첨부</button>{busy&&<button type="button" className="button ghost small" onClick={()=>streamController.current?.abort()}><Square size={13} fill="currentColor"/>응답 멈추기</button>}</>} />
 </section></div></div>;
}



