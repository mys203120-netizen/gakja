create extension if not exists pgcrypto;

create table if not exists profiles (
  id uuid primary key default gen_random_uuid(), email text unique not null, name text not null,
  role text not null default 'student' check (role in ('student','staff','admin')),
  password_hash text, active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists sessions (
  id text primary key, user_id uuid not null references profiles(id) on delete cascade,
  expires_at timestamptz not null, created_at timestamptz not null default now()
);
create index if not exists sessions_user_idx on sessions(user_id);
create table if not exists staff_assignments (
  staff_id uuid not null references profiles(id), student_id uuid not null references profiles(id),
  permissions jsonb not null default '["import","publish","review"]', primary key(staff_id,student_id)
);
create table if not exists support_targets (
  id text primary key, student_id uuid not null references profiles(id), data jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists production_links (
  id text primary key, student_id uuid not null references profiles(id),
  data jsonb not null default '{}', created_at timestamptz not null default now()
);
create table if not exists content_packages (
  id text primary key, student_id uuid not null references profiles(id), active_version int,
  created_at timestamptz not null default now()
);
create unique index if not exists content_packages_student_idx on content_packages(student_id);
create table if not exists content_versions (
  id uuid primary key default gen_random_uuid(), package_id text not null references content_packages(id),
  version int not null check(version > 0), data jsonb not null, learning_hash text not null,
  status text not null default 'staged' check(status in ('staged','published','rejected')),
  production_job_ref text not null references production_links(id), review jsonb not null default '{}',
  created_by uuid references profiles(id), published_by uuid references profiles(id),
  published_at timestamptz, created_at timestamptz not null default now(), unique(package_id,version)
);
create table if not exists documents (
  id uuid primary key default gen_random_uuid(), student_id uuid not null references profiles(id),
  package_id text not null references content_packages(id), content_version int not null,
  kind text not null check(kind in ('guidebook','handbook')), data jsonb not null, html text not null,
  file_hash text not null, created_at timestamptz not null default now(),
  unique(package_id,content_version,kind), foreign key(package_id,content_version) references content_versions(package_id,version)
);
create table if not exists user_answers (
  id uuid primary key default gen_random_uuid(), student_id uuid not null references profiles(id),
  question_id text not null, revision int not null default 1, structure text not null default '',
  script text not null default '', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(student_id,question_id)
);
create table if not exists answer_revisions (
  id uuid primary key default gen_random_uuid(), answer_id uuid not null references user_answers(id),
  revision int not null, structure text not null, script text not null, created_at timestamptz not null default now(),
  unique(answer_id,revision)
);
create table if not exists answer_comments (
  id uuid primary key default gen_random_uuid(), answer_id uuid references user_answers(id),
  student_id uuid not null references profiles(id), author_id uuid not null references profiles(id),
  content text not null, created_at timestamptz not null default now()
);
create table if not exists chat_threads (
  id uuid primary key default gen_random_uuid(), student_id uuid not null references profiles(id),
  target_id text references support_targets(id), content_version int not null, title text not null default '새 대화',
  context jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(), thread_id uuid not null references chat_threads(id) on delete cascade,
  student_id uuid not null references profiles(id), role text not null check(role in ('user','assistant')),
  content text not null, data jsonb not null default '{}', created_at timestamptz not null default now()
);
create table if not exists interview_sessions (
  id uuid primary key default gen_random_uuid(), student_id uuid not null references profiles(id),
  kind text not null default 'chat', mode text not null default 'basic', target_id text references support_targets(id),
  content_version int not null, state text not null default 'active', data jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), completed_at timestamptz
);
create table if not exists interview_turns (
  id uuid primary key default gen_random_uuid(), session_id uuid not null references interview_sessions(id) on delete cascade,
  student_id uuid not null references profiles(id), question_id text not null, data jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create table if not exists memory_attempts (
  id uuid primary key default gen_random_uuid(), student_id uuid not null references profiles(id),
  memory_item_id text not null, rating text not null check(rating in ('again','hard','good','easy')),
  data jsonb not null default '{}', due_at timestamptz not null, created_at timestamptz not null default now()
);
create index if not exists memory_attempts_due_idx on memory_attempts(student_id,due_at);
create table if not exists interview_reports (
  id uuid primary key default gen_random_uuid(), student_id uuid not null references profiles(id),
  session_id uuid not null unique references interview_sessions(id), data jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create table if not exists media_assets (
  id uuid primary key default gen_random_uuid(), student_id uuid not null references profiles(id),
  session_id uuid references interview_sessions(id), data bytea not null, mime text not null,
  text text, metadata jsonb not null default '{}', created_at timestamptz not null default now()
);
create table if not exists student_confirmations (
  id uuid primary key default gen_random_uuid(), student_id uuid not null references profiles(id),
  entity_id text, question text not null, response text, state text not null default 'pending',
  data jsonb not null default '{}', reviewed_by uuid references profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists student_preferences (
  student_id uuid primary key references profiles(id), data jsonb not null default '{}', updated_at timestamptz not null default now()
);
create table if not exists reading_progress (
  student_id uuid not null references profiles(id), document_kind text not null, section_id text not null,
  updated_at timestamptz not null default now(), primary key(student_id,document_kind)
);
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(), student_id uuid not null references profiles(id),
  title text not null, body text not null default '', href text, read_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(), actor_id uuid references profiles(id), student_id uuid references profiles(id),
  action text not null, data jsonb not null default '{}', created_at timestamptz not null default now()
);
create table if not exists usage_records (
  id uuid primary key default gen_random_uuid(), student_id uuid references profiles(id), kind text not null,
  model text, input_tokens int not null default 0, output_tokens int not null default 0,
  data jsonb not null default '{}', created_at timestamptz not null default now()
);
create table if not exists briefings (
  id uuid primary key default gen_random_uuid(), title text not null, category text not null,
  data jsonb not null, status text not null default 'draft', created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

-- Browser access is denied except explicitly permitted own rows. The app's server
-- uses a connection role and rechecks ownership before every read or write.
do $$
declare table_name text;
begin
  foreach table_name in array array['profiles','sessions','staff_assignments','support_targets','production_links','content_packages','content_versions','documents','user_answers','answer_revisions','answer_comments','chat_threads','chat_messages','interview_sessions','interview_turns','memory_attempts','interview_reports','media_assets','student_confirmations','student_preferences','reading_progress','notifications','audit_logs','usage_records','briefings']
  loop execute format('alter table %I enable row level security', table_name); end loop;
  if exists(select 1 from pg_roles where rolname='anon') then execute 'revoke all on all tables in schema public from anon'; end if;
end $$;

-- Supabase auth schemas exist only on a Supabase deployment.
do $$
declare t text;
begin
  if to_regprocedure('auth.uid()') is not null then
    foreach t in array array['support_targets','documents','user_answers','answer_comments','chat_threads','chat_messages','interview_sessions','interview_turns','memory_attempts','interview_reports','media_assets','student_confirmations','student_preferences','reading_progress','notifications']
    loop
      execute format('drop policy if exists own_student_read on %I',t);
      execute format('create policy own_student_read on %I for select to authenticated using (student_id = auth.uid())',t);
    end loop;
    execute 'drop policy if exists own_profile_read on profiles';
    execute 'create policy own_profile_read on profiles for select to authenticated using (id = auth.uid())';
  end if;
end $$;
