import test from 'node:test';
import assert from 'node:assert/strict';
import { MorphMotionTracker, morphRoleForPhase } from '../lib/interview/morph-motion';

test('only the active audio phase reacts and stopped sessions reset to a neutral pulse', () => {
  assert.equal(morphRoleForPhase('speaking_question'), 'interviewer');
  assert.equal(morphRoleForPhase('speaking_acknowledgement'), 'interviewer');
  assert.equal(morphRoleForPhase('listening'), 'candidate');
  for (const phase of ['idle', 'completed', 'error', 'suspended']) assert.equal(morphRoleForPhase(phase), 'ready');
  const tracker = new MorphMotionTracker();
  assert.equal(tracker.step('ready', .4, 0).pulseScale, 1);
  assert.equal(tracker.step('processing', .4, 16).motion, 'processing');
  assert.equal(tracker.step('interviewer', .1, 32).motion, 'interviewer');
  const stopped = tracker.step('ready', .1, 48);
  assert.equal(stopped.motion, 'silence');
  assert.equal(stopped.energy, 0);
  assert.equal(stopped.pulseScale, 1);
});

test('interviewer and candidate share exactly the same pulse and rotation for the same voice', () => {
  const candidate = new MorphMotionTracker(), interviewer = new MorphMotionTracker();
  for (let now = 0; now <= 3200; now += 16) {
    const rms = now < 400 || now > 2400 ? 0 : now < 1400 ? .035 : .08;
    const mine = candidate.step('candidate', rms, now);
    const theirs = interviewer.step('interviewer', rms, now);
    assert.equal(mine.energy, theirs.energy);
    assert.equal(mine.pulseScale, theirs.pulseScale);
    assert.equal(mine.playbackRate, 1);
    assert.equal(theirs.playbackRate, 1);
    assert.equal(mine.sway, 0);
    assert.equal(theirs.sway, 0);
  }
});

test('a steady observed voice contracts and expands within the bounded scale range', () => {
  const tracker = new MorphMotionTracker();
  const scales: number[] = [];
  for (let now = 0; now <= 3000; now += 16) {
    const movement = tracker.step('interviewer', .1, now);
    assert.ok(movement.pulseScale >= .9 && movement.pulseScale <= 1.07);
    if (now >= 1000) scales.push(movement.pulseScale);
  }
  assert.ok(Math.min(...scales) < .93, 'Voiced pulse should visibly contract.');
  assert.ok(Math.max(...scales) > 1.04, 'Voiced pulse should visibly expand.');
});

test('real voice level changes alter the pulse envelope without changing rotation speed', () => {
  const quiet = new MorphMotionTracker(), loud = new MorphMotionTracker();
  const quietScales: number[] = [], loudScales: number[] = [];
  for (let now = 0; now <= 2400; now += 16) {
    const low = quiet.step('interviewer', .015, now);
    const high = loud.step('interviewer', .08, now);
    assert.equal(low.playbackRate, high.playbackRate);
    if (now > 1000) { quietScales.push(low.pulseScale); loudScales.push(high.pulseScale); }
  }
  const range = (values: number[]) => Math.max(...values) - Math.min(...values);
  assert.ok(range(loudScales) > range(quietScales) * 3);
});

test('silence releases smoothly to exactly neutral scale and cannot grow the base size', () => {
  const tracker = new MorphMotionTracker();
  for (let now = 0; now <= 1200; now += 16) tracker.step('candidate', .08, now);
  let result = tracker.step('candidate', 0, 1216);
  const released = result.pulseScale;
  result = tracker.step('candidate', 0, 1232);
  assert.ok(Math.abs(result.pulseScale - released) < .03, 'Release should not snap between frames.');
  for (let now = 1248; now <= 5000; now += 16) result = tracker.step('candidate', 0, now);
  assert.equal(result.motion, 'silence');
  assert.equal(result.energy, 0);
  assert.equal(result.pulseScale, 1);
  assert.equal(result.playbackRate, 1);
});

test('VAD gates background noise and uses the same short release between syllables', () => {
  const tracker = new MorphMotionTracker();
  const quiet = tracker.step('candidate', .2, 0, false);
  assert.equal(quiet.motion, 'silence');
  assert.equal(quiet.pulseScale, 1);
  assert.equal(tracker.step('candidate', .05, 16, true).motion, 'candidate');
  assert.equal(tracker.step('candidate', .2, 160, false).motion, 'candidate');
  assert.equal(tracker.step('candidate', .2, 320, false).motion, 'silence');
  for (let now = 336; now < 3200; now += 16) tracker.step('candidate', .2, now, false);
  const settled = tracker.step('candidate', .2, 3200, false);
  assert.equal(settled.energy, 0);
  assert.equal(settled.pulseScale, 1);
});

test('a stale VAD speech flag cannot animate a zero-signal or disconnected input', () => {
  const tracker = new MorphMotionTracker();
  tracker.step('candidate', .05, 0, true);
  assert.equal(tracker.step('candidate', 0, 350, true).motion, 'silence');
  const silent = new MorphMotionTracker().step('candidate', 0, 0, true);
  assert.equal(silent.motion, 'silence');
  assert.equal(silent.pulseScale, 1);
});

test('role transitions cannot carry the previous speaker envelope into a silent microphone', () => {
  const tracker = new MorphMotionTracker();
  for (let now = 0; now < 1500; now += 16) tracker.step('interviewer', .08, now);
  const next = tracker.step('candidate', 0, 1504, true);
  assert.equal(next.motion, 'silence');
  assert.equal(next.energy, 0);
  assert.equal(next.pulseScale, 1);
  assert.equal(tracker.step('processing', .2, 1520).pulseScale, 1);
});

test('invalid analyser samples and clock values cannot produce invalid CSS values', () => {
  for (const invalid of [NaN, Infinity, -Infinity, -1]) {
    const result = new MorphMotionTracker().step('candidate', invalid, 0);
    assert.equal(result.motion, 'silence');
    assert.equal(result.pulseScale, 1);
    assert.ok([result.energy, result.playbackRate, result.pulseScale, result.sway].every(Number.isFinite));
  }
  const tracker = new MorphMotionTracker();
  for (const now of [0, NaN, Infinity, 200, 100, 216]) {
    const result = tracker.step('interviewer', .05, now);
    assert.ok([result.energy, result.playbackRate, result.pulseScale, result.sway].every(Number.isFinite));
    assert.ok(result.pulseScale >= .9 && result.pulseScale <= 1.07);
  }
});
