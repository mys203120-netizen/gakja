import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { randomUUID } from 'node:crypto';

/** Real helper code, an in-memory transactional DB adapter; no paid calls or production writes. */
class ApiError extends Error { constructor(public status:number,message:string){super(message);} }
const source=fs.readFileSync(new URL('../apps/web/src/lib/quiz-assistance.ts',import.meta.url),'utf8');
const mod={exports:{} as Record<string,any>};
let session:any,answered:boolean,queries:{sql:string;params:any[]}[]=[];
async function query(sql:string,params:any[]=[]){
  queries.push({sql,params});
  if(sql.startsWith('select * from quiz_sessions'))return session?.id===params[0]&&session.student_id===params[1]?[session]:[];
  if(sql.startsWith('select id from quiz_responses'))return answered&&session.id===params[0]&&session.student_id===params[1]&&params[2]===0?[{id:'saved-answer'}]:[];
  if(sql.startsWith('update quiz_sessions')){
    assert.equal(params[0],session.id);assert.equal(params[1],session.student_id);
    session={...session,metadata:JSON.parse(params[2])};return [];
  }
  throw new Error('Unexpected mock SQL: '+sql);
}
const db={query:async(sql:string,params:any[]=[])=>({rows:await query(sql,params)})};
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
  module:mod,exports:mod.exports,JSON,String,Number,Date,Set,
  require(name:string){
    if(name==='server-only')return {};
    if(name==='node:crypto')return {randomUUID};
    if(name==='./db')return {ApiError,query,transaction:async(fn:any)=>fn(db)};
    throw new Error(name);
  },
});
function setup(metadata:Record<string,any>={assistance_recorded:true}){
  session={id:'session',student_id:'owner',state:'paused',current_index:0,content_version:6,items:[{id:'memory',question_id:'q1',activity_ids:['a1'],target_id:'uos',source_kind:'personal'}],metadata:structuredClone(metadata)};
  answered=false;queries=[];
}
const facts=()=>JSON.parse(JSON.stringify(mod.exports.quizHelpFacts(session,0)));
const writes=()=>queries.filter(row=>row.sql.startsWith('update'));
const receipt=(extra:Record<string,any>={})=>({sessionId:'session',itemIndex:0,helpKind:'ai',requestId:'receipt',threadId:'thread',...extra});

test('new observed absence and legacy unknown assistance remain distinct',()=>{
  setup();assert.equal(facts().assistance_recorded,true);assert.equal(facts().assisted,false);
  setup({assistedIndices:[]});assert.equal(facts().assistance_recorded,false);assert.equal(facts().assisted,false);
  setup({assistedIndices:[0]});assert.equal(facts().assistance_recorded,true);assert.equal(facts().assisted,true);
});
test('owned help derives original saved school, version, question and activity',async()=>{
  setup({targetId:'school-fallback',targetSnapshot:{school_id:'uos',admission_year:2027}});
  const context=await mod.exports.getQuizHelpContext('owner','session',0);
  assert.equal(context.questionId,'q1');assert.equal(context.activityId,'a1');assert.equal(context.targetId,'uos');assert.equal(context.sourceVersion,6);assert.equal(context.sourceType,'personal');assert.equal(context.targetSnapshot.school_id,'uos');
  session.items[0]={...session.items[0],source_kind:'common',common_revision:4,target_snapshot:{school_id:'original'}};
  const common=await mod.exports.getQuizHelpContext('owner','session',0);
  assert.equal(common.sourceType,'common');assert.equal(common.sourceVersion,4);assert.equal(common.targetSnapshot.school_id,'original');
});
test('foreign and stale context fails before any help receipt is written',async()=>{
  setup();await assert.rejects(mod.exports.getQuizHelpContext('other','session',0),(error:any)=>error.status===404);
  await assert.rejects(mod.exports.recordQuizHelp('other',receipt(),db),(error:any)=>error.status===404);
  await assert.rejects(mod.exports.getQuizHelpContext('owner','session',99),(error:any)=>error.status===404);
  session.current_index=1;await assert.rejects(mod.exports.getQuizHelpContext('owner','session',0),(error:any)=>error.status===409);
  session.current_index=0;session.state='completed';await assert.rejects(mod.exports.getQuizHelpContext('owner','session',0),(error:any)=>error.status===409);
  assert.equal(writes().length,0);
});
test('evidence before submission produces canonical observed help, not AI or a fabricated answer',async()=>{
  setup();session.studentAnswer='학생 초안';
  const saved=await mod.exports.recordQuizHelp('owner',receipt({helpKind:'evidence'}),db);
  assert.equal(saved.recorded,true);assert.equal(saved.receipt.phase,'before_answer');
  assert.deepEqual(facts().helpKinds,['evidence']);assert.equal(facts().assisted,true);assert.equal(facts().hint_used,false);assert.equal(facts().assistance_recorded,true);
  assert.equal(session.studentAnswer,'학생 초안');assert.equal(answered,false);
  assert.equal(queries.some(row=>/insert into (?:quiz_responses|memory_attempts|study_session_events)/.test(row.sql)),false);
});
test('hint receipt is durable and duplicate request does not inflate help counts',async()=>{
  setup();const input=receipt({helpKind:'hint'});
  await mod.exports.recordQuizHelp('owner',input,db);const again=await mod.exports.recordQuizHelp('owner',input,db);
  assert.equal(again.duplicate,true);assert.equal(session.metadata.helpEvents.length,1);assert.equal(facts().hint_used,true);assert.equal(writes().length,1);
  assert.deepEqual(facts().helpKinds,['hint']);
});
test('visible partial AI output is assistance even if the response is interrupted',async()=>{
  setup();await mod.exports.recordQuizHelp('owner',receipt({status:'partial'}),db);
  assert.equal(facts().assisted,true);assert.equal(facts().helpEvents[0].status,'partial');
  const firstAt=session.metadata.helpEvents[0].at;
  await mod.exports.recordQuizHelp('owner',receipt({status:'interrupted'}),db);
  assert.equal(facts().helpEvents[0].status,'interrupted');assert.equal(session.metadata.helpEvents[0].at,firstAt);assert.equal(session.metadata.helpEvents.length,1);
});
test('partial completion upgrades one receipt and completed status cannot be downgraded',async()=>{
  setup();await mod.exports.recordQuizHelp('owner',receipt({status:'partial'}),db);
  const firstAt=session.metadata.helpEvents[0].at;
  await mod.exports.recordQuizHelp('owner',receipt({status:'completed'}),db);
  await mod.exports.recordQuizHelp('owner',receipt({status:'interrupted'}),db);
  await mod.exports.recordQuizHelp('owner',receipt({status:'partial'}),db);
  assert.equal(session.metadata.helpEvents.length,1);assert.equal(session.metadata.helpEvents[0].status,'completed');assert.equal(session.metadata.helpEvents[0].at,firstAt);
});
test('settling already visible help after submission keeps original assistance phase and student answer',async()=>{
  setup();await mod.exports.recordQuizHelp('owner',receipt({status:'partial'}),db);
  answered=true;session.state='completed';session.current_index=1;session.studentAnswer='이미 제출한 학생 답변';
  await mod.exports.recordQuizHelp('owner',receipt({status:'completed'}),db);
  assert.equal(facts().assisted,true);assert.equal(session.metadata.helpEvents[0].phase,'before_answer');assert.equal(session.metadata.helpEvents[0].status,'completed');assert.equal(session.studentAnswer,'이미 제출한 학생 답변');
});
test('new help arriving only after submission is retained without relabelling the saved attempt',async()=>{
  setup();answered=true;session.state='completed';session.current_index=1;session.studentAnswer='도움 없이 제출한 답변';
  const saved=await mod.exports.recordQuizHelp('owner',receipt({status:'completed'}),db);
  assert.equal(saved.recorded,false);assert.equal(saved.receipt.phase,'after_answer');assert.equal(session.metadata.helpEvents.length,1);
  assert.equal(facts().assisted,false);assert.equal(facts().assistance_recorded,true);assert.deepEqual(facts().helpKinds,[]);assert.equal(session.studentAnswer,'도움 없이 제출한 답변');
});
test('positive legacy hint evidence can be observed without claiming legacy absence was recorded',()=>{
  setup({hintIndices:[0]});assert.equal(facts().assistance_recorded,true);assert.equal(facts().hint_used,true);assert.equal(facts().assisted,true);
  setup({helpEvents:[{kind:'ai',itemIndex:0,phase:'after_answer',receiptId:'late'}]});assert.equal(facts().assistance_recorded,false);assert.equal(facts().assisted,false);
});
test('help kinds combine once per kind and one item cannot inherit another item receipt',async()=>{
  setup();await mod.exports.recordQuizHelp('owner',receipt({helpKind:'evidence',requestId:'evidence'}),db);await mod.exports.recordQuizHelp('owner',receipt({helpKind:'video',requestId:'video'}),db);
  session.metadata.helpEvents.push({kind:'hint',itemIndex:1,phase:'before_answer',receiptId:'other-item'});
  assert.deepEqual(facts().helpKinds,['evidence','video']);assert.equal(facts().hint_used,false);assert.equal(facts().helpEvents.length,2);
});
