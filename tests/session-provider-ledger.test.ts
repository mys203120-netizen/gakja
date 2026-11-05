import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProviderUsage } from '../server/observability/provider-cost';
import { recordSessionProviderUsage } from '../server/observability/session-provider-ledger';

const response = (id: string) => normalizeProviderUsage({ id, _request_id: 'request-' + id, model: 'gpt-6-luna', service_tier: 'default', usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100, input_tokens_details: { cached_tokens: 500, cache_write_tokens: 0 } } });

test('ledger appends server usage immutably and never represents its public-rate estimate as an invoice', () => {
  const observed = response('one'), first = recordSessionProviderUsage(undefined, { stage: 'core', attemptId: 'a1', observation: observed });
  const before = structuredClone(first), next = recordSessionProviderUsage(first, { stage: 'review', attemptId: 'a2', observation: response('two') });
  assert.deepEqual(first, before); assert.equal(first.entries.length, 1); assert.equal(next.entries.length, 2);
  assert.equal(next.summary.invoiceVerified, false); assert.equal(next.summary.pricedCalls, 2); assert.equal(next.summary.unknownCalls, 0); assert.ok(next.summary.totalUsd! > 0);
  observed.usage!.input_tokens = 9999;
  assert.equal(first.entries[0].observation.usage!.input_tokens, 1000);
});

test('duplicate response callbacks and request-only identities do not double-count the same successful call', () => {
  const first = recordSessionProviderUsage(undefined, { stage: 'core', attemptId: 'a1', observation: response('same') });
  const repeated = recordSessionProviderUsage(first, { stage: 'core', attemptId: 'later-callback', observation: response('same') });
  assert.equal(repeated.entries.length, 1); assert.equal(repeated.summary.totalUsd, first.summary.totalUsd);
  const requestOnly = response('request-only'); requestOnly.responseId = null;
  const withRequest = recordSessionProviderUsage(repeated, { stage: 'evaluation', attemptId: 'e1', observation: requestOnly });
  const repeatedRequest = recordSessionProviderUsage(withRequest, { stage: 'evaluation', attemptId: 'e2', observation: requestOnly });
  assert.equal(repeatedRequest.entries.length, 2); assert.equal(repeatedRequest.summary.totalUsd, withRequest.summary.totalUsd);
});

test('missing usage retains distinct unknown attempts rather than treating failures as free', () => {
  const missing = normalizeProviderUsage({ model: 'gpt-6-luna', _request_id: 'repeated-gateway-request' }, { requestedServiceTier: 'default' });
  const first = recordSessionProviderUsage(undefined, { stage: 'core', attemptId: 'failed-one', observation: missing });
  const second = recordSessionProviderUsage(first, { stage: 'core', attemptId: 'failed-two', observation: missing });
  const duplicate = recordSessionProviderUsage(second, { stage: 'core', attemptId: 'failed-two', observation: missing });
  assert.equal(duplicate.entries.length, 2); assert.equal(duplicate.summary.unknownCalls, 2); assert.equal(duplicate.summary.totalUsd, null);
  assert.equal(duplicate.entries[0].cost.reason, 'missing_usage');
});

test('a provider response attributed to two stages is preserved as an issue without a doubled priced subtotal', () => {
  const first = recordSessionProviderUsage(undefined, { stage: 'core', attemptId: 'a1', observation: response('collision') });
  const collision = recordSessionProviderUsage(first, { stage: 'review', attemptId: 'a2', observation: response('collision') });
  assert.equal(collision.entries.length, 2); assert.equal(collision.summary.totalUsd, null); assert.equal(collision.summary.unknownCalls, 1);
  assert.equal(collision.summary.observedPricedSubtotalUsd, first.summary.observedPricedSubtotalUsd);
  assert.deepEqual(collision.summary.issues[0].stages, ['core', 'review']);
});
