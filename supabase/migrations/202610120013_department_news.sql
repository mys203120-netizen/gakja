-- Public metadata only: never a copied article body or invented publication date.
create table if not exists department_news_articles (
  id uuid primary key default gen_random_uuid(), canonical_url text not null unique,
  title text not null check(length(title)<=300), publisher text not null,
  snippet text not null default '' check(length(snippet)<=180), published_at timestamptz not null,
  feed_key text not null, fetched_at timestamptz not null default now()
);
create index if not exists department_news_articles_date on department_news_articles(published_at desc);
create table if not exists department_news_cache (
  topic_key text primary key, article_ids uuid[] not null default '{}',
  status text not null check(status in ('fresh','empty','error')), fetched_at timestamptz,
  checked_at timestamptz not null default now(), retry_after timestamptz not null default now(),
  source_failures jsonb not null default '[]'
);
create table if not exists department_news_thoughts (
  id uuid primary key default gen_random_uuid(), student_id uuid not null references profiles(id),
  article_id uuid not null references department_news_articles(id), content text not null check(length(content)<=4000),
  revision integer not null check(revision>0), updated_at timestamptz not null default now(),
  unique(student_id,article_id)
);
create table if not exists department_news_thought_revisions (
  id uuid primary key default gen_random_uuid(), thought_id uuid not null references department_news_thoughts(id) on delete cascade,
  student_id uuid not null references profiles(id), content text not null check(length(content)<=4000),
  revision integer not null, created_at timestamptz not null default now(), unique(thought_id,revision)
);
create table if not exists department_news_practice (
  student_id uuid not null references profiles(id), article_id uuid not null references department_news_articles(id),
  target_id text not null, major text not null, briefing_id uuid not null references briefings(id),
  created_at timestamptz not null default now(), primary key(student_id,article_id,target_id,major)
);
alter table department_news_articles enable row level security;
alter table department_news_cache enable row level security;
alter table department_news_thoughts enable row level security;
alter table department_news_thought_revisions enable row level security;
alter table department_news_practice enable row level security;
do $$ begin
  if to_regprocedure('auth.uid()') is not null then
    if not exists(select 1 from pg_policies where tablename='department_news_thoughts' and policyname='own_student_read') then
      execute 'create policy own_student_read on department_news_thoughts for select to authenticated using(student_id=auth.uid())';
      execute 'create policy own_student_read on department_news_thought_revisions for select to authenticated using(student_id=auth.uid())';
      execute 'create policy own_student_read on department_news_practice for select to authenticated using(student_id=auth.uid())';
    end if;
  end if;
end $$;
