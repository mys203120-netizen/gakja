create table if not exists briefing_thoughts (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references profiles(id),
  briefing_id uuid not null references briefings(id),
  content text not null check(length(content)<=8000),
  revision integer not null check(revision>0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(student_id,briefing_id)
);
create table if not exists briefing_thought_revisions (
  id uuid primary key default gen_random_uuid(),
  thought_id uuid not null references briefing_thoughts(id) on delete cascade,
  student_id uuid not null references profiles(id),
  content text not null, revision integer not null,
  created_at timestamptz not null default now(), unique(thought_id,revision)
);
alter table briefing_thoughts enable row level security;
alter table briefing_thought_revisions enable row level security;
do $$ begin
  if to_regprocedure('auth.uid()') is not null then
    execute 'create policy own_student_read on briefing_thoughts for select to authenticated using (student_id=auth.uid())';
    execute 'create policy own_student_read on briefing_thought_revisions for select to authenticated using (student_id=auth.uid())';
  end if;
end $$;
