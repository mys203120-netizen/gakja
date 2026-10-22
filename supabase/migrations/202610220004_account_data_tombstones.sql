-- Only opaque identifiers survive an explicit permanent deletion, so delayed
-- autosaves on another device cannot recreate the deleted personal content.
create table account_data_tombstones (
 student_id uuid not null references profiles(id), table_name text not null, row_id text not null,
 deleted_at timestamptz not null default now(), primary key(student_id,table_name,row_id)
);
alter table account_data_tombstones enable row level security;
revoke all on account_data_tombstones from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then revoke all on account_data_tombstones from anon; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then revoke all on account_data_tombstones from authenticated; end if;
end $$;
create or replace function reject_trashed_account_record() returns trigger language plpgsql as $$
declare owner text; record_id text; blocked boolean;
begin
 owner=to_jsonb(new)->>'student_id'; record_id=to_jsonb(new)->>'id';
 if owner is null or record_id is null or current_setting('gakja.data_restore',true)=owner then return new; end if;
 execute format('select exists(select 1 from %I.account_data_tombstones where student_id=$1::uuid and table_name=$2 and row_id=$3)',tg_table_schema)
 into blocked using owner,tg_table_name,record_id;
 if blocked then raise exception using errcode='P0001',message='삭제한 항목이에요. 새 항목으로 작성해 주세요.'; end if;
 execute format('select exists(select 1 from %I.account_data_trash where student_id=$1::uuid and ((root_table=$2 and root_id=$3) or exists(select 1 from jsonb_array_elements(coalesce(snapshot->''rows''->$2,''[]''::jsonb)) r where r->>''id''=$3)))',tg_table_schema)
 into blocked using owner,tg_table_name,record_id;
 if blocked then raise exception using errcode='P0001',message='휴지통에 있는 항목이에요. 복원한 뒤 이어서 작성해 주세요.'; end if;
 return new;
end $$;
