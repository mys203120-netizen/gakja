import 'server-only';
import {query,transaction} from './db';
import {recordMatchesCurrentTarget} from './learning-target-scope';
import {diagnosticReviewScope} from './training-diagnostic-scope';

type Value=Record<string,any>;
export async function refreshTrainingDiagnostics(studentId:string){
 const [preference]=await query("select data->'trainingDiagnostics' as diagnostics from student_preferences where student_id=$1",[studentId]);
 const diagnostics:Value=preference?.diagnostics||{};
 for(const [targetId,value] of Object.entries(diagnostics) as Array<[string,Value]>){
  if(!value.sessionId)continue;
  const [session]=await query("select s.state,s.target_id,s.data,count(t.id) filter(where nullif(t.data->>'answer','') is not null and coalesce(t.data->>'invalidated','false')<>'true')::int as answers from interview_sessions s left join interview_turns t on t.session_id=s.id and t.student_id=s.student_id where s.id=$1 and s.student_id=$2 group by s.id",[value.sessionId,studentId]);
  if(!session||session.target_id!==targetId||!['active','completed'].includes(session.state))continue;
  if(!recordMatchesCurrentTarget({targetId,targetSnapshot:value.targetSnapshot},[{...session.data.context?.target,id:targetId}]))continue;
  const scope=diagnosticReviewScope(session.data.context||{});
  const patch:Value={...(scope||{})};
  if(value.state==='in_progress'&&session.state==='completed'&&session.answers)Object.assign(patch,{state:'completed',completedAt:new Date().toISOString(),answers:session.answers,observationOnly:true});
  if(Object.keys(patch).every(key=>JSON.stringify(patch[key])===JSON.stringify(value[key])))continue;
  await transaction(async db=>{
   await db.query("update student_preferences set data=jsonb_set(data,ARRAY['trainingDiagnostics',$2],(data->'trainingDiagnostics'->$2)||$3::jsonb),updated_at=now() where student_id=$1 and data->'trainingDiagnostics'->$2->>'sessionId'=$4",[studentId,targetId,JSON.stringify(patch),value.sessionId]);
  });
 }
}
