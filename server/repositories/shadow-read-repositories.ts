import { createHash } from 'node:crypto';
import path from 'node:path';
import { interviewConfig } from '../../interview.config';
import type { RequestContext } from '../auth/request-identity';
import type { PrivateObjectService } from '../storage/private-object-service';
import type { ShadowArtifactRecord, ShadowRepository, ShadowSelector, ShadowSnapshot } from '../shadow/shadow-ports';
import { assertReadOwner, emptyReadScope, storedProvenance, type AnalysisPayload, type AnalysisPointer, type ConfiguredSourceRead,
  type FullRecordPointer, type ReadRepositories, type ReadScope, type LocatedStoredFile as StoredFile, type LocatedStoredJson as StoredJson } from './analysis-read-ports';
import type { FullRecordSource, AnalysisQAManifest } from '../data/full-student-analysis';
import type { QuestionBankReader } from './question-bank-ports';
import type { AudioReader } from './audio-ports';
import type { PreparedQuestionBank, QuestionBankPartial, BankOptions } from '../data/prepared-question-bank';

export class ShadowReadError extends Error {
  constructor(readonly code: 'SHADOW_ARTIFACT_NOT_PLANNED'|'SHADOW_ARTIFACT_UNAVAILABLE'|'SHADOW_DEPENDENCY_UNAVAILABLE'|
    'SHADOW_SNAPSHOT_CHANGED'|'SHADOW_OBJECT_BINDING_CHANGED'|'SHADOW_SCOPE_MISMATCH'|'SHADOW_READ_ONLY_REQUIRED') {
    super(code);this.name='ShadowReadError';
  }
}
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const matches=(record:ShadowArtifactRecord,query:ShadowSelector)=>
  [{role:record.role,reference:record.reference,selection:record.selection},...(record.aliases??[])].some(selector=>
    selector.role===query.role && (query.reference===undefined || selector.reference===query.reference) &&
    (query.selection===undefined || selector.selection===query.selection));
const pin=(binding:ShadowArtifactRecord)=>JSON.stringify([binding.runId,binding.artifactId,binding.locatorId,binding.role,binding.reference,binding.selection,
  binding.availability,binding.status,binding.required,
  binding.scope,Object.hasOwn(binding,'sourceRevision'),binding.sourceRevision,Object.hasOwn(binding,'domainSha256'),binding.domainSha256,
  Object.hasOwn(binding,'versionId'),binding.versionId,Object.hasOwn(binding,'legacyId'),binding.legacyId,
  Object.hasOwn(binding,'originalPin'),binding.originalPin,binding.rawSha256,binding.sizeBytes,binding.receiptId,binding.objectId,binding.objectRevision,
  binding.object,Object.hasOwn(binding,'mediaType'),binding.mediaType,binding.generation,binding.snapshotToken,binding.dependencies,binding.aliases]);

/** An isolated shadow composition only. The domain/local provenance owner is
 * kept intact, while the closed A context supplies actual DB/object authority.
 * No reference in this adapter is passed to filesystem or URL IO. */
export async function createShadowReadRepositories(options:{
  context:RequestContext;runId:string;repository:Pick<ShadowRepository,'capture'|'resolve'|'unchanged'>;objects:Pick<PrivateObjectService,'read'>;
  environment:'isolated-shadow';
}) {
  if(options.environment!=='isolated-shadow'||process.env.NODE_ENV==='production')throw new ShadowReadError('SHADOW_READ_ONLY_REQUIRED');
  const {context,runId,repository,objects}=options;
  const captured=await repository.capture(context,runId);
  if(!captured||captured.state!=='open'||context.mode!=='authenticated'||!context.scope||captured.ownerId!==context.account.ownerId||
    captured.studentId!==context.scope.studentId||captured.applicationTargetId!==context.scope.applicationTargetId||captured.supportTargetId!==context.scope.supportTargetId)throw new ShadowReadError('SHADOW_SCOPE_MISMATCH');
  const snapshot:ShadowSnapshot=structuredClone(captured),ownerId=snapshot.provenanceOwnerId??snapshot.ownerId;
  const counters={mappingReads:0,objectReads:0,objectBytes:0,confirmedAbsentReads:0,snapshotChecks:0,localFileReads:0};
  const byId=new Map(snapshot.artifacts.map(row=>[row.artifactId,row]));
  function scope(request:{scope:ReadScope}){
    assertReadOwner(repositories,request.scope);
    if(request.scope.studentId!==null&&request.scope.studentId!==snapshot.studentId ||
      request.scope.supportTargetId!==null&&request.scope.supportTargetId!==snapshot.supportTargetId)throw new ShadowReadError('SHADOW_SCOPE_MISMATCH');
  }
  function planned(query:ShadowSelector):ShadowArtifactRecord {
    if(query.reference===undefined){
      const pointers=snapshot.pointers.filter(pointer=>pointer.name===query.role&&pointer.selection===query.selection);
      if(pointers.length===1){const row=byId.get(pointers[0].artifactId);if(row&&matches(row,query))return row;}
      const absent=snapshot.artifacts.filter(row=>row.availability==='absent'&&matches(row,query));
      if(absent.length===1)return absent[0];
      throw new ShadowReadError('SHADOW_ARTIFACT_UNAVAILABLE');
    }
    const rows=snapshot.artifacts.filter(row=>matches(row,query));
    if(rows.length!==1)throw new ShadowReadError('SHADOW_ARTIFACT_NOT_PLANNED');
    return rows[0];
  }
  function checkDependencies(record:ShadowArtifactRecord,visited=new Set<string>()) {
    if(visited.has(record.artifactId))return;visited.add(record.artifactId);
    for(const dependency of record.dependencies){
      const row=byId.get(dependency.artifactId);
      if(!row || dependency.required&&(row.availability!=='present'||row.status!=='bound'||!row.objectId))throw new ShadowReadError('SHADOW_DEPENDENCY_UNAVAILABLE');
      if(dependency.required&&row)checkDependencies(row,visited);
    }
  }
  async function assertSnapshotUnchanged(){
    counters.snapshotChecks++;
    if(!await repository.unchanged(context,runId,snapshot.generation))throw new ShadowReadError('SHADOW_SNAPSHOT_CHANGED');
  }
  async function read(query:ShadowSelector):Promise<StoredFile|null>{
    await assertSnapshotUnchanged();
    const expected=planned(query);checkDependencies(expected);
    if(expected.availability==='absent'){
      if(expected.status!=='absent'||expected.absenceReason!=='known-absent'||expected.required)throw new ShadowReadError('SHADOW_ARTIFACT_UNAVAILABLE');
      counters.confirmedAbsentReads++;await assertSnapshotUnchanged();return null;
    }
    counters.mappingReads++;
    const resolved=await repository.resolve(context,runId,query);
    if(!resolved||resolved.artifactId!==expected.artifactId||resolved.status!=='bound'||resolved.snapshotToken!==snapshot.snapshotToken||resolved.generation!==snapshot.generation)throw new ShadowReadError('SHADOW_ARTIFACT_UNAVAILABLE');
    const before=structuredClone(resolved);
    if(pin(before)!==pin(expected))throw new ShadowReadError('SHADOW_OBJECT_BINDING_CHANGED');
    if(before.scope.ownerId!==snapshot.ownerId||before.scope.studentId!==snapshot.studentId||
      before.scope.kind==='target'&&(before.scope.applicationTargetId!==snapshot.applicationTargetId||before.scope.supportTargetId!==snapshot.supportTargetId))throw new ShadowReadError('SHADOW_SCOPE_MISMATCH');
    const bytes=await objects.read(context,{objectId:before.objectId,scope:before.scope.kind});counters.objectReads++;counters.objectBytes+=bytes.length;
    if(bytes.length!==before.sizeBytes||sha(bytes)!==before.rawSha256)throw new ShadowReadError('SHADOW_OBJECT_BINDING_CHANGED');
    counters.mappingReads++;
    const after=await repository.resolve(context,runId,query);
    if(!after||pin(before)!==pin(after))throw new ShadowReadError('SHADOW_OBJECT_BINDING_CHANGED');
    await assertSnapshotUnchanged();
    return {provenancePath:before.reference,locator:{kind:'verified-shadow-object',runId,artifactId:before.artifactId,objectId:before.objectId,snapshotToken:snapshot.snapshotToken},bytes:Buffer.from(bytes),sha256:before.rawSha256};
  }
  const required=async(query:ShadowSelector)=>{
    const value=await read(query);if(!value)throw Object.assign(new Error('SHADOW_CONFIRMED_ABSENT'),{code:'ENOENT'});return value;
  };
  const json=async<T>(query:ShadowSelector):Promise<StoredJson<T>>=>{const file=await required(query);return {...file,value:JSON.parse(file.bytes.toString('utf8')) as T};};
  const jsonMaybe=async<T>(query:ShadowSelector):Promise<StoredJson<T>|null>=>{const file=await read(query);return file?{...file,value:JSON.parse(file.bytes.toString('utf8')) as T}:null;};
  const repositories:ReadRepositories={ownerId,kind:'shadow',assertSnapshotUnchanged,
    artifacts:{async read(request){scope(request);return read({role:request.role,reference:request.reference,selection:'dependency'});}},
    source:{
      async readConfiguredInputs(request){scope(request);const inputs:ConfiguredSourceRead['inputs']=[],missing:ConfiguredSourceRead['missing']=[];
        for(const [role,reference]of Object.entries(interviewConfig.files).filter(([role])=>role!=='sourceManifest')){
          const file=await read({role:'configured-input:'+role,reference,selection:'configured'});
          if(file)inputs.push({role,path:reference,bytes:file.bytes,sha256:file.sha256});
          else{missing.push({role,path:reference});inputs.push({role,path:reference,bytes:null,sha256:null,readError:Object.assign(new Error('SHADOW_CONFIRMED_ABSENT'),{code:'ENOENT'})});}
        }
        return {inputs,missing};
      },
      async readPinnedInput(request){scope(request);const file=await required({role:'configured-input:'+request.pin.role,reference:request.pin.path,selection:'configured'});
        if(request.pin.sha256!==null&&file.sha256!==request.pin.sha256)throw new ShadowReadError('SHADOW_OBJECT_BINDING_CHANGED');return file;},
      async readCurrentRecord(request){scope(request);const pointer=await jsonMaybe<FullRecordPointer>({role:'full-record-pointer',selection:'current'});
        return pointer?{pointer,document:await json<FullRecordSource>({role:'full-record-document',reference:pointer.value.path,selection:'current'})}:null;},
    },
    analysis:{
      async readCurrentPointer(request){scope(request);return jsonMaybe<AnalysisPointer>({role:'analysis-pointer',selection:'current'});},
      async readAnalysis(request){scope(request);return json<AnalysisPayload>({role:'analysis-document',reference:request.reference,
        selection:request.purpose==='historical-revision'?'historical':request.selection});},
      async readQaManifest(request){scope(request);return json<AnalysisQAManifest>({role:'analysis-qa',reference:path.join(path.dirname(request.analysisReference),'analysis-qa.json'),selection:'dependency'});},
      async readReviewFile(request){scope(request);return required({role:'review:'+request.kind,reference:request.reference,selection:'dependency'});},
      async currentPointerUnchanged(request){scope(request);const current=await read({role:'analysis-pointer',selection:'current'});return !!current&&current.bytes.equals(request.captured.bytes);},
      async analysisDocumentUnchanged(request){scope(request);const current=await read({role:'analysis-document',reference:storedProvenance(request.captured)});return !!current&&current.bytes.equals(request.captured.bytes);},
    },
  };
  const bankReader:QuestionBankReader={ownerId,
    async readReady(request){scope(request);const value=await jsonMaybe<PreparedQuestionBank>({role:'bank-ready',reference:`data/prepared/question-banks/${request.scope.bankKey}.json`,selection:request.purpose==='pinned'?'pinned':'current'});return value?.value??null;},
    async readPartial(request){scope(request);const value=await jsonMaybe<QuestionBankPartial|PreparedQuestionBank>({role:'bank-partial',reference:`data/prepared/question-banks/${request.scope.bankKey}.partial.json`,selection:'dependency'});return value?.value??null;},
  };
  const audioReader:AudioReader={ownerId,async read(request){scope(request);return (await required({role:'audio',reference:request.id,selection:'dependency'})).bytes;}};
  return {repositories,bankReader,audioReader,snapshot:structuredClone(snapshot),
    readOptions:(extra:Partial<ReadScope>={})=>({repositories,scope:{...emptyReadScope(ownerId),...extra}}),
    bankOptions:(extra:Partial<ReadScope>={}):BankOptions=>({readOnly:{bank:bankReader,audio:audioReader},readOptions:{repositories,scope:{...emptyReadScope(ownerId),...extra}}}),
    assertSnapshotUnchanged,diagnostics:()=>({...counters}),
  };
}
