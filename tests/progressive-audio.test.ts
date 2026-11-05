import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InterviewAudioPreloader, InterviewPlaybackGate } from '../lib/interview/audio-preload';
import { canStartListeningAfterAudio, ProgressiveInterviewAudio } from '../lib/interview/progressive-audio';
import { NextTurnOperation, NextTurnResponseError, readNextTurnResponse } from '../lib/interview/next-turn-stream';
import { ClientTimingLedger } from '../lib/interview/client-timings';
import type { PreparedTurn } from '../server/protocol';

const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const turn: PreparedTurn = { id: 'next', questionText: '실제 다음 질문', questionKind: 'main', parentMainQuestionId: 'next', mainIndex: 2, mainCount: 4, followUpIndex: 0, evidenceIds: ['pdf:1'], questionAudioUrl: '/api/audio/question', acknowledgement: '말씀하신 내용 잘 들었습니다.', acknowledgementAudioUrl: '/api/audio/ack', interviewerId: 'one' };
const acknowledgement = { type: 'acknowledgement_ready' as const, turnId: turn.id, acknowledgement: turn.acknowledgement!, acknowledgementAudioUrl: turn.acknowledgementAudioUrl!, interviewerId: 'one' };

test('NDJSON progress handles split Korean UTF8, duplicates and starts acknowledgement before the full turn', async () => {
  const encoder = new TextEncoder(), events: string[] = [];
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
  const reading = readNextTurnResponse(response, event => events.push(event.acknowledgement));
  const bytes = encoder.encode(`${JSON.stringify(acknowledgement)}\n`);
  for (let position = 0; position < bytes.length; position += 3) stream.enqueue(bytes.slice(position, position + 3));
  await tick(); assert.deepEqual(events, [turn.acknowledgement]);
  stream.enqueue(bytes); stream.enqueue(encoder.encode(`${JSON.stringify({ type: 'turn_ready', turn, done: false })}\n`)); stream.close();
  assert.deepEqual(await reading, { turn, done: false }); assert.equal(events.length, 1);
});

test('JSON remains supported, protocol errors are explicit and a mismatched streamed question is rejected', async () => {
  assert.deepEqual(await readNextTurnResponse(Response.json({ turn, done: false }), () => {}), { turn, done: false });
  await assert.rejects(readNextTurnResponse(new Response(`${JSON.stringify({ type: 'error', message: '실제 TTS 실패' })}\n`, { headers: { 'Content-Type': 'application/x-ndjson' } }), () => {}), /실제 TTS 실패/);
  await assert.rejects(readNextTurnResponse(new Response(`${JSON.stringify(acknowledgement)}\n${JSON.stringify({ type: 'turn_ready', turn: { ...turn, id: 'other' }, done: false })}\n`, { headers: { 'Content-Type': 'application/x-ndjson' } }), () => {}), /응답/);
});

test('durable playback receipts survive JSON/NDJSON parsing and budget invalidation preserves its recovery code', async () => {
  const id = crypto.randomUUID(), value = { turn, done: false, acceptedClientEventIds: [id] };
  assert.deepEqual(await readNextTurnResponse(Response.json(value), () => {}), value);
  assert.deepEqual(await readNextTurnResponse(new Response(`${JSON.stringify({ type: 'turn_ready', ...value })}\n`, { headers: { 'Content-Type': 'application/x-ndjson' } }), () => {}), value);
  await assert.rejects(readNextTurnResponse(Response.json({ ...value, acceptedClientEventIds: ['invalid'] }), () => {}), /저장 결과/);
  await assert.rejects(readNextTurnResponse(Response.json({ error: 'Retry prepared question', code: 'QUESTION_ACTION_BUDGET_EXHAUSTED' }, { status: 409 }), () => {}), error => error instanceof NextTurnResponseError && error.code === 'QUESTION_ACTION_BUDGET_EXHAUSTED');
});

test('acknowledgement playback overlaps question preload but never question playback or early question reveal', async () => {
  const events: string[] = [], ackEnded = deferred<void>(), questionEnded = deferred<void>();
  const player = new ProgressiveInterviewAudio({
    prepare: async url => { events.push(`prepare:${url}`); return `blob:${url}`; }, wait: async () => {}, current: () => true,
    play: async (url, onPlaying) => { events.push(`play:${url}`); onPlaying(); await (url.endsWith('/ack') ? ackEnded.promise : questionEnded.promise); },
    acknowledgementPlaying: () => events.push('ack-visible'), acknowledgementEnded: () => events.push('ack-ended'), questionPlaying: () => events.push('question-visible'),
  });
  const ack = player.acknowledge(acknowledgement); await tick(); assert.ok(events.includes('ack-visible'));
  const playing = player.playTurn(turn); const duplicate = player.playTurn(turn);
  await tick(); assert.ok(events.includes('prepare:/api/audio/question')); assert.ok(!events.includes('question-visible'));
  ackEnded.resolve(); await ack; await tick();
  assert.ok(events.indexOf('ack-ended') < events.indexOf('question-visible')); assert.equal(events.filter(event => event === 'ack-visible').length, 1);
  questionEnded.resolve(); await Promise.all([playing, duplicate]);
  assert.equal(events.filter(event => event === 'question-visible').length, 1);
});

test('suspended acknowledgement waits and retirement rejects late sound even if preparation finishes', async () => {
  const gate = new InterviewPlaybackGate(); gate.pause(); let current = true, played = 0;
  const player = new ProgressiveInterviewAudio({ prepare: async url => url, wait: () => gate.wait(), current: () => current, play: async (_url, onPlaying) => { played++; onPlaying(); }, acknowledgementPlaying: () => {}, acknowledgementEnded: () => {}, questionPlaying: () => {} });
  const pending = player.acknowledge(acknowledgement); await tick(); assert.equal(played, 0);
  gate.resume(); await pending; assert.equal(played, 1);
  gate.pause(); const next = player.playTurn({ ...turn, id: 'later', acknowledgement: null, acknowledgementAudioUrl: null }); await tick(); current = false; gate.dispose();
  await assert.rejects(next, /취소|종료/); assert.equal(played, 1);
});

test('retrying a failed question never repeats an already played acknowledgement', async () => {
  let ackCount = 0, questionCount = 0, fail = true;
  const player = new ProgressiveInterviewAudio({ prepare: async url => url, wait: async () => {}, current: () => true,
    play: async (url, onPlaying) => { if (url.endsWith('/ack')) ackCount++; else { questionCount++; if (fail) throw new Error('question audio error'); } onPlaying(); },
    acknowledgementPlaying: () => {}, acknowledgementEnded: () => {}, questionPlaying: () => {},
  });
  await assert.rejects(player.playTurn(turn), /question audio error/); fail = false; player.retry(turn.id); await player.playTurn(turn);
  assert.equal(ackCount, 1); assert.equal(questionCount, 2);
});

test('audio preload deduplicates downloads and revokes/aborts every run-owned object URL', async () => {
  let requests = 0; const revoked: string[] = []; const signals: AbortSignal[] = [];
  const cache = new InterviewAudioPreloader({ fetch: (async (_url, options) => { requests++; signals.push(options!.signal as AbortSignal); return new Response(new Blob(['mp3'], { type: 'audio/mpeg' })); }) as typeof fetch, createObjectURL: () => 'blob:one', revokeObjectURL: value => revoked.push(value) });
  assert.equal(await cache.prepare('/one'), 'blob:one'); assert.equal(await cache.prepare('/one'), 'blob:one'); assert.equal(requests, 1);
  cache.dispose(); assert.deepEqual(revoked, ['blob:one']); assert.equal(signals[0].aborted, true);
  const late = deferred<Response>(); let created = 0;
  const pendingCache = new InterviewAudioPreloader({ fetch: (() => late.promise) as typeof fetch, createObjectURL: () => { created++; return 'blob:late'; }, revokeObjectURL: () => {} });
  const pending = pendingCache.prepare('/pending'); pendingCache.dispose(); late.resolve(new Response(new Blob(['late'])));
  await assert.rejects(pending, /취소/); assert.equal(created, 0);
});

test('per-turn timing preserves current question time separately from submit-to-next-question latency', () => {
  const ledger = new ClientTimingLedger();
  ledger.mark('first', 'playback', 'questionStarted', 100); ledger.mark('first', 'playback', 'listeningStarted', 500);
  ledger.mark('first', 'answer', 'submittedAt', 1000); ledger.mark('first', 'answer', 'finalizedAt', 1100);
  ledger.link('first', 'next'); ledger.mark('first', 'transition', 'acknowledgementStarted', 1200); ledger.mark('next', 'playback', 'acknowledgementEnded', 1350); ledger.mark('first', 'transition', 'acknowledgementEnded', 1350); ledger.mark('first', 'transition', 'questionStarted', 1400);
  ledger.mark('next', 'playback', 'questionStarted', 1400); ledger.mark('next', 'playback', 'listeningStarted', 1800);
  assert.deepEqual(ledger.transition('first'), { submittedAt: 1000, finalizedAt: 1100, acknowledgementStarted: 1200, acknowledgementEnded: 1350, questionStarted: 1400 });
  assert.equal(ledger.playbackSnapshot().first.questionStarted, 100); assert.equal(ledger.sourceFor('next'), 'first');
  assert.equal(ledger.transitionSnapshot().first.questionStarted - ledger.transitionSnapshot().first.submittedAt, 400);
  assert.equal(ledger.transitionSnapshot().first.questionStarted - ledger.transitionSnapshot().first.acknowledgementEnded, 50);
});

test('resume callers share one next request and failed requests retry without allowing duplicate playback', async () => {
  const operation = new NextTurnOperation(1, 'answered', 'session'), response = deferred<{ turn: PreparedTurn; done: boolean }>();
  let requests = 0;
  const first = operation.load(() => { requests++; return response.promise; });
  const second = operation.load(() => { requests++; return Promise.resolve({ turn, done: false }); });
  assert.equal(first, second); assert.equal(requests, 1);
  operation.acknowledge(turn.id); response.resolve({ turn, done: false }); operation.complete(await first);
  assert.equal(operation.startPlayback(), true); assert.equal(operation.startPlayback(), false);
  assert.throws(() => operation.acknowledge('unexpected-turn'), /식별자/);
  operation.retryPlayback(); assert.equal(operation.startPlayback(), true);
  const failed = new NextTurnOperation(1, 'other', 'session');
  await assert.rejects(failed.load(async () => { throw new Error('transport'); }), /transport/);
  assert.deepEqual(await failed.load(async () => ({ turn, done: false })), { turn, done: false });
});

test('retry does not replace an acknowledgement still paused in flight', async () => {
  const ending = deferred<void>(); let plays = 0;
  const player = new ProgressiveInterviewAudio({ prepare: async url => url, wait: async () => {}, current: () => true, play: async (_url, onPlaying) => { plays++; onPlaying(); await ending.promise; }, acknowledgementPlaying: () => {}, acknowledgementEnded: () => {}, questionPlaying: () => {} });
  const original = player.acknowledge(acknowledgement); await tick(); player.retry(turn.id);
  assert.equal(player.acknowledge(acknowledgement), original); assert.equal(plays, 1);
  ending.resolve(); await original;
});

test('an audio ended event queued during suspension never starts microphone capture', () => {
  assert.equal(canStartListeningAfterAudio('speaking_question', false), true);
  assert.equal(canStartListeningAfterAudio('speaking_question', true), false);
  for (const phase of ['suspended', 'ending', 'completed']) assert.equal(canStartListeningAfterAudio(phase, false), false);
  assert.equal(canStartListeningAfterAudio('preparing_next', false), true);
});
