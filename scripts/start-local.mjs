import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import { resetLocalServerPorts, recordServerProcess } from './local-server-reset.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceId = createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0,16);
process.chdir(root);
const children = new Set();
let stopping = false;
function run(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
    children.add(child);
    child.once('error', reject);
    child.once('exit', (code) => {
      children.delete(child);
      if (code === 0) resolve(); else reject(new Error(`${path.basename(binary)} exited (${code})`));
    });
  });
}
async function background(args, port) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true, env: process.env });
  children.add(child);
  child.once('error', e => { console.error(e.message); shutdown(1); });
  child.once('exit', code => { children.delete(child); if (!stopping) shutdown(code || 1); });
  await recordServerProcess(root, child.pid, port === undefined ? [] : [port]);
  return child;
}
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (process.platform === 'win32' && child.pid) {
      // Only owned process trees, never a process name or arbitrary occupied port.
      spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 700);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
async function response(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1800) }); return r.ok ? await r.json() : null; }
  catch { return null; }
}
async function free(port) {
  return await new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
async function waitFor(url, predicate, maxMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const result = await response(url);
    if (predicate(result)) return result;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error(`서버 준비 응답을 받지 못했습니다: ${url}`);
}
function openBrowser(url) {
  const args = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(args[0], args[1], { stdio: 'ignore', windowsHide: true });
  child.once('error', () => console.log(`브라우저에서 열어 주세요: ${url}`));
  child.unref();
}

try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 이상 LTS 버전이 필요합니다: https://nodejs.org');
  const lock = path.join(root, 'package-lock.json');
  const stamp = path.join(root, 'node_modules', '.interview-dependency-hash');
  const hash = () => createHash('sha256').update(readFileSync('package.json')).update(existsSync(lock) ? readFileSync(lock) : '').digest('hex');
  const needsInstall = !existsSync('node_modules/next/package.json') || !existsSync(stamp) || readFileSync(stamp, 'utf8') !== hash();
  if (needsInstall) {
    console.log('프로젝트 의존성을 준비합니다.');
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!existsSync(npmCli)) throw new Error('npm을 찾지 못했습니다. 터미널에서 npm ci를 실행한 뒤 다시 시작해 주세요.');
    await run(process.execPath, [npmCli, existsSync(lock) ? 'ci' : 'install', '--no-audit', '--no-fund']);
    writeFileSync(stamp, hash());
  }
  const { config } = await import('dotenv');
  if (!existsSync('.env.local')) {
    writeFileSync('.env.local', readFileSync('.env.example'));
    console.log('.env.local을 만들었습니다. 실제 API 키를 입력한 후 서버를 다시 시작해 주세요.');
  }
  config({ path: path.join(root, '.env.local'), quiet: true });
  const web = Number(process.env.WEB_PORT || 3000);
  const realtime = Number(process.env.REALTIME_PORT || 3001);
  if (![web,realtime].every(p=>Number.isInteger(p)&&p>=1024&&p<=65535) || web===realtime) throw new Error('WEB_PORT와 REALTIME_PORT는 서로 다른 1024~65535 포트여야 합니다.');
  const reset = process.argv.includes('--reset-ports');
  if (reset) await resetLocalServerPorts(root, [web, realtime]);
  if (process.argv.includes('--reset-ports-only')) {
    if (!reset) throw new Error('--reset-ports-only에는 --reset-ports가 필요합니다.');
    process.exit(0);
  }
  await recordServerProcess(root, process.pid);
  const health = await response(`http://127.0.0.1:${web}/api/health`);
  if (!reset && health?.app === 'each-answer-interview' && health.ok && health.workspaceId === workspaceId) {
    console.log(`이미 실행 중인 면접 서버를 사용합니다: http://localhost:${web}/interview`);
    if (!process.argv.includes('--no-open')) openBrowser(`http://localhost:${web}/interview`);
  } else {
    for (const port of [web,realtime]) if (!await free(port)) throw new Error(`${port} 포트를 다른 프로그램이 사용 중입니다. .env.local의 WEB_PORT/REALTIME_PORT를 변경해 주세요.`);
    await run(process.execPath, ['scripts/prepare-assets.mjs']);
    try { if (process.argv.includes('--prepare-data') || !existsSync('data/prepared/source-manifest.json')) await run(process.execPath, ['scripts/prepare-context.mjs']); }
    catch { console.warn('학생부 자료 준비가 완료되지 않았습니다. 면접 화면에서 구체적인 설정 오류를 확인해 주세요.'); }
    const preparationKeys = ['OPENAI_API_KEY', 'CLOVA_SPEECH_SECRET_KEY', 'CLOVA_VOICE_CLIENT_ID', 'CLOVA_VOICE_CLIENT_SECRET'];
    if (process.argv.includes('--prepare-data') && preparationKeys.every(key => process.env[key]?.trim())) {
      try {
        await run(process.execPath, ['--import', 'tsx', 'scripts/prepare-question-references.ts']);
        await run(process.execPath, ['--import', 'tsx', 'scripts/analyze-question-references.ts', '--run-live', '--resume']);
        await run(process.execPath, ['--import', 'tsx', 'scripts/compile-interviewer-policy.ts']);
        await run(process.execPath, ['--import', 'tsx', 'scripts/prepare-question-strategies.ts', '--run-live']);
        await run(process.execPath, ['--import', 'tsx', 'scripts/prepare-activities.ts', '--run-live']);
        await run(process.execPath, ['--import', 'tsx', 'scripts/prepare-interview-bank.ts', '--run-live']);
      } catch { console.warn('면접 사전 준비가 완료되지 않았습니다. 자료와 API 연결을 확인한 뒤 다시 실행해 주세요.'); }
    }
    console.log('저장된 면접 자료를 사용해 서버를 시작합니다.');
    await background(['--import', 'tsx', path.join(root, 'server/realtime.ts')], realtime);
    await waitFor(`http://127.0.0.1:${realtime}/api/health`, r => r?.app === 'each-answer-interview' && r.ok && r.workspaceId === workspaceId);
    await background(['--import', 'tsx', path.join(root, 'scripts/run-evaluation-worker.ts')]);
    await background([path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(web)], web);
    await waitFor(`http://127.0.0.1:${web}/api/health`, r => r?.app === 'each-answer-interview' && r.ok && r.workspaceId === workspaceId);
    const page = await fetch(`http://127.0.0.1:${web}/interview`, { signal: AbortSignal.timeout(120000) });
    if (!page.ok) throw new Error(`면접 화면을 열지 못했습니다 (${page.status}).`);
    console.log(`면접 화면: http://localhost:${web}/interview\n종료: 이 창에서 Ctrl+C`);
    if (!process.argv.includes('--no-open')) openBrowser(`http://localhost:${web}/interview`);
  }
} catch (e) { console.error(`\n실행 오류: ${e.message}`); shutdown(1); }
