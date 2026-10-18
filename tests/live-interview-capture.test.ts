import assert from 'node:assert/strict';
import test from 'node:test';
import {createLiveAnswerCapture, type LiveCaptureProgress} from '../apps/web/src/lib/client/live-interview-recorder';
import {validateSpeechTelemetry} from '../apps/web/src/lib/speech-analysis';

async function fakeCapture(run:(state:any)=>Promise<void>|void,{video=false,audioContext=true}={}){
  const originals=Object.fromEntries(['window','MediaStream','performance','setInterval','clearInterval','setTimeout','clearTimeout'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  let id=0;
  class Track extends EventTarget {kind:string;readyState='live';muted=false;constructor(kind:string){super();this.kind=kind;}stop(){throw Error('Must not stop caller-owned tracks');}end(){this.readyState='ended';this.dispatchEvent(new Event('ended'));}}
  class Stream {tracks:Track[];constructor(tracks:Track[]){this.tracks=tracks;}getTracks(){return this.tracks;}getAudioTracks(){return this.tracks.filter(t=>t.kind==='audio');}getVideoTracks(){return this.tracks.filter(t=>t.kind==='video');}}
  const state={now:0,rms:0,recorders:[] as any[],timers:new Map<number,{callback:()=>void;at:number;interval?:number}>(),progress:[] as LiveCaptureProgress[],connections:[] as unknown[],closes:0,stream:new Stream([new Track('audio'),...(video?[new Track('video')]:[])]),context:null as any,
    advance(ms:number,rms=this.rms){this.now+=ms;this.rms=rms;for(const [key,timer] of [...this.timers])if(timer.at<=this.now){if(timer.interval)timer.at=this.now+timer.interval;else this.timers.delete(key);timer.callback();}},
    run(ms:number,rms:number){for(let elapsed=0;elapsed<ms;elapsed+=100)this.advance(Math.min(100,ms-elapsed),rms);}};
  class Recorder {
    static isTypeSupported(){return true;}
    state='inactive';mimeType:string;stopCalls=0;pauseCalls=0;resumeCalls=0;
    ondataavailable:any;onstop:any;onerror:any;
    constructor(_stream:any,options?:any){this.mimeType=options?.mimeType||'audio/webm';state.recorders.push(this);}
    start(){this.state='recording';}
    stop(){this.stopCalls++;this.state='inactive';}
    pause(){this.pauseCalls++;this.state='paused';}
    resume(){this.resumeCalls++;this.state='recording';}
    chunk(text:string){this.ondataavailable?.({data:new Blob([text],{type:this.mimeType})});}
    finish(text='final'){this.state='inactive';this.chunk(text);this.onstop?.();}
  }
  class AudioContext {
    state='suspended';destination={speaker:true};
    constructor(){state.context=this;}
    createMediaStreamSource(){return{connect(node:any){state.connections.push(node);},disconnect(){}};}
    createAnalyser(){return{fftSize:2048,getFloatTimeDomainData(values:Float32Array){values.fill(state.rms);},disconnect(){}};}
    async resume(){this.state='running';}async close(){this.state='closed';state.closes++;}
  }
  Object.defineProperty(globalThis,'window',{configurable:true,value:{MediaRecorder:Recorder,...(audioContext?{AudioContext}:{})}});
  Object.defineProperty(globalThis,'MediaStream',{configurable:true,value:Stream});
  Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>state.now}});
  Object.defineProperty(globalThis,'setInterval',{configurable:true,value:(callback:()=>void,interval:number)=>{const key=++id;state.timers.set(key,{callback,at:state.now+interval,interval});return key;}});
  Object.defineProperty(globalThis,'setTimeout',{configurable:true,value:(callback:()=>void,ms:number)=>{const key=++id;state.timers.set(key,{callback,at:state.now+ms});return key;}});
  Object.defineProperty(globalThis,'clearInterval',{configurable:true,value:(key:number)=>state.timers.delete(key)});
  Object.defineProperty(globalThis,'clearTimeout',{configurable:true,value:(key:number)=>state.timers.delete(key)});
  try{await run(state);}finally{for(const [name,descriptor] of Object.entries(originals))if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete(globalThis as any)[name];}
}

test('one stop promise waits for both final recorders and freezes fractional duration',async()=>{
  await fakeCapture(async state=>{
    const capture=createLiveAnswerCapture(state.stream);await Promise.resolve();state.run(900,.04);state.advance(99.7,.04);
    const result=capture.stop();assert.equal(result,capture.stop());assert.equal(result,capture.finished);
    let resolved=false;void result.then(()=>{resolved=true;});
    state.recorders[0].finish('video-final');await Promise.resolve();assert.equal(resolved,false);
    state.advance(2500);state.recorders[1].finish('audio-final');const saved=await result;
    assert.equal(saved.durationMs,1000);assert.equal(saved.telemetry?.durationMs,1000);assert.ok(validateSpeechTelemetry(saved.telemetry));
    assert.equal(await saved.blob.text(),'video-final');assert.equal(await saved.analysisAudio!.text(),'audio-final');
    assert.equal(saved.reason,'manual');assert.equal(saved.partial,false);assert.ok(state.recorders.every((r:any)=>r.stopCalls===1));assert.equal(state.timers.size,0);assert.equal(state.connections.length,1);
  },{video:true});
});
test('silence auto-finishes only after speech and a visible warning',async()=>{
  await fakeCapture(async state=>{
    const capture=createLiveAnswerCapture(state.stream,{onProgress:p=>state.progress.push(p)});await Promise.resolve();
    state.run(10000,0);assert.equal(state.recorders[0].stopCalls,0);
    state.run(700,.04);state.run(3900,0);assert.equal(state.recorders[0].stopCalls,0);assert.equal(state.progress.at(-1).endingSoon,false);
    state.run(100,0);assert.equal(state.progress.at(-1).endingSoon,true);state.run(1000,0);
    assert.equal(state.recorders[0].stopCalls,1);state.recorders[0].finish();const saved=await capture.finished;
    assert.equal(saved.reason,'silence');assert.equal(saved.speechStarted,true);assert.equal(saved.partial,false);
  });
});
test('speech during warning and throttled timers cannot submit prematurely',async()=>{
  await fakeCapture(async state=>{
    const capture=createLiveAnswerCapture(state.stream);await Promise.resolve();state.run(700,.04);state.run(4000,0);state.run(100,.04);state.run(4000,0);
    state.advance(60000,0);assert.equal(state.recorders[0].stopCalls,0);state.run(4900,0);assert.equal(state.recorders[0].stopCalls,0);
    capture.stop();state.recorders[0].finish();const saved=await capture.finished;assert.equal(saved.reason,'manual');assert.ok(saved.telemetry?.limitations.includes('capture-gaps'));
  });
});
test('pause and resume freeze both recorders, silence clock and three-minute limit',async()=>{
  await fakeCapture(async state=>{
    const capture=createLiveAnswerCapture(state.stream,{onProgress:p=>state.progress.push(p),maxDurationMs:10000});await Promise.resolve();state.run(700,.04);state.run(4000,0);
    capture.pause();capture.pause();state.advance(90000,0);assert.equal(state.recorders[0].stopCalls,0);assert.equal(state.progress.at(-1).durationMs,4700);
    assert.ok(state.recorders.every((r:any)=>r.pauseCalls===1));capture.resume();capture.resume();state.run(900,0);assert.equal(state.recorders[0].stopCalls,0);state.run(100,0);assert.equal(state.recorders[0].stopCalls,1);
    for(const recorder of state.recorders)recorder.finish();const saved=await capture.finished;assert.equal(saved.durationMs,5700);assert.equal(saved.reason,'silence');assert.ok(state.recorders.every((r:any)=>r.resumeCalls===1));assert.ok(validateSpeechTelemetry(saved.telemetry));
  },{video:true});
});
test('opening silence at the limit is not labelled a spoken answer',async()=>{
  await fakeCapture(async state=>{
    const capture=createLiveAnswerCapture(state.stream);await Promise.resolve();state.run(180000,0);state.recorders[0].finish();const saved=await capture.finished;
    assert.equal(saved.reason,'limit');assert.equal(saved.partial,true);assert.equal(saved.speechStarted,false);assert.equal(saved.durationMs,180000);assert.deepEqual(saved.telemetry?.speechSegments,[]);
  });
});
test('no WebAudio leaves manual finishing available without invented silence evidence',async()=>{
  await fakeCapture(async state=>{
    const capture=createLiveAnswerCapture(state.stream,{onProgress:p=>state.progress.push(p)});state.run(20000,0);assert.equal(state.recorders[0].stopCalls,0);
    capture.stop();state.recorders[0].finish();const saved=await capture.finished;assert.equal(saved.telemetry,undefined);assert.equal(saved.measurementAvailable,false);assert.equal(saved.reason,'manual');assert.equal(state.progress.at(-1).measurementAvailable,false);
  },{audioContext:false});
});
test('track loss preserves partial audio and ignores later stop duplication',async()=>{
  await fakeCapture(async state=>{
    const capture=createLiveAnswerCapture(state.stream);await Promise.resolve();state.run(700,.04);state.recorders[0].chunk('first-');state.stream.getAudioTracks()[0].end();
    assert.equal(state.recorders[0].stopCalls,1);state.recorders[0].finish('last');const saved=await capture.finished;
    assert.equal(saved.reason,'interrupted');assert.equal(saved.partial,true);assert.equal(await saved.blob.text(),'first-last');assert.equal(capture.stop(),capture.finished);
  });
});
test('persistent mute stops safely while a temporary or paused mute does not',async()=>{
  await fakeCapture(async state=>{
    const capture=createLiveAnswerCapture(state.stream);await Promise.resolve();const track=state.stream.getAudioTracks()[0];
    track.muted=true;track.dispatchEvent(new Event('mute'));state.advance(1000);track.muted=false;track.dispatchEvent(new Event('unmute'));state.advance(1000);assert.equal(state.recorders[0].stopCalls,0);
    capture.pause();track.muted=true;track.dispatchEvent(new Event('mute'));state.advance(10000);assert.equal(state.recorders[0].stopCalls,0);track.muted=false;capture.resume();
    track.muted=true;track.dispatchEvent(new Event('mute'));state.advance(1500);state.recorders[0].finish();assert.equal((await capture.finished).reason,'interrupted');
  });
});
test('a missing final stop event resolves with preserved chunks and an explicit partial flag',async()=>{
  await fakeCapture(async state=>{
    const capture=createLiveAnswerCapture(state.stream);await Promise.resolve();state.run(700,.04);state.recorders[0].chunk('available');capture.stop();state.advance(10000);
    const saved=await capture.finished;assert.equal(saved.partial,true);assert.match(saved.issue!,/지연/);assert.equal(await saved.blob.text(),'available');assert.equal(saved.durationMs,700);assert.equal(state.timers.size,0);
  });
});
test('dispose rejects once, discards late data and releases only owned recording resources',async()=>{
  await fakeCapture(async state=>{
    const capture=createLiveAnswerCapture(state.stream);await Promise.resolve();state.run(700,.04);capture.dispose();capture.dispose();state.recorders[0].finish();
    await assert.rejects(capture.finished,error=>(error as Error).name==='AbortError');assert.equal(state.recorders[0].stopCalls,1);assert.equal(state.timers.size,0);assert.equal(state.closes,1);
  });
});
test('cancel during pending final delivery cannot resurrect a discarded answer',async()=>{
  await fakeCapture(async state=>{
    const capture=createLiveAnswerCapture(state.stream);await Promise.resolve();state.run(700,.04);const stopped=capture.stop();state.recorders[0].finish('video-final');capture.dispose();state.recorders[1].finish('late-audio');
    await assert.rejects(stopped,error=>(error as Error).name==='AbortError');assert.equal(state.timers.size,0);assert.ok(state.recorders.every((r:any)=>r.stopCalls===1));
  },{video:true});
});
test('recorder failure waits for final audio and returns an interrupted partial recording',async()=>{
  await fakeCapture(async state=>{
    const capture=createLiveAnswerCapture(state.stream);await Promise.resolve();state.run(700,.04);state.recorders[0].onerror();state.recorders[0].finish('partial-video');state.recorders[1].finish('complete-audio');
    const saved=await capture.finished;assert.equal(saved.reason,'interrupted');assert.equal(saved.partial,true);assert.equal(await saved.analysisAudio!.text(),'complete-audio');
  },{video:true});
});
test('a device still muted on resume interrupts without falsely ending on silence',async()=>{
  await fakeCapture(async state=>{
    const capture=createLiveAnswerCapture(state.stream);await Promise.resolve();state.run(700,.04);capture.pause();state.stream.getAudioTracks()[0].muted=true;state.advance(10000);capture.resume();state.advance(1500);state.recorders[0].finish();
    assert.equal((await capture.finished).reason,'interrupted');
  });
});
