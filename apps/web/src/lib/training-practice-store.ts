import 'server-only';
import type {PoolClient} from 'pg';
import {query,ApiError} from './db';
import {eligibleQuizItems} from './quiz-rules';
import {schoolQuizItems} from './school-quiz';
import {recordMatchesCurrentTarget} from './learning-target-scope';
import {koreaToday} from './planner-model';
import type {HybridQuestion,HybridAssignment,TrainingPractice} from './hybrid-training';
import type {getPlanContext} from './planner-context';

type Value=Record<string,any>;
type Context=Awaited<ReturnType<typeof getPlanContext>>;

/** Reuse the quiz API's reviewed pools; no generated question is presented as a verified quiz. */
export function trainingQuizQuestions(questions:HybridQuestion[],context:Context):HybridQuestion[]{
 const choice=eligibleQuizItems(context.learning,'choice'),answer=eligibleQuizItems(context.learning,'answer');
 return questions.map(question=>{
  const school=context.schoolTargets.find(row=>row.id===question.targetId);if(!school)return question;
  const choices=question.sourceType==='personal'?choice.filter(item=>item.question_id===question.id):[];
  const answers=question.sourceType==='personal'?answer.filter(item=>item.question_id===question.id):schoolQuizItems(context.sources.filter(source=>source.kind==='question'&&source.sourceType==='common'&&source.targetId===question.targetId&&source.sourceVersion===question.sourceVersion&&source.id===question.id).map(source=>source.entity),{...school.data,id:school.id});
  const items=choices.length?choices:answers;
  return items.length?{...question,quiz:{kind:'quiz',mode:choices.length?'choice':'answer',itemIds:items.slice(0,3).map(item=>item.id)}}:question;
 });
}

/** Pending work contributes to the same shared budget; outdated school/publication tasks stay in the assignment archive. */
export async function pendingTrainingAssignments(studentId:string,context:Context,questions:HybridQuestion[],db:Pick<PoolClient,'query'>):Promise<HybridAssignment[]>{
 const rows=(await db.query(`select id,title,target_id,target_snapshot,source_kind,content_version,due_at,
  jsonb_array_length(items) as item_count,items->0->>'question_id' as question_id,items->0->>'common_revision' as common_revision
  from quiz_assignments where student_id=$1 and state in('assigned','in_progress') order by due_at nulls last,created_at,id limit 100`,[studentId])).rows;
 return rows.flatMap(row=>{
  const school=context.schoolTargets.find(school=>school.id===row.target_id);
  if(!school||!recordMatchesCurrentTarget({targetId:row.target_id,targetSnapshot:row.target_snapshot},[{...school.data,id:school.id}]))return [];
  const sourceType=row.source_kind==='common'?'common' as const:'personal' as const,version=Number(sourceType==='common'?row.common_revision:row.content_version);
  const matches=questions.filter(question=>question.targetId===row.target_id&&question.sourceType===sourceType&&question.sourceVersion===version);
  const question=matches.find(question=>Boolean(row.question_id)&&question.id===row.question_id);if(!question||!Number(row.item_count))return [];
  return [{id:row.id,title:row.title,targetId:row.target_id,sourceType,sourceVersion:version,questionId:question.id,minutes:Math.min(40,Math.max(10,Number(row.item_count)*4)),dueDate:row.due_at?koreaToday(new Date(row.due_at)):null}];
 });
}

/** Completion is reconstructed from submitted source rows, rather than a return URL or client checkbox. */
export async function trainingPracticeCompletions(studentId:string,plans:Value[],db?:Pick<PoolClient,'query'>):Promise<Map<string,string>>{
 const read=async(sql:string,values:unknown[])=>db?(await db.query(sql,values)).rows:query(sql,values);
 const practiceOf=(plan:Value)=>plan.target?.automaticPractice?.hybrid?.practice as TrainingPractice|undefined;
 const practicePlans=plans.filter(practiceOf),quizIds=practicePlans.filter(plan=>practiceOf(plan)?.kind==='quiz').map(plan=>plan.id),assignmentIds=[...new Set(practicePlans.flatMap(plan=>{const practice=practiceOf(plan);return practice?.kind==='assignment'?[practice.assignmentId]:[];}))];
 const result=new Map<string,string>();if(!practicePlans.length)return result;
 const [quizzes,assignments]=await Promise.all([
  quizIds.length?read(`select s.id,s.metadata,s.finished_at from quiz_sessions s where s.student_id=$1 and s.metadata->>'trainingPlanId'=any($2::text[])
   and s.state='completed' and jsonb_array_length(s.items)>0 and not exists(select 1 from jsonb_array_elements(s.items) with ordinality item(value,n)
    where not exists(select 1 from quiz_responses r where r.session_id=s.id and r.student_id=s.student_id and r.item_index=item.n-1 and r.memory_item_id=item.value->>'id' and coalesce(r.data->>'invalidated','false')<>'true'
     and (nullif(r.selected_option_id,'') is not null or nullif(btrim(r.response),'') is not null or nullif(r.data->>'recording_id','') is not null)))`,[studentId,quizIds]):[],
  assignmentIds.length?read(`select a.id,a.target_id,a.target_snapshot,a.source_kind,a.content_version,a.items->0->>'common_revision' as common_revision,max(r.submitted_at) as submitted_at
   from quiz_assignments a join quiz_submissions r on r.assignment_id=a.id and r.student_id=a.student_id
   where a.student_id=$1 and a.id=any($2::uuid[]) and a.state in('submitted','completed','retry_due','reviewed') and jsonb_array_length(a.items)>0
   and not exists(select 1 from jsonb_array_elements(a.items) item where not exists(select 1 from quiz_submissions valid where valid.assignment_id=a.id and valid.student_id=a.student_id and valid.memory_item_id=item->>'id' and coalesce(valid.response->>'invalidated','false')<>'true' and coalesce(valid.result->>'invalidated','false')<>'true'))
   group by a.id`,[studentId,assignmentIds]):[],
 ]);
 for(const plan of practicePlans){
  const practice=practiceOf(plan)!;
  const row=practice.kind==='quiz'?quizzes.find(row=>row.metadata.trainingPlanId===plan.id):assignments.find(row=>row.id===practice.assignmentId);
  if(!row)continue;
  const metadata=practice.kind==='quiz'?row.metadata:row,targetId=metadata.targetId||metadata.target_id,snapshot=metadata.targetSnapshot||metadata.target_snapshot;
  const at=practice.kind==='quiz'?row.finished_at:row.submitted_at,stamp=at?new Date(at):null;
  if(!stamp||!Number.isFinite(stamp.getTime())||stamp<new Date(plan.created_at)||koreaToday(stamp)<plan.date)continue;
  if(!recordMatchesCurrentTarget({targetId,targetSnapshot:snapshot},[{...plan.target.targetSnapshot,id:plan.target.targetId}]))continue;
  const version=Number(practice.kind==='quiz'?metadata.trainingSourceVersion:plan.target.sourceType==='common'?row.common_revision:row.content_version);
  if(version!==Number(plan.target.sourceVersion)||(practice.kind==='quiz'?metadata.trainingSourceType:row.source_kind)!==plan.target.sourceType)continue;
  result.set(plan.id,stamp.toISOString());
 }
 return result;
}

/** The browser may only create the frozen quiz which today's owned plan actually assigned. */
export async function assertTrainingQuizPlan(db:Pick<PoolClient,'query'>,studentId:string,planId:string,input:{targetId?:string|null;sourceType?:string;sourceVersion?:number;mode:string;itemIds?:string[]},target:Value|null){
 const row=(await db.query("select *,to_char(planned_date,'YYYY-MM-DD') as date from student_plans where id=$1 and student_id=$2 for update",[planId,studentId])).rows[0],practice=row?.target?.automaticPractice?.hybrid?.practice;
 if(!row||row.date!==koreaToday()||row.target?.automaticPractice?.status==='superseded'||row.target?.automaticPractice?.hybrid?.kind!=='quiz'||practice?.kind!=='quiz'||!row.target.automaticPractice.startedAt)throw new ApiError(409,'오늘 계획에서 퀴즈를 다시 시작해 주세요.');
 if(!target||!recordMatchesCurrentTarget({targetId:row.target.targetId,targetSnapshot:row.target.targetSnapshot},[target])||input.targetId!==row.target.targetId||input.sourceType!==row.target.sourceType||Number(input.sourceVersion)!==Number(row.target.sourceVersion)||input.mode!==practice.mode||JSON.stringify(input.itemIds)!==JSON.stringify(practice.itemIds))throw new ApiError(409,'계획과 같은 학교·자료의 퀴즈를 시작해 주세요.');
 return row;
}
