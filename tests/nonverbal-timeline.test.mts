import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as timeline from '../apps/web/src/lib/nonverbal-timeline.ts';
const frame=(atMs:number,value=0):timeline.TrackFrame=>({atMs,v:[[0,0],[.5,.5],[value,0],[0,0]],q:['observed','observed','observed','observed']});
const track=(values:number[]):timeline.Tracking=>({version:timeline.TIMELINE_VERSION,durationMs:values.length*100,intervalMs:100,frames:values.map((value,i)=>frame(i*100,value))});
test('full time axis is required, reordered, missing, mismatched quality and wrong source duration fail closed',()=>{
  const input=track(Array(20).fill(0));assert.equal(timeline.validateTracking(input,2000).frames.length,20);
  for(const invalid of [{...input,frames:input.frames.slice(1)},{...input,frames:[...input.frames].reverse()},{...input,durationMs:3000},{...input,frames:input.frames.map((f,i)=>i===0?{...f,q:['low_confidence',...f.q.slice(1)]}:f)}])assert.throws(()=>timeline.validateTracking(invalid,2000));
  assert.throws(()=>timeline.trackingTimes(1_200_001));
});
test('a full hand departure and return is counted once; stationary jitter is never repetition',()=>{
  const input=track([0,0,0,0,.2,.4,.5,.4,.3,.1,0,0,0,0,.2,.4,.5,.4,.3,.1,0,0]);
  const result=timeline.summarizeTracking(input),left=result.channels.find(c=>c.channel==='left')!;
  assert.equal(left.count,2);assert.equal(left.coverage,100);
  const events=result.events.filter(e=>e.channel==='left');assert.ok(events[0].endMs<=events[1].startMs);
  assert.equal(timeline.summarizeTracking(track(Array.from({length:100},(_,i)=>i%2?.03:0))).channels[2].count,0);
});
test('occlusion never bridges one return trip or double-counts a face excursion',()=>{
  const input=track([0,0,0,.4,.5,.5,.5,.4,.1,0,0,0]);
  input.frames[5].v[2]=null;input.frames[5].q[2]='low_confidence';
  input.frames.forEach((f,i)=>{f.v[0]=[i===0||i===11?0:35,0];});input.frames[5].v[0]=null;input.frames[5].q[0]='not_detected';
  const result=timeline.summarizeTracking(input);assert.equal(result.channels[2].count,0);assert.equal(result.channels[0].count,0);assert.equal(result.channels[0].partialCount,2);assert.equal(result.channels[2].unavailableMs,100);
});
test('a long stable lead-in does not invalidate a later complete motion, and incomplete endpoints are not counted',()=>{
  const input=track([...Array(300).fill(0),.2,.4,.5,.4,.3,.1,0,0]);assert.equal(timeline.summarizeTracking(input).channels[2].count,1);
  assert.equal(timeline.summarizeTracking(track([0,0,0,.4,.5,.6,.6,.6])).channels[2].count,0);
});
test('all failed frames expose zero coverage, exact unavailable duration, and no motion judgments',()=>{
  const input=track(Array(10).fill(0));input.frames.forEach(f=>{f.v=[null,null,null,null];f.q=['decode_failed','decode_failed','decode_failed','decode_failed'];});
  const result=timeline.summarizeTracking(input);assert.equal(result.events.length,0);for(const channel of result.channels){assert.equal(channel.coverage,0);assert.equal(channel.unavailableMs,1000);assert.equal(channel.unavailable.length,1);}assert.equal(result.decodedFrames,0);assert.equal((result as any).score,undefined);
});
test('worker rejects multiple subjects and low visibility without exposing expression or eye gaze outputs',async()=>{
  const source=await readFile('apps/web/public/nonverbal/worker.js','utf8'),scope:any={importScripts:()=>{},self:{},Vision:{},Map,Math,Number};vm.runInNewContext(source,scope);
  const multi=scope.signals(0,{faceLandmarks:[[],[]]}, {landmarks:[]},{landmarks:[]});assert.ok(multi.q.every((q:string)=>q==='multiple_people'));
  const body=Array.from({length:33},()=>({x:.5,y:.5,visibility:.2}));body[11].x=.3;body[12].x=.7;
  const low=scope.signals(0,{faceLandmarks:[],facialTransformationMatrixes:[]},{landmarks:[body]},{landmarks:[]});assert.equal(low.q[1],'low_confidence');assert.equal(low.v[1],null);assert.ok(source.includes('outputFaceBlendshapes:false'));assert.ok(!source.includes('faceBlendshapes['));
});

async function serviceFixture(){
  let row:any={student_id:'owner',metadata:{durationSeconds:2,kind:'answer_recording',consentAt:'2026-10-23'},state:'completed'};const exported:any={};const source=await readFile('apps/web/src/lib/nonverbal-tracking.ts','utf8');
  class ApiError extends Error{constructor(public status:number,message:string){super(message);}}
  const owned=async(student:string)=>{if(student!=='owner'||row.state!=='completed')throw new ApiError(403,'Forbidden');return structuredClone(row);};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:exported,Date,JSON,require:(name:string)=>{
    if(name==='server-only')return{};if(name==='./nonverbal-analysis')return {ownedNonverbalMedia:owned};if(name==='./nonverbal-timeline')return timeline;
    if(name==='./db')return {ApiError,query:async(sql:string,p:any[])=>{if(p[1]!=='owner')return[];if(p.length===5){if(['completed','processing'].includes(row.metadata.nonverbalTimeline?.status))return[];row.metadata.nonverbalTimeline=JSON.parse(p[2]);return[{id:'m'}];}if(row.metadata.nonverbalTimeline?.lease===p[2]&&row.metadata.nonverbalTimeline?.status==='processing'){row.metadata.nonverbalTimeline=JSON.parse(p[3]);return[{id:'m'}];}return[];}};
    throw Error('Unexpected dependency '+name);
  }});return {service:exported,row};
}
test('local save retains ownership, completed-session and lease checks; cancel prevents late save; no provider dependency',async()=>{
  const f=await serviceFixture();await assert.rejects(()=>f.service.beginNonverbalTracking('foreign','m','lease'));f.row.state='active';await assert.rejects(()=>f.service.beginNonverbalTracking('owner','m','lease'));f.row.state='completed';
  await f.service.beginNonverbalTracking('owner','m','lease');await assert.rejects(()=>f.service.beginNonverbalTracking('owner','m','other'));
  await f.service.cancelNonverbalTracking('owner','m','foreign-lease');assert.equal(f.row.metadata.nonverbalTimeline.status,'processing');
  await f.service.cancelNonverbalTracking('owner','m','lease');await assert.rejects(()=>f.service.saveNonverbalTracking('owner','m','lease',track(Array(20).fill(0))));
  await f.service.beginNonverbalTracking('owner','m','second');const saved=await f.service.saveNonverbalTracking('owner','m','second',track(Array(20).fill(0)));
  assert.equal(saved.analysis.status,'completed');assert.equal(saved.analysis.billing,'local_no_api_charge');assert.equal(saved.analysis.frames,undefined);assert.equal(f.row.metadata.kind,'answer_recording');assert.ok(!JSON.stringify(f.row).includes('data:image'));
});
