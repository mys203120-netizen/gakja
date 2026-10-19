-- Keep the same restrictive account gate used by all other private tables.
-- This stays effective if another permissive access policy is added later.
do $$
begin
 if to_regprocedure('auth.uid()') is null or not exists(select 1 from pg_roles where rolname='authenticated') then return; end if;
 execute 'create policy active_account_gate on public.experience_card_drafts as restrictive for all to authenticated
  using (exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.active))
  with check (exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.active))';
end $$;
