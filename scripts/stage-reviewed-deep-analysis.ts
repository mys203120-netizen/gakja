/** Strict offline authoring stage. It performs no provider calls or activation. */
import dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { loadInterviewContextAt } from '../server/data/load-interview-context';
import { loadFullRecord, loadFullStudentAnalysis, loadStagedFullStudentAnalysis, materializeFullStudentAnalysis, saveFullStudentAnalysis } from '../server/data/full-student-analysis';
import { materializeDeepWire, preservedAcademicRowSignature, type DeepCommonParts } from '../server/data/student-analysis-batches';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export async function stageReviewedDeepAnalysis(args: string[], root = process.cwd()) {
  const arg=(name:string)=>args.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3);
  const artifactPath=arg('review'); if(!artifactPath)throw new Error('REVIEWED_DEEP_INPUT_REQUIRED');
  const reportPath=path.resolve(root,arg('output')??`artifacts/student-deep-reviewed-stage-${Date.now()}.json`);
  const relative=path.relative(path.resolve(root,'artifacts'),reportPath);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('REVIEWED_DEEP_OUTPUT_PATH_INVALID');
  await mkdir(path.dirname(reportPath),{recursive:true});const handle=await open(reportPath,'wx',0o600);
  const report:Record<string,unknown>={schemaVersion:'offline-reviewed-deep-stage-v1',createdAt:new Date().toISOString(),externalProviderCalls:0,activated:false,pointerWrites:0,bankWrites:0};
  const boundJson=async(pin:{path:string;sha256:string})=>{const text=await readFile(path.resolve(root,pin.path),'utf8');if(sha(text)!==pin.sha256)throw new Error('REVIEWED_DEEP_PIN_CHANGED:'+pin.path);return JSON.parse(text);};
  try{
    const text=await readFile(path.resolve(root,artifactPath),'utf8'),artifact=JSON.parse(text);
    if(artifact.schemaVersion!=='offline-reviewed-deep-synthesis-authoring-v1'||artifact.externalProviderCalls!==0||artifact.activationApproval!==false)throw new Error('REVIEWED_DEEP_AUTHORSHIP_INVALID');
    const parts:DeepCommonParts=await boundJson(artifact.combinedInput),sourceReview=await boundJson(artifact.sourceReview);
    if(sourceReview.combinedInput.sha256!==artifact.combinedInput.sha256)throw new Error('REVIEWED_DEEP_SOURCE_PARENT_MISMATCH');
    for(const row of sourceReview.sourceRows){const at=parts.sourceReviews.findIndex(item=>item.sourceKey===row.sourceKey);if(at<0||!isDeepStrictEqual(parts.sourceReviews[at],row.before))throw new Error('REVIEWED_DEEP_SOURCE_REVIEW_STALE');parts.sourceReviews[at]=row.after;}
    if(!isDeepStrictEqual(parts.sourceReviews,artifact.sourceReviews))throw new Error('REVIEWED_DEEP_SOURCE_REVIEW_BODY_CHANGED');
    for(const change of artifact.manualDataChanges.teacherObservationAdditions??[]){
      if(change.field!=='teacherObservations')throw new Error('REVIEWED_DEEP_FACT_FIELD_INVALID');
      const entity=parts.activities.find(row=>row.localId===change.entityLocalId);if(!entity)throw new Error('REVIEWED_DEEP_FACT_OWNER_INVALID');
      for(const id of change.quoteIds){if(!parts.quoteDictionary.some(row=>row.id===id))throw new Error('REVIEWED_DEEP_FACT_PROOF_INVALID');if(!entity.factProofRefs.teacherObservations.some(ref=>ref.quoteId===id))entity.factProofRefs.teacherObservations.push({kind:'proof_ref',quoteId:id});}
    }
    for(const change of artifact.manualDataChanges.resolvedBoundaryUnknowns??[]){const entity=parts.activities.find(row=>row.localId===change.entityLocalId);if(!entity||!entity.unknowns.includes(change.previousText)||change.after!==null||change.basisQuoteIds.some((id:number)=>!parts.quoteDictionary.some(row=>row.id===id)))throw new Error('REVIEWED_DEEP_UNKNOWN_CHANGE_STALE');entity.unknowns=entity.unknowns.filter(text=>text!==change.previousText);}
    for(const change of artifact.manualDataChanges.recordedContextProofReorderings??[]){
      const entity=parts.activities.find(row=>row.localId===change.entityLocalId);
      if(!entity||change.field!=='recordedContext'||!isDeepStrictEqual(entity.factProofRefs.recordedContext,change.previousProofs)||sha(JSON.stringify(change.previousProofs))!==change.previousSha256||sha(JSON.stringify(change.replacementProofs))!==change.replacementSha256||!isDeepStrictEqual(change.previousProofs.map((r:{quoteId:number})=>r.quoteId).sort(),change.replacementProofs.map((r:{quoteId:number})=>r.quoteId).sort()))throw new Error('REVIEWED_DEEP_PROOF_REORDER_STALE');
      entity.factProofRefs.recordedContext=change.replacementProofs;
    }
    const context=await loadInterviewContextAt(root,{writeManifest:false});if(context.errors.length)throw new Error('REVIEWED_DEEP_CONTEXT_NOT_READY');
    const source=await loadFullRecord(root,context.student.pdfSha256),parent=await loadFullStudentAnalysis(context,root);if(!source||!parent||source.pdfSha256!==artifact.sourcePdfSha256||source.contentSha256!==artifact.sourceContentSha256)throw new Error('REVIEWED_DEEP_SOURCE_MISMATCH');
    const wire=materializeDeepWire(parts,artifact.synthesis,source),generatedAt=new Date().toISOString(),model='offline-source-reviewed-authoring-v1';
    const value=materializeFullStudentAnalysis(context,source,wire,{model,generatedAt,derivationVersion:'full-record-deep-v1'});
    for(const old of parent.common.activities){const retained=value.common.activities.find(row=>row.localId===old.localId);if(!retained||retained.id!==old.id)throw new Error('REVIEWED_DEEP_EXISTING_ACTIVITY_ID_CHANGED:'+old.localId);for(const field of ['recordedContext','studentActions','teamActions','choiceReasons','outcomes','teacherObservations']as const)for(const proof of old.facts[field])if(!retained.facts[field].some(item=>isDeepStrictEqual(item,proof)))throw new Error('REVIEWED_DEEP_EXISTING_ACTIVITY_FACT_CHANGED:'+old.localId);}
    for(const old of parent.common.academicRecords.filter(row=>row.tableStructure?.status==='resolved')){const retained=value.common.academicRecords.find(row=>row.localId===old.localId);if(!retained||retained.id!==old.id||preservedAcademicRowSignature(old)!==preservedAcademicRowSignature(retained))throw new Error('REVIEWED_DEEP_EXISTING_ACADEMIC_CHANGED:'+old.localId);}
    for(const old of parent.common.trajectories)if(!value.common.trajectories.some(row=>isDeepStrictEqual(row,old)))throw new Error('REVIEWED_DEEP_EXISTING_TRAJECTORY_CHANGED:'+old.id);
    const groupFor=new Map<string,string>(artifact.synthesis.activityGroups.flatMap((group:{canonicalLocalId:string;memberLocalIds:string[]})=>group.memberLocalIds.map(id=>[id,group.canonicalLocalId])));
    const canonicalSourceReviews=parts.sourceReviews.map(row=>({...row,units:row.units.map(unit=>({...unit,entityLocalIds:[...new Set(unit.entityLocalIds.map(id=>groupFor.get(id)??id))]}))}));
    const job='data/prepared/student-analysis-proposals/deep-1793813290803';
    const proposalPath=`${job}/reviewed-deep-proposal-${sha(text).slice(0,16)}.json`;
    await writeFile(path.resolve(root,proposalPath),JSON.stringify({schemaVersion:'unapproved-full-analysis-proposal-v2',codecVersion:'student-analysis-codec-v2',model,generatedAt,sourceContentSha256:source.contentSha256,status:'completed',authorship:{type:'offline-source-reviewed-authoring',artifactPath,artifactSha256:sha(text),providerSynthesisSucceeded:false},output:wire,sourceReviews:canonicalSourceReviews,wholeRecordAxes:artifact.synthesis.wholeRecordAxes},null,2)+'\n',{flag:'wx',mode:0o600});
    const staged=await saveFullStudentAnalysis(value,source,root),loaded=await loadStagedFullStudentAnalysis(context,staged.revisionPath,root);
    Object.assign(report,{staged:true,revisionPath:staged.revisionPath,manifestPath:staged.manifestPath,proposalPath,artifactPath,artifactSha256:sha(text),commonContentSha256:loaded.common.contentSha256,targetContentSha256:loaded.target.contentSha256,activities:loaded.common.activities.length,academicRows:loaded.common.academicRecords.length,literalValues:loaded.manifest.academicLiteralCount,trajectories:loaded.common.trajectories.length,objectives:loaded.target.objectives.length,priorities:loaded.target.activityPriorities.length,coverage:loaded.common.coverage,sourceReviews:canonicalSourceReviews,wholeRecordAxes:artifact.synthesis.wholeRecordAxes,existing18ActivityIdsAndFactsPreserved:true,existing13AcademicIdsAnd35LiteralProvenancePreserved:true,existing2TrajectoriesPreserved:true,independentFinalReviewRequired:true});
    return report;
  }catch(error){report.failure=error instanceof Error?error.message:'REVIEWED_DEEP_STAGE_FAILED';return report;}
  finally{await handle.writeFile(JSON.stringify(report,null,2)+'\n');await handle.sync();await handle.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){dotenv.config({path:'.env.local',quiet:true});stageReviewedDeepAnalysis(process.argv.slice(2)).then(report=>{console.log(JSON.stringify({stage:report.revisionPath,failure:report.failure,activities:report.activities,academicRows:report.academicRows,objectives:report.objectives}));if(report.failure)process.exitCode=1;}).catch(error=>{console.error(error instanceof Error?error.message:'REVIEWED_DEEP_STAGE_FAILED');process.exitCode=1;});}
