import { randomBytes, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import pg from 'pg';
import { applyOwnershipMigration, schemaFingerprint } from './pr07b-migration.mjs';

const roleNames = ['gakja_owner','gakja_mapping','gakja_request','gakja_worker','gakja_bypass'];
const runId = process.env.PR07B_TEST_RUN_ID;
const bootstrap = process.env.PR07B_TEST_BOOTSTRAP_URL;
if (process.env.PR07B_TEST_DISPOSABLE !== '1' || !runId || !/^[a-z0-9_]{8,48}$/u.test(runId) || !bootstrap) {
  throw new Error('PR07B_EXPLICIT_DISPOSABLE_DATABASE_REQUIRED');
}
const baseUrl = new URL(bootstrap);
if (!/^\/pr07b_admin_[a-z0-9_]+$/u.test(baseUrl.pathname)) throw new Error('PR07B_DISPOSABLE_ADMIN_DATABASE_REQUIRED');
const database = `pr07b_${runId}`;
const output = path.resolve(process.env.PR07B_TEST_OUTPUT ?? `artifacts/pr07b/db-${runId}`);
await mkdir(output, { recursive: true });
const report = { version: 'pr07b-real-postgres-run-v1', runId, database, startedAt: new Date().toISOString(), status: 'running', checks: [],
  sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  sourceStatus:execFileSync('git',['status','--porcelain=v1','-uall'],{encoding:'utf8'}).trim(),
  imageDigest:process.env.PR07B_TEST_POSTGRES_IMAGE_DIGEST??null };
const admin = new pg.Client({ connectionString: bootstrap, connectionTimeoutMillis: 5000 });
let child, createdDatabase = false, createdRoles = false;
const credentials = roleNames.filter(name => name !== 'gakja_owner').map(name => [name, randomBytes(24).toString('base64url')]);
const secretValues = [baseUrl.password, decodeURIComponent(baseUrl.password), ...credentials.map(([, password]) => password)].filter(Boolean);
const redact = value => secretValues.reduce((text, password) => text.replaceAll(password, '[redacted]'), String(value)).replaceAll(bootstrap, '[disposable-admin-url]');
const quoteIdentifier = value => '"' + value.replaceAll('"','""') + '"';
async function save() { await writeFile(path.join(output, 'run.json'), JSON.stringify(report,null,2)+'\n'); }
try {
  await admin.connect();
  const details = await admin.query('SELECT version(),current_database(),current_user,session_user');
  report.server = details.rows[0];
  if (!/^PostgreSQL 17\.11\b/u.test(report.server.version)) throw new Error('PR07B_POSTGRES_VERSION_MISMATCH');
  const existing = await admin.query(`SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','v','m','S')`);
  if (existing.rows.some(row => row.nspname !== 'public' || row.relname !== 'pr07b_disposable_marker')) throw new Error('PR07B_ADMIN_DATABASE_NOT_EMPTY');
  if (existing.rowCount !== 1) throw new Error('PR07B_PREEXISTING_DISPOSABLE_MARKER_REQUIRED');
  const marker = await admin.query('SELECT * FROM public.pr07b_disposable_marker');
  if (marker.rowCount !== 1 || marker.rows[0].run_id !== runId || marker.rows[0].marker !== 'gakja-pr07b-disposable-only') throw new Error('PR07B_DISPOSABLE_MARKER_MISMATCH');
  if ((await admin.query('SELECT datname FROM pg_database WHERE datname=$1',[database])).rowCount) throw new Error('PR07B_CHILD_DATABASE_ALREADY_EXISTS');
  if ((await admin.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',[roleNames])).rowCount) throw new Error('PR07B_ROLES_ALREADY_EXIST');
  const bootstrapSql=await readFile(new URL('../db/bootstrap-roles.sql',import.meta.url),'utf8');report.bootstrapSha256=createHash('sha256').update(bootstrapSql).digest('hex');
  await admin.query(bootstrapSql); createdRoles=true;
  for (const [name,password] of credentials) await admin.query(`ALTER ROLE ${quoteIdentifier(name)} PASSWORD '${password}'`);
  await admin.query(`CREATE DATABASE ${quoteIdentifier(database)} OWNER gakja_owner`); createdDatabase=true;
  await admin.query(`REVOKE ALL ON DATABASE ${quoteIdentifier(database)} FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${roleNames.map(quoteIdentifier).join(',')}`);
  const childUrl = new URL(bootstrap); childUrl.pathname='/'+database;
  child = new pg.Client({connectionString:childUrl.href}); await child.connect();
  await child.query('CREATE SCHEMA pr07b_control');
  await child.query('REVOKE ALL ON SCHEMA pr07b_control FROM PUBLIC');
  await child.query('CREATE TABLE pr07b_control.marker(run_id text PRIMARY KEY, marker text NOT NULL)');
  await child.query('INSERT INTO pr07b_control.marker VALUES($1,$2)',[runId,'gakja-pr07b-disposable-only']);
  await child.query('CREATE TABLE pr07b_control.migrations(version text PRIMARY KEY, checksum text NOT NULL, fingerprint text NOT NULL)');
  report.migration = await applyOwnershipMigration(child);
  report.replay = await applyOwnershipMigration(child);
  await child.query('BEGIN'); await child.query('SET LOCAL ROLE gakja_owner');
  const seedSql=await readFile(new URL('../db/seed.synthetic.sql',import.meta.url),'utf8');report.seedSha256=createHash('sha256').update(seedSql).digest('hex');
  await child.query(seedSql); await child.query('COMMIT');
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
  const env = { ...process.env, PR07B_TEST_ADMIN_URL:childUrl.href };
  for (const [name,password] of credentials) {
    const url=new URL(childUrl);url.username=name;url.password=password;
    env[`PR07B_TEST_${name.replace('gakja_','').toUpperCase()}_URL`]=url.href;
    const connection=new pg.Client({connectionString:url.href});await connection.connect();
    try {const identity=await connection.query('SELECT current_user,session_user,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=current_user');(report.actualRoleConnections??=[]).push(identity.rows[0]);}
    finally {await connection.end();}
  }
  const command=['--import','tsx','--test','--test-concurrency=1','tests/db/rls-isolation.test.ts','tests/db/identity-integration.test.ts'];
  const run=spawn(process.execPath,command,{cwd:process.cwd(),env,windowsHide:true,stdio:['ignore','pipe','pipe']});let log='';
  run.stdout.on('data',value=>{log+=value;});run.stderr.on('data',value=>{log+=value;});
  const code=await new Promise((resolve,reject)=>{run.once('error',reject);run.once('exit',resolve);});
  await writeFile(path.join(output,'tests.log'),redact(log));
  report.command='node '+command.join(' ');report.exitCode=code;report.status=code===0?'passed':'failed';
  const count=name=>{const found=log.match(new RegExp('(?:#|ℹ) '+name+' (\\d+)'));return found?Number(found[1]):null;};
  report.tests={total:count('tests'),pass:count('pass'),fail:count('fail'),skipped:count('skipped')};
  process.exitCode=code===0?0:1;
} catch(error) {
  report.status='failed'; report.error={code:typeof error?.code==='string'?error.code:'PR07B_DATABASE_VERIFICATION_FAILED',message:redact(error?.message??'DB verification failed')};process.exitCode=1;
} finally {
  if(createdDatabase) {
    const marker=await child?.query('SELECT * FROM pr07b_control.marker').catch(()=>null);
    const owned=marker?.rowCount===1 && marker.rows[0].run_id===runId && marker.rows[0].marker==='gakja-pr07b-disposable-only';
    if(child)await child.end().catch(()=>{});
    if(owned) {await admin.query(`DROP DATABASE ${quoteIdentifier(database)} WITH (FORCE)`);report.cleanedOwnedDatabase=true;}
    else {report.cleanupError='PR07B_CHILD_MARKER_NOT_VERIFIED';process.exitCode=1;}
  } else if(child) {
    await child.end().catch(()=>{});
  }
  if(createdRoles)for(const role of [...roleNames].reverse())await admin.query(`DROP ROLE ${quoteIdentifier(role)}`).catch(error=>{report.cleanupError=error.code??'ROLE_CLEANUP_FAILED';process.exitCode=1;});
  await admin.end().catch(()=>{});if(process.exitCode)report.status='failed';report.exitCode=process.exitCode??0;report.finishedAt=new Date().toISOString();await save();
}
console.log(JSON.stringify({status:report.status,runId,tests:report.tests,postgres:report.server?.version,migrationSha256:report.migration?.checksum,seedSha256:report.seedSha256,roles:report.actualRoleConnections,output,exitCode:process.exitCode??0}));
