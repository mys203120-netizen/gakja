import { createHash } from 'node:crypto';

export type FollowupLatencyPath = 'normal' | 'repair';
export interface FollowupLatencySample {
  caseId: string;
  repeat: number;
  path: FollowupLatencyPath;
  inputSha256: string;
  wallMs: number;
  calls: { core: number; review: number; repair: number };
  failure: string | null;
}
export interface FollowupLatencyReport {
  version: 'followup-latency-report-v1';
  providerMode: 'live' | 'synthetic';
  /** State exactly which clock was measured; e.g. post-decision runtime, not microphone E2E. */
  scope: string;
  configuration: Record<string, unknown>;
  completed: boolean;
  releaseKey?: string;
  samples: FollowupLatencySample[];
}
export interface FollowupLatencyReceipt {
  version: 'followup-latency-receipt-v1';
  status: 'pass' | 'fail' | 'incomplete';
  scope: string;
  releaseKey?: string;
  beforeSha256: string;
  afterSha256: string;
  configurationSha256: string;
  minimumPairsPerPath: number;
  evidence?: {
    before: { path: string; sha256: string };
    after: { path: string; sha256: string };
  };
  diagnostics: string[];
  paths: Array<{
    path: FollowupLatencyPath; pairs: number; successfulPairs: number;
    before: { p50Ms: number | null; p95Ms: number | null; failures: number };
    after: { p50Ms: number | null; p95Ms: number | null; failures: number };
  }>;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('LATENCY_NON_JSON_VALUE');
  return encoded;
}
export const latencyHash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const key = (sample: FollowupLatencySample) => `${sample.path}:${sample.caseId}:${sample.repeat}`;
function samples(report: FollowupLatencyReport): Map<string, FollowupLatencySample> {
  if (report.version !== 'followup-latency-report-v1' || !['live', 'synthetic'].includes(report.providerMode) ||
      typeof report.scope !== 'string' || !report.scope.trim() || !report.configuration || typeof report.configuration !== 'object' || Array.isArray(report.configuration) ||
      typeof report.completed !== 'boolean' || !Array.isArray(report.samples)) throw new Error('LATENCY_REPORT_INVALID');
  const result = new Map<string, FollowupLatencySample>();
  for (const sample of report.samples) {
    if (!sample || !['normal', 'repair'].includes(sample.path) || typeof sample.caseId !== 'string' || !sample.caseId ||
        !Number.isSafeInteger(sample.repeat) || sample.repeat < 1 || !isHash(sample.inputSha256) ||
        !Number.isFinite(sample.wallMs) || sample.wallMs < 0 || !sample.calls ||
        !['core', 'review', 'repair'].every(stage => Number.isSafeInteger(sample.calls[stage as keyof typeof sample.calls]) && sample.calls[stage as keyof typeof sample.calls] >= 0) ||
        !(sample.failure === null || typeof sample.failure === 'string' && sample.failure.length > 0)) throw new Error('LATENCY_SAMPLE_INVALID');
    if (result.has(key(sample))) throw new Error('LATENCY_DUPLICATE_SAMPLE');
    result.set(key(sample), sample);
  }
  return result;
}
function distribution(rows: FollowupLatencySample[]) {
  const sorted = rows.map(row => row.wallMs).sort((a, b) => a - b);
  return {
    p50Ms: sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null,
    p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1] : null,
    failures: rows.filter(row => row.failure !== null).length,
  };
}

/** Compare all paired attempts, including failures. Never discard slow failures or relax a timeout. */
export function compareFollowupLatency(before: FollowupLatencyReport, after: FollowupLatencyReport, minimumPairsPerPath = 20): FollowupLatencyReceipt {
  if (!Number.isSafeInteger(minimumPairsPerPath) || minimumPairsPerPath < 20) throw new Error('LATENCY_MINIMUM_PAIRS_INVALID');
  const oldRows = samples(before), newRows = samples(after);
  if (before.scope !== after.scope) throw new Error('LATENCY_SCOPE_CHANGED');
  if (latencyHash(before.configuration) !== latencyHash(after.configuration)) throw new Error('LATENCY_CONFIGURATION_CHANGED');
  if (oldRows.size !== newRows.size) throw new Error('LATENCY_CASE_SET_CHANGED');
  const diagnostics: string[] = [];
  let incomplete = !before.completed || !after.completed || before.providerMode !== 'live' || after.providerMode !== 'live';
  if (incomplete) diagnostics.push('LATENCY_LIVE_COMPLETED_EVIDENCE_REQUIRED');
  for (const [id, old] of oldRows) {
    const next = newRows.get(id);
    if (!next || old.inputSha256 !== next.inputSha256) throw new Error('LATENCY_PAIRED_INPUT_CHANGED');
    const maximum = next.path === 'normal' ? { core: 1, review: 1, repair: 0 } : { core: 1, review: 2, repair: 1 };
    if (Object.keys(maximum).some(stage => next.calls[stage as keyof typeof next.calls] > maximum[stage as keyof typeof maximum]) ||
        old.failure === null && Object.keys(old.calls).some(stage => next.calls[stage as keyof typeof next.calls] > old.calls[stage as keyof typeof old.calls])) diagnostics.push(`LATENCY_CALL_COUNT_INCREASE:${id}`);
  }
  const paths = (['normal', 'repair'] as const).map(path => {
    const old = [...oldRows.values()].filter(row => row.path === path), next = [...newRows.values()].filter(row => row.path === path);
    const a = distribution(old), b = distribution(next);
    if (old.length < minimumPairsPerPath) { incomplete = true; diagnostics.push(`LATENCY_INSUFFICIENT_PAIRS:${path}`); }
    const successfulPairs = old.filter(row => row.failure === null && newRows.get(key(row))?.failure === null).length;
    if (!successfulPairs) { incomplete = true; diagnostics.push(`LATENCY_NO_SUCCESSFUL_PAIR:${path}`); }
    if (a.p50Ms !== null && b.p50Ms !== null && b.p50Ms > a.p50Ms) diagnostics.push(`LATENCY_P50_INCREASE:${path}`);
    if (a.p95Ms !== null && b.p95Ms !== null && b.p95Ms > a.p95Ms) diagnostics.push(`LATENCY_P95_INCREASE:${path}`);
    if (b.failures > a.failures) diagnostics.push(`LATENCY_FAILURE_COUNT_INCREASE:${path}`);
    for (const caseId of new Set(old.map(row => row.caseId))) {
      if (next.filter(row => row.caseId === caseId && row.failure !== null).length > old.filter(row => row.caseId === caseId && row.failure !== null).length) diagnostics.push(`LATENCY_CASE_FAILURE_COUNT_INCREASE:${path}:${caseId}`);
    }
    return { path, pairs: old.length, successfulPairs, before: a, after: b };
  });
  const failed = diagnostics.some(item => !item.startsWith('LATENCY_LIVE_COMPLETED_EVIDENCE_REQUIRED') && !item.startsWith('LATENCY_INSUFFICIENT_PAIRS') && !item.startsWith('LATENCY_NO_SUCCESSFUL_PAIR'));
  return {
    version: 'followup-latency-receipt-v1', status: failed ? 'fail' : incomplete ? 'incomplete' : 'pass', scope: after.scope,
    ...(after.releaseKey ? { releaseKey: after.releaseKey } : {}), beforeSha256: latencyHash(before), afterSha256: latencyHash(after),
    configurationSha256: latencyHash(after.configuration), minimumPairsPerPath, diagnostics, paths,
  };
}

/** Summary shape only. A release verifier must also reload raw reports and recompute with verifyFollowupLatencyEvidence. */
export function isPassingFollowupLatencyReceipt(value: unknown, releaseKey?: string): value is FollowupLatencyReceipt {
  if (!value || typeof value !== 'object') return false;
  const row = value as FollowupLatencyReceipt;
  if (row.version !== 'followup-latency-receipt-v1' || row.status !== 'pass' || !row.scope ||
      !isHash(row.beforeSha256) || !isHash(row.afterSha256) || !isHash(row.configurationSha256) ||
      !Number.isSafeInteger(row.minimumPairsPerPath) || row.minimumPairsPerPath < 20 ||
      !Array.isArray(row.diagnostics) || row.diagnostics.length || !Array.isArray(row.paths) || row.paths.length !== 2 ||
      releaseKey !== undefined && row.releaseKey !== releaseKey) return false;
  return (['normal', 'repair'] as const).every(path => {
    const matches = row.paths.filter(item => item.path === path);
    if (matches.length !== 1) return false;
    const item = matches[0];
    return Number.isSafeInteger(item.pairs) && item.pairs >= row.minimumPairsPerPath &&
      Number.isSafeInteger(item.successfulPairs) && item.successfulPairs > 0 && item.successfulPairs <= item.pairs && [item.before, item.after].every(stats =>
      stats && Number.isFinite(stats.p50Ms) && stats.p50Ms! >= 0 && Number.isFinite(stats.p95Ms) && stats.p95Ms! >= stats.p50Ms! &&
      Number.isSafeInteger(stats.failures) && stats.failures >= 0 && stats.failures <= item.pairs) &&
      item.after.p50Ms! <= item.before.p50Ms! && item.after.p95Ms! <= item.before.p95Ms! && item.after.failures <= item.before.failures;
  });
}

/** Recompute every percentile, count and binding from the pinned raw observations, never trust an edited summary. */
export function verifyFollowupLatencyEvidence(value: unknown, before: unknown, after: unknown, releaseKey?: string): value is FollowupLatencyReceipt {
  if (!isPassingFollowupLatencyReceipt(value, releaseKey)) return false;
  try {
    const recomputed = compareFollowupLatency(before as FollowupLatencyReport, after as FollowupLatencyReport, value.minimumPairsPerPath);
    const { evidence: _evidence, ...summary } = value;
    void _evidence;
    return recomputed.status === 'pass' && stable(summary) === stable(recomputed);
  } catch { return false; }
}
