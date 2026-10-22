-- Recoverable user-initiated removal. No existing records are changed by this migration.
create table account_data_trash (
 id uuid primary key default gen_random_uuid(), student_id uuid not null references profiles(id),
 type text not null, root_table text not null, root_id text not null, title text not null,
 school_id text, snapshot jsonb not null, related_count integer not null default 0,
 original_created_at timestamptz not null, created_at timestamptz not null default now(),
 purge_started_at timestamptz
);
create index account_data_trash_owner on account_data_trash(student_id,created_at desc,id);
create index account_data_trash_root on account_data_trash(student_id,root_table,root_id);
-- Keep recordings as bytea instead of expanding them into enormous JSON snapshots.
create table account_data_blobs (
 trash_id uuid not null references account_data_trash(id) on delete cascade,
 table_name text not null, row_id text not null, data bytea not null,
 primary key(trash_id,table_name,row_id)
);
create table account_device_sessions (
 id uuid primary key default gen_random_uuid(), student_id uuid not null references profiles(id),
 session_key text not null, label text not null,
 created_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
 expires_at timestamptz not null, revoked_at timestamptz,
 unique(student_id,session_key)
);
create index account_device_sessions_owner on account_device_sessions(student_id,last_seen_at desc);
create table account_data_requests (
 id uuid primary key default gen_random_uuid(), student_id uuid not null references profiles(id),
 type text not null check(type in ('all_data','account')),
 status text not null default 'requested' check(status in ('requested','processing','completed','cancelled')),
 detail text not null default '접수했어요. 운영팀이 본인 확인과 삭제 범위를 확인한 뒤 처리해요.',
 inquiry_id uuid references support_inquiries(id), created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create unique index account_data_request_pending on account_data_requests(student_id,type) where status in ('requested','processing');
do $$ declare t text; begin
 foreach t in array array['account_data_trash','account_data_blobs','account_device_sessions','account_data_requests'] loop
  execute format('alter table %I enable row level security',t);
  execute format('revoke all on %I from public',t);
  if exists(select 1 from pg_roles where rolname='anon') then execute format('revoke all on %I from anon',t); end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then execute format('revoke all on %I from authenticated',t); end if;
 end loop;
end $$;
-- A delayed autosave from another tab must not recreate an item while it is in the trash.
create function reject_trashed_account_record() returns trigger language plpgsql as $$
declare owner text; record_id text; blocked boolean;
begin
 owner=to_jsonb(new)->>'student_id'; record_id=to_jsonb(new)->>'id';
 if owner is null or record_id is null or current_setting('gakja.data_restore',true)=owner then return new; end if;
 execute format('select exists(select 1 from %I.account_data_trash where student_id=$1::uuid and ((root_table=$2 and root_id=$3) or exists(select 1 from jsonb_array_elements(coalesce(snapshot->''rows''->$2,''[]''::jsonb)) r where r->>''id''=$3)))',tg_table_schema)
 into blocked using owner,tg_table_name,record_id;
 if blocked then raise exception using errcode='P0001',message='휴지통에 있는 항목이에요. 복원한 뒤 이어서 작성해 주세요.'; end if;
 return new;
end $$;
do $$ declare t text; begin
 foreach t in array array['experience_cards','experience_card_drafts','user_answers','chat_threads','interview_sessions','interview_reports','media_assets','chat_attachments','documents','quiz_sessions','quiz_recordings','study_sessions','memory_attempts','briefing_thoughts','department_news_thoughts','knowledge_bite_progress','student_confirmations','student_plans','quiz_assignments','support_targets'] loop
  execute format('create trigger account_trash_autosave_guard before insert on %I for each row execute function reject_trashed_account_record()',t);
 end loop;
end $$;
