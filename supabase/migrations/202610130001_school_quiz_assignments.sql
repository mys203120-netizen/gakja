-- A school-question task can start before a private student record is published.
-- Its approved public sources and target identity remain immutable in the task.
alter table quiz_assignments alter column package_id drop not null;
alter table quiz_assignments add column source_kind text not null default 'personal';
alter table quiz_assignments add column target_id text;
alter table quiz_assignments add column target_snapshot jsonb;
alter table quiz_assignments add column source_snapshot jsonb not null default '{}';

create function valid_school_assignment_items(items jsonb, target_id text, target_snapshot jsonb)
returns boolean language plpgsql immutable as $$
declare item jsonb;
begin
  if jsonb_typeof(items) is distinct from 'array' or jsonb_array_length(items)=0
    or target_id is null or jsonb_typeof(target_snapshot) is distinct from 'object' then return false; end if;
  for item in select value from jsonb_array_elements(items) loop
    if item->>'source_kind' is distinct from 'common'
      or item->>'target_id' is distinct from target_id
      or item->'target_snapshot' is distinct from target_snapshot
      or item->>'question_id' is null or length(item->>'question_id')=0
      or jsonb_typeof(item->'source_snapshot') is distinct from 'object'
      or jsonb_typeof(item->'source_type') is distinct from 'string'
      or jsonb_typeof(item->'common_revision') is distinct from 'number'
      or not coalesce(item->>'common_revision' ~ '^[1-9][0-9]*$',false)
      or item->>'category' is distinct from 'experiential'
      or item->>'kind' is distinct from 'short_speech'
      or item->>'evaluation_method' is distinct from 'self_check'
      or coalesce(item->>'modelAnswer','')<>'' then return false; end if;
  end loop;
  return true;
end $$;

alter table quiz_assignments add constraint quiz_assignments_source_shape check (
  (source_kind='personal' and package_id is not null and content_version>0)
  or (source_kind='common' and package_id is null and content_version=0
    and valid_school_assignment_items(items,target_id,target_snapshot)
    and jsonb_typeof(source_snapshot)='object'
    and jsonb_typeof(source_snapshot->'questions')='array'
    and jsonb_array_length(source_snapshot->'questions')>0)
);
create index quiz_assignments_school_target_idx on quiz_assignments(student_id,target_id,created_at desc)
  where source_kind='common';
