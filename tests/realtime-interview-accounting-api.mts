// Local PostgreSQL transaction; never opens a provider call or changes an existing account.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import pg from 'pg';
import ts from 'typescript';
import {loadProjectEnv,redactEnvironmentSecrets} from '../scripts/load-env.mjs';

loadProjectEnv();if(!['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname))throw Error('Local isolated database only.');
const client=new pg.Client({connectionString:process.env.DATABASE_URL}),student=randomUUID(),usage=randomUUID(),module={exports:{}as any};
vm.runInNewContext(ts.transpileModule(readFileSync('apps/web/src/lib/realtime-interview-observer.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
  module,exports:module.exports,Map,Promise,Number,JSON,Error,
  require(name:string){if(name==='server-only')return{};if(name==='openai/realtime/ws')return{OpenAIRealtimeWS:class{constructor(){throw Error('No provider calls in accounting test.');}}};if(name==='./db')return{query:async(sql:string,params:any[])=>(await client.query(sql,params)).rows};throw Error(name);},
});
try{
  await client.connect();await client.query('begin');
  await client.query("insert into profiles(id,email,name,role) values($1,$2,'isolated accounting fixture','student')",[student,`accounting-${student}@gakja.test`]);
  await client.query("insert into ai_usage_logs(id,student_id,feature,model,prompt_version,status,realtime_issued_at) values($1,$2,'interview_realtime','synthetic','synthetic','connected',now())",[usage,student]);
  const response={type:'response.done',response:{id:'dedup-response',status:'completed',usage:{input_tokens:100,output_tokens:40,input_token_details:{audio_tokens:80,cached_tokens:12},output_token_details:{audio_tokens:35}}}};
  for(let attempt=0;attempt<5;attempt++)await module.exports.recordRealtimeResponseUsage(usage,response);
  await module.exports.recordRealtimeResponseUsage(usage,{type:'conversation.item.input_audio_transcription.completed',item_id:'transcription-a',usage:{input_tokens:15,output_tokens:5}});
  const [row]=(await client.query('select input_tokens,output_tokens,realtime_usage from ai_usage_logs where id=$1',[usage])).rows;
  assert.equal(row.input_tokens,115);assert.equal(row.output_tokens,45);assert.equal(row.realtime_usage.responses,1);assert.equal(row.realtime_usage.usage_events,2);assert.equal(row.realtime_usage.finalization,'incomplete');
  const events=(await client.query('select response_id,data from interview_realtime_usage_events where usage_id=$1 order by response_id',[usage])).rows;
  assert.equal(events.length,2);assert.equal(events.find(row=>row.response_id==='dedup-response').data.input_audio_tokens,80);assert.equal(events.find(row=>row.response_id==='dedup-response').data.cached_tokens,12);
  await client.query("update ai_usage_logs set status='cleanup_pending' where id=$1",[usage]);
  await client.query("update ai_usage_logs set status='completed',realtime_closed_at=now(),realtime_usage=realtime_usage||jsonb_build_object('observed_call_ms',greatest(0,extract(epoch from(now()-realtime_issued_at))*1000)::bigint) where id=$1",[usage]);
  const[closed]=(await client.query('select input_tokens,output_tokens,realtime_usage,status from ai_usage_logs where id=$1',[usage])).rows;
  assert.equal(closed.input_tokens,115);assert.equal(closed.output_tokens,45);assert.equal(closed.status,'completed');assert.equal(closed.realtime_usage.finalization,'incomplete');assert.ok(closed.realtime_usage.observed_call_ms>=0);
  console.log(JSON.stringify({passed:12,duplicateDeliveries:5,storedUsageEvents:events.length,providerCalls:0,rolledBack:true}));
}catch(error){console.error(redactEnvironmentSecrets(error instanceof Error?error.stack:String(error)));process.exitCode=1;}
finally{await client.query('rollback').catch(()=>{});await client.end();}
