import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID,createHash } from 'node:crypto';
import { exportJWK,generateKeyPair,SignJWT } from 'jose';
import { interviewConfig } from '../../interview.config';
import { loadInterviewContextAt } from '../../server/data/load-interview-context';
import { loadFullRecord,loadFullStudentAnalysisSnapshot,loadStagedFullStudentAnalysisSnapshot } from '../../server/data/full-student-analysis';
import { loadQuestionBank } from '../../server/data/prepared-question-bank';
import { resolveQuestionReviewAuthority,createQuestionReviewAuthorityScope } from '../../server/data/question-review-authority';
import { createRequestIdentityBoundary,RequestAccessError,type PrincipalVerifier,type AuthenticatedRequestContext } from '../../server/auth/request-identity';
import { createTrustedJwtVerifier } from '../../server/auth/jose-jwt-verifier';
import { createPostgresAccountResolver,createPostgresRequestAuthority } from '../../server/db/postgres-authority';
import { createPostgresObjectRepository } from '../../server/db/postgres-object-repository';
import { createPostgresShadowRepository,createShadowImportCapability } from '../../server/db/postgres-shadow-repository';
import { createSupabaseObjectProvider } from '../../server/storage/supabase-object-provider';
import { createPrivateObjectService } from '../../server/storage/private-object-service';
import type { ObjectStorageProvider } from '../../server/storage/private-object-ports';
import { inventoryShadowFiles,type ShadowInventoryRequest,type ShadowInventory } from '../../server/shadow/shadow-plan';
import { createShadowImporter } from '../../server/shadow/shadow-import';
import { compareShadowObservations } from '../../server/shadow/shadow-compare';
import { createShadowReadRepositories } from '../../server/repositories/shadow-read-repositories';
import { testPools,closePools } from './shadow-test-database';
import { baselineDependencyFaults } from './c-dependency-faults.mjs';

// Real PostgreSQL and the pinned official Storage API are mandatory here. Fault
// injection wraps actual provider IO; it is not substituted as a storage engine.
const root=process.env.PR07D_TEST_FIXTURE_ROOT,baselineFile=process.env.PR07D_TEST_BASELINE_RESULT;
const apiUrl=process.env.PR07D_TEST_STORAGE_API_URL,credential=process.env.PR07D_TEST_STORAGE_SERVICE_KEY;
const bucket=process.env.PR07D_TEST_BUCKET,keyPrefix=process.env.PR07D_TEST_KEY_PREFIX;
const diagnostic=process.env.PR07D_TEST_CONTROLLED_PROVIDER_DIAGNOSTIC==='1';
if(diagnostic&&process.env.GITHUB_ACTIONS==='true')throw new Error('PR07D_CI_REQUIRES_OFFICIAL_STORAGE');
if(!root||!baselineFile||!apiUrl||!credential||!bucket||!keyPrefix)throw new Error('PR07D_ACTUAL_BASELINE_DATABASE_STORAGE_REQUIRED');
const fixture=JSON.parse(await fs.promises.readFile(path.join(root,'fixture-manifest.json'),'utf8'));
const baseline=JSON.parse(await fs.promises.readFile(baselineFile,'utf8'));
if(baseline.codeCommit!=='3204e83ea5bde64c57fe0da57cc7abc8ecca44fb'||baseline.metrics.fixtureFileReads<1||baseline.metrics.fixtureFileWrites!==0)throw new Error('PR07D_INDEPENDENT_BASELINE_REQUIRED');
Object.assign(interviewConfig,{target:fixture.configuration.target,files:fixture.configuration.files});
const pools=testPools(1),rows:Record<string,unknown>[]=[];
const json=(value:unknown)=>JSON.parse(JSON.stringify(value));
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const poisonRoot=path.join(root,'no-local-fallback-here');
const keys=await generateKeyPair('ES256'),jwk={...await exportJWK(keys.publicKey),kid:'pr07d-shadow-signature',alg:'ES256'};
const verifiers=['a','b'].map(who=>createTrustedJwtVerifier({issuer:`https://issuer-${who}.example`,audience:'pr07d-shadow',algorithms:['ES256'],jwks:{keys:[jwk]}}));
const verifier:PrincipalVerifier={kind:'trusted-jwt',async verify(token){for(const candidate of verifiers){try{return await candidate.verify(token);}catch(error){if(!(error instanceof RequestAccessError)||error.status===503)throw error;}}throw new RequestAccessError(401,'AUTH_INVALID');}};
const identity=createRequestIdentityBoundary({mode:'service',verifier,accounts:createPostgresAccountResolver(pools.request)});
const authority=createPostgresRequestAuthority(pools.request,identity);
const objectRepository=createPostgresObjectRepository({authority,boundary:identity,mappingPool:pools.mapping,bucket,keyPrefix});
const repository=createPostgresShadowRepository({authority,boundary:identity,mappingPool:pools.mapping});
const controlledObjects=new Map<string,Buffer>();
const actual:ObjectStorageProvider=diagnostic?{
  async read(ref){const bytes=controlledObjects.get(JSON.stringify(ref));if(!bytes)throw new Error('CONTROLLED_OBJECT_MISSING');return Buffer.from(bytes);},
  async upload(ref,bytes){if(controlledObjects.has(JSON.stringify(ref)))throw new Error('CONTROLLED_OBJECT_EXISTS');controlledObjects.set(JSON.stringify(ref),Buffer.from(bytes));},
  async copy(from,to){const bytes=controlledObjects.get(JSON.stringify(from));if(!bytes)throw new Error('CONTROLLED_OBJECT_MISSING');controlledObjects.set(JSON.stringify(to),Buffer.from(bytes));},
  async remove(ref){controlledObjects.delete(JSON.stringify(ref));},
}:createSupabaseObjectProvider({apiUrl,serviceCredential:credential,bucket,keyPrefix,allowLoopbackHttp:true});
const io={read:0,upload:0,copy:0,remove:0};let readFault=false,copyFault=false;
let dependencyFault:{key:string;bytes:Buffer}|undefined;
const provider:ObjectStorageProvider={
  async read(ref,options){io.read++;if(readFault)throw new Error('CONTROLLED_PROVIDER_READ_FAILURE');const bytes=await actual.read(ref,options);return dependencyFault?.key===ref.key?Buffer.from(dependencyFault.bytes):bytes;},
  async upload(ref,bytes,options){io.upload++;return actual.upload(ref,bytes,options);},
  async copy(from,to,options){io.copy++;const value=await actual.copy(from,to,options);if(copyFault){copyFault=false;throw new Error('CONTROLLED_COPY_RESPONSE_LOST');}return value;},
  async remove(ref,options){io.remove++;return actual.remove(ref,options);},
};
const objects=createPrivateObjectService({repository:objectRepository,provider});
const inventories:ShadowInventory[]=[],contexts=new Map<string,AuthenticatedRequestContext>();
const originalRead=fs.promises.readFile.bind(fs.promises);let observing=false,localAttempts=0;
fs.promises.readFile=async function(...args:Parameters<typeof fs.promises.readFile>){
  const [file]=args;
  if(observing){const value=path.resolve(String(file)),relative=path.relative(root!,value);if(!relative.startsWith('..')&&!path.isAbsolute(relative)){localAttempts++;throw new Error('PR07D_FORBIDDEN_LOCAL_FALLBACK');}}
  return originalRead(...args);
} as typeof fs.promises.readFile;
syncBuiltinESMExports();
async function noLocal<T>(operation:()=>Promise<T>):Promise<T>{const before=localAttempts;observing=true;try{return await operation();}finally{observing=false;assert.equal(localAttempts,before);}}
async function selected(who:'a'|'b'){
  const token=await new SignJWT().setProtectedHeader({alg:'ES256',kid:jwk.kid}).setIssuer(`https://issuer-${who}.example`).setSubject('shared').setAudience('pr07d-shadow').setExpirationTime('2h').sign(keys.privateKey);
  const authenticated=await identity.authenticate('Bearer '+token);return identity.selectScope(authenticated,{applicationTargetId:'shadow-app-'+who}) as AuthenticatedRequestContext;
}
function capability(context:AuthenticatedRequestContext,inventory:ShadowInventory){return createShadowImportCapability({
  runId:inventory.plan.runId,planSha256:inventory.plan.planSha256,ownerId:inventory.plan.ownerId,studentId:inventory.plan.studentId,
  applicationTargetId:inventory.plan.applicationTargetId,supportTargetId:inventory.plan.supportTargetId,artifactIds:inventory.plan.artifacts.map(a=>a.artifactId),expiresAt:Date.now()+1_800_000,
  async checkCurrent(){try{await identity.revalidate(context);return true;}catch{return false;}}});}
async function readDomain(context:AuthenticatedRequestContext,inventory:ShadowInventory){
  const read=await createShadowReadRepositories({context,runId:inventory.plan.runId,repository,objects,environment:'isolated-shadow'});
  return noLocal(async()=>{
    const source=await loadFullRecord(poisonRoot,fixture.source.pdfSha256,read.readOptions());
    const current=await loadFullStudentAnalysisSnapshot(fixture.contextInput,poisonRoot,read.readOptions());
    const contextValue=await loadInterviewContextAt(poisonRoot,{...read.readOptions(),writeManifest:false});
    const staged=await loadStagedFullStudentAnalysisSnapshot(fixture.contextInput,fixture.v2Ref,poisonRoot,read.readOptions());
    const bank=await loadQuestionBank(contextValue,{...read.bankOptions(),root:poisonRoot,plan:fixture.plan,environment:fixture.environment});
    const review=await loadStagedFullStudentAnalysisSnapshot(fixture.contextInput,fixture.review.child.revisionPath,poisonRoot,read.readOptions());
    const ancestry=await resolveQuestionReviewAuthority(fixture.review.reviewContext,fixture.review.objectiveId,fixture.review.questionSha256,fixture.review.reviewModel,
      poisonRoot,createQuestionReviewAuthorityScope(fixture.review.reviewContext,poisonRoot,read.readOptions()));
    await read.assertSnapshotUnchanged();return {read,source,current,context:contextValue,staged,bank,review,ancestry};
  });
}
const importer=createShadowImporter({repository,objects,objectRepository,identity,roots:{fixture:root},
  async verifyDomain(context,inventory){const value=await readDomain(context as AuthenticatedRequestContext,inventory);return {passed:value.context.errors.length===0&&!!value.current&&!!value.staged&&!!value.bank,diagnostics:value.read.diagnostics()};}});
async function inventory(who:'a'|'b',artifacts=fixture.artifacts){
  const request:ShadowInventoryRequest={version:'shadow-inventory-request-v1',runId:'shadow_'+randomUUID(),binding:'synthetic',ownerId:'owner-'+who,
    studentId:fixture.source.studentId,applicationTargetId:'shadow-app-'+who,supportTargetId:fixture.scope.supportTargetId,
    provenanceOwnerId:fixture.provenanceOwnerId,artifacts,pointers:fixture.pointers};
  const value=await inventoryShadowFiles(request,{fixture:root!});assert.equal(value.eligible,true,JSON.stringify(value.entries.filter(x=>['unsupported','quarantined','missing'].includes(x.classification))));inventories.push(value);return value;
}
const imported=new Map<string,ShadowInventory>();
const progress=async(phase:string)=>{await fs.promises.appendFile(path.join(process.env.PR07D_TEST_OUTPUT??'artifacts/pr07d','execution-progress.jsonl'),JSON.stringify({phase,at:new Date().toISOString(),io})+'\n');};
test.before(async()=>{
  await progress('before-outer-mappings');
  await pools.admin.query('INSERT INTO gakja.target_profiles VALUES($1,$2,$3,$4,$5,2027)',[fixture.scope.supportTargetId,fixture.profileRevision,fixture.publicSchoolIds.universityId,fixture.publicSchoolIds.departmentId,fixture.publicSchoolIds.admissionTrackId]);
  for(const who of ['a','b'] as const){
    await pools.admin.query('INSERT INTO gakja.students VALUES($1,$2,$3,$4)',['owner-'+who,fixture.source.studentId,'Explicit synthetic student',fixture.source.pdfSha256]);
    await pools.admin.query('INSERT INTO gakja.application_targets VALUES($1,$2,$3,$4,$5,$6)',['owner-'+who,fixture.source.studentId,'shadow-app-'+who,fixture.scope.supportTargetId,fixture.profileRevision,'Explicit synthetic outer mapping']);
    await pools.admin.query('INSERT INTO gakja.access_grants(account_id,owner_id,student_id,application_target_id,support_target_id,source_present,source_revision) VALUES($1,$2,$3,$4,$5,false,NULL)',
      ['account-'+who,'owner-'+who,fixture.source.studentId,'shadow-app-'+who,fixture.scope.supportTargetId]);
    contexts.set(who,await selected(who));
  }
  await progress('before-complete');
});
test.after(async()=>{
  observing=false;
  const cleanupErrors:Record<string,unknown>[]=[];
  for(const value of inventories){const context=contexts.get(value.plan.ownerId.slice(-1));if(context)try{
    const result=await importer.cleanup(context,value,capability(context,value));assert.equal(result.complete,true);assert.deepEqual(result.remaining,[]);
    rows.push({caseId:'D-CLEANUP-VERIFIED',runId:value.plan.runId,complete:result.complete,remaining:result.remaining});
  }catch(error){const failure={caseId:'D-CLEANUP',runId:value.plan.runId,error:(error as {code?:string;message?:string}).code??(error as Error).message};rows.push(failure);cleanupErrors.push(failure);}}
  fs.promises.readFile=originalRead;syncBuiltinESMExports();
  const output=path.join(process.env.PR07D_TEST_OUTPUT??'artifacts/pr07d','domain-shadow-cases.json');
  await fs.promises.writeFile(output,JSON.stringify({version:'pr07d-actual-domain-shadow-v1',baselineCommit:baseline.codeCommit,baselineFileReads:baseline.metrics.fixtureFileReads,
    storageEngine:diagnostic?'controlled-memory-diagnostic-NOT-actual-Storage':'official-Supabase-Storage-REST',
    actualStudentDataTransferred:false,fixtureKind:'public synthetic student + Git-public policy/school reference dependencies',rows,io,localAttempts,
    approvedEvaluationCount:0,sessionEvaluationWrites:0,aiProviderCalls:0},null,2)+'\n');await closePools(pools);assert.deepEqual(cleanupErrors,[]);
});

test('D-SHADOW-01 actual C local and D DB/Storage loaders preserve source, v2 analysis, staged QA and ready-bank/audio for A and B',async()=>{
  for(const who of ['a','b'] as const){
    const context=contexts.get(who)!,value=await inventory(who);await progress('import-'+who);await importer.import(context,value,capability(context,value));imported.set(who,value);await progress('read-'+who);
    const observed=await readDomain(context,value);
    assert.deepEqual(json(observed.source),baseline.source.value);
    assert.deepEqual(json(observed.current?.analysis),baseline.current.value.analysis);
    const observedContext=json(observed.context),expectedContext=json(baseline.context.value),volatileDisplays=[];
    if(observedContext.questionStrategies){
      assert.equal(observedContext.questionStrategies.contentSha256,expectedContext.questionStrategies.contentSha256);
      volatileDisplays.push({key:'questionStrategies.generatedAt',baseline:expectedContext.questionStrategies.generatedAt,candidate:observedContext.questionStrategies.generatedAt,
        rule:'existing derived catalog display timestamp is outside the existing catalog hash'});
      observedContext.questionStrategies.generatedAt=expectedContext.questionStrategies.generatedAt;
    }
    assert.deepEqual(observedContext,expectedContext);
    const staged=json(observed.staged?.analysis),expected=json(baseline.staged.value.analysis);
    const displays=[];for(const key of ['revisionPath','manifestPath']){displays.push({key,baseline:expected[key],candidate:staged[key],rule:'display-only-native-separator'});expected[key]=expected[key].replaceAll('\\','/');staged[key]=staged[key].replaceAll('\\','/');}
    assert.deepEqual(staged,expected);assert.deepEqual(json(observed.bank),baseline.bank.value);
    assert.deepEqual(json(observed.review?.analysis.common),baseline.review.value.analysis.common);
    assert.deepEqual(json(observed.review?.analysis.target),baseline.review.value.analysis.target);
    assert.deepEqual(json(observed.ancestry),baseline.ancestry.value);assert.equal(observed.ancestry?.kind,'unchanged_objective_ancestor_review');
    assert.equal(observed.context.errors.length,0);assert.ok(observed.bank);assert.ok(observed.read.diagnostics().objectReads>0);assert.ok(observed.read.diagnostics().mappingReads>0);
    assert.equal(observed.read.diagnostics().localFileReads,0);assert.equal(localAttempts,0);
    await progress('verify-'+who);const verify=await importer.verify(context,value);assert.equal(verify.passed,true);await progress('complete-'+who);
    const rawArtifacts=value.plan.artifacts.filter(a=>a.availability==='present').map(a=>({role:a.role,reference:a.reference,sizeBytes:a.sizeBytes,sha256:a.rawSha256}));
    const diagnostics=observed.read.diagnostics();
    const comparison=compareShadowObservations({caseId:'D-SHADOW-01-'+who,expectation:'equivalent-success'},
      {ok:true,value:baseline.current.value.analysis,availability:'present',rawArtifacts:baseline.rawArtifacts,effects:{privateFileReads:baseline.metrics.fixtureFileReads,databaseReads:0,storageReads:0,writes:baseline.metrics.fixtureFileWrites,aiProviderCalls:0,payloadReturned:true}},
      {ok:true,value:json(observed.current?.analysis),availability:'present',rawArtifacts,effects:{privateFileReads:localAttempts,databaseReads:diagnostics.mappingReads,storageReads:diagnostics.objectReads,writes:0,aiProviderCalls:0,payloadReturned:true}});
    assert.equal(comparison.passed,true,JSON.stringify(comparison.differences));
    rows.push({caseId:'D-SHADOW-01-'+who,baseline:'fulfilled',candidate:'fulfilled',outcome:'equivalent-success',diagnostics:observed.read.diagnostics(),displays,volatileDisplays,bankHash:observed.bank?.contentSha256,
      comparison,counterScope:'aggregate complete domain read (Source/Analysis/context/staged/review/bank)',
      rawDomainHashesDistinct:value.plan.artifacts.filter(a=>a.availability==='present'&&a.domainSha256&&a.rawSha256!==a.domainSha256).map(a=>a.artifactId)});
  }
});

test('D-SHADOW-02 v1 staged historical refusal matches the existing C caller without upgrading its payload',async()=>{
  const context=contexts.get('a')!,value=imported.get('a')!,read=await createShadowReadRepositories({context,runId:value.plan.runId,repository,objects,environment:'isolated-shadow'});
  assert.equal(baseline.historical.status,'rejected');
  await noLocal(()=>assert.rejects(loadStagedFullStudentAnalysisSnapshot(fixture.contextInput,fixture.v1Ref,poisonRoot,{...read.readOptions(),purpose:'historical-revision'}),error=>
    (error as Error).message===baseline.historical.message));
  const historicalV2=await noLocal(()=>loadStagedFullStudentAnalysisSnapshot(fixture.contextInput,fixture.v2Ref,poisonRoot,{...read.readOptions(),purpose:'historical-revision'}));
  assert.deepEqual(json(historicalV2?.analysis.common),baseline.historicalV2.value.analysis.common);
  assert.deepEqual(json(historicalV2?.analysis.target),baseline.historicalV2.value.analysis.target);
  rows.push({caseId:'D-SHADOW-02',outcome:'equivalent-domain-refusal-for-v1-and-success-for-v2',baseline:baseline.historical.message,candidate:baseline.historical.message,payloadReturned:false,explicitHistoricalSelector:true});
});

test('D-SHADOW-03 retry reuses original immutable receipts and pointer pins',async()=>{
  const context=contexts.get('a')!,value=imported.get('a')!,before=await repository.capture(context,value.plan.runId),uploads=io.upload,copies=io.copy;
  const retried=await importer.import(context,value,capability(context,value));assert.equal(io.upload,uploads);assert.equal(io.copy,copies);
  assert.equal(retried.snapshot.generation,before!.generation);assert.deepEqual(retried.snapshot.pointers,before!.pointers);
  rows.push({caseId:'D-SHADOW-03',outcome:'immutable-idempotent-reuse',newUploads:io.upload-uploads,newCopies:io.copy-copies});
});

test('D-SHADOW-04 B cannot read A shadow or object despite identical local IDs, bytes and provenance',async()=>{
  const a=contexts.get('a')!,b=contexts.get('b')!,value=imported.get('a')!,snapshot=await repository.capture(a,value.plan.runId);
  assert.equal(await repository.capture(b,value.plan.runId),null);
  await assert.rejects(createShadowReadRepositories({context:b,runId:value.plan.runId,repository,objects,environment:'isolated-shadow'}));
  const bound=snapshot!.artifacts.find(x=>x.availability==='present'&&x.status==='bound')!;
  await assert.rejects(objects.read(b,{objectId:bound.objectId!,scope:bound.scope.kind}));
  rows.push({caseId:'D-SHADOW-04',outcome:'authority-refusal',payloadReturned:false});
});

test('D-SHADOW-05 explicit optional absence is observable and provider failures stay failures',async()=>{
  const context=contexts.get('a')!,value=imported.get('a')!,read=await createShadowReadRepositories({context,runId:value.plan.runId,repository,objects,environment:'isolated-shadow'});
  assert.equal(await read.bankReader.readPartial({scope:{...read.readOptions().scope,bankKey:fixture.bankKey} as never,purpose:'current'}),null);
  assert.ok(read.diagnostics().confirmedAbsentReads>0);readFault=true;
  try{await noLocal(()=>assert.rejects(loadFullRecord(poisonRoot,fixture.source.pdfSha256,read.readOptions())));}finally{readFault=false;}
  rows.push({caseId:'D-SHADOW-05',absence:'planned-known-absent',providerFailure:'refused-not-null',payloadReturned:false});
});

test('D-SHADOW-06 a captured reader refuses cancellation and never silently selects a newer snapshot',async()=>{
  const context=contexts.get('b')!,value=imported.get('b')!,read=await createShadowReadRepositories({context,runId:value.plan.runId,repository,objects,environment:'isolated-shadow'});
  await repository.cancel(context,value.plan.runId,capability(context,value));
  await noLocal(()=>assert.rejects(loadFullRecord(poisonRoot,fixture.source.pdfSha256,read.readOptions()),error=>(error as {code?:string}).code==='SHADOW_SNAPSHOT_CHANGED'));
  rows.push({caseId:'D-SHADOW-06',outcome:'snapshot-refusal',payloadReturned:false});
});

test('D-SHADOW-07 raw source mutation is quarantined before any upload or pointer publication',async()=>{
  // This fault changes only a new test-owned copy. The immutable C baseline
  // input, original private files and active local pointers remain untouched.
  const faultRoot=path.join(process.env.PR07D_TEST_OUTPUT??'artifacts/pr07d','fault-'+randomUUID());await fs.promises.mkdir(faultRoot,{recursive:true});
  const original=await fs.promises.readFile(path.join(root!,fixture.sourceRef)),file=path.join(faultRoot,'source.json');await fs.promises.writeFile(file,original);
  const request:ShadowInventoryRequest={version:'shadow-inventory-request-v1',runId:'shadow_'+randomUUID(),binding:'synthetic',ownerId:'owner-a',studentId:fixture.source.studentId,
    applicationTargetId:'shadow-app-a',supportTargetId:fixture.scope.supportTargetId,provenanceOwnerId:fixture.provenanceOwnerId,
    artifacts:fixture.artifacts.map((a:ShadowInventoryRequest['artifacts'][number])=>a.artifactId==='source'?{...a,source:{rootId:'fault',relativePath:'source.json'}}:a),pointers:fixture.pointers};
  const value=await inventoryShadowFiles(request,{fixture:root!,fault:faultRoot}),context=contexts.get('a')!,source=value.plan.artifacts.find(a=>a.artifactId==='source')!;inventories.push(value);
  assert.equal(value.eligible,true);assert.equal(source.availability,'present');const uploads=io.upload;
  const faultImporter=createShadowImporter({repository,objects,objectRepository,identity,roots:{fixture:root!,fault:faultRoot}});
  await fs.promises.writeFile(file,Buffer.concat([original,Buffer.from(' ')]));await assert.rejects(faultImporter.import(context,value,capability(context,value)),error=>(error as {code?:string}).code==='SHADOW_SOURCE_CHANGED');
  const snapshot=await repository.capture(context,value.plan.runId);assert.equal(snapshot!.pointers.length,0);
  // Earlier dependency artifacts can already be safely copied; the changed
  // artifact itself must never become bound or publish a pointer.
  assert.equal(snapshot!.artifacts.find(a=>a.artifactId==='source')!.status,'quarantined');
  rows.push({caseId:'D-SHADOW-07',outcome:'source-changed-refusal',earlierDependencyUploads:io.upload-uploads,pointersPublished:0,rawSha256:source.availability==='present'?source.rawSha256:null,unchangedBaselineSha256:sha(await fs.promises.readFile(path.join(root!,fixture.sourceRef)))});
});

test('D-SHADOW-08 normal legacy v1 current selection preserves the original codec and IDs',async()=>{
  const context=contexts.get('a')!,ids=['input-studentPdf','source','source-pointer','analysis-v1','analysis-pointer'];
  const request:ShadowInventoryRequest={version:'shadow-inventory-request-v1',runId:'shadow_'+randomUUID(),binding:'synthetic',ownerId:'owner-a',studentId:fixture.source.studentId,
    applicationTargetId:'shadow-app-a',supportTargetId:fixture.scope.supportTargetId,provenanceOwnerId:fixture.provenanceOwnerId,pointers:fixture.pointers,
    artifacts:fixture.artifacts.filter((a:{artifactId:string})=>ids.includes(a.artifactId)).map((a:ShadowInventoryRequest['artifacts'][number])=>a.artifactId==='analysis-pointer'?
      {...a,source:{rootId:'historical',relativePath:'data/prepared/student-analysis-current.json'},dependencies:[{artifactId:'analysis-v1',required:true}]}:a)};
  const roots={fixture:root!,historical:fixture.historicalCurrentRoot};
  const value=await inventoryShadowFiles(request,roots);assert.equal(value.eligible,true);inventories.push(value);
  const legacyImporter=createShadowImporter({repository,objects,objectRepository,identity,roots});await legacyImporter.import(context,value,capability(context,value));
  const read=await createShadowReadRepositories({context,runId:value.plan.runId,repository,objects,environment:'isolated-shadow'});
  const observed=await noLocal(()=>loadFullStudentAnalysisSnapshot(fixture.contextInput,poisonRoot,read.readOptions()));
  assert.equal(baseline.legacyCurrent.status,'fulfilled');assert.deepEqual(json(observed?.analysis),baseline.legacyCurrent.value.analysis);
  rows.push({caseId:'D-SHADOW-08',outcome:'equivalent-success',originalSchemaVersion:observed?.analysis.common.schemaVersion,diagnostics:read.diagnostics(),payloadRewritten:false});
});

test('D-SHADOW-09 dependency fault copies expose exact C outcomes and stricter D integrity refusals',async()=>{
  const codeRoot=process.env.PR07D_TEST_BASELINE_CODE_ROOT;if(!codeRoot)throw new Error('PR07D_BASELINE_CODE_ROOT_REQUIRED');
  const faults=await baselineDependencyFaults({codeRoot,fixtureRoot:root!,driver:path.resolve('tests/shadow/c-baseline-driver.mjs'),output:path.resolve(process.env.PR07D_TEST_OUTPUT!)});
  const context=contexts.get('a')!,value=imported.get('a')!,snapshot=await repository.capture(context,value.plan.runId);
  for(const fault of faults){
    const row=snapshot!.artifacts.find(a=>a.artifactId===fault.artifactId);assert.ok(row?.object);
    const read=await createShadowReadRepositories({context,runId:value.plan.runId,repository,objects,environment:'isolated-shadow'}),before=io.read;
    dependencyFault={key:row.object.ref.key,bytes:fault.bytes};let candidateCode:string|undefined;
    try{
      await noLocal(()=>assert.rejects((async()=>{
        if(fault.resultKey==='staged')return loadStagedFullStudentAnalysisSnapshot(fixture.contextInput,fixture.v2Ref,poisonRoot,read.readOptions());
        if(fault.resultKey==='review')return loadStagedFullStudentAnalysisSnapshot(fixture.contextInput,fixture.review.child.revisionPath,poisonRoot,read.readOptions());
        if(fault.resultKey==='ancestry')return resolveQuestionReviewAuthority(fixture.review.reviewContext,fixture.review.objectiveId,fixture.review.questionSha256,fixture.review.reviewModel,
          poisonRoot,createQuestionReviewAuthorityScope(fixture.review.reviewContext,poisonRoot,read.readOptions()));
        return loadInterviewContextAt(poisonRoot,{...read.readOptions(),writeManifest:false});
      })(),error=>{candidateCode=(error as {code?:string}).code;return candidateCode==='OBJECT_INTEGRITY_FAILED';}));
    }finally{dependencyFault=undefined;}
    assert.ok(io.read>before);
    rows.push({caseId:fault.caseId,artifactId:fault.artifactId,baseline:fault.baseline,candidate:{errorCode:candidateCode,payloadReturned:false,actualProviderReads:io.read-before,localFileReads:0},
      outcome:'stricter-storage-integrity-refusal',equivalence:'not-applicable',fault:'test wrapper changes bytes after an actual provider read; C reads a separate new fault-copy',
      originalSha256:fault.originalSha256,faultSha256:fault.faultSha256});
  }
});

test('D-SHADOW-10 actual copy response loss and committed binding interruption resume the same immutable objects',async()=>{
  const ids=['input-studentPdf','source','source-pointer','analysis-v2','analysis-pointer'];
  const value=await inventory('a',fixture.artifacts.filter((a:{artifactId:string})=>ids.includes(a.artifactId))),context=contexts.get('a')!;
  let interrupt=true;const uploads=io.upload,copies=io.copy;
  const interrupted=createShadowImporter({repository:{...repository,async bindObject(...args:Parameters<typeof repository.bindObject>){
    const result=await repository.bindObject(...args);if(interrupt){interrupt=false;throw new Error('CONTROLLED_COMMITTED_BIND_RESPONSE_LOST');}return result;
  }},objects,objectRepository,identity,roots:{fixture:root!}});
  copyFault=true;
  await assert.rejects(interrupted.import(context,value,capability(context,value)),/CONTROLLED_COMMITTED_BIND_RESPONSE_LOST/u);
  assert.equal(copyFault,false);const partial=await repository.capture(context,value.plan.runId);
  assert.equal(partial!.artifacts.filter(a=>a.status==='bound').length,1);assert.equal(partial!.pointers.length,0);
  const first=partial!.artifacts.find(a=>a.status==='bound')!,resumed=await importer.import(context,value,capability(context,value));
  assert.ok(resumed.results.some(row=>row.artifactId===first.artifactId&&row.status==='reused'));
  assert.equal(resumed.snapshot.artifacts.find(a=>a.artifactId===first.artifactId)!.objectId,first.objectId);
  assert.equal(io.upload-uploads,ids.length);assert.equal(io.copy-copies,ids.length);
  const read=await createShadowReadRepositories({context,runId:value.plan.runId,repository,objects,environment:'isolated-shadow'});
  const current=await noLocal(()=>loadFullStudentAnalysisSnapshot(fixture.contextInput,poisonRoot,read.readOptions()));
  assert.deepEqual(json(current?.analysis),baseline.current.value.analysis);
  rows.push({caseId:'D-SHADOW-10',outcome:'partial-resume-with-immutable-reuse',copyResponseLostAfterActualCopy:true,committedBindResponseLost:true,
    firstObjectPreserved:true,uploads:io.upload-uploads,copies:io.copy-copies,originalPointerWrites:0,diagnostics:read.diagnostics()});
});
