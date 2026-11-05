import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function worklet(rate: number) {
  let Constructor: any;
  const messages: any[]=[];
  const sandbox={sampleRate:rate,AudioWorkletProcessor:class {port={postMessage:(message:any)=>messages.push(message),onmessage:null};},registerProcessor:(_name:string,ctor:any)=>{Constructor=ctor;},ArrayBuffer,DataView,Math};
  vm.runInNewContext(readFileSync('public/audio-capture.worklet.js','utf8'),sandbox);
  const instance=new Constructor();
  return {instance,messages};
}
test('actual worklet resamples 44.1/48kHz mono audio to 16k PCM, with 100ms chunks',()=>{
  for(const sampleRate of [44100,48000]) {
    const {instance,messages}=worklet(sampleRate);
    instance.port.onmessage({data:{type:'capture',enabled:true}});
    for(let i=0;i<sampleRate;i+=128) instance.process([[new Float32Array(Math.min(128,sampleRate-i)).fill(.5)]]);
    instance.port.onmessage({data:{type:'flush',id:'final'}});
    const chunks=messages.filter(m=>m.type==='pcm');
    assert.equal(chunks.reduce((total,m)=>total+m.buffer.byteLength/2,0),16000);
    assert.ok(chunks.every(c=>c.buffer.byteLength<=3200));
    assert.equal(new DataView(chunks[0].buffer).getInt16(0,true),16384);
    assert.ok(messages.some(m=>m.type==='flushed'&&m.id==='final'));
  }
});
test('worklet sends no PCM while capture disabled and averages stereo channels',()=>{
  const {instance,messages}=worklet(48000);
  instance.process([[new Float32Array(4800).fill(1)]]);
  assert.equal(messages.length,0);
  instance.port.onmessage({data:{type:'capture',enabled:true}});
  instance.process([[new Float32Array(4800).fill(1),new Float32Array(4800).fill(-1)]]);
  const output=messages.find(m=>m.type==='pcm');
  assert.ok(output); assert.equal(new DataView(output.buffer).getInt16(0,true),0);
});
