-- A short server-owned lease prevents concurrent retries from paying for the same example twice.
create table if not exists interview_example_requests (
 student_id uuid not null references profiles(id) on delete cascade,
 request_id uuid not null,
 report_id uuid not null references interview_reports(id) on delete cascade,
 turn_id uuid not null references interview_turns(id) on delete cascade,
 basis_hash text not null check(length(basis_hash)=64), fact_ids jsonb not null,
 status text not null check(status in ('processing','completed','failed')),
 lease_token uuid not null, lease_until timestamptz not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 primary key(student_id,request_id)
);
alter table interview_example_requests enable row level security;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then revoke all on interview_example_requests from anon; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then revoke all on interview_example_requests from authenticated; end if;
end $$;
