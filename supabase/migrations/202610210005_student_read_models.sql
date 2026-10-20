-- Cached projections are rebuildable from owned source rows. A correction/deletion invalidates them too.
create table if not exists student_learning_revisions (
 student_id uuid primary key references profiles(id) on delete cascade,
 revision bigint not null default 0
);
create table if not exists learning_catalog_revision (
 singleton boolean primary key default true check(singleton),revision bigint not null default 0
);
insert into learning_catalog_revision(singleton) values(true) on conflict do nothing;
create table if not exists student_read_models (
 student_id uuid not null references profiles(id) on delete cascade,
 kind text not null,scope text not null,source_revision text not null,payload jsonb not null,
 computed_at timestamptz not null default now(),primary key(student_id,kind,scope)
);
alter table student_learning_revisions enable row level security;
alter table learning_catalog_revision enable row level security;
alter table student_read_models enable row level security;

create or replace function bump_student_learning_revision() returns trigger language plpgsql as $$
declare row_data jsonb; previous_data jsonb; owner uuid; parent_id text; changed boolean;
begin
 row_data=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 previous_data=case when tg_op='UPDATE' then to_jsonb(old) else '{}'::jsonb end;
 if tg_op='UPDATE' and tg_table_name='student_preferences' then
  select exists(select 1 from unnest(array['answer_meaning_checks','trainingDiagnostics','trainingAvailability','automaticPractice','trainingActivityNotes','selectedTargetId']) k where previous_data->'data'->k is distinct from row_data->'data'->k) into changed;
  if not changed then return new; end if;
 elsif tg_op='UPDATE' and tg_table_name='study_sessions' then
  if previous_data->'state' is not distinct from row_data->'state' and previous_data->'report' is not distinct from row_data->'report' then return new; end if;
 elsif tg_op='UPDATE' and tg_table_name='interview_turns' then
  select exists(select 1 from unnest(array['answer','invalidated','assisted','assistance_recorded','helpKinds','helpEvents','timedOut','submissionSource','speechSource','rootQuestionId','followupDepth','answerRevisions','transcriptRevisions']) k where previous_data->'data'->k is distinct from row_data->'data'->k) into changed;
  if not changed then return new; end if;
 end if;
 owner=nullif(row_data->>'student_id','')::uuid;
 if owner is null and tg_table_name='answer_revisions' then
  execute format('select student_id from %I.user_answers where id=$1::uuid',tg_table_schema) into owner using row_data->>'answer_id';
 elsif owner is null and tg_table_name='content_versions' then
  execute format('select student_id from %I.content_packages where id=$1',tg_table_schema) into owner using row_data->>'package_id';
 end if;
 if owner is not null then
  execute format('select exists(select 1 from %I.profiles where id=$1)',tg_table_schema) into changed using owner;
  if changed then
   execute format('insert into %I.student_learning_revisions(student_id,revision) values($1,1) on conflict(student_id) do update set revision=student_learning_revisions.revision+1',tg_table_schema) using owner;
  end if;
 else
  execute format('update %I.learning_catalog_revision set revision=revision+1 where singleton=true',tg_table_schema);
 end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;

do $$
declare name text;
begin
 foreach name in array array['user_answers','answer_revisions','interview_turns','interview_sessions','study_session_events','study_imported_events','study_sessions','memory_attempts','quiz_responses','quiz_sessions','quiz_assignments','quiz_submissions','preparation_states','student_confirmations','fact_confirmation_events','experience_cards','support_targets','school_profiles','content_packages','content_versions','knowledge_bite_progress','knowledge_bite_revisions','student_preferences','notifications','common_interview_questions'] loop
  -- Never fall through to public tables while migrating an isolated test schema.
  if to_regclass(format('%I.%I',current_schema(),name)) is not null then
   execute format('drop trigger if exists learning_read_model_revision on %I.%I',current_schema(),name);
   execute format('create trigger learning_read_model_revision after insert or update or delete on %I.%I for each row execute function bump_student_learning_revision()',current_schema(),name);
  end if;
 end loop;
end $$;
