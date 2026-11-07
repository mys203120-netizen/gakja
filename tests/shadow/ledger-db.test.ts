import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { testPools, closePools } from './shadow-test-database';
import { applyReadShadowMigration } from '../../scripts/pr07d-migration.mjs';
import type { ObjectRegistration } from '../../server/storage/private-object-ports';
import type { ShadowArtifactPlan, ShadowPresentArtifact, ShadowRunPlan, ShadowSnapshot } from '../../server/shadow/shadow-ports';
import { createRequestIdentityBoundary } from '../../server/auth/request-identity';
import { createTrustedJwtVerifier } from '../../server/auth/jose-jwt-verifier';
import { createPostgresAccountResolver, createPostgresRequestAuthority } from '../../server/db/postgres-authority';
import { createPostgresShadowRepository, createShadowImportCapability, ShadowRepositoryError } from '../../server/db/postgres-shadow-repository';

// Actual SQL/request roles. Storage states in this file are SQL-carrier fixtures,
// not evidence of a provider upload; separate integration files use real APIs.
const pools=testPools(2);test.after(()=>closePools(pools));
const bytes=Buffer.from('{"z":1,"text":"한글🙂","literal":null}\r\n');
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
type Who='a'|'b'|'c';
async function scoped<T>(who:Who,role:'request'|'mapping',operation:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client=await pools[role].connect();await client.query('BEGIN');
  try {
    const issuer=who==='b'?'https://issuer-b.example':'https://issuer-a.example',subject=who==='c'?'c':'shared';
    await client.query("SELECT set_config('gakja.issuer',$1,true),set_config('gakja.subject',$2,true)",[issuer,subject]);
    const access=(await client.query('SELECT gakja.resolve_account($1,$2) value',[issuer,subject])).rows[0].value;
    const grant=access.grants.find((g:{applicationTargetId:string})=>g.applicationTargetId===`app-${who}`);assert.ok(grant);
    for(const [key,value] of Object.entries({owner_id:access.ownerId,account_id:access.accountId,account_revision:access.revision,student_id:grant.studentId,application_target_id:grant.applicationTargetId}))
      await client.query('SELECT set_config($1,$2,true)',['gakja.'+key,value]);
    const value=await operation(client);await client.query('COMMIT');return value;
  } catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
function artifact(id='source',scope:'common'|'target'='common',who:Who='a'):ShadowPresentArtifact {
  return {artifactId:id,role:'configured-input',locatorId:id,reference:`legacy/${id}.json`,selection:'configured',scope,required:true,availability:'present',
    objectKind:'source-json',sizeBytes:bytes.length,rawSha256:sha(bytes),legacyId:id,originalPin:'original-pin',versionId:'legacy-v1',dependencies:[],
    ...(who==='a'?{}:{sourceRevision:who==='b'?null:'source-r1'})};
}
function plan(who:Who='a',artifacts:ShadowArtifactPlan[]=[artifact('source','common',who)]):ShadowRunPlan {
  const value={runId:'shadow_'+randomUUID(),binding:'synthetic' as const,ownerId:`owner-${who}`,studentId:`student-${who}`,applicationTargetId:`app-${who}`,supportTargetId:'domain-track',artifacts,pointers:[]};
  return {...value,planSha256:sha(JSON.stringify(value))};
}
async function register(value:ShadowRunPlan,who:Who='a'):Promise<ShadowSnapshot> {
  return scoped(who,'mapping',async c=>(await c.query('SELECT gakja.shadow_register_run($1::jsonb) value',[JSON.stringify(value)])).rows[0].value);
}
async function object(input:ShadowPresentArtifact,who:Who='a',extra:Record<string,unknown>={}):Promise<ObjectRegistration> {
  return scoped(who,'mapping',async c=>{
    let u=(await c.query('SELECT gakja.storage_admit($1::jsonb) value',[JSON.stringify({scope:input.scope,studentId:`student-${who}`,
      ...(input.scope==='target'?{applicationTargetId:`app-${who}`,supportTargetId:'domain-track'}:{}),kind:input.objectKind,
      sourcePresent:Object.hasOwn(input,'sourceRevision'),sourceRevision:input.sourceRevision??null,domainPresent:Object.hasOwn(input,'domainSha256'),domainSha256:input.domainSha256??null,
      expectedSize:input.sizeBytes,expectedSha256:input.rawSha256,idempotencyKey:randomUUID(),bucket:'pr07d-synthetic',keyPrefix:'shadow_fixture',...extra})])).rows[0].value;
    if(input.mediaType)u=(await c.query('SELECT gakja.storage_set_media_type($1::uuid,$2::bigint,$3) value',[u.receiptId,u.revision,input.mediaType])).rows[0].value;
    u=(await c.query('SELECT gakja.storage_transition($1::uuid,$2::bigint,$3) value',[u.receiptId,u.revision,'verifying'])).rows[0].value;
    return (await c.query('SELECT gakja.storage_transition($1::uuid,$2::bigint,$3,$4::bigint,$5) value',[u.receiptId,u.revision,'verified',u.expectedSize,u.expectedSha256])).rows[0].value;
  });
}
async function bind(value:ShadowRunPlan,input:ShadowPresentArtifact,receipt:ObjectRegistration,who:Who='a') {
  return scoped(who,'mapping',async c=>(await c.query('SELECT gakja.shadow_bind_object($1,$2,$3::uuid) value',[value.runId,input.artifactId,receipt.receiptId])).rows[0].value);
}
const denied=(operation:()=>Promise<unknown>,codes=['42501'])=>assert.rejects(operation(),error=>codes.includes((error as {code?:string}).code??''));

test('D migration replays its latest fingerprint and preserves B/C checksum checkpoints',async()=>{
  const client=await pools.admin.connect();try{
    const replay=await applyReadShadowMigration(client);assert.equal(replay.applied,false);
    const rows=(await client.query('SELECT version,checksum FROM pr07b_control.migrations ORDER BY version')).rows;assert.equal(rows.length,3);
    assert.equal(rows[0].checksum,sha(await readFile('db/migrations/0001_ownership.sql')));assert.equal(rows[1].checksum,sha(await readFile('db/migrations/0002_private_storage.sql')));
    await client.query('BEGIN');await client.query('ALTER TABLE gakja.shadow_runs ADD COLUMN drift text');
    await assert.rejects(applyReadShadowMigration(client),/PR07D_MIGRATION_SCHEMA_DRIFT/u);await client.query('ROLLBACK');
    assert.equal((await applyReadShadowMigration(client)).applied,false);
  }finally{client.release();}
});

test('request and mapping connections cannot publish shadow rows through direct DML or private helpers',async()=>{
  for(const role of ['request','mapping'] as const) for(const sql of [
    "INSERT INTO gakja.shadow_history(run_id,generation,event) VALUES('guessed_run',1,'forged')",
    "UPDATE gakja.shadow_runs SET generation=generation+1",'DELETE FROM gakja.shadow_artifacts',
    "SELECT gakja.shadow_advance('guessed_run','forged')",
  ])await scoped('a',role,c=>denied(()=>c.query(sql)));
  await scoped('a','request',c=>denied(()=>c.query('SELECT gakja.shadow_register_run($1::jsonb)',[JSON.stringify(plan())])));
});

test('A and B retain distinct refs for identical legacy IDs and bytes, with exact source absence/null/string',async()=>{
  for(const who of ['a','b','c'] as const){const input=artifact('same-id','common',who),value=plan(who,[input]),snapshot=await register(value,who),u=await object(input,who);
    const linked=await bind(value,input,u,who);assert.equal(linked.objectId,u.objectId);
    assert.equal(Object.hasOwn(linked,'sourceRevision'),who!=='a');if(who!=='a')assert.equal(linked.sourceRevision,who==='b'?null:'source-r1');
    assert.equal(await scoped(who,'request',async c=>(await c.query('SELECT gakja.shadow_unchanged($1,$2::bigint) value',[value.runId,linked.generation])).rows[0].value),true);
    assert.equal(snapshot.artifacts[0].status,'planned');
    if(who!=='a')assert.equal(await scoped('a','request',async c=>(await c.query('SELECT gakja.shadow_capture($1) value',[value.runId])).rows[0].value),null);
  }
});

test('plan retry is idempotent but same pin different bytes and unauthorized target/student are refused',async()=>{
  const value=plan();assert.deepEqual(await register(value),await register(value));
  await assert.rejects(register({...value,artifacts:[{...value.artifacts[0],reference:'different/reference'}]}),e=>(e as {code?:string}).code==='23505');
  await assert.rejects(register({...plan(),studentId:'student-b'}),e=>(e as {code?:string}).code==='42501');
  const dup=plan('a',[artifact('one'),{...artifact('two'),legacyId:'one',rawSha256:sha('different bytes at same pin')}]);
  await assert.rejects(register(dup),e=>(e as {code?:string}).code==='23505');
});

test('legacy identity preserves missing, null, literal sentinel pins and distinct source revisions',async()=>{
  const optionalValues=[undefined,null,'<null>','known-version'] as const;
  const artifacts:ShadowPresentArtifact[]=[];
  for(const originalPin of optionalValues)for(const versionId of optionalValues)for(const sourceRevision of [undefined,null,'source-previous'] as const){
    const {originalPin:_pin,versionId:_version,...base}=artifact('identity-'+artifacts.length);void _pin;void _version;
    artifacts.push({...base,legacyId:'same-legacy',...(originalPin===undefined?{}:{originalPin}),...(versionId===undefined?{}:{versionId}),...(sourceRevision===undefined?{}:{sourceRevision})});
  }
  const snapshot=await register(plan('a',artifacts));assert.equal(snapshot.artifacts.length,48);
  for(const expected of artifacts){const actual=snapshot.artifacts.find(a=>a.artifactId===expected.artifactId)!;
    for(const key of ['originalPin','versionId','sourceRevision'] as const){assert.equal(Object.hasOwn(actual,key),Object.hasOwn(expected,key));assert.equal(actual[key],expected[key]);}}
});

test('confirmed optional absence carries no fabricated bytes/hash and required or unplanned absence is not eligible',async()=>{
  const absence:ShadowArtifactPlan={artifactId:'optional',role:'optional-registry',locatorId:'optional-registry',reference:'legacy/optional.json',selection:'configured',scope:'common',required:false,availability:'absent',absenceReason:'known-absent',dependencies:[]};
  const value=plan('a',[absence]),snapshot=await register(value);assert.equal(snapshot.artifacts[0].status,'absent');assert.equal(Object.hasOwn(snapshot.artifacts[0],'rawSha256'),false);
  assert.equal(await scoped('a','request',async c=>(await c.query('SELECT gakja.shadow_resolve($1,$2,$3,$4) value',[value.runId,absence.role,absence.reference,absence.selection])).rows[0].value),null);
  await assert.rejects(register(plan('a',[{...absence,required:true} as unknown as ShadowArtifactPlan])),e=>(e as {code?:string}).code==='22023');
  await assert.rejects(register(plan('a',[{...artifact(),dependencies:[{artifactId:'optional',required:true}]},absence])),e=>(e as {code?:string}).code==='23514');
});

test('typed binding rejects wrong raw/domain/source/owner/object kind rather than adopting another verified object',async()=>{
  const input={...artifact(),domainSha256:null},value=plan('a',[input]);await register(value);
  const wrong=await object({...input,domainSha256:sha('domain')});await assert.rejects(bind(value,input,wrong),e=>(e as {code?:string}).code==='23503');
  const other=await object(artifact('b','target','b'),'b');assert.equal(await bind(value,input,other),null);
  const good=await object(input);assert.ok(await bind(value,input,good));
  const replacement=await object(input);await assert.rejects(bind(value,input,replacement),e=>(e as {code?:string}).code==='23505');
});

test('media is explicit once before verification, legacy C WAV fallback is retained, and shape mismatches fail',async()=>{
  const mp3={...artifact('audio'),objectKind:'audio' as const,mediaType:'audio/mpeg' as const},value=plan('a',[mp3]);await register(value);
  const u=await object(mp3);assert.equal(u.mediaType,'audio/mpeg');assert.equal((await bind(value,mp3,u)).mediaType,'audio/mpeg');
  await scoped('a','mapping',async c=>{assert.equal((await c.query('SELECT gakja.storage_set_media_type($1::uuid,$2::bigint,$3) value',[u.receiptId,u.revision,'audio/mpeg'])).rows[0].value.mediaType,'audio/mpeg');
    assert.equal((await c.query('SELECT gakja.storage_set_media_type($1::uuid,$2::bigint,$3) value',[u.receiptId,u.revision,'audio/wav'])).rows[0].value,null);});
  const png={...artifact('image'),objectKind:'source-image' as const,mediaType:'image/png' as const};const imagePlan=plan('a',[png]);await register(imagePlan);assert.ok(await bind(imagePlan,png,await object(png)));
  const journal={...artifact('journal'),objectKind:'review-journal' as const};const journalPlan=plan('a',[journal]);await register(journalPlan);assert.equal((await bind(journalPlan,journal,await object(journal))).objectKind,'review-journal');
  const wav=await object({...artifact('old-wav'),objectKind:'audio'});assert.equal(wav.mediaType,'audio/wav');
});

test('shadow pointer generation detects ABA and C receipt revocation without changing local pointer formats',async()=>{
  const one={...artifact('one'),role:'analysis-pointer'},two={...artifact('two'),role:'analysis-pointer'},value=plan('a',[one,two]);
  value.pointers=[{name:'analysis-pointer',selection:'current',artifactId:'one'}];await register(value);const u=await object(one);
  await bind(value,one,u);await bind(value,two,await object(two));
  const set=async(id:string,generation:string)=>scoped('a','mapping',async c=>(await c.query('SELECT gakja.shadow_set_pointer($1,$2,$3,$4,$5::bigint) value',[value.runId,'analysis-pointer','current',id,generation])).rows[0].value);
  assert.equal((await set('one','0')).generation,'1');const captured=await scoped('a','request',async c=>(await c.query('SELECT gakja.shadow_capture($1) value',[value.runId])).rows[0].value);
  assert.equal((await set('two','1')).generation,'2');assert.equal((await set('one','2')).generation,'3');assert.equal(await set('two','1'),null);
  assert.equal(await scoped('a','request',async c=>(await c.query('SELECT gakja.shadow_unchanged($1,$2::bigint) value',[value.runId,captured.generation])).rows[0].value),false);
  await scoped('a','mapping',c=>c.query('SELECT gakja.storage_transition($1::uuid,NULL,$2)',[u.receiptId,'cancelled']));
  assert.equal(await scoped('a','request',async c=>(await c.query('SELECT gakja.shadow_resolve($1,$2,NULL,$3) value',[value.runId,'analysis-pointer','current'])).rows[0].value),null);
});

test('dependency closure is mandatory and a known receipt is required before cleanup can claim complete',async()=>{
  const dep=artifact('qa'),main={...artifact('main'),dependencies:[{artifactId:'qa',required:true}]},value=plan('a',[main,dep]);await register(value);
  await bind(value,main,await object(main));
  assert.equal(await scoped('a','request',async c=>(await c.query('SELECT gakja.shadow_resolve($1,$2,$3,$4) value',[value.runId,main.role,main.reference,main.selection])).rows[0].value),null);
  await scoped('a','mapping',c=>c.query('SELECT gakja.shadow_cancel_run($1)',[value.runId]));
  assert.equal(await scoped('a','mapping',async c=>(await c.query('SELECT gakja.shadow_mark_cleaned($1) value',[value.runId])).rows[0].value),null);
});

test('lost receipt recovery after quarantine or cancellation is tracking-only and never restores read authority',async()=>{
  for(const mode of ['quarantined','cancelled','terminal'] as const){
    const input=artifact('recover-'+mode),value=plan('a',[input]);await register(value);
    const u=await object(input),wrong=await object({...input,rawSha256:sha('different')});
    if(mode==='quarantined')await scoped('a','mapping',c=>c.query('SELECT gakja.shadow_quarantine($1,$2)',[value.runId,input.artifactId]));
    else await scoped('a','mapping',c=>c.query('SELECT gakja.shadow_cancel_run($1)',[value.runId]));
    if(mode==='terminal')await scoped('a','mapping',c=>c.query('SELECT gakja.storage_transition($1::uuid,NULL,$2)',[u.receiptId,'cancelled']));
    if(mode!=='quarantined'){
      const capture=()=>scoped('a','mapping',async c=>(await c.query('SELECT gakja.shadow_capture($1) value',[value.runId])).rows[0].value);
      const before=await capture();assert.equal(await bind(value,input,u),null);
      assert.deepEqual(await capture(),before,'closed bind must not perform cleanup receipt tracking');
    }
    const note=(receipt:string)=>scoped('a','mapping',async c=>(await c.query('SELECT gakja.shadow_note_receipt($1,$2,$3::uuid) value',[value.runId,input.artifactId,receipt])).rows[0].value);
    await assert.rejects(note(wrong.receiptId),e=>(e as {code?:string}).code==='23503');
    const tracked=await note(u.receiptId);assert.equal(tracked.status,'quarantined');assert.equal(tracked.receiptId,u.receiptId);assert.equal(Object.hasOwn(tracked,'object'),false);
    await assert.rejects(note(wrong.receiptId),e=>(e as {code?:string}).code==='23505');
    assert.deepEqual(await note(u.receiptId),tracked);
    if(mode==='quarantined')await assert.rejects(bind(value,input,u),e=>(e as {code?:string}).code==='23505');
    else assert.equal(await bind(value,input,u),null);
    assert.equal(await scoped('a','request',async c=>(await c.query('SELECT gakja.shadow_resolve($1,$2,$3,$4) value',[value.runId,input.role,input.reference,input.selection])).rows[0].value),null);
    await scoped('a','mapping',async c=>{await c.query('SELECT gakja.shadow_cancel_run($1)',[value.runId]);
      const cancelled=(await c.query('SELECT gakja.storage_transition($1::uuid,NULL,$2) value',[u.receiptId,'cancelled'])).rows[0].value;
      await c.query('SELECT gakja.storage_transition($1::uuid,$2::bigint,$3)',[u.receiptId,cancelled.revision,'cleanup_clean']);
      assert.equal((await c.query('SELECT gakja.shadow_mark_cleaned($1) value',[value.runId])).rows[0].value.state,'cleaned');});
  }
});

test('TS repository rejects forged, expired or revoked finite capabilities and resets the pool',async()=>{
  const keys=await generateKeyPair('ES256'),jwk={...await exportJWK(keys.publicKey),kid:'shadow-db',alg:'ES256'},issuer='https://issuer-a.example';
  const boundary=createRequestIdentityBoundary({mode:'service',accounts:createPostgresAccountResolver(pools.request),verifier:createTrustedJwtVerifier({issuer,audience:'shadow-db',algorithms:['ES256'],jwks:{keys:[jwk]}})});
  const jwt=await new SignJWT().setProtectedHeader({alg:'ES256',kid:'shadow-db'}).setIssuer(issuer).setSubject('shared').setAudience('shadow-db').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
  const context=boundary.selectScope(await boundary.authenticate('Bearer '+jwt),{applicationTargetId:'app-a'}),authority=createPostgresRequestAuthority(pools.request,boundary);
  const repository=createPostgresShadowRepository({authority,boundary,mappingPool:pools.mapping}),value=plan();
  const config={runId:value.runId,planSha256:value.planSha256,ownerId:value.ownerId,studentId:value.studentId,applicationTargetId:value.applicationTargetId,supportTargetId:value.supportTargetId,artifactIds:['source'],expiresAt:Date.now()+60_000,checkCurrent:async()=>true};
  await assert.rejects(repository.registerRun(context,value,{kind:'shadow-import-capability-v1'}),e=>e instanceof ShadowRepositoryError&&e.code==='SHADOW_AUTHORITY_REQUIRED');
  for(const deniedCap of [createShadowImportCapability({...config,expiresAt:Date.now()-1}),createShadowImportCapability({...config,checkCurrent:async()=>false})])
    await assert.rejects(repository.registerRun(context,value,deniedCap),e=>e instanceof ShadowRepositoryError&&e.code==='SHADOW_AUTHORITY_REQUIRED');
  assert.equal(await repository.capture(context,value.runId),null,'refused capabilities must not register metadata');
  const cap=createShadowImportCapability(config),snapshot=await repository.registerRun(context,value,cap);assert.equal(snapshot.runId,value.runId);
  await assert.rejects(repository.registerRun(context,{...value,artifacts:[{...value.artifacts[0],reference:'forged-reference'}]},cap),e=>e instanceof ShadowRepositoryError&&e.code==='SHADOW_INVALID_PLAN');
  await assert.rejects(repository.registerRun({...context},value,cap));
  await assert.rejects(repository.registerRun(context,value,createShadowImportCapability({...config,artifactIds:['wrong']})),e=>e instanceof ShadowRepositoryError&&e.code==='SHADOW_AUTHORITY_REQUIRED');
  for(const pool of [pools.mapping,pools.request])assert.equal((await pool.query("SELECT coalesce(current_setting('gakja.owner_id',true),'') value")).rows[0].value,'');
});
