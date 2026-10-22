-- Internal milestone receipts contain no learning content and are never browser-readable.
-- GA receives only the event enum and (for signup) a verified provider enum.
create table if not exists analytics_conversion_receipts (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references profiles(id) on delete cascade,
  event_name text not null check(event_name in ('sign_up','first_answer_saved','interview_completed')),
  dedupe_key text not null,
  method text check(method in ('google','kakao')),
  occurred_at timestamptz not null default clock_timestamp(),
  delivered_at timestamptz,
  unique(student_id,event_name,dedupe_key)
);
create index if not exists analytics_receipts_pending_idx on analytics_conversion_receipts(student_id,occurred_at) where delivered_at is null;
alter table analytics_conversion_receipts enable row level security;
do $$ begin
  if exists(select 1 from pg_roles where rolname='anon') then revoke all on analytics_conversion_receipts from anon; end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then revoke all on analytics_conversion_receipts from authenticated; end if;
end $$;

create or replace function analytics_record_milestone(student uuid, event text, dedupe text, provider text default null)
returns void language sql as $$
  insert into analytics_conversion_receipts(student_id,event_name,dedupe_key,method)
  select p.id,event,dedupe,provider from profiles p
  where p.id=student and p.role='student' and p.active and lower(p.email) not like '%@gakja.test'
  on conflict(student_id,event_name,dedupe_key) do nothing
$$;

create or replace function analytics_saved_answer()
returns trigger language plpgsql as $$
declare saved boolean := false;
begin
  case tg_table_name
    when 'user_answers' then
      saved := nullif(btrim(new.script),'') is not null or nullif(btrim(new.structure),'') is not null;
    when 'interview_turns' then
      saved := nullif(btrim(new.data->>'answer'),'') is not null
        and coalesce(new.data->>'invalidated','false')<>'true'
        and exists(select 1 from interview_sessions s where s.id=new.session_id and s.student_id=new.student_id and s.state not in ('cancelled','deleted'));
    when 'quiz_responses' then
      saved := not new.timed_out
        and exists(select 1 from quiz_sessions s where s.id=new.session_id and s.student_id=new.student_id and s.mode<>'choice')
        and (nullif(btrim(new.response),'') is not null or exists(
          select 1 from quiz_recordings r where r.id::text=new.data->>'recording_id' and r.session_id=new.session_id and r.student_id=new.student_id and r.item_index=new.item_index));
    when 'quiz_submissions' then
      saved := jsonb_typeof(new.response->'response')='string' and nullif(btrim(new.response->>'response'),'') is not null;
    when 'memory_attempts' then
      saved := jsonb_typeof(new.data->'answer')='string' and nullif(btrim(new.data->>'answer'),'') is not null;
    else return new;
  end case;
  if saved then perform analytics_record_milestone(new.student_id,'first_answer_saved','first'); end if;
  return new;
end $$;

-- Mark existing answers as already known, without sending historical conversions.
insert into analytics_conversion_receipts(student_id,event_name,dedupe_key,delivered_at)
select p.id,'first_answer_saved','first',now() from profiles p
where p.role='student' and (
  exists(select 1 from user_answers a where a.student_id=p.id and (nullif(btrim(a.script),'') is not null or nullif(btrim(a.structure),'') is not null))
  or exists(select 1 from interview_turns t join interview_sessions s on s.id=t.session_id and s.student_id=t.student_id where t.student_id=p.id and s.state not in ('cancelled','deleted') and coalesce(t.data->>'invalidated','false')<>'true' and nullif(btrim(t.data->>'answer'),'') is not null)
  or exists(select 1 from quiz_responses r join quiz_sessions s on s.id=r.session_id and s.student_id=r.student_id where r.student_id=p.id and s.mode<>'choice' and not r.timed_out and (nullif(btrim(r.response),'') is not null or nullif(r.data->>'recording_id','') is not null))
  or exists(select 1 from quiz_submissions q where q.student_id=p.id and jsonb_typeof(q.response->'response')='string' and nullif(btrim(q.response->>'response'),'') is not null)
  or exists(select 1 from memory_attempts m where m.student_id=p.id and jsonb_typeof(m.data->'answer')='string' and nullif(btrim(m.data->>'answer'),'') is not null)
) on conflict(student_id,event_name,dedupe_key) do nothing;

do $$ declare table_name text; begin
  foreach table_name in array array['user_answers','interview_turns','quiz_responses','quiz_submissions','memory_attempts'] loop
    execute format('drop trigger if exists analytics_saved_answer_receipt on %I',table_name);
    execute format('create trigger analytics_saved_answer_receipt after insert or update on %I for each row execute function analytics_saved_answer()',table_name);
  end loop;
end $$;

create or replace function analytics_confirmed_signup()
returns trigger language plpgsql as $$
begin
  -- Both direct local OAuth and Supabase OAuth create this audit only after
  -- provisionSocialStudent validates the provider and inserts a NEW profile.
  if new.action='account.social.created' and new.actor_id=new.student_id
    and new.data->>'provider' in ('google','kakao')
    and exists(select 1 from social_identities i where i.user_id=new.student_id and i.provider=new.data->>'provider') then
    perform analytics_record_milestone(new.student_id,'sign_up','account',new.data->>'provider');
  end if;
  return new;
end $$;
drop trigger if exists analytics_signup_receipt on audit_logs;
create trigger analytics_signup_receipt after insert on audit_logs for each row execute function analytics_confirmed_signup();

create or replace function analytics_completed_interview()
returns trigger language plpgsql as $$
begin
  -- finishSession persists the report before committing the completed session.
  -- Drafts, cancellation, failed saves and feedback retries cannot create events.
  if new.state='completed' and old.state is distinct from 'completed'
    and exists(select 1 from interview_reports r where r.session_id=new.id and r.student_id=new.student_id)
    and exists(select 1 from interview_turns t where t.session_id=new.id and t.student_id=new.student_id
      and nullif(btrim(t.data->>'answer'),'') is not null and coalesce(t.data->>'invalidated','false')<>'true') then
    perform analytics_record_milestone(new.student_id,'interview_completed',new.id::text);
  end if;
  return new;
end $$;
drop trigger if exists analytics_interview_receipt on interview_sessions;
create trigger analytics_interview_receipt after update on interview_sessions for each row execute function analytics_completed_interview();

-- Trigger helpers execute with the app connection role; never expose an RPC for
-- a browser to fabricate milestone rows, even when Supabase grants schema usage.
revoke all on function analytics_record_milestone(uuid,text,text,text) from public;
revoke all on function analytics_saved_answer() from public;
revoke all on function analytics_confirmed_signup() from public;
revoke all on function analytics_completed_interview() from public;
