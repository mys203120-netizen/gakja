import 'server-only';
import {createClient} from '@supabase/supabase-js';
import {supabaseServer, type Profile} from './auth';
import {ApiError, pool, query, transaction} from './db';
import {readChatAttachment, removeLocalAccountAttachment, type ChatAttachmentRow} from './chat-attachments';
import {moveAccountDataToTrash, type DataPick, type DataRows} from './account-data-store';

type StoredFile = {provider:'supabase'|'local';bucket:string;path:string;table:string;row:Record<string,any>};
export function accountStoredFiles(rows:DataRows,studentId:string):StoredFile[] {
  const result:StoredFile[]=[];
  const push=(table:string,row:Record<string,any>,storage:Record<string,any>)=>{
    if(!storage||!['supabase','local'].includes(storage.provider))return;
    const bucket=String(storage.bucket||'student-chat-files'),path=String(storage.path||'');
    if(!['student-media','student-chat-files','content-imports'].includes(bucket)||!path.startsWith(studentId+'/')||path.includes('..')||path.includes('\\'))throw new ApiError(409,'파일 소유 정보를 확인하지 못했어요.');
    result.push({provider:storage.provider,bucket,path,table,row});
  };
  for(const table of ['media_assets','quiz_recordings'])for(const row of rows[table]||[])if(row.metadata?.provider==='supabase')push(table,row,row.metadata);
  for(const row of rows.chat_attachments||[])push('chat_attachments',row,row.storage);
  for(const row of rows.recording_uploads||[])for(const file of row.files||[])push('recording_uploads',row,{...file,provider:'supabase'});
  return [...new Map(result.map(file=>[file.provider+':'+file.bucket+':'+file.path,file])).values()];
}
export async function readAccountStoredFile(file:StoredFile,storage?:Awaited<ReturnType<typeof supabaseServer>>['storage']) {
  if(file.provider==='local')return readChatAttachment(file.row as ChatAttachmentRow);
  const client=storage||(await supabaseServer()).storage;
  const result=await client.from(file.bucket).download(file.path);
  if(result.error||!result.data)throw new ApiError(503,'원본 파일을 가져오지 못했어요. 백업을 다시 시도해 주세요.');
  return Buffer.from(await result.data.arrayBuffer());
}
export async function permanentlyDeleteAccountData(user:Profile,picks:DataPick[]) {
  const control=await pool.connect();let locked=false;
  try{
    locked=(await control.query('select pg_try_advisory_lock(hashtextextended($1,0)) as locked',['account-purge:'+user.id])).rows[0].locked;
    if(!locked)throw new ApiError(409,'다른 삭제를 마무리하고 있어요. 잠시 후 다시 시도해 주세요.');
    return await purgeAccountData(user,picks);
  }finally{
    let failure:Error|undefined;
    try{if(locked)await control.query('select pg_advisory_unlock(hashtextextended($1,0))',['account-purge:'+user.id]);}
    catch(error){failure=error as Error;}
    finally{control.release(failure);}
  }
}
async function purgeAccountData(user:Profile,picks:DataPick[]) {
  // Verify every requested record before entering a resumable purge. A failed provider
  // deletion leaves an explicit retryable entry and cannot offer a partial restoration.
  const entries=await transaction(async db=>{
    await db.query('select pg_advisory_xact_lock(hashtext($1))',['account-data:'+user.id]);
    const found=[];
    for(const pick of picks){
      let entry=(await db.query('select * from account_data_trash where id::text=$1 and student_id=$2 and type=$3 for update',[pick.id,user.id,pick.type])).rows[0];
      if(!entry&&pick.type==='thread'){
        const legacy=(await db.query('select id from chat_threads where id::text=$1 and student_id=$2 and deleted_at is not null for update',[pick.id,user.id])).rows[0];
        if(legacy){await db.query("update chat_messages set status='failed' where thread_id=$1 and student_id=$2 and status='pending' and created_at<now()-interval '2 minutes'",[legacy.id,user.id]);const receipts=await moveAccountDataToTrash(db,user,[pick]);entry=(await db.query('select * from account_data_trash where id=$1',[receipts[0].id])).rows[0];}
      }
      if(!entry)throw new ApiError(404,'휴지통의 자료를 찾을 수 없어요.');
      accountStoredFiles(entry.snapshot.rows,user.id);found.push(entry);
    }
    const remote=found.some(entry=>accountStoredFiles(entry.snapshot.rows,user.id).some(file=>file.provider==='supabase')||process.env.AUTH_MODE==='supabase'&&(entry.snapshot.rows.documents||[]).length>0);
    if(remote&&(!process.env.SUPABASE_SERVICE_ROLE_KEY||!process.env.NEXT_PUBLIC_SUPABASE_URL))throw new ApiError(503,'원본 파일을 삭제할 저장소 연결이 필요해요. 자료는 휴지통에 보관돼 있어요.');
    for(const entry of found)await db.query('update account_data_trash set purge_started_at=coalesce(purge_started_at,now()) where id=$1 and student_id=$2',[entry.id,user.id]);
    return found;
  });
  const remoteFiles=entries.flatMap(entry=>accountStoredFiles(entry.snapshot.rows,user.id)).filter(file=>file.provider==='supabase');
  const storage=remoteFiles.length?createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false,autoRefreshToken:false}}).storage:null;
  let count=0;const completed:{id:string;type:any;sourceId:string}[]=[];
  for(const entry of entries){
    try {
      for(const file of accountStoredFiles(entry.snapshot.rows,user.id)){
        const [shared]=await query(`select exists(select 1 from media_assets where student_id=$1 and metadata->>'path'=$2)
          or exists(select 1 from quiz_recordings where student_id=$1 and metadata->>'path'=$2)
          or exists(select 1 from chat_attachments where student_id=$1 and storage->>'path'=$2)
          or exists(select 1 from account_data_trash where student_id=$1 and id<>$3 and jsonb_path_exists(snapshot,'$.rows.*[*].**.path ? (@ == $path)',jsonb_build_object('path',$2::text))) as shared`,[user.id,file.path,entry.id]);
        if(shared?.shared)continue;
        if(file.provider==='local')await removeLocalAccountAttachment(file.row as ChatAttachmentRow);
        else {const result=await storage!.from(file.bucket).remove([file.path]);if(result.error)throw result.error;}
      }
      // Document originals are an immutable cache of the owned HTML included in this snapshot.
      if(process.env.AUTH_MODE==='supabase'&&(entry.snapshot.rows.documents||[]).length){
        if(!process.env.SUPABASE_SERVICE_ROLE_KEY||!process.env.NEXT_PUBLIC_SUPABASE_URL)throw new Error('Document storage unavailable');
        const documentStorage=storage||createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}).storage;
        for(const document of entry.snapshot.rows.documents){const result=await documentStorage.from('document-originals').remove([`${document.id}/${document.file_hash}.html`]);if(result.error)throw result.error;}
      }
      const removed=await transaction(async db=>{
        const deleted=await db.query('delete from account_data_trash where id=$1 and student_id=$2 and purge_started_at is not null returning id',[entry.id,user.id]);
        if(deleted.rowCount){
          for(const [table,rows]of Object.entries(entry.snapshot.rows) as [string,Record<string,any>[]][])for(const row of rows)if(row.id)await db.query('insert into account_data_tombstones(student_id,table_name,row_id) values($1,$2,$3) on conflict do nothing',[user.id,table,String(row.id)]);
          await db.query('insert into audit_logs(actor_id,student_id,action,data) values($1,$1,$2,$3)',[user.id,'account.data.permanently_deleted',JSON.stringify({type:entry.type,count:entry.related_count+1,trashId:entry.id})]);
        }
        return !!deleted.rowCount;
      });
      if(removed){count++;completed.push({id:entry.id,type:entry.type,sourceId:entry.root_id});}
    }catch{return {ok:false,partial:true,count,items:completed,error:'일부 원본 파일의 삭제를 마무리하지 못했어요. 남은 항목의 영구 삭제를 다시 눌러 주세요.'};}
  }
  return {ok:true,count,items:completed};
}
