import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as policy from '../apps/web/src/lib/interview-policy';
class FeatureError extends Error{constructor(public status:number,message:string,public code:string){super(message);}}
function harness(env:Record<string,string>={}){
 const calls:any[]=[],module={exports:{} as any};let fail=false;
 vm.runInNewContext(ts.transpileModule(readFileSync('apps/web/src/lib/interview-speech.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,process:{env},Buffer,AbortSignal,URLSearchParams,fetch:async(url:string,init:any)=>{calls.push({url,init});if(fail)throw new Error('secret provider failure');return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'audio/mpeg'}});},require(name:string){if(name==='server-only')return {};if(name==='./interview-policy')return policy;if(name==='./ai')return {FeatureError,speechProvider:()=> 'openai',speechConfigured:()=>true,reserveUsage:async(...args:any[])=>{calls.push({usage:args});return 'usage';},completeUsage:async(...args:any[])=>calls.push({settled:args}),openai:()=>({audio:{speech:{create:async(payload:any)=>{calls.push({openai:payload});return new Response(new Uint8Array([1]));}}}})};throw new Error(name);}});
 return {api:module.exports,calls,setFail:()=>{fail=true;}};
}
test('CLOVA remains opt-in and missing credentials preserve the existing provider',async()=>{
 for(const env of [{},{CLOVA_TTS_ENABLED:'true'},{CLOVA_TTS_CLIENT_ID:'fixture',CLOVA_TTS_CLIENT_SECRET:'fixture'}]){const h=harness(env);assert.equal(h.api.clovaSpeechConfigured(),false);await h.api.synthesizeInterviewSpeech('student','session','질문입니다.','C');assert.equal(h.calls.find(c=>c.openai).openai.voice,'shimmer');assert.equal(h.calls.some(c=>c.url),false);}
});
test('CLOVA sends the named character voice and returns ephemeral MP3 bytes without storage dependencies',async()=>{
 const h=harness({CLOVA_TTS_ENABLED:'true',CLOVA_TTS_CLIENT_ID:'synthetic-id',CLOVA_TTS_CLIENT_SECRET:'synthetic-secret'});const bytes=await h.api.synthesizeInterviewSpeech('student','session','AI 탐구를 설명해 주세요.','D');assert.deepEqual([...bytes],[1,2,3]);const call=h.calls.find(c=>c.url);assert.equal(call.url,'https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts');assert.equal(call.init.body.get('speaker'),'vdonghyun');assert.equal(call.init.body.get('text'),'에이아이 탐구를 설명해 주세요.');assert.equal(call.init.body.get('format'),'mp3');assert.equal(h.calls.some(c=>c.openai),false);
});
test('invalid speech text is rejected before usage and vendor failures are sanitized',async()=>{
 const h=harness({CLOVA_TTS_ENABLED:'true',CLOVA_TTS_CLIENT_ID:'synthetic-id',CLOVA_TTS_CLIENT_SECRET:'synthetic-secret'});await assert.rejects(()=>h.api.synthesizeInterviewSpeech('s','i','가'.repeat(2001),'A'),(error:any)=>error.code==='SPEECH_TEXT_LIMIT');assert.equal(h.calls.length,0);h.setFail();await assert.rejects(()=>h.api.synthesizeInterviewSpeech('s','i','질문','A'),(error:any)=>error.code==='SPEECH_FAILED'&&!error.message.includes('secret'));assert.equal(h.calls.at(-1).settled[1],'failed');
});
