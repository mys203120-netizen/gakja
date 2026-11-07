import { randomBytes, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import pg from 'pg';
import { applyOwnershipMigration, schemaFingerprint } from './pr07b-migration.mjs';
import { applyPrivateStorageMigration } from './pr07c-migration.mjs';
import { applyReadShadowMigration } from './pr07d-migration.mjs';
import { applySessionWriterMigration } from './pr07e-migration.mjs';
import { applyEvaluationWriterMigration } from './pr07f-migration.mjs';

const roleNames = ['gakja_owner','gakja_mapping','gakja_request','gakja_worker','gakja_bypass'];
const runId = process.env.PR07F_TEST_RUN_ID;
const bootstrap = process.env.PR07F_TEST_BOOTSTRAP_URL;
if (process.env.PR07F_TEST_DISPOSABLE !== '1' || !runId || !/^[a-z0-9_]{8,48}$/u.test(runId) || !bootstrap) {
  throw new Error('PR07F_EXPLICIT_DISPOSABLE_DATABASE_REQUIRED');
}
const baseUrl = new URL(bootstrap);
if (!/^\/pr07f_admin_[a-z0-9_]+$/u.test(baseUrl.pathname)) throw new Error('PR07F_DISPOSABLE_ADMIN_DATABASE_REQUIRED');
const database = `pr07f_${runId}`;
const output = path.resolve(process.env.PR07F_TEST_OUTPUT ?? `artifacts/pr07f/db-${runId}`);
if (!output.startsWith(path.resolve('artifacts/pr07f') + path.sep)) throw new Error('PR07F_OWNED_REPORT_DIRECTORY_REQUIRED');
await mkdir(output, { recursive: true });
const report = { version: 'pr07f-real-postgres-run-v1', runId, database, startedAt: new Date().toISOString(), status: 'running', checks: [],
  sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  sourceStatus:execFileSync('git',['status','--porcelain=v1','-uall'],{encoding:'utf8'}).trim(),
  imageDigest:process.env.PR07F_TEST_POSTGRES_IMAGE_DIGEST??null };
const admin = new pg.Client({ connectionString: bootstrap, connectionTimeoutMillis: 5000 });
const restoreDatabase = `pr07f_restore_${runId}`;
let child, restoreChild, createdDatabase = false, createdRestoreDatabase = false, createdRoles = false;
const credentials = roleNames.filter(name => name !== 'gakja_owner').map(name => [name, randomBytes(24).toString('base64url')]);
const secretValues = [process.env.PR07F_TEST_STORAGE_SERVICE_KEY,process.env.PR07F_TEST_STORAGE_ANON_KEY,baseUrl.password, decodeURIComponent(baseUrl.password), ...credentials.map(([, password]) => password)].filter(Boolean);
const redact = value => secretValues.reduce((text, password) => text.replaceAll(password, '[redacted]'), String(value))
  .replaceAll(bootstrap, '[disposable-admin-url]').replace(/([?&]token=)[^\s"'<>]+/gu,'$1[redacted]')
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,'[redacted-jwt]');
const quoteIdentifier = value => '"' + value.replaceAll('"','""') + '"';
async function save() { await writeFile(path.join(output, 'run.json'), JSON.stringify(report,null,2)+'\n'); }
try {
  await admin.connect();
  const details = await admin.query('SELECT version(),current_database(),current_user,session_user');
  report.server = details.rows[0];
  if (!/^PostgreSQL 17\.11\b/u.test(report.server.version)) throw new Error('PR07F_POSTGRES_VERSION_MISMATCH');
  const existing = await admin.query(`SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','v','m','S')`);
  if (existing.rows.some(row => row.nspname !== 'public' || row.relname !== 'pr07f_disposable_marker')) throw new Error('PR07F_ADMIN_DATABASE_NOT_EMPTY');
  if (existing.rowCount !== 1) throw new Error('PR07F_PREEXISTING_DISPOSABLE_MARKER_REQUIRED');
  const marker = await admin.query('SELECT * FROM public.pr07f_disposable_marker');
  if (marker.rowCount !== 1 || marker.rows[0].run_id !== runId || marker.rows[0].marker !== 'gakja-pr07f-disposable-only') throw new Error('PR07F_DISPOSABLE_MARKER_MISMATCH');
  if ((await admin.query('SELECT datname FROM pg_database WHERE datname=$1',[database])).rowCount) throw new Error('PR07F_CHILD_DATABASE_ALREADY_EXISTS');
  if ((await admin.query('SELECT datname FROM pg_database WHERE datname=$1',[restoreDatabase])).rowCount) throw new Error('PR07F_RESTORE_DATABASE_ALREADY_EXISTS');
  if ((await admin.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',[roleNames])).rowCount) throw new Error('PR07F_ROLES_ALREADY_EXIST');
  const bootstrapSql=await readFile(new URL('../db/bootstrap-roles.sql',import.meta.url),'utf8');report.bootstrapSha256=createHash('sha256').update(bootstrapSql).digest('hex');
  await admin.query(bootstrapSql); createdRoles=true;
  for (const [name,password] of credentials) await admin.query(`ALTER ROLE ${quoteIdentifier(name)} PASSWORD '${password}'`);
  await admin.query(`CREATE DATABASE ${quoteIdentifier(database)} OWNER gakja_owner`); createdDatabase=true;
  await admin.query(`REVOKE ALL ON DATABASE ${quoteIdentifier(database)} FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${roleNames.map(quoteIdentifier).join(',')}`);
  const childUrl = new URL(bootstrap); childUrl.pathname='/'+database;
  child = new pg.Client({connectionString:childUrl.href}); await child.connect();
  await child.query('CREATE SCHEMA pr07f_control');
  await child.query('REVOKE ALL ON SCHEMA pr07f_control FROM PUBLIC');
  await child.query('CREATE TABLE pr07f_control.marker(run_id text PRIMARY KEY, marker text NOT NULL)');
  await child.query('INSERT INTO pr07f_control.marker VALUES($1,$2)',[runId,'gakja-pr07f-disposable-only']);
  await child.query('CREATE SCHEMA pr07b_control');
  await child.query('REVOKE ALL ON SCHEMA pr07b_control FROM PUBLIC');
  await child.query('CREATE TABLE pr07b_control.migrations(version text PRIMARY KEY, checksum text NOT NULL, fingerprint text NOT NULL)');
  report.baseMigration = await applyOwnershipMigration(child);
  report.baseReplay = await applyOwnershipMigration(child);
  await child.query('BEGIN'); await child.query('SET LOCAL ROLE gakja_owner');
  const seedSql=await readFile(new URL('../db/seed.synthetic.sql',import.meta.url),'utf8');report.seedSha256=createHash('sha256').update(seedSql).digest('hex');
  await child.query(seedSql); await child.query('COMMIT');
  report.privateStorageMigration = await applyPrivateStorageMigration(child);
  report.privateStorageReplay = await applyPrivateStorageMigration(child);
  report.readShadowMigration = await applyReadShadowMigration(child);
  report.readShadowReplay = await applyReadShadowMigration(child);
  report.sessionWriterMigration = await applySessionWriterMigration(child);
  report.sessionWriterReplay = await applySessionWriterMigration(child);
  report.migration = await applyEvaluationWriterMigration(child);
  report.replay = await applyEvaluationWriterMigration(child);
  report.schemaFingerprint = await schemaFingerprint(child);
  report.roles = (await child.query(`SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolbypassrls FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname`,[roleNames])).rows;
  report.memberships = (await child.query(`SELECT parent.rolname parent,member.rolname member FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member WHERE parent.rolname=ANY($1::text[]) OR member.rolname=ANY($1::text[])`,[roleNames])).rows;
  report.policies = (await child.query("SELECT * FROM pg_policies WHERE schemaname='gakja' ORDER BY tablename,policyname")).rows;
  report.tablePermissions = (await child.query("SELECT grantee,table_name,privilege_type FROM information_schema.role_table_grants WHERE table_schema='gakja' ORDER BY grantee,table_name,privilege_type")).rows;
  report.functionPermissions = (await child.query("SELECT grantee,routine_name,privilege_type FROM information_schema.routine_privileges WHERE routine_schema='gakja' ORDER BY grantee,routine_name")).rows;
  report.extensions = (await child.query('SELECT extname,extversion FROM pg_extension ORDER BY extname')).rows;
  report.rlsState = (await child.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='gakja' AND c.relkind='r' ORDER BY c.relname")).rows;
  report.representativeQueryPlan = (await child.query("EXPLAIN (FORMAT JSON) SELECT * FROM gakja.session_bindings WHERE owner_id='owner-a' AND student_id='student-a' AND application_target_id='app-a' AND session_id='11111111-1111-4111-8111-111111111111'")).rows[0]['QUERY PLAN'];
  report.queryPlanScope = 'Small synthetic fixture only; indexes and actual plan recorded, no production throughput claim';
  const env = { ...process.env, PR07F_TEST_ADMIN_URL:childUrl.href };
  for (const [name,password] of credentials) {
    const url=new URL(childUrl);url.username=name;url.password=password;
    env[`PR07F_TEST_${name.replace('gakja_','').toUpperCase()}_URL`]=url.href;
    const connection=new pg.Client({connectionString:url.href});await connection.connect();
    try {const identity=await connection.query('SELECT current_user,session_user,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=current_user');(report.actualRoleConnections??=[]).push(identity.rows[0]);}
    finally {await connection.end();}
  }
  { // Every advertised F SQL run includes its read-only restore case.
    await admin.query(`CREATE DATABASE ${quoteIdentifier(restoreDatabase)} OWNER gakja_owner`);createdRestoreDatabase=true;
    await admin.query(`REVOKE ALL ON DATABASE ${quoteIdentifier(restoreDatabase)} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(restoreDatabase)} TO ${roleNames.map(quoteIdentifier).join(',')}`);
    const restoreUrl=new URL(bootstrap);restoreUrl.pathname='/'+restoreDatabase;
    restoreChild=new pg.Client({connectionString:restoreUrl.href});await restoreChild.connect();
    await restoreChild.query('CREATE SCHEMA pr07f_control');await restoreChild.query('REVOKE ALL ON SCHEMA pr07f_control FROM PUBLIC');
    await restoreChild.query('CREATE TABLE pr07f_control.marker(run_id text PRIMARY KEY,marker text NOT NULL)');
    await restoreChild.query('INSERT INTO pr07f_control.marker VALUES($1,$2)',[runId,'gakja-pr07f-owned-restore-only']);
    await restoreChild.query('CREATE SCHEMA pr07b_control');await restoreChild.query('REVOKE ALL ON SCHEMA pr07b_control FROM PUBLIC');
    await restoreChild.query('CREATE TABLE pr07b_control.migrations(version text PRIMARY KEY,checksum text NOT NULL,fingerprint text NOT NULL)');
    const ownership=await applyOwnershipMigration(restoreChild);
    await restoreChild.query('BEGIN');await restoreChild.query('SET LOCAL ROLE gakja_owner');await restoreChild.query(seedSql);await restoreChild.query('COMMIT');
    const storage=await applyPrivateStorageMigration(restoreChild),shadow=await applyReadShadowMigration(restoreChild),writer=await applySessionWriterMigration(restoreChild),evaluation=await applyEvaluationWriterMigration(restoreChild);
    report.restoreDatabase={database:restoreDatabase,owned:true,separateFromPrimary:restoreDatabase!==database,migrations:{ownership,storage,shadow,writer,evaluation}};
    env.PR07F_TEST_RESTORE_ADMIN_URL=restoreUrl.href;
    for(const [name,password] of credentials){const url=new URL(restoreUrl);url.username=name;url.password=password;env[`PR07F_TEST_RESTORE_${name.replace('gakja_','').toUpperCase()}_URL`]=url.href;}
  }
  // Existing public E preparation readers are reused; only their explicit
  // disposable fixture/Storage aliases are populated, never personal env.
  for(const suffix of ['DISPOSABLE','RUN_ID','FIXTURE_ROOT','BASELINE_RESULT','BASELINE_CODE_ROOT','STORAGE_API_URL','STORAGE_SERVICE_KEY','STORAGE_ANON_KEY','BUCKET','KEY_PREFIX']){
    const value=env['PR07F_TEST_'+suffix];if(value!==undefined)env['PR07E_TEST_'+suffix]=value;
  }
  const files=['tests/evaluation-writer/evaluation-writer-db.test.ts'];
  if(process.env.PR07F_TEST_WITH_STORAGE==='1')files.push('tests/evaluation-writer/evaluation-writer.integration.test.ts');
  report.backendScope=process.env.PR07F_TEST_WITH_STORAGE==='1'?
    process.env.PR07F_TEST_CONTROLLED_PROVIDER_DIAGNOSTIC==='1'?'actual PostgreSQL + controlled memory provider diagnostic; actual Storage gate NOT satisfied':'actual Supabase Storage API + actual PostgreSQL + two independent evaluation workers':
    'actual PostgreSQL F SQL/repository only; no two-worker HTTP or actual Storage claim';
  const command=['--import','tsx','--test','--test-reporter=tap','--test-concurrency=1',...files];
  const run=spawn(process.execPath,command,{cwd:process.cwd(),env,windowsHide:true,stdio:['ignore','pipe','pipe']});let log='',progress=Promise.resolve();
  const observed=value=>{log+=value;const current=redact(log);progress=progress.then(()=>writeFile(path.join(output,'tests-progress.log'),current));};
  run.stdout.on('data',observed);run.stderr.on('data',observed);
  const code=await new Promise((resolve,reject)=>{run.once('error',reject);run.once('exit',resolve);});
  await progress;await writeFile(path.join(output,'tests.log'),redact(log));
  report.command='node '+command.join(' ');report.exitCode=code;report.status=code===0?'passed':'failed';
  const count=name=>{const found=log.match(new RegExp('(?:#|ℹ) '+name+' (\\d+)'));return found?Number(found[1]):null;};
  report.tests={total:count('tests'),pass:count('pass'),fail:count('fail'),skipped:count('skipped'),cancelled:count('cancelled')};
  if (code === 0 && (report.tests.total === null || report.tests.fail !== 0 || report.tests.skipped !== 0 || report.tests.cancelled !== 0 || report.tests.pass !== report.tests.total)) {
    report.status='failed';report.error={code:'PR07F_COMPLETE_UNSKIPPED_RESULT_REQUIRED'};
  }
  process.exitCode=report.status==='passed'?0:1;
} catch(error) {
  report.status='failed'; report.error={code:typeof error?.code==='string'?error.code:'PR07F_DATABASE_VERIFICATION_FAILED',message:redact(error?.message??'DB verification failed'),position:error?.position??null,internalPosition:error?.internalPosition??null};process.exitCode=1;
} finally {
  if(createdRestoreDatabase) {
    const marker=await restoreChild?.query('SELECT * FROM pr07f_control.marker').catch(()=>null);
    const owned=marker?.rowCount===1&&marker.rows[0].run_id===runId&&marker.rows[0].marker==='gakja-pr07f-owned-restore-only';
    await restoreChild?.end().catch(()=>{});
    if(owned){await admin.query(`DROP DATABASE ${quoteIdentifier(restoreDatabase)} WITH (FORCE)`);report.cleanedOwnedRestoreDatabase=true;}
    else{report.restoreCleanupError='PR07F_RESTORE_MARKER_NOT_VERIFIED';process.exitCode=1;}
  } else if(restoreChild) await restoreChild.end().catch(()=>{});
  if(createdDatabase) {
    const marker=await child?.query('SELECT * FROM pr07f_control.marker').catch(()=>null);
    const owned=marker?.rowCount===1 && marker.rows[0].run_id===runId && marker.rows[0].marker==='gakja-pr07f-disposable-only';
    if(child)await child.end().catch(()=>{});
    if(owned) {await admin.query(`DROP DATABASE ${quoteIdentifier(database)} WITH (FORCE)`);report.cleanedOwnedDatabase=true;}
    else {report.cleanupError='PR07F_CHILD_MARKER_NOT_VERIFIED';process.exitCode=1;}
  } else if(child) {
    await child.end().catch(()=>{});
  }
  if(createdRoles)for(const role of [...roleNames].reverse())await admin.query(`DROP ROLE ${quoteIdentifier(role)}`).catch(error=>{report.cleanupError=error.code??'ROLE_CLEANUP_FAILED';process.exitCode=1;});
  await admin.end().catch(()=>{});if(process.exitCode)report.status='failed';report.exitCode=process.exitCode??0;report.finishedAt=new Date().toISOString();await save();
}
console.log(JSON.stringify({status:report.status,runId,tests:report.tests,postgres:report.server?.version,migrationSha256:report.migration?.checksum,seedSha256:report.seedSha256,roles:report.actualRoleConnections,output,exitCode:process.exitCode??0}));
