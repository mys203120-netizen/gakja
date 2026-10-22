import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import {z} from 'zod';
import * as model from '../apps/web/src/lib/thought-writing-model.ts';
import {experienceDraftSchema} from '../apps/web/src/lib/armory-model.ts';

class ApiError extends Error{constructor(public status:number,message:string){super(message);}}
const code=(file:string)=>ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const proposal={draft:'수질 기록을 비교했습니다.',followup_question:'어떤 기준으로 비교했나요?',support_quotes:['수질 기록 비교']};
function harness(){
 const state={user:{id:randomUUID(),role:'student'} as any,prefs:{calendarEditJournal:['kept'],theme:'kept'} as any,targets:new Map<string,any>(),audits:[] as any[],help:[] as any[],calls:[] as any[],queries:[] as string[],blocked:false,thread:null as any,quizEnded:false,paused:true,aiFail:false,gate:null as Promise<any>|null,context:{ownerStudentId:'student',sourceKind:'common',contentVersion:'1',targetId:null,questionId:'common_test',activityId:null,briefingId:null,questions:[{id:'common_test',prompt:'직접 한 일을 설명해 주세요.',common_revision:1}]} as any};
 async function run(sql:string,args:any[]=[]):Promise<any[]>{state.queries.push(sql);
  if(sql.startsWith('select 1 from account_data'))return state.blocked?[{blocked:1}]:[];
  if(sql.startsWith('select id,data from support_targets'))return state.targets.has(args[1])?[state.targets.get(args[1])]:[];
  if(sql.startsWith('select * from chat_threads'))return state.thread?.id===args[0]&&state.thread?.student_id===args[1]?[state.thread]:[];
  if(sql.startsWith('insert into student_preferences'))return [];
  if(sql.startsWith('select data from student_preferences'))return [{data:structuredClone(state.prefs)}];
  if(sql.startsWith('update student_preferences')){state.prefs={...state.prefs,thoughtWritingReceipts:JSON.parse(args[1])};return [];}
  if(sql.startsWith("select data->'thoughtWritingReceipts'"))return [{receipts:structuredClone(state.prefs.thoughtWritingReceipts)}];
  if(sql.startsWith('insert into audit_logs')){if(!state.audits.some(item=>item.requestId===args[2]))state.audits.push(JSON.parse(args[1]));return [];}
  if(sql.startsWith('select data from audit_logs'))return state.audits.filter(item=>item.requestId===args[1]).map(data=>({data}));
  throw Error('Unexpected SQL '+sql);
 }
 const db={query:async(sql:string,args:any[])=>({rows:await run(sql,args)})};let lock=Promise.resolve();
 async function transaction(fn:Function){const previous=lock;let release!:()=>void;lock=new Promise<void>(resolve=>release=resolve);await previous;const before=structuredClone({prefs:state.prefs,audits:state.audits,help:state.help});try{return await fn(db);}catch(error){Object.assign(state,before);throw error;}finally{release();}}
 const dependencies:Record<string,any>={
  'server-only':{},'node:crypto':{createHash,randomUUID},'./db':{ApiError,query:run,transaction},'./thought-writing-model':model,
  './ai':{assertPublishedAccess:async()=>{},getLearningContext:async()=>structuredClone(state.context)},
  './quick-start-ai':{QUICK_START_DRAFT_VERSION:'test',generateQuickStartDraft:async(studentId:string,input:any)=>{assert.equal(studentId,state.user.id);state.calls.push(input);if(state.aiFail)throw new ApiError(503,'Provider unavailable');return state.gate?await state.gate:structuredClone(proposal);},validateQuickStartDraft:(value:any,source:string,history:any[])=>{const facts=[source,...history.map(item=>item.answer)];if(value.support_quotes.some((quote:string)=>!facts.some(fact=>fact.includes(quote))))throw new ApiError(502,'Ungrounded quote');}},
  './quiz-assistance':{getQuizHelpContext:async(_owner:string,sessionId:string,itemIndex:number)=>{if(state.quizEnded)throw new ApiError(409,'Quiz ended');return {sessionId,itemIndex,questionId:'common_test',targetId:undefined,sourceType:'common',sourceVersion:1};},recordQuizHelp:async(_owner:string,input:any)=>state.help.push(input)},
  './interview-assistance':{ownedInterviewHelpScope:async()=>{if(!state.paused)throw new ApiError(409,'Interview resumed');return {sessionId:'interview',turnId:'turn'};},ownedInterviewChatContext:async()=>structuredClone(state.context),assertInterviewHelpContext:()=>{},recordInterviewHelp:async(_db:any,_owner:any,_scope:any,input:any)=>state.help.push(input)},
 };
 const module={exports:{} as any};vm.runInNewContext(code('apps/web/src/lib/thought-writing.ts'),{module,exports:module.exports,Date,JSON,Number,require:(name:string)=>{if(name in dependencies)return dependencies[name];throw Error(name);}});
 const routeModule={exports:{} as any};vm.runInNewContext(code('apps/web/src/app/api/writing/draft/route.ts'),{module:routeModule,exports:routeModule.exports,Request,Response,JSON,require:(name:string)=>{
  if(name==='@/lib/auth')return {checkOrigin:(request:Request)=>{if(request.headers.get('origin')!=='http://fixture.test')throw new ApiError(403,'Origin');},requireUser:async()=>{if(!state.user)throw new ApiError(401,'Login');return state.user;}};
  if(name==='@/lib/ai')return {requireStudent:(user:any)=>{if(user.role!=='student')throw new ApiError(403,'Student');},featureError:(error:any)=>({status:error.status||(error instanceof z.ZodError?400:500),error:error.message,code:'TEST'})};
  if(name==='@/lib/db')return {ApiError};if(name==='@/lib/thought-writing')return module.exports;throw Error(name);
 }});
 const input={kind:'experience',scopeId:randomUUID(),field:'situation',source:'수질 기록 비교',original:'',history:[],context:{},requestId:randomUUID()};
 async function post(change:Record<string,any>={},origin='http://fixture.test',signal?:AbortSignal){const response=await routeModule.exports.POST(new Request('http://fixture.test/api/writing/draft',{method:'POST',headers:{origin},body:JSON.stringify({...input,...change}),signal}));return {status:response.status,data:await response.json()};}
 return {state,input,post,service:module.exports};
}
test('writing validates authentication, origin, sizes and help scopes before any provider call',async()=>{
 for(const change of [{source:''},{source:'x'.repeat(2001)},{scopeId:'bad'},{field:undefined},{history:[{question:'왜?',answer:''}]},{context:{quizSessionId:randomUUID()}},{context:{threadId:randomUUID()}},{untrusted:true}]){const h=harness();assert.equal((await h.post(change)).status,400);assert.equal(h.state.calls.length,0);}
 const h=harness();assert.equal((await h.post({},'https://elsewhere.test')).status,403);h.state.user.role='admin';assert.equal((await h.post()).status,403);h.state.user=null;assert.equal((await h.post()).status,401);assert.equal(h.state.calls.length,0);
 const large=harness();assert.equal((await large.post({original:'x'.repeat(41000)})).status,413);
});
test('experience paragraphs use the common generator and original/history facts without saving or completing an answer',async()=>{
 const h=harness(),history=[{question:'어떤 기록?',answer:'하천 수질 기록'}],result=await h.post({original:'학교 옆 하천 기록',history});assert.equal(result.status,200);assert.equal(result.data.assisted,true);assert.equal(h.state.calls[0].thoughts,'수질 기록 비교');assert.match(h.state.calls[0].question,/2000자/);assert.equal(h.state.calls[0].history[0].answer,'학교 옆 하천 기록');assert.equal(h.state.calls[0].history[1].answer,history[0].answer);
 assert.deepEqual(h.state.prefs.calendarEditJournal,['kept']);assert.equal(h.state.prefs.theme,'kept');assert.ok(!h.state.queries.some(sql=>/insert into (experience_cards|quiz_responses|interview_turns|memory_attempts)/.test(sql)));assert.equal(h.state.help.length,0);
 const retry=await h.post({original:'학교 옆 하천 기록',history});assert.equal(retry.data.duplicate,true);assert.equal(h.state.calls.length,1);assert.equal((await h.post({source:'다른 원문'})).status,409);
});
test('parallel requests are bounded and a failed or cancelled generation remains retryable',async()=>{
 const h=harness();let finish!:(value:any)=>void;h.state.gate=new Promise(resolve=>finish=resolve);const first=h.post();while(!h.state.calls.length)await new Promise(resolve=>setImmediate(resolve));assert.equal((await h.post()).status,409);assert.equal((await h.post({requestId:randomUUID()})).status,409);finish(proposal);assert.equal((await first).status,200);
 const failed=harness();failed.state.aiFail=true;assert.equal((await failed.post()).status,503);assert.equal(failed.state.prefs.thoughtWritingReceipts[0].status,'failed');failed.state.aiFail=false;assert.equal((await failed.post()).status,200);
 const cancelled=harness(),controller=new AbortController();controller.abort();assert.equal((await cancelled.post({},undefined,controller.signal)).status,499);assert.equal(cancelled.state.audits.length,0);
});
test('ungrounded or oversized generated text is refused and an experience deleted during generation cannot reappear',async()=>{
 for(const result of [{...proposal,support_quotes:['전국 1등']},{...proposal,draft:'x'.repeat(2001)}]){const h=harness();h.state.gate=Promise.resolve(result);assert.equal((await h.post()).status,502);assert.equal(h.state.audits.length,0);}
 const h=harness();let finish!:(value:any)=>void;h.state.gate=new Promise(resolve=>finish=resolve);const pending=h.post();while(!h.state.calls.length)await new Promise(resolve=>setImmediate(resolve));h.state.blocked=true;finish(proposal);assert.equal((await pending).status,409);assert.equal(h.state.audits.length,0);
 const changed=harness();changed.state.targets.set('owned',{id:'owned',data:{university:'학교',department:'원래 학과'}});let complete!:(value:any)=>void;changed.state.gate=new Promise(resolve=>complete=resolve);const work=changed.post({context:{targetId:'owned'}});while(!changed.state.calls.length)await new Promise(resolve=>setImmediate(resolve));changed.state.targets.get('owned').data.department='다른 학과';complete(proposal);assert.equal((await work).status,409);
});
test('clearing a proposal reservation during data cleanup refuses a late result without reviving its cache',async()=>{
 const h=harness();let finish!:(value:any)=>void;h.state.gate=new Promise(resolve=>finish=resolve);const pending=h.post();while(!h.state.calls.length)await new Promise(resolve=>setImmediate(resolve));delete h.state.prefs.thoughtWritingReceipts;finish(proposal);assert.equal((await pending).status,409);assert.equal(h.state.prefs.thoughtWritingReceipts,undefined);assert.equal(h.state.audits.length,0);assert.deepEqual(h.state.prefs.calendarEditJournal,['kept']);
});
test('chat assistance remains tied to its current quiz/interview and durable metadata survives proposal-cache expiry',async()=>{
 const h=harness(),context={questionId:'common_test',sourceType:'common',sourceVersion:1,quizSessionId:randomUUID(),quizItemIndex:0};
 const result=await h.post({kind:'chat',field:undefined,scopeId:'draft-key',context});assert.equal(result.status,200);assert.equal(h.state.help[0].helpKind,'writing');assert.equal(h.state.help[0].requestId,h.input.requestId);assert.equal(h.state.context.state,undefined);
 h.state.prefs.thoughtWritingReceipts=[];const receipt=await h.service.ownedWritingReceipt(h.state.user.id,h.input.requestId,h.state.context);assert.equal(receipt.assisted,true);await assert.rejects(h.service.ownedWritingReceipt(h.state.user.id,h.input.requestId,{...h.state.context,questionId:'other'}),{status:409});
 const late=harness();let finish!:(value:any)=>void;late.state.gate=new Promise(resolve=>finish=resolve);const work=late.post({kind:'chat',field:undefined,scopeId:'draft',context});while(!late.state.calls.length)await new Promise(resolve=>setImmediate(resolve));late.state.quizEnded=true;finish(proposal);assert.equal((await work).status,409);assert.equal(late.state.help.length,0);
 const thread=harness();thread.state.thread={id:randomUUID(),student_id:'foreign',context:thread.state.context};assert.equal((await thread.post({kind:'chat',field:undefined,scopeId:'draft',context:{threadId:thread.state.thread.id}})).status,404);assert.equal(thread.state.calls.length,0);
});
test('experience drafts retain exact separate originals and assistance metadata through the normal schema',()=>{
 const value=experienceDraftSchema.parse({title:'',category:'협업',situation:'정리한 문장',action:'행동',result:'',confirmed:false,writingOriginals:{situation:'  원래 키워드\n그대로  '},writingAssistance:[{requestId:randomUUID(),field:'situation',at:new Date().toISOString()}]});assert.equal(value.writingOriginals?.situation,'  원래 키워드\n그대로  ');assert.equal(value.writingAssistance?.length,1);
});
test('using a paragraph-assisted experience carries assistance into each interview turn without an answer',()=>{
 const source=readFileSync('apps/web/src/app/api/interviews/route.ts','utf8'),file=ts.createSourceFile('route.ts',source,ts.ScriptTarget.ES2022,true),fn=file.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='rootTurn')!;
 const script=ts.transpileModule(fn.getFullText(file)+'\nmodule.exports=rootTurn;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,module={exports:null as any};vm.runInNewContext(script,{module,Boolean,entityText:(value:any,key:string)=>value[key]});
 const settings={context:{activities:[],contentVersion:'1'},panelists:[{id:'A'}],experienceCard:{data:{writingAssistance:[{requestId:randomUUID()}]}}};
 for(const index of [0,1]){const turn=module.exports({id:'q',prompt:'설명해 주세요.'},index,settings);assert.equal(turn.assisted,true);assert.equal(turn.helpKinds[0],'carried_help');assert.equal(turn.answer,null);assert.equal(turn.draft,'');}
 assert.equal(module.exports({id:'q',prompt:'설명'},0,{...settings,experienceCard:null}).assisted,false);
});
