import { aggregateProviderCosts, estimateProviderCost, normalizeProviderUsage, type ProviderCostEstimate, type ProviderUsageObservation } from './provider-cost';

export const PROVIDER_SESSION_LEDGER_VERSION = 'session-provider-cost-ledger-v1';
export type ProviderSessionStage = 'core' | 'review' | 'repair' | 'evaluation';
export interface ProviderSessionUsageEntry {
  identity: string;
  stage: ProviderSessionStage;
  attemptId: string;
  observation: ProviderUsageObservation;
  cost: ProviderCostEstimate;
}
export interface ProviderSessionLedgerIssue {
  kind: 'provider_identity_reused_across_stages';
  providerIdentity: string;
  stages: ProviderSessionStage[];
}
export interface ProviderSessionLedger {
  version: typeof PROVIDER_SESSION_LEDGER_VERSION;
  entries: ProviderSessionUsageEntry[];
  summary: ReturnType<typeof aggregateProviderCosts> & {
    invoiceVerified: false;
    issues: ProviderSessionLedgerIssue[];
  };
}
export interface SessionProviderUsageInput {
  stage: ProviderSessionStage;
  attemptId: string;
  observation: ProviderUsageObservation;
}

/** Keep only server billing metadata, not arbitrary response/client properties. */
function observationCopy(value: ProviderUsageObservation): ProviderUsageObservation {
  const result = normalizeProviderUsage({ model: value.responseModel, service_tier: value.serviceTier, _request_id: value.requestId, id: value.responseId,
    prompt_cache_options: { ttl: value.observedCacheTtl }, usage: value.usage },
  { requestedModel: value.requestedModel, requestedServiceTier: value.requestedServiceTier, requestedCacheTtl: value.requestedCacheTtl });
  if (value.validity === 'invalid_usage' && !result.usage) result.validity = 'invalid_usage';
  return result;
}
function providerIdentity(observation: ProviderUsageObservation) {
  return observation.responseId ? 'response:' + observation.responseId : observation.requestId ? 'request:' + observation.requestId : null;
}
function entryIdentity(input: SessionProviderUsageInput, observation: ProviderUsageObservation) {
  // A failed request with no usage is not a zero-cost successful response. Keep
  // every distinct attempt, even when a gateway repeats a request ID.
  const provider = observation.validity === 'complete' ? providerIdentity(observation) : null;
  return JSON.stringify([input.stage, provider ?? 'attempt:' + input.attemptId]);
}

/** Server-owned append-only cost evidence. Retrying an already observed response
 * does not bill it twice. Missing/invalid usage remains an unknown cost. */
export function recordSessionProviderUsage(existing: ProviderSessionLedger | undefined, input: SessionProviderUsageInput): ProviderSessionLedger {
  if (!['core', 'review', 'repair', 'evaluation'].includes(input.stage) || !input.attemptId.trim() || input.attemptId.length > 200) throw new Error('INVALID_PROVIDER_USAGE_ATTEMPT');
  if (existing && existing.version !== PROVIDER_SESSION_LEDGER_VERSION) throw new Error('UNSUPPORTED_PROVIDER_LEDGER_VERSION');
  const entries = structuredClone(existing?.entries ?? []);
  const observation = observationCopy(input.observation);
  const identity = entryIdentity(input, observation);
  if (!entries.some(entry => entry.identity === identity)) entries.push({ identity, stage: input.stage, attemptId: input.attemptId, observation, cost: estimateProviderCost(observation) });
  const seen = new Map<string, ProviderSessionStage>();
  const collisions = new Map<string, Set<ProviderSessionStage>>();
  const estimates = entries.map(entry => {
    const provider = entry.observation.validity === 'complete' ? providerIdentity(entry.observation) : null;
    if (!provider) return entry.cost;
    const stage = seen.get(provider);
    if (!stage) { seen.set(provider, entry.stage); return entry.cost; }
    // A response cannot independently belong to two stages. Preserve both
    // observations for diagnosis, count the known response once, and keep the
    // combined total unknown until the conflicting attribution is reconciled.
    const stages = collisions.get(provider) ?? new Set<ProviderSessionStage>([stage]);
    stages.add(entry.stage); collisions.set(provider, stages);
    return { ...entry.cost, usd: null, reason: 'provider_identity_reused_across_stages' };
  });
  const issues = [...collisions].map(([provider, stages]) => ({ kind: 'provider_identity_reused_across_stages' as const, providerIdentity: provider, stages: [...stages] }));
  return { version: PROVIDER_SESSION_LEDGER_VERSION, entries, summary: { ...aggregateProviderCosts(estimates), invoiceVerified: false, issues } };
}
