import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as oldModel from '../apps/web/src/lib/nonverbal-analysis-model.ts';
import * as timeline from '../apps/web/src/lib/nonverbal-timeline.ts';
async function fixture(options:{seekFails?:boolean;duration?:number;unsupported?:boolean}={}){
  const decoded:number[]=[],times:number[]=[];let terminated=0,revoked=0,closed=0,removed=0,clock=0;
  class Video extends EventTarget {videoWidth=640;videoHeight=360;duration=options.duration??1;readyState=2;muted=true;playsInline=true;preload='';set src(_v:string){queueMicrotask(()=>this.dispatchEvent(new Event('loadedmetadata')));}get currentTime(){return clock;}set currentTime(t:number){clock=t;queueMicrotask(()=>this.dispatchEvent(new Event(options.seekFails?'error':'seeked')));}removeAttribute(){removed++;}load(){}}
  class Worker extends EventTarget {terminate(){terminated++;}postMessage(value:any){queueMicrotask(()=>{if(value.type==='init')this.dispatchEvent(new MessageEvent('message',{data:{id:value.id,ready:true}}));else{times.push(value.atMs);this.dispatchEvent(new MessageEvent('message',{data:{id:value.id,frame:{atMs:value.atMs,v:[null,null,null,null],q:['not_detected','not_detected','not_detected','not_detected']}}}));}});}}
  const exported:any={},source=await readFile('apps/web/src/lib/client/video-samples.ts','utf8');
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:exported,require:(name:string)=>{if(name==='../nonverbal-analysis-model')return oldModel;if(name==='../nonverbal-timeline')return timeline;throw Error(name);},Worker:options.unsupported?undefined:Worker,OffscreenCanvas:class{},WebAssembly:{},createImageBitmap:async()=>({close(){closed++;}}),document:{createElement:(tag:string)=>tag==='video'?new Video():{width:0,height:0,getContext:()=>({drawImage(){decoded.push(clock);}})}},URL:{createObjectURL:()=>'blob:fixture',revokeObjectURL(){revoked++;}},DOMException,AbortController,setTimeout,clearTimeout,Number,Math,Blob,Uint8Array});
  return {run:exported.trackVideoBlob,supported:exported.supportsLocalVideoTracking,times,decoded,counts:()=>({terminated,revoked,closed,removed})};
}
test('client visits the full time axis with only one worker frame in flight and releases resources',async()=>{
  const f=await fixture(),result=await f.run(new Blob(['synthetic']),1);assert.deepEqual(f.times,[0,100,200,300,400,500,600,700,800,900]);assert.equal(result.frames.length,10);assert.equal(f.decoded.length,10);assert.equal(f.counts().revoked,1);assert.equal(f.counts().removed,1);assert.ok(f.counts().terminated>0);
});
test('cancel stops further frame extraction, terminates worker, and never returns a partial tracking result',async()=>{
  const f=await fixture(),abort=new AbortController();await assert.rejects(()=>f.run(new Blob(['synthetic']),1,abort.signal,(p:any)=>{if(p.completed===3)abort.abort();}),{name:'AbortError'});assert.equal(f.times.length,3);assert.equal(f.counts().revoked,1);assert.ok(f.counts().terminated>0);
});
test('unsupported browsers and oversized media fail before frame extraction',async()=>{
  const f=await fixture({unsupported:true});assert.equal(f.supported(),false);await assert.rejects(()=>f.run(new Blob(['synthetic']),1));assert.equal(f.decoded.length,0);
  const g=await fixture();await assert.rejects(()=>g.run(new Blob([new Uint8Array(20*1024*1024+1)]),1));assert.equal(g.times.length,0);
});
test('wrong original duration and repeated decoder errors fail without completing observations',async()=>{
  const f=await fixture({duration:10});await assert.rejects(()=>f.run(new Blob(['synthetic']),1));assert.equal(f.times.length,0);assert.equal(f.counts().revoked,1);
  const g=await fixture({seekFails:true});await assert.rejects(()=>g.run(new Blob(['synthetic']),1));assert.equal(g.times.length,1);assert.equal(g.counts().revoked,1);
});
