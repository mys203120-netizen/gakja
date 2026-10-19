import {INITIAL_LIVE_TURN, observeLiveTurn, type LiveTurnEndpointOptions} from '../live-interview-turn';
import {buildSpeechTelemetry, MAX_SPEECH_CAPTURE_MS, MAX_SPEECH_SAMPLES, SPEECH_SAMPLE_INTERVAL_MS, type RmsSample, type SpeechTelemetry} from '../speech-telemetry';

export type LiveAnswerStopReason = 'manual' | 'silence' | 'limit' | 'interrupted';
export type LiveCaptureProgress = {
  durationMs:number; speechStarted:boolean; silenceMs:number; endingSoon:boolean;
  level:number; paused:boolean; measurementAvailable:boolean;
};
export type LiveAnswerRecording = {
  blob:Blob; analysisAudio?:Blob; durationMs:number; telemetry?:SpeechTelemetry;
  reason:LiveAnswerStopReason; partial:boolean; issue?:string;
  speechStarted:boolean; measurementAvailable:boolean;
};
export type LiveAnswerCapture = {
  finished:Promise<LiveAnswerRecording>;
  stop(reason?:LiveAnswerStopReason):Promise<LiveAnswerRecording>;
  pause():void;
  resume():void;
  /** Explicit discard. To preserve interrupted audio call stop('interrupted'). */
  dispose():void;
};
type Options = LiveTurnEndpointOptions & {
  onProgress?:(progress:LiveCaptureProgress)=>void;
  onLevel?:(level:number)=>void;
  maxDurationMs?:number;
  onChunk?:(blob:Blob,kind:'primary'|'analysis',durationMs:number)=>void;
  onComplete?:(recording:LiveAnswerRecording)=>Promise<void>|void;
  autoStop?:()=>boolean;
};
type RecorderPart = {recorder:MediaRecorder;chunks:Blob[];ended:boolean;failed:boolean};
const MAX_LIVE_ANSWER_MS = 180_000;
const FINAL_CHUNK_TIMEOUT_MS = 10_000;

/** Uses an already consented stream. Never requests a microphone or stops shared tracks. */
export function createLiveAnswerCapture(stream:MediaStream, options:Options = {}):LiveAnswerCapture {
  if (typeof window === 'undefined' || !window.MediaRecorder || !stream.getAudioTracks().some(track=>track.readyState==='live')) throw new Error('연결된 마이크를 확인해 주세요.');
  const Recorder = window.MediaRecorder;
  const video = stream.getVideoTracks().some(track=>track.readyState==='live');
  const mimeFor = (types:string[])=>types.find(type=>Recorder.isTypeSupported(type));
  const audioMime = mimeFor(['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus']);
  const primaryMime = video ? mimeFor(['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm','video/mp4']) : audioMime;
  // A three-minute video should fit the existing 20 MB upload budget. These are
  // encoder hints, so the upload path must still validate the actual Blob size.
  const primary:RecorderPart = {recorder:new Recorder(stream,{...(primaryMime?{mimeType:primaryMime}:{}),audioBitsPerSecond:64_000,...(video?{videoBitsPerSecond:600_000}:{})}),chunks:[],ended:false,failed:false};
  // Construct both recorders before starting either, so an unsupported audio encoder cannot leave an orphan recording.
  const analysis:RecorderPart|undefined = video ? {recorder:new Recorder(new MediaStream(stream.getAudioTracks()),{...(audioMime?{mimeType:audioMime}:{}),audioBitsPerSecond:64_000}),chunks:[],ended:false,failed:false} : undefined;
  const parts = analysis ? [primary,analysis] : [primary];
  let endpoint = {...INITIAL_LIVE_TURN}, activeMs = 0, activeSince = performance.now(), paused = false, stopping = false, settled = false, discarded = false;
  let stopReason:LiveAnswerStopReason = 'manual', durationMs = 0, issue:string|undefined;
  let context:AudioContext|undefined, source:MediaStreamAudioSourceNode|undefined, analyser:AnalyserNode|undefined, buffer:Float32Array<ArrayBuffer>|undefined;
  let meter:ReturnType<typeof setInterval>|undefined, limitTimer:ReturnType<typeof setTimeout>|undefined, finalTimer:ReturnType<typeof setTimeout>|undefined;
  const muteTimers = new Map<MediaStreamTrack,ReturnType<typeof setTimeout>>();
  const trackListeners:Array<{track:MediaStreamTrack;ended:()=>void;mute:()=>void;unmute:()=>void}> = [];
  const samples:RmsSample[] = [];
  let resolve!:(value:LiveAnswerRecording)=>void, reject!:(reason:Error)=>void;
  const finished = new Promise<LiveAnswerRecording>((yes,no)=>{resolve=yes;reject=no;});
  // Consumers often attach after construction. Explicit disposal must not raise an unhandled rejection in that gap.
  void finished.catch(()=>{});
  const elapsedMs = ()=>activeMs + (paused || stopping ? 0 : Math.max(0,performance.now()-activeSince));
  const maxDurationMs = Math.min(MAX_LIVE_ANSWER_MS,Math.max(1000,Number.isFinite(options.maxDurationMs)?options.maxDurationMs!:MAX_LIVE_ANSWER_MS));
  const notify = (level=0)=>{
    try {options.onLevel?.(level);} catch { /* A view callback must not leak the recorder. */ }
    try {options.onProgress?.({durationMs:Math.round(elapsedMs()),speechStarted:endpoint.speechStarted,silenceMs:Math.round(endpoint.silenceMs),endingSoon:endpoint.endingSoon,level,paused,measurementAvailable:Boolean(analyser && context?.state==='running')});} catch { /* Keep capture ownership even if a view callback fails. */ }
  };
  const releaseMeasurement = ()=>{
    if(meter!==undefined)clearInterval(meter);if(limitTimer!==undefined)clearTimeout(limitTimer);
    meter=undefined;limitTimer=undefined;
    try{source?.disconnect();}catch{}try{analyser?.disconnect();}catch{}
    if(context && context.state!=='closed')void context.close().catch(()=>{});
    for(const timer of muteTimers.values())clearTimeout(timer);muteTimers.clear();
    for(const listener of trackListeners){listener.track.removeEventListener('ended',listener.ended);listener.track.removeEventListener('mute',listener.mute);listener.track.removeEventListener('unmute',listener.unmute);}
    trackListeners.length=0;
  };
  const clearRecorders = ()=>{
    if(finalTimer!==undefined)clearTimeout(finalTimer);finalTimer=undefined;
    for(const part of parts){part.recorder.ondataavailable=null;part.recorder.onstop=null;part.recorder.onerror=null;part.chunks.length=0;}
  };
  const complete = (timedOut=false)=>{
    if(settled || !stopping || !timedOut && parts.some(part=>!part.ended))return;
    settled=true;releaseMeasurement();
    const primaryBlob=new Blob(primary.chunks,{type:primary.recorder.mimeType||primaryMime||(video?'video/webm':'audio/webm')});
    const analysisBlob=analysis?new Blob(analysis.chunks,{type:analysis.recorder.mimeType||audioMime||'audio/webm'}):undefined;
    const blob=primaryBlob.size?primaryBlob:analysisBlob;
    const partial=stopReason==='interrupted'||stopReason==='limit'||timedOut||parts.some(part=>part.failed)||!primaryBlob.size||Boolean(analysis&&!analysisBlob?.size);
    const telemetry=durationMs<=MAX_SPEECH_CAPTURE_MS?buildSpeechTelemetry(samples,durationMs):null;
    const result=blob?.size?{blob,...(analysisBlob?.size&&primaryBlob.size?{analysisAudio:analysisBlob}:{}),durationMs,telemetry:telemetry||undefined,reason:stopReason,partial,
      issue:issue||(timedOut?'녹음 종료가 지연되어 받은 부분까지만 보관했어요.':partial&&stopReason!=='limit'?'연결이 끊겨 녹음한 부분까지만 보관했어요.':undefined),speechStarted:endpoint.speechStarted,measurementAvailable:samples.length>0}:null;
    samples.length=0;clearRecorders();
    if(result){
      // Persistence belongs to the capture, so its final event survives a view unmount.
      Promise.resolve().then(()=>options.onComplete?.(result)).then(()=>resolve(result),()=>resolve({...result,partial:true,issue:'기기 임시 저장을 확인하지 못했어요. 이 화면에서 녹음을 내려받거나 서버에 저장해 주세요.'}));
    }else reject(new Error('녹음 파일을 받지 못했어요. 마이크를 확인하고 다시 말해 주세요.'));
  };
  const stop = (reason:LiveAnswerStopReason='manual')=>{
    if(stopping || settled)return finished;
    activeMs=elapsedMs();durationMs=Math.max(1,Math.round(activeMs));stopping=true;stopReason=reason;releaseMeasurement();
    finalTimer=setTimeout(()=>complete(true),FINAL_CHUNK_TIMEOUT_MS);
    for(const part of parts){
      if(part.ended)continue;
      if(part.recorder.state==='inactive')continue; // Its queued final data and stop events still belong to this capture.
      try{part.recorder.stop();}catch{part.failed=true;part.ended=true;issue='녹음을 끝내는 중 연결이 끊겼어요. 받은 부분은 보관했어요.';}
    }
    complete();return finished;
  };
  const armLimit = ()=>{if(limitTimer!==undefined)clearTimeout(limitTimer);limitTimer=setTimeout(()=>void stop('limit'),Math.max(0,maxDurationMs-elapsedMs()));};
  const measure = ()=>{
    if(paused || stopping || settled)return;
    const atMs=elapsedMs();
    if(atMs>=maxDurationMs){void stop('limit');return;}
    let rms=0;
    if(analyser && buffer && context?.state==='running'){
      try{analyser.getFloatTimeDomainData(buffer);}catch{issue='마이크 측정이 중단되어 말한 부분까지만 보관했어요.';void stop('interrupted');return;}
      let squares=0;for(const value of buffer)squares+=value*value;rms=Math.sqrt(squares/buffer.length);
      if(Number.isFinite(rms)&&rms<=1){if(samples.length<MAX_SPEECH_SAMPLES)samples.push({atMs,rms});endpoint=observeLiveTurn(endpoint,atMs,rms,options);if(options.autoStop?.()===false)endpoint={...endpoint,silenceMs:0,endingSoon:false,shouldStop:false};}
    }
    notify(rms);
    if(endpoint.shouldStop)void stop('silence');
  };
  for(const part of parts){
    part.recorder.ondataavailable=event=>{if(!settled&&!discarded&&event.data.size){part.chunks.push(event.data);try{options.onChunk?.(event.data,part===primary?'primary':'analysis',Math.round(stopping?durationMs:elapsedMs()));}catch{/* Complete retains the in-memory source even if persistence fails. */}}};
    part.recorder.onstop=()=>{part.ended=true;if(!stopping){issue='녹음 연결이 끊겨 말한 부분까지만 보관했어요.';void stop('interrupted');}else complete();};
    part.recorder.onerror=()=>{part.failed=true;issue='녹음 장치 오류로 말한 부분까지만 보관했어요.';void stop('interrupted');};
  }
  try{
    const AudioContextClass=window.AudioContext||(window as Window&{webkitAudioContext?:typeof AudioContext}).webkitAudioContext;
    if(AudioContextClass){try{context=new AudioContextClass();source=context.createMediaStreamSource(stream);analyser=context.createAnalyser();analyser.fftSize=2048;source.connect(analyser);buffer=new Float32Array(analyser.fftSize);void context.resume().then(measure).catch(()=>{});}catch{try{source?.disconnect();}catch{}analyser=undefined;}}
    activeSince=performance.now();
    for(const part of parts)part.recorder.start(250);
    for(const track of stream.getTracks()){
      const ended=()=>{issue='마이크 또는 카메라 연결이 끊겼어요. 말한 부분은 보관했어요.';void stop('interrupted');};
      const mute=()=>{if(paused||stopping)return;const old=muteTimers.get(track);if(old)clearTimeout(old);muteTimers.set(track,setTimeout(()=>{if(!paused&&!stopping&&track.muted)ended();},1500));};
      const unmute=()=>{const timer=muteTimers.get(track);if(timer!==undefined)clearTimeout(timer);muteTimers.delete(track);};
      track.addEventListener('ended',ended);track.addEventListener('mute',mute);track.addEventListener('unmute',unmute);trackListeners.push({track,ended,mute,unmute});
    }
    meter=setInterval(measure,SPEECH_SAMPLE_INTERVAL_MS);armLimit();
    for(const listener of trackListeners){if(listener.track.readyState!=='live'){listener.ended();break;}if(listener.track.muted)listener.mute();}
  }catch(error){
    settled=true;releaseMeasurement();for(const part of parts)if(part.recorder.state!=='inactive')try{part.recorder.stop();}catch{}
    clearRecorders();reject(error instanceof Error?error:new Error('녹음을 시작하지 못했어요.'));throw error;
  }
  return {finished,stop,
    pause(){if(paused||stopping||settled)return;activeMs=elapsedMs();paused=true;if(limitTimer!==undefined)clearTimeout(limitTimer);limitTimer=undefined;
      for(const timer of muteTimers.values())clearTimeout(timer);muteTimers.clear();
      try{for(const part of parts)if(part.recorder.state==='recording')part.recorder.pause();}catch{issue='일시정지 중 연결이 끊겼어요.';void stop('interrupted');}notify();},
    resume(){if(!paused||stopping||settled)return;
      if(stream.getAudioTracks().every(track=>track.readyState!=='live')){void stop('interrupted');return;}
      try{for(const part of parts)if(part.recorder.state==='paused')part.recorder.resume();}catch{issue='녹음을 이어가지 못했어요.';void stop('interrupted');return;}
      activeSince=performance.now();paused=false;void context?.resume().catch(()=>{});armLimit();for(const listener of trackListeners)if(listener.track.muted)listener.mute();notify();},
    dispose(){if(settled)return;discarded=true;settled=true;releaseMeasurement();for(const part of parts)if(part.recorder.state!=='inactive')try{part.recorder.stop();}catch{}samples.length=0;clearRecorders();reject(new DOMException('녹음을 취소했어요.','AbortError'));},
  };
}
