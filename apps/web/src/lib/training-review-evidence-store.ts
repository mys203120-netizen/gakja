import 'server-only';
import type {PoolClient} from 'pg';
import type {LearningData} from '@gakja/content-contracts';
import {query} from './db';
import type {getPlanContext} from './planner-context';
import {automaticQuestionTargets} from './automatic-practice-store';
import {planTargetHref} from './planner-model';
import type {HybridQuestion} from './hybrid-training';
import {knowledgeTargetKey} from './knowledge-flow-model';
import {learningScopeIdentity} from './learning-target-scope';
import {assignmentReviewSource,interviewReviewSource,memoryReviewSource,quizReviewSource,reviewQuestionAttempts,sourceValidateTrainingEvents,type ReviewAttempt,type ReviewEvidenceSource} from './training-review-evidence';

type Value=Record<string,any>;
type Context=Awaited<ReturnType<typeof getPlanContext>>;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Only IDs discovered in this student's event stream are fetched; every source also checks its actual owner. */
export async function loadReviewQuestionFacts(studentId:string,context:Context,db?:Pick<PoolClient,'query'>):Promise<{questions:Array<HybridQuestion&{targetKey:string;attempts:ReviewAttempt[]}>;targets:Map<string,Value>;events:Value[]}>{
 const read=async(sql:string,params:unknown[])=>db?(await db.query(sql,params)).rows:query(sql,params);
 const ids=(kind:string)=>[...new Set(context.events.filter(event=>event.kind===kind&&uuid.test(String(event.source_id||''))).map(event=>String(event.source_id)))];
 const batches=async(kind:string,sql:string)=>{
  const sourceIds=ids(kind),rows:Value[]=[];
  for(let offset=0;offset<sourceIds.length;offset+=2000)rows.push(...await read(sql,[studentId,sourceIds.slice(offset,offset+2000)]));
  return rows;
 };
 const assignmentSelect=`select r.id,r.assignment_id,r.student_id,r.memory_item_id,r.response,r.result,r.submitted_at,a.student_id as assignment_student_id,a.state as assignment_state,a.content_version,a.source_kind,a.target_id,a.target_snapshot,
  (select item from jsonb_array_elements(a.items)item where item->>'id'=r.memory_item_id limit 1) as item,
  (select coalesce(jsonb_agg(e.data),'[]'::jsonb) from quiz_assignment_events e where e.assignment_id=a.id and e.student_id=r.student_id and e.data->>'kind'='help' and e.data->>'memory_item_id'=r.memory_item_id) as help_events
  from quiz_submissions r join quiz_assignments a on a.id=r.assignment_id and a.student_id=r.student_id where r.student_id=$1`;
 const [turns,quiz,memory,assignmentRows]=await Promise.all([
  batches('interview_answer',`select t.id,t.question_id,t.data,t.created_at,s.target_id,s.data as session_data,s.state as session_state from interview_turns t join interview_sessions s on s.id=t.session_id and s.student_id=t.student_id where t.student_id=$1 and t.id=any($2::uuid[])`),
  batches('quiz_response',`select r.id,r.data,r.response,r.selected_option_id,r.outcome,r.timed_out,r.hint_used,r.created_at,s.mode,s.content_version,s.metadata,s.items->r.item_index as item from quiz_responses r join quiz_sessions s on s.id=r.session_id and s.student_id=r.student_id where r.student_id=$1 and r.id=any($2::uuid[])`),
  batches('memory_review',`select id,data,memory_item_id,created_at from memory_attempts where student_id=$1 and id=any($2::uuid[])`),
  batches('assignment_submission',assignmentSelect+' and r.id=any($2::uuid[])'),
 ]);
 // Assignment memory rows are a projection of the same submitted receipt, not a second success.
 const mirrorAssignments=[...new Set(memory.filter(row=>uuid.test(String(row.data?.assignment_id||''))).map(row=>String(row.data.assignment_id)))];
 for(let offset=0;offset<mirrorAssignments.length;offset+=2000)assignmentRows.push(...await read(assignmentSelect+' and r.assignment_id=any($2::uuid[])',[studentId,mirrorAssignments.slice(offset,offset+2000)]));
 const learningAt=(version:unknown)=>context.sources.find(source=>source.sourceType==='personal'&&source.sourceVersion===Number(version)&&source.learning)?.learning as LearningData|undefined;
 const mirrorIds=new Map<string,string[]>();for(const mirror of memory){if(!mirror.data?.assignment_id)continue;const key=JSON.stringify([mirror.data.assignment_id,mirror.memory_item_id]),ids=mirrorIds.get(key)||[];ids.push('memory_review:'+mirror.id);mirrorIds.set(key,ids);}
 const assignments=[...new Map(assignmentRows.map(row=>[String(row.id),row])).values()].map(row=>({...assignmentReviewSource(row,learningAt(row.content_version)),discoveryIds:mirrorIds.get(JSON.stringify([row.assignment_id,row.memory_item_id]))||[]}));
 const sources:ReviewEvidenceSource[]=[...turns.map(interviewReviewSource),...quiz.map(row=>quizReviewSource(row,learningAt(row.content_version))),...memory.filter(row=>!row.data?.assignment_id).map(row=>memoryReviewSource(row,learningAt(row.data?.content_version))),...assignments];
 const targets=new Map<string,Value>(),questions:Array<HybridQuestion&{targetKey:string;attempts:ReviewAttempt[]}> = [];
 for(const school of context.schoolTargets){
  const current={...school.data,id:school.id},owned=automaticQuestionTargets(context,school.id);
  for(const target of owned.values()){
   const question={id:target.id,title:target.title,targetId:school.id,targetKey:knowledgeTargetKey(learningScopeIdentity(current)),sourceType:target.sourceType,sourceVersion:target.sourceVersion,activityIds:target.activityIds||[],category:target.questionSnapshot?.department_context?'major' as const:target.questionSnapshot?.talent_profile?'talent' as const:'personal' as const,attempts:reviewQuestionAttempts(target,current,context.events,sources),href:planTargetHref(target,'interview')};
   targets.set(`${school.id}:${target.sourceType}:${target.sourceVersion}:${target.id}`,target);questions.push(question);
  }
 }
 return {questions,targets,events:sourceValidateTrainingEvents(context.events,sources)};
}
