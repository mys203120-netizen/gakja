import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { estimateProviderCost, aggregateProviderCosts, type ProviderUsageObservation } from '../server/observability/provider-cost';
import type { SingleCoreDecision } from '../server/providers/single-core-contract';
interface Case { id: string; repeat: number; newDecision: SingleCoreDecision | null; acceptedAcknowledgement: unknown; wallMs: number; failure?: string | null;
  providerUsage: Array<{ stage: string; observation: ProviderUsageObservation }>; policyTrace?: Record<string, unknown>;
  labelCheck: { structuralLabelsPassed: boolean; failures: string[] }; expected: unknown }
interface Report { cases: Case[]; providerRequests: number; semanticPromptSha256: string; contractVersion: string; coreReasoningEffort?: string;
  manifest: { sha256: string }; analysisRevisionPath?: string; engineSourceUnchanged: boolean; activePointerUnchanged: boolean;
  historicalEvidenceProjection?: { currentManifestSha256?: string }; proposedReactionCount: number; acceptedReactionCount: number }
const names = [
  'actual-user-core-v6-c00231-20261104.json', 'actual-user-core-v6-tuned-c00231-20261104.json',
  'actual-user-core-v6-final-c00231-20261104.json', 'actual-user-core-v7-critical-c00231-20261104.json',
  'actual-user-core-v7-neutral-critical-low-c00231-20261104.json', 'actual-user-core-v7-neutral-critical-medium-c00231-20261104.json',
  'actual-user-core-v7-scope-first-critical-low-c00231-20261104.json', 'actual-user-core-v7-final-c00231-20261104.json',
  'actual-user-core-v7-compact-final-c00231-20261104.json',
];
const round = (n: number) => Math.round(n * 1000) / 1000;
const stats = (values: number[]) => { const sorted = [...values].sort((a,b) => a-b); return { min: round(sorted[0]), median: round(sorted.length % 2 ? sorted[(sorted.length-1)/2] : (sorted[sorted.length/2-1]+sorted[sorted.length/2])/2), p95: round(sorted[Math.ceil(sorted.length*.95)-1]), max: round(sorted.at(-1)!), total: round(sorted.reduce((a,b)=>a+b,0)) }; };
const reports: Array<{ path: string; report: Report; sha256: string }> = [];
for (const name of names) { const file = `artifacts/${name}`, bytes = await readFile(file); reports.push({ path: file, report: JSON.parse(bytes.toString('utf8')) as Report, sha256: createHash('sha256').update(bytes).digest('hex') }); }
const experiments = reports.map(({ path, report: r, sha256 }) => {
  const observations = r.cases.flatMap(item => item.providerUsage.map(row=>row.observation));
  const costs = observations.map(estimateProviderCost), input = observations.map(item=>item.usage?.input_tokens ?? 0);
  const usage = observations.reduce((sum, item) => { const u=item.usage; if (!u) { sum.missingUsageCalls++; return sum; }
    sum.input += u.input_tokens; sum.output += u.output_tokens; sum.cachedRead += u.input_tokens_details.cached_tokens;
    sum.reasoning += u.output_tokens_details?.reasoning_tokens ?? 0;
    if (u.input_tokens_details.cache_write_tokens === undefined) sum.missingCacheWriteCounterCalls++;
    else sum.cacheWrite += u.input_tokens_details.cache_write_tokens;
    sum.cacheWrite30m += u.input_tokens_details.cache_write_tokens_details?.ttl_30m_tokens ?? 0;
    sum.cacheWrite12h += u.input_tokens_details.cache_write_tokens_details?.ttl_12h_tokens ?? 0; return sum;
  }, { input:0,output:0,cachedRead:0,cacheWrite:0,cacheWrite30m:0,cacheWrite12h:0,reasoning:0,missingUsageCalls:0,missingCacheWriteCounterCalls:0 });
  return { path, sha256, cases:r.cases.length, providerCalls:r.providerRequests,
    effort:r.coreReasoningEffort ?? r.cases[0].policyTrace?.coreReasoningEffort, contract:r.contractVersion,
    inputContract:r.cases[0].policyTrace?.inputContract, semanticPromptSha256:r.semanticPromptSha256,
    caseManifestSha256:r.manifest.sha256, stagedAnalysis:r.analysisRevisionPath,
    unchangedEngineDuringRun:r.engineSourceUnchanged, unchangedActivePointer:r.activePointerUnchanged,
    latencyMs:stats(r.cases.map(item=>item.wallMs)), observedInputTokensPerCall:stats(input), usage,
    cachedReadShareOfInput:round(usage.cachedRead/usage.input), publicSnapshotEstimate:aggregateProviderCosts(costs),
    costBoundsWhereNeeded:{ lowerUsd:round(costs.reduce((sum,cost)=>sum+(cost.usd??cost.lowerBoundUsd??0),0)), upperUsd:round(costs.reduce((sum,cost)=>sum+(cost.usd??cost.upperBoundUsd??0),0)) },
    modelResponseFamilies:[...new Set(observations.map(item=>item.responseModel))], processingTiers:[...new Set(observations.map(item=>item.serviceTier??item.requestedServiceTier))],
    providerFailures:r.cases.filter(item=>item.failure).map(item=>({id:item.id,repeat:item.repeat,failure:item.failure})),
    falseContinuationOnFrozenCompleteCases:r.cases.filter(item=>item.id!=='R2-Q6'&&item.newDecision?.next.action==='CONTINUE_ANSWER').map(item=>({id:item.id,repeat:item.repeat})),
    frozenLabelPasses:r.cases.filter(item=>item.labelCheck.structuralLabelsPassed).length,
    frozenLabelFailures:r.cases.filter(item=>!item.labelCheck.structuralLabelsPassed).map(item=>({id:item.id,repeat:item.repeat,failures:item.labelCheck.failures})),
    proposedReactions:r.proposedReactionCount, sourceGateAcceptedReactions:r.acceptedReactionCount,
  };
});
const selectedRuntimeReport = 'artifacts/actual-user-core-v7-final-c00231-20261104.json';
const final = reports.find(item=>item.path===selectedRuntimeReport)!.report;
const notes: Record<string,{status:'PASS'|'NUANCE'|'DEFECT';finding:string;md:string[]}> = {
  'R1-Q1':{status:'PASS',finding:'Search path is not evidence. F narrows to recoverable comparison data/conditions; no invented experiment or scoring.',md:['MD9 §15','MD10 §§4,6–7']},
  'R1-Q2':{status:'NUANCE',finding:'No false unrelated label. F asks narrower source/condition existence, not the whole original comparison. Within F2 budget, but added value after repeated search-path answer is weak; transition or one easy same-demand rephrase is preferable. Frozen transition-only failure remains recorded.',md:['MD8 §§13–15','MD9 §§14–17']},
  'R1-Q3':{status:'PASS',finding:'Actual personal work accepted; no additional STAR/activity requirement.',md:['MD10 §§4,6']},
  'R1-Q4':{status:'PASS',finding:'Honest grade-driven choice accepted without shame, moral judgment, or invented interest.',md:['MD8 §8','MD9 §§13,15']},
  'R1-Q5':{status:'NUANCE',finding:'Student names straight-line approximation as a limit. Asking its implication for cumulative interpretation can be useful, but partial is stricter than the student-favorable reading of this broad question. Prefer met if followed by a useful separate implication probe; do not count as an unequivocal coverage pass.',md:['MD10 §6(2)','MD9 §15(4)']},
  'R1-Q6':{status:'PASS',finding:'Relative change comparison met; no retroactive requirement for mechanism.',md:['MD10 §§4,6','MD9 §15']},
  'R1-Q7':{status:'PASS',finding:'Unknown mechanism scope respected; no admission judgment or coaching despite admission request.',md:['MD8 §14','MD9 §16']},
  'R1-Q8':{status:'PASS',finding:'Completed negative answers conditional connection question; no forced invented interest.',md:['MD10 §6']},
  'R1-Q9':{status:'PASS',finding:'Grade priority treated as actual criterion rather than undesirable non-answer.',md:['MD9 §15','MD10 §6']},
  'R2-Q1':{status:'PASS',finding:'Absence of evidence acknowledged as unavailable and transitioned; not misrecorded as supplied evidence.',md:['MD8 §14','MD10 §§6–7']},
  'R2-Q2':{status:'PASS',finding:'Short complete no-role answer accepted for conditional existence question.',md:['MD10 §6']},
  'R2-Q3':{status:'PASS',finding:'Nonacademic social-impression priority accepted as actual choice criterion.',md:['MD9 §§13,15','MD10 §6']},
  'R2-Q4':{status:'PASS',finding:'Other person knowing the criterion not misrecorded as student supplying it; one same-demand clarification, no F inflation.',md:['MD8 §13','MD9 §16']},
  'R2-Q5':{status:'PASS',finding:'Concrete criteria accepted without another why/STAR probe.',md:['MD10 §§4,6']},
  'R2-Q6':{status:'PASS',finding:'Clearly open concessive utterance continues with no question, assessment, reaction, or F.',md:['MD8 §§8,15','MD10 §42']},
  'R2-Q7':{status:'DEFECT',finding:'Contextual strong/weak-electrolyte reading succeeds and F does not define a misheard word. But reason explicitly says comparison directions were answered then marks partial for an unasked principle. Existing direction comparison should remain met; any useful principle F is a separate deeper demand.',md:['MD10 §4(3),§6(2)','MD9 §§10,15']},
  'R2-Q8':{status:'PASS',finding:'Explicit refusal ends scope with neutral acceptance; no same-demand re-interrogation.',md:['MD8 §§14–15','MD9 §§16–17']},
  'R2-Q9':{status:'PASS',finding:'Ambiguous side attribution kept partial; prior refusal respected through transition without another definition F.',md:['MD8 §14','MD10 §§5–6']},
  'R3-Q1':{status:'PASS',finding:'Actual reading-interest motive met; neutral paraphrase grounded.',md:['MD10 §§4,6']},
  'R3-Q2':{status:'PASS',finding:'Numerical approximation limitation accepted. Nonexact reaction quote rejected by source gate; no raw rewrite or fabricated echo.',md:['MD10 §§4,6','MD8 §9']},
  'R3-Q3':{status:'PASS',finding:'Both actual contributions met; no requirement to invent outcomes.',md:['MD10 §§4,6']},
  'R3-Q4':{status:'PASS',finding:'Comparison pair, identical conditions and percentage baseline accepted; no retroactive requirement for all absolute measured values.',md:['MD10 §4(3),§6(2)']},
  'R3-Q5':{status:'PASS',finding:'Full mechanism comparison met; no repeated principle F.',md:['MD10 §§4,6','MD9 §15']},
  'R3-Q6':{status:'PASS',finding:'Actual research-selection criteria met without deeper unspoken requirements.',md:['MD10 §§4,6']},
  'R3-Q7':{status:'PASS',finding:'Actual cross-activity connection and system-efficiency view met.',md:['MD10 §§4,6']},
};
const cases = final.cases.map(item=>({id:item.id,...notes[item.id],observedCoverage:item.newDecision?.assessment?.coverage??null,
  observedResponse:item.newDecision?.assessment?.response??null,observedNext:item.newDecision?.next??null,
  frozenLabelPassed:item.labelCheck.structuralLabelsPassed,frozenLabelFailures:item.labelCheck.failures,
  proposedReaction:item.newDecision?.reaction??null,acceptedReaction:Boolean(item.acceptedAcknowledgement)}));
const texts = final.cases.flatMap(item=>item.newDecision?.reaction?[item.newDecision.reaction.text]:[]);
const repeatedText = [...new Set(texts)].map(text=>({text,count:texts.filter(item=>item===text).length})).filter(item=>item.count>1);
const verification={version:'actual-user-core-human-verification-v1',createdAt:new Date().toISOString(),
  scope:'Private manual MD-based review of all25 actual historical question/answer checkpoints under staged c002 analysis and exactly verified diagnostic-only old question excerpts. Core-only, voice-free independent prefixes; no HTTP/WS/STT/TTS/browser or continuous conversational-variation claim.',
  frozenLabelsChanged:false,originalSessionsOrJournalsChanged:false,pointerActivationPerformed:false,
  selectedRuntimeReport, runtimeSourceRestorationProof:'artifacts/actual-user-core-v7-restored-source-verification-20261104.json',
  rejectedCompactExperiment:{path:'artifacts/actual-user-core-v7-compact-final-c00231-20261104.json',ship:false,
    reason:'Lower token use did not justify semantic regression. Honest motive, completed conditional denial, same-demand/F relation, unfinished continuation and scoped refusal regressed; the known unasked-principle scope defect also remained.',
    affectedCases:['R1-Q4','R1-Q8','R2-Q4','R2-Q6','R2-Q7','R2-Q9'],newTuningOrPaidBenchmarkAfterRejection:false},
  experimentComparisonLimit:'Same frozen actual Q/A/prefixes and staged c002 source context. Core prompts, wire order and input projection intentionally changed. This is not a population causal experiment or a reconstruction of missing historical prompts.',
  pricingLimit:'Observed SDK counters with the repository published-rate snapshot; cache reads and writes explicit. Estimates are not reconciled account invoices and exclude STT/TTS, bank/analysis preparation and hosting.',
  experiments,totalObservedCoreCalls:experiments.reduce((sum,item)=>sum+item.providerCalls,0),
  finalManualSummary:{PASS:cases.filter(item=>item.status==='PASS').length,NUANCE:cases.filter(item=>item.status==='NUANCE').length,DEFECT:cases.filter(item=>item.status==='DEFECT').length,
    allFrozenLabelsPassed:false,allSemanticCasesUnambiguouslyPassed:false},cases,
  reactionReview:{accepted:final.acceptedReactionCount,proposed:final.proposedReactionCount,acceptedContent:'Neutral receipts/paraphrases/transitions; no observed praise, scoring, coaching, unsupported new achievements or traits.',rejected:'R3-Q2 changed the exact source quote; gate correctly omitted it.',repeatedText,
    limitation:'Original prefixes contain historical reactions, not the new generated reactions from preceding independent checkpoints. Thus repeated generic transitions in this report do not verify live conversational non-repetition. The live core receives recent spoken reactions and the source gate rejects exact repeated text; browser/continuous validation is separate.'},
  concreteRemainingIssue:'R2-Q7 coverage imports an unasked principle despite recognizing the completed directional comparison. No TS semantic correction applied; frozen label failure preserved.'};
const output='artifacts/actual-user-core-v7-human-verification-final-20261104.json';
await writeFile(output,JSON.stringify(verification,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({output,totalObservedCoreCalls:verification.totalObservedCoreCalls,manual:verification.finalManualSummary,selectedRuntimeReport,
  first:experiments[0],final:experiments.find(item=>item.path===selectedRuntimeReport),rejectedCompact:experiments.at(-1)}));
