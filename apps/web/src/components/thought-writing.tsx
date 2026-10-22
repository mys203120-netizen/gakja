'use client';
import {useEffect,useRef,useState} from 'react';
import {Sparkles,Undo2,Square} from 'lucide-react';
import {assertDeviceDocumentCurrent} from '@/lib/client/device-storage';
import type {WritingContext,WritingProposal} from '@/lib/thought-writing-model';
import {api,Alert,Modal,ActionButton} from './shared';
import {ownedClassName} from './owned-class-name';
import styles from './thought-writing.module.css';

type Props={userId:string;kind:'experience'|'chat';scopeId:string;scopeKey:string;field?:'situation'|'action'|'result';value:string;original?:string;savedOriginal?:string;context?:WritingContext;disabled?:boolean;onApply:(text:string,receipt:{requestId:string;original:string;undo:boolean})=>void};
export function ThoughtWriting({userId,kind,scopeId,scopeKey,field,value,original='',savedOriginal,context={},disabled=false,onApply}:Props){
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[baseline,setBaseline]=useState(''),[proposal,setProposal]=useState<WritingProposal|null>(null),[edited,setEdited]=useState(''),[answer,setAnswer]=useState(''),[history,setHistory]=useState<{question:string;answer:string}[]>([]),[receipt,setReceipt]=useState(''),[undo,setUndo]=useState<{before:string;after:string;requestId:string;scope:string}|null>(null);
 const request=useRef<{controller:AbortController;id:string;scope:string}|null>(null),identity=useRef<{digest:string;id:string}|null>(null),latest=useRef({value,scopeKey,disabled,onApply,userId});
 latest.current={value,scopeKey,disabled,onApply,userId};
 const limit=kind==='experience'?2000:6000;
 function cancel(){const active=request.current;request.current=null;active?.controller.abort();setBusy(false);setOpen(false);setError('');}
 useEffect(()=>{setOpen(false);setBusy(false);setError('');setProposal(null);setUndo(null);identity.current=null;return()=>{const active=request.current;request.current=null;active?.controller.abort();};},[scopeKey]);
 useEffect(()=>{if(open&&value!==baseline)cancel();},[value]);
 function begin(){if(disabled||!value.trim())return;try{assertDeviceDocumentCurrent(userId);setBaseline(value);setProposal(null);setEdited('');setAnswer('');setHistory([]);setReceipt('');setError('');setOpen(true);}catch(reason){setError((reason as Error).message);}}
 async function generate(followup=false){
  if(request.current||disabled)return;
  const nextHistory=followup&&proposal?.followup_question&&answer.trim()?[...history,{question:proposal.followup_question,answer:answer.trim()}]:history;
  if(followup&&!answer.trim())return;
  const input={kind,scopeId,field,source:baseline,original,history:nextHistory,context},digest=JSON.stringify(input);
  if(identity.current?.digest!==digest)identity.current={digest,id:crypto.randomUUID()};
  const active={controller:new AbortController(),id:identity.current!.id,scope:scopeKey};request.current=active;setBusy(true);setError('');
  try{
   assertDeviceDocumentCurrent(userId);
   const result=await api('/api/writing/draft',{method:'POST',body:JSON.stringify({...input,requestId:active.id}),signal:active.controller.signal});
   if(request.current!==active||latest.current.scopeKey!==active.scope||latest.current.value!==baseline||latest.current.disabled)return;
   assertDeviceDocumentCurrent(userId);setProposal(result.proposal);setEdited(result.proposal.draft);setReceipt(result.requestId);setHistory(nextHistory);setAnswer('');
  }catch(reason){if(request.current===active&&!active.controller.signal.aborted)setError((reason as Error).message);}
  finally{if(request.current===active){request.current=null;setBusy(false);}}
 }
 function apply(){
  if(!proposal||!edited.trim()||edited.length>limit||busy)return;
  try{assertDeviceDocumentCurrent(userId);if(latest.current.scopeKey!==scopeKey||latest.current.value!==baseline||latest.current.disabled)throw Error('입력이나 화면이 바뀌었어요. 현재 글에서 다시 정리해 주세요.');
   latest.current.onApply(edited,{requestId:receipt,original:baseline,undo:false});setUndo({before:baseline,after:edited,requestId:receipt,scope:scopeKey});setOpen(false);
  }catch(reason){setError((reason as Error).message);}
 }
 const restoration=undo&&value===undo.after?undo:savedOriginal!==undefined&&savedOriginal!==value?{before:savedOriginal,after:value,requestId:'',scope:scopeKey}:null;
 function restore(){if(!restoration)return;try{assertDeviceDocumentCurrent(userId);if(latest.current.scopeKey!==restoration.scope||latest.current.value!==restoration.after||latest.current.disabled)throw Error('적용 뒤 글이 달라졌어요. 현재 글을 유지했어요.');latest.current.onApply(restoration.before,{requestId:restoration.requestId,original:restoration.before,undo:true});setUndo(null);setError('');}catch(reason){setError((reason as Error).message);}}
 return <span className={ownedClassName(styles.tools,true)}><button type="button" className={ownedClassName('button ghost small')} disabled={disabled||!value.trim()} onClick={begin}><Sparkles size={15}/>문장 정리</button>{restoration&&<button type="button" className={ownedClassName('button ghost small')} disabled={disabled} onClick={restore}><Undo2 size={14}/>원문으로</button>}{error&&!open&&<span role="status" className={ownedClassName(styles.inlineError,true)}>{error}</span>}
 {open&&<Modal title="키워드를 내 말로 정리" onClose={cancel}><div className={ownedClassName(styles.dialog,true)}><details open={!proposal}><summary>입력한 원문</summary><p className={ownedClassName(styles.original,true)}>{baseline}</p></details>
 {proposal&&<><label>정리한 문장 · 직접 고칠 수 있어요<textarea aria-label="정리한 문장" rows={5} value={edited} maxLength={limit} disabled={busy} onChange={event=>setEdited(event.target.value)}/></label>{proposal.followup_question&&history.length<6&&<div className={ownedClassName(styles.followup,true)}><label>{proposal.followup_question}<textarea aria-label="꼬리질문에 답하기" rows={2} maxLength={2000} value={answer} disabled={busy} onChange={event=>setAnswer(event.target.value)} placeholder="기억나는 키워드만 적어도 괜찮아요."/></label><ActionButton className={ownedClassName('button')} disabled={!answer.trim()} pending={busy} pendingLabel="다시 정리 중" onClick={()=>void generate(true)}>이 내용도 반영하기</ActionButton></div>}</>}
 {error&&<Alert>{error}</Alert>}<div className={ownedClassName(styles.actions,true)}>{busy?<button type="button" className={ownedClassName('button')} onClick={()=>{const active=request.current;request.current=null;active?.controller.abort();setBusy(false);}}><Square size={13}/>정리 멈추기</button>:<button type="button" className={ownedClassName('button')} onClick={cancel}>취소</button>}{proposal?<button type="button" className={ownedClassName('button primary')} disabled={busy||!edited.trim()} onClick={apply}>확인하고 적용</button>:<ActionButton className={ownedClassName('button primary')} pending={busy} pendingLabel="문장 정리 중" onClick={()=>void generate()}>문장으로 정리</ActionButton>}</div></div></Modal>}</span>;
}
