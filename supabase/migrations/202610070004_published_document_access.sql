-- The student's authenticated Supabase role can read published learning only.
-- The staging area remains inaccessible even when the student knows a row ID.
do $$
begin
  if to_regprocedure('auth.uid()') is not null then
    execute 'drop policy if exists own_published_package on content_packages';
    execute 'create policy own_published_package on content_packages for select to authenticated using (student_id=auth.uid() and active_version is not null)';
    execute 'drop policy if exists own_published_content on content_versions';
    execute 'create policy own_published_content on content_versions for select to authenticated using (status=''published'' and exists(select 1 from content_packages p where p.id=package_id and p.student_id=auth.uid()))';
    execute 'drop policy if exists own_student_read on documents';
    execute 'create policy own_student_read on documents for select to authenticated using (student_id=auth.uid() and exists(select 1 from content_versions v where v.package_id=documents.package_id and v.version=documents.content_version and v.status=''published''))';
    execute 'drop policy if exists own_answer_history on answer_revisions';
    execute 'create policy own_answer_history on answer_revisions for select to authenticated using (exists(select 1 from user_answers a where a.id=answer_id and a.student_id=auth.uid()))';
  end if;
end $$;
