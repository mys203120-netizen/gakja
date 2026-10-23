'use client';
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {ArrowRight,ChevronDown,Undo2} from 'lucide-react';
import type {ReviewPlacementSuggestion,ReviewPlacementPreview} from '@/lib/training-review-placement';
import type {CalendarEditPreview} from '@/lib/calendar-edit';
import {api,post,Alert,Modal} from './shared';
import {SettingsSelect} from './settings-select';
import {ownedClassName} from './owned-class-name';
import styles from './training-review-placement.module.css';

type Proposal={preview:ReviewPlacementPreview;fingerprint:string};
type UndoProposal={preview:CalendarEditPreview;fingerprint:string;operationId:string};
const day=(value:string)=>`${Number(value.slice(5,7))}월 ${Number(value.slice(8))}일`;
/** One optional action: inspect an area change before writing any plan. */
export function TrainingReviewPlacement({enabled,onChanged}:{enabled:boolean;onChanged:()=>void}){
 const [suggestions,setSuggestions]=useState<ReviewPlacementSuggestion[]|null>(null),[selected,setSelected]=useState(''),[date,setDate]=useState(''),[proposal,setProposal]=useState<Proposal|null>(null),[undo,setUndo]=useState<UndoProposal|null>(null),[operationId,setOperationId]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[revision,setRevision]=useState(0);
 const alive=useRef(true),flight=useRef(false);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{
  if(!enabled)return;const controller=new AbortController();setError('');
  void Promise.all([api<{suggestions:ReviewPlacementSuggestion[]}>('/api/training/review-placement',{signal:controller.signal,cache:'no-store'}),api<{history:Array<{id:string;mode:string}>}>('/api/planner/calendar',{signal:controller.signal,cache:'no-store'})]).then(([result,history])=>{
   if(controller.signal.aborted)return;setSuggestions(result.suggestions);setSelected(result.suggestions[0]?.questionKey||'');setDate(result.suggestions[0]?.candidates[0]?.date||'');setOperationId(history.history.find(item=>item.mode==='review')?.id||'');
  }).catch(error=>{if(!controller.signal.aborted)setError((error as Error).message);});
  return()=>controller.abort();
 },[enabled,revision]);
 const current=suggestions?.find(item=>item.questionKey===selected),modal=Boolean(proposal||undo);
 async function act(action:'preview'|'apply'|'undoPreview'|'undo'){
  if(flight.current)return;flight.current=true;setBusy(true);setError('');
  try{
   if(action==='preview'){
    const value=await post('/api/training/review-placement',{action,selection:{questionKey:selected,date}});if(alive.current)setProposal(value);
   }else if(action==='undoPreview'){
    const value=await post('/api/planner/calendar',{action,operationId});if(alive.current)setUndo(value);
   }else{
    const value=action==='apply'?await post('/api/training/review-placement',{action,selection:{questionKey:proposal!.preview.questionKey,date:proposal!.preview.date},fingerprint:proposal!.fingerprint}):await post('/api/planner/calendar',{action,operationId:undo!.operationId,fingerprint:undo!.fingerprint});
    if(!alive.current)return;setProposal(null);setUndo(null);setOperationId(action==='apply'?value.operationId:'');setNotice(action==='apply'?'보완 영역을 편성했어요. 연습을 시작하기 전에는 되돌릴 수 있어요.':'보완 편성 전 계획으로 되돌렸어요.');setRevision(value=>value+1);onChanged();
   }
  }catch(error){if(alive.current)setError((error as Error).message);}finally{flight.current=false;if(alive.current)setBusy(false);}
 }
 if(!enabled&&!notice)return null;
 if(suggestions?.length===0&&!operationId&&!error&&!notice)return null;
 const close=()=>{if(!busy){setProposal(null);setUndo(null);setError('');}};
 return <section className={ownedClassName(styles.root,true)} aria-label="면접 전 보완 영역 편성">
  <details><summary>면접 전 보완 날짜 확인{suggestions?.length?` · ${suggestions.length}개 영역`:''}<ChevronDown size={16}/></summary><div className={styles.body}>
   {!suggestions&&!error&&<p role="status">학교·자료·영역별 가용일을 확인하고 있어요.</p>}
   {Boolean(suggestions?.length)&&<>
    <SettingsSelect label="보완할 영역" fullWidth value={selected} disabled={busy} options={suggestions!.map(item=>({value:item.questionKey,label:`${item.school} · ${item.area}`}))} onChange={key=>{setSelected(key);setDate(suggestions!.find(item=>item.questionKey===key)?.candidates[0]?.date||'');setError('');}}/>
    {current&&<><p>{current.message}</p><dl className={styles.evidence}><div><dt>보완 질문</dt><dd>{current.title}</dd></div><div><dt>편성 근거</dt><dd>{current.reason}</dd></div><div><dt>기준 자료</dt><dd>{current.sourceType==='personal'?'개인 자료':'공통 질문'} {current.sourceVersion}판 · {current.area}</dd></div>{current.deadline&&<div><dt>{current.deadlineLabel}</dt><dd>{day(current.deadline)} 전까지</dd></div>}</dl>
     {current.status==='ready'&&<><SettingsSelect label="제안 날짜" fullWidth disabled={busy} value={date} options={current.candidates.map(item=>({value:item.date,label:`${day(item.date)} · ${item.minutes}분 · ${item.before.length?`자동 계획 ${item.before.length}개 교체`:'빈 가용일'}`}))} onChange={setDate}/><button type="button" className={ownedClassName('button secondary',true)} disabled={busy||!date} onClick={()=>void act('preview')}>변경 미리보기<ArrowRight size={15}/></button></>}
     {current.resolution&&<Link href={current.resolution.href} className={ownedClassName('text-link',true)}>{current.resolution.label}<ArrowRight size={14}/></Link>}
     {!!current.conflicts.length&&<details className={styles.conflicts}><summary>바꾸지 않는 날짜 · {current.conflicts.length}일</summary><ul>{current.conflicts.map(item=><li key={item.date}>{day(item.date)} · {item.reason}</li>)}</ul><Link href="/preparation#training-calendar">캘린더에서 직접 확인</Link></details>}
    </>}
   </>}
   {suggestions?.length===0&&<p>남은 보완 질문은 같은 학교·자료 버전·영역의 일정에 연결되어 있어요.</p>}
   {operationId&&<button type="button" className={ownedClassName('text-link',true)} disabled={busy} onClick={()=>void act('undoPreview')}><Undo2 size={14}/>최근 보완 편성 되돌리기</button>}
   {error&&!modal&&<><Alert>{error}</Alert><button type="button" className={ownedClassName('text-link',true)} disabled={busy} onClick={()=>setRevision(value=>value+1)}>다시 확인</button></>}
  </div></details>
  {notice&&<p role="status" className={styles.notice}>{notice}</p>}
  {modal&&<Modal title={undo?'보완 편성을 되돌릴까요?':'보완 영역으로 바꿀까요?'} onClose={close}><div className={styles.body}>
   {proposal&&<><p><strong>{day(proposal.preview.date)} · {proposal.preview.area} · {proposal.preview.minutes}분</strong></p><p>{proposal.preview.school} · {proposal.preview.sourceType==='personal'?'개인 자료':'공통 질문'} {proposal.preview.sourceVersion}판</p><p>{proposal.preview.reason}</p><div className={styles.comparison}><section><h3>변경 전</h3>{proposal.preview.before.length?<ol>{proposal.preview.before.map(item=><li key={item.id}>{item.title}</li>)}</ol>:<p>등록된 계획 없음</p>}</section><section><h3>변경 후</h3><ol>{proposal.preview.after.map(item=><li key={item.sequence}>{item.title}<span>{item.minutes}분</span></li>)}</ol></section></div><p className={styles.note}>이 날짜의 미시작 자동 계획 전체를 표시된 순서로 교체해요. 직접 추가·이동·정렬하거나 시작·완료한 일정은 후보에서 제외했어요. 새 순서는 하루 한 영역과 화상 연습을 유지해요.</p></>}
   {undo&&<><p>{undo.preview.replacement?day(undo.preview.replacement.date):''}의 편성 전 계획을 복원해요.</p><div className={styles.comparison}><section><h3>현재 보완 순서</h3><ol>{undo.preview.replacement?.before.map((title,index)=><li key={index}>{title}</li>)}</ol></section><section><h3>복원할 순서</h3>{undo.preview.replacement?.after.length?<ol>{undo.preview.replacement.after.map((title,index)=><li key={index}>{title}</li>)}</ol>:<p>등록된 계획 없음</p>}</section></div><p className={styles.note}>편성 이후 수정하거나 시작한 학습이 있으면 되돌리지 않아요.</p></>}
   {error&&<Alert>{error}</Alert>}<div className={ownedClassName('form-actions',true)}><button type="button" className={ownedClassName('button secondary',true)} disabled={busy} onClick={close}>취소</button><button type="button" className={ownedClassName('button primary',true)} disabled={busy} onClick={()=>void act(undo?'undo':'apply')}>{busy?'확인 중':undo?'편성 되돌리기':'이 일정으로 적용'}</button></div>
  </div></Modal>}
 </section>;
}
