import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import {connectRealtimeInterview,RealtimeInterviewEvents,type RealtimeInterviewConnection,type RealtimeInterviewSnapshot} from '../apps/web/src/lib/client/realtime-interview.ts';

const scope={sessionId:'session-a',turnId:'turn-a',generation:2,attemptId:'attempt-a'},question={prompt:'이 활동에서 무엇을 배웠나요?',speakerId:'B',digest:'approved-digest'};
const metadata={session_id:scope.sessionId,turn_id:scope.turnId,generation:String(scope.generation),attempt_id:scope.attemptId,question_digest:question.digest};
const created=(extra={})=>({type:'response.created',response:{id:'response-a',metadata:{...metadata,...extra}}});
const transcript=(value=question.prompt)=>({type:'response.output_audio_transcript.done',response_id:'response-a',transcript:value});
const done={type:'response.done',response:{id:'response-a',status:'completed',output:[]}},drained={type:'output_audio_buffer.stopped',response_id:'response-a'};
const originalGlobals=new Map(['fetch','MediaStream','RTCPeerConnection'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
let active:RealtimeInterviewConnection[]=[];
afterEach(async()=>{await Promise.all(active.map(connection=>connection.close()));active=[];for(const[key,descriptor]of originalGlobals)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);});
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return{promise,resolve};};
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function harness({response,offer,deleteStatuses=[]}:{response?:Promise<any>;offer?:Promise<any>;deleteStatuses?:number[]}={}){
  const clone={enabled:true,stops:0,stop(){this.stops++;}},source={enabled:true,stops:0,stop(){this.stops++;},clone(){return clone;}};
  const events:RealtimeInterviewSnapshot[]=[],requests:{url:string;init:RequestInit}[]=[],streams:unknown[]=[],selected:string[]=[];
  const output={element:{plays:0,async play(){this.plays++;}} as unknown as HTMLAudioElement,stops:0,setStream(stream:MediaStream|null){streams.push(stream);},select(id:string){selected.push(id);},stop(){this.stops++;}};
  class Channel extends EventTarget{readyState='connecting';sent:string[]=[];closes=0;onmessage:((event:{data:unknown})=>void)|null=null;onclose:(()=>void)|null=null;send(value:string){this.sent.push(value);}close(){this.closes++;this.readyState='closed';this.onclose?.();}receive(event:unknown){this.onmessage?.({data:typeof event==='string'?event:JSON.stringify(event)});}}
  class Peer{static instances:Peer[]=[];channel=new Channel();tracks:unknown[]=[];closes=0;remote:unknown[]=[];connectionState='new';onconnectionstatechange:(()=>void)|null=null;ontrack:((event:any)=>void)|null=null;constructor(){Peer.instances.push(this);}addTrack(track:unknown){this.tracks.push(track);}createDataChannel(){return this.channel;}createOffer(){return offer||Promise.resolve({type:'offer',sdp:'offer-sdp'});}async setLocalDescription(){}async setRemoteDescription(value:unknown){this.remote.push(value);this.channel.readyState='open';this.channel.dispatchEvent(new Event('open'));}close(){this.closes++;this.connectionState='closed';}}
  const approved={sdp:'answer-sdp',callId:'rtc_owned_call',expiresAt:new Date(Date.now()+240000).toISOString(),question,responseEvent:{type:'response.create',response:{conversation:'none',input:[],metadata}}};
  Object.assign(globalThis,{MediaStream:class{constructor(public tracks:unknown[]){}},RTCPeerConnection:Peer,fetch:async(url:string,init:RequestInit)=>{requests.push({url,init});if(init.method==='DELETE'){const status=deleteStatuses.shift()??200;return{ok:status>=200&&status<300,status,json:async()=>({})};}return response||{ok:true,status:200,json:async()=>approved};}});
  const connection=connectRealtimeInterview({getAudioTracks:()=>[source]} as unknown as MediaStream,scope,question,output,event=>events.push(event));active.push(connection);
  return{connection,source,clone,events,requests,output,streams,selected,approved,get peer(){return Peer.instances[0];},get channel(){return Peer.instances[0].channel;}};
}
async function play(h:ReturnType<typeof harness>){const playing=h.connection.playQuestion();await flush();h.channel.receive(created());h.channel.receive(transcript());h.channel.receive(done);h.channel.receive(drained);await playing;}

test('question output accepts only exact application turn/generation/attempt/digest/provider response',()=>{
  for(const change of [{attempt_id:'other'},{turn_id:'other'},{session_id:'other'},{generation:'3'},{question_digest:'other'}]){const events=new RealtimeInterviewEvents(scope,question);assert.equal(events.accept(created(change)),'invalid');}
  const events=new RealtimeInterviewEvents(scope,question);assert.equal(events.accept({type:'response.done',response:{id:'old-response',status:'completed'}}),'ignored');assert.equal(events.accept(created()),'updated');assert.equal(events.accept({type:'response.created',response:{id:'second',metadata}}),'invalid');
});

test('generated audio is not complete until actual playback drains and transcript matches',()=>{
  const events=new RealtimeInterviewEvents(scope,question);events.accept(created());events.accept(transcript());assert.equal(events.accept(done),'updated');assert.equal(events.accept(drained),'played');
  const reversed=new RealtimeInterviewEvents(scope,question);reversed.accept(created());reversed.accept(drained);reversed.accept(transcript());assert.equal(reversed.accept(done),'played');
  const wrong=new RealtimeInterviewEvents(scope,question);wrong.accept(created());wrong.accept(transcript('AI가 만든 다른 질문'));wrong.accept(done);assert.equal(wrong.accept(drained),'invalid');
});

test('duplicate events are ignored and cancelled provider responses cannot start capture',()=>{
  const events=new RealtimeInterviewEvents(scope,question);assert.equal(events.accept({...created(),event_id:'event-1'}),'updated');assert.equal(events.accept({...created(),event_id:'event-1'}),'ignored');assert.equal(events.accept({type:'response.done',response:{id:'response-a',status:'cancelled'}}),'invalid');
});

test('RTC sends one approved question, then shares only a clone when durable capture starts',async()=>{
  const h=harness();assert.equal(h.clone.enabled,false);await h.connection.ready;h.connection.startInput();assert.equal(h.clone.enabled,false,'input stays disabled before verified playback');
  const first=h.connection.playQuestion(),second=h.connection.playQuestion();await flush();assert.equal(h.channel.sent.filter(value=>JSON.parse(value).type==='response.create').length,1);h.channel.receive(created());h.channel.receive(transcript());h.channel.receive(done);await flush();assert.equal(h.clone.enabled,false);h.channel.receive(drained);await Promise.all([first,second]);
  h.connection.startInput();h.connection.startInput();assert.equal(h.clone.enabled,true);assert.equal(h.source.enabled,true);assert.equal(h.source.stops,0);assert.equal(h.peer.tracks[0],h.clone);assert.equal(h.channel.sent.filter(value=>JSON.parse(value).type==='input_audio_buffer.clear').length,1);
  assert.deepEqual(JSON.parse(String(h.requests[0].init.body)),{...scope,consent:true,sdp:'offer-sdp'});
  assert.equal(await h.connection.close(),true);assert.equal(h.clone.stops,1);assert.equal(h.source.stops,0);assert.equal(h.source.enabled,true);assert.equal(h.peer.closes,1);
});

test('remote interviewer stream uses the existing sole output element',async()=>{
  const h=harness();await h.connection.ready;const remote={id:'remote-stream'};h.peer.ontrack?.({streams:[remote],track:{}});assert.equal(h.streams[0],remote);assert.equal(h.selected[0],'B');assert.equal((h.output.element as any).plays,1);await h.connection.close();assert.equal(h.streams.at(-1),null);
});

test('student captions are deduplicated provisional previews and never submit answers or author questions',async()=>{
  const h=harness();await h.connection.ready;await play(h);h.channel.receive({type:'conversation.item.input_audio_transcription.delta',item_id:'item-a',delta:'시작 전'});assert.equal(h.events.at(-1)?.preview,'');h.connection.startInput();
  const delta={type:'conversation.item.input_audio_transcription.delta',item_id:'item-a',delta:'잠정',event_id:'event-a'};h.channel.receive(delta);h.channel.receive(delta);assert.equal(h.events.at(-1)?.preview,'잠정');h.channel.receive({type:'conversation.item.input_audio_transcription.completed',item_id:'item-a',transcript:'최종 미리보기'});h.channel.receive({...delta,event_id:'late-delta'});assert.equal(h.events.at(-1)?.preview,'최종 미리보기');
  assert.ok(h.requests.every(request=>request.url==='/api/interviews/realtime'));assert.equal(h.channel.sent.filter(value=>JSON.parse(value).type==='response.create').length,1);for(const value of ['invalid','null','[]'])assert.doesNotThrow(()=>h.channel.receive(value));
});

test('finish commits student input once, keeps late captions briefly, and never stops durable source',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const h=harness();await h.connection.ready;await play(h);h.connection.startInput();h.connection.finishInput();h.connection.finishInput();assert.equal(h.clone.enabled,false);assert.equal(h.events.at(-1)?.phase,'finishing');h.channel.receive({type:'conversation.item.input_audio_transcription.completed',item_id:'last',transcript:'늦게 도착한 자막'});assert.equal(h.events.at(-1)?.preview,'늦게 도착한 자막');assert.equal(h.channel.sent.filter(value=>JSON.parse(value).type==='input_audio_buffer.commit').length,1);t.mock.timers.tick(1800);await flush();assert.equal(h.clone.stops,1);assert.equal(h.source.stops,0);
});

test('mismatched or interrupted question output closes RTC and leaves original capture available for TTS fallback',async()=>{
  for(const bad of [transcript('다른 질문'),{type:'error',error:{message:'network'}}]){const h=harness();await h.connection.ready;const playing=h.connection.playQuestion();await flush();h.channel.receive(created());h.channel.receive(bad);h.channel.receive(done);h.channel.receive(drained);await assert.rejects(()=>playing);assert.ok(h.events.some(value=>value.phase==='unavailable'));assert.equal(h.clone.stops,1);assert.equal(h.source.stops,0);assert.equal(h.source.enabled,true);}
});

test('late cancelled negotiation still awaits exact owned remote hangup before logout',async()=>{
  const response=deferred<any>(),h=harness({response:response.promise});await flush();const stopping=h.connection.close();let settled=false;void stopping.then(()=>settled=true);await flush();assert.equal(settled,false);response.resolve({ok:true,json:async()=>h.approved});assert.equal(await stopping,true);assert.equal(h.peer.remote.length,0);assert.equal(h.requests.filter(request=>request.init.method==='DELETE').length,1);assert.equal(h.clone.stops,1);assert.equal(h.source.stops,0);
});

test('close has a retryable remote receipt, stops local resources once, and does not accept unauthorized cleanup',async()=>{
  const h=harness({deleteStatuses:[502,502,200]});await h.connection.ready;assert.equal(await h.connection.close(),false);assert.equal(h.requests.filter(request=>request.init.method==='DELETE').length,2);assert.equal(await h.connection.close(),true);assert.equal(h.requests.filter(request=>request.init.method==='DELETE').length,3);assert.equal(h.clone.stops,1);assert.equal(h.peer.closes,1);assert.equal(h.channel.closes,1);
  const denied=harness({deleteStatuses:[401]});await denied.connection.ready;assert.equal(await denied.connection.close(),false);
});

test('expired lease and server question mismatch close a created provider call',async()=>{
  for(const change of [{question:{...question,prompt:'browser mismatch'}},{expiresAt:new Date(1).toISOString()}]){const response=deferred<any>(),h=harness({response:response.promise});await flush();response.resolve({ok:true,json:async()=>({...h.approved,...change})});await assert.rejects(()=>h.connection.ready);await flush();assert.ok(h.requests.some(request=>request.init.method==='DELETE'));assert.equal(h.clone.enabled,false);assert.equal(h.source.stops,0);}
});

test('cancellation before offer completion never opens a paid call or stops the original microphone',async()=>{
  const offer=deferred<any>(),h=harness({offer:offer.promise});const closing=h.connection.close();offer.resolve({type:'offer',sdp:'late'});assert.equal(await closing,true);assert.equal(h.requests.length,0);assert.equal(h.source.stops,0);assert.equal(h.clone.stops,1);
});
