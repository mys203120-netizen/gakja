import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportJWK,generateKeyPair,SignJWT } from 'jose';
import type { PoolClient } from 'pg';
import { createRequestIdentityBoundary,type AuthenticatedRequestContext,type PrincipalVerifier } from '../../server/auth/request-identity';
import { createTrustedJwtVerifier } from '../../server/auth/jose-jwt-verifier';
import { createPostgresAccountResolver } from '../../server/db/postgres-authority';
import { createPostgresSessionCommandRepository,createSessionEnrollmentCapability } from '../../server/db/postgres-session-writer';
import { SessionCommandError,type SessionCommandSnapshot,type SessionCommandKind,type SessionCommandRequest,type SessionCommandCommit } from '../../server/session-writer/session-command-ports';
import { testPools,closePools } from './session-writer-test-database';
import { applySessionWriterMigration } from '../../scripts/pr07e-migration.mjs';

const pools=testPools(1),hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const keyPair=await generateKeyPair('ES256'),jwk={...await exportJWK(keyPair.publicKey),kid:'session-sql',alg:'ES256'};
const verifiers=(['a','b'] as const).map(who=>createTrustedJwtVerifier({issuer:`https://issuer-${who}.example`,audience:'session-sql',algorithms:['ES256'],jwks:{keys:[jwk]}}));
const verifier:PrincipalVerifier={kind:'trusted-jwt',async verify(token){for(const v of verifiers)try{return await v.verify(token);}catch{/* try the other explicit synthetic issuer */}throw new Error('TEST_TOKEN_INVALID');}};
const boundary=createRequestIdentityBoundary({mode:'service',verifier,accounts:createPostgresAccountResolver(pools.request)});
const repository=createPostgresSessionCommandRepository({boundary,requestPool:pools.request,mappingPool:pools.mapping,environment:'isolated-session-writer'});
const contexts=new Map<string,AuthenticatedRequestContext>();
async function selected(who:'a'|'b'){
  const token=await new SignJWT().setProtectedHeader({alg:'ES256',kid:jwk.kid}).setIssuer(`https://issuer-${who}.example`).setSubject('shared').setAudience('session-sql').setExpirationTime('1h').sign(keyPair.privateKey);
  return boundary.selectScope(await boundary.authenticate('Bearer '+token),{applicationTargetId:'app-'+who}) as AuthenticatedRequestContext;
}
test.before(async()=>{for(const who of ['a','b'] as const)contexts.set(who,await selected(who));});
test.after(async()=>{await closePools(pools);});
const ctx=(who='a')=>contexts.get(who)!;
function capability(context:AuthenticatedRequestContext,input:{sessionId:string;creationKey:string;inputSha256:string}){
  return createSessionEnrollmentCapability({...context.scope!,ownerId:context.account.ownerId,...input,expiresAt:Date.now()+300000,async checkCurrent(){try{await boundary.revalidate(context);return true;}catch{return false;}}});
}
async function enroll(who='a',key='create-'+randomUUID()){
  const context=ctx(who),id=randomUUID(),contextJson='{\r\n "synthetic": "한글😀", "order": [2,1], "nullable": null\r\n}',contextSha=hash(contextJson);
  const sessionJson=JSON.stringify({id,createdAt:'2026-11-07T00:00:00.000Z',updatedAt:'2026-11-07T00:00:00.000Z',status:'active',evaluationStatus:'pending',turns:[],
    runtime:{version:'authenticated-session-runtime-v1',owner:{id:context.account.ownerId,mode:'authenticated'},contextSnapshotSha256:contextSha,epoch:0,checkpoint:{phase:'prepared'},operations:{}}});
  const input={sessionId:id,creationKey:key,inputSha256:hash(key),sessionJson,contextJson,pinsJson:'{"sourceSha256":"'+ 'a'.repeat(64)+'","unknown":null}',sourceSha256:'a'.repeat(64),
    ...(Object.hasOwn(context.scope!,'sourceRevision')?{sourceRevision:context.scope!.sourceRevision}:{})};
  return repository.enroll(context,input,capability(context,input));
}
function command(s:SessionCommandSnapshot,kind:SessionCommandKind,key='key-'+randomUUID(),semanticKey=key,body=key):SessionCommandRequest {
  return {sessionId:s.binding.sessionId,key,kind,inputSha256:hash(body),semanticKey,semanticSha256:hash(body),expectedRevision:s.revision,writerGeneration:s.writerGeneration,writerToken:s.writerToken};
}
const event=()=>[{eventId:randomUUID(),kind:'checkpoint',payloadJson:'{"synthetic":true}'}];
async function begin(s:SessionCommandSnapshot,kind:SessionCommandKind,key?:string,semantic?:string,body?:string){
  const req=command(s,kind,key,semantic,body),start=await repository.beginIntent(ctx(s.binding.ownerId.slice(-1)),req);assert.equal(start.status,'pending');if(start.status!=='pending')throw new Error('EXPECTED_PENDING');return start;
}
async function commit(s:SessionCommandSnapshot,kind:SessionCommandKind,key?:string,semantic?:string,body?:string,extra:Partial<SessionCommandCommit>={}){
  const started=await begin(s,kind,key,semantic,body),value=await repository.commit(ctx(s.binding.ownerId.slice(-1)),started.intent,{sessionJson:s.sessionJson,events:event(),resultJson:JSON.stringify({ok:true,operation:kind}),...extra});
  return {receipt:value,snapshot:(await repository.read(ctx(s.binding.ownerId.slice(-1)),s.binding.sessionId))!,intent:started.intent};
}
async function created(who='a'){return (await commit(await enroll(who),'create')).snapshot;}
async function scoped(role:'request'|'mapping',operation:(client:PoolClient)=>Promise<unknown>){
  const client=await pools[role].connect(),context=ctx();try{await client.query('BEGIN');const values={issuer:context.principal.issuer,subject:context.principal.subject,account_id:context.account.accountId,account_revision:context.account.revision,owner_id:context.account.ownerId,student_id:context.scope!.studentId,application_target_id:context.scope!.applicationTargetId};
    for(const [k,v]of Object.entries(values))await client.query('SELECT set_config($1,$2,true)',['gakja.'+k,v]);return await operation(client);
  }finally{await client.query('ROLLBACK');client.release();}}

test('E exact context/session text and scoped A/B enrollments stay independent; create binding is atomic',async()=>{
  const a=await enroll('a','same-synthetic-key'),b=await enroll('b','same-synthetic-key');assert.notEqual(a.binding.ownerId,b.binding.ownerId);assert.equal(a.contextJson,b.contextJson);assert.equal(a.created,false);
  assert.equal((await pools.admin.query('SELECT count(*)::int n FROM gakja.session_bindings WHERE session_id=$1',[a.binding.sessionId])).rows[0].n,0);
  const value=await commit(a,'create');assert.equal(value.snapshot.created,true);assert.equal(value.snapshot.contextJson,a.contextJson);assert.equal(value.snapshot.sessionJson,a.sessionJson);
  const row=(await pools.admin.query('SELECT * FROM gakja.session_bindings WHERE session_id=$1',[a.binding.sessionId])).rows[0];assert.equal(row.context_snapshot_sha256,a.contextSnapshotSha256);
  assert.equal(await repository.read(ctx('b'),a.binding.sessionId),null);assert.ok((await repository.list(ctx())).some(s=>s.binding.sessionId===a.binding.sessionId));
  const otherTarget=boundary.selectScope(ctx(),{applicationTargetId:'app-a2'});assert.equal(await repository.read(otherTarget,a.binding.sessionId),null);
});
test('E durable receipt replay precedes stale CAS and different-key same semantic aliases preserve the first result',async()=>{
  const s=await created(),key='same-input-'+randomUUID(),first=await commit(s,'answer',key,'answer:turn:1','same-answer');
  const later=(await commit(first.snapshot,'event')).snapshot;
  const repeated=await repository.beginIntent(ctx(),command(s,'answer',key,'answer:turn:1','same-answer'));assert.equal(repeated.status,'committed');
  if(repeated.status==='committed')assert.equal(repeated.receipt.operationId,first.receipt.operationId);
  await assert.rejects(repository.beginIntent(ctx(),command(later,'answer',key,'answer:turn:1','different-answer')),e=>e instanceof SessionCommandError&&e.code==='SESSION_IDEMPOTENCY_CONFLICT');
  const newKey='new-key-'+randomUUID(),lookupInput=command(s,'answer',newKey,'answer:turn:1','same-answer');
  const keyCount=(await pools.admin.query('SELECT count(*)::int n FROM gakja.session_command_keys WHERE session_id=$1',[s.binding.sessionId])).rows[0].n;
  const discovered=await repository.findCommitted(ctx(),lookupInput);assert.equal(discovered!.operationId,first.receipt.operationId);
  assert.equal((await pools.admin.query('SELECT count(*)::int n FROM gakja.session_command_keys WHERE session_id=$1',[s.binding.sessionId])).rows[0].n,keyCount,'read-only replay discovery cannot create a durable key alias');
  assert.equal(await repository.receipt(ctx(),lookupInput),null);
  const alias=await repository.beginIntent(ctx(),lookupInput);assert.equal(alias.status,'committed');
  if(alias.status==='committed'){assert.equal(alias.receipt.resultJson,first.receipt.resultJson);assert.equal(alias.receipt.operationId,first.receipt.operationId);}
  assert.equal((await repository.read(ctx(),s.binding.sessionId))!.revision,later.revision);
});
test('E failed mandatory event rolls back snapshot and receipt; progress persists one recoverable checkpoint',async()=>{
  const s=await created(),started=await begin(s,'next');
  await assert.rejects(repository.commit(ctx(),started.intent,{sessionJson:s.sessionJson,events:[],resultJson:'{}'}));
  const duplicate=event()[0];await assert.rejects(repository.commit(ctx(),started.intent,{sessionJson:s.sessionJson,events:[duplicate,duplicate],resultJson:'{}'}),e=>e instanceof SessionCommandError&&e.code==='SESSION_SEMANTIC_CONFLICT');
  assert.equal((await pools.admin.query('SELECT count(*)::int n FROM gakja.session_mandatory_events WHERE operation_id=$1',[started.intent.operationId])).rows[0].n,0);
  const premature=JSON.parse(s.sessionJson);premature.turns=[{id:randomUUID()}];await assert.rejects(repository.persistProgress(ctx(),started.intent,{sessionJson:JSON.stringify(premature),events:event()}),e=>e instanceof SessionCommandError&&e.code==='SESSION_REVISION_CONFLICT');
  assert.equal((await repository.read(ctx(),s.binding.sessionId))!.revision,s.revision);assert.equal(await repository.receipt(ctx(),started.intent),null);
  const state=JSON.parse(s.sessionJson);state.runtime.operations.prepared={synthetic:true};
  const advanced=await repository.persistProgress(ctx(),started.intent,{sessionJson:JSON.stringify(state),events:event()});assert.equal(advanced.status,'pending');
  if(advanced.status==='pending'){assert.equal(BigInt(advanced.intent.expectedRevision),BigInt(s.revision)+1n);assert.equal(advanced.snapshot.sessionJson,JSON.stringify(state));
    await repository.commit(ctx(),advanced.intent,{sessionJson:advanced.snapshot.sessionJson,events:event(),resultJson:'{"prepared":true}'});}
});
test('E same-revision contenders cannot overwrite a committed snapshot',async()=>{
  const s=await created(),a=await begin(s,'event'),b=await begin(s,'event');
  const one=JSON.parse(s.sessionJson);one.metrics={winner:'a'};
  await repository.commit(ctx(),a.intent,{sessionJson:JSON.stringify(one),events:event(),resultJson:'{"winner":"a"}'});
  await assert.rejects(repository.commit(ctx(),b.intent,{sessionJson:s.sessionJson,events:event(),resultJson:'{"winner":"b"}'}),e=>e instanceof SessionCommandError&&e.code==='SESSION_REVISION_CONFLICT');
  assert.equal(JSON.parse((await repository.read(ctx(),s.binding.sessionId))!.sessionJson).metrics.winner,'a');
});
test('E atomic recovery advances logical epoch and DB fence; an old provider intent cannot commit',async()=>{
  const s=await created(),old=await begin(s,'next'),recovery=await begin(s,'recover');
  const doc=JSON.parse(s.sessionJson);doc.runtime.epoch++;
  await repository.commit(ctx(),recovery.intent,{sessionJson:JSON.stringify(doc),events:event(),resultJson:'{"recovered":true}',rotateWriter:true});
  const current=(await repository.read(ctx(),s.binding.sessionId))!;assert.equal(BigInt(current.writerGeneration),BigInt(s.writerGeneration)+1n);assert.notEqual(current.writerToken,s.writerToken);
  await assert.rejects(repository.commit(ctx(),old.intent,{sessionJson:s.sessionJson,events:event(),resultJson:'{}'}),e=>e instanceof SessionCommandError&&e.code==='SESSION_WRITER_STALE');
  const retry=await repository.beginIntent(ctx(),{...old.intent,...command(current,'next',old.intent.key,old.intent.semanticKey),inputSha256:old.intent.inputSha256,semanticSha256:old.intent.semanticSha256,resume:true});assert.equal(retry.status,'pending');
});
test('E different-key concurrent end requests retain the first accepted bytes and one frozen F handoff',async()=>{
  const s=await created(),a=await begin(s,'end-accept','end-a-'+randomUUID(),'end-once','first'),b=await begin(s,'end-accept','end-b-'+randomUUID(),'end-once','later');
  const firstInput='{"elapsedMs":1234,"metrics":{"source":"first"}}',doc=JSON.parse(s.sessionJson);doc.status='ending';
  const first=await repository.commit(ctx(),a.intent,{sessionJson:JSON.stringify(doc),events:event(),resultJson:'{"accepted":1234}',endIntent:{intentId:randomUUID(),inputJson:firstInput,inputSha256:hash(firstInput)}});
  const repeat=await repository.commit(ctx(),b.intent,{sessionJson:s.sessionJson,events:event(),resultJson:'{"accepted":9999}',endIntent:{intentId:randomUUID(),inputJson:'{}',inputSha256:hash('{}')}});
  assert.equal(repeat.operationId,first.operationId);let current=(await repository.read(ctx(),s.binding.sessionId))!;assert.equal(current.endIntent!.inputJson,firstInput);
  const finishing=await begin(current,'end-finalize'),frozen=JSON.parse(current.sessionJson);frozen.runtime.epoch++;frozen.evaluationStatus='review_required';
  const frozenJson=JSON.stringify(frozen),handoffJson='{"pipeline":"F-pending","approvalCount":0}';
  await repository.commit(ctx(),finishing.intent,{sessionJson:frozenJson,events:event(),resultJson:'{"handoff":"waiting"}',handoff:{intentId:randomUUID(),payloadJson:handoffJson,payloadSha256:hash(handoffJson),frozenSessionSha256:hash(frozenJson)}});
  current=(await repository.read(ctx(),s.binding.sessionId))!;assert.equal(current.handoff!.state,'awaiting-evaluation-consumer');
  const observation=await begin(current,'event');await repository.commit(ctx(),observation.intent,{sessionJson:current.sessionJson,events:event(),resultJson:'{"observed":true}'});
  const late=(await repository.read(ctx(),s.binding.sessionId))!;assert.equal(late.sessionSha256,current.handoff!.frozenSessionSha256);
  const invalidEvent=await begin(late,'event');await assert.rejects(repository.commit(ctx(),invalidEvent.intent,{sessionJson:JSON.stringify({...frozen,updatedAt:'later'}),events:event(),resultJson:'{}'}),e=>e instanceof SessionCommandError&&e.code==='SESSION_INPUT_FROZEN');
  await assert.rejects(repository.beginIntent(ctx(),command(late,'answer')),e=>e instanceof SessionCommandError&&e.code==='SESSION_INPUT_FROZEN');
  assert.equal((await pools.admin.query('SELECT count(*)::int n FROM gakja.session_evaluation_handoffs WHERE session_id=$1',[s.binding.sessionId])).rows[0].n,1);
  assert.equal((await pools.admin.query('SELECT count(*)::int n FROM gakja.job_bindings WHERE session_id=$1',[s.binding.sessionId])).rows[0].n,0);
});
test('E rollback distinguishes unpublished enrollment from committed authenticated read-only preservation',async()=>{
  const unpublished=await enroll(),local=await repository.rollbackUncommitted(ctx(),{sessionId:unpublished.binding.sessionId,expectedRevision:unpublished.revision,writerGeneration:unpublished.writerGeneration,writerToken:unpublished.writerToken});assert.equal(local.writer,'local');assert.equal(local.created,false);
  const s=await created();await assert.rejects(repository.rollbackUncommitted(ctx(),{sessionId:s.binding.sessionId,expectedRevision:s.revision,writerGeneration:s.writerGeneration,writerToken:s.writerToken}),e=>e instanceof SessionCommandError&&e.code==='SESSION_INPUT_FROZEN');
  const frozen=await repository.freeze(ctx(),{sessionId:s.binding.sessionId,expectedRevision:s.revision,writerGeneration:s.writerGeneration,writerToken:s.writerToken});assert.equal(frozen.writer,'read-only');
  const bundle=await repository.exportPreservation(ctx(),s.binding.sessionId);assert.equal(hash(bundle.payloadJson),bundle.sha256);const exported=JSON.parse(bundle.payloadJson);assert.equal(exported.session.session_json,s.sessionJson);assert.ok(exported.commands.length>0);assert.ok(exported.events.length>0);
  const createCommand=exported.commands.find((c:{kind:string})=>c.kind==='create');assert.ok(await repository.receiptByKey(ctx(),{sessionId:s.binding.sessionId,key:createCommand.original_key,inputSha256:createCommand.input_sha256}));
  await assert.rejects(repository.beginIntent(ctx(),command(frozen,'event')),e=>e instanceof SessionCommandError&&e.code==='SESSION_INPUT_FROZEN');
});
test('E finite enrollment capability, limited SQL roles and immutable receipt/context rules reject forgery',async()=>{
  const s=await created();await assert.rejects(repository.read({...ctx()},s.binding.sessionId));
  const id=randomUUID(),key='finite-'+randomUUID(),doc={...JSON.parse(s.sessionJson),id};
  const enrollment={sessionId:id,creationKey:key,inputSha256:hash(key),sourceSha256:'a'.repeat(64),sessionJson:JSON.stringify(doc),contextJson:s.contextJson,pinsJson:s.pinsJson};
  const config={...ctx().scope!,ownerId:ctx().account.ownerId,sessionId:id,creationKey:key,inputSha256:hash(key),expiresAt:Date.now()+60000,checkCurrent:async()=>true};
  for(const cap of [{kind:'session-enrollment-capability-v1'} as const,createSessionEnrollmentCapability({...config,expiresAt:Date.now()-1}),createSessionEnrollmentCapability({...config,checkCurrent:async()=>false})])
    await assert.rejects(repository.enroll(ctx(),enrollment,cap),e=>e instanceof SessionCommandError&&e.code==='SESSION_ACCESS_DENIED');
  assert.equal(await repository.read(ctx(),id),null);
  await assert.rejects(scoped('request',c=>c.query('SELECT gakja.session_enroll($1::jsonb)',['{}'])),e=>(e as {code?:string}).code==='42501');
  await assert.rejects(scoped('mapping',c=>c.query('SELECT gakja.session_begin($1::jsonb)',['{}'])),e=>(e as {code?:string}).code==='42501');
  await assert.rejects(pools.request.query('UPDATE gakja.session_command_sessions SET revision=revision+1'),e=>(e as {code?:string}).code==='42501');
  await assert.rejects(pools.bypass.query('SELECT * FROM gakja.session_commands'),e=>(e as {code?:string}).code==='42501');
  await assert.rejects(pools.admin.query('UPDATE gakja.session_command_sessions SET context_json=$1,context_sha256=$2 WHERE session_id=$3',['{}',hash('{}'),s.binding.sessionId]),e=>(e as {code?:string}).code==='23514');
  await assert.rejects(pools.admin.query('UPDATE gakja.session_commands SET result_json=$1,result_sha256=$2 WHERE session_id=$3',['{}',hash('{}'),s.binding.sessionId]),e=>(e as {code?:string}).code==='23514');
  assert.equal((await pools.request.query("SELECT coalesce(current_setting('gakja.owner_id',true),'') value")).rows[0].value,'');
});
test('E checkpoint replay preserves historical B/C/D bytes and refuses changed SQL and catalog drift',async()=>{
  const client=await pools.admin.connect();
  const output=path.resolve(process.env.PR07E_TEST_OUTPUT??'artifacts/pr07e');await mkdir(output,{recursive:true});
  const sql=await readFile(new URL('../../db/migrations/0004_session_writer.sql',import.meta.url),'utf8'),copy=path.join(output,'checksum-probe-'+randomUUID()+'.sql');
  await writeFile(copy,'-- deliberate isolated checksum probe\n'+sql,{flag:'wx'});
  try{
    const replay=await applySessionWriterMigration(client);assert.equal(replay.applied,false);assert.equal(replay.baseChecksums.length,3);
    await assert.rejects(applySessionWriterMigration(client,pathToFileURL(copy)),/PR07E_MIGRATION_CHECKSUM_CHANGED/u);
    await client.query('CREATE TABLE gakja.e_owned_drift_probe(id integer)');
    try{await assert.rejects(applySessionWriterMigration(client),/PR07E_MIGRATION_SCHEMA_DRIFT/u);}finally{await client.query('DROP TABLE gakja.e_owned_drift_probe');}
    assert.equal((await applySessionWriterMigration(client)).applied,false);
  }finally{client.release();}
});
test('E submission deadline is immutable across commands and SQL rejects decision/advance after the persisted budget',async()=>{
  const s=await created(),doc=JSON.parse(s.sessionJson),turnId=randomUUID(),answerId='same-answer',scope=turnId+':'+answerId+':1';
  const started=new Date(s.serverNow).getTime(),deadline=new Date(started+150).toISOString();
  doc.turns=[{id:turnId,answerId,metadata:{answerCaptureRevision:1}}];doc.runtime.submissionAttempts={[scope]:{turnId,answerId,captureRevision:1,attemptId:randomUUID(),epoch:0,startedAt:new Date(started).toISOString(),deadlineAt:deadline,status:'running'}};
  const state=(await commit(s,'event',undefined,undefined,undefined,{sessionJson:JSON.stringify(doc)})).snapshot;
  const extension=JSON.parse(state.sessionJson);extension.runtime.submissionAttempts[scope].deadlineAt=new Date(started+95000).toISOString();
  const modifying=await begin(state,'event');await assert.rejects(repository.commit(ctx(),modifying.intent,{sessionJson:JSON.stringify(extension),events:event(),resultJson:'{}'}),e=>e instanceof SessionCommandError&&e.code==='SESSION_REVISION_CONFLICT');
  const decision=await begin(state,'answer');
  await pools.admin.query('SELECT pg_sleep(GREATEST(0,extract(epoch from ($1::timestamptz-clock_timestamp()))))',[deadline]);
  await assert.rejects(repository.commit(ctx(),decision.intent,{sessionJson:state.sessionJson,events:event(),resultJson:'{"advance":true}'}),e=>e instanceof SessionCommandError&&e.status===408&&e.code==='SESSION_TURN_WORK_TIMEOUT');
  assert.equal(await repository.receipt(ctx(),decision.intent),null);
  const ending=await begin(state,'end-accept');assert.ok(ending.intent.operationId,'expired submission still permits durable end intent processing');
});
test('E passive connection close is durable without snapshot CAS changes and stale generations cannot extend recovery',async()=>{
  const s=await created(),work=await begin(s,'next'),token=randomUUID();
  assert.equal(Object.hasOwn(s,'lastDisconnectedAt'),false);
  const closedAt=await repository.observeConnectionClosed(ctx(),{sessionId:s.binding.sessionId,writerGeneration:s.writerGeneration,connectionToken:token});
  const observed=(await repository.read(ctx(),s.binding.sessionId))!;
  assert.equal(observed.lastDisconnectedAt,closedAt);assert.equal(observed.revision,s.revision);assert.equal(observed.sessionJson,s.sessionJson);assert.equal(observed.writerToken,s.writerToken);
  assert.equal(await repository.observeConnectionClosed(ctx(),{sessionId:s.binding.sessionId,writerGeneration:s.writerGeneration,connectionToken:token}),closedAt,'a repeated close cannot renew the window');
  await repository.commit(ctx(),work.intent,{sessionJson:s.sessionJson,events:event(),resultJson:'{"provider":"still-current"}'});
  const beforeRecover=(await repository.read(ctx(),s.binding.sessionId))!,recovery=await begin(beforeRecover,'recover'),doc=JSON.parse(beforeRecover.sessionJson);doc.runtime.epoch++;
  await repository.commit(ctx(),recovery.intent,{sessionJson:JSON.stringify(doc),events:event(),resultJson:'{"recovered":true}',rotateWriter:true});
  const current=(await repository.read(ctx(),s.binding.sessionId))!;assert.equal(Object.hasOwn(current,'lastDisconnectedAt'),false);
  await assert.rejects(repository.observeConnectionClosed(ctx(),{sessionId:s.binding.sessionId,writerGeneration:s.writerGeneration,connectionToken:randomUUID()}),e=>e instanceof SessionCommandError&&e.code==='SESSION_WRITER_STALE');
  await assert.rejects(repository.observeConnectionClosed(ctx('b'),{sessionId:s.binding.sessionId,writerGeneration:current.writerGeneration,connectionToken:randomUUID()}),e=>e instanceof SessionCommandError&&e.status===404);
  const frozen=await repository.freeze(ctx(),{sessionId:s.binding.sessionId,expectedRevision:current.revision,writerGeneration:current.writerGeneration,writerToken:current.writerToken});
  const closedFrozen=await repository.observeConnectionClosed(ctx(),{sessionId:s.binding.sessionId,writerGeneration:frozen.writerGeneration,connectionToken:randomUUID()});
  const after=(await repository.read(ctx(),s.binding.sessionId))!;assert.equal(after.lastDisconnectedAt,closedFrozen);assert.equal(after.revision,frozen.revision);assert.equal(after.sessionJson,frozen.sessionJson);
  const bundle=await repository.exportPreservation(ctx(),s.binding.sessionId),payload=JSON.parse(bundle.payloadJson);assert.equal(payload.connectionCloses.length,2);
  await assert.rejects(pools.admin.query('UPDATE gakja.session_connection_closes SET closed_at=clock_timestamp() WHERE session_id=$1',[s.binding.sessionId]),e=>(e as {code?:string}).code==='23514');
});
