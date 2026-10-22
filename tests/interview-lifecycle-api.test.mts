import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import ts from 'typescript';
import * as timers from '../apps/web/src/lib/interview-timer';
import * as completion from '../apps/web/src/lib/interview-completion';
import * as assistance from '../apps/web/src/lib/assistance-records';

const require=createRequire(import.meta.url), id='00000000-0000-4000-8000-000000000001';
let session:any, report:any, turns:any[]=[],writes=0,aiAvailable=false,coachCalls=0,coachGate:Promise<void>|undefined;
const deferred:Function[]=[];
class FeatureError extends Error {constructor(public status:number,message:string,public code:string){super(message);}}
const ai={FeatureError,requireStudent(){},assertPublishedAccess:async()=>{},aiEnabled:()=>aiAvailable,selfCheckReport:()=>({sections:turns.map(turn=>({question:turn.data.question,answer:turn.data.answer}))}),coach:async()=>{coachCalls++;await coachGate;return {content:'나중에 완성한 피드백'};},featureError:(e:any)=>({status:e.status||500,error:e.message,code:e.code})};
async function query(sql:string,args:any[]){
  if(sql.startsWith('select')&&sql.includes('from interview_sessions'))return session.student_id===args[1]?[structuredClone(session)]:[];
  if(sql.startsWith('select')&&sql.includes('from interview_reports'))return report?[report]:[];
  if(sql.startsWith('select')&&sql.includes('from interview_turns'))return turns;
  if(sql.startsWith('select'))return [];
  writes++;
  if(sql.startsWith('update interview_turns')&&sql.includes("data=data-'draft'")){for(const turn of turns)if(turn.data.answer==null)delete turn.data.draft;return [];}
  if(sql.startsWith('update interview_sessions')){
    const value=JSON.parse(args[2]);
    session.data=sql.includes('data=$3')?value:{...session.data,...value};
    if(sql.includes("state='completed'"))session.state='completed';
    if(sql.includes("state='cancelled'"))session.state='cancelled';
    return [structuredClone(session)];
  }
  if(sql.startsWith('insert into interview_reports')){report={id:'report',data:JSON.parse(args[2])};return [report];}
  if(sql.startsWith('update interview_reports')){if(args.length===3||String(report.data.reportRevision)===args[3]&&report.data.aiStatus==='pending'&&String(report.data.aiAttemptedAt)===args[4])Object.assign(report.data,JSON.parse(args[2]));return [structuredClone(report)];}
  return [];
}
const mod={exports:{} as any};
vm.runInNewContext(ts.transpileModule(readFileSync('apps/web/src/app/api/interviews/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
  module:mod,exports:mod.exports,Response,Request,URL,Date,console,
  require(name:string){
    if(name==='@/lib/interview-timer')return timers;
    if(name==='@/lib/interview-completion')return completion;
    if(name==='@/lib/assistance-records')return assistance;
    if(name==='next/server')return {after:(work:Function)=>deferred.push(work)};
    if(name==='@/lib/auth')return {requireUser:async()=>({id:'owner',role:'student'}),checkOrigin(){}};
    if(name==='@/lib/db')return {query,transaction:async(fn:any)=>fn({query:async(sql:string,args:any[])=>({rows:await query(sql,args)})})};
    if(name==='@/lib/ai')return ai;
    if(name==='@/lib/study-sessions')return {recordStudyEvent:async()=>{}};
    if(name.startsWith('@/'))return {};
    return require(name);
  }
});
function setup(extra:any={}){const now=Date.now();session={id,student_id:'owner',state:'active',data:{context:{},elapsedMs:2000,activeSince:now-5000,timerLeaseUntil:now+25000,generation:3,...extra}};report=null;turns=[];writes=0;aiAvailable=false;coachCalls=0;coachGate=undefined;deferred.length=0;}
async function action(action:string,extra:Record<string,unknown>={}){const r=await mod.exports.POST(new Request('http://localhost/api/interviews',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,sessionId:id,...extra})}));return {status:r.status,body:await r.json()};}
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
test('explicit unsaved exit clears only unanswered drafts and keeps already submitted evidence valid',async()=>{
  setup({questionQueue:[{id:'a'},{id:'b'}]});turns=[{question_id:'a',data:{question:'첫 질문',answer:'이미 보낸 답변',draft:'과거 초안',rootQuestionId:'a',assistance_recorded:true}},{question_id:'b',data:{question:'현재 질문',answer:null,draft:'버릴 초안',rootQuestionId:'b'}}];
  const result=await action('finish',{discardDraft:true});assert.equal(result.status,200);assert.equal(session.state,'completed');
  assert.equal(turns[0].data.answer,'이미 보낸 답변');assert.equal(turns[0].data.draft,'과거 초안');assert.equal(turns[1].data.draft,undefined);
  assert.equal(result.body.session.data.trainingProgress.answeredRootCount,1);assert.equal(result.body.session.data.trainingProgress.allRootsAnswered,false);
});
test('cancel also stops time and neither suspend nor heartbeat can modify foreign data',async()=>{
  setup();assert.equal((await action('cancel')).status,200);assert.equal(session.state,'cancelled');assert.equal(session.data.activeSince,null);
  for(const verb of ['suspend','heartbeat']){setup();session.student_id='someone-else';assert.equal((await action(verb)).status,404);assert.equal(writes,0);}
});

test('a saved partial diagnostic is not a completed lesson and exit returns before deferred AI feedback',async()=>{
  setup({trainingPurpose:'diagnostic',questionQueue:[{id:'a'},{id:'b'},{id:'c'}]});aiAvailable=true;
  turns=[{question_id:'a',data:{question:'첫 질문',answer:'몰라요',rootQuestionId:'a',assistance_recorded:true}}];
  let release!:()=>void;coachGate=new Promise<void>(resolve=>release=resolve);
  const receipt=await action('finish');assert.equal(receipt.status,200);assert.equal(session.state,'completed');
  assert.equal(receipt.body.session.data.trainingProgress.allRootsAnswered,false);assert.equal(receipt.body.session.data.trainingProgress.answeredRootCount,1);
  assert.equal(receipt.body.report.aiStatus,'pending');assert.equal(coachCalls,0,'AI starts only after sending the durable receipt');assert.equal(deferred.length,1);
  const work=deferred[0]();assert.equal(coachCalls,1);release();await work;assert.equal(report.data.aiStatus,'completed');
});

test('deferred feedback for an earlier report revision cannot overwrite newer corrected evidence',async()=>{
  setup({questionQueue:[{id:'a'}]});aiAvailable=true;turns=[{question_id:'a',data:{question:'질문',answer:'답변',rootQuestionId:'a',assistance_recorded:true}}];
  await action('finish');report.data.reportRevision=2;report.data.aiStatus='pending';await deferred[0]();
  assert.equal(report.data.reportRevision,2);assert.equal(report.data.aiStatus,'pending');assert.equal(report.data.aiFeedback,undefined);
});

test('feedback interrupted after receipt is retryable without duplicating recent in-flight work or another student access',async()=>{
  setup({questionQueue:[{id:'a'}]});aiAvailable=true;turns=[{question_id:'a',data:{question:'질문',answer:'답변',rootQuestionId:'a',assistance_recorded:true}}];
  await action('finish');assert.equal(deferred.length,1);assert.equal((await action('report_feedback')).status,409);assert.equal(deferred.length,1);
  report.data.aiAttemptedAt=Date.now()-61000;assert.equal((await action('report_feedback')).status,200);assert.equal(deferred.length,2);
  await deferred[1]();assert.equal(report.data.aiStatus,'completed');assert.equal(coachCalls,1);
  session.student_id='different-student';assert.equal((await action('report_feedback')).status,404);
});
