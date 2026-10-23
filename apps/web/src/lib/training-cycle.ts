import type {HybridQuestion} from './hybrid-training';
import {recordMatchesCurrentTarget} from './learning-target-scope';
import {allInterviewRootsAnsweredSql} from './interview-completion';

type Value=Record<string,any>;

/** Compact owned evidence; an ended partial room never advances the preparation cycle. */
export const trainingCycleEvidenceSql=`select s.id as session_id,s.target_id,s.content_version,
 s.data->'context'->'target' as target_snapshot,
 (select jsonb_agg(jsonb_build_object('id',root->>'id','source_type',root->>'source_type','common_revision',root->'common_revision')) from jsonb_array_elements(case when jsonb_typeof(s.data->'questionQueue')='array' then s.data->'questionQueue' else '[]'::jsonb end) root) as roots,
 r.id as report_id,coalesce(s.completed_at,s.updated_at) as completed_at
 from interview_sessions s left join interview_reports r on r.session_id=s.id and r.student_id=s.student_id
 where s.student_id=$1 and s.state='completed' and s.data->>'sessionMode'='real'
 and ${allInterviewRootsAnsweredSql('s')} order by coalesce(s.completed_at,s.updated_at) desc,s.id desc`;

/** Match the frozen school, source namespace, revision and root question together. */
export function withRehearsalEvidence(questions:HybridQuestion[],rows:Value[],targets:Value[]):HybridQuestion[]{
 const eligible=rows.filter(row=>row.session_id&&Array.isArray(row.roots)&&recordMatchesCurrentTarget(row,targets)&&Number.isFinite(new Date(row.completed_at).getTime()))
  .sort((a,b)=>new Date(b.completed_at).getTime()-new Date(a.completed_at).getTime());
 return questions.map(question=>{
  const evidence=eligible.find(row=>row.target_id===question.targetId&&row.roots.some((root:Value)=>root.id===question.id&&
   (root.common_revision||root.source_type==='common'||root.source_type==='general_practice'?question.sourceType==='common'&&Number(root.common_revision)===question.sourceVersion:question.sourceType==='personal'&&Number(row.content_version)===question.sourceVersion)));
  return evidence?{...question,rehearsal:{sessionId:String(evidence.session_id),reportId:evidence.report_id?String(evidence.report_id):null,completedAt:new Date(evidence.completed_at).toISOString()}}:question;
 });
}
