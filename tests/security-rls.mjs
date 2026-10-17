// Runs real PostgreSQL RLS in an isolated disposable database. Auth/Storage
// schemas below model the SQL boundary; this is not a hosted Storage HTTP test.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { loadProjectEnv } from '../scripts/load-env.mjs';
loadProjectEnv();
const url = new URL(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
if (!['localhost','127.0.0.1'].includes(url.hostname)) throw Error('RLS tests require a local disposable PostgreSQL server.');
const admin = new pg.Client({ connectionString: url.href });
await admin.connect();
const name = 'gakja_rls_' + randomBytes(6).toString('hex');
let db, checks = 0;
const createdRoles = [];
try {
  for (const role of ['anon','authenticated']) {
    if (!(await admin.query('select 1 from pg_roles where rolname=$1',[role])).rowCount) {
      await admin.query(`create role ${role} nologin`); createdRoles.push(role);
    }
  }
  await admin.query(`create database ${name}`);
  url.pathname = '/' + name; db = new pg.Client({ connectionString: url.href }); await db.connect();
  await db.query(`create schema auth; create schema storage;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function storage.foldername(text) returns text[] language sql immutable as $$select string_to_array($1,'/')$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema public,auth,storage to anon,authenticated;
    grant select,insert,update,delete on storage.objects to authenticated;`);
  for (const file of readdirSync('supabase/migrations').filter(file=>file.endsWith('.sql')).sort()) await db.query(readFileSync('supabase/migrations/'+file,'utf8'));
  // Match Supabase's exposed-table grants: policies must still enforce ownership.
  await db.query('grant select on all tables in schema public to authenticated');
  const own='00000000-0000-4000-8000-000000000001', other='00000000-0000-4000-8000-000000000002', upload='00000000-0000-4000-8000-000000000003';
  const path=own+'/uploads/'+upload+'/recording';
  await db.query("insert into profiles(id,email,name) values($1,'own@example.test','Own'),($2,'other@example.test','Other')",[own,other]);
  await db.query("insert into support_targets(id,student_id,data) values('own',$1,'{}'),('other',$2,'{}')",[own,other]);
  await db.query("insert into recording_uploads(id,student_id,kind,fields,files) values($1,$2,'quiz','{}',$3)",[upload,own,JSON.stringify([{field:'recording',path,bucket:'student-media'}])]);
  await db.query("insert into storage.objects(bucket_id,name) values('student-chat-files',$1),('student-media',$2)",[own+'/note.txt',other+'/old.webm']);
  await db.query("insert into storage.objects(bucket_id,name) values('document-originals',$1)",[own+'/book.html']);
  assert.equal((await db.query("select public from storage.buckets where id='document-originals'")).rows[0].public,false);checks++;
  async function asUser(id, callback) {
    await db.query('set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);
    try { await callback(); } finally { await db.query('reset role'); }
  }
  const count=async table=>(await db.query(`select count(*)::int n from ${table}`)).rows[0].n;
  await asUser(own,async()=>{
    assert.equal((await db.query("select * from storage.objects where bucket_id='document-originals'")).rowCount,0);checks++;
    await assert.rejects(db.query("insert into storage.objects(bucket_id,name) values('document-originals',$1)",[own+'/forged.html']),/row-level security/);checks++;

    assert.equal(await count('profiles'),1); checks++;
    assert.equal(await count('support_targets'),1); checks++;
    assert.equal(await count('recording_uploads'),1); checks++;
    assert.equal(await count('storage.objects'),1); checks++;
    await db.query("insert into storage.objects(bucket_id,name) values('student-media',$1)",[path]); checks++;
    await assert.rejects(db.query("insert into storage.objects(bucket_id,name) values('student-media',$1)",[own+'/arbitrary.webm']), /row-level security/); checks++;
    await assert.rejects(db.query("insert into storage.objects(bucket_id,name) values('student-media',$1)",[other+'/foreign.webm']), /row-level security/); checks++;
    assert.equal((await db.query("delete from storage.objects where bucket_id='student-media'")).rowCount,0); checks++;
    assert.equal((await db.query("update storage.objects set name='replaced' where bucket_id='student-media'")).rowCount,0); checks++;
  });
  await asUser(other,async()=>{assert.equal(await count('recording_uploads'),0);checks++;});
  for (const [index,bucket,kind] of [[4,'student-chat-files','attachment'],[5,'content-imports','guidebook']]) {
    const id=`00000000-0000-4000-8000-00000000000${index}`, destination=own+'/uploads/'+id+'/file0';
    await db.query("insert into recording_uploads(id,student_id,kind,fields,files) values($1,$2,$3,'{}',$4)",[id,own,kind,JSON.stringify([{field:'file0',path:destination,bucket}])]);
    await asUser(own,async()=>{
      await db.query('insert into storage.objects(bucket_id,name) values($1,$2)',[bucket,destination]);checks++;
      assert.equal((await db.query('select * from storage.objects where bucket_id=$1 and name=$2',[bucket,destination])).rowCount,1);checks++;
      assert.equal((await db.query('delete from storage.objects where bucket_id=$1 and name=$2',[bucket,destination])).rowCount,0);checks++;
      assert.equal((await db.query("update storage.objects set name='changed' where bucket_id=$1 and name=$2",[bucket,destination])).rowCount,0);checks++;
    });
  }
  // Keep exactly the same simulated JWT; only the live profile changes.
  await db.query('update profiles set active=false where id=$1',[own]);
  await asUser(own,async()=>{
    for (const table of ['profiles','support_targets','recording_uploads','storage.objects']) {assert.equal(await count(table),0);checks++;}
    await assert.rejects(db.query("insert into storage.objects(bucket_id,name) values('student-chat-files',$1)",[own+'/blocked.txt']),/row-level security/); checks++;
    assert.equal((await db.query("delete from storage.objects where bucket_id='student-chat-files'")).rowCount,0); checks++;
  });
  await db.query('update profiles set active=true where id=$1',[own]);
  await db.query('update recording_uploads set locked_at=now() where id=$1',[upload]);
  await db.query("delete from storage.objects where name=$1",[path]);
  await asUser(own,async()=>{await assert.rejects(db.query("insert into storage.objects(bucket_id,name) values('student-media',$1)",[path]),/row-level security/);checks++;});
  await db.query("update recording_uploads set expires_at=now()-interval '2 days' where id=$1",[upload]);
  const preview=spawnSync(process.execPath,['scripts/cleanup-recording-uploads.mjs'],{encoding:'utf8',env:{...process.env,DATABASE_URL:url.href,DATABASE_SSL:'false'},windowsHide:true});
  assert.equal(preview.status,0,preview.stderr);assert.equal(JSON.parse(preview.stdout).mode,'dry-run');checks++;
  assert.equal((await db.query('select id from recording_uploads where id=$1',[upload])).rowCount,1);checks++;
  await db.query("update recording_uploads set locked_at=null,expires_at=now()-interval '1 second' where id=$1",[upload]);
  await asUser(own,async()=>{await assert.rejects(db.query("insert into storage.objects(bucket_id,name) values('student-media',$1)",[path]),/row-level security/);checks++;});
  // A forgotten public table gate is a regression, even if no fixtures use it.
  assert.deepEqual((await db.query("select tablename from pg_tables t where schemaname='public' and rowsecurity and not exists(select 1 from pg_policies p where p.schemaname=t.schemaname and p.tablename=t.tablename and policyname in ('active_account_gate','active_profile_gate'))")).rows,[]); checks++;
  console.log(`PostgreSQL RLS: ${checks} checks passed; every migration applied to an empty database.`);
} finally {
  if(db) await db.end();
  await admin.query(`drop database if exists ${name} with (force)`);
  for(const role of createdRoles) await admin.query(`drop role ${role}`);
  await admin.end();
}
