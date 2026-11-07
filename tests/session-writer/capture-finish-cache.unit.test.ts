import test from 'node:test';
import assert from 'node:assert/strict';
import { captureFinishForEnd, captureFinishMayPublish, type CaptureFinishCache } from '../../server/session-writer/capture-finish-cache';
import { WorkTestClock } from '../fixtures/work-test-clock';

const instant = Date.parse('2026-11-07T00:00:00.000Z'), deadlineAt = new Date(instant + 15_000).toISOString();
test('an ignored-abort STT result after timeout cannot be promoted by an end retry after a failed final CAS', async () => {
  const cache: CaptureFinishCache<string> = {}, clock = new WorkTestClock(); let calls = 0, resolve!: (value: string) => void;
  const provider = () => { calls++; return new Promise<string>(done => { resolve = done; }); };
  const waiting = captureFinishForEnd(cache, provider, { deadlineAt, serverNowMs: instant, attemptId: 'first', clock });
  const rejected = assert.rejects(waiting, { code: 'TURN_WORK_TIMEOUT' }); await Promise.resolve(); clock.advance(15_000); await rejected;
  // The database commit of this technical failure did not succeed. Its accepted
  // end remains pending while the original provider ignores abort and finishes.
  clock.advance(1); resolve('late confirmed words'); await cache.promise;
  assert.equal(cache.result!.value, 'late confirmed words'); assert.equal(captureFinishMayPublish(cache), false);
  await assert.rejects(captureFinishForEnd(cache, provider, { deadlineAt, serverNowMs: instant + 15_001, attemptId: 'retry', clock }), { code: 'TURN_WORK_TIMEOUT' });
  assert.equal(calls, 1); assert.equal(cache.endDeadline!.deadlineAt, deadlineAt);
});
test('a timely STT result survives a lost final CAS without extending the original deadline', async () => {
  const cache: CaptureFinishCache<string> = {}, clock = new WorkTestClock(); let calls = 0;
  const provider = async () => { calls++; clock.advance(14_999); return 'timely confirmed words'; };
  assert.equal(await captureFinishForEnd(cache, provider, { deadlineAt, serverNowMs: instant, attemptId: 'first', clock }), 'timely confirmed words');
  clock.advance(100_000);
  assert.equal(await captureFinishForEnd(cache, provider, { deadlineAt, serverNowMs: instant + 114_999, attemptId: 'retry', clock }), 'timely confirmed words');
  assert.equal(calls, 1); assert.equal(cache.endDeadline!.deadlineAt, deadlineAt); assert.equal(captureFinishMayPublish(cache), true);
  await assert.rejects(captureFinishForEnd(cache, provider, { deadlineAt: new Date(instant + 130_000).toISOString(), serverNowMs: instant + 114_999, attemptId: 'changed', clock }), { code: 'TURN_WORK_RETIRED' });
});
