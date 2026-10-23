/** node --import tsx tests/example-answer-integration.mts
 * Real localhost PostgreSQL, random schema, synthetic facts and an injected no-network provider. */
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import vm from 'node:vm';
import ts from 'typescript';
import * as model from '../apps/web/src/lib/example-answer-model';
import {loadProjectEnv,redactEnvironmentSecrets} from '../scripts/load-env.mjs';
loadProjectEnv();const connectionString=process.env.TEST_DATABASE_URL||process.env.DATABASE_URL!;
if(!['localhost','127.0.0.1'].includes(new URL(connectionString).hostname))throw Error('Local isolated test only.');
const schema='example_answer_test_'+crypto.randomUUID().replaceAll('-',''),admin=new pg.Client({connectionString});await admin.connect();
const pool=new pg.Pool({connectionString,options:`-c search_path=${schema},public`,max:8}),owner=crypto.randomUUID(),other=crypto.randomUUID();
let checks=0,providerCalls=0;const check=(value:unknown)=>{assert.ok(value);checks++;};
class ApiError extends Error{constructor(public status:number,message:string){super(message);}}
const database={ApiError,transaction:async(fn:Function)=>{const db=await pool.connect();try{await db.query('begin');const result=await fn(db);await db.query('commit');return result;}catch(error){await db.query('rollback');throw error;}finally{db.release();}}};
let refine:(_owner:string,answer:model.CompletedExample)=>Promise<model.CompletedExample>=async(_owner,answer)=>answer;
const barrier=()=>{let started!:()=>void,release!:()=>void;const begins=new Promise<void>(yes=>{started=yes;}),gate=new Promise<void>(yes=>{release=yes;});return {begins,release,run:async(_studentId:string,answer:model.CompletedExample)=>{started();await gate;return answer;}};};
try{
 await admin.query(`create schema ${schema}`);
 await pool.query(`create table profiles(id uuid primary key);
 create table interview_sessions(id uuid primary key,student_id uuid references profiles(id),state text,data jsonb);
 create table interview_reports(id uuid primary key,session_id uuid references interview_sessions(id),student_id uuid references profiles(id),data jsonb);
 create table interview_turns(id uuid primary key,session_id uuid references interview_sessions(id),student_id uuid references profiles(id),data jsonb);
 create table student_confirmations(student_id uuid references profiles(id),entity_id text,state text,data jsonb,confirmation_status text);`);
 await pool.query(await readFile(new URL('../supabase/migrations/202610230005_interview_example_requests.sql',import.meta.url),'utf8'));
 await pool.query('insert into profiles values($1),($2)',[owner,other]);
 const service:any={},source=await readFile(new URL('../apps/web/src/lib/example-answer-service.ts',import.meta.url),'utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:service,Date,JSON,Array,Error,require(name:string){if(name==='server-only')return {};if(name==='node:crypto')return crypto;if(name==='./db')return database;if(name==='./example-answer-model')return model;if(name==='./example-answer-provider')return {refineExampleAnswer:async(studentId:string,answer:model.CompletedExample)=>{assert.equal(studentId,owner);providerCalls++;return refine(studentId,answer);}};throw Error(name);}});
 async function fixture(){
  const sessionId=crypto.randomUUID(),reportId=crypto.randomUUID(),turnId=crypto.randomUUID(),activityId=crypto.randomUUID(),sourceId=crypto.randomUUID();
  const raw='저는 하천 탐구에서 채취 지점별 시료를 비교했습니다. 서로 다른 의견은 관측 조건이 같은지를 기준으로 정리했습니다. 예상과 다른 결과도 기록에 남겼습니다.';
  const context={packageId:'synthetic-package',contentVersion:1,questions:[{id:'q',activity_ids:[activityId],source_ref_ids:[sourceId]}],activities:[{id:activityId,source_ref_ids:[sourceId]}],sources:[{id:sourceId,type:'student_document',page:2,quote:'하천 시료를 비교하고 관측 조건을 기록했다.'}]};
  const section={turnId,questionId:'q',question:'의견이 달랐을 때 어떻게 조율했나요?',answer:'별도로 교정한 표시 답변.',evaluationEvidence:{answer:raw},evaluation:{needsReview:true,reason:'근거를 명확히',evidence:['시료를 비교']}};
  const data={rootQuestionId:'q',sourceIds:[sourceId],answer:'학생이 수정한 표시 답변.',rawTranscript:raw,originalAnswer:raw,evaluation:{needsReview:true,evidence:['시료를 비교']},feedback:{content:'합성 피드백'},exampleAnswers:[]};
  await pool.query('insert into interview_sessions values($1,$2,$3,$4)',[sessionId,owner,'completed',JSON.stringify({context})]);await pool.query('insert into interview_reports values($1,$2,$3,$4)',[reportId,sessionId,owner,JSON.stringify({sections:[section],summary:'합성 종합 평가'})]);await pool.query('insert into interview_turns values($1,$2,$3,$4)',[turnId,sessionId,owner,JSON.stringify(data)]);
  const detail=await service.getExampleAnswer(owner,reportId,turnId),basis=detail.basis as model.ExampleBasis;
  const input={reportId,turnId,basisHash:basis.hash,factIds:[basis.facts.find(f=>f.kind==='record')!.id,...basis.facts.filter(f=>f.kind==='utterance').map(f=>f.id)],confirmed:true,requestId:crypto.randomUUID()};
  const stable=async()=>JSON.stringify((await pool.query("select data-'exampleAnswers' as turn_data,(select data from interview_reports where id=$2) as report_data from interview_turns where id=$1",[turnId,reportId])).rows[0]);
  return {sessionId,reportId,turnId,activityId,input,stable};
 }
 const f=await fixture(),before=await f.stable();
 await assert.rejects(()=>service.getExampleAnswer(other,f.reportId,f.turnId),(e:any)=>e.status===404);checks++;
 await assert.rejects(()=>service.saveExampleAnswer(other,f.input),(e:any)=>e.status===404);checks++;
 await pool.query("update interview_sessions set state='active' where id=$1",[f.sessionId]);await assert.rejects(()=>service.saveExampleAnswer(owner,f.input),(e:any)=>e.status===409);checks++;await pool.query("update interview_sessions set state='completed' where id=$1",[f.sessionId]);
 await pool.query("update interview_turns set data=jsonb_set(data,'{invalidated}','true') where id=$1",[f.turnId]);await assert.rejects(()=>service.saveExampleAnswer(owner,f.input),(e:any)=>e.status===404);checks++;await pool.query("update interview_turns set data=data-'invalidated' where id=$1",[f.turnId]);
 await assert.rejects(()=>service.saveExampleAnswer(owner,{...f.input,basisHash:'f'.repeat(64)}),(e:any)=>e.status===409);checks++;check(providerCalls===0);check((await pool.query('select count(*)::int n from interview_example_requests')).rows[0].n===0);
 // The first transaction releases before provider latency. A concurrent retry cannot claim its lease.
 const gate=barrier();refine=gate.run;const pending=service.saveExampleAnswer(owner,f.input);await gate.begins;
 await assert.rejects(()=>service.saveExampleAnswer(owner,f.input),(e:any)=>e.status===409);checks++;check(providerCalls===1);gate.release();const first=await pending;check(first.example.version===1);check(first.duplicate===false);check(before===await f.stable());
 check((await service.saveExampleAnswer(owner,f.input)).duplicate===true);check(providerCalls===1);check((await pool.query('select status from interview_example_requests where student_id=$1 and request_id=$2',[owner,f.input.requestId])).rows[0].status==='completed');
 // Separate explicit requests may generate concurrently; the final locked history assigns unique versions.
 refine=async(_id,answer)=>answer;const versioned=await Promise.all([service.saveExampleAnswer(owner,{...f.input,requestId:crypto.randomUUID()}),service.saveExampleAnswer(owner,{...f.input,requestId:crypto.randomUUID(),factIds:[f.input.factIds[0],...f.input.factIds.slice(1).reverse()]})]);assert.deepEqual(versioned.map(item=>item.example.version).sort(),[2,3]);checks++;check(before===await f.stable());check((await service.getExampleAnswer(owner,f.reportId,f.turnId)).history.length===3);
 await assert.rejects(()=>service.saveExampleAnswer(owner,{...f.input,factIds:f.input.factIds.slice(0,-1)}),(e:any)=>e.status===409);checks++;
 // Evidence changed during generation is checked inside the final write transaction.
 const stale=await fixture(),staleGate=barrier();refine=staleGate.run;const writing=service.saveExampleAnswer(owner,stale.input);await staleGate.begins;
 await pool.query("update interview_reports set data=jsonb_set(data,'{sections,0,evaluationEvidence,answer}',to_jsonb('새로 정정된 원발화입니다.'::text)) where id=$1",[stale.reportId]);staleGate.release();await assert.rejects(()=>writing,(e:any)=>e.status===409);checks++;check((await pool.query("select jsonb_array_length(data->'exampleAnswers') n from interview_turns where id=$1",[stale.turnId])).rows[0].n===0);check((await pool.query('select status from interview_example_requests where request_id=$1',[stale.input.requestId])).rows[0].status==='failed');
 const ended=await fixture(),endGate=barrier();refine=endGate.run;const invalidating=service.saveExampleAnswer(owner,ended.input);await endGate.begins;await pool.query("update interview_turns set data=jsonb_set(data,'{invalidated}','true') where id=$1",[ended.turnId]);endGate.release();await assert.rejects(()=>invalidating,(e:any)=>e.status===404);checks++;check((await pool.query("select jsonb_array_length(data->'exampleAnswers') n from interview_turns where id=$1",[ended.turnId])).rows[0].n===0);
 // A failed provider leaves a retryable owned lease; retrying does not add a partial history version.
 const retry=await fixture();refine=async()=>{throw Error('injected provider failure');};await assert.rejects(()=>service.saveExampleAnswer(owner,retry.input),/injected provider failure/);checks++;check((await pool.query('select status from interview_example_requests where request_id=$1',[retry.input.requestId])).rows[0].status==='failed');refine=async(_id,answer)=>answer;check((await service.saveExampleAnswer(owner,retry.input)).example.version===1);
 // A reclaimed expired lease fences out the old worker, which cannot overwrite the new saved result.
 const reclaim=await fixture(),oldGate=barrier();refine=oldGate.run;const oldWorker=service.saveExampleAnswer(owner,reclaim.input);await oldGate.begins;await pool.query("update interview_example_requests set lease_until=now()-interval '1 second' where request_id=$1",[reclaim.input.requestId]);refine=async(_id,answer)=>answer;const newWorker=await service.saveExampleAnswer(owner,reclaim.input);check(newWorker.example.version===1);oldGate.release();await assert.rejects(()=>oldWorker,(e:any)=>e.status===409);checks++;check((await service.getExampleAnswer(owner,reclaim.reportId,reclaim.turnId)).history.length===1);
 // The saved ownership join also rejects an inconsistent report/session pair.
 const forged=crypto.randomUUID();await pool.query('insert into interview_reports values($1,$2,$3,$4)',[forged,f.sessionId,other,JSON.stringify({sections:[]})]);await assert.rejects(()=>service.getExampleAnswer(other,forged,f.turnId),(e:any)=>e.status===404);checks++;
 console.log(`Example answer integration: ${checks} checks passed; ${providerCalls} injected provider calls, 0 external or paid calls. Isolated real PostgreSQL.`);
}catch(error){console.error(redactEnvironmentSecrets(error instanceof Error?error.stack:error));process.exitCode=1;}
finally{await pool.end();if(!/^example_answer_test_[a-f0-9]{32}$/.test(schema))throw Error('Unsafe test schema');await admin.query(`drop schema ${schema} cascade`);await admin.end();}
