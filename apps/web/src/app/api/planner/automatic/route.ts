import {createHash} from 'node:crypto';
import {z} from 'zod';
import {requireUser,checkOrigin} from '@/lib/auth';
import {ApiError,errorResponse,query,transaction} from '@/lib/db';
import {getPlanContext,presentPlan} from '@/lib/planner-context';
import {automaticPracticeDays} from '@/lib/automatic-practice';
import {automaticQuestionTargets,automaticQuestionFacts,saveAutomaticPracticeSettings,pauseAutomaticPractice} from '@/lib/automatic-practice-store';
import {interviewSupportForTarget} from '@/lib/school-interview-scope';
import {knowledgeTargetKey} from '@/lib/knowledge-flow-model';
import {koreaToday} from '@/lib/planner-model';
import {studentAdmissionCalendar} from '@/lib/admission-calendar-store';
import {hybridDeadlines} from '@/lib/hybrid-training';
import {normalizeTrainingAvailability} from '@/lib/training-availability';

const schema=z.discriminatedUnion('action',[
  z.object({action:z.literal('pause'),targetId:z.string().min(1).max(200)}).strict(),
  z.object({action:z.enum(['preview','save']),targetId:z.string().min(1).max(200),interviewDate:z.string(),minutes:z.union([z.literal(10),z.literal(20),z.literal(30)]),previewToken:z.string().optional()}).strict(),
]);
const headers={'Cache-Control':'private, no-store'};
export async function POST(request:Request){
  try{
    checkOrigin(request);const user=await requireUser();
    if(user.role!=='student')throw new ApiError(403,'학생 계정에서 이용해 주세요.');
    const raw=await request.text();if(raw.length>2000)throw new ApiError(413,'입력 내용을 확인해 주세요.');
    let value;try{value=JSON.parse(raw);}catch{throw new ApiError(400,'입력 내용을 확인해 주세요.');}
    const parsed=schema.safeParse(value);if(!parsed.success)throw new ApiError(400,'면접일과 하루 연습 시간을 확인해 주세요.');
    const input=parsed.data,today=koreaToday(),context=await getPlanContext(user.id);
    const school=context.schoolTargets.find(row=>row.id===input.targetId);
    if(!school)throw new ApiError(404,'현재 등록된 지원 학교를 선택해 주세요.');
    if(input.action==='pause'){await pauseAutomaticPractice(user.id,school.id);return Response.json({paused:true},{headers});}
    const preferences=(await query('select data from student_preferences where student_id=$1',[user.id]))[0]?.data||{};
    if(normalizeTrainingAvailability(preferences.trainingAvailability))throw new ApiError(409,'등록한 학습 가능 시간은 오늘 훈련의 전체 지원처에 함께 적용돼요. 오늘 훈련에서 시간을 수정해 주세요.');
    const current={...school.data,id:school.id};
    const support=interviewSupportForTarget(current);if(!support.supported)throw new ApiError(409,support.reason);
    const calendar=await studentAdmissionCalendar(user.id);
    const actual=hybridDeadlines({today,targets:[current],schedules:calendar.interviewSchedules,coverage:calendar.interviewScheduleCoverage.targets,settings:{[school.id]:{interviewDate:input.interviewDate,dateSource:'goal'}}})[0];
    if(actual.status==='no_interview')throw new ApiError(409,actual.reason);
    const deadline=actual?.date?{date:actual.date,source:actual.source,label:actual.label}:null;
    if(deadline&&deadline.date!==input.interviewDate)throw new ApiError(409,'등록된 면접일이 바뀌었어요. 학교 일정에서 확인한 뒤 계획을 다시 만들어 주세요.');
    const targets=automaticQuestionTargets(context,school.id);
    let drafts;
    try{drafts=automaticPracticeDays(today,input.interviewDate,input.minutes,automaticQuestionFacts(context,current,targets));}
    catch(error){throw new ApiError(400,(error as Error).message);}
    const plans=drafts.map(plan=>({...plan,target:targets.get(plan.questionId)!}));
    const token=createHash('sha256').update(JSON.stringify({school:current,today,interviewDate:input.interviewDate,minutes:input.minutes,plans})).digest('hex');
    const existing=await query("select * ,to_char(planned_date,'YYYY-MM-DD') as date from student_plans where student_id=$1 and target->>'targetId'=$2 and target ? 'automaticPractice'",[user.id,school.id]);
    const replaceable=existing.filter(plan=>plan.target.automaticPractice.status!=='superseded'&&!plan.completed&&!presentPlan(plan,context).performedAt);
    if(input.action==='preview')return Response.json({plans,previewToken:token,replaceCount:replaceable.length,school:school.data.university,dateSource:deadline?.source||'goal',horizonDays:7},{headers});
    if(input.previewToken!==token)throw new ApiError(409,'질문이나 연습 기록이 바뀌었어요. 계획을 다시 미리보기해 주세요.');
    await transaction(async db=>{
      // Serialize automatic generation per student; a repeated save cannot duplicate plans.
      await db.query('select pg_advisory_xact_lock(hashtext($1))',['automatic-practice:'+user.id]);
      const [owned]=(await db.query("select data from support_targets where id=$1 and student_id=$2 and nullif(data->>'archived_at','') is null for share",[school.id,user.id])).rows;
      if(!owned||knowledgeTargetKey(owned.data)!==knowledgeTargetKey(school.data))throw new ApiError(409,'지원 학교 정보가 바뀌었어요. 다시 미리보기해 주세요.');
      await saveAutomaticPracticeSettings(db,user.id,school.id,current,{enabled:true,interviewDate:input.interviewDate,dailyMinutes:input.minutes,dateSource:deadline?.source||'goal'});
      const [saved]=(await db.query("select id from student_plans where student_id=$1 and target->'automaticPractice'->>'token'=$2 limit 1",[user.id,token])).rows;
      if(saved)return;
      // Only future, untouched auto entries are replaced. Manual and completed entries remain.
      const currentPlans=(await db.query("select *,to_char(planned_date,'YYYY-MM-DD') as date from student_plans where student_id=$1 and target->>'targetId'=$2 and target ? 'automaticPractice' for update",[user.id,school.id])).rows;
      const events=(await db.query('select kind,data,created_at from study_session_events where student_id=$1 order by created_at desc',[user.id])).rows;
      const removable=currentPlans.filter(plan=>plan.target.automaticPractice.status!=='superseded'&&!plan.completed&&!presentPlan(plan,{...context,events}).performedAt);
      for(const plan of removable)await db.query("update student_plans set target=jsonb_set(target,'{automaticPractice,status}','\"superseded\"'::jsonb),revision=revision+1,updated_at=now() where id=$1 and student_id=$2",[plan.id,user.id]);
      const retained=currentPlans.filter(plan=>!removable.includes(plan));
      for(const plan of plans){
        if(retained.some(item=>item.target?.automaticPractice?.status!=='superseded'&&item.date===plan.date&&item.kind===plan.kind&&item.target?.id===plan.target.id))continue;
        const target={...plan.target,automaticPractice:{version:2,status:'active',token,interviewDate:input.interviewDate,dateSource:deadline?.source||'goal',dailyMinutes:input.minutes,minutes:plan.minutes,reason:plan.reason,phase:plan.phase}};
        await db.query('insert into student_plans(student_id,title,planned_date,kind,target) values($1,$2,$3,$4,$5)',[user.id,plan.title,plan.date,plan.kind,JSON.stringify(target)]);
      }
    });
    return Response.json({saved:true},{headers});
  }catch(error){return errorResponse(error);}
}
