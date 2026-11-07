import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createRequestIdentityBoundary, type AuthenticatedRequestContext } from '../../server/auth/request-identity';
import { createTrustedJwtVerifier } from '../../server/auth/jose-jwt-verifier';
import { createPostgresAccountResolver, createPostgresRequestAuthority } from '../../server/db/postgres-authority';
import { createPostgresObjectRepository } from '../../server/db/postgres-object-repository';
import { createInternalObjectCapability, createPrivateObjectService } from '../../server/storage/private-object-service';
import { ObjectProviderError } from '../../server/storage/supabase-object-provider';
import type { ObjectStorageProvider, StorageObjectRef } from '../../server/storage/private-object-ports';
import { createPostgresTransitionRepository, createTransitionCommand, createTransitionInstallerCapability, createTransitionOperatorCapability } from '../../server/transition/postgres-transition';
import { captureRecoveryArchive, restoreRecoveryArchive, createRestoredObjectProvider } from '../../server/transition/recovery';
import type { TransitionCommandAction, TransitionOperatorAction } from '../../server/transition/transition-ports';

const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const make=(role:string,restore=false)=>{
  const value=process.env['PR07G_TEST_'+(restore?'RESTORE_':'')+role+'_URL'];
  if(process.env.PR07G_TEST_DISPOSABLE!=='1'||!value||!/^\/pr07g_[a-z0-9_]+$/u.test(new URL(value).pathname))throw new Error('PR07G_OWNED_DATABASE_REQUIRED');
  return new Pool({connectionString:value,max:2,connectionTimeoutMillis:5000,idleTimeoutMillis:1000});
};
const source={admin:make('ADMIN'),request:make('REQUEST'),mapping:make('MAPPING')},destination={admin:make('ADMIN',true),request:make('REQUEST',true),mapping:make('MAPPING',true)};
const keys=await generateKeyPair('ES256'),jwk={...await exportJWK(keys.publicKey),kid:'g-recovery-sql',alg:'ES256'};
const token=await new SignJWT().setProtectedHeader({alg:'ES256',kid:jwk.kid}).setIssuer('https://issuer-a.example').setSubject('shared').setAudience('g-recovery-sql').setExpirationTime('1h').sign(keys.privateKey);
const actions:TransitionOperatorAction[]=['prepare','verify','activate','freeze','status','export','restore'];
test.after(async()=>{await Promise.all([...Object.values(source),...Object.values(destination)].map(pool=>pool.end()));});
function controlled(){
  const data=new Map<string,Buffer>();const key=(ref:StorageObjectRef)=>JSON.stringify([ref.bucket,ref.key]);
  const provider:ObjectStorageProvider={async read(ref){const value=data.get(key(ref));if(!value)throw new ObjectProviderError('STORAGE_NOT_FOUND');return Buffer.from(value);},
    async upload(ref,bytes){if(data.has(key(ref)))throw new ObjectProviderError('STORAGE_CONFLICT');data.set(key(ref),Buffer.from(bytes));},
    async copy(from,to){const value=data.get(key(from));if(!value)throw new ObjectProviderError('STORAGE_NOT_FOUND');data.set(key(to),Buffer.from(value));},async remove(ref){data.delete(key(ref));}};
  return provider;
}
test('G-RECOVERY-DB exact B bytes and real verified C metadata roundtrip atomically; tampering stays unpublished and old authorities stay revoked',async()=>{
  const app='g-recovery-'+randomUUID();
  async function setup(pools:typeof source){
    await pools.admin.query('INSERT INTO gakja.application_targets VALUES($1,$2,$3,$4,$5,$6)',['owner-a','student-a',app,'domain-track','profile-r1','G public recovery metadata']);
    await pools.admin.query('INSERT INTO gakja.access_grants VALUES($1,$2,$3,$4,$5,false,NULL,true)',['account-a','owner-a','student-a',app,'domain-track']);
    const identity=createRequestIdentityBoundary({mode:'service',verifier:createTrustedJwtVerifier({issuer:'https://issuer-a.example',audience:'g-recovery-sql',algorithms:['ES256'],jwks:{keys:[jwk]}}),accounts:createPostgresAccountResolver(pools.request)});
    const context=identity.selectScope(await identity.authenticate('Bearer '+token),{applicationTargetId:app}) as AuthenticatedRequestContext;
    const repository=createPostgresTransitionRepository({identity,requestPool:pools.request,mappingPool:pools.mapping});
    const finite={ownerId:context.account.ownerId,...context.scope!,issuer:context.principal.issuer,subject:context.principal.subject,expiresAt:Date.now()+600_000,async checkCurrent(){await identity.revalidate(context);return true;}};
    const operator=createTransitionOperatorCapability({...finite,actions});
    async function install(){const input={key:randomUUID(),inputSha256:hash('public recovery installer'),grant:{issuer:finite.issuer,subject:finite.subject,actions,expiresAt:new Date(finite.expiresAt-1000).toISOString(),active:true}};
      await repository.installOperator(context,input,createTransitionInstallerCapability({...finite,key:input.key,inputSha256:input.inputSha256,sourceProofSha256:hash('public synthetic fixture only')}));}
    async function command(action:TransitionCommandAction,payload:unknown){const state=(await repository.read(context))!;return repository.command(context,createTransitionCommand({key:randomUUID(),action,expectedGeneration:state.generation,payloadJson:JSON.stringify(payload)}),operator);}
    return{identity,context,repository,operator,install,command};
  }
  const s=await setup(source),d=await setup(destination),sourceProvider=controlled(),destinationProvider=controlled();
  // Actual C admission/upload/format verification/read-back and CAS lifecycle;
  // only the object provider here is explicitly controlled, not an API claim.
  const objectRepository=createPostgresObjectRepository({authority:createPostgresRequestAuthority(source.request,s.identity),boundary:s.identity,mappingPool:source.mapping,bucket:'recovery-source',keyPrefix:'recovery_source'});
  const objects=createPrivateObjectService({repository:objectRepository,provider:sourceProvider});
  const bytes=Buffer.from('원문🙂\r\nDo not rewrite canonical bytes.\n'),idempotencyKey=randomUUID();
  const capability=createInternalObjectCapability({scope:{kind:'target',ownerId:'owner-a',studentId:'student-a',applicationTargetId:app,supportTargetId:'domain-track'},kinds:['source-markdown'],idempotencyKeys:[idempotencyKey],objectIds:[],expiresAt:Date.now()+300_000,async checkCurrent(){await s.identity.revalidate(s.context);return true;}});
  const receipt=await objects.admitGenerated(s.context,{kind:'source-markdown',scope:'target',studentId:'student-a',expectedSize:bytes.length,expectedSha256:hash(bytes),idempotencyKey},capability);
  const objectCapability=createInternalObjectCapability({scope:{kind:'target',ownerId:'owner-a',studentId:'student-a',applicationTargetId:app,supportTargetId:'domain-track'},kinds:['source-markdown'],idempotencyKeys:[idempotencyKey],objectIds:[receipt.objectId],expiresAt:Date.now()+300_000,async checkCurrent(){await s.identity.revalidate(s.context);return true;}});
  await objects.upload(s.context,receipt.receiptId,bytes,objectCapability);await objects.complete(s.context,receipt.receiptId,objectCapability);
  await s.install();await d.install();
  const localEvidenceJson=JSON.stringify({scope:{ownerId:'owner-a',...s.context.scope!},inventoryComplete:true,activeLegacySessions:0,unparticipatingProcesses:0,writeBarrierInstalled:true,stoppedParticipantProofSha256:hash('controlled SQL fixture; physical process barrier tested separately')});
  const checkpointJson='{"controlledSqlFixture":true}';
  await s.command('prepare',{localEvidenceJson,localEvidenceSha256:hash(localEvidenceJson),checkpointJson,checkpointSha256:hash(checkpointJson),expiresAt:new Date(Date.now()+300_000).toISOString()});
  await s.command('freeze',{});
  const exported=await s.repository.exportRecovery(s.context,s.operator),metadata=JSON.parse(exported.metadataJson);
  assert.equal(metadata.objects.length,1);assert.equal(metadata.tables.common_versions.length,1);
  const policy={maxMetadataBytes:8*1024*1024,maxObjectBytes:1024,maxTotalBytes:4096,maxObjects:5};
  const archive=await captureRecoveryArchive(exported,sourceProvider,policy);
  const publication={async publish(value:Parameters<typeof d.repository.restoreRecovery>[2]){await d.repository.restoreRecovery(d.context,d.operator,value);}};
  const bad=JSON.parse(exported.metadataJson);bad.tables.common_versions[0].domain_sha256='0'.repeat(64);const badJson=JSON.stringify(bad);
  await assert.rejects(d.repository.restoreRecovery(d.context,d.operator,{metadataJson:badJson,metadataSha256:hash(badJson),manifestSha256:archive.manifestSha256,locations:[]}));
  assert.equal((await destination.admin.query('SELECT count(*) n FROM gakja.transition_recovery_publications')).rows[0].n,'0');
  const result=await restoreRecoveryArchive({archive,destination:destinationProvider,publication,bucket:'recovery-destination',keyPrefix:'recovery_destination',policy});
  assert.deepEqual(await createRestoredObjectProvider({destination:destinationProvider,locations:result.locations}).read(receipt.finalRef,{maxBytes:bytes.length}),bytes);
  assert.equal((await d.repository.read(d.context))!.state,'read-only-recovery');
  assert.equal((await destination.admin.query('SELECT count(*) n FROM gakja.transition_operator_grants WHERE active')).rows[0].n,'0');
  const copied=(await destination.admin.query('SELECT * FROM gakja.common_versions WHERE owner_id=$1 AND student_id=$2',['owner-a','student-a'])).rows[0];
  const original=(await source.admin.query('SELECT * FROM gakja.common_versions WHERE owner_id=$1 AND student_id=$2',['owner-a','student-a'])).rows[0];
  assert.deepEqual(copied.original_bytes,original.original_bytes);assert.equal(copied.content_sha256,original.content_sha256);assert.equal(copied.domain_sha256,original.domain_sha256);
  await assert.rejects(d.repository.access(d.context,'session-write'));
});
