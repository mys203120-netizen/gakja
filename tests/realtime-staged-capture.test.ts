import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStagedFixture, poll } from './fixtures/staged-realtime-harness';
import { AnswerCaptureLifecycle } from '../lib/interview/answer-capture';

type Json = Record<string, unknown>;
const endingObservation = { stopSource: 'space', lastSpeechMs: 800, trailingSilenceMs: 200, speechActiveAtEnd: false, vadAvailable: true, tailDrainMs: 160, requestedAtMs: 840 };
const metrics = { speech: { durationMs: 1_000, speakingMs: 700, firstSpeechMs: 100 } };

test('real HTTP/WS keeps staged capture separate from sole-core decision and answer commitment', { timeout: 90_000 }, async context => {
  const fixture = await startStagedFixture(); context.after(() => fixture.close());
  const capture = async (sessionId: string, turnId: string, answerId: string, captureRevision: number) => {
    const connection = await fixture.connect(sessionId);
    const scope = { turnId, answerId, captureRevision };
    const started = await connection.exchange({ type: 'start', ...scope }, 'started');
    assert.equal(started.type, 'started'); assert.equal(started.captureRevision, captureRevision); assert.equal(typeof started.streamId, 'string');
    connection.ws.send(Buffer.alloc(3_200), { binary: true });
    const finalized = await connection.exchange({ type: 'finish', ...scope, staged: true }, 'finalized');
    assert.equal(finalized.type, 'finalized'); assert.equal(finalized.captureRevision, captureRevision); assert.equal(finalized.streamId, started.streamId);
    return { ...connection, scope, finalized };
  };
  const candidate = (sessionId: string, scope: Json) => fixture.request(`/api/sessions/${sessionId}/answer-candidate`, { ...scope, elapsedMs: 2_000, metrics, endingObservation });

  for (const speechObservation of ['unknown', 'healthy_zero'] as const) await context.test(`empty STT with ${speechObservation} speech observation and disabled input continues without an F, advance or semantic call`, async () => {
    const { sessionId, turn } = await fixture.start(), answerId = randomUUID(), before = await fixture.control('/state', undefined, false);
    await fixture.control('/configure', { silentNextStream: true }, false);
    const connection = await capture(sessionId, turn.id, answerId, 1);
    try {
      assert.equal(connection.finalized.rawTranscript, '');
      const observed = speechObservation === 'healthy_zero';
      const unknownMetrics = { speech: { durationMs: 1_000, speakingMs: observed ? 0 : null, firstSpeechMs: null, vadAvailable: observed, vadCoverageComplete: observed } };
      const result = await fixture.request(`/api/sessions/${sessionId}/answer-candidate`, { ...connection.scope, elapsedMs: 2_000, metrics: unknownMetrics, endingObservation: { stopSource: 'space', lastSpeechMs: null, trailingSilenceMs: null, speechActiveAtEnd: null, vadAvailable: observed, microphoneEnabled: false } });
      assert.equal(result.status, 200); assert.equal(result.body.action, 'CONTINUE_ANSWER');
      const pending = await fixture.saved(sessionId);
      assert.equal(pending.turns.length, 1); assert.equal(pending.turns[0].id, turn.id); assert.equal(pending.turns[0].answerId, answerId);
      assert.equal(pending.turns[0].rawTranscript, ''); assert.equal(pending.turns[0].answerObservation, undefined, 'An uncommitted capture does not claim student silence or assess an answer');
      assert.equal(pending.turns[0].metadata.answerCommitStatus, 'continuing'); assert.equal(pending.turns[0].metadata.coreDecision, undefined);
      assert.equal(Object.values(pending.followUpCountByMainQuestion).reduce((sum, value) => sum + value, 0), 0);
      assert.equal(pending.runtime?.answerCandidates?.[String(result.body.candidateId)].decision?.semanticDecision.assessment, null);
      assert.equal(pending.runtime?.answerCandidates?.[String(result.body.candidateId)].endingObservation.microphoneEnabled, false);
      assert.equal((await fixture.control('/state', undefined, false)).coreCalls, before.coreCalls);
      const resumed = { ...connection.scope, captureRevision: 2 };
      assert.equal((await connection.exchange({ type: 'start', ...resumed }, 'started')).type, 'started');
      const active = await fixture.request(`/api/sessions/${sessionId}`), recovery = active.body.recovery as Json;
      assert.equal(recovery.captureRevision, 2); assert.equal(recovery.answerId, answerId); assert.equal(recovery.transcript, '');
      connection.ws.send(Buffer.alloc(3_200), { binary: true });
      const voiced = await connection.exchange({ type: 'finish', ...resumed, staged: true }, 'finalized');
      assert.equal(voiced.rawTranscript, '합성 테스트 응답입니다.');
      const durable = (await fixture.saved(sessionId)).turns[0];
      assert.equal(durable.metadata.answerCaptureRevision, 2); assert.equal(durable.metadata.captureParts?.length, 2);
      assert.equal((durable.metrics as { speech: { durationMs: number } }).speech.durationMs, 1_000);
    } finally { connection.close(); }
    await fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 3_000, metrics });
  });

  await context.test('known words still receive normal completion when the microphone observation is false', async () => {
    const { sessionId, turn } = await fixture.start(), answerId = randomUUID(), connection = await capture(sessionId, turn.id, answerId, 1);
    const before = await fixture.control('/state', undefined, false);
    try {
      const result = await fixture.request(`/api/sessions/${sessionId}/answer-candidate`, { ...connection.scope, elapsedMs: 2_000, metrics, endingObservation: { ...endingObservation, microphoneEnabled: false } });
      assert.equal(result.status, 200); assert.equal(result.body.action, 'ADVANCE');
      assert.equal(result.body.rawTranscript, '합성 테스트 응답입니다.');
      assert.equal((await fixture.control('/state', undefined, false)).coreCalls, Number(before.coreCalls) + 1);
    } finally { connection.close(); }
    await fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 3_000, metrics });
  });

  await context.test('healthy observed zero speech with enabled input follows replay rather than the disabled-input hold', async () => {
    const { sessionId, turn } = await fixture.start(), answerId = randomUUID(), before = await fixture.control('/state', undefined, false);
    await fixture.control('/configure', { silentNextStream: true }, false);
    const connection = await capture(sessionId, turn.id, answerId, 1);
    const zeroMetrics = { speech: { durationMs: 2_000, speakingMs: 0, firstSpeechMs: null, vadAvailable: true, vadCoverageComplete: true } };
    try {
      const result = await fixture.request(`/api/sessions/${sessionId}/answer-candidate`, { ...connection.scope, elapsedMs: 2_000, metrics: zeroMetrics, endingObservation: { ...endingObservation, microphoneEnabled: true } });
      assert.equal(result.status, 200); assert.equal(result.body.action, 'ADVANCE');
      const staged = await fixture.saved(sessionId);
      assert.equal(staged.runtime?.answerCandidates?.[String(result.body.candidateId)].decision?.semanticDecision.next.action, 'REPLAY');
      assert.equal(staged.turns[0].answerObservation, undefined);
      const next = await fixture.request(`/api/sessions/${sessionId}/next`, { ...connection.scope, candidateId: result.body.candidateId, metrics: zeroMetrics, elapsedMs: 2_000 });
      assert.equal(next.status, 200); assert.equal((next.body.turn as { questionKind: string }).questionKind, 'clarification');
      const saved = await fixture.saved(sessionId);
      assert.equal(saved.followUpCountByMainQuestion[turn.id], 0);
      assert.equal((await fixture.control('/state', undefined, false)).coreCalls, before.coreCalls);
    } finally { connection.close(); }
    await fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 3_000 });
  });

  await context.test('provider errors carry capture scope and lose client authority after a replacement capture starts', async () => {
    const { sessionId, turn } = await fixture.start(), answerId = randomUUID(), connection = await fixture.connect(sessionId);
    const scope = { turnId: turn.id, answerId, captureRevision: 1 };
    try {
      await fixture.control('/configure', { failNextStreamAtConstruction: true }, false);
      const failure = await connection.exchange({ type: 'start', ...scope }, 'error');
      assert.equal(failure.turnId, turn.id); assert.equal(failure.answerId, answerId); assert.equal(failure.captureRevision, 1); assert.equal(typeof failure.streamId, 'string');
      const resumed = { ...scope, captureRevision: 2 };
      const started = await connection.exchange({ type: 'start', ...resumed }, 'started');
      assert.equal(started.type, 'started');
      const client = new AnswerCaptureLifecycle(); client.begin(turn.id, answerId, 2);
      client.bindStream({ ...resumed, streamId: String(started.streamId) });
      assert.equal(client.acceptsTranscript(failure), false, 'The production error guard uses the same capture authority check');
      connection.ws.send(Buffer.alloc(3_200), { binary: true });
      assert.equal((await connection.exchange({ type: 'finish', ...resumed, staged: true }, 'finalized')).type, 'finalized');
    } finally { connection.close(); }
    await fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 2_000, metrics });
  });

  await context.test('a delayed old final save never relabels its transcript as a replacement capture', async () => {
    const { sessionId, turn } = await fixture.start(), answerId = randomUUID(), old = await fixture.connect(sessionId);
    const scope = { turnId: turn.id, answerId, captureRevision: 1 }, oldEvents: Json[] = [];
    old.ws.on('message', raw => { oldEvents.push(JSON.parse(raw.toString()) as Json); });
    let replacement: Awaited<ReturnType<typeof fixture.connect>> | undefined;
    try {
      const started = await old.exchange({ type: 'start', ...scope }, 'started'); assert.equal(started.type, 'started');
      await fixture.control('/configure', { holdCaptureFinalSave: true });
      old.ws.send(Buffer.alloc(3_200), { binary: true }); old.ws.send(JSON.stringify({ type: 'finish', ...scope, staged: true }));
      await poll(() => fixture.control(), state => state.captureSaveBlocked === true, 'old capture final save blocked');
      replacement = await fixture.connect(sessionId);
      const resumed = { ...scope, captureRevision: 2 };
      assert.equal((await replacement.exchange({ type: 'start', ...resumed }, 'started')).type, 'started');
      replacement.ws.send(Buffer.alloc(3_200), { binary: true });
      await fixture.control('/release-capture-save', {});
      assert.equal((await replacement.exchange({ type: 'finish', ...resumed, staged: true }, 'finalized')).type, 'finalized');
      for (const event of oldEvents.filter(event => event.type === 'finalized')) {
        assert.equal(event.captureRevision, 1); assert.equal(event.streamId, started.streamId);
        assert.equal(event.rawTranscript, '합성 테스트 응답입니다.');
      }
      assert.equal((await fixture.saved(sessionId)).turns[0].metadata.answerCaptureRevision, 2);
    } finally { await fixture.control('/release-capture-save', {}); old.close(); replacement?.close(); }
    await fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 2_000, metrics });
  });

  await context.test('duplicate staged finish consumes one provider final; stale capture revisions cannot change its raw text', async () => {
    const { sessionId, turn } = await fixture.start(), answerId = randomUUID();
    const before = await fixture.control(), connection = await capture(sessionId, turn.id, answerId, 1);
    try {
      const snapshot = (await fixture.saved(sessionId)).turns[0];
      assert.equal(snapshot.transcriptStatus, 'paused'); assert.equal(snapshot.metadata.answerCommitStatus, 'staged');
      const duplicate = await connection.exchange({ type: 'finish', ...connection.scope, staged: true }, 'finalized');
      assert.equal(duplicate.rawTranscript, connection.finalized.rawTranscript);
      assert.equal(duplicate.streamId, connection.finalized.streamId);
      assert.equal((await fixture.control()).providerFinishes, Number(before.providerFinishes) + 1);
      const stale = await connection.exchange({ type: 'start', ...connection.scope }, 'started');
      assert.equal(stale.type, 'error');
      assert.equal((await candidate(sessionId, { ...connection.scope, captureRevision: 2 })).status, 409);
      const after = (await fixture.saved(sessionId)).turns[0];
      assert.equal(after.rawTranscript, snapshot.rawTranscript); assert.equal(after.metadata.answerCaptureRevision, 1);
    } finally { connection.close(); }
    assert.equal((await fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 2_000, metrics })).status, 202);
  });

  await context.test('deciding, advance ready, next running and committed states reject late starts without another core call', async () => {
    const { sessionId, turn } = await fixture.start(), answerId = randomUUID();
    const connection = await capture(sessionId, turn.id, answerId, 1), original = String(connection.finalized.rawTranscript);
    const before = await fixture.control('/state', undefined, false), stagedBefore = await fixture.control();
    try {
      await fixture.control('/configure', { holdCandidate: true });
      const decision = candidate(sessionId, connection.scope), duplicateDecision = candidate(sessionId, connection.scope);
      await poll(() => fixture.control(), state => state.candidateBlocked === true, 'candidate decision blocked');
      const late = { type: 'start', ...connection.scope, captureRevision: 2 };
      assert.equal((await connection.exchange(late, 'started')).type, 'error');
      assert.equal((await fixture.saved(sessionId)).turns[0].rawTranscript, original);
      await fixture.control('/release-candidate', {});
      const [ready, duplicate] = await Promise.all([decision, duplicateDecision]);
      assert.equal(ready.status, 200); assert.equal(ready.body.action, 'ADVANCE');
      assert.equal(duplicate.body.candidateId, ready.body.candidateId);
      assert.equal((await connection.exchange(late, 'started')).type, 'error');
      await fixture.control('/configure', { holdPreparation: true });
      const next = fixture.request(`/api/sessions/${sessionId}/next`, { ...connection.scope, candidateId: ready.body.candidateId, metrics, elapsedMs: 3_000 });
      await poll(() => fixture.control(), state => state.preparationBlocked === true, 'next preparation blocked');
      assert.equal((await connection.exchange(late, 'started')).type, 'error');
      await fixture.control('/release-preparation', {});
      assert.equal((await next).status, 200);
      assert.equal((await connection.exchange(late, 'started')).type, 'error');
      assert.equal((await fixture.request(`/api/sessions/${sessionId}/next`, { ...connection.scope, candidateId: randomUUID(), metrics, elapsedMs: 3_000 })).status, 409);
      assert.equal((await fixture.request(`/api/sessions/${sessionId}/next`, { ...connection.scope, captureRevision: 2, candidateId: ready.body.candidateId, metrics, elapsedMs: 3_000 })).status, 409);
      const saved = await fixture.saved(sessionId);
      assert.equal(saved.turns[0].rawTranscript, original); assert.equal(saved.turns[0].answerId, answerId);
      assert.equal(saved.turns[0].metadata.answerCaptureRevision, 1); assert.equal(saved.turns[0].metadata.answerCommitStatus, 'committed');
      assert.equal((await fixture.control('/state', undefined, false)).coreCalls, Number(before.coreCalls) + 1);
      assert.equal((await fixture.control()).candidateReuse, Number(stagedBefore.candidateReuse) + 1);
    } finally { await fixture.control('/release-candidate', {}); await fixture.control('/release-preparation', {}); connection.close(); }
    await fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 3_000 });
  });

  await context.test('CONTINUE preserves question and answer, appends a new stream, and invalidates an old advancement candidate', async () => {
    const { sessionId, turn } = await fixture.start(), answerId = randomUUID();
    const first = await capture(sessionId, turn.id, answerId, 1);
    try {
      await fixture.control('/configure', { nextContinue: true });
      const continued = await candidate(sessionId, first.scope);
      assert.equal(continued.status, 200); assert.equal(continued.body.action, 'CONTINUE_ANSWER');
      const firstSaved = (await fixture.saved(sessionId)).turns[0], part = structuredClone(firstSaved.metadata.captureParts?.[0]);
      assert.equal(firstSaved.transcriptStatus, 'paused'); assert.equal(firstSaved.metadata.answerCommitStatus, 'continuing');
      assert.equal((await fixture.saved(sessionId)).turns.length, 1);
      const resumedScope = { ...first.scope, captureRevision: 2 };
      assert.equal((await first.exchange({ type: 'start', ...resumedScope }, 'started')).type, 'started');
      first.ws.send(Buffer.alloc(3_200), { binary: true });
      assert.equal((await first.exchange({ type: 'finish', ...resumedScope, staged: true }, 'finalized')).type, 'finalized');
      const appended = (await fixture.saved(sessionId)).turns[0];
      assert.equal(appended.answerId, answerId); assert.equal(appended.id, turn.id);
      assert.equal(appended.rawTranscript, `${first.finalized.rawTranscript} ${first.finalized.rawTranscript}`);
      assert.equal(appended.metadata.captureParts?.length, 2); assert.deepEqual(appended.metadata.captureParts?.[0], part);
      assert.equal((await fixture.request(`/api/sessions/${sessionId}/next`, { ...first.scope, candidateId: continued.body.candidateId, metrics, elapsedMs: 3_000 })).status, 409);
      assert.equal((await candidate(sessionId, first.scope)).status, 409);
      assert.equal((await candidate(sessionId, resumedScope)).body.action, 'ADVANCE');
    } finally { first.close(); }
    await fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 3_000, metrics });
  });

  await context.test('a candidate whose source changes during its async decision cannot be accepted', async () => {
    const { sessionId, turn } = await fixture.start(), answerId = randomUUID();
    const connection = await capture(sessionId, turn.id, answerId, 1);
    try {
      await fixture.control('/configure', { mutateCandidateSource: true });
      const rejected = await candidate(sessionId, connection.scope);
      assert.equal(rejected.status, 409);
      const saved = await fixture.saved(sessionId);
      assert.equal(saved.turns[0].metadata.answerCommitStatus, 'staged');
      assert.equal(saved.turns.length, 1);
    } finally { connection.close(); }
    await fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 2_000, metrics });
  });

  await context.test('retrying a failed postdecision save reuses its source-bound decision without another core call', async () => {
    const { sessionId, turn } = await fixture.start(), answerId = randomUUID();
    const connection = await capture(sessionId, turn.id, answerId, 1), before = await fixture.control(), coreBefore = await fixture.control('/state', undefined, false);
    try {
      await fixture.control('/configure', { failCandidateDecisionSave: true });
      assert.equal((await candidate(sessionId, connection.scope)).status, 502);
      const failed = await fixture.saved(sessionId), bound = Object.values(failed.runtime?.answerCandidates ?? {})[0];
      assert.ok(bound?.decision); assert.equal(bound.status, 'failed'); assert.equal(failed.turns[0].metadata.answerCommitStatus, 'staged');
      const retried = await candidate(sessionId, connection.scope);
      assert.equal(retried.status, 200); assert.equal(retried.body.action, 'ADVANCE'); assert.equal(retried.body.candidateId, bound.id);
      assert.equal((await fixture.control()).candidateCalls, Number(before.candidateCalls) + 1);
      assert.equal((await fixture.control()).candidateSaveFailures, Number(before.candidateSaveFailures) + 1);
      assert.equal((await fixture.control('/state', undefined, false)).coreCalls, Number(coreBefore.coreCalls) + 1);
    } finally { connection.close(); }
    await fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 2_000, metrics });
  });

  await context.test('explicit end commits staged STT without reopening capture or calling the semantic core', async () => {
    const { sessionId, turn } = await fixture.start(), answerId = randomUUID();
    const connection = await capture(sessionId, turn.id, answerId, 1), before = await fixture.control('/state', undefined, false), stagedBefore = await fixture.control();
    connection.close();
    assert.equal((await fixture.request(`/api/sessions/${sessionId}/closing`, { reason: 'user_ended', elapsedMs: 2_000 })).status, 200);
    assert.equal((await fixture.saved(sessionId)).turns[0].transcriptStatus, 'finalized');
    assert.equal((await fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 2_000, metrics })).status, 202);
    const saved = await poll(() => fixture.evaluated(sessionId), session => session.evaluationStatus === 'completed', 'ended staged answer evaluated');
    assert.equal(saved.turns[0].answerId, answerId); assert.equal(saved.turns[0].rawTranscript, connection.finalized.rawTranscript);
    assert.equal(saved.turns[0].transcriptStatus, 'finalized'); assert.equal(saved.turns[0].metadata.answerCommitStatus, 'committed');
    assert.equal((await fixture.control('/state', undefined, false)).coreCalls, before.coreCalls);
    assert.equal((await fixture.control()).providerFinishes, stagedBefore.providerFinishes);
  });

  await context.test('explicit end wins while a candidate request remains in flight and its late result cannot advance', async () => {
    const { sessionId, turn } = await fixture.start(), answerId = randomUUID();
    const connection = await capture(sessionId, turn.id, answerId, 1);
    try {
      await fixture.control('/configure', { holdCandidate: true, nextContinue: true });
      const decision = candidate(sessionId, connection.scope);
      await poll(() => fixture.control(), state => state.candidateBlocked === true, 'ending candidate blocked');
      assert.equal((await fixture.request(`/api/sessions/${sessionId}/closing`, { reason: 'user_ended', elapsedMs: 2_000 })).status, 200);
      // The old socket epoch is retired by closing; its late start is ignored.
      connection.ws.send(JSON.stringify({ type: 'start', ...connection.scope, captureRevision: 2 }));
      assert.equal((await fixture.request(`/api/sessions/${sessionId}/next`, { ...connection.scope, candidateId: randomUUID(), metrics, elapsedMs: 2_000 })).status, 409);
      await fixture.control('/release-candidate', {});
      assert.equal((await decision).status, 409);
      assert.equal((await fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 2_000, metrics })).status, 202);
      const saved = await poll(() => fixture.evaluated(sessionId), session => session.evaluationStatus === 'completed', 'inflight candidate ended');
      assert.equal(saved.turns.length, 1); assert.equal(saved.turns[0].rawTranscript, connection.finalized.rawTranscript);
      assert.equal(saved.turns[0].transcriptStatus, 'finalized'); assert.equal(saved.turns[0].metadata.answerCommitStatus, 'committed');
      assert.equal(saved.turns[0].metadata.answerCaptureRevision, 1);
    } finally { await fixture.control('/release-candidate', {}); connection.close(); }
  });
});
