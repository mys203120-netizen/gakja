/** Independent source-root HTTP/WS evidence. Only anonymous providers/context are
 * substituted; realtime, runtime, session/context/log and evaluation writers are real. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { build } from 'esbuild';
import { WebSocket, type RawData } from 'ws';
import type { InterviewSession, PreparedTurn } from '../server/protocol';

type Json = Record<string, unknown>;
const sourceRoot = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]);
const controlled = process.argv.includes('--controlled');
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const root = await mkdtemp(path.join(os.tmpdir(), 'pr06c-handler-'));
let child: ChildProcessWithoutNullStreams | undefined, diagnostic = '', launchNumber = 0, uuidNumber = 0;
const uuid = () => controlled ? `10000000-0000-4000-8000-${String(++uuidNumber).padStart(12, '0')}` : randomUUID();
const sockets = new Set<WebSocket>();
async function port() { const server = net.createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const value = (server.address() as net.AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return value; }
async function poll<T>(read: () => Promise<T>, match: (value: T) => boolean, label: string): Promise<T> {
  for (let i = 0; i < 1000; i++) { const value = await read(); if (match(value)) return value; await sleep(10); }
  throw new Error(`Timeout: ${label}\n${diagnostic}`);
}
async function stop() {
  for (const ws of sockets) ws.terminate(); sockets.clear();
  if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => { child!.once('exit', () => resolve()); child!.kill(); });
}
try {
  const main = path.join(sourceRoot, 'server/realtime.ts'), providers = path.join(sourceRoot, 'tests/fixtures/staged-realtime-providers.ts');
  const context = path.join(root, 'context.ts'), clock = path.join(root, 'clock.cjs'), outfile = path.join(root, 'runtime.cjs');
  await writeFile(context, `import { loadInterviewContext as load } from ${JSON.stringify(path.join(sourceRoot, 'tests/fixtures/runtime-context.ts').replaceAll('\\', '/'))}; export async function loadInterviewContext() { const context = await load(); if (process.env.PR06C_LATEST_CONTEXT) context.questionGuidelines = 'different current synthetic context'; return context; }`);
  await writeFile(clock, `const crypto=require('node:crypto');const{syncBuiltinESMExports}=require('node:module');const ActualDate=Date;const at=Date.parse('2026-11-06T00:00:00.000Z');global.Date=class extends ActualDate{constructor(...args){super(...(args.length?args:[at]));}static now(){return at;}};Object.defineProperty(performance,'now',{value:()=>0});let index=0;crypto.randomUUID=()=> '20000000-0000-4000-8'+String(process.env.PR06C_PROCESS).padStart(3,'0')+'-'+String(++index).padStart(12,'0');syncBuiltinESMExports();`);
  const bundle = await build({ entryPoints: [main], outfile, bundle: true, metafile: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent', plugins: [{ name: 'anonymous-provider-boundaries', setup(builder) {
    builder.onResolve({ filter: /^\.\/(?:submission-work|providers\/(?:openai|clova-tts|clova-stt|answer-reaction|realtime-core|single-core-runtime|approved-restatement)|data\/prepared-question-bank)$/ }, args => args.importer === main ? { path: providers } : undefined);
    builder.onResolve({ filter: /^\.\/data\/load-interview-context$/ }, args => args.importer === main ? { path: context } : undefined);
  } }] });
  const inputs = Object.keys(bundle.metafile!.inputs).map(file => file.replaceAll('\\', '/'));
  assert.ok(inputs.some(file => file.endsWith('server/storage/local-session-store.ts')));
  assert.ok(inputs.some(file => file.endsWith('server/storage/conversation-log.ts')));
  assert.ok(!inputs.some(file => /server\/providers\/(?:openai|clova-stt|clova-tts)\.ts$/u.test(file)));
  const realtimePort = await port(), webPort = await port(), base = `http://127.0.0.1:${realtimePort}`, origin = `http://127.0.0.1:${webPort}`;
  let controlPort = 0, stagedPort = 0;
  const launches: number[] = [];
  const launch = async () => {
    controlPort = await port(); stagedPort = await port(); launchNumber++;
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', REALTIME_PORT: String(realtimePort), WEB_PORT: String(webPort), RECOVERY_TEST_CONTROL_PORT: String(controlPort), STAGED_TEST_CONTROL_PORT: String(stagedPort), RECOVERY_TEST_TOKEN: 'explicit-synthetic-token', OPENAI_API_KEY: 'synthetic-only', CLOVA_SPEECH_SECRET_KEY: 'synthetic-only', CLOVA_VOICE_CLIENT_ID: 'synthetic-only', CLOVA_VOICE_CLIENT_SECRET: 'synthetic-only', LOCAL_INTERVIEW_OWNER_ID: 'owner-pr06c-synthetic', PR06C_PROCESS: String(launchNumber), ...(launchNumber > 1 ? { PR06C_LATEST_CONTEXT: 'changed' } : {}) };
    for (const key of ['SystemRoot', 'PATH', 'Path', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[key]) env[key] = process.env[key];
    child = spawn(process.execPath, [...(controlled ? ['--require', clock] : []), outfile], { cwd: root, env, windowsHide: true, stdio: 'pipe' });
    launches.push(child.pid!); child.stdout.resume(); child.stderr.on('data', bytes => { diagnostic = (diagnostic + String(bytes)).slice(-4000); });
    await poll(async () => { if (child!.exitCode !== null) throw new Error(diagnostic); try { return (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }, Boolean, 'startup');
  };
  const control = async (route: string, body?: Json, staged = true) => {
    const response = await fetch(`http://127.0.0.1:${staged ? stagedPort : controlPort}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Recovery-Test-Token': 'explicit-synthetic-token', 'Content-Type': 'application/json', Connection: 'close' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, 200); return await response.json() as Json;
  };
  const request = async (route: string, body?: unknown) => {
    const response = await fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Connection: 'close' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    return { status: response.status, body: await response.json() as Json };
  };
  const start = async () => {
    const preparation = await request('/api/prepare', {}); assert.equal(preparation.status, 200, JSON.stringify(preparation.body));
    const result = await request('/api/sessions', { preparationId: preparation.body.preparationId }); assert.equal(result.status, 201);
    return { id: result.body.sessionId as string, turn: result.body.turn as PreparedTurn };
  };
  const saved = async (id: string) => JSON.parse(await readFile(path.join(root, 'data/sessions', `${id}.json`), 'utf8')) as InterviewSession;
  const connect = async (id: string) => {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/api/realtime?sessionId=${id}`, { origin }); sockets.add(ws);
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const exchange = (body: Json, expected: string) => new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => { ws.off('message', receive); reject(new Error(`WS ${expected} timeout`)); }, 5000);
      const receive = (bytes: RawData) => { const value = JSON.parse(bytes.toString()) as Json; if (value.type !== expected && value.type !== 'error') return; clearTimeout(timer); ws.off('message', receive); resolve(value); };
      ws.on('message', receive); ws.send(JSON.stringify(body));
    });
    return { ws, exchange, close: async () => { const done = new Promise<void>(resolve => ws.once('close', () => resolve())); ws.close(); await done; sockets.delete(ws); } };
  };
  await launch();
  const first = await start(), other = await start(), scope = { turnId: first.turn.id, answerId: uuid(), captureRevision: 1 };
  const connection = await connect(first.id);
  const started = await connection.exchange({ type: 'start', ...scope }, 'started'); assert.equal(started.type, 'started');
  connection.ws.send(Buffer.alloc(3200));
  const final = await connection.exchange({ type: 'finish', ...scope, staged: true }, 'finalized'); assert.equal(final.type, 'finalized'); assert.equal(final.streamId, started.streamId);
  const metrics = { speech: { durationMs: 1000, speakingMs: 700, firstSpeechMs: 100 } };
  const candidateBody = { ...scope, elapsedMs: 2000, metrics, endingObservation: { stopSource: 'space', lastSpeechMs: 800, trailingSilenceMs: 200, speechActiveAtEnd: false, vadAvailable: true, tailDrainMs: 160, requestedAtMs: 840 } };
  await control('/configure', { holdCandidate: true });
  const pendingCandidate = request(`/api/sessions/${first.id}/answer-candidate`, candidateBody);
  await poll(() => control('/state'), state => state.candidateBlocked === true, 'candidate barrier');
  const duplicateCandidate = request(`/api/sessions/${first.id}/answer-candidate`, candidateBody);
  await control('/release-candidate', {});
  const [candidate, candidateRetry] = await Promise.all([pendingCandidate, duplicateCandidate]);
  assert.equal(candidate.status, 200, JSON.stringify(candidate)); assert.equal(candidate.body.action, 'ADVANCE'); assert.equal(candidate.body.candidateId, candidateRetry.body.candidateId);
  assert.equal((await control('/state')).candidateCalls, 1);
  await control('/configure', { blockSecondTurnSave: true }, false);
  const nextBody = { ...scope, candidateId: candidate.body.candidateId, elapsedMs: 3000, metrics };
  const pendingNext = request(`/api/sessions/${first.id}/next`, nextBody);
  await poll(() => control('/state', undefined, false), state => state.saveBlocked === true, 'real rename held after turn push');
  const duplicateNext = request(`/api/sessions/${first.id}/next`, nextBody);
  // Allow duplicate to reach its existing in-flight operation before releasing the writer.
  await sleep(30); await control('/release-save', {}, false);
  const [next, repeatedNext] = await Promise.all([pendingNext, duplicateNext]);
  assert.equal(next.status, 200, JSON.stringify(next)); assert.equal((next.body.turn as PreparedTurn).id, (repeatedNext.body.turn as PreparedTurn).id);
  assert.equal((await saved(first.id)).turns.length, 2);
  const acceptedEnd = { elapsedMs: 3500, metrics: { acceptedMarker: 'first-end', ...metrics } };
  const ended = await request(`/api/sessions/${first.id}/end`, acceptedEnd); assert.equal(ended.status, 202);
  const frozen = await saved(first.id), sessionPath = path.join(root, 'data/sessions', `${first.id}.json`);
  const frozenBytes = await readFile(sessionPath), frozenHash = hash(frozenBytes);
  const retryEnds = await Promise.all([request(`/api/sessions/${first.id}/end`, { elapsedMs: 9900, metrics: { acceptedMarker: 'late' } }), request(`/api/sessions/${first.id}/end`, acceptedEnd)]);
  assert.deepEqual(retryEnds.map(result => result.status), [202, 202]);
  await connection.close(); assert.deepEqual(await readFile(sessionPath), frozenBytes);
  const racing = await start(), racingConnection = await connect(racing.id);
  const racingScope = { turnId: racing.turn.id, answerId: uuid(), captureRevision: 1 };
  await racingConnection.exchange({ type: 'start', ...racingScope }, 'started'); racingConnection.ws.send(Buffer.alloc(3200));
  await control('/configure', { holdCaptureFinalSave: true });
  const racingFinish = racingConnection.exchange({ type: 'finish', ...racingScope, staged: true }, 'finalized');
  await poll(() => control('/state'), value => value.captureSaveBlocked === true, 'capture snapshot rename held');
  const racingEnd = request(`/api/sessions/${racing.id}/end`, { elapsedMs: 4500, metrics: { acceptedMarker: 'end-during-capture-save' } });
  await sleep(30); await control('/release-capture-save', {});
  const [racingFinal, racingEnded] = await Promise.all([racingFinish, racingEnd]);
  // The accepted end revokes the old capture response while keeping its saved words.
  assert.equal(racingFinal.type, 'error'); assert.equal(racingEnded.status, 202, JSON.stringify(racingEnded));
  const racingBytes = await readFile(path.join(root, 'data/sessions', `${racing.id}.json`));
  const racingSnapshot = await saved(racing.id);
  assert.equal(racingSnapshot.status, 'ending'); assert.equal(racingSnapshot.elapsedMs, 4500);
  assert.equal(racingSnapshot.runtime!.acceptedEndRequest!.metrics.acceptedMarker, 'end-during-capture-save');
  assert.equal(racingSnapshot.turns[0].rawTranscript, '합성 테스트 응답입니다.');
  await racingConnection.close();
  assert.deepEqual(await readFile(path.join(root, 'data/sessions', `${racing.id}.json`)), racingBytes);
  const otherConnection = await connect(other.id), otherAnswer = uuid();
  await otherConnection.exchange({ type: 'start', turnId: other.turn.id, answerId: otherAnswer, captureRevision: 1 }, 'started');
  otherConnection.ws.send(Buffer.alloc(320)); await sleep(30); await otherConnection.close();
  await poll(() => saved(other.id), value => Boolean(value.runtime!.checkpoint.disconnectedAt), 'disconnect saved');
  const priorOther = await saved(other.id);
  await stop(); await launch();
  assert.notEqual(launches[0], launches[1]);
  const recovered = await request(`/api/sessions/${other.id}`); assert.equal(recovered.status, 200, JSON.stringify(recovered));
  const recovery = recovered.body.recovery as Json;
  assert.equal((recovery.currentTurn as PreparedTurn).id, other.turn.id); assert.equal(recovery.answerId, otherAnswer); assert.equal(recovery.transcript, '합성 테스트'); assert.notEqual(recovery.transcriptStatus, 'finalized');
  assert.equal((await saved(other.id)).runtime!.contextSnapshotSha256, priorOther.runtime!.contextSnapshotSha256);
  assert.deepEqual(await readFile(sessionPath), frozenBytes);
  const sameNext = await request(`/api/sessions/${first.id}/next`, nextBody);
  // A frozen ending session follows the existing stopped-session response; never regenerates a question.
  assert.equal((await control('/state', undefined, false)).coreInvocations, 0);
  await poll(async () => readFile(path.join(root, 'data/conversation-logs', `${other.id}.jsonl`), 'utf8'), text => text.includes('session.restored'), 'restored log');
  await poll(async () => readFile(path.join(root, 'data/conversation-logs', `${first.id}.jsonl`), 'utf8'), text => text.includes('session.restored'), 'frozen session restored log settled');
  await poll(async () => readFile(path.join(root, 'data/conversation-logs', `${first.id}.jsonl`), 'utf8'), text => text.includes('"source":"http"') && text.includes('"code":"REQUEST_ERROR"'), 'rejected next error journal settled');
  await stop();
  const files: Array<{ path: string; bytes: number; sha256: string; text: string }> = [];
  const visit = async (directory: string) => { for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) { const file = path.join(directory, entry.name); if (entry.isDirectory()) await visit(file); else { const bytes = await readFile(file); files.push({ path: path.relative(root, file).replaceAll('\\', '/'), bytes: bytes.length, sha256: hash(bytes), text: bytes.toString('utf8') }); } } };
  await visit(path.join(root, 'data'));
  const logs = files.filter(file => file.path.endsWith('.jsonl')).map(file => ({ path: file.path, rows: file.text.trim().split('\n').map(line => JSON.parse(line) as Json) }));
  for (const log of logs) { assert.deepEqual(log.rows.map(row => row.seq), log.rows.map((_, index) => index + 1)); assert.equal(new Set(log.rows.map(row => row.eventId)).size, log.rows.length); assert.ok(log.rows.every(row => fileSession(log.path) === row.sessionId)); }
  const report = { version: 'pr06c-handler-evidence-v1', sourceRoot, controlled, realHttpWs: true, actualSessionLogWriters: true, actualProviderCalls: 0, privateFilesCopied: 0,
    processIds: launches, observations: { candidateCalls: 1, duplicateCandidateSameId: true, duplicateNextSameId: true, turns: frozen.turns.length, duplicateEndStatuses: retryEnds.map(value => value.status), frozenSessionBytesPreserved: true, endDuringCaptureSavePreserved: true, recoveredPartial: recovery.transcript, recoveredSameIds: true, originalContextPinPreserved: true, freshProcess: true, frozenNextStatus: sameNext.status, logSequenceAndIdsValid: true },
    rawEvidence: { firstId: first.id, otherId: other.id, scope, nextBody, candidate, candidateRetry, next, repeatedNext, acceptedEnd, ended, frozenHash, racingScope, racingFinal, racingEnded, racingHash: hash(racingBytes), recovered, sameNext, files },
    limitations: ['Synthetic providers/PCM, no real browser/device.', 'Controlled writer barrier, not arbitrary process races or power-loss durability.', 'No evaluation worker/provider/approval; real enqueue persists only existing downstream job.'] };
  await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, controlled, observations: report.observations, files: files.length }));
} finally { await stop(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('pr06c-handler-')); await rm(root, { recursive: true, force: true }); }
function fileSession(file: string) { return path.basename(file, '.jsonl'); }
