import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as cursors from '../apps/web/src/lib/record-cursor';

const require=createRequire(import.meta.url);
class ApiError extends Error{constructor(public status:number,message:string){super(message);}}
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const at='2026-10-21T08:00:00.123456Z';
const rows=Array.from({length:75},(_,index)=>({id:id(75-index),created_at:at,__cursor_at:at,question_id:'question-'+index,written:true}));
function harness(){
 const calls:{sql:string;params:any[]}[]=[];
 const state={items:[...rows],owned:true};
 const query=async(sql:string,params:any[])=>{
  calls.push({sql,params});
  if(sql.includes('from support_targets'))return state.owned?[{id:'school'}]:[];
  if(/where student_id=\$1 and question_id in/.test(sql))return [{id:id(1),question_id:'published-question',written:true}];
  if(/where .*id=\$2.*limit 1/.test(sql))return params[1]===id(1)?[{id:id(1),script:'owned answer',data:{sections:[{answer:'complete report'}]}}]:[];
  let selected=state.items;
  if(sql.includes('(created_at,id)<=')){
   const start=params.length-5;
   const [anchorAt,anchorId,afterAt,afterId]=params.slice(start,start+4);
   const before=(row:any,stamp:string,key:string,inclusive=false)=>row.__cursor_at<stamp||row.__cursor_at===stamp&&(inclusive?row.id<=key:row.id<key);
   selected=selected.filter(row=>before(row,anchorAt,anchorId,true)&&before(row,afterAt,afterId));
  }
  return selected.slice(0,params.at(-1));
 };
 const module={exports:{} as any};
 const source=ts.transpileModule(readFileSync('apps/web/src/lib/student-records.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{module,exports:module.exports,URLSearchParams,require:(name:string)=>name==='server-only'?{}:name==='./db'?{ApiError,query}:name==='./record-cursor'?cursors:name==='./student-assignment-records'?{}:require(name)});
 return {state,calls,get:(params:URLSearchParams,owner='student')=>module.exports.getStudentRecords(owner,params)};
}

test('cursor preserves microseconds and canonical IDs, rejects a different actor/target/version',()=>{
 const scope=JSON.stringify(['student','versions','school',7]),point={at,id:'quiz:'+id(2)};
 const encoded=cursors.encodeRecordCursor({anchor:point,after:point},scope);
 assert.deepEqual(cursors.parseRecordCursor(encoded,scope),{anchor:point,after:point});
 for(const other of ['other-student','other-school','8'])assert.throws(()=>cursors.parseRecordCursor(encoded,scope+other));
 for(const bad of ['!',encoded+'=',Buffer.from('{"v":1}').toString('base64url'),'a'.repeat(1601)])assert.throws(()=>cursors.parseRecordCursor(bad,scope));
});

test('record pages remain bounded and stable through tied timestamps, a concurrent insertion and edits',async()=>{
 const h=harness(),params=new URLSearchParams({kind:'answers',limit:'30'});
 const first=await h.get(params);assert.equal(first.items.length,30);assert.equal(first.page.hasMore,true);assert.equal(h.calls.at(-1)!.params.at(-1),31);
 assert.ok(!h.calls.at(-1)!.sql.includes('select *'));assert.ok(!h.calls.at(-1)!.sql.includes('script,'));
 h.state.items.unshift({id:id(99),created_at:'2026-10-21T08:01:00.000000Z',__cursor_at:'2026-10-21T08:01:00.000000Z',question_id:'new',written:true});
 h.state.items[40].written=false; // An edit never moves the immutable created-time cursor.
 params.set('cursor',first.page.nextCursor);const second=await h.get(params);params.set('cursor',second.page.nextCursor);const third=await h.get(params);
 const all=[...first.items,...second.items,...third.items];
 assert.equal(all.length,75);assert.equal(new Set(all.map((row:any)=>row.id)).size,75);assert.ok(!all.some((row:any)=>row.id===id(99)));assert.equal(third.page.hasMore,false);
 const cursorQuery=h.calls.find(call=>call.sql.includes('(created_at,id)<='))!;
 assert.ok(cursorQuery.sql.includes('(created_at,id)<('));assert.ok(cursorQuery.sql.includes('student_id=$1'));assert.ok(cursorQuery.sql.includes('created_at desc,id desc'));
});

test('a cursor cannot cross student, target, source version or archive scope',async()=>{
 const h=harness(),params=new URLSearchParams({kind:'threads',targetId:'school',sourceVersion:'7',limit:'10'});
 const first=await h.get(params);params.set('cursor',first.page.nextCursor);
 await assert.rejects(h.get(params,'other'),error=>(error as ApiError).status===400);
 for(const [name,value]of [['targetId','other-school'],['sourceVersion','8'],['sourceType','common'],['archived','1']]){const changed=new URLSearchParams(params);changed.set(name,value);await assert.rejects(h.get(changed),error=>(error as ApiError).status===400);}
 h.state.owned=false;await assert.rejects(h.get(new URLSearchParams({kind:'interviews',targetId:'school'})),error=>(error as ApiError).status===404);
});

test('old record detail is independent of a recent page and retains the ownership predicate',async()=>{
 const h=harness();const detail=await h.get(new URLSearchParams({kind:'answers',id:id(1)}));assert.equal(detail.item.script,'owned answer');
 const query=h.calls.at(-1)!;assert.ok(query.sql.includes('student_id=$1'));assert.equal(query.params[0],'student');assert.equal(query.params[1],id(1));
 await assert.rejects(h.get(new URLSearchParams({kind:'answers',id:id(999)})),error=>(error as ApiError).status===404);
});

test('current material answer state selects only current published questions without answer bodies',async()=>{
 const h=harness();const result=await h.get(new URLSearchParams({kind:'answers',view:'state'}));
 assert.equal(result.items.length,1);const sql=h.calls.at(-1)!.sql;
 assert.ok(sql.includes("v.status='published'"));assert.ok(sql.includes('v.version=p.active_version'));assert.ok(sql.includes('p.student_id=$1'));assert.ok(!/select \*/.test(sql));
});

test('assignment list filters before pagination and old ID detail uses the frozen version and public projection',async()=>{
 const h=harness();await h.get(new URLSearchParams({kind:'assignments',state:'active'}));const list=h.calls.at(-1)!;
 assert.ok(list.sql.includes("state<>'completed'"));assert.ok(list.sql.includes('jsonb_array_length(items)'));assert.ok(!list.sql.includes('select *'));
 const old={id:id(1),student_id:'student',package_id:'published',content_version:2,source_kind:'personal',items:[{id:'item',correct_answer:'must stay server-side'}]};
 const calls:{sql:string;params:any[]}[]=[],versions:number[]=[];
 const query=async(sql:string,params:any[])=>{calls.push({sql,params});if(sql.includes('from quiz_assignments'))return params[0]==='student'?[old]:[];return [];};
 const module={exports:{} as any},source=ts.transpileModule(readFileSync('apps/web/src/lib/student-assignment-records.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{module,exports:module.exports,require:(name:string)=>{
  if(name==='server-only')return {};
  if(name==='./db')return {ApiError,query};
  if(name==='./data')return {getLearning:async(owner:string,version:number)=>{assert.equal(owner,'student');versions.push(version);return {learning:{version}};}};
  if(name==='./learning-workflows')return {safeAssignment:(assignment:any,attempts:any[],events:any[],learning:any)=>{assert.equal(assignment,old);assert.equal(learning.version,2);return {id:assignment.id,items:[{id:'item'}],attempts,history:events};}};
  return require(name);
 }});
 const detail=await module.exports.getStudentAssignment('student',id(1));assert.equal(detail.id,id(1));assert.deepEqual(versions,[2]);assert.ok(!JSON.stringify(detail).includes('correct_answer'));
 assert.ok(calls.every(call=>call.params[0]==='student'&&call.params[1]===id(1)));assert.ok(calls.some(call=>call.sql.includes('limit 30')));
 await assert.rejects(module.exports.getStudentAssignment('other',id(1)),error=>(error as ApiError).status===404);
});

test('list limits and kinds reject invalid input before a history scan',async()=>{
 const h=harness();for(const limit of ['0','51','1.5','NaN'])await assert.rejects(h.get(new URLSearchParams({kind:'reports',limit})),error=>(error as ApiError).status===400);
 await assert.rejects(h.get(new URLSearchParams({kind:'media_assets'})),error=>(error as ApiError).status===400);
 assert.equal(h.calls.length,0);
});

test('full export streams every canonical answer page and keeps raw source queries owned',async()=>{
 const calls:{sql:string;params:any[]}[]=[],historyCalls:any[]=[];
 const versions=Array.from({length:503},(_,index)=>({id:'quiz:'+id(index+1),script:'answer '+index}));
 const module={exports:{} as any};
 const source=ts.transpileModule(readFileSync('apps/web/src/app/api/student-records/export/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{module,exports:module.exports,ReadableStream,TextEncoder,Response,console,require:(name:string)=>{
  if(name==='@/lib/auth')return {requireUser:async()=>({id:'student',role:'student'})};
  if(name==='@/lib/db')return {ApiError,errorResponse:(error:ApiError)=>Response.json({error:error.message},{status:error.status||500}),query:async(sql:string,params:any[])=>{calls.push({sql,params});return [];}};
  if(name==='@/lib/learning-workflows')return {getLearningHistoryPage:async(user:any,_student:any,options:any)=>{historyCalls.push({user,options});const start=Number(options.cursor||0),end=start+options.limit;return {versions:versions.slice(start,end),versionsPage:{nextCursor:end<versions.length?String(end):null}};}};
  return require(name);
 }});
 const response=await module.exports.GET(),body=await response.json();
 assert.equal(response.status,200);assert.equal(body.answers.length,503);assert.equal(body.answers.at(-1).id,versions.at(-1)!.id);
 assert.equal(historyCalls.length,3);assert.ok(historyCalls.every(call=>call.user.id==='student'&&call.options.limit===250));
 assert.ok(calls.every(call=>call.params[0]==='student'&&call.sql.includes('student_id=$1')&&call.sql.includes('limit 250')));
 assert.ok(calls.find(call=>call.sql.includes('study_sessions r'))!.sql.includes('r.started_at'));
 assert.ok(calls.find(call=>call.sql.includes('study_imported_events r'))!.sql.includes('r.occurred_at'));
 assert.deepEqual(body.importedStudyHistory,[]);
 assert.equal(response.headers.get('Cache-Control'),'private, no-store');
});

test('paged UI rejects late responses after actor/school changes and deduplicates repeated more clicks',async()=>{
 let slots:any[]=[],index=0,scheduled:(()=>void)[]=[],scope='targetId=school-a',owner='student-a';
 const requests:{url:string;resolve:(value:any)=>void;reject:(error:Error)=>void}[]=[];
 const equal=(left:any[],right:any[])=>left?.length===right.length&&left.every((value,key)=>value===right[key]);
 const react={
  useRef:(current:any)=>{const slot=index++;return slots[slot]||(slots[slot]={current});},
  useState:(initial:any)=>{const slot=index++;if(!(slot in slots))slots[slot]=initial;return [slots[slot],(value:any)=>{slots[slot]=typeof value==='function'?value(slots[slot]):value;}];},
  useCallback:(callback:any,deps:any[])=>{const slot=index++;if(!slots[slot]||!equal(slots[slot].deps,deps))slots[slot]={deps,value:callback};return slots[slot].value;},
  useEffect:(effect:any,deps:any[])=>{const slot=index++,previous=slots[slot];if(!previous||!equal(previous.deps,deps)){scheduled.push(()=>{previous?.cleanup?.();const cleanup=effect();slots[slot]={deps,cleanup};});}},
 };
 const module={exports:{} as any},source=ts.transpileModule(readFileSync('apps/web/src/components/use-record-pages.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{module,exports:module.exports,AbortController,require:(name:string)=>name==='react'?react:name==='./shared'?{api:(url:string)=>new Promise((resolve,reject)=>requests.push({url,resolve,reject}))}:require(name)});
 const render=()=>{index=0;return module.exports.useRecordPages('interviews',scope,true,owner);};
 const effects=()=>{const work=scheduled;scheduled=[];work.forEach(effect=>effect());};
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 let result=render();assert.equal(result.loading,true);effects();assert.equal(requests.length,1);
 owner='student-b';scope='targetId=school-b';result=render();assert.equal(result.items.length,0);assert.equal(result.loading,true);effects();assert.equal(requests.length,2);
 requests[0].resolve({items:[{id:'private-old-actor'}],page:{nextCursor:null}});await settle();result=render();assert.equal(result.items.length,0);assert.equal(result.loading,true);
 requests[1].resolve({items:[{id:'owned-current'}],page:{nextCursor:'next',hasMore:true}});await settle();result=render();assert.equal(result.items[0].id,'owned-current');assert.equal(result.loading,false);
 const first=result.more(),second=result.more();assert.equal(requests.length,3);requests[2].resolve({items:[{id:'owned-current'},{id:'owned-older'}],page:{nextCursor:null,hasMore:false}});await Promise.all([first,second]);result=render();assert.equal(result.items.length,2);assert.equal(result.page.hasMore,false);
});
