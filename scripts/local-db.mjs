import { loadProjectEnv, projectRoot } from './load-env.mjs';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

loadProjectEnv();
if (!process.env.DATABASE_URL) throw new Error('루트 .env.local에 DATABASE_URL을 설정해 주세요.');
let url;
try { url = new URL(process.env.DATABASE_URL); }
catch { throw new Error('루트 .env.local의 DATABASE_URL 형식을 확인해 주세요.'); }
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('db:start는 로컬 PostgreSQL 주소에서만 실행해 주세요.');
const workspace = projectRoot;
let runtimeRoot = workspace;
// PostgreSQL's Windows bootstrap encodes non-ASCII paths using the system code
// page. Use an ASCII junction; the persistent files remain in .local/postgres.
if (process.platform === 'win32' && /[^\x00-\x7f]/.test(workspace)) {
  const cache = join(homedir(), '.codex', 'local-runtimes');
  mkdirSync(cache, { recursive: true });
  runtimeRoot = join(cache, `gakja-${createHash('sha256').update(workspace).digest('hex').slice(0, 12)}`);
  if (!existsSync(runtimeRoot)) symlinkSync(workspace, runtimeRoot, 'junction');
  if (realpathSync(runtimeRoot).toLowerCase() !== realpathSync(workspace).toLowerCase()) throw new Error('로컬 PostgreSQL 경로를 확인해 주세요.');
}
const databaseDir = join(runtimeRoot, '.local', 'postgres');
mkdirSync(join(workspace, '.local'), { recursive: true });
let server = new EmbeddedPostgres({
  databaseDir, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
  port: Number(url.port || '54329'), persistent: true, authMethod: 'scram-sha-256',
  initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-h', '127.0.0.1'],
  onLog: (line) => { if (/ready to accept connections|database system is shut down/.test(String(line))) console.log(String(line)); },
});
if (runtimeRoot !== workspace) {
  const bin = join(runtimeRoot, 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'bin');
  let child;
  server = {
    async initialise() {
      const passwordFile = join(tmpdir(), `gakja-pg-${randomBytes(8).toString('hex')}`);
      writeFileSync(passwordFile, `${decodeURIComponent(url.password)}\n`);
      try {
        await new Promise((done, fail) => {
          const proc = spawn(join(bin, 'initdb.exe'), ['-D', databaseDir, '--auth=scram-sha-256', `--username=${decodeURIComponent(url.username)}`, `--pwfile=${passwordFile}`, '--encoding=UTF8', '--locale=C'], { cwd: runtimeRoot, env: { ...process.env, LC_MESSAGES: 'C' }, windowsHide: true });
          let error = ''; proc.stderr.on('data', (chunk) => { error += String(chunk); }); proc.on('error', fail); proc.on('exit', (code) => code === 0 ? done() : fail(new Error(error)));
        });
      } finally { unlinkSync(passwordFile); }
    },
    async start() {
      await new Promise((done, fail) => {
        child = spawn(join(bin, 'postgres.exe'), ['-D', databaseDir, '-p', url.port || '54329', '-h', '127.0.0.1'], { cwd: runtimeRoot, env: { ...process.env, LC_MESSAGES: 'C' }, windowsHide: true });
        let errors = ''; child.stderr.on('data', (chunk) => { const line = String(chunk); errors += line; if (line.includes('ready to accept connections')) done(); }); child.on('error', fail); child.on('exit', (code) => fail(new Error(`PostgreSQL exit ${code}: ${errors}`)));
      });
    },
    getPgClient() { return new pg.Client({ user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), host: '127.0.0.1', port: Number(url.port), database: 'postgres' }); },
    async stop() {
      await new Promise((done, fail) => { const proc = spawn(join(bin, 'pg_ctl.exe'), ['-D', databaseDir, 'stop', '-m', 'fast'], { cwd: runtimeRoot, windowsHide: true }); proc.on('error', fail); proc.on('exit', () => done()); });
    },
  };
}
const probe = new pg.Client({ connectionString: url.href });
try { await probe.connect(); console.log('PostgreSQL이 이미 실행 중이에요.'); await probe.end(); process.exit(0); }
catch { await probe.end().catch(() => {}); }
if (!existsSync(resolve(databaseDir, 'PG_VERSION'))) await server.initialise();
await server.start();
const client = server.getPgClient();
await client.connect();
const name = decodeURIComponent(url.pathname.slice(1));
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error('로컬 데이터베이스 이름을 확인해 주세요.');
const found = await client.query('select 1 from pg_database where datname=$1', [name]);
if (!found.rowCount) await client.query(`create database "${name}"`);
await client.end();
console.log(`PostgreSQL ${url.hostname}:${url.port} / ${name}`);
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await server.stop(); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
setInterval(() => {}, 60_000);
