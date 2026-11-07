import { createHash,randomUUID } from 'node:crypto';
import { lstat,readFile,realpath,stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { privateObjectKinds,type PrivateObjectKind } from '../storage/private-object-ports';
import { inspectAudioFormat,inspectImageFormat } from '../storage/media-format';
import { validatePdfStructure } from '../storage/pdf-structure';
import type { ShadowArtifactIdentity,ShadowArtifactPlan,ShadowPointerPlan,ShadowRunPlan } from './shadow-ports';

export class ShadowPlanError extends Error {
  constructor(readonly code:'SHADOW_PLAN_INVALID'|'SHADOW_SOURCE_OUTSIDE_ROOT'|'SHADOW_SOURCE_CHANGED'|'SHADOW_PLAN_BLOCKED'|'SHADOW_DEPENDENCY_MISSING'|'SHADOW_DOMAIN_HASH_INVALID') {super(code);this.name='ShadowPlanError';}
}
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const hex=/^[a-f0-9]{64}$/u;
const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value===value.trim()&&value.length<=4096;
const selections=['current','staged','pinned','historical','revision','review-parent','configured','dependency'];
export interface ShadowFileLocation {rootId:string;relativePath:string}
export interface ShadowFileSelection extends Omit<ShadowArtifactIdentity,'artifactId'|'locatorId'> {
  artifactId?:string;locatorId?:string;availability:'present';objectKind:PrivateObjectKind;
  source:ShadowFileLocation;classification:'selected'|'dependency';domainSha256?:string|null;
  expectedRawSha256?:string;mediaType?:'audio/mpeg'|'audio/wav'|'image/png'|'image/jpeg';
}
export interface ShadowAbsentSelection extends Omit<ShadowArtifactIdentity,'artifactId'|'locatorId'|'required'> {
  artifactId?:string;locatorId?:string;availability:'absent';required:false;absenceReason:'known-absent';
}
export interface ShadowInventoryRequest {
  version:'shadow-inventory-request-v1';runId?:string;binding:ShadowRunPlan['binding'];
  ownerId:string;studentId:string;applicationTargetId:string;supportTargetId:string;provenanceOwnerId?:string;
  artifacts:readonly(ShadowFileSelection|ShadowAbsentSelection)[];pointers?:readonly ShadowPointerPlan[];
  /** Inventory only: these are deliberately outside the selected read graph. */
  notSelected?:readonly{source:ShadowFileLocation;reason:string}[];
  previousAttempt?:{runId:string;reason:string};
}
export interface ShadowInventoryEntry {
  artifactId:string;classification:'selected'|'dependency'|'not_selected'|'missing'|'unsupported'|'quarantined'|'absent';
  role?:string;reference?:string;selection?:string;expectedRawSha256?:string;
  source?:ShadowFileLocation;pathSha256?:string;rawSha256?:string;sizeBytes?:number;reason?:string;
}
export interface ShadowInventory {
  version:'shadow-inventory-v1';plan:ShadowRunPlan;inputFingerprint:string;eligible:boolean;
  entries:readonly ShadowInventoryEntry[];counts:Record<string,number>;backendWrites:0;providerCalls:0;
  localSnapshotLimit:'before-after-file-pins-do-not-prove-local-ABA-absence';
  sources:Readonly<Record<string,ShadowFileLocation>>;
  previousAttempt?:{runId:string;reason:string};
}
export type ShadowSourceRoots=Readonly<Record<string,string>>;

/** Plan metadata serialization is explicit. This never serializes or sorts a
 * domain payload, changes its bytes, or invents a missing domain hash. */
export function shadowPlanFingerprint(plan:Omit<ShadowRunPlan,'planSha256'>|ShadowRunPlan):string {
  const {planSha256:_ignored,...value}=plan as ShadowRunPlan;void _ignored;return sha(JSON.stringify(value));
}
export function assertShadowPlan(plan:ShadowRunPlan):void {
  if(!plan||!id(plan.runId)||!/^[a-z0-9_-]{8,128}$/u.test(plan.runId)||!hex.test(plan.planSha256)||!['synthetic','local-verification-only'].includes(plan.binding)||
    ![plan.ownerId,plan.studentId,plan.applicationTargetId,plan.supportTargetId].every(id)||
    !Array.isArray(plan.artifacts)||!plan.artifacts.length||plan.artifacts.length>512||shadowPlanFingerprint(plan)!==plan.planSha256)throw new ShadowPlanError('SHADOW_PLAN_INVALID');
  const all=new Map(plan.artifacts.map(a=>[a.artifactId,a]));
  if(all.size!==plan.artifacts.length||new Set(plan.artifacts.map(a=>a.locatorId)).size!==plan.artifacts.length)throw new ShadowPlanError('SHADOW_PLAN_INVALID');
  const selectors=new Set<string>();
  for(const a of plan.artifacts) {
    if(!id(a.artifactId)||a.artifactId.length>128||!id(a.locatorId)||a.locatorId.length>256||!id(a.role)||a.role.length>128||!id(a.reference)||
      !selections.includes(a.selection)||!['common','target'].includes(a.scope)||!Array.isArray(a.dependencies))throw new ShadowPlanError('SHADOW_PLAN_INVALID');
    for(const key of ['sourceRevision','versionId','legacyId','originalPin'] as const)if(Object.hasOwn(a,key)&&a[key]!==null&&!id(a[key]))throw new ShadowPlanError('SHADOW_PLAN_INVALID');
    for(const selector of [{role:a.role,reference:a.reference,selection:a.selection},...(a.aliases??[])]) {
      if(!id(selector.role)||selector.role.length>128||selector.reference!==undefined&&!id(selector.reference)||selector.selection!==undefined&&!selections.includes(selector.selection))throw new ShadowPlanError('SHADOW_PLAN_INVALID');
      const key=JSON.stringify([selector.role,selector.reference??null,selector.selection??null]);if(selectors.has(key))throw new ShadowPlanError('SHADOW_PLAN_INVALID');selectors.add(key);
    }
    if(a.availability==='present') {
      if(!privateObjectKinds.includes(a.objectKind)||!Number.isSafeInteger(a.sizeBytes)||a.sizeBytes<1||a.sizeBytes>16*1024*1024||!hex.test(a.rawSha256)||
        a.domainSha256!==undefined&&a.domainSha256!==null&&!hex.test(a.domainSha256))throw new ShadowPlanError('SHADOW_PLAN_INVALID');
    } else if(a.availability!=='absent'||a.required!==false||a.absenceReason!=='known-absent')throw new ShadowPlanError('SHADOW_PLAN_INVALID');
    for(const dep of a.dependencies) {
      const target=all.get(dep.artifactId);if(typeof dep.required!=='boolean'||!target||dep.required&&target.availability==='absent')throw new ShadowPlanError('SHADOW_DEPENDENCY_MISSING');
    }
  }
  const visiting=new Set<string>(),visited=new Set<string>();
  const visit=(key:string)=>{if(visiting.has(key))throw new ShadowPlanError('SHADOW_PLAN_INVALID');if(visited.has(key))return;visiting.add(key);for(const d of all.get(key)!.dependencies)visit(d.artifactId);visiting.delete(key);visited.add(key);};
  for(const key of all.keys())visit(key);
  for(const pointer of plan.pointers??[])if(!all.has(pointer.artifactId)||all.get(pointer.artifactId)!.availability!=='present')throw new ShadowPlanError('SHADOW_PLAN_INVALID');
}
export function assertShadowInventory(value:ShadowInventory):void {
  assertShadowPlan(value.plan);
  const fingerprint=sha(JSON.stringify({plan:value.plan,entries:value.entries,sources:value.sources,...(value.previousAttempt?{previousAttempt:value.previousAttempt}:{})}));
  if(!value.eligible||value.inputFingerprint!==fingerprint||value.entries.some(e=>['missing','unsupported','quarantined'].includes(e.classification)))throw new ShadowPlanError('SHADOW_PLAN_BLOCKED');
}

/** Only trusted composition supplies roots. A provenance/reference in JSON is
 * never a filesystem instruction; every source has a separately bounded root. */
async function sourceFile(roots:ShadowSourceRoots,location:ShadowFileLocation) {
  const base=roots[location.rootId],relative=location.relativePath;
  if(!base||!id(relative)||path.isAbsolute(relative)||path.win32.isAbsolute(relative)||/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(relative)||relative.split(/[\\/]/u).some(x=>x==='..'||x==='.'||!x))throw new ShadowPlanError('SHADOW_SOURCE_OUTSIDE_ROOT');
  const canonicalBase=await realpath(base),candidate=path.resolve(canonicalBase,relative),resolved=await realpath(candidate),inside=path.relative(canonicalBase,resolved);
  if(inside.startsWith('..')||path.isAbsolute(inside)||(await lstat(candidate)).isSymbolicLink())throw new ShadowPlanError('SHADOW_SOURCE_OUTSIDE_ROOT');
  return resolved;
}
async function sourceBytes(roots:ShadowSourceRoots,location:ShadowFileLocation) {
  const file=await sourceFile(roots,location),before=await stat(file);
  if(!before.isFile()||before.size>16*1024*1024)throw new ShadowPlanError('SHADOW_PLAN_BLOCKED');
  const bytes=await readFile(file),after=await stat(file);
  if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||bytes.length!==before.size||await realpath(file)!==file)throw new ShadowPlanError('SHADOW_SOURCE_CHANGED');
  return bytes;
}
async function sourceDigest(roots:ShadowSourceRoots,location:ShadowFileLocation) {
  const file=await sourceFile(roots,location),before=await stat(file);if(!before.isFile())throw new ShadowPlanError('SHADOW_PLAN_BLOCKED');
  const hash=createHash('sha256');let size=0;for await(const chunk of createReadStream(file,{highWaterMark:1024*1024})){size+=chunk.length;hash.update(chunk);}
  const after=await stat(file);if(size!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new ShadowPlanError('SHADOW_SOURCE_CHANGED');
  return {sizeBytes:size,rawSha256:hash.digest('hex')};
}
export async function readShadowSource(inventory:ShadowInventory,roots:ShadowSourceRoots,artifactId:string):Promise<Buffer> {
  const artifact=inventory.plan.artifacts.find(a=>a.artifactId===artifactId),source=inventory.sources[artifactId];
  if(!inventory.eligible||!artifact||artifact.availability!=='present'||!source)throw new ShadowPlanError('SHADOW_PLAN_BLOCKED');
  const bytes=await sourceBytes(roots,source);if(bytes.length!==artifact.sizeBytes||sha(bytes)!==artifact.rawSha256)throw new ShadowPlanError('SHADOW_SOURCE_CHANGED');return bytes;
}

export async function inventoryShadowFiles(request:ShadowInventoryRequest,roots:ShadowSourceRoots):Promise<ShadowInventory> {
  if(!request||request.version!=='shadow-inventory-request-v1'||!Array.isArray(request.artifacts)||request.artifacts.length>512)throw new ShadowPlanError('SHADOW_PLAN_INVALID');
  const entries:ShadowInventoryEntry[]=[],artifacts:ShadowArtifactPlan[]=[],sources:Record<string,ShadowFileLocation>={};let eligible=true;
  for(const item of request.artifacts) {
    const artifactId=item.artifactId??sha(JSON.stringify([item.role,item.reference,item.selection,item.scope])),locatorId=item.locatorId??'sha256:'+artifactId;
    const {artifactId:_a,locatorId:_l,...identity}=item;void _a;void _l;
    if(item.availability==='absent') {
      artifacts.push({...identity,artifactId,locatorId} as ShadowArtifactPlan);entries.push({artifactId,role:item.role,reference:item.reference,selection:item.selection,classification:'absent',reason:'known-absent'});continue;
    }
    sources[artifactId]={...item.source};
    let observed:{sizeBytes:number;rawSha256:string}|undefined;
    try {
      const bytes=await sourceBytes(roots,item.source),rawSha256=sha(bytes);
      observed={sizeBytes:bytes.length,rawSha256};
      if(item.expectedRawSha256&&item.expectedRawSha256!==rawSha256)throw new ShadowPlanError('SHADOW_SOURCE_CHANGED');
      let mediaType=item.mediaType;
      if(item.objectKind==='audio') {const actual=inspectAudioFormat(bytes).mediaType;if(mediaType&&mediaType!==actual)throw new ShadowPlanError('SHADOW_PLAN_BLOCKED');mediaType=actual;}
      else if(item.objectKind==='source-image') {const actual=inspectImageFormat(bytes).mediaType;if(mediaType&&mediaType!==actual)throw new ShadowPlanError('SHADOW_PLAN_BLOCKED');mediaType=actual;}
      else if(item.objectKind==='source-pdf')await validatePdfStructure(bytes);
      else {
        const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!text.length)throw new ShadowPlanError('SHADOW_PLAN_BLOCKED');
        if(item.objectKind==='review-journal'){const rows=text.split(/\r?\n/u).filter(r=>r.trim().length>0);if(!rows.length)throw new ShadowPlanError('SHADOW_PLAN_BLOCKED');for(const row of rows)JSON.parse(row);}
        else if(item.objectKind!=='source-markdown')JSON.parse(text);
      }
      const {source:_source,classification:_classification,expectedRawSha256:_expected,...descriptor}=identity as ShadowFileSelection;void _source;void _classification;void _expected;
      artifacts.push({...descriptor,artifactId,locatorId,sizeBytes:bytes.length,rawSha256,...(mediaType?{mediaType}:{})} as ShadowArtifactPlan);
      entries.push({artifactId,role:item.role,reference:item.reference,selection:item.selection,classification:item.classification,source:{...item.source},pathSha256:sha(JSON.stringify(item.source)),rawSha256,sizeBytes:bytes.length,
        ...(item.expectedRawSha256?{expectedRawSha256:item.expectedRawSha256}:{})});
    } catch(error) {
      eligible=false;const code=(error as {code?:string}).code??'FORMAT_OR_READ_FAILED';
      if(!observed&&code==='SHADOW_PLAN_BLOCKED')try{observed=await sourceDigest(roots,item.source);}catch{/* failed reads remain unknown */}
      entries.push({artifactId,role:item.role,reference:item.reference,selection:item.selection,classification:code==='ENOENT'?'missing':code==='SHADOW_SOURCE_CHANGED'?'quarantined':'unsupported',source:{...item.source},pathSha256:sha(JSON.stringify(item.source)),reason:code,...observed,
        ...(item.expectedRawSha256?{expectedRawSha256:item.expectedRawSha256}:{})});
    }
  }
  for(const row of request.notSelected??[])entries.push({artifactId:sha(JSON.stringify(row.source)),classification:'not_selected',source:{...row.source},reason:row.reason,pathSha256:sha(JSON.stringify(row.source))});
  const planBase:Omit<ShadowRunPlan,'planSha256'>={runId:request.runId??randomUUID(),binding:request.binding,ownerId:request.ownerId,studentId:request.studentId,
    applicationTargetId:request.applicationTargetId,supportTargetId:request.supportTargetId,...(request.provenanceOwnerId===undefined?{}:{provenanceOwnerId:request.provenanceOwnerId}),artifacts,...(request.pointers?{pointers:request.pointers}:{})};
  const plan:ShadowRunPlan={...planBase,planSha256:shadowPlanFingerprint(planBase)};
  try{assertShadowPlan(plan);}catch(error){eligible=false;entries.push({artifactId:'plan',classification:'quarantined',reason:(error as ShadowPlanError).code});}
  const counts:Record<string,number>={};for(const entry of entries)counts[entry.classification]=(counts[entry.classification]??0)+1;
  const previousAttempt=request.previousAttempt;
  if(previousAttempt&&(!id(previousAttempt.runId)||!id(previousAttempt.reason)||previousAttempt.runId===plan.runId))throw new ShadowPlanError('SHADOW_PLAN_INVALID');
  return {version:'shadow-inventory-v1',plan,inputFingerprint:sha(JSON.stringify({plan,entries,sources,...(previousAttempt?{previousAttempt}:{})})),eligible,entries,counts,backendWrites:0,providerCalls:0,
    localSnapshotLimit:'before-after-file-pins-do-not-prove-local-ABA-absence',sources,...(previousAttempt?{previousAttempt}:{})};
}
