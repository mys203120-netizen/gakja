'use client';
import {useEffect,useRef,useState} from 'react';
import {Mic,Square,Volume2} from 'lucide-react';
import {INTERVIEW_CHARACTERS} from '@/lib/interview-policy';
import {createLiveAnswerCapture,type LiveAnswerCapture} from '@/lib/client/live-interview-recorder';
import {post} from './shared';
import styles from './live-interview-session.module.css';

export function InterviewCoach({sessionId,turnId,characterId,consent,onClose,onResume,onRetry,onSaved}:{sessionId:string;turnId:string;characterId:string;consent:boolean;onClose:()=>void;onResume:()=>void;onRetry:()=>void;onSaved:()=>Promise<void>}){
 const person=INTERVIEW_CHARACTERS.find(value=>value.id===characterId)||INTERVIEW_CHARACTERS[0];
 const [message,setMessage]=useState(''),[reply,setReply]=useState<{reply:string;requestId:string;message:string}|null>(null),[busy,setBusy]=useState(false),[recording,setRecording]=useState(false),[error,setError]=useState('');
 const capture=useRef<LiveAnswerCapture|null>(null),stream=useRef<MediaStream|null>(null),audio=useRef<HTMLAudioElement|null>(null),url=useRef(''),alive=useRef(true),requestId=useRef(crypto.randomUUID());
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;capture.current?.dispose();stream.current?.getTracks().forEach(track=>track.stop());audio.current?.pause();if(url.current)URL.revokeObjectURL(url.current);};},[]);
 const scope={sessionId,turnId,characterId,requestId:requestId.current};
 async function send(body:Record<string,unknown>|FormData){
  setBusy(true);setError('');try{const response=body instanceof FormData?await fetch('/api/interviews/coach',{method:'POST',body}):null;
   const value=response?await response.json():await post('/api/interviews/coach',body as Record<string,unknown>);
   if(response&&!response.ok)throw new Error(value.error||'도움을 불러오지 못했어요.');
   if(!alive.current)return;setReply(value);setMessage(value.message);await onSaved();requestId.current=crypto.randomUUID();
  }catch(cause){if(alive.current)setError((cause as Error).message);}finally{if(alive.current)setBusy(false);}
 }
 async function startVoice(){
  if(!consent||busy||recording)return;setError('');audio.current?.pause();
  try{const next=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});if(!alive.current){next.getTracks().forEach(track=>track.stop());return;}stream.current=next;
   const nextCapture=createLiveAnswerCapture(next,{autoStop:()=>false,maxDurationMs:30000});capture.current=nextCapture;setRecording(true);
   const value=await nextCapture.finished;next.getTracks().forEach(track=>track.stop());capture.current=null;stream.current=null;if(!alive.current)return;setRecording(false);
   const form=new FormData();for(const [key,value] of Object.entries(scope))form.set(key,value);form.set('consent','true');form.set('durationSeconds',String(value.durationMs/1000));form.set('recording',value.blob,'help.webm');await send(form);
  }catch(cause){stream.current?.getTracks().forEach(track=>track.stop());if(alive.current){setRecording(false);setError((cause as Error).message);}}
 }
 async function listen(){
  if(!reply||busy||recording)return;setBusy(true);setError('');try{audio.current??=new Audio();const response=await fetch('/api/interviews/coach',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...scope,requestId:reply.requestId,action:'speech'})});if(!response.ok){const value=await response.json();throw new Error(value.error);}
   const blob=await response.blob();if(!alive.current)return;if(url.current)URL.revokeObjectURL(url.current);url.current=URL.createObjectURL(blob);audio.current.src=url.current;await audio.current.play();
  }catch(cause){if(alive.current)setError((cause as Error).message);}finally{if(alive.current)setBusy(false);}
 }
 function leave(next:()=>void){audio.current?.pause();next();}
 return <section className={styles.coachPanel} aria-label={`${person.name}의 도움`}><div className={styles.coachHeading}><h2>{person.name}에게 도움받기</h2><button type="button" className="text-link" disabled={busy||recording} onClick={()=>leave(onClose)}>닫기</button></div><p>어느 부분이 막혔나요? 도움 대화는 답변과 따로 보관해요.</p>
  <label>도움 요청<textarea value={message} maxLength={1200} disabled={busy||recording} onChange={event=>{setMessage(event.target.value);requestId.current=crypto.randomUUID();}} placeholder="예: 제 역할을 어떻게 설명하면 좋을지 막혔어요."/></label>
  <div className={styles.actions}><button type="button" className="button secondary" disabled={busy||!consent} onClick={()=>recording?void capture.current?.stop('manual'):void startVoice()}>{recording?<Square size={16}/>:<Mic size={16}/>} {recording?'요청 말하기 완료':'목소리로 도움 요청'}</button><button type="button" className="button primary" disabled={busy||recording||!message.trim()} onClick={()=>void send({...scope,message})}>{busy?'확인 중':'힌트 받기'}</button></div>
  {error&&<p role="alert" className={styles.error}>{error}</p>}{reply&&<div className={styles.coachReply}><strong>{person.name}의 힌트</strong><p>{reply.reply}</p><button type="button" className="text-link" disabled={busy||recording} onClick={()=>void listen()}><Volume2 size={16}/>힌트 듣기</button></div>}
  <div className={styles.actions}><button type="button" className="button secondary" disabled={busy||recording} onClick={()=>leave(onResume)}>원래 질문 이어서 답하기</button><button type="button" className="text-link" disabled={busy||recording} onClick={()=>leave(onRetry)}>처음부터 다시 답하기</button></div>
 </section>;
}
