import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {z} from 'zod';
import {streamedJsonContent} from '../apps/web/src/lib/assistant-stream-model';
class FeatureError extends Error {constructor(public status:number,message:string,public code:string){super(message);}}
const code=ts.transpileModule(readFileSync('apps/web/src/lib/quick-start-ai.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function harness(){
 const capture={requests:[] as any[],usage:[] as any[],output:{draft:'수질 기록을 비교했습니다.',followup_question:'비교할 때 어떤 기준을 맞췄나요?',support_quotes:['수질 기록 비교']} as any,available:true,fail:false,incomplete:false,wait:null as Promise<void>|null};
 const module={exports:{} as any};
 vm.runInNewContext(code,{module,exports:module.exports,require:(name:string)=>{
  if(name==='server-only')return {};if(name==='zod')return {z};if(name==='./assistant-stream-model')return {streamedJsonContent};
  if(name==='./ai')return {FeatureError,modelFor:()=> 'gpt-5.6-terra',openai:()=>{if(!capture.available)throw new FeatureError(503,'AI 연결 전','AI_NOT_CONFIGURED');return {responses:{create:async(request:any)=>{capture.requests.push(request);if(capture.fail)throw Error('provider unavailable');return(async function*(){const raw=JSON.stringify(capture.output);for(let i=0;i<raw.length;i+=7){yield {type:'response.output_text.delta',delta:raw.slice(i,i+7)};if(capture.wait&&i>=14)await capture.wait;}if(!capture.incomplete)yield {type:'response.completed',response:{status:'completed',output_text:raw,usage:{input_tokens:12,output_tokens:8}}};})();}}};},reserveUsage:async()=>{capture.usage.push('pending');return 'usage';},completeUsage:async(_id:string,status:string)=>capture.usage.push(status)};
  throw Error(name);
 }});return {capture,generate:module.exports.generateQuickStartDraft,validate:module.exports.validateQuickStartDraft};
}
test('free thoughts and all prior student answers are grounded without inventing facts or revealing review notes',async()=>{
 const h=harness(),input={sessionId:'session',question:'내 역할을 말해 주세요.',thoughts:'수질 기록 비교',history:[{question:'계기는?',answer:'하천이 궁금했음'}]},deltas:string[]=[];
 const result=await h.generate('student',input,{onDelta:(value:string)=>deltas.push(value)}),request=h.capture.requests[0];
 assert.equal(request.stream,true);assert.equal(request.store,false);assert.equal(request.text.format.strict,true);
 assert.deepEqual(JSON.parse(request.input[0].content),{question:input.question,student_thoughts:input.thoughts,history:input.history});assert.match(request.instructions,/새로운 활동·직책·학년·학교·상·성과·수치·행동·감정·배운 점·지원 동기를 만들어 추가하지 않는다/);assert.match(request.instructions,/꼬리물음 하나/);
 assert.equal(deltas.join(''),result.draft);assert.equal(Object.hasOwn(result,'review_note'),false);assert.deepEqual(h.capture.usage,['pending','completed']);
});
test('genuine provider deltas arrive before completion, and a partial never bypasses final grounding validation',async()=>{
 const h=harness(),deltas:string[]=[];let release!:()=>void;h.capture.wait=new Promise(resolve=>release=resolve);
 const work=h.generate('student',{sessionId:'session',question:'역할?',thoughts:'수질 기록 비교'},{onDelta:(value:string)=>deltas.push(value)});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(h.capture.usage.includes('completed'),false);assert.ok(deltas.length>0,'visible provider text precedes completion');release();await work;assert.equal(deltas.join(''),h.capture.output.draft);
 const invalid=harness();invalid.capture.output.support_quotes=['1등 수상'];await assert.rejects(invalid.generate('student',{sessionId:'session',question:'역할?',thoughts:'수질 기록 비교'}),{code:'THOUGHT_DRAFT_INVALID'});assert.deepEqual(invalid.capture.usage,['pending','failed']);
});
test('empty drafts can ask one natural follow-up but empty/malformed/oversized complete proposals are rejected',()=>{
 const h=harness();assert.equal(h.validate({draft:'',followup_question:'어떤 일이 있었나요?',support_quotes:['잘 모르겠음']},'잘 모르겠음').draft,'');
 for(const value of [{draft:'',followup_question:null,support_quotes:['수질 기록 비교']},{...h.capture.output,draft:'x'.repeat(8001)},{...h.capture.output,followup_question:''},{...h.capture.output,support_quotes:[]},{...h.capture.output,review_note:'불필요'}])assert.throws(()=>h.validate(value,'수질 기록 비교'),{code:'THOUGHT_DRAFT_INVALID'});
});
test('failure, cancellation and incomplete provider output cannot become valid drafts',async()=>{
 const input={sessionId:'session',question:'역할?',thoughts:'수질 기록 비교'};const h=harness();h.capture.fail=true;await assert.rejects(h.generate('student',input),{code:'THOUGHT_DRAFT_FAILED'});
 const incomplete=harness();incomplete.capture.incomplete=true;await assert.rejects(incomplete.generate('student',input),{code:'THOUGHT_DRAFT_INCOMPLETE'});
 const aborted=harness(),controller=new AbortController();controller.abort();await assert.rejects(aborted.generate('student',input,{signal:controller.signal}),{code:'THOUGHT_DRAFT_CANCELLED'});
 const unavailable=harness();unavailable.capture.available=false;await assert.rejects(unavailable.generate('student',input),{status:503});assert.equal(unavailable.capture.requests.length,0);assert.equal(unavailable.capture.usage.length,0);
});
