import test from 'node:test';
import assert from 'node:assert/strict';
import { FirstQuestionPreparation, type PreparedFirstQuestion } from '../lib/interview/first-question-preparation';
import { InterviewStartupCountdown } from '../lib/interview/startup-flow';

test('device checks and countdown share one pending preparation without starting playback or creating a session', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const preparation = new FirstQuestionPreparation();
  let complete!: (value: PreparedFirstQuestion) => void;
  let requests = 0, launches = 0;
  const request = async () => { requests++; return new Promise<PreparedFirstQuestion>(resolve => { complete = resolve; }); };
  const idle = preparation.ensure('same-sources', request);
  const deviceCheck = preparation.ensure('same-sources', request);
  const countdown = new InterviewStartupCountdown();
  countdown.start({ valid: () => true, tick: () => { void preparation.ensure('same-sources', request); }, ready: () => { launches++; }, interrupted: () => assert.fail('unexpected interruption') });
  await Promise.resolve();
  assert.equal(requests, 1); assert.equal(deviceCheck, idle); assert.equal(launches, 0);
  context.mock.timers.tick(1000);
  complete({ ready: true, preparationId: 'approved-first', questionAudioUrl: '/api/audio/approved.mp3' });
  assert.equal((await idle).preparationId, 'approved-first');
  assert.equal(preparation.readyId('same-sources'), 'approved-first');
  assert.equal(launches, 0, 'preparation readiness cannot bypass the countdown');
  context.mock.timers.tick(1000); context.mock.timers.tick(1000);
  assert.equal(launches, 1); assert.equal(requests, 1);
});

test('a failed background preparation can retry at a later startup action', async () => {
  const preparation = new FirstQuestionPreparation();
  await assert.rejects(preparation.ensure('sources', async () => { throw new Error('temporary failure'); }));
  assert.equal(preparation.readyId('sources'), undefined);
  const result = await preparation.ensure('sources', async () => ({ ready: true, preparationId: 'retry-approved' }));
  assert.equal(result.preparationId, 'retry-approved');
});

test('source changes, expiry and disposal never expose a stale approved preparation', async () => {
  let now = 0;
  const preparation = new FirstQuestionPreparation(() => now, 100);
  await preparation.ensure('old', async () => ({ ready: true, preparationId: 'old-id' }));
  assert.equal(preparation.readyId('different-sources'), undefined);
  now = 101;
  assert.equal(preparation.readyId('old'), undefined);
  let pendingSignal!: AbortSignal, complete!: (value: PreparedFirstQuestion) => void;
  const pending = preparation.ensure('new', signal => { pendingSignal = signal; return new Promise(resolve => { complete = resolve; }); });
  await Promise.resolve();
  const changed = preparation.ensure('newer', async () => ({ ready: true, preparationId: 'new-id' }));
  assert.equal(pendingSignal.aborted, true);
  complete({ ready: true, preparationId: 'cancelled-id' });
  await assert.rejects(pending, { name: 'AbortError' });
  await changed;
  assert.equal(preparation.readyId('new'), undefined);
  assert.equal(preparation.readyId('newer'), 'new-id');
  preparation.cancel(); assert.equal(preparation.readyId('newer'), undefined);
});
