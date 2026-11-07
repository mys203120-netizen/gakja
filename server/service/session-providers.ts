import { withPinnedProviderModels } from '../providers/provider-model-context';
import type { AuthenticatedRequestContext } from '../auth/request-identity';
import { createHash } from 'node:crypto';
import { runRealtimeCore } from '../providers/realtime-core';
import { approvedRestatement } from '../providers/approved-restatement';
import { approvedAudioReplay } from '../providers/approved-audio-replay';
import { classifySingleCoreAnswerCandidate, assertSingleCoreCandidateBinding, SINGLE_CORE_ENGINE_VERSION } from '../providers/single-core-runtime';
import { selectNextPreparedMainQuestion } from '../data/prepared-question-bank';
import { checkedSpeechSettings, requestSpeechBytes, speechAudioCacheId, interviewerVoiceDefaults } from '../providers/clova-tts';
import { ClovaSpeechStream } from '../providers/clova-stt';
import type { StrategyCoreOptions } from '../providers/realtime-strategy-core';
import type { ScopedSessionProviders, IsolatedSessionProviders, SyntheticCapture } from '../session-writer/isolated-session-service';
import type { TranscriptObservation } from '../protocol';
import type { TurnWorkContext } from '../turn-work';
import { TransitionError } from '../transition/transition-ports';
import { authorizeScoped, assertScopedComponent, bindScopedComponent, scopedServiceAuthority, type ScopedServiceAuthority } from './scoped-authority';
import { runScopedOperation, scopedOperationContext } from './scoped-command';

export interface ScopedServiceAudio {
  read(context:AuthenticatedRequestContext,id:string):Promise<Buffer|null>;
  write(context:AuthenticatedRequestContext,input:{audioId:string;bytes:Buffer;sessionId:string;sourceRevision?:string|null}):Promise<void>;
}
/** Only raw external I/O is substitutable. All classifiers, gates, selection,
 * source checks, parsers and contract construction remain the real functions. */
export interface RehearsalSessionRawIO extends Pick<StrategyCoreOptions,'requestSingleCore'|'requestFactReview'|'requestSurfaceRepair'|'requestStrategy'|'requestReview'|'requestRepair'> {
  requestRealtime?:NonNullable<Parameters<typeof runRealtimeCore>[2]['request']>;
  requestSpeechBytes:typeof requestSpeechBytes;
  openCapture:IsolatedSessionProviders['openCapture'];
}
function requireContext(context?:AuthenticatedRequestContext){return context??scopedOperationContext().context;}
function cancellableWork(work:TurnWorkContext|undefined,signal:AbortSignal):TurnWorkContext|undefined {
  if(!work)return undefined;
  return new Proxy(work,{get(target,key){
    if(key==='run')return <T>(cap:number,operation:(stage:{signal:AbortSignal;timeoutMs:number})=>Promise<T>)=>target.run(cap,stage=>operation({...stage,signal:AbortSignal.any([stage.signal,signal])}));
    if(key==='assertLive')return ()=>{signal.throwIfAborted();target.assertLive();};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
}
function coreOptions(options:StrategyCoreOptions,signal:AbortSignal,raw?:RehearsalSessionRawIO):StrategyCoreOptions {
  const {requestSingleCore:_a,requestFactReview:_b,requestSurfaceRepair:_c,requestStrategy:_d,requestReview:_e,requestRepair:_f,resolveApprovedRecovery:_g,...base}=options;
  void _a;void _b;void _c;void _d;void _e;void _f;void _g;
  return {...base,workContext:cancellableWork(options.workContext,signal),...(raw?{requestSingleCore:raw.requestSingleCore,requestFactReview:raw.requestFactReview,
    requestSurfaceRepair:raw.requestSurfaceRepair,requestStrategy:raw.requestStrategy,requestReview:raw.requestReview,requestRepair:raw.requestRepair}:{})};
}
function assertNativeConfiguration(authority:ScopedServiceAuthority){if(scopedServiceAuthority(authority).mode==='production'&&['OPENAI_API_KEY','CLOVA_VOICE_CLIENT_ID','CLOVA_VOICE_CLIENT_SECRET','CLOVA_SPEECH_SECRET_KEY'].some(key=>!process.env[key]?.trim()))throw new TransitionError(503,'SERVICE_PROVIDER_CONFIGURATION_REQUIRED');}
async function providerOperation<T>(authority:ScopedServiceAuthority,context:AuthenticatedRequestContext,sessionId:string,operation:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal){
  const active=scopedOperationContext();
  return runScopedOperation(authority,context,{generation:active.generation,kind:'provider',sessionId,signal:signal?AbortSignal.any([active.signal,signal]):active.signal},async current=>{
    await authorizeScoped(authority,context,'session-write',sessionId);current.throwIfAborted();assertNativeConfiguration(authority);
    const result=await operation(current);current.throwIfAborted();await authorizeScoped(authority,context,'session-write',sessionId);return result;
  });
}
function nativeCapture(input:Parameters<IsolatedSessionProviders['openCapture']>[0]):SyntheticCapture {
  let failure:Error|undefined,closed=false;const observations:TranscriptObservation[]=[];
  const stream=new ClovaSpeechStream(value=>{const observation={segmentId:input.streamId+':'+value.position,revision:value.revision,confidence:value.confidence,startTimestamp:value.startTimestamp,endTimestamp:value.endTimestamp};
    const index=observations.findIndex(item=>item.segmentId===observation.segmentId);if(index<0)observations.push(observation);else if(observations[index].revision<=observation.revision)observations[index]=observation;
  },error=>{failure=error;});
  return {write(bytes){if(closed||failure)throw failure??new Error('STT_CAPTURE_CLOSED');stream.write(bytes);},async finish(){
    if(failure)throw failure;const rawTranscript=await stream.finish();if(failure)throw failure;return {rawTranscript,observations:[...observations],confirmed:true};
  },close(){if(!closed){closed=true;stream.close();}}};
}
const nativeHandles=new WeakSet<object>(),rehearsalHandles=new WeakSet<object>();
export function assertSessionProviderHandle(authority:ScopedServiceAuthority,provider:ScopedSessionProviders){assertScopedComponent(authority,provider);const mode=scopedServiceAuthority(authority).mode;if(mode==='production'?!nativeHandles.has(provider):!nativeHandles.has(provider)&&!rehearsalHandles.has(provider))throw new TransitionError(503,'SERVICE_NATIVE_PROVIDER_HANDLE_REQUIRED');}
function createProviders(authority:ScopedServiceAuthority,audio:ScopedServiceAudio,raw?:RehearsalSessionRawIO):ScopedSessionProviders {
  assertScopedComponent(authority,audio);scopedServiceAuthority(authority);
  const providers:ScopedSessionProviders={kind:raw?'service-rehearsal':'service-native',
    async classify(context,session,candidate,options,pins){const active=scopedOperationContext();return providerOperation(authority,active.context,session.id,signal=>withPinnedProviderModels(pins?.models,()=>classifySingleCoreAnswerCandidate(context,session,candidate,coreOptions(options,signal,raw))));},
    forSession(pins,selected){
      const scope=pins.sessionAuthority as {sessionId?:string;sourceRevision?:string|null}|undefined;
      const sessionId=scope?.sessionId;
      return {approvedRestatement,approvedAudioReplay,selectNextPreparedMainQuestion,interviewerVoiceDefaults,assertSingleCoreCandidateBinding,SINGLE_CORE_ENGINE_VERSION,
        async runRealtimeCore(context,session,options){const auth=requireContext(selected);return providerOperation(authority,auth,session.id,signal=>withPinnedProviderModels(pins.models,()=>runRealtimeCore(context,session,{...coreOptions(options,signal,raw),...(raw?.requestRealtime?{request:raw.requestRealtime}:{})})));},
        async synthesizeSpeech(text,speaker,options={}){
          const auth=requireContext(selected);if(!sessionId)throw new TransitionError(503,'SERVICE_SESSION_PIN_REQUIRED');
          const settings=checkedSpeechSettings(text,speaker,options),id=speechAudioCacheId(text,settings),started=performance.now();
          const cached=await audio.read(auth,id);if(cached){options.signal?.throwIfAborted();options.onTiming?.({cache:'disk',durationMs:performance.now()-started,providerMs:null,audioId:id,settings});return '/api/audio/'+id;}
          const providerStarted=performance.now();
          const bytes=await providerOperation(authority,auth,sessionId,signal=>(raw?.requestSpeechBytes??requestSpeechBytes)(text,speaker,{...options,settings,signal}),options.signal);
          const providerMs=performance.now()-providerStarted;
          await audio.write(auth,{audioId:id,bytes,sessionId,...(Object.hasOwn(scope!,'sourceRevision')?{sourceRevision:scope!.sourceRevision}:{})});
          options.signal?.throwIfAborted();options.onTiming?.({cache:'provider',durationMs:performance.now()-started,providerMs,audioId:id,settings});return '/api/audio/'+id;
        },
        async readSpeechAudio(id){const auth=requireContext(selected);await authorizeScoped(authority,auth,'read',sessionId);return audio.read(auth,id);},
      };
    },
    async openCapture(input,selected){
      const context=requireContext(selected),active=scopedOperationContext();let release!:()=>void,resolveOpened!:(capture:SyntheticCapture)=>void,rejectOpened!:(cause:unknown)=>void;
      const done=new Promise<void>(resolve=>{release=resolve;}),opened=new Promise<SyntheticCapture>((resolve,reject)=>{resolveOpened=resolve;rejectOpened=reject;});
      let capture:SyntheticCapture|undefined;
      const running=runScopedOperation(authority,context,{generation:active.generation,kind:'capture',sessionId:input.sessionId,signal:active.signal},async signal=>{
        await authorizeScoped(authority,context,'session-write',input.sessionId);signal.throwIfAborted();
        assertNativeConfiguration(authority);capture=raw?await raw.openCapture(input,context):nativeCapture(input);
        const close=()=>{void capture?.close();release();};signal.addEventListener('abort',close,{once:true});
        let settled=false;const finish=()=>{if(!settled){settled=true;release();}};
        resolveOpened({async write(bytes){signal.throwIfAborted();await authorizeScoped(authority,context,'session-write',input.sessionId);await capture!.write(bytes);},async finish(){
          try{signal.throwIfAborted();const value=await capture!.finish();signal.throwIfAborted();await authorizeScoped(authority,context,'session-write',input.sessionId);return value;}
          finally{await capture!.close();finish();}
        },async close(){await capture!.close();finish();}});
        try{await done;signal.throwIfAborted();}finally{signal.removeEventListener('abort',close);await capture.close();}
      });
      void running.catch(cause=>{rejectOpened(cause);void capture?.close();release();});return opened;
    },
  };(raw?rehearsalHandles:nativeHandles).add(providers);return bindScopedComponent(authority,providers);
}
export function createNativeSessionProviders(options:{authority:ScopedServiceAuthority;audio:ScopedServiceAudio}):ScopedSessionProviders {
  return createProviders(options.authority,options.audio);
}
export function createRehearsalSessionProviders(options:{authority:ScopedServiceAuthority;audio:ScopedServiceAudio;raw:RehearsalSessionRawIO}):ScopedSessionProviders {
  if(scopedServiceAuthority(options.authority).mode!=='rehearsal'||process.env.NODE_ENV==='production'||!options.raw.requestSingleCore||typeof options.raw.requestSpeechBytes!=='function'||typeof options.raw.openCapture!=='function')throw new TransitionError(503,'SERVICE_REHEARSAL_PROVIDER_REQUIRED');
  return createProviders(options.authority,options.audio,options.raw);
}
export const serviceAudioContentSha256=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
