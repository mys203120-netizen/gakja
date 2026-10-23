create table student_document_previews (
  id uuid primary key default gen_random_uuid(), student_id uuid not null unique references profiles(id) on delete cascade,
  filename text not null, bytes bytea not null, pages jsonb not null default '[]',
  status text not null default 'pending' check(status in ('pending','processing','ready','failed')),
  lease_token uuid, lease_until timestamptz, error_message text,
  created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '24 hours'
);
create index student_document_preview_expiry on student_document_previews(expires_at);
create table student_document_text_versions (
  id uuid primary key default gen_random_uuid(), document_id uuid not null references student_documents(id) on delete cascade,
  student_id uuid not null references profiles(id) on delete cascade, revision integer not null check(revision>0),
  pages jsonb not null, reason text not null, created_at timestamptz not null default now(), unique(document_id,revision)
);
insert into student_document_text_versions(document_id,student_id,revision,pages,reason) select id,student_id,1,pages,'기존 PDF 추출문' from student_documents;
create trigger student_document_text_immutable before update on student_document_text_versions for each row execute function immutable_student_document();
alter table student_document_analyses add column text_revision integer not null default 1;
alter table student_document_previews enable row level security;
alter table student_document_text_versions enable row level security;
do $$ begin
  if exists(select 1 from pg_roles where rolname='anon') then revoke all on student_document_previews,student_document_text_versions from anon; end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then revoke all on student_document_previews,student_document_text_versions from authenticated; end if;
end $$;
