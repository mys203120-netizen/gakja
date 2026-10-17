-- Public reference catalog and non-personal practice remain independent of student publication.
create table if not exists school_reference_catalog (
  id text not null, revision int not null check(revision>0), university text not null,
  status text not null check(status in ('historical_reference','needs_confirmation','official_confirmed')),
  data jsonb not null, source jsonb not null, created_at timestamptz not null default now(),
  primary key(id,revision)
);
create table if not exists common_interview_questions (
  id text not null, revision int not null check(revision>0), prompt text not null,
  source_type text not null check(source_type in ('general_practice','book_reference','verified_past')),
  status text not null check(status in ('published','withdrawn')),
  school_reference_id text, data jsonb not null, source jsonb not null,
  created_at timestamptz not null default now(), primary key(id,revision)
);
create index if not exists common_questions_school_idx on common_interview_questions(school_reference_id,status);
do $$
declare t text;
begin
  foreach t in array array['school_reference_catalog','common_interview_questions'] loop
    execute format('alter table %I enable row level security',t);
    if exists(select 1 from pg_roles where rolname='anon') then execute format('revoke all on %I from anon',t); end if;
    if exists(select 1 from pg_roles where rolname='authenticated') then execute format('revoke insert,update,delete on %I from authenticated',t); end if;
  end loop;
end $$;
