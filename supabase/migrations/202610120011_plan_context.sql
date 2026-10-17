-- A plan points to an owned content ID, never to a client-provided URL.
alter table student_plans add column if not exists target jsonb;
alter table student_plans add constraint student_plans_target_shape check(target is null or (jsonb_typeof(target)='object' and target->>'kind' in ('question','activity','video','assignment') and length(target->>'id') between 1 and 200));
alter table knowledge_bite_revisions add column if not exists metadata jsonb not null default '{}'::jsonb;
