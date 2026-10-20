import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const require=createRequire(import.meta.url);
const studentId='00000000-0000-4000-8000-000000000001',sessionId='00000000-0000-4000-8000-000000000002',turnId='00000000-0000-4000-8000-000000000003',attemptId='00000000-0000-4000-8000-000000000004',callId='rtc_interview_test';
const sdp='v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',input={sessionId,turnId,attemptId,generation:2,consent:true,sdp};
class FeatureError extends Error{constructor(public status:number,message:string,public code='FAILED'){super(message);}}
function harness(){
  const state={active:true,session:{state:'active',kind:'video',session_data:{context:{targetId:'owned-target'},generation:2,paused:false,processing:null,activeSince:Date.now()-1000,timerLeaseUntil:Date.now()+30000},turn_id:turnId,turn_data:{question:'이 활동에서 본인의 역할은 무엇이었나요?',speakerId:'B'}},logs:[] as any[],fetches:[] as any[],queries:[] as any[],access:0,dailyLimit:false,published:true,failAccounting:false,afterFetch:null as (()=>void)|null,upstreamStatus:201,upstreamSdp:sdp,upstreamLocation:`/v1/realtime/calls/${callId}`,hangupStatus:200,upstreamFailure:false,env:{OPENAI_API_KEY:'synthetic-never-return',REALTIME_INTERVIEW_ENABLED:'true'} as Record<string,string>};
  let lock=Promise.resolve();
  const query=async(sql:string,params:any[])=>{
    state.queries.push({sql,params});
    if(sql.startsWith('select s.id'))return state.active&&params[1]===studentId?[structuredClone(state.session)]:[];
    if(sql.startsWith('select count(*)')){const rows=state.logs.filter(row=>row.studentId===params[0]&&row.feature===params[1]);return [{count:rows.filter(row=>!row.old).length,attempt_count:rows.filter(row=>row.contextId===params[2]||row.contextId.startsWith(params[2]+':')).length}];}
    if(sql.startsWith('select id,context_id'))return state.logs.filter(row=>row.studentId===params[0]&&row.feature===params[1]&&row.status==='connected'&&(!sql.includes("interval '4 minutes'")||row.expired)).map(row=>({...row,context_id:row.contextId}));
    if(sql.startsWith('select id,status'))return state.logs.filter(row=>row.studentId===params[0]&&row.feature===params[1]&&row.contextId===params[2]);
    if(sql.startsWith('update ai_usage_logs')){if(state.failAccounting)throw Error('accounting unavailable');const row=state.logs.find(row=>row.id===params[0]&&row.studentId===params[1]);if(row){row.contextId=params[2];row.status=params[3];}return [];}
    throw Error('unexpected SQL '+sql);
  };
  const apiModule={exports:{} as any};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../apps/web/src/lib/realtime-interview.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
    module:apiModule,exports:apiModule.exports,process:{env:state.env},Response,Request,FormData,TextDecoder,Uint8Array,AbortSignal,Error,URL,Date,
    fetch:async(url:string,options:any)=>{state.fetches.push({url,options});if(url.endsWith('/hangup'))return new Response(null,{status:state.hangupStatus});state.afterFetch?.();if(state.upstreamFailure)throw Error('vendor secret');return new Response(state.upstreamSdp,{status:state.upstreamStatus,headers:state.upstreamLocation?{location:state.upstreamLocation}:{}});},
    require(dependency:string){
      if(dependency==='server-only')return {};
      if(dependency==='./db')return {query};
      if(dependency==='./recording-transcription')return {withRecordingTranscriptionLock:async(_key:string,work:()=>Promise<unknown>)=>{const result=lock.then(work);lock=result.then(()=>{},()=>{});return result;}};
      if(dependency==='./ai')return {FeatureError,aiEnabled:()=>Boolean(state.env.OPENAI_API_KEY),assertPublishedAccess:async()=>{state.access++;if(!state.published)throw new FeatureError(403,'학교 연결을 확인해 주세요.','ACCESS_DENIED');},reserveUsage:async(id:string,feature:string,contextId:string,model:string)=>{if(state.dailyLimit)throw new FeatureError(429,'한도','AI_DAILY_LIMIT');const usageId=`usage-${state.logs.length}`;state.logs.push({id:usageId,studentId:id,feature,contextId,model,status:'pending',created_at:new Date().toISOString()});return usageId;},completeUsage:async(id:string,status:string)=>{const row=state.logs.find(row=>row.id===id);if(row)row.status=status;}};
      return require(dependency);
    },
  });
  return {state,api:apiModule.exports,start:(candidate:any=input,actor=studentId,signal=new AbortController().signal)=>apiModule.exports.startInterviewRealtime(actor,candidate,signal)};
}

test('interview RTC uses owned current server question, a fixed output model and no browser credential',async()=>{
  const h=harness(),result=await h.start();assert.equal(result.callId,callId);assert.equal(result.question.prompt,h.state.session.turn_data.question);assert.equal(result.question.speakerId,'B');assert.equal(result.question.digest.length,64);assert.ok(!JSON.stringify(result).includes(h.state.env.OPENAI_API_KEY));
  const request=h.state.fetches[0],session=JSON.parse(request.options.body.get('session'));assert.equal(request.url,'https://api.openai.com/v1/realtime/calls');assert.equal(session.model,'gpt-realtime-2.1');assert.deepEqual(session.output_modalities,['audio']);assert.deepEqual(session.tools,[]);assert.equal(session.audio.input.turn_detection.create_response,false);assert.equal(session.audio.input.turn_detection.interrupt_response,false);assert.equal(session.audio.input.transcription.language,'ko');assert.equal(session.audio.output.voice,'marin');assert.equal(result.responseEvent.response.conversation,'none');assert.deepEqual(JSON.parse(JSON.stringify(result.responseEvent.response.input)),[]);assert.equal(result.responseEvent.response.metadata.turn_id,turnId);assert.equal(result.responseEvent.response.metadata.attempt_id,attemptId);assert.equal(h.state.logs[0].status,'connected');assert.equal(h.state.access,2);
  assert.ok(h.state.queries[0].sql.includes("p.role='student'"));assert.ok(h.state.queries[0].sql.includes('p.active=true'));assert.ok(h.state.queries[0].sql.includes("data->>'answer' is null"));
});

test('RTC feature is off by default and missing consent/foreign fields/invalid audio SDP fail strictly',async()=>{
  const h=harness();delete h.state.env.REALTIME_INTERVIEW_ENABLED;assert.equal(h.api.realtimeInterviewEnabled(),false);await assert.rejects(()=>h.start(),(e:any)=>e.code==='REALTIME_INTERVIEW_DISABLED');assert.equal(h.state.fetches.length,0);
  for(const change of [{consent:false},{sdp:'v=0\r\nm=video 9 bad'},{sdp:'x'.repeat(60001)},{question:'browser injected question'},{generation:-1},{attemptId:'not-uuid'}])assert.equal(h.api.realtimeInterviewInput.safeParse({...input,...change}).success,false);
  assert.equal(h.api.realtimeInterviewCloseInput.safeParse({sessionId,turnId,generation:2,attemptId,callId:'../foreign'}).success,false);
});

test('JSON body validates actual streamed bytes and media type before parsing',async()=>{
  const h=harness();await assert.rejects(()=>h.api.readRealtimeInterviewBody(new Request('http://localhost',{method:'POST',body:'{}'})),(e:any)=>e.status===415);
  await assert.rejects(()=>h.api.readRealtimeInterviewBody(new Request('http://localhost',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'가'.repeat(34000)})})),(e:any)=>e.status===413);
  await assert.rejects(()=>h.api.readRealtimeInterviewBody(new Request('http://localhost',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'})),(e:any)=>e.status===400);
});

test('foreign student, ended/paused/processing/expired and stale turn/generation never incur paid calls',async()=>{
  for(const change of [{state:'completed'},{kind:'chat'},{session_data:{paused:true}},{session_data:{processing:'pending'}},{session_data:{timerLeaseUntil:1}},{turn_id:'other'},{session_data:{generation:3}}]){const h=harness();const {session_data,...top}=change as any;Object.assign(h.state.session,top);Object.assign(h.state.session.session_data,session_data);await assert.rejects(()=>h.start(),(e:any)=>e.status===409);assert.equal(h.state.logs.length,0);assert.equal(h.state.fetches.length,0);}
  const h=harness();await assert.rejects(()=>h.start(input,'foreign-student'),(e:any)=>e.status===404);assert.equal(h.state.fetches.length,0);
});

test('a published-school access failure prevents provider negotiation',async()=>{const h=harness();h.state.published=false;await assert.rejects(()=>h.start(),(e:any)=>e.status===403);assert.equal(h.state.logs.length,0);assert.equal(h.state.fetches.length,0);});

test('one concurrent attempt reserves once, including duplicate attempts outside the minute window',async()=>{
  const h=harness(),results=await Promise.allSettled([h.start(),h.start()]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(h.state.fetches.length,1);h.state.logs[0].old=true;await assert.rejects(()=>h.start(),(e:any)=>e.code==='REALTIME_INTERVIEW_ATTEMPT_USED');assert.equal(h.state.logs.length,1);
});

test('daily AI and six-per-minute quotas gate paid requests',async()=>{
  const a=harness();a.state.dailyLimit=true;await assert.rejects(()=>a.start(),(e:any)=>e.code==='AI_DAILY_LIMIT');assert.equal(a.state.fetches.length,0);
  const b=harness();for(let i=0;i<6;i++)b.state.logs.push({studentId,feature:'interview_realtime',contextId:`other-${i}`,status:'failed'});await assert.rejects(()=>b.start(),(e:any)=>e.code==='REALTIME_INTERVIEW_RATE_LIMIT');assert.equal(b.state.fetches.length,0);
});

test('pause-resume within the same generation or question mutation during handshake closes remote call',async()=>{
  for(const change of [(h:ReturnType<typeof harness>)=>{h.state.session.session_data.activeSince=Date.now()+1;},(h:ReturnType<typeof harness>)=>{h.state.session.turn_data.question='변경된 질문';},(h:ReturnType<typeof harness>)=>{h.state.active=false;}]){const h=harness();h.state.afterFetch=()=>change(h);await assert.rejects(()=>h.start(),(e:any)=>['REALTIME_INTERVIEW_CHANGED','REALTIME_INTERVIEW_NOT_FOUND'].includes(e.code));assert.equal(h.state.logs[0].status,'failed');assert.ok(h.state.fetches.some(call=>call.url.endsWith('/hangup')));}
});

test('aborted handshake and invalid provider SDP never escape a stale response',async()=>{
  for(const setup of [(h:ReturnType<typeof harness>,c:AbortController)=>{h.state.afterFetch=()=>c.abort();},(h:ReturnType<typeof harness>)=>{h.state.upstreamSdp='malformed provider secret';},(h:ReturnType<typeof harness>)=>{h.state.failAccounting=true;}]){const h=harness(),c=new AbortController();setup(h,c);await assert.rejects(()=>h.start(input,studentId,c.signal),(e:any)=>e.status===499||e.status===502);assert.ok(h.state.fetches.some(call=>call.url.endsWith('/hangup')));assert.equal(h.state.logs[0].status,'failed');}
});

test('provider errors are sanitized and foreign cleanup URLs are never followed',async()=>{
  for(const change of [{upstreamStatus:503},{upstreamFailure:true},{upstreamLocation:'https://evil.example/v1/realtime/calls/rtc_foreign'}]){const h=harness();Object.assign(h.state,change);await assert.rejects(()=>h.start(),(e:any)=>e.status===502&&!e.message.includes('secret'));assert.ok(h.state.fetches.every(call=>call.url.startsWith('https://api.openai.com/v1/realtime/calls')));}
});

test('close belongs to exact student/session/turn/generation/attempt and is idempotent while paused',async()=>{
  const h=harness();await h.start();const close={sessionId,turnId,generation:2,attemptId,callId};for(const [actor,candidate]of [['other',close],[studentId,{...close,generation:3}],[studentId,{...close,turnId:attemptId}],[studentId,{...close,attemptId:sessionId}]])await assert.rejects(()=>h.api.closeInterviewRealtime(actor,candidate),(e:any)=>e.status===404);
  h.state.session.session_data.paused=true;await h.api.closeInterviewRealtime(studentId,close);await h.api.closeInterviewRealtime(studentId,close);assert.equal(h.state.logs[0].status,'completed');assert.equal(h.state.fetches.filter(call=>call.url.endsWith('/hangup')).length,1);
});

test('heartbeat hangs up expired/paused/new activation calls and transient hangup can be retried',async()=>{
  for(const change of [(h:ReturnType<typeof harness>)=>{h.state.logs[0].created_at=new Date(Date.now()-250000).toISOString();},(h:ReturnType<typeof harness>)=>{h.state.session.session_data.paused=true;},(h:ReturnType<typeof harness>)=>{h.state.session.session_data.activeSince=Date.now()+1;}]){const h=harness();await h.start();change(h);await assert.rejects(()=>h.api.heartbeatInterviewRealtime(studentId,{sessionId,turnId,generation:2,attemptId,callId}));assert.equal(h.state.logs[0].status,'completed');}
  const h=harness();await h.start();h.state.hangupStatus=503;await assert.rejects(()=>h.api.closeInterviewRealtime(studentId,{sessionId,turnId,generation:2,attemptId,callId}),(e:any)=>e.code==='REALTIME_INTERVIEW_CLOSE_FAILED');assert.equal(h.state.logs[0].status,'connected');h.state.hangupStatus=200;await h.api.closeInterviewRealtime(studentId,{sessionId,turnId,generation:2,attemptId,callId});assert.equal(h.state.logs[0].status,'completed');
});

test('a new attempt closes older owned connections and stale leases are swept',async()=>{
  const h=harness();await h.start();h.state.logs[0].expired=true;h.state.logs[0].old=true;await h.start({...input,attemptId:'00000000-0000-4000-8000-000000000005'});assert.equal(h.state.logs[0].status,'completed');assert.equal(h.state.logs[1].status,'connected');assert.equal(h.state.fetches.filter(call=>call.url.endsWith('/hangup')).length,1);
});
