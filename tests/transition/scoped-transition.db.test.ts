import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createRequestIdentityBoundary, type AuthenticatedRequestContext } from '../../server/auth/request-identity';
import { createTrustedJwtVerifier } from '../../server/auth/jose-jwt-verifier';
import { createPostgresAccountResolver } from '../../server/db/postgres-authority';
import { createPostgresTransitionRepository, createTransitionInstallerCapability, createTransitionOperatorCapability, createTransitionCommand } from '../../server/transition/postgres-transition';
import { createTransitionServiceAuthority, withTransitionOperation, transitionSqlAuthorization, currentTransitionOperation, TransitionError, type TransitionCommandAction, type TransitionOperatorAction } from '../../server/transition/transition-ports';
import { evaluationSupplyFixture } from '../fixtures/evaluation-supply';
import { createAuthenticatedSessionRuntime } from '../../server/session-runtime';

const make = (role: string) => {
  const value = process.env['PR07G_TEST_' + role + '_URL'];
  if (process.env.PR07G_TEST_DISPOSABLE !== '1' || !process.env.PR07G_TEST_RUN_ID || !value || !/^\/pr07g_[a-z0-9_]+$/u.test(new URL(value).pathname)) throw new Error('PR07G_OWNED_DATABASE_REQUIRED');
  return new Pool({ connectionString: value,max: 4,connectionTimeoutMillis: 5000,idleTimeoutMillis: 1000 });
};
const pools = { admin: make('ADMIN'),request: make('REQUEST'),mapping: make('MAPPING'),worker: make('WORKER') };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const keys = await generateKeyPair('ES256'), jwk = { ...await exportJWK(keys.publicKey),kid:'g-sql',alg:'ES256' };
const identity = createRequestIdentityBoundary({ mode:'service',verifier:createTrustedJwtVerifier({ issuer:'https://issuer-a.example',audience:'g-sql',algorithms:['ES256'],jwks:{ keys:[jwk] } }),accounts:createPostgresAccountResolver(pools.request) });
const repository = createPostgresTransitionRepository({ identity,requestPool:pools.request,mappingPool:pools.mapping });
const authority = createTransitionServiceAuthority({ mode:'rehearsal',identity,repository });
const allActions: readonly TransitionOperatorAction[] = ['prepare','verify','activate','freeze','rollback-empty','recover','status','export','restore','register-input'];
test.after(async () => { await Promise.all(Object.values(pools).map(pool => pool.end())); });
async function context(source?: string | null) {
  const app = 'g-test-' + randomUUID();
  await pools.admin.query('INSERT INTO gakja.application_targets VALUES($1,$2,$3,$4,$5,$6)',['owner-a','student-a',app,'domain-track','profile-r1','public G synthetic']);
  await pools.admin.query('INSERT INTO gakja.access_grants VALUES($1,$2,$3,$4,$5,$6,$7,true)',['account-a','owner-a','student-a',app,'domain-track',source !== undefined,source ?? null]);
  const token = await new SignJWT().setProtectedHeader({ alg:'ES256',kid:jwk.kid }).setIssuer('https://issuer-a.example').setSubject('shared').setAudience('g-sql').setExpirationTime('1h').sign(keys.privateKey);
  return identity.selectScope(await identity.authenticate('Bearer ' + token),{ applicationTargetId:app }) as AuthenticatedRequestContext;
}
function finite(c: AuthenticatedRequestContext) {
  return { ownerId:c.account.ownerId,...c.scope!,issuer:c.principal.issuer,subject:c.principal.subject,expiresAt:Date.now()+600_000,async checkCurrent() { await identity.revalidate(c);return true; } };
}
async function install(c: AuthenticatedRequestContext, granted = allActions) {
  const base = finite(c), input = { key:randomUUID(),inputSha256:hash(randomUUID()),grant:{ issuer:base.issuer,subject:base.subject,actions:granted,expiresAt:new Date(base.expiresAt-1000).toISOString(),active:true } };
  const snapshot = await repository.installOperator(c,input,createTransitionInstallerCapability({ ...base,key:input.key,inputSha256:input.inputSha256,sourceProofSha256:hash('explicit public synthetic operator source proof') }));
  return { snapshot,operator:createTransitionOperatorCapability({ ...base,actions:allActions }) };
}
async function advance(c: AuthenticatedRequestContext, op: ReturnType<typeof createTransitionOperatorCapability>, action: TransitionCommandAction, payload: unknown = {}) {
  const state = (await repository.read(c))!;
  return repository.command(c,createTransitionCommand({ key:randomUUID(),action,expectedGeneration:state.generation,payloadJson:JSON.stringify(payload) }),op);
}
function evidence(c: AuthenticatedRequestContext) {
  const localEvidenceJson = JSON.stringify({ scope:{ ownerId:c.account.ownerId,...c.scope! },inventoryComplete:true,activeLegacySessions:0,unparticipatingProcesses:0,writeBarrierInstalled:true,stoppedParticipantProofSha256:hash('synthetic stopped proof') });
  const checkpointJson = '{"synthetic":true,"originalBytes":"한글🙂\\r\\n"}';
  return { localEvidenceJson,localEvidenceSha256:hash(localEvidenceJson),checkpointJson,checkpointSha256:hash(checkpointJson),expiresAt:new Date(Date.now()+300_000).toISOString() };
}
async function activate(c: AuthenticatedRequestContext) {
  const { operator } = await install(c), proof = evidence(c); await advance(c,operator,'prepare',proof);
  const verificationJson = JSON.stringify({ verified:true,localEvidenceSha256:proof.localEvidenceSha256,checkpointSha256:proof.checkpointSha256 });
  await advance(c,operator,'verify',{ verificationJson,verificationSha256:hash(verificationJson) }); await advance(c,operator,'activate');
  return { operator,state:(await repository.read(c))! };
}
async function sql<T>(c: AuthenticatedRequestContext, pool: Pool, query: string, args: unknown[] = [], g?: Record<string,string>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); await settings(client,c,g); const result = (await client.query(query,args)).rows[0]?.value; await client.query('COMMIT'); return result; }
  catch(error) { await client.query('ROLLBACK');throw error; } finally { await client.query('RESET ALL');client.release(); }
}
async function settings(client: PoolClient,c: AuthenticatedRequestContext,g: Record<string,string> = {}) {
  const values = { issuer:c.principal.issuer,subject:c.principal.subject,account_id:c.account.accountId,account_revision:c.account.revision,owner_id:c.account.ownerId,student_id:c.scope!.studentId,application_target_id:c.scope!.applicationTargetId,...g };
  for (const [key,value] of Object.entries(values)) await client.query('SELECT set_config($1,$2,true)',['gakja.'+key,value]);
}
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

test('G-DB-01 finite operator authority is opaque, current, separate from user/reviewer and source presence stays exact',async () => {
  for (const source of [undefined,null,'source-g'] as const) {
    const c = await context(source), { snapshot,operator } = await install(c,['status']);
    assert.equal(Object.hasOwn(snapshot.scope,'sourceRevision'),source !== undefined);assert.equal(snapshot.scope.sourceRevision,source);
    assert.equal((await repository.authorizeOperator(c,'status',operator)).transitionId,snapshot.transitionId);
    await assert.rejects(repository.authorizeOperator(c,'prepare',operator),/TRANSITION_OPERATOR_REQUIRED/u);
    await assert.rejects(advance(c,operator,'prepare',evidence(c)),error => error instanceof TransitionError && error.code === 'TRANSITION_OPERATOR_REQUIRED');
    await assert.rejects(repository.receipt(c,'x',hash('x'),{ kind:'scoped-transition-operator-v1' }),/TRANSITION_OPERATOR_REQUIRED/u);
    await assert.rejects(sql(c,pools.request,'SELECT gakja.transition_command($1::jsonb) value',[JSON.stringify({ action:'prepare' })]),code('42501'));
  }
});
test('G-DB-02 unknown inventory and missing stop barrier cannot prepare; rejected evidence publishes no command or state',async () => {
  const c = await context(), { operator } = await install(c), proof = evidence(c), body = JSON.parse(proof.localEvidenceJson);body.inventoryComplete=false;
  proof.localEvidenceJson=JSON.stringify(body);proof.localEvidenceSha256=hash(proof.localEvidenceJson);
  await assert.rejects(advance(c,operator,'prepare',proof),/TRANSITION_EVIDENCE_REQUIRED/u);
  const valid=evidence(c);
  await assert.rejects(advance(c,operator,'prepare',{...valid,expiresAt:null}),/TRANSITION_EVIDENCE_REQUIRED/u);
  await assert.rejects(advance(c,operator,'prepare',{...valid,expiresAt:'infinity'}),/TRANSITION_EVIDENCE_REQUIRED/u);
  await assert.rejects(advance(c,operator,'prepare',{...valid,checkpointJson:null,checkpointSha256:null}),/TRANSITION_EVIDENCE_REQUIRED/u);
  assert.equal((await repository.read(c))!.state,'unprepared');
  assert.equal((await pools.admin.query('SELECT count(*)::int n FROM gakja.transition_commands WHERE transition_id=$1',[(await repository.read(c))!.transitionId])).rows[0].n,0);
});
test('G-DB-10 TS and actual SQL reject nonfinite operator grants before installing a scope or authority',async()=>{
  const c=await context(),base=finite(c);
  for(const expiresAt of ['infinity','not-a-date','']){
    const input={key:randomUUID(),inputSha256:hash(randomUUID()),grant:{issuer:base.issuer,subject:base.subject,actions:allActions,expiresAt,active:true}};
    const capability=createTransitionInstallerCapability({...base,key:input.key,inputSha256:input.inputSha256,sourceProofSha256:hash('explicit public synthetic operator source proof')});
    await assert.rejects(repository.installOperator(c,input,capability),/TRANSITION_INVALID/u);
  }
  const payload={key:randomUUID(),inputSha256:hash('explicit SQL infinity refusal'),sourceProofSha256:hash('proof'),grant:{issuer:base.issuer,subject:base.subject,actions:allActions,expiresAt:'infinity',active:true}};
  await assert.rejects(sql(c,pools.mapping,'SELECT gakja.transition_install_operator($1::jsonb) value',[JSON.stringify(payload)]),code('42501'));
  assert.equal(await repository.read(c),null);
  assert.throws(()=>createTransitionOperatorCapability({...base,actions:allActions,expiresAt:Number.POSITIVE_INFINITY}),/TRANSITION_OPERATOR_REQUIRED/u);
  assert.throws(()=>createTransitionOperatorCapability({...base,actions:allActions,expiresAt:Number.NaN}),/TRANSITION_OPERATOR_REQUIRED/u);
});
test('G-DB-03 prepare/verify/activate/freeze are CAS, exact idempotent receipts survive freeze and changed bytes conflict',async () => {
  const c = await context(), { operator,state } = await activate(c);
  assert.equal(state.state,'db-primary');assert.equal(state.generation,'3');
  const command = createTransitionCommand({ key:randomUUID(),action:'freeze',expectedGeneration:state.generation,payloadJson:'{}' });
  const first = await repository.command(c,command,operator), replay = await repository.command(c,command,operator);
  assert.equal(replay.operationId,first.operationId);assert.equal(replay.resultJson,first.resultJson);assert.equal(replay.replay,true);
  const changed = createTransitionCommand({ ...command,payloadJson:'{"changed":true}' });
  await assert.rejects(repository.command(c,changed,operator),/TRANSITION_IDEMPOTENCY_CONFLICT/u);
  await assert.rejects(repository.command(c,createTransitionCommand({ key:randomUUID(),action:'activate',expectedGeneration:'0',payloadJson:'{}' }),operator),/TRANSITION_GENERATION_CHANGED/u);
});
test('G-DB-04 selected scope rejects old isolated E/F/mapping/worker mutation RPCs and private cores without generation',async () => {
  const c = await context();await activate(c);
  for (const [pool,query,args] of [
    [pools.request,'SELECT gakja.session_begin($1::jsonb) value',[JSON.stringify({ sessionId:randomUUID() })]],
    [pools.mapping,'SELECT gakja.session_enroll($1::jsonb) value',[JSON.stringify({ creationKey:randomUUID(),inputSha256:hash('x') })]],
    [pools.request,'SELECT gakja.evaluation_consume($1::jsonb) value',['{}']],
    [pools.mapping,'SELECT gakja.evaluation_grant_worker($1::jsonb) value',['{}']],
    [pools.worker,'SELECT gakja.evaluation_worker($1,$2,$3::jsonb) value',[hash('missing'),'claim','{}']],
  ] as const) await assert.rejects(sql(c,pool,query,[...args]),code('P7303'));
  await assert.rejects(sql(c,pools.request,'SELECT gakja.session_begin_pre_g($1::jsonb) value',['{}']),code('42501'));
  await assert.rejects(sql(c,pools.mapping,'SELECT gakja.evaluation_restore($1::jsonb) value',['{}']),code('P7304'));
});
test('G-DB-05 finite operations pin generation, exclude legacy sessions and freeze cancels provider without publishing a result',async () => {
  const c = await context(), { operator,state } = await activate(c);
  await assert.rejects(repository.beginOperation(c,{ operationId:randomUUID(),generation:state.generation,kind:'provider',sessionId:'11111111-1111-4111-8111-111111111111',expiresAt:new Date(Date.now()+30_000).toISOString() }),/TRANSITION_EVIDENCE_REQUIRED/u);
  await assert.rejects(withTransitionOperation(authority,c,{ operationId:randomUUID(),generation:state.generation,kind:'provider',expiresAt:new Date(Date.now()+30_000).toISOString() },async signal => {
    const active = currentTransitionOperation(authority)!;assert.equal(active.generation,state.generation);assert.equal(active.signal,signal);
    const guc = await transitionSqlAuthorization(authority,c,'admit');
    await sql(c,pools.request,"SELECT (gakja.transition_guard('admit')).generation::text value",[],guc);
    await advance(c,operator,'freeze');
    await Promise.race([new Promise<void>(resolve => signal.addEventListener('abort',() => resolve(),{ once:true })),new Promise<never>((_,reject) => setTimeout(() => reject(new Error('GENERATION_POLL_DID_NOT_CANCEL')),3000))]);
    assert.equal(signal.aborted,true);await assert.rejects(sql(c,pools.request,"SELECT gakja.transition_guard('admit') value",[],guc),code('P7303'));
    for(const action of ['renew','checkpoint','usage','complete','fail'])
      await assert.rejects(sql(c,pools.worker,'SELECT gakja.evaluation_worker($1,$2,$3::jsonb) value',[hash('controlled-stale-job'),action,'{}'],guc),code('P7303'));
  }),/TRANSITION_GENERATION_CHANGED/u);
  assert.equal((await repository.read(c))!.activeOperations,0);
  await assert.rejects(repository.beginOperation(c,{ operationId:randomUUID(),generation:state.generation,kind:'http',expiresAt:new Date(Date.now()+30_000).toISOString() }),/TRANSITION_GENERATION_CHANGED/u);
});
test('G-DB-06 final SQL shared generation lock serializes freeze through commit and blocks every stale post-freeze mutation',async () => {
  const c = await context(), { operator,state } = await activate(c), operation = await repository.beginOperation(c,{ operationId:randomUUID(),generation:state.generation,kind:'cli',expiresAt:new Date(Date.now()+30_000).toISOString() });
  const guc = { transition_mode:'service-g',transition_id:state.transitionId,transition_generation:state.generation,transition_operation:operation.operationId }, client = await pools.request.connect();
  await client.query('BEGIN');await settings(client,c,guc);await client.query("SELECT gakja.transition_guard('admit')");
  let done=false;const freezing=advance(c,operator,'freeze').then(value => { done=true;return value; });
  let observed=false;
  for(let i=0;i<100;i++) { const row=(await pools.admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%transition_command%' ")).rows[0];if(row.n>0){observed=true;break;}await new Promise(resolve=>setTimeout(resolve,10)); }
  assert.equal(observed,true);assert.equal(done,false);await client.query('COMMIT');client.release();await freezing;
  await assert.rejects(sql(c,pools.request,"SELECT gakja.transition_guard('admit') value",[],guc),code('P7303'));
});
test('G-DB-07 new E enrollment preserves exact canonical bytes and records a real durable write; post-write rollback is denied',async () => {
  const c = await context(), { operator,state } = await activate(c), fixture = await evaluationSupplyFixture();
  fixture.context.student={ ...fixture.context.student,studentId:c.scope!.studentId };fixture.session.runtime=createAuthenticatedSessionRuntime(fixture.context,c.account.ownerId);
  const sessionJson=JSON.stringify(fixture.session),contextJson=JSON.stringify(fixture.context),pinsJson='{ "unchanged": true, "unicode": "한글🙂" }\r\n';
  const input={ sessionId:fixture.session.id,creationKey:randomUUID(),inputSha256:hash(fixture.session.id),sessionJson,contextJson,pinsJson,sourceSha256:fixture.bank.sourceFingerprint };
  await withTransitionOperation(authority,c,{ operationId:randomUUID(),generation:state.generation,kind:'http',expiresAt:new Date(Date.now()+30_000).toISOString() },async () => {
    const guc=await transitionSqlAuthorization(authority,c,'admit');const result=await sql<{ sessionJson:string;contextJson:string;pinsJson:string }>(c,pools.mapping,'SELECT gakja.session_enroll($1::jsonb) value',[JSON.stringify(input)],guc);
    assert.equal(result.sessionJson,sessionJson);assert.equal(result.contextJson,contextJson);assert.equal(result.pinsJson,pinsJson);
  });
  assert.equal((await repository.read(c))!.writeFacts,1);await advance(c,operator,'freeze');
  await assert.rejects(advance(c,operator,'rollback-empty'),/TRANSITION_EVIDENCE_REQUIRED/u);
  assert.equal((await pools.admin.query('SELECT pins_json FROM gakja.session_command_sessions WHERE session_id=$1',[input.sessionId])).rows[0].pins_json,pinsJson);
});
test('G-DB-08 only an actually empty frozen DB scope can roll back; finite grant revocation defeats a still-minted TS capability',async () => {
  const c=await context(),{ operator,state }=await activate(c);await advance(c,operator,'freeze');await advance(c,operator,'rollback-empty');assert.equal((await repository.read(c))!.state,'local-primary');
  await pools.admin.query('UPDATE gakja.transition_operator_grants SET active=false WHERE transition_id=$1',[state.transitionId]);
  await assert.rejects(advance(c,operator,'prepare',evidence(c)),/TRANSITION_OPERATOR_REQUIRED/u);
});
test('G-DB-09 source grant absent/null/string changes cannot retarget an already selected authority and cross-target access stays isolated',async () => {
  const c=await context(null),{ snapshot }=await install(c);assert.equal(snapshot.scope.sourceRevision,null);
  await pools.admin.query('UPDATE gakja.access_grants SET source_revision=$1 WHERE account_id=$2 AND application_target_id=$3',['new-source','account-a',c.scope!.applicationTargetId]);
  await assert.rejects(repository.read(c));
  const other=await context('other-source');assert.equal(await repository.read(other),null);
});
