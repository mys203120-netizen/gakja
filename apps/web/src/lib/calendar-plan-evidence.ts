import 'server-only';
import {query} from './db';
import type {plannerMonthRange} from './planner-range';

/** A month's display needs per-day facts, not every historical answer body. */
export async function calendarPlanEvidence(studentId:string,plans:Record<string,any>[],range:ReturnType<typeof plannerMonthRange>,linkedQuestionIds:string[]=[]){
 if(!plans.some(plan=>plan.target))return [];
 const planIds=plans.filter(plan=>plan.target?.automaticPractice?.hybrid).map(plan=>plan.id);
 const manual=plans.filter(plan=>plan.target&&!plan.target.automaticPractice);
 const manualEntities=[...new Set([...manual.map(plan=>plan.target.id),...(manual.some(plan=>plan.target.kind==='activity')?linkedQuestionIds:[])])];
 const earliest=manual.map(plan=>new Date(plan.created_at).toISOString()).sort()[0]||null;
 return query(`with all_events as(
  select id,student_id,kind,source_id,data,created_at from study_session_events where student_id=$1
  union all select id,student_id,kind,source_id,data,occurred_at as created_at from study_imported_events where student_id=$1
 ), candidates as(
  select e.*,case when e.created_at>=($2::date::timestamp at time zone 'Asia/Seoul') and e.created_at<(($3::date+1)::timestamp at time zone 'Asia/Seoul') then to_char(e.created_at at time zone 'Asia/Seoul','YYYY-MM-DD') else null end as event_day,
   coalesce(e.data->>'questionId',e.data->>'memoryItemId',e.data->>'videoId',e.data->>'assignmentId') as entity,
   coalesce(e.data->>'targetId',e.data->>'target_id') as target_scope,
   case when coalesce(e.data->>'commonRevision',e.data->>'common_revision') is not null then 'common' else 'personal' end as source_type,
   coalesce(e.data->>'commonRevision',e.data->>'common_revision',e.data->>'contentVersion',e.data->>'content_version') as source_version,
   coalesce(e.data->'targetSnapshot',e.data->'target_snapshot') as target_snapshot
  from all_events e where e.student_id=$1 and coalesce(e.data->>'invalidated','false')<>'true'
   and ((e.created_at>=($2::date::timestamp at time zone 'Asia/Seoul') and e.created_at<(($3::date+1)::timestamp at time zone 'Asia/Seoul'))
    or e.data->>'trainingPlanId'=any($4::text[])
    or ($6::timestamptz is not null and e.created_at>=$6::timestamptz and (coalesce(e.data->>'questionId',e.data->>'memoryItemId',e.data->>'videoId',e.data->>'assignmentId')=any($5::text[]) or coalesce(e.data->'activityIds','[]'::jsonb) ?| $5::text[])))
   and (e.kind<>'interview_answer' or exists(select 1 from interview_turns t join interview_sessions s on s.id=t.session_id and s.student_id=t.student_id where t.student_id=e.student_id and t.id::text=e.source_id and t.question_id=e.data->>'questionId' and coalesce(t.data->>'commonRevision','')=coalesce(e.data->>'commonRevision',e.data->>'common_revision','') and coalesce(e.data->>'contentVersion',e.data->>'content_version','')=coalesce(s.data->'context'->>'contentVersion',s.content_version::text,'') and coalesce(e.data->'targetSnapshot',e.data->'target_snapshot','null'::jsonb)=coalesce(s.data->'context'->'target','null'::jsonb) and coalesce(t.data->>'invalidated','false')<>'true' and nullif(btrim(t.data->>'answer'),'') is not null and s.state not in('cancelled','deleted') and (nullif(e.data->>'trainingPlanId','') is null or s.state='completed')))
 ) select distinct on(kind,event_day,entity,target_scope,source_type,source_version,target_snapshot,data->>'trainingPlanId')
  id,kind,source_id,created_at,jsonb_strip_nulls(jsonb_build_object(
   'questionId',data->'questionId','memoryItemId',data->'memoryItemId','videoId',data->'videoId','assignmentId',data->'assignmentId',
   'targetId',coalesce(data->'targetId',data->'target_id'),'targetSnapshot',target_snapshot,'sourceType',coalesce(data->'sourceType',data->'source_type'),
   'commonRevision',coalesce(data->'commonRevision',data->'common_revision'),'contentVersion',coalesce(data->'contentVersion',data->'content_version'),
   'trainingPlanId',data->'trainingPlanId','sessionId',data->'sessionId','completed',data->'completed','activityIds',data->'activityIds',
   'explanationSaved',data->'explanationSaved','action',data->'action','reflection',case when nullif(btrim(data->>'reflection'),'') is not null then 'saved' end
  )) as data from candidates order by kind,event_day,entity,target_scope,source_type,source_version,target_snapshot,data->>'trainingPlanId',created_at desc,id desc`,[studentId,range.startDate,range.endDate,planIds,manualEntities,earliest]);
}
