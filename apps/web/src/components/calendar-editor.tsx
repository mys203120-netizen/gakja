'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {ownedClassName} from './owned-class-name';
import {ArrowRight,CalendarDays,Undo2,MoveRight,GripVertical} from 'lucide-react';
import {calendarPlanMovable,type CalendarEditRequest,type CalendarEditPreview} from '@/lib/calendar-edit';
import {koreaToday,shiftPlanDay,validPlanDay} from '@/lib/planner-model';
import {api,post,Alert,Modal,type Item} from './shared';
import {SettingsSelect} from './settings-select';
import styles from './calendar-editor.module.css';

type History={id:string;label:string;mode:string;createdAt:string;count:number};
type Proposed={preview:CalendarEditPreview;fingerprint:string;request?:CalendarEditRequest;operationId?:string;undo?:boolean};
type DragSource={kind:'day'|'plan';value:string;day:string};
/** Mouse fallback also works when a browser surface cannot dispatch HTML5 drop events. */
export function createCalendarPointerDrag({document:doc,enabled,onVisual,onPreview}:{document:Document;enabled:(source:DragSource)=>boolean;onVisual:(source:DragSource|null,day:string)=>void;onPreview:(source:DragSource,day:string)=>void}){
 let gesture:{source:DragSource;pointerId:number;x:number;y:number;moved:boolean;root:Element}|null=null,claimed=false,disposed=false;
 let clickTimer:ReturnType<typeof setTimeout>|null=null;
 const suppressClick=(event:Event)=>{event.preventDefault();event.stopImmediatePropagation();clearClick();};
 function clearClick(){doc.removeEventListener('click',suppressClick,true);if(clickTimer!==null){clearTimeout(clickTimer);clickTimer=null;}}
 function removeListeners(){doc.removeEventListener('pointermove',move,true);doc.removeEventListener('pointerup',up,true);doc.removeEventListener('pointercancel',cancel,true);doc.defaultView?.removeEventListener('blur',cancel);}
 function reset(){removeListeners();gesture=null;onVisual(null,'');}
 function cancel(){claimed=true;reset();}
 function hitDay(x:number,y:number,root:Element){const target=doc.elementFromPoint(x,y)?.closest('[data-calendar-day]');const day=target?.getAttribute('data-calendar-day')||'';return target&&root.contains(target)&&validPlanDay(day)?day:'';}
 function move(event:PointerEvent){
  if(!gesture||event.pointerId!==gesture.pointerId)return;
  if(!enabled(gesture.source)){cancel();return;}
  if(!gesture.moved&&Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)<7)return;
  gesture.moved=true;if(event.cancelable)event.preventDefault();
  const day=hitDay(event.clientX,event.clientY,gesture.root);onVisual(gesture.source,day===gesture.source.day?'':day);
 }
 function up(event:PointerEvent){
  if(!gesture||event.pointerId!==gesture.pointerId)return;
  const value=gesture,day=hitDay(event.clientX,event.clientY,value.root),canApply=value.moved&&!claimed&&enabled(value.source)&&day&&day!==value.source.day;
  claimed=true;reset();
  if(!value.moved)return;
  // Suppress only the click produced by this mouse release, never the next deliberate click.
  if(event.cancelable)event.preventDefault();doc.addEventListener('click',suppressClick,true);clickTimer=setTimeout(clearClick,0);
  if(canApply)onPreview(value.source,day);
 }
 return {
  start(event:{pointerType:string;button:number;isPrimary?:boolean;pointerId:number;clientX:number;clientY:number;currentTarget:EventTarget|null;target:EventTarget|null},source:DragSource){
   if(disposed||event.pointerType!=='mouse'||event.button!==0||event.isPrimary===false||!enabled(source))return;
   const element=event.currentTarget as Element|null,root=element?.closest('#dashboard-planner'),target=event.target as Element|null;
   const control=target?.closest('button,input,textarea,select,[contenteditable="true"]');
   if(!root||control&&control!==element)return;
   clearClick();removeListeners();claimed=false;gesture={source,pointerId:event.pointerId,x:event.clientX,y:event.clientY,moved:false,root};
   doc.addEventListener('pointermove',move,{capture:true,passive:false});doc.addEventListener('pointerup',up,true);doc.addEventListener('pointercancel',cancel,true);doc.defaultView?.addEventListener('blur',cancel);
  },
  // A tracked mouse uses pointer movement throughout; cancelling native dragstart preserves pointerup.
  nativeStart(){if(disposed||gesture)return false;claimed=false;return true;},
  claimNativeDrop(){if(disposed||claimed)return false;claimed=true;reset();return true;},
  end(){if(!gesture)onVisual(null,'');},
  dispose(){disposed=true;removeListeners();clearClick();gesture=null;}
 };
}
const shortDate=(day:string)=>`${Number(day.slice(5,7))}월 ${Number(day.slice(8))}일`;
export function useCalendarEditor({plans,selected,onChanged}:{plans:Item[];selected:string;onChanged:(day:string)=>Promise<void>}){
 const [proposal,setProposal]=useState<Proposed|null>(null),[history,setHistory]=useState<History[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[dragging,setDragging]=useState(''),[dropDay,setDropDay]=useState('');
 const [text,setText]=useState(''),[destination,setDestination]=useState(shiftPlanDay(selected,1));
 const pending=useRef(false),historyRevision=useRef(0),current=useRef({history,busy,proposal});current.current={history,busy,proposal};
 const activePlans=useRef(plans);activePlans.current=plans;
 const pointerDrag=useRef<ReturnType<typeof createCalendarPointerDrag>|null>(null),previewRef=useRef(preview);previewRef.current=preview;
 function dragEnabled(source:DragSource){return !pending.current&&!current.current.busy&&!current.current.proposal&&!document.querySelector('dialog[open]')&&activePlans.current.some(plan=>(source.kind==='day'?plan.date===source.value:plan.id===source.value)&&calendarPlanMovable(plan as any));}
 useEffect(()=>{const controller=createCalendarPointerDrag({document,enabled:dragEnabled,onVisual:(source,day)=>{setDragging(source?.value||'');setDropDay(day);},onPreview:(source,day)=>void previewRef.current({...(source.kind==='plan'?{ids:[source.value]}:{fromDate:source.value}),toDate:day,mode:'move'})});pointerDrag.current=controller;return()=>{controller.dispose();pointerDrag.current=null;};},[]);
 useEffect(()=>{setDestination(shiftPlanDay(selected,1));},[selected]);
 useEffect(()=>{const controller=new AbortController(),revision=historyRevision.current;void api<{history:History[]}>('/api/planner/calendar',{signal:controller.signal,cache:'no-store'}).then(result=>{if(historyRevision.current===revision)setHistory(result.history);}).catch(()=>{});return()=>controller.abort();},[]);
 const requestUndo=useCallback(async(operationId?:string)=>{
  if(pending.current)return;pending.current=true;setBusy(true);setError('');
  try{const result=await post('/api/planner/calendar',{action:'undoPreview',...(operationId?{operationId}:{})});setProposal({...result,undo:true});}catch(error){setError((error as Error).message);}finally{pending.current=false;setBusy(false);}
 },[]);
 useEffect(()=>{function key(event:KeyboardEvent){const element=event.target as HTMLElement;if(!(event.ctrlKey||event.metaKey)||event.key.toLowerCase()!=='z'||event.shiftKey||element.isContentEditable||element.closest('input,textarea,select,[role="textbox"],dialog'))return;if(!current.current.history.length||current.current.busy||current.current.proposal)return;event.preventDefault();void requestUndo();}document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);},[requestUndo]);
 async function preview(request?:CalendarEditRequest,command?:string){
  if(pending.current)return;pending.current=true;setBusy(true);setError('');
  try{const result=await post('/api/planner/calendar',{action:'preview',...(command?{text:command}:{request})});setProposal(result);setNotice('');}catch(error){setError((error as Error).message);}finally{pending.current=false;setBusy(false);}
 }
 async function apply(){
  if(!proposal||pending.current)return;pending.current=true;setBusy(true);setError('');
  try{const result=await post('/api/planner/calendar',proposal.undo?{action:'undo',operationId:proposal.operationId,fingerprint:proposal.fingerprint}:{action:'apply',request:proposal.request,fingerprint:proposal.fingerprint});historyRevision.current++;setHistory(result.history||[]);setProposal(null);setText('');setNotice(proposal.undo?'변경 전 날짜로 되돌렸어요.':'일정을 변경했어요. Ctrl+Z로 되돌릴 수 있어요.');try{await onChanged(proposal.preview.changes[0].to);}catch{setError('일정은 저장했어요. 새 일정을 표시하려면 화면을 다시 불러와 주세요.');}}catch(error){setError((error as Error).message);}finally{pending.current=false;setBusy(false);}
 }
 const movable=plans.filter(plan=>plan.date===selected&&calendarPlanMovable(plan as any));
 const latestMerge=history.find(entry=>entry.mode==='merge');
 function dragProps(day:string){
  const canMove=plans.some(plan=>plan.date===day&&calendarPlanMovable(plan as any));
  return {draggable:canMove&&!busy,'data-calendar-day':day,'data-dragging':dragging===day||undefined,'data-drop-target':dropDay===day||undefined,
   onPointerDown:(event:React.PointerEvent)=>pointerDrag.current?.start(event,{kind:'day',value:day,day}),
   onDragStart:(event:React.DragEvent)=>{if(!canMove||!dragEnabled({kind:'day',value:day,day})||!pointerDrag.current?.nativeStart()){event.preventDefault();return;}event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-gakja-plan-day',day);setDragging(day);},
   onDragOver:(event:React.DragEvent)=>{if(!event.dataTransfer.types.some(type=>['application/x-gakja-plan-day','application/x-gakja-plan-id'].includes(type))||day===dragging)return;event.preventDefault();event.dataTransfer.dropEffect='move';setDropDay(day);},
   onDragLeave:()=>setDropDay(previous=>previous===day?'':previous),onDragEnd:()=>pointerDrag.current?.end(),
   onDrop:(event:React.DragEvent)=>{const from=event.dataTransfer.getData('application/x-gakja-plan-day'),id=event.dataTransfer.getData('application/x-gakja-plan-id');if(!id&&(!from||from===day))return;event.preventDefault();const source:DragSource=id?{kind:'plan',value:id,day:activePlans.current.find(plan=>plan.id===id)?.date||''}:{kind:'day',value:from,day:from};if(!dragEnabled(source)||!pointerDrag.current?.claimNativeDrop())return;void preview({...(id?{ids:[id]}:{fromDate:from}),toDate:day,mode:'move'});}
  };
 }
 function planDragProps(plan:Item){const source:DragSource={kind:'plan',value:plan.id,day:plan.date};return {draggable:calendarPlanMovable(plan as any)&&!busy,'data-dragging':dragging===plan.id||undefined,onPointerDown:(event:React.PointerEvent)=>pointerDrag.current?.start(event,source),onDragStart:(event:React.DragEvent)=>{if(!dragEnabled(source)||!pointerDrag.current?.nativeStart()){event.preventDefault();return;}event.stopPropagation();event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-gakja-plan-id',plan.id);setDragging(plan.id);},onDragEnd:()=>pointerDrag.current?.end()};}
 const controls=<div className={styles.editor}>
  <details><summary><MoveRight size={16}/>일정 옮기기<span>드래그 또는 문장으로 변경</span></summary><div className={styles.body}>
   <form className={styles.command} onSubmit={event=>{event.preventDefault();void preview(undefined,text);}}><label htmlFor="calendar-command">일정을 어떻게 바꿀까요?</label><textarea id="calendar-command" value={text} onChange={event=>setText(event.target.value)} maxLength={300} rows={2} placeholder="오늘 일정은 내일로 미뤄줘"/><button type="submit" className={ownedClassName("button secondary",true)} disabled={busy||!text.trim()}>변경 미리보기<ArrowRight size={15}/></button></form>
   <form className={styles.dateForm} onSubmit={event=>{event.preventDefault();void preview({fromDate:selected,toDate:destination,mode:'move'});}}><span>{shortDate(selected)} · 이동할 계획 {movable.length}개</span><label>옮길 날짜<input type="date" required min={koreaToday()} value={destination} onChange={event=>setDestination(event.target.value)}/></label><button type="submit" className={ownedClassName("text-link",true)} disabled={busy||!movable.length}>날짜 변경<ArrowRight size={15}/></button></form>
   {latestMerge&&<button type="button" className={ownedClassName("text-link",true)} onClick={()=>void requestUndo(latestMerge.id)} disabled={busy}>최근 병합 해제 · 원래 날짜로</button>}
  </div></details>
  {history.length>0&&<button type="button" className={styles.undo} onClick={()=>void requestUndo()} disabled={busy} aria-keyshortcuts="Control+Z Meta+Z"><Undo2 size={15}/>되돌리기<span>Ctrl+Z</span></button>}
  {(notice||dragging)&&<p role="status" className={styles.notice}>{dragging?<><GripVertical size={14}/>{plans.some(plan=>plan.id===dragging)?'선택한 계획을':`${shortDate(dragging)}의 미완료 계획을`} 원하는 날짜에 놓으세요.</>:notice}</p>}
  {error&&!proposal&&<Alert>{error}</Alert>}
  {proposal&&<Modal title="일정을 변경하시겠어요?" onClose={()=>{if(!busy){setProposal(null);setError('');}}}><div className={styles.preview}>
   {!proposal.undo&&proposal.request&&<><label className={styles.destination}>옮길 날짜<input type="date" min={koreaToday()} value={proposal.request.toDate} disabled={busy} onChange={event=>{if(validPlanDay(event.target.value))void preview({...proposal.request!,toDate:event.target.value});}}/></label><SettingsSelect label="배치 방식" fullWidth value={proposal.request.mode} disabled={busy} options={[{value:'move',label:'간격 유지해 이동'},{value:'merge',label:'선택한 날에 모으기'},{value:'shift',label:'기존 일정 뒤로 밀기'},{value:'spread',label:'하루에 하나씩 나누기'}]} onChange={mode=>void preview({...proposal.request!,mode:mode as CalendarEditRequest['mode']})}/></>}
   <p>{proposal.preview.label} · {proposal.preview.changes.length}개</p>
   <ul className={styles.changes}>{proposal.preview.changes.map(change=><li key={change.id}><span>{change.title}</span><div><time dateTime={change.from}>{shortDate(change.from)}</time><ArrowRight size={14}/><time dateTime={change.to}>{shortDate(change.to)}</time></div></li>)}</ul>
   {proposal.preview.excluded>0&&<p className={styles.note}>진행하거나 완료한 계획 {proposal.preview.excluded}개는 그대로 보관해요.</p>}
   {proposal.request?.mode==='shift'&&<p className={styles.note}>도착 날짜부터 뒤에 있는 미완료 계획도 함께 밀려요.</p>}
   {proposal.undo&&<p className={styles.note}>계획의 날짜를 되돌려요. 학습 답변과 기록은 유지돼요.</p>}
   {error&&<Alert>{error}</Alert>}
   <div className={ownedClassName("form-actions",true)}><button type="button" className={ownedClassName("button secondary",true)} disabled={busy} onClick={()=>{setProposal(null);setError('');}}>취소</button><button type="button" className={ownedClassName("button primary",true)} disabled={busy} onClick={()=>void apply()}>{busy?'변경 중':proposal.undo?'변경 되돌리기':'일정 변경'}</button></div>
  </div></Modal>}
 </div>;
 return {controls,dragProps,planDragProps,busy,moveOne:(plan:Item)=>void preview({ids:[plan.id],toDate:destination,mode:'move'})};
}
