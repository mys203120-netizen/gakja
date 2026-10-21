'use client';
import {useEffect,useState} from 'react';
import Link from 'next/link';
import {ArrowRight,Check} from 'lucide-react';
import {useApp} from './app-shell';
import {api,type Item} from './shared';
import {nextTrainingStep,trainingStepHref,trainingTaskDone,type TrainingFlowTask} from '@/lib/training-flow';
import {ownedClassName} from './owned-class-name';
import styles from './training-continuation.module.css';

/** A return link never grants completion; the server reconstructs it from submitted records. */
export function TrainingContinuation({planId}:{planId?:string|null}){
 const {data,targetId,learningRevision}=useApp(),[value,setValue]=useState<Item|null>(null),[error,setError]=useState(''),[revision,setRevision]=useState(0);
 const scope=JSON.stringify([data.user.id,targetId,planId,learningRevision]);
 useEffect(()=>{
  if(!planId)return;const controller=new AbortController();setValue(null);setError('');
  api('/api/training?planId='+encodeURIComponent(planId),{signal:controller.signal,cache:'no-store'}).then(result=>{if(!controller.signal.aborted)setValue({...result,scope});}).catch(cause=>{if(!controller.signal.aborted)setError(cause.message);});
  return()=>controller.abort();
 },[planId,scope,revision]);
 if(!planId)return null;
 const current=value?.scope===scope?value:null,task:TrainingFlowTask|undefined=current?.today?.tasks.find((task:Item)=>task.id===planId),complete=task&&trainingTaskDone(task),next=complete?nextTrainingStep(current!.today.tasks as TrainingFlowTask[],planId):null;
 return <section className={ownedClassName(styles.continuation,true)} aria-label="오늘 계획 이어가기" aria-live="polite">
  {error?<><p className={ownedClassName(undefined,true)}>{error}</p><button className={ownedClassName('button ghost',true)} onClick={()=>setRevision(value=>value+1)}>다음 순서 다시 확인</button></>:!current?<p role="status" className={ownedClassName(undefined,true)}>저장한 기록을 오늘 계획에 반영하고 있어요.</p>:next?<><span className={ownedClassName(styles.label,true)}>{next.kind==='review'?'마지막 순서':'다음 순서'}</span><a className={ownedClassName(styles.next,true)} href={trainingStepHref(next)}><strong className={ownedClassName(undefined,true)}>{next.title}</strong><span className={ownedClassName(undefined,true)}>권장 {next.minutes}분<ArrowRight size={20}/></span></a></>:<><p className={ownedClassName(undefined,true)}>{complete?'오늘 계획을 모두 마쳤어요.':task?'답변은 저장됐어요. 남은 항목을 마치면 차시가 완료돼요.':'이 기록을 저장했어요. 오늘 계획을 확인해 보세요.'}</p><Link className={ownedClassName('button primary')} href={task&&!complete?'/my/train?planId='+encodeURIComponent(planId):'/my'}>{task&&!complete?'같은 차시로 돌아가기':'오늘 계획'}{complete?<Check size={16}/>:<ArrowRight size={16}/>}</Link></>}
 </section>;
}
