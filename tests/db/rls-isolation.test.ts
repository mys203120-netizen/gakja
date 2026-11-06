import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { testPools, closePools } from './test-database';
import { applyOwnershipMigration } from '../../scripts/pr07b-migration.mjs';
import { snapshotHash } from '../../server/session-runtime';

const pools = testPools();
test.after(() => closePools(pools));
type Account = { accountId: string; ownerId: string; revision: string; grants: Array<{studentId:string;applicationTargetId:string;supportTargetId:string;sourceRevision?:string|null}> };
const issuer = (who:string) => who==='b'?'https://issuer-b.example':'https://issuer-a.example';
const subject = (who:string) => who==='c'?'c':'shared';
async function account(client:PoolClient,who:string):Promise<Account> {
  await client.query("SELECT set_config('gakja.issuer',$1,true),set_config('gakja.subject',$2,true)",[issuer(who),subject(who)]);
  return (await client.query('SELECT gakja.resolve_account($1,$2) value',[issuer(who),subject(who)])).rows[0].value;
}
/** Deliberately SQL-context-only tests. This carrier is not JWT authentication;
 * the separately executed integration file exercises the real verifier. */
async function scoped<T>(who:string,operation:(client:PoolClient,value:Account)=>Promise<T>,app=`app-${who}`) {
  const client=await pools.request.connect();await client.query('BEGIN');
  try {
    const value=await account(client,who),grant=value.grants.find(g=>g.applicationTargetId===app);assert.ok(grant);
    for(const [key,setting] of Object.entries({account_id:value.accountId,owner_id:value.ownerId,account_revision:value.revision,student_id:grant.studentId,application_target_id:grant.applicationTargetId}))await client.query('SELECT set_config($1,$2,true)',['gakja.'+key,setting]);
    const result=await operation(client,value);await client.query('ROLLBACK');return result;
  } catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function denied(operation:()=>Promise<unknown>,codes=['42501']) {
  await assert.rejects(operation(),error=>codes.includes((error as {code?:string}).code??''));
}

test('actual restricted connections are neither owners nor superusers/bypass roles and have no escalation membership',async()=>{
  for(const [name,pool] of [['gakja_request',pools.request],['gakja_worker',pools.worker]] as const) {
    const result=await pool.query('SELECT current_user,session_user,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=current_user');
    assert.equal(result.rows[0].current_user,name);assert.equal(result.rows[0].session_user,name);
    for(const flag of ['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb'])assert.equal(result.rows[0][flag],false);
    assert.equal((await pool.query('SELECT count(*)::int n FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)')).rows[0].n,0);
    await denied(()=>pool.query('SET ROLE gakja_owner'));await denied(()=>pool.query('SET ROLE gakja_bypass'));
  }
  const tables=await pools.admin.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='gakja' AND c.relkind='r' AND c.relname<>'target_profiles'");
  assert.ok(tables.rowCount!>=16);for(const row of tables.rows){assert.equal(row.relrowsecurity,true);assert.equal(row.relforcerowsecurity,true);assert.equal(row.owner,'gakja_owner');}
});

test('SQL carrier A and B each see their own rows across direct lookup, join, search, count and pagination',async()=>{
  for(const who of ['a','b'])await scoped(who,async client=>{
    const own='owner-'+who,other=who==='a'?'owner-b':'owner-a';
    for(const table of ['students','application_targets','session_bindings','audio_bindings','common_versions','target_versions','private_objects','legacy_mappings']){
      const rows=await client.query(`SELECT owner_id FROM gakja.${table}`);assert.ok(rows.rowCount!>0,table);assert.ok(rows.rows.every(row=>row.owner_id===own),table);
      assert.equal((await client.query(`SELECT count(*)::int n FROM gakja.${table} WHERE owner_id=$1`,[other])).rows[0].n,0,table);
    }
    const joined=await client.query('SELECT s.owner_id,a.application_target_id FROM gakja.students s JOIN gakja.application_targets a USING(owner_id,student_id) WHERE s.display_name ILIKE $1 ORDER BY a.application_target_id LIMIT 1 OFFSET 0',['%synthetic%']);
    assert.equal(joined.rowCount,1);assert.equal(joined.rows[0].owner_id,own);
    assert.equal((await client.query('SELECT count(*)::int n FROM gakja.students s JOIN gakja.application_targets a ON a.owner_id<>s.owner_id')).rows[0].n,0);
  });
  assert.equal((await pools.request.query('SELECT count(*)::int n FROM gakja.students')).rows[0].n,0,'pool connection outside transaction has no identity');
});

test('different issuers with one subject map separately and absent/null/string source pins roundtrip distinctly',async()=>{
  const values=[];
  for(const who of ['a','b','c'])values.push(await scoped(who,async(_client,value)=>value));
  assert.deepEqual(values.map(v=>v.ownerId),['owner-a','owner-b','owner-c']);
  assert.equal(Object.hasOwn(values[0].grants.find(g=>g.applicationTargetId==='app-a')!,'sourceRevision'),false);
  assert.equal(values[0].grants.find(g=>g.applicationTargetId==='app-a2')!.sourceRevision,null);
  assert.equal(values[1].grants[0].sourceRevision,null);assert.equal(values[2].grants[0].sourceRevision,'source-r1');
  await scoped('a',async client=>assert.equal((await client.query('SELECT count(*)::int n FROM gakja.common_versions')).rows[0].n,0),'app-a2');
  await scoped('c',async client=>assert.equal((await client.query('SELECT count(*)::int n FROM gakja.common_versions')).rows[0].n,1));
  const hashes=await pools.admin.query('SELECT count(DISTINCT source_sha256)::int hashes,count(*)::int people FROM gakja.students');assert.equal(hashes.rows[0].hashes,1);assert.equal(hashes.rows[0].people,3);
});

test('own allowed immutable insert and pointer DML preserve original UTF8 bytes/hash/key order and missing/null',async()=>{
  const bytes=Buffer.from('{"z":2,"a":"한글🙂","nullable":null}\r\n'),hash=createHash('sha256').update(bytes).digest('hex');
  const domainHash=snapshotHash(JSON.parse(bytes.toString('utf8')));assert.notEqual(domainHash,hash);
  await scoped('a',async client=>{
    const existing=await client.query('SELECT original_bytes,content_sha256,domain_sha256 FROM gakja.common_versions UNION ALL SELECT original_bytes,content_sha256,domain_sha256 FROM gakja.target_versions');
    assert.equal(existing.rowCount,2);for(const version of existing.rows){assert.equal(createHash('sha256').update(version.original_bytes).digest('hex'),version.content_sha256);assert.equal(snapshotHash(JSON.parse(version.original_bytes.toString('utf8'))),version.domain_sha256);assert.notEqual(version.domain_sha256,version.content_sha256);}
    await client.query(`INSERT INTO gakja.common_versions(owner_id,student_id,kind,revision,version_id,source_present,source_revision,content_sha256,domain_sha256,original_ref,original_bytes,projection)
      VALUES('owner-a','student-a','synthetic-bytes','r-test','v-test',false,NULL,$1,$4,'synthetic://bytes',$2,$3::jsonb)`,[hash,bytes,bytes.toString('utf8'),domainHash]);
    const saved=(await client.query("SELECT original_bytes,content_sha256,domain_sha256,projection FROM gakja.common_versions WHERE kind='synthetic-bytes'")).rows[0];
    assert.deepEqual(saved.original_bytes,bytes);assert.equal(saved.content_sha256,hash);assert.equal(saved.domain_sha256,domainHash);assert.equal(snapshotHash(JSON.parse(saved.original_bytes.toString('utf8'))),domainHash);assert.equal(Object.hasOwn(saved.projection,'missing'),false);assert.equal(saved.projection.nullable,null);
    assert.notEqual(JSON.stringify(saved.projection),bytes.toString('utf8'));
    await client.query("INSERT INTO gakja.common_pointers VALUES('owner-a','student-a','synthetic-bytes','v-test')");
    assert.equal((await client.query("UPDATE gakja.common_pointers SET version_id='v-test' WHERE kind='synthetic-bytes'")).rowCount,1);
    assert.equal((await client.query("DELETE FROM gakja.common_pointers WHERE kind='synthetic-bytes'")).rowCount,1);
  });
  for(const command of ['UPDATE gakja.common_versions SET original_ref=original_ref', 'DELETE FROM gakja.common_versions','UPDATE gakja.target_versions SET revision=revision','DELETE FROM gakja.target_versions'])await scoped('a',client=>denied(()=>client.query(command)));
});

test('RLS WITH CHECK blocks owner transfer/upsert and restricted callers cannot change grants, revisions, schema, sequences or truncate',async()=>{
  for(const command of [
    "INSERT INTO gakja.target_pointers VALUES('owner-b','student-b','app-b','target-student-analysis','same-target-version') ON CONFLICT(owner_id,student_id,application_target_id,kind) DO UPDATE SET version_id=EXCLUDED.version_id",
    "UPDATE gakja.common_pointers SET owner_id='owner-b',student_id='student-b' WHERE owner_id='owner-a'",
    'UPDATE gakja.access_grants SET active=true','DELETE FROM gakja.principals','UPDATE gakja.accounts SET revision=1','TRUNCATE gakja.common_versions',
    'CREATE TABLE gakja.unwanted(x int)','ALTER TABLE gakja.students DISABLE ROW LEVEL SECURITY','CREATE TEMP TABLE accounts(x int)',
    "SELECT nextval('gakja.mapping_audit_audit_id_seq')",
  ])await scoped('a',client=>denied(()=>client.query(command)));
  await scoped('a',async client=>assert.equal((await client.query("UPDATE gakja.common_pointers SET version_id='same-common-version' WHERE owner_id='owner-b'")).rowCount,0));
});

test('composite FKs reject cross-owner/student/personal-target and pointer references even for privileged seed connections',async()=>{
  const cases=[
    ["INSERT INTO gakja.application_targets VALUES('owner-a','student-b','bad-target','domain-track','profile-r1','synthetic')",['23503']],
    ["INSERT INTO gakja.session_bindings(owner_id,session_id,student_id,application_target_id,support_target_id,source_present,source_revision,context_snapshot_sha256,frozen_source_sha256) VALUES('owner-a','bad-session','student-a','app-b','domain-track',false,NULL,repeat('1',64),repeat('f',64))",['23503']],
    ["INSERT INTO gakja.common_pointers VALUES('owner-a','student-b','full-student-analysis','same-common-version')",['23503']],
    ["INSERT INTO gakja.target_pointers VALUES('owner-a','student-a','app-a2','target-student-analysis','same-target-version')",['23503']],
    ["INSERT INTO gakja.students VALUES(NULL,'bad','synthetic',repeat('f',64))",['23502']],
  ] as const;
  for(const [query,codes] of cases)await denied(()=>pools.admin.query(query),[...codes]);
});

test('trusted grant changes atomically advance integer revision/audit and rollback leaves neither change',async()=>{
  const before=(await pools.mapping.query("SELECT revision FROM gakja.accounts WHERE account_id='account-a'")).rows[0].revision;
  const client=await pools.mapping.connect();
  try {
    await client.query('BEGIN');await client.query("UPDATE gakja.access_grants SET active=false WHERE account_id='account-a' AND application_target_id='app-a'");
    assert.ok(BigInt((await client.query("SELECT revision FROM gakja.accounts WHERE account_id='account-a'")).rows[0].revision)>BigInt(before));
    await client.query('ROLLBACK');assert.equal((await client.query("SELECT revision FROM gakja.accounts WHERE account_id='account-a'")).rows[0].revision,before);
    await client.query('BEGIN');await client.query("UPDATE gakja.access_grants SET active=false WHERE account_id='account-a' AND application_target_id='app-a'");await client.query('COMMIT');
    const revoked=await scoped('a',async(c,value)=>({value,count:(await c.query('SELECT count(*)::int n FROM gakja.students')).rows[0].n}),'app-a2');
    assert.ok(BigInt(revoked.value.revision)>BigInt(before));
    assert.equal(revoked.value.grants.some(g=>g.applicationTargetId==='app-a'),false);
    await client.query("UPDATE gakja.access_grants SET active=true WHERE account_id='account-a' AND application_target_id='app-a'");
    const restored=(await client.query("SELECT revision FROM gakja.accounts WHERE account_id='account-a'")).rows[0].revision;assert.ok(BigInt(restored)>BigInt(revoked.value.revision));
    assert.ok((await client.query("SELECT count(*)::int n FROM gakja.mapping_audit WHERE account_id='account-a' AND actor='gakja_mapping'")).rows[0].n>=2);
  } finally {await client.query('ROLLBACK');client.release();}
});

test('worker role sees only an explicit authorized job, while BYPASSRLS control demonstrably bypasses FORCE RLS',async()=>{
  const client=await pools.worker.connect();
  try {
    assert.equal((await client.query('SELECT count(*)::int n FROM gakja.job_bindings')).rows[0].n,0);
    await client.query('BEGIN');await client.query("SELECT set_config('gakja.worker_subject','worker-a',true),set_config('gakja.job_id',$1,true)",['a'.repeat(64)]);
    const rows=await client.query('SELECT owner_id,job_id FROM gakja.job_bindings');assert.equal(rows.rowCount,1);assert.equal(rows.rows[0].owner_id,'owner-a');
    assert.equal((await client.query('SELECT count(*)::int n FROM gakja.job_bindings WHERE owner_id=$1',['owner-b'])).rows[0].n,0);
    await client.query('ROLLBACK');
    await denied(()=>client.query('UPDATE gakja.job_bindings SET model=model'));
  } finally {await client.query('ROLLBACK');client.release();}
  assert.equal((await pools.bypass.query('SELECT count(*)::int n FROM gakja.students')).rows[0].n,3);
  assert.equal((await pools.bypass.query('SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0].rolbypassrls,true);
  assert.equal((await pools.admin.query('SELECT count(*)::int n FROM gakja.students')).rows[0].n,3);
});

test('definer lookup is scoped, hardens search_path/PUBLIC execute and no SQL runtime DDL/view escape exists',async()=>{
  assert.equal((await pools.request.query("SELECT gakja.resolve_account('https://issuer-b.example','shared') value")).rows[0].value,null);
  await scoped('a',async client=>assert.equal((await client.query("SELECT gakja.resolve_account('https://issuer-b.example','shared') value")).rows[0].value,null));
  const functions=await pools.admin.query("SELECT proname,prosecdef,proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='gakja'");
  for(const row of functions.rows.filter(row=>row.prosecdef))assert.ok(row.proconfig.includes('search_path=pg_catalog'));
  const publicExec=await pools.admin.query("SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE n.nspname='gakja' AND a.grantee=0 AND a.privilege_type='EXECUTE'");assert.equal(publicExec.rows[0].n,0);
  assert.equal((await pools.admin.query("SELECT count(*)::int n FROM pg_views WHERE schemaname='gakja'")).rows[0].n,0);
});

test('migration replay verifies checksum and real catalog drift; representative indexed query plan is captured',async()=>{
  const client=await pools.admin.connect();
  try {
    const repeated=await applyOwnershipMigration(client);assert.equal(repeated.applied,false);
    await client.query('BEGIN');await client.query('ALTER TABLE gakja.students ADD COLUMN unexpected_drift text');
    await assert.rejects(applyOwnershipMigration(client),/MIGRATION_SCHEMA_DRIFT/u);await client.query('ROLLBACK');
    await client.query('BEGIN');await client.query('DROP TRIGGER grant_revision ON gakja.access_grants');
    await assert.rejects(applyOwnershipMigration(client),/MIGRATION_SCHEMA_DRIFT/u);await client.query('ROLLBACK');
    assert.equal((await applyOwnershipMigration(client)).applied,false);
    const plan=await client.query("EXPLAIN (FORMAT JSON) SELECT * FROM gakja.session_bindings WHERE owner_id='owner-a' AND student_id='student-a' AND application_target_id='app-a' AND session_id='11111111-1111-4111-8111-111111111111'");
    assert.ok(plan.rows[0]['QUERY PLAN'][0].Plan);
  } finally {await client.query('ROLLBACK');client.release();}
});

test('same-scope legacy references, common metadata and source-pin presence constraints are enforced by the database',async()=>{
  for(const query of [
    "INSERT INTO gakja.legacy_mappings VALUES('owner-a','student-a','app-a','domain-track','target-student-analysis','bad-legacy',false,NULL,'new-pin','missing-version','synthetic-proof')",
    "INSERT INTO gakja.common_legacy_mappings VALUES('owner-a','student-b','full-student-analysis','bad-legacy',false,NULL,'new-pin','same-common-version','synthetic-proof')",
    "INSERT INTO gakja.job_bindings(owner_id,job_id,session_id,student_id,application_target_id,support_target_id,source_present,source_revision,source_sha256,snapshot_sha256,context_snapshot_sha256,pipeline_version,model) VALUES('owner-a',repeat('9',64),'11111111-1111-4111-8111-111111111111','student-a','app-a','domain-track',true,NULL,repeat('d',64),repeat('e',64),repeat('1',64),'synthetic','synthetic')",
  ])await denied(()=>pools.admin.query(query),['23503']);
  for(const value of ['', ' ', '\t', '\u00a0', '\ufeff'])await denied(()=>pools.admin.query("INSERT INTO gakja.access_grants(account_id,owner_id,student_id,application_target_id,support_target_id,source_present,source_revision) VALUES('account-a','owner-a','student-a','app-a','domain-track',true,$1) ON CONFLICT(account_id,student_id,application_target_id) DO UPDATE SET source_revision=EXCLUDED.source_revision",[value]),['23514']);
  for(const who of ['a','b'])await scoped(who,async client=>{
    for(const table of ['common_private_objects','common_legacy_mappings']){
      const rows=await client.query(`SELECT owner_id FROM gakja.${table}`);assert.ok(rows.rowCount!>0);assert.ok(rows.rows.every(row=>row.owner_id==='owner-'+who));
    }
  });
});

test('SET LOCAL is explicitly a trusted carrier, not authentication for a holder of raw SQL credentials',async()=>{
  await scoped('a',async client=>{
    await client.query("SELECT set_config('gakja.owner_id','owner-b',true)");
    assert.equal((await client.query('SELECT count(*)::int n FROM gakja.students')).rows[0].n,0,'owner spoof alone does not match verified principal/account');
    const b=await account(client,'b');
    for(const [key,value] of Object.entries({account_id:b.accountId,owner_id:b.ownerId,account_revision:b.revision,student_id:'student-b',application_target_id:'app-b'}))await client.query('SELECT set_config($1,$2,true)',['gakja.'+key,value]);
    const rows=await client.query('SELECT owner_id FROM gakja.students');
    assert.equal(rows.rowCount,1);assert.equal(rows.rows[0].owner_id,'owner-b','a SQL credential holder can forge the complete carrier: never expose SQL/claims RPC to browsers');
  });
});
