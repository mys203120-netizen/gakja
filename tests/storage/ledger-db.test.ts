import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { testPools, closePools } from './storage-test-database';
import { applyPrivateStorageMigration } from '../../scripts/pr07c-migration.mjs';
import type { ObjectRegistration } from '../../server/storage/private-object-ports';

const pools=testPools(2);
test.after(()=>closePools(pools));
type Who='a'|'b'|'c';
type Account={accountId:string;ownerId:string;revision:string;grants:Array<{studentId:string;applicationTargetId:string;supportTargetId:string;sourceRevision?:string|null}>};
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const raw=Buffer.from('%PDF-1.7\r\n% Synthetic 한글🙂\n%%EOF\n');

/** Deliberate SQL-carrier tests, separate from actual signed JWT/HTTP/Storage.
 * Only the disposable C runner creates these real restricted LOGIN connections. */
async function scoped<T>(who:Who,role:'request'|'mapping',operation:(client:PoolClient)=>Promise<T>,app=`app-${who}`):Promise<T> {
  const client=await pools[role].connect();await client.query('BEGIN');
  try {
    const issuer=who==='b'?'https://issuer-b.example':'https://issuer-a.example';
    const subject=who==='c'?'c':'shared';
    await client.query("SELECT set_config('gakja.issuer',$1,true),set_config('gakja.subject',$2,true)",[issuer,subject]);
    const access=(await client.query<{v:Account}>('SELECT gakja.resolve_account($1,$2) v',[issuer,subject])).rows[0].v;
    const grant=access.grants.find(g=>g.applicationTargetId===app);assert.ok(grant);
    for(const [key,value] of Object.entries({account_id:access.accountId,owner_id:access.ownerId,account_revision:access.revision,student_id:grant.studentId,application_target_id:grant.applicationTargetId})) {
      await client.query('SELECT set_config($1,$2,true)',['gakja.'+key,value]);
    }
    const value=await operation(client);await client.query('COMMIT');return value;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
function admission(who:Who='a',scope:'common'|'target'='common',extra:Record<string,unknown>={}) {
  return {scope,studentId:`student-${who}`,kind:'source-pdf',sourcePresent:who!=='a',sourceRevision:who==='c'?'source-r1':null,
    domainPresent:false,domainSha256:null,expectedSize:raw.length,expectedSha256:sha(raw),idempotencyKey:randomUUID(),
    bucket:'pr07c_synthetic',keyPrefix:'synthetic_run',...(scope==='target'?{applicationTargetId:`app-${who}`,supportTargetId:'domain-track'}:{}),...extra};
}
async function admit(who:Who='a',scope:'common'|'target'='common',extra:Record<string,unknown>={}) {
  return scoped(who,'mapping',async client=>(await client.query<{v:ObjectRegistration}>('SELECT gakja.storage_admit($1::jsonb) v',[JSON.stringify(admission(who,scope,extra))])).rows[0].v);
}
async function transition(who:Who,value:ObjectRegistration,action:string,revision:string|null=value.revision,size:number|null=null,hash:string|null=null) {
  return scoped(who,'mapping',async client=>(await client.query<{v:ObjectRegistration|null}>('SELECT gakja.storage_transition($1::uuid,$2::bigint,$3::text,$4::bigint,$5::text) v',[value.receiptId,revision,action,size,hash])).rows[0].v);
}
async function complete(who:Who,value:ObjectRegistration) {
  const verifying=await transition(who,value,'verifying');assert.ok(verifying);
  const verified=await transition(who,verifying,'verified',verifying.revision,verifying.expectedSize,verifying.expectedSha256);assert.ok(verified);return verified;
}
async function get(who:Who,value:ObjectRegistration) {
  return scoped(who,'request',async client=>(await client.query('SELECT gakja.storage_get_verified($1::uuid,NULL::text) v',[value.objectId])).rows[0].v);
}
const denied=(operation:()=>Promise<unknown>,codes=['42501'])=>assert.rejects(operation(),error=>codes.includes((error as {code?:string}).code??''));

test('C replays its latest checkpoint while preserving the exact B SQL, seed and historical migration ledger',async()=>{
  assert.equal(sha(await readFile('db/migrations/0001_ownership.sql')),'0973558f93beb7dd0676d898ee386f5b4a19e0a756ee8f8666ade2c74a32cd23');
  assert.equal(sha(await readFile('db/seed.synthetic.sql')),'246266d2246678c956ff30ed5743d1e9117e7776f9376eabc49af5554f7f9790');
  const before=await pools.admin.query("SELECT * FROM pr07b_control.migrations WHERE version='0001_ownership'");
  const client=await pools.admin.connect();
  try {const result=await applyPrivateStorageMigration(client);assert.equal(result.applied,false);assert.equal(result.baseChecksum,before.rows[0].checksum);}
  finally{client.release();}
  assert.deepEqual((await pools.admin.query("SELECT * FROM pr07b_control.migrations WHERE version='0001_ownership'")).rows,before.rows);
});

test('C catalog privilege/trigger drift and changed SQL checksum fail rather than silently replaying',async()=>{
  for(const statement of ["GRANT UPDATE ON gakja.storage_uploads TO gakja_request",'DROP TRIGGER storage_identity_immutable ON gakja.storage_uploads']) {
    const client=await pools.admin.connect();await client.query('BEGIN');
    try {await client.query(statement);await assert.rejects(applyPrivateStorageMigration(client),/PR07C_MIGRATION_SCHEMA_DRIFT/);}
    finally{await client.query('ROLLBACK');client.release();}
  }
  await mkdir('artifacts/pr07c',{recursive:true});
  const path='artifacts/pr07c/ledger-altered-migration.sql';await writeFile(path,(await readFile('db/migrations/0002_private_storage.sql','utf8'))+'\n-- changed checksum test\n');
  const client=await pools.admin.connect();try{await assert.rejects(applyPrivateStorageMigration(client,pathToFileURL(resolve(path))),/PR07C_MIGRATION_CHECKSUM_CHANGED/);}finally{client.release();}
});

test('request cannot mint verified metadata or refs; mapping cannot bypass the narrow lifecycle functions with direct DML',async()=>{
  for(const role of ['request','mapping'] as const)for(const command of [
    "UPDATE gakja.storage_uploads SET state='verified'",
    'DELETE FROM gakja.storage_uploads',
    'INSERT INTO gakja.storage_uploads DEFAULT VALUES',
    'INSERT INTO gakja.storage_audio_links DEFAULT VALUES',
  ])await denied(()=>scoped('a',role,client=>client.query(command)));
  await denied(()=>scoped('a','request',client=>client.query('SELECT gakja.storage_admit($1)',[JSON.stringify(admission())])));
  await denied(()=>scoped('a','request',client=>client.query("INSERT INTO gakja.common_private_objects VALUES('owner-a','student-a','fake','audio',false,NULL,1,repeat('0',64),'synthetic://unverified')")));
});

test('common and target admissions issue separate server refs for A/B even with identical bytes/hash',async()=>{
  const values=[];
  for(const who of ['a','b'] as const)for(const scope of ['common','target'] as const) {
    const value=await admit(who,scope);values.push(value);
    assert.equal(value.scope.kind,scope);assert.equal(value.scope.ownerId,`owner-${who}`);assert.equal(value.scope.studentId,`student-${who}`);
    assert.equal(Object.hasOwn(value.scope,'applicationTargetId'),scope==='target');
    assert.equal(value.stagingRef.key,`synthetic_run/staging/${value.objectId}`);assert.equal(value.finalRef.key,`synthetic_run/final/${value.objectId}`);
    assert.equal(value.state,'pending');assert.equal(await get(who,value),null);
    const done=await complete(who,value);assert.equal((await get(who,done)).contentSha256,sha(raw));
    assert.equal(await get(who==='a'?'b':'a',done),null);
  }
  assert.equal(new Set(values.map(v=>v.objectId)).size,4);assert.equal(new Set(values.map(v=>v.finalRef.key)).size,4);
});

test('source absence, literal null and a string pin roundtrip; missing target grant and wrong pin are refused',async()=>{
  const a=await admit('a'),b=await admit('b'),c=await admit('c');
  assert.equal(Object.hasOwn(a,'sourceRevision'),false);assert.equal(b.sourceRevision,null);assert.equal(c.sourceRevision,'source-r1');
  await denied(()=>admit('b','common',{sourcePresent:false,sourceRevision:null}));
  await denied(()=>admit('c','common',{sourcePresent:true,sourceRevision:'wrong-pin'}));
  await denied(()=>admit('a','target',{applicationTargetId:'app-b'}));
  await denied(()=>scoped('a','mapping',client=>client.query('SELECT gakja.storage_admit($1)',[JSON.stringify(admission('b'))])));
});

test('admission retries are idempotent but changed bytes or client-supplied refs are not adopted',async()=>{
  const input=admission();const put=()=>scoped('a','mapping',async client=>(await client.query('SELECT gakja.storage_admit($1) v',[JSON.stringify(input)])).rows[0].v as ObjectRegistration);
  const first=await put(),second=await put();assert.deepEqual(second,first);
  await denied(()=>scoped('a','mapping',client=>client.query('SELECT gakja.storage_admit($1)',[JSON.stringify({...input,expectedSha256:'0'.repeat(64)})])),['23505']);
  for(const bad of [{objectRef:'https://evil.example/private'},{stagingKey:first.stagingRef.key},{keyPrefix:'../outside'},{sourceRevision:42}]) {
    await denied(()=>scoped('a','mapping',client=>client.query('SELECT gakja.storage_admit($1)',[JSON.stringify({...admission(),...bad})])),['22023','42501','23514']);
  }
});

test('another owner ref cannot be substituted into an admitted row or cancelled through an authorized own scope',async()=>{
  const a=await admit('a'),b=await admit('b');
  await denied(()=>pools.admin.query('UPDATE gakja.storage_uploads SET final_key=$1,revision=revision+1 WHERE receipt_id=$2',[b.finalRef.key,a.receiptId]),['23514']);
  assert.equal(await transition('a',b,'cancelled',null),null);
  const unchanged=await scoped('b','request',async client=>(await client.query('SELECT gakja.storage_get_receipt($1) v',[b.receiptId])).rows[0].v);
  assert.equal(unchanged.state,'pending');assert.deepEqual(unchanged.finalRef,b.finalRef);
});

test('B metadata and pending/uploading/verifying receipts never count as verified objects',async()=>{
  assert.ok((await pools.admin.query('SELECT count(*)::int n FROM gakja.common_private_objects')).rows[0].n>0);
  const original=await admit();assert.equal(await get('a',original),null);
  const uploading=await transition('a',original,'uploading');assert.ok(uploading);assert.equal(await get('a',uploading),null);
  const verifying=await transition('a',uploading,'verifying');assert.ok(verifying);assert.equal(await get('a',verifying),null);
  await denied(()=>transition('a',verifying,'verified',verifying.revision,raw.length+1,sha(raw)),['23514']);
  await denied(()=>transition('a',verifying,'verified',verifying.revision,raw.length,'0'.repeat(64)),['23514']);
  assert.equal(await get('a',verifying),null);
});

test('completion is revision fenced, immutable refs survive retry, and cancellation blocks later completion/read',async()=>{
  const pending=await admit();const verifying=await transition('a',pending,'verifying');assert.ok(verifying);
  assert.deepEqual(await transition('a',verifying,'verifying'),verifying);
  assert.equal(await transition('a',pending,'verified',pending.revision,raw.length,sha(raw)),null);
  const results=await Promise.all([transition('a',verifying,'verified',verifying.revision,raw.length,sha(raw)),transition('a',verifying,'cancelled',null)]);
  assert.ok(results[1]);assert.equal(results[1].state,'cancelled');assert.equal(await get('a',verifying),null);
  assert.equal(await transition('a',results[1],'verified',results[1].revision,raw.length,sha(raw)),null);
  assert.deepEqual(results[1].finalRef,pending.finalRef);
  const cleanup=await transition('a',results[1],'cleanup_failed');assert.ok(cleanup);assert.equal(cleanup.cleanupState,'failed');
  const cleaned=await transition('a',cleanup,'cleanup_clean');assert.ok(cleaned);assert.equal(cleaned.cleanupState,'clean');assert.equal(await get('a',cleaned),null);
});

test('app receipt expiry is a DB deadline and does not claim provider signed-upload expiry',async()=>{
  const value=await admit('a','common',{expiresInSeconds:1});
  await new Promise(resolve=>setTimeout(resolve,1100));
  const expired=await transition('a',value,'verifying');assert.ok(expired);assert.equal(expired.state,'expired');assert.equal(await get('a',expired),null);
  assert.equal(await transition('a',expired,'verified',expired.revision,raw.length,sha(raw)),null);
});

test('new audio link proves exact owner/target/source/kind/raw hash instead of matching a filename',async()=>{
  const bytes=Buffer.from('explicit-synthetic-audio');
  const value=await complete('a',await admit('a','target',{kind:'audio',expectedSize:bytes.length,expectedSha256:sha(bytes)}));
  const link=await scoped('a','mapping',async client=>(await client.query('SELECT gakja.storage_link_audio($1,$2) v',[value.receiptId,'same-audio.mp3'])).rows[0].v);
  assert.deepEqual(link,{objectId:value.objectId,scope:'target'});
  const a=await scoped('a','request',async client=>(await client.query('SELECT gakja.storage_audio_object($1) v',['same-audio.mp3'])).rows[0].v);assert.deepEqual(a,link);
  const b=await scoped('b','request',async client=>(await client.query('SELECT gakja.storage_audio_object($1) v',['same-audio.mp3'])).rows[0].v);assert.equal(b,null);
  const wrong=await complete('a',await admit('a','target',{kind:'audio'}));
  await denied(()=>scoped('a','mapping',client=>client.query('SELECT gakja.storage_link_audio($1,$2)',[wrong.receiptId,'unmapped-audio.mp3'])),['23503']);
  await scoped('a','mapping',client=>client.query(`INSERT INTO gakja.audio_bindings(owner_id,resource_id,student_id,application_target_id,support_target_id,source_present,source_revision,content_sha256)
    VALUES('owner-a','new-exact-hash-audio','student-a','app-a','domain-track',false,NULL,$1)`,[sha(bytes)]));
  await denied(()=>scoped('a','mapping',client=>client.query('SELECT gakja.storage_link_audio($1,$2)',[wrong.receiptId,'new-exact-hash-audio'])),['23503']);
});

test('version and legacy traversal use typed source/raw/domain-hash links and preserve old IDs',async()=>{
  for(const scope of ['common','target'] as const) {
    const table=scope==='common'?'common_versions':'target_versions';
    const row=(await pools.admin.query(`SELECT * FROM gakja.${table} WHERE owner_id='owner-a'`)).rows[0];
    const value=await complete('a',await admit('a',scope,{kind:'analysis-json',expectedSize:row.original_bytes.length,expectedSha256:row.content_sha256,domainPresent:true,domainSha256:row.domain_sha256}));
    await scoped('a','mapping',client=>client.query('SELECT gakja.storage_link_version($1,$2,$3)',[value.receiptId,row.kind,row.version_id]));
    const version=await scoped('a','request',async client=>(await client.query('SELECT gakja.storage_version_object($1,$2,$3) v',[scope,row.kind,row.version_id])).rows[0].v);
    assert.deepEqual(version,{objectId:value.objectId,scope});
    const legacy=scope==='common'?'same-legacy-full-id':'same-legacy-id';
    const resolved=await scoped('a','request',async client=>(await client.query('SELECT gakja.storage_legacy_object($1,$2,$3,$4) v',[scope,row.kind,legacy,'same-original-pin'])).rows[0].v);
    assert.deepEqual(resolved,version);
    const wrong=await scoped('a','request',async client=>(await client.query('SELECT gakja.storage_legacy_object($1,$2,$3,$4) v',[scope,row.kind,legacy,'wrong-pin'])).rows[0].v);assert.equal(wrong,null);
    assert.notEqual(row.domain_sha256,row.content_sha256);
  }
});
