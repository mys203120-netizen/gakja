import test from 'node:test';
import assert from 'node:assert/strict';
import { bestEffortClosing, DurableEndRegistration, durableEndRequestInit, endingAnswerObservations } from '../lib/interview/durable-end';
import { playNativeInterviewAudio } from '../lib/interview/native-audio-playback';

const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test('the final active answer keeps its own speech identity and never borrows the preceding answer observation', () => {
  const first = endingAnswerObservations([], { turnId: 'q1', answerId: 'a1' }, { durationMs: 90000, speakingMs: 80000, firstSpeechMs: 1000 }, '앞선 답변입니다.').answers;
  const before = structuredClone(first);
  const current = endingAnswerObservations(first, { turnId: 'q2', answerId: 'a2' }, { durationMs: 8000, speakingMs: 6200, firstSpeechMs: 700 }, '현재 마지막 답변입니다.');
  assert.equal(current.last?.turnId, 'q2'); assert.equal(current.last?.answerId, 'a2'); assert.equal(current.last?.speech.durationMs, 8000);
  assert.equal(current.answers[0].speech.durationMs, 90000); assert.deepEqual(first, before);
  const missing = endingAnswerObservations(first, { turnId: 'q2', answerId: 'a2' }, undefined, '');
  assert.equal(missing.last, undefined, 'Missing current observations cannot acquire the prior answer duration.');
  assert.equal(missing.answers.length, 1);
});

test('duplicate end shares flush/finish/registration and keeps current answer scope after the UI retires', async () => {
  const registration = new DurableEndRegistration<{ metrics: unknown }, { jobId: string }>();
  const flush = deferred<void>(), order: string[] = [];
  const scope = { turnId: 'current-turn', answerId: 'current-answer', captureRevision: 3 };
  let retired = false, preparations = 0, posts = 0;
  const prepare = async () => {
    preparations++; await flush.promise; order.push('PCM flushed');
    order.push('WS finish:' + JSON.stringify(scope));
    return { metrics: { captureFinishScope: scope, answers: [{ ...scope, speech: { durationMs: 8000, speakingMs: 6200 } }], lastObservedAnswerTurnId: scope.turnId } };
  };
  const post = async (body: { metrics: unknown }) => {
    posts++; order.push('HTTP /end');
    assert.equal(retired, true, 'UI retirement is not authority to cancel durable work.');
    assert.deepEqual((body.metrics as { captureFinishScope: unknown }).captureFinishScope, scope);
    return { jobId: 'same-job' };
  };
  const first = registration.register('session-1', prepare, post), duplicate = registration.register('session-1', prepare, post);
  assert.equal(first, duplicate); retired = true; flush.resolve();
  assert.deepEqual(await first, { jobId: 'same-job' }); assert.equal(preparations, 1); assert.equal(posts, 1);
  assert.deepEqual(order, ['PCM flushed', 'WS finish:' + JSON.stringify(scope), 'HTTP /end']);
  assert.deepEqual(await registration.register('session-1', async () => { throw new Error('MUST_NOT_REPEAT'); }, post), { jobId: 'same-job' });
  assert.equal(posts, 1);
});

test('lost accepted response retries the exact first metrics and cannot create a second logical job', async () => {
  const registration = new DurableEndRegistration<{ metrics: { answers: Array<{ turnId: string; answerId: string; speech: { durationMs: number } }> } }, { jobId: string }>();
  const source = { metrics: { answers: [{ turnId: 'last-turn', answerId: 'last-answer', speech: { durationMs: 4000 } }] } };
  const requests: unknown[] = [], jobs = new Map<string, string>();
  let preparations = 0;
  const send = async (body: typeof source) => {
    requests.push(structuredClone(body)); if (!jobs.has('session')) jobs.set('session', 'one-job');
    if (requests.length === 1) { body.metrics.answers[0].speech.durationMs = 999; throw new Error('response lost after durable acceptance'); }
    return { jobId: jobs.get('session')! };
  };
  await assert.rejects(registration.register('session', async () => { preparations++; return source; }, send), /response lost/u);
  source.metrics.answers[0].speech.durationMs = 80000;
  assert.deepEqual(await registration.register('session', async () => { preparations++; return source; }, send), { jobId: 'one-job' });
  assert.equal(preparations, 1); assert.equal(jobs.size, 1); assert.deepEqual(requests[0], requests[1]);
  assert.equal((requests[1] as typeof source).metrics.answers[0].speech.durationMs, 4000);
});

test('end fetch has no epoch abort signal and preserves full large observations instead of truncating to keepalive', () => {
  const small = { metrics: { speech: { durationMs: 1000 } }, elapsedMs: 3000 };
  const init = durableEndRequestInit(small);
  assert.equal(init.keepalive, true); assert.equal(Object.hasOwn(init, 'signal'), false); assert.deepEqual(JSON.parse(init.body as string), small);
  const large = { metrics: { vision: { records: ['관찰 원문'.repeat(25000)] } }, elapsedMs: 30000 };
  const full = durableEndRequestInit(large);
  assert.equal(full.keepalive, false); assert.equal(Object.hasOwn(full, 'signal'), false); assert.deepEqual(JSON.parse(full.body as string), large);
});

class FakeAudio extends EventTarget {
  src = ''; pauses = 0;
  async play() {}
  pause() { this.pauses++; }
}
for (const scenario of ['paused', 'error', 'never_ended'] as const) test(`durable end is accepted before ${scenario} closing and remains accepted after optional playback settles`, async () => {
  const registration = new DurableEndRegistration<{ metrics: { lastObservedAnswerTurnId: string } }, { jobId: string }>();
  const accepted = deferred<void>(), audio = new FakeAudio(); let posts = 0, jobs = 0, playStarts = 0, cancel: (() => void) | null = null;
  const payload = { metrics: { lastObservedAnswerTurnId: 'last-turn' } };
  const end = async () => {
    await registration.register('session', async () => payload, async () => { posts++; jobs++; accepted.resolve(); return { jobId: 'one-job' }; });
    return bestEffortClosing(() => {
      playStarts++; assert.equal(jobs, 1);
      return playNativeInterviewAudio({ audio: audio as unknown as HTMLAudioElement, url: '/closing', current: () => true, action: () => 'play',
        onPlaying: () => {}, onEnded: () => {}, onBlocked: () => {}, registerCancel: value => { cancel = value; }, unregisterCancel: value => { if (cancel === value) cancel = null; } });
    }, () => { (cancel as (() => void) | null)?.(); }, 15);
  };
  const ending = end(); await accepted.promise; await tick(); assert.equal(posts, 1); assert.equal(playStarts, 1);
  audio.dispatchEvent(new Event('playing'));
  if (scenario === 'paused') audio.pause();
  if (scenario === 'error') audio.dispatchEvent(new Event('error'));
  const outcome = await ending;
  assert.equal(outcome, scenario === 'error' ? 'failed' : 'timed_out'); assert.equal(posts, 1); assert.equal(jobs, 1);
  assert.deepEqual(await registration.register('session', async () => payload, async () => { throw new Error('DUPLICATE_JOB'); }), { jobId: 'one-job' });
});

test('normal closing still waits for its native ended event, after durable acceptance', async () => {
  let accepted = false, finished = false;
  const ended = deferred<void>();
  const registration = new DurableEndRegistration<object, object>();
  await registration.register('normal', async () => ({}), async () => { accepted = true; return {}; });
  const closing = bestEffortClosing(async () => { assert.equal(accepted, true); await ended.promise; finished = true; }, () => { throw new Error('NORMAL_AUDIO_MUST_NOT_CANCEL'); }, 1000);
  assert.equal(finished, false); ended.resolve(); assert.equal(await closing, 'played'); assert.equal(finished, true);
});

test('cancelling optional closing during preparation settles immediately and cannot start delayed audio', async () => {
  const preparation = deferred<void>(), controller = new AbortController();
  let starts = 0, cancellations = 0;
  const closing = bestEffortClosing(async () => { await preparation.promise; if (!controller.signal.aborted) starts++; }, () => { cancellations++; }, 1000, controller.signal);
  await tick(); controller.abort();
  assert.equal(await closing, 'cancelled'); assert.equal(cancellations, 1);
  preparation.resolve(); await tick(); assert.equal(starts, 0);
});

test('already cancelled closing never invokes its preparation or audio', async () => {
  const controller = new AbortController(); controller.abort();
  assert.equal(await bestEffortClosing(async () => { throw new Error('MUST_NOT_START'); }, () => { throw new Error('MUST_NOT_CANCEL_UNSTARTED_AUDIO'); }, 1000, controller.signal), 'cancelled');
});
