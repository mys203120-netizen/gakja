-- Derived evidence is append-only. Frozen interview/study reports and original recordings remain unchanged.
create table if not exists speech_analysis_versions (
  id uuid primary key default gen_random_uuid(), student_id uuid not null references profiles(id),
  recording_id uuid not null, recording_kind text not null check(recording_kind in ('interview','quiz')),
  source_hash text not null, algorithm_version text not null, analysis jsonb not null,
  created_at timestamptz not null default now(), unique(student_id,recording_kind,recording_id,source_hash,algorithm_version)
);
create index if not exists speech_analysis_student_recording on speech_analysis_versions(student_id,recording_kind,recording_id,created_at desc);
alter table speech_analysis_versions enable row level security;
do $$ begin
  if exists(select 1 from pg_roles where rolname='anon') then revoke all on speech_analysis_versions from anon; end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then revoke insert,update,delete on speech_analysis_versions from authenticated; end if;
  if to_regprocedure('auth.uid()') is not null then
    execute 'drop policy if exists own_student_read on speech_analysis_versions';
    execute 'create policy own_student_read on speech_analysis_versions for select to authenticated using (student_id=auth.uid())';
  end if;
end $$;
