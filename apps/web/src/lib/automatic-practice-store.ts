import 'server-only';
import type {PoolClient} from 'pg';
import {transaction,ApiError,query} from './db';
import {getPlanContext,ownedPlanTarget,presentPlan} from './planner-context';
import {automaticPracticeDays,practiceDaysLeft,practicePhase,practicePhaseLabels} from './automatic-practice';
import {koreaToday,shiftPlanDay,type PlanTarget} from './planner-model';
import {recordMatchesCurrentTarget} from './learning-target-scope';
import {interviewSupportForTarget,isStudentRecordQuestion} from './school-interview-scope';
import {focusTraining} from './focus-training';
import {knowledgeTargetKey} from './knowledge-flow-model';
import {normalizeTrainingAvailability} from './training-availability';
import {hybridDeadlines} from './hybrid-training';
import {studentAdmissionCalendar} from './admission-calendar-store';
type Context=Awaited<ReturnType<typeof getPlanContext>>;
type Value=Record<string,any>;
type QuestionTarget=PlanTarget&{kind:'question';title:string;sourceType:'personal'|'common';sourceVersion:number;questionSnapshot:Value;targetSnapshot:Value;targetId:string};
export function automaticQuestionTargets(context:Context,schoolId:string){
  const targets=new Map<string,QuestionTarget>();
  const candidates=context.sources.filter(source=>source.kind==='question'&&isStudentRecordQuestion(source.entity)&&(source.sourceType==='common'?source.targetId===schoolId&&context.targets.some(option=>option.id===source.id&&option.sourceType==='common'&&option.sourceVersion===source.sourceVersion):source.sourceVersion===context.contentVersion&&(!source.entity.support_target_ids?.length||source.entity.support_target_ids.includes(schoolId))));
  for(const source of candidates){
    try{const target=ownedPlanTarget(context,{kind:'question',id:source.id,targetId:schoolId,sourceType:source.sourceType,sourceVersion:source.sourceVersion});if(target&&'questionSnapshot' in target&&target.kind==='question')targets.set(source.id,target as QuestionTarget);}
    catch(error){if(!(error instanceof ApiError)||error.status!==409)throw error;}
  }
  return targets;
}
export function automaticQuestionFacts(context:Context,current:Value,targets:ReturnType<typeof automaticQuestionTargets>){
  const priorities=new Map(focusTraining(context.events,current,[...targets.values()]).map(item=>[item.id,item.score]));
  return [...targets.values()].map(target=>{
    const events=context.events.filter(event=>{
      const data=event.data||{},common=data.commonRevision||data.common_revision;
      return ['quiz_response','memory_review','interview_answer'].includes(event.kind)&&data.questionId===target.id&&recordMatchesCurrentTarget(data,[current])&&(target.sourceType==='common'?Number(common)===target.sourceVersion:!common&&Number(data.contentVersion||data.content_version)===target.sourceVersion);
    }).sort((a,b)=>new Date(b.created_at).getTime()-new Date(a.created_at).getTime());
    return {id:target.id,title:target.title,practiced:events.length>0,lastPracticedAt:events[0]?.created_at?new Date(events[0].created_at).toISOString():undefined,priority:priorities.get(target.id)||0,category:target.questionSnapshot?.department_context?'major' as const:target.questionSnapshot?.talent_profile?'talent' as const:'personal' as const};
  });
}
const planKey=(plan:Value)=>JSON.stringify([plan.date,plan.kind,plan.target?.targetId,plan.target?.id,plan.target?.sourceType,plan.target?.sourceVersion]);
export async function saveAutomaticPracticeSettings(db:PoolClient,studentId:string,targetId:string,targetSnapshot:Value,settings:Value){
  const data={automaticPractice:{[targetId]:{...settings,targetSnapshot,updatedAt:new Date().toISOString()}}};
  await db.query("insert into student_preferences(student_id,data) values($1,$2::jsonb) on conflict(student_id) do update set data=jsonb_set(student_preferences.data,'{automaticPractice}',coalesce(student_preferences.data->'automaticPractice','{}'::jsonb)||(excluded.data->'automaticPractice')),updated_at=now()",[studentId,JSON.stringify(data)]);
}
export async function pauseAutomaticPractice(studentId:string,targetId:string){
  await transaction(async db=>{
    await db.query('select pg_advisory_xact_lock(hashtext($1))',['automatic-practice:'+studentId]);
    const school=(await db.query("select id,data from support_targets where student_id=$1 and id=$2 and nullif(data->>'archived_at','') is null for share",[studentId,targetId])).rows[0];
    if(!school)throw new ApiError(404,'현재 등록된 지원 학교를 선택해 주세요.');
    const previous=(await db.query("select jsonb_build_object('trainingAvailability',data->'trainingAvailability','automaticPractice',data->'automaticPractice') as data from student_preferences where student_id=$1",[studentId])).rows[0]?.data?.automaticPractice?.[targetId]||{};
    await saveAutomaticPracticeSettings(db,studentId,targetId,{...school.data,id:targetId},{...previous,enabled:false});
  });
}
/** Replace only untouched automatic entries; never delete a plan or declare it performed. */
export async function synchronizeAutomaticPractice(studentId:string,context:Context,today=koreaToday()){
  const savedPreferences=(await query('select data from student_preferences where student_id=$1',[studentId]))[0]?.data||{};
  if(normalizeTrainingAvailability(savedPreferences.trainingAvailability)){
    const {getHybridTraining}=await import('./hybrid-training-store');
    const training=await getHybridTraining(studentId,undefined,today);
    return training.deadlines.map(deadline=>({targetId:deadline.targetId,enabled:true,date:deadline.date,dateSource:deadline.source,dateLabel:deadline.label,daysLeft:deadline.daysLeft,
      phase:'connection',phaseLabel:training.today.focus,dailyMinutes:training.today.capacityMinutes,status:deadline.status,
      plannedToday:training.today.tasks.filter(task=>task.targetId===deadline.targetId).length}));
  }
  const calendar=await studentAdmissionCalendar(studentId);
  return transaction(async db=>{
    await db.query('select pg_advisory_xact_lock(hashtext($1))',['automatic-practice:'+studentId]);
    const registered=(await db.query("select id,data from support_targets where student_id=$1 and nullif(data->>'archived_at','') is null for share",[studentId])).rows;
    if(registered.length!==context.schoolTargets.length||registered.some(row=>!context.schoolTargets.some(saved=>saved.id===row.id&&knowledgeTargetKey(saved.data)===knowledgeTargetKey(row.data))))return [];
    const rows=(await db.query("select *,to_char(planned_date,'YYYY-MM-DD') as date from student_plans where student_id=$1 and planned_date>=$2::date and planned_date<$3::date order by created_at desc,id for update",[studentId,today,shiftPlanDay(today,7)])).rows;
    const events=context.events;
    const currentPreferences=(await db.query("select jsonb_build_object('trainingAvailability',data->'trainingAvailability','automaticPractice',data->'automaticPractice') as data from student_preferences where student_id=$1",[studentId])).rows[0]?.data||{};
    // A concurrent availability save must not be followed by the legacy 20-minute fallback.
    if(normalizeTrainingAvailability(currentPreferences.trainingAvailability))return [];
    const preferences=currentPreferences.automaticPractice||{};
    const fresh={...context,events},decorated:Value[]=rows.map(row=>presentPlan(row,fresh));
    const fixed=decorated.filter(plan=>!plan.target?.automaticPractice||plan.completed||plan.performedAt);
    const configs=context.schoolTargets.flatMap(school=>{
      const current={...school.data,id:school.id};
      const configured=preferences[school.id];
      const settings=configured&&recordMatchesCurrentTarget({targetId:school.id,targetSnapshot:configured.targetSnapshot},[current])?configured:rows.find(row=>row.target?.targetId===school.id&&row.target?.automaticPractice&&recordMatchesCurrentTarget({targetId:school.id,targetSnapshot:row.target.targetSnapshot},[current]))?.target.automaticPractice;
      const actual=hybridDeadlines({today,targets:[current],schedules:calendar.interviewSchedules,coverage:calendar.interviewScheduleCoverage.targets,settings:{[school.id]:settings}})[0];
      const deadline=actual?.date?{date:actual.date,source:actual.source,label:actual.label}:null;
      if(!deadline||!interviewSupportForTarget(current).supported)return [];
      const days=practiceDaysLeft(today,deadline.date),minutes=[10,20,30].includes(settings?.dailyMinutes)?settings.dailyMinutes:20;
      const targets=automaticQuestionTargets(fresh,school.id),questions=automaticQuestionFacts(fresh,current,targets);
      const enabled=settings?.enabled!==false;
      const drafts=enabled&&days>0&&days<=180&&questions.length?automaticPracticeDays(today,deadline.date,minutes,questions).map(plan=>({...plan,target:targets.get(plan.questionId)!})):[];
      return [{school,deadline,days,minutes,drafts,enabled}];
    }).sort((a,b)=>a.deadline.date.localeCompare(b.deadline.date)||a.school.id.localeCompare(b.school.id));
    const desired:Value[]=[];
    for(let date=today;date<shiftPlanDay(today,7);date=shiftPlanDay(date,1)){
      const active=configs.filter(config=>config.drafts.some(plan=>plan.date===date));
      const cap=active.length?Math.max(...active.map(config=>config.minutes)):0;
      let slots=Math.max(0,Math.floor((cap-fixed.filter(plan=>plan.date===date).reduce((sum,plan)=>sum+Number(plan.target?.automaticPractice?.minutes||10),0))/10));
      const queues=active.map(config=>config.drafts.filter(plan=>plan.date===date&&!fixed.some(existing=>planKey(existing)===planKey(plan))).map(plan=>({...plan,config})));
      // A full daily workload is shared across schools, not multiplied by their count.
      while(slots>0&&queues.some(queue=>queue.length))for(const queue of queues){if(!slots)break;const next=queue.shift();if(next){desired.push(next);slots--;}}
    }
    const used=new Set<string>();
    for(const plan of desired){
      const existing=decorated.find(row=>row.target?.automaticPractice&&row.target.automaticPractice.status!=='superseded'&&!used.has(row.id)&&!row.completed&&!row.performedAt&&planKey(row)===planKey(plan)&&knowledgeTargetKey(row.target?.targetSnapshot)===knowledgeTargetKey(plan.target.targetSnapshot));
      const automaticPractice={version:2,interviewDate:plan.config.deadline.date,dateSource:plan.config.deadline.source,dailyMinutes:plan.config.minutes,minutes:plan.minutes,reason:plan.reason,phase:plan.phase,status:'active'};
      if(existing){
        used.add(existing.id);const next={...existing.target.automaticPractice,...automaticPractice};
        if(knowledgeTargetKey(next)!==knowledgeTargetKey(existing.target.automaticPractice))await db.query("update student_plans set target=jsonb_set(target,'{automaticPractice}',$3::jsonb),revision=revision+1,updated_at=now() where id=$1 and student_id=$2",[existing.id,studentId,JSON.stringify(next)]);
        continue;
      }
      const saved=(await db.query('insert into student_plans(student_id,title,planned_date,kind,target) values($1,$2,$3,$4,$5) returning id',[studentId,plan.title,plan.date,plan.kind,JSON.stringify({...plan.target,automaticPractice})])).rows[0];used.add(saved.id);
    }
    for(const plan of decorated){
      if(!plan.target?.automaticPractice||plan.completed||plan.performedAt||used.has(plan.id)||plan.target.automaticPractice.status==='superseded')continue;
      await db.query("update student_plans set target=jsonb_set(target,'{automaticPractice}',(target->'automaticPractice')||$3::jsonb),revision=revision+1,updated_at=now() where id=$1 and student_id=$2",[plan.id,studentId,JSON.stringify({status:'superseded',supersededAt:new Date().toISOString(),reason:'남은 날짜·실제 연습·하루 시간에 맞춰 새 계획으로 조정했어요.'})]);
    }
    return configs.map(config=>({targetId:config.school.id,enabled:config.enabled,date:config.deadline.date,dateSource:config.deadline.source,dateLabel:config.deadline.label,daysLeft:config.days,phase:practicePhase(config.days),phaseLabel:practicePhaseLabels[practicePhase(config.days)],dailyMinutes:config.minutes,status:!config.enabled?'paused':config.days<0?'passed':config.days===0?'today':config.days>180?'far_future':'ready',plannedToday:desired.filter(plan=>plan.date===today&&plan.target.targetId===config.school.id).length}));
  });
}
