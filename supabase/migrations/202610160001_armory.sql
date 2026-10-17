create table experience_cards (
 id uuid primary key,
 student_id uuid not null references profiles(id),
 data jsonb not null,
 revision integer not null default 1,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index experience_cards_owner on experience_cards(student_id,updated_at desc);
alter table experience_cards enable row level security;
