import { createHash } from 'node:crypto';
import type { RequestContext,RequestIdentityBoundary } from '../auth/request-identity';
import { createInternalObjectCapability,type PrivateObjectService } from '../storage/private-object-service';
import type { ObjectAdmission,PrivateObjectRepository,PrivateObjectScope } from '../storage/private-object-ports';
import type { ShadowArtifactPlan,ShadowImportCapability,ShadowRepository,ShadowSnapshot } from './shadow-ports';
import { assertShadowInventory,readShadowSource,type ShadowInventory,type ShadowSourceRoots } from './shadow-plan';

export class ShadowImportError extends Error {
  constructor(readonly code:'SHADOW_IMPORT_BLOCKED'|'SHADOW_IMPORT_STATE'|'SHADOW_IMPORT_CONFLICT'|'SHADOW_POINTER_CONFLICT'|'SHADOW_VERIFY_FAILED'|'SHADOW_DOMAIN_VERIFIER_REQUIRED') {super(code);this.name='ShadowImportError';}
}
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const blocked:()=>never=()=>{throw new ShadowImportError('SHADOW_IMPORT_BLOCKED');};

/** No global writer or fallback is installed. Every operation is finite to the
 * supplied plan and capability, uses C lifecycle writes, and performs object IO
 * outside DB transactions. Sources are used only by this migration tool. */
export function createShadowImporter(options:{
  repository:ShadowRepository;objects:PrivateObjectService;objectRepository:PrivateObjectRepository;
  identity:RequestIdentityBoundary;roots:ShadowSourceRoots;now?:()=>number;
  verifyDomain?:(context:RequestContext,inventory:ShadowInventory,snapshot:ShadowSnapshot)=>Promise<{passed:boolean;[key:string]:unknown}>;
}) {
  const {repository,objects,objectRepository,identity,roots}=options,now=options.now??Date.now;
  async function validate(context:RequestContext,inventory:ShadowInventory) {
    assertShadowInventory(inventory);
    const current=await identity.revalidate(context),p=inventory.plan;
    if(current.mode!=='authenticated'||!current.scope||current.account.ownerId!==p.ownerId||current.scope.studentId!==p.studentId||
      current.scope.applicationTargetId!==p.applicationTargetId||current.scope.supportTargetId!==p.supportTargetId)blocked();
    return current;
  }
  function admission(inventory:ShadowInventory,artifact:ShadowArtifactPlan):ObjectAdmission {
    if(artifact.availability!=='present')blocked();
    return {kind:artifact.objectKind,scope:artifact.scope,studentId:inventory.plan.studentId,
      expectedSize:artifact.sizeBytes,expectedSha256:artifact.rawSha256,
      idempotencyKey:'D:'+sha(JSON.stringify([inventory.plan.runId,inventory.plan.planSha256,artifact.artifactId])),
      ...(Object.hasOwn(artifact,'sourceRevision')?{sourceRevision:artifact.sourceRevision}:{}),
      ...(Object.hasOwn(artifact,'domainSha256')?{domainSha256:artifact.domainSha256}:{}),
      ...(artifact.mediaType?{mediaType:artifact.mediaType}:{})};
  }
  async function internal(context:RequestContext,inventory:ShadowInventory,artifact:ShadowArtifactPlan,objectIds:string[]=[]) {
    if(artifact.availability!=='present')blocked();const current=await validate(context,inventory),input=admission(inventory,artifact),p=inventory.plan;
    const scope:PrivateObjectScope=artifact.scope==='common'?{kind:'common',ownerId:p.ownerId,studentId:p.studentId}:
      {kind:'target',ownerId:p.ownerId,studentId:p.studentId,applicationTargetId:p.applicationTargetId,supportTargetId:p.supportTargetId};
    return createInternalObjectCapability({scope,kinds:[artifact.objectKind],idempotencyKeys:[input.idempotencyKey],objectIds,
      ...(Object.hasOwn(artifact,'sourceRevision')?{sourceRevision:artifact.sourceRevision}:{}),expiresAt:Math.min(current.principal.expiresAt,now()+900_000),
      async checkCurrent(){try{await validate(context,inventory);return true;}catch{return false;}}});
  }
  async function receive(context:RequestContext,inventory:ShadowInventory,artifact:ShadowArtifactPlan) {
    if(artifact.availability!=='present')blocked();const input=admission(inventory,artifact);
    return artifact.objectKind==='source-pdf'?objects.admitStudent(context,input):objects.admitGenerated(context,input,await internal(context,inventory,artifact));
  }
  async function snapshot(context:RequestContext,inventory:ShadowInventory) {
    await validate(context,inventory);const s=await repository.capture(context,inventory.plan.runId);
    if(!s||s.planSha256!==inventory.plan.planSha256)throw new ShadowImportError('SHADOW_IMPORT_STATE');return s;
  }
  function order(inventory:ShadowInventory) {
    const rows=new Map(inventory.plan.artifacts.map(a=>[a.artifactId,a])),visited=new Set<string>(),ordered:ShadowArtifactPlan[]=[];
    const add=(a:ShadowArtifactPlan)=>{if(visited.has(a.artifactId))return;visited.add(a.artifactId);for(const d of a.dependencies)add(rows.get(d.artifactId)!);ordered.push(a);};
    for(const a of inventory.plan.artifacts)add(a);return ordered;
  }
  return Object.freeze({
    async status(context:RequestContext,inventory:ShadowInventory){return snapshot(context,inventory);},
    async import(context:RequestContext,inventory:ShadowInventory,capability:ShadowImportCapability) {
      await validate(context,inventory);let state=await repository.registerRun(context,inventory.plan,capability);
      if(state.state!=='open')throw new ShadowImportError('SHADOW_IMPORT_STATE');
      const results:{artifactId:string;status:string;receiptId?:string;objectId?:string}[]=[];
      for(const artifact of order(inventory)) {
        if(artifact.availability==='absent'){results.push({artifactId:artifact.artifactId,status:'known-absent'});continue;}
        let bytes:Buffer;
        try{bytes=await readShadowSource(inventory,roots,artifact.artifactId);}catch(error){
          if((error as {code?:string}).code==='SHADOW_SOURCE_CHANGED')await repository.quarantine(context,state.runId,artifact.artifactId,capability).catch(()=>null);
          throw error;
        }
        state=await snapshot(context,inventory);const existing=state.artifacts.find(a=>a.artifactId===artifact.artifactId);
        if(!existing||existing.status==='quarantined')throw new ShadowImportError('SHADOW_IMPORT_STATE');
        if(existing.status==='bound') {
          const verified=await objects.read(context,{objectId:existing.objectId!,scope:artifact.scope});
          if(!verified.equals(bytes))throw new ShadowImportError('SHADOW_VERIFY_FAILED');
          // A partial import may legitimately still have other planned rows.
          // Pin this exact reused relation rather than requiring the complete
          // run to be readable before resume can finish its remaining rows.
          const after=await snapshot(context,inventory),row=after.artifacts.find(a=>a.artifactId===artifact.artifactId);
          if(after.generation!==state.generation||!row||row.status!=='bound'||row.receiptId!==existing.receiptId||row.objectId!==existing.objectId||
            row.rawSha256!==existing.rawSha256||row.sizeBytes!==existing.sizeBytes)throw new ShadowImportError('SHADOW_IMPORT_CONFLICT');
          if(!row.object||row.object.revision!==row.objectRevision) {
            // Explicit migration resume can rebind the same verified receipt
            // after C cleanup; a read never performs this generation change.
            await repository.bindObject(context,state.runId,artifact.artifactId,existing.receiptId!,capability);
          }
          results.push({artifactId:artifact.artifactId,status:'reused',receiptId:existing.receiptId,objectId:existing.objectId});continue;
        }
        const receipt=await receive(context,inventory,artifact);
        await repository.noteReceipt(context,state.runId,artifact.artifactId,receipt.receiptId,capability);
        if(['cancelled','expired','rejected'].includes(receipt.state))throw new ShadowImportError('SHADOW_IMPORT_STATE');
        const objectCap=await internal(context,inventory,artifact,[receipt.objectId]);
        if(receipt.state!=='verified') {
          if(receipt.state!=='verifying')await objects.upload(context,receipt.receiptId,bytes,objectCap);
          await objects.complete(context,receipt.receiptId,objectCap);
        }
        // C cleanup increments receipt revision. Do it before binding that
        // exact revision into D; no reader silently refreshes an old snapshot.
        const cleaned=await objects.cleanup(context,receipt.receiptId,objectCap);
        if(cleaned.cleanupState!=='clean')throw new ShadowImportError('SHADOW_IMPORT_STATE');
        const binding=await repository.bindObject(context,state.runId,artifact.artifactId,receipt.receiptId,capability);
        const observed=await objects.read(context,{objectId:binding.objectId,scope:artifact.scope});
        if(!observed.equals(bytes))throw new ShadowImportError('SHADOW_VERIFY_FAILED');
        results.push({artifactId:artifact.artifactId,status:'imported',receiptId:binding.receiptId,objectId:binding.objectId});
      }
      // Observe source changes before publishing any shadow-only pointer.
      for(const artifact of inventory.plan.artifacts)if(artifact.availability==='present')await readShadowSource(inventory,roots,artifact.artifactId);
      state=await snapshot(context,inventory);
      for(const pointer of inventory.plan.pointers??[]) {
        const existing=state.pointers.find(p=>p.name===pointer.name&&p.selection===pointer.selection);
        if(existing) {if(existing.artifactId!==pointer.artifactId)throw new ShadowImportError('SHADOW_POINTER_CONFLICT');continue;}
        const published=await repository.setPointer(context,state.runId,pointer,'0',capability);
        state=await snapshot(context,inventory);
        if(!published) {
          // A concurrent retry may have published this exact frozen pointer.
          // Adopt only its observed identical target, never reset/replace it.
          const observed=state.pointers.find(p=>p.name===pointer.name&&p.selection===pointer.selection);
          if(!observed||observed.artifactId!==pointer.artifactId)throw new ShadowImportError('SHADOW_POINTER_CONFLICT');
        }
      }
      const finalSnapshot=await snapshot(context,inventory);
      for(const expected of inventory.plan.pointers??[]) {
        const observed=finalSnapshot.pointers.find(p=>p.name===expected.name&&p.selection===expected.selection);
        if(!observed||observed.artifactId!==expected.artifactId)throw new ShadowImportError('SHADOW_POINTER_CONFLICT');
      }
      if(finalSnapshot.generation!==state.generation||!await repository.unchanged(context,finalSnapshot.runId,finalSnapshot.generation))throw new ShadowImportError('SHADOW_IMPORT_CONFLICT');
      return {version:'shadow-import-result-v1',runId:state.runId,planSha256:state.planSha256,results,snapshot:finalSnapshot,
        sessionEvaluationWrites:0,activeLocalPointerWrites:0,aiProviderCalls:0};
    },
    async verify(context:RequestContext,inventory:ShadowInventory) {
      const captured=await snapshot(context,inventory),results:Record<string,string>={};
      for(const artifact of inventory.plan.artifacts) {
        const row=captured.artifacts.find(a=>a.artifactId===artifact.artifactId);
        if(!row)throw new ShadowImportError('SHADOW_VERIFY_FAILED');
        if(artifact.availability==='absent') {if(row.availability!=='absent'||row.status!=='absent')throw new ShadowImportError('SHADOW_VERIFY_FAILED');results[artifact.artifactId]='known-absent';continue;}
        const binding=await repository.resolve(context,captured.runId,{role:artifact.role,reference:artifact.reference,selection:artifact.selection});
        if(!binding||binding.rawSha256!==artifact.rawSha256||binding.sizeBytes!==artifact.sizeBytes)throw new ShadowImportError('SHADOW_VERIFY_FAILED');
        const bytes=await objects.read(context,{objectId:binding.objectId,scope:artifact.scope}),source=await readShadowSource(inventory,roots,artifact.artifactId);
        if(sha(bytes)!==artifact.rawSha256||!bytes.equals(source))throw new ShadowImportError('SHADOW_VERIFY_FAILED');
        results[artifact.artifactId]='raw-bytes-and-relationship-verified-domain-gate-required';
      }
      if(!await repository.unchanged(context,captured.runId,captured.generation))throw new ShadowImportError('SHADOW_IMPORT_CONFLICT');
      if(!options.verifyDomain)throw new ShadowImportError('SHADOW_DOMAIN_VERIFIER_REQUIRED');
      const domain=await options.verifyDomain(context,inventory,captured);
      if(!domain.passed||!await repository.unchanged(context,captured.runId,captured.generation))throw new ShadowImportError('SHADOW_VERIFY_FAILED');
      return {version:'shadow-verify-result-v1',passed:true,results,domain,generation:captured.generation,domainApprovalGranted:false,writes:0,aiProviderCalls:0};
    },
    async cleanup(context:RequestContext,inventory:ShadowInventory,capability:ShadowImportCapability) {
      let state=await snapshot(context,inventory);const remaining:{artifactId:string;reason:string}[]=[];
      // Recover uncertain admission responses while the run is still open.
      // Idempotent C admission cannot revive a cancelled/expired receipt.
      if(state.state==='open'||state.state==='cancelled') {
        for(const artifact of inventory.plan.artifacts)if(artifact.availability==='present'&&!state.artifacts.find(a=>a.artifactId===artifact.artifactId)?.receiptId) {
          try {const receipt=await receive(context,inventory,artifact);await repository.noteReceipt(context,state.runId,artifact.artifactId,receipt.receiptId,capability);}
          catch {remaining.push({artifactId:artifact.artifactId,reason:'receipt-recovery-not-confirmed'});}
        }
        state=state.state==='open'?await repository.cancel(context,state.runId,capability):await snapshot(context,inventory);
      }
      for(const row of state.artifacts) {
        if(row.availability==='absent')continue;
        const artifact=inventory.plan.artifacts.find(a=>a.artifactId===row.artifactId)!;
        if(!row.receiptId){if(!remaining.some(r=>r.artifactId===row.artifactId))remaining.push({artifactId:row.artifactId,reason:'receipt-status-unknown'});continue;}
        try {
          const receipt=await objectRepository.getReceipt(context,row.receiptId);if(!receipt)throw new ShadowImportError('SHADOW_IMPORT_STATE');
          const cap=await internal(context,inventory,artifact,[receipt.objectId]);
          await objects.cancel(context,row.receiptId,cap);const cleaned=await objects.cleanup(context,row.receiptId,cap);
          if(cleaned.cleanupState!=='clean')remaining.push({artifactId:row.artifactId,reason:'provider-delete-incomplete'});
        }catch{remaining.push({artifactId:row.artifactId,reason:'cleanup-not-confirmed'});}
      }
      if(!remaining.length&&state.state!=='cleaned')state=await repository.markCleaned(context,state.runId,capability);
      else state=await snapshot(context,inventory);
      return {complete:!remaining.length&&state.state==='cleaned',state,remaining,aiProviderCalls:0};
    },
  });
}
export type ShadowImporter=ReturnType<typeof createShadowImporter>;
