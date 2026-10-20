-- Metadata-only history enumeration; no answer body is returned before a cursor page is selected.
create or replace function learning_history_timestamp(value text, fallback timestamptz)
returns timestamptz language plpgsql stable as $$
begin
  if value is null or value='' then return fallback; end if;
  return value::timestamptz;
exception when others then return fallback;
end $$;

create or replace function learning_history_question(student uuid, version_number int, question_id text)
returns jsonb language sql stable as $$
  select question from content_versions v join content_packages p on p.id=v.package_id
  cross join lateral jsonb_array_elements(coalesce(v.data->'questions','[]'::jsonb)) question
  where p.student_id=student and v.status='published' and v.version=version_number and question->>'id'=question_id
  order by v.created_at,p.id limit 1
$$;

-- Mirrors quizAnswerContext's legacy choice-card identity without loading archived packages into Node.
create or replace function learning_history_quiz_identity(student uuid, version_number int, item jsonb, response jsonb)
returns text language plpgsql stable as $$
declare original jsonb; concept boolean; dedicated boolean;
begin
  concept=coalesce(item->>'kind'='choice',false) or coalesce(response->>'practice_kind'='concept',false) or coalesce(item->>'practice_kind'='concept',false);
  if not concept then return coalesce(nullif(response->>'question_id',''),item->>'question_id',''); end if;
  if response->>'practice_kind'='concept' and coalesce(nullif(response->>'practice_question_id',''),nullif(response->>'question_id','')) is not null then
    return coalesce(nullif(response->>'practice_question_id',''),nullif(response->>'question_id',''));
  end if;
  if nullif(item->>'practice_question_id','') is not null then return item->>'practice_question_id'; end if;
  original=learning_history_question(student,version_number,item->>'question_id');
  dedicated=coalesce(original->>'category'='concept',false) or coalesce(original->'question_types' ? 'concept',false);
  return case when dedicated then item->>'question_id' else 'concept:'||coalesce(item->>'id','') end;
end $$;

create or replace view learning_answer_history_index with (security_invoker=true) as
select r.id::text as id,a.student_id,'edit'::text as origin,r.id as source_id,0::bigint as ordinal,
  r.created_at,a.question_id,null::text as target_id,
  coalesce(r.data->'question'->'support_target_ids',learning_history_question(a.student_id,(r.data->>'contentVersion')::int,a.question_id)->'support_target_ids','[]'::jsonb) as target_ids,
  'personal'::text as source_type,coalesce((r.data->>'contentVersion')::int,0) as source_version,null::int as common_revision
from answer_revisions r join user_answers a on a.id=r.answer_id where nullif(btrim(r.script),'') is not null
union all
select t.id::text||':revision:'||coalesce(rev.value->>'revision',rev.ordinality::text),t.student_id,'interview_revision',t.id,rev.ordinality,
  learning_history_timestamp(rev.value->>'at',t.created_at),t.question_id,s.target_id::text,'[]'::jsonb,
  case when nullif(t.data->>'commonRevision','') is not null or s.data->'context'->>'sourceKind'='common' then 'common' else 'personal' end,s.content_version,(t.data->>'commonRevision')::int
from interview_turns t join interview_sessions s on s.id=t.session_id and s.student_id=t.student_id
cross join lateral jsonb_array_elements(case when jsonb_typeof(t.data->'answerRevisions')='array' then t.data->'answerRevisions' else '[]'::jsonb end) with ordinality rev(value,ordinality)
where s.state not in ('cancelled','deleted') and coalesce(t.data->>'invalidated','false')!='true'
  and nullif(btrim(t.data->>'answer'),'') is not null and nullif(btrim(rev.value->>'text'),'') is not null
union all
select t.id::text||':answer',t.student_id,'interview_original',t.id,0,
  learning_history_timestamp(t.data->>'answeredAt',t.created_at),t.question_id,s.target_id::text,'[]'::jsonb,
  case when nullif(t.data->>'commonRevision','') is not null or s.data->'context'->>'sourceKind'='common' then 'common' else 'personal' end,s.content_version,(t.data->>'commonRevision')::int
from interview_turns t join interview_sessions s on s.id=t.session_id and s.student_id=t.student_id
where s.state not in ('cancelled','deleted') and coalesce(t.data->>'invalidated','false')!='true' and nullif(btrim(t.data->>'answer'),'') is not null
  and jsonb_array_length(case when jsonb_typeof(t.data->'answerRevisions')='array' then t.data->'answerRevisions' else '[]'::jsonb end)=0
  and nullif(case when jsonb_typeof(t.data->'originalAnswer')='string' then t.data->>'originalAnswer'
    when jsonb_array_length(case when jsonb_typeof(t.data->'transcriptRevisions')='array' then t.data->'transcriptRevisions' else '[]'::jsonb end)=0 then t.data->>'answer' else null end,'') is not null
union all
select t.id::text||':transcript:'||coalesce(rev.value->>'revision',rev.ordinality::text),t.student_id,'interview_transcript',t.id,rev.ordinality,
  learning_history_timestamp(rev.value->>'at',t.created_at),t.question_id,s.target_id::text,'[]'::jsonb,
  case when nullif(t.data->>'commonRevision','') is not null or s.data->'context'->>'sourceKind'='common' then 'common' else 'personal' end,s.content_version,(t.data->>'commonRevision')::int
from interview_turns t join interview_sessions s on s.id=t.session_id and s.student_id=t.student_id
cross join lateral jsonb_array_elements(case when jsonb_typeof(t.data->'transcriptRevisions')='array' then t.data->'transcriptRevisions' else '[]'::jsonb end) with ordinality rev(value,ordinality)
where s.state not in ('cancelled','deleted') and coalesce(t.data->>'invalidated','false')!='true' and nullif(btrim(t.data->>'answer'),'') is not null
  and jsonb_array_length(case when jsonb_typeof(t.data->'answerRevisions')='array' then t.data->'answerRevisions' else '[]'::jsonb end)=0
  and nullif(btrim(rev.value->>'transcript'),'') is not null
union all
select t.id::text||':answer-current',t.student_id,'interview_current',t.id,0,
  learning_history_timestamp(t.data->>'answeredAt',t.created_at),t.question_id,s.target_id::text,'[]'::jsonb,
  case when nullif(t.data->>'commonRevision','') is not null or s.data->'context'->>'sourceKind'='common' then 'common' else 'personal' end,s.content_version,(t.data->>'commonRevision')::int
from interview_turns t join interview_sessions s on s.id=t.session_id and s.student_id=t.student_id
where s.state not in ('cancelled','deleted') and coalesce(t.data->>'invalidated','false')!='true' and nullif(btrim(t.data->>'answer'),'') is not null
  and jsonb_array_length(case when jsonb_typeof(t.data->'answerRevisions')='array' then t.data->'answerRevisions' else '[]'::jsonb end)=0
  and jsonb_array_length(case when jsonb_typeof(t.data->'transcriptRevisions')='array' then t.data->'transcriptRevisions' else '[]'::jsonb end)=0
  and jsonb_typeof(t.data->'originalAnswer')='string' and t.data->>'originalAnswer'=''
union all
select 'quiz:'||r.id::text,r.student_id,'quiz',r.id,0,r.created_at,
  learning_history_quiz_identity(r.student_id,s.content_version,coalesce(s.items->r.item_index,'{}'::jsonb),coalesce(r.data,'{}'::jsonb)),
  coalesce(nullif(r.data->>'target_id',''),nullif(s.items->r.item_index->>'target_id',''),s.metadata->>'targetId'),'[]'::jsonb,
  case when coalesce(r.data->>'source_kind',s.items->r.item_index->>'source_kind')='common' or coalesce(r.data->>'common_revision',s.items->r.item_index->>'common_revision') is not null then 'common' else 'personal' end,s.content_version,coalesce(r.data->>'common_revision',s.items->r.item_index->>'common_revision')::int
from quiz_responses r join quiz_sessions s on s.id=r.session_id and s.student_id=r.student_id
where s.mode!='choice' and (nullif(btrim(r.response),'') is not null or nullif(r.data->>'recording_id','') is not null)
union all
select 'assignment:'||r.id::text,r.student_id,'assignment',r.id,0,r.submitted_at,
  learning_history_quiz_identity(r.student_id,a.content_version,coalesce(item.value,'{}'::jsonb),coalesce(r.response,'{}'::jsonb)),
  coalesce(nullif(item.value->>'target_id',''),nullif(r.response->>'target_id',''),a.target_id::text),'[]'::jsonb,
  case when coalesce(item.value->>'source_kind',r.response->>'source_kind',a.source_kind)='common' then 'common' else 'personal' end,a.content_version,coalesce(item.value->>'common_revision',r.response->>'common_revision')::int
from quiz_submissions r join quiz_assignments a on a.id=r.assignment_id and a.student_id=r.student_id
left join lateral(select value from jsonb_array_elements(a.items) value where value->>'id'=r.memory_item_id limit 1)item on true
where jsonb_typeof(r.response->'response')='string' and nullif(btrim(r.response->>'response'),'') is not null;

create index if not exists answer_revision_history_order_idx on answer_revisions(answer_id,created_at desc,id desc);
create index if not exists interview_turn_history_student_idx on interview_turns(student_id,created_at desc,id desc);
create index if not exists quiz_submission_history_student_idx on quiz_submissions(student_id,submitted_at desc,id desc);
