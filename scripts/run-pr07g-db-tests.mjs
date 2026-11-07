import { randomBytes, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import pg from 'pg';
import { applyOwnershipMigration, schemaFingerprint } from './pr07b-migration.mjs';
import { applyServiceInputsMigration } from './pr07g-service-inputs-migration.mjs';

const roles = ['gakja_owner','gakja_mapping','gakja_request','gakja_worker','gakja_bypass'];
const runId = process.env.PR07G_TEST_RUN_ID;
if (process.env.PR07G_TEST_DISPOSABLE !== '1' || !runId || !/^[a-z0-9_]{8,48}$/u.test(runId)) throw new Error('PR07G_EXPLICIT_DISPOSABLE_REQUIRED');
const output = path.resolve(process.env.PR07G_TEST_OUTPUT ?? `artifacts/pr07g/db-${runId}`);
if (!output.startsWith(path.resolve('artifacts/pr07g') + path.sep)) throw new Error('PR07G_OWNED_REPORT_DIRECTORY_REQUIRED');
await mkdir(output, { recursive: true });
const report = { version: 'pr07g-two-postgres-recovery-run-v1', runId, status: 'running', startedAt: new Date().toISOString(), clusters: [],
  sourceCommit: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), sourceStatus: execFileSync('git',['status','--porcelain=v1','-uall'],{encoding:'utf8'}).trim() };
const secrets = [process.env.PR07G_TEST_STORAGE_SERVICE_KEY,process.env.PR07G_TEST_RESTORE_STORAGE_SERVICE_KEY].filter(Boolean);
const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret,'[redacted]'),String(value)).replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gu,'[database-url]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,'[redacted-jwt]');
const quote = value => '"'+value.replaceAll('"','""')+'"';
const resources = [];
const env = { ...process.env };
async function setup(kind) {
  const prefix = kind === 'restore' ? 'RESTORE_' : '';
  const bootstrap = process.env['PR07G_TEST_'+prefix+'BOOTSTRAP_URL'];
  if (!bootstrap) throw new Error('PR07G_TWO_EXPLICIT_BOOTSTRAP_URLS_REQUIRED');
  const base = new URL(bootstrap); secrets.push(base.password,decodeURIComponent(base.password));
  if (!/^\/pr07g_admin_[a-z0-9_]+$/u.test(base.pathname)) throw new Error('PR07G_DISPOSABLE_ADMIN_DATABASE_REQUIRED');
  const admin = new pg.Client({ connectionString: bootstrap, connectionTimeoutMillis: 5000 }); await admin.connect();
  const resource = { kind, admin, createdRoles: false, createdDatabase: false, child: null, database: `pr07g_${prefix.toLowerCase()}${runId}` }; resources.push(resource);
  const marker = await admin.query('SELECT * FROM public.pr07g_disposable_marker');
  if (marker.rowCount !== 1 || marker.rows[0].run_id !== runId || marker.rows[0].marker !== 'gakja-pr07g-'+kind+'-disposable-only') throw new Error('PR07G_RESOURCE_MARKER_MISMATCH');
  const version = await admin.query('SHOW server_version');
  if (!/^17\.11(?:\s|$)/u.test(version.rows[0].server_version)) throw new Error('PR07G_POSTGRES_VERSION_MISMATCH');
  const existing = await admin.query(`SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','v','m','S')`);
  if (existing.rowCount !== 1 || existing.rows[0].nspname !== 'public' || existing.rows[0].relname !== 'pr07g_disposable_marker') throw new Error('PR07G_ADMIN_NOT_EMPTY');
  if ((await admin.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',[roles])).rowCount) throw new Error('PR07G_ROLES_ALREADY_EXIST');
  if ((await admin.query('SELECT datname FROM pg_database WHERE datname=$1',[resource.database])).rowCount) throw new Error('PR07G_CHILD_ALREADY_EXISTS');
  await admin.query(await readFile(new URL('../db/bootstrap-roles.sql',import.meta.url),'utf8')); resource.createdRoles=true;
  const credentials = roles.filter(role => role !== 'gakja_owner').map(role => [role,randomBytes(24).toString('base64url')]);
  for (const [role,password] of credentials) { secrets.push(password); await admin.query(`ALTER ROLE ${quote(role)} PASSWORD '${password}'`); }
  await admin.query(`CREATE DATABASE ${quote(resource.database)} OWNER gakja_owner`); resource.createdDatabase=true;
  await admin.query(`REVOKE ALL ON DATABASE ${quote(resource.database)} FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE ${quote(resource.database)} TO ${roles.map(quote).join(',')}`);
  const childUrl = new URL(bootstrap); childUrl.pathname='/'+resource.database;
  const child = new pg.Client({ connectionString: childUrl.href }); resource.child=child; await child.connect();
  await child.query('CREATE SCHEMA pr07g_control; REVOKE ALL ON SCHEMA pr07g_control FROM PUBLIC; CREATE TABLE pr07g_control.marker(run_id text PRIMARY KEY,marker text NOT NULL)');
  await child.query('INSERT INTO pr07g_control.marker VALUES($1,$2)',[runId,'gakja-pr07g-'+kind+'-owned-only']);
  await child.query('CREATE SCHEMA pr07b_control; REVOKE ALL ON SCHEMA pr07b_control FROM PUBLIC; CREATE TABLE pr07b_control.migrations(version text PRIMARY KEY,checksum text NOT NULL,fingerprint text NOT NULL)');
  const ownership = await applyOwnershipMigration(child);
  let seed = await readFile(new URL('../db/seed.synthetic.sql',import.meta.url),'utf8');
  if (kind === 'restore') seed=seed.slice(0,seed.indexOf('INSERT INTO gakja.session_bindings'));
  await child.query('BEGIN'); await child.query('SET LOCAL ROLE gakja_owner'); await child.query(seed); await child.query('COMMIT');
  const migration = await applyServiceInputsMigration(child), replay = await applyServiceInputsMigration(child);
  const data = { kind, database: resource.database, endpoint: { hostname: base.hostname, port: base.port }, postgres: version.rows[0].server_version, ownership, migration, replay,
    schemaFingerprint: await schemaFingerprint(child), seedSha256:createHash('sha256').update(seed).digest('hex'), mappingSeed:kind==='restore'?'fresh current mapping only; no historical permissions copied':'public synthetic B fixture',
    roles:(await child.query('SELECT rolname,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolinherit FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname',[roles])).rows,
    rls:(await child.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='gakja' AND c.relkind='r' ORDER BY c.relname")).rows,
    policies:(await child.query("SELECT * FROM pg_policies WHERE schemaname='gakja' ORDER BY tablename,policyname")).rows };
  report.clusters.push(data); env['PR07G_TEST_'+prefix+'ADMIN_URL']=childUrl.href;
  for (const [role,password] of credentials) { const url=new URL(childUrl);url.username=role;url.password=password;env['PR07G_TEST_'+prefix+role.replace('gakja_','').toUpperCase()+'_URL']=url.href; }
}
try {
  const source=new URL(process.env.PR07G_TEST_BOOTSTRAP_URL), restore=new URL(process.env.PR07G_TEST_RESTORE_BOOTSTRAP_URL);
  if (source.host===restore.host) throw new Error('PR07G_INDEPENDENT_POSTGRES_ENDPOINTS_REQUIRED');
  await setup('primary'); await setup('restore');
  for(const suffix of ['DISPOSABLE','RUN_ID','FIXTURE_ROOT','BASELINE_RESULT','BASELINE_CODE_ROOT','STORAGE_API_URL','STORAGE_SERVICE_KEY','STORAGE_ANON_KEY','BUCKET','KEY_PREFIX']) {
    if(env['PR07G_TEST_'+suffix]!==undefined) env['PR07E_TEST_'+suffix]=env['PR07G_TEST_'+suffix];
  }
  const files=['tests/transition/scoped-transition.db.test.ts','tests/transition/recovery.db.test.ts','tests/transition/service-inputs.db.test.ts'];
  if(process.env.PR07G_TEST_WITH_STORAGE==='1')files.push('tests/transition/scoped-service.integration.test.ts');
  const command=['--import','tsx','--test','--test-reporter=tap','--test-concurrency=1',...files];
  const child=spawn(process.execPath,command,{env,windowsHide:true,stdio:['ignore','pipe','pipe']}); let log='',progress=Promise.resolve();
  const observe=value=>{log+=value;progress=progress.then(()=>writeFile(path.join(output,'tests-progress.log'),redact(log)));};
  child.stdout.on('data',observe);child.stderr.on('data',observe);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);}); await progress;
  await writeFile(path.join(output,'tests.log'),redact(log));
  const count=name=>{const found=log.match(new RegExp('(?:#|ℹ) '+name+' (\\d+)'));return found?Number(found[1]):null;};
  report.command='node '+command.join(' ');report.tests={total:count('tests'),pass:count('pass'),fail:count('fail'),skipped:count('skipped'),cancelled:count('cancelled')};
  report.status=code===0&&report.tests.total>0&&report.tests.pass===report.tests.total&&report.tests.fail===0&&report.tests.skipped===0&&report.tests.cancelled===0?'passed':'failed';
  process.exitCode=report.status==='passed'?0:1;
} catch(error) { report.status='failed';report.error={code:error?.code??'PR07G_DB_RUN_FAILED',message:redact(error?.message??error),position:error?.position??null,internalPosition:error?.internalPosition??null};process.exitCode=1; }
finally {
  for(const resource of resources.reverse()) {
    try {
      if(resource.createdDatabase) {
        const marker=await resource.child?.query('SELECT * FROM pr07g_control.marker').catch(()=>null);
        if(marker?.rowCount!==1||marker.rows[0].run_id!==runId||marker.rows[0].marker!=='gakja-pr07g-'+resource.kind+'-owned-only') throw new Error('PR07G_CHILD_CLEANUP_MARKER_MISMATCH');
        await resource.child.end();await resource.admin.query(`DROP DATABASE ${quote(resource.database)} WITH (FORCE)`);
      }
      if(resource.createdRoles)for(const role of [...roles].reverse())await resource.admin.query(`DROP ROLE ${quote(role)}`);
      (report.cleanup??=[]).push({kind:resource.kind,ownedDatabaseRemoved:resource.createdDatabase,ownedRolesRemoved:resource.createdRoles});
    } catch(error) { (report.cleanup??=[]).push({kind:resource.kind,error:redact(error.message)});process.exitCode=1; }
    finally {await resource.child?.end().catch(()=>{});await resource.admin.end().catch(()=>{});}
  }
  if(process.exitCode)report.status='failed';report.finishedAt=new Date().toISOString();report.exitCode=process.exitCode??0;
  await writeFile(path.join(output,'db-run.json'),JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify({status:report.status,runId,tests:report.tests,clusters:report.clusters.map(c=>({kind:c.kind,postgres:c.postgres,migration:c.migration.checksum})),output,exitCode:report.exitCode}));
