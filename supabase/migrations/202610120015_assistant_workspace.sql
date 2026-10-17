-- Conversations and their original learning context survive archive/delete actions.
alter table chat_threads add column if not exists archived_at timestamptz;
alter table chat_threads add column if not exists deleted_at timestamptz;
create index if not exists chat_threads_workspace_idx on chat_threads(student_id,archived_at,updated_at desc) where deleted_at is null;

create table if not exists chat_attachments (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references profiles(id),
  thread_id uuid references chat_threads(id) on delete cascade,
  message_id uuid references chat_messages(id) on delete cascade,
  name text not null check(length(name) between 1 and 180),
  mime text not null,
  kind text not null check(kind in ('text','image','pdf')),
  size integer not null check(size between 1 and 15728640),
  extracted_text text,
  storage jsonb not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  check ((thread_id is null) = (message_id is null))
);
create index if not exists chat_attachments_student_idx on chat_attachments(student_id,created_at desc);
create index if not exists chat_attachments_message_idx on chat_attachments(message_id) where deleted_at is null;
alter table chat_attachments enable row level security;

do $$ begin
  if to_regprocedure('auth.uid()') is not null then
    execute 'create policy own_student_read on chat_attachments for select to authenticated using (student_id=auth.uid())';
  end if;
  if to_regclass('storage.buckets') is not null and to_regprocedure('auth.uid()') is not null then
    execute 'insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values(''student-chat-files'',''student-chat-files'',false,15728640,array[''application/pdf'',''application/vnd.openxmlformats-officedocument.wordprocessingml.document'',''text/plain'',''text/markdown'',''image/png'',''image/jpeg'',''image/webp'',''image/gif'']) on conflict(id) do update set public=false,file_size_limit=15728640';
    execute 'create policy student_chat_files_read on storage.objects for select to authenticated using (bucket_id=''student-chat-files'' and (storage.foldername(name))[1]=auth.uid()::text)';
    execute 'create policy student_chat_files_upload on storage.objects for insert to authenticated with check (bucket_id=''student-chat-files'' and (storage.foldername(name))[1]=auth.uid()::text)';
    execute 'create policy student_chat_files_delete on storage.objects for delete to authenticated using (bucket_id=''student-chat-files'' and (storage.foldername(name))[1]=auth.uid()::text)';
  end if;
end $$;
