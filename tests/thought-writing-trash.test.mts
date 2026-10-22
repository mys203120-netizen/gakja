import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import {z} from 'zod';
const code=(path:string)=>ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
class ApiError extends Error{constructor(public status:number,message:string){super(message);}}
function harness(){
 const user={id:randomUUID(),email:'fixture@test.invalid',name:'Fixture',role:'student'},cardId=randomUUID(),foreign=randomUUID();
 const card={id:cardId,student_id:user.id,revision:1,created_at:new Date().toISOString(),data:{title:'보존할 경험',situation:'확인한 문단',action:'내 행동',writingOriginals:{situation:'원래 키워드\n그대로'},writingAssistance:[{requestId:randomUUID(),field:'situation'}]}};
 const state={cards:[card],trash:[] as any[],prefs:{student_id:user.id,data:{calendarEdits:[{id:'calendar-change'}],theme:'kept',thoughtWritingReceipts:[{requestId:randomUUID(),proposal:{draft:'삭제돼야 할 AI 제안 캐시'}}]} as any},failGraph:false,queries:[] as string[]};
 const tableColumns:Record<string,string[]>={experience_cards:['id','student_id','revision','created_at','data'],student_preferences:['student_id','data']};const cursors=new Map<string,any[]>();
 const result=(rows:any[]=[])=>({rows,rowCount:rows.length});
 async function query(sql:string,args:any[]=[]):Promise<any>{state.queries.push(sql);
  if(sql.startsWith('set ')||sql.startsWith('begin')||sql==='commit'||sql==='rollback'||sql.startsWith('select pg_advisory'))return result();
  if(sql.startsWith('select pg_try'))return result([{locked:true}]);
  if(sql==='select current_schema() as schema')return result([{schema:'fixture'}]);
  if(sql.startsWith('select c.relname as name'))return result(Object.entries(tableColumns).flatMap(([name,columns])=>columns.map(column=>({name,column,binary:false,primary:name==='student_preferences'?['student_id']:['id']}))));
  if(sql.startsWith('select p.relname as parent'))return result();
  if(sql.startsWith('select id from "fixture"."experience_cards"'))return result(state.cards.filter(row=>row.id===args[0]&&row.student_id===args[1]).map(row=>({id:row.id})));
  if(sql.startsWith('update student_preferences')){if(args[0]===user.id)delete state.prefs.data.thoughtWritingReceipts;return result();}
  if(sql.startsWith('select jsonb_build_object')&&sql.includes('from "fixture"."experience_cards"')){if(state.failGraph)throw new ApiError(409,'Busy data graph');return result(state.cards.filter(row=>row.student_id===args[0]&&row.id===args[1]).map(row=>({row:structuredClone(row)})));}
  if(sql.startsWith('insert into account_data_trash')){state.trash.push({id:args[0],student_id:args[1],type:args[2],root_id:args[4],snapshot:JSON.parse(args[7])});return result();}
  if(sql.startsWith('delete from "fixture"."experience_cards"')){const rows=JSON.parse(args[0]);state.cards=state.cards.filter(row=>!rows.some((deleted:any)=>deleted.id===row.id));return result();}
  if(sql.startsWith('select * from account_data_trash'))return result(state.trash.filter(row=>row.id===args[0]&&row.student_id===args[1]&&row.type===args[2]));
  if(sql.startsWith('select set_config')||sql.startsWith('delete from student_read_models'))return result();
  if(sql.startsWith('insert into "fixture"."experience_cards"')){state.cards.push(...JSON.parse(args[0]));return result();}
  if(sql.startsWith('delete from account_data_trash')){state.trash=state.trash.filter(row=>row.id!==args[0]||row.student_id!==args[1]);return result();}
  if(sql.startsWith('select id,email'))return result([user]);
  if(sql.startsWith('declare ')){const cursor=sql.match(/^declare ("[^"]+")/)![1];let rows:any[]=[];if(sql.includes('"experience_cards" r'))rows=state.cards.filter(row=>row.student_id===args[0]);else if(sql.includes('"student_preferences" r'))rows=state.prefs.student_id===args[0]?[state.prefs]:[];else if(sql.includes('account_data_trash r'))rows=state.trash.filter(row=>row.student_id===args[0]);cursors.set(cursor,structuredClone(rows).map(row=>({row})));return result();}
  if(sql.startsWith('fetch forward ')){const cursor=sql.match(/from ("[^"]+")/)![1],rows=cursors.get(cursor)||[];cursors.set(cursor,[]);return result(rows);}
  if(sql.startsWith('close '))return result();
  throw Error('Unexpected SQL: '+sql);
 }
 const db={query,release(){}};
 const dependencies:Record<string,any>={'server-only':{},'node:crypto':{createHash,randomUUID},zod:{z},'./db':{ApiError,query:async(sql:string,args:any[])=>((await query(sql,args)).rows),pool:{connect:async()=>db}},'./account-data-model':{ACCOUNT_DATA_TYPES:{experience:'내 경험'}},'./account-device-sessions':{},'./study-sessions':{studySummary:()=>({})},'./privacy-policy':{},'./support-config':{},'./auth':{},'./account-data-files':{accountStoredFiles:()=>[],readAccountStoredFile:()=>{throw Error('No files');}},'./account-readable-report':{}};
 const module={exports:{} as any};vm.runInNewContext(code('apps/web/src/lib/account-data-store.ts'),{module,exports:module.exports,JSON,Date,Buffer,require:(name:string)=>{if(name in dependencies)return dependencies[name];throw Error(name);}});
 dependencies['./account-data-store']=module.exports;
 const backup={exports:{} as any};vm.runInNewContext(code('apps/web/src/lib/account-data-backup.ts'),{module:backup,exports:backup.exports,JSON,Date,Buffer,TextEncoder,ReadableStream,Response,process:{env:{}},require:(name:string)=>{if(name in dependencies)return dependencies[name];throw Error(name);}});
 async function transaction(fn:Function){const before=structuredClone({cards:state.cards,trash:state.trash,prefs:state.prefs});try{return await fn();}catch(error){Object.assign(state,before);throw error;}}
 return {state,user,cardId,foreign,card:structuredClone(card),async trash(picks=[{id:cardId,type:'experience'}]){return transaction(()=>module.exports.moveAccountDataToTrash(db,user,picks));},async restore(id:string){return transaction(()=>module.exports.restoreAccountData(db,user,[{id,type:'experience'}]));},async backup(){return (await backup.exports.accountDataBackup(user,'json')).json();}};
}
test('trash removes transient AI text from preferences and backup while preserving exact original in the reversible snapshot',async()=>{
 const h=harness(),before=await h.backup();assert.equal(before.records.student_preferences[0].data.thoughtWritingReceipts[0].proposal.draft,'삭제돼야 할 AI 제안 캐시');
 const receipts=await h.trash();assert.equal(h.state.cards.length,0);assert.equal(h.state.prefs.data.thoughtWritingReceipts,undefined);assert.equal(h.state.prefs.data.theme,'kept');assert.deepEqual(h.state.prefs.data.calendarEdits,[{id:'calendar-change'}]);
 const exported=await h.backup();assert.equal(JSON.stringify(exported).includes('삭제돼야 할 AI 제안 캐시'),false);assert.equal(exported.trash[0].snapshot.rows.experience_cards[0].data.writingOriginals.situation,'원래 키워드\n그대로');
 await h.restore(receipts[0].id);assert.deepEqual(h.state.cards[0],h.card);assert.equal(h.state.trash.length,0);assert.equal(h.state.prefs.data.thoughtWritingReceipts,undefined);assert.equal((await h.backup()).records.experience_cards[0].data.writingOriginals.situation,'원래 키워드\n그대로');
});
test('foreign picks are rejected before cache removal and a graph-lock failure rolls cache and data back together',async()=>{
 const h=harness();await assert.rejects(h.trash([{id:h.foreign,type:'experience'}]),{status:404});assert.equal(h.state.prefs.data.thoughtWritingReceipts.length,1);assert.ok(!h.state.queries.some(sql=>sql.startsWith('update student_preferences')));
 h.state.failGraph=true;await assert.rejects(h.trash(),{status:409});assert.equal(h.state.prefs.data.thoughtWritingReceipts.length,1);assert.deepEqual(h.state.cards[0],h.card);assert.equal(h.state.trash.length,0);
});
