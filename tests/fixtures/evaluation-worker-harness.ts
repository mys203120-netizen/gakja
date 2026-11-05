/** Separate real queue/worker process with an explicitly synthetic model
 * boundary. This helper never loads the developer's environment or API key. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { EvaluationJob } from '../../server/evaluation-job-store';

const workspace = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
async function unusedPort() {
  const server = net.createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
export async function startSyntheticEvaluationWorker(directory: string, environment: NodeJS.ProcessEnv) {
  assert.equal(environment.NODE_ENV, 'test');
  assert.equal(environment.OPENAI_API_KEY, 'synthetic-test-only');
  const controlPort = await unusedPort(), outfile = path.join(directory, 'evaluation-test-worker.cjs');
  const entry = path.join(workspace, 'server/evaluation-worker.ts'), fixture = path.join(workspace, 'tests/fixtures/realtime-providers.ts');
  const bundle = await build({ stdin: { resolveDir: workspace, sourcefile: 'synthetic-evaluation-worker-entry.ts',
    contents: `import { runEvaluationWorkerOnce } from ${JSON.stringify(entry)};
let stopping = false; process.on('SIGTERM', () => { stopping = true; });
(async () => { while (!stopping) { try { const result = await runEvaluationWorkerOnce({ reviewReadiness: () => ({ unitCount: 0, readyCount: 0, held: [], invalid: [] }) }); if (result.processed) continue; } catch (error) { console.error(error); } await new Promise(resolve => setTimeout(resolve, 20)); } })().catch(error => { console.error(error); process.exitCode = 1; });` },
    outfile, bundle: true, metafile: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent',
    plugins: [{ name: 'isolated-evaluation-provider', setup(builder) {
      builder.onResolve({ filter: /^\.\/providers\/openai$/ }, args => args.importer === entry ? { path: fixture } : undefined);
    } }],
  });
  const inputs = Object.keys(bundle.metafile!.inputs).map(input => input.replaceAll('\\', '/'));
  assert.ok(inputs.some(input => input.endsWith('server/evaluation-worker.ts')));
  assert.ok(inputs.some(input => input.endsWith('tests/fixtures/realtime-providers.ts')));
  assert.ok(!inputs.some(input => input.endsWith('server/providers/openai.ts')), 'The isolated worker must not bundle a live model provider');
  const child = spawn(process.execPath, [outfile], { cwd: directory,
    env: { ...environment, RECOVERY_TEST_CONTROL_PORT: String(controlPort) }, stdio: 'pipe', windowsHide: true });
  let diagnostic = ''; child.stdout.resume(); child.stderr.on('data', chunk => { diagnostic = `${diagnostic}${chunk}`.slice(-3000); });
  const control = async (route = '/state', body?: Record<string, unknown>) => {
    if (child.exitCode !== null) throw new Error('Synthetic evaluation worker exited: ' + diagnostic);
    const response = await fetch(`http://127.0.0.1:${controlPort}${route}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Recovery-Test-Token': environment.RECOVERY_TEST_TOKEN!, 'Content-Type': 'application/json', Connection: 'close' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200); return await response.json() as Record<string, unknown>;
  };
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill(); });
  };
  try {
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) { try { await control(); ready = true; break; } catch { if (child.exitCode !== null) throw new Error(diagnostic); await sleep(20); } }
    assert.ok(ready, 'Synthetic evaluation worker control must become ready');
    const jobs = async () => {
      const files = await readdir(path.join(directory, 'data/evaluation-jobs')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
      return await Promise.all(files.filter(file => /^[a-f0-9]{64}\.job\.json$/u.test(file)).map(async file => JSON.parse(await readFile(path.join(directory, 'data/evaluation-jobs', file), 'utf8')) as EvaluationJob));
    };
    const drain = async () => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) { if (!(await jobs()).some(job => ['queued', 'running'].includes(job.status))) return; await sleep(20); }
      throw new Error('Synthetic evaluation queue did not drain: ' + diagnostic);
    };
    return { control, close, jobs, drain, diagnostic: () => diagnostic };
  } catch (error) { await close(); throw error; }
}
