create table if not exists student_plans (
  id uuid primary key default gen_random_uuid(), student_id uuid not null references profiles(id),
  title text not null check(length(title) between 1 and 160), planned_date date not null,
  kind text not null default 'study' check(kind in ('study','quiz','interview','reading')),
  completed boolean not null default false, revision integer not null default 1,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists student_plans_date_idx on student_plans(student_id,planned_date);
alter table student_plans enable row level security;
do $$ begin
  if to_regprocedure('auth.uid()') is not null then
    execute 'create policy own_student_read on student_plans for select to authenticated using (student_id=auth.uid())';
  end if;
end $$;
