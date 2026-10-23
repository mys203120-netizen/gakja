-- Student originals are separate from generated, versioned learning content.
create table if not exists student_documents (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null unique references profiles(id) on delete cascade,
  filename text not null, mime text not null check(mime='application/pdf'),
  bytes bytea not null, sha256 text not null check(length(sha256)=64),
  pages jsonb not null, page_count integer not null check(page_count between 1 and 60),
  recognition jsonb not null, consent_version text not null,
  locked_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create table if not exists student_document_guidelines (
  id uuid primary key default gen_random_uuid(),
  kind text not null check(kind in ('analysis','questions','evaluation','feedback','curriculum')),
  version integer not null check(version>0), body text not null check(length(body) between 10 and 20000),
  status text not null check(status in ('draft','published')), created_by uuid references profiles(id),
  created_at timestamptz not null default now(), published_at timestamptz,
  unique(kind,version)
);
create table if not exists student_document_analyses (
  id uuid primary key default gen_random_uuid(), document_id uuid not null references student_documents(id) on delete cascade,
  student_id uuid not null references profiles(id) on delete cascade, revision integer not null check(revision>0),
  status text not null check(status in ('pending','processing','completed','failed','unconfigured')),
  guidelines jsonb not null, targets jsonb not null, result jsonb, markdown text,
  model text, error_code text, error_message text, content_version_id uuid references content_versions(id),
  lease_token uuid, started_at timestamptz, completed_at timestamptz, created_at timestamptz not null default now(),
  unique(document_id,revision)
);
create unique index if not exists student_document_analysis_running on student_document_analyses(document_id) where status in ('pending','processing');
create index if not exists student_document_analysis_history on student_document_analyses(student_id,revision desc);

create or replace function immutable_student_document() returns trigger language plpgsql as $$
begin
  if new is distinct from old then raise exception '고정한 생기부 원본은 변경할 수 없습니다.'; end if;
  return new;
end $$;
create trigger student_document_immutable before update on student_documents for each row execute function immutable_student_document();
create or replace function immutable_published_document_guideline() returns trigger language plpgsql as $$
begin
  if old.status='published' then raise exception '게시한 지침은 새 버전으로 작성해 주세요.'; end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger published_document_guideline_immutable before update or delete on student_document_guidelines for each row execute function immutable_published_document_guideline();

alter table student_documents enable row level security;
alter table student_document_analyses enable row level security;
alter table student_document_guidelines enable row level security;
-- No browser grants: all access, including original downloads, is owner checked by server routes.
do $$ begin
  if exists(select 1 from pg_roles where rolname='anon') then revoke all on student_documents,student_document_analyses,student_document_guidelines from anon; end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then revoke all on student_documents,student_document_analyses,student_document_guidelines from authenticated; end if;
end $$;
