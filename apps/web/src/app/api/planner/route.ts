import { checkOrigin, requireUser } from '@/lib/auth';
import { ApiError, errorResponse, query, transaction } from '@/lib/db';
import { validPlanDay } from '@/lib/planner-model';
import { getPlanContext, ownedPlanTarget, presentPlan } from '@/lib/planner-context';
import {studentAdmissionCalendar,refreshAdmissionCalendar} from '@/lib/admission-calendar-store';
import {after} from 'next/server';
import { z } from 'zod';
import {synchronizeAutomaticPractice} from '@/lib/automatic-practice-store';
import {presentHybridPlan} from '@/lib/hybrid-training-store';
import {plannerMonthRange} from '@/lib/planner-range';
import {calendarPlanEvidence} from '@/lib/calendar-plan-evidence';
import {allInterviewRootsAnsweredSql} from '@/lib/interview-completion';
import {trainingPracticeCompletions} from '@/lib/training-practice-store';
const targetSchema = z.object({kind:z.enum(['question','activity','video','assignment']),id:z.string().min(1).max(200),targetId:z.string().min(1).max(200).optional(),sourceType:z.enum(['personal','common']).optional(),sourceVersion:z.number().int().min(1).max(100000).optional()}).strict();
const inputSchema = z.discriminatedUnion('action',[
  z.object({action:z.literal('create'),title:z.string().trim().min(1).max(160),date:z.string().refine(validPlanDay),kind:z.enum(['study','quiz','interview','reading']).default('study'),target:targetSchema.nullable().optional()}),
  z.object({action:z.literal('update'),id:z.string().uuid(),expectedRevision:z.number().int().positive(),title:z.string().trim().min(1).max(160).optional(),date:z.string().refine(validPlanDay).optional(),completed:z.boolean().optional(),kind:z.enum(['study','quiz','interview','reading']).optional(),target:targetSchema.nullable().optional()}),
]);
const privateHeaders = {'Cache-Control':'private, no-store'};
const columns = "id,title,to_char(planned_date,'YYYY-MM-DD') as date,kind,completed,revision,target,created_at";
export async function GET(request:Request) {
  try {
    const user = await requireUser(); if(user.role!=='student')throw new ApiError(403,'학생의 계획표에서 이용해 주세요.');
    const params=new URL(request.url).searchParams,targetId=params.get('targetId');
    let range;try{range=plannerMonthRange(params.get('month'));}catch(error){throw new ApiError(400,(error as Error).message);}
    const scopedPlans=()=>query(`select ${columns} from student_plans where student_id=$1 and planned_date between $2::date and $3::date order by planned_date,created_at`,[user.id,range.startDate,range.endDate]);
    const [initialPlans,calendar] = await Promise.all([scopedPlans(),studentAdmissionCalendar(user.id,targetId)]);
    const context = await getPlanContext(user.id,initialPlans.map(plan=>plan.target).filter(Boolean));
    const automaticPractice=await synchronizeAutomaticPractice(user.id,context);
    const allPlans=await scopedPlans();
    const plans=(params.get('history')==='1'?allPlans:allPlans.filter(plan=>plan.target?.automaticPractice?.status!=='superseded')).filter(plan=>plan.target?.automaticPractice?.hybrid?.kind!=='break');
    const evidence=await calendarPlanEvidence(user.id,plans,range,context.sources.filter(source=>source.kind==='question').map(source=>source.id));
    const hybridIds=plans.filter(plan=>plan.target?.automaticPractice?.hybrid).map(plan=>plan.id);
    const hybridSessions=hybridIds.length?await query(`select s.id from interview_sessions s where s.student_id=$1 and s.state='completed' and s.data->>'trainingPlanId'=any($2::text[]) and ${allInterviewRootsAnsweredSql('s')}`,[user.id,hybridIds]):[];
    const completedSessionIds=new Set(hybridSessions.map(row=>row.id));
    const merged={...context,events:[...evidence,...context.events.filter(event=>event.kind!=='interview_answer'&&!evidence.some(row=>row.id===event.id))]};
    const practiceCompletions=await trainingPracticeCompletions(user.id,plans);
    const presented=plans.map(plan=>presentHybridPlan(plan,merged,completedSessionIds,practiceCompletions));
    if(calendar.refreshDue)after(()=>refreshAdmissionCalendar());
    return Response.json({plans:presented,range,automaticPractice,supersededPlanCount:allPlans.length-allPlans.filter(plan=>plan.target?.automaticPractice?.status!=='superseded').length,targets:context.targets,interviewSchedules:calendar.interviewSchedules,interviewScheduleCoverage:calendar.interviewScheduleCoverage},{headers:privateHeaders});
  } catch(error){return errorResponse(error);}
}
export async function POST(request: Request) {
  try {
    checkOrigin(request); const user=await requireUser();if(user.role!=='student')throw new ApiError(403,'학생의 계획표에서 이용해 주세요.');
    const text=await request.text(); if(text.length>8000)throw new ApiError(413,'계획을 짧게 입력해 주세요.');
    let value; try{value=JSON.parse(text);}catch{throw new ApiError(400,'입력 내용을 확인해 주세요.');}
    const parsed=inputSchema.safeParse(value);if(!parsed.success)throw new ApiError(400,'제목과 날짜, 연결할 항목을 확인해 주세요.');const input=parsed.data;
    const context = await getPlanContext(user.id,input.target ? [input.target] : []);
    const target = input.target === undefined ? undefined : ownedPlanTarget(context,input.target);
    const plan=await transaction(async client=>{
      if(input.action==='create')return (await client.query(`insert into student_plans(student_id,title,planned_date,kind,target) values($1,$2,$3,$4,$5) returning ${columns}`,[user.id,input.title,input.date,input.kind,target?JSON.stringify(target):null])).rows[0];
      const [current]=(await client.query('select * from student_plans where id=$1 and student_id=$2 for update',[input.id,user.id])).rows;
      if(!current)throw new ApiError(404,'계획을 찾을 수 없어요.');if(current.revision!==input.expectedRevision)throw new ApiError(409,'다른 화면에서 변경한 계획이에요. 다시 확인해 주세요.');
      if(current.target?.automaticPractice?.hybrid)throw new ApiError(409,'자동 훈련은 오늘 훈련에서 진행해 주세요. 일정은 학습 시간 설정에서 조정할 수 있어요.');
      // A manually edited automatic entry becomes a personal plan and must survive regeneration.
      if(current.target?.automaticPractice&&(input.title!==undefined||input.date!==undefined||input.kind!==undefined))await client.query("update student_plans set target=target-'automaticPractice' where id=$1 and student_id=$2",[input.id,user.id]);
      return (await client.query(`update student_plans set title=coalesce($3,title),planned_date=coalesce($4,planned_date),completed=coalesce($5,completed),target=case when $6 then $7::jsonb else target end,kind=coalesce($8,kind),revision=revision+1,updated_at=now() where id=$1 and student_id=$2 returning ${columns}`,[input.id,user.id,input.title??null,input.date??null,input.completed??null,input.target!==undefined,target?JSON.stringify(target):null,input.kind??null])).rows[0];
    });
    const savedContext = input.action==='update' && input.target===undefined && plan.target?.common ? await getPlanContext(user.id,[plan.target]) : context;
    return Response.json({plan:presentPlan(plan,savedContext)},{headers:privateHeaders});
  }catch(error){return errorResponse(error);}
}
