import 'server-only';
import {OpenAIRealtimeWS} from 'openai/realtime/ws';
import {query} from './db';

type Observer={state:'connecting'|'ready';close():Promise<void>};
const observers=new Map<string,Observer>();
export function interviewRealtimeObservationState(callId:string){return observers.get(callId)?.state||'unavailable';}
const integer=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=100_000_000?value:null;
/** Only server-side provider events are billing evidence. Browser captions/counters never enter here. */
export function realtimeResponseUsage(event:Record<string,any>){
  const transcription=event.type==='conversation.item.input_audio_transcription.completed';
  const response=transcription?{id:`transcription:${event.item_id}`,usage:event.usage,status:'completed'}:event.response,usage=response?.usage;
  if((event.type!=='response.done'&&!transcription)||typeof response?.id!=='string'||response.id.length>200||!usage||(transcription&&typeof event.item_id!=='string'))return null;
  const input=integer(usage.input_tokens),output=integer(usage.output_tokens);
  const seconds=transcription&&usage.type==='duration'&&typeof usage.seconds==='number'&&Number.isFinite(usage.seconds)&&usage.seconds>=0&&usage.seconds<=300?usage.seconds:null;
  if((input===null||output===null)&&seconds===null)return null;
  return {responseId:response.id,kind:transcription?'transcription':'response',input_tokens:input,output_tokens:output,status:String(response.status||'unknown'),
    input_audio_tokens:integer(usage.input_token_details?.audio_tokens),output_audio_tokens:integer(usage.output_token_details?.audio_tokens),
    cached_tokens:integer(usage.input_token_details?.cached_tokens),total_tokens:integer(usage.total_tokens),audio_seconds:seconds};
}
export async function recordRealtimeResponseUsage(usageId:string,event:Record<string,any>){
  const usage=realtimeResponseUsage(event);if(!usage)return;
  // One statement makes delivery retries and repeated response.done idempotent.
  await query(`with inserted as (
    insert into interview_realtime_usage_events(usage_id,response_id,data) values($1,$2,$3)
    on conflict(usage_id,response_id) do nothing returning data
  ) update ai_usage_logs set input_tokens=input_tokens+coalesce((inserted.data->>'input_tokens')::int,0),
    output_tokens=output_tokens+coalesce((inserted.data->>'output_tokens')::int,0),
    realtime_usage=realtime_usage||jsonb_build_object('source','provider_sideband','finalization','incomplete',
      'usage_events',coalesce((realtime_usage->>'usage_events')::int,0)+1,
      'responses',coalesce((realtime_usage->>'responses')::int,0)+case when inserted.data->>'kind'='response' then 1 else 0 end)
    from inserted where ai_usage_logs.id=$1 and feature='interview_realtime'`,[usageId,usage.responseId,JSON.stringify(usage)]);
}
/** Persistent Node sideband observes usage even if the tab is lost. Failures remain explicitly incomplete. */
export async function observeInterviewRealtime(usageId:string,callId:string){
  if(observers.has(callId))return;
  let chain=Promise.resolve(),closed=false,timer:ReturnType<typeof setTimeout>|undefined;
  const socket=new OpenAIRealtimeWS({callID:callId,options:{handshakeTimeout:10_000,perMessageDeflate:false}});
  const observer:Observer={state:'connecting',async close(){if(closed)return chain;closed=true;if(timer)clearTimeout(timer);socket.close();observers.delete(callId);await chain;}};
  observers.set(callId,observer);
  const markIncomplete=()=>{chain=chain.then(()=>query("update ai_usage_logs set realtime_usage=realtime_usage||'{\"source\":\"provider_sideband\",\"finalization\":\"incomplete\"}'::jsonb where id=$1 and feature='interview_realtime'",[usageId])).then(()=>{}).catch(()=>{});};
  socket.on('error',error=>{
    markIncomplete();
    // Realtime reports recoverable client-event errors through the SDK's error emitter too.
    // A VAD/cancel race must not detach billing observation while the call keeps speaking.
    if(!error.error||socket.socket.readyState!==1)void observer.close();
  });
  socket.on('event',event=>{
    const value=event as Record<string,any>;
    if(value.type==='response.done'||value.type==='conversation.item.input_audio_transcription.completed')chain=chain.then(()=>recordRealtimeResponseUsage(usageId,value)).catch(markIncomplete);
    if(value.type==='session.closed'&&value.session?.usage){
      const input=integer(value.session.usage.input_tokens),output=integer(value.session.usage.output_tokens);
      if(input!==null&&output!==null)chain=chain.then(()=>query("update ai_usage_logs set input_tokens=$2,output_tokens=$3,realtime_usage=realtime_usage||'{\"source\":\"provider_sideband\",\"finalization\":\"complete\"}'::jsonb where id=$1 and feature='interview_realtime'",[usageId,input,output])).then(()=>{}).catch(markIncomplete);
    }
  });
  socket.socket.addEventListener('close',()=>{void observer.close();});
  timer=setTimeout(()=>{markIncomplete();void observer.close();},245_000);timer.unref?.();
  await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('sideband timeout')),10_000);const opened=()=>{clearTimeout(timeout);observer.state='ready';resolve();};socket.socket.addEventListener('open',opened,{once:true});socket.socket.addEventListener('error',()=>{clearTimeout(timeout);reject(Error('sideband unavailable'));},{once:true});});
}
export async function closeInterviewRealtimeObserver(callId:string){
  // Hangup first, then allow provider's final usage events to reach the already registered sideband.
  const observer=observers.get(callId);if(observer){await new Promise(resolve=>setTimeout(resolve,300));await observer.close();}
}
