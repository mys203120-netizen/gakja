-- Server-issued, immutable upload destinations. No client writes to this table.
create table public.recording_uploads (
  id uuid primary key, student_id uuid not null references public.profiles(id),
  kind text not null check (kind in ('interview','quiz','attachment','guidebook')),
  fields jsonb not null, files jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes',
  locked_at timestamptz, cleanup_checked_at timestamptz
);
create index recording_uploads_student_created on public.recording_uploads(student_id,created_at);
alter table public.recording_uploads enable row level security;

do $$
declare t record;
begin
  if to_regprocedure('auth.uid()') is null then return; end if;
  -- Profiles must not look themselves up through RLS (infinite recursion).
  execute 'create policy active_profile_gate on public.profiles as restrictive for all to authenticated using (active) with check (active)';
  -- AND with existing ownership/publication rules, never OR with them.
  for t in select tablename from pg_tables where schemaname='public' and rowsecurity and tablename <> 'profiles' loop
    execute format('create policy active_account_gate on public.%I as restrictive for all to authenticated using (exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.active)) with check (exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.active))',t.tablename);
  end loop;
  execute 'grant select on public.profiles, public.recording_uploads to authenticated';
  execute 'create policy own_upload_read on public.recording_uploads for select to authenticated using (student_id=(select auth.uid()))';
  if to_regclass('storage.objects') is null then return; end if;
  execute 'create policy active_account_gate on storage.objects as restrictive for all to authenticated using (exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.active)) with check (exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.active))';
  -- Recordings cannot be replaced after validation, including delete + insert.
  execute 'drop policy if exists student_media_upload on storage.objects';
  execute 'drop policy if exists student_media_delete on storage.objects';
  execute 'drop policy if exists student_chat_files_upload on storage.objects';
  execute $policy$create policy student_media_upload on storage.objects for insert to authenticated with check (
    bucket_id in ('student-media','student-chat-files','content-imports') and (storage.foldername(name))[1]=(select auth.uid())::text
    and exists(select 1 from public.recording_uploads u, jsonb_array_elements(u.files) f
      where u.student_id=(select auth.uid()) and u.expires_at>now() and u.locked_at is null
        and f->>'path'=name and f->>'bucket'=bucket_id)
  )$policy$;
  execute $policy$create policy immutable_recordings_update on storage.objects as restrictive for update to authenticated using (bucket_id not in ('student-media','content-imports') and not (bucket_id='student-chat-files' and (storage.foldername(name))[2]='uploads')) with check (bucket_id not in ('student-media','content-imports') and not (bucket_id='student-chat-files' and (storage.foldername(name))[2]='uploads'))$policy$;
  execute $policy$create policy immutable_recordings_delete on storage.objects as restrictive for delete to authenticated using (bucket_id not in ('student-media','content-imports') and not (bucket_id='student-chat-files' and (storage.foldername(name))[2]='uploads'))$policy$;
  execute $bucket$insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('content-imports','content-imports',false,5242880,array['text/html']) on conflict(id) do update set public=false,file_size_limit=5242880,allowed_mime_types=array['text/html']$bucket$;
  execute $policy$create policy own_content_import_read on storage.objects for select to authenticated using (bucket_id='content-imports' and (storage.foldername(name))[1]=(select auth.uid())::text)$policy$;
  execute $bucket$update storage.buckets set public=false,file_size_limit=20971520,
    allowed_mime_types=array['video/webm','video/mp4','audio/webm','audio/mp4','audio/mpeg','audio/wav','audio/x-wav','audio/ogg'] where id='student-media'$bucket$;
  execute $bucket$update storage.buckets set public=false,file_size_limit=15728640,
    allowed_mime_types=array['text/plain','text/markdown','application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/png','image/jpeg','image/webp','image/gif'] where id='student-chat-files'$bucket$;
end $$;
