-- PostgreSQL CHECK allows SQL NULL. Require the public-source index explicitly.
alter table quiz_assignments add constraint quiz_assignments_common_source_index check (
  source_kind<>'common' or coalesce(
    jsonb_typeof(source_snapshot->'questions')='array'
    and jsonb_array_length(source_snapshot->'questions')=jsonb_array_length(items),false)
);
