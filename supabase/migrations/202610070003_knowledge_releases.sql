create table if not exists knowledge_releases (
  id uuid primary key default gen_random_uuid(), title text not null, category text not null default '',
  data jsonb not null, status text not null default 'draft', created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
alter table knowledge_releases enable row level security;
