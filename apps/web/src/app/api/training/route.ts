import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {checkOrigin,requireUser} from '@/lib/auth';
import {ApiError,errorResponse,query,transaction} from '@/lib/db';
import {getHybridTraining} from '@/lib/hybrid-training-store';
import {getPlanContext} from '@/lib/planner-context';
import {automaticQuestionTargets} from '@/lib/automatic-practice-store';
import {koreaToday} from '@/lib/planner-model';
import {readTrainingReadiness,refreshTrainingDiagnostics} from '@/lib/training-records';
import {recordMatchesCurrentTarget} from '@/lib/learning-target-scope';
import {after} from 'next/server';
import {refreshAdmissionCalendar} from '@/lib/admission-calendar-store';

export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
type Value=Record<string,any>;
const inputSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('task_start'),planId:z.string().uuid()}).strict(),
 z.object({action:z.literal('link_session'),planId:z.string().uuid().optional(),sessionId:z.string().uuid(),diagnostic:z.boolean().default(false)}).strict(),
 z.object({action:z.literal('task_complete'),planId:z.string().uuid()}).strict(),
 z.object({action:z.literal('diagnostic_reflection'),sessionId:z.string().uuid(),needsReviewQuestionIds:z.array(z.string().max(200)).max(20),focusCategories:z.array(z.enum(['personal','major','talent'])).max(3)}).strict(),
 z.object({action:z.literal('activity_note'),turnId:z.string().uuid(),activityId:z.string().min(1).max(220),body:z.string().trim().min(1).max(1500),requestId:z.string().uuid()}).strict(),
]);
async function ownedPlan(studentId:string,id:string,db:{query:Function}={query:async(sql:string,args:unknown[])=>({rows:await query(sql,args)})}){
 const [plan]=(await db.query("select *,to_char(planned_date,'YYYY-MM-DD') as date from student_plans where id=$1 and student_id=$2",[id,studentId])).rows;
 if(!plan||!plan.target?.automaticPractice?.hybrid)throw new ApiError(404,'오늘 훈련에서 계획을 다시 선택해 주세요.');return plan;
}
function taskView(plan:Value){const ap=plan.target.automaticPractice,hybrid=ap.hybrid;return {id:plan.id,date:plan.date,title:plan.title,kind:hybrid.kind,minutes:ap.minutes,reason:ap.reason,targetId:plan.target.targetId,questionId:plan.target.id,sourceType:plan.target.sourceType,sourceVersion:plan.target.sourceVersion,activityIds:plan.target.activityIds||[],href:'/my/train?planId='+plan.id,sessionId:hybrid.sessionId||null,completed:plan.completed,startedAt:ap.startedAt||hybrid.startedAt,requestId:hybrid.requestId};}

export async function GET(request:Request){
 try{
  const user=await requireUser();if(user.role!=='student')throw new ApiError(403,'학생 계정에서 이용해 주세요.');
  const params=new URL(request.url).searchParams,targetId=params.get('targetId'),planId=params.get('planId');
  if(planId)z.string().uuid().parse(planId);
  const selectedPlan=planId?await ownedPlan(user.id,planId):null;
  const context=await getPlanContext(user.id);
  if(targetId&&!context.schoolTargets.some(row=>row.id===targetId))throw new ApiError(404,'나의 지원 학교를 선택해 주세요.');
  await refreshTrainingDiagnostics(user.id);
  const selectedTargetId=selectedPlan?.target.targetId||targetId||context.selectedTargetId||context.schoolTargets[0]?.id;
  const hybrid=await getHybridTraining(user.id,selectedTargetId);
  if(hybrid.refreshDue)after(()=>refreshAdmissionCalendar());
  const [readiness,profile,preferences]=await Promise.all([readTrainingReadiness(user.id,context,selectedTargetId),query('select created_at from profiles where id=$1',[user.id]),query('select data from student_preferences where student_id=$1',[user.id])]);
  const targets=selectedTargetId?automaticQuestionTargets(context,selectedTargetId):new Map();
  const candidates=[...targets.values()];
  // Keep a diagnosis within one source/version; the server validates the fixed question list again at session start.
  const personal=candidates.filter(q=>q.sourceType==='personal'),pool=selectedPlan?candidates.filter(q=>q.sourceType===selectedPlan.target.sourceType&&q.sourceVersion===selectedPlan.target.sourceVersion):personal.length?personal:candidates.filter(q=>q.sourceType==='common');
  const diagnosticQuestions:Value[]=[];
  for(const category of ['personal','major','talent']){const q=pool.find(item=>!diagnosticQuestions.some(chosen=>chosen.id===item.id)&&(category==='major'?item.questionSnapshot?.department_context:category==='talent'?item.questionSnapshot?.talent_profile:!item.questionSnapshot?.department_context&&!item.questionSnapshot?.talent_profile));if(q)diagnosticQuestions.push(q);}
  for(const q of pool)if(diagnosticQuestions.length<3&&!diagnosticQuestions.some(chosen=>chosen.id===q.id))diagnosticQuestions.push(q);
  const diagnosticInput=diagnosticQuestions.length?{targetId:selectedTargetId,sourceType:diagnosticQuestions[0].sourceType,sourceVersion:diagnosticQuestions[0].sourceVersion,questionIds:diagnosticQuestions.map(q=>q.id),questionCount:diagnosticQuestions.length}:null;
  const selectedTask=selectedPlan?taskView(selectedPlan):null;
  return Response.json({...hybrid,readiness,registeredAt:profile[0]?.created_at,diagnostics:hybrid.diagnostics[selectedTargetId||'']||null,diagnosticQuestions:diagnosticQuestions.map(q=>({id:q.id,title:q.title,activityIds:q.activityIds})),diagnosticInput,selectedTask,activityNotes:preferences[0]?.data?.trainingActivityNotes||[]},{headers});
 }catch(error){return errorResponse(error);}
}

export async function POST(request:Request){
 try{
  checkOrigin(request);const user=await requireUser();if(user.role!=='student')throw new ApiError(403,'학생 계정에서 이용해 주세요.');
  const raw=await request.text();if(raw.length>12000)throw new ApiError(413,'입력 내용을 짧게 남겨 주세요.');
  let value;try{value=JSON.parse(raw);}catch{throw new ApiError(400,'입력 내용을 확인해 주세요.');}
  const parsed=inputSchema.safeParse(value);if(!parsed.success)throw new ApiError(400,'훈련과 입력 내용을 확인해 주세요.');const input=parsed.data;
  if(input.action==='task_start'){
   const plan=await transaction(async db=>{
    await db.query('select pg_advisory_xact_lock(hashtext($1))',['automatic-practice:'+user.id]);
    const row=await ownedPlan(user.id,input.planId,db),ap=row.target.automaticPractice;
    if(ap.status==='superseded'||row.date!==koreaToday())throw new ApiError(409,'오늘의 새 계획에서 시작해 주세요.');
    const school=(await db.query("select data from support_targets where id=$1 and student_id=$2 and nullif(data->>'archived_at','') is null",[row.target.targetId,user.id])).rows[0];
    if(!school||!recordMatchesCurrentTarget({targetId:row.target.targetId,targetSnapshot:row.target.targetSnapshot},[{...school.data,id:row.target.targetId}]))throw new ApiError(409,'지원 정보가 바뀌었어요. 오늘 계획을 다시 확인해 주세요.');
    if(!ap.startedAt){ap.startedAt=new Date().toISOString();ap.hybrid.startedAt=ap.startedAt;ap.hybrid.requestId='training-'+randomUUID();await db.query("update student_plans set target=jsonb_set(target,'{automaticPractice}',$3::jsonb),revision=revision+1,updated_at=now() where id=$1 and student_id=$2",[row.id,user.id,JSON.stringify(ap)]);}
    return row;
   });return Response.json({task:taskView(plan),href:'/my/train?planId='+plan.id},{headers});
  }
  if(input.action==='task_complete'){
   const plan=await transaction(async db=>{
    await db.query('select pg_advisory_xact_lock(hashtext($1))',['automatic-practice:'+user.id]);
    const row=await ownedPlan(user.id,input.planId,db),kind=row.target.automaticPractice.hybrid.kind;
    if(!['review','break'].includes(kind))throw new ApiError(409,'답변을 제출한 실제 훈련 기록으로 완료를 확인해요.');
    if(row.date!==koreaToday()||row.target.automaticPractice.status==='superseded')throw new ApiError(409,'오늘 계획을 다시 확인해 주세요.');
    await db.query('update student_plans set completed=true,revision=revision+1,updated_at=now() where id=$1 and student_id=$2',[row.id,user.id]);return row;
   });return Response.json({completed:true,selfChecked:true,planId:plan.id},{headers});
  }
  const [session]=input.action==='activity_note'?[]:await query('select id,target_id,state,data from interview_sessions where id=$1 and student_id=$2',[input.sessionId,user.id]);
  if(input.action!=='activity_note'&&!session)throw new ApiError(404,'내가 진행한 훈련을 선택해 주세요.');
  if(input.action==='link_session'){
   const context=session!.data.context||{};
   await transaction(async db=>{
    await db.query('select pg_advisory_xact_lock(hashtext($1))',['automatic-practice:'+user.id]);
    if(input.planId){
     const plan=await ownedPlan(user.id,input.planId,db);
     if(session!.data.trainingPlanId!==plan.id||session!.target_id!==plan.target.targetId)throw new ApiError(409,'이 계획에서 시작한 훈련을 선택해 주세요.');
     const ap={...plan.target.automaticPractice,hybrid:{...plan.target.automaticPractice.hybrid,sessionId:session!.id}};
     await db.query("update student_plans set target=jsonb_set(target,'{automaticPractice}',$3::jsonb),revision=revision+1,updated_at=now() where id=$1 and student_id=$2",[plan.id,user.id,JSON.stringify(ap)]);
    }
    if(input.diagnostic){
     if(!session!.target_id)throw new ApiError(409,'진단할 지원 학교를 선택해 주세요.');
     const [current]=(await db.query("select data from support_targets where id=$1 and student_id=$2 and nullif(data->>'archived_at','') is null",[session!.target_id,user.id])).rows;
     if(!current||!recordMatchesCurrentTarget({targetId:session!.target_id,targetSnapshot:context.target},[{...current.data,id:session!.target_id}]))throw new ApiError(409,'지원 정보가 바뀌었어요. 현재 지원처에서 진단을 다시 시작해 주세요.');
     const [actual]=(await db.query('select state from interview_sessions where id=$1 and student_id=$2 for share',[session!.id,user.id])).rows;
     if(!actual||!['active','completed'].includes(actual.state))throw new ApiError(409,'진행 중이거나 답변을 마친 진단을 선택해 주세요.');
     if(actual.state==='completed'){
      const [evidence]=(await db.query("select count(*)::int as answers from interview_turns where session_id=$1 and student_id=$2 and nullif(data->>'answer','') is not null and coalesce(data->>'invalidated','false')<>'true'",[session!.id,user.id])).rows;
      if(!evidence?.answers)throw new ApiError(409,'실제로 답변한 진단만 완료로 연결할 수 있어요.');
     }
     const [saved]=(await db.query('select data from student_preferences where student_id=$1 for update',[user.id])).rows;
     // Reconnecting the same session must preserve the student's reflection and original timestamps.
     if(saved?.data?.trainingDiagnostics?.[session!.target_id]?.sessionId===session!.id)return;
     const diagnostic={state:actual.state==='completed'?'completed':'in_progress',sessionId:session!.id,startedAt:new Date().toISOString(),...(actual.state==='completed'?{completedAt:new Date().toISOString()}:{}),targetSnapshot:context.target,sourceType:context.sourceKind,sourceVersion:context.contentVersion,needsReviewQuestionIds:[],focusCategories:[],observationOnly:true};
     await db.query("insert into student_preferences(student_id,data) values($1,jsonb_build_object('trainingDiagnostics',jsonb_build_object($2::text,$3::jsonb))) on conflict(student_id) do update set data=jsonb_set(student_preferences.data,'{trainingDiagnostics}',coalesce(student_preferences.data->'trainingDiagnostics','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb)),updated_at=now()",[user.id,session!.target_id,JSON.stringify(diagnostic)]);
    }
   });return Response.json({linked:true,sessionId:session!.id},{headers});
  }
  if(input.action==='diagnostic_reflection'){
   const answered=await query("select question_id,data from interview_turns where session_id=$1 and student_id=$2 and nullif(data->>'answer','') is not null and coalesce(data->>'invalidated','false')<>'true'",[session!.id,user.id]);
   if(!answered.length)throw new ApiError(409,'답변을 남긴 뒤 다시 연습할 부분을 골라 주세요.');
   const ids=new Set(answered.map(row=>row.data.rootQuestionId||row.question_id));
   if(input.needsReviewQuestionIds.some(id=>!ids.has(id)))throw new ApiError(409,'실제로 답한 질문만 선택해 주세요.');
   const result=await query("update student_preferences set data=jsonb_set(data,ARRAY['trainingDiagnostics',$2],(data->'trainingDiagnostics'->$2)||$3::jsonb),updated_at=now() where student_id=$1 and data->'trainingDiagnostics'->$2->>'sessionId'=$4 returning student_id",[user.id,session!.target_id,JSON.stringify({needsReviewQuestionIds:input.needsReviewQuestionIds,focusCategories:input.focusCategories,selfReported:true,observationOnly:true}),session!.id]);
   if(!result.length)throw new ApiError(409,'현재 진단에서 다시 선택해 주세요.');return Response.json({saved:true,selfCheckOnly:true},{headers});
  }
  const [turn]=await query("select t.question_id,t.data,s.data as session_data from interview_turns t join interview_sessions s on s.id=t.session_id and s.student_id=t.student_id where t.id=$1 and t.student_id=$2 and s.state not in ('cancelled','deleted')",[input.turnId,user.id]);
  if(!turn?.data.answer||turn.data.invalidated)throw new ApiError(404,'제출한 내 답변을 선택해 주세요.');
  const context=turn.session_data.context||{},root=(context.questions||[]).find((q:Value)=>q.id===(turn.data.rootQuestionId||turn.question_id));
  const ids=new Set([...(root?.activity_ids||[]),...(context.activityId?[context.activityId]:[]),...(turn.session_data.experienceCard?['experience:'+turn.session_data.experienceCard.id]:[])]);
  if(!ids.has(input.activityId))throw new ApiError(409,'이 답변에 연결된 활동을 선택해 주세요.');
  await transaction(async db=>{
   await db.query("insert into student_preferences(student_id,data) values($1,'{}') on conflict do nothing",[user.id]);
   const [row]=(await db.query('select data from student_preferences where student_id=$1 for update',[user.id])).rows;
   const notes:Value[]=row.data.trainingActivityNotes||[],existing=notes.find(note=>note.id===input.requestId);
   if(existing){if(existing.activityId!==input.activityId||existing.body!==input.body||existing.turnId!==input.turnId)throw new ApiError(409,'저장할 활동이나 내용이 바뀌었어요. 새로 저장해 주세요.');return;}
   if(notes.length>=300)throw new ApiError(409,'활동 보완 기록이 많아요. 기존 기록을 확인해 주세요.');
   const note={id:input.requestId,activityId:input.activityId,body:input.body,turnId:input.turnId,confirmedByStudent:true,createdAt:new Date().toISOString(),notice:'학생이 확인한 보완 메모 · 원문과 구분'};
   await db.query("update student_preferences set data=jsonb_set(data,'{trainingActivityNotes}',$2::jsonb),updated_at=now() where student_id=$1",[user.id,JSON.stringify([...notes,note])]);
  });return Response.json({saved:true,confirmedByStudent:true},{headers});
 }catch(error){return errorResponse(error);}
}
