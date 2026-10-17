import { loadProjectEnv, projectRoot, redactEnvironmentSecrets } from './load-env.mjs';
import pg from 'pg';
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection, createServer } from 'node:net';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const root = projectRoot;
const logDir = join(root, '.local', 'logs');
const serverStatePath = join(root, '.local', 'server.json');
const webRoot = join(root, 'apps', 'web');
const webRequire = createRequire(join(webRoot, 'package.json'));
process.chdir(root);
loadProjectEnv();

function background(name, command, args, cwd = root, env = process.env) {
  const logPath = join(logDir, `${name}.log`);
  const log = openSync(logPath, 'a');
  let child;
  try {
    child = spawn(command, args, {
      cwd, env, detached: true, windowsHide: true,
      stdio: ['ignore', log, log],
    });
  } finally {
    closeSync(log);
  }
  const state = { exited: false, failed: false, logPath, error: null, exitCode: null };
  child.on('error', error => {
    state.failed = true;
    state.error = redactEnvironmentSecrets(`${error.code || 'SPAWN_ERROR'}: ${error.message}`);
    appendFileSync(logPath, `\n[launcher] ${state.error}\n`);
  });
  child.on('exit', code => {
    state.exited = true;
    state.exitCode = code;
    appendFileSync(logPath, `\n[launcher] Exit code: ${code}\n`);
  });
  child.unref();
  return state;
}

async function databaseReady() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2000,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false,
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function webReady(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/login`, { signal: AbortSignal.timeout(4000) });
    return response.ok && (await response.text()).includes('각자의답');
  } catch {
    return false;
  }
}

function portInUse(port) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    const finish = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

function portAvailable(port) {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', error => resolve({ available: false, code: error.code }));
    server.listen({ host: '0.0.0.0', port }, () => {
      server.close(() => resolve({ available: true }));
    });
  });
}

function validPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

async function selectWebPort() {
  const preferred = Number(process.env.PORT || 3000);
  if (!validPort(preferred)) throw new Error('.env.local의 PORT는 1~65535 사이 숫자로 설정해 주세요.');
  let previous;
  try { previous = JSON.parse(readFileSync(serverStatePath, 'utf8')).port; }
  catch { /* No previously started server. */ }
  const candidates = [...new Set([
    ...(validPort(previous) ? [previous] : []), preferred,
    ...Array.from({ length: 20 }, (_, index) => 3100 + index),
  ])];
  for (const port of candidates) {
    if (await portInUse(port)) {
      if (await webReady(port)) return { port, running: true, preferred };
      continue;
    }
    const result = await portAvailable(port);
    if (result.available) return { port, running: false, preferred };
    if (!['EACCES', 'EADDRINUSE'].includes(result.code)) {
      throw new Error(`${port}번 포트를 확인할 수 없어요 (${result.code}).`);
    }
  }
  throw new Error('사용 가능한 웹 포트가 없어요. .env.local의 PORT에 다른 포트를 지정해 주세요.');
}

function webEnvironment(appUrl) {
  const env = { ...process.env };
  let localUrl = !env.NEXT_PUBLIC_APP_URL;
  try {
    localUrl ||= ['localhost', '127.0.0.1', '[::1]'].includes(new URL(env.NEXT_PUBLIC_APP_URL).hostname);
  } catch { /* The app will report an invalid configured URL. */ }
  if (localUrl) env.NEXT_PUBLIC_APP_URL = appUrl;
  return env;
}

async function waitFor(check, state, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (state.failed || state.exited) {
      const detail = state.error || `종료 코드 ${state.exitCode}`;
      throw new Error(`${label} 실행에 실패했어요 (${detail}). 로그: ${state.logPath}`);
    }
    await delay(600);
  }
  throw new Error(`${label} 준비 시간이 초과됐어요. 로그: ${state.logPath}`);
}

async function main() {
  if (process.platform !== 'win32') throw new Error('이 실행 파일은 Windows용이에요.');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 이상을 설치해 주세요.');
  if (!existsSync(join(root, '.env.local')) && !existsSync(join(root, '.env')) && !process.env.DATABASE_URL) throw new Error('프로젝트 루트의 .env.local 파일이 필요해요. .env.example을 복사해 주세요.');
  if (!process.env.DATABASE_URL) throw new Error('.env.local에 DATABASE_URL을 설정해 주세요.');
  let database;
  try { database = new URL(process.env.DATABASE_URL); }
  catch { throw new Error('.env.local의 DATABASE_URL 형식을 확인해 주세요.'); }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname || !database.pathname.slice(1)) throw new Error('.env.local에 PostgreSQL 연결 주소와 데이터베이스 이름을 설정해 주세요.');
  if (!validPort(Number(process.env.PORT || 3000))) throw new Error('.env.local의 PORT는 1~65535 사이 숫자로 설정해 주세요.');
  if (process.argv.includes('--check-config')) {
    console.log('환경 설정 형식: 확인 완료 (.env.local → .env). 서버 실행과 외부 API 호출은 하지 않았어요.');
    return;
  }
  mkdirSync(logDir, { recursive: true });

  const local = ['localhost', '127.0.0.1'].includes(database.hostname);
  if (await databaseReady()) {
    console.log('PostgreSQL: 연결 완료');
  } else if (local) {
    console.log('로컬 PostgreSQL을 시작하고 있어요...');
    const state = background('postgres', process.execPath, [join(root, 'scripts', 'local-db.mjs')]);
    await waitFor(databaseReady, state, 'PostgreSQL', 60000);
  } else {
    throw new Error('원격 PostgreSQL에 연결할 수 없어요. .env.local의 DB 연결 설정을 확인해 주세요.');
  }

  const { port, running, preferred } = await selectWebPort();
  const appUrl = `http://localhost:${port}`;
  if (running) {
    console.log('웹 서버: 이미 실행 중이에요.');
  } else {
    if (port !== preferred) console.log(`${preferred}번 대신 ${port}번 포트로 실행합니다.`);
    console.log('웹 서버를 시작하고 있어요...');
    const nextCli = webRequire.resolve('next/dist/bin/next');
    const state = background('web', process.execPath, [
      nextCli, 'dev', '--webpack', '--hostname', '0.0.0.0', '--port', String(port),
    ], webRoot, webEnvironment(appUrl));
    await waitFor(() => webReady(port), state, '웹 서버');
  }
  writeFileSync(serverStatePath, JSON.stringify({ port, url: appUrl }, null, 2) + '\n');

  console.log(`\n실행 완료: ${appUrl}`);
  console.log(`로그: ${logDir}\n`);
  if (!process.argv.includes('--no-open')) {
    const opener = spawn('explorer.exe', [appUrl], { detached: true, windowsHide: true, stdio: 'ignore' });
    opener.on('error', () => { console.log(`브라우저에서 ${appUrl}을 열어 주세요.`); });
    opener.unref();
  }
}

main().catch(error => {
  console.error(`\n[오류] ${redactEnvironmentSecrets(error.message)}`);
  process.exitCode = 1;
});
