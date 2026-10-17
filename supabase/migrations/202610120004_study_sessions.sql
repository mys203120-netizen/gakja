-- A study report is a snapshot of persisted quiz/interview answers in one app visit.
create table if not exists study_sessions (
  id uuid primary key default gen_random_uuid(), student_id uuid not null references profiles(id),
  state text not null default 'active' check(state in ('active','finalized')),
  started_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(), closing_at timestamptz,
  ended_at timestamptz, finish_reason text, report jsonb
);
create unique index if not exists study_sessions_one_active on study_sessions(student_id) where state='active';
create index if not exists study_sessions_student_started on study_sessions(student_id,started_at desc);
create table if not exists study_session_tabs (
  session_id uuid not null references study_sessions(id) on delete cascade,
  student_id uuid not null references profiles(id), tab_id uuid not null,
  last_seen_at timestamptz not null default now(), closed_at timestamptz,
  primary key(session_id,tab_id)
);
create table if not exists study_session_events (
  id uuid primary key default gen_random_uuid(), session_id uuid not null references study_sessions(id) on delete cascade,
  student_id uuid not null references profiles(id), kind text not null check(kind in ('quiz_response','interview_answer')),
  source_id text not null, data jsonb not null, created_at timestamptz not null default now(),
  unique(student_id,kind,source_id)
);
create index if not exists study_session_events_session on study_session_events(session_id,created_at);
do $$
declare t text;
begin
  foreach t in array array['study_sessions','study_session_tabs','study_session_events'] loop
    execute format('alter table %I enable row level security',t);
    if exists(select 1 from pg_roles where rolname='anon') then execute format('revoke all on %I from anon',t); end if;
    if exists(select 1 from pg_roles where rolname='authenticated') then execute format('revoke insert,update,delete on %I from authenticated',t); end if;
    if to_regprocedure('auth.uid()') is not null then
      execute format('drop policy if exists own_student_read on %I',t);
      execute format('create policy own_student_read on %I for select to authenticated using (student_id=auth.uid())',t);
    end if;
  end loop;
end $$;
