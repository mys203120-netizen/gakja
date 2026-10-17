import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { addHelpReceipt, assistanceEvidence, interviewHelpContextMatches } from '../apps/web/src/lib/assistance-records';

const scope={sessionId:'s',turnId:'t',questionId:'q',targetId:'school',contentVersion:'6',activityId:null,briefingId:null};
test('legacy false is unknown, recorded false is a new unassisted attempt',()=>{
  assert.deepEqual(assistanceEvidence({assisted:false}),{assistance_recorded:false,assisted:false,hint_used:false,helpKinds:[]});
  assert.equal(assistanceEvidence({assistance_recorded:true,assisted:false}).assistance_recorded,true);
});
test('source help cannot become student answer or correctness; repeated receipt is idempotent',()=>{
  const original={draft:'내 역할을 확인하고 싶다.',answer:null,outcome:null,assisted:false};
  const receipt={kind:'evidence' as const,receiptId:'r1',at:'2026-10-14T00:00:00Z'};
  const once=addHelpReceipt(original,receipt),twice=addHelpReceipt(once,receipt);
  assert.equal(twice.helpEvents.length,1);assert.equal(twice.assisted,true);assert.equal(twice.assistance_recorded,true);
  assert.equal(twice.answer,null);assert.equal(twice.outcome,null);assert.equal(twice.draft,original.draft);
  assert.deepEqual(original.helpEvents,undefined);
});
test('different help kinds accumulate and cannot clear a preceding hint',()=>{
  const hint=addHelpReceipt({},{kind:'hint',receiptId:'h',at:'now'});
  const ai=addHelpReceipt(hint,{kind:'ai',receiptId:'a',at:'later',threadId:'chat',messageId:'reply'});
  assert.deepEqual(ai.helpKinds,['hint','ai']);assert.equal(ai.hint_used,true);assert.equal(ai.helpEvents[1].messageId,'reply');
});
test('one AI receipt settles partial to interrupted or completed without erasing seen help',()=>{
  const partial=addHelpReceipt({answer:null},{kind:'ai',receiptId:'reply',at:'first',status:'partial'});
  const interrupted=addHelpReceipt(partial,{kind:'ai',receiptId:'reply',at:'later',status:'interrupted'});
  assert.equal(interrupted.assisted,true);assert.equal(interrupted.helpEvents.length,1);assert.equal(interrupted.helpEvents[0].at,'first');assert.equal(interrupted.helpEvents[0].status,'interrupted');
  const completed=addHelpReceipt(interrupted,{kind:'ai',receiptId:'reply',at:'complete',status:'completed'});
  const stale=addHelpReceipt(completed,{kind:'ai',receiptId:'reply',at:'late',status:'interrupted'});
  assert.equal(stale.helpEvents[0].status,'completed');assert.equal(stale.answer,null);
});
test('help has the frozen question, school, version and optional activity/briefing scope',()=>{
  const context={questionId:'q',targetId:'school',contentVersion:'6',activityId:null,briefingId:null};
  assert.equal(interviewHelpContextMatches(scope,context),true);
  for(const changed of [{questionId:'other'},{targetId:'other'},{contentVersion:'7'},{briefingId:'article'}])assert.equal(interviewHelpContextMatches(scope,{...context,...changed}),false);
  assert.equal(interviewHelpContextMatches({...scope,activityId:'a'},context),false);
  assert.equal(interviewHelpContextMatches({...scope,briefingId:'article'},{...context,briefingId:'article',questionId:null}),true);
});

class FeatureError extends Error {constructor(public status:number,message:string,public code:string){super(message);}}
const source=fs.readFileSync(new URL('../apps/web/src/lib/interview-assistance.ts',import.meta.url),'utf8');
const mod={exports:{} as Record<string,any>};
let session:any,turn:any,queries:{sql:string;params:any[]}[]=[];
async function query(sql:string,params:any[]=[]){queries.push({sql,params});if(sql.includes('from interview_sessions'))return session?.id===params[0]&&session.student_id===params[1]?[session]:[];if(sql.includes('from interview_turns'))return turn?.id===params[0]&&turn.session_id===params[1]&&turn.student_id===params[2]?[turn]:[];if(sql.startsWith('update interview_turns')){turn={...turn,data:JSON.parse(params[3])};return [turn];}throw new Error(sql);}
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:mod,exports:mod.exports,JSON,String,require(name:string){if(name==='server-only')return{};if(name==='./db')return{query};if(name==='./ai')return{FeatureError,assertPublishedAccess:async()=>{}};if(name==='./assistance-records')return{addHelpReceipt,interviewHelpContextMatches};throw new Error(name);}});
function setup(){session={id:'s',student_id:'owner',state:'active',data:{paused:true,context:{targetId:'school',contentVersion:'6',activityId:null,briefingId:null}}};turn={id:'t',session_id:'s',student_id:'owner',question_id:'q',data:{answer:null,draft:'내 초안'}};queries=[];}
const db={query:async(sql:string,params:any[])=>({rows:await query(sql,params)})};
test('foreign session or foreign turn fails before any help write',async()=>{
  setup();await assert.rejects(mod.exports.ownedInterviewHelpScope('other','s','t'),(error:any)=>error.status===404);assert.equal(queries.some(row=>row.sql.startsWith('update')),false);
  setup();turn.student_id='other';await assert.rejects(mod.exports.ownedInterviewHelpScope('owner','s','t'),(error:any)=>error.status===404);
});
test('AI help requires a paused unanswered session and refuses processing/finished turns',async()=>{
  for(const change of ['active','processing','answered','ended']){setup();if(change==='active')session.data.paused=false;if(change==='processing')session.data.processing='job';if(change==='answered')turn.data.answer='already submitted';if(change==='ended')session.state='completed';await assert.rejects(mod.exports.ownedInterviewHelpScope('owner','s','t'),(error:any)=>error.status===409);}
});
test('source can be viewed during an active turn and durable receipt survives a new reader',async()=>{
  setup();session.data.paused=false;const owned=await mod.exports.ownedInterviewHelpScope('owner','s','t',false);
  await mod.exports.recordInterviewHelp(db,'owner',owned,{kind:'evidence',receiptId:'receipt',at:'now'},false);
  const reopened=await mod.exports.ownedInterviewHelpScope('owner','s','t',false);assert.equal(reopened.turnId,'t');assert.equal(turn.data.assisted,true);assert.equal(turn.data.assistance_recorded,true);assert.equal(turn.data.draft,'내 초안');assert.equal(turn.data.answer,null);
});
test('context changes while a provider replies cannot attach help to another attempt',async()=>{
  setup();const owned=await mod.exports.ownedInterviewHelpScope('owner','s','t');session.data.context.contentVersion='7';
  await assert.rejects(mod.exports.recordInterviewHelp(db,'owner',owned,{kind:'ai',receiptId:'reply',at:'now'}),(error:any)=>error.code==='HELP_CONTEXT_MISMATCH');assert.equal(turn.data.assisted,undefined);
});
test('settling a seen partial after resume/submit changes only its receipt status',async()=>{
  setup();const owned=await mod.exports.ownedInterviewHelpScope('owner','s','t');
  await mod.exports.recordInterviewHelp(db,'owner',owned,{kind:'ai',receiptId:'reply',at:'first',status:'partial'});
  session.data.paused=false;turn.data.answer='학생이 직접 제출한 답변';
  await mod.exports.settleInterviewHelp(db,'owner',owned,{kind:'ai',receiptId:'reply',at:'later',status:'interrupted'});
  assert.equal(turn.data.answer,'학생이 직접 제출한 답변');assert.equal(turn.data.assisted,true);assert.equal(turn.data.helpEvents.length,1);assert.equal(turn.data.helpEvents[0].status,'interrupted');
  await mod.exports.settleInterviewHelp(db,'owner',owned,{kind:'ai',receiptId:'unseen',at:'later',status:'interrupted'});
  assert.equal(turn.data.helpEvents.length,1);
});
test('pending help reservation rejects a resume race without writing a help achievement',async()=>{
  setup();const owned=await mod.exports.ownedInterviewHelpScope('owner','s','t');session.data.paused=false;
  await assert.rejects(mod.exports.lockInterviewHelpScope(db,'owner',owned),(error:any)=>error.code==='SESSION_NOT_PAUSED');assert.equal(queries.some(row=>row.sql.startsWith('update')),false);
});
test('paused common question uses its common revision and original personal snapshot separately',async()=>{
  setup();session.data.context={...session.data.context,questionId:'initial-other',questions:[{id:'q',common_revision:1}],activities:[{id:'old-activity'}]};
  const owned=await mod.exports.ownedInterviewHelpScope('owner','s','t');const context=await mod.exports.ownedInterviewChatContext('owner',owned);
  assert.equal(context.questionId,'q');assert.equal(context.contentVersion,'6');assert.equal(context.questions[0].common_revision,1);assert.equal(context.activities[0].id,'old-activity');
});
