import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

function harness(){
  const state={queries:[]as{sql:string;params:any[]}[],sockets:[]as Socket[],responses:new Map<string,any>(),input:0,output:0,finalization:'incomplete'};
  class Socket{
    socket=Object.assign(new EventTarget(),{readyState:1});listeners=new Map<string,Function[]>();closed=0;url=new URL('wss://api.openai.com/v1/realtime?model=model');
    constructor(options:any){this.url.searchParams.delete('model');this.url.searchParams.set('call_id',options.callID);state.sockets.push(this);queueMicrotask(()=>this.socket.dispatchEvent(new Event('open')));}
    on(type:string,callback:Function){this.listeners.set(type,[...(this.listeners.get(type)||[]),callback]);}
    emit(value:any){for(const fn of this.listeners.get('event')||[])fn(value);}
    fail(provider=false){for(const fn of this.listeners.get('error')||[])fn({message:'private provider failure',...(provider?{error:{code:'response_cancel_not_active'}}:{})});}
    close(){this.closed++;}
  }
  const module={exports:{}as any};
  vm.runInNewContext(ts.transpileModule(readFileSync('apps/web/src/lib/realtime-interview-observer.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
    module,exports:module.exports,URL,Map,Promise,Error,Number,JSON,
    setTimeout:(callback:Function,delay:number)=>{if(delay===300)queueMicrotask(()=>callback());return{unref(){}};},clearTimeout(){},
    require(name:string){if(name==='server-only')return{};if(name==='openai/realtime/ws')return{OpenAIRealtimeWS:Socket};if(name==='./db')return{query:async(sql:string,params:any[])=>{
      state.queries.push({sql,params});
      if(sql.startsWith('with inserted')){const key=params[0]+':'+params[1];if(!state.responses.has(key)){const usage=JSON.parse(params[2]);state.responses.set(key,usage);state.input+=usage.input_tokens;state.output+=usage.output_tokens;}}
      else if(sql.includes('input_tokens=$2')){state.input=params[1];state.output=params[2];state.finalization='complete';}
      return[];
    }};throw Error(name);},
  });return {state,api:module.exports};
}
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const response={type:'response.done',response:{id:'response-a',status:'completed',usage:{input_tokens:120,output_tokens:42,total_tokens:162,input_token_details:{audio_tokens:100,cached_tokens:4},output_token_details:{audio_tokens:40}}}};

test('provider usage preserves zero, separates audio/cached values and rejects missing or fabricated counts',()=>{
  const h=harness();const parsed=h.api.realtimeResponseUsage(response);assert.equal(parsed.input_audio_tokens,100);assert.equal(parsed.output_audio_tokens,40);assert.equal(parsed.cached_tokens,4);
  assert.equal(h.api.realtimeResponseUsage({type:'response.done',response:{id:'x',usage:{input_tokens:0,output_tokens:0}}}).input_tokens,0);
  for(const usage of [{input_tokens:-1,output_tokens:1},{input_tokens:1.5,output_tokens:1},{input_tokens:'10',output_tokens:1},{input_tokens:NaN,output_tokens:1},{input_tokens:10}])assert.equal(h.api.realtimeResponseUsage({type:'response.done',response:{id:'x',usage}}),null);
  assert.equal(h.api.realtimeResponseUsage({type:'response.output_audio_transcript.done',response:{id:'x',usage:{input_tokens:1,output_tokens:1}}}),null);
  const duration=h.api.realtimeResponseUsage({type:'conversation.item.input_audio_transcription.completed',item_id:'duration-item',usage:{type:'duration',seconds:2.75}});
  assert.equal(duration.audio_seconds,2.75);assert.equal(duration.input_tokens,null);assert.equal(duration.output_tokens,null);
});

test('usage is collected on authenticated server sideband, deduplicated by response ID and kept incomplete without final usage',async()=>{
  const h=harness();await h.api.observeInterviewRealtime('usage-a','rtc_owned');await h.api.observeInterviewRealtime('usage-a','rtc_owned');
  assert.equal(h.state.sockets.length,1);const socket=h.state.sockets[0];assert.equal(socket.url.searchParams.get('call_id'),'rtc_owned');assert.equal(socket.url.searchParams.has('model'),false);
  socket.emit(response);socket.emit(response);await flush();assert.equal(h.state.responses.size,1);assert.equal(h.state.input,120);assert.equal(h.state.output,42);
  assert.ok(h.state.queries[0].sql.includes('on conflict(usage_id,response_id) do nothing'));
  await h.api.closeInterviewRealtimeObserver('rtc_owned');assert.equal(socket.closed,1);assert.equal(h.state.finalization,'incomplete');
});

test('provider transcription usage has its own identity and final reported totals supersede response partials',async()=>{
  const h=harness();await h.api.observeInterviewRealtime('usage-a','rtc_owned');const socket=h.state.sockets[0];socket.emit(response);
  const transcript={type:'conversation.item.input_audio_transcription.completed',item_id:'item-a',usage:{input_tokens:15,output_tokens:6}};socket.emit(transcript);socket.emit(transcript);await flush();assert.equal(h.state.responses.size,2);assert.equal(h.state.input,135);
  socket.emit({type:'session.closed',session:{usage:{input_tokens:140,output_tokens:50}}});await flush();assert.equal(h.state.finalization,'complete');assert.equal(h.state.input,140);assert.equal(h.state.output,50);await h.api.closeInterviewRealtimeObserver('rtc_owned');
});

test('recoverable VAD/cancel protocol errors do not detach server usage collection',async()=>{
  const h=harness();await h.api.observeInterviewRealtime('usage-a','rtc_owned');const socket=h.state.sockets[0];socket.fail(true);await flush();
  assert.equal(socket.closed,0);assert.equal(h.api.interviewRealtimeObservationState('rtc_owned'),'ready');
  socket.emit(response);await flush();assert.equal(h.state.responses.size,1);assert.equal(h.state.input,120);
  socket.fail();await flush();assert.equal(socket.closed,1);assert.equal(h.api.interviewRealtimeObservationState('rtc_owned'),'unavailable');
});
