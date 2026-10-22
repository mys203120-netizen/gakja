import 'server-only';
import type {PoolClient} from 'pg';
import {supabaseServer, type Profile} from './auth';
import {ApiError, pool} from './db';
import {accountStoredFiles, readAccountStoredFile} from './account-data-files';
import {dataMetadata, type DataRows} from './account-data-store';
import {readableReportArticle,readableReportHeader,readableReportSection} from './account-readable-report';

const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
const excluded=new Set(['account_device_sessions','account_session_revocations','account_data_trash','student_read_models','student_learning_revisions']);
const binaryTables=new Set(['media_assets','quiz_recordings']);
type Source={name:string;from:string;owner:string;columns:string;primary:string[]};
async function* sourceRows(db:PoolClient,source:Source,index:number,userId:string) {
  const cursor=quote('account_export_'+index);
  await db.query(`declare ${cursor} no scroll cursor for select ${source.columns} as row from ${source.from} where ${source.owner}=$1 ${source.primary.length?'order by '+source.primary.map(column=>'r.'+quote(column)).join(','):''}`,[userId]);
  try{for(;;){const batch=(await db.query(`fetch forward 20 from ${cursor}`)).rows;if(!batch.length)break;for(const item of batch)yield item.row as Record<string,any>;}}
  finally{await db.query('close '+cursor);}
}
/** A consistent, unbounded export. Cursors and one-at-a-time files bound process memory. */
export async function accountDataBackup(user:Profile,format:'json'|'html') {
  const db=await pool.connect(),encoder=new TextEncoder();let closed=false;
  const close=async(success:boolean)=>{if(closed)return;closed=true;try{await db.query(success?'commit':'rollback');}finally{db.release();}};
  try {
    await db.query('begin isolation level repeatable read read only');
    const meta=await dataMetadata(db),schema=quote(meta.schema),profile=(await db.query('select id,email,name,role,created_at from profiles where id=$1',[user.id])).rows[0];
    const sources:Source[]=[];
    for(const info of meta.tables.values()){
      if(!info.owned||excluded.has(info.name))continue;
      const columns=info.columns.filter(column=>!info.binary.includes(column));
      sources.push({name:info.name,from:`${schema}.${quote(info.name)} r`,owner:'r.student_id',columns:'jsonb_build_object('+columns.flatMap(column=>["'"+column+"'",'r.'+quote(column)]).join(',')+')',primary:info.primary});
    }
    for(const [name,parent,column]of [['answer_revisions','user_answers','answer_id'],['content_versions','content_packages','package_id']])sources.push({name,from:`${schema}.${quote(name)} r join ${schema}.${quote(parent)} p on p.id=r.${quote(column)}`,owner:'p.student_id',columns:'to_jsonb(r)',primary:meta.tables.get(name)?.primary||[]});
    const identity=meta.tables.get('social_identities');if(identity)sources.push({name:'social_identities',from:`${schema}.social_identities r`,owner:'r.user_id',columns:'to_jsonb(r)',primary:identity.primary});
    sources.sort((a,b)=>a.name.localeCompare(b.name));
    // Capture a cookie-backed Storage client before yielding the response; stream pulls
    // do not create an additional authentication boundary or rely on public URLs.
    const storage=process.env.AUTH_MODE==='supabase'?(await supabaseServer()).storage:undefined;
    const exportedAt=new Date().toISOString();
    async function* generate(){
      if(format==='html')yield readableReportHeader(user,exportedAt);
      else yield JSON.stringify({format:'gakjaon-full-backup',version:1,exportedAt,profile}).slice(0,-1)+',"records":{';
      let firstSource=true;
      for(let index=0;index<sources.length;index++){
        const source=sources[index];
        if(format!=='html'){yield (firstSource?'':',')+JSON.stringify(source.name)+':[';firstSource=false;}
        let first=true,rendered=false;
        for await(const row of sourceRows(db,source,index,user.id)){
          if(format==='html'){const article=readableReportArticle(source.name,row);if(article){if(!rendered){yield readableReportSection(source.name);rendered=true;}yield article;}}
          else {yield (first?'':',')+JSON.stringify(row);first=false;}
        }
        yield format==='html'?(rendered?'</section>':''):']';
      }
      if(format==='html'){yield '</body></html>';return;}
      yield '},"trash":[';let firstTrash=true;
      const trashSource:Source={name:'trash',from:`${schema}.account_data_trash r`,owner:'r.student_id',columns:'to_jsonb(r)',primary:['created_at','id']};
      for await(const row of sourceRows(db,trashSource,sources.length,user.id)){yield (firstTrash?'':',')+JSON.stringify(row);firstTrash=false;}
      yield '],"files":[';let firstFile=true;const stored=new Set<string>();
      const file=async function*(row:Record<string,any>,table:string,trashId?:string){
        if(binaryTables.has(table)){
          const result=trashId?(await db.query('select data from account_data_blobs where trash_id=$1 and table_name=$2 and row_id=$3',[trashId,table,String(row.id)])).rows[0]:(await db.query(`select data from ${schema}.${quote(table)} where id=$1 and student_id=$2`,[row.id,user.id])).rows[0];
          if(!result)throw new ApiError(409,'백업 중 원본 파일을 찾지 못했어요. 다시 시도해 주세요.');
          const bytes=result.data as Buffer;
          if(bytes.length){yield {table,id:row.id,trashId:trashId||null,name:table+'-'+row.id,mime:row.mime,encoding:'base64',data:bytes.toString('base64')};}
        }
        for(const storedFile of accountStoredFiles({[table]:[row]},user.id)){
          const key=storedFile.provider+':'+storedFile.bucket+':'+storedFile.path;if(stored.has(key))continue;stored.add(key);
          let bytes:Buffer;
          try{bytes=await readAccountStoredFile(storedFile,storage);}
          catch(error){
            // An upload intent can exist before bytes have arrived at Storage.
            // Saved media/attachments always fail the export if their originals are missing.
            if(table!=='recording_uploads')throw error;
            yield {table,id:row.id,trashId:trashId||null,name:storedFile.path.split('/').at(-1),bucket:storedFile.bucket,path:storedFile.path,status:'upload_not_available',note:'완료되지 않았거나 만료된 업로드 요청이에요. 저장된 녹음과 첨부 원본은 별도 파일 항목에 포함돼요.'};
            continue;
          }
          yield {table,id:row.id,trashId:trashId||null,name:row.name||storedFile.path.split('/').at(-1),mime:row.mime||'application/octet-stream',provider:storedFile.provider,bucket:storedFile.bucket,path:storedFile.path,encoding:'base64',data:bytes.toString('base64')};
        }
      };
      for(let index=0;index<sources.length;index++){
        const source=sources[index];if(!['media_assets','quiz_recordings','chat_attachments','recording_uploads'].includes(source.name))continue;
        for await(const row of sourceRows(db,source,index+100,user.id))for await(const item of file(row,source.name)){yield (firstFile?'':',')+JSON.stringify(item);firstFile=false;}
      }
      for await(const trash of sourceRows(db,trashSource,sources.length+200,user.id))for(const [table,rows]of Object.entries(trash.snapshot?.rows||{}) as [string,Record<string,any>[]][])for(const row of rows)for await(const item of file(row,table,trash.id)){yield (firstFile?'':',')+JSON.stringify(item);firstFile=false;}
      yield ']}';
    }
    const iterator=generate();
    const stream=new ReadableStream<Uint8Array>({
      async pull(controller){try{const next=await iterator.next();if(next.done){await close(true);controller.close();}else controller.enqueue(encoder.encode(next.value));}catch(error){await close(false);controller.error(error);}},
      async cancel(){try{await iterator.return(undefined);}finally{await close(false);}},
    });
    return new Response(stream,{headers:{'Content-Type':format==='html'?'text/html; charset=utf-8':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="gakjaon-full-backup-${exportedAt.slice(0,10)}.${format}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; sandbox"}});
  }catch(error){await close(false);throw error;}
}
