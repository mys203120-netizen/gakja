import { createHash } from 'node:crypto';
import type { AudioAccessBinding } from '../../server/request-realtime-server';
import type { AuthenticatedRequestContext } from '../../server/auth/request-identity';
import type { IsolatedSessionProviders } from '../../server/session-writer/isolated-session-service';
import type { SessionTurnProviders } from '../../server/session-turn-preparer';
import { approvedRestatement } from '../../server/providers/approved-restatement';
import { approvedAudioReplay } from '../../server/providers/approved-audio-replay';
import { selectNextPreparedMainQuestion } from '../../server/data/prepared-question-bank';
import { interviewerVoiceDefaults } from '../../server/providers/clova-tts';
import { assertSingleCoreCandidateBinding, SINGLE_CORE_ENGINE_VERSION, singleCoreCandidatePolicySha256 } from '../../server/providers/single-core-runtime';
import { SINGLE_CORE_CONTRACT_VERSION, singleCoreCandidateDecisionSchema, type SingleCoreDecision } from '../../server/providers/single-core-contract';
import { observeAnswerSubmission } from '../../server/answer-submission';
import { syntheticMp3 } from '../shadow/media-fixtures';

export interface SyntheticSessionProviderConfiguration {
  transcript:string; confirmed:boolean; captureError:boolean;
  classifyAction:'continue'|'advance'; nextAction:'CLOSING'|'TRANSITION'|'REPLAY';
}
interface SessionAuthority {ownerId:string;studentId:string;applicationTargetId:string;supportTargetId:string;sessionId:string;sourceRevision?:string|null}
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
/** External LLM/STT/TTS substitutes only. Selection, source/contract checking,
 * replay/restatement and the complete question engine remain production code.
 * Fixture decisions are explicitly configured; no words are classified here. */
export function createSyntheticSessionProviders(options:{
  stage(phase:string,detail:Record<string,unknown>):Promise<void>;
  readPinnedAudio(authority:SessionAuthority,id:string):Promise<Buffer|null>;
}) {
  const configuration:SyntheticSessionProviderConfiguration={transcript:'합성 면접에서 자료를 비교하고 확인한 방법을 설명했습니다.',confirmed:true,captureError:false,classifyAction:'advance',nextAction:'CLOSING'};
  const stats={classify:0,core:0,tts:0,stt:0,captureBytes:0,captureCloses:0,syntheticMediaReads:0,paidProviderCalls:0};
  const media=new Map<string,{authority:SessionAuthority;bytes:Buffer}>();
  const authority=(pins:Readonly<Record<string,unknown>>)=>{
    const value=pins.sessionAuthority as SessionAuthority|undefined;
    if(!value||![value.ownerId,value.studentId,value.applicationTargetId,value.supportTargetId,value.sessionId].every(v=>typeof v==='string'&&v.length>0))throw new Error('PR07E_SYNTHETIC_SESSION_AUTHORITY_REQUIRED');
    return value;
  };
  const decision=():SingleCoreDecision=>configuration.classifyAction==='continue'?
    singleCoreCandidateDecisionSchema.parse({assessment:null,next:{action:'CONTINUE_ANSWER',question:null},reaction:null}):
    singleCoreCandidateDecisionSchema.parse({assessment:{coverage:'met',response:'answered',reason:'Explicit public synthetic provider fixture; no real semantic approval.'},next:{action:configuration.nextAction,question:null},reaction:null});
  const providers:IsolatedSessionProviders={kind:'synthetic',
    async classify(context,session,candidate,work){
      stats.classify++;await options.stage('synthetic-classify',{sessionId:session.id,captureRevision:candidate.captureRevision});
      const turn=session.turns.at(-1);if(!turn?.answerId)throw new Error('PR07E_SYNTHETIC_CURRENT_TURN_REQUIRED');
      const projected=structuredClone(session),current=projected.turns.at(-1)!;
      current.rawTranscript=candidate.text;current.transcriptStatus='finalized';current.metadata.answerCaptureRevision=candidate.captureRevision;current.metadata.answerEndingObservation=candidate.endingObservation;
      current.answerObservation=observeAnswerSubmission(candidate.text,current.metrics,candidate.endingObservation);projected.elapsedMs=candidate.elapsedMs??session.elapsedMs;
      const semanticDecision=decision();
      return {kind:semanticDecision.next.action==='CONTINUE_ANSWER'?'CONTINUE':'ADVANCE',sourceTurnId:turn.id,sourceAnswerId:turn.answerId,sourceTranscriptSha256:hash(candidate.text),captureRevision:candidate.captureRevision,
        engineVersion:SINGLE_CORE_ENGINE_VERSION,contractVersion:SINGLE_CORE_CONTRACT_VERSION,policySha256:singleCoreCandidatePolicySha256(context,projected,work.policyMode),semanticDecision,providerTimings:{coreMs:0,coreModelCalls:0,coreFallback:0}};
    },
    forSession(pins):SessionTurnProviders {
      const scope=authority(pins);
      return {approvedRestatement,approvedAudioReplay,selectNextPreparedMainQuestion,interviewerVoiceDefaults,assertSingleCoreCandidateBinding,SINGLE_CORE_ENGINE_VERSION,
        async runRealtimeCore(context,session,work){
          stats.core++;await options.stage('synthetic-core',{sessionId:session.id});
          const previous=session.turns.at(-1)!;
          if(work.pendingCandidateDecision)assertSingleCoreCandidateBinding(context,session,work.pendingCandidateDecision,work.policyMode);
          const semantic=work.pendingCandidateDecision?.semanticDecision??decision(),replay=semantic.next.action==='REPLAY';
          return {reaction:{classification:'relevant',action:replay?'clarify':'transition',keywordQuote:null,reply:null,reasonCode:'ANSWER_RELATED',evidenceSpan:null,missingTarget:null,directive:replay?'clarification_same_target':'next_main',
            sourceTurnId:previous.id,sourceAnswerId:previous.answerId??null,parentMainQuestionId:previous.parentMainQuestionId,origin:'model',durationMs:0},
            draft:null,followUpGoal:null,origin:'model',providerTimings:{coreMs:0,coreModelCalls:0,coreFallback:0},engineVersion:SINGLE_CORE_ENGINE_VERSION,semanticDecision:semantic,
            execution:{status:'ready',action:semantic.next.action,surfaceOrigin:null,semanticAuthority:'single_core'},
            nextAction:semantic.next.action==='REPLAY'?'CLARIFICATION':semantic.next.action==='CONTINUE_ANSWER'?'CONTINUE_ANSWER':semantic.next.action==='CLOSING'?'CLOSING':'TRANSITION',
            ...(replay?{clarificationMode:'repeat_audio' as const}:{}),fulfillment:'met'};
        },
        async synthesizeSpeech(text,speaker,work={}){
          stats.tts++;await options.stage('synthetic-tts',{sessionId:scope.sessionId});
          const id=hash(JSON.stringify([scope.ownerId,scope.sessionId,speaker,text]));media.set(id,{authority:{...scope},bytes:syntheticMp3()});
          work.onTiming?.({durationMs:0,providerMs:0,audioId:id,cache:'memory',settings:{speaker,speed:0,pitch:0,volume:0,format:'mp3'}});return '/api/audio/'+id;
        },
        async readSpeechAudio(id){const value=media.get(id);if(value&&value.authority.ownerId===scope.ownerId)return Buffer.from(value.bytes);return options.readPinnedAudio(scope,id);},
      };
    },
    async openCapture(input){
      stats.stt++;await options.stage('synthetic-stt-open',{...input});let bytes=0,closed=false;
      return {async write(body){if(closed)throw new Error('PR07E_SYNTHETIC_CAPTURE_CLOSED');bytes+=body.length;stats.captureBytes+=body.length;},
        async finish(){await options.stage('synthetic-stt-finish',{...input,bytes});return {rawTranscript:configuration.transcript,confirmed:configuration.confirmed,errorCode:configuration.captureError?'SYNTHETIC_STT_DEVICE_FAILURE':undefined};},
        close(){if(!closed){closed=true;stats.captureCloses++;}}};
    },
  };
  return {providers,configure(input:Partial<SyntheticSessionProviderConfiguration>){Object.assign(configuration,input);},diagnostics:()=>({...stats,configuration:{...configuration}}),
    audioBinding(context:AuthenticatedRequestContext,id:string):AudioAccessBinding|null {
      const value=media.get(id);if(!value||value.authority.ownerId!==context.account.ownerId||value.authority.applicationTargetId!==context.scope?.applicationTargetId)return null;
      return {...value.authority,resourceId:id,contentType:'audio/mpeg',objectIdentity:hash(JSON.stringify(['explicit-synthetic-media',value.authority,id,hash(value.bytes)]))};
    },readAudio(context:AuthenticatedRequestContext,binding:AudioAccessBinding){const value=media.get(binding.resourceId);if(!value||value.authority.ownerId!==context.account.ownerId)return null;stats.syntheticMediaReads++;return Buffer.from(value.bytes);}};
}
