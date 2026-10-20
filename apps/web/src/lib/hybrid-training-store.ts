import 'server-only';
import {ApiError,transaction} from './db';
import {getPlanContext,presentPlan} from './planner-context';
import {studentAdmissionCalendar} from './admission-calendar-store';
import {interviewSupportForTarget} from './school-interview-scope';
import {recordMatchesCurrentTarget} from './learning-target-scope';
import {knowledgeTargetKey} from './knowledge-flow-model';
import {koreaToday,shiftPlanDay} from './planner-model';
import {normalizeTrainingAvailability} from './training-availability';
import {hybridDeadlines,hybridTrainingDays,preserveHybridPlan,type HybridTask,type HybridTaskKind} from './hybrid-training';
import {reviewDiagnostics} from './training-review-store';
import {reviewDiagnosticKey} from './training-review';
import {getTrainingReadModel,trainingReadContext} from './training-read-model';
import {studentModelRevision} from './student-read-model';

type Value=Record<string,any>;
type Context=Awaited<ReturnType<typeof getPlanContext>>;
const autoOf=(plan:Value)=>plan.target?.automaticPractice;
const columns="*,to_char(planned_date,'YYYY-MM-DD') as date";
const taskMinutes=(plan:Value)=>Math.max(0,Number(autoOf(plan)?.minutes||plan.target?.minutes||10));
const hybridKinds=new Set<HybridTaskKind>(['diagnostic','recall','focus','mixed','review','break']);

/** The explicit task/session link permits finishing across midnight and several diagnostic topics. */
export function presentHybridPlan(plan:Value,context:Context,completedSessions:Set<string>){
  const hybrid=autoOf(plan)?.hybrid;
  if(!hybrid)return presentPlan(plan,context);
  const base=presentPlan(plan,{...context,events:[]});
  if(['review','break'].includes(hybrid.kind))return base;
  const linked=context.events.filter(event=>event.data?.trainingPlanId===plan.id&&completedSessions.has(event.data?.sessionId));
  for(const event of linked){
    const at=new Date(event.created_at);if(!Number.isFinite(at.getTime()))continue;
    const day=koreaToday(at);if(day<plan.date)continue;
    const questionId=event.data?.questionId;
    // A mixed/diagnostic task is completed by its actual submitted roots, not a fabricated seed answer.
    const decorated=presentPlan({...plan,date:day,target:{...plan.target,id:questionId}},{...context,events:[event]});
    if(decorated.performedAt)return {...base,performedAt:decorated.performedAt};
  }
  return base;
}

function presentTask(plan:Value,context:Context,today:string,completedSessions:Set<string>):HybridTask{
  const auto=autoOf(plan),kind:HybridTaskKind=hybridKinds.has(auto?.hybrid?.kind)?auto.hybrid.kind:plan.kind==='interview'?'mixed':plan.kind==='reading'?'review':'focus';
  const decorated=presentHybridPlan(plan,context,completedSessions),performedAt=decorated.performedAt;
  const startedAt=auto?.startedAt||auto?.hybrid?.startedAt||null;
  return {id:plan.id,title:plan.title,kind,minutes:taskMinutes(plan),reason:auto?.reason||'직접 추가한 계획이에요.',targetId:plan.target?.targetId||null,questionId:plan.target?.kind==='question'?plan.target.id:undefined,
    sourceType:plan.target?.sourceType,sourceVersion:plan.target?.sourceVersion,activityIds:plan.target?.activityIds||[],href:decorated.href,performedAt,completed:plan.completed,startedAt,
    status:plan.completed||performedAt?'completed':startedAt&&plan.date===today?'in_progress':'pending',manual:!auto,date:plan.date,sequence:auto?.hybrid?.sequence||0};
}

function scopedDiagnostics(value:Value,context:Context){
  return Object.fromEntries(context.schoolTargets.flatMap(school=>{
    const entry=value?.[school.id];
    if(!entry?.targetSnapshot||!recordMatchesCurrentTarget({targetId:school.id,targetSnapshot:entry.targetSnapshot},[{...school.data,id:school.id}]))return [];
    if(entry.sourceType==='personal'?Number(entry.sourceVersion)!==context.contentVersion:entry.sourceType!=='common'||!context.sources.some(source=>source.kind==='question'&&source.sourceType==='common'&&source.targetId===school.id&&source.sourceVersion===Number(entry.sourceVersion)))return [];
    return [[school.id,entry]];
  }));
}

/** Read through to the authenticated student's own durable plan; no synthetic answers or other students' data. */
export async function getHybridTraining(studentId:string,targetId?:string|null,today=koreaToday(),supplied?:Awaited<ReturnType<typeof getTrainingReadModel>>){
  const [snapshot,calendar]=await Promise.all([supplied||getTrainingReadModel(studentId,today),studentAdmissionCalendar(studentId)]);
  const context=trainingReadContext(snapshot);
  if(targetId&&!context.schoolTargets.some(row=>row.id===targetId))throw new ApiError(404,'등록한 지원 학교를 선택해 주세요.');
  return transaction(async db=>{
    // The same lock is used by the legacy planner: two screens cannot duplicate the daily workload.
    await db.query('select pg_advisory_xact_lock(hashtext($1))',['automatic-practice:'+studentId]);
    const registered=(await db.query("select id,data from support_targets where student_id=$1 and nullif(data->>'archived_at','') is null for share",[studentId])).rows;
    if(registered.length!==context.schoolTargets.length||registered.some(row=>!context.schoolTargets.some(saved=>saved.id===row.id&&knowledgeTargetKey(saved.data)===knowledgeTargetKey(row.data))))throw new ApiError(409,'지원 학교 정보가 바뀌었어요. 다시 확인해 주세요.');
    // School edits also lock the target before preferences; keep that order to avoid a deadlock.
    const preferences=(await db.query("select jsonb_build_object('trainingAvailability',data->'trainingAvailability','trainingDiagnostics',data->'trainingDiagnostics','automaticPractice',data->'automaticPractice') as data from student_preferences where student_id=$1 for update",[studentId])).rows[0]?.data||{};
    if(await studentModelRevision(db,studentId)!==snapshot.sourceRevision)throw new ApiError(409,'새 학습 기록을 반영하고 있어요. 다시 불러와 주세요.');
    const completedSessions=new Set<string>(snapshot.completedSessionIds);
    const fresh=context,availability=normalizeTrainingAvailability(preferences.trainingAvailability,today),diagnostics=scopedDiagnostics(preferences.trainingDiagnostics||{},fresh);
    const targets=context.schoolTargets.map(school=>{const support=interviewSupportForTarget(school.data);return {...school.data,id:school.id,interviewSupported:support.supported,interviewSupportReason:support.reason};});
    const settings=Object.fromEntries(context.schoolTargets.flatMap(school=>{const value=preferences.automaticPractice?.[school.id];return value?.targetSnapshot&&recordMatchesCurrentTarget({targetId:school.id,targetSnapshot:value.targetSnapshot},[{...school.data,id:school.id}])?[[school.id,value]]:[];}));
    const deadlines=hybridDeadlines({today,targets,schedules:calendar.interviewSchedules,coverage:calendar.interviewScheduleCoverage.targets,availability,settings});
    const rows=(await db.query(`select ${columns} from student_plans where student_id=$1 and planned_date>=$2 and planned_date<$3 order by planned_date,created_at,id for update`,[studentId,today,shiftPlanDay(today,7)])).rows;
    const tasks=rows.map(row=>presentTask(row,fresh,today,completedSessions));
    const decorated=rows.map((row,index)=>({...row,performedAt:tasks[index].performedAt}));
    const fixed=decorated.filter(row=>autoOf(row)?.hybrid?.kind!=='break'&&autoOf(row)?.status!=='superseded'&&preserveHybridPlan(row,today));
    const fixedIds=new Set(fixed.map(row=>row.id));
    const source={targets:new Map(snapshot.targets)},questions=snapshot.questions;
    for(const [schoolId,diagnostic] of Object.entries(diagnostics) as Array<[string,Value]>){
      const key=reviewDiagnosticKey(schoolId,reviewDiagnostics({[schoolId]:diagnostic})[schoolId]);
      const activeSelections=new Set(snapshot.activeRequests.filter(request=>request.diagnosticKey===key).map(request=>request.selectionKey));
      // Reflection checkboxes belong to this diagnosis. Never restore hidden questions from another session.
      diagnostic.activeNeedsReviewQuestionIds=(diagnostic.needsReviewQuestionIds||[]).filter((id:string)=>activeSelections.has('question:'+id));
      diagnostic.activeFocusCategories=(diagnostic.focusCategories||[]).filter((category:string)=>activeSelections.has('category:'+category));
    }
    const activeDeadlines=deadlines.filter(deadline=>settings[deadline.targetId]?.enabled!==false);
    const days=hybridTrainingDays({today,availability,deadlines:activeDeadlines,questions,diagnostics,fixedTasks:tasks.filter(task=>fixedIds.has(task.id))});
    if(availability){
      const used=new Set<string>();
      for(const day of days)for(let index=0;index<day.tasks.length;index++){
        const task=day.tasks[index];if(fixedIds.has(task.id))continue;
        const owned=source.targets.get(`${task.targetId}:${task.sourceType}:${task.sourceVersion}:${task.questionId}`);
        if(!owned)continue;
        const deadline=deadlines.find(item=>item.targetId===task.targetId)!;
        const auto={version:3,status:'active',interviewDate:deadline.date,dateSource:deadline.source,dailyMinutes:day.capacityMinutes,minutes:task.minutes,reason:task.reason,hybrid:{version:1,key:task.id,kind:task.kind,sequence:task.sequence,availabilityRevision:availability.revision,diagnosticAt:diagnostics[String(task.targetId)]?.completedAt||null}};
        const existing=decorated.find(row=>!used.has(row.id)&&!fixedIds.has(row.id)&&autoOf(row)?.status!=='superseded'&&autoOf(row)?.hybrid?.key===task.id&&knowledgeTargetKey(row.target?.targetSnapshot)===knowledgeTargetKey(owned.targetSnapshot));
        let id:string;
        if(existing){
          id=existing.id;
          if(existing.title!==task.title||knowledgeTargetKey(autoOf(existing))!==knowledgeTargetKey(auto))await db.query("update student_plans set title=$3,target=jsonb_set(target,'{automaticPractice}',$4::jsonb),revision=revision+1,updated_at=now() where id=$1 and student_id=$2",[id,studentId,task.title,JSON.stringify(auto)]);
        }else{
          const saved=(await db.query('insert into student_plans(student_id,title,planned_date,kind,target) values($1,$2,$3,$4,$5) returning id',[studentId,task.title,day.date,['mixed','diagnostic','recall','focus'].includes(task.kind)?'interview':'study',JSON.stringify({...owned,automaticPractice:auto})])).rows[0];id=saved.id;
        }
        used.add(id);day.tasks[index]={...task,id};
      }
      for(const row of decorated){
        if(!autoOf(row)||autoOf(row).status==='superseded'||fixedIds.has(row.id)||used.has(row.id))continue;
        // Preserve historical/started break records; only untouched current/future placeholders are retired.
        if(autoOf(row).hybrid?.kind==='break'&&preserveHybridPlan(row,today))continue;
        await db.query("update student_plans set target=jsonb_set(target,'{automaticPractice}',(target->'automaticPractice')||$3::jsonb),revision=revision+1,updated_at=now() where id=$1 and student_id=$2",[row.id,studentId,JSON.stringify({status:'superseded',supersededAt:new Date().toISOString(),reason:'실제 면접 일정·가능한 시간·답변 기록에 맞춰 계획을 조정했어요.'})]);
      }
    }
    const warnings=[...(!availability?['학습 가능한 시간을 설정하면 실제 일정에 맞춘 하루 계획을 만들어요.']:[]),...deadlines.filter(item=>!['ready','passed','today'].includes(item.status)).map(item=>`${item.university}: ${item.reason}`)];
    // The selected school is a display focus only; it never multiplies the student's daily budget.
    return {availability,needsAvailability:!availability,startDate:availability?.startDate||null,selectedTargetId:targetId||context.selectedTargetId||null,deadlines,days,today:days[0],diagnostics,review:snapshot.review,warnings,interviewSchedules:calendar.interviewSchedules,interviewScheduleCoverage:calendar.interviewScheduleCoverage,refreshDue:calendar.refreshDue};
  });
}
