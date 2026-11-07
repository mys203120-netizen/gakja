import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { analysisDomainFixture } from '../fixtures/analysis-domain';
import { analysisQAManifest, loadFullRecord, loadFullStudentAnalysisSnapshot, loadStagedFullStudentAnalysisSnapshot } from '../../server/data/full-student-analysis';
import { createRequestIdentityBoundary } from '../../server/auth/request-identity';
import { createShadowReadRepositories, ShadowReadError } from '../../server/repositories/shadow-read-repositories';
import type { ShadowArtifactBinding, ShadowArtifactRecord, ShadowSnapshot } from '../../server/shadow/shadow-ports';
import { emptyReadScope } from '../../server/repositories/analysis-read-ports';

const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
/** Explicit mapping/object mocks. Domain loaders/codecs/QA are the real callers;
 * real PostgreSQL + official Storage independent comparisons run separately. */
async function fixture(options:{missingDependency?:boolean;absentPointer?:boolean;unboundAnalysis?:boolean;historicalAlias?:boolean}={}){
  const f=analysisDomainFixture(),ownerId='auth-owner',studentId=f.source.studentId,supportTargetId=f.v2.target.supportTargetId;
  const identity=createRequestIdentityBoundary({mode:'service',environment:'test',
    verifier:{kind:'trusted-jwt',async verify(){return{issuer:'https://shadow.example',subject:'test',expiresAt:Date.now()+60_000};}},
    accounts:{kind:'synthetic',async resolve(){return{accountId:'test-account',ownerId,revision:'1',grants:[{studentId,applicationTargetId:'app-a',supportTargetId}]};}}});
  const context=identity.selectScope(await identity.authenticate('Bearer synthetic-test-input'),{applicationTargetId:'app-a'});
  const artifactRecords:ShadowArtifactRecord[]=[],objects=new Map<string,Buffer>();let generation='1',objectCalls=0;
  let afterRead:(()=>void)|undefined;
  const snapshot:ShadowSnapshot={runId:'reader-unit',planSha256:hash('plan'),binding:'synthetic',ownerId,studentId,applicationTargetId:'app-a',supportTargetId,
    provenanceOwnerId:'local-development-owner',state:'open',generation,snapshotToken:generation,artifacts:artifactRecords,pointers:[]};
  const add=(role:string,reference:string,selection:ShadowArtifactRecord['selection'],value:unknown,aliases:ShadowArtifactRecord['aliases']=[])=>{
    const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value,null,2)+'\r\n'),artifactId=hash(role+reference),objectId=hash('object'+role+reference);
    const record:ShadowArtifactBinding={runId:snapshot.runId,artifactId,locatorId:hash('locator'+artifactId),role,reference,selection,scope:{kind:'common',ownerId,studentId},
      availability:'present',required:true,dependencies:[],aliases,status:'bound',generation:'1',snapshotToken:'1',objectKind:'source-json',sizeBytes:bytes.length,rawSha256:hash(bytes),
      receiptId:hash('receipt'+objectId),objectId,objectRevision:'1',object:{receiptId:hash('receipt'+objectId),objectId,scope:{kind:'common',ownerId,studentId},
        kind:'source-json',revision:'1',ref:{bucket:'synthetic',key:'verified/'+objectId},sizeBytes:bytes.length,contentSha256:hash(bytes)}};
    artifactRecords.push(record);objects.set(objectId,bytes);return record;
  };
  const sourcePath='data/prepared/record-revisions/unit/source.json',analysisPath='data/prepared/student-analysis-revisions/unit/analysis.json';
  const sourcePointer=add('full-record-pointer','data/prepared/full-record-current.json','current',{path:sourcePath,pdfSha256:f.source.pdfSha256,contentSha256:f.source.contentSha256});
  add('full-record-document',sourcePath,'current',f.source);
  const analysisPointer=add('analysis-pointer','data/prepared/student-analysis-current.json','current',{path:analysisPath,revision:f.v2.common.revision,sourceContentSha256:f.source.contentSha256});
  snapshot.pointers=[{name:'full-record-pointer',selection:'current',artifactId:sourcePointer.artifactId,generation:'1'},
    {name:'analysis-pointer',selection:'current',artifactId:analysisPointer.artifactId,generation:'1'}];
  const payload={...f.v2,sourceRevision:f.source.revision,sourceContentSha256:f.source.contentSha256};
  const analysis=add('analysis-document',analysisPath,'current',payload,[{role:'analysis-document',reference:analysisPath,selection:'staged'},
    ...(options.historicalAlias?[{role:'analysis-document',reference:analysisPath,selection:'historical' as const}]:[])]);
  if(options.missingDependency)analysis.dependencies=[{artifactId:hash('not-in-plan'),required:true}];
  if(options.unboundAnalysis)artifactRecords[artifactRecords.indexOf(analysis)]={...analysis,status:'planned'};
  add('analysis-qa',path.join(path.dirname(analysisPath),'analysis-qa.json'),'dependency',analysisQAManifest(payload,f.source,null));
  if(options.absentPointer){
    const index=artifactRecords.findIndex(record=>record.artifactId===analysisPointer.artifactId);
    artifactRecords[index]={runId:snapshot.runId,artifactId:analysisPointer.artifactId,locatorId:analysisPointer.locatorId,
      role:'analysis-pointer',reference:analysisPointer.reference,selection:'current',scope:{kind:'common',ownerId,studentId},
      availability:'absent',required:false,absenceReason:'known-absent',dependencies:[],status:'absent',generation:'1',snapshotToken:'1'};
    snapshot.pointers=snapshot.pointers.filter(pointer=>pointer.name!=='analysis-pointer');
  }
  const read=await createShadowReadRepositories({context,runId:snapshot.runId,environment:'isolated-shadow',
    repository:{async capture(){return structuredClone({...snapshot,generation,snapshotToken:generation});},
      async resolve(_context,_run,selector){return artifactRecords.find(record=>record.availability==='present'&&record.status==='bound'&&
        [{role:record.role,reference:record.reference,selection:record.selection},...(record.aliases??[])].some(alias=>alias.role===selector.role&&
          (selector.reference===undefined||alias.reference===selector.reference)&&(selector.selection===undefined||alias.selection===selector.selection))) as ShadowArtifactBinding|undefined??null;},
      async unchanged(_context,_run,captured){return generation===captured;}},
    objects:{async read(_context,selector){objectCalls++;const bytes=objects.get(selector.objectId);if(!bytes)throw new Error('UNEXPECTED_OBJECT');afterRead?.();return Buffer.from(bytes);}}});
  return{f,read,context,sourcePath,analysisPath,analysis,objects,artifactRecords,add,objectCalls:()=>objectCalls,setGeneration:(v:string)=>{generation=v;},setAfterRead:(fn:()=>void)=>{afterRead=fn;}};
}
const code=(expected:ShadowReadError['code'])=>(error:unknown)=>error instanceof ShadowReadError&&error.code===expected;

test('unit a changed missing/null mapping pin cannot be substituted within the captured generation',async()=>{
  const f=await fixture();
  f.analysis.versionId=null;
  await assert.rejects(f.read.repositories.analysis.readAnalysis({scope:emptyReadScope(f.read.repositories.ownerId),
    purpose:'analysis-validation',reference:f.analysisPath,selection:'current'}),code('SHADOW_OBJECT_BINDING_CHANGED'));
  assert.equal(f.objectCalls(),0);
});

test('unit historical purpose requires its explicitly planned historical selector',async()=>{
  const stagedOnly=await fixture();
  await assert.rejects(loadStagedFullStudentAnalysisSnapshot(stagedOnly.f.context,stagedOnly.analysisPath,'Z:/not-a-local-fixture',
    {...stagedOnly.read.readOptions(),purpose:'historical-revision'}),code('SHADOW_ARTIFACT_NOT_PLANNED'));
  const historical=await fixture({historicalAlias:true});
  const result=await loadStagedFullStudentAnalysisSnapshot(historical.f.context,historical.analysisPath,'Z:/not-a-local-fixture',
    {...historical.read.readOptions(),purpose:'historical-revision'});
  assert.deepEqual(result.analysis.common,historical.f.v2.common);
});

test('unit shadow typed locator reaches the actual source/current/staged analysis gates without a local path',async()=>{
  const h=await fixture(),options=h.read.readOptions();
  assert.deepEqual(await loadFullRecord('ROOT_MUST_NOT_BE_READ',h.f.source.pdfSha256,options),h.f.source);
  const current=await loadFullStudentAnalysisSnapshot(h.f.context,'ROOT_MUST_NOT_BE_READ',options);assert.ok(current);
  assert.deepEqual(current.analysis,h.f.v2);assert.equal('path' in current.document,false);assert.equal(current.document.provenancePath,h.analysisPath);
  const staged=await loadStagedFullStudentAnalysisSnapshot(h.f.context,h.analysisPath,'ROOT_MUST_NOT_BE_READ',options);
  assert.deepEqual(staged.analysis.common,h.f.v2.common);assert.equal(h.read.diagnostics().localFileReads,0);assert.ok(h.objectCalls()>0);
});

test('unit a mapping generation ABA observed after object IO rejects the private result',async()=>{
  const h=await fixture();h.setAfterRead(()=>h.setGeneration('3'));
  await assert.rejects(loadFullRecord('UNUSED',h.f.source.pdfSha256,h.read.readOptions()),code('SHADOW_SNAPSHOT_CHANGED'));
});

test('unit corrupted bytes and required missing dependencies fail before domain promotion',async()=>{
  const h=await fixture();h.objects.set(h.analysis.objectId,Buffer.from('{}'));
  await assert.rejects(loadFullStudentAnalysisSnapshot(h.f.context,'UNUSED',h.read.readOptions()),code('SHADOW_OBJECT_BINDING_CHANGED'));
  const j=await fixture({missingDependency:true});
  await assert.rejects(loadFullStudentAnalysisSnapshot(j.f.context,'UNUSED',j.read.readOptions()),code('SHADOW_DEPENDENCY_UNAVAILABLE'));
});

test('unit wrong student selection is refused before object IO and the reader has no writer methods',async()=>{
  const h=await fixture();
  await assert.rejects(h.read.repositories.source.readCurrentRecord({scope:{...emptyReadScope(h.read.repositories.ownerId),studentId:'other-student'},purpose:'runtime-context'}),code('SHADOW_SCOPE_MISMATCH'));
  assert.equal(h.objectCalls(),0);assert.equal('publishReady' in h.read.bankReader,false);assert.equal('publish' in h.read.audioReader,false);
});

test('unit only an explicit known-absent plan entry returns null; an unplanned optional lookup is not empty data',async()=>{
  const h=await fixture({absentPointer:true}),request={scope:emptyReadScope(h.read.repositories.ownerId),purpose:'runtime-context' as const};
  assert.equal(await h.read.repositories.analysis.readCurrentPointer(request),null);assert.equal(h.objectCalls(),0);
  await assert.rejects(h.read.repositories.artifacts!.read({...request,role:'not-planned',reference:'unknown',optional:true}),code('SHADOW_ARTIFACT_NOT_PLANNED'));
});

test('unit a planned but unbound object fails without fetching another object or a local fallback',async()=>{
  const h=await fixture({unboundAnalysis:true});
  await assert.rejects(h.read.repositories.analysis.readAnalysis({scope:emptyReadScope(h.read.repositories.ownerId),purpose:'runtime-context',selection:'current',reference:h.analysisPath}),code('SHADOW_ARTIFACT_UNAVAILABLE'));
  assert.equal(h.objectCalls(),0);assert.equal(h.read.diagnostics().localFileReads,0);
});
