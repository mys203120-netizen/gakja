import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as crypto from 'node:crypto';
import {z} from 'zod';
import * as model from '../apps/web/src/lib/nonverbal-analysis-model.ts';
const jpeg='data:image/jpeg;base64,'+Buffer.from([255,216,1,2,255,217]).toString('base64');
const samples=model.nonverbalSampleTimes(30_000).map((atMs,index)=>({id:index+1,atMs,dataUrl:jpeg}));
const observation=()=>({status:'observed',observations:[{category:'hands',sampleIds:[1,3],description:'두 표본에서 손이 놓인 위치가 다르게 보여요.',checkNext:'해당 위치의 원본 화면에서 손 위치를 확인해 보세요.'}],limitations:['표본 사이 움직임은 확인할 수 없어요.']});
test('bounded deterministic sampling is based on stored duration and ordered ids',()=>{
  assert.equal(samples.length,6);assert.equal(model.nonverbalSampleTimes(0).length,0);
  assert.equal(model.validateVideoSamples(samples,30_000).length,6);
  assert.throws(()=>model.validateVideoSamples(samples.slice(1),30_000));
  assert.throws(()=>model.validateVideoSamples(samples.map(s=>({...s,atMs:s.atMs+1000})),30_000));
});
test('observations only cite supplied samples and reject unsupported mental-state or continuous claims',()=>{
  const valid=model.validateNonverbalOutput(observation(),samples);assert.deepEqual(valid.observations[0].timestampsMs,[samples[0].atMs,samples[2].atMs]);
  const foreign=observation();foreign.observations[0].sampleIds=[7];assert.throws(()=>model.validateNonverbalOutput(foreign,samples));
  for(const description of ['긴장한 태도로 보입니다.','시선이 계속 흔들립니다.','자신감이 높아 보입니다.','반복적으로 손을 움직입니다.']){const invalid=observation();invalid.observations[0].description=description;assert.throws(()=>model.validateNonverbalOutput(invalid,samples));}
  assert.equal(model.validateNonverbalOutput({status:'insufficient',observations:[],limitations:['손과 상체가 화면에서 보이지 않아요.']},samples).status,'insufficient');
});

async function serviceFixture(){
  let row:any={id:'media-a',student_id:'owner-a',session_id:'session-a',mime:'video/webm',state:'completed',turn_data:{answer:'실제 답변'},metadata:{kind:'answer_recording',turnId:'turn-a',consentAt:'2026-10-23',durationSeconds:30}};
  let calls=0,usage=0,finished=0,enabled=false;const settlements:any[]=[];
  class ApiError extends Error{constructor(public status:number,message:string){super(message);}}
  const exported:any={},env={NONVERBAL_ANALYSIS_ENABLED:'false',OPENAI_API_KEY:'synthetic-not-real'};
  const source=await readFile(new URL('../apps/web/src/lib/nonverbal-analysis.ts',import.meta.url),'utf8');
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:exported,Buffer,process:{env},console,require:(name:string)=>{
    if(name==='server-only')return {};if(name==='node:crypto')return crypto;if(name==='zod')return {z};if(name==='./nonverbal-analysis-model')return model;
    if(name==='./ai')return {openai:()=>{throw Error('Real model access is forbidden in tests');},reserveUsage:async()=>{usage++;return 'usage';},completeUsage:async(_id:string,status:string,tokens:unknown)=>{finished++;settlements.push({status,tokens});}};
    if(name==='./db')return {ApiError,query:async(sql:string,params:any[])=>{
      if(sql.startsWith('select m.id'))return params[1]===row.student_id?[structuredClone(row)]:[];
      if(sql.startsWith('update media_assets')){
        if(typeof params[2]==='string'&&params[2].startsWith('{')){if(['processing','completed'].includes(row.metadata.nonverbalAnalysis?.status))return [];row.metadata.nonverbalAnalysis=JSON.parse(params[2]);return [{id:row.id}];}
        if(row.metadata.nonverbalAnalysis?.lease===params[2]){row.metadata.nonverbalAnalysis=JSON.parse(params[3]);return [{id:row.id}];}return [];
      }throw Error('Unexpected SQL');}};
    throw Error('Unexpected dependency '+name);
  }});
  return {service:exported,enable:()=>{env.NONVERBAL_ANALYSIS_ENABLED='true';enabled=true;},row:()=>row,set:(patch:any)=>{row={...row,...patch};},counts:()=>({calls,usage,finished}),settlements,analyzer:async()=>{calls++;return {value:observation(),model:'injected-test'};}};
}
test('owner and ended-session access are checked, configuration never becomes a completed observation',async()=>{
  const f=await serviceFixture();await assert.rejects(()=>f.service.getNonverbalAnalysis('foreign','media-a'));
  f.set({state:'active'});await assert.rejects(()=>f.service.getNonverbalAnalysis('owner-a','media-a'));f.set({state:'completed'});
  const result=await f.service.saveNonverbalAnalysis('owner-a','media-a',samples,f.analyzer);assert.equal(result.configured,false);assert.equal(result.analysis,null);assert.equal(f.counts().usage,0);assert.equal(f.counts().calls,0);
});
test('one completed observation is bound to source timestamps and never stores sampled images',async()=>{
  const f=await serviceFixture();f.enable();const result=await f.service.saveNonverbalAnalysis('owner-a','media-a',samples,f.analyzer);
  assert.equal(result.analysis.status,'completed');assert.equal(result.analysis.observationStatus,'observed');assert.equal(result.analysis.sampleCount,6);
  assert.equal(f.counts().usage,1);assert.equal(f.counts().finished,1);assert.ok(!JSON.stringify(f.row().metadata).includes('data:image'));
  assert.equal(f.row().metadata.kind,'answer_recording');
  await f.service.saveNonverbalAnalysis('owner-a','media-a',samples,f.analyzer);assert.equal(f.counts().calls,1);
});
test('failed model observation preserves original recording metadata and does not create a score',async()=>{
  const f=await serviceFixture();f.enable();const result=await f.service.saveNonverbalAnalysis('owner-a','media-a',samples,async()=>{throw Error('fixture failure');});
  assert.equal(result.analysis.status,'failed');assert.equal(result.analysis.score,undefined);assert.equal(f.row().metadata.kind,'answer_recording');assert.equal(f.row().metadata.durationSeconds,30);assert.equal(f.counts().finished,1);
});
test('concurrent requests share one lease and an expired worker cannot report its stale result',async()=>{
  const f=await serviceFixture();f.enable();let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
  const work=f.service.saveNonverbalAnalysis('owner-a','media-a',samples,async()=>{await pending;return f.analyzer();});
  await new Promise(resolve=>setImmediate(resolve));
  const concurrent=await f.service.saveNonverbalAnalysis('owner-a','media-a',samples,f.analyzer);assert.equal(concurrent.analysis.status,'processing');assert.equal(f.counts().usage,1);
  f.row().metadata.nonverbalAnalysis={status:'processing',lease:'replacement-lease',startedAt:new Date().toISOString()};
  release();const stale=await work;assert.equal(stale.analysis.status,'processing');assert.equal(f.row().metadata.nonverbalAnalysis.lease,'replacement-lease');assert.equal(f.counts().calls,1);
});

test('a paid invalid output retains its usage without becoming an observation',async()=>{
  const f=await serviceFixture();f.enable();const tokens={input_tokens:700,output_tokens:120};
  const result=await f.service.saveNonverbalAnalysis('owner-a','media-a',samples,async()=>({value:'not valid JSON',model:'injected-test',usage:tokens}));
  assert.equal(result.analysis.status,'failed');assert.deepEqual(f.settlements,[{status:'failed',tokens}]);assert.equal(result.analysis.observations,undefined);
});
