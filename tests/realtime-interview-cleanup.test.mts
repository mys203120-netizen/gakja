import assert from 'node:assert/strict';
import test from 'node:test';
import {cleanupInterviewRealtime} from '../scripts/cleanup-interview-realtime.mjs';
const context='interview-rt:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:0:00000000-0000-4000-8000-000000000003:';

test('scheduled cleanup hangs up only server-recorded expired interview calls then settles exact owned rows',async()=>{
  const requests:any[]=[],queries:any[]=[];const result=await cleanupInterviewRealtime({apiKey:'synthetic-key',query:async(sql:string,params:any[])=>{queries.push({sql,params});return sql.startsWith('select')?{rows:[{id:'usage-a',student_id:'student-a',context_id:context+'rtc_owned'}]}:{rows:[]};},request:async(url:string,options:any)=>{requests.push({url,options});return new Response(null,{status:404});}});
  assert.deepEqual(result,{scanned:1,completed:1,failed:0,invalid:0});assert.ok(queries[0].sql.includes("created_at<now()-interval '4 minutes'"));assert.ok(queries[0].sql.includes("feature='interview_realtime'"));assert.ok(queries[0].sql.includes('limit 100'));assert.equal(requests[0].url,'https://api.openai.com/v1/realtime/calls/rtc_owned/hangup');assert.deepEqual(queries[1].params,['usage-a','student-a']);assert.ok(!JSON.stringify(result).includes('synthetic-key'));
});

test('scheduled cleanup keeps transient failures retryable and rejects arbitrary provider identifiers',async()=>{
  const queries:any[]=[],requests:string[]=[];const result=await cleanupInterviewRealtime({apiKey:'synthetic-key',query:async(sql:string,params:any[])=>{queries.push({sql,params});return sql.startsWith('select')?[{id:'usage-a',student_id:'student-a',context_id:context+'rtc_retry'},{id:'bad',student_id:'student-a',context_id:'https://evil.example/rtc_foreign'}]:[];},request:async(url:string)=>{requests.push(url);return new Response(null,{status:503});}});
  assert.deepEqual(result,{scanned:2,completed:0,failed:1,invalid:1});assert.equal(requests.length,1);assert.equal(queries.length,2);
});

test('missing server credential prevents both DB and provider work',async()=>{
  let calls=0;await assert.rejects(()=>cleanupInterviewRealtime({apiKey:'',query:async()=>{calls++;return[];},request:async()=>{calls++;return new Response();}}));assert.equal(calls,0);
});
