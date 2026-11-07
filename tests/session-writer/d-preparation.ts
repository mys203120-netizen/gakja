import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { interviewConfig } from '../../interview.config';
import type { InterviewPlan } from '../../server/interview-planner';
import { loadInterviewContextAt } from '../../server/data/load-interview-context';
import { loadQuestionBank } from '../../server/data/prepared-question-bank';
import { createRequestIdentityBoundary, RequestAccessError, type AuthenticatedRequestContext, type PrincipalVerifier } from '../../server/auth/request-identity';
import { createTrustedJwtVerifier } from '../../server/auth/jose-jwt-verifier';
import { createPostgresAccountResolver, createPostgresRequestAuthority } from '../../server/db/postgres-authority';
import { createPostgresObjectRepository } from '../../server/db/postgres-object-repository';
import { createPostgresShadowRepository, createShadowImportCapability } from '../../server/db/postgres-shadow-repository';
import { createPrivateObjectService } from '../../server/storage/private-object-service';
import { createSupabaseObjectProvider } from '../../server/storage/supabase-object-provider';
import type { ObjectStorageProvider } from '../../server/storage/private-object-ports';
import { inventoryShadowFiles, type ShadowInventory, type ShadowInventoryRequest } from '../../server/shadow/shadow-plan';
import { createShadowImporter } from '../../server/shadow/shadow-import';
import { createShadowReadRepositories } from '../../server/repositories/shadow-read-repositories';
import type { testPools } from './session-writer-test-database';

export interface PublicDSessionFixture {
  version: 'pr07d-public-synthetic-fixture-v1';
  configuration: Pick<typeof interviewConfig,'target'|'files'>;
  source: {studentId:string;pdfSha256:string;revision:string};
  scope: {studentId:string;supportTargetId:string;sourceRevision:string};
  profileRevision:string;
  publicSchoolIds:{universityId:string;departmentId:string;admissionTrackId:string};
  provenanceOwnerId:string; artifacts:ShadowInventoryRequest['artifacts']; pointers:ShadowInventoryRequest['pointers'];
  plan:InterviewPlan; environment:Record<string,string>; speechHash:string; bankKey:string;
}
export type SessionWriterTestPools=ReturnType<typeof testPools>;
export const eAudience='pr07e-two-server';

/** Only an owned public synthetic fixture prepared by the exact C runner is
 * accepted. No private data root or production environment is auto-adopted. */
export async function loadOwnedPublicDFixture() {
  const root=process.env.PR07E_TEST_FIXTURE_ROOT,result=process.env.PR07E_TEST_BASELINE_RESULT;
  if(process.env.PR07E_TEST_DISPOSABLE!=='1'||!root||!result)throw new Error('PR07E_OWNED_PUBLIC_BASELINE_REQUIRED');
  const relative=path.relative(path.resolve('artifacts/pr07d'),path.resolve(root));
  if(!/^baseline-[a-z0-9_]+[\\/]synthetic-input$/u.test(relative)||await realpath(root)!==path.resolve(root))throw new Error('PR07E_BASELINE_ROOT_INVALID');
  const fixture=JSON.parse(await readFile(path.join(root,'fixture-manifest.json'),'utf8')) as PublicDSessionFixture;
  const baseline=JSON.parse(await readFile(result,'utf8')) as {codeCommit:string;metrics:{fixtureFileReads:number;fixtureFileWrites:number}};
  if(fixture.version!=='pr07d-public-synthetic-fixture-v1'||baseline.codeCommit!=='3204e83ea5bde64c57fe0da57cc7abc8ecca44fb'||baseline.metrics.fixtureFileReads<1||baseline.metrics.fixtureFileWrites!==0)throw new Error('PR07E_EXACT_C_BASELINE_INVALID');
  return {root,fixture,baseline};
}
export async function createSessionTestSigningAuthority() {
  const keys=await generateKeyPair('ES256'),jwk={...await exportJWK(keys.publicKey),kid:'pr07e-two-server-signature',alg:'ES256'};
  return {jwk,async token(who:'a'|'b',expiresIn='2h') {
    return new SignJWT().setProtectedHeader({alg:'ES256',kid:jwk.kid}).setIssuer(`https://issuer-${who}.example`).setSubject('shared').setAudience(eAudience).setIssuedAt().setExpirationTime(expiresIn).sign(keys.privateKey);
  }};
}
export function createSessionTestAuthority(pools:SessionWriterTestPools,jwk:Awaited<ReturnType<typeof createSessionTestSigningAuthority>>['jwk'],now=Date.now) {
  const verifiers=['a','b'].map(who=>createTrustedJwtVerifier({issuer:`https://issuer-${who}.example`,audience:eAudience,algorithms:['ES256'],jwks:{keys:[jwk]}}));
  const verifier:PrincipalVerifier={kind:'trusted-jwt',async verify(token){
    for(const current of verifiers)try{return await current.verify(token);}catch(error){if(!(error instanceof RequestAccessError)||error.status===503)throw error;}
    throw new RequestAccessError(401,'AUTH_INVALID');
  }};
  const identity=createRequestIdentityBoundary({mode:'service',verifier,accounts:createPostgresAccountResolver(pools.request),now});
  const authority=createPostgresRequestAuthority(pools.request,identity);
  return {identity,authority};
}
export async function seedPublicDOuterScope(pools:SessionWriterTestPools,fixture:PublicDSessionFixture) {
  await pools.admin.query('INSERT INTO gakja.target_profiles VALUES($1,$2,$3,$4,$5,2027)',[fixture.scope.supportTargetId,fixture.profileRevision,fixture.publicSchoolIds.universityId,fixture.publicSchoolIds.departmentId,fixture.publicSchoolIds.admissionTrackId]);
  for(const who of ['a','b'] as const){
    await pools.admin.query('INSERT INTO gakja.students VALUES($1,$2,$3,$4)',['owner-'+who,fixture.source.studentId,'Explicit synthetic E student',fixture.source.pdfSha256]);
    await pools.admin.query('INSERT INTO gakja.application_targets VALUES($1,$2,$3,$4,$5,$6)',['owner-'+who,fixture.source.studentId,'shadow-app-'+who,fixture.scope.supportTargetId,fixture.profileRevision,'Explicit synthetic E outer mapping']);
    await pools.admin.query('INSERT INTO gakja.access_grants(account_id,owner_id,student_id,application_target_id,support_target_id,source_present,source_revision) VALUES($1,$2,$3,$4,$5,false,NULL)',
      ['account-'+who,'owner-'+who,fixture.source.studentId,'shadow-app-'+who,fixture.scope.supportTargetId]);
  }
}
export function createEObjects(pools:SessionWriterTestPools,auth:ReturnType<typeof createSessionTestAuthority>,providerOverride?:ObjectStorageProvider) {
  const apiUrl=process.env.PR07E_TEST_STORAGE_API_URL,credential=process.env.PR07E_TEST_STORAGE_SERVICE_KEY,bucket=process.env.PR07E_TEST_BUCKET,keyPrefix=process.env.PR07E_TEST_KEY_PREFIX;
  if(!apiUrl||!credential||!bucket||!keyPrefix)throw new Error('PR07E_EXPLICIT_STORAGE_REQUIRED');
  const objectRepository=createPostgresObjectRepository({authority:auth.authority,boundary:auth.identity,mappingPool:pools.mapping,bucket,keyPrefix});
  const provider=providerOverride??createSupabaseObjectProvider({apiUrl,serviceCredential:credential,bucket,keyPrefix,allowLoopbackHttp:true});
  const objects=createPrivateObjectService({repository:objectRepository,provider});
  const shadow=createPostgresShadowRepository({authority:auth.authority,boundary:auth.identity,mappingPool:pools.mapping});
  return {objects,objectRepository,shadow};
}
export function shadowCapability(context:AuthenticatedRequestContext,inventory:ShadowInventory,identity:ReturnType<typeof createSessionTestAuthority>['identity']) {
  return createShadowImportCapability({runId:inventory.plan.runId,planSha256:inventory.plan.planSha256,ownerId:inventory.plan.ownerId,studentId:inventory.plan.studentId,applicationTargetId:inventory.plan.applicationTargetId,supportTargetId:inventory.plan.supportTargetId,
    artifactIds:inventory.plan.artifacts.map(a=>a.artifactId),expiresAt:Date.now()+1_800_000,async checkCurrent(){try{await identity.revalidate(context);return true;}catch{return false;}}});
}
export async function importPublicDContexts(pools:SessionWriterTestPools,signing:Awaited<ReturnType<typeof createSessionTestSigningAuthority>>,root:string,fixture:PublicDSessionFixture,providerOverride?:ObjectStorageProvider) {
  const auth=createSessionTestAuthority(pools,signing.jwk),storage=createEObjects(pools,auth,providerOverride),contexts=new Map<'a'|'b',AuthenticatedRequestContext>(),inventories=new Map<'a'|'b',ShadowInventory>();
  Object.assign(interviewConfig,{target:fixture.configuration.target,files:fixture.configuration.files});
  const importer=createShadowImporter({repository:storage.shadow,objects:storage.objects,objectRepository:storage.objectRepository,identity:auth.identity,roots:{fixture:root}});
  for(const who of ['a','b'] as const){
    const context=auth.identity.selectScope(await auth.identity.authenticate('Bearer '+await signing.token(who)),{applicationTargetId:'shadow-app-'+who}) as AuthenticatedRequestContext;
    const inventory=await inventoryShadowFiles({version:'shadow-inventory-request-v1',runId:'e_shadow_'+randomUUID(),binding:'synthetic',ownerId:'owner-'+who,studentId:fixture.source.studentId,applicationTargetId:'shadow-app-'+who,
      supportTargetId:fixture.scope.supportTargetId,provenanceOwnerId:fixture.provenanceOwnerId,artifacts:fixture.artifacts,pointers:fixture.pointers},{fixture:root});
    if(!inventory.eligible)throw new Error('PR07E_PUBLIC_D_INVENTORY_BLOCKED');
    const audio=inventory.plan.artifacts.find(a=>a.artifactId==='audio');
    if(!audio||audio.availability!=='present')throw new Error('PR07E_PUBLIC_AUDIO_PIN_REQUIRED');
    await pools.admin.query('INSERT INTO gakja.audio_bindings(owner_id,resource_id,student_id,application_target_id,support_target_id,source_present,source_revision,content_sha256) VALUES($1,$2,$3,$4,$5,true,$6,$7)',
      ['owner-'+who,fixture.speechHash,fixture.source.studentId,'shadow-app-'+who,fixture.scope.supportTargetId,fixture.source.revision,audio.rawSha256]);
    const imported=await importer.import(context,inventory,shadowCapability(context,inventory,auth.identity));
    const audioBinding=imported.snapshot.artifacts.find(a=>a.artifactId==='audio');
    if(!audioBinding?.receiptId||!await storage.objectRepository.linkAudio(context,audioBinding.receiptId,fixture.speechHash))throw new Error('PR07E_PUBLIC_AUDIO_LINK_REQUIRED');
    contexts.set(who,context);inventories.set(who,inventory);
  }
  return {auth,storage,contexts,inventories,importer,async cleanup(){
    for(const who of ['a','b'] as const){
      const context=auth.identity.selectScope(await auth.identity.authenticate('Bearer '+await signing.token(who)),{applicationTargetId:'shadow-app-'+who}) as AuthenticatedRequestContext,inventory=inventories.get(who)!;
      const result=await importer.cleanup(context,inventory,shadowCapability(context,inventory,auth.identity));
      if(!result.complete||result.remaining.length)throw new Error('PR07E_D_CLEANUP_INCOMPLETE');
    }
  }};
}
/** This exact factory is used by each independent server process. The domain
 * loaders receive actual D repositories and never a local mirror directory. */
export async function readVerifiedDPreparation(auth:ReturnType<typeof createSessionTestAuthority>,storage:ReturnType<typeof createEObjects>,context:AuthenticatedRequestContext,fixture:PublicDSessionFixture,runId:string) {
  Object.assign(interviewConfig,{target:fixture.configuration.target,files:fixture.configuration.files});
  const read=await createShadowReadRepositories({context,runId,repository:storage.shadow,objects:storage.objects,environment:'isolated-shadow'});
  const root=path.resolve('artifacts/pr07e/forbidden-local-candidate-data');
  const value=await loadInterviewContextAt(root,{...read.readOptions(),writeManifest:false});
  const bank=await loadQuestionBank(value,{...read.bankOptions(),root,plan:fixture.plan,environment:fixture.environment});
  await read.assertSnapshotUnchanged();await auth.identity.revalidate(context);
  if(value.errors.length||!bank)throw new Error('PR07E_D_PREPARATION_REJECTED');
  return {context:value,bank,read,runId};
}
