import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStagedFixture, poll } from './fixtures/staged-realtime-harness';
const metrics = { speech: { durationMs: 1_000, speakingMs: 700, firstSpeechMs: 100 } };
const endingObservation = { stopSource: 'button', lastSpeechMs: 800, trailingSilenceMs: 200, speechActiveAtEnd: false, vadAvailable: true };
type Json = Record<string, unknown>;

test('ordered voice submission owns one deadline through STT, candidate, next and cancellation', { timeout: 90_000 }, async context => {
  const fixture = await startStagedFixture(); context.after(() => fixture.close());
  const startCapture = async () => {
    const { sessionId, turn } = await fixture.start(), connection = await fixture.connect(sessionId);
    const scope = { turnId: turn.id, answerId: randomUUID(), captureRevision: 1, submissionAttemptId: randomUUID() };
    assert.equal((await connection.exchange({ type: 'start', ...scope }, 'started')).type, 'started');
    connection.ws.send(Buffer.alloc(3_200), { binary: true });
    return { sessionId, connection, scope };
  };
  const candidate = (sessionId: string, scope: Json) => fixture.request(`/api/sessions/${sessionId}/answer-candidate`, { ...scope, elapsedMs: 2_000, metrics, endingObservation });
  const next = (sessionId: string, scope: Json, candidateId: unknown) => fixture.request(`/api/sessions/${sessionId}/next`, { ...scope, candidateId, elapsedMs: 2_000, metrics });
  const advance = (milliseconds: number) => fixture.control('/advance-work-clock', { milliseconds });

  await context.test('STT consumes the same budget; candidate retry and changed ID cannot refresh it', async () => {
    const f = await startCapture();
    try {
      await fixture.control('/configure', { holdSttFinish: true });
      const final = f.connection.exchange({ type: 'finish', ...f.scope, staged: true }, 'finalized');
      await poll(() => fixture.control(), state => state.sttFinishBlocked === true, 'held STT');
      await advance(90_000); await fixture.control('/release-stt-finish'); assert.equal((await final).type, 'finalized');
      await fixture.control('/configure', { holdCandidate: true });
      const before = await fixture.control('/state', undefined, false), first = candidate(f.sessionId, f.scope);
      await poll(() => fixture.control(), state => state.candidateBlocked === true, 'held candidate');
      await advance(5_000);
      assert.equal((await first).body.code, 'TURN_WORK_TIMEOUT');
      const retry = await candidate(f.sessionId, f.scope); assert.equal(retry.status, 408); assert.equal(retry.body.code, 'TURN_WORK_TIMEOUT');
      assert.equal((await candidate(f.sessionId, { ...f.scope, submissionAttemptId: randomUUID() })).body.code, 'TURN_WORK_RETIRED');
      await fixture.control('/release-candidate');
      await poll(() => fixture.control(), state => state.candidateBlocked === false, 'late candidate release');
      const saved = await fixture.saved(f.sessionId); assert.equal(saved.turns.length, 1); assert.equal(saved.turns[0].rawTranscript, '합성 테스트 응답입니다.');
      assert.equal(saved.turns[0].metadata.answerCommitStatus, 'staged');
      assert.equal((await fixture.control('/state', undefined, false)).coreCalls, Number(before.coreCalls) + 1, 'late synthetic call is observed but cannot commit its decision');
    } finally { f.connection.close(); }
    assert.equal((await fixture.request(`/api/sessions/${f.sessionId}/end`, { elapsedMs: 3_000, metrics })).status, 202);
  });

  await context.test('scope-bound cancel bypasses blocked finish queue and end still drains raw speech/evaluation exactly once', async () => {
    const f = await startCapture();
    await fixture.control('/configure', { holdSttFinish: true });
    const terminal = f.connection.exchange({ type: 'finish', ...f.scope, staged: true }, 'finalized');
    await poll(() => fixture.control(), state => state.sttFinishBlocked === true, 'held STT cancellation');
    const before = await fixture.control('/state', undefined, false);
    f.connection.ws.send(JSON.stringify({ type: 'cancel_submission', ...f.scope, submissionAttemptId: randomUUID() }));
    f.connection.ws.send(JSON.stringify({ type: 'cancel_submission', ...f.scope }));
    await poll(() => fixture.saved(f.sessionId), saved => Object.values(saved.runtime?.submissionAttempts ?? {}).some(row => row.status === 'cancelled'), 'cancel before finish release');
    assert.equal((await fixture.control('/state', undefined, false)).sttCloses, before.sttCloses, 'cancelling generation never closes the capture producer');
    const end = fixture.request(`/api/sessions/${f.sessionId}/end`, { elapsedMs: 3_000, metrics: { ...metrics, captureFinishScope: f.scope } });
    await poll(() => fixture.saved(f.sessionId), saved => Boolean(saved.runtime?.endRequestedAt), 'durable end intent');
    await fixture.control('/release-stt-finish'); assert.equal((await terminal).type, 'error'); assert.equal((await end).status, 202);
    f.connection.close();
    const saved = await poll(() => fixture.evaluated(f.sessionId), saved => saved.evaluationStatus === 'completed', 'evaluation after cancelled STT wait');
    assert.equal(saved.turns[0].rawTranscript, '합성 테스트 응답입니다.'); assert.equal(saved.turns[0].transcriptStatus, 'finalized');
    const after = await fixture.control('/state', undefined, false); assert.equal(after.evaluationCalls, Number(before.evaluationCalls) + 1);
    assert.equal((await fixture.request(`/api/sessions/${f.sessionId}/end`, { elapsedMs: 9_000 })).status, 202);
    assert.equal((await fixture.control('/state', undefined, false)).evaluationCalls, after.evaluationCalls);
  });

  await context.test('cancel during cached decision execution rejects ignored-abort late preparation without ack/turn commit', async () => {
    const f = await startCapture();
    try {
      assert.equal((await f.connection.exchange({ type: 'finish', ...f.scope, staged: true }, 'finalized')).type, 'finalized');
      const decision = await candidate(f.sessionId, f.scope); assert.equal(decision.status, 200);
      await fixture.control('/configure', { holdPreparation: true });
      const pending = next(f.sessionId, f.scope, decision.body.candidateId);
      await poll(() => fixture.control(), state => state.preparationBlocked === true, 'held preparation');
      f.connection.ws.send(JSON.stringify({ type: 'cancel_submission', ...f.scope }));
      assert.equal((await pending).body.code, 'TURN_WORK_CANCELLED');
      await fixture.control('/release-preparation'); await poll(() => fixture.control(), state => state.preparationBlocked === false, 'late preparation released');
      const saved = await fixture.saved(f.sessionId); assert.equal(saved.turns.length, 1);
      assert.ok(!Object.values(saved.runtime!.operations).some(operation => operation.result?.turn));
      assert.ok(!(await fixture.logs(f.sessionId)).some(event => event.type === 'acknowledgement.prepared' && event.turnId !== f.scope.turnId));
    } finally { f.connection.close(); }
    await fixture.request(`/api/sessions/${f.sessionId}/end`, { elapsedMs: 3_000, metrics });
  });

  await context.test('durably committed operation keeps its UUID and replays after deadline without another core', async () => {
    const f = await startCapture();
    try {
      await f.connection.exchange({ type: 'finish', ...f.scope, staged: true }, 'finalized');
      const decision = await candidate(f.sessionId, f.scope), first = await next(f.sessionId, f.scope, decision.body.candidateId);
      assert.equal(first.status, 200); const id = (first.body.turn as Json).id;
      const before = await fixture.control('/state', undefined, false);
      await advance(96_000); const replay = await next(f.sessionId, f.scope, decision.body.candidateId);
      assert.equal(replay.status, 200); assert.equal((replay.body.turn as Json).id, id);
      assert.equal((await fixture.control('/state', undefined, false)).coreCalls, before.coreCalls);
      assert.equal((await fixture.saved(f.sessionId)).turns.length, 2);
    } finally { f.connection.close(); }
    await fixture.request(`/api/sessions/${f.sessionId}/end`, { elapsedMs: 3_000, metrics });
  });

  await context.test('uncommitted prepared cache cannot acquire a fresh budget after deadline', async () => {
    const f = await startCapture();
    try {
      await f.connection.exchange({ type: 'finish', ...f.scope, staged: true }, 'finalized');
      const decision = await candidate(f.sessionId, f.scope);
      await fixture.control('/configure', { failPreparedCommitSave: true });
      assert.equal((await next(f.sessionId, f.scope, decision.body.candidateId)).status, 502);
      const before = await fixture.control('/state', undefined, false); await advance(95_000);
      const retry = await next(f.sessionId, f.scope, decision.body.candidateId); assert.equal(retry.status, 408); assert.equal(retry.body.code, 'TURN_WORK_TIMEOUT');
      assert.equal((await fixture.control('/state', undefined, false)).coreCalls, before.coreCalls);
      assert.equal((await fixture.saved(f.sessionId)).turns.length, 1);
    } finally { f.connection.close(); }
    await fixture.request(`/api/sessions/${f.sessionId}/end`, { elapsedMs: 3_000, metrics });
  });

  await context.test('normal time-limit closing commits and returns done on its first response', async () => {
    const f = await startCapture();
    try {
      await f.connection.exchange({ type: 'finish', ...f.scope, staged: true }, 'finalized');
      const decision = await candidate(f.sessionId, f.scope);
      const result = await fixture.request(`/api/sessions/${f.sessionId}/next`, { ...f.scope, candidateId: decision.body.candidateId, elapsedMs: 720_000, metrics });
      assert.equal(result.status, 200); assert.equal(result.body.done, true); assert.equal(result.body.turn, null); assert.ok(result.body.closingUtterance);
      const saved = await fixture.saved(f.sessionId); assert.equal(saved.status, 'ending'); assert.equal(saved.turns.length, 1);
      assert.ok(Object.values(saved.runtime!.operations).some(operation => operation.status === 'committed' && operation.result?.done === true));
    } finally { f.connection.close(); }
    assert.equal((await fixture.request(`/api/sessions/${f.sessionId}/end`, { elapsedMs: 720_000, metrics })).status, 202);
  });

  await context.test('time-limit closing TTS shares the remaining submission budget while explicit end stays independent', async () => {
    const f = await startCapture();
    try {
      await f.connection.exchange({ type: 'finish', ...f.scope, staged: true }, 'finalized');
      const decision = await candidate(f.sessionId, f.scope); await advance(90_000);
      await fixture.control('/configure', { holdClosingTts: true });
      const pending = fixture.request(`/api/sessions/${f.sessionId}/next`, { ...f.scope, candidateId: decision.body.candidateId, elapsedMs: 720_000, metrics });
      await poll(() => fixture.control(), state => state.closingTtsBlocked === true, 'held terminal TTS');
      await advance(5_000); const failed = await pending;
      assert.equal(failed.status, 408); assert.equal(failed.body.code, 'TURN_WORK_TIMEOUT');
      await fixture.control('/release-closing-tts');
      await poll(() => fixture.control(), state => state.closingTtsBlocked === false, 'late terminal TTS');
      const saved = await fixture.saved(f.sessionId); assert.equal(saved.runtime?.closingUtterance, undefined); assert.equal(saved.status, 'active');
      assert.equal((await fixture.request(`/api/sessions/${f.sessionId}/end`, { elapsedMs: 720_000, metrics })).status, 202);
    } finally { f.connection.close(); }
  });
});
