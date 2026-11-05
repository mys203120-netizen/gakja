import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStagedFixture, poll } from './fixtures/staged-realtime-harness';
import type { ClientPlaybackEvent } from '../lib/interview/client-event-contract';
import type { PreparedTurn } from '../server/protocol';

type Json = Record<string, unknown>;
const metrics = { speech: { durationMs: 1000, speakingMs: 700, firstSpeechMs: 100 } };
const endingObservation = { stopSource: 'button', lastSpeechMs: 800, trailingSilenceMs: 200, speechActiveAtEnd: false, vadAvailable: true };

test('playback outbox batches restore the F budget durably before progression without another semantic call', { timeout: 90_000 }, async t => {
  const fixture = await startStagedFixture({ evaluationWorker: false }); t.after(() => fixture.close());
  const capture = async (sessionId: string, turn: PreparedTurn) => {
    const connection = await fixture.connect(sessionId), scope = { turnId: turn.id, answerId: randomUUID(), captureRevision: 1 };
    assert.equal((await connection.exchange({ type: 'start', ...scope }, 'started')).type, 'started');
    connection.ws.send(Buffer.alloc(3200), { binary: true });
    assert.equal((await connection.exchange({ type: 'finish', ...scope, staged: true }, 'finalized')).type, 'finalized');
    connection.close(); return scope;
  };
  const candidate = (sessionId: string, scope: Json, clientEvents: ClientPlaybackEvent[] = []) => fixture.request(`/api/sessions/${sessionId}/answer-candidate`, { ...scope, elapsedMs: 3000, metrics, endingObservation, clientEvents });
  const next = (sessionId: string, scope: Json, candidateId: unknown, clientEvents: ClientPlaybackEvent[] = []) => fixture.request(`/api/sessions/${sessionId}/next`, { ...scope, candidateId, elapsedMs: 3000, metrics, clientEvents });
  const playing = (turnId: string, atMs: number, clockId = randomUUID()): ClientPlaybackEvent => ({ eventId: randomUUID(), type: 'question_playing', turnId, clockId, atMs });
  const twoUnreportedFollowUps = async () => {
    const { sessionId, turn } = await fixture.start(); let current = turn;
    const follows: PreparedTurn[] = [];
    for (let i = 0; i < 2; i++) {
      const scope = await capture(sessionId, current);
      await fixture.control('/configure', { followUpNextCore: true }, false);
      const ready = await candidate(sessionId, scope); assert.equal(ready.status, 200);
      const prepared = await next(sessionId, scope, ready.body.candidateId); assert.equal(prepared.status, 200);
      current = prepared.body.turn as PreparedTurn; assert.equal(current.questionKind, 'follow_up'); follows.push(current);
    }
    const scope = await capture(sessionId, current), clockId = randomUUID();
    const starts = follows.map((follow, i) => playing(follow.id, i * 1000 + 10, clockId));
    const ends: ClientPlaybackEvent[] = starts.map(start => ({ ...start, eventId: randomUUID(), type: 'audio_ended', atMs: start.atMs + 100, payload: { role: 'question' } }));
    return { sessionId, scope, follows, starts, events: [ends[0], ends[1], starts[1], starts[0], starts[0]] };
  };

  await t.test('dropped F1 start, out-of-order ends and duplicate backup cannot authorize a third F', async () => {
    const { sessionId, scope, events } = await twoUnreportedFollowUps();
    await fixture.control('/configure', { followUpNextCore: true }, false);
    const ready = await candidate(sessionId, scope, events); assert.equal(ready.status, 200);
    assert.equal(new Set(ready.body.acceptedClientEventIds as string[]).size, 4);
    const saved = await fixture.saved(sessionId), root = saved.turns[0].id;
    assert.equal(saved.followUpCountByMainQuestion[root], 2);
    assert.equal((await fixture.control()).lastCandidateAllowFollowUp, false);
    const afterDecision = await fixture.control();
    const duplicate = await candidate(sessionId, scope, events);
    assert.equal(duplicate.body.candidateId, ready.body.candidateId);
    assert.equal((await fixture.control()).candidateCalls, afterDecision.candidateCalls);
    const prepared = await next(sessionId, scope, ready.body.candidateId, events); assert.equal(prepared.status, 200);
    assert.equal((prepared.body.turn as PreparedTurn).questionKind, 'main');
    const counts = await fixture.control(), replay = await next(sessionId, scope, ready.body.candidateId, events);
    assert.equal((replay.body.turn as PreparedTurn).id, (prepared.body.turn as PreparedTurn).id);
    assert.equal((await fixture.control()).candidateCalls, counts.candidateCalls);
    assert.equal((await fixture.saved(sessionId)).turns.filter(row => row.questionKind === 'follow_up').length, 2);
    await fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 4000, metrics });
  });

  await t.test('a corrected cached F retires its UUID once, then the same candidate recovers to main without another core call', async () => {
    const { sessionId, scope, events } = await twoUnreportedFollowUps();
    await fixture.control('/configure', { followUpNextCore: true }, false);
    const ready = await candidate(sessionId, scope); assert.equal(ready.status, 200);
    await fixture.control('/configure', { failPreparedCommitSave: true });
    const failed = await next(sessionId, scope, ready.body.candidateId); assert.equal(failed.status, 502);
    const key = `${sessionId}:${scope.turnId}:${scope.answerId}`;
    const old = (await fixture.saved(sessionId)).runtime!.operations[key].prepared as { id: string; acknowledgement: string };
    assert.ok(old.id); const counts = await fixture.control();
    const invalidated = await next(sessionId, scope, ready.body.candidateId, events);
    assert.equal(invalidated.status, 409); assert.equal(invalidated.body.code, 'QUESTION_ACTION_BUDGET_EXHAUSTED');
    const archived = (await fixture.saved(sessionId)).runtime!.operations[key];
    assert.equal(archived.prepared, undefined); assert.equal((archived.retiredPrepared![0] as { id: string }).id, old.id);
    const recovered = await next(sessionId, scope, ready.body.candidateId, events); assert.equal(recovered.status, 200);
    const main = recovered.body.turn as PreparedTurn; assert.equal(main.questionKind, 'main'); assert.notEqual(main.id, old.id);
    assert.equal((await fixture.control()).candidateCalls, counts.candidateCalls);
    const late = await fixture.request(`/api/sessions/${sessionId}/events`, { eventId: randomUUID(), type: 'acknowledgement_playing', turnId: old.id, clockId: randomUUID(), atMs: 5000 });
    assert.equal(late.status, 200, 'Retired prepared speech retains its canonical identity.');
    await fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 6000, metrics });
  });

  await t.test('an in-flight duplicate merges delayed playback before the original operation reserves its next question', async () => {
    const { sessionId, scope, events } = await twoUnreportedFollowUps();
    await fixture.control('/configure', { followUpNextCore: true }, false);
    const ready = await candidate(sessionId, scope); assert.equal(ready.status, 200);
    await fixture.control('/configure', { holdPreparation: true });
    const original = next(sessionId, scope, ready.body.candidateId);
    await poll(() => fixture.control(), state => state.preparationBlocked === true, 'next preparation held');
    const duplicate = next(sessionId, scope, ready.body.candidateId, events);
    await poll(() => fixture.saved(sessionId), saved => saved.followUpCountByMainQuestion[saved.turns[0].id] === 2, 'duplicate playback batch saved');
    const before = await fixture.control(); await fixture.control('/release-preparation', {});
    const [first, second] = await Promise.all([original, duplicate]); assert.equal(first.status, 200); assert.equal(second.status, 200);
    assert.equal((first.body.turn as PreparedTurn).questionKind, 'main');
    assert.equal((first.body.turn as PreparedTurn).id, (second.body.turn as PreparedTurn).id);
    assert.equal((await fixture.control()).candidateCalls, before.candidateCalls);
    await fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 6000, metrics });
  });

  for (const recoverable of [true, false]) await t.test(`an old unplayed repaired cache without proof ${recoverable ? 'reprepares from the exact candidate' : 'offers durable end when its original authority is absent'}`, async () => {
    const { sessionId, turn } = await fixture.start(), scope = await capture(sessionId, turn);
    await fixture.control('/configure', { followUpNextCore: true }, false);
    const ready = await candidate(sessionId, scope); assert.equal(ready.status, 200);
    await fixture.control('/configure', { failPreparedCommitSave: true, ...(recoverable ? { cacheRepairWithoutProof: true } : { cacheRepairWithoutAuthority: true }) });
    const failed = await next(sessionId, scope, ready.body.candidateId); assert.equal(failed.status, 502);
    const key = `${sessionId}:${scope.turnId}:${scope.answerId}`;
    const cached = (await fixture.saved(sessionId)).runtime!.operations[key].prepared as { id: string; draft: { questionText: string } };
    const counts = await fixture.control(), providers = await fixture.control('/state', undefined, false);
    const invalidated = await next(sessionId, scope, ready.body.candidateId);
    assert.equal(invalidated.status, 409);
    assert.equal(invalidated.body.code, recoverable ? 'QUESTION_REPAIR_PROOF_INVALID' : 'QUESTION_REPAIR_RECOVERY_UNAVAILABLE');
    const state = (await fixture.saved(sessionId)).runtime!.operations[key];
    assert.equal(state.prepared, undefined); assert.equal((state.retiredPrepared![0] as { id: string }).id, cached.id);
    const retried = await next(sessionId, scope, ready.body.candidateId);
    if (recoverable) {
      assert.equal(retried.status, 200); const question = retried.body.turn as PreparedTurn;
      assert.equal(question.questionKind, 'follow_up'); assert.notEqual(question.id, cached.id); assert.notEqual(question.questionText, cached.draft.questionText);
      const saved = await fixture.saved(sessionId), original = saved.runtime!.answerCandidates![String(ready.body.candidateId)].decision!.semanticDecision;
      assert.equal(question.questionText, original.next.question?.text);
    } else {
      assert.equal(retried.status, 409); assert.equal(retried.body.code, 'QUESTION_REPAIR_RECOVERY_UNAVAILABLE'); assert.equal(state.status, 'blocked');
      assert.equal((await fixture.saved(sessionId)).turns.length, 1);
    }
    assert.equal((await fixture.control()).candidateCalls, counts.candidateCalls);
    assert.equal((await fixture.control('/state', undefined, false)).coreCalls, providers.coreCalls);
    await fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 4000, metrics });
    assert.equal((await fixture.saved(sessionId)).turns[0].answerId, scope.answerId);
  });

  await t.test('failed observation save returns no receipt and makes no semantic request; retry saves each event once', async () => {
    const { sessionId, turn } = await fixture.start(), scope = await capture(sessionId, turn), event = playing(turn.id, 10);
    const before = await fixture.control(); await fixture.control('/configure', { failPlaybackBatchSave: true });
    const failed = await candidate(sessionId, scope, [event]); assert.equal(failed.status, 502); assert.equal(failed.body.acceptedClientEventIds, undefined);
    assert.equal((await fixture.control()).candidateCalls, before.candidateCalls);
    const ready = await candidate(sessionId, scope, [event, event]); assert.equal(ready.status, 200);
    assert.deepEqual(ready.body.acceptedClientEventIds, [event.eventId]);
    assert.equal((await fixture.saved(sessionId)).questionPresentationEventIds!.filter(id => id === event.eventId).length, 1);
    await fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 4000, metrics });
  });

  await t.test('the whole batch is validated before any observation mutates the session', async () => {
    const { sessionId, turn } = await fixture.start(), scope = await capture(sessionId, turn), event = playing(turn.id, 10);
    const rejected = await candidate(sessionId, scope, [event, playing(randomUUID(), 20)]); assert.equal(rejected.status, 409);
    assert.equal((await fixture.saved(sessionId)).questionPresentations?.length ?? 0, 0);
    assert.equal((await candidate(sessionId, scope, [{ ...event, type: 'phase_changed' } as unknown as ClientPlaybackEvent])).status, 400);
    assert.equal((await candidate(sessionId, scope, [event, { ...event, atMs: 11 }])).status, 409);
    await fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 4000, metrics });
  });

  await t.test('end intent during an observation save rejects the late candidate without starting its core', async () => {
    const { sessionId, turn } = await fixture.start(), scope = await capture(sessionId, turn), event = playing(turn.id, 10);
    const before = await fixture.control(); await fixture.control('/configure', { holdPlaybackBatchSave: true });
    const deciding = candidate(sessionId, scope, [event]);
    await poll(() => fixture.control(), state => state.playbackBatchSaveBlocked === true, 'observation save held');
    const ending = fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 4000, metrics });
    try {
      await poll(() => next(sessionId, scope, randomUUID()), response => response.status === 409 && String(response.body.error).includes('종료'), 'end intent accepted');
    } finally { await fixture.control('/release-playback-save', {}); }
    assert.equal((await deciding).status, 409); assert.equal((await ending).status, 202);
    assert.equal((await fixture.control()).candidateCalls, before.candidateCalls);
    const frozen = await fixture.saved(sessionId), presentation = structuredClone(frozen.questionPresentations);
    assert.equal((await candidate(sessionId, scope, [event])).status, 409);
    assert.deepEqual((await fixture.saved(sessionId)).questionPresentations, presentation);
  });
});
