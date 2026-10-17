-- Learning tasks are attempts over immutable approved content, not content edits.
create table if not exists quiz_assignments (
  id uuid primary key default gen_random_uuid(), student_id uuid not null references profiles(id),
  assigned_by uuid not null references profiles(id), title text not null,
  package_id text not null references content_packages(id), content_version int not null,
  state text not null default 'assigned' check (state in ('assigned','in_progress','submitted','reviewed','retry_due','completed')),
  items jsonb not null check (jsonb_typeof(items)='array'), due_at timestamptz,
  parent_assignment_id uuid references quiz_assignments(id), report_id uuid references interview_reports(id),
  review jsonb not null default '{}', submitted_at timestamptz, reviewed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(package_id,content_version) references content_versions(package_id,version)
);
create index if not exists quiz_assignments_student_due_idx on quiz_assignments(student_id,state,due_at);
create table if not exists quiz_submissions (
  id uuid primary key default gen_random_uuid(), assignment_id uuid not null references quiz_assignments(id) on delete cascade,
  student_id uuid not null references profiles(id), memory_item_id text not null, response jsonb not null,
  rating text not null check (rating in ('again','hard','good','easy')), result jsonb not null,
  submitted_at timestamptz not null default now(), unique(assignment_id,memory_item_id)
);
create table if not exists quiz_assignment_events (
  id uuid primary key default gen_random_uuid(), assignment_id uuid not null references quiz_assignments(id) on delete cascade,
  student_id uuid not null references profiles(id), actor_id uuid not null references profiles(id),
  state text not null, data jsonb not null default '{}', created_at timestamptz not null default now()
);
create table if not exists school_profiles (
  id uuid primary key default gen_random_uuid(), student_id uuid not null references profiles(id),
  target_id text not null references support_targets(id), revision int not null check(revision>0),
  status text not null check(status in ('official_confirmed','historical_reference','sampled','training_configuration','needs_confirmation')),
  data jsonb not null, provenance jsonb not null, reviewed_by uuid not null references profiles(id),
  checked_at timestamptz, created_at timestamptz not null default now(), unique(student_id,target_id,revision)
);
create index if not exists school_profiles_current_idx on school_profiles(student_id,target_id,revision desc);
create table if not exists learning_requests (
  actor_id uuid not null references profiles(id), student_id uuid not null references profiles(id),
  action text not null, request_id text not null, fingerprint text not null, result jsonb not null,
  created_at timestamptz not null default now(), primary key(actor_id,action,request_id)
);
-- The source document and old response remain intact; the typed status is additive.
alter table student_confirmations add column if not exists confirmation_status text;
alter table student_confirmations add constraint confirmation_status_values check (confirmation_status is null or confirmation_status in ('confirmed_from_record','confirmed_by_student','needs_confirmation','student_says_different','cannot_confirm'));
create table if not exists fact_confirmation_events (
  id uuid primary key default gen_random_uuid(), confirmation_id uuid not null references student_confirmations(id) on delete cascade,
  student_id uuid not null references profiles(id), actor_id uuid not null references profiles(id),
  confirmation_status text not null check (confirmation_status in ('confirmed_from_record','confirmed_by_student','needs_confirmation','student_says_different','cannot_confirm')),
  response text, data jsonb not null default '{}', created_at timestamptz not null default now()
);

-- Browser writes remain server-only; read policies protect student rows in Supabase.
do $$
declare t text;
begin
  foreach t in array array['quiz_assignments','quiz_submissions','quiz_assignment_events','school_profiles','learning_requests','fact_confirmation_events'] loop
    execute format('alter table %I enable row level security',t);
    if exists(select 1 from pg_roles where rolname='anon') then execute format('revoke all on %I from anon',t); end if;
    if exists(select 1 from pg_roles where rolname='authenticated') then execute format('revoke insert,update,delete on %I from authenticated',t); end if;
    if t <> 'learning_requests' and to_regprocedure('auth.uid()') is not null then
      execute format('drop policy if exists own_student_read on %I',t);
      execute format('create policy own_student_read on %I for select to authenticated using (student_id=auth.uid())',t);
    end if;
  end loop;
end $$;
