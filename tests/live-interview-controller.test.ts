import assert from 'node:assert/strict';
import test from 'node:test';
import {LiveInterviewController,type LiveInterviewServices,type LiveInfo,type LiveSnapshot} from '../apps/web/src/lib/client/live-interview-controller';
import type {LiveAnswerRecording} from '../apps/web/src/lib/client/live-interview-recorder';

function deferred<T=void>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const recording=(patch:Partial<LiveAnswerRecording>={}):LiveAnswerRecording=>({blob:new Blob(['synthetic speech'],{type:'audio/webm'}),durationMs:7000,reason:'silence',partial:false,speechStarted:true,measurementAvailable:true,...patch});
function harness(count=1){
  const questions=Array.from({length:count},(_,index)=>({id:`q${index+1}`,turnId:`t${index+1}`,speakerId:`speaker${index%2+1}`,prompt:`합성 질문 ${index+1}`}));
  const info:LiveInfo={session:{state:'active',data:{generation:7,paused:true}},question:questions[0],turns:[],media:[]};
  const state={info,questions,index:0,calls:[] as any[],snapshots:[] as LiveSnapshot[],captures:[] as any[],overrides:{} as Partial<LiveInterviewServices>};
  const log=(name:string,...args:any[])=>state.calls.push({name,args});
  const services:LiveInterviewServices={
    async load(){log('load');return state.overrides.load?state.overrides.load():structuredClone(info);},
    async prepare(){log('prepare');await state.overrides.prepare?.();},
    mute(paused){log('mute',paused);state.overrides.mute?.(paused);},
    async suspend(){log('suspend');await state.overrides.suspend?.();info.session.data.paused=true;},
    async resume(){log('resume');await state.overrides.resume?.();info.session.data.paused=false;},
    async speak(question,generation,signal){log('speak',question.turnId,generation,signal);await state.overrides.speak?.(question,generation,signal);},
    captureDuringQuestion:()=>state.overrides.captureDuringQuestion?.()===true,
    async beforeCapture(question,generation,signal){log('beforeCapture',question,generation,signal);await state.overrides.beforeCapture?.(question,generation,signal);},
    capture(progress){log('capture');const done=deferred<LiveAnswerRecording>();void done.promise.catch(()=>{});const capture={finished:done.promise,pauseCalls:0,resumeCalls:0,disposeCalls:0,stopCalls:[] as any[],resolve:done.resolve,pause(){this.pauseCalls++;},resume(){this.resumeCalls++;},stop(reason='manual'){this.stopCalls.push(reason);done.resolve(recording({reason:reason as any}));return done.promise;},dispose(){this.disposeCalls++;done.reject(new DOMException('disposed','AbortError'));}};state.captures.push(capture);return capture;},
    async upload(value,question,generation,options){log('upload',value,question.turnId,generation,options);return state.overrides.upload?state.overrides.upload(value,question,generation,options):`media-${question.turnId}`;},
    async transcribe(mediaId){log('transcribe',mediaId);await state.overrides.transcribe?.(mediaId);},
    async answer(mediaId,question,generation){log('answer',mediaId,question,generation);if(state.overrides.answer)return state.overrides.answer(mediaId,question,generation);commit(question);},
    async finish(){log('finish');await state.overrides.finish?.();info.session.state='completed';info.question=null;},
    release(){log('release');state.overrides.release?.();},
    async wait(){log('wait');if(state.overrides.wait)await state.overrides.wait();else info.session.data.processing=false;},
  };
  function commit(question:LiveInfo){info.turns.push({id:question.turnId,answer:'저장된 전사'});state.index++;info.question=questions[state.index]||null;}
  const controller=new LiveInterviewController(structuredClone(info),services,snapshot=>state.snapshots.push(snapshot));
  const calls=(name:string)=>state.calls.filter(call=>call.name===name);
  const until=async(predicate:()=>boolean)=>{for(let i=0;i<30&&!predicate();i++)await tick();assert.ok(predicate(),`phase=${controller.state.phase}, calls=${state.calls.map(c=>c.name).join(',')}`);};
  return{state,controller,calls,until,commit};
}

test('one start runs spoken questions, silence capture, saved-media answers and finish in order',async()=>{
  const h=harness(2);await h.controller.start();await h.until(()=>h.state.captures.length===1);
  assert.deepEqual(h.calls('speak').map(c=>c.args[0]),['t1']);h.state.captures[0].resolve(recording());await h.until(()=>h.state.captures.length===2);
  h.state.captures[1].resolve(recording());await h.until(()=>h.controller.state.phase==='complete');
  assert.deepEqual(h.state.calls.filter(c=>['speak','capture','upload','transcribe','answer','finish'].includes(c.name)).map(c=>c.name),['speak','capture','upload','transcribe','answer','speak','capture','upload','transcribe','answer','finish']);
  assert.deepEqual(h.calls('answer').map(c=>[c.args[0],c.args[1].turnId,c.args[2]]),[['media-t1','t1',7],['media-t2','t2',7]]);
  assert.equal(h.calls('finish').length,1);assert.equal(h.calls('release').length,1);h.controller.dispose();
});

test('barge-in starts durable recording before RTC question and saves its exact attempt once',async()=>{
  const h=harness();h.state.overrides.captureDuringQuestion=()=>true;const playback=deferred<void>();h.state.overrides.speak=()=>playback.promise;
  await h.controller.start();await h.until(()=>h.calls('speak').length===1);
  assert.equal(h.state.captures.length,1);assert.ok(h.state.calls.findIndex(c=>c.name==='capture')<h.state.calls.findIndex(c=>c.name==='speak'));
  assert.equal(h.calls('answer').length,0);playback.resolve();await h.until(()=>h.controller.state.phase==='listening');
  h.state.captures[0].resolve(recording());await h.until(()=>h.controller.state.phase==='complete');
  assert.equal(h.calls('capture').length,1);assert.equal(h.calls('upload').length,1);assert.equal(h.calls('answer').length,1);h.controller.dispose();
});
test('unmount requests a preserving stop and never submits the late final recording',async()=>{
  const h=harness();await h.controller.start();await h.until(()=>h.state.captures.length===1);
  const capture=h.state.captures[0];h.controller.dispose();await tick();
  assert.deepEqual(capture.stopCalls,['interrupted']);assert.equal(capture.disposeCalls,0);assert.equal(h.calls('upload').length,0);assert.equal(h.calls('answer').length,0);
});
test('a recovered device recording is bound to the exact turn and generation before explicit save',async()=>{
  const h=harness(),saved=recording({partial:true,reason:'interrupted'});
  assert.equal(h.controller.restoreRecording(saved,{...h.state.questions[0],turnId:'other-turn'},7),false);
  assert.equal(h.controller.restoreRecording(saved,h.state.questions[0],8),false);
  assert.equal(h.controller.restoreRecording(saved,h.state.questions[0],7),true);assert.equal(h.calls('upload').length,0);
  await h.controller.start();await h.until(()=>h.controller.state.phase==='complete');assert.equal(h.calls('speak').length,0);assert.equal(h.calls('upload').length,1);assert.equal(h.calls('upload')[0].args[0],saved);h.controller.dispose();
});
test('pausing during the preparation countdown cannot start a recorder',async()=>{
  const h=harness();h.state.overrides.beforeCapture=async(_q,_g,signal)=>new Promise<void>((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('paused','AbortError')),{once:true}));
  await h.controller.start();await h.until(()=>h.calls('beforeCapture').length===1);h.controller.pause();await tick();assert.equal(h.state.captures.length,0);assert.equal(h.controller.state.phase,'paused');h.controller.dispose();
});

test('pause after preparation releases its reservation and resume prepares again before capture',async()=>{
  const h=harness();let reserved=false,pausedInGap=false;
  h.state.overrides.beforeCapture=async()=>{reserved=true;};
  h.state.overrides.mute=paused=>{if(paused)reserved=false;};
  // A visibility/pause event can run in the awaited checkpoint between the
  // preparation promise settling and capture taking ownership of its writer.
  const checkpoint=(h.controller as any).checkpoint.bind(h.controller);
  (h.controller as any).checkpoint=async(...args:any[])=>{
    if(reserved&&!pausedInGap){pausedInGap=true;h.controller.pause();}
    await checkpoint(...args);
  };
  await h.controller.start();await h.until(()=>pausedInGap);
  assert.equal(reserved,false);assert.equal(h.state.captures.length,0);
  await h.controller.start();await h.until(()=>h.state.captures.length===1);
  assert.equal(reserved,true,'capture must own a newly prepared reservation');
  assert.equal(h.calls('beforeCapture').length,2);assert.equal(h.controller.state.error,'');h.controller.dispose();
});
test('pause mid-answer resumes the same capture without replay or another recorder',async()=>{
  const h=harness();await h.controller.start();await h.until(()=>h.state.captures.length===1);const capture=h.state.captures[0];
  h.controller.pause();await tick();assert.equal(h.controller.state.phase,'paused');assert.equal(capture.pauseCalls,1);
  await h.controller.start();assert.equal(h.controller.state.phase,'listening');assert.equal(capture.resumeCalls,1);assert.equal(h.state.captures.length,1);assert.equal(h.calls('speak').length,1);
  capture.resolve(recording());await h.until(()=>h.controller.state.phase==='complete');h.controller.dispose();
});
test('changing remembered recording settings preserves the current capture and rechecks devices for the next question',async()=>{
  const h=harness(2);await h.controller.start();await h.until(()=>h.state.captures.length===1);
  await h.controller.resetDevices();await tick();
  assert.deepEqual(h.state.captures[0].stopCalls,['manual']);assert.equal(h.calls('release').length,1);assert.equal(h.calls('upload').length,0);assert.equal(h.controller.state.phase,'paused');assert.equal(h.controller.state.error,'');
  await h.controller.start();await h.until(()=>h.state.captures.length===2);
  assert.equal(h.calls('upload').length,1);assert.equal(h.calls('upload')[0].args[1],'t1');assert.equal(h.calls('prepare').length,2,'the released device is prepared again before the second recording');
  assert.equal(h.state.captures[0].resumeCalls,0,'a stopped capture cannot resume with its released tracks');
  h.state.captures[1].resolve(recording());await h.until(()=>h.controller.state.phase==='complete');h.controller.dispose();
});
test('pause during TTS aborts it and replays the whole question before opening the microphone',async()=>{
  const h=harness();h.state.overrides.speak=async(_q,_g,signal)=>{if(h.calls('speak').length===1)await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('paused','AbortError')),{once:true}));};
  await h.controller.start();await h.until(()=>h.calls('speak').length===1);h.controller.pause();const resumed=h.controller.start();await resumed;await h.until(()=>h.state.captures.length===1);
  assert.equal(h.calls('speak').length,2);assert.equal(h.calls('speak')[0].args[2].aborted,true);assert.equal(h.calls('suspend').length,1);assert.equal(h.controller.state.error,'');h.controller.dispose();
});
test('pause while a permission dialog is open cannot unmute or start after it resolves',async()=>{
  const h=harness(),permission=deferred();h.state.overrides.prepare=()=>permission.promise;const starting=h.controller.start();await h.until(()=>h.calls('prepare').length===1);
  h.controller.pause();permission.resolve();await starting;await tick();assert.equal(h.controller.state.phase,'paused');assert.equal(h.calls('resume').length,0);assert.equal(h.calls('speak').length,0);assert.equal(h.calls('mute').some(c=>c.args[0]===false),false);h.controller.dispose();
});
test('pause then immediate resume during preparation follows the newest user intent exactly once',async()=>{
  const h=harness(),permission=deferred();h.state.overrides.prepare=()=>permission.promise;const first=h.controller.start();await h.until(()=>h.calls('prepare').length===1);
  h.controller.pause();const resumed=h.controller.start();assert.equal(first,resumed);permission.resolve();await resumed;await h.until(()=>h.state.captures.length===1);
  assert.equal(h.calls('resume').length,1);assert.equal(h.calls('speak').length,1);assert.equal(h.state.captures.length,1);h.controller.dispose();
});
test('pause and server resume are serialized when a resume request is still in flight',async()=>{
  const h=harness(),resume=deferred();h.state.overrides.resume=()=>resume.promise;const starting=h.controller.start();await h.until(()=>h.calls('resume').length===1);
  h.controller.pause();await tick();assert.equal(h.calls('suspend').length,0);resume.resolve();await starting;await h.until(()=>h.calls('suspend').length===1);
  assert.equal(h.state.info.session.data.paused,true);assert.equal(h.calls('capture').length,0);h.controller.dispose();
});
test('pause during upload retains its media identity and waits before transcription and answer',async()=>{
  const h=harness(),upload=deferred<string>();h.state.overrides.upload=()=>upload.promise;await h.controller.start();await h.until(()=>h.state.captures.length===1);
  h.state.captures[0].resolve(recording());await h.until(()=>h.calls('upload').length===1);h.controller.pause();upload.resolve('durable-media');await tick();assert.equal(h.calls('transcribe').length,0);assert.equal(h.calls('answer').length,0);
  await h.controller.start();await h.until(()=>h.controller.state.phase==='complete');assert.equal(h.calls('upload').length,1);assert.equal(h.calls('answer')[0].args[0],'durable-media');h.controller.dispose();
});
test('pause during transcription waits for resume before submitting the saved transcript',async()=>{
  const h=harness(),transcribe=deferred();h.state.overrides.transcribe=()=>transcribe.promise;await h.controller.start();await h.until(()=>h.state.captures.length===1);h.state.captures[0].resolve(recording());await h.until(()=>h.calls('transcribe').length===1);
  h.controller.pause();transcribe.resolve();await tick();assert.equal(h.calls('answer').length,0);await h.controller.start();await h.until(()=>h.controller.state.phase==='complete');assert.equal(h.calls('transcribe').length,1);h.controller.dispose();
});
test('a lost answer response reloads its committed receipt without a second answer or upload',async()=>{
  const h=harness(2);h.state.overrides.answer=async(_media,question)=>{h.commit(question);if(question.turnId==='t1')throw Error('response lost after commit');};
  await h.controller.start();await h.until(()=>h.state.captures.length===1);h.state.captures[0].resolve(recording());await h.until(()=>h.state.captures.length===2);
  assert.equal(h.calls('answer').length,1);assert.equal(h.calls('upload').length,1);assert.equal(h.controller.state.error,'');h.controller.dispose();
});
test('known no-speech capture is preserved for recovery but never uploaded or answered',async()=>{
  const h=harness();await h.controller.start();await h.until(()=>h.state.captures.length===1);h.state.captures[0].resolve(recording({speechStarted:false,reason:'limit',partial:true}));await h.until(()=>h.controller.state.phase==='error');
  assert.equal(h.calls('upload').length,0);assert.equal(h.calls('answer').length,0);assert.ok(h.controller.state.recording);
  await h.controller.start();await h.until(()=>h.state.captures.length===2);assert.equal(h.calls('speak').length,2);h.controller.dispose();
});
test('an interrupted partial recording requires an explicit retry and then reuses that recording',async()=>{
  const h=harness();await h.controller.start();await h.until(()=>h.state.captures.length===1);const partial=recording({reason:'interrupted',partial:true,issue:'장치 연결 끊김'});h.state.captures[0].resolve(partial);await h.until(()=>h.controller.state.phase==='error');
  assert.equal(h.calls('upload').length,0);assert.equal(h.controller.state.recording,partial);await h.controller.start();await h.until(()=>h.controller.state.phase==='complete');
  assert.equal(h.calls('upload')[0].args[0],partial);assert.equal(h.state.captures.length,1);h.controller.dispose();
});
test('finish saves the current answer before ending and never speaks the next question',async()=>{
  const h=harness(2);await h.controller.start();await h.until(()=>h.state.captures.length===1);await h.controller.finish();await h.until(()=>h.controller.state.phase==='complete');
  assert.deepEqual(h.state.captures[0].stopCalls,['manual']);assert.equal(h.calls('answer').length,1);assert.equal(h.calls('finish').length,1);assert.equal(h.calls('speak').length,1);assert.equal(h.calls('prepare').length,1);h.controller.dispose();
});
test('dispose during upload cannot start transcription or submit a stale answer',async()=>{
  const h=harness(),upload=deferred<string>();h.state.overrides.upload=()=>upload.promise;await h.controller.start();await h.until(()=>h.state.captures.length===1);h.state.captures[0].resolve(recording());await h.until(()=>h.calls('upload').length===1);
  h.controller.dispose();upload.resolve('late-media');await tick();assert.equal(h.calls('transcribe').length,0);assert.equal(h.calls('answer').length,0);assert.equal(h.calls('release').length,1);
});
test('dispose during preparation releases devices that arrive after unmount',async()=>{
  const h=harness(),permission=deferred();h.state.overrides.prepare=()=>permission.promise;const starting=h.controller.start();await h.until(()=>h.calls('prepare').length===1);h.controller.dispose();permission.resolve();await starting;
  assert.equal(h.calls('speak').length,0);assert.equal(h.calls('mute').some(c=>c.args[0]===false),false);assert.equal(h.calls('release').length,2);
});
test('retry while the failed loop is still suspending starts exactly one replacement loop',async()=>{
  const h=harness(),suspend=deferred();let failOnce=true;h.state.overrides.suspend=()=>suspend.promise;
  h.state.overrides.transcribe=async()=>{if(failOnce){failOnce=false;throw Error('temporary transcription outage');}};
  await h.controller.start();await h.until(()=>h.state.captures.length===1);h.state.captures[0].resolve(recording());await h.until(()=>h.controller.state.phase==='error');
  const retry=h.controller.start();suspend.resolve();await retry;await h.until(()=>h.controller.state.phase==='complete');
  assert.equal(h.calls('upload').length,1);assert.equal(h.calls('transcribe').length,2);assert.equal(h.calls('answer').length,1);assert.equal(h.state.captures.length,1);h.controller.dispose();
});
test('explicit exit after no-speech transcription preserves the stored recording and never forces recognition or an answer',async()=>{
  const h=harness();h.state.overrides.transcribe=async()=>{throw Error('음성을 확인하지 못했어요.');};
  await h.controller.start();await h.until(()=>h.state.captures.length===1);const saved=recording();h.state.captures[0].resolve(saved);await h.until(()=>h.controller.state.phase==='error');
  assert.equal(h.calls('upload').length,1);assert.equal(h.calls('transcribe').length,1);assert.equal(h.calls('answer').length,0);
  h.controller.pause();await h.controller.finish({preserveOnly:true});await h.until(()=>h.controller.state.phase==='complete');
  assert.equal(h.calls('transcribe').length,1);assert.equal(h.calls('upload').length,1);assert.equal(h.calls('answer').length,0);assert.equal(h.calls('finish').length,1);
  assert.equal(h.controller.state.recording,saved);assert.equal(h.state.info.turns.length,0);h.controller.dispose();
});
test('explicit error exit saves an unuploaded partial recording before finishing without transcription',async()=>{
  const h=harness();await h.controller.start();await h.until(()=>h.state.captures.length===1);const partial=recording({partial:true,reason:'interrupted',issue:'마이크 연결 끊김'});h.state.captures[0].resolve(partial);await h.until(()=>h.controller.state.phase==='error');
  assert.equal(h.calls('upload').length,0);await h.controller.finish({preserveOnly:true});await h.until(()=>h.controller.state.phase==='complete');
  assert.equal(h.calls('upload').length,1);assert.equal(h.calls('upload')[0].args[0],partial);assert.deepEqual(h.calls('upload')[0].args[3],{deferTranscription:true});assert.equal(h.calls('transcribe').length,0);assert.equal(h.calls('answer').length,0);assert.equal(h.calls('finish').length,1);h.controller.dispose();
});
test('failed preservation blocks completion but retains local bytes for an explicit exit retry',async()=>{
  const h=harness();h.state.overrides.upload=async()=>{throw Error('연결 끊김');};await h.controller.start();await h.until(()=>h.state.captures.length===1);const saved=recording();h.state.captures[0].resolve(saved);await h.until(()=>h.controller.state.phase==='error');
  await h.controller.finish({preserveOnly:true});await h.until(()=>h.calls('upload').length===2&&h.controller.state.phase==='error');
  assert.equal(h.calls('finish').length,0);assert.equal(h.controller.state.recording,saved);h.state.overrides.upload=async()=> 'durably-preserved-media';
  await h.controller.finish({preserveOnly:true});await h.until(()=>h.controller.state.phase==='complete');assert.equal(h.calls('upload').length,3);assert.equal(h.calls('transcribe').length,0);assert.equal(h.calls('answer').length,0);assert.equal(h.calls('finish').length,1);h.controller.dispose();
});
test('a durable current-turn recording is recovered without another question playback or recording',async()=>{
  const h=harness();h.state.info.media=[{id:'existing-media',metadata:{kind:'answer_recording',turnId:'t1',generation:7}}];
  await h.controller.start();await h.until(()=>h.controller.state.phase==='complete');
  assert.equal(h.calls('speak').length,0);assert.equal(h.calls('capture').length,0);assert.equal(h.calls('upload').length,0);assert.equal(h.calls('transcribe')[0].args[0],'existing-media');assert.equal(h.calls('answer')[0].args[0],'existing-media');h.controller.dispose();
});
test('an ambiguous answer still processing is polled and its receipt prevents a duplicate submission',async()=>{
  const h=harness();h.state.overrides.answer=async()=>{h.state.info.session.data.processing=true;throw Error('connection lost while processing');};
  h.state.overrides.wait=async()=>{h.commit(h.state.questions[0]);h.state.info.session.data.processing=false;};
  await h.controller.start();await h.until(()=>h.state.captures.length===1);h.state.captures[0].resolve(recording());await h.until(()=>h.controller.state.phase==='complete');
  assert.equal(h.calls('answer').length,1);assert.equal(h.calls('upload').length,1);assert.equal(h.calls('wait').length,1);h.controller.dispose();
});
test('finish while paused retains the paused answer and finishes without permission preparation again',async()=>{
  const h=harness(2);await h.controller.start();await h.until(()=>h.state.captures.length===1);h.controller.pause();await tick();await h.controller.finish();await h.until(()=>h.controller.state.phase==='complete');
  assert.equal(h.calls('prepare').length,1);assert.equal(h.calls('answer').length,1);assert.equal(h.calls('speak').length,1);assert.equal(h.calls('finish').length,1);h.controller.dispose();
});
test('finish during an incomplete spoken question aborts playback and closes without inventing an answer',async()=>{
  const h=harness();h.state.overrides.speak=async(_q,_g,signal)=>new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('ending','AbortError')),{once:true}));
  await h.controller.start();await h.until(()=>h.calls('speak').length===1);await h.controller.finish();await h.until(()=>h.controller.state.phase==='complete');
  assert.equal(h.calls('capture').length,0);assert.equal(h.calls('answer').length,0);assert.equal(h.calls('finish').length,1);h.controller.dispose();
});
test('a stale paused response arriving during resume cannot pause the newly resumed loop again',async()=>{
  const h=harness(),read=deferred<LiveInfo>();h.state.overrides.load=async()=>h.calls('load').length===3?read.promise:structuredClone(h.state.info);
  await h.controller.start();await h.until(()=>h.calls('load').length===3);h.controller.pause();await tick();read.resolve(structuredClone(h.state.info));await tick();
  await h.controller.start();await h.until(()=>h.state.captures.length===1);assert.equal(h.calls('suspend').length,1);assert.equal(h.controller.state.phase,'listening');h.controller.dispose();
});
test('explicit rerecord ignores every old current-turn media locally without deleting files or a draft',async()=>{
  const h=harness();h.state.questions[0].draft='사용자가 직접 쓴 초안';h.state.info.media=['old-one','old-two'].map(id=>({id,metadata:{kind:'answer_recording',turnId:'t1',generation:7}}));
  h.state.overrides.transcribe=async id=>{if(id.startsWith('old-'))throw Error('NO_SPEECH_DETECTED');};
  await h.controller.start();await h.until(()=>h.controller.state.phase==='error');assert.equal(h.calls('transcribe')[0].args[0],'old-two');
  await h.controller.rerecord();await h.until(()=>h.state.captures.length===1);assert.equal(h.controller.state.recording,undefined);h.state.captures[0].resolve(recording());await h.until(()=>h.controller.state.phase==='complete');
  assert.deepEqual(h.calls('transcribe').map(c=>c.args[0]),['old-two','media-t1']);assert.equal(h.state.info.media.length,2);assert.equal(h.state.questions[0].draft,'사용자가 직접 쓴 초안');assert.equal(h.calls('answer').length,1);h.controller.dispose();
});
test('rerecord refuses a changed unanswered turn and preserves the pending recording',async()=>{
  const h=harness(2);h.state.overrides.transcribe=async()=>{throw Error('ASR failed');};await h.controller.start();await h.until(()=>h.state.captures.length===1);const original=recording();h.state.captures[0].resolve(original);await h.until(()=>h.controller.state.phase==='error');
  h.state.info.question=h.state.questions[1];h.state.info.session.data.generation=8;await h.controller.rerecord();assert.equal(h.controller.state.phase,'error');assert.match(h.controller.state.error,/질문 상태/);assert.equal(h.controller.state.recording,original);assert.equal(h.state.captures.length,1);h.controller.dispose();
});
test('rerecord sees an already committed answer and continues with the real next question',async()=>{
  const h=harness(2);h.state.overrides.transcribe=async()=>{throw Error('ASR failed');};await h.controller.start();await h.until(()=>h.state.captures.length===1);h.state.captures[0].resolve(recording());await h.until(()=>h.controller.state.phase==='error');
  h.commit(h.state.questions[0]);h.state.overrides.transcribe=undefined;await h.controller.rerecord();await h.until(()=>h.state.captures.length===2);assert.deepEqual(h.calls('speak').map(c=>c.args[0]),['t1','t2']);assert.equal(h.calls('answer').length,0);h.controller.dispose();
});
test('rerecord retires a paused in-flight upload before creating the new attempt',async()=>{
  const h=harness(),upload=deferred<string>();h.state.overrides.upload=async()=>{const id=await upload.promise;h.state.info.media.push({id,metadata:{kind:'answer_recording',turnId:'t1',generation:7}});return id;};
  await h.controller.start();await h.until(()=>h.state.captures.length===1);h.state.captures[0].resolve(recording());await h.until(()=>h.calls('upload').length===1);h.controller.pause();
  const replace=h.controller.rerecord();await tick();upload.resolve('late-old-media');await replace;await h.until(()=>h.state.captures.length===2);assert.equal(h.calls('transcribe').length,0);assert.equal(h.calls('answer').length,0);assert.equal(h.state.info.media[0].id,'late-old-media');h.controller.dispose();
});
test('dispose during rerecord validation cannot restart devices or discard the preserved snapshot',async()=>{
  const h=harness();h.state.overrides.transcribe=async()=>{throw Error('ASR failed');};await h.controller.start();await h.until(()=>h.state.captures.length===1);const original=recording();h.state.captures[0].resolve(original);await h.until(()=>h.controller.state.phase==='error');
  const load=deferred<LiveInfo>();h.state.overrides.load=()=>load.promise;const replace=h.controller.rerecord();await tick();h.controller.dispose();load.resolve(structuredClone(h.state.info));await replace;assert.equal(h.state.captures.length,1);assert.equal(h.controller.state.recording,original);
});
test('explicit manual completion can reach real transcription when amplitude detection missed quiet speech',async()=>{
  const h=harness();await h.controller.start();await h.until(()=>h.state.captures.length===1);h.state.captures[0].resolve(recording({reason:'manual',speechStarted:false}));await h.until(()=>h.controller.state.phase==='complete');
  assert.equal(h.calls('upload').length,1);assert.equal(h.calls('transcribe').length,1);assert.equal(h.calls('answer').length,1);h.controller.dispose();
});
