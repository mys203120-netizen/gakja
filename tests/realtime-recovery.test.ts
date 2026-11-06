import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { build } from "esbuild";
import { WebSocket, type RawData } from "ws";
import { interviewConfig } from "../interview.config";
import { InterviewClientEventJournal, type InterviewClientEvent } from "../lib/interview/client-events";
import { publicServiceError } from "../lib/interview/service-errors";
import type { InterviewSession, PreparedTurn } from "../server/protocol";
import { aggregateSessionEvaluation, questionPresentationIssue } from "../server/providers/evaluation-aggregation";
import { startSyntheticEvaluationWorker } from './fixtures/evaluation-worker-harness';

type Json = Record<string, unknown>;
const workspace = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
async function unusedPort() {
  const server = net.createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const port = address.port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function poll<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeoutMs = 12000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await sleep(10); }
  throw new Error(`Synthetic recovery fixture timed out: ${label}`);
}
async function stopChild(child: ChildProcessWithoutNullStreams | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill(); });
}
async function removeOwnedDirectory(directory: string) {
  const absolute = path.resolve(directory);
  assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
  assert.ok(path.basename(absolute).startsWith("interview-recovery-"));
  await rm(absolute, { recursive: true, force: true });
}
async function startFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "interview-recovery-"));
  let child: ChildProcessWithoutNullStreams | undefined;
  let worker: Awaited<ReturnType<typeof startSyntheticEvaluationWorker>> | undefined;
  try {
    for (const [role, relative] of Object.entries(interviewConfig.files)) {
      if (role === "sourceManifest") continue;
      const target = path.resolve(directory, relative);
      assert.ok(path.relative(directory, target) && !path.relative(directory, target).startsWith(".."));
      await mkdir(path.dirname(target), { recursive: true }); await copyFile(path.join(workspace, relative), target);
    }
    const outfile = path.join(directory, "realtime-test.cjs"), fixture = path.join(workspace, "tests", "fixtures", "realtime-providers.ts");
    const bundle = await build({ entryPoints: [path.join(workspace, "server", "realtime.ts")], outfile, bundle: true, metafile: true, platform: "node", format: "cjs", target: "node22", logLevel: "silent", plugins: [{ name: "synthetic-provider-boundaries", setup(builder) { builder.onResolve({ filter: /^\.\/(?:providers\/(?:openai|clova-tts|clova-stt|answer-reaction|realtime-core|single-core-runtime|approved-restatement)|data\/prepared-question-bank)$/ }, args => args.importer === path.join(workspace, "server", "realtime.ts") ? { path: fixture } : undefined); builder.onResolve({ filter: /^\.\/data\/load-interview-context$/ }, args => args.importer === path.join(workspace, 'server', 'realtime.ts') ? { path: path.join(workspace, 'tests/fixtures/recovery-context.ts') } : undefined); builder.onResolve({ filter: /^pdfjs-dist\/legacy\/build\/pdf\.mjs$/ }, () => ({ path: pathToFileURL(path.join(workspace, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href, external: true })); } }] });
    const inputs = Object.keys(bundle.metafile!.inputs).map(input => input.replaceAll("\\", "/"));
    assert.ok(inputs.some(input => input.endsWith("tests/fixtures/realtime-providers.ts")), "Synthetic providers must be present before starting the child");
    assert.ok(!inputs.some(input => /(?:^|\/)server\/(?:providers\/(?:openai|clova-tts|clova-stt|answer-reaction|realtime-core|single-core-runtime|approved-restatement)|data\/prepared-question-bank)\.ts$/u.test(input)), "Live provider/core/bank implementations must never enter the explicit recovery fixture bundle");
    const port = await unusedPort(), webPort = await unusedPort(), controlPort = await unusedPort(), token = randomUUID();
    const environment: NodeJS.ProcessEnv = { INTERVIEW_EXECUTION_MODE: 'local-development', NODE_ENV: "test" };
    for (const name of ["SystemRoot", "PATH", "Path", "COMSPEC", "TEMP", "TMP", "USERPROFILE"]) if (process.env[name]) environment[name] = process.env[name]!;
    Object.assign(environment, { REALTIME_PORT: String(port), WEB_PORT: String(webPort), RECOVERY_TEST_CONTROL_PORT: String(controlPort), RECOVERY_TEST_TOKEN: token, OPENAI_API_KEY: "synthetic-test-only", CLOVA_SPEECH_SECRET_KEY: "synthetic-test-only", CLOVA_VOICE_CLIENT_ID: "synthetic-test-only", CLOVA_VOICE_CLIENT_SECRET: "synthetic-test-only" });
    // No .env.local in this owned temporary CWD; dotenv cannot read the real secret file.
    const running = spawn(process.execPath, [outfile], { cwd: directory, env: environment, stdio: "pipe", windowsHide: true });
    child = running; running.stdout.resume(); running.stderr.resume();
    const base = `http://127.0.0.1:${port}`, origin = `http://127.0.0.1:${webPort}`;
    const rawControl = async (route = "/state", body?: Json) => {
      const response = await fetch(`http://127.0.0.1:${controlPort}${route}`, { method: body === undefined ? "GET" : "POST", headers: { "X-Recovery-Test-Token": token, "Content-Type": "application/json", Connection: 'close' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200); return await response.json() as Json;
    };
    const control = async (route = '/state', body?: Json): Promise<Json> => {
      if (!worker) return rawControl(route, body);
      if (route === '/reset') {
        await Promise.all([rawControl(route, body), worker.control(route, body)]);
        await worker.drain(); await worker.control(route, body); return rawControl(route, body);
      }
      const local = await rawControl(route, body);
      if (route === '/configure' || route === '/release-save') await worker.control(route, body);
      if (body === undefined) {
        const remote = await worker.control();
        return { ...local, evaluationCalls: remote.evaluationCalls, evaluationSaveFailures: remote.evaluationSaveFailures,
          evaluationSaveBlocked: remote.evaluationSaveBlocked };
      }
      return local;
    };
    await poll(async () => { if (child!.exitCode !== null) throw new Error("Isolated synthetic server exited during startup"); try { return (await fetch(`${base}/api/health`, { headers: { Connection: 'close' }, signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, Boolean, "server startup", 20000);
    const sourceStatus = await (await fetch(`${base}/api/status`, { headers: { Connection: 'close' } })).json();
    assert.deepEqual(sourceStatus.errors, [], 'The isolated server must verify the actual copied PDF and current guide sources');
    worker = await startSyntheticEvaluationWorker(directory, environment);
    await control();
    const request = async (route: string, body?: unknown) => {
      const response = await fetch(`${base}${route}`, { method: body === undefined ? "GET" : "POST", headers: { Origin: origin, "Content-Type": "application/json", Connection: 'close' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12000) });
      assert.ok(response.ok, `Synthetic endpoint status ${response.status}`); return await response.json() as Json;
    };
    const start = async () => { const prepared = await request("/api/prepare", {}); const session = await request("/api/sessions", { preparationId: prepared.preparationId }); return { sessionId: session.sessionId as string, turn: session.turn as PreparedTurn }; };
    const answer = async (sessionId: string, turn: PreparedTurn, options: { silent?: boolean; expectFailure?: boolean; failureAt?: 'write' | 'construction' | 'finish' | 'late-partial'; elapsedMs?: number; answerId?: string; pause?: boolean; expectedTranscript?: string } = {}) => {
      if (options.silent || options.expectFailure) await control("/configure", { silentNextStream: Boolean(options.silent), failNextStream: Boolean(options.expectFailure && options.failureAt !== 'construction' && options.failureAt !== 'finish'), failNextStreamAtConstruction: options.failureAt === 'construction', failNextStreamAtFinish: options.failureAt === 'finish', lateTranscriptAfterFailure: options.failureAt === 'late-partial' });
      const answerId = options.answerId ?? randomUUID(), socket = new WebSocket(`ws://127.0.0.1:${port}/api/realtime?sessionId=${sessionId}`, { origin });
      const waiting = new Map<string, { resolve: (value: Json) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
      const publicErrors: Json[] = [];
      socket.on("message", raw => { const event = JSON.parse(raw.toString()) as Json; const pending = waiting.get(String(event.type)); if (pending) { clearTimeout(pending.timer); waiting.delete(String(event.type)); pending.resolve(event); } if (event.type === "error") { publicErrors.push(event); for (const entry of waiting.values()) entry.reject(new Error("Synthetic WS error")); } });
      const wait = (type: string) => new Promise<Json>((resolve, reject) => { const timer = setTimeout(() => { waiting.delete(type); reject(new Error(`Synthetic WS ${type} timeout`)); }, 5000); waiting.set(type, { resolve, reject, timer }); });
      let failed = false;
      try {
        await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
        const started = wait("started"); socket.send(JSON.stringify({ type: "start", turnId: turn.id, answerId })); await started;
        socket.send(Buffer.alloc(3200), { binary: true });
        const finalized = wait(options.pause ? "paused" : "finalized"); socket.send(JSON.stringify({ type: options.pause ? "pause" : "finish", turnId: turn.id, answerId }));
        const result = await finalized; assert.equal(result.rawTranscript, options.expectedTranscript ?? (options.silent ? "" : "합성 테스트 응답입니다."));
      } catch (error) {
        if (!options.expectFailure) throw error;
        failed = true; assert.match(String(error), /Synthetic WS error/u);
      } finally { socket.close(); for (const pending of waiting.values()) clearTimeout(pending.timer); }
      if (options.expectFailure) assert.equal(failed, true);
      return { turnId: turn.id, answerId, publicErrors, elapsedMs: options.elapsedMs ?? 20000, metrics: { speech: { durationMs: options.silent ? 5000 : 100, speakingMs: options.silent ? 0 : null, firstSpeechMs: null }, verification: { syntheticProvider: true } } };
    };
    const next = async (sessionId: string, body: unknown, onProgress?: (event: Json) => Promise<void>) => {
      const response = await fetch(`${base}/api/sessions/${sessionId}/next`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Accept: "application/x-ndjson", Connection: 'close' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
      // Before any streamed audio is available, errors retain their real HTTP
      // status and JSON body. Normalize only this fixture's event representation.
      if (!response.ok) { const error = await response.json() as Json; return { status: response.status, events: [{ type: 'error', ...error, message: error.error }] as Json[] }; }
      if (!onProgress || !response.body) { const text = await response.text(); return { status: response.status, events: text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Json) }; }
      const reader = response.body.getReader(), decoder = new TextDecoder(), events: Json[] = []; let pending = "";
      const consume = async (line: string) => { if (!line.trim()) return; const event = JSON.parse(line) as Json; events.push(event); await onProgress(event); };
      try { while (true) { const chunk = await reader.read(); if (chunk.done) break; pending += decoder.decode(chunk.value, { stream: true }); let newline; while ((newline = pending.indexOf("\n")) >= 0) { await consume(pending.slice(0, newline)); pending = pending.slice(newline + 1); } } pending += decoder.decode(); await consume(pending); }
      finally { reader.releaseLock(); }
      return { status: response.status, events };
    };
    const saved = async (sessionId: string) => JSON.parse(await readFile(path.join(directory, "data", "sessions", `${sessionId}.json`), "utf8")) as InterviewSession;
    const evaluated = async (sessionId: string) => {
      const snapshot = await saved(sessionId), projection = await request(`/api/sessions/${sessionId}`);
      return { ...snapshot, status: projection.status, evaluationStatus: projection.evaluationStatus,
        evaluation: projection.evaluation, evaluationError: projection.evaluationError } as InterviewSession;
    };
    const job = async (sessionId: string) => (await worker!.jobs()).find(item => item.sessionId === sessionId);
    const logs = async (sessionId: string): Promise<Array<Record<string, any>>> => { try { return (await readFile(path.join(directory, 'data/conversation-logs', `${sessionId}.jsonl`), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } };
    return { base, origin, directory, control, request, start, answer, next, saved, evaluated, job, logs, async close() { await worker?.close(); await stopChild(child); await removeOwnedDirectory(directory); } };
  } catch (error) { await worker?.close(); await stopChild(child); await removeOwnedDirectory(directory); throw error; }
}

test("real realtime HTTP/WS recovers provider faults without external APIs", { timeout: 150000 }, async context => {
  const fixture = await startFixture(); context.after(() => fixture.close());
  const clientJournal = (sessionId: string) => {
    const journal = new InterviewClientEventJournal((id, event) => fixture.request(`/api/sessions/${id}/events`, event));
    journal.bind(sessionId, 1);
    return {
      journal,
      async emit(event: Omit<InterviewClientEvent, 'eventId' | 'clockId'>) {
        const id = journal.emit({ sessionId, epoch: 1 }, { ...event, payload: { ...(event.payload as Json ?? {}), verification: 'synthetic-browser-event' } });
        assert.ok(id); await journal.flush(sessionId); assert.equal(journal.status().failedWrites, 0);
        return journal.snapshot(sessionId).find(item => item.eventId === id)!;
      },
    };
  };
  await context.test('offline Q0 uses no runtime generation/core/question TTS and the opening is a separate non-evaluative utterance', async () => {
    await fixture.control('/reset', {}); const { sessionId, turn } = await fixture.start();
    const bytes = await (await fetch(`${fixture.base}${turn.questionAudioUrl}`, { headers: { Connection: 'close' } })).arrayBuffer();
    assert.ok(Buffer.from(bytes).toString().startsWith('ID3-explicit-offline-synthetic-audio:'));
    const counters = await fixture.control();
    assert.equal(counters.generationCalls, 0); assert.equal(counters.coreCalls, 0); assert.equal(counters.coreInvocations, 0);
    assert.equal(counters.questionTtsAttempts, 0); assert.equal(counters.bankHits, 1); assert.equal(counters.offlinePreparedCandidates, (await fixture.request('/api/status')).mainQuestionCount as number * 2); assert.equal(counters.openingTtsAttempts, 1);
    await fixture.request(`/api/sessions/${sessionId}/end`, {});
  });
  await context.test("same-answer pause and reconnect survives a follow-up TTS failure through presented playback and the following accepted answer", async () => {
    await fixture.control('/reset', {}); const { sessionId, turn } = await fixture.start(), client = clientJournal(sessionId);
    await client.emit({ type: 'question_playing', turnId: turn.id, phase: 'speaking_question', atMs: 10 });
    await client.emit({ type: 'audio_ended', turnId: turn.id, phase: 'speaking_question', atMs: 100, payload: { role: 'question' } });
    await client.emit({ type: 'phase_changed', turnId: turn.id, phase: 'listening', atMs: 101 });
    const answerId = randomUUID();
    await fixture.answer(sessionId, turn, { answerId, pause: true, elapsedMs: 10000 });
    const paused = (await fixture.saved(sessionId)).turns[0];
    assert.equal(paused.answerId, answerId); assert.equal(paused.transcriptStatus, 'paused'); assert.equal(paused.rawTranscript, '합성 테스트 응답입니다.');
    const firstStreamId = paused.metadata.lastStreamId; assert.ok(firstStreamId);
    const resumedText = '합성 테스트 응답입니다. 합성 테스트 응답입니다.';
    const resumed = await fixture.answer(sessionId, turn, { answerId, expectedTranscript: resumedText, elapsedMs: 20000 });
    const finalized = (await fixture.saved(sessionId)).turns[0];
    assert.equal(finalized.answerId, answerId); assert.equal(finalized.transcriptStatus, 'finalized'); assert.equal(finalized.rawTranscript, resumedText);
    assert.notEqual(finalized.metadata.lastStreamId, firstStreamId); assert.equal(finalized.sttObservations?.length, 2);
    assert.equal((await fixture.control()).pcmBytes, 6400, 'The two real test PCM chunks are consumed once each, without replaying the paused capture');
    await fixture.control('/configure', { failNextQuestionTts: true });
    const failed = await fixture.next(sessionId, resumed); assert.equal(failed.events.at(-1)?.type, 'error');
    const reservedId = failed.events.find(event => event.type === 'acknowledgement_ready')?.turnId; assert.ok(reservedId);
    const recovered = await fixture.next(sessionId, resumed), next = recovered.events.find(event => event.type === 'turn_ready')?.turn as PreparedTurn | undefined;
    assert.ok(next); assert.equal(next.id, reservedId);
    const duplicate = await fixture.next(sessionId, resumed);
    assert.equal((duplicate.events.find(event => event.type === 'turn_ready')?.turn as PreparedTurn).id, next.id);
    assert.equal((await fixture.control()).coreCalls, 1);
    const playing = await client.emit({ type: 'question_playing', turnId: next.id, phase: 'speaking_question', atMs: 1000 });
    await client.emit({ type: 'client_error', turnId: next.id, phase: 'error', atMs: 1050, payload: { message: 'Synthetic playback interruption' } });
    const interrupted = (await fixture.saved(sessionId)).questionPresentations?.find(item => item.turnId === next.id);
    assert.equal(interrupted?.interrupted, true); assert.ok(interrupted?.errorCodes?.includes('QUESTION_DELIVERY_ERROR'));
    const repeated = await fixture.request(`/api/sessions/${sessionId}/events`, playing); assert.equal(repeated.duplicate, true);
    await client.emit({ type: 'question_playing', turnId: next.id, phase: 'speaking_question', atMs: 1100 });
    const ended = await client.emit({ type: 'audio_ended', turnId: next.id, phase: 'speaking_question', atMs: 1200, payload: { role: 'question' } });
    const listening = await client.emit({ type: 'phase_changed', turnId: next.id, phase: 'listening', atMs: 1201 });
    const delivered = (await fixture.saved(sessionId)).questionPresentations?.find(item => item.turnId === next.id);
    assert.ok(delivered);
    const { attempts, activeAttemptId, ...projection } = delivered;
    assert.deepEqual(projection, { turnId: next.id, rootTurnId: next.parentMainQuestionId, questionKind: next.questionKind, clockId: playing.clockId, startedAtMs: 1000, completedAtMs: 1200, interrupted: false, errorCodes: [] });
    assert.equal(attempts?.length, 1); assert.equal(activeAttemptId, playing.eventId);
    assert.equal(attempts[0].eventIds.length, 4); assert.ok(attempts[0].eventIds.includes(playing.eventId)); assert.ok(attempts[0].eventIds.includes(ended.eventId));
    assert.equal(playing.clockId, ended.clockId); assert.equal(ended.clockId, listening.clockId); assert.equal(questionPresentationIssue(delivered), null);
    const followingAnswer = await fixture.answer(sessionId, next, { elapsedMs: 30000 }); assert.notEqual(followingAnswer.answerId, answerId);
    const following = await fixture.next(sessionId, followingAnswer), unplayed = following.events.find(event => event.type === 'turn_ready')?.turn as PreparedTurn | undefined;
    assert.ok(unplayed); assert.equal(unplayed.mainIndex, 2);
    const continued = await fixture.saved(sessionId);
    assert.equal(continued.status, 'active', 'The next answer is accepted before session completion is requested');
    assert.equal(continued.turns[0].rawTranscript, resumedText); assert.equal(continued.turns[1].answerId, followingAnswer.answerId);
    assert.equal(continued.turns[1].transcriptStatus, 'finalized'); assert.equal(continued.questionPresentations?.length, 2);
    assert.equal(continued.questionPresentations?.some(item => item.turnId === unplayed.id), false, 'A prepared third question is absent from the presentation denominator');
    await fixture.request(`/api/sessions/${sessionId}/end`, { metrics: { clientEventsBackup: client.journal.snapshot(sessionId), verification: { syntheticBrowserEvents: true } }, elapsedMs: 30000 });
    const completed = await poll(() => fixture.evaluated(sessionId), value => value.evaluationStatus === 'completed', 'continued recovery evaluation persisted');
    assert.equal((completed.evaluation as { aggregation: { N_total: number } }).aggregation.N_total, 1, 'The presented Q0 and F belong to one root; the unplayed next root is excluded');
    assert.equal(new Set(completed.questionPresentationEventIds).size, completed.questionPresentationEventIds?.length);
    const rows = await poll(() => fixture.logs(sessionId), values => values.some(row => row.type === 'answer.relevance' && row.turnId === next.id), 'following answer accepted and journalled');
    const captures = rows.filter(row => row.type === 'stt.started' && row.turnId === turn.id);
    assert.equal(captures.length, 2); assert.equal(captures[0].answerId, answerId); assert.equal(captures[1].answerId, answerId);
    assert.equal(captures[1].payload.resumed, true); assert.equal(captures[1].payload.rawTranscript, '합성 테스트 응답입니다.');
    assert.notEqual(captures[0].payload.streamId, captures[1].payload.streamId);
    const pausedRow = rows.find(row => row.type === 'stt.paused' && row.turnId === turn.id)!;
    const finalRow = rows.find(row => row.type === 'stt.final' && row.turnId === turn.id)!;
    const reaction = rows.find(row => row.type === 'answer.relevance' && row.turnId === turn.id)!;
    const playedRow = rows.find(row => row.eventId === playing.eventId)!, endedRow = rows.find(row => row.eventId === ended.eventId)!, listeningRow = rows.find(row => row.eventId === listening.eventId)!;
    const nextCapture = rows.find(row => row.type === 'stt.started' && row.turnId === next.id)!, nextFinal = rows.find(row => row.type === 'stt.final' && row.turnId === next.id)!;
    assert.ok(pausedRow.seq < captures[1].seq && captures[1].seq < finalRow.seq && finalRow.seq < reaction.seq);
    assert.ok(reaction.seq < playedRow.seq && playedRow.seq < endedRow.seq && endedRow.seq < listeningRow.seq && listeningRow.seq < nextCapture.seq && nextCapture.seq < nextFinal.seq);
    assert.equal(rows.filter(row => row.eventId === playing.eventId).length, 1);
  });
  await context.test('approved common Q0 authority survives actual runtime preparation and its next core call', async () => {
    await fixture.control('/reset', {}); await fixture.control('/configure', { commonMainNext: true });
    const { sessionId, turn } = await fixture.start(); assert.deepEqual(turn.evidenceIds, []);
    const prepared = await fixture.saved(sessionId); assert.equal(prepared.turns[0].metadata.commonApproval?.kind, 'COMMON_APPROVED');
    const answer = await fixture.answer(sessionId, turn), result = await fixture.next(sessionId, answer);
    assert.ok(result.events.some(event => event.type === 'turn_ready')); assert.equal((await fixture.control()).coreCalls, 1);
    await fixture.request(`/api/sessions/${sessionId}/end`, {});
  });
  await context.test("completed evaluation without question playback or another capture does not establish conversation continuation", async () => {
    await fixture.control('/reset', {}); const { sessionId } = await fixture.start();
    await fixture.request(`/api/sessions/${sessionId}/end`, {});
    const completed = await poll(() => fixture.evaluated(sessionId), value => value.evaluationStatus === 'completed', 'unplayed session evaluation completed');
    assert.equal(completed.status, 'completed'); assert.equal(completed.turns.length, 1); assert.deepEqual(completed.questionPresentations, []);
    const evaluation = completed.evaluation as { aggregation: { N_total: number; N_valid: number; reasonCodes: string[] }; sessionScore: number | null };
    assert.equal(evaluation.aggregation.N_total, 0); assert.equal(evaluation.aggregation.N_valid, 0); assert.equal(evaluation.sessionScore, null);
    assert.ok(evaluation.aggregation.reasonCodes.includes('NO_PRESENTED_CLUSTERS'));
    const rows = await poll(() => fixture.logs(sessionId), values => values.some(row => row.type === 'evaluation.status' && row.payload.status === 'completed'), 'unplayed completion journal');
    assert.equal(rows.some(row => row.type === 'playback.started' || row.type === 'stt.started' || row.type === 'stt.final'), false);
  });
  await context.test("question completion from a different client clock remains durably unverified even after a finalized answer", async () => {
    await fixture.control('/reset', {}); const { sessionId, turn } = await fixture.start();
    const beforeReconnect = clientJournal(sessionId), afterReconnect = clientJournal(sessionId);
    const playing = await beforeReconnect.emit({ type: 'question_playing', turnId: turn.id, phase: 'speaking_question', atMs: 100 });
    const ended = await afterReconnect.emit({ type: 'audio_ended', turnId: turn.id, phase: 'speaking_question', atMs: 200, payload: { role: 'question' } });
    assert.notEqual(playing.clockId, ended.clockId);
    const answered = await fixture.answer(sessionId, turn);
    await fixture.request(`/api/sessions/${sessionId}/end`, { metrics: answered.metrics });
    const completed = await poll(() => fixture.evaluated(sessionId), value => value.evaluationStatus === 'completed', 'clock-conflict session completed');
    const record = completed.questionPresentations?.[0]; assert.ok(record);
    assert.equal(record.clockId, playing.clockId); assert.equal(record.completedAtMs, null); assert.ok(record.errorCodes?.includes('PRESENTATION_CLOCK_CONFLICT'));
    assert.equal(completed.turns[0].transcriptStatus, 'finalized');
    const aggregation = aggregateSessionEvaluation(completed, [{ turnId: turn.id, status: 'PARTIAL', score: 50 }]);
    assert.equal(aggregation.aggregation.N_total, 1); assert.equal(aggregation.aggregation.N_valid, 0); assert.equal(aggregation.sessionScore, null);
    assert.ok(aggregation.clusterScores[0].exclusionReasons.some(reason => reason.code === 'QUESTION_DELIVERY_ERROR'));
  });
  await context.test("ack published before question TTS failure keeps its draft, UUID and cached audio on retry", async () => {
    await fixture.control("/reset", {}); const { sessionId, turn } = await fixture.start();
    const answer = await fixture.answer(sessionId, turn); await fixture.control("/configure", { failNextQuestionTts: true });
    const failed = await fixture.next(sessionId, answer); assert.equal(failed.status, 200);
    const firstAck = failed.events.find(event => event.type === "acknowledgement_ready");
    assert.ok(firstAck); assert.equal(failed.events.at(-1)?.type, "error");
    assert.equal(failed.events.at(-1)?.message, publicServiceError('connection'));
    const privateFailure = await poll(() => fixture.logs(sessionId), rows => rows.some(row => row.type === 'error' && String(row.payload.message).includes('SYNTHETIC_QUESTION_TTS_FAILURE')), 'private TTS diagnostic retained');
    assert.ok(privateFailure.some(row => String(row.payload.message).includes('SYNTHETIC_QUESTION_TTS_FAILURE')));
    const retried = await fixture.next(sessionId, answer); assert.equal(retried.status, 200);
    const repeatedAck = retried.events.find(event => event.type === "acknowledgement_ready"), ready = retried.events.find(event => event.type === "turn_ready");
    assert.ok(repeatedAck && ready?.turn); const next = ready.turn as PreparedTurn;
    assert.equal(repeatedAck.turnId, firstAck.turnId); assert.equal(next.id, firstAck.turnId);
    assert.equal(repeatedAck.acknowledgementAudioUrl, firstAck.acknowledgementAudioUrl);
    assert.equal((await fetch(`${fixture.base}${String(repeatedAck.acknowledgementAudioUrl)}`, { headers: { Connection: 'close' } })).status, 200);
    const stats = await fixture.control(); assert.equal(stats.generationCalls, 0); assert.equal(stats.coreCalls, 1); assert.equal(stats.questionTtsFailures, 1); assert.equal(stats.acknowledgementTtsProviderCalls, 1);
    const saved = await fixture.saved(sessionId); assert.equal(saved.turns.length, 2); assert.equal(saved.turns[1].metadata.providerTimings?.draftCacheHit, 1);
    await fixture.request(`/api/sessions/${sessionId}/end`, {});
  });
  await context.test('early acknowledgement TTS failure retries the cached core decision and joins pending follow-up TTS', async () => {
    await fixture.control('/reset', {}); const { sessionId, turn } = await fixture.start();
    const answer = await fixture.answer(sessionId, turn);
    await fixture.control('/configure', { failNextAcknowledgementTts: true, holdNextQuestionTts: true, followUpNextCore: true });
    const failed = await fixture.next(sessionId, answer); assert.equal(failed.events.at(-1)?.type, 'error');
    assert.equal(failed.events.some(event => event.type === 'acknowledgement_ready'), false);
    const blocked = await fixture.control(); assert.equal(blocked.questionTtsBlocked, true); assert.equal(blocked.coreCalls, 1); assert.equal(blocked.acknowledgementTtsFailures, 1);
    let reservedId: string | undefined, resolveAck!: () => void;
    const ackReady = new Promise<void>(resolve => { resolveAck = resolve; });
    const retried = fixture.next(sessionId, answer, async event => { if (event.type === 'acknowledgement_ready') { reservedId = String(event.turnId); resolveAck(); } });
    await Promise.race([ackReady, retried.then(() => { throw new Error('Synthetic retry ended before its acknowledgement'); }), sleep(8000, undefined, { ref: false }).then(() => { throw new Error('Synthetic retry acknowledgement timed out'); })]);
    assert.equal((await fixture.control()).coreCalls, 1, 'Retry must reuse the same core decision instead of starting another model request');
    await fixture.control('/release-question-tts', {});
    const recovered = await retried, next = recovered.events.find(event => event.type === 'turn_ready')?.turn as PreparedTurn | undefined;
    assert.ok(next && reservedId); assert.equal(next.id, reservedId);
    const saved = await fixture.saved(sessionId); assert.equal(saved.turns.length, 2); assert.equal(saved.turns[1].metadata.providerTimings?.draftCacheHit, 1); assert.equal(saved.turns[1].metadata.providerTimings?.coreModelCalls, 0); assert.equal((await fixture.control()).coreCalls, 1); assert.equal((await fixture.control()).questionTtsProviderCalls, 1);
    await fixture.request(`/api/sessions/${sessionId}/end`, {});
  });
  await context.test("duplicate answer joins the pending request after turn push but before save resolves", async () => {
    await fixture.control("/reset", {}); const { sessionId, turn } = await fixture.start();
    const answer = await fixture.answer(sessionId, turn); await fixture.control("/configure", { blockSecondTurnSave: true });
    const first = fixture.next(sessionId, answer);
    await poll(() => fixture.control(), state => state.saveBlocked === true, "new-turn save barrier");
    const duplicate = fixture.next(sessionId, answer); await sleep(20); await fixture.control("/release-save", {});
    const [one, two] = await Promise.all([first, duplicate]); assert.equal(one.status, 200); assert.equal(two.status, 200);
    const oneTurn = one.events.find(event => event.type === "turn_ready")?.turn as PreparedTurn | undefined, twoTurn = two.events.find(event => event.type === "turn_ready")?.turn as PreparedTurn | undefined;
    assert.ok(oneTurn && twoTurn); assert.equal(oneTurn.id, twoTurn.id);
    assert.equal((await fixture.control()).coreCalls, 1); assert.equal((await fixture.saved(sessionId)).turns.length, 2);
    await fixture.request(`/api/sessions/${sessionId}/end`, {});
  });
  await context.test("an earlier answer-save failure does not reject a fully persisted next turn or break duplicate retry", async () => {
    await fixture.control("/reset", {}); const { sessionId, turn } = await fixture.start();
    const answer = await fixture.answer(sessionId, turn);
    await fixture.control("/configure", { failNextAnswerSave: true });
    const result = await fixture.next(sessionId, answer);
    const prepared = result.events.find(event => event.type === "turn_ready")?.turn as PreparedTurn | undefined;
    assert.ok(prepared); assert.equal(result.events.some(event => event.type === "error"), false);
    const saved = await fixture.saved(sessionId); assert.equal(saved.turns.length, 2); assert.equal(saved.turns[1].id, prepared.id);
    assert.equal((saved.turns[0].metrics as { speech: { durationMs: number } }).speech.durationMs, 100);
    const duplicate = await fixture.next(sessionId, answer);
    assert.equal((duplicate.events.find(event => event.type === "turn_ready")?.turn as PreparedTurn).id, prepared.id);
    const stats = await fixture.control(); assert.equal(stats.answerSaveFailures, 1); assert.equal(stats.coreCalls, 1);
    const rows = await poll(() => fixture.logs(sessionId), values => values.some(event => event.payload?.code === "EARLIER_SAVE_RECOVERED"), "recovered earlier save journal");
    assert.equal(rows.find(event => event.payload?.code === "EARLIER_SAVE_RECOVERED")?.payload.recovered, true);
    await fixture.request(`/api/sessions/${sessionId}/end`, {});
  });
  await context.test("a failed answer save at the time limit stays retryable without advancing or generating another turn", async () => {
    await fixture.control("/reset", {}); const { sessionId, turn } = await fixture.start();
    const answer = { ...await fixture.answer(sessionId, turn), elapsedMs: 720000 };
    await fixture.control("/configure", { failNextAnswerSave: true });
    const failed = await fixture.next(sessionId, answer);
    assert.equal(failed.events.at(-1)?.type, "error");
    assert.equal((await fixture.request(`/api/sessions/${sessionId}`)).status, "active");
    assert.equal((await fixture.saved(sessionId)).turns.length, 1);
    const retried = await fixture.next(sessionId, answer);
    const ready = retried.events.find(event => event.type === "turn_ready"); assert.equal(ready?.done, true); assert.equal(ready?.turn, null);
    assert.equal((await fixture.control()).coreCalls, 0);
    await fixture.request(`/api/sessions/${sessionId}/end`, {});
  });
  await context.test("evaluation completion is hidden until persisted and a failed result save becomes durably retryable", async () => {
    await fixture.control("/reset", {}); const { sessionId } = await fixture.start();
    await fixture.control("/configure", { failNextEvaluationSave: true, holdNextEvaluationSave: true });
    const ending = fixture.request(`/api/sessions/${sessionId}/end`, {});
    await poll(() => fixture.control(), value => value.evaluationSaveBlocked === true, "evaluation result save barrier");
    const during = await fixture.request(`/api/sessions/${sessionId}`);
    assert.equal(during.evaluationStatus, "running"); assert.equal(during.status, "ending");
    const originalSnapshot = JSON.stringify(await fixture.saved(sessionId));
    assert.notEqual((await ending).evaluationStatus, "completed");
    await fixture.control("/release-save", {});
    const failed = await poll(() => fixture.request(`/api/sessions/${sessionId}`), value => value.evaluationStatus === "failed", "retryable evaluation status");
    assert.equal(failed.status, "ending"); assert.match(String(failed.evaluationError), /다시 시도/u);
    const failedJob = await fixture.job(sessionId); assert.ok(failedJob);
    assert.equal(failedJob.status, 'failed'); assert.equal(failedJob.error?.code, 'EIO'); assert.equal(failedJob.resultSha256, null);
    assert.equal(JSON.stringify(await fixture.saved(sessionId)), originalSnapshot, 'A failed worker result commit must not overwrite the immutable interview snapshot');
    const failedRows = await poll(() => fixture.logs(sessionId), values => values.some(event => event.type === "evaluation.status" && event.payload.status === "failed" && event.payload.resultStorage === 'versioned-evaluation-job-result'), "evaluation persistence error journal");
    assert.ok(failedRows.some(event => event.type === "evaluation.status" && event.payload.jobId === failedJob.id));
    await fixture.request(`/api/sessions/${sessionId}/retry-evaluation`, {});
    await poll(() => fixture.request(`/api/sessions/${sessionId}`), value => value.evaluationStatus === "completed", "evaluation retry completed");
    const completedJob = await fixture.job(sessionId); assert.equal(completedJob?.status, 'completed'); assert.ok(completedJob?.resultSha256);
    const stats = await fixture.control(); assert.equal(stats.evaluationSaveFailures, 1); assert.equal(stats.evaluationCalls, 2);
  });
  await context.test("ending while the one core call is pending starts no new TTS and records no late turn", async () => {
    await fixture.control("/reset", {}); const { sessionId, turn } = await fixture.start();
    const answer = await fixture.answer(sessionId, turn); await fixture.control("/configure", { holdNextCore: true });
    const pending = fixture.next(sessionId, answer);
    await poll(() => fixture.control(), state => state.coreBlocked === true, "core barrier");
    const before = await fixture.control(); await fixture.request(`/api/sessions/${sessionId}/end`, { metrics: answer.metrics });
    await fixture.control("/release-core", {}); const response = await pending;
    assert.equal(response.events.at(-1)?.type, "error");
    const after = await fixture.control(); assert.equal(after.questionTtsAttempts, before.questionTtsAttempts); assert.equal(after.acknowledgementTtsAttempts, before.acknowledgementTtsAttempts);
    assert.equal((await fixture.saved(sessionId)).turns.length, 1);
  });
  await context.test("a finalized silent answer gets one non-evaluative clarification then transitions without consuming an F slot", async () => {
    await fixture.control("/reset", {}); const { sessionId, turn } = await fixture.start();
    const blank = await fixture.answer(sessionId, turn, { silent: true, elapsedMs: 10000 });
    const first = await fixture.next(sessionId, blank);
    assert.equal(first.events.some(event => event.type === "error"), false);
    const repair = first.events.find(event => event.type === "turn_ready")?.turn as PreparedTurn | undefined;
    assert.ok(repair); assert.equal(repair.questionKind, "clarification"); assert.equal(repair.mainIndex, 1); assert.equal(repair.followUpIndex, 0); assert.equal(repair.parentMainQuestionId, turn.id);
    const duplicate = await fixture.next(sessionId, blank);
    assert.equal((duplicate.events.find(event => event.type === "turn_ready")?.turn as PreparedTurn).id, repair.id);
    const afterFirst = await fixture.saved(sessionId);
    assert.equal(afterFirst.turns[0].rawTranscript, ""); assert.equal(afterFirst.turns[0].transcriptStatus, "finalized");
    assert.equal(afterFirst.turns[0].answerObservation?.classification, "silence_observed");
    assert.equal(afterFirst.turns[0].answerObservation?.durationMs, 5000);
    assert.equal(afterFirst.turns[1].metadata.nonEvaluative, true); assert.equal(afterFirst.turns[1].metadata.clarificationOfTurnId, turn.id);
    assert.equal(afterFirst.followUpCountByMainQuestion[turn.id], 0);
    const secondBlank = await fixture.answer(sessionId, repair, { silent: true, elapsedMs: 20000 });
    const second = await fixture.next(sessionId, secondBlank);
    const nextMain = second.events.find(event => event.type === "turn_ready")?.turn as PreparedTurn | undefined;
    assert.ok(nextMain); assert.equal(nextMain.questionKind, "main"); assert.equal(nextMain.mainIndex, 2);
    const afterSecond = await fixture.saved(sessionId);
    assert.equal(afterSecond.turns.filter(item => item.questionKind === "clarification").length, 1);
    assert.equal(afterSecond.followUpCountByMainQuestion[turn.id], 0);
    assert.equal(afterSecond.turns[1].rawTranscript, ""); assert.equal(afterSecond.turns[1].metadata.answerReaction?.action, "transition");
    const voiced = await fixture.answer(sessionId, nextMain, { elapsedMs: 30000 });
    const continuing = await fixture.next(sessionId, voiced);
    assert.equal((continuing.events.find(event => event.type === "turn_ready")?.turn as PreparedTurn).mainIndex, 3);
    const rows = await poll(() => fixture.logs(sessionId), values => values.filter(event => event.type === "answer.silence").length === 2, "explicit observed silence journal");
    assert.equal(rows.filter(event => event.type === "error").length, 0);
    assert.ok(rows.filter(event => event.type === "answer.silence").every(event => event.payload.rawTranscript === "" && event.payload.speakingMs === 0));
    await fixture.request(`/api/sessions/${sessionId}/end`, {});
  });
  await context.test("explicit ending keeps an empty finalized answer's actual timing and raw text", async () => {
    await fixture.control("/reset", {}); const { sessionId, turn } = await fixture.start();
    const blank = await fixture.answer(sessionId, turn, { silent: true, elapsedMs: 5000 });
    // Use the current client contract: observation timing belongs to this exact
    // turn AND answer. Unlabelled end-wide speech may be the preceding answer.
    await fixture.request(`/api/sessions/${sessionId}/end`, { metrics: { ...blank.metrics, lastObservedAnswerTurnId: blank.turnId,
      answers: [{ turnId: blank.turnId, answerId: blank.answerId, ...blank.metrics }] }, elapsedMs: blank.elapsedMs });
    const saved = await poll(() => fixture.evaluated(sessionId), value => value.evaluationStatus === "completed", "empty answer end evaluation");
    assert.equal(saved.turns.length, 1); assert.equal(saved.turns[0].rawTranscript, "");
    assert.equal(saved.turns[0].answerObservation?.classification, "silence_observed");
    assert.equal((saved.turns[0].metrics as { speech: { durationMs: number; characterCount: number; cpm: null } }).speech.durationMs, 5000);
    assert.equal((saved.turns[0].metrics as { speech: { characterCount: number; cpm: null } }).speech.characterCount, 0);
    assert.equal((saved.turns[0].metrics as { speech: { cpm: null } }).speech.cpm, null);
    assert.equal((await fixture.control()).coreCalls, 0);
  });
  await context.test('explicit ending never treats another answer timing as observed silence for the current answer', async () => {
    await fixture.control('/reset', {}); const { sessionId, turn } = await fixture.start();
    const blank = await fixture.answer(sessionId, turn, { silent: true, elapsedMs: 5000 });
    await fixture.request(`/api/sessions/${sessionId}/end`, { metrics: { ...blank.metrics,
      answers: [{ turnId: randomUUID(), answerId: randomUUID(), ...blank.metrics }] }, elapsedMs: blank.elapsedMs });
    const saved = await poll(() => fixture.evaluated(sessionId), value => value.evaluationStatus === 'completed', 'unbound silence timing evaluation');
    assert.equal(saved.turns[0].rawTranscript, '');
    assert.equal(saved.turns[0].answerObservation?.classification, 'empty_transcript');
    assert.notEqual((saved.turns[0].metrics as { speech?: { durationMs?: number } }).speech?.durationMs, 5000);
    assert.equal((await fixture.control()).coreCalls, 0);
  });
  await context.test('candidate shortage preserves the answer and active session, requests preparation, and never pretends time completed', async () => {
    await fixture.control('/reset', {}); const { sessionId, turn } = await fixture.start();
    const answer = await fixture.answer(sessionId, turn, { elapsedMs: 5000 });
    await fixture.control('/configure', { exhaustMainPool: true });
    const failed = await fixture.next(sessionId, answer);
    assert.ok(failed.events.some(event => event.code === 'PREPARATION_REQUIRED'));
    const saved = await fixture.saved(sessionId);
    assert.equal(saved.status, 'active'); assert.equal(saved.turns.length, 1); assert.equal(saved.turns[0].rawTranscript, '합성 테스트 응답입니다.');
    assert.equal(saved.runtime?.checkpoint.phase, 'candidate_exhausted'); assert.equal(saved.runtime?.closingUtterance, undefined);
    const before = await fixture.control(), repeated = await fixture.next(sessionId, answer), after = await fixture.control();
    assert.equal(repeated.status, 503); assert.equal(after.coreCalls, before.coreCalls);
    const closing = await fixture.request(`/api/sessions/${sessionId}/closing`, { elapsedMs: 5000 });
    assert.equal((closing.closingUtterance as Json).reason, 'user_ended');
    await fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 5000 });
  });
  await context.test('server provider ledger persists usage once and ignores client cost claims', async () => {
    await fixture.control('/reset', {}); const { sessionId, turn } = await fixture.start();
    const answer = await fixture.answer(sessionId, turn, { elapsedMs: 5000 });
    await fixture.control('/configure', { emitUsageNextCore: true });
    const result = await fixture.next(sessionId, { ...answer, metrics: { ...answer.metrics, providerUsageLedger: { totalUsd: 999999 } } });
    assert.equal(result.status, 200);
    const state = await fixture.saved(sessionId);
    assert.equal(state.providerUsageLedger?.entries.length, 1);
    assert.equal(state.providerUsageLedger?.entries[0].observation.usage?.input_tokens_details.cache_write_tokens, 30);
    assert.equal(state.providerUsageLedger?.summary.unknownCalls, 0);
    assert.equal(state.providerUsageLedger?.summary.invoiceVerified, false);
    const totalUsd=state.providerUsageLedger?.summary.totalUsd;assert.equal(typeof totalUsd,'number');assert.ok(totalUsd!==null&&totalUsd!==undefined&&totalUsd>0&&totalUsd<1);
    const duplicate = await fixture.next(sessionId, answer);assert.equal(duplicate.status,200);
    assert.equal((await fixture.saved(sessionId)).providerUsageLedger?.entries.length,1);
    await fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 5000 });
    const rows = await fixture.logs(sessionId);
    assert.equal(rows.filter(row=>row.type==='provider.usage').length,1);
  });
  await context.test('provider quota failure preserves the finalized answer and retries the same operation only on a new explicit request', async () => {
    await fixture.control('/reset', {}); const { sessionId, turn } = await fixture.start(), client = clientJournal(sessionId);
    await client.emit({ type: 'question_playing', turnId: turn.id, phase: 'speaking_question', atMs: 10 });
    await client.emit({ type: 'audio_ended', turnId: turn.id, phase: 'speaking_question', atMs: 100, payload: { role: 'question' } });
    const answer = await fixture.answer(sessionId, turn, { elapsedMs: 5000 });
    const before = await fixture.control(), initial = await fixture.saved(sessionId);
    await fixture.control('/configure', { providerUnavailableNextCore: true, followUpNextCore: true });
    const failed = await fixture.next(sessionId, answer);
    assert.equal(failed.status, 503);
    assert.equal(failed.events[0].code, 'QUESTION_PROVIDER_UNAVAILABLE');
    assert.equal(failed.events[0].error, publicServiceError('connection'));
    assert.doesNotMatch(JSON.stringify(failed.events), /HTTP_429|quota|credit|OpenAI|CLOVA/iu);
    const paused = await fixture.saved(sessionId), key = `${sessionId}:${turn.id}:${answer.answerId}`;
    assert.equal(paused.status, 'active'); assert.equal(paused.turns.length, 1);
    assert.equal(paused.turns[0].answerId, answer.answerId); assert.equal(paused.turns[0].rawTranscript, '합성 테스트 응답입니다.');
    assert.equal(paused.turns[0].transcriptStatus, 'finalized'); assert.ok(paused.turns[0].metrics);
    assert.deepEqual(paused.followUpCountByMainQuestion, initial.followUpCountByMainQuestion);
    assert.equal(paused.runtime?.checkpoint.phase, 'provider_unavailable');
    assert.equal(paused.runtime?.operations[key].status, 'retryable');
    assert.equal(paused.runtime?.operations[key].prepared, undefined);
    assert.equal(paused.runtime?.operations[key].result, undefined);
    assert.equal(paused.runtime?.closingUtterance, undefined);
    const decision = paused.turns[0].metadata.coreDecision as unknown as Json;
    assert.equal(decision.providerUnavailable, true); assert.equal(decision.failureDetail, 'HTTP_429');
    const unavailable = await fixture.control();
    assert.equal(unavailable.coreCalls, Number(before.coreCalls) + 1);
    assert.equal(unavailable.bankHits, before.bankHits);
    assert.equal(unavailable.questionTtsAttempts, before.questionTtsAttempts);
    assert.equal(unavailable.acknowledgementTtsAttempts, before.acknowledgementTtsAttempts);
    await sleep(25); assert.equal((await fixture.control()).coreCalls, unavailable.coreCalls, 'No automatic provider retry is scheduled');
    const recovered = await fixture.next(sessionId, answer);
    const next = recovered.events.find(event => event.type === 'turn_ready')?.turn as PreparedTurn | undefined;
    assert.ok(next); assert.equal(next.questionKind, 'follow_up');
    const recoveredState = await fixture.saved(sessionId);
    assert.equal(recoveredState.turns.length, 2); assert.equal(recoveredState.turns[0].answerId, answer.answerId);
    assert.equal(recoveredState.runtime?.operations[key].status, 'committed');
    assert.equal(recoveredState.runtime?.operations[key].failureCode, undefined);
    assert.deepEqual(recoveredState.followUpCountByMainQuestion, initial.followUpCountByMainQuestion, 'Prepared, unheard F does not consume its allowance');
    const counts = await fixture.control(), duplicate = await fixture.next(sessionId, answer);
    assert.equal((duplicate.events.find(event => event.type === 'turn_ready')?.turn as PreparedTurn).id, next.id);
    assert.deepEqual(await fixture.control(), counts, 'Committed duplicate repeats no core, candidate selection or TTS');
    await client.emit({ type: 'question_playing', turnId: next.id, phase: 'speaking_question', atMs: 200 });
    const presented = await fixture.saved(sessionId);
    assert.equal(presented.followUpCountByMainQuestion[turn.id], 1);
    await fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 5000 });
  });
  await context.test('failed question review preserves the finalized answer and retries the same operation only on a new explicit request', async () => {
    await fixture.control('/reset', {}); const { sessionId, turn } = await fixture.start(), client = clientJournal(sessionId);
    await client.emit({ type: 'question_playing', turnId: turn.id, phase: 'speaking_question', atMs: 10 });
    await client.emit({ type: 'audio_ended', turnId: turn.id, phase: 'speaking_question', atMs: 100, payload: { role: 'question' } });
    const answer = await fixture.answer(sessionId, turn, { elapsedMs: 5000 });
    const before = await fixture.control(), initial = await fixture.saved(sessionId);
    await fixture.control('/configure', { questionReviewUnavailableNextCore: true, followUpNextCore: true });
    const failed = await fixture.next(sessionId, answer);
    assert.equal(failed.status, 503);
    assert.equal(failed.events[0].code, 'QUESTION_REVIEW_UNAVAILABLE');
    assert.equal(failed.events[0].error, publicServiceError('connection'));
    assert.doesNotMatch(JSON.stringify(failed.events), /HTTP_429|quota|credit|OpenAI|CLOVA/iu);
    const paused = await fixture.saved(sessionId), key = `${sessionId}:${turn.id}:${answer.answerId}`;
    assert.equal(paused.status, 'active'); assert.equal(paused.turns.length, 1);
    assert.equal(paused.turns[0].answerId, answer.answerId); assert.equal(paused.turns[0].rawTranscript, '합성 테스트 응답입니다.');
    assert.equal(paused.turns[0].transcriptStatus, 'finalized'); assert.ok(paused.turns[0].metrics);
    assert.deepEqual(paused.followUpCountByMainQuestion, initial.followUpCountByMainQuestion);
    assert.equal(paused.runtime?.checkpoint.phase, 'question_review_failed');
    assert.equal(paused.runtime?.operations[key].status, 'retryable');
    assert.equal(paused.runtime?.operations[key].prepared, undefined);
    assert.equal(paused.runtime?.operations[key].result, undefined);
    assert.equal(paused.runtime?.closingUtterance, undefined);
    const decision = paused.turns[0].metadata.coreDecision as unknown as Json;
    assert.equal(decision.questionRecoveryRequired, true); assert.equal(decision.failureDetail, 'PREMISE_UNSUPPORTED');
    const unavailable = await fixture.control();
    assert.equal(unavailable.coreCalls, Number(before.coreCalls) + 1);
    assert.equal(unavailable.bankHits, before.bankHits);
    assert.equal(unavailable.questionTtsAttempts, before.questionTtsAttempts);
    assert.equal(unavailable.acknowledgementTtsAttempts, before.acknowledgementTtsAttempts);
    await sleep(25); assert.equal((await fixture.control()).coreCalls, unavailable.coreCalls, 'No automatic provider retry is scheduled');
    const recovered = await fixture.next(sessionId, answer);
    const next = recovered.events.find(event => event.type === 'turn_ready')?.turn as PreparedTurn | undefined;
    assert.ok(next); assert.equal(next.questionKind, 'follow_up');
    const recoveredState = await fixture.saved(sessionId);
    assert.equal(recoveredState.turns.length, 2); assert.equal(recoveredState.turns[0].answerId, answer.answerId);
    assert.equal(recoveredState.runtime?.operations[key].status, 'committed');
    assert.equal(recoveredState.runtime?.operations[key].failureCode, undefined);
    assert.deepEqual(recoveredState.followUpCountByMainQuestion, initial.followUpCountByMainQuestion, 'Prepared, unheard F does not consume its allowance');
    const counts = await fixture.control(), duplicate = await fixture.next(sessionId, answer);
    assert.equal((duplicate.events.find(event => event.type === 'turn_ready')?.turn as PreparedTurn).id, next.id);
    assert.deepEqual(await fixture.control(), counts, 'Committed duplicate repeats no core, candidate selection or TTS');
    await client.emit({ type: 'question_playing', turnId: next.id, phase: 'speaking_question', atMs: 200 });
    const presented = await fixture.saved(sessionId);
    assert.equal(presented.followUpCountByMainQuestion[turn.id], 1);
    await fixture.request(`/api/sessions/${sessionId}/end`, { elapsedMs: 5000 });
  });
  await context.test("two pauses and one final capture preserve separate observations and ending deduplicates the final submission", async () => {
    await fixture.control("/reset", {}); const { sessionId, turn } = await fixture.start();
    const answerId = randomUUID();
    await fixture.answer(sessionId, turn, { silent: true, answerId, pause: true });
    await fixture.answer(sessionId, turn, { silent: true, answerId, pause: true });
    const voiced = await fixture.answer(sessionId, turn, { answerId });
    await fixture.request(`/api/sessions/${sessionId}/end`, { metrics: voiced.metrics });
    const saved = await poll(() => fixture.evaluated(sessionId), value => value.evaluationStatus === "completed", "three-capture session persisted");
    const rows = await poll(() => fixture.logs(sessionId), values => values.filter(event => ['stt.paused', 'stt.final'].includes(event.type) && event.answerId === answerId).length === 3, "all capture observations retained");
    const finals = rows.filter(event => ['stt.paused', 'stt.final'].includes(event.type) && event.answerId === answerId);
    const submissions = rows.filter(event => event.type === "answer.submitted" && event.answerId === answerId);
    assert.equal(submissions.length, 1); assert.equal(new Set(finals.map(event => event.eventId)).size, 3);
    assert.deepEqual(finals.map(event => event.type), ['stt.paused', 'stt.paused', 'stt.final']);
    assert.equal(new Set(finals.map(event => event.payload.captureAttemptId)).size, 3);
    assert.deepEqual(finals.map(event => event.payload.rawTranscript), ["", "", "합성 테스트 응답입니다."]);
    assert.equal(finals.at(-1)?.payload.rawTranscript, saved.turns[0].rawTranscript);
    assert.equal(finals.at(-1)?.payload.captureAttemptId, saved.turns[0].metadata.lastStreamId);
    assert.equal(submissions[0].payload.captureAttemptId, finals.at(-1)?.payload.captureAttemptId);
    assert.equal(saved.turns[0].sttObservations?.length, 3);
    assert.equal((await fixture.control()).coreCalls, 0);
  });
  for (const failureAt of ['write', 'construction', 'finish', 'late-partial'] as const) await context.test(`a ${failureAt} STT failure stays durably failed despite queued finish, late final and disconnect`, async () => {
    await fixture.control("/reset", {}); const { sessionId, turn } = await fixture.start();
    const failed = await fixture.answer(sessionId, turn, { expectFailure: true, failureAt, elapsedMs: 5000 });
    assert.ok(failed.publicErrors.length > 0);
    assert.ok(failed.publicErrors.every(event => event.message === publicServiceError('speech')));
    assert.doesNotMatch(JSON.stringify(failed.publicErrors), /SYNTHETIC_STT_TRANSPORT_FAILURE/u);
    const response = await fixture.next(sessionId, failed);
    assert.equal(response.status, 422); assert.equal(response.events[0].code, "REQUEST_ERROR");
    const saved = await poll(() => fixture.saved(sessionId), value => value.turns[0].transcriptStatus === "error", "actual STT failure preserved");
    assert.equal(saved.turns.length, 1); assert.equal(saved.turns[0].answerObservation, undefined);
    assert.equal(saved.turns[0].rawTranscript ?? '', failureAt === 'finish' ? '합성 테스트' : '');
    assert.equal((await fixture.control()).coreCalls, 0);
    const privateFailures = await poll(() => fixture.logs(sessionId), rows => rows.some(row => row.type === 'error' && /SYNTHETIC_STT_(?:TRANSPORT|CONSTRUCTION|FINISH)_FAILURE/u.test(String(row.payload.message))), 'private STT diagnostic retained');
    assert.equal(privateFailures.some(row => row.type === 'stt.final' && row.turnId === turn.id), false);
    assert.equal(privateFailures.some(row => row.type === 'stt.partial' && /실패 후|오류 뒤/u.test(String(row.payload.rawTranscript))), false);
    await fixture.request(`/api/sessions/${sessionId}/end`, {});
  });
  await context.test('closing the active capture survives a synchronous provider error without dereferencing a retired stream', async () => {
    await fixture.control('/reset', {});
    const { sessionId, turn } = await fixture.start(), answerId = randomUUID();
    await fixture.control('/configure', { lateCallbacksOnClose: true });
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(fixture.base).port}/api/realtime?sessionId=${sessionId}`, { origin: fixture.origin });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const started = new Promise<void>(resolve => ws.on('message', raw => { if (JSON.parse(raw.toString()).type === 'started') resolve(); }));
    ws.send(JSON.stringify({ type: 'start', turnId: turn.id, answerId })); await started;
    const closed = new Promise<void>(resolve => ws.once('close', () => resolve())); ws.close(); await closed;
    const saved = await poll(() => fixture.saved(sessionId), value => value.turns[0].transcriptStatus === 'error', 'active capture close failure persisted');
    assert.equal(saved.turns[0].rawTranscript ?? '', '');
    assert.equal((await fixture.request('/api/health')).ok, true);
    assert.equal((await fixture.control()).coreCalls, 0);
    await fixture.request(`/api/sessions/${sessionId}/end`, {});
  });
  await context.test('a second socket cannot replace live capture and retired callbacks cannot overwrite its accepted replacement', async () => {
    await fixture.control('/reset', {}); const { sessionId, turn } = await fixture.start(), answerId = randomUUID();
    const socket = async () => {
      const ws = new WebSocket(`${fixture.base.replace('http:', 'ws:')}/api/realtime?sessionId=${sessionId}`, { origin: fixture.origin });
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      return ws;
    };
    const wait = (ws: WebSocket, type: string) => new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => { ws.off('message', receive); reject(new Error(`Synthetic replacement ${type} timeout`)); }, 5000);
      const receive = (raw: RawData) => { const event = JSON.parse(raw.toString()); if (event.type === type) { clearTimeout(timer); ws.off('message', receive); resolve(event); } };
      ws.on('message', receive);
    });
    await fixture.control('/configure', { lateCallbacksOnClose: true });
    const old = await socket();
    let oldClosed = false; const closed = new Promise<void>(resolve => old.once('close', () => { oldClosed = true; resolve(); }));
    const oldStart = wait(old, 'started'); old.send(JSON.stringify({ type: 'start', turnId: turn.id, answerId })); const original = await oldStart;
    const previousId = original.streamId; assert.equal(typeof previousId, 'string');
    const replacement = await socket();
    try {
      const errors: Json[] = []; replacement.on('message', raw => { const event = JSON.parse(raw.toString()); if (event.type === 'error') errors.push(event); });
      const rejected = wait(replacement, 'error'); replacement.send(JSON.stringify({ type: 'start', turnId: turn.id, answerId })); await rejected;
      const retained = wait(old, 'transcript'); old.send(Buffer.alloc(3200), { binary: true }); const retainedTranscript = await retained;
      assert.equal(retainedTranscript.streamId, previousId, 'Rejected replacement must leave the original capture owning PCM');
      old.close(); await closed;
      await poll(() => fixture.control(), counters => Number(counters.sttCloses) >= 1, 'old capture close and queued late callbacks');
      const nextStart = wait(replacement, 'started'); replacement.send(JSON.stringify({ type: 'start', turnId: turn.id, answerId })); const current = await nextStart;
      assert.equal(typeof current.streamId, 'string'); assert.notEqual(current.streamId, previousId);
      const progress = await fixture.request(`/api/sessions/${sessionId}`);
      assert.equal((progress.recovery as Json).transcriptStatus, 'streaming');
      const result = wait(replacement, 'finalized'); replacement.send(Buffer.alloc(3200), { binary: true }); replacement.send(JSON.stringify({ type: 'finish', turnId: turn.id, answerId }));
      const expected = `${retainedTranscript.rawTranscript} 합성 테스트 응답입니다.`;
      assert.equal((await result).rawTranscript, expected);
      const saved = await fixture.saved(sessionId);
      assert.equal(saved.turns[0].transcriptStatus, 'finalized'); assert.equal(saved.turns[0].rawTranscript, expected);
      assert.equal(saved.turns[0].metadata.lastStreamId, current.streamId); assert.equal(errors.length, 1);
      const rows = await fixture.logs(sessionId);
      assert.equal(rows.some(row => row.type === 'stt.partial' && /닫힌 이전/u.test(String(row.payload.rawTranscript))), false);
      await fixture.request(`/api/sessions/${sessionId}/end`, {});
    } finally { replacement.close(); if (!oldClosed) old.close(); }
  });
  await context.test("append-only journal orders synthetic STT and canonical client-reported playback, deduplicates end backup and records evaluation", async () => {
    await fixture.control("/reset", {});
    const { sessionId, turn } = await fixture.start();
    const initial = await poll(() => fixture.logs(sessionId), rows => rows.some(row => row.type === 'question.prepared'), 'initial private journal');
    assert.ok(initial.some(row => row.type === 'session.created')); assert.ok(initial.some(row => row.type === 'sources.snapshot')); assert.ok(initial.some(row => row.type === 'rules.snapshot'));
    assert.equal(initial.some(row => row.type === 'playback.started'), false, 'Prepared audio is not evidence of physical playback');
    const answer = await fixture.answer(sessionId, turn);
    await fixture.control('/configure', { holdNextQuestionTts: true, followUpNextCore: true });
    let ackEvent: { eventId: string; type: 'acknowledgement_playing'; turnId: string; phase: string; atMs: number; payload: Json } | undefined;
    let acknowledge!: () => void; const acknowledgementPosted = new Promise<void>(resolve => { acknowledge = resolve; });
    const pendingNext = fixture.next(sessionId, answer, async event => {
      if (event.type !== 'acknowledgement_ready') return;
      ackEvent = { eventId: randomUUID(), type: 'acknowledgement_playing', turnId: String(event.turnId), phase: 'speaking_acknowledgement', atMs: 100, payload: { text: 'FORGED_CLIENT_TEXT' } };
      const posted = await fixture.request(`/api/sessions/${sessionId}/events`, ackEvent); assert.equal(posted.accepted, true); acknowledge();
    });
    await Promise.race([acknowledgementPosted, pendingNext.then(() => { throw new Error('Synthetic progress ended before acknowledgement POST'); }), sleep(8000, undefined, { ref: false }).then(() => { throw new Error('Synthetic acknowledgement event POST timed out'); })]);
    assert.ok(ackEvent); const acknowledgedEvent = ackEvent;
    assert.equal((await fixture.saved(sessionId)).turns.length, 1, 'Early acknowledgement must resolve while its new question is still absent from saved turns');
    await fixture.control('/release-question-tts', {}); const prepared = await pendingNext;
    const next = prepared.events.find(event => event.type === 'turn_ready')?.turn as PreparedTurn | undefined; assert.ok(next); assert.equal(next.id, ackEvent.turnId);
    const questionEvent = { eventId: randomUUID(), type: 'question_playing', turnId: next.id, phase: 'speaking_question', atMs: 200, payload: { text: 'FORGED_CLIENT_TEXT' } };
    const posted = await fixture.request(`/api/sessions/${sessionId}/events`, questionEvent), duplicate = await fixture.request(`/api/sessions/${sessionId}/events`, questionEvent);
    assert.equal(posted.accepted, true); assert.equal(duplicate.duplicate, true);
    const foreign = await fixture.start();
    const invalid = await fetch(`${fixture.base}/api/sessions/${sessionId}/events`, { method: 'POST', headers: { Origin: fixture.origin, 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify({ ...questionEvent, eventId: 'invalid-uuid' }) }); assert.equal(invalid.status, 400); await invalid.arrayBuffer();
    const wrongSession = await fetch(`${fixture.base}/api/sessions/${sessionId}/events`, { method: 'POST', headers: { Origin: fixture.origin, 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify({ ...questionEvent, eventId: randomUUID(), turnId: foreign.turn.id }) }); assert.equal(wrongSession.status, 409); await wrongSession.arrayBuffer();
    await fixture.request(`/api/sessions/${foreign.sessionId}/end`, {});
    const errorEvent = { eventId: randomUUID(), type: 'client_error', turnId: next.id, phase: 'error', atMs: 210, payload: { message: 'synthetic-test-only sk-proj-logTestLeak123', apiKey: 'UNKNOWN_LOG_KEY_VALUE' } };
    await fixture.request(`/api/sessions/${sessionId}/events`, errorEvent);
    const offlineEnded = { eventId: randomUUID(), type: 'audio_ended', turnId: next.id, phase: 'speaking_question', atMs: 300, payload: { role: 'question', text: 'FORGED_CLIENT_TEXT' } };
    await fixture.request(`/api/sessions/${sessionId}/end`, { metrics: { clientEventsBackup: [ackEvent, questionEvent, errorEvent, offlineEnded], verification: { syntheticClientObservation: true } }, elapsedMs: 400100 });
    await poll(() => fixture.evaluated(sessionId), snapshot => snapshot.evaluationStatus === 'completed', 'evaluation persisted');
    const rows = await poll(() => fixture.logs(sessionId), values => values.some(row => row.eventId === offlineEnded.eventId) && values.some(row => row.type === 'evaluation.status' && (row.payload.status === 'completed' || row.payload.evaluationStatus === 'completed')), 'end backup and evaluation journal');
    assert.deepEqual(rows.map(row => row.seq), Array.from({ length: rows.length }, (_, index) => index + 1));
    assert.equal(new Set(rows.map(row => row.eventId)).size, rows.length);
    for (const input of [ackEvent, questionEvent, errorEvent, offlineEnded]) assert.equal(rows.filter(row => row.eventId === input.eventId).length, 1, 'Direct POST and backup must share the original event UUID');
    const partial = rows.find(row => row.type === 'stt.partial' && row.turnId === turn.id), final = rows.find(row => row.type === 'stt.final' && row.turnId === turn.id), reaction = rows.find(row => row.type === 'answer.relevance' && row.turnId === turn.id);
    assert.ok(partial && final && reaction); assert.equal(partial.payload.rawTranscript, '합성 테스트'); assert.equal(final.payload.rawTranscript, '합성 테스트 응답입니다.');
    assert.ok(partial.seq < final.seq && final.seq < reaction.seq); assert.equal(reaction.payload.sourceTurnId, turn.id); assert.equal(reaction.payload.action, 'probe');
    const ackPrepared = rows.find(row => row.type === 'acknowledgement.prepared' && row.turnId === next.id), questionPrepared = rows.find(row => row.type === 'question.prepared' && row.turnId === next.id);
    const ackPlaying = rows.find(row => row.eventId === acknowledgedEvent.eventId)!, questionPlaying = rows.find(row => row.eventId === questionEvent.eventId)!, ended = rows.find(row => row.eventId === offlineEnded.eventId)!;
    assert.ok(ackPrepared && questionPrepared); assert.equal(ackPrepared.payload.text, next.acknowledgement); assert.equal(questionPrepared.payload.text, next.questionText);
    assert.equal(ackPlaying.type, 'playback.started'); assert.equal(ackPlaying.role, 'acknowledgement'); assert.equal(ackPlaying.payload.text, next.acknowledgement); assert.equal(ackPlaying.payload.interviewerId, next.interviewerId); assert.equal(ackPlaying.payload.sourceTurnId, turn.id);
    assert.equal(questionPlaying.payload.text, next.questionText); assert.equal(questionPlaying.payload.sourceTurnId, turn.id); assert.equal(ended.type, 'playback.ended'); assert.equal(ended.payload.text, next.questionText);
    assert.ok(ackPrepared.seq < ackPlaying.seq && ackPlaying.seq < questionPrepared.seq && questionPrepared.seq < questionPlaying.seq);
    const voice = rows.find(row => row.type === 'provider.config' && row.turnId === next.id && Array.isArray(row.payload.voices)); assert.ok(voice); assert.equal(voice.payload.voices[0].interviewerId, next.interviewerId); assert.equal(voice.payload.voices[0].speed, 0); assert.equal(voice.payload.voices[0].format, 'mp3');
    assert.ok(rows.filter(row => row.type === 'playback.started' || row.type === 'playback.ended').every(row => row.payload.text !== 'FORGED_CLIENT_TEXT'));
    const serialized = JSON.stringify(rows); assert.doesNotMatch(serialized, /synthetic-test-only|sk-proj-logTestLeak123|UNKNOWN_LOG_KEY_VALUE/);
    assert.equal((await fixture.request(`/api/sessions/${sessionId}`)).status, 'completed');
    const stale = await fetch(`${fixture.base}/api/sessions/${sessionId}/next`, { method: 'POST', headers: { Origin: fixture.origin, 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify(answer) });
    assert.equal(stale.status, 409, 'A completed interview cannot return an old cached question');
    assert.equal((await stale.json()).turn, undefined);
  });
});
