import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { aggregateProviderCosts, estimateProviderCost, LUNA_PUBLIC_PRICE_SNAPSHOT, TERRA_PUBLIC_PRICE_SNAPSHOT, type ProviderUsageObservation } from '../server/observability/provider-cost';
import { speechCost, speechCostScenario, SPEECH_USER_PROVIDED_PRICE_SNAPSHOT, VOICE_USER_PROVIDED_PRICE_SNAPSHOT } from '../server/observability/speech-cost';

type Mode = 'full' | 'compiled';
type Stage = 'core' | 'review';
interface UsageEntry { stage: Stage; observation: ProviderUsageObservation }
interface BenchmarkCase {
  mode: Mode; index: number; answerSha256: string; questionContractSha256: string;
  action?: string; approvedKind?: string | null; origin?: string; failure?: string | null;
  recoveryRequired?: boolean; checks?: Record<string, boolean>;
  providerUsage: UsageEntry[]; timings: Record<string, number>;
  audio?: { elapsedMs: number; requestCharacters: number; timing?: { cache?: string; durationMs?: number; providerMs?: number | null } };
}
interface Evaluation {
  mode: Mode; completed: boolean; questionCount: number; elapsedMs: number;
  providerUsage: ProviderUsageObservation[];
}
export interface RuntimePolicyBenchmark {
  startedAt?: string; completedAt?: string; bankKey?: string; bankContentSha256?: string;
  registrySha256?: string; provenance: { sttCalls?: number; [key: string]: unknown };
  cases: BenchmarkCase[]; evaluation?: Evaluation[]; limits?: string[];
}
const round = (value: number) => Number(value.toFixed(12));
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function numericSummary(values: number[]) {
  if (values.some(value => !finite(value))) throw new Error('NONFINITE_METRIC');
  const sorted = [...values].sort((a, b) => a - b), count = sorted.length;
  return { count, minimum: count ? sorted[0] : null, maximum: count ? sorted[count - 1] : null,
    mean: count ? round(values.reduce((sum, value) => sum + value, 0) / count) : null,
    median: count ? round(count % 2 ? sorted[Math.floor(count / 2)] : (sorted[count / 2 - 1] + sorted[count / 2]) / 2) : null,
    sum: round(values.reduce((sum, value) => sum + value, 0)) };
}

/** Hypothetical identical-request warm replay. Does not predict production cache hits. */
export function identicalRequestWarmObservation(observed: ProviderUsageObservation): ProviderUsageObservation {
  const result = structuredClone(observed), usage = result.usage;
  if (result.validity !== 'complete' || !usage || usage.input_tokens_details.cache_write_tokens === undefined) return result;
  const details = usage.input_tokens_details;
  details.cached_tokens += details.cache_write_tokens!;
  details.cache_write_tokens = 0;
  details.cache_write_tokens_details = { ttl_30m_tokens: 0, ttl_12h_tokens: 0 };
  return result;
}

function priced(observations: ProviderUsageObservation[], warm = false) {
  const estimates = observations.map(value => estimateProviderCost(warm ? identicalRequestWarmObservation(value) : value));
  const aggregate = aggregateProviderCosts(estimates);
  // Unlike the generic helper, this report includes evaluation explicitly below.
  return { basis: aggregate.basis, invoiceVerified: false as const, currency: 'USD' as const,
    calls: aggregate.observedCalls, pricedCalls: aggregate.pricedCalls, unknownCalls: aggregate.unknownCalls,
    knownSubtotalUsd: aggregate.observedPricedSubtotalUsd, totalUsd: aggregate.totalUsd,
    unknownReasons: estimates.filter(value => value.usd === null).map(value => value.reason) };
}
function tokenStats(observations: ProviderUsageObservation[]) {
  const measured = observations.filter(value => value.validity === 'complete' && value.usage !== null).map(value => value.usage!);
  return { observedCalls: observations.length, completeUsageCalls: measured.length,
    input: numericSummary(measured.map(value => value.input_tokens)),
    output: numericSummary(measured.map(value => value.output_tokens)),
    cachedRead: numericSummary(measured.map(value => value.input_tokens_details.cached_tokens)),
    cacheWrite: numericSummary(measured.flatMap(value => value.input_tokens_details.cache_write_tokens === undefined ? [] : [value.input_tokens_details.cache_write_tokens])),
    cacheWriteUsageMissingCalls: measured.filter(value => value.input_tokens_details.cache_write_tokens === undefined).length };
}
function audioSummary(cases: BenchmarkCase[]) {
  const calls = cases.filter(value => value.audio !== undefined).map(value => ({ index: value.index, ...value.audio! }));
  const provider = calls.filter(value => value.timing?.cache === 'provider');
  const reused = calls.filter(value => value.timing?.cache === 'memory' || value.timing?.cache === 'disk');
  const unknown = calls.filter(value => !['provider', 'memory', 'disk'].includes(value.timing?.cache ?? ''));
  return {
    recordedAudioRequests: calls.length, providerRequests: provider.length, cacheReadRequests: reused.length, unknownCacheRequests: unknown.length,
    newSynthesisRequestCharacters: unknown.length ? null : provider.reduce((sum, value) => sum + value.requestCharacters, 0),
    knownNewSynthesisRequestCharacters: provider.reduce((sum, value) => sum + value.requestCharacters, 0),
    reusedRequestCharacters: reused.reduce((sum, value) => sum + value.requestCharacters, 0),
    marginalFeeKrw: null,
    reason: 'Existing monthly application usage and remaining allowance are unmeasured; request characters are not a reconciled billing counter.',
    elapsedMsAllRecorded: numericSummary(calls.map(value => value.elapsedMs)),
    elapsedMsProvider: numericSummary(provider.map(value => value.elapsedMs)),
    elapsedMsCacheRead: numericSummary(reused.map(value => value.elapsedMs)),
    measuredProviderMs: numericSummary(provider.flatMap(value => finite(value.timing?.providerMs) ? [value.timing!.providerMs!] : [])),
    scope: 'Only audio explicitly present in benchmark cases; not all Q0 bank audio, reactions, browser playback or an entire interview.',
  };
}
const addKnown = (left: number | null, right: number | null) => left === null || right === null ? null : round(left + right);
const decrease = (before: number | null, after: number | null) => before === null || after === null || before === 0 ? null : round((before - after) / before * 100);

export function summarizeRuntimePolicyCost(input: RuntimePolicyBenchmark) {
  if (!Array.isArray(input.cases) || !input.cases.length) throw new Error('BENCHMARK_CASES_MISSING');
  const full = input.cases.filter(value => value.mode === 'full'), compiled = input.cases.filter(value => value.mode === 'compiled');
  const indices = new Set(input.cases.map(value => value.index));
  const pairs = [...indices].sort((a, b) => a - b).map(index => {
    const a = full.filter(value => value.index === index), b = compiled.filter(value => value.index === index);
    if (a.length !== 1 || b.length !== 1 || a[0].answerSha256 !== b[0].answerSha256 || a[0].questionContractSha256 !== b[0].questionContractSha256) throw new Error(`UNMATCHED_CASE_${index}`);
    return { index, sameAnswer: true, sameQuestionContract: true };
  });
  // Reuse one warmed evaluator reference for BOTH arms, removing evaluator order
  // and stochastic output-length differences from the normalized comparison.
  const evaluationReference = (input.evaluation ?? []).find(value => value.mode === 'full' && value.completed && value.providerUsage.length);
  const sharedEvaluationCost = evaluationReference ? priced(evaluationReference.providerUsage, true) : null;
  const arms = (['full', 'compiled'] as const).map(mode => {
    const cases = input.cases.filter(value => value.mode === mode);
    const usage = cases.flatMap(value => value.providerUsage);
    const core = usage.filter(value => value.stage === 'core').map(value => value.observation);
    const review = usage.filter(value => value.stage === 'review').map(value => value.observation);
    const evaluation = (input.evaluation ?? []).filter(value => value.mode === mode);
    const evaluationUsage = evaluation.flatMap(value => value.providerUsage);
    const actualRealtime = priced([...core, ...review]);
    const actualEvaluation = evaluation.length ? priced(evaluationUsage) : null;
    const warmRealtime = priced([...core, ...review], true);
    const metric = (key: string) => numericSummary(cases.flatMap(value => finite(value.timings[key]) ? [value.timings[key]] : []));
    const allChecks = [...new Set(cases.flatMap(value => Object.keys(value.checks ?? {})))].sort();
    return { mode, cases: cases.length,
      observedPublishedRateCost: {
        core: priced(core), review: priced(review), realtimeCoreAndReview: actualRealtime,
        evaluation: actualEvaluation,
        combinedMeasuredWorkloadUsd: actualEvaluation ? addKnown(actualRealtime.totalUsd, actualEvaluation.totalUsd) : null,
      },
      identicalRequestWarmScenario: {
        hypothetical: true, core: priced(core, true), review: priced(review, true), realtimeCoreAndReview: warmRealtime,
        commonEvaluatorReference: sharedEvaluationCost,
        combinedWithCommonEvaluatorUsd: sharedEvaluationCost ? addKnown(warmRealtime.totalUsd, sharedEvaluationCost.totalUsd) : null,
      },
      tokenRanges: { core: tokenStats(core), review: tokenStats(review), evaluation: tokenStats(evaluationUsage) },
      timingsMs: {
        core: metric('coreMs'), localAndLlmReviewAllCases: metric('premiseReviewMs'),
        reviewCasesWithActualProviderCall: numericSummary(cases.filter(value => value.providerUsage.some(entry => entry.stage === 'review')).map(value => value.timings.premiseReviewMs)),
        realtimeCoreAndReview: metric('realtimeTurnMs'),
        evaluation: numericSummary(evaluation.map(value => value.elapsedMs)),
        recordedFollowUpOrClarificationAudioReady: numericSummary(cases.filter(value => value.audio).map(value => value.timings.realtimeTurnMs + value.audio!.elapsedMs)),
        timingScope: 'Observed timings, not warm-normalized predictions. Realtime excludes STT, TTS, browser playback and student speaking time; recorded audio-ready samples add TTS only where measured.',
      },
      qualityChecks: {
        approvedFollowUps: cases.filter(value => value.approvedKind === 'follow_up').length,
        approvedClarifications: cases.filter(value => value.approvedKind === 'clarification').length,
        transitions: cases.filter(value => value.action === 'TRANSITION').length,
        fallbacks: cases.filter(value => value.origin === 'fallback').length,
        recoveryRequired: cases.filter(value => value.recoveryRequired).length,
        failureCodes: cases.flatMap(value => value.failure ? [{ index: value.index, failure: value.failure }] : []),
        assertions: allChecks.map(check => ({ check, passed: cases.filter(value => value.checks?.[check] === true).length, failed: cases.filter(value => value.checks?.[check] === false).length, missing: cases.filter(value => value.checks?.[check] === undefined).length })),
        limitation: 'Structural assertions and generated follow-up counts do not prove natural dialogue quality or MD semantic completeness; inspect content and blinded audits separately.',
      },
      audio: audioSummary(cases),
    };
  });
  const [a, b] = arms;
  return {
    version: 'runtime-policy-cost-summary-v1', sourceStartedAt: input.startedAt ?? null, sourceCompletedAt: input.completedAt ?? null,
    bankKey: input.bankKey ?? null, bankContentSha256: input.bankContentSha256 ?? null, registrySha256: input.registrySha256 ?? null,
    pricingSnapshots: { openaiLuna: LUNA_PUBLIC_PRICE_SNAPSHOT, openaiTerra: TERRA_PUBLIC_PRICE_SNAPSHOT, speech: SPEECH_USER_PROVIDED_PRICE_SNAPSHOT, voice: VOICE_USER_PROVIDED_PRICE_SNAPSHOT },
    measuredScope: {
      description: `${pairs.length} independent fixed Q0/AI-answer cases per arm, plus separately measured post-evaluation workload.`,
      sourceRunMarkedComplete: Boolean(input.completedAt), pairedCases: pairs.length,
      completeTimedHumanInterview: false, twelveMinuteSessionCostMeasured: false, invoiceVerified: false,
      pairedCaseContractsAndAnswers: pairs, provenance: input.provenance,
      sttRerunCalls: input.provenance.sttCalls ?? null,
      sttRerunCost: speechCost(input.provenance.sttCalls === 0 ? [] : null),
    },
    arms,
    comparison: {
      coreMeanInputTokenReductionPercent: decrease(a.tokenRanges.core.input.mean, b.tokenRanges.core.input.mean),
      observedRealtimeMeanLatencyReductionPercent: decrease(a.timingsMs.realtimeCoreAndReview.mean, b.timingsMs.realtimeCoreAndReview.mean),
      observedRealtimeMedianLatencyReductionPercent: decrease(a.timingsMs.realtimeCoreAndReview.median, b.timingsMs.realtimeCoreAndReview.median),
      observedRealtimeCostReductionPercent: decrease(a.observedPublishedRateCost.realtimeCoreAndReview.totalUsd, b.observedPublishedRateCost.realtimeCoreAndReview.totalUsd),
      matchedWarmRealtimeCostReductionPercent: decrease(a.identicalRequestWarmScenario.realtimeCoreAndReview.totalUsd, b.identicalRequestWarmScenario.realtimeCoreAndReview.totalUsd),
      matchedWarmWithCommonEvaluationCostReductionPercent: decrease(a.identicalRequestWarmScenario.combinedWithCommonEvaluatorUsd, b.identicalRequestWarmScenario.combinedWithCommonEvaluatorUsd),
    },
    warmScenarioDefinition: {
      hypothetical: true, sharedEvaluatorSourceArm: evaluationReference?.mode ?? null,
      sharedEvaluatorObservedOutputTokens: evaluationReference?.providerUsage.reduce((sum, value) => sum + (value.usage?.output_tokens ?? 0), 0) ?? null,
      transformation: 'For every complete observation with known write counters, move cache_write_tokens to cached_tokens; preserve ordinary-input, output, total input and model/tier. Use the same transformed full-arm evaluation reference for both arms.',
      warning: 'This assumes the identical request prefix including previously written dynamic content is reusable. It is not a promised production cache-hit rate, cold-cache experiment, latency measurement or invoice. Missing write counters remain unknown.',
    },
    monthlySpeechAndVoiceScenarios: {
      currency: 'KRW', source: 'user-provided-tariffs-2026-11-03', applicationCount: 1,
      assumptions: '200 newly synthesized characters and 360,000ms captured STT in one stream per interview; one full-month paid Voice application. Volumes and durations are assumptions, not measured sessions.',
      scenarios: [1_000, 3_000, 10_000].map(count => speechCostScenario(count, 200, 360_000)),
      llmUsdKeptSeparate: true, fxRate: null, mixedCurrencyGrandTotal: null,
    },
    limits: [...(input.limits ?? []),
      'Observed costs are API usage multiplied by rate snapshots, not reconciled account invoices. No currency conversion or tax assumption is invented.',
      'Full and compiled arms may have different cache histories, approved follow-up counts and TTS cache hits; observed cost/latency is not an isolated prompt-length causal experiment.',
      'No first-question generation, offline student analysis, question-bank preparation, audio warm-up, hosting or storage amortization is included.',
      'A warm common evaluator prevents cache-order/output-length differences from being advertised as evaluator savings; evaluator policy itself was not reduced by this realtime change.',
      'Six independent cases do not exercise turn-to-turn adaptation, browser permissions/playback, human STT, silence handling, interruptions or a full 12-minute interview.',
    ],
  };
}

async function main() {
  const inputPath = path.resolve(process.argv[2] ?? 'artifacts/runtime-policy-ab-comparison.json');
  const outputPath = path.resolve(process.argv[3] ?? 'artifacts/runtime-policy-cost-summary.json');
  if (inputPath === outputPath) throw new Error('OUTPUT_MUST_NOT_OVERWRITE_SOURCE');
  const source = await fs.readFile(inputPath, 'utf8');
  const report = { sourceFile: path.relative(process.cwd(), inputPath).split(path.sep).join('/'), sourceSha256: createHash('sha256').update(source).digest('hex'), ...summarizeRuntimePolicyCost(JSON.parse(source) as RuntimePolicyBenchmark) };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ output: outputPath, inputSha256: report.sourceSha256, comparison: report.comparison }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
