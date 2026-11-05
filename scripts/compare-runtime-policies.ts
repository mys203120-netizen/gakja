import dotenv from 'dotenv';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {loadInterviewContext} from '../server/data/load-interview-context';
import {loadQuestionBank} from '../server/data/prepared-question-bank';
import {bindQuestionContractToTurn} from '../server/question-objective';
import {createSessionRuntime} from '../server/session-runtime';
import {runStrategyRealtimeCore} from '../server/providers/realtime-strategy-core';
import {evaluateSession} from '../server/providers/openai';
import {synthesizeSpeech,readSpeechAudio} from '../server/providers/clova-tts';
import {compilePolicyClauseRegistry} from '../server/policy/compiled-runtime-policy';
import {estimateProviderCost,aggregateProviderCosts,type ProviderUsageObservation} from '../server/observability/provider-cost';
import type {InterviewSession,RecordedTurn} from '../server/protocol';

const args=process.argv.slice(2),get=(name:string,fallback:string)=>args.find(a=>a.startsWith(name+'='))?.slice(name.length+1)??fallback;
if(!args.includes('--run-live'))throw new Error('EXPLICIT_RUN_LIVE_REQUIRED');
dotenv.config({path:'.env.local',quiet:true});
const modes=get('--modes','full,compiled').split(',') as Array<'full'|'compiled'>;
if(modes.some(m=>!['full','compiled'].includes(m)))throw new Error('UNKNOWN_POLICY_MODE');
const out=get('--out','artifacts/runtime-policy-ab-comparison.json');
if(!/^artifacts\/[a-z0-9-]+\.json$/u.test(out))throw new Error('REPORT_PATH_INVALID');
const onlyCase=args.some(a=>a.startsWith('--case='))?Number(get('--case','0')):null;
const context=await loadInterviewContext(),bank=await loadQuestionBank(context);
if(context.errors.length||!bank||bank.key!=='a2f39d1ff69d7151e4f8ba885f92a68cc034e7e342c39b956d3a0cfff48d4d79')throw new Error('PINNED_BANK_CHANGED');
const registry=compilePolicyClauseRegistry(context);
await mkdir('data/prepared/runtime-policy-registry',{recursive:true});
await writeFile(`data/prepared/runtime-policy-registry/${registry.contentSha256}.json`,JSON.stringify(registry,null,2),{mode:0o600});
const previous=JSON.parse(await readFile('artifacts/fixed-bank-answers-retest.json','utf8'));
const prior=JSON.parse(await readFile('artifacts/bank-ai-student-followup-e2e.json','utf8'));
const original:InterviewSession=JSON.parse(await readFile(`data/sessions/${prior.sessionId}.json`,'utf8'));
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const makeSession=()=>({...structuredClone(original),id:randomUUID(),status:'active',evaluationStatus:'pending',plan:structuredClone(bank.plan),sourceManifest:{...structuredClone(context.manifest),interviewPlan:structuredClone(bank.plan)},runtime:createSessionRuntime(context,original.runtime!.owner),turns:[],questionPresentations:[],questionPresentationEventIds:[],followUpCountByMainQuestion:{},conversationLedger:undefined,elapsedMs:30000,durationSeconds:context.interviewOverview!.durationSeconds}) as InterviewSession;
const fixtures=previous.cases.map((c:{index:number;question:string;answer:string;sameAnswerSha256:string})=>{
 const selected=bank.slots.flatMap(slot=>slot.candidates.map(candidate=>({slot,candidate}))).find(({candidate})=>candidate.draft.questionText===c.question);
 if(!selected||hash(c.answer)!==c.sameAnswerSha256)throw new Error('FIXED_CASE_CHANGED');
 const {slot,candidate}=selected,session=makeSession(),draft=structuredClone(candidate.draft),id=randomUUID();
 Object.assign(draft,bindQuestionContractToTurn(draft,context,session,id));
 const turn={id,questionText:draft.questionText,questionKind:'main',parentMainQuestionId:id,mainIndex:slot.mainIndex,mainCount:bank.plan.mainQuestionTarget,followUpIndex:0,evidenceIds:draft.evidenceIds,questionAudioUrl:candidate.questionAudioUrl,acknowledgement:null,acknowledgementAudioUrl:null,interviewerId:'interviewer-1',rawTranscript:c.answer,answerId:randomUUID(),transcriptStatus:'finalized',metadata:{...draft,rulesVersion:context.manifest.rulesVersion,generatedAt:new Date().toISOString(),answerTurnId:null,sourceAnswerId:null,sourceRefIds:draft.evidenceIds,activityIds:[...new Set(context.student.evidence.filter(e=>draft.evidenceIds.includes(e.id)).map(e=>e.activityId))],supportTarget:context.target,parentQuestionId:null,questionClusterId:id,planSlotId:slot.slotId,topicArea:bank.plan.slots.find(s=>s.id===slot.slotId)?.topicArea}} as RecordedTurn;
 session.turns.push(turn);session.followUpCountByMainQuestion[id]=0;
 return {index:c.index,session,candidate};
});
const report:{[key:string]:any}={startedAt:new Date().toISOString(),provenance:{syntheticTest:true,exactFixedAnswers:true,newStudentGenerationCalls:0,sttCalls:0,browserPlaybackMeasured:false,persistedAsHumanSession:false},bankKey:bank.key,bankContentSha256:bank.contentSha256,registrySha256:registry.contentSha256,coverage:registry.coverage,runOrder:[],cases:[],evaluation:[],limits:['Six fixed independent Q0 cases are a controlled workload, not a complete timed human interview.','Charges are observed API usage multiplied by official public rates, not invoice reconciliation.','CLOVA, hosting, tax and preparation amortization are not silently treated as zero.','Order alternates by case; first writes and warm reads are recorded, no forced provider cache purge.']};
const save=()=>writeFile(out,JSON.stringify(report,null,2),{mode:0o600});
for(const fixture of fixtures){
 if(onlyCase!==null&&fixture.index!==onlyCase)continue;
 const order=fixture.index%2?[...modes].reverse():modes;
 for(const mode of order){
  const session=structuredClone(fixture.session),turn=session.turns[0],observed:Array<{stage:string;observation:ProviderUsageObservation;cost:ReturnType<typeof estimateProviderCost>}>=[];
  report.runOrder.push({index:fixture.index,mode});
  const result=await runStrategyRealtimeCore(context,session,{policyMode:mode,allowFollowUp:true,allowClarification:true,onProviderUsage:(stage,observation)=>observed.push({stage,observation,cost:estimateProviderCost(observation)})});
  const row:{[key:string]:any}={index:fixture.index,mode,question:turn.questionText,answer:turn.rawTranscript,answerSha256:hash(turn.rawTranscript!),fixtureTurnId:turn.id,questionContractSha256:turn.metadata.approvedQuestion?.contentSha256,action:result.nextAction,requestedAction:result.requestedAction,origin:result.origin,fulfillment:result.fulfillment,interpretation:result.interpretation,candidateQuestion:result.candidateQuestion,approvedQuestion:result.draft?.questionText??null,approvedKind:result.draft?.questionKind??null,recoveryRequired:result.questionRecoveryRequired??false,failure:result.failureDetail??null,serverGuards:result.serverGuards,reviewTrace:result.reviewTrace,policyTrace:result.policyTrace,timings:result.providerTimings,providerUsage:observed,cost:aggregateProviderCosts(observed.map(x=>x.cost)),checks:{approvedBeforeSpeech:!result.draft||result.draft.premiseValidation?.status==='approved',singleDemand:!result.draft||result.draft.premiseValidation?.coreIntentCount===1,noIdenticalUnrequestedRepeat:!result.draft||result.draft.questionText!==turn.questionText,sameCluster:!result.draft||result.draft.parentMainQuestionId===turn.parentMainQuestionId,answerPreserved:turn.rawTranscript===fixture.session.turns[0].rawTranscript}};
  if(result.draft&&args.includes('--synthesize')){let timing:unknown;const at=performance.now();const url=await synthesizeSpeech(result.draft.questionText,fixture.candidate.voiceSettings.speaker,{settings:fixture.candidate.voiceSettings,onTiming:t=>{timing=t;}});row.audio={elapsedMs:performance.now()-at,requestCharacters:result.draft.questionText.length,bytes:(await readSpeechAudio(url.slice('/api/audio/'.length)))?.length,timing};}
  report.cases.push(row);await save();
  console.log(JSON.stringify({index:fixture.index,mode,action:row.action,approved:row.approvedQuestion,requiresRetry:row.recoveryRequired,failure:row.failure,input:row.timings.inputTokens,reviewInput:row.timings.reviewInputTokens,ms:row.timings.realtimeTurnMs,cost:row.cost.totalUsd,unknownCosts:row.cost.unknownCalls}));
  if(result.providerUnavailable){report.aborted='provider_unavailable';await save();process.exitCode=1;break;}
 }
 if(report.aborted)break;
}
if(args.includes('--evaluate')&&!report.aborted){
 for(const mode of modes){
  const session=makeSession();session.status='completed';session.elapsedMs=session.durationSeconds!*1000;
  session.turns=fixtures.map((f:{session:InterviewSession})=>structuredClone(f.session.turns[0]));
  session.metrics={verification:{syntheticTest:true,scenario:'fixed-six-answer-cost-benchmark',syntheticClientObservation:false}};
  const observations:ProviderUsageObservation[]=[],at=performance.now();
  const row:{[key:string]:any}={mode,questionCount:session.turns.length,normalDeliveryObserved:false};
  try{const result=await evaluateSession(context,session,{maxRetries:0,onProviderUsage:o=>observations.push(o)});row.completed=true;row.outputSummary={summary:result.summary};}catch(error){row.completed=false;row.failure=error instanceof Error?error.name:'unknown';}
  row.elapsedMs=performance.now()-at;row.providerUsage=observations;row.cost=aggregateProviderCosts(observations.map(estimateProviderCost));report.evaluation.push(row);await save();console.log(JSON.stringify({stage:'evaluation',mode,completed:row.completed,input:observations[0]?.usage?.input_tokens,cost:row.cost.totalUsd,ms:row.elapsedMs}));
 }
}
report.completedAt=new Date().toISOString();
report.summary=modes.map(mode=>{const rows=report.cases.filter((r:any)=>r.mode===mode),evalRows=report.evaluation.filter((r:any)=>r.mode===mode),costs=[...rows.flatMap((r:any)=>r.providerUsage.map((o:any)=>o.cost)),...evalRows.flatMap((r:any)=>r.providerUsage.map(estimateProviderCost))];return {mode,caseCount:rows.length,approvedFollowUps:rows.filter((r:any)=>r.approvedKind==='follow_up').length,approvedClarifications:rows.filter((r:any)=>r.approvedKind==='clarification').length,retryRequired:rows.filter((r:any)=>r.recoveryRequired).length,totalCoreAndReviewMs:rows.reduce((n:number,r:any)=>n+r.timings.realtimeTurnMs,0),coreInputTokens:rows.map((r:any)=>r.timings.inputTokens??null),reviewInputTokens:rows.map((r:any)=>r.timings.reviewInputTokens??null),sixAnswerLlmWorkloadCost:aggregateProviderCosts(costs)};});
await save();console.log(JSON.stringify({artifact:out,summary:report.summary}));
