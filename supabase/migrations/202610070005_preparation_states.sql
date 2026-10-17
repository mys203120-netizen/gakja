create table if not exists preparation_states (
  student_id uuid not null references profiles(id), entity_id text not null,
  stage text not null check(stage in ('read','answer','recall','speech','followup')),
  completed boolean not null default false, source text not null default 'self_check',
  updated_at timestamptz not null default now(), primary key(student_id,entity_id,stage)
);
alter table preparation_states enable row level security;
do $$
begin
  if to_regprocedure('auth.uid()') is not null then
    execute 'create policy own_preparation_read on preparation_states for select to authenticated using (student_id=auth.uid())';
  end if;
end $$;
