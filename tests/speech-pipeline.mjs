import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
class FeatureError extends Error {constructor(status,message,code){super(message);this.status=status;this.code=code;}}
let state;
const envKeys=['OPENAI_TRANSCRIPTION_MODEL','OPENAI_TRANSCRIPT_CLEANUP_MODEL','TRANSCRIPT_CLEANUP_ENABLED','OPENAI_TRANSCRIPT_CLEANUP_TIMEOUT_MS'];
const priorEnv=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
function reset(){for(const key of envKeys)delete process.env[key];state={provider:'openai',configured:true,events:[],usage:[],sttCalls:[],cleanupCalls:[],raw:'음, 저는 관찰했습니다. 이유가 궁금했습니다.',output:{display_text:'음, 저는 관찰했습니다.\n이유가 궁금했습니다.',edits:[]},status:'completed',sttFailure:false,cleanupFailure:false,limitCleanup:false};}
const ai={FeatureError,transcriptionProvider:()=>state.provider,transcriptionConfigured:()=>state.configured,googleSpeechToken:async()=>{throw new Error('No Google request expected');},
 reserveUsage:async(student,feature,context,model)=>{state.events.push(`reserve:${feature}`);if(state.limitCleanup&&feature==='transcription_cleanup')throw new FeatureError(429,'daily limit','AI_DAILY_LIMIT');const id=`usage${state.usage.length+1}`;state.usage.push({id,feature,model});return id;},
 completeUsage:async(id,status,usage)=>{state.events.push(`settle:${id}:${status}`);const row=state.usage.find(row=>row.id===id);if(state.failAllSettlements||state.failRawSettlement&&row.feature==='transcription'||state.failCleanupSettlement&&row.feature==='transcription_cleanup')throw new Error('Usage settlement unavailable');Object.assign(row,{status,tokens:usage});},
 openai:()=>({audio:{transcriptions:{create:async(input,options)=>{state.sttCalls.push({input,options});state.events.push('stt');if(state.sttFailure)throw new Error('Secret vendor details must not escape');return {text:state.raw,words:state.words||[]};}}},responses:{create:async(input,options)=>{state.cleanupCalls.push({input,options});state.events.push('cleanup');if(state.cleanupFailure)throw new Error('Secret provider token=do-not-return');return{status:state.status,output_text:JSON.stringify(state.output),usage:{input_tokens:10,output_tokens:20}};}}}),
};
const loaded=new Map();
function load(name){if(loaded.has(name))return loaded.get(name);const module={exports:{}};const source=fs.readFileSync(new URL(`../apps/web/src/lib/${name}.ts`,import.meta.url),'utf8');vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,Buffer,process,AbortSignal,Date,JSON,Error,console,require(dependency){if(dependency==='server-only')return{};if(dependency==='./ai')return ai;if(dependency==='openai')return{toFile:async(bytes,name,options)=>({bytes,name,...options})};if(dependency.startsWith('./'))return load(dependency.slice(2));return require(dependency);}});loaded.set(name,module.exports);return module.exports;}
const {transcribeStoredAudio,formatStoredTranscription}=load('speech-transcription');
let checks=0;function check(condition,message){assert.ok(condition,message);checks++;}
const record=async raw=>{state.events.push('saved-raw');state.savedRaw=structuredClone(raw);};
function wav(durationMs=2000,amplitude=0){const rate=16000,frames=Math.round(rate*durationMs/1000),bytes=Buffer.alloc(44+frames*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*2,40);for(let index=0;index<frames;index++)bytes.writeInt16LE(Math.round(amplitude*Math.sin(index*.2)),44+index*2);return bytes;}
const {buildSpeechTelemetry}=load('speech-telemetry');
const {observedSilence}=load('speech-silence');
const telemetry=(duration=2000,rms=0)=>buildSpeechTelemetry(Array.from({length:duration/100},(_,index)=>({atMs:index*100,rms})),duration);
async function transcribe(){return transcribeStoredAudio('student','attempt',Buffer.from('mock-recording'),'audio/webm;codecs=opus',30,{onRawTranscription:record});}
try {
 reset();const silent=wav();await assert.rejects(()=>transcribeStoredAudio('student','attempt',silent,'audio/wav',2,{speechTelemetry:telemetry(),onRawTranscription:record}),error=>error.code==='NO_SPEECH_DETECTED'&&error.status===422&&error.message.includes('다시 녹음')&&error.message.includes('직접 입력'));checks++;
 check(state.sttCalls.length===0&&state.cleanupCalls.length===0&&state.usage.length===0&&!state.savedRaw,'complete PCM silence stops before both paid providers, quota reservation and durable text');
 check(observedSilence(silent,2) === 'pcm','server PCM samples catch silence even without client telemetry');
 const forgedVoice=telemetry(2000,.1);check(observedSilence(silent,2,forgedVoice)==='pcm','fabricated voiced segments cannot bypass PCM silence');
 check(observedSilence(wav(2000,80),2,telemetry())===null,'real low volume PCM overrides incorrect zero-voice telemetry');
 check(observedSilence(wav(2000,2000),2,telemetry())===null,'real voiced waveform is not rejected by a claimed silent VAD');
 check(observedSilence(wav(200),.2,telemetry(200))===null,'very short recordings remain unknown rather than falsely silent');
 const compressed=Buffer.from('opaque-webm-for-pure-provider-test');
 check(observedSilence(compressed,2,telemetry())==='microphone','complete new microphone measurements can identify near-digital silence in compressed recordings');
 const legacy=telemetry();delete legacy.analysis.peakRms;check(observedSilence(compressed,2,legacy)===null,'legacy zero-VAD capture without peak is not enough to block normal audio');
 check(observedSilence(compressed,2)===null,'unobserved compressed recording remains eligible for normal STT');
 const partial=buildSpeechTelemetry([{atMs:0,rms:0},{atMs:100,rms:0}],2000);check(observedSilence(compressed,2,partial)===null,'partial microphone observation is not silence');
 const truncated=telemetry();truncated.coverage.truncated=true;check(observedSilence(compressed,2,truncated)===null,'truncated observation is not silence');
 const noise=telemetry();noise.limitations.push('high-background-level');check(observedSilence(compressed,2,noise)===null,'noisy or uncertain captures cannot block audio');
 check(observedSilence(compressed,20,telemetry())===null,'mismatched duration cannot manufacture full observation');
 const invalid=telemetry();invalid.coverage.observedMs=999999;check(observedSilence(compressed,2,invalid)===null,'invalid telemetry is not trusted');
 const corrupt=silent.subarray(0,silent.length-2);check(observedSilence(corrupt,2)===null,'truncated PCM data cannot prove complete silence');
 check(observedSilence(compressed,2,telemetry(2000,.001))===null,'no VAD segments with a quiet but nonzero microphone is still eligible for recognition');
 reset();await transcribeStoredAudio('student','attempt',wav(300,3000),'audio/wav',.3,{onRawTranscription:record});check(state.sttCalls.length===1&&state.cleanupCalls.length===1&&state.savedRaw.text===state.raw,'short real utterances continue through both configured providers');
 reset();await assert.rejects(()=>transcribeStoredAudio('student','attempt',silent,'audio/wav',2,{onRawTranscription:record}),error=>error.code==='NO_SPEECH_DETECTED');await transcribeStoredAudio('student','attempt',wav(2000,3000),'audio/wav',2,{onRawTranscription:record});check(state.sttCalls.length===1&&state.cleanupCalls.length===1&&state.usage.length===2,'new audible rerecording works after a free silence failure');
 reset();let result=await transcribe();
 check(state.sttCalls.length===1&&state.cleanupCalls.length===1,'one request to each explicit model');
 check(state.sttCalls[0].input.model==='gpt-4o-mini-transcribe'&&state.cleanupCalls[0].input.model==='gpt-6-luna','no implicit model substitution');
 check(state.sttCalls[0].input.response_format==='json'&&state.sttCalls[0].input.language==='ko','mini transcribe uses supported JSON format and Korean');
 check(state.sttCalls[0].options.maxRetries===0&&state.sttCalls[0].options.timeout===40000,'STT latency bounded without SDK retry');
 check(state.cleanupCalls[0].input.reasoning.effort==='none'&&!state.cleanupCalls[0].input.store&&state.cleanupCalls[0].options.timeout===25000,'cleanup uses nonreasoning, no storage, bounded latency');
 check(state.cleanupCalls[0].options.maxRetries===0&&!state.cleanupCalls[0].input.stream,'no retry or unfinished display streaming');
 check(state.cleanupCalls[0].input.text.format.strict===true&&state.cleanupCalls[0].input.text.format.type==='json_schema','strict structured copy-edit response');
 check(state.events.indexOf('saved-raw')<state.events.indexOf('reserve:transcription_cleanup'),'durable raw callback finishes before paid formatting');
 check(state.events.indexOf('saved-raw')<state.events.indexOf('settle:usage1:completed'),'durable raw save precedes nonessential successful STT usage settlement');
 check(result.text===state.raw&&result.rawText===state.raw&&result.displayText==='음, 저는 관찰했습니다.\n이유가 궁금했습니다.','only final cleaned display differs; raw speech remains byte-for-byte');
 check(result.cleanup.status==='completed'&&result.cleanup.editCount===0&&/^[a-f0-9]{64}$/.test(result.cleanup.rawHash),'cleanup provenance and raw cache hash present');
 check(result.alignmentStatus==='answer_only'&&result.words.length===0,'mini STT never fabricates word times');
 check(state.usage.map(row=>row.feature).join(',')==='transcription,transcription_cleanup'&&state.usage.every(row=>row.status==='completed'),'separate raw and cleanup quota accounting');
 check(JSON.parse(state.cleanupCalls[0].input.input[0].content).transcript===state.raw&&state.cleanupCalls[0].input.input.length===1,'cleanup receives only transcript data, no unrelated student documents');
 const raw=state.savedRaw;state.cleanupCalls=[];state.sttCalls=[];result=await formatStoredTranscription('student','attempt',raw);
 check(state.sttCalls.length===0&&state.cleanupCalls.length===1&&result.rawText===raw.text,'cleanup-only retry never retranscribes or changes original timing');
 reset();state.cleanupFailure=true;result=await transcribe();
 check(result.displayText===null&&result.cleanup.status==='failed'&&result.rawText===state.raw&&state.savedRaw.text===state.raw,'failed formatter preserves durable raw and exposes no partial main transcript');
 check(result.cleanup.error==='TRANSCRIPT_CLEANUP_FAILED'&&!JSON.stringify(result).includes('token='),'sanitized errors never leak upstream details');
 check(state.usage[0].status==='completed'&&state.usage[1].status==='failed','format failure does not mark successful STT as failure');
 reset();state.output={display_text:'저는 훌륭한 연구 성과를 냈습니다.',edits:[]};result=await transcribe();
 check(result.cleanup.status==='failed'&&result.displayText===null&&result.cleanup.error==='CLEANUP_UNSUPPORTED_CHANGE','invented achievement is rejected rather than displayed');
 reset();state.status='incomplete';result=await transcribe();
 check(result.displayText===null&&result.cleanup.error==='TRANSCRIPT_CLEANUP_INCOMPLETE','incomplete response never produces a polished answer');
 reset();process.env.TRANSCRIPT_CLEANUP_ENABLED='false';result=await transcribe();
 check(result.cleanup.status==='disabled'&&result.displayText===null&&state.cleanupCalls.length===0&&state.savedRaw.text===state.raw,'explicitly disabled cleanup retains raw for separate review');
 reset();process.env.OPENAI_TRANSCRIPT_CLEANUP_MODEL='other-model';result=await transcribe();
 check(result.cleanup.status==='failed'&&result.cleanup.error==='TRANSCRIPT_CLEANUP_MODEL_INVALID'&&state.cleanupCalls.length===0,'unavailable or mistyped configured model never falls back');
 reset();state.limitCleanup=true;result=await transcribe();
 check(result.cleanup.error==='AI_DAILY_LIMIT'&&result.displayText===null&&state.savedRaw.text===state.raw&&state.cleanupCalls.length===0,'cleanup quota exhaustion preserves completed raw without an extra call');
 reset();state.raw='';await assert.rejects(transcribe(),error=>error.code==='NO_SPEECH_DETECTED');checks++;
 check(!state.savedRaw&&state.cleanupCalls.length===0&&state.usage[0].status==='failed','empty audio stops before callback and formatting');
 reset();state.sttFailure=true;await assert.rejects(transcribe(),error=>error.code==='TRANSCRIPTION_FAILED'&&!error.message.includes('Secret'));checks++;
 check(state.cleanupCalls.length===0&&!state.savedRaw,'STT failure cannot become a formatted answer');
 reset();await assert.rejects(()=>transcribeStoredAudio('student','attempt',Buffer.alloc(25*1024*1024+1),'audio/webm',20,{onRawTranscription:record}),error=>error.code==='TRANSCRIPTION_FILE_TOO_LARGE');checks++;
 check(state.sttCalls.length===0&&state.usage.length===0,'oversized file is rejected before quota and upload');
 reset();await assert.rejects(()=>transcribeStoredAudio('student','attempt',Buffer.from('audio'),'audio/webm',20,{onRawTranscription:async()=>{throw new Error('Storage failed');}}),/Storage failed/);checks++;
 check(state.cleanupCalls.length===0&&state.usage.length===1,'failed durable raw write stops the second paid operation');
 reset();process.env.OPENAI_TRANSCRIPTION_MODEL='whisper-1';state.words=[{word:'음',start:0,end:.4},{word:'관찰',start:1,end:2}];result=await transcribe();
 check(result.modelId==='whisper-1'&&result.alignmentStatus==='word'&&result.words[0].word==='음'&&result.words.length===2,'explicit legacy word-aligned transcription preserves raw timings across cleanup');
 check(state.sttCalls[0].input.language==='ko','Whisper also pins Korean language');
 for(const words of [[{word:'음',start:-1,end:1}],[{word:'음',start:0,end:31}],[{word:'음',start:1,end:2},{word:'어',start:.5,end:1}],[{word:' ',start:0,end:1}]]) {
  reset();process.env.OPENAI_TRANSCRIPTION_MODEL='whisper-1';state.words=words;result=await transcribe();
  check(result.alignmentStatus==='answer_only'&&result.words.length===0&&result.rawText===state.raw,'invalid alignment is discarded without losing speech');
 }
 reset();state.raw='양극 물질이 있습니다.';state.output={display_text:'음극 물질이 있습니다.',edits:[{original:'양극',replacement:'음극',occurrence:0,kind:'spelling'}]};result=await transcribe();
 check(result.cleanup.status==='failed'&&result.displayText===null&&state.savedRaw.text===state.raw,'semantic substitution cannot escape through declared spelling edits');
 reset();process.env.OPENAI_TRANSCRIPT_CLEANUP_TIMEOUT_MS='100000';await transcribe();
 check(state.cleanupCalls[0].options.timeout===30000,'cleanup timeout configuration capped to30seconds');
 reset();state.provider='google';await assert.rejects(()=>transcribeStoredAudio('student','attempt',Buffer.from('audio'),'audio/webm',60,{onRawTranscription:record}),error=>error.code==='BATCH_TRANSCRIPTION_REQUIRED');checks++;
 check(state.sttCalls.length===0&&state.cleanupCalls.length===0,'explicit Google legacy incompatibility never silently moves vendors');
 reset();state.configured=false;await assert.rejects(transcribe(),error=>error.code==='SPEECH_NOT_CONFIGURED');checks++;
 check(state.usage.length===0,'missing key rejects before budget or upload');
 reset();state.failRawSettlement=true;result=await transcribe();
 check(state.sttCalls.length===1&&state.savedRaw.text===state.raw&&result.cleanup.status==='completed','STT usage-log outage never prevents durable raw save or repeats a paid STT call');
 check(state.usage.length===2&&state.usage[0].status===undefined&&state.usage[1].status==='completed','unsettled STT reservation remains counted without being falsely changed to failed');
 check(!state.events.includes('settle:usage1:failed'),'successful STT is never marked failed due to an accounting outage');
 reset();state.failCleanupSettlement=true;result=await transcribe();
 check(result.cleanup.status==='completed'&&result.displayText==='음, 저는 관찰했습니다.\n이유가 궁금했습니다.'&&state.cleanupCalls.length===1,'completed validated cleanup survives completion-log failure without a second paid request');
 check(state.usage.length===2&&state.usage[1].status===undefined&&!state.events.includes('settle:usage2:failed'),'cleanup accounting outage preserves reservation rather than relabeling real output failed');
 reset();state.failAllSettlements=true;state.sttFailure=true;await assert.rejects(transcribe(),error=>error.code==='TRANSCRIPTION_FAILED'&&!error.message.includes('settlement'));checks++;
 check(state.sttCalls.length===1&&!state.savedRaw&&state.cleanupCalls.length===0,'failed STT and failed error log retain the original sanitized provider failure');
 reset();state.failAllSettlements=true;state.cleanupFailure=true;result=await transcribe();
 check(state.savedRaw.text===state.raw&&result.cleanup.status==='failed'&&result.cleanup.error==='TRANSCRIPT_CLEANUP_FAILED','real cleanup failure remains retryable even if failed usage settlement is also unavailable');
 reset();state.failAllSettlements=true;await assert.rejects(()=>transcribeStoredAudio('student','attempt',Buffer.from('audio'),'audio/webm',20,{onRawTranscription:async()=>{throw new Error('Storage failed');}}),/Storage failed/);checks++;
 check(state.sttCalls.length===1&&state.cleanupCalls.length===0,'durable-save failure still blocks cleanup and is not replaced by accounting failure');
 console.log(`speech pipeline: ${checks} checks passed; synthetic SDK/quota adapters, zero real API requests`);
} finally {for(const key of envKeys){if(priorEnv[key]===undefined)delete process.env[key];else process.env[key]=priorEnv[key];}}
