import 'server-only';
import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {ApiError,transaction,query} from './db';
import {koreaToday} from './planner-model';
import {calendarPlanMovable,previewCalendarEdit,type CalendarEditRequest,type CalendarEditPreview,type CalendarPlan} from './calendar-edit';

type Placement={operationId:string;originalDate:string;placedAt:string};
type JournalChange={id:string;from:string;to:string;revision:number;previousPlacement:Placement|null};
type ReplacementJournal={date:string;availability:string;removed:Array<{id:string;revision:number;status?:string}>;created:Array<{id:string;revision:number}>};
type JournalEntry={id:string;createdAt:string;label:string;mode:string;changes:JournalChange[];replacement?:ReplacementJournal;undoneAt?:string};
const fingerprint=(preview:CalendarEditPreview)=>createHash('sha256').update(JSON.stringify(preview)).digest('hex');
const planOrder=(a:CalendarPlan,b:CalendarPlan)=>(a.target?.automaticPractice?.hybrid?.sequence||0)-(b.target?.automaticPractice?.hybrid?.sequence||0)||a.id.localeCompare(b.id);
const columns="p.id,p.title,to_char(p.planned_date,'YYYY-MM-DD') as date,p.revision,p.completed,p.target";
export async function lockedCalendarPlans(db:PoolClient,studentId:string,includeSuperseded=false){
 // The same lock is held by automatic replanning. No regenerated task can overwrite a confirmed placement.
 await db.query('select pg_advisory_xact_lock(hashtext($1))',['automatic-practice:'+studentId]);
 const preference=(await db.query('select data from student_preferences where student_id=$1 for update',[studentId])).rows[0]?.data||{};
 const plans=(await db.query(`select ${columns},(
  exists(select 1 from interview_sessions s where s.student_id=p.student_id and s.data->>'trainingPlanId'=p.id::text and s.state not in('cancelled','deleted'))
  or exists(select 1 from quiz_sessions s where s.student_id=p.student_id and s.metadata->>'trainingPlanId'=p.id::text and s.state not in('cancelled','deleted'))
  or exists(select 1 from (select student_id,data,created_at,kind from study_session_events where student_id=$1 union all select student_id,data,occurred_at as created_at,kind from study_imported_events where student_id=$1) e where e.student_id=p.student_id and coalesce(e.data->>'invalidated','false')<>'true' and e.created_at>=p.created_at
   and e.kind in('interview_answer','quiz_response','memory_review','assignment_submission','knowledge_progress')
   and (e.data->>'trainingPlanId'=p.id::text or (p.target is not null and coalesce(e.data->>'questionId',e.data->>'videoId',e.data->>'assignmentId',e.data->>'memoryItemId')=p.target->>'id'
    and coalesce(e.data->>'targetId',e.data->>'target_id','')=coalesce(p.target->>'targetId','') and to_char(e.created_at at time zone 'Asia/Seoul','YYYY-MM-DD')>=to_char(p.planned_date,'YYYY-MM-DD'))))
 ) as locked from student_plans p where p.student_id=$1
 ${includeSuperseded?'':"and coalesce(p.target->'automaticPractice'->>'status','active')<>'superseded'"} order by p.id limit 5001 for update of p`,[studentId])).rows as CalendarPlan[];
 if(plans.length>5000)throw new ApiError(400,'계획이 많아요. 보관한 계획을 정리한 뒤 다시 시도해 주세요.');
 const journal=(Array.isArray(preference.calendarEdits)?preference.calendarEdits:[]).slice(-20) as JournalEntry[];
 return {plans,journal,preferences:preference};
}
async function saveJournal(db:PoolClient,studentId:string,journal:JournalEntry[]){
 await db.query("insert into student_preferences(student_id,data) values($1,jsonb_build_object('calendarEdits',$2::jsonb)) on conflict(student_id) do update set data=jsonb_set(student_preferences.data,'{calendarEdits}',$2::jsonb),updated_at=now()",[studentId,JSON.stringify(journal.slice(-20))]);
}
function publicJournal(journal:JournalEntry[]){return journal.filter(entry=>!entry.undoneAt).slice().reverse().map(entry=>({id:entry.id,label:entry.label,mode:entry.mode,createdAt:entry.createdAt,count:entry.replacement?entry.replacement.created.length+entry.replacement.removed.length:entry.changes.length}));}
export async function calendarEditHistory(studentId:string){
 const saved=(await query("select data->'calendarEdits' as journal from student_preferences where student_id=$1",[studentId]))[0]?.journal;
 return {history:publicJournal(Array.isArray(saved)?saved:[])};
}
export async function editCalendarPlans(studentId:string,request:CalendarEditRequest,expectedFingerprint?:string){
 return transaction(async db=>{
  const {plans,journal}=await lockedCalendarPlans(db,studentId);let preview:CalendarEditPreview;
  try{preview=previewCalendarEdit(plans,request,koreaToday());}catch(error){throw new ApiError(400,(error as Error).message);}
  const version=fingerprint(preview);
  if(expectedFingerprint===undefined)return {preview,fingerprint:version};
  if(expectedFingerprint!==version)throw new ApiError(409,'일정이 바뀌었어요. 변경 내용을 다시 확인해 주세요.');
  const id=randomUUID(),createdAt=new Date().toISOString();
  const changes:JournalChange[]=[];
  for(const change of preview.changes){
   const plan=plans.find(plan=>plan.id===change.id)!;
   const previousPlacement=plan.target?.calendarPlacement||null;
   const placement:Placement={operationId:id,originalDate:previousPlacement?.originalDate||plan.date,placedAt:createdAt};
   // Preserve the automatic task and all question/source snapshots. Only its date and placement marker change.
   await db.query("update student_plans set planned_date=$3,target=case when target is null then null else jsonb_set(target,'{calendarPlacement}',$4::jsonb) end,revision=revision+1,updated_at=now() where id=$1 and student_id=$2",[plan.id,studentId,change.to,JSON.stringify(placement)]);
   changes.push({id:change.id,from:change.from,to:change.to,revision:plan.revision+1,previousPlacement});
  }
  const entry:JournalEntry={id,createdAt,label:preview.label,mode:preview.mode,changes};
  await saveJournal(db,studentId,[...journal,entry]);
  return {preview,fingerprint:version,operationId:id,history:publicJournal([...journal,entry])};
 });
}
export async function undoCalendarEdit(studentId:string,operationId?:string,expectedFingerprint?:string){
 return transaction(async db=>{
  const {plans,journal,preferences}=await lockedCalendarPlans(db,studentId,true);
  const entry=operationId?journal.find(entry=>entry.id===operationId&&!entry.undoneAt):journal.slice().reverse().find(entry=>!entry.undoneAt);
  if(!entry)throw new ApiError(404,'되돌릴 일정 변경이 없어요.');
  if(entry.replacement)return undoCalendarReplacement(db,studentId,entry,plans,journal,preferences,expectedFingerprint);
  for(const change of entry.changes){
   const plan=plans.find(plan=>plan.id===change.id);
   if(!plan||plan.revision!==change.revision||plan.date!==change.to||!calendarPlanMovable(plan))throw new ApiError(409,'변경 후 수정하거나 연습한 계획이 있어요. 현재 일정을 확인한 뒤 직접 재배치해 주세요.');
  }
  const preview:CalendarEditPreview={changes:entry.changes.map(change=>({id:change.id,title:plans.find(plan=>plan.id===change.id)!.title,from:change.to,to:change.from,revision:change.revision})),excluded:0,sourceDates:[...new Set(entry.changes.map(change=>change.to))],mode:'move',label:entry.mode==='merge'?'병합 전 날짜로 되돌리기':'일정 변경 되돌리기'};
  const version=fingerprint(preview);
  if(expectedFingerprint===undefined)return {preview,fingerprint:version,operationId:entry.id};
  if(expectedFingerprint!==version)throw new ApiError(409,'일정이 바뀌었어요. 변경 내용을 다시 확인해 주세요.');
  for(const change of entry.changes){
   await db.query("update student_plans set planned_date=$3,target=case when $4::jsonb is null then nullif(target-'calendarPlacement','{}'::jsonb) else jsonb_set(target,'{calendarPlacement}',$4::jsonb) end,revision=revision+1,updated_at=now() where id=$1 and student_id=$2",[change.id,studentId,change.from,change.previousPlacement?JSON.stringify(change.previousPlacement):null]);
   // Earlier entries may still be undone after their successor is reverted.
   for(const previous of journal){if(previous.id===entry.id||previous.undoneAt)continue;const matching=previous.changes.find(item=>item.id===change.id&&item.to===change.from);if(matching)matching.revision=change.revision+1;const replacement=previous.replacement?.date===change.from?previous.replacement.created.find(item=>item.id===change.id):null;if(replacement)replacement.revision=change.revision+1;}
  }
  entry.undoneAt=new Date().toISOString();await saveJournal(db,studentId,journal);
  return {preview,fingerprint:version,operationId:entry.id,history:publicJournal(journal)};
 });
}

export type CalendarReplacementDraft<T>={preview:T;date:string;removeIds:string[];plans:Array<{title:string;kind:string;target:Record<string,any>}>;contextFingerprint:string};
/** Uses the same owner lock and journal as date edits. The builder has validated the entire day. */
export async function applyCalendarReplacement<T>(db:PoolClient,studentId:string,state:Awaited<ReturnType<typeof lockedCalendarPlans>>,draft:CalendarReplacementDraft<T>,expectedFingerprint?:string){
 const version=createHash('sha256').update(JSON.stringify(draft)).digest('hex');
 if(expectedFingerprint===undefined)return {preview:draft.preview,fingerprint:version};
 if(version!==expectedFingerprint)throw new ApiError(409,'일정·자료·보완 근거가 바뀌었어요. 변경 내용을 다시 확인해 주세요.');
 const removed=state.plans.filter(plan=>draft.removeIds.includes(plan.id)).sort(planOrder),day=state.plans.filter(plan=>plan.date===draft.date&&plan.target?.automaticPractice?.status!=='superseded'&&plan.target?.automaticPractice?.hybrid?.kind!=='break');
 if(removed.length!==new Set(draft.removeIds).size||day.length!==removed.length||day.some(plan=>!draft.removeIds.includes(plan.id))||removed.some(plan=>!calendarPlanMovable(plan)||!plan.target?.automaticPractice||plan.target.calendarPlacement?.operationId||plan.target.automaticPractice.hybrid?.studentOrderedAt))throw new ApiError(409,'보호된 일정이나 새 계획이 있어요. 변경 내용을 다시 확인해 주세요.');
 if(!draft.plans.length||draft.plans.length>10)throw new ApiError(400,'보완 순서를 다시 확인해 주세요.');
 const id=randomUUID(),createdAt=new Date().toISOString(),created:Array<{id:string;revision:number}>=[];
 for(const plan of removed){
  await db.query("update student_plans set target=jsonb_set(jsonb_set(target,'{automaticPractice,status}','\"superseded\"'::jsonb),'{reviewReplacement}',$3::jsonb),revision=revision+1,updated_at=now() where id=$1 and student_id=$2",[plan.id,studentId,JSON.stringify({operationId:id,role:'replaced'})]);
 }
 for(const plan of draft.plans){
  const target={...plan.target,calendarPlacement:{operationId:id,originalDate:draft.date,placedAt:createdAt},reviewReplacement:{operationId:id,role:'created'}};
  const row=(await db.query('insert into student_plans(student_id,title,planned_date,kind,target) values($1,$2,$3,$4,$5::jsonb) returning id,revision',[studentId,plan.title,draft.date,plan.kind,JSON.stringify(target)])).rows[0];created.push(row);
 }
 const entry:JournalEntry={id,createdAt,label:'보완 영역 편성',mode:'review',changes:[],replacement:{date:draft.date,availability:JSON.stringify(state.preferences.trainingAvailability||null),removed:removed.map(plan=>({id:plan.id,revision:plan.revision+1,status:plan.target?.automaticPractice?.status})),created}};
 await saveJournal(db,studentId,[...state.journal,entry]);
 return {preview:draft.preview,fingerprint:version,operationId:id,history:publicJournal([...state.journal,entry])};
}

async function undoCalendarReplacement(db:PoolClient,studentId:string,entry:JournalEntry,plans:CalendarPlan[],journal:JournalEntry[],preferences:Record<string,any>,expectedFingerprint?:string){
 const saved=entry.replacement!,removed=saved.removed.map(change=>plans.find(plan=>plan.id===change.id)),created=saved.created.map(change=>plans.find(plan=>plan.id===change.id));
 const fail=()=>{throw new ApiError(409,'편성 후 수정·시작한 학습이나 변경된 학습 시간이 있어요. 현재 일정을 확인한 뒤 조정해 주세요.');};
 if(JSON.stringify(preferences.trainingAvailability||null)!==saved.availability)fail();
 for(let index=0;index<removed.length;index++){
  const plan=removed[index];if(!plan||plan.date!==saved.date||plan.revision!==saved.removed[index].revision||plan.completed||plan.locked||plan.performedAt||plan.target?.automaticPractice?.startedAt||plan.target?.automaticPractice?.hybrid?.startedAt||plan.target?.reviewReplacement?.operationId!==entry.id||plan.target?.automaticPractice?.status!=='superseded')fail();
 }
 for(let index=0;index<created.length;index++){
  const plan=created[index];if(!plan||plan.date!==saved.date||plan.revision!==saved.created[index].revision||!calendarPlanMovable(plan)||plan.target?.calendarPlacement?.operationId!==entry.id)fail();
 }
 const active=plans.filter(plan=>plan.date===saved.date&&plan.target?.automaticPractice?.status!=='superseded'&&plan.target?.automaticPractice?.hybrid?.kind!=='break');
 if(active.length!==created.length||active.some(plan=>!saved.created.some(item=>item.id===plan.id)))fail();
 // Older journals used row-lock/UUID order. The preserved task sequence is the actual UI/restore order.
 const titles=(items:Array<CalendarPlan|undefined>)=>items.map(plan=>plan!).sort(planOrder).map(plan=>plan.title);
 const preview:CalendarEditPreview={label:'보완 편성 전 순서로 되돌리기',mode:'move',changes:[...created,...removed].map(plan=>({id:plan!.id,title:plan!.title,from:saved.date,to:saved.date,revision:plan!.revision})),sourceDates:[saved.date],excluded:0,replacement:{date:saved.date,before:titles(created),after:titles(removed)}};
 const version=fingerprint(preview);
 if(expectedFingerprint===undefined)return {preview,fingerprint:version,operationId:entry.id};
 if(expectedFingerprint!==version)fail();
 for(const plan of created)await db.query("update student_plans set target=jsonb_set(target-'calendarPlacement','{automaticPractice,status}','\"superseded\"'::jsonb),revision=revision+1,updated_at=now() where id=$1 and student_id=$2",[plan!.id,studentId]);
 for(const savedPlan of saved.removed)await db.query("update student_plans set target=case when $3::text is null then jsonb_set(target-'reviewReplacement','{automaticPractice}',(target->'automaticPractice')-'status') else jsonb_set(target-'reviewReplacement','{automaticPractice,status}',to_jsonb($3::text)) end,revision=revision+1,updated_at=now() where id=$1 and student_id=$2",[savedPlan.id,studentId,savedPlan.status??null]);
 entry.undoneAt=new Date().toISOString();await saveJournal(db,studentId,journal);
 return {preview,fingerprint:version,operationId:entry.id,history:publicJournal(journal)};
}
