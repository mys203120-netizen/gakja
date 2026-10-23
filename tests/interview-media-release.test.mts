import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

const require=createRequire(import.meta.url),studentId=randomUUID(),sessionId=randomUUID(),turnId=randomUUID(),assetId=randomUUID();
class FeatureError extends Error{constructor(public status:number,message:string,public code:string){super(message);}}
function harness(){
 const state={phase:'active',kind:'answer_recording',redirects:0,owned:true};
 const module={exports:{} as any};
 vm.runInNewContext(ts.transpileModule(readFileSync('apps/web/src/app/api/media/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,Response,Request,Buffer,URL,require(name:string){
  if(name==='@/lib/auth')return {requireUser:async()=>({id:studentId})};
  if(name==='@/lib/db')return {query:async(sql:string)=>sql.includes('from media_assets')?state.owned?[{id:assetId,session_id:sessionId,mime:'video/webm',metadata:{questionId:'q1',turnId,kind:state.kind,provider:'supabase',bucket:'private',path:'owned.webm'}}]:[]:sql.includes('from interview_sessions')?[{id:sessionId,state:state.phase,data:{context:{}}}]:[{id:turnId}]};
  if(name==='@/lib/ai')return {FeatureError,requireStudent(){},assertPublishedAccess:async()=>{},featureError:(error:any)=>({status:error.status||400,code:error.code,error:error.message})};
  if(name==='@/lib/recording-upload')return {recordingRedirect:async()=>{state.redirects++;return Response.redirect('https://fixture.invalid/owned.webm');}};
  if(name.startsWith('@/'))return {};
  return require(name);
 }});
 return {state,read:()=>module.exports.GET(new Request(`http://fixture.test/api/media?id=${assetId}`))};
}
for(const kind of ['answer_recording','analysis_audio','help_recording'])test(`active ${kind} cannot obtain a storage redirect`,async()=>{
 const h=harness();h.state.kind=kind;const response=await h.read();assert.equal(response.status,403);assert.equal((await response.json()).code,'INTERVIEW_MEDIA_NOT_RELEASED');assert.equal(h.state.redirects,0);
});
test('completed owned answers can obtain playback and missing ownership never reaches storage',async()=>{
 const h=harness();h.state.phase='completed';assert.equal((await h.read()).status,302);assert.equal(h.state.redirects,1);h.state.owned=false;assert.equal((await h.read()).status,404);assert.equal(h.state.redirects,1);
});
test('question voice remains available during an active interview',async()=>{
 const h=harness();h.state.kind='question_speech';assert.equal((await h.read()).status,302);assert.equal(h.state.redirects,1);
});
