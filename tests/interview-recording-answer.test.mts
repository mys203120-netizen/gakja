import * as interviewPolicyModule from '../apps/web/src/lib/interview-policy';
import * as interviewFeedbackModule from '../apps/web/src/lib/interview-feedback';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import * as timer from '../apps/web/src/lib/interview-timer';
import * as provenance from '../apps/web/src/lib/transcript-provenance';
import * as assistance from '../apps/web/src/lib/assistance-records';
import * as interviewScope from '../apps/web/src/lib/school-interview-scope';

// Execute the production route and owned-media resolver. Only SQL/auth/provider
// boundaries are synthetic; transactions serialize and roll back like the DB.
const require=createRequire(import.meta.url),sessionId=randomUUID(),turnId=randomUUID(),mediaId=randomUUID();
const raw='음, 저는 설문 문항을 정했습니다. 결과를 비교했습니다.';
const display='음, 저는 설문 문항을 정했습니다.\n결과를 비교했습니다.';
class FeatureError extends Error{constructor(public status:number,message:string,public code='TEST'){super(message);}}
let state:any,tail=Promise.resolve();
const ai={FeatureError,requireStudent(){},assertPublishedAccess:async()=>{},aiEnabled:()=>state.ai,
  getLearningContext:async()=>({...state.session.data.context,target:null,targetId:null,sourceKind:'personal',packageId:'fixture-package',questions:state.session.data.questionQueue}),
  normalizeMode:(mode:string)=>mode,interviewQuestions:(context:any)=>context.questions,planRootQuestions:(questions:any[],count:number)=>({questions:questions.slice(0,count),plan:{basis:'training'}}),
  entityText:(value:any,key:string)=>value[key]||'',PROMPT_VERSION:'synthetic-test',
  coach:async(...args:any[])=>{state.coachCalls.push(args);if(state.coachGate)await state.coachGate;return {content:state.coachContent||'그 선택을 한 이유는 무엇인가요?',sources:[],model:'synthetic-provider',promptVersion:'fixture'};},
  featureError:(error:any)=>({status:error.status||(error.name==='ZodError'?400:500),error:error.message,code:error.code})};
async function query(sql:string,args:any[]=[]):Promise<any[]>{
  if(sql.startsWith('select')&&sql.includes('from interview_sessions'))return state.session.id===args[0]&&state.session.student_id===args[1]?[structuredClone(state.session)]:[];
  if(sql.startsWith('select')&&sql.includes('from interview_turns')){
    let rows=state.turns.filter((row:any)=>row.session_id===args[0]&&row.student_id===args[1]);
    if(sql.includes("data->>'answer' is null"))rows=rows.filter((row:any)=>!row.data.answer&&!row.data.invalidated).slice(-1);
    return structuredClone(rows);
  }
  if(sql.startsWith('select')&&sql.includes('from media_assets'))return structuredClone(state.assets.filter((row:any)=>row.id===args[0]&&row.student_id===args[1]&&row.session_id===args[2]&&row.metadata.turnId===args[3]&&row.metadata.kind==='answer_recording'));
  if(sql.startsWith('select'))return [];
  if(sql.startsWith('insert into interview_sessions')){
    state.session={id:randomUUID(),student_id:args[0],kind:args[1],mode:args[2],target_id:args[3],content_version:args[4],data:JSON.parse(args[5]),request_id:args[6],state:'active'};state.writes++;return [structuredClone(state.session)];
  }
  if(sql.startsWith('update interview_sessions')){
    const owner=sql.includes('student_id=$3')?args[2]:args[1];if(state.session.id!==args[0]||state.session.student_id!==owner)return [];
    const data=JSON.parse(sql.includes('data=$2')?args[1]:args[2]);state.session.data=sql.includes(' || ')?{...state.session.data,...data}:data;
    if(sql.includes("state='cancelled'"))state.session.state='cancelled';state.writes++;
    return [structuredClone(state.session)];
  }
  if(sql.startsWith('update interview_turns')){
    const index=state.turns.findIndex((row:any)=>row.id===args[0]);if(index<0)return [];
    const row=state.turns[index];
    if(sql.includes('question_id=$2')){row.question_id=args[1];row.data=JSON.parse(args[2]);}
    else row.data=JSON.parse(sql.includes('data=$2')?args[1]:args[2]);
    state.writes++;return [structuredClone(row)];
  }
  if(sql.startsWith('insert into interview_turns')){
    const explicit=args.length===5,row={id:explicit?args[0]:randomUUID(),session_id:args[explicit?1:0],student_id:args[explicit?2:1],question_id:args[explicit?3:2],data:JSON.parse(args[explicit?4:3])};state.turns.push(row);state.writes++;return [structuredClone(row)];
  }
  return [];
}
const database={query,transaction:async(fn:any)=>{
  const previous=tail;let release!:()=>void;tail=new Promise<void>(resolve=>release=resolve);await previous;
  const backup=structuredClone({session:state.session,turns:state.turns,assets:state.assets,events:state.events,writes:state.writes});
  try{return await fn({query:async(sql:string,args:any[])=>({rows:await query(sql,args)})});}
  catch(error){Object.assign(state,backup);throw error;}finally{release();}
}};
function load(file:string){const mod={exports:{} as any};vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
  module:mod,exports:mod.exports,Response,Request,URL,Date,console,process:{env:{}},
  require(name:string){if(name==='@/lib/interview-policy')return interviewPolicyModule;if(name==='@/lib/interview-feedback')return interviewFeedbackModule;
    if(name==='server-only')return {};
    if(name==='@/lib/auth')return {requireUser:async()=>({id:state.actor,role:'student'}),checkOrigin(){}};
    if(name==='@/lib/db')return database;
    if(name==='@/lib/ai'||name==='./ai')return ai;
    if(name==='@/lib/interview-timer')return timer;
    if(name==='@/lib/transcript-provenance')return provenance;
    if(name==='@/lib/assistance-records')return assistance;
    if(name==='@/lib/school-interview-scope')return interviewScope;
    if(name==='@/lib/interview-transcript-selection')return transcript;
    if(name==='@/lib/study-sessions')return {recordStudyEvent:async(_db:any,_owner:string,event:any)=>{state.events.push(structuredClone(event));}};
    if(name.startsWith('@/'))return {};
    return require(name);
  },
});return mod.exports;}
const transcript=load('apps/web/src/lib/interview-transcript-selection.ts');
const route=load('apps/web/src/app/api/interviews/route.ts');
function reset(){
  tail=Promise.resolve();state={actor:'owner',ai:false,coachCalls:[],events:[],writes:0,
    session:{id:sessionId,student_id:'owner',kind:'video',mode:'basic',state:'active',data:{context:{ownerStudentId:'owner',contentVersion:'7',targetId:'target',target:{id:'target'},activities:[],questions:[]},generation:3,index:0,elapsedMs:0,activeSince:Date.now(),timerLeaseUntil:Date.now()+30000,paused:false,followups:false,feedbackTiming:'end',questionQueue:[{id:'q1',prompt:'맡은 역할은 무엇인가요?'},{id:'q2',prompt:'배운 점은 무엇인가요?'}],panelists:[{id:'A'},{id:'B'}]}},
    turns:[{id:turnId,session_id:sessionId,student_id:'owner',question_id:'q1',data:{question:'맡은 역할은 무엇인가요?',rootIndex:0,followupDepth:0,speakerId:'A',answer:null,draft:'',assistance_recorded:true,helpKinds:[],assisted:false}}],
    assets:[{id:mediaId,student_id:'owner',session_id:sessionId,text:raw,metadata:{kind:'answer_recording',turnId,generation:3,transcriptionStatus:'completed',displayTranscript:display,transcriptCleanup:{status:'completed',rawHash:createHash('sha256').update(raw).digest('hex'),modelId:'synthetic-verbatim',promptVersion:'fixture'}}}]};
}
const payload=()=>({action:'answer_recording',sessionId,turnId,mediaId,generation:3,requestId:'auto-request-fixture'});
async function call(overrides:Record<string,unknown>={}){const response=await route.POST(new Request('http://fixture.test/api/interviews',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload(),...overrides})}));return {status:response.status,body:await response.json()};}

test('recording submission uses the server transcript and keeps raw speech provenance before the next speaker',async()=>{
  reset();const response=await call();assert.equal(response.status,200,JSON.stringify(response.body));
  const turn=state.turns[0].data;assert.equal(turn.answer,display);assert.equal(turn.originalAnswer,display);assert.equal(turn.rawTranscript,raw);
  assert.deepEqual(turn.speechSource,{rawText:raw,displayText:display,submittedText:display,mediaId,cleanupStatus:'completed',cleanupModel:'synthetic-verbatim',cleanupPromptVersion:'fixture',rawHash:createHash('sha256').update(raw).digest('hex'),studentEdited:false});
  assert.equal(turn.transcriptSelection,'automatic');assert.equal(turn.submissionSource,'recording');assert.equal(turn.submittedGeneration,3);assert.equal(turn.answerRevisions.length,1);assert.equal(turn.transcriptRevisions,undefined);
  assert.equal(state.events.length,1);assert.equal(state.events[0].data.answer,display);assert.equal(response.body.nextQuestion.id,'q2');assert.equal(response.body.nextQuestion.speakerId,'B');assert.equal(state.assets[0].text,raw);
});
test('automatic submission accepts a formatter-owned draft but never replaces manual edits',async()=>{
  reset();Object.assign(state.turns[0].data,{draft:display,displayTranscript:display,autoTranscriptApplied:true,mediaId});assert.equal((await call()).status,200);
  reset();state.turns[0].data.draft='다른 탭에서 작성한 답변';const response=await call();assert.equal(response.body.code,'ANSWER_DRAFT_CHANGED');assert.equal(state.writes,0);assert.equal(state.turns[0].data.draft,'다른 탭에서 작성한 답변');
});
test('failed, silent, pending, invalid-hash and old-generation recordings cannot submit',async()=>{
  const cases=[(a:any)=>a.metadata.transcriptionStatus='failed',(a:any)=>a.metadata.transcriptionErrorCode='NO_SPEECH_DETECTED',(a:any)=>a.metadata.transcriptCleanup.status='pending',(a:any)=>a.text='',(a:any)=>a.metadata.transcriptCleanup.rawHash='wrong',(a:any)=>a.metadata.generation=2,(a:any)=>delete a.metadata.generation];
  for(const mutate of cases){reset();mutate(state.assets[0]);const result=await call();assert.equal(result.status,409,JSON.stringify(result.body));assert.equal(state.writes,0);assert.equal(state.events.length,0);assert.equal(state.turns[0].data.answer,null);}
});
test('foreign assets, other turns, paused sessions, stale generations and Chat mode cannot auto-submit',async()=>{
  const cases:[()=>void,number,string][]=[
    [()=>state.assets[0].student_id='foreign',404,'TRANSCRIPT_MEDIA_NOT_FOUND'],[()=>state.assets[0].metadata.turnId=randomUUID(),404,'TRANSCRIPT_MEDIA_NOT_FOUND'],
    [()=>state.session.data.paused=true,409,'SESSION_PAUSED'],[()=>state.session.data.timerLeaseUntil=Date.now()-1,409,'SESSION_PAUSED'],
    [()=>state.session.data.generation=4,409,'STALE_GENERATION'],[()=>state.session.kind='chat',409,'TRANSCRIPT_MODE_REQUIRED'],[()=>state.actor='foreign',404,'SESSION_NOT_FOUND']];
  for(const [mutate,status,code] of cases){reset();mutate();const result=await call();assert.equal(result.status,status);assert.equal(result.body.code,code);assert.equal(state.writes,0);}
  reset();assert.equal((await call({turnId:randomUUID()})).body.code,'STALE_TURN');assert.equal(state.writes,0);
});
test('automatic submissions require their full capture scope and reject supplied answer text',async()=>{
  for(const key of ['turnId','mediaId','generation','requestId']){reset();assert.equal((await call({[key]:undefined})).body.code,'RECORDING_ANSWER_SCOPE_REQUIRED');assert.equal(state.writes,0);}
  reset();assert.equal((await call({answer:'client injected replacement'})).body.code,'RECORDING_ANSWER_TEXT_FORBIDDEN');assert.equal(state.writes,0);
});
test('concurrent retries submit once and durable receipts remain recoverable after pause or completion',async()=>{
  reset();const results=await Promise.all([call(),call()]);assert.ok(results.every(result=>result.status===200));assert.equal(state.events.length,1);assert.equal(state.turns.length,2);
  const writes=state.writes;state.session.data.paused=true;assert.equal((await call()).status,200);assert.equal(state.writes,writes);
  state.session.state='completed';const completed=await call();assert.equal(completed.status,200);assert.equal(completed.body.nextQuestion,null);assert.equal(state.writes,writes);
  assert.equal((await call({mediaId:randomUUID()})).body.code,'REQUEST_CONFLICT');assert.equal(state.writes,writes);
});
test('follow-up generation receives the saved transcript and cannot overwrite a later cancellation generation',async()=>{
  reset();state.ai=true;state.session.data.followups=true;let release!:()=>void;state.coachGate=new Promise<void>(resolve=>release=resolve);
  const pending=call();while(!state.coachCalls.length)await new Promise(resolve=>setTimeout(resolve,0));
  assert.ok(state.coachCalls[0][3][0].content.includes(raw));
  const cancel=await call({action:'cancel'});assert.equal(cancel.status,200);release();const result=await pending;assert.equal(result.status,200);
  assert.equal(state.session.state,'cancelled');assert.equal(state.session.data.paused,true);assert.equal(state.session.data.generation,4);assert.equal(state.turns[1].question_id,'q2');assert.equal(state.events.length,1);assert.equal(result.body.nextQuestion,null);
  reset();state.ai=true;state.session.data.followups=true;const generated=await call();assert.equal(generated.status,200);assert.equal(generated.body.nextQuestion.questionKind,'generated');assert.equal(generated.body.nextQuestion.speakerId,'A');assert.equal(state.turns[1].data.parentTurnId,turnId);
});
test('suspending while feedback is pending keeps the saved answer but never restarts its timer',async()=>{
  reset();state.ai=true;state.session.data.followups=true;let release!:()=>void;state.coachGate=new Promise<void>(resolve=>release=resolve);
  const pending=call();while(!state.coachCalls.length)await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal((await call({action:'suspend'})).status,200);release();const result=await pending;
  assert.equal(result.status,200);assert.equal(result.body.session.data.paused,true);assert.equal(result.body.session.data.activeSince,null);assert.equal(result.body.session.data.timerLeaseUntil,null);assert.equal(state.events.length,1);
});
test('Live timer resume preserves a saved capture while Chat resume and explicit pause still invalidate it',async()=>{
  reset();assert.equal((await call({action:'suspend'})).status,200);assert.equal(state.session.data.generation,3);
  assert.equal((await call({action:'resume'})).status,200);assert.equal(state.session.data.generation,3);assert.equal(state.session.data.paused,false);assert.equal((await call()).status,200);
  reset();state.session.kind='chat';state.session.data.paused=true;assert.equal((await call({action:'resume'})).status,200);assert.equal(state.session.data.generation,4);
  reset();assert.equal((await call({action:'pause'})).status,200);assert.equal(state.session.data.generation,4);assert.equal((await call({action:'resume'})).status,200);assert.equal(state.session.data.generation,4);assert.equal((await call({generation:4})).body.code,'STALE_GENERATION');
  reset();state.session.data.paused=true;state.session.data.processing='pending-provider';state.session.data.processingAt=Date.now();assert.equal((await call({action:'resume'})).body.code,'INTERVIEW_PENDING');assert.equal(state.session.data.paused,true);assert.equal(state.session.data.generation,3);
});
test('a repeated Live resume retains the saved recording generation and submits it once',async()=>{
  reset();
  for(let attempt=0;attempt<3;attempt++){
    const result=await call({action:'resume'});
    assert.equal(result.status,200);assert.equal(state.session.data.generation,3);assert.equal(state.session.data.paused,false);
  }
  assert.equal((await call()).status,200);assert.equal(state.events.length,1);
  assert.equal((await call()).status,200);assert.equal(state.events.length,1);
});
test('new Live sessions exclude room setup time; Chat sessions retain their running timer',async()=>{
  for(const kind of ['video','chat']){
    reset();const result=await call({action:'start',kind,mode:'basic',turnId:undefined,mediaId:undefined,generation:undefined,requestId:randomUUID()});assert.equal(result.status,200,JSON.stringify(result.body));
    const data=result.body.session.data;assert.equal(data.paused,kind==='video');assert.equal(data.elapsedMs,0);assert.equal(data.generation,0);
    if(kind==='video'){assert.equal(data.activeSince,null);assert.equal(data.timerLeaseUntil,null);}else{assert.equal(typeof data.activeSince,'number');assert.ok(data.timerLeaseUntil>Date.now());}
  }
});
test('manual text submission continues to use the student answer without a media selection',async()=>{
  reset();const result=await call({action:'answer',answer:'직접 입력한 답변',mediaId:undefined,generation:undefined});assert.equal(result.status,200);assert.equal(state.turns[0].data.answer,'직접 입력한 답변');assert.equal(state.turns[0].data.speechSource,undefined);
});


test('real policy rejects help, typing, correction and retry before writes or paid work',async()=>{
 for(const action of ['help','answer','draft','settings','retry','use_transcript','transcript']){reset();state.session.data.sessionMode='real';const result=await call({action,answer:'작성 답변',draft:'초안',transcript:'수정'});assert.equal(result.status,403,action);assert.equal(result.body.code,'REAL_INTERVIEW_POLICY');assert.equal(state.writes,0);assert.equal(state.coachCalls.length,0);}
});
test('real recording evaluation is stored but not released before completion',async()=>{
 reset();state.session.data.sessionMode='real';state.ai=true;const result=await call();assert.equal(result.status,200,JSON.stringify(result.body));assert.ok(state.turns[0].data.feedback);assert.equal(result.body.feedback,null);assert.equal(result.body.turn.feedback,null);assert.equal(result.body.turn.data.feedback,null);assert.equal(result.body.turn.evaluation,null);
});
test('practice retry versions draft evidence and retains the original media',async()=>{
 reset();Object.assign(state.turns[0].data,{draft:'이전 초안',rawTranscript:raw,rawTranscriptMediaId:mediaId,mediaId});const result=await call({action:'retry'});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(state.session.data.generation,4);assert.equal(state.session.data.paused,true);assert.equal(state.turns[0].data.draft,'');assert.equal(state.turns[0].data.attempts[0].rawTranscript,raw);assert.equal(state.assets[0].id,mediaId);assert.equal(state.assets[0].text,raw);
});
test('follow-up ceilings apply to ordinary and pressure sessions and sufficient answers advance',async()=>{
 for(const [pressure,depth,expected] of [[false,1,1],[true,1,2],[true,2,1]] as const){reset();state.ai=true;state.session.data.followups=true;state.session.data.pressure=pressure;state.turns[0].data.followupDepth=depth;await call();assert.equal(state.coachCalls.length,expected);}
 reset();state.ai=true;state.session.data.followups=true;state.coachContent='[NEXT]';const result=await call();assert.equal(result.body.nextQuestion.id,'q2');
});
