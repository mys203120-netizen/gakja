import type { RehearsalSessionRawIO } from '../../server/service/session-providers';
import { singleCoreCandidateDecisionSchema } from '../../server/providers/single-core-contract';
import { syntheticMp3 } from '../shadow/media-fixtures';
import type { SyntheticSessionProviderConfiguration } from '../session-writer/synthetic-providers';
/** Raw provider responses only; G uses real classifier, parser, gates and engines. */
export function createRawSessionIO(stage:(phase:string,detail:Record<string,unknown>)=>Promise<void>){
 const configuration:SyntheticSessionProviderConfiguration={transcript:'합성 면접에서 자료를 비교하고 확인한 방법을 설명했습니다.',confirmed:true,captureError:false,classifyAction:'advance',nextAction:'TRANSITION'};
 const counters={core:0,tts:0,stt:0,captureBytes:0,captureCloses:0,paidProviderCalls:0};
 const raw:RehearsalSessionRawIO={
  async requestSingleCore(){counters.core++;await stage('raw-model',{});return singleCoreCandidateDecisionSchema.parse(configuration.classifyAction==='continue'?{assessment:null,next:{action:'CONTINUE_ANSWER',question:null},reaction:null}:{assessment:{coverage:'met',response:'answered',reason:'Explicit public raw provider response fixture.'},next:{action:configuration.nextAction,question:null},reaction:null});},
  async requestFactReview(){throw new Error('G_UNEXPECTED_FACT_REVIEW_RAW_CALL');},async requestSurfaceRepair(){throw new Error('G_UNEXPECTED_SURFACE_REPAIR_RAW_CALL');},
  async requestSpeechBytes(){counters.tts++;await stage('raw-tts',{});return syntheticMp3();},
  async openCapture(input){counters.stt++;await stage('raw-stt-open',{...input});let closed=false;
   return {async write(bytes){if(closed)throw new Error('G_CAPTURE_CLOSED');counters.captureBytes+=bytes.length;},async finish(){await stage('raw-stt-finish',{...input});return {rawTranscript:configuration.transcript,confirmed:configuration.confirmed,...(configuration.captureError?{errorCode:'SYNTHETIC_STT_DEVICE_FAILURE'}:{})};},close(){if(!closed){closed=true;counters.captureCloses++;}}};
  },
 };
 return {raw,configure(value:Partial<SyntheticSessionProviderConfiguration>){Object.assign(configuration,value);},diagnostics:()=>({...counters,configuration:{...configuration}})};
}
