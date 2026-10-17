-- Only the server may write/read originals; authorized routes issue 60-second URLs.
do $$ begin
  if to_regclass('storage.buckets') is null then return; end if;
  insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('document-originals','document-originals',false,5242880,array['text/html'])
  on conflict(id) do update set public=false,file_size_limit=5242880,allowed_mime_types=array['text/html'];
  create policy server_only_document_originals on storage.objects as restrictive
    for all to authenticated using (bucket_id <> 'document-originals') with check (bucket_id <> 'document-originals');
end $$;
