import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { build } from 'esbuild';
import { WebSocket, type RawData } from 'ws';
import { interviewConfig } from '../../interview.config';
import type { InterviewSession, PreparedTurn } from '../../server/protocol';
import { startSyntheticEvaluationWorker } from './evaluation-worker-harness';

type Json = Record<string, unknown>;
const workspace = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
async function unusedPort() {
  const server = net.createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
export async function poll<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await sleep(10); }
  throw new Error(`Staged capture fixture timed out: ${label}`);
}

export async function startStagedFixture(options: { evaluationWorker?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'interview-staging-'));
  let child: ChildProcessWithoutNullStreams | undefined;
  let worker: Awaited<ReturnType<typeof startSyntheticEvaluationWorker>> | undefined;
  const close = async () => {
    await worker?.close();
    if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => { child!.once('exit', () => resolve()); child!.kill(); });
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('interview-staging-'));
    await rm(directory, { recursive: true, force: true });
  };
  try {
    for (const [role, relative] of Object.entries(interviewConfig.files)) {
      if (role === 'sourceManifest') continue;
      const target = path.resolve(directory, relative);
      assert.ok(path.relative(directory, target) && !path.relative(directory, target).startsWith('..'));
      await mkdir(path.dirname(target), { recursive: true }); await copyFile(path.join(workspace, relative), target);
    }
    const outfile = path.join(directory, 'realtime-staged-test.cjs');
    const fixture = path.join(workspace, 'tests/fixtures/staged-realtime-providers.ts');
    const bundle = await build({ entryPoints: [path.join(workspace, 'server/realtime.ts')], outfile, bundle: true, metafile: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent', plugins: [{ name: 'isolated-staged-providers', setup(builder) {
      builder.onResolve({ filter: /^\.\/(?:submission-work|providers\/(?:openai|clova-tts|clova-stt|answer-reaction|realtime-core|single-core-runtime|approved-restatement)|data\/prepared-question-bank)$/ }, args => args.importer === path.join(workspace, 'server/realtime.ts') ? { path: fixture } : undefined);
      builder.onResolve({ filter: /^\.\/data\/load-interview-context$/ }, args => args.importer === path.join(workspace, 'server/realtime.ts') ? { path: path.join(workspace, 'tests/fixtures/recovery-context.ts') } : undefined);
      builder.onResolve({ filter: /^pdfjs-dist\/legacy\/build\/pdf\.mjs$/ }, () => ({ path: pathToFileURL(path.join(workspace, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href, external: true }));
    } }] });
    const inputs = Object.keys(bundle.metafile!.inputs).map(input => input.replaceAll('\\', '/'));
    assert.ok(inputs.some(input => input.endsWith('tests/fixtures/staged-realtime-providers.ts')));
    assert.ok(!inputs.some(input => /(?:^|\/)server\/(?:providers\/(?:openai|clova-tts|clova-stt|answer-reaction|realtime-core|single-core-runtime|approved-restatement)|data\/prepared-question-bank)\.ts$/u.test(input)), 'All external provider/core boundaries must be replaced before launching');
    const port = await unusedPort(), webPort = await unusedPort(), controlPort = await unusedPort(), stagedPort = await unusedPort(), token = randomUUID();
    const environment: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
    for (const name of ['SystemRoot', 'PATH', 'Path', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[name]) environment[name] = process.env[name]!;
    Object.assign(environment, { REALTIME_PORT: String(port), WEB_PORT: String(webPort), RECOVERY_TEST_CONTROL_PORT: String(controlPort), STAGED_TEST_CONTROL_PORT: String(stagedPort), RECOVERY_TEST_TOKEN: token, OPENAI_API_KEY: 'synthetic-test-only', CLOVA_SPEECH_SECRET_KEY: 'synthetic-test-only', CLOVA_VOICE_CLIENT_ID: 'synthetic-test-only', CLOVA_VOICE_CLIENT_SECRET: 'synthetic-test-only' });
    child = spawn(process.execPath, [outfile], { cwd: directory, env: environment, stdio: 'pipe', windowsHide: true });
    let diagnostic = ''; child.stdout.resume(); child.stderr.on('data', chunk => { diagnostic = `${diagnostic}${chunk}`.slice(-2_000); });
    const base = `http://127.0.0.1:${port}`, origin = `http://127.0.0.1:${webPort}`;
    await poll(async () => { if (child!.exitCode !== null) throw new Error(`Isolated staged server exited: ${diagnostic}`); try { return (await fetch(`${base}/api/health`, { headers: { Connection: 'close' }, signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }, Boolean, 'startup');
    if (options.evaluationWorker !== false) worker = await startSyntheticEvaluationWorker(directory, environment);
    const rawControl = async (route = '/state', body?: Json, staged = true) => {
      const response = await fetch(`http://127.0.0.1:${staged ? stagedPort : controlPort}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Recovery-Test-Token': token, 'Content-Type': 'application/json', Connection: 'close' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5_000) });
      assert.equal(response.status, 200); return await response.json() as Json;
    };
    const control = async (route = '/state', body?: Json, staged = true) => {
      if (staged || !worker) return rawControl(route, body, staged);
      if (route === '/reset') {
        await Promise.all([rawControl(route, body, false), worker.control(route, body)]);
        await worker.drain();
        await worker.control(route, body); return rawControl(route, body, false);
      }
      const local = await rawControl(route, body, false);
      if (route === '/configure' || route === '/release-save') await worker.control(route, body);
      if (body === undefined) {
        const remote = await worker.control();
        return { ...local, evaluationCalls: remote.evaluationCalls, evaluationSaveFailures: remote.evaluationSaveFailures,
          evaluationSaveBlocked: remote.evaluationSaveBlocked };
      }
      return local;
    };
    const request = async (route: string, body?: unknown) => {
      const response = await fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Connection: 'close' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
      return { status: response.status, body: await response.json() as Json };
    };
    const start = async () => {
      const prepared = await request('/api/prepare', {}); assert.equal(prepared.status, 200, `Synthetic preparation failed: ${JSON.stringify(prepared.body)} ${diagnostic}`);
      const session = await request('/api/sessions', { preparationId: prepared.body.preparationId }); assert.equal(session.status, 201);
      return { sessionId: session.body.sessionId as string, turn: session.body.turn as PreparedTurn };
    };
    const connect = async (sessionId: string) => {
      const ws = new WebSocket(`${base.replace('http:', 'ws:')}/api/realtime?sessionId=${sessionId}`, { origin });
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      const exchange = (body: Json, expected: string) => new Promise<Json>((resolve, reject) => {
        const timer = setTimeout(() => { ws.off('message', receive); reject(new Error(`Staged WS ${expected} timeout`)); }, 5_000);
        const receive = (raw: RawData) => { const event = JSON.parse(raw.toString()) as Json; if (event.type !== expected && event.type !== 'error') return; clearTimeout(timer); ws.off('message', receive); resolve(event); };
        ws.on('message', receive); ws.send(JSON.stringify(body));
      });
      return { ws, exchange, close: () => ws.close() };
    };
    const saved = async (sessionId: string) => JSON.parse(await readFile(path.join(directory, 'data/sessions', `${sessionId}.json`), 'utf8')) as InterviewSession;
    const evaluated = async (sessionId: string) => {
      const snapshot = await saved(sessionId), projection = (await request(`/api/sessions/${sessionId}`)).body;
      return { ...snapshot, status: projection.status, evaluationStatus: projection.evaluationStatus,
        evaluation: projection.evaluation, evaluationError: projection.evaluationError } as InterviewSession;
    };
    const logs = async (sessionId: string) => (await readFile(path.join(directory, 'data/conversation-logs', `${sessionId}.jsonl`), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Json);
    return { base, directory, worker, control, request, start, connect, saved, evaluated, logs, close, diagnostic: () => diagnostic + (worker?.diagnostic() ?? '') };
  } catch (error) { await close(); throw error; }
}
