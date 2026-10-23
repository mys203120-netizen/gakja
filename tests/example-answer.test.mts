import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as crypto from 'node:crypto';
import {z} from 'zod';
import * as model from '../apps/web/src/lib/example-answer-model.ts';
import {renderReportExport} from '../apps/web/src/lib/report-export.ts';

const owner='00000000-0000-4000-8000-000000000010',reportId='00000000-0000-4000-8000-000000000011',turnId='00000000-0000-4000-8000-000000000012';
const raw='음, 저는 하천 탐구에서 채취 지점별 시료를 비교했습니다. 서로 다른 의견은 관측 조건이 같은지를 기준으로 정리했습니다. 예상과 다른 결과도 기록에 남겼습니다.';
function fixture(){return {section:{reportId,turnId,questionId:'q',question:'의견이 달랐을 때 어떻게 조율했나요?',answer:'완전히 다듬은 표시 답변입니다.',evaluationEvidence:{answer:raw}},turn:{rootQuestionId:'q',sourceIds:['record'],answer:'수정 답변'},context:{packageId:'p',contentVersion:1,questions:[{id:'q',activity_ids:['activity'],source_ref_ids:['record','talent']}],activities:[{id:'activity',source_ref_ids:['record']}],sources:[{id:'record',type:'student_document',page:2,quote:'하천 시료를 비교하고 관측 조건을 기록했다.'},{id:'talent',type:'school_talent',quote:'근거 중심의 탐구 인재'},{id:'foreign-record',type:'student_document',quote:'연결되지 않은 다른 활동이다.'}]},confirmations:[] as any[]};}
function request(basis:model.ExampleBasis){return {reportId,turnId,basisHash:basis.hash,factIds:[basis.facts.find(f=>f.kind==='record')!.id,...basis.facts.filter(f=>f.kind==='utterance').map(f=>f.id)],confirmed:true as const,requestId:'00000000-0000-4000-8000-000000000013'};}

test('the complete answer basis pins the report raw utterance and linked record only',()=>{
 const value=fixture(),basis=model.exampleAnswerBasis(value);assert.equal(basis.blocked,false);assert.equal(basis.facts.filter(f=>f.kind==='utterance').length,3);assert.ok(basis.facts.some(f=>f.text.startsWith('음, 저는')));assert.ok(basis.facts.every(f=>!f.text.includes('다듬은')&&!f.text.includes('연결되지 않은')&&!f.text.includes('인재')));assert.equal(basis.facts.find(f=>f.kind==='record')?.page,2);
});
test('a completed example is a finished paragraph of confirmed actual claims with exact citations, never a replacement for the original',()=>{
 const value=fixture(),before=structuredClone(value),basis=model.exampleAnswerBasis(value),input=request(basis),answer=model.completeEvidenceAnswer(basis,input,{id:'result',version:1,at:'2026-10-23T01:00:00Z'});
 assert.equal(answer.answer,raw.replace(/^음, /,''));assert.equal(answer.sentences.length,3);assert.equal(answer.citations.length,4);assert.equal(answer.method,'confirmed_extracts');assert.deepEqual(value,before);assert.equal(answer.confirmedAt,answer.createdAt);
 const reverse={...input,factIds:[input.factIds[0],...input.factIds.slice(1).reverse()]};assert.ok(model.completeEvidenceAnswer(basis,reverse,{id:'x',version:2,at:'now'}).answer.startsWith('예상과 다른'));
});
test('foreign facts, duplicates, missing confirmation, missing record and stale bases fail before saving',()=>{
 const basis=model.exampleAnswerBasis(fixture()),input=request(basis),meta={id:'x',version:1,at:'now'};
 assert.throws(()=>model.exampleRequestSchema.parse({...input,confirmed:false}));assert.throws(()=>model.exampleRequestSchema.parse({...input,answer:'대신 쓸 문장'}));
 assert.throws(()=>model.completeEvidenceAnswer(basis,{...input,factIds:[...input.factIds,'outside']},meta));assert.throws(()=>model.completeEvidenceAnswer(basis,{...input,factIds:[input.factIds[0],input.factIds[0]]},meta));assert.throws(()=>model.completeEvidenceAnswer(basis,{...input,factIds:input.factIds.slice(1)},meta));
 assert.throws(()=>model.completeEvidenceAnswer(basis,{...input,basisHash:'f'.repeat(64)},meta));
 const changed=fixture();changed.section.evaluationEvidence.answer+=' 추가 발화.';assert.notEqual(model.exampleAnswerBasis(changed).hash,basis.hash);
});
test('unconfirmed conflicting activity facts and a source-less question cannot become a first-person example',()=>{
 for(const status of ['student_says_different','cannot_confirm','needs_confirmation']){const f=fixture();f.confirmations=[{entity_id:'activity',confirmation_status:status}];const basis=model.exampleAnswerBasis(f);assert.equal(basis.blocked,true);assert.throws(()=>model.completeEvidenceAnswer(basis,request(basis),{id:'x',version:1,at:'now'}));}
 const f=fixture();f.context.sources=f.context.sources.filter(value=>value.type!=='student_document');assert.equal(model.exampleAnswerBasis(f).blocked,true);
 for(const state of ['different','unknown','cannot_confirm']){const value=fixture();value.confirmations=[{entity_id:'activity',state,confirmation_status:null}];assert.equal(model.exampleAnswerBasis(value).blocked,true);}
 for(const confirmation of [{entity_id:'q',state:'cannot_confirm'},{entity_id:'q',state:'open',data:{is_correction:true}},{entity_id:'record',state:'responded',data:{is_correction:true}}]){const value=fixture();value.confirmations=[confirmation];assert.equal(model.exampleAnswerBasis(value).blocked,true);}
 const reviewed=fixture();reviewed.confirmations=[{entity_id:'activity',state:'confirmed',confirmation_status:'needs_confirmation'}];assert.equal(model.exampleAnswerBasis(reviewed).blocked,false);
 const ocr=fixture();Object.assign(ocr.context.sources[0],{quote_basis:'student_reviewed_transcription',verification_status:'student_reviewed_transcription',text_revision:3});assert.match(model.exampleAnswerBasis(ocr).facts.find(f=>f.kind==='record')!.label,/학생이 확인한 인식문 3차 · 2쪽/);
});
test('report download escapes complete examples and makes a changed basis visible',()=>{
 const html=renderReportExport({title:'검수',interviews:[{data:{sections:[{question:'질문',exampleAnswer:{version:2,answer:'<script>alert(1)</script>',note:'원답변 보존',stale:true,citations:[{label:'생기부 <2>',text:'<img src=x onerror=alert(1)>'}]}}]}}]});assert.ok(html.includes('완성 예시답변 · 2차'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<img src=x'));assert.ok(html.includes('사실 확인 내용이 바뀐'));
});

function serviceHarness(refine?:(answer:any)=>Promise<any>){
 const f=fixture(),state={owner,sessionState:'completed',invalidated:false,updates:0,lease:null as any,report:{id:reportId,session_id:'session',data:{sections:[f.section]},session_data:{context:f.context}},turn:{id:turnId,data:{...f.turn,exampleAnswers:[] as any[]}}};
 class ApiError extends Error{constructor(public status:number,message:string){super(message);}}
 async function query(sql:string,args:any[]=[]):Promise<{rows:any[]}>{
  if(sql.includes('from interview_reports'))return {rows:args[1]===state.owner&&args[0]===reportId?[{...structuredClone(state.report),session_state:state.sessionState}]:[]};
  if(sql.includes('from interview_turns'))return {rows:args[0]===turnId?[{...structuredClone(state.turn),data:{...structuredClone(state.turn.data),invalidated:state.invalidated}}]:[]};
  if(sql.includes('from student_confirmations'))return {rows:f.confirmations};
  if(sql.startsWith('insert into interview_example_requests')){if(state.lease?.request_id===args[1])return {rows:[]};state.lease={request_id:args[1],report_id:args[2],turn_id:args[3],basis_hash:args[4],fact_ids:JSON.parse(args[5]),lease_token:args[6],status:'processing',active:true};return {rows:[state.lease]};}
  if(sql.includes('from interview_example_requests'))return {rows:state.lease&&(!sql.includes("status='processing'")||state.lease.status==='processing'&&state.lease.lease_token===args[2])?[state.lease]:[]};
  if(sql.startsWith('update interview_example_requests')){if(state.lease){if(sql.includes("status='completed'"))state.lease.status='completed';else if(sql.includes("status='failed'"))state.lease.status='failed';else{state.lease.status='processing';state.lease.lease_token=args[2];}}return {rows:[]};}
  if(sql.startsWith('update interview_turns')){state.updates++;state.turn.data.exampleAnswers=JSON.parse(args[2]);return {rows:[]};}
  throw Error(sql);
 }
 const exports:any={},module={exports};vm.runInNewContext(ts.transpileModule(readFileSync('apps/web/src/lib/example-answer-service.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports,require(name:string){if(name==='server-only')return {};if(name==='./db')return {ApiError,transaction:async(fn:Function)=>fn({query})};if(name==='./example-answer-model')return model;if(name==='./example-answer-provider')return {refineExampleAnswer:async(_owner:string,answer:any)=>refine?refine(answer):answer};if(name==='node:crypto')return crypto;throw Error(name);},Date,JSON,Array,Error});return {state,service:module.exports};
}
test('completed owned reports save versioned examples idempotently without changing the report, answer or evaluation',async()=>{
 const h=serviceHarness(),before=structuredClone(h.state.report),detail=await h.service.getExampleAnswer(owner,reportId,turnId),input=request(detail.basis),result=await h.service.saveExampleAnswer(owner,input);assert.equal(result.example.version,1);assert.equal(h.state.updates,1);assert.equal((await h.service.saveExampleAnswer(owner,input)).duplicate,true);assert.equal(h.state.updates,1);assert.deepEqual(h.state.report,before);assert.equal(h.state.turn.data.answer,'수정 답변');
 const second=await h.service.saveExampleAnswer(owner,{...input,requestId:crypto.randomUUID(),factIds:[input.factIds[0],...input.factIds.slice(1).reverse()]});assert.equal(second.example.version,2);
 await assert.rejects(h.service.saveExampleAnswer(owner,{...input,factIds:input.factIds.slice(0,-1)}),(e:any)=>e.status===409);
});
test('another owner, active session, invalidated turn and changed basis are rejected without a write',async()=>{
 const h=serviceHarness(),detail=await h.service.getExampleAnswer(owner,reportId,turnId),input=request(detail.basis);
 await assert.rejects(h.service.saveExampleAnswer('other',input),(e:any)=>e.status===404);h.state.sessionState='active';await assert.rejects(h.service.saveExampleAnswer(owner,input),(e:any)=>e.status===409);h.state.sessionState='completed';h.state.invalidated=true;await assert.rejects(h.service.saveExampleAnswer(owner,input),(e:any)=>e.status===404);h.state.invalidated=false;await assert.rejects(h.service.saveExampleAnswer(owner,{...input,basisHash:'a'.repeat(64)}),(e:any)=>e.status===409);assert.equal(h.state.updates,0);
});

function providerHarness(output:unknown,enabled=true){
 const calls:any[]=[],usage:string[]=[],tokens:any[]=[];class FeatureError extends Error{constructor(public status:number,message:string){super(message);}}
 const exports:any={},module={exports};vm.runInNewContext(ts.transpileModule(readFileSync('apps/web/src/lib/example-answer-provider.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports,require(name:string){if(name==='server-only')return {};if(name==='zod')return {z};if(name==='./ai')return {FeatureError,aiEnabled:()=>enabled,modelFor:()=> 'configured-interview-model',reserveUsage:async()=>{usage.push('reserved');return 'u';},completeUsage:async(_id:string,state:string,value:any)=>{usage.push(state);tokens.push(value);},openai:()=>({responses:{create:async(value:any)=>{calls.push(value);return {status:'completed',output_text:JSON.stringify(output),usage:{input_tokens:120,output_tokens:45}};}}})};throw Error(name);},JSON,Map,Set,Error});return {provider:module.exports,calls,usage,tokens};
}
test('AI examples send only confirmed facts, retain sentence citations, account for usage and disable provider storage',async()=>{
 const basis=model.exampleAnswerBasis(fixture()),original=model.completeEvidenceAnswer(basis,request(basis),{id:'x',version:1,at:'now'}),spoken=original.citations.filter(f=>f.kind==='utterance');
 const h=providerHarness({sentences:spoken.map(f=>({text:f.text.replace(/^음, /,''),fact_ids:[f.id]}))});const result=await h.provider.refineExampleAnswer(owner,original);
 assert.equal(result.method,'grounded_rewrite');assert.equal(h.calls[0].store,false);assert.equal(h.calls[0].model,'configured-interview-model');const sent=JSON.parse(h.calls[0].input[0].content);assert.deepEqual(sent.confirmed_facts,original.citations);assert.ok(!JSON.stringify(sent).includes('foreign-record'));assert.deepEqual(h.usage,['reserved','completed']);assert.ok(result.sentences.every((s:any)=>s.factIds.length));
 const off=providerHarness(null,false);assert.equal((await off.provider.refineExampleAnswer(owner,original)).method,'confirmed_extracts');assert.equal(off.calls.length,0);assert.equal(off.usage.length,0);
});
test('AI output cannot cite unknown facts, use record-only role claims, or persist malformed incomplete output',async()=>{
 const basis=model.exampleAnswerBasis(fixture()),original=model.completeEvidenceAnswer(basis,request(basis),{id:'x',version:1,at:'now'}),record=original.citations.find(f=>f.kind==='record')!,spoken=original.citations.find(f=>f.kind==='utterance')!;
 for(const facts of [['outside'],[record.id]]){const h=providerHarness({sentences:[{text:'입력에 없는 내용을 완성했다고 말합니다.',fact_ids:facts},{text:spoken.text,fact_ids:[spoken.id]}]});assert.equal((await h.provider.refineExampleAnswer(owner,original)).method,'confirmed_extracts');assert.deepEqual(h.usage,['reserved','completed_with_fallback']);}
 const h=providerHarness({answer:'문장 근거 없음'});assert.equal((await h.provider.refineExampleAnswer(owner,original)).answer,original.answer);assert.deepEqual(h.usage,['reserved','completed_with_fallback']);assert.deepEqual(h.tokens,[{input_tokens:120,output_tokens:45}]);
});
test('new numbers and explicit new roles fall back to confirmed extracts even with otherwise valid citation IDs',async()=>{
 const basis=model.exampleAnswerBasis(fixture()),original=model.completeEvidenceAnswer(basis,request(basis),{id:'x',version:1,at:'now'}),spoken=original.citations.find(f=>f.kind==='utterance')!;
 for(const text of ['저는 팀장으로 전국 대회에서 우승했습니다.','관측을 100회 시행하고 결과를 98% 개선했습니다.','저는 새로운 실험 방법을 개발하고 연구를 설계했습니다.']){const h=providerHarness({sentences:[{text,fact_ids:[spoken.id]},{text:spoken.text,fact_ids:[spoken.id]}]});assert.equal((await h.provider.refineExampleAnswer(owner,original)).answer,original.answer);}
 const denied={...original,citations:original.citations.map(f=>f.id===spoken.id?{...f,text:'저는 반복 측정을 하지 않았고 수치도 기억나지 않습니다.'}:f)};const h=providerHarness({sentences:[{text:'반복 측정을 통해 수치를 기록했습니다.',fact_ids:[spoken.id]},{text:spoken.text,fact_ids:[spoken.id]}]});assert.equal((await h.provider.refineExampleAnswer(owner,denied)).method,'confirmed_extracts');
 for(const denial of ['저는 실험을 직접 안 했습니다.','저는 실험 담당이 아닙니다.','측정한 것은 제가 아니었습니다.']){const input={...original,citations:original.citations.map(f=>f.id===spoken.id?{...f,text:denial}:f)};assert.equal((await h.provider.refineExampleAnswer(owner,input)).method,'confirmed_extracts');}
});
test('same request in flight reserves one provider call; changed facts during generation cannot save',async()=>{
 let release!:(value:any)=>void,started!:(value?:any)=>void;const start=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);let calls=0;
 const h=serviceHarness(async answer=>{calls++;started();await gate;return answer;}),input=request((await h.service.getExampleAnswer(owner,reportId,turnId)).basis),pending=h.service.saveExampleAnswer(owner,input);await start;
 await assert.rejects(h.service.saveExampleAnswer(owner,input),(e:any)=>e.status===409);assert.equal(calls,1);release(null);await pending;assert.equal(h.state.updates,1);assert.equal(h.state.lease.status,'completed');
 const stale=serviceHarness(async answer=>{stale.state.report.data.sections[0].evaluationEvidence.answer+=' 근거 변경.';return answer;});const value=request((await stale.service.getExampleAnswer(owner,reportId,turnId)).basis);await assert.rejects(stale.service.saveExampleAnswer(owner,value),(e:any)=>e.status===409);assert.equal(stale.state.updates,0);assert.equal(stale.state.lease.status,'failed');
});
