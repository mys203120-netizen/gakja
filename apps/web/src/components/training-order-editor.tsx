'use client';
import {useState} from 'react';
import {ArrowUp,ArrowDown,ChevronDown} from 'lucide-react';
import {trainingOrderError} from '@/lib/training-order';
import {ActionButton,Alert,post} from './shared';
import styles from './training-order-editor.module.css';
type Task={id:string;title:string;kind:string;startedAt?:string;completed?:boolean;manual?:boolean;status:string};
export function TrainingOrderEditor({tasks,onSaved}:{tasks:Task[];onSaved:()=>void}){
 const current=tasks.filter(task=>!task.manual&&task.kind!=='break');
 const key=current.map(task=>task.id+':'+task.status).join('|');
 return current.length<2?null:<Editor key={key} tasks={current} onSaved={onSaved}/>;
}
function Editor({tasks,onSaved}:{tasks:Task[];onSaved:()=>void}){
 const [ids,setIds]=useState(tasks.map(task=>task.id)),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const changed=ids.some((id,index)=>id!==tasks[index].id);
 function moved(index:number,delta:number){const next=[...ids],to=index+delta;if(to<0||to>=ids.length)return null;[next[index],next[to]]=[next[to],next[index]];return trainingOrderError(tasks,next)?null:next;}
 async function save(){if(busy||!changed)return;setBusy(true);setError('');try{await post('/api/training',{action:'task_reorder',ids});onSaved();}catch(cause){setError((cause as Error).message);}finally{setBusy(false);}}
 return <details className={styles.editor}><summary>훈련 순서 바꾸기<ChevronDown size={16}/></summary><p>시작 전 훈련의 순서를 조정해요. 오늘 정리는 마지막에 남겨요.</p><ol>{ids.map((id,index)=>{const task=tasks.find(task=>task.id===id)!;return <li key={id}><span>{task.title}</span><button type="button" aria-label={task.title+' 위로 이동'} disabled={busy||!moved(index,-1)} onClick={()=>setIds(moved(index,-1)!)}><ArrowUp size={17}/></button><button type="button" aria-label={task.title+' 아래로 이동'} disabled={busy||!moved(index,1)} onClick={()=>setIds(moved(index,1)!)}><ArrowDown size={17}/></button></li>;})}</ol>{error&&<Alert>{error}</Alert>}<ActionButton className="button secondary" pending={busy} disabled={!changed} onClick={()=>void save()}>순서 저장</ActionButton></details>;
}
