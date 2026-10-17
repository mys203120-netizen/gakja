-- Imported source records belong to a separate historical bucket. Frozen visit reports are untouched.
alter table study_session_events drop constraint if exists study_session_events_kind_check;
alter table study_session_events add constraint study_session_events_kind_check check(kind in ('quiz_response','interview_answer','memory_review','assignment_submission','knowledge_progress'));
create table if not exists study_imported_events (
  id uuid primary key default gen_random_uuid(), student_id uuid not null references profiles(id),
  kind text not null check(kind in ('quiz_response','interview_answer','memory_review','assignment_submission','knowledge_progress')),
  source_id text not null, data jsonb not null, occurred_at timestamptz not null,
  imported_at timestamptz not null default now(), unique(student_id,kind,source_id)
);
create index if not exists study_imported_events_student_time on study_imported_events(student_id,occurred_at);
alter table study_imported_events enable row level security;
do $$ begin
  if exists(select 1 from pg_roles where rolname='anon') then revoke all on study_imported_events from anon; end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then revoke insert,update,delete on study_imported_events from authenticated; end if;
  if to_regprocedure('auth.uid()') is not null then
    execute 'drop policy if exists own_student_read on study_imported_events';
    execute 'create policy own_student_read on study_imported_events for select to authenticated using (student_id=auth.uid())';
  end if;
end $$;
alter table answer_revisions add column if not exists data jsonb not null default '{}';

-- All source IDs and actual occurrence times are preserved; this statement is safe to repeat.
with candidates as (
  select r.student_id,'quiz_response'::text as kind,r.id::text as source_id,r.created_at as occurred_at,
    jsonb_build_object('quizSessionId',s.id,'memoryItemId',r.memory_item_id,'questionId',coalesce(r.data->>'question_id',i.value->>'question_id'),'prompt',i.value->>'prompt',
      'mode',s.mode,'outcome',r.outcome,'timedOut',r.timed_out,'elapsedMs',r.elapsed_ms,'response',case when s.mode='choice' then coalesce((select o->>'text' from jsonb_array_elements(coalesce(i.value->'options','[]')) o where o->>'id'=r.selected_option_id limit 1),'') else r.response end,
      'audioId',r.data->>'recording_id','hintUsed',r.hint_used,'contentVersion',s.content_version,'verified',s.mode='choice' and r.outcome is not null,'correctAnswer',r.data->'correct_answer','sourceRefIds',i.value->'source_ref_ids','provenance','quiz_responses') as data
  from quiz_responses r join quiz_sessions s on s.id=r.session_id and s.student_id=r.student_id
  left join lateral (select x.value from jsonb_array_elements(s.items) with ordinality x(value,n) where x.n=r.item_index+1) i on true
  union all
  select t.student_id,'interview_answer',t.id::text,coalesce(nullif(t.data->>'answeredAt','')::timestamptz,t.created_at),
    jsonb_build_object('sessionId',s.id,'kind',s.kind,'questionId',t.question_id,'question',t.data->>'question','answer',coalesce(t.data->>'originalAnswer',t.data->>'answer'),'assisted',coalesce(t.data->'assisted','false'::jsonb),'contentVersion',s.content_version,'provenance','interview_turns')
  from interview_turns t join interview_sessions s on s.id=t.session_id and s.student_id=t.student_id
  where s.state not in ('cancelled','deleted') and length(trim(coalesce(t.data->>'answer','')))>0 and coalesce(t.data->>'invalidated','false')<>'true'
  union all
  select m.student_id,'memory_review',m.id::text,m.created_at,
    jsonb_build_object('memoryItemId',m.memory_item_id,'questionId',i.value->>'question_id','prompt',coalesce(m.data->>'prompt',i.value->>'prompt'),'response',m.data->'answer','outcome',m.data->'correct','rating',m.rating,'hintUsed',coalesce(m.data->'hint_used','false'::jsonb),'evaluationMethod',m.data->>'evaluation_method','verified',coalesce(m.data->>'evaluation_method','')='reviewed_correct_answer','contentVersion',m.data->'content_version','dueAt',m.due_at,'provenance','memory_attempts')
  from memory_attempts m
  left join content_packages p on p.student_id=m.student_id
  left join content_versions v on v.package_id=p.id and v.version=case when coalesce(m.data->>'content_version','')~'^[0-9]+$' then (m.data->>'content_version')::int else null end
  left join lateral (select x.value from jsonb_array_elements(coalesce(v.data->'memory_items','[]')) x(value) where x.value->>'id'=m.memory_item_id limit 1) i on true
  where not (m.data ? 'quiz_session_id') and not (m.data ? 'quiz_response_id') and not (m.data ? 'assignment_id')
  union all
  select s.student_id,'assignment_submission',s.id::text,s.submitted_at,
    jsonb_build_object('assignmentId',a.id,'title',a.title,'memoryItemId',s.memory_item_id,'questionId',i.value->>'question_id','prompt',i.value->>'prompt','response',s.response->'response','outcome',s.result->'correct','cannotRecall',s.result->'cannot_recall','evaluationMethod',s.result->>'evaluation_method','verified',s.result->>'evaluation_method'='reviewed_correct_answer','contentVersion',a.content_version,'sourceRefIds',i.value->'source_ref_ids','correctAnswer',s.result->'reviewed_answer','provenance','quiz_submissions')
  from quiz_submissions s join quiz_assignments a on a.id=s.assignment_id and a.student_id=s.student_id
  left join lateral (select x.value from jsonb_array_elements(a.items) x(value) where x.value->>'id'=s.memory_item_id limit 1) i on true
  union all
  select r.student_id,'knowledge_progress',p.id::text||':'||r.revision::text,r.created_at,
    jsonb_build_object('progressId',p.id,'videoId',r.video_id,'title',p.snapshot->>'title','completed',r.completed_at is not null,'reflection',r.reflection,'saved',r.saved,'revision',r.revision,'contentVersion',p.snapshot->'contentVersion','activities',p.snapshot->'activities','selfReported',true,'provenance','knowledge_bite_revisions')
  from knowledge_bite_revisions r join knowledge_bite_progress p on p.id=r.progress_id and p.student_id=r.student_id
  where r.completed_at is not null or length(trim(r.reflection))>0
)
insert into study_imported_events(student_id,kind,source_id,data,occurred_at)
select c.student_id,c.kind,c.source_id,c.data,c.occurred_at from candidates c
where not exists(select 1 from study_session_events e where e.student_id=c.student_id and e.kind=c.kind and e.source_id=c.source_id)
on conflict(student_id,kind,source_id) do nothing;

-- Best available historical prompt provenance; new writes store the exact content snapshot.
with revision_context as (
select r.id,jsonb_build_object('question',q.value,'answerDesign',d.value,'contentVersion',v.version,'provenance','historical_content_at_revision') as data
from answer_revisions r join user_answers a on a.id=r.answer_id
join content_packages p on p.student_id=a.student_id
join lateral (select cv.* from content_versions cv where cv.package_id=p.id and cv.status='published' and coalesce(cv.published_at,cv.created_at)<=r.created_at order by coalesce(cv.published_at,cv.created_at) desc limit 1) v on true
left join lateral (select x.value from jsonb_array_elements(coalesce(v.data->'questions','[]')) x(value) where x.value->>'id'=a.question_id limit 1) q on true
left join lateral (select x.value from jsonb_array_elements(coalesce(v.data->'answer_designs','[]')) x(value) where x.value->>'question_id'=a.question_id limit 1) d on true
where r.data='{}'::jsonb and q.value is not null
)
update answer_revisions r set data=c.data from revision_context c where r.id=c.id;
