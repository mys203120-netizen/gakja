-- Public school exam dates remain separate from a student's assigned date/time.
create table if not exists admission_calendar_versions (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  admission_year int not null check (admission_year between 2020 and 2100),
  content_hash text not null check (length(content_hash)=64),
  data jsonb not null check (jsonb_typeof(data)='object'),
  fetched_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (source_key,admission_year,content_hash)
);
create table if not exists admission_calendar_sync_state (
  source_key text primary key,
  latest_version_id uuid references admission_calendar_versions(id),
  checked_at timestamptz,
  attempted_at timestamptz,
  retry_after timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);
create index if not exists admission_calendar_year_idx on admission_calendar_versions(source_key,admission_year,fetched_at desc);
do $$
declare t text;
begin
  foreach t in array array['admission_calendar_versions','admission_calendar_sync_state'] loop
    execute format('alter table %I enable row level security',t);
    if exists(select 1 from pg_roles where rolname='anon') then execute format('revoke all on %I from anon',t); end if;
    if exists(select 1 from pg_roles where rolname='authenticated') then execute format('revoke all on %I from authenticated',t); end if;
  end loop;
end $$;
