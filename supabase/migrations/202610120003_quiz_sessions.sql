create table if not exists quiz_sessions (
  id uuid primary key default gen_random_uuid(), student_id uuid not null references profiles(id),
  mode text not null check(mode in ('choice','answer','oral')), content_version integer not null,
  state text not null default 'ready' check(state in ('ready','active','paused','completed','ended')),
  items jsonb not null, current_index integer not null default 0, revision integer not null default 1,
  deadline_at timestamptz, remaining_ms integer, item_started_at timestamptz, item_elapsed_ms integer not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), finished_at timestamptz
);
create index if not exists quiz_sessions_student_idx on quiz_sessions(student_id,created_at desc);
create table if not exists quiz_responses (
  id uuid primary key default gen_random_uuid(), session_id uuid not null references quiz_sessions(id) on delete cascade,
  student_id uuid not null references profiles(id), item_index integer not null, memory_item_id text not null,
  response text not null default '', selected_option_id text, outcome boolean, timed_out boolean not null default false,
  elapsed_ms integer not null, hint_used boolean not null default false, rating text not null,
  data jsonb not null default '{}', created_at timestamptz not null default now(), unique(session_id,item_index)
);
create table if not exists quiz_recordings (
  id uuid primary key default gen_random_uuid(), session_id uuid not null references quiz_sessions(id) on delete cascade,
  student_id uuid not null references profiles(id), item_index integer not null, data bytea not null, mime text not null,
  duration_ms integer not null, metadata jsonb not null default '{}', created_at timestamptz not null default now()
);
alter table quiz_sessions enable row level security;
alter table quiz_responses enable row level security;
alter table quiz_recordings enable row level security;
do $$ begin
  if to_regprocedure('auth.uid()') is not null then
    execute 'create policy own_student_read on quiz_sessions for select to authenticated using (student_id=auth.uid())';
    execute 'create policy own_student_read on quiz_responses for select to authenticated using (student_id=auth.uid())';
    -- Audio bytes stay behind the authenticated API, including in Supabase mode.
  end if;
end $$;
