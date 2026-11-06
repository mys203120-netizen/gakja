import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { build } from 'esbuild';
import { WebSocket } from 'ws';
import { startSyntheticEvaluationWorker } from './fixtures/evaluation-worker-harness';

const workspace = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
async function port() { const s = net.createServer(); await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve)); const p = (s.address() as net.AddressInfo).port; await new Promise<void>(resolve => s.close(() => resolve())); return p; }
async function poll<T>(read: () => Promise<T>, valid: (value: T) => boolean) { for (let i = 0; i < 200; i++) { try { const value = await read(); if (valid(value)) return value; } catch { /* bounded startup/read retry */ } await sleep(25); } throw new Error('Synthetic restart fixture timed out'); }
async function stop(child?: ChildProcessWithoutNullStreams, force = false) { if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill(force ? 'SIGKILL' : 'SIGTERM'); }); }
test('actual HTTP/socket flow pins preparation, persists next results, closes with the same voice and restores after restart', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'interview-runtime-flow-')); let child: ChildProcessWithoutNullStreams | undefined;
  let diagnostic = '';
  let worker: Awaited<ReturnType<typeof startSyntheticEvaluationWorker>> | undefined;
  try {
    const outfile = path.join(directory, 'runtime.cjs'), main = path.join(workspace, 'server/realtime.ts'), providers = path.join(workspace, 'tests/fixtures/realtime-providers.ts'), context = path.join(workspace, 'tests/fixtures/runtime-context.ts');
    const bundled = await build({ entryPoints: [main], outfile, bundle: true, metafile: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent', plugins: [{ name: 'explicit-no-network-providers', setup(builder) {
      builder.onResolve({ filter: /^\.\/(?:providers\/(?:openai|clova-tts|clova-stt|answer-reaction|realtime-core|single-core-runtime|approved-restatement)|data\/prepared-question-bank)$/ }, args => args.importer === main ? { path: providers } : undefined);
      builder.onResolve({ filter: /^\.\/data\/load-interview-context$/ }, args => args.importer === main ? { path: context } : undefined);
    } }] });
    assert.ok(!Object.keys(bundled.metafile!.inputs).some(input => /server[\\/]providers[\\/](?:openai|clova-stt|clova-tts)\.ts$/u.test(input)));
    const realPort = await port(), webPort = await port(), origin = `http://127.0.0.1:${webPort}`, base = `http://127.0.0.1:${realPort}`;
    let controlPort = 0;
    const launch = async () => {
      controlPort = await port();
      const env: NodeJS.ProcessEnv = { INTERVIEW_EXECUTION_MODE: 'local-development', NODE_ENV: 'test', REALTIME_PORT: String(realPort), WEB_PORT: String(webPort), RECOVERY_TEST_CONTROL_PORT: String(controlPort), RECOVERY_TEST_TOKEN: 'explicit-synthetic-token', OPENAI_API_KEY: 'synthetic-test-only', CLOVA_SPEECH_SECRET_KEY: 'synthetic-only', CLOVA_VOICE_CLIENT_ID: 'synthetic-only', CLOVA_VOICE_CLIENT_SECRET: 'synthetic-only', LOCAL_INTERVIEW_OWNER_ID: 'owner-runtime-fixture' };
      for (const name of ['SystemRoot', 'PATH', 'Path', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[name]) env[name] = process.env[name];
      child = spawn(process.execPath, [outfile], { cwd: directory, env, windowsHide: true, stdio: 'pipe' }); child.stdout.resume(); child.stderr.on('data', value => { diagnostic = (diagnostic + String(value)).slice(-4000); });
      await poll(() => fetch(`${base}/api/health`), row => row.ok);
      worker ??= await startSyntheticEvaluationWorker(directory, env);
    };
    const control = async (route: string, body?: unknown) => (await fetch(`http://127.0.0.1:${controlPort}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Recovery-Test-Token': 'explicit-synthetic-token', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json();
    const request = async (route: string, body?: unknown) => { const response = await fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const value = await response.json(); assert.ok(response.ok, `${response.status}: ${JSON.stringify(value)}`); return value; };
    await launch();
    const prepared = await request('/api/prepare', {});
    assert.equal((await fetch(`${base}/api/sessions`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ preparationId: randomUUID() }) })).status, 409);
    const started = await request('/api/sessions', { preparationId: prepared.preparationId }), id = started.sessionId, first = started.turn;
    assert.equal(first.acknowledgement, '안녕하세요. 면접을 시작하겠습니다.');
    assert.equal((await fetch(`${base}/api/sessions`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ preparationId: prepared.preparationId }) })).status, 409);
    const clockId = randomUUID();
    const event = (type: string, turnId: string, atMs: number, payload?: unknown) => request(`/api/sessions/${id}/events`, { eventId: randomUUID(), type, turnId, atMs, clockId, ...(payload ? { payload } : {}) });
    await event('acknowledgement_playing', first.id, 1); await event('audio_ended', first.id, 5, { role: 'acknowledgement' });
    await event('question_playing', first.id, 10); await event('audio_ended', first.id, 20, { role: 'question' });
    await request(`/api/sessions/${id}/events`, { eventId: randomUUID(), type: 'phase_changed', phase: 'listening', turnId: first.id, atMs: 21, clockId, payload: { elapsedMs: 1234, checkpoint: true } });
    const ws = new WebSocket(`ws://127.0.0.1:${realPort}/api/realtime?sessionId=${id}`, { origin }); await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    const answerId = randomUUID(), messages: Array<Record<string, unknown>> = []; ws.on('message', bytes => messages.push(JSON.parse(bytes.toString())));
    ws.send(JSON.stringify({ type: 'start', turnId: first.id, answerId })); await poll(async () => messages, rows => rows.some(row => row.type === 'started'));
    ws.send(Buffer.alloc(320)); await poll(async () => messages, rows => rows.some(row => row.type === 'transcript'));
    // Restart during an unfinished capture: only saved partial words may survive.
    ws.close(); await new Promise<void>(resolve => ws.once('close', () => resolve())); await sleep(100); await stop(child); await launch();
    const recovered = await request(`/api/sessions/${id}`); assert.equal(recovered.recovery.transcript, '합성 테스트'); assert.notEqual(recovered.recovery.transcriptStatus, 'finalized'); assert.equal(recovered.recovery.answerId, answerId); assert.equal(recovered.recovery.currentTurn.acknowledgement, null);
    assert.equal(recovered.recovery.elapsedMs, 1234);
    const ws2 = new WebSocket(`ws://127.0.0.1:${realPort}/api/realtime?sessionId=${id}`, { origin }); await new Promise<void>(resolve => ws2.once('open', () => resolve())); const replies: Array<Record<string, unknown>> = []; ws2.on('message', bytes => replies.push(JSON.parse(bytes.toString())));
    ws2.send(JSON.stringify({ type: 'start', turnId: first.id, answerId })); await poll(async () => replies, rows => rows.some(row => row.type === 'started')); ws2.send(Buffer.alloc(320)); ws2.send(JSON.stringify({ type: 'finish', turnId: first.id, answerId })); await poll(async () => replies, rows => rows.some(row => row.type === 'finalized'));
    const body = { turnId: first.id, answerId, elapsedMs: 2500 };
    await control('/configure', { holdNextQuestionTts: true, followUpNextCore: true });
    const response = await fetch(`${base}/api/sessions/${id}/next`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(body) });
    const reader = response.body!.getReader(), decoder = new TextDecoder(); let line = '';
    while (!line.includes('\n')) { const bytes = await reader.read(); assert.equal(bytes.done, false); line += decoder.decode(bytes.value, { stream: true }); }
    const early = JSON.parse(line.split('\n')[0]); assert.equal(early.type, 'acknowledgement_ready');
    await event('acknowledgement_playing', early.turnId, 23); await event('audio_ended', early.turnId, 24, { role: 'acknowledgement' });
    const during = JSON.parse(await readFile(path.join(directory, 'data/sessions', `${id}.json`), 'utf8'));
    assert.equal(during.runtime.operations[`${id}:${first.id}:${answerId}`].prepared.id, early.turnId);
    // Keep the exact precommit snapshot as a second synthetic session so one
    // process restart exercises both unfinished and durably committed work.
    const expired = structuredClone(during), expiredId = randomUUID(); expired.id = expiredId;
    expired.runtime.operations = Object.fromEntries(Object.entries(expired.runtime.operations).map(([key, value]) => [key.replace(`${id}:`, `${expiredId}:`), value]));
    await writeFile(path.join(directory, 'data/sessions', `${expiredId}.json`), JSON.stringify(expired));
    await control('/release-question-tts', {});
    await poll(async () => JSON.parse(await readFile(path.join(directory, 'data/sessions', `${id}.json`), 'utf8')), row => row.runtime.operations[`${id}:${first.id}:${answerId}`].status === 'committed');
    ws2.close(); await stop(child, true); await reader.cancel().catch(() => {}); await launch();
    for (let retry = 0; retry < 2; retry++) {
      const rejected = await fetch(`${base}/api/sessions/${expiredId}/next`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(rejected.status, 408); assert.equal((await rejected.json()).code, 'TURN_WORK_TIMEOUT');
    }
    const expiredSaved = JSON.parse(await readFile(path.join(directory, 'data/sessions', `${expiredId}.json`), 'utf8'));
    assert.equal(expiredSaved.turns[0].rawTranscript, during.turns[0].rawTranscript);
    assert.equal(expiredSaved.turns.length, 1); assert.equal(expiredSaved.runtime.operations[`${expiredId}:${first.id}:${answerId}`].prepared.id, early.turnId);
    assert.deepEqual(expiredSaved.runtime.operations[`${expiredId}:${first.id}:${answerId}`].acknowledgementDelivery, during.runtime.operations[`${id}:${first.id}:${answerId}`].acknowledgementDelivery);
    assert.equal(expiredSaved.runtime.operations[`${expiredId}:${first.id}:${answerId}`].result, undefined);
    assert.equal((await control('/state')).coreInvocations, 0);
    await request(`/api/sessions/${expiredId}/end`, { elapsedMs: 2500 });
    const next = await request(`/api/sessions/${id}/next`, body); assert.equal(next.turn.id, early.turnId); assert.equal(next.turn.acknowledgement, null); assert.equal((await control('/state')).coreInvocations, 0);
    await stop(child);
    // Persist an explicitly retired synthetic preparation, then verify its late
    // acknowledgement still resolves canonically after all process maps vanish.
    const archiveFile = path.join(directory, 'data/sessions', `${id}.json`);
    const archivedSession = JSON.parse(await readFile(archiveFile, 'utf8'));
    const operation = archivedSession.runtime.operations[`${id}:${first.id}:${answerId}`];
    const retiredId = randomUUID(); operation.retiredPrepared = [{ ...structuredClone(operation.prepared), id: retiredId }];
    await writeFile(archiveFile, JSON.stringify(archivedSession));
    await launch();
    const repeated = await request(`/api/sessions/${id}/next`, body); assert.equal(repeated.turn.id, next.turn.id);
    await event('acknowledgement_playing', retiredId, 25);
    assert.equal((await request(`/api/sessions/${id}`)).recovery.currentTurn.id, next.turn.id, 'A late retired acknowledgement never changes the committed question.');
    const closing = (await request(`/api/sessions/${id}/closing`, {})).closingUtterance; assert.equal(closing.interviewerId, first.interviewerId); assert.equal(closing.nonEvaluative, true);
    assert.equal((await request(`/api/sessions/${id}/closing`, {})).closingUtterance.id, closing.id);
    await event('acknowledgement_playing', closing.id, 30, { role: 'closing' }); await event('audio_ended', closing.id, 40, { role: 'closing' });
    await request(`/api/sessions/${id}/end`, { elapsedMs: 2500 }); await poll(() => request(`/api/sessions/${id}`), row => row.evaluationStatus === 'completed');
    const before = JSON.parse(await readFile(path.join(directory, 'data/sessions', `${id}.json`), 'utf8'));
    assert.equal(before.runtime.firstEvaluationDelivery.turnId, first.id); assert.equal(before.runtime.firstEvaluationDelivery.entitlementLedgerImplemented, false);
    await stop(child); await launch(); const completed = await request(`/api/sessions/${id}`);
    assert.equal(completed.status, 'completed'); assert.equal(completed.recovery.closingDelivered, true);
    const after = JSON.parse(await readFile(path.join(directory, 'data/sessions', `${id}.json`), 'utf8')); assert.deepEqual(after.turns, before.turns);
    // Simulate a crash after durable end intent but before final STT/enqueue.
    // Observe files after launch, without a GET that could trigger recovery.
    const interrupted = structuredClone(before);
    interrupted.id = randomUUID(); interrupted.status = 'active'; interrupted.evaluationStatus = 'pending';
    delete interrupted.evaluation; delete interrupted.evaluationError; delete interrupted.runtime.evaluationJob; delete interrupted.runtime.evaluationInputFrozenAt;
    const oldTime = new Date(Date.now() - 20 * 60_000).toISOString();
    interrupted.runtime.endRequestedAt = oldTime;
    interrupted.runtime.acceptedEndRequest = { elapsedMs: 3300, metrics: { acceptedMarker: 'startup-end-intent' } };
    interrupted.runtime.checkpoint.disconnectedAt = oldTime;
    const unfinished = interrupted.turns.at(-1);
    unfinished.answerId = randomUUID(); unfinished.rawTranscript = '중단된 미확정 합성 발화'; unfinished.transcriptStatus = 'streaming';
    unfinished.metadata.answerSubmissionMode = 'staged-v2'; unfinished.metadata.answerCaptureRevision = 1; unfinished.metadata.lastStreamId = randomUUID();
    delete unfinished.metadata.captureParts;
    const interruptedFile = path.join(directory, 'data/sessions', `${interrupted.id}.json`);
    await writeFile(interruptedFile, JSON.stringify(interrupted));
    await stop(child); await launch();
    const accepted = await poll(async () => JSON.parse(await readFile(interruptedFile, 'utf8')), row => Boolean(row.runtime.evaluationJob));
    assert.equal(accepted.turns.at(-1).rawTranscript, '중단된 미확정 합성 발화');
    assert.equal(accepted.turns.at(-1).transcriptStatus, 'error');
    assert.equal(accepted.metrics.acceptedMarker, 'startup-end-intent');
    const acceptedBytes = await readFile(interruptedFile), acceptedJob = accepted.runtime.evaluationJob.id;
    await stop(child); await launch();
    assert.deepEqual(await readFile(interruptedFile), acceptedBytes);
    assert.equal(JSON.parse(await readFile(interruptedFile, 'utf8')).runtime.evaluationJob.id, acceptedJob);
  } catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}\nIsolated server: ${diagnostic}`); }
  finally { await worker?.close(); await stop(child); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('interview-runtime-flow-')); await rm(directory, { recursive: true, force: true }); }
});
