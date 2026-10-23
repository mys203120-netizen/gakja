import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import {connectLiveTranscription, TranscriptTurns, type LiveTranscript, type LiveTranscription} from '../apps/web/src/lib/client/realtime-transcription.ts';

const scope = {sessionId:'session-a', itemIndex:1, attemptId:'attempt-a'};
const originalGlobals = new Map(['fetch','MediaStream','RTCPeerConnection'].map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)]));
let active:LiveTranscription[]=[];
afterEach(()=>{
  active.forEach(connection=>connection.close());active=[];
  for(const [key,descriptor] of originalGlobals) if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);
});

const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};};
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function harness({response,offer,deleteStatuses=[]}:{response?:Promise<{ok:boolean;json:()=>Promise<unknown>}>;offer?:Promise<{type:'offer';sdp:string}>;deleteStatuses?:number[]}={}){
  const cloned={enabled:true,stops:0,stop(){this.stops++;}};
  const source={enabled:true,stops:0,stop(){this.stops++;},clone(){return cloned;}};
  const events:LiveTranscript[]=[],requests:{url:string;init:RequestInit}[]=[];
  class Channel extends EventTarget{
    readyState='connecting';sent:string[]=[];closes=0;
    onmessage:((event:{data:unknown})=>void)|null=null;onclose:(()=>void)|null=null;
    send(value:string){this.sent.push(value);}
    close(){this.closes++;this.readyState='closed';this.onclose?.();}
    receive(value:unknown){this.onmessage?.({data:typeof value==='string'?value:JSON.stringify(value)});}
  }
  class Peer{
    static instances:Peer[]=[];channel=new Channel();tracks:unknown[]=[];closes=0;remote:unknown[]=[];connectionState='new';onconnectionstatechange:(()=>void)|null=null;
    constructor(){Peer.instances.push(this);}
    addTrack(track:unknown){this.tracks.push(track);}
    createDataChannel(){return this.channel;}
    createOffer(){return offer||Promise.resolve({type:'offer' as const,sdp:'offer-sdp'});}
    async setLocalDescription(){}
    async setRemoteDescription(value:unknown){this.remote.push(value);this.channel.readyState='open';this.channel.dispatchEvent(new Event('open'));}
    close(){this.closes++;this.connectionState='closed';}
  }
  Object.assign(globalThis,{
    MediaStream:class{constructor(public tracks:unknown[]){}},RTCPeerConnection:Peer,
    fetch:async(url:string,init:RequestInit)=>{requests.push({url,init});if(init.method==='DELETE'){const status=deleteStatuses.shift()??200;return {ok:status>=200&&status<300,status,json:async()=>({})};}return response||{ok:true,json:async()=>({sdp:'answer-sdp',callId:'call-a'})};},
  });
  const connection=connectLiveTranscription({getAudioTracks:()=>[source]} as unknown as MediaStream,scope,event=>events.push(event));active.push(connection);
  return {connection,source,cloned,events,requests,get peer(){return Peer.instances[0];},get channel(){return Peer.instances[0].channel;}};
}
const delta=(id:string,value:string,eventId?:string)=>({type:'conversation.item.input_audio_transcription.delta',item_id:id,delta:value,...eventId?{event_id:eventId}:{}});
const completed=(id:string,value:string)=>({type:'conversation.item.input_audio_transcription.completed',item_id:id,transcript:value});
const committed=(id:string,previous:string|null)=>({type:'input_audio_buffer.committed',item_id:id,previous_item_id:previous});

test('live transcription owns only a disabled clone and enables it only after explicit start',async()=>{
  const h=harness();assert.equal(h.cloned.enabled,false);assert.equal(h.source.enabled,true);assert.equal(h.source.stops,0);
  await h.connection.ready;assert.equal(h.events.at(-1)?.phase,'ready');assert.equal(h.cloned.enabled,false);assert.equal(h.peer.tracks[0],h.cloned);
  assert.deepEqual(JSON.parse(String(h.requests[0].init.body)),{...scope,consent:true,sdp:'offer-sdp'});
  h.connection.start();assert.equal(h.cloned.enabled,true);assert.equal(h.events.at(-1)?.phase,'listening');
  h.connection.close();h.connection.close();assert.equal(h.cloned.stops,1);assert.equal(h.cloned.enabled,false);assert.equal(h.source.stops,0);assert.equal(h.source.enabled,true);assert.equal(h.peer.closes,1);
  const cleanup=h.requests.filter(request=>request.init.method==='DELETE');assert.equal(cleanup.length,1);assert.deepEqual(JSON.parse(String(cleanup[0].init.body)),{...scope,callId:'call-a'});
});

test('remote hangup retries one transient failure without duplicating close or touching the original microphone',async()=>{
  const h=harness({deleteStatuses:[502,200]});await h.connection.ready;h.connection.start();h.connection.close();h.connection.close();await flush();
  const cleanup=h.requests.filter(request=>request.init.method==='DELETE');assert.equal(cleanup.length,2);assert.ok(cleanup.every(request=>request.init.keepalive===true));assert.deepEqual(cleanup.map(request=>JSON.parse(String(request.init.body))),[{...scope,callId:'call-a'},{...scope,callId:'call-a'}]);
  assert.equal(h.cloned.stops,1);assert.equal(h.peer.closes,1);assert.equal(h.channel.closes,1);assert.equal(h.source.stops,0);assert.equal(h.source.enabled,true);
  h.connection.close();await flush();assert.equal(h.requests.filter(request=>request.init.method==='DELETE').length,2);
});

test('persistent hangup failure is bounded and an explicit later close may retry',async()=>{
  const h=harness({deleteStatuses:[502,502,200]});await h.connection.ready;assert.equal(await h.connection.close(),false);await flush();assert.equal(await h.connection.close(),true);await flush();
  assert.equal(h.requests.filter(request=>request.init.method==='DELETE').length,3);assert.equal(h.cloned.stops,1);assert.equal(h.source.stops,0);assert.equal(h.source.enabled,true);
});

test('turn reconciliation replaces provisional text and orders out-of-order completions by committed predecessor',()=>{
  const turns=new TranscriptTurns();assert.equal(turns.accept(completed('second','두 번째 문장')),'두 번째 문장');turns.accept(committed('second','first'));
  turns.accept(delta('first','첫 번째'));assert.equal(turns.accept(completed('first','첫 번째 문장')),'첫 번째 문장\n두 번째 문장');turns.accept(committed('first',null));
  assert.equal(turns.accept(delta('first','중복되면 안 되는 조각')),'첫 번째 문장\n두 번째 문장');assert.equal(turns.accept(completed('first','첫 번째 문장')),'첫 번째 문장\n두 번째 문장');
});

test('channel events deduplicate event ids and completed turns while ignoring pre-start text',async()=>{
  const h=harness();await h.connection.ready;h.channel.receive(delta('first','시작 전'));assert.equal(h.events.at(-1)?.text,'');h.connection.start();
  h.channel.receive(delta('first','잠정','event-a'));h.channel.receive(delta('first','잠정','event-a'));assert.equal(h.events.at(-1)?.text,'잠정');
  h.channel.receive(completed('first','확정한 문장'));h.channel.receive(delta('first','이전 조각','event-b'));assert.equal(h.events.at(-1)?.text,'확정한 문장');
  assert.doesNotThrow(()=>h.channel.receive('invalid json'));assert.doesNotThrow(()=>h.channel.receive('null'));assert.doesNotThrow(()=>h.channel.receive('[]'));
});

test('cancelled late SDP responses clean the issued call and never attach or restart a track',async()=>{
  const delayed=deferred<{ok:boolean;json:()=>Promise<unknown>}>(),h=harness({response:delayed.promise});await flush();assert.equal(h.requests.length,1);
  h.connection.close();assert.equal(h.cloned.stops,1);assert.equal(h.requests[0].init.signal?.aborted,true);
  delayed.resolve({ok:true,json:async()=>({sdp:'late-answer',callId:'late-call'})});await h.connection.ready;
  assert.equal(h.peer.remote.length,0);assert.equal(h.source.stops,0);assert.equal(h.cloned.enabled,false);assert.equal(h.requests.filter(request=>request.init.method==='DELETE').length,1);assert.equal(JSON.parse(String(h.requests.at(-1)?.init.body)).callId,'late-call');
});

test('cancellation before a pending offer resolves never issues a server call',async()=>{
  const delayed=deferred<{type:'offer';sdp:string}>(),h=harness({offer:delayed.promise});h.connection.close();delayed.resolve({type:'offer',sdp:'late-offer'});await h.connection.ready;
  assert.equal(h.requests.length,0);assert.equal(h.cloned.stops,1);assert.equal(h.source.stops,0);assert.equal(h.events.some(event=>event.phase==='ready'),false);
});

test('finishing keeps collecting the final committed turn even if an older completion arrives first',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const h=harness();await h.connection.ready;h.connection.start();h.channel.receive(committed('first',null));h.channel.receive(delta('first','앞부분'));
  h.connection.finish();assert.equal(h.cloned.enabled,false);assert.equal(h.source.enabled,true);assert.equal(h.events.at(-1)?.phase,'finishing');assert.deepEqual(h.channel.sent.map(value=>JSON.parse(value)),[{type:'input_audio_buffer.commit'}]);
  h.channel.receive(committed('final','first'));h.channel.receive(completed('first','앞부분 확정'));assert.equal(h.cloned.stops,0,'older VAD completion must not close the final turn');
  h.channel.receive(completed('final','마지막 문장'));t.mock.timers.tick(2000);assert.equal(h.events.at(-1)?.text,'앞부분 확정\n마지막 문장');assert.equal(h.events.at(-1)?.phase,'finished');assert.equal(h.cloned.stops,1);assert.equal(h.source.stops,0);
});

test('finishing without a completion times out without stopping durable recording tracks',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const h=harness();await h.connection.ready;h.connection.start();h.channel.receive(delta('first','화면에 표시된 초안'));h.connection.finish();h.connection.finish();
  t.mock.timers.tick(2000);assert.equal(h.events.at(-1)?.phase,'finished');assert.equal(h.events.at(-1)?.text,'화면에 표시된 초안');assert.equal(h.channel.sent.length,1);assert.equal(h.cloned.stops,1);assert.equal(h.source.stops,0);
});

test('channel failure exposes unavailable state and leaves the original recording intact',async()=>{
  const h=harness();await h.connection.ready;h.connection.start();h.channel.receive(delta('first','표시했던 글'));h.channel.onclose?.();assert.equal(h.events.at(-1)?.phase,'unavailable');assert.equal(h.events.at(-1)?.text,'표시했던 글');assert.equal(h.cloned.stops,1);assert.equal(h.source.stops,0);h.connection.start();assert.equal(h.cloned.enabled,false);
});
