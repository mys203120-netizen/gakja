import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { SignJWT } from 'jose';
import { prepareExactCBaseline } from './pr07d-baseline.mjs';

// This command starts only owned, empty, disposable Docker resources. It never
// reads DATABASE_URL, Supabase production env names, or preexisting buckets.
const storageImage = 'supabase/storage-api:v1.89.12@sha256:8526956cb462e9f7d392e9848ec77133b2769982ed614e9753cc687e8e4339a6';
const postgresImage = 'postgres:17.11';
const requestedRun = process.env.PR07D_TEST_RUN_ID;
const runId = requestedRun ?? 'storage_' + randomBytes(10).toString('hex');
if (!/^[a-z0-9_]{8,48}$/u.test(runId)) throw new Error('PR07D_RUN_ID_INVALID');
const output = path.resolve(process.env.PR07D_TEST_OUTPUT ?? 'artifacts/pr07d/storage-' + runId);
await mkdir(output, { recursive: true });
const execute = promisify(execFile);
const adminPassword = randomBytes(24).toString('hex'), storagePassword = randomBytes(24).toString('hex'), jwtSecret = randomBytes(32).toString('hex');
const secrets = [adminPassword, storagePassword, jwtSecret];
const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), String(value))
  .replace(/([?&]token=)[^\s"'<>]+/gu, '$1[redacted]')
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted-jwt]');
const report = { version: 'pr07d-owned-official-storage-shadow-run-v1', runId, output, status: 'running', startedAt: new Date().toISOString(),
  operatingInputsUsed: false, actualStudentDataTransferred: false, storageImage, postgresImage, providerBackend: 'official Supabase Storage REST API / internal file backend',
  sourceCommit: (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim(),
  sourceStatus: (await execute('git', ['status', '--porcelain=v1', '-uall'])).stdout.trim(), resources: [], cleanup: [] };
let networkId, storageContainerId, apiUrl, serviceKey, bucket, keyPrefix, controlBucket, createdBucket = false, createdControlBucket = false;
const controlBytes = Buffer.from('PR07D unrelated synthetic control object');
const containers = [];
async function docker(args) { return (await execute('docker', args, { windowsHide: true, timeout: 240_000, maxBuffer: 8_000_000 })).stdout.trim(); }
async function ownContainer(name, args) {
  const id = await docker(['run', '--detach', '--name', name, '--label', 'gakja.pr07d.run=' + runId, '--label', 'gakja.pr07d.disposable=true',
    '--network', networkId, ...args]);
  containers.push(id); report.resources.push({ type: 'container', id, name }); return id;
}
async function assertOwn(type, id) {
  const marker = await docker([type, 'inspect', id, '--format', '{{ index .Labels "gakja.pr07d.run" }}']);
  if (marker !== runId) throw new Error('PR07D_RESOURCE_MARKER_MISMATCH');
}
async function containerMarker(id) {
  const value = await docker(['inspect', id, '--format', '{{ index .Config.Labels "gakja.pr07d.run" }}']);
  if (value !== runId) throw new Error('PR07D_CONTAINER_MARKER_MISMATCH');
}
async function pgReady(id, database) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { await docker(['exec', id, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', database]); return; }
    catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  throw new Error('PR07D_OWNED_POSTGRES_NOT_READY');
}
async function port(id, value) { const result = await docker(['port', id, value]); const matched = result.match(/^127\.0\.0\.1:(\d+)$/u); if (!matched) throw new Error('PR07D_LOOPBACK_PORT_REQUIRED'); return matched[1]; }
async function api(route, init = {}, timeoutMs = 10_000) {
  return fetch(apiUrl + route, { ...init, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
    headers: { Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json', ...init.headers } });
}
try {
  await docker(['info', '--format', '{{.ServerVersion}}']);
  const baseline=await prepareExactCBaseline({runId,reportDirectory:output});
  report.baseline={codeCommit:baseline.report.codeCommit,freshLockfileInstall:true,nodeModulesCopied:false};
  // create rejects an existing name; this command never adopts it.
  // An internal Docker network disables host port publication. Use an owned
  // bridge with explicit loopback-only published ports for the host test driver.
  networkId = await docker(['network', 'create', '--label', 'gakja.pr07d.run=' + runId, 'pr07d-' + runId]);
  report.resources.push({ type: 'network', id: networkId });
  const database = 'pr07d_admin_' + randomBytes(8).toString('hex');
  const appDb = await ownContainer('pr07d-' + runId + '-appdb', ['--network-alias', 'app-db', '--tmpfs', '/var/lib/postgresql/data:rw',
    '-e', 'POSTGRES_DB=' + database, '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD=' + adminPassword, '-p', '127.0.0.1::5432', postgresImage]);
  const storageDb = await ownContainer('pr07d-' + runId + '-providerdb', ['--network-alias', 'provider-db', '--tmpfs', '/var/lib/postgresql/data:rw',
    '-e', 'POSTGRES_DB=postgres', '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD=' + storagePassword, postgresImage]);
  await pgReady(appDb, database); await pgReady(storageDb, 'postgres');
  await containerMarker(appDb); await containerMarker(storageDb);
  report.appPgImageId = await docker(['inspect', appDb, '--format', '{{.Image}}']);
  report.providerPgImageId = await docker(['inspect', storageDb, '--format', '{{.Image}}']);
  report.hostBinding = '127.0.0.1 only; owned bridge, provider DB has no published port';
  const appPort = await port(appDb, '5432/tcp');
  const bootstrapUrl = `postgresql://postgres:${adminPassword}@127.0.0.1:${appPort}/${database}`;
  const marker = new pg.Client({ connectionString: bootstrapUrl }); await marker.connect();
  try {
    await marker.query('CREATE TABLE public.pr07d_disposable_marker(run_id text PRIMARY KEY,marker text NOT NULL)');
    await marker.query('INSERT INTO public.pr07d_disposable_marker VALUES($1,$2)', [runId, 'gakja-pr07d-disposable-only']);
  } finally { await marker.end(); }
  const jwt = async role => new SignJWT({ role }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('3h').sign(new TextEncoder().encode(jwtSecret));
  serviceKey = await jwt('service_role'); const anonKey = await jwt('anon'); secrets.push(serviceKey, anonKey);
  if (process.env.GITHUB_ACTIONS === 'true') for (const value of secrets) process.stdout.write('::add-mask::' + value + '\n');
  const storageDbUrl = `postgresql://postgres:${storagePassword}@provider-db:5432/postgres`;
  const settings = {
    SERVER_PORT: '5000', AUTH_JWT_SECRET: jwtSecret, AUTH_JWT_ALGORITHM: 'HS256', ANON_KEY: anonKey, SERVICE_KEY: serviceKey,
    DATABASE_URL: storageDbUrl, DATABASE_POOL_URL: storageDbUrl, DB_INSTALL_ROLES: 'true', DB_SUPER_USER: 'postgres',
    STORAGE_BACKEND: 'file', STORAGE_FILE_BACKEND_PATH: '/var/lib/storage', STORAGE_S3_BUCKET: 'pr07d-internal',
    TENANT_ID: 'pr07d-test', REGION: 'local', UPLOAD_FILE_SIZE_LIMIT: '16777216', UPLOAD_FILE_SIZE_LIMIT_STANDARD: '16777216',
    UPLOAD_SIGNED_URL_EXPIRATION_TIME: '7200', IMAGE_TRANSFORMATION_ENABLED: 'false', JWT_CACHING_ENABLED: 'false',
    LOG_LEVEL: 'error', S3_PROTOCOL_ACCESS_KEY_ID: 'pr07d-synthetic', S3_PROTOCOL_ACCESS_KEY_SECRET: randomBytes(32).toString('hex'),
  };
  secrets.push(settings.S3_PROTOCOL_ACCESS_KEY_SECRET);
  const storage = await ownContainer('pr07d-' + runId + '-storage', ['--network-alias', 'storage', '--tmpfs', '/var/lib/storage:rw,mode=1777',
    ...Object.entries(settings).flatMap(([name, value]) => ['-e', name + '=' + value]), '-p', '127.0.0.1::5000', storageImage]);
  storageContainerId = storage;
  apiUrl = 'http://127.0.0.1:' + await port(storage, '5000/tcp');
  let healthy = false;
  const readinessDeadline = Date.now() + 90_000;
  while (Date.now() < readinessDeadline) {
    try { const response = await api('/bucket', {}, 2_000); if (response.ok) { await response.body?.cancel(); healthy = true; break; } await response.body?.cancel(); }
    catch { /* actual API/migrations are not ready */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!healthy) throw new Error('PR07D_ACTUAL_STORAGE_API_NOT_READY');
  await containerMarker(storage);
  report.providerReadyByActualApi = true;
  report.providerPgVersion = await docker(['exec', storageDb, 'postgres', '--version']);
  report.appPgVersion = await docker(['exec', appDb, 'postgres', '--version']);
  report.storageImageId = await docker(['inspect', storage, '--format', '{{.Image}}']);
  report.storageImageLabels = JSON.parse(await docker(['image', 'inspect', report.storageImageId, '--format', '{{json .Config.Labels}}']));
  bucket = 'pr07d-' + randomBytes(10).toString('hex');
  keyPrefix = 'run_' + randomBytes(12).toString('hex');
  const created = await api('/bucket', { method: 'POST', body: JSON.stringify({ id: bucket, name: bucket, public: false, file_size_limit: 16777216 }) });
  if (!created.ok) throw new Error('PR07D_PRIVATE_BUCKET_CREATE_FAILED'); await created.body?.cancel(); createdBucket = true;
  const verified = await api('/bucket/' + bucket); const bucketInfo = await verified.json();
  if (!verified.ok || bucketInfo.id !== bucket || bucketInfo.public !== false) throw new Error('PR07D_PRIVATE_BUCKET_VERIFICATION_FAILED');
  report.bucket = { id: bucket, private: true, createdByThisRun: true }; report.signedUploadConfiguredSeconds = 7200;
  controlBucket = 'pr07d-control-' + randomBytes(8).toString('hex');
  const controlCreated = await api('/bucket', { method: 'POST', body: JSON.stringify({ id: controlBucket, name: controlBucket, public: false }) });
  if (!controlCreated.ok) throw new Error('PR07D_CONTROL_BUCKET_CREATE_FAILED'); await controlCreated.body?.cancel(); createdControlBucket = true;
  const controlUploaded = await api('/object/' + controlBucket + '/unrelated-control', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'false' }, body: controlBytes });
  if (!controlUploaded.ok) throw new Error('PR07D_CONTROL_OBJECT_CREATE_FAILED'); await controlUploaded.body?.cancel();
  report.control = { privateBucketCreatedByRun: true, sha256: createHash('sha256').update(controlBytes).digest('hex') };
  const command = ['scripts/run-pr07d-db-tests.mjs'];
  const child = spawn(process.execPath, command, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    PR07D_TEST_DISPOSABLE: '1', PR07D_TEST_RUN_ID: runId, PR07D_TEST_BOOTSTRAP_URL: bootstrapUrl, PR07D_TEST_OUTPUT: output,
    PR07D_TEST_POSTGRES_IMAGE_DIGEST: report.appPgImageId,
    PR07D_TEST_FIXTURE_ROOT:baseline.fixtureRoot, PR07D_TEST_BASELINE_RESULT:baseline.baselineResult,
    PR07D_TEST_BASELINE_CODE_ROOT:baseline.codeRoot,
    PR07D_TEST_WITH_STORAGE: '1', PR07D_TEST_STORAGE_API_URL: apiUrl, PR07D_TEST_STORAGE_SERVICE_KEY: serviceKey,
    PR07D_TEST_STORAGE_ANON_KEY: anonKey, PR07D_TEST_BUCKET: bucket, PR07D_TEST_KEY_PREFIX: keyPrefix, PR07D_TEST_STORAGE_IMAGE: storageImage } });
  let log = ''; child.stdout.on('data', value => { log += value; }); child.stderr.on('data', value => { log += value; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  await writeFile(path.join(output, 'storage-tests.log'), redact(log));
  report.command = 'node ' + command.join(' '); report.testExitCode = code;
  if (code !== 0) throw new Error('PR07D_ACTUAL_STORAGE_TESTS_FAILED');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = redact(error?.message ?? 'PR07D_STORAGE_RUN_FAILED'); process.exitCode = 1;
} finally {
  // API deletion only. No SQL mutation of provider storage.objects/buckets.
  if (createdBucket && apiUrl && serviceKey) {
    try {
      // emptyBucket is an asynchronous queue in this version. Enumerate only
      // the server-allocated prefixes and use the actual delete API instead.
      for (const part of ['staging', 'final']) {
        const prefix = keyPrefix + '/' + part;
        for (let batch = 0; batch < 100; batch++) {
          const listed = await api('/object/list/' + bucket, { method: 'POST', body: JSON.stringify({ prefix, limit: 100, offset: 0 }) });
          if (!listed.ok) throw new Error('PR07D_OWN_OBJECT_LIST_FAILED');
          const rows = await listed.json();
          if (!Array.isArray(rows)) throw new Error('PR07D_OBJECT_LIST_RESPONSE_INVALID');
          if (!rows.length) break;
          if (rows.some(row => typeof row.name !== 'string' || !/^[a-f0-9-]{36}$/u.test(row.name))) throw new Error('PR07D_UNEXPECTED_OBJECT_KEY_REFUSED');
          const deleted = await api('/object/' + bucket, { method: 'DELETE', body: JSON.stringify({ prefixes: rows.map(row => prefix + '/' + row.name) }) });
          if (!deleted.ok) throw new Error('PR07D_OWN_OBJECT_DELETE_FAILED'); await deleted.body?.cancel();
          if (batch === 99) throw new Error('PR07D_CLEANUP_BOUND_EXCEEDED');
        }
      }
      const removed = await api('/bucket/' + bucket, { method: 'DELETE' });
      if (!removed.ok) throw new Error('PR07D_OWN_BUCKET_REMOVE_FAILED'); await removed.body?.cancel();
      report.cleanup.push({ type: 'bucket', own: true, removedByStorageApi: true });
    } catch (error) { report.cleanup.push({ type: 'bucket', error: redact(error.message) }); process.exitCode = 1; }
  }
  if (createdControlBucket && apiUrl && serviceKey) {
    try {
      const read = await api('/object/authenticated/' + controlBucket + '/unrelated-control');
      if (!read.ok || !Buffer.from(await read.arrayBuffer()).equals(controlBytes)) throw new Error('PR07D_UNRELATED_CONTROL_CHANGED');
      report.controlUnchangedThroughApplicationAndPrefixCleanup = true;
      const deleted = await api('/object/' + controlBucket, { method: 'DELETE', body: JSON.stringify({ prefixes: ['unrelated-control'] }) });
      if (!deleted.ok) throw new Error('PR07D_CONTROL_DELETE_FAILED'); await deleted.body?.cancel();
      const removed = await api('/bucket/' + controlBucket, { method: 'DELETE' });
      if (!removed.ok) throw new Error('PR07D_CONTROL_BUCKET_REMOVE_FAILED'); await removed.body?.cancel();
      report.cleanup.push({ type: 'control-bucket', own: true, unchangedBeforeOwnCleanup: true, removedByStorageApi: true });
    } catch (error) { report.cleanup.push({ type: 'control-bucket', error: redact(error.message) }); process.exitCode = 1; }
  }
  for (const id of [...containers].reverse()) {
    try {
      await containerMarker(id);
      const logs = await execute('docker', ['logs', id], { windowsHide: true, maxBuffer: 8_000_000 }).then(result => result.stdout + result.stderr).catch(() => '');
      await writeFile(path.join(output, id === storageContainerId ? 'provider-server.log' : 'postgres-' + id + '.log'), redact(logs));
      await docker(['rm', '--force', id]); report.cleanup.push({ type: 'container', id, own: true, removed: true });
    } catch (error) { report.cleanup.push({ type: 'container', id, error: redact(error.message) }); process.exitCode = 1; }
  }
  if (networkId) {
    try { await assertOwn('network', networkId); await docker(['network', 'rm', networkId]); report.cleanup.push({ type: 'network', own: true, removed: true }); }
    catch (error) { report.cleanup.push({ type: 'network', error: redact(error.message) }); process.exitCode = 1; }
  }
  if (process.exitCode) report.status = 'failed';
  report.finishedAt = new Date().toISOString(); report.exitCode = process.exitCode ?? 0;
  await writeFile(path.join(output, 'storage-run.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ status: report.status, sourceCommit: report.sourceCommit, actualStorageImage: storageImage,
  imageId: report.storageImageId, providerReadyByActualApi: report.providerReadyByActualApi, output, exitCode: report.exitCode }));
