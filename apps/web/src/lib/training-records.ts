import 'server-only';
import {query,transaction} from './db';
import {foldTrainingEvidence} from './training-evidence';
import {recordMatchesCurrentTarget} from './learning-target-scope';

type Value=Record<string,any>;
export async function refreshTrainingDiagnostics(studentId:string){
 const [preference]=await query('select data from student_preferences where student_id=$1',[studentId]);
 const diagnostics:Value=preference?.data?.trainingDiagnostics||{};
 for(const [targetId,value] of Object.entries(diagnostics) as Array<[string,Value]>){
  if(value.state!=='in_progress'||!value.sessionId)continue;
  const [session]=await query("select s.state,s.target_id,s.data,count(t.id) filter(where nullif(t.data->>'answer','') is not null and coalesce(t.data->>'invalidated','false')<>'true')::int as answers from interview_sessions s left join interview_turns t on t.session_id=s.id and t.student_id=s.student_id where s.id=$1 and s.student_id=$2 group by s.id",[value.sessionId,studentId]);
  if(session?.state!=='completed'||session.target_id!==targetId||!session.answers)continue;
  if(!recordMatchesCurrentTarget({targetId,targetSnapshot:value.targetSnapshot},[{...session.data.context?.target,id:targetId}]))continue;
  await transaction(async db=>{
   await db.query("update student_preferences set data=jsonb_set(data,ARRAY['trainingDiagnostics',$2],(data->'trainingDiagnostics'->$2)||$3::jsonb),updated_at=now() where student_id=$1 and data->'trainingDiagnostics'->$2->>'sessionId'=$4",[studentId,targetId,JSON.stringify({state:'completed',completedAt:new Date().toISOString(),answers:session.answers,observationOnly:true}),value.sessionId]);
  });
 }
}

export async function readTrainingReadiness(studentId:string,context:Value,targetId?:string|null){
 const [cards,turns,preferences]=await Promise.all([
  query('select id,data,revision from experience_cards where student_id=$1 order by updated_at desc',[studentId]),
  query("select t.id,t.question_id,t.data,t.created_at,s.data as session_data,s.target_id from interview_turns t join interview_sessions s on s.id=t.session_id and s.student_id=t.student_id where t.student_id=$1 and s.state not in ('cancelled','deleted') order by t.created_at",[studentId]),
  query('select data from student_preferences where student_id=$1',[studentId]),
 ]);
 const target=context.schoolTargets.find((row:Value)=>row.id===targetId);
 const common=context.sources.filter((source:Value)=>source.sourceType==='common'&&(!targetId||source.targetId===targetId)).map((source:Value)=>source.entity);
 return foldTrainingEvidence({learning:{...context.learning,questions:[...(context.learning.questions||[]),...common]},cards,turns,events:context.events,target:target?{...target.data,id:target.id}:undefined,contentVersion:context.contentVersion,notes:preferences[0]?.data?.trainingActivityNotes||[]});
}
