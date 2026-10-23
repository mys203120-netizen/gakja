'use client';
import {useEffect,useRef,useState} from 'react';
import {ArrowDown,ArrowUp,Check,Copy} from 'lucide-react';
import {useApp} from './app-shell';
import {api,post,Alert,ActionButton,Spinner} from './shared';
import {ownedClassName} from './owned-class-name';
import type {CompletedExample,ExampleBasis} from '@/lib/example-answer-model';
import styles from './completed-example-answer.module.css';
type Detail={basis:ExampleBasis;latest:CompletedExample|null;history:(CompletedExample&{stale:boolean})[]};

export function CompletedExampleAnswer({reportId,turnId}:{reportId:string;turnId:string}){
 const {data}=useApp(),scope=[data.user.id,reportId,turnId].join(':'),scopeRef=useRef(scope);scopeRef.current=scope;
 const [open,setOpen]=useState(false),[detail,setDetail]=useState<Detail|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[revision,setRevision]=useState(0);
 const [selected,setSelected]=useState<string[]>([]),[confirmed,setConfirmed]=useState(false),[editing,setEditing]=useState(false),[viewId,setViewId]=useState(''),[copied,setCopied]=useState(false);
 const request=useRef<string|null>(null);
 useEffect(()=>{setDetail(null);setSelected([]);setConfirmed(false);setEditing(false);setViewId('');setError('');setBusy(false);setLoading(false);request.current=null;},[scope]);
 useEffect(()=>{if(!open)return;const controller=new AbortController(),capture=scope;setLoading(true);setError('');
  api<Detail>('/api/interviews/example-answer?'+new URLSearchParams({reportId,turnId}),{cache:'no-store',signal:controller.signal}).then(value=>{if(!controller.signal.aborted&&scopeRef.current===capture){setDetail(value);setSelected([]);setConfirmed(false);request.current=null;setEditing(!value.latest);setViewId(value.latest?.id||'');}}).catch(err=>{if(!controller.signal.aborted&&scopeRef.current===capture)setError((err as Error).message);}).finally(()=>{if(!controller.signal.aborted&&scopeRef.current===capture)setLoading(false);});return()=>controller.abort();
 },[open,scope,revision,reportId,turnId]);
 function choose(id:string){setSelected(previous=>previous.includes(id)?previous.filter(value=>value!==id):[...previous,id]);setConfirmed(false);request.current=null;}
 function move(id:string,direction:number){setSelected(previous=>{const utterances=previous.filter(value=>detail?.basis.facts.find(fact=>fact.id===value)?.kind==='utterance'),position=utterances.indexOf(id),nextId=utterances[position+direction];if(position<0||!nextId)return previous;const index=previous.indexOf(id),next=previous.indexOf(nextId),result=[...previous];[result[index],result[next]]=[result[next],result[index]];return result;});setConfirmed(false);request.current=null;}
 async function save(){if(!detail||busy||!confirmed)return;setBusy(true);setError('');const capture=scope;request.current??=crypto.randomUUID();
  try{const result=await post('/api/interviews/example-answer',{reportId,turnId,basisHash:detail.basis.hash,factIds:selected,confirmed:true,requestId:request.current});if(scopeRef.current!==capture)return;setDetail(previous=>previous?{...previous,latest:result.example,history:[...previous.history.filter(item=>item.id!==result.example.id),{...result.example,stale:false}]}:previous);setViewId(result.example.id);setEditing(false);setConfirmed(false);request.current=null;}
  catch(err){if(scopeRef.current===capture)setError((err as Error).message);}finally{if(scopeRef.current===capture)setBusy(false);}
 }
 const example=detail?.history.find(item=>item.id===viewId)||detail?.latest,chosen=selected.map(id=>detail?.basis.facts.find(fact=>fact.id===id)).filter(Boolean),enough=chosen.some(f=>f?.kind==='record')&&chosen.some(f=>f?.kind==='utterance')&&chosen.filter(f=>f?.kind==='utterance').map(f=>f!.text).join(' ').length>=40;
 return <details className={styles.panel} onToggle={event=>setOpen(event.currentTarget.open)}><summary>완성 예시답변</summary>{open&&<div className={styles.content}>
  <p className={styles.caption}>생기부 원문과 내가 한 답변을 확인해 한 문단으로 완성해요.</p>
  {error&&<Alert>{error}<button type="button" className={styles.reload} disabled={loading||busy} onClick={()=>setRevision(value=>value+1)}>새로 불러오기</button></Alert>}
  {loading?<Spinner/>:detail&&<>
   {!editing&&example?<>
    <div className={styles.resultHeading}><strong>완성 예시 · {example.version}차</strong><button type="button" className={styles.copy} onClick={async()=>{try{await navigator.clipboard.writeText(example.answer);setCopied(true);}catch{setError('복사를 허용하지 않는 브라우저예요. 아래 문장을 직접 선택해 주세요.');}}}>{copied?<Check size={15}/>:<Copy size={15}/>} {copied?'복사됨':'문장 복사'}</button></div>
    <p className={styles.caption}>{example.method==='grounded_rewrite'?'확인한 사실로 다듬은 AI 예시':'AI 연결 없이 확인한 원발화로 완성한 예시'}</p>
    <p className={styles.answer}>{example.answer}</p>
    {example.basisHash!==detail.basis.hash&&<p className={styles.notice}>이후 사실 확인 내용이 바뀐 버전이에요. 현재 근거를 다시 확인해 주세요.</p>}
    <p className={styles.caption}>{example.note}</p>
    <details className={styles.evidence}><summary>사용한 문장과 원문 근거</summary>{example.citations.map(fact=><blockquote key={fact.id}><span>{fact.label}</span><p>{fact.text}</p></blockquote>)}</details>
    {detail.history.length>1&&<label className={styles.history}>저장한 버전<select value={example.id} onChange={event=>{setViewId(event.target.value);setCopied(false);}}>{[...detail.history].reverse().map(item=><option key={item.id} value={item.id}>{item.version}차 · {new Date(item.createdAt).toLocaleDateString('ko-KR')}{item.stale?' · 근거 변경 전':''}</option>)}</select></label>}
    <button type="button" className={styles.reload} onClick={()=>{setSelected([]);setConfirmed(false);setEditing(true);setCopied(false);}}>사실을 다시 골라 새 예시 만들기</button>
   </>:detail.basis.blocked?<p className={styles.notice}>{detail.basis.reason}</p>:<>
    <fieldset className={styles.facts} disabled={busy}><legend>사실인 문장만 골라 주세요</legend><p className={styles.caption}>생기부 근거와 원답변을 각각 하나 이상 골라요. 고른 원답변의 순서가 예시의 순서가 돼요.</p>{(['record','utterance'] as const).map(kind=><div key={kind} className={styles.factGroup}><h4>{kind==='record'?'생기부 원문 근거':'내 원답변'}</h4>{detail.basis.facts.filter(fact=>fact.kind===kind).map(fact=><label key={fact.id} className={styles.fact}><input type="checkbox" checked={selected.includes(fact.id)} onChange={()=>choose(fact.id)}/><span><small>{fact.label}</small>{fact.text}</span></label>)}</div>)}</fieldset>
    {selected.length>0&&<ol className={styles.order} aria-label="예시답변 문장 순서">{chosen.filter(fact=>fact?.kind==='utterance').map((fact,index,array)=><li key={fact!.id}><span>{fact!.text}</span><div><button type="button" aria-label={`${index+1}번 문장 위로`} disabled={busy||index===0} onClick={()=>move(fact!.id,-1)}><ArrowUp size={16}/></button><button type="button" aria-label={`${index+1}번 문장 아래로`} disabled={busy||index===array.length-1} onClick={()=>move(fact!.id,1)}><ArrowDown size={16}/></button></div></li>)}</ol>}
    <label className={styles.confirm}><input type="checkbox" disabled={busy||!enough} checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>고른 원문과 답변이 내 실제 경험과 맞고, 내가 한 행동임을 확인했어요.</label>
    {!enough&&<p className={styles.caption}>생기부 근거와 40자 이상의 원답변을 고르면 완성할 수 있어요. 내용이 부족하면 이 질문을 한 번 더 연습해 보세요.</p>}
    <div className={styles.actions}><ActionButton className={ownedClassName('button primary')} pending={busy} disabled={!confirmed||!enough} onClick={()=>void save()}>확인한 사실로 예시 완성</ActionButton>{detail.latest&&<button type="button" className={styles.reload} disabled={busy} onClick={()=>setEditing(false)}>저장한 예시로 돌아가기</button>}</div>
   </>}
  </>}
 </div>}</details>;
}
