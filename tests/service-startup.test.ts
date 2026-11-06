import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// This probe executes the actual entry module and every provider import. Only
// filesystem/network effects are intercepted; authentication is never stubbed.
const probe = `
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
const report = {privateReads:0,privateWrites:0,outboundCalls:0,privateOperations:[]};
const save = fs.writeFileSync.bind(fs);
const persist = () => save(process.env.PROBE_REPORT,JSON.stringify(report));
persist();
const sourceData = path.resolve(process.env.PROBE_SOURCE_ROOT,'server/data').replaceAll('\\\\','/').toLowerCase()+'/';
function personal(value) {
  if(typeof value!=='string' && !Buffer.isBuffer(value) && !(value instanceof URL)) return false;
  const raw=value instanceof URL?fileURLToPath(value):String(value);
  const resolved=path.resolve(raw).replaceAll('\\\\','/').toLowerCase();
  if(resolved.startsWith(sourceData) && /\\.(?:ts|js|mjs)$/u.test(resolved)) return false;
  return /\\/(?:data|\\.local)\\//u.test(resolved) || /\\.pdf$/u.test(resolved) || resolved.endsWith('/data') || resolved.endsWith('/.local');
}
for (const [target,names,write] of [[fs,['readFile','readFileSync','readdir','readdirSync','stat','statSync','lstat','lstatSync','access','accessSync','existsSync','createReadStream'],false],
 [fsp,['readFile','readdir','stat','lstat','access'],false],
 [fs,['writeFile','writeFileSync','appendFile','appendFileSync','mkdir','mkdirSync','rename','renameSync','unlink','unlinkSync','createWriteStream','open','openSync'],true],
 [fsp,['writeFile','appendFile','mkdir','rename','unlink','open'],true]]) {
  for(const name of names){ const original=target[name]; target[name]=function(...args){
    if(personal(args[0]) || (name.startsWith('rename') && personal(args[1]))) {
      report[write?'privateWrites':'privateReads']++; report.privateOperations.push(name);
      persist();
      throw new Error('SERVICE_STARTUP_PRIVATE_IO_FORBIDDEN');
    }
    return original.apply(this,args);
  };}
}
function blocked(){report.outboundCalls++;persist();throw new Error('SERVICE_STARTUP_OUTBOUND_FORBIDDEN');}
// tsx uses a local named/Unix pipe for loader IPC. It is not a TCP/provider call.
for(const name of ['connect','createConnection']) {
  const original=net[name];net[name]=function(...args){
    if(typeof args[0]==='string' && /(?:\\\\|\\/)tsx-[^\\/\\\\]+(?:\\\\|\\/)\\d+\\.pipe$/u.test(args[0])) return original.apply(this,args);
    return blocked();
  };
}
globalThis.fetch=blocked;tls.connect=blocked;
syncBuiltinESMExports();
process.on('exit',persist);
`;
const sourceRoot = process.cwd();
async function availablePort() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); return port;
}
async function launch(t: test.TestContext, settings: Record<string, string | undefined>, controlScript?: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'service-entry-')); t.after(() => rm(directory, { recursive: true, force: true }));
  // CLOVA's public protocol is the sole cwd-relative startup asset; no private
  // student input, environment file or dependency directory is copied.
  await mkdir(path.join(directory, 'server')); await copyFile(path.join(sourceRoot, 'server/clova.proto'), path.join(directory, 'server/clova.proto'));
  const guard = path.join(directory, 'guard.mjs'), reportPath = path.join(directory, 'effects.json');
  await writeFile(guard, probe);
  const port = await availablePort(), env: Record<string, string | undefined> = { ...process.env,
    REALTIME_PORT: String(port), WEB_PORT: '39999', NODE_ENV: 'production', PROBE_SOURCE_ROOT: sourceRoot, PROBE_REPORT: reportPath,
    LOCAL_INTERVIEW_OWNER_ID: 'spoofed-development-owner', OPENAI_API_KEY: '', CLOVA_SPEECH_SECRET_KEY: '', CLOVA_VOICE_CLIENT_ID: '', CLOVA_VOICE_CLIENT_SECRET: '' };
  for (const key of ['INTERVIEW_EXECUTION_MODE', 'INTERVIEW_AUTH_ISSUER', 'INTERVIEW_AUTH_AUDIENCE', 'INTERVIEW_AUTH_JWKS_URL', 'INTERVIEW_AUTH_ALGORITHMS']) delete env[key];
  Object.assign(env, settings);
  const entry = controlScript === undefined ? [path.join(sourceRoot, 'server/realtime.ts')] : ['--input-type=module', '--eval', controlScript];
  const child = spawn(process.execPath, ['--import', pathToFileURL(guard).href, '--import', pathToFileURL(path.join(sourceRoot, 'node_modules/tsx/dist/loader.mjs')).href,
    ...entry], { cwd: directory, env: env as NodeJS.ProcessEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', bytes => { output += bytes.toString(); }); child.stderr.on('data', bytes => { output += bytes.toString(); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  const stop = async () => { if (child.exitCode === null) child.kill(); await exited; };
  t.after(stop);
  return { child, exited, port, stop, output: () => output, effects: async () => JSON.parse(await readFile(reportPath, 'utf8')) as { privateReads: number; privateWrites: number; outboundCalls: number; privateOperations: string[] } };
}

test('startup probe detects real named filesystem imports and blocks a TCP provider connection before effects', { timeout: 30_000 }, async t => {
  const control = await launch(t, {}, `
    import { readFile, mkdir } from 'node:fs/promises';
    import { connect } from 'node:net';
    for (const operation of [() => readFile('data/prepared/student.json'), () => mkdir('data/sessions'), () => connect(443, 'provider.invalid')]) {
      try { await operation(); throw new Error('PROBE_MISSED_OPERATION'); }
      catch (error) { if (!String(error).includes('SERVICE_STARTUP_')) throw error; }
    }
  `);
  assert.equal(await control.exited, 0, control.output());
  assert.deepEqual(await control.effects(), { privateReads: 1, privateWrites: 1, outboundCalls: 1, privateOperations: ['readFile', 'mkdir'] });
});

test('actual realtime entry starts default production service without private input or recovery/provider effects', { timeout: 45_000 }, async t => {
  const server = await launch(t, {}), base = `http://127.0.0.1:${server.port}`;
  let healthy = false;
  for (let attempt = 0; attempt < 250; attempt++) {
    if (server.child.exitCode !== null) throw new Error(`Service startup failed: ${server.output()}`);
    try { healthy = (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { /* startup */ }
    if (healthy) break; await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(healthy, server.output());
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { app: 'each-answer-interview', ok: true, mode: 'service' });
  for (const [method, route] of [['GET', '/api/status'], ['POST', '/api/prepare'], ['POST', '/api/sessions'],
    ['GET', '/api/audio/known.wav'], ['GET', '/api/sessions/00000000-0000-4000-8000-000000000000'],
    ['POST', '/api/sessions/00000000-0000-4000-8000-000000000000/retry-evaluation']]) {
    const response = await fetch(base + route, { method, headers: { Authorization: 'Bearer explicit-synthetic-untrusted' } });
    assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const body = await response.json(); assert.equal(body.code, 'AUTH_UNAVAILABLE');
    assert.ok(!JSON.stringify(body).includes('spoofed-development-owner'));
  }
  await server.stop(); assert.deepEqual(await server.effects(), { privateReads: 0, privateWrites: 0, outboundCalls: 0, privateOperations: [] });
});

test('actual production entry rejects explicit local mode before any personal input or recovery IO', { timeout: 30_000 }, async t => {
  const server = await launch(t, { INTERVIEW_EXECUTION_MODE: 'local-development' });
  assert.notEqual(await server.exited, 0); assert.match(server.output(), /EXECUTION_MODE_INVALID/u);
  assert.deepEqual(await server.effects(), { privateReads: 0, privateWrites: 0, outboundCalls: 0, privateOperations: [] });
});

test('actual service entry rejects partial verifier configuration without key fetch or personal IO', { timeout: 30_000 }, async t => {
  const server = await launch(t, { INTERVIEW_EXECUTION_MODE: 'service', INTERVIEW_AUTH_ISSUER: 'https://explicit-synthetic.invalid' });
  assert.notEqual(await server.exited, 0); assert.match(server.output(), /AUTH_UNAVAILABLE/u);
  assert.deepEqual(await server.effects(), { privateReads: 0, privateWrites: 0, outboundCalls: 0, privateOperations: [] });
});
