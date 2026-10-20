import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import {z} from 'zod';
import {readQuickStartStream} from '../apps/web/src/lib/quick-start-stream';

class ApiError extends Error {constructor(public status:number,message:string){super(message);}}
const id=randomUUID(),studentId=randomUUID(),question={id:'common-item',question_id:'common_motivation',source_kind:'common',prompt:'지원 동기를 내 경험과 연결해 말해 주세요.',target_id:null};
const proposal={draft:'하천 수질 기록을 정리하며 환경공학에 관심을 갖게 되었습니다.',support_quotes:['하천 수질 기록 정리'],followup_question:'어떤 기록을 비교했나요?'};
const code=ts.transpileModule(readFileSync('apps/web/src/app/api/quick-start/draft/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;

function harness(){
  const state={user:{id:studentId,role:'student'} as any,session:{id,student_id:studentId,mode:'answer',state:'active',current_index:0,items:[{...question}],metadata:{} as any},target:null as any,aiFailure:false,aiCalls:[] as any[],help:[] as any[],sql:[] as string[],generation:null as Promise<any>|null,deltas:[] as string[],deltaBeforeWait:false};
  const db={query:async(sql:string,args:any[])=>{
    state.sql.push(sql);
    if(sql.startsWith('select * from quiz_sessions'))return {rows:args[0]===state.session.id&&args[1]===state.session.student_id?[structuredClone(state.session)]:[]};
    if(sql.startsWith('select id,data from support_targets'))return {rows:state.target?[structuredClone(state.target)]:[]};
    if(sql.startsWith('update quiz_sessions')){assert.equal(args[0],state.session.id);assert.equal(args[1],studentId);state.session.metadata=JSON.parse(args[2]);return {rows:[]};}
    throw Error('Unexpected SQL '+sql);
  }};
  let lock=Promise.resolve();
  const transaction=async(fn:Function)=>{const previous=lock;let release!:()=>void;lock=new Promise<void>(resolve=>release=resolve);await previous;try{return await fn(db);}finally{release();}};
  const mod={exports:{} as any};
  vm.runInNewContext(code,{module:mod,exports:mod.exports,Request,Response,ReadableStream,TextEncoder,AbortController,URL,Date,JSON,require:(name:string)=>{
    if(name==='node:crypto')return {createHash};if(name==='zod')return {z};
    if(name==='@/lib/auth')return {requireUser:async()=>{if(!state.user)throw new ApiError(401,'로그인해 주세요.');return state.user;},checkOrigin:(request:Request)=>{if(request.headers.get('origin')!=='http://fixture.test')throw new ApiError(403,'허용되지 않은 요청');}};
    if(name==='@/lib/db')return {ApiError,transaction};
    if(name==='@/lib/ai')return {requireStudent:(user:any)=>{if(user.role!=='student')throw new ApiError(403,'학생 계정');},featureError:(error:any)=>({status:error.status||(error instanceof z.ZodError?400:500),error:error.message,code:'TEST'})};
    if(name==='@/lib/quick-start-ai')return {QUICK_START_DRAFT_VERSION:'dialogue-test',generateQuickStartDraft:async(owner:string,input:any,options:any={})=>{assert.equal(owner,studentId);state.aiCalls.push(input);if(state.aiFailure)throw new ApiError(503,'AI 연결을 준비 중이에요.');if(state.deltaBeforeWait)for(const delta of state.deltas)await options.onDelta?.(delta);const result=state.generation?await state.generation:proposal;if(!state.deltaBeforeWait)for(const delta of state.deltas)await options.onDelta?.(delta);return result;}};
    if(name==='@/lib/quiz-assistance')return {recordQuizHelp:async(owner:string,input:any)=>{assert.equal(owner,studentId);state.help.push(input);state.session.metadata.assistedIndices=[0];}};
    if(name==='@/lib/school-quiz')return {schoolQuizTargetIdentity:(target:any)=>target};
    if(name==='@/lib/school-learning')return {schoolLearningIdentityMatches:(left:any,right:any)=>left?.university===right?.university};
    throw Error(name);
  }});
  const input={sessionId:id,targetId:null as string|null,thoughts:'하천 수질 기록 정리',history:[],requestId:randomUUID()};
  const response=(change:Record<string,any>={},origin='http://fixture.test')=>mod.exports.POST(new Request('http://fixture.test/api/quick-start/draft',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({...input,...change})}));
  const post=async(change:Record<string,any>={},origin='http://fixture.test')=>{const result=await response(change,origin);return {status:result.status,data:await result.json()};};
  const get=(change:Record<string,string>={})=>mod.exports.GET(new Request('http://fixture.test/api/quick-start/draft?'+new URLSearchParams({sessionId:input.sessionId,requestId:input.requestId,...change})));
  return {state,input,post,response,get};
}

test('only an owned current common one-question text session can generate a draft',async()=>{
  for(const mutate of [(s:any)=>s.user=null,(s:any)=>s.user.role='admin',(s:any)=>s.session.student_id='someone-else',(s:any)=>s.session.mode='choice',(s:any)=>s.session.items[0].source_kind='personal',(s:any)=>s.session.state='completed',(s:any)=>s.session.items.push({...question}),(s:any)=>s.session.current_index=1]){
    const h=harness();mutate(h.state);const result=await h.post();assert.ok([400,401,403,404,409].includes(result.status));assert.equal(h.state.aiCalls.length,0);
  }
  const h=harness();assert.equal((await h.post({},'https://elsewhere.test')).status,403);assert.equal(h.state.aiCalls.length,0);
});

test('empty, oversized and untrusted request fields are rejected before generation',async()=>{
  for(const change of [{thoughts:''},{thoughts:' '},{thoughts:'x'.repeat(40001)},{history:[{question:'질문',answer:''}]},{question:'조작된 질문'},{requestId:'bad'}]){
    const h=harness();assert.equal((await h.post(change)).status,400);assert.equal(h.state.aiCalls.length,0);
  }
});

test('successful generation records writing help without submitting or overwriting a student answer',async()=>{
  const h=harness(),result=await h.post();assert.equal(result.status,200);assert.equal(result.data.assisted,true);assert.equal(result.data.proposal.draft,proposal.draft);
  assert.equal(h.state.aiCalls[0].question,question.prompt);assert.equal(h.state.aiCalls[0].thoughts,h.input.thoughts);assert.deepEqual(h.state.aiCalls[0].history,[]);
  assert.equal(h.state.session.state,'active');assert.equal(h.state.session.metadata.drafts,undefined);
  assert.equal(h.state.help[0].helpKind,'writing');assert.equal(h.state.help[0].requestId,h.input.requestId);
  assert.deepEqual(h.state.session.metadata.assistedIndices,[0]);
  assert.ok(!h.state.sql.some(sql=>sql.includes('insert into quiz_responses')||sql.includes('memory_attempts')));
});

test('a lost response retries the same request without another AI call or assistance receipt',async()=>{
  const h=harness();assert.equal((await h.post()).status,200);const duplicate=await h.post();
  assert.equal(duplicate.status,200);assert.equal(duplicate.data.duplicate,true);assert.equal(h.state.aiCalls.length,1);assert.equal(h.state.help.length,1);
  assert.equal((await h.post({thoughts:'다른 사실'})).status,409);assert.equal(h.state.aiCalls.length,1);
});

test('concurrent clicks cannot generate twice for the same current question',async()=>{
  const h=harness();let finish!:Function;h.state.generation=new Promise(resolve=>finish=resolve);
  const first=h.post();while(!h.state.aiCalls.length)await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await h.post()).status,409);assert.equal((await h.post({requestId:randomUUID()})).status,409);assert.equal(h.state.aiCalls.length,1);
  finish(proposal);assert.equal((await first).status,200);
});

test('AI failure remains retryable without recording help or consuming the answer',async()=>{
  const h=harness();h.state.aiFailure=true;assert.equal((await h.post()).status,503);assert.equal(h.state.help.length,0);assert.equal(h.state.session.metadata.quickStartDrafts[0].status,'failed');
  h.state.aiFailure=false;assert.equal((await h.post()).status,200);assert.equal(h.state.aiCalls.length,2);assert.equal(h.state.help.length,1);
});

test('a changed school or completed answer rejects a result arriving after generation began',async()=>{
  for(const mutate of [(s:any)=>s.session.state='completed',(s:any)=>s.session.metadata.targetId='new-school']){
    const h=harness();let finish!:Function;h.state.generation=new Promise(resolve=>finish=resolve);
    const first=h.post();while(!h.state.aiCalls.length)await new Promise(resolve=>setImmediate(resolve));mutate(h.state);finish(proposal);
    assert.equal((await first).status,409);assert.equal(h.state.help.length,0);assert.equal(h.state.session.metadata.quickStartDrafts[0].status,'failed');
  }
});

test('current target ownership and identity are rechecked on a school-scoped request',async()=>{
  const h=harness();h.state.session.metadata={targetId:'target',targetSnapshot:{university:'서울시립대학교'}};h.state.session.items[0].target_id='target' as any;
  assert.equal((await h.post({targetId:'target'})).status,409);assert.equal(h.state.aiCalls.length,0);
  h.state.target={id:'target',data:{university:'서울시립대학교'}};assert.equal((await h.post({targetId:'target'})).status,200);
  h.state.target.data.university='건국대학교';assert.equal((await h.post({targetId:'target'})).status,409);
});


test('free prose has no line or entry count limit and prior student answers accompany a refinement',async()=>{
 const h=harness(),thoughts=Array(30).fill('생각나는 내용을 자유롭게 적음').join('\n'),history=Array.from({length:80},(_,i)=>({question:'꼬리물음 '+i,answer:'학생의 이전 답 '+i}));
 assert.equal((await h.post({thoughts,history})).status,200);assert.equal(h.state.aiCalls[0].history.length,80);assert.equal(h.state.aiCalls[0].thoughts,thoughts);
});

test('actual SSE exposes model deltas before a validated result, and writes partial assistance before display',async()=>{
 const h=harness();let finish!:Function;h.state.generation=new Promise(resolve=>finish=resolve);h.state.deltas=['하천 기록을'];h.state.deltaBeforeWait=true;
 const response=await h.response({stream:true});assert.match(response.headers.get('content-type')||'',/text\/event-stream/);
 const events:any[]=[];const reading=readQuickStartStream(response,event=>{events.push(event);if(event.type==='delta')assert.equal(h.state.help[0].status,'partial');});
 while(!events.some(event=>event.type==='delta'))await new Promise(resolve=>setImmediate(resolve));assert.equal(events.some(event=>event.type==='done'),false);assert.equal(h.state.session.metadata.drafts,undefined);
 finish(proposal);await reading;assert.equal(events.at(-1).type,'done');assert.equal(events.at(-1).proposal.draft,proposal.draft);assert.deepEqual(h.state.help.map(help=>help.status),['partial','completed']);
 const recovered=await h.get();assert.equal((await recovered.json()).proposal.draft,proposal.draft);h.state.user.id=randomUUID();assert.equal((await h.get()).status,404);
});

test('cancelled streamed previews remain interrupted help and never become saved student answers',async()=>{
 const h=harness();let finish!:Function;h.state.generation=new Promise(resolve=>finish=resolve);h.state.deltas=['중간 미리보기'];h.state.deltaBeforeWait=true;
 const response=await h.response({stream:true}),reader=response.body!.getReader();await reader.read();await reader.read();await reader.cancel();finish(proposal);
 for(let i=0;i<8&&h.state.session.metadata.quickStartDrafts[0].status==='pending';i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.state.session.metadata.quickStartDrafts[0].status,'failed');assert.deepEqual(h.state.help.map(help=>help.status),['partial','interrupted']);assert.equal(h.state.session.metadata.drafts,undefined);assert.equal(h.state.session.state,'active');
});
