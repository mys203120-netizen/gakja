-- Cover provider sessions that have not visited the app since device tracking began.
create table account_session_revocations (
 student_id uuid primary key references profiles(id), revoked_before timestamptz not null,
 allowed_session_key text not null
);
alter table account_session_revocations enable row level security;
revoke all on account_session_revocations from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then revoke all on account_session_revocations from anon; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then revoke all on account_session_revocations from authenticated; end if;
end $$;
