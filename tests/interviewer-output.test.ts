import assert from 'node:assert/strict';
import test from 'node:test';
import {outputRms,smoothMouth} from '../apps/web/src/lib/client/interviewer-audio-analyser';
import {InterviewerAvatarSignal} from '../apps/web/src/lib/client/interviewer-avatar';
import {InterviewerAudioOutput} from '../apps/web/src/lib/client/interviewer-audio-output';
import {Live2DController} from '../apps/web/src/lib/client/live2d-controller';

test('output RMS gates silence, rejects nonfinite samples and smooths measured attack and release',()=>{
  assert.equal(outputRms([]),0);assert.equal(outputRms([1,-1,1,-1]),1);assert.equal(outputRms([NaN,1]),0);
  assert.equal(smoothMouth(.001,0,16),0);const opening=smoothMouth(.2,0,16);assert.ok(opening>0&&opening<1);const closing=smoothMouth(0,opening,16);assert.ok(closing>0&&closing<opening);assert.equal(smoothMouth(Infinity,0,16),0);
});
test('only actual speaking output can open the active avatar mouth; renderer failures do not stop other consumers',()=>{
  const signal=new InterviewerAvatarSignal(),seen:any[]=[];signal.subscribe(()=>{throw Error('renderer failed');});signal.subscribe(frame=>seen.push(frame));signal.mouth(1);assert.equal(signal.snapshot.mouthOpen,0);
  signal.state('speaking','B');signal.mouth(.7);assert.equal(signal.snapshot.speakerId,'B');assert.equal(signal.snapshot.mouthOpen,.7);signal.state('listening','B');assert.equal(signal.snapshot.mouthOpen,0);signal.state('speaking','C');signal.mouth(3);assert.equal(signal.snapshot.mouthOpen,1);signal.silence();assert.equal(signal.snapshot.mouthOpen,0);signal.reset();assert.equal(seen.at(-1).state,'idle');
});
test('one audio element has one audible graph across concurrent unlocks, TTS/stream changes and teardown',async(t)=>{
  const previous={window:(globalThis as any).window,raf:globalThis.requestAnimationFrame,caf:globalThis.cancelAnimationFrame};const frames=new Map<number,FrameRequestCallback>();let frameId=0,sources=0,closed=0,amplitude=.2;
  const connections:any[]=[],streamConnections:any[]=[];let context:Context|undefined,resumes=0;
  class Context{state='running';destination={id:'destination'};constructor(){context=this;}async resume(){resumes++;this.state='running';}async close(){closed++;this.state='closed';}createAnalyser(){return {fftSize:1024,getFloatTimeDomainData(array:Float32Array){array.fill(amplitude);},disconnect(){}};}createMediaElementSource(){sources++;return {connect(target:any){connections.push(target);},disconnect(){}};}createMediaStreamSource(){return {connect(target:any){streamConnections.push(target);},disconnect(){}};}}
  (globalThis as any).window={AudioContext:Context};globalThis.requestAnimationFrame=callback=>{const id=++frameId;frames.set(id,callback);return id;};globalThis.cancelAnimationFrame=id=>{frames.delete(id);};
  t.after(()=>{(globalThis as any).window=previous.window;globalThis.requestAnimationFrame=previous.raf;globalThis.cancelAnimationFrame=previous.caf;});
  class Audio extends EventTarget{paused=true;ended=false;srcObject:any=null;removeAttribute(){}async play(){this.paused=false;this.dispatchEvent(new Event('playing'));}pause(){this.paused=true;this.dispatchEvent(new Event('pause'));}}
  const audio=new Audio(),signal=new InterviewerAvatarSignal(),output=new InterviewerAudioOutput(audio as any,signal);await Promise.all([output.unlock(),output.unlock(),output.unlock()]);
  assert.equal(sources,1);assert.equal(connections.filter(node=>node.id==='destination').length,1,'the analyser does not add another audible route');output.select('B');await audio.play();
  for(const [id,callback] of [...frames]){frames.delete(id);callback(performance.now()+16);}assert.ok(signal.snapshot.mouthOpen>0);output.syncState('thinking','C');assert.equal(signal.snapshot.state,'speaking');assert.equal(signal.snapshot.speakerId,'B','a late UI phase cannot replace the audible speaker');output.stop();assert.equal(signal.snapshot.mouthOpen,0);assert.equal(frames.size,0);
  output.setStream({} as MediaStream);await output.unlock();assert.equal(sources,1,'RTC reuses the existing element source');output.select('C');amplitude=0;await audio.play();for(const [id,callback] of [...frames]){frames.delete(id);callback(performance.now()+32);}assert.equal(signal.snapshot.mouthOpen,0);
  assert.equal(streamConnections.length,1);assert.ok(streamConnections.every(node=>node.id!=='destination'),'RTC observation never creates a second audible output');
  const beforeResume=resumes;context!.state='interrupted';await output.unlock();assert.equal(context!.state,'running','Safari interruption resumes on the next explicit start gesture');assert.equal(resumes,beforeResume+1);assert.equal(sources,1);
  output.dispose();output.dispose();assert.equal(closed,1);assert.equal(frames.size,0);assert.equal(audio.srcObject,null);
});
test('Cubism IDs are cached, mapped to the actual model range and written after motion; inactive mouths close',()=>{
  const calls:any[]=[];let ids=0;const handle={cubismId:'mouth'};const controller=new Live2DController({parameter(name){ids++;assert.equal(name,'ParamMouthOpenY');return {id:handle,min:.1,max:.9};},setParameter(id,value){calls.push(['parameter',id,value]);},update(_delta,state,reduced){calls.push(['motion',state,reduced]);},render(){calls.push(['render']);},destroy(){calls.push(['destroy']);}});
  controller.frame({state:'speaking',speakerId:'A',mouthOpen:.5},.02,true);assert.deepEqual(calls.map(call=>call[0]),['motion','parameter','render']);assert.equal(calls[1][1],handle);assert.equal(calls[1][2],.5);assert.equal(calls[0][2],true);
  controller.frame({state:'listening',speakerId:'A',mouthOpen:1},.02,false);assert.equal(calls.filter(call=>call[0]==='parameter').at(-1)[2],.1);controller.dispose();controller.dispose();assert.equal(ids,1);assert.equal(calls.filter(call=>call[0]==='destroy').length,1);
});
