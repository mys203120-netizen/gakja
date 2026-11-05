import dotenv from 'dotenv';
import * as grpc from '@grpc/grpc-js';
import * as loader from '@grpc/proto-loader';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import path from 'node:path';
import {ClovaSpeechStream, type SpeechStreamTransport} from '../server/providers/clova-stt';
import {speechAudioCacheId} from '../server/providers/clova-tts';
import {clovaStreamingConfiguration, currentQuestionVocabulary} from '../server/providers/speech-vocabulary';
import {loadInterviewContext} from '../server/data/load-interview-context';
import {decodeSyntheticAudio} from './live-e2e-audio';

if (!process.argv.includes('--run-live')) throw Error('EXPLICIT_RUN_LIVE_REQUIRED');
dotenv.config({path:'.env.local',quiet:true});
const mode=process.argv.find(a=>a.startsWith('--mode='))?.split('=')[1]??'current';
const kind=process.argv.find(a=>a.startsWith('--case='))?.split('=')[1]??'meaning';
if(!['current','coherent','source-keywords','legacy-source-keywords'].includes(mode)||!['meaning','role'].includes(kind))throw Error('INVALID_DIAGNOSTIC_MODE');
const original=JSON.parse(await readFile(kind==='meaning'?'artifacts/live-interview-e2e-20261103T125455Z-coverage.json':'artifacts/live-interview-e2e-20261103T125013Z-conversation.json','utf8'));
const selected=original.turns.find((t:{scenario:string})=>t.scenario===(kind==='meaning'?'meaning_request':'specific_role_with_correction'));
const intended=selected.syntheticStudent.text;
const storedTurn=original.finalSession.turns.find((t:{id:string})=>t.id===selected.turnId);
const context=['source-keywords','legacy-source-keywords'].includes(mode)?await loadInterviewContext():null;
// Exact former extraction is test-only, retained for a reproducible adverse control.
function legacyKeywords(){
 const source=[storedTurn.questionText,...context!.student.evidence.filter(e=>storedTurn.evidenceIds.includes(e.id)).map(e=>e.text)].join('\n').normalize('NFC');
 const stop=/^(?:어떤|무엇|본인|직접|실제로|통해서|대해서|관련|활동|학생|내용|과정|이유|설명|질문|기록|말씀|하였|있었|합니다|했어요|주세요)$/u;
 const seen=new Set<string>();for(const raw of source.match(/[가-힣]{2,18}|[A-Za-z][A-Za-z0-9+-]{1,22}/gu)??[]){const w=raw.replace(/(?:에서는|으로는|에서|으로|에게|까지|보다|이라면|이란|라는|라고|이며|이고|은|는|을|를|이|가|과|와)$/u,'');if(w.length>=2&&!stop.test(w))seen.add(w);if(seen.size>=64)break;}return [...seen];
}
const keywords=mode==='source-keywords'?currentQuestionVocabulary(context!,storedTurn):mode==='legacy-source-keywords'?legacyKeywords():[];
const audioId=speechAudioCacheId(intended,{speaker:'nara',speed:0,pitch:0,volume:0,format:'mp3'});
const mp3=await readFile(`data/audio/${audioId}.mp3`),decoded=await decodeSyntheticAudio(mp3);
const definitions=loader.loadSync(path.join(process.cwd(),'server/clova.proto'),{keepCase:true,longs:String,enums:String,defaults:true,oneofs:true});
const pkg=grpc.loadPackageDefinition(definitions) as any;
const Service=pkg.com.nbp.cdncp.nest.grpc.proto.v1.NestService;
const events:Array<Record<string,unknown>>=[];
let closed=false;
const at=performance.now();
const custom=():SpeechStreamTransport=>{
  const c=new Service(`${process.env.CLOVA_SPEECH_GRPC_HOST??'clovaspeech-gw.ncloud.com'}:${process.env.CLOVA_SPEECH_GRPC_PORT??50051}`,grpc.credentials.createSsl());
  const metadata=new grpc.Metadata();metadata.set('authorization',`Bearer ${process.env.CLOVA_SPEECH_SECRET_KEY??''}`);
  const call=c.recognize(metadata);
  const write=call.write.bind(call);
  call.write=(request:any)=>{
    if(request.type==='CONFIG'&&mode==='legacy-source-keywords'){
      const config=JSON.parse(request.config.config);config.keywordBoosting={boostings:[{words:keywords.join(','),weight:1.5}]};request={...request,config:{config:JSON.stringify(config)}};
    }
    if(request.type==='CONFIG'&&mode==='coherent'){
      const config=clovaStreamingConfiguration();
      config.semanticEpd={...config.semanticEpd,useWordEpd:false,usePeriodEpd:false,gapThreshold:800,durationThreshold:20000};
      request={...request,config:{config:JSON.stringify(config)}};
    }
    return write(request);
  };
  call.on('data',(msg:{contents:string})=>events.push({atMs:performance.now()-at,payload:JSON.parse(msg.contents)}));
  return {call,close:()=>{closed=true;c.close();}};
};
const revisions:any[]=[];let error:string|null=null;
const stream=new ClovaSpeechStream(r=>revisions.push(r),e=>{error=e.message;},{keywords},custom);
let raw:string|null=null,finalizeMs:number|null=null;
try{
 const sendAt=performance.now();
 for(let offset=0;offset<decoded.pcm.length;offset+=3200){
  stream.write(decoded.pcm.subarray(offset,offset+3200));
  const delay=sendAt+Math.min(offset+3200,decoded.pcm.length)/32-performance.now();if(delay>0)await sleep(delay);
 }
 const finishAt=performance.now();raw=await stream.finish();finalizeMs=performance.now()-finishAt;
}catch(e){error=e instanceof Error?e.message:String(e);}finally{stream.close();}
const out=`artifacts/clova-stt-same-audio-${kind}-${mode}.json`;
await writeFile(out,JSON.stringify({mode,kind,intended,priorTranscript:selected.capture.rawTranscript,keywords,raw,finalizeMs,audioId,mp3Sha256:createHash('sha256').update(mp3).digest('hex'),pcmSha256:createHash('sha256').update(decoded.pcm).digest('hex'),pcmDurationMs:decoded.durationMs,closed,error,revisions,events,source:'real-clova-grpc-same-cached-audio-no-llm-correction'},null,2));
console.log(JSON.stringify({out,mode,kind,intended,raw,finalizeMs,error}));
if(error)process.exitCode=1;
