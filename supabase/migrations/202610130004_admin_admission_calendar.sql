-- Admin edits override imported snapshots without destroying publisher evidence.
create table if not exists admission_calendar_admin_edits (
  id text primary key,
  admission_year integer not null check(admission_year between 2020 and 2100),
  school_reference_id text not null,
  data jsonb not null check(jsonb_typeof(data)='object'),
  revision integer not null check(revision>0),
  deleted boolean not null default false,
  created_by uuid not null references profiles(id),
  updated_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists admission_calendar_admin_school_idx on admission_calendar_admin_edits(admission_year,school_reference_id);
create table if not exists admission_calendar_admin_events (
  id uuid primary key default gen_random_uuid(),
  row_id text not null references admission_calendar_admin_edits(id),
  revision integer not null,
  action text not null check(action in ('create','update','delete','restore')),
  actor_id uuid not null references profiles(id),
  data jsonb not null check(jsonb_typeof(data)='object'),
  created_at timestamptz not null default now()
);
do $$
declare t text;
begin
  foreach t in array array['admission_calendar_admin_edits','admission_calendar_admin_events'] loop
    execute format('alter table %I enable row level security',t);
    if exists(select 1 from pg_roles where rolname='anon') then execute format('revoke all on %I from anon',t); end if;
    if exists(select 1 from pg_roles where rolname='authenticated') then execute format('revoke all on %I from authenticated',t); end if;
  end loop;
end $$;
