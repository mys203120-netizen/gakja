-- Editing an experience must never autosave over its confirmed source card.
create table public.experience_card_drafts (
 id uuid primary key,
 student_id uuid not null references public.profiles(id),
 card_revision integer not null default 0 check (card_revision>=0),
 data jsonb not null,
 step smallint not null default 0 check (step between 0 and 3),
 revision integer not null default 1 check (revision>0),
 updated_at timestamptz not null default now()
);
create index experience_card_drafts_owner on public.experience_card_drafts(student_id,updated_at desc);
alter table public.experience_card_drafts enable row level security;
-- These drafts are served through the authenticated application API only.
-- The ownership policy also protects a future deliberate Data API grant.
do $$
begin
 if to_regprocedure('auth.uid()') is not null and exists(select 1 from pg_roles where rolname='authenticated') then
  execute 'create policy experience_draft_owner on public.experience_card_drafts for all to authenticated
   using (student_id=(select auth.uid()) and exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.active))
   with check (student_id=(select auth.uid()) and exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.active))';
 end if;
 if exists(select 1 from pg_roles where rolname='anon') then execute 'revoke all on public.experience_card_drafts from anon'; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then execute 'revoke all on public.experience_card_drafts from authenticated'; end if;
end $$;
