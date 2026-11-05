import test from 'node:test';
import assert from 'node:assert/strict';
import { identicalRequestWarmObservation, numericSummary, summarizeRuntimePolicyCost, type RuntimePolicyBenchmark } from '../scripts/summarize-runtime-policy-cost';
import { estimateProviderCost, normalizeProviderUsage } from '../server/observability/provider-cost';

function observation() {
  return normalizeProviderUsage({ model: 'gpt-6-luna', service_tier: 'default', prompt_cache_options: { ttl: '30m' }, usage: {
    input_tokens: 1_000, output_tokens: 100, total_tokens: 1_100,
    input_tokens_details: { cached_tokens: 600, cache_write_tokens: 300, cache_write_tokens_details: { ttl_30m_tokens: 300, ttl_12h_tokens: 0 } },
  } });
}
test('warm normalization preserves ordinary/output tokens, original evidence and unknown cache-write evidence', () => {
  const original = observation(), warmed = identicalRequestWarmObservation(original);
  assert.equal(warmed.usage?.input_tokens_details.cached_tokens, 900);
  assert.equal(warmed.usage?.input_tokens_details.cache_write_tokens, 0);
  assert.equal(warmed.usage?.input_tokens, original.usage?.input_tokens);
  assert.equal(warmed.usage?.output_tokens, original.usage?.output_tokens);
  assert.equal(estimateProviderCost(warmed).tokens?.ordinaryInput, 100);
  assert.equal(original.usage?.input_tokens_details.cache_write_tokens, 300);
  delete original.usage!.input_tokens_details.cache_write_tokens;
  delete original.usage!.input_tokens_details.cache_write_tokens_details;
  assert.equal(estimateProviderCost(identicalRequestWarmObservation(original)).usd, null);
});
test('latency summaries report the median separately from the mean and preserve missing metrics', () => {
  assert.deepEqual(numericSummary([1, 2, 99]), { count: 3, minimum: 1, maximum: 99, mean: 34, median: 2, sum: 102 });
  assert.equal(numericSummary([1, 2, 10, 11]).median, 6);
  assert.equal(numericSummary([]).mean, null);
});
test('common evaluation removes evaluation-order cost bias while observed audio/cache scope stays separate', () => {
  const input: RuntimePolicyBenchmark = { provenance: { sttCalls: 0 }, cases: (['full', 'compiled'] as const).map(mode => ({
    mode, index: 0, answerSha256: 'same-answer', questionContractSha256: 'same-contract',
    providerUsage: [{ stage: 'core', observation: observation() }], timings: { coreMs: 100, premiseReviewMs: 0, realtimeTurnMs: 100 },
    audio: { elapsedMs: 20, requestCharacters: 100, timing: { cache: mode === 'full' ? 'disk' : 'provider' } },
  })), evaluation: (['full', 'compiled'] as const).map(mode => ({ mode, completed: true, questionCount: 1, elapsedMs: 200,
    providerUsage: [mode === 'full' ? observation() : identicalRequestWarmObservation(observation())],
  })) };
  const report = summarizeRuntimePolicyCost(input);
  assert.notEqual(report.arms[0].observedPublishedRateCost.evaluation!.totalUsd, report.arms[1].observedPublishedRateCost.evaluation!.totalUsd);
  assert.equal(report.arms[0].identicalRequestWarmScenario.combinedWithCommonEvaluatorUsd, report.arms[1].identicalRequestWarmScenario.combinedWithCommonEvaluatorUsd);
  assert.equal(report.arms[0].audio.newSynthesisRequestCharacters, 0);
  assert.equal(report.arms[1].audio.newSynthesisRequestCharacters, 100);
  assert.equal(report.measuredScope.sttRerunCost.proratedKrw, 0);
  assert.equal(report.measuredScope.completeTimedHumanInterview, false);
  input.cases[1].answerSha256 = 'different-answer';
  assert.throws(() => summarizeRuntimePolicyCost(input), /UNMATCHED_CASE/u);
});
