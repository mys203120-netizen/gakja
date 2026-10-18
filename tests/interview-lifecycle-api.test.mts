import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import ts from 'typescript';
import * as timers from '../apps/web/src/lib/interview-timer';

const require=createRequire(import.meta.url), id='00000000-0000-4000-8000-000000000001';
let session:any, report:any, writes=0;
class FeatureError extends Error {constructor(public status:number,message:string,public code:string){super(message);}}
const ai={FeatureError,requireStudent(){},assertPublishedAccess:async()=>{},aiEnabled:()=>false,selfCheckReport:()=>({sections:[]}),featureError:(e:any)=>({status:e.status||500,error:e.message,code:e.code})};
async function query(sql:string,args:any[]){
  if(sql.startsWith('select')&&sql.includes('from interview_sessions'))return session.student_id===args[1]?[structuredClone(session)]:[];
  if(sql.startsWith('select')&&sql.includes('from interview_reports'))return report?[report]:[];
  if(sql.startsWith('select'))return [];
  writes++;
  if(sql.startsWith('update interview_sessions')){
    const value=JSON.parse(args[2]);
    session.data=sql.includes('data=$3')?value:{...session.data,...value};
    if(sql.includes("state='completed'"))session.state='completed';
    if(sql.includes("state='cancelled'"))session.state='cancelled';
    return [structuredClone(session)];
  }
  if(sql.startsWith('insert into interview_reports')){report={id:'report',data:JSON.parse(args[2])};return [report];}
  return [];
}
const mod={exports:{} as any};
vm.runInNewContext(ts.transpileModule(readFileSync('apps/web/src/app/api/interviews/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
  module:mod,exports:mod.exports,Response,Request,URL,Date,console,
  require(name:string){
    if(name==='@/lib/interview-timer')return timers;
    if(name==='@/lib/auth')return {requireUser:async()=>({id:'owner',role:'student'}),checkOrigin(){}};
    if(name==='@/lib/db')return {query,transaction:async(fn:any)=>fn({query:async(sql:string,args:any[])=>({rows:await query(sql,args)})})};
    if(name==='@/lib/ai')return ai;
    if(name==='@/lib/study-sessions')return {recordStudyEvent:async()=>{}};
    if(name.startsWith('@/'))return {};
    return require(name);
  }
});
function setup(extra:any={}){const now=Date.now();session={id,student_id:'owner',state:'active',data:{context:{},elapsedMs:2000,activeSince:now-5000,timerLeaseUntil:now+25000,generation:3,...extra}};report=null;writes=0;}
async function action(action:string){const r=await mod.exports.POST(new Request('http://localhost/api/interviews',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,sessionId:id})}));return {status:r.status,body:await r.json()};}
test('suspend during AI processing preserves generation and in-flight answer',async()=>{
  setup({processing:'in-flight',processingAt:Date.now()});const r=await action('suspend');
  assert.equal(r.status,200);assert.equal(session.data.paused,true);assert.equal(session.data.activeSince,null);
  assert.equal(session.data.generation,3);assert.equal(session.data.processing,'in-flight');
  assert.ok(session.data.elapsedMs>=7000&&session.data.elapsedMs<8500);
  const elapsed=session.data.elapsedMs;await action('suspend');assert.equal(session.data.elapsedMs,elapsed);
});
test('an expired heartbeat settles the session and requires explicit resume',async()=>{
  const now=Date.now();
  setup({activeSince:now-90000,timerLeaseUntil:now-60000});
  assert.equal((await action('heartbeat')).status,200);assert.equal(session.data.paused,true);assert.equal(session.data.elapsedMs,32000);
  await action('resume');assert.equal(session.data.paused,false);assert.ok(session.data.timerLeaseUntil>Date.now());assert.equal(session.data.elapsedMs,32000);
});
test('explicit pause counts current interval before changing paused flag',async()=>{
  setup();assert.equal((await action('pause')).status,200);assert.ok(session.data.elapsedMs>=7000);assert.equal(session.data.activeSince,null);
});
test('finish saves the frozen duration, and later heartbeat cannot restart it',async()=>{
  setup();await action('suspend');const elapsed=session.data.elapsedMs;
  const r=await action('finish');assert.equal(r.status,200);assert.equal(session.state,'completed');assert.equal(report.data.durationSeconds,Math.floor(elapsed/1000));
  const before=writes;await action('heartbeat');assert.equal(writes,before);assert.equal(session.data.activeSince,null);
});
test('cancel also stops time and neither suspend nor heartbeat can modify foreign data',async()=>{
  setup();assert.equal((await action('cancel')).status,200);assert.equal(session.state,'cancelled');assert.equal(session.data.activeSince,null);
  for(const verb of ['suspend','heartbeat']){setup();session.student_id='someone-else';assert.equal((await action(verb)).status,404);assert.equal(writes,0);}
});
