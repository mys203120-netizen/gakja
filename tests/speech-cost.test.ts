import test from 'node:test';
import assert from 'node:assert/strict';
import { speechCost, voiceMonthlyCost, voiceMonthlyCostByApplication, allocateVoiceMonthlyCost, speechCostScenario, SPEECH_USER_PROVIDED_PRICE_SNAPSHOT, VOICE_USER_PROVIDED_PRICE_SNAPSHOT } from '../server/observability/speech-cost';

test('stream-level rounding remains distinct from proportional duration and silence is included in captured duration', () => {
  assert.equal(speechCost([360_000]).proratedKrw, 120);
  assert.equal(speechCost([360_000]).perStream15SecondRoundedKrw, 120);
  const split = speechCost([14_900, 100]);
  assert.equal(split.proratedKrw, 5);
  assert.equal(split.perStream15SecondRoundedKrw, 10);
  assert.equal(split.roundingVerified, false);
  assert.equal(split.invoiceVerified, false);
});
test('unknown speech observations never become free usage, while explicitly no new calls cost zero', () => {
  const partial = speechCost([15_000, null]);
  assert.equal(partial.capturedDurationMs, null);
  assert.equal(partial.knownCapturedDurationMs, 15_000);
  assert.equal(partial.proratedKrw, null);
  assert.equal(partial.perStream15SecondRoundedKrw, null);
  assert.equal(partial.knownProratedSubtotalKrw, 5);
  assert.equal(speechCost(null).proratedKrw, null);
  assert.equal(speechCost([]).proratedKrw, 0);
});
test('Voice base fee includes one million new characters and cache reads do not remove it', () => {
  assert.equal(voiceMonthlyCost(0).monthlyProratedKrw, 90_000);
  assert.equal(voiceMonthlyCost(1_000_000).monthlyProratedKrw, 90_000);
  assert.equal(voiceMonthlyCost(2_000_000).monthlyProratedKrw, 190_000);
  const boundary = voiceMonthlyCost(1_000_001);
  assert.equal(boundary.monthlyProratedKrw, 90_000.1);
  assert.equal(boundary.monthly1000CharacterRoundedKrw, 90_100);
  assert.equal(voiceMonthlyCost(null).monthlyProratedKrw, null);
});
test('application allowances do not pool and unknown application distribution cannot imply an exact fee', () => {
  const concentrated = voiceMonthlyCostByApplication([2_000_000, 0]);
  const balanced = voiceMonthlyCostByApplication([1_000_000, 1_000_000]);
  assert.equal(concentrated.monthlyProratedKrw, 280_000);
  assert.equal(balanced.monthlyProratedKrw, 180_000);
  const aggregate = voiceMonthlyCost(2_000_000, 2);
  assert.equal(aggregate.monthlyProratedKrw, null);
  assert.equal(aggregate.monthly1000CharacterRoundedKrw, null);
  assert.deepEqual(aggregate.proratedRangeKrw, { minimum: 180_000, maximum: 280_000 });
  const partial = voiceMonthlyCostByApplication([2_000_000, null]);
  assert.equal(partial.monthlyProratedKrw, null);
  assert.deepEqual(partial.proratedRangeKrw, { minimum: 280_000, maximum: null });
});
test('monthly allocations separate fixed and variable expense and reproduce the requested volume scenarios', () => {
  const scenarios = [1_000, 3_000, 10_000].map(sessions => speechCostScenario(sessions, 200, 360_000));
  assert.deepEqual(scenarios.map(value => value.voice.monthlyProratedKrw), [90_000, 90_000, 190_000]);
  assert.deepEqual(scenarios.map(value => value.allocation.fixedPerSessionKrw), [90, 30, 9]);
  assert.deepEqual(scenarios.map(value => value.allocation.proratedVariablePerSessionKrw), [0, 0, 10]);
  assert.deepEqual(scenarios.map(value => value.speechAndVoiceProratedPerSessionKrw), [210, 150, 139]);
  const missing = allocateVoiceMonthlyCost(voiceMonthlyCost(null), 1_000);
  assert.equal(missing.fixedPerSessionKrw, 90);
  assert.equal(missing.proratedTotalPerSessionKrw, null);
});
test('invalid counts and durations are rejected and both tariffs retain their user provenance', () => {
  assert.throws(() => speechCost([-1]), RangeError);
  assert.throws(() => speechCost([Number.NaN]), RangeError);
  assert.throws(() => voiceMonthlyCost(-1), RangeError);
  assert.throws(() => voiceMonthlyCost(100, 0), RangeError);
  assert.throws(() => voiceMonthlyCostByApplication([]), RangeError);
  assert.throws(() => allocateVoiceMonthlyCost(voiceMonthlyCost(0), 0), RangeError);
  assert.equal(SPEECH_USER_PROVIDED_PRICE_SNAPSHOT.source, 'user');
  assert.equal(VOICE_USER_PROVIDED_PRICE_SNAPSHOT.source, 'user');
  assert.equal(VOICE_USER_PROVIDED_PRICE_SNAPSHOT.asOf, '2026-11-03');
});
