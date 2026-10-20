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
import {interviewReviewSource,memoryReviewSource,quizReviewSource,reviewQuestionAttempts,type ReviewAttempt,type ReviewEvidenceSource} from './training-review-evidence';

type Value=Record<string,any>;
type Context=Awaited<ReturnType<typeof getPlanContext>>;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Only IDs discovered in this student's event stream are fetched; every source also checks its actual owner. */
export async function loadReviewQuestionFacts(studentId:string,context:Context,db?:Pick<PoolClient,'query'>):Promise<{questions:Array<HybridQuestion&{targetKey:string;attempts:ReviewAttempt[]}>;targets:Map<string,Value>}>{
 const read=async(sql:string,params:unknown[])=>db?(await db.query(sql,params)).rows:query(sql,params);
 const ids=(kind:string)=>[...new Set(context.events.filter(event=>event.kind===kind&&uuid.test(String(event.source_id||''))).map(event=>String(event.source_id)))];
 const batches=async(kind:string,sql:string)=>{
  const sourceIds=ids(kind),rows:Value[]=[];
  for(let offset=0;offset<sourceIds.length;offset+=2000)rows.push(...await read(sql,[studentId,sourceIds.slice(offset,offset+2000)]));
  return rows;
 };
 const [turns,quiz,memory]=await Promise.all([
  batches('interview_answer',`select t.id,t.question_id,t.data,t.created_at,s.target_id,s.data as session_data,s.state as session_state from interview_turns t join interview_sessions s on s.id=t.session_id and s.student_id=t.student_id where t.student_id=$1 and t.id=any($2::uuid[])`),
  batches('quiz_response',`select r.id,r.data,r.response,r.selected_option_id,r.outcome,r.timed_out,r.hint_used,r.created_at,s.mode,s.content_version,s.metadata,s.items->r.item_index as item from quiz_responses r join quiz_sessions s on s.id=r.session_id and s.student_id=r.student_id where r.student_id=$1 and r.id=any($2::uuid[])`),
  batches('memory_review',`select id,data,memory_item_id,created_at from memory_attempts where student_id=$1 and id=any($2::uuid[])`),
 ]);
 const learningAt=(version:unknown)=>context.sources.find(source=>source.sourceType==='personal'&&source.sourceVersion===Number(version)&&source.learning)?.learning as LearningData|undefined;
 const sources:ReviewEvidenceSource[]=[...turns.map(interviewReviewSource),...quiz.map(row=>quizReviewSource(row,learningAt(row.content_version))),...memory.map(row=>memoryReviewSource(row,learningAt(row.data?.content_version)))];
 const targets=new Map<string,Value>(),questions:Array<HybridQuestion&{targetKey:string;attempts:ReviewAttempt[]}> = [];
 for(const school of context.schoolTargets){
  const current={...school.data,id:school.id},owned=automaticQuestionTargets(context,school.id);
  for(const target of owned.values()){
   const question={id:target.id,title:target.title,targetId:school.id,targetKey:knowledgeTargetKey(learningScopeIdentity(current)),sourceType:target.sourceType,sourceVersion:target.sourceVersion,activityIds:target.activityIds||[],category:target.questionSnapshot?.department_context?'major' as const:target.questionSnapshot?.talent_profile?'talent' as const:'personal' as const,attempts:reviewQuestionAttempts(target,current,context.events,sources),href:planTargetHref(target,'interview')};
   targets.set(`${school.id}:${target.sourceType}:${target.sourceVersion}:${target.id}`,target);questions.push(question);
  }
 }
 return {questions,targets};
}
