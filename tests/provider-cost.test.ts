import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProviderUsage, estimateProviderCost, aggregateProviderCosts } from '../server/observability/provider-cost';

function observed(input = 12000, cached = 4000, written: number | undefined = 7000, split: unknown = { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 }, output = 100) {
  return normalizeProviderUsage({ model: 'gpt-6-luna', service_tier: 'default', _request_id: 'req_test', id: 'resp_test', output_text: 'must not be retained', usage: { input_tokens: input, output_tokens: output, total_tokens: input + output, input_tokens_details: { cached_tokens: cached, ...(written === undefined ? {} : { cache_write_tokens: written }), ...(split ? { cache_write_tokens_details: split } : {}) }, output_tokens_details: { reasoning_tokens: Math.min(10, output) } } });
}

test('separate read and both write lifetimes are priced once and reasoning is not billed twice', () => {
  const o = observed(), result = estimateProviderCost(o);
  assert.equal(result.usd, 0.001565);
  assert.deepEqual(result.tokens, { ordinaryInput: 1000, cachedRead: 4000, cacheWrite30m: 3000, cacheWrite12h: 4000, output: 100 });
  assert.equal(result.invoiceVerified, false);
  assert.doesNotMatch(JSON.stringify(o), /must not be retained|output_text/u);
});
test('272K boundary and long-request input/output multipliers apply to the entire request', () => {
  const short = estimateProviderCost(observed(272000, 0, 0, null, 100));
  const long = estimateProviderCost(observed(272001, 0, 0, null, 100));
  assert.equal(short.inputClass, 'short'); assert.equal(long.inputClass, 'long');
  assert.equal(short.usd, 0.02725); assert.equal(long.usd, 0.0544752);
});
test('missing cache writes and missing write lifetime remain unknown rather than silently becoming zero', () => {
  const missing = observed(12000, 4000, 7000, null); delete missing.usage!.input_tokens_details.cache_write_tokens;
  const unknownWrites = estimateProviderCost(missing);
  assert.equal(unknownWrites.usd, null); assert.equal(unknownWrites.reason, 'cache_write_usage_not_recorded');
  const unknownLifetime = estimateProviderCost(observed(12000, 4000, 7000, null));
  assert.equal(unknownLifetime.usd, null); assert.equal(unknownLifetime.reason, 'cache_write_lifetime_not_recorded');
  assert.ok(unknownLifetime.upperBoundUsd! > unknownLifetime.lowerBoundUsd!);
});
test('an observed default cache lifetime prices writes and unsupported models/tiers stay unpriced', () => {
  const o = observed(12000, 4000, 7000, null); o.observedCacheTtl = '30m';
  assert.equal(estimateProviderCost(o).usd, 0.001065);
  assert.equal(estimateProviderCost({ ...o, responseModel: 'other-model' }).usd, null);
  assert.equal(estimateProviderCost({ ...o, serviceTier: 'scale' }).usd, null);
});
test('malformed overlapping token buckets cannot produce a plausible cost and unknown calls prevent an exact aggregate', () => {
  const bad = observed(12000, 9000, 7000, null); assert.equal(bad.validity, 'invalid_usage');
  const good = estimateProviderCost(observed()), missing = estimateProviderCost(normalizeProviderUsage({ model: 'gpt-6-luna', service_tier: 'default' }));
  const total = aggregateProviderCosts([good, missing]);
  assert.equal(total.totalUsd, null); assert.equal(total.observedPricedSubtotalUsd, good.usd); assert.equal(total.unknownCalls, 1);
});
test('post-interview Terra calls use their own price card, including its five-percent cached-read rate', () => {
  const o = observed(1000, 500, 250, { ttl_30m_tokens: 250, ttl_12h_tokens: 0 }, 1000);
  o.responseModel = 'gpt-6.1-terra';
  const estimate = estimateProviderCost(o);
  assert.equal(estimate.usd, 0.0055875);
  assert.equal(estimate.pricingSnapshot, 'openai-gpt-6.1-terra-standard-2026-11-03');
  assert.equal(estimate.componentsUsd?.cachedRead, 0.000025);
});
