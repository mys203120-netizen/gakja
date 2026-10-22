import 'server-only';
import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {ApiError,transaction,query} from './db';
import {koreaToday} from './planner-model';
import {calendarPlanMovable,previewCalendarEdit,type CalendarEditRequest,type CalendarEditPreview,type CalendarPlan} from './calendar-edit';

type Placement={operationId:string;originalDate:string;placedAt:string};
type JournalChange={id:string;from:string;to:string;revision:number;previousPlacement:Placement|null};
type JournalEntry={id:string;createdAt:string;label:string;mode:string;changes:JournalChange[];undoneAt?:string};
const fingerprint=(preview:CalendarEditPreview)=>createHash('sha256').update(JSON.stringify(preview)).digest('hex');
const columns="p.id,p.title,to_char(p.planned_date,'YYYY-MM-DD') as date,p.revision,p.completed,p.target";
async function lockedPlans(db:PoolClient,studentId:string){
 // The same lock is held by automatic replanning. No regenerated task can overwrite a confirmed placement.
 await db.query('select pg_advisory_xact_lock(hashtext($1))',['automatic-practice:'+studentId]);
 const preference=(await db.query('select data from student_preferences where student_id=$1 for update',[studentId])).rows[0]?.data||{};
 const plans=(await db.query(`select ${columns},(
  exists(select 1 from interview_sessions s where s.student_id=p.student_id and s.data->>'trainingPlanId'=p.id::text and s.state not in('cancelled','deleted'))
  or exists(select 1 from (select student_id,data,created_at,kind from study_session_events where student_id=$1 union all select student_id,data,occurred_at as created_at,kind from study_imported_events where student_id=$1) e where e.student_id=p.student_id and coalesce(e.data->>'invalidated','false')<>'true' and e.created_at>=p.created_at
   and e.kind in('interview_answer','quiz_response','memory_review','assignment_submission','knowledge_progress')
   and (e.data->>'trainingPlanId'=p.id::text or (p.target is not null and coalesce(e.data->>'questionId',e.data->>'videoId',e.data->>'assignmentId',e.data->>'memoryItemId')=p.target->>'id'
    and coalesce(e.data->>'targetId',e.data->>'target_id','')=coalesce(p.target->>'targetId','') and to_char(e.created_at at time zone 'Asia/Seoul','YYYY-MM-DD')>=to_char(p.planned_date,'YYYY-MM-DD'))))
 ) as locked from student_plans p where p.student_id=$1
 and coalesce(p.target->'automaticPractice'->>'status','active')<>'superseded' order by p.id limit 5001 for update of p`,[studentId])).rows as CalendarPlan[];
 if(plans.length>5000)throw new ApiError(400,'계획이 많아요. 보관한 계획을 정리한 뒤 다시 시도해 주세요.');
 const journal=(Array.isArray(preference.calendarEdits)?preference.calendarEdits:[]).slice(-20) as JournalEntry[];
 return {plans,journal};
}
async function saveJournal(db:PoolClient,studentId:string,journal:JournalEntry[]){
 await db.query("insert into student_preferences(student_id,data) values($1,jsonb_build_object('calendarEdits',$2::jsonb)) on conflict(student_id) do update set data=jsonb_set(student_preferences.data,'{calendarEdits}',$2::jsonb),updated_at=now()",[studentId,JSON.stringify(journal.slice(-20))]);
}
function publicJournal(journal:JournalEntry[]){return journal.filter(entry=>!entry.undoneAt).slice().reverse().map(entry=>({id:entry.id,label:entry.label,mode:entry.mode,createdAt:entry.createdAt,count:entry.changes.length}));}
export async function calendarEditHistory(studentId:string){
 const saved=(await query("select data->'calendarEdits' as journal from student_preferences where student_id=$1",[studentId]))[0]?.journal;
 return {history:publicJournal(Array.isArray(saved)?saved:[])};
}
export async function editCalendarPlans(studentId:string,request:CalendarEditRequest,expectedFingerprint?:string){
 return transaction(async db=>{
  const {plans,journal}=await lockedPlans(db,studentId);let preview:CalendarEditPreview;
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
  const {plans,journal}=await lockedPlans(db,studentId);
  const entry=operationId?journal.find(entry=>entry.id===operationId&&!entry.undoneAt):journal.slice().reverse().find(entry=>!entry.undoneAt);
  if(!entry)throw new ApiError(404,'되돌릴 일정 변경이 없어요.');
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
   for(const previous of journal){if(previous.id===entry.id||previous.undoneAt)continue;const matching=previous.changes.find(item=>item.id===change.id&&item.to===change.from);if(matching)matching.revision=change.revision+1;}
  }
  entry.undoneAt=new Date().toISOString();await saveJournal(db,studentId,journal);
  return {preview,fingerprint:version,operationId:entry.id,history:publicJournal(journal)};
 });
}
