import 'server-only';
import {createHash, randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import type {Profile} from './auth';
import {ApiError, query, transaction} from './db';
import {ACCOUNT_DATA_TYPES, type AccountDataItem, type AccountDataReceipt, type AccountDataType} from './account-data-model';
import {deviceSessions} from './account-device-sessions';
import {studySummary} from './study-sessions';
import {PRIVACY_POLICY_VERSION} from './privacy-policy';
import {supportConfig} from './support-config';

export const DATA_TABLES = {
  experience:'experience_cards', draft:'experience_card_drafts', answer:'user_answers', thread:'chat_threads',
  interview:'interview_sessions', report:'interview_reports', media:'media_assets', attachment:'chat_attachments',
  document:'documents', quiz:'quiz_sessions', quiz_recording:'quiz_recordings', study:'study_sessions', memory:'memory_attempts',
  thought:'briefing_thoughts', news:'department_news_thoughts', knowledge:'knowledge_bite_progress',
  confirmation:'student_confirmations', plan:'student_plans', assignment:'quiz_assignments', school:'support_targets',
} as const;
const descendants = ['answer_revisions','answer_comments','chat_messages','interview_turns','quiz_responses','quiz_submissions','quiz_assignment_events','study_session_tabs','study_session_events','study_imported_events','briefing_thought_revisions','department_news_thought_revisions','knowledge_bite_revisions','fact_confirmation_events','school_profiles','speech_analysis_versions','recording_uploads','learning_requests','audit_logs'];
const allowedTables = new Set<string>([...Object.values(DATA_TABLES),...descendants]);
export type DataRows = Record<string, Record<string,any>[]>;
type Snapshot = {version:1; rows:DataRows; reportEvents:Record<string,any[]>};
type TableInfo = {name:string; columns:string[]; primary:string[]; binary:string[]; owned:boolean};
type ForeignKey = {parent:string; child:string; parentColumns:string[]; childColumns:string[]};
type Metadata = {schema:string; tables:Map<string,TableInfo>; keys:ForeignKey[]};
const ident = (value:string) => '"'+value.replaceAll('"','""')+'"';
const tableSql = (meta:Metadata,name:string) => ident(meta.schema)+'.'+ident(name);
const pickSchema = z.object({id:z.string().min(1).max(160),type:z.enum(Object.keys(DATA_TABLES) as [AccountDataType,...AccountDataType[]])}).strict();
export const accountDataMutationSchema = z.discriminatedUnion('action',[
  z.object({action:z.enum(['trash','restore','delete']),items:z.array(pickSchema).min(1).max(50),confirmation:z.string().max(254).optional()}).strict(),
  z.object({action:z.literal('request_delete'),scope:z.enum(['all_data','account']),confirmation:z.string().max(254)}).strict(),
  z.object({action:z.literal('cancel_request'),requestId:z.string().uuid()}).strict(),
  z.object({action:z.literal('revoke_sessions'),scope:z.literal('others')}).strict(),
]);
export type DataPick = z.infer<typeof pickSchema>;
export function confirmAccountEmail(user:Profile,value?:string) {
  if (!value || value.trim().toLowerCase()!==user.email.toLowerCase()) throw new ApiError(400,'가입한 이메일을 정확히 입력해 주세요.');
}
export async function dataMetadata(db:PoolClient):Promise<Metadata> {
  const schema=(await db.query('select current_schema() as schema')).rows[0].schema as string;
  const rows=(await db.query(`select c.relname as name,a.attname as column,a.atttypid='bytea'::regtype as binary,
    coalesce((select array_agg(x.attname::text order by k.ordinality) from pg_index i cross join lateral unnest(i.indkey) with ordinality k(attnum,ordinality)
    join pg_attribute x on x.attrelid=c.oid and x.attnum=k.attnum where i.indrelid=c.oid and i.indisprimary),'{}') as primary
    from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid
    where n.nspname=$1 and c.relkind='r' and a.attnum>0 and not a.attisdropped and a.attgenerated='' order by c.relname,a.attnum`,[schema])).rows;
  const tables=new Map<string,TableInfo>();
  for(const row of rows){let info=tables.get(row.name);if(!info){info={name:row.name,columns:[],binary:[],primary:row.primary,owned:false};tables.set(row.name,info);}info.columns.push(row.column);if(row.binary)info.binary.push(row.column);if(row.column==='student_id')info.owned=true;}
  const keys=(await db.query(`select p.relname as parent,c.relname as child,
    array_agg(pa.attname::text order by k.ordinality) as "parentColumns",array_agg(ca.attname::text order by k.ordinality) as "childColumns"
    from pg_constraint f join pg_class c on c.oid=f.conrelid join pg_class p on p.oid=f.confrelid
    join pg_namespace n on n.oid=c.relnamespace cross join lateral unnest(f.conkey,f.confkey) with ordinality k(childkey,parentkey,ordinality)
    join pg_attribute ca on ca.attrelid=c.oid and ca.attnum=k.childkey join pg_attribute pa on pa.attrelid=p.oid and pa.attnum=k.parentkey
    where f.contype='f' and n.nspname=$1 group by f.oid,p.relname,c.relname`,[schema])).rows as ForeignKey[];
  return {schema,tables,keys};
}
function rowExpression(info:TableInfo,alias:string) {
  return 'jsonb_build_object('+info.columns.filter(column=>!info.binary.includes(column)).flatMap(column=>["'"+column+"'",alias+'.'+ident(column)]).join(',')+')';
}
const rowKey=(info:TableInfo,row:Record<string,any>)=>JSON.stringify(info.primary.map(key=>row[key]));
async function lockData(db:PoolClient,studentId:string) {
  await db.query("set local lock_timeout='1500ms'");
  await db.query('select pg_advisory_xact_lock(hashtext($1))',['account-data:'+studentId]);
  // Share each feature's mutation lock so a queued autosave cannot overtake the removal.
  const armory=(await db.query('select pg_try_advisory_xact_lock(hashtext($1)) as locked',['armory:'+studentId])).rows[0];
  const study=(await db.query('select pg_try_advisory_xact_lock(hashtextextended($1,0)) as locked',['study-session:'+studentId])).rows[0];
  if(!armory.locked||!study.locked)throw new ApiError(409,'다른 화면에서 자료를 저장하고 있어요. 저장이 끝난 뒤 다시 정리해 주세요.');
}
async function graphSnapshot(db:PoolClient,meta:Metadata,studentId:string,table:string,id:string):Promise<Snapshot|null> {
  const rows:DataRows={},seen=new Map<string,Set<string>>(),queue:string[]=[];
  const add=(name:string,items:Record<string,any>[])=>{const info=meta.tables.get(name)!;let changed=false;const known=seen.get(name)||new Set<string>();seen.set(name,known);for(const row of items){const key=rowKey(info,row);if(known.has(key))continue;if(info.owned&&row.student_id!==studentId)throw new ApiError(403,'본인 자료만 정리할 수 있어요.');known.add(key);(rows[name]??=[]).push(row);changed=true;}if(changed&&!queue.includes(name))queue.push(name);};
  const select=async(name:string,condition:string,params:unknown[])=>{
    const info=meta.tables.get(name);if(!info||!allowedTables.has(name))return [];
    const selected=(await db.query(`select ${rowExpression(info,'r')} as row from ${tableSql(meta,name)} r where ${info.owned?'r.student_id=$1 and ':''}(${condition}) for update nowait`,params)).rows.map(item=>item.row);
    add(name,selected);return selected;
  };
  if(!(await select(table,'r.id::text=$2',[studentId,id])).length)return null;
  while(queue.length){
    const parent=queue.shift()!,selected=rows[parent];
    for(const key of meta.keys.filter(key=>key.parent===parent&&allowedTables.has(key.child))){
      const info=meta.tables.get(key.child)!;
      if(!info.primary.length)throw new ApiError(409,'연결 자료의 복원 기준을 확인해 주세요.');
      const matching=(await db.query(`select ${rowExpression(info,'r')} as row from ${tableSql(meta,key.child)} r
        join jsonb_populate_recordset(null::${tableSql(meta,parent)},$2::jsonb) p on ${key.childColumns.map((column,index)=>'r.'+ident(column)+'=p.'+ident(key.parentColumns[index])).join(' and ')}
        where ${info.owned?'r.student_id=$1':'$1::uuid is not null'} for update of r nowait`,[studentId,JSON.stringify(selected)])).rows.map(item=>item.row);
      add(key.child,matching);
    }
    const ids=selected.map(row=>String(row.id)).filter(id=>id!=='undefined');
    if(ids.length&&parent!=='learning_requests')await select('learning_requests',"exists(select 1 from jsonb_path_query(r.result,'$.**') value where jsonb_typeof(value)='string' and value#>>'{}'=any($2::text[]))",[studentId,ids]);
    if(ids.length&&parent!=='audit_logs')await select('audit_logs',"exists(select 1 from jsonb_path_query(r.data,'$.**') value where jsonb_typeof(value)='string' and value#>>'{}'=any($2::text[]))",[studentId,ids]);
    if(parent==='experience_cards')await select('experience_card_drafts','r.id::text=any($2::text[])',[studentId,ids]);
    if(parent==='media_assets'){
      const linked=[...new Set(selected.flatMap(row=>[row.metadata?.analysisMediaId,row.metadata?.analysisFor]).filter(Boolean))];
      if(linked.length)await select('media_assets','r.id::text=any($2::text[])',[studentId,linked]);
    }
    if(['media_assets','quiz_recordings'].includes(parent))await select('speech_analysis_versions','r.recording_id::text=any($2::text[])',[studentId,ids]);
    const eventKind:Record<string,string>={interview_turns:'interview_answer',quiz_responses:'quiz_response',quiz_submissions:'assignment_submission',memory_attempts:'memory_review'};
    if(eventKind[parent])for(const events of ['study_session_events','study_imported_events'])await select(events,'r.kind=$3 and r.source_id=any($2::text[])',[studentId,ids,eventKind[parent]]);
    if(parent==='knowledge_bite_progress')for(const events of ['study_session_events','study_imported_events'])await select(events,"r.kind='knowledge_progress' and split_part(r.source_id,':',1)=any($2::text[])",[studentId,ids]);
    if(parent==='quiz_sessions')await select('memory_attempts',"r.data->>'quiz_session_id'=any($2::text[])",[studentId,ids]);
    if(parent==='quiz_assignments')await select('memory_attempts',"r.data->>'assignment_id'=any($2::text[])",[studentId,ids]);
    if(['media_assets','quiz_recordings','chat_attachments'].includes(parent)){
      const paths=selected.map(row=>row.storage?.path||row.metadata?.path).filter(Boolean);
      if(paths.length)await select('recording_uploads',"exists(select 1 from jsonb_array_elements(r.files) f where f->>'path'=any($2::text[]))",[studentId,paths]);
    }
    if(Object.values(rows).reduce((sum,items)=>sum+items.length,0)>25000)throw new ApiError(413,'연결된 자료가 많아요. 항목을 나누어 정리해 주세요.');
  }
  for(const session of rows.interview_sessions||[])if(session.state==='active')throw new ApiError(409,'진행 중인 면접을 종료한 뒤 휴지통으로 옮겨 주세요.');
  for(const session of rows.quiz_sessions||[])if(session.state==='active')throw new ApiError(409,'진행 중인 연습을 종료한 뒤 휴지통으로 옮겨 주세요.');
  for(const session of rows.study_sessions||[])if(session.state==='active')throw new ApiError(409,'오늘 학습을 마친 뒤 리포트를 정리해 주세요.');
  if((rows.chat_messages||[]).some(row=>row.status==='pending'))throw new ApiError(409,'AI 답변이 끝난 뒤 대화를 정리해 주세요.');
  const interviewIds=[...new Set((rows.media_assets||[]).map(row=>row.session_id).filter(Boolean))],quizIds=[...new Set((rows.quiz_recordings||[]).map(row=>row.session_id).filter(Boolean))];
  if(interviewIds.length&&(await db.query("select 1 from interview_sessions where student_id=$1 and id=any($2::uuid[]) and state='active' limit 1",[studentId,interviewIds])).rows.length)throw new ApiError(409,'진행 중인 면접을 종료한 뒤 녹음을 정리해 주세요.');
  if(quizIds.length&&(await db.query("select 1 from quiz_sessions where student_id=$1 and id=any($2::uuid[]) and state='active' limit 1",[studentId,quizIds])).rows.length)throw new ApiError(409,'진행 중인 연습을 종료한 뒤 녹음을 정리해 주세요.');
  const attachmentThreads=[...new Set((rows.chat_attachments||[]).map(row=>row.thread_id).filter(Boolean))];
  if(attachmentThreads.length&&(await db.query("select 1 from chat_messages where student_id=$1 and thread_id=any($2::uuid[]) and status='pending' limit 1",[studentId,attachmentThreads])).rows.length)throw new ApiError(409,'AI 답변이 끝난 뒤 첨부 자료를 정리해 주세요.');
  const reportEvents:Record<string,any[]>={};
  const removedEvents=rows.study_session_events||[],sessionIds=[...new Set(removedEvents.map(row=>row.session_id))].filter(id=>!(rows.study_sessions||[]).some(row=>row.id===id));
  if(sessionIds.length){
    const reports=(await db.query("select id,report from study_sessions where student_id=$1 and id=any($2::uuid[]) and state='finalized' for update nowait",[studentId,sessionIds])).rows;
    const removedIds=new Set(removedEvents.map(row=>row.id));
    for(const report of reports){const events=Array.isArray(report.report?.events)?report.report.events:[],removed=events.filter((event:any)=>removedIds.has(event.id));if(removed.length){reportEvents[report.id]=removed;const kept=events.filter((event:any)=>!removedIds.has(event.id));await db.query('update study_sessions set report=$3::jsonb where id=$1 and student_id=$2',[report.id,studentId,JSON.stringify({...studySummary(kept),events:kept})]);}}
  }
  return {version:1,rows,reportEvents};
}
function tableOrder(meta:Metadata,names:string[]) {
  const pending=new Set(names),result:string[]=[];
  while(pending.size){const ready=[...pending].filter(name=>!meta.keys.some(key=>key.child===name&&key.parent!==name&&pending.has(key.parent)));
    if(!ready.length)throw new ApiError(409,'연결 자료를 안전하게 정리하지 못했어요.');for(const name of ready){pending.delete(name);result.push(name);}}
  return result;
}
async function removeSnapshotRows(db:PoolClient,meta:Metadata,snapshot:Snapshot) {
  for(const name of tableOrder(meta,Object.keys(snapshot.rows)).reverse()){
    const info=meta.tables.get(name)!;
    await db.query(`delete from ${tableSql(meta,name)} r using jsonb_populate_recordset(null::${tableSql(meta,name)},$1::jsonb) p where ${info.primary.map(column=>'r.'+ident(column)+'=p.'+ident(column)).join(' and ')}`,[JSON.stringify(snapshot.rows[name])]);
  }
}
const titleOf=(type:AccountDataType,row:Record<string,any>)=>String(row.title||row.data?.title||(type==='school'?(row.data?.university||row.data?.university_name||row.data?.name):'')||ACCOUNT_DATA_TYPES[type]).slice(0,200);
function createdOf(row:Record<string,any>){return row.created_at||row.started_at||row.updated_at||new Date().toISOString();}
function schoolOf(row:Record<string,any>){return row.target_id||row.metadata?.targetId||row.snapshot?.targetId||row.target?.targetId||row.data?.context?.targetId||null;}
export async function moveAccountDataToTrash(db:PoolClient,user:Profile,picks:DataPick[]):Promise<AccountDataReceipt[]> {
  await lockData(db,user.id);const meta=await dataMetadata(db),receipts:AccountDataReceipt[]=[];
  // Validate every requested owner before changing a single row. Overlapping selections are folded into their parent snapshot.
  for(const pick of picks){const [owned]=(await db.query(`select id from ${tableSql(meta,DATA_TABLES[pick.type])} where id::text=$1 and student_id=$2`,[pick.id,user.id])).rows;if(!owned)throw new ApiError(404,'정리할 자료를 찾을 수 없어요. 목록을 새로 불러와 주세요.');}
  const priority=(pick:DataPick)=>({school:0,interview:1,quiz:1,thread:1,experience:1,study:1,report:2,assignment:3} as Record<string,number>)[pick.type]??4;
  for(const pick of [...picks].sort((a,b)=>priority(a)-priority(b))){
    const table=DATA_TABLES[pick.type],snapshot=await graphSnapshot(db,meta,user.id,table,pick.id);if(!snapshot)continue;
    const root=snapshot.rows[table].find(row=>String(row.id)===pick.id)!,trashId=randomUUID(),count=Object.values(snapshot.rows).reduce((sum,items)=>sum+items.length,0)-1;
    await db.query('insert into account_data_trash(id,student_id,type,root_table,root_id,title,school_id,snapshot,related_count,original_created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[trashId,user.id,pick.type,table,pick.id,titleOf(pick.type,root),schoolOf(root),JSON.stringify(snapshot),count,createdOf(root)]);
    for(const [name,items]of Object.entries(snapshot.rows)){
      const info=meta.tables.get(name)!;if(info.binary.length){
        if(info.binary.length!==1||!info.columns.includes('id'))throw new ApiError(409,'파일 복원 형식을 확인해 주세요.');
        await db.query(`insert into account_data_blobs(trash_id,table_name,row_id,data) select $1,$2,r.id::text,r.${ident(info.binary[0])} from ${tableSql(meta,name)} r join jsonb_populate_recordset(null::${tableSql(meta,name)},$3::jsonb) p on r.id=p.id`,[trashId,name,JSON.stringify(items)]);
      }
    }
    await removeSnapshotRows(db,meta,snapshot);receipts.push({id:trashId,type:pick.type,sourceId:pick.id});
  }
  await db.query('delete from student_read_models where student_id=$1',[user.id]);
  return receipts;
}
export async function restoreAccountData(db:PoolClient,user:Profile,picks:DataPick[]):Promise<AccountDataReceipt[]> {
  await lockData(db,user.id);const meta=await dataMetadata(db),receipts:AccountDataReceipt[]=[],entries:Record<string,any>[]=[],combined:DataRows={};
  await db.query("select set_config('gakja.data_restore',$1,true)",[user.id]);
  for(const pick of picks){
    const trash=(await db.query('select * from account_data_trash where id::text=$1 and student_id=$2 and type=$3 for update',[pick.id,user.id,pick.type])).rows[0];
    if(!trash){
      if(pick.type==='thread'){const legacy=await db.query('update chat_threads set deleted_at=null,archived_at=null,updated_at=now() where id::text=$1 and student_id=$2 and deleted_at is not null returning id',[pick.id,user.id]);if(legacy.rows.length){receipts.push({id:pick.id,type:pick.type,sourceId:pick.id});continue;}}
      throw new ApiError(404,'휴지통의 자료를 찾을 수 없어요.');
    }
    if(trash.purge_started_at)throw new ApiError(409,'영구 삭제가 시작된 자료예요. 삭제를 마무리해 주세요.');
    entries.push(trash);
    for(const [name,rows]of Object.entries((trash.snapshot as Snapshot).rows))combined[name]=[...(combined[name]||[]),...rows];
  }
  try {
      // Restore the selected dependency graph as one unit. In particular a child
      // assignment and its parent may have been trashed in separate operations.
      for(const name of tableOrder(meta,Object.keys(combined))){
        if(!allowedTables.has(name))throw new ApiError(409,'복원할 자료 형식을 확인해 주세요.');
        const info=meta.tables.get(name)!;
        if(info.owned&&combined[name].some(row=>row.student_id!==user.id))throw new ApiError(403,'본인 자료만 복원할 수 있어요.');
        const rows=[...new Map(combined[name].map(row=>[rowKey(info,row),row])).values()];
        const columns=info.columns.map(ident).join(','),values=info.columns.map(column=>info.binary.includes(column)?'b.data':'r.'+ident(column)).join(',');
        await db.query(`insert into ${tableSql(meta,name)}(${columns}) overriding system value select ${values} from jsonb_populate_recordset(null::${tableSql(meta,name)},$1::jsonb) r ${info.binary.length?"left join "+tableSql(meta,'account_data_blobs')+" b on b.trash_id=any($2::uuid[]) and b.table_name=$3 and b.row_id=r.id::text":''}`,[JSON.stringify(rows),...(info.binary.length?[entries.map(entry=>entry.id),name]:[])]);
      }
      for(const trash of entries)for(const [id,events]of Object.entries((trash.snapshot as Snapshot).reportEvents||{})){
        const report=(await db.query('select report from study_sessions where id=$1 and student_id=$2 for update',[id,user.id])).rows[0];if(!report)continue;
        const combined=[...(report.report?.events||[]),...events],unique=[...new Map(combined.map((event:any)=>[event.id,event])).values()].sort((a:any,b:any)=>String(a.created_at).localeCompare(String(b.created_at)));
        await db.query('update study_sessions set report=$3::jsonb where id=$1 and student_id=$2',[id,user.id,JSON.stringify({...studySummary(unique),events:unique})]);
      }
  }catch(error){if(['23505','23503'].includes((error as {code?:string}).code||''))throw new ApiError(409,'같은 자료가 새로 만들어졌거나 연결 자료가 휴지통에 있어요. 연결된 항목을 먼저 복원해 주세요.');throw error;}
  for(const trash of entries){
    await db.query('delete from account_data_trash where id=$1 and student_id=$2',[trash.id,user.id]);receipts.push({id:trash.id,type:trash.type,sourceId:trash.root_id});
  }
  await db.query('delete from student_read_models where student_id=$1',[user.id]);return receipts;
}

const expressions:Record<AccountDataType,{title:string;detail:string;school?:string;date?:string;where?:string}>= {
  experience:{title:"r.data->>'title'",detail:"concat_ws(' ',r.data->>'situation',r.data->>'action',r.data->>'result')"},
  draft:{title:"r.data->>'title'",detail:"concat_ws(' ',r.data->>'situation',r.data->>'action')",date:'r.updated_at'},
  answer:{title:"'저장한 답변'",detail:"concat_ws(' ',r.question_id,r.script,r.structure)"},
  thread:{title:'r.title',detail:"coalesce((select string_agg(m.content,' ') from chat_messages m where m.thread_id=r.id and m.student_id=r.student_id),'')",school:'r.target_id',where:'r.deleted_at is null'},
  interview:{title:"coalesce(r.data->>'targetName',r.data->'context'->'target'->>'university','모의면접')",detail:"coalesce((select string_agg(concat_ws(' ',t.data->>'question',t.data->>'answer'),' ') from interview_turns t where t.session_id=r.id and t.student_id=r.student_id),'')",school:'r.target_id'},
  report:{title:"'면접 리포트'",detail:'r.data::text',school:'(select target_id from interview_sessions where id=r.session_id and student_id=r.student_id)'},
  media:{title:"case when r.metadata->>'kind'='analysis_audio' then '분석용 음성' else '면접 녹음·영상' end",detail:"concat_ws(' ',r.text,r.metadata->>'questionId')",school:'(select target_id from interview_sessions where id=r.session_id and student_id=r.student_id)'},
  attachment:{title:'r.name',detail:'coalesce(r.extracted_text,\'\')',school:'(select target_id from chat_threads where id=r.thread_id and student_id=r.student_id)'},
  document:{title:"case when r.kind='guidebook' then '가이드북' else '핸드북' end",detail:"r.data::text"},
  quiz:{title:"case when r.mode='oral' then '말하기 연습' when r.mode='choice' then '개념 확인' else '답변 연습' end",detail:'r.items::text',school:"r.metadata->>'targetId'"},
  quiz_recording:{title:"'연습 녹음'",detail:"coalesce(r.metadata->>'transcript','')",school:"(select metadata->>'targetId' from quiz_sessions where id=r.session_id and student_id=r.student_id)"},
  study:{title:"'학습 리포트'",detail:'coalesce(r.report::text,\'\')',date:'r.started_at',where:"r.state='finalized'"},
  memory:{title:"'복습 기록'",detail:"concat_ws(' ',r.memory_item_id,r.data->>'answer')",school:"coalesce(r.data->>'targetId',r.data->>'target_id')"},
  thought:{title:"coalesce((select title from briefings where id=r.briefing_id),'생각 기록')",detail:'r.content'},
  news:{title:"coalesce((select title from department_news_articles where id=r.article_id),'뉴스 생각')",detail:'r.content',date:'r.updated_at'},
  knowledge:{title:"coalesce(r.snapshot->>'label',r.snapshot->>'title','지식 기록')",detail:'r.reflection',school:"r.snapshot->>'targetId'"},
  confirmation:{title:'r.question',detail:"concat_ws(' ',r.question,r.response)"},
  plan:{title:'r.title',detail:'r.target::text',school:"r.target->>'targetId'"},
  assignment:{title:'r.title',detail:'r.items::text',school:'r.target_id'},
  school:{title:"coalesce(r.data->>'university',r.data->>'university_name',r.data->>'name','지원 학교')",detail:'r.data::text',school:'r.id'},
};
export function activeDataSql() {
  return (Object.entries(DATA_TABLES) as [AccountDataType,string][]).map(([type,table])=>{const view=expressions[type];return `select r.id::text as id,${type==='answer'?'r.question_id':'r.id::text'} as href_id,'${type}'::text as type,coalesce(nullif(${view.title},''),'${ACCOUNT_DATA_TYPES[type]}') as title,
    (${view.date||'r.created_at'}) as created_at,${view.school||'null::text'} as school_id,${view.detail} as search_text from ${ident(table)} r where r.student_id=$1${view.where?' and '+view.where:''}`;}).join(' union all ');
}
function filterDate(value:string|null){if(!value)return null;if(!/^\d{4}-\d\d-\d\d$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw new ApiError(400,'날짜를 확인해 주세요.');return value;}
const scopeDigest=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,24);
export async function accountDataPage(user:Profile,params:URLSearchParams) {
  const view=params.get('view')||'active',q=(params.get('q')||'').trim(),type=params.get('type')||'',schoolId=params.get('schoolId')||'',from=filterDate(params.get('from')),to=filterDate(params.get('to')),limit=Number(params.get('limit')||30);
  if(!['active','trash'].includes(view)||q.length>200||schoolId.length>160||type&&!Object.hasOwn(DATA_TABLES,type)||!Number.isInteger(limit)||limit<1||limit>50||from&&to&&from>to)throw new ApiError(400,'검색 조건을 확인해 주세요.');
  const scope=scopeDigest(JSON.stringify([user.id,view,q,type,schoolId,from,to])),values:unknown[]=[user.id],where:string[]=[];
  const bind=(value:unknown)=>{values.push(value);return '$'+values.length;};
  if(q)where.push(`position(lower(${bind(q)}) in lower(title||' '||coalesce(search_text,'')))>0`);
  if(type)where.push('type='+bind(type));if(schoolId)where.push('school_id='+bind(schoolId));
  // Dates in this Korean service are inclusive Korea calendar days.
  if(from)where.push(`created_at>=(${bind(from)}::date::timestamp at time zone 'Asia/Seoul')`);
  if(to)where.push(`created_at<((${bind(to)}::date+1)::timestamp at time zone 'Asia/Seoul')`);
  const rawCursor=params.get('cursor');if(rawCursor){try{if(rawCursor.length>1600)throw new Error();const cursor=JSON.parse(Buffer.from(rawCursor,'base64url').toString('utf8'));if(cursor.scope!==scope||typeof cursor.at!=='string'||!Number.isFinite(Date.parse(cursor.at))||typeof cursor.id!=='string'||cursor.id.length>160||!Object.hasOwn(DATA_TABLES,cursor.type))throw new Error();where.push(`(created_at,type,id)<(${bind(cursor.at)}::timestamptz,${bind(cursor.type)}::text,${bind(cursor.id)}::text)`);}catch{throw new ApiError(400,'목록을 처음부터 다시 불러와 주세요.');}}
  const trashSql=`select id::text,type,title,created_at,school_id,title as search_text,root_id,related_count,purge_started_at from account_data_trash where student_id=$1
    union all select id::text,'thread',title,deleted_at,target_id,title,id::text,(select count(*)::int from chat_messages m where m.thread_id=t.id),null::timestamptz from chat_threads t where student_id=$1 and deleted_at is not null`;
  const [selected,counts,schools,sessions,requests]=await Promise.all([
    query(`select *,to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at from (${view==='trash'?trashSql:activeDataSql()}) records ${where.length?'where '+where.join(' and '):''} order by created_at desc,type desc,id desc limit ${bind(limit+1)}`,values),
    query(`select (select count(*)::int from (${activeDataSql()}) a) as active,((select count(*) from account_data_trash where student_id=$1)+(select count(*) from chat_threads where student_id=$1 and deleted_at is not null))::int as trash`,[user.id]),
    query("select id,coalesce(data->>'university',data->>'university_name',data->>'name','지원 학교') as name from support_targets where student_id=$1 order by name,id",[user.id]),
    deviceSessions(user.id),
    query('select id,type,status,detail,created_at as "createdAt",updated_at as "updatedAt" from account_data_requests where student_id=$1 order by created_at desc',[user.id]),
  ]);
  const visible=selected.slice(0,limit),last=visible.at(-1),nextCursor=selected.length>limit&&last?Buffer.from(JSON.stringify({scope,at:last.cursor_at,type:last.type,id:last.id})).toString('base64url'):null;
  const href=(type:AccountDataType,id:string)=>({experience:'/armory?card='+encodeURIComponent(id),draft:'/armory',answer:'/materials/answers/'+encodeURIComponent(id),thread:'/on/'+encodeURIComponent(id),interview:'/interview/'+encodeURIComponent(id),report:'/records/reports/'+encodeURIComponent(id),study:'/reports/sessions/'+encodeURIComponent(id),school:'/schools/'+encodeURIComponent(id)} as Partial<Record<AccountDataType,string>>)[type];
  const items:AccountDataItem[]=visible.map(row=>({id:row.id,type:row.type,title:row.title,sourceId:row.root_id||row.id,createdAt:new Date(row.created_at).toISOString(),schoolId:row.school_id||null,schoolName:schools.find(school=>school.id===row.school_id)?.name||'',deletedAt:view==='trash'?new Date(row.created_at).toISOString():null,detail:row.purge_started_at?'영구 삭제를 마무리해 주세요.':String(row.search_text||'').replace(/\s+/g,' ').slice(0,100),relatedCount:Number(row.related_count||0),restoreAvailable:!row.purge_started_at,...(view==='active'?{href:href(row.type,row.href_id||row.id)}:{})}));
  return {items,page:{nextCursor,hasMore:!!nextCursor,limit},counts:counts[0]||{active:0,trash:0},schools,sessions,requests};
}
export async function requestAccountDataDeletion(user:Profile,type:'all_data'|'account',confirmation:string) {
  confirmAccountEmail(user,confirmation);
  return transaction(async db=>{
    await lockData(db,user.id);const previous=(await db.query("select id from account_data_requests where student_id=$1 and type=$2 and status in ('requested','processing')",[user.id,type])).rows[0];if(previous)return previous;
    const config=supportConfig(),requestId=randomUUID(),inquiryId=randomUUID(),label=type==='account'?'계정 탈퇴 및 전체 자료 삭제':'전체 자료 삭제';
    await db.query("insert into support_inquiries(id,request_id,student_id,email,type,content,policy_version,response_time_notice,retention_notice) values($1,$2,$3,$4,'privacy',$5,$6,$7,$8)",[inquiryId,requestId,user.id,user.email,`${label} 요청\n본인 계정에서 이메일을 확인하고 접수했어요.\n요청 번호: ${requestId}\n사용자에게 삭제 범위와 진행 결과를 안내해 주세요.`,PRIVACY_POLICY_VERSION,config.responseTime,config.retention]);
    return (await db.query('insert into account_data_requests(id,student_id,type,inquiry_id) values($1,$2,$3,$4) returning id',[requestId,user.id,type,inquiryId])).rows[0];
  });
}
export async function cancelAccountDataRequest(user:Profile,id:string) {
  return transaction(async db=>{
    const request=(await db.query("update account_data_requests set status='cancelled',detail='요청을 취소했어요.',updated_at=now() where id=$1 and student_id=$2 and status='requested' returning inquiry_id",[id,user.id])).rows[0];
    if(!request)throw new ApiError(409,'이미 확인을 시작한 요청이에요. 문의로 취소 가능 여부를 확인해 주세요.');
    await db.query("update support_inquiries set status='resolved',operator_note='사용자가 데이터 관리에서 요청을 취소함',updated_at=now() where id=$1",[request.inquiry_id]);return {ok:true};
  });
}
