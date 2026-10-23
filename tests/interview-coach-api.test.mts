import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import * as policy from '../apps/web/src/lib/interview-policy';
import {addHelpReceipt} from '../apps/web/src/lib/assistance-records';
const require=createRequire(import.meta.url),sessionId=randomUUID(),turnId=randomUUID(),requestId=randomUUID(),studentId=randomUUID();
const input={sessionId,turnId,requestId,characterId:'C',message:'제 역할을 설명하기 어려워요.'};
class FeatureError extends Error{constructor(public status:number,message:string,public code:string){super(message);}}
function harness(){
 const state={mode:'practice',paused:true,coachCalls:0,speechCalls:0,transcriptionCalls:0,assets:[] as any[],turn:{question:'활동에서 어떤 역할을 했나요?',answer:null,draft:'제가 적어 둔 답변',helpConversations:[] as any[]}};
 const scope={sessionId,turnId,questionId:'root-question'};
 async function owned(){if(state.mode==='real')throw new FeatureError(403,'실전 도움 차단','REAL_INTERVIEW_POLICY');if(!state.paused)throw new FeatureError(409,'면접을 멈춰 주세요.','SESSION_NOT_PAUSED');return scope;}
 async function query(sql:string,args:any[]=[]):Promise<any[]>{
  if(sql.startsWith('select')&&sql.includes('from interview_turns'))return [{question_id:'current-question',data:structuredClone(state.turn)}];
  if(sql.startsWith('select')&&sql.includes('from media_assets'))return state.assets.filter(asset=>asset.metadata.requestId===args[2]);
  if(sql.startsWith('insert into media_assets')){state.assets.push({id:args[0],studentId:args[1],sessionId:args[2],bytes:args[3],mime:args[4],metadata:JSON.parse(args[5])});return [];}
  if(sql.startsWith('update media_assets')){state.assets.find(asset=>asset.id===args[0]).text=args[2];return [];}
  if(sql.startsWith('update interview_turns')){state.turn=JSON.parse(args[2]);return [];}
  throw Error(sql);
 }
 const module={exports:{} as any};
 vm.runInNewContext(ts.transpileModule(readFileSync('apps/web/src/app/api/interviews/coach/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,Response,Request,File,Buffer,Date,URL,FormData,require(name:string){
  if(name==='@/lib/interview-policy')return policy;
  if(name==='@/lib/auth')return {checkOrigin(){},requireUser:async()=>({id:studentId})};
  if(name==='@/lib/ai')return {FeatureError,requireStudent(){},featureError:(error:any)=>({status:error.status||400,code:error.code,error:error.message}),coach:async()=>{state.coachCalls++;return {content:'그때 직접 맡았던 행동 하나부터 떠올려 보세요.'};}};
  if(name==='@/lib/db')return {query,transaction:async(fn:any)=>fn({query:async(sql:string,args:any[])=>({rows:await query(sql,args)})})};
  if(name==='@/lib/interview-assistance')return {ownedInterviewHelpScope:owned,ownedInterviewChatContext:async()=>({}),lockInterviewHelpScope:async()=>{await owned();return {data:structuredClone(state.turn)};},recordInterviewHelp:async(_db:any,_student:any,_scope:any,receipt:any)=>{await owned();state.turn=addHelpReceipt(state.turn,receipt) as typeof state.turn;}};
  if(name==='@/lib/recording-transcription')return {withRecordingTranscriptionLock:async(_key:string,fn:Function)=>fn()};
  if(name==='@/lib/speech-transcription')return {transcribeStoredAudio:async(_s:any,_i:any,_b:any,_m:any,_d:any,options:any)=>{state.transcriptionCalls++;await options.onRawTranscription({text:'음, 역할이, 역할이 막혔어요.'});return {rawText:'음, 역할이, 역할이 막혔어요.',displayText:'역할 설명이 어려워요.'};}};
  if(name==='@/lib/interview-speech')return {synthesizeInterviewSpeech:async()=>{state.speechCalls++;return Buffer.from('synthetic audio');}};
  return require(name);
 }});
 async function call(value:Record<string,unknown>|FormData=input){const response=await module.exports.POST(new Request('http://fixture.test/api/interviews/coach',{method:'POST',...(value instanceof FormData?{body:value}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(value)})}));return {status:response.status,body:response.headers.get('content-type')?.includes('json')?await response.json():await response.text()};}
 return {state,call};
}
test('real help is rejected before any hint, transcription or speech provider work',async()=>{
 const h=harness();h.state.mode='real';const response=await h.call();assert.equal(response.status,403);assert.equal(h.state.coachCalls+h.state.speechCalls+h.state.transcriptionCalls,0);assert.equal(h.state.assets.length,0);
});
test('named hints remain separate from the answer and retries reuse their exact receipt',async()=>{
 const h=harness(),response=await h.call();assert.equal(response.status,200);assert.equal(response.body.characterName,'하람');assert.equal(h.state.turn.answer,null);assert.equal(h.state.turn.draft,'제가 적어 둔 답변');assert.equal(h.state.turn.helpConversations.length,1);await h.call();assert.equal(h.state.coachCalls,1);assert.equal(h.state.turn.helpConversations.length,1);
});
test('help audio is saved separately and preserves raw transcript instead of formatting output',async()=>{
 const h=harness(),form=new FormData();for(const [key,value] of Object.entries(input))form.set(key,value);form.set('consent','true');form.set('durationSeconds','12');form.set('recording',new Blob(['synthetic user audio'],{type:'audio/webm'}),'help.webm');
 const response=await h.call(form);assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(h.state.assets[0].metadata.kind,'help_recording');assert.equal(h.state.assets[0].metadata.questionId,'current-question');assert.equal(h.state.assets[0].text,'음, 역할이, 역할이 막혔어요.');assert.equal(response.body.rawTranscript,h.state.assets[0].text);assert.equal(h.state.turn.answer,null);assert.equal(h.state.turn.draft,'제가 적어 둔 답변');
});
test('hint speech only reads the stored same-character reply and never arbitrary client text',async()=>{
 const h=harness();await h.call();assert.equal((await h.call({...input,action:'speech',characterId:'D',message:'외부 음성 요청'})).status,404);assert.equal(h.state.speechCalls,0);assert.equal((await h.call({...input,action:'speech',message:'외부 음성 요청'})).status,200);assert.equal(h.state.speechCalls,1);
});
