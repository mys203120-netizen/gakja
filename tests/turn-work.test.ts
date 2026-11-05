import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnWorkContext, TurnWorkError } from '../server/turn-work';
import { SubmissionWorkRegistry } from '../server/submission-work';
import { SubmissionWait } from '../lib/interview/submission-wait';
import type { InterviewSession } from '../server/protocol';

import { WorkTestClock } from './fixtures/work-test-clock';
const scope = { turnId: 'q', answerId: 'a', captureRevision: 1 };
const session = () => ({ id: 's', status: 'active', runtime: { epoch: 0, operations: {} } }) as unknown as InterviewSession;
const pending = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

test('one trusted finish budget charges STT plus candidate/next gaps; retry IDs never refresh it', async () => {
  const clock = new WorkTestClock(), registry = new SubmissionWorkRegistry(95, clock), s = session();
  const work = registry.get(s, scope, 'attempt', true);
  clock.advance(15); assert.equal(registry.get(s, scope, 'attempt'), work);
  let coreCap = 0; await work.run(15, async stage => { coreCap = stage.timeoutMs; return 'candidate'; });
  clock.advance(70);
  let ttsCap = 0; await registry.get(s, scope, 'attempt').run(35, async stage => { ttsCap = stage.timeoutMs; });
  assert.equal(coreCap, 15); assert.equal(ttsCap, 10);
  assert.throws(() => registry.get(s, scope, 'another-attempt'), TurnWorkError);
  clock.advance(10); assert.throws(() => registry.get(s, scope, 'attempt'), { code: 'TURN_WORK_TIMEOUT' });
  assert.throws(() => registry.get(s, scope), { code: 'TURN_WORK_TIMEOUT' }, 'omitting attemptId cannot bypass an expired capture');
  assert.equal(Object.values(s.runtime!.submissionAttempts!)[0].status, 'expired');
});

test('cancel immediately releases an ignored-abort provider waiter and rejects its late result', async () => {
  const clock = new WorkTestClock(), deferred = pending<string>();
  const work = createTurnWorkContext({ attemptId: 'attempt', timeoutMs: 100, clock });
  let providerSignal!: AbortSignal;
  const result = work.run(50, async stage => { providerSignal = stage.signal; return deferred.promise; });
  const rejected = assert.rejects(result, { code: 'TURN_WORK_CANCELLED' });
  work.cancel(); await rejected; assert.equal(providerSignal.aborted, true);
  deferred.resolve('late'); await Promise.resolve();
  assert.throws(() => work.assertLive(), { code: 'TURN_WORK_CANCELLED' });
});

test('stage timeout does not refresh the shared total budget or start a later stage', async () => {
  const clock = new WorkTestClock(), work = createTurnWorkContext({ attemptId: 'attempt', timeoutMs: 100, clock });
  const result = work.run(12, async () => new Promise<never>(() => {}));
  const rejected = assert.rejects(result, { code: 'TURN_STAGE_TIMEOUT' }); clock.advance(12); await rejected;
  assert.equal(work.remainingMs(), 88);
  clock.advance(88); let called = false;
  await assert.rejects(work.run(6, async () => { called = true; }), { code: 'TURN_WORK_TIMEOUT' }); assert.equal(called, false);
});

test('CONTINUE/new capture gets a new budget while completed attempt identity stays fixed', () => {
  const clock = new WorkTestClock(), registry = new SubmissionWorkRegistry(95, clock), s = session();
  const first = registry.get(s, scope, 'a1', true); clock.advance(30); registry.complete(s, scope);
  const secondScope = { ...scope, captureRevision: 2 }, second = registry.get(s, secondScope, 'a2', true);
  assert.notEqual(first, second); assert.equal(second.remainingMs(), 95);
  assert.throws(() => registry.get(s, scope, 'a3', true), { code: 'TURN_WORK_RETIRED' });
  assert.equal(Object.values(s.runtime!.submissionAttempts!)[0].status, 'completed');
});

test('a persisted running attempt cannot gain a fresh monotonic deadline after process restart', () => {
  const clock = new WorkTestClock(), s = session(); new SubmissionWorkRegistry(95, clock).get(s, scope, 'a1', true);
  const restored = structuredClone(s); restored.runtime!.epoch++;
  assert.throws(() => new SubmissionWorkRegistry(95, clock).get(restored, scope, 'a1'), { code: 'TURN_WORK_TIMEOUT' });
  assert.equal(Object.values(restored.runtime!.submissionAttempts!)[0].status, 'expired');
});

test('end intent cancels generation but leaves separately owned capture/evaluation operations untouched', async () => {
  const clock = new WorkTestClock(), registry = new SubmissionWorkRegistry(95, clock), s = session(), capture = pending<string>();
  const work = registry.get(s, scope, 'a1', true);
  const generation = work.run(95, async () => new Promise<never>(() => {}));
  const rejection = assert.rejects(generation, { code: 'TURN_WORK_CANCELLED' });
  s.runtime!.endRequestedAt = new Date().toISOString(); registry.cancelSession(s.id); await rejection;
  capture.resolve('last raw transcript'); assert.equal(await capture.promise, 'last raw transcript');
});

test('browser submit timer includes pre-finish work and Space withdrawal/CONTINUE completion cancels it', () => {
  const clock = new WorkTestClock(); let expired = 0;
  const first = new SubmissionWait(scope, 'a1', 95, () => { expired++; }, clock);
  clock.advance(5); first.complete(); clock.advance(100); assert.equal(expired, 0); assert.equal(first.signal.aborted, false);
  const second = new SubmissionWait({ ...scope, captureRevision: 2 }, 'a2', 95, () => { expired++; }, clock);
  clock.advance(94); assert.equal(expired, 0); clock.advance(1); assert.equal(expired, 1); assert.equal(second.signal.aborted, true);
  assert.throws(() => second.assertLive(), /기다리는 시간이 초과/);
});

test('only scope-bound cancellation can retire an attempt; durable committed work is retained', async () => {
  const clock = new WorkTestClock(), registry = new SubmissionWorkRegistry(95, clock), s = session();
  const work = registry.get(s, scope, 'a1', true);
  assert.equal(registry.cancel(s, scope, 'old'), false); assert.equal(work.signal.aborted, false);
  registry.complete(s, scope);
  assert.equal(registry.get(s, scope, 'a1'), work, 'the canonical completed identity remains inspectable');
  let newStageCalls = 0;
  await assert.rejects(work.run(35, async () => { newStageCalls++; }), { code: 'TURN_WORK_RETIRED' });
  registry.cancelSession(s.id); clock.advance(200);
  await assert.rejects(work.run(35, async () => { newStageCalls++; }), { code: 'TURN_WORK_RETIRED' });
  assert.equal(newStageCalls, 0);
  assert.equal(work.signal.aborted, false); assert.equal(Object.values(s.runtime!.submissionAttempts!)[0].status, 'completed');
});
