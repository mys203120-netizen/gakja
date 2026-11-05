import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InterviewClientEventJournal, phaseEventTurnId, readClientEventReceipt, type InterviewClientEvent } from '../lib/interview/client-events';
import { playbackEventBatchSchema } from '../lib/interview/client-event-contract';

test('phase observations bind early acknowledgement to the new audible turn instead of the previous answer', () => {
  const scope = { playbackTurnId: 'next-ack-turn', pendingTurnId: null, currentTurnId: 'previous-answer-turn' };
  assert.equal(phaseEventTurnId('speaking_acknowledgement', scope), 'next-ack-turn'); assert.equal(phaseEventTurnId('speaking_question', scope), 'next-ack-turn');
  assert.equal(phaseEventTurnId('listening', scope), 'previous-answer-turn');
});

const scope = { sessionId: 'session-one', epoch: 1 };
test('real playback event IDs and turn scope survive non-blocking sends and end backup', async () => {
  const delivered: InterviewClientEvent[] = []; let sequence = 0, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const journal = new InterviewClientEventJournal(async (_id, event) => { delivered.push(event); await pending; }, () => `event-${++sequence}`, () => 12);
  journal.bind(scope.sessionId, scope.epoch);
  journal.emit(scope, { type: 'acknowledgement_playing', turnId: 'reserved-next-turn', phase: 'speaking_acknowledgement' });
  assert.equal(journal.status().pending, 1);
  const backup = journal.snapshot(scope.sessionId); assert.equal(backup[0].turnId, 'reserved-next-turn'); assert.equal(backup[0].eventId, 'event-1'); assert.equal(backup[0].atMs, 12);
  assert.match(backup[0].clockId!, /^[0-9a-f-]{36}$/u);
  let flushed = false; const flushing = journal.flush(scope.sessionId).then(() => { flushed = true; });
  await Promise.resolve(); assert.equal(flushed, false); release(); await flushing;
  assert.equal(delivered[0].eventId, backup[0].eventId); assert.equal(journal.status().pending, 0);
  assert.equal(delivered[0].clockId, backup[0].clockId);
});

test('log network failure never rejects playback and keeps an identical event for end backup', async () => {
  const journal = new InterviewClientEventJournal(async () => { throw new Error('offline'); }, () => 'keep-for-backup', () => 24);
  journal.bind(scope.sessionId, 1); assert.equal(journal.emit(scope, { type: 'question_playing', turnId: 'question-two' }), 'keep-for-backup');
  await journal.flush(scope.sessionId); assert.equal(journal.status().failedWrites, 1); assert.equal(journal.snapshot(scope.sessionId)[0].eventId, 'keep-for-backup');
});

test('retirement blocks late playback and new-run scope cannot submit old session events', async () => {
  const sent: string[] = []; let next = 0;
  const journal = new InterviewClientEventJournal(async id => { sent.push(id); }, () => `event-${++next}`);
  journal.bind(scope.sessionId, 1); journal.emit(scope, { type: 'phase_changed', phase: 'ending' });
  journal.retire(); assert.equal(journal.emit(scope, { type: 'question_playing', turnId: 'late-question' }), null);
  journal.bind('session-two', 2); assert.equal(journal.emit(scope, { type: 'audio_ended' }), null);
  journal.emit({ sessionId: 'session-two', epoch: 2 }, { type: 'phase_changed', phase: 'preparing' });
  await journal.flush(scope.sessionId); await journal.flush('session-two');
  assert.deepEqual(sent, ['session-one', 'session-two']); assert.equal(journal.snapshot('session-one').length, 1); assert.equal(journal.snapshot('session-two').length, 1);
});

test('failed playback sends stay in a detached outbox until a durable same-session receipt; end backup remains complete', async () => {
  let sequence = 0;
  const journal = new InterviewClientEventJournal(async () => { throw new Error('offline'); }, () => `event-${++sequence}`);
  journal.bind(scope.sessionId, 1);
  journal.emit(scope, { type: 'question_playing', turnId: 'follow-up', payload: { role: 'question' } });
  journal.emit(scope, { type: 'phase_changed', phase: 'listening' });
  await journal.flush(scope.sessionId);
  const batch = journal.outstandingPlayback(scope.sessionId);
  assert.equal(batch.length, 1); assert.equal(batch[0].eventId, 'event-1');
  (batch[0].payload as { role: string }).role = 'modified';
  assert.deepEqual(journal.outstandingPlayback(scope.sessionId)[0].payload, { role: 'question' });
  journal.acknowledge('other-session', ['event-1']); assert.equal(journal.outstandingPlayback(scope.sessionId).length, 1);
  journal.acknowledge(scope.sessionId, ['foreign-event']); assert.equal(journal.outstandingPlayback(scope.sessionId).length, 1);
  journal.acknowledge(scope.sessionId, ['event-1']); assert.equal(journal.outstandingPlayback(scope.sessionId).length, 0);
  assert.equal(journal.snapshot(scope.sessionId).length, 2);
});

test('successful direct save acknowledges playback without waiting for the append-only log', async () => {
  const journal = new InterviewClientEventJournal(async () => ({ accepted: true, logged: false }), () => 'event-one');
  journal.bind(scope.sessionId, 1); journal.emit(scope, { type: 'question_playing', turnId: 'follow-up' });
  assert.equal(journal.outstandingPlayback(scope.sessionId).length, 1);
  await journal.flush(scope.sessionId);
  assert.equal(journal.outstandingPlayback(scope.sessionId).length, 0); assert.equal(journal.snapshot(scope.sessionId).length, 1);
});

test('playback receipts and batches are bounded, typed, clock-bound observations', () => {
  const id = crypto.randomUUID(), event = { eventId: id, type: 'question_playing', turnId: crypto.randomUUID(), clockId: crypto.randomUUID(), atMs: 10 };
  assert.deepEqual(readClientEventReceipt([id]), [id]);
  assert.throws(() => readClientEventReceipt(['invalid']));
  assert.throws(() => readClientEventReceipt(Array(4097).fill(id)));
  assert.equal(playbackEventBatchSchema.safeParse([event]).success, true);
  assert.equal(playbackEventBatchSchema.safeParse([{ ...event, type: 'phase_changed' }]).success, false);
  assert.equal(playbackEventBatchSchema.safeParse([{ ...event, clockId: undefined }]).success, false);
  assert.equal(playbackEventBatchSchema.safeParse(Array(4097).fill(event)).success, false);
});
