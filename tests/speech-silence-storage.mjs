// Actual quiz/interview storage functions, in-memory SQL adapter, no database or network writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
class FeatureError extends Error {constructor(status,message,code){super(message);Object.assign(this,{status,code});}}
class ApiError extends Error {constructor(status,message){super(message);this.status=status;}}
let state;
const user={id:'student',role:'student'};
function wav(silent=true){const rate=16000,frames=32000,bytes=Buffer.alloc(44+frames*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*2,40);if(!silent)for(let i=0;i<frames;i++)bytes.writeInt16LE(Math.round(3000*Math.sin(i*.2)),44+i*2);return bytes;}
const raw={text:'음, 제가 관찰했습니다.',provider:'openai',modelId:'gpt-4o-mini-transcribe',words:[],alignmentStatus:'answer_only'};
const formatted=value=>({...value,rawText:value.text,displayText:'제가 관찰했습니다.',cleanup:{status:'completed'}});
function reset(kind){state={kind,row:{id:'recording',student_id:'student',session_id:'session',data:wav(),mime:'audio/wav',duration_ms:2000,text:null,metadata:{kind:'answer_recording',provider:'postgresql',turnId:'turn',durationSeconds:2}},turn:{id:'turn',state:'active',data:{draft:'제가 직접 작성한 초안'}},stt:0,format:0,reservations:0};}
function patch(value){Object.assign(state.row.metadata,value);}
async function query(sql,args=[]){
 if(sql.startsWith('select m.*')||sql.startsWith('select r.*'))return [state.row];
 if(sql.startsWith('select text,metadata')||sql.startsWith('select metadata'))return [state.row];
 if(sql.startsWith('select t.*,s.state'))return [state.turn];
 if(sql.startsWith('update media_assets set text=coalesce')){state.row.text??=args[2];patch(JSON.parse(args[3]));return [];}
 if(sql.startsWith('update media_assets set metadata=metadata || $3')){patch(JSON.parse(args[2]));return [];}
 if(sql.startsWith('update quiz_recordings set metadata=metadata || $3')){patch(JSON.parse(args[2]));return [];}
 if(sql.startsWith('update interview_turns set data=data || jsonb_build_object')){state.turn.data.rawTranscript=args[2];state.turn.data.rawTranscriptMediaId=args[1];return [];}
 if(sql.startsWith('update interview_turns set data=$3')){state.turn.data=JSON.parse(args[2]);return [];}
 if(sql.startsWith('update media_assets set metadata=metadata || jsonb_build_object')){
  if(sql.includes("'transcriptionError'"))patch({transcriptionStatus:args[2],transcriptionError:args[3],cleanupStatus:args[4],transcriptionErrorCode:args[5]});
  else patch({transcriptionStatus:args[2],cleanupStatus:'pending'});
  return [];
 }
 if(sql.startsWith('update quiz_recordings set metadata=metadata || jsonb_build_object')){
  if(sql.includes("'transcriptionError'"))patch({transcriptionStatus:state.row.metadata.transcript?'completed':'failed',transcriptionError:state.row.metadata.transcript?null:args[2],transcriptionErrorCode:state.row.metadata.transcript?null:args[3],cleanupStatus:state.row.metadata.transcript?'failed':'pending'});
  else patch({transcriptionStatus:args[2],cleanupStatus:'pending'});
  return [];
 }
 throw new Error('Unexpected SQL in silence storage regression: '+sql);
}
const db={query,ApiError,transaction:async work=>work({query:async(...args)=>({rows:await query(...args)})})};
const ai={FeatureError,transcriptionProvider:()=> 'openai',transcriptionConfigured:()=>true,reserveUsage:async()=>{state.reservations++;return 'usage';},completeUsage:async()=>{},openai:()=>({audio:{transcriptions:{create:async()=>{state.stt++;return {text:raw.text};}}}})};
const recording={withRecordingTranscriptionLock:async(_key,work)=>work(),storedRawTranscription:text=>typeof text==='string'&&text.trim()?{...raw,text}:null,cachedFormattedTranscription:(value,metadata)=>metadata.transcriptCleanup?.status==='completed'?formatted(value):null,transcriptionDescriptor:value=>({provider:value.provider,modelId:value.modelId}),transcriptionResponse:(metadata,text=null)=>({rawTranscript:text,transcript:metadata.transcriptCleanup?.status==='completed'?metadata.displayTranscript:null,transcriptionStatus:metadata.transcriptionStatus,cleanupStatus:metadata.transcriptCleanup?.status||metadata.cleanupStatus,transcriptionError:metadata.transcriptionError})};
const modules=new Map();
function load(name){if(modules.has(name))return modules.get(name);const module={exports:{}};const source=fs.readFileSync(new URL('../apps/web/src/lib/'+name+'.ts',import.meta.url),'utf8');vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,Buffer,process,console,AbortSignal,Date,JSON,Error,require(dependency){if(dependency==='server-only')return {};if(dependency==='./ai')return ai;if(dependency==='./auth')return {supabaseServer:async()=>{throw new Error('No storage access expected');}};if(dependency==='./db')return db;if(dependency==='./recording-transcription')return recording;if(dependency==='./transcript-cleanup')return {cleanupTranscript:async(_student,_context,text)=>{state.format++;return {displayText:'제가 관찰했습니다.',cleanup:{status:'completed'}};}};if(dependency==='openai')return {toFile:async()=>({})};if(['./get-learning-workflows','./learning-workflows','./learning-navigation','./learning-growth'].includes(dependency))return {};if(dependency.startsWith('./'))return load(dependency.slice(2));return require(dependency);}});modules.set(name,module.exports);return module.exports;}
const interview=load('interview-transcription').transcribeOwnedInterviewRecording;
const quiz=load('speech-growth-store').transcribeOwnedQuizRecording;
let checks=0;function check(value,message){assert.ok(value,message);checks++;}
for(const kind of ['interview','quiz']){
 const run=()=>kind==='interview'?interview(user.id,'recording'):quiz(user,'recording');
 reset(kind);await assert.rejects(run,error=>error.code==='NO_SPEECH_DETECTED');checks++;
 check(state.stt===0&&state.format===0&&state.reservations===0,kind+': complete silence makes zero paid requests');
 check(!state.row.text&&!state.row.metadata.transcript&&!state.row.metadata.displayTranscript,kind+': silence cannot create raw or display text');
 check(state.row.metadata.transcriptionStatus==='failed'&&state.row.metadata.cleanupStatus==='pending'&&state.row.metadata.transcriptionError.includes('다시 녹음')&&state.row.metadata.transcriptionError.includes('직접 입력'),kind+': persisted failure tells student to rerecord or type');
 check(state.row.metadata.transcriptionErrorCode==='NO_SPEECH_DETECTED',kind+': explicit no-speech diagnostic code is stored separately from message');
 check(state.turn.data.draft==='제가 직접 작성한 초안',kind+': failed silence does not replace a typed draft');
 await assert.rejects(run,error=>error.code==='NO_SPEECH_DETECTED');checks++;
 check(state.stt===0&&state.reservations===0,kind+': retry of the same silence remains free and does not invent an answer');
 state.row.data=wav(false);const audible=await run();
 check(state.stt===1&&state.format===1&&audible.transcript==='제가 관찰했습니다.',kind+': actual audible rerecording succeeds after silence failure');
 check(state.row.metadata.transcriptionStatus==='completed'&&state.row.metadata.transcriptionError===null&&state.row.metadata.transcriptionErrorCode===null,kind+': successful retry clears stale transcription failure and diagnostic code');
 if(kind==='interview')check(state.turn.data.draft==='제가 직접 작성한 초안',kind+': successful retry still preserves the manually entered draft');
 const storedRaw=kind==='interview'?state.row.text:state.row.metadata.transcript,storedDisplay=state.row.metadata.displayTranscript;
 state.row.data=wav();const cached=await run();
 check(state.stt===1&&state.format===1&&cached.cached===true,kind+': prior completed transcript uses cache even when original bytes are silent');
 check((kind==='interview'?state.row.text:state.row.metadata.transcript)===storedRaw&&state.row.metadata.displayTranscript===storedDisplay,kind+': no migration or destructive overwrite of prior normal raw/display evidence');
}
console.log('speech silence storage: '+checks+' checks passed; actual quiz/interview functions, in-memory SQL adapter, zero database/network writes');
