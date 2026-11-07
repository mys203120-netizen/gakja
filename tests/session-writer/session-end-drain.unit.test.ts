import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionEndDrainer, type SessionEndCaptureDrain } from '../../server/session-end-drain';
import { WorkTestClock } from '../fixtures/work-test-clock';

const scope = { turnId: 'synthetic-turn', answerId: 'synthetic-answer', captureRevision: 1 };
const marker = (finishForEnd: () => Promise<void>, captureScope = scope): SessionEndCaptureDrain => {
  let markFinishReceived!: () => void;
  return { ...captureScope, receipt: new Promise<void>(resolve => { markFinishReceived = resolve; }), get markFinishReceived() { return markFinishReceived; }, finishForEnd };
};

test('HTTP end waits for the matching socket finish marker and preserves the queued final PCM', async () => {
  const clock = new WorkTestClock(), sequence: string[] = [], capture = { text: 'first', finalized: '' };
  const drain = marker(async () => { capture.finalized = capture.text; sequence.push('provider-finish'); });
  const draining = createSessionEndDrainer<typeof capture>({ drainFor: () => drain, finish: async () => { assert.fail('matching drain owns finish'); },
    close: () => { sequence.push('close'); }, onFailure: () => { assert.fail('capture must remain confirmed'); }, clock });
  const result = draining({ captures: [capture], finishScope: scope });
  await Promise.resolve(); clock.advance(1_999); assert.equal(sequence.length, 0);
  capture.text += ' + queued final PCM'; sequence.push('last-pcm'); drain.markFinishReceived();
  assert.deepEqual(await result, { activeStreamsFlushed: true });
  assert.equal(capture.finalized, 'first + queued final PCM'); assert.deepEqual(sequence, ['last-pcm', 'provider-finish', 'close']);
});

test('missing finish marker becomes an unconfirmed capture after the original two seconds', async () => {
  const clock = new WorkTestClock(), failures: string[] = []; let finished = 0, closed = 0, forgotten = 0;
  const drain = marker(async () => { finished++; });
  const result = createSessionEndDrainer<number>({ drainFor: () => drain, finish: async () => { finished++; }, close: () => { closed++; },
    onFailure: (_capture, _drain, error) => { failures.push((error as Error).message); }, forget: () => { forgotten++; }, clock })({ captures: [1], finishScope: scope });
  clock.advance(1_999); await Promise.resolve(); assert.equal(closed, 0); assert.equal(finished, 0);
  clock.advance(1); assert.deepEqual(await result, { activeStreamsFlushed: true });
  assert.deepEqual(failures, ['END_CAPTURE_FINISH_NOT_RECEIVED']); assert.equal(finished, 0); assert.equal(closed, 1); assert.equal(forgotten, 1);
  drain.markFinishReceived(); await Promise.resolve(); assert.equal(finished, 0, 'a late marker cannot finalize a closed unconfirmed capture');
});

test('other capture scopes retain the existing immediate drain and no-drain provider fallback', async () => {
  const sequence: string[] = [], drain = marker(async () => { sequence.push('other-drain'); }, { ...scope, captureRevision: 2 });
  const result = await createSessionEndDrainer<number>({ drainFor: capture => capture === 1 ? drain : undefined,
    finish: async () => { sequence.push('fallback'); }, close: capture => { sequence.push(`close-${capture}`); },
    onFailure: () => { assert.fail('unrelated drain does not wait for this marker'); }, clock: new WorkTestClock() })({ captures: [1, 2], finishScope: scope });
  assert.deepEqual(result, { activeStreamsFlushed: true }); assert.deepEqual(sequence, ['other-drain', 'fallback', 'close-1', 'close-2']);
});
