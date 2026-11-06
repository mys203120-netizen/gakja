import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import path from 'node:path';
import pg from 'pg';

const execute = promisify(execFile);
const binaryDirectory = process.env.PR07C_POSTGRES_BIN;
if (!binaryDirectory || !path.isAbsolute(binaryDirectory)) throw new Error('PR07C_EXPLICIT_POSTGRES_BIN_REQUIRED');
const extension = process.platform === 'win32' ? '.exe' : '';
const binary = name => path.join(binaryDirectory, name + extension);
const version = (await execute(binary('postgres'), ['--version'], { windowsHide: true })).stdout.trim();
if (!/^postgres \(PostgreSQL\) 17\.11$/u.test(version)) throw new Error('PR07C_POSTGRES_VERSION_MISMATCH');
const runId = 'local_' + randomBytes(10).toString('hex');
const root = path.resolve('artifacts/pr07c/local-db', runId), allowed = path.resolve('artifacts/pr07c/local-db');
if (!root.startsWith(allowed + path.sep)) throw new Error('PR07C_CLUSTER_PATH_INVALID');
await mkdir(allowed, { recursive: true });
await mkdir(root, { recursive: false });
const data = path.join(root, 'data'), marker = path.join(root, 'owned-cluster.json');
await writeFile(marker, JSON.stringify({ runId, marker: 'gakja-pr07c-owned-disposable-cluster', data, version }) + '\n', { flag: 'wx' });
const password = randomBytes(24).toString('base64url'), passwordFile = path.join(root, 'init-password');
const redact = value => String(value).replaceAll(password, '[redacted]');
const report = { version: 'pr07c-local-cluster-v1', runId, postgresVersion: version, root, startedAt: new Date().toISOString(), status: 'running', network: 'loopback-only SCRAM host authentication', operatingDatabaseUsed: false };
let started = false;
try {
  await writeFile(passwordFile, password, { flag: 'wx', mode: 0o600 });
  try {
    const initialized = await execute(binary('initdb'), ['-D', data, '-U', 'pr07c_local_admin', '-E', 'UTF8', '--locale=C', '--auth-local=trust', '--auth-host=scram-sha-256', '--pwfile='+passwordFile], { windowsHide: true, maxBuffer: 4_000_000 });
    await writeFile(path.join(root, 'initdb.log'), redact(initialized.stdout + initialized.stderr));
  } finally { await unlink(passwordFile).catch(()=>{}); }
  const temporary = net.createServer(); await new Promise(resolve => temporary.listen(0,'127.0.0.1',resolve));
  const port = temporary.address().port; await new Promise(resolve => temporary.close(resolve)); report.port = port;
  // pg_ctl's Windows daemon can retain inherited pipe handles. Ignore stdio
  // and observe the owned launcher's exit, rather than awaiting pipe closure.
  await new Promise((resolve,reject)=>{
    const launcher=spawn(binary('pg_ctl'),['-D',data,'-l',path.join(root,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port} -F`,'-w','start'],{windowsHide:true,stdio:'ignore'});
    launcher.once('error',reject);launcher.once('exit',code=>code===0?resolve():reject(new Error('PR07C_PG_START_FAILED')));
  });
  started = true; await writeFile(path.join(root,'start.log'),'Owned pg_ctl -w start exited0; PostgreSQL startup log is postgres.log.\n');
  const url = new URL(`postgresql://pr07c_local_admin@127.0.0.1:${port}/postgres`);url.password=password;
  const admin = new pg.Client({ connectionString:url.href });await admin.connect();
  try { await admin.query(`CREATE DATABASE pr07c_admin_${runId}`); } finally { await admin.end(); }
  url.pathname='/pr07c_admin_'+runId;
  // Only this launcher may mark the database it just created in its owned cluster.
  // The general runner requires this marker before its first mutation.
  const markerClient=new pg.Client({connectionString:url.href});await markerClient.connect();
  try {
    await markerClient.query('CREATE TABLE public.pr07c_disposable_marker(run_id text PRIMARY KEY, marker text NOT NULL)');
    await markerClient.query('INSERT INTO public.pr07c_disposable_marker VALUES($1,$2)',[runId,'gakja-pr07c-disposable-only']);
  } finally {await markerClient.end();}
  const output = path.resolve(process.env.PR07C_TEST_OUTPUT ?? `artifacts/pr07c/db-${runId}`);
  const child = spawn(process.execPath,['scripts/run-pr07c-db-tests.mjs'],{cwd:process.cwd(),env:{...process.env,PR07C_TEST_DISPOSABLE:'1',PR07C_TEST_RUN_ID:runId,PR07C_TEST_BOOTSTRAP_URL:url.href,PR07C_TEST_OUTPUT:output},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',v=>{log+=v;});child.stderr.on('data',v=>{log+=v;});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  await writeFile(path.join(root,'runner.log'),redact(log));report.exitCode=code;report.status=code===0?'passed':'failed';report.output=output;process.exitCode=code===0?0:1;
} catch(error) {
  report.status='failed';report.error={code:error?.code??'PR07C_LOCAL_CLUSTER_FAILED',message:redact(error?.message??'Local PostgreSQL failed')};process.exitCode=1;
} finally {
  const ownership=JSON.parse(await readFile(marker,'utf8'));
  if(ownership.runId!==runId||ownership.data!==data||ownership.marker!=='gakja-pr07c-owned-disposable-cluster')throw new Error('PR07C_CLUSTER_MARKER_MISMATCH');
  if(started) {
    try {const stopped=await execute(binary('pg_ctl'),['-D',data,'-m','fast','-w','stop'],{windowsHide:true});report.stoppedOwnedCluster=true;await writeFile(path.join(root,'stop.log'),redact(stopped.stdout+stopped.stderr));}
    catch{report.stoppedOwnedCluster=false;report.status='failed';process.exitCode=1;}
  }
  report.finishedAt=new Date().toISOString();await writeFile(path.join(root,'cluster-report.json'),JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify({status:report.status,runId,clusterReport:path.join(root,'cluster-report.json'),output:report.output,exitCode:process.exitCode??0}));
