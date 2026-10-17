-- Existing question snapshots and responses remain unchanged.
alter table quiz_sessions add column if not exists metadata jsonb not null default '{}';
create index if not exists quiz_responses_student_item_idx on quiz_responses(student_id,memory_item_id,created_at desc);
