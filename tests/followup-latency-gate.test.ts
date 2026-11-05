import test from 'node:test';
import assert from 'node:assert/strict';
import { compareFollowupLatency, isPassingFollowupLatencyReceipt, verifyFollowupLatencyEvidence, type FollowupLatencyReport } from '../scripts/lib/followup-latency-gate';

function report(): FollowupLatencyReport {
  return { version: 'followup-latency-report-v1', providerMode: 'live', scope: 'synthetic unit fixture for gate logic; no real measurement',
    configuration: { model: 'synthetic', cache: 'warm', concurrency: 1, reviewTimeoutMs: 12000 }, completed: true, releaseKey: 'a'.repeat(64),
    samples: (['normal', 'repair'] as const).flatMap(path => Array.from({ length: 20 }, (_, index) => ({
      path, caseId: 'synthetic', repeat: index + 1, inputSha256: 'b'.repeat(64), wallMs: 100 + index,
      calls: { core: 1, review: path === 'normal' ? 1 : 2, repair: path === 'normal' ? 0 : 1 }, failure: null,
    }))) };
}
test('latency acceptance requires paired unchanged config and non-increasing normal and repaired p50/p95', () => {
  const before = report(), after = structuredClone(before);
  const receipt = compareFollowupLatency(before, after);
  assert.equal(receipt.status, 'pass'); assert.equal(isPassingFollowupLatencyReceipt(receipt, before.releaseKey), true);
  after.samples.find(sample => sample.path === 'repair')!.wallMs = 1000;
  after.samples.filter(sample => sample.path === 'repair')[1].wallMs = 1100;
  const slow = compareFollowupLatency(before, after);
  assert.equal(slow.status, 'fail'); assert.ok(slow.diagnostics.includes('LATENCY_P95_INCREASE:repair'));
});
test('latency cannot pass on mocks, insufficient evidence, changed input, duplicates or relaxed timeout', () => {
  const before = report();
  const mocked = structuredClone(before); mocked.providerMode = 'synthetic';
  assert.equal(compareFollowupLatency(before, mocked).status, 'incomplete');
  const partial = structuredClone(before); partial.completed = false;
  assert.equal(compareFollowupLatency(before, partial).status, 'incomplete');
  assert.equal(compareFollowupLatency({ ...before, samples: before.samples.slice(0, 2) }, { ...before, samples: before.samples.slice(0, 2) }).status, 'incomplete');
  const changed = structuredClone(before); changed.samples[0].inputSha256 = 'c'.repeat(64);
  assert.throws(() => compareFollowupLatency(before, changed), /PAIRED_INPUT_CHANGED/u);
  const duplicate = structuredClone(before); duplicate.samples.push(duplicate.samples[0]);
  assert.throws(() => compareFollowupLatency(before, duplicate), /DUPLICATE_SAMPLE/u);
  const timeout = structuredClone(before); timeout.configuration.reviewTimeoutMs = 24000;
  assert.throws(() => compareFollowupLatency(before, timeout), /CONFIGURATION_CHANGED/u);
  assert.throws(() => compareFollowupLatency(before, before, 3), /MINIMUM_PAIRS_INVALID/u);
});
test('latency acceptance includes failed attempts and forbids an extra model call hidden by faster samples', () => {
  const before = report(), after = structuredClone(before);
  after.samples[0].wallMs = 1; after.samples[0].calls.review++;
  assert.equal(compareFollowupLatency(before, after).status, 'fail');
  after.samples[0].calls.review--; after.samples[0].failure = 'PROVIDER_TIMEOUT';
  assert.equal(compareFollowupLatency(before, after).status, 'fail');
});
test('semantic release cannot trust a bare pass or altered latency summary', () => {
  const receipt = compareFollowupLatency(report(), report());
  assert.equal(isPassingFollowupLatencyReceipt({ status: 'pass' }), false);
  assert.equal(isPassingFollowupLatencyReceipt(receipt, 'c'.repeat(64)), false);
  const altered = structuredClone(receipt); altered.paths[0].after.p95Ms = 5000;
  assert.equal(isPassingFollowupLatencyReceipt(altered), false);
  altered.paths[0].after.p95Ms = NaN;
  assert.equal(isPassingFollowupLatencyReceipt(altered), false);
});
test('latency release recomputes metrics from raw reports instead of trusting copied passing metrics', () => {
  const before = report(), after = structuredClone(before);
  for (const sample of after.samples) sample.wallMs += 1000;
  const forged = compareFollowupLatency(before, after);
  forged.status = 'pass'; forged.diagnostics = [];
  for (const row of forged.paths) row.after = { ...row.before };
  assert.equal(isPassingFollowupLatencyReceipt(forged), true, 'A shaped summary is not source evidence.');
  assert.equal(verifyFollowupLatencyEvidence(forged, before, after, before.releaseKey), false);
  const good = compareFollowupLatency(before, before);
  assert.equal(verifyFollowupLatencyEvidence(good, before, before, before.releaseKey), true);
});
test('all-failed runs cannot approve latency and recovered calls are not mistaken for extra stages', () => {
  const before = report(), after = structuredClone(before);
  for (const sample of before.samples) sample.failure = 'PROVIDER_UNAVAILABLE';
  for (const sample of after.samples) sample.failure = 'PROVIDER_UNAVAILABLE';
  assert.equal(compareFollowupLatency(before, after).status, 'incomplete');
  const old = report(), next = structuredClone(old);
  old.samples[0].failure = 'PROVIDER_TIMEOUT'; old.samples[0].calls.review = 0;
  assert.equal(compareFollowupLatency(old, next).status, 'pass');
});
