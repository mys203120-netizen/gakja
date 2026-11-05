/** Official public rate snapshot, not an account invoice or a provider quote. */
export const LUNA_PUBLIC_PRICE_SNAPSHOT = Object.freeze({
  id: 'openai-gpt-6-luna-standard-2026-11-03',
  asOf: '2026-11-03',
  currency: 'USD' as const,
  model: 'gpt-6-luna',
  inputPerMillion: 0.10,
  cachedInputPerMillion: 0.01,
  cacheWrite30mPerMillion: 0.125,
  cacheWrite12hPerMillion: 0.25,
  outputPerMillion: 0.50,
  longContextThreshold: 272000,
  longContextInputMultiplier: 2,
  longContextOutputMultiplier: 1.5,
  sources: [
    'https://developers.openai.com/api/docs/models/gpt-6-luna',
    'https://developers.openai.com/api/docs/guides/prompt-caching',
  ],
});
export const TERRA_PUBLIC_PRICE_SNAPSHOT = Object.freeze({
  ...LUNA_PUBLIC_PRICE_SNAPSHOT,
  id: 'openai-gpt-6.1-terra-standard-2026-11-03',
  model: 'gpt-6.1-terra',
  inputPerMillion: 1.00,
  cachedInputPerMillion: 0.05,
  cacheWrite30mPerMillion: 1.25,
  cacheWrite12hPerMillion: 2.50,
  outputPerMillion: 5.00,
  sources: ['https://developers.openai.com/api/docs/models/gpt-6.1-terra', 'https://developers.openai.com/api/docs/guides/prompt-caching'],
});

export interface ObservedResponseUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details: {
    cached_tokens: number;
    cache_write_tokens?: number;
    cache_write_tokens_details?: { ttl_30m_tokens: number; ttl_12h_tokens: number };
  };
  output_tokens_details?: { reasoning_tokens?: number };
}
export interface ProviderUsageObservation {
  responseModel: string | null;
  serviceTier: string | null;
  requestId: string | null;
  responseId: string | null;
  observedCacheTtl: '30m' | '12h' | null;
  usage: ObservedResponseUsage | null;
  validity: 'complete' | 'missing_usage' | 'invalid_usage';
  requestedModel?: string;
  requestedServiceTier?: string;
  requestedCacheTtl?: '30m' | '12h';
  requestedReasoningEffort?: string;
  requestedMaxOutputTokens?: number;
}
type RequestMetadata = Pick<ProviderUsageObservation, 'requestedModel' | 'requestedServiceTier' | 'requestedCacheTtl' | 'requestedReasoningEffort' | 'requestedMaxOutputTokens'>;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const label = (value: unknown) => typeof value === 'string' && value.length <= 200 ? value : null;

/** Copies billing counters only. Never stores response text, prompts, headers or credentials. */
export function normalizeProviderUsage(response: unknown, request: RequestMetadata = {}): ProviderUsageObservation {
  const raw = object(response), cache = object(raw.prompt_cache_options);
  const observation: ProviderUsageObservation = {
    responseModel: label(raw.model), serviceTier: label(raw.service_tier), requestId: label(raw._request_id), responseId: label(raw.id),
    observedCacheTtl: cache.ttl === '30m' || cache.ttl === '12h' ? cache.ttl : null,
    ...request, usage: null, validity: raw.usage == null ? 'missing_usage' : 'invalid_usage',
  };
  if (raw.usage == null) return observation;
  const u = object(raw.usage), details = object(u.input_tokens_details), writes = object(details.cache_write_tokens_details), output = object(u.output_tokens_details);
  if (!count(u.input_tokens) || !count(u.output_tokens) || !count(u.total_tokens) || !count(details.cached_tokens)) return observation;
  if (u.total_tokens !== u.input_tokens + u.output_tokens || details.cached_tokens > u.input_tokens) return observation;
  const usage: ObservedResponseUsage = { input_tokens: u.input_tokens, output_tokens: u.output_tokens, total_tokens: u.total_tokens, input_tokens_details: { cached_tokens: details.cached_tokens } };
  if (details.cache_write_tokens !== undefined) {
    if (!count(details.cache_write_tokens) || details.cache_write_tokens + details.cached_tokens > u.input_tokens) return observation;
    usage.input_tokens_details.cache_write_tokens = details.cache_write_tokens;
  }
  if (details.cache_write_tokens_details !== undefined) {
    if (!count(writes.ttl_30m_tokens) || !count(writes.ttl_12h_tokens) || writes.ttl_30m_tokens + writes.ttl_12h_tokens !== details.cache_write_tokens) return observation;
    usage.input_tokens_details.cache_write_tokens_details = { ttl_30m_tokens: writes.ttl_30m_tokens, ttl_12h_tokens: writes.ttl_12h_tokens };
  }
  if (output.reasoning_tokens !== undefined) {
    if (!count(output.reasoning_tokens) || output.reasoning_tokens > u.output_tokens) return observation;
    usage.output_tokens_details = { reasoning_tokens: output.reasoning_tokens };
  }
  return { ...observation, usage, validity: 'complete' };
}

export interface ProviderCostEstimate {
  basis: 'published-rates-observed-usage';
  invoiceVerified: false;
  currency: 'USD';
  pricingSnapshot: string | null;
  usd: number | null;
  reason: string | null;
  lowerBoundUsd?: number;
  upperBoundUsd?: number;
  inputClass?: 'short' | 'long';
  processing?: string;
  configuredTierUsed?: boolean;
  tokens?: { ordinaryInput: number; cachedRead: number; cacheWrite30m: number; cacheWrite12h: number; output: number };
  componentsUsd?: { ordinaryInput: number; cachedRead: number; cacheWrite30m: number; cacheWrite12h: number; output: number };
  assumptions: string[];
}
const money = (n: number) => Number(n.toFixed(12));

export function estimateProviderCost(observation: ProviderUsageObservation): ProviderCostEstimate {
  const result: ProviderCostEstimate = { basis: 'published-rates-observed-usage', invoiceVerified: false, currency: 'USD', pricingSnapshot: null, usd: null, reason: null,
    assumptions: ['Public direct-OpenAI pricing; account discounts, credits, taxes, foreign exchange, regional premiums, gateway markups and invoice adjustments are not reconciled.', 'No hosted-tool costs included. Reasoning tokens are already part of output_tokens.'] };
  const model = observation.responseModel ?? observation.requestedModel;
  const price = /^gpt-6-luna(?:-\d{4}-\d{2}-\d{2})?$/u.test(model ?? '') ? LUNA_PUBLIC_PRICE_SNAPSHOT : /^gpt-6\.1-terra(?:-\d{4}-\d{2}-\d{2})?$/u.test(model ?? '') ? TERRA_PUBLIC_PRICE_SNAPSHOT : null;
  if (!price) return { ...result, reason: 'unsupported_or_missing_model' };
  result.pricingSnapshot = price.id;
  if (model !== price.model) result.assumptions.push(`Dated response model is priced at its configured ${price.model} family public rate.`);
  if (observation.validity !== 'complete' || !observation.usage) return { ...result, reason: observation.validity };
  const usage = observation.usage, processing = observation.serviceTier ?? observation.requestedServiceTier;
  const tierMultiplier = processing === 'default' || processing === 'standard' ? 1 : processing === 'flex' || processing === 'batch' ? 0.5 : processing === 'priority' || processing === 'fast' ? 2 : null;
  if (tierMultiplier === null) return { ...result, reason: 'unsupported_or_missing_processing_tier' };
  result.processing = processing; result.configuredTierUsed = observation.serviceTier == null;
  const long = usage.input_tokens > price.longContextThreshold;
  result.inputClass = long ? 'long' : 'short';
  const inputScale = tierMultiplier * (long ? price.longContextInputMultiplier : 1) / 1_000_000;
  const outputScale = tierMultiplier * (long ? price.longContextOutputMultiplier : 1) / 1_000_000;
  const { cached_tokens: reads, cache_write_tokens: writes, cache_write_tokens_details: split } = usage.input_tokens_details;
  const outputCost = usage.output_tokens * price.outputPerMillion * outputScale;
  const readCost = reads * price.cachedInputPerMillion * inputScale;
  if (writes === undefined) {
    const unknown = usage.input_tokens - reads;
    return { ...result, reason: 'cache_write_usage_not_recorded', lowerBoundUsd: money(readCost + outputCost + unknown * price.inputPerMillion * inputScale), upperBoundUsd: money(readCost + outputCost + unknown * price.cacheWrite12hPerMillion * inputScale) };
  }
  const ordinary = usage.input_tokens - reads - writes;
  let thirty = split?.ttl_30m_tokens, twelve = split?.ttl_12h_tokens;
  const ttl = observation.observedCacheTtl ?? observation.requestedCacheTtl;
  if (!split) {
    if (writes === 0) { thirty = 0; twelve = 0; }
    else if (ttl === '30m') { thirty = writes; twelve = 0; result.assumptions.push('All writes use the observed/requested 30-minute lifetime; no per-breakpoint lifetime overrides are recorded.'); }
    else if (ttl === '12h') { thirty = 0; twelve = writes; result.assumptions.push('All writes use the observed/requested 12-hour lifetime; no per-breakpoint lifetime overrides are recorded.'); }
    else {
      const fixed = ordinary * price.inputPerMillion * inputScale + readCost + outputCost;
      return { ...result, reason: 'cache_write_lifetime_not_recorded', lowerBoundUsd: money(fixed + writes * price.cacheWrite30mPerMillion * inputScale), upperBoundUsd: money(fixed + writes * price.cacheWrite12hPerMillion * inputScale) };
    }
  }
  result.tokens = { ordinaryInput: ordinary, cachedRead: reads, cacheWrite30m: thirty!, cacheWrite12h: twelve!, output: usage.output_tokens };
  const components = { ordinaryInput: ordinary * price.inputPerMillion * inputScale, cachedRead: readCost, cacheWrite30m: thirty! * price.cacheWrite30mPerMillion * inputScale, cacheWrite12h: twelve! * price.cacheWrite12hPerMillion * inputScale, output: outputCost };
  result.componentsUsd = Object.fromEntries(Object.entries(components).map(([k,v]) => [k,money(v)])) as typeof components;
  result.usd = money(Object.values(components).reduce((sum,n)=>sum+n,0));
  return result;
}

export function aggregateProviderCosts(estimates: ProviderCostEstimate[]) {
  const priced = estimates.filter((value): value is ProviderCostEstimate & { usd: number } => value.usd !== null);
  const subtotal = money(priced.reduce((sum,value)=>sum+value.usd,0));
  return { basis: 'published-rates-observed-usage', invoiceVerified: false, currency: 'USD', observedCalls: estimates.length, pricedCalls: priced.length, unknownCalls: estimates.length-priced.length, observedPricedSubtotalUsd: subtotal, totalUsd: priced.length===estimates.length ? subtotal : null,
    excludedCosts: ['CLOVA Speech STT', 'CLOVA Voice TTS', 'offline analysis and bank preparation amortization', 'post-interview evaluation unless separately supplied', 'storage/network/hosting', 'gateway markup, tax and currency conversion'] };
}
