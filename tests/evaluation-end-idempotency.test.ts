import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startStagedFixture } from './fixtures/staged-realtime-harness';

test('HTTP end freezes the first accepted source across repeated/concurrent requests and delayed browser events', { timeout: 90_000 }, async context => {
  const fixture = await startStagedFixture({ evaluationWorker: false }); context.after(() => fixture.close());
  const prepareAnswered = async () => {
    const started = await fixture.start(), answerId = randomUUID(), connection = await fixture.connect(started.sessionId);
    const scope = { turnId: started.turn.id, answerId, captureRevision: 1 };
    assert.equal((await connection.exchange({ type: 'start', ...scope }, 'started')).type, 'started');
    connection.ws.send(Buffer.alloc(3200), { binary: true });
    assert.equal((await connection.exchange({ type: 'finish', ...scope, staged: true }, 'finalized')).type, 'finalized');
    connection.close();
    return started;
  };
  await context.test('different repeat metrics and late audio completion are journalled without changing the source', async () => {
    const { sessionId, turn } = await prepareAnswered(), clockId = randomUUID();
    const event = (type: 'question_playing' | 'audio_ended' | 'phase_changed', atMs: number) => ({ eventId: randomUUID(), type, turnId: turn.id, clockId,
      phase: type === 'phase_changed' ? 'completed' : 'speaking_question', atMs, payload: { role: 'question', elapsedMs: atMs } });
    assert.equal((await fixture.request(`/api/sessions/${sessionId}/events`, event('question_playing', 100))).status, 200);
    const metrics = { acceptedMarker: 'first-snapshot', speech: { durationMs: 1000, speakingMs: 700, firstSpeechMs: 100 }, vision: { method: 'synthetic-turn-summary', records: [] } };
    const first = await fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 2000, metrics });
    assert.equal(first.status, 202);
    const saved = await fixture.saved(sessionId), reference = saved.runtime!.evaluationJob!;
    const sessionFile = path.join(fixture.directory, 'data/sessions', `${sessionId}.json`);
    const jobFile = path.join(fixture.directory, 'data/evaluation-jobs', `${reference.id}.job.json`);
    const snapshotFile = path.join(fixture.directory, 'data/evaluation-jobs', `${reference.id}.snapshot.json`);
    const [beforeSession, beforeJob, beforeSnapshot] = await Promise.all([readFile(sessionFile), readFile(jobFile), readFile(snapshotFile)]);
    assert.equal(saved.questionPresentations?.[0].completedAtMs, null);
    assert.equal((await fixture.request(`/api/sessions/${sessionId}/end`, { metrics: {}, elapsedMs: 9000 })).status, 202);
    assert.equal((await fixture.request(`/api/sessions/${sessionId}/end`, { metrics: { acceptedMarker: 'must-not-replace' }, elapsedMs: 12000 })).status, 202);
    assert.equal((await fixture.request(`/api/sessions/${sessionId}/events`, event('audio_ended', 500))).status, 200);
    assert.equal((await fixture.request(`/api/sessions/${sessionId}/events`, event('phase_changed', 600))).status, 200);
    assert.equal((await fixture.request(`/api/sessions/${sessionId}/timings`, { turnId: turn.id, clientTimings: { submitToQuestionMs: 100 } })).status, 200);
    const progress = await fixture.request(`/api/sessions/${sessionId}`);
    assert.equal(progress.status, 200); assert.equal(progress.body.evaluationStatus, 'pending');
    assert.deepEqual(await readFile(sessionFile), beforeSession);
    assert.deepEqual(await readFile(jobFile), beforeJob);
    assert.deepEqual(await readFile(snapshotFile), beforeSnapshot);
    const events = await fixture.logs(sessionId);
    assert.ok(events.some(row => row.type === 'playback.ended' && (row.payload as { lateAfterEvaluationFreeze?: boolean }).lateAfterEvaluationFreeze === true));
  });
  await context.test('concurrent first end requests share one commit and cannot replace each other metrics', async () => {
    const { sessionId } = await prepareAnswered();
    const responses = await Promise.all([
      fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 1000, metrics: { acceptedMarker: 'left', speech: { durationMs: 1000, speakingMs: 700 } } }),
      fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 9000, metrics: { acceptedMarker: 'right', speech: { durationMs: 9000, speakingMs: 4000 } } }),
    ]);
    assert.deepEqual(responses.map(response => response.status), [202, 202]);
    const saved = await fixture.saved(sessionId), reference = saved.runtime!.evaluationJob!;
    const snapshot = JSON.parse(await readFile(path.join(fixture.directory, 'data/evaluation-jobs', `${reference.id}.snapshot.json`), 'utf8'));
    const marker = (saved.metrics as { acceptedMarker: string }).acceptedMarker;
    assert.ok(['left', 'right'].includes(marker));
    assert.equal(snapshot.session.metrics.acceptedMarker, marker);
    assert.equal(snapshot.session.elapsedMs, saved.elapsedMs);
    const progress = await fixture.request(`/api/sessions/${sessionId}`);
    assert.equal(progress.status, 200); assert.equal(progress.body.evaluationStatus, 'pending');
  });
  await context.test('end commits one job before optional closing, and closing cannot change frozen source', async () => {
    const { sessionId } = await prepareAnswered();
    const ended = await fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 2500, metrics: { acceptedMarker: 'end-before-audio' } });
    assert.equal(ended.status, 202);
    const saved = await fixture.saved(sessionId), reference = saved.runtime!.evaluationJob!;
    const sessionFile = path.join(fixture.directory, 'data/sessions', `${sessionId}.json`);
    const snapshotFile = path.join(fixture.directory, 'data/evaluation-jobs', `${reference.id}.snapshot.json`);
    const [beforeSession, beforeSnapshot] = await Promise.all([readFile(sessionFile), readFile(snapshotFile)]);
    const closings = await Promise.all(Array.from({ length: 3 }, () => fixture.request(`/api/sessions/${sessionId}/closing`, { reason: 'user_ended', elapsedMs: 9000 })));
    assert.deepEqual(closings.map(response => response.status), [200, 200, 200]);
    const utterances = closings.map(response => response.body.closingUtterance as { id: string; audioUrl: string });
    assert.ok(utterances[0].audioUrl); assert.equal(new Set(utterances.map(value => value.id)).size, 1);
    for (const type of ['acknowledgement_playing', 'audio_ended']) assert.equal((await fixture.request(`/api/sessions/${sessionId}/events`, { eventId: randomUUID(), type, turnId: utterances[0].id, phase: 'closing', atMs: type === 'audio_ended' ? 200 : 100, clockId: randomUUID(), payload: { role: 'acknowledgement' } })).status, 200);
    const closingEvents = (await fixture.logs(sessionId)).filter(row => row.turnId === utterances[0].id && ['playback.started', 'playback.ended'].includes(String(row.type)));
    assert.equal(closingEvents.length, 2); assert.ok(closingEvents.every(row => row.role === 'closing'));
    assert.deepEqual(await readFile(sessionFile), beforeSession);
    assert.deepEqual(await readFile(snapshotFile), beforeSnapshot);
    assert.equal((await fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 19000, metrics: { acceptedMarker: 'retry-after-interrupted-audio' } })).status, 202);
    assert.equal((await fixture.saved(sessionId)).runtime!.evaluationJob!.id, reference.id);
    const metadata = await Promise.all((await readdir(path.join(fixture.directory, 'data/evaluation-jobs'))).filter(file => file.endsWith('.job.json')).map(file => readFile(path.join(fixture.directory, 'data/evaluation-jobs', file), 'utf8').then(JSON.parse)));
    assert.equal(metadata.filter(job => job.sessionId === sessionId).length, 1);
  });
  await context.test('HTTP end persists intent then waits for the ordered WS finish and retains final raw text', async () => {
    const { sessionId, turn } = await fixture.start(), answerId = randomUUID(), connection = await fixture.connect(sessionId);
    const scope = { turnId: turn.id, answerId, captureRevision: 1 };
    await connection.exchange({ type: 'start', ...scope }, 'started');
    connection.ws.send(Buffer.alloc(3200), { binary: true });
    const pendingEnd = fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 3500, metrics: { acceptedMarker: 'first-during-drain', captureFinishScope: scope,
      answers: [{ turnId: turn.id, answerId, speech: { durationMs: 3500, speakingMs: 2100 } }] } });
    let intent = await fixture.saved(sessionId);
    const intentDeadline = Date.now() + 5_000;
    while (!intent.runtime?.endRequestedAt && Date.now() < intentDeadline) { await sleep(10); intent = await fixture.saved(sessionId); }
    assert.ok(intent.runtime!.endRequestedAt, intent.runtime!.endRequestedAt ? '' : JSON.stringify({ message: 'end intention must be on disk while waiting for the socket barrier', response: await pendingEnd, events: (await fixture.logs(sessionId)).filter(row => row.type === 'error') }));
    assert.equal(intent.runtime!.evaluationJob, undefined);
    assert.equal(intent.runtime!.acceptedEndRequest!.metrics.acceptedMarker, 'first-during-drain');
    const retry = fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 9900, metrics: { acceptedMarker: 'must-not-replace-draining-input' } });
    connection.ws.send(JSON.stringify({ type: 'finish', ...scope, staged: false }));
    assert.deepEqual((await Promise.all([pendingEnd, retry])).map(value => value.status), [202, 202]);
    const saved = await fixture.saved(sessionId), final = saved.turns.at(-1)!;
    assert.equal(final.rawTranscript, '합성 테스트 응답입니다.');
    assert.equal(final.answerId, answerId); assert.equal(final.transcriptStatus, 'finalized');
    assert.equal(saved.elapsedMs, 3500); assert.equal((saved.metrics as { acceptedMarker: string }).acceptedMarker, 'first-during-drain');
    assert.ok(saved.runtime!.evaluationJob); connection.close();
  });
  await context.test('socket disappearance after durable end drains accepted audio without requiring a closing playback event', async () => {
    const { sessionId, turn } = await fixture.start(), answerId = randomUUID(), connection = await fixture.connect(sessionId);
    const scope = { turnId: turn.id, answerId, captureRevision: 1 };
    await connection.exchange({ type: 'start', ...scope }, 'started');
    connection.ws.send(Buffer.alloc(3200), { binary: true });
    const ending = fixture.request(`/api/sessions/${sessionId}/end`, { metrics: { captureFinishScope: scope } });
    let intent = await fixture.saved(sessionId);
    const deadline = Date.now() + 5000;
    while (!intent.runtime?.endRequestedAt && Date.now() < deadline) { await sleep(10); intent = await fixture.saved(sessionId); }
    assert.ok(intent.runtime?.endRequestedAt, intent.runtime?.endRequestedAt ? '' : JSON.stringify({ response: await ending, events: (await fixture.logs(sessionId)).filter(row => row.type === 'error') }));
    connection.close();
    assert.equal((await ending).status, 202);
    const saved = await fixture.saved(sessionId);
    assert.equal(saved.turns.at(-1)!.rawTranscript, '합성 테스트 응답입니다.');
    assert.equal(saved.turns.at(-1)!.transcriptStatus, 'finalized');
    assert.ok(saved.runtime!.evaluationJob);
  });
  await context.test('a stale end capture scope cannot freeze another answer', async () => {
    const { sessionId, turn } = await prepareAnswered();
    const result = await fixture.request(`/api/sessions/${sessionId}/end`, { metrics: { captureFinishScope: { turnId: turn.id, answerId: randomUUID(), captureRevision: 1 } } });
    assert.equal(result.status, 409);
    const saved = await fixture.saved(sessionId);
    assert.equal(saved.runtime!.endRequestedAt, undefined); assert.equal(saved.runtime!.evaluationJob, undefined);
  });
  await context.test('an opaque answer identity allowed by WS remains allowed by end', async () => {
    const { sessionId, turn } = await fixture.start(), answerId = 'opaque-answer-from-existing-contract', connection = await fixture.connect(sessionId);
    const scope = { turnId: turn.id, answerId, captureRevision: 1 };
    await connection.exchange({ type: 'start', ...scope }, 'started');
    connection.ws.send(Buffer.alloc(3200), { binary: true });
    connection.ws.send(JSON.stringify({ type: 'finish', ...scope, staged: false }));
    assert.equal((await fixture.request(`/api/sessions/${sessionId}/end`, { metrics: { captureFinishScope: scope } })).status, 202);
    assert.equal((await fixture.saved(sessionId)).turns.at(-1)!.answerId, answerId); connection.close();
  });
  await context.test('restart after accepted intent resumes one job beyond reconnect window without promoting unconfirmed speech', async () => {
    const started = await fixture.start(), seed = await fixture.saved(started.sessionId);
    seed.id = randomUUID(); seed.updatedAt = new Date(Date.now() - 20 * 60_000).toISOString();
    seed.runtime!.endRequestedAt = seed.updatedAt;
    seed.runtime!.checkpoint.disconnectedAt = seed.updatedAt;
    seed.runtime!.acceptedEndRequest = { elapsedMs: 4200, metrics: { acceptedMarker: 'persisted-before-crash' } };
    const turn = seed.turns.at(-1)!;
    turn.answerId = randomUUID(); turn.rawTranscript = '확정되지 않은 합성 전사'; turn.transcriptStatus = 'streaming';
    turn.metadata.answerSubmissionMode = 'staged-v2'; turn.metadata.answerCaptureRevision = 1; turn.metadata.lastStreamId = randomUUID();
    delete turn.metadata.captureParts;
    const sessionFile = path.join(fixture.directory, 'data/sessions', `${seed.id}.json`);
    await writeFile(sessionFile, JSON.stringify(seed));
    assert.equal((await fixture.request(`/api/sessions/${seed.id}`)).status, 200);
    const recovered = await fixture.saved(seed.id);
    assert.ok(recovered.runtime!.evaluationJob); assert.equal(recovered.status, 'ending');
    assert.equal(recovered.turns.at(-1)!.rawTranscript, turn.rawTranscript);
    assert.equal(recovered.turns.at(-1)!.transcriptStatus, 'error');
    assert.equal((recovered.metrics as { acceptedMarker: string }).acceptedMarker, 'persisted-before-crash');
    const source = await readFile(sessionFile);
    assert.equal((await fixture.request(`/api/sessions/${seed.id}/end`, { elapsedMs: 9900, metrics: { acceptedMarker: 'retry-must-not-replace' } })).status, 202);
    assert.deepEqual(await readFile(sessionFile), source);
  });
  await context.test('legacy ending without accepted intent is never automatically evaluated on read', async () => {
    const started = await fixture.start(), seed = await fixture.saved(started.sessionId);
    seed.id = randomUUID(); seed.status = 'ending'; seed.evaluationStatus = 'pending';
    const sessionFile = path.join(fixture.directory, 'data/sessions', `${seed.id}.json`);
    await writeFile(sessionFile, JSON.stringify(seed)); const before = await readFile(sessionFile);
    assert.equal((await fixture.request(`/api/sessions/${seed.id}`)).status, 200);
    assert.deepEqual(await readFile(sessionFile), before);
    assert.equal((await fixture.saved(seed.id)).runtime!.evaluationJob, undefined);
  });
  await context.test('an accepted frozen pointer recovers once with its original model even after the environment changes', async () => {
    const started = await prepareAnswered(), seed = await fixture.saved(started.sessionId);
    seed.id = randomUUID(); seed.status = 'ending'; seed.evaluationStatus = 'pending';
    seed.runtime!.endRequestedAt = new Date().toISOString();
    seed.runtime!.evaluationInputFrozenAt = seed.runtime!.endRequestedAt;
    seed.runtime!.acceptedEndRequest = { elapsedMs: 1800, metrics: { acceptedMarker: 'frozen-before-enqueue' } };
    // This ID is deliberately absent, like a pointer published just before a
    // process died. No existing user's job or source is changed.
    const pinnedModel = 'synthetic-original-model-before-restart';
    seed.runtime!.evaluationJob = { id: 'e'.repeat(64), pipelineVersion: 'evaluation-cluster-v3-explicit-quotes', sourceSha256: 'f'.repeat(64), model: pinnedModel };
    const { EVALUATION_PIPELINE_VERSION } = await import('../server/providers/evaluation-input');
    seed.runtime!.evaluationJob.pipelineVersion = EVALUATION_PIPELINE_VERSION;
    const sessionFile = path.join(fixture.directory, 'data/sessions', `${seed.id}.json`);
    await writeFile(sessionFile, JSON.stringify(seed));
    assert.equal((await fixture.request(`/api/sessions/${seed.id}`)).status, 200);
    const resumed = await fixture.saved(seed.id), reference = resumed.runtime!.evaluationJob!;
    assert.notEqual(reference.id, 'e'.repeat(64));
    const job = JSON.parse(await readFile(path.join(fixture.directory, 'data/evaluation-jobs', `${reference.id}.job.json`), 'utf8'));
    assert.equal(job.sessionId, seed.id); assert.equal(job.sourceSha256, reference.sourceSha256);
    assert.equal(reference.model, pinnedModel); assert.equal(job.model, pinnedModel);
    const snapshot = JSON.parse(await readFile(path.join(fixture.directory, 'data/evaluation-jobs', `${reference.id}.snapshot.json`), 'utf8'));
    assert.equal(snapshot.session.runtime.evaluationJob.model, pinnedModel);
    const source = await readFile(sessionFile);
    assert.equal((await fixture.request(`/api/sessions/${seed.id}`)).status, 200);
    assert.deepEqual(await readFile(sessionFile), source);
  });
});
