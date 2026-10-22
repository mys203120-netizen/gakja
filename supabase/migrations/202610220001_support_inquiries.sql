-- Only the server database role may handle public inquiries. No exposed client grants.
create table support_inquiries (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  student_id uuid references profiles(id) on delete set null,
  email text not null check (length(email) between 3 and 254),
  type text not null check (type in ('service','account','technical','privacy')),
  content text not null check (length(content) between 1 and 5000),
  status text not null default 'received' check (status in ('received','in_progress','resolved')),
  policy_version text not null,
  consented_at timestamptz not null default now(),
  response_time_notice text not null,
  retention_notice text not null,
  operator_note text not null default '',
  updated_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index support_inquiries_email_created on support_inquiries(email,created_at desc);
create index support_inquiries_status_created on support_inquiries(status,created_at desc);
alter table support_inquiries enable row level security;
revoke all on support_inquiries from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='anon') then revoke all on support_inquiries from anon; end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then revoke all on support_inquiries from authenticated; end if;
end $$;
