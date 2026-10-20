export type RealtimeInterviewScope={sessionId:string;turnId:string;generation:number;attemptId:string};
export type RealtimeInterviewSnapshot={phase:'connecting'|'ready'|'speaking'|'listening'|'finishing'|'closed'|'unavailable';preview:string};
type Output={element:HTMLAudioElement;setStream(stream:MediaStream|null):void;select(speakerId:string):void;stop():void};
type ApprovedQuestion={prompt:string;speakerId:string;digest:string};
const normalized=(value:string)=>value.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu,'').toLowerCase();

/** App/attempt identity is independent of provider IDs. Late or duplicate responses cannot advance a turn. */
export class RealtimeInterviewEvents{
  private seen=new Set<string>();responseId='';transcript='';generated=false;drained=false;
  constructor(private scope:RealtimeInterviewScope,private expected:ApprovedQuestion){}
  accept(event:Record<string,any>):'ignored'|'updated'|'played'|'invalid'{
    if(typeof event.event_id==='string'){if(this.seen.has(event.event_id))return 'ignored';if(this.seen.size>=2000)return 'invalid';this.seen.add(event.event_id);}
    if(event.type==='response.created'){
      const value=event.response,metadata=value?.metadata;
      if(metadata?.attempt_id!==this.scope.attemptId||metadata?.turn_id!==this.scope.turnId||metadata?.generation!==String(this.scope.generation)||metadata?.session_id!==this.scope.sessionId||metadata?.question_digest!==this.expected.digest||typeof value.id!=='string')return 'invalid';
      if(this.responseId&&this.responseId!==value.id)return 'invalid';this.responseId=value.id;return 'updated';
    }
    const id=event.response_id||event.response?.id;
    if(!id||id!==this.responseId)return 'ignored';
    if(event.type==='response.output_audio_transcript.done')this.transcript=typeof event.transcript==='string'?event.transcript.slice(0,12000):'';
    if(event.type==='response.done'){
      if(event.response?.status!=='completed')return 'invalid';this.generated=true;
      if(!this.transcript)this.transcript=(event.response.output||[]).flatMap((item:Record<string,any>)=>item.content||[]).map((item:Record<string,any>)=>item.transcript||'').join('').slice(0,12000);
    }
    if(event.type==='output_audio_buffer.stopped')this.drained=true;
    if(this.generated&&this.drained)return normalized(this.transcript)===normalized(this.expected.prompt)?'played':'invalid';
    return 'updated';
  }
}

/** A per-approved-question RTC call shares only a clone of the durable recorder's microphone track. */
export function connectRealtimeInterview(stream:MediaStream,scope:RealtimeInterviewScope,expected:{prompt:string;speakerId:string},output:Output,update:(value:RealtimeInterviewSnapshot)=>void){
  const abort=new AbortController();let peer:RTCPeerConnection|undefined,channel:RTCDataChannel|undefined,track:MediaStreamTrack|undefined,events:RealtimeInterviewEvents|undefined;
  let callId='',closed=false,inputStarted=false,inputFinished=false,questionStarted=false,questionPlayed=false,preview='',phase:RealtimeInterviewSnapshot['phase']='connecting',request:Record<string,unknown>|undefined;
  let shutdown:Promise<boolean>|undefined;
  let lifetime:ReturnType<typeof setTimeout>|undefined,heartbeat:ReturnType<typeof setInterval>|undefined,finishTimer:ReturnType<typeof setTimeout>|undefined,playTimer:ReturnType<typeof setTimeout>|undefined;
  let resolvePlayback!:()=>void,rejectPlayback!:(error:Error)=>void;const playback=new Promise<void>((resolve,reject)=>{resolvePlayback=resolve;rejectPlayback=reject;});void playback.catch(()=>{});
  const transcriptItems=new Map<string,{text:string;complete:boolean}>(),seen=new Set<string>();
  const emit=(next:RealtimeInterviewSnapshot['phase'])=>{phase=next;update({phase,preview});};
  const send=(event:Record<string,unknown>)=>{if(channel?.readyState==='open')channel.send(JSON.stringify(event));};
  const cleanups=new Map<string,Promise<boolean>>();
  const cleanupCall=(id:string)=>{const previous=cleanups.get(id);if(previous)return previous;const work=(async()=>{for(let attempt=0;attempt<2;attempt++)try{const response=await fetch('/api/interviews/realtime',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({...scope,callId:id}),keepalive:true});if(response.ok||response.status===404)return true;if([401,403].includes(response.status))return false;}catch{/* Retry the owned hangup once; peer tracks are already stopped. */}return false;})();cleanups.set(id,work);return work;};
  function close(){
    if(shutdown)return shutdown;
    if(!closed){closed=true;abort.abort();clearTimeout(lifetime);clearTimeout(finishTimer);clearTimeout(playTimer);clearInterval(heartbeat);
    try{send({type:'response.cancel'});send({type:'output_audio_buffer.clear'});}catch{}
    output.stop();output.setStream(null);if(track){track.enabled=false;track.stop();}channel?.close();peer?.close();rejectPlayback(new DOMException('실시간 면접 연결을 멈췄어요.','AbortError'));emit('closed');}
    // Wait for a late issued call ID too. Logout can await this receipt before revoking authentication.
    const pending=Promise.resolve().then(()=>ready).catch(()=>{}).then(()=>callId?cleanupCall(callId):true);shutdown=pending;
    void pending.then(confirmed=>{if(!confirmed){if(callId)cleanups.delete(callId);if(shutdown===pending)shutdown=undefined;}});return pending;
  }
  function unavailable(){if(closed)return;rejectPlayback(new Error('실시간 연결을 확인하지 못했어요.'));emit('unavailable');close();}
  const ready=(async()=>{
    emit('connecting');
    try{
      if(typeof RTCPeerConnection==='undefined')throw Error('unsupported');const source=stream.getAudioTracks()[0];if(!source)throw Error('no microphone');
      track=source.clone();track.enabled=false;peer=new RTCPeerConnection();peer.addTrack(track,new MediaStream([track]));channel=peer.createDataChannel('oai-events');
      peer.onconnectionstatechange=()=>{if(['failed','disconnected'].includes(peer?.connectionState||''))unavailable();};
      peer.ontrack=event=>{if(closed)return;const remote=event.streams[0]||new MediaStream([event.track]);output.setStream(remote);output.select(expected.speakerId);void output.element.play().catch(()=>unavailable());};
      channel.onclose=()=>{if(!closed)unavailable();};
      channel.onmessage=({data})=>{
        if(closed||typeof data!=='string'||data.length>100000)return;let event:Record<string,any>;try{event=JSON.parse(data);}catch{return;}if(!event||typeof event!=='object'||Array.isArray(event)||typeof event.type!=='string')return;
        if(typeof event.event_id==='string'){if(seen.has(event.event_id))return;if(seen.size>=2000){unavailable();return;}seen.add(event.event_id);}
        if(event.type==='error'||event.type==='conversation.item.input_audio_transcription.failed'){unavailable();return;}
        if(event.type.startsWith('response.')||event.type.startsWith('output_audio_buffer.')){
          const result=events?.accept(event);if(result==='invalid'){unavailable();return;}if(result==='played'){questionPlayed=true;clearTimeout(playTimer);output.stop();resolvePlayback();}
        }
        if(!inputStarted||!['conversation.item.input_audio_transcription.delta','conversation.item.input_audio_transcription.completed'].includes(event.type)||typeof event.item_id!=='string')return;
        if(!transcriptItems.has(event.item_id)&&transcriptItems.size>=50){unavailable();return;}
        const item=transcriptItems.get(event.item_id)||{text:'',complete:false};
        if(event.type.endsWith('.completed')){item.text=String(event.transcript||'').slice(0,12000);item.complete=true;}else if(!item.complete)item.text=(item.text+String(event.delta||'')).slice(0,12000);
        transcriptItems.set(event.item_id,item);preview=[...transcriptItems.values()].map(value=>value.text).filter(Boolean).join('\n').slice(0,12000);emit(inputFinished?'finishing':'listening');
      };
      const offer=await peer.createOffer();if(closed)return;await peer.setLocalDescription(offer);if(closed)return;
      const response=await fetch('/api/interviews/realtime',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...scope,consent:true,sdp:offer.sdp}),signal:abort.signal});
      const value=await response.json();if(closed){if(typeof value.callId==='string'&&/^rtc_[a-zA-Z0-9_-]{1,150}$/.test(value.callId))callId=value.callId;return;}
      if(typeof value.callId==='string'&&/^rtc_[a-zA-Z0-9_-]{1,150}$/.test(value.callId))callId=value.callId;
      if(!response.ok||typeof value.sdp!=='string'||!callId||value.question?.prompt!==expected.prompt||value.question?.speakerId!==expected.speakerId||typeof value.question?.digest!=='string'||value.responseEvent?.type!=='response.create')throw Error('unapproved question');
      events=new RealtimeInterviewEvents(scope,value.question);request=value.responseEvent;
      const remaining=new Date(value.expiresAt).getTime()-Date.now();if(!Number.isFinite(remaining)||remaining<=0||remaining>245000)throw Error('expired call');lifetime=setTimeout(unavailable,remaining);
      await peer.setRemoteDescription({type:'answer',sdp:value.sdp});if(closed)return;
      if(channel.readyState!=='open')await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>{dispose();reject(Error('data channel timeout'));},8000),opened=()=>{dispose();resolve();},cancelled=()=>{dispose();reject(new DOMException('연결 취소','AbortError'));};
        const dispose=()=>{clearTimeout(timer);channel?.removeEventListener('open',opened);abort.signal.removeEventListener('abort',cancelled);};channel!.addEventListener('open',opened,{once:true});abort.signal.addEventListener('abort',cancelled,{once:true});
      });
      if(closed)return;heartbeat=setInterval(()=>{void fetch('/api/interviews/realtime',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({...scope,callId}),signal:abort.signal}).then(response=>{if(!response.ok)unavailable();}).catch(()=>{if(!closed)unavailable();});},8000);emit('ready');
    }catch(error){if(!closed)unavailable();throw error;}
  })();void ready.catch(()=>{});
  return {ready,close,
    async playQuestion(){await ready;if(closed||!request)throw Error('RTC unavailable');if(!questionStarted){questionStarted=true;emit('speaking');send(request);playTimer=setTimeout(unavailable,90000);}await playback;},
    startInput(){if(closed||!track||inputStarted||!questionPlayed)return;inputStarted=true;send({type:'input_audio_buffer.clear'});track.enabled=true;emit('listening');},
    finishInput(){if(closed||inputFinished)return;inputFinished=true;if(track)track.enabled=false;send({type:'input_audio_buffer.commit'});emit('finishing');finishTimer=setTimeout(close,1800);},
  };
}
export type RealtimeInterviewConnection=ReturnType<typeof connectRealtimeInterview>;
