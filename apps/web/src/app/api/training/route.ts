import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {checkOrigin,requireUser} from '@/lib/auth';
import {ApiError,errorResponse,query,transaction} from '@/lib/db';
import {getHybridTraining} from '@/lib/hybrid-training-store';
import {getPlanContext} from '@/lib/planner-context';
import {automaticQuestionTargets} from '@/lib/automatic-practice-store';
import {koreaToday} from '@/lib/planner-model';
import {refreshTrainingDiagnostics} from '@/lib/training-records';
import {recordMatchesCurrentTarget} from '@/lib/learning-target-scope';
import {after} from 'next/server';
import {refreshAdmissionCalendar} from '@/lib/admission-calendar-store';
import {loadReviewQuestionFacts} from '@/lib/training-review-evidence-store';
import {reviewDiagnostics} from '@/lib/training-review-store';
import {applyReviewReflection,reconcileTrainingReviews,reviewQuestionKey} from '@/lib/training-review';
import {diagnosticReviewScope} from '@/lib/training-diagnostic-scope';
import {getTrainingReadModel,trainingReadContext} from '@/lib/training-read-model';
import {allInterviewRootsAnsweredSql} from '@/lib/interview-completion';
import {applyTrainingDayReflection} from '@/lib/training-day-review';
import {studentModelRevision} from '@/lib/student-read-model';
import {trainingOrderError} from '@/lib/training-order';
import {questionDomain} from '@/lib/training-domain';

export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
type Value=Record<string,any>;
const inputSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('task_start'),planId:z.string().uuid()}).strict(),
 z.object({action:z.literal('link_session'),planId:z.string().uuid().optional(),sessionId:z.string().uuid(),diagnostic:z.boolean().default(false)}).strict(),
 z.object({action:z.literal('task_complete'),planId:z.string().uuid()}).strict(),
 z.object({action:z.literal('task_reorder'),ids:z.array(z.string().uuid()).min(2).max(30)}).strict(),
 z.object({action:z.literal('repetition'),planId:z.string().uuid(),enabled:z.boolean(),intervalDays:z.union([z.literal(1),z.literal(3),z.literal(7),z.literal(14)])}).strict(),
 z.object({action:z.literal('day_reflection'),planId:z.string().uuid(),requestId:z.string().uuid(),improvement:z.string().trim().max(500),revisitQuestionKeys:z.array(z.string().min(1).max(2500)).max(30)}).strict(),
 z.object({action:z.literal('diagnostic_reflection'),sessionId:z.string().uuid(),needsReviewQuestionIds:z.array(z.string().max(200)).max(20),focusCategories:z.array(z.enum(['personal','major','talent'])).max(3)}).strict(),
 z.object({action:z.literal('activity_note'),turnId:z.string().uuid(),activityId:z.string().min(1).max(220),body:z.string().trim().min(1).max(1500),requestId:z.string().uuid()}).strict(),
]);
async function ownedPlan(studentId:string,id:string,db:{query:Function}={query:async(sql:string,args:unknown[])=>({rows:await query(sql,args)})}){
 const [plan]=(await db.query("select *,to_char(planned_date,'YYYY-MM-DD') as date from student_plans where id=$1 and student_id=$2",[id,studentId])).rows;
 if(!plan||!plan.target?.automaticPractice?.hybrid)throw new ApiError(404,'오늘 훈련에서 계획을 다시 선택해 주세요.');return plan;
}
function taskView(plan:Value){const ap=plan.target.automaticPractice,hybrid=ap.hybrid;return {id:plan.id,date:plan.date,title:plan.title,kind:hybrid.kind,stage:hybrid.stage,pressure:hybrid.pressure===true,area:hybrid.area,activityTitles:hybrid.activityTitles,minutes:ap.minutes,reason:ap.reason,targetId:plan.target.targetId,questionId:plan.target.id,sourceType:plan.target.sourceType,sourceVersion:plan.target.sourceVersion,activityIds:plan.target.activityIds||[],href:hybrid.kind==='assignment'?'/quiz/assignments/'+encodeURIComponent(hybrid.practice?.assignmentId||'')+'?trainingPlanId='+plan.id:'/my/train?planId='+plan.id,sessionId:hybrid.sessionId||null,practice:hybrid.practice||null,dayReflection:hybrid.dayReflection||null,completed:plan.completed,startedAt:ap.startedAt||hybrid.startedAt,requestId:hybrid.requestId};}

export async function GET(request:Request){
 try{
  const user=await requireUser();if(user.role!=='student')throw new ApiError(403,'학생 계정에서 이용해 주세요.');
  const params=new URL(request.url).searchParams,targetId=params.get('targetId'),planId=params.get('planId');
  if(planId)z.string().uuid().parse(planId);
  const selectedPlan=planId?await ownedPlan(user.id,planId):null;
  await refreshTrainingDiagnostics(user.id);
  const snapshot=await getTrainingReadModel(user.id),context=trainingReadContext(snapshot);
  if(targetId&&!context.schoolTargets.some(row=>row.id===targetId))throw new ApiError(404,'나의 지원 학교를 선택해 주세요.');
  const selectedTargetId=selectedPlan?.target.targetId||targetId||context.selectedTargetId||context.schoolTargets[0]?.id;
  const hybrid=await getHybridTraining(user.id,selectedTargetId,koreaToday(),snapshot);
  if(hybrid.refreshDue)after(()=>refreshAdmissionCalendar());
  const readiness=snapshot.readiness[selectedTargetId||'']||{items:[],summary:{total:0,practiced:0,unconfirmed:0},observationOnly:true};
  const [profile,preferences]=await Promise.all([query('select created_at from profiles where id=$1',[user.id]),query("select jsonb_build_object('trainingActivityNotes',coalesce(data->'trainingActivityNotes','[]'::jsonb),'trainingRepetition',data->'trainingRepetition') as data from student_preferences where student_id=$1",[user.id])]);
  const targets=selectedTargetId?automaticQuestionTargets(context,selectedTargetId):new Map();
  const candidates=[...targets.values()];
  // Keep a diagnosis within one source/version; the server validates the fixed question list again at session start.
  const personal=candidates.filter(q=>q.sourceType==='personal'),pool=selectedPlan?candidates.filter(q=>q.sourceType===selectedPlan.target.sourceType&&q.sourceVersion===selectedPlan.target.sourceVersion):personal.length?personal:candidates.filter(q=>q.sourceType==='common');
  const diagnosticQuestions:Value[]=[];
  for(const category of ['personal','major','talent']){const q=pool.find(item=>!diagnosticQuestions.some(chosen=>chosen.id===item.id)&&(category==='major'?item.questionSnapshot?.department_context:category==='talent'?item.questionSnapshot?.talent_profile:!item.questionSnapshot?.department_context&&!item.questionSnapshot?.talent_profile));if(q)diagnosticQuestions.push(q);}
  for(const q of pool)if(diagnosticQuestions.length<3&&!diagnosticQuestions.some(chosen=>chosen.id===q.id))diagnosticQuestions.push(q);
  const diagnosticInput=diagnosticQuestions.length?{targetId:selectedTargetId,sourceType:diagnosticQuestions[0].sourceType,sourceVersion:diagnosticQuestions[0].sourceVersion,questionIds:diagnosticQuestions.map(q=>q.id),questionCount:diagnosticQuestions.length}:null;
  const selectedTask=selectedPlan?taskView(selectedPlan):null;
  const selectedQuestion=snapshot.questions.find(question=>question.id===selectedTask?.questionId&&question.targetId===selectedTask?.targetId&&question.sourceType===selectedTask?.sourceType&&question.sourceVersion===selectedTask?.sourceVersion);
  const repetition=selectedQuestion?preferences[0]?.data?.trainingRepetition?.[reviewQuestionKey(selectedQuestion)]||{enabled:true,intervalDays:1}:null;
  const selectedLearning=context.sources.find(source=>source.sourceType==='personal'&&source.sourceVersion===selectedTask?.sourceVersion&&source.learning)?.learning||context.learning;
  const scopedQuestions=selectedTask?.area?snapshot.questions.filter(question=>question.targetId===selectedTask.targetId&&question.sourceType===selectedTask.sourceType&&question.sourceVersion===selectedTask.sourceVersion&&questionDomain(question,selectedLearning).area===selectedTask.area):[];
  const scopeQuestions=scopedQuestions.map(question=>({id:question.id,title:question.title}));
  const activityIds=new Set(selectedTask?.kind==='reading'&&scopedQuestions.length?scopedQuestions.flatMap(question=>question.activityIds):selectedTask?.activityIds||[]);
  const scopeActivities=(selectedLearning.activities||[]).filter((activity:Value)=>activityIds.has(activity.id)).map((activity:Value)=>({id:activity.id,title:activity.title,area:activity.area,summary:activity.activity_summary,sources:(selectedLearning.source_refs||[]).filter((source:Value)=>activity.source_ref_ids.includes(source.id)).map((source:Value)=>({quote:source.quote,page:source.page}))}));
  return Response.json({...hybrid,...(selectedTask?.kind==='review'?{dayReview:snapshot.dayReview?.all}:{}),readiness,registeredAt:profile[0]?.created_at,diagnostics:hybrid.diagnostics[selectedTargetId||'']||null,diagnosticQuestions:diagnosticQuestions.map(q=>({id:q.id,title:q.title,activityIds:q.activityIds})),diagnosticInput,selectedTask,scopeActivities,scopeQuestions,repetition,activityNotes:preferences[0]?.data?.trainingActivityNotes||[]},{headers});
 }catch(error){return errorResponse(error);}
}

export async function POST(request:Request){
 try{
  checkOrigin(request);const user=await requireUser();if(user.role!=='student')throw new ApiError(403,'학생 계정에서 이용해 주세요.');
  const raw=await request.text();if(raw.length>12000)throw new ApiError(413,'입력 내용을 짧게 남겨 주세요.');
  let value;try{value=JSON.parse(raw);}catch{throw new ApiError(400,'입력 내용을 확인해 주세요.');}
  const parsed=inputSchema.safeParse(value);if(!parsed.success)throw new ApiError(400,'훈련과 입력 내용을 확인해 주세요.');const input=parsed.data;
  if(input.action==='task_reorder'){
   if(new Set(input.ids).size!==input.ids.length)throw new ApiError(400,'중복 없는 훈련 순서를 선택해 주세요.');
   await transaction(async db=>{
    await db.query('select pg_advisory_xact_lock(hashtext($1))',['automatic-practice:'+user.id]);
    const rows=(await db.query("select * from student_plans where student_id=$1 and planned_date=$2 and target->'automaticPractice'->>'status'<>'superseded' and target->'automaticPractice'->'hybrid' is not null order by created_at,id for update",[user.id,koreaToday()])).rows.filter(row=>row.target.automaticPractice.hybrid.kind!=='break');
    if(rows.length!==input.ids.length||rows.some(row=>!input.ids.includes(row.id)))throw new ApiError(409,'오늘 계획이 바뀌었어요. 새 계획에서 순서를 바꿔 주세요.');
    const displayed=[...rows].sort((a,b)=>Number(a.target.automaticPractice.hybrid.sequence||0)-Number(b.target.automaticPractice.hybrid.sequence||0));
    const orderError=trainingOrderError(displayed.map(row=>({id:row.id,kind:row.target.automaticPractice.hybrid.kind,completed:row.completed,startedAt:row.target.automaticPractice.startedAt||row.target.automaticPractice.hybrid.startedAt})),input.ids);
    if(orderError)throw new ApiError(409,orderError);
    const ordered=input.ids.map(id=>rows.find(row=>row.id===id)!);
    if(ordered.some((row,index)=>row.target.automaticPractice.hybrid.kind==='review'&&index!==ordered.length-1))throw new ApiError(400,'오늘 정리는 마지막에 두어 주세요.');
    for(const [sequence,row] of ordered.entries())await db.query("update student_plans set target=jsonb_set(target,'{automaticPractice,hybrid}',(target->'automaticPractice'->'hybrid')||$3::jsonb),revision=revision+1,updated_at=now() where id=$1 and student_id=$2",[row.id,user.id,JSON.stringify({sequence,studentOrderedAt:new Date().toISOString()})]);
   });return Response.json({ok:true},{headers});
  }
  if(input.action==='repetition'){
   const snapshot=await getTrainingReadModel(user.id);
   await transaction(async db=>{
    await db.query('select pg_advisory_xact_lock(hashtext($1))',['automatic-practice:'+user.id]);
    const plan=await ownedPlan(user.id,input.planId,db),target=plan.target;
    const question=snapshot.questions.find(question=>question.id===target.id&&question.targetId===target.targetId&&question.sourceType===target.sourceType&&question.sourceVersion===target.sourceVersion);
    if(!question)throw new ApiError(409,'현재 자료의 질문에서 반복 설정을 바꿔 주세요.');
    if(await studentModelRevision(db,user.id)!==snapshot.sourceRevision)throw new ApiError(409,'새 기록을 반영 중이에요. 반복 설정을 다시 불러와 주세요.');
    const key=reviewQuestionKey(question),setting={enabled:input.enabled,intervalDays:input.intervalDays};
    await db.query("insert into student_preferences(student_id,data) values($1,jsonb_build_object('trainingRepetition',jsonb_build_object($2::text,$3::jsonb))) on conflict(student_id) do update set data=jsonb_set(student_preferences.data,'{trainingRepetition}',coalesce(student_preferences.data->'trainingRepetition','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb)),updated_at=now()",[user.id,key,JSON.stringify(setting)]);
    await db.query('insert into student_learning_revisions(student_id,revision) values($1,1) on conflict(student_id) do update set revision=student_learning_revisions.revision+1',[user.id]);
   });return Response.json({ok:true},{headers});
  }
  if(input.action==='task_start'){
   const plan=await transaction(async db=>{
    await db.query('select pg_advisory_xact_lock(hashtext($1))',['automatic-practice:'+user.id]);
    const row=await ownedPlan(user.id,input.planId,db),ap=row.target.automaticPractice;
    if(row.completed||ap.status==='superseded'||row.date!==koreaToday())throw new ApiError(409,'오늘의 새 계획에서 시작해 주세요.');
    const school=(await db.query("select data from support_targets where id=$1 and student_id=$2 and nullif(data->>'archived_at','') is null",[row.target.targetId,user.id])).rows[0];
    if(!school||!recordMatchesCurrentTarget({targetId:row.target.targetId,targetSnapshot:row.target.targetSnapshot},[{...school.data,id:row.target.targetId}]))throw new ApiError(409,'지원 정보가 바뀌었어요. 오늘 계획을 다시 확인해 주세요.');
    let restart=false;
    if(ap.hybrid.sessionId){
     const [linked]=(await db.query(`select s.state,${allInterviewRootsAnsweredSql('s')} as fully_answered from interview_sessions s where s.id=$1 and s.student_id=$2 and s.data->>'trainingPlanId'=$3 for share`,[ap.hybrid.sessionId,user.id,row.id])).rows;
     if(linked?.state==='completed'){
      if(linked.fully_answered)throw new ApiError(409,'이미 마친 훈련이에요. 다음 훈련을 선택해 주세요.');
      delete ap.hybrid.sessionId;ap.hybrid.requestId='training-'+randomUUID();restart=true;
     }
    }
    if(!ap.startedAt||restart){ap.startedAt||=new Date().toISOString();ap.hybrid.startedAt||=ap.startedAt;ap.hybrid.requestId||='training-'+randomUUID();await db.query("update student_plans set target=jsonb_set(target,'{automaticPractice}',$3::jsonb),revision=revision+1,updated_at=now() where id=$1 and student_id=$2",[row.id,user.id,JSON.stringify(ap)]);}
    return row;
   });return Response.json({task:taskView(plan),href:'/my/train?planId='+plan.id},{headers});
  }
  if(input.action==='task_complete'){
   const plan=await transaction(async db=>{
    await db.query('select pg_advisory_xact_lock(hashtext($1))',['automatic-practice:'+user.id]);
    const row=await ownedPlan(user.id,input.planId,db),kind=row.target.automaticPractice.hybrid.kind;
    if(kind==='review'&&!row.target.automaticPractice.hybrid.dayReflection)throw new ApiError(409,'오늘 답변을 돌아보고 정리를 저장해 주세요.');
    if(!['reading','review','break'].includes(kind))throw new ApiError(409,'답변을 제출한 실제 훈련 기록으로 완료를 확인해요.');
    if(row.date!==koreaToday()||row.target.automaticPractice.status==='superseded')throw new ApiError(409,'오늘 계획을 다시 확인해 주세요.');
    await db.query('update student_plans set completed=true,revision=revision+1,updated_at=now() where id=$1 and student_id=$2',[row.id,user.id]);return row;
   });return Response.json({completed:true,selfChecked:true,planId:plan.id},{headers});
  }
  if(input.action==='day_reflection'){
   const snapshot=await getTrainingReadModel(user.id),context=trainingReadContext(snapshot);
   const saved=await transaction(async db=>{
    await db.query('select pg_advisory_xact_lock(hashtext($1))',['automatic-practice:'+user.id]);
    const row=await ownedPlan(user.id,input.planId,db),ap=row.target.automaticPractice;
    if(ap.hybrid.kind!=='review'||ap.status==='superseded'||row.date!==koreaToday())throw new ApiError(409,'오늘 정리에서 다시 선택해 주세요.');
    const current=(await db.query("select id,data from support_targets where student_id=$1 and nullif(data->>'archived_at','') is null for share",[user.id])).rows;
    const school=current.find(target=>target.id===row.target.targetId);
    if(!school||!recordMatchesCurrentTarget({targetId:school.id,targetSnapshot:row.target.targetSnapshot},[{...school.data,id:school.id}]))throw new ApiError(409,'지원 정보가 바뀌었어요. 오늘 계획을 다시 확인해 주세요.');
    const candidates=[...automaticQuestionTargets(context,school.id).values()];
    if(!candidates.some(question=>question.id===row.target.id&&question.sourceType===row.target.sourceType&&Number(question.sourceVersion)===Number(row.target.sourceVersion)))throw new ApiError(409,'자료가 바뀌었어요. 오늘 계획을 다시 확인해 주세요.');
    const keys=[...new Set(input.revisitQuestionKeys)].sort(),previous=ap.hybrid.dayReflection;
    if(previous){
     if(previous.requestId!==input.requestId||previous.improvement!==input.improvement||JSON.stringify([...(previous.revisitQuestionKeys||[])].sort())!==JSON.stringify(keys))throw new ApiError(409,'이미 저장한 오늘 정리는 오늘 훈련에서 확인해 주세요.');
     return previous;
    }
    if(await studentModelRevision(db,user.id)!==snapshot.sourceRevision)throw new ApiError(409,'새 기록을 반영하고 있어요. 오늘 정리를 다시 불러와 주세요.');
    const preference=(await db.query('select data from student_preferences where student_id=$1 for update',[user.id])).rows[0]?.data||{};
    const events=(await db.query('select id,source_id,kind,data,created_at from study_session_events where student_id=$1 union all select id,source_id,kind,data,occurred_at as created_at from study_imported_events where student_id=$1',[user.id])).rows;
    const source=await loadReviewQuestionFacts(user.id,{...context,events},db),now=new Date().toISOString();
    if(current.length!==context.schoolTargets.length||current.some(target=>!context.schoolTargets.some(saved=>saved.id===target.id&&recordMatchesCurrentTarget({targetId:target.id,targetSnapshot:saved.data},[{...target.data,id:target.id}]))))throw new ApiError(409,'지원 정보가 바뀌었어요. 오늘 정리를 다시 확인해 주세요.');
    let state;try{state=applyTrainingDayReflection({state:preference.trainingReview,questions:source.questions,planId:row.id,date:row.date,questionKeys:keys,now});}catch(error){throw new ApiError(409,(error as Error).message);}
    const reflection={requestId:input.requestId,improvement:input.improvement,revisitQuestionKeys:keys,date:row.date,savedAt:now};
    await db.query("insert into student_preferences(student_id,data) values($1,jsonb_build_object('trainingReview',$2::jsonb)) on conflict(student_id) do update set data=jsonb_set(student_preferences.data,'{trainingReview}',$2::jsonb),updated_at=now()",[user.id,JSON.stringify(state)]);
    await db.query("update student_plans set target=jsonb_set(target,'{automaticPractice}', $3::jsonb),completed=true,revision=revision+1,updated_at=now() where id=$1 and student_id=$2",[row.id,user.id,JSON.stringify({...ap,hybrid:{...ap.hybrid,dayReflection:reflection}})]);
    // Automatic reconciliation writes trainingReview without invalidation. A new student
    // request must explicitly invalidate the shared projection; receipt retries return above.
    await db.query('insert into student_learning_revisions(student_id,revision) values($1,1) on conflict(student_id) do update set revision=student_learning_revisions.revision+1',[user.id]);
    return reflection;
   });return Response.json({completed:true,reflection:saved},{headers});
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
     const [actual]=(await db.query(`select s.state,${allInterviewRootsAnsweredSql('s')} as fully_answered from interview_sessions s where s.id=$1 and s.student_id=$2 for share`,[session!.id,user.id])).rows;
     if(!actual||!['active','completed'].includes(actual.state))throw new ApiError(409,'진행 중이거나 답변을 마친 진단을 선택해 주세요.');
     let answers:number|undefined;
     if(actual.state==='completed'){
      const [evidence]=(await db.query("select count(*)::int as answers from interview_turns where session_id=$1 and student_id=$2 and nullif(btrim(data->>'answer'),'') is not null and coalesce(data->>'invalidated','false')<>'true'",[session!.id,user.id])).rows;
      answers=Number(evidence?.answers||0);
     }
     const [saved]=(await db.query('select data from student_preferences where student_id=$1 for update',[user.id])).rows;
     // Reconnecting the same session must preserve the student's reflection and original timestamps.
     const previous=saved?.data?.trainingDiagnostics?.[session!.target_id];
     const sameSession=previous?.sessionId===session!.id;
     if(actual.state==='completed'&&!answers&&!sameSession)throw new ApiError(409,'실제로 답변한 진단만 완료로 연결할 수 있어요.');
     const scope=diagnosticReviewScope(context);
     if(!scope)throw new ApiError(409,'같은 자료 버전의 질문으로 진단을 시작해 주세요.');
     const fullyCompleted=actual.state==='completed'&&actual.fully_answered;
     const diagnostic={...(sameSession?previous:{}),state:fullyCompleted?'completed':actual.state==='completed'?'partial':'in_progress',sessionId:session!.id,startedAt:sameSession&&previous.startedAt||new Date().toISOString(),completedAt:fullyCompleted?(sameSession&&previous.completedAt||new Date().toISOString()):null,...(answers===undefined?{}:{answers}),targetSnapshot:context.target,...scope,...(sameSession?{}:{needsReviewQuestionIds:[],focusCategories:[]}),observationOnly:true};
     if(sameSession&&JSON.stringify(previous)===JSON.stringify(diagnostic))return;
     await db.query("insert into student_preferences(student_id,data) values($1,jsonb_build_object('trainingDiagnostics',jsonb_build_object($2::text,$3::jsonb))) on conflict(student_id) do update set data=jsonb_set(student_preferences.data,'{trainingDiagnostics}',coalesce(student_preferences.data->'trainingDiagnostics','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb)),updated_at=now()",[user.id,session!.target_id,JSON.stringify(diagnostic)]);
    }
   });return Response.json({linked:true,sessionId:session!.id},{headers});
  }
  if(input.action==='diagnostic_reflection'){
   const answered=await query("select question_id,data from interview_turns where session_id=$1 and student_id=$2 and nullif(data->>'answer','') is not null and coalesce(data->>'invalidated','false')<>'true'",[session!.id,user.id]);
   if(!answered.length)throw new ApiError(409,'답변을 남긴 뒤 다시 연습할 부분을 골라 주세요.');
   const ids=new Set(answered.map(row=>row.data.rootQuestionId||row.question_id));
   if(input.needsReviewQuestionIds.some(id=>!ids.has(id)))throw new ApiError(409,'실제로 답한 질문만 선택해 주세요.');
   const context=await getPlanContext(user.id);
   await transaction(async db=>{
    await db.query('select pg_advisory_xact_lock(hashtext($1))',['automatic-practice:'+user.id]);
    const current=(await db.query("select id,data from support_targets where student_id=$1 and id=$2 and nullif(data->>'archived_at','') is null for share",[user.id,session!.target_id])).rows[0];
    if(!current||!recordMatchesCurrentTarget({targetId:current.id,targetSnapshot:session!.data.context?.target},[{...current.data,id:current.id}]))throw new ApiError(409,'지원 정보가 바뀌었어요. 현재 지원처에서 다시 선택해 주세요.');
    const preference=(await db.query('select data from student_preferences where student_id=$1 for update',[user.id])).rows[0]?.data||{};
    const diagnostic=preference.trainingDiagnostics?.[current.id];
    if(diagnostic?.sessionId!==session!.id)throw new ApiError(409,'현재 진단에서 다시 선택해 주세요.');
    const events=(await db.query('select id,source_id,kind,data,created_at from study_session_events where student_id=$1 order by created_at desc',[user.id])).rows;
    const source=await loadReviewQuestionFacts(user.id,{...context,events},db),now=new Date().toISOString();
    if(!source.questions.some(question=>question.targetId===current.id&&question.sourceType===diagnostic.sourceType&&question.sourceVersion===Number(diagnostic.sourceVersion)))throw new ApiError(409,'진단 자료가 바뀌었어요. 현재 자료로 다시 진단해 주세요.');
    const previous=reconcileTrainingReviews({state:preference.trainingReview,questions:source.questions,diagnostics:reviewDiagnostics(preference.trainingDiagnostics),now});
    const updated={...diagnostic,questionIds:[...ids],needsReviewQuestionIds:input.needsReviewQuestionIds,focusCategories:input.focusCategories,reviewSchemaVersion:1,selfReported:true,observationOnly:true};
    const state=applyReviewReflection({state:previous.state,questions:source.questions,targetId:current.id,diagnostic:reviewDiagnostics({[current.id]:updated})[current.id],needsReviewQuestionIds:input.needsReviewQuestionIds,focusCategories:input.focusCategories,now});
    await db.query("update student_preferences set data=jsonb_set(jsonb_set(data,ARRAY['trainingDiagnostics',$2],$3::jsonb),'{trainingReview}',$4::jsonb),updated_at=now() where student_id=$1",[user.id,current.id,JSON.stringify(updated),JSON.stringify(state)]);
   });
   return Response.json({saved:true,selfCheckOnly:true,reviewSchemaVersion:1},{headers});
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
