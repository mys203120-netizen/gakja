import { createScopedEvaluationService } from '../../server/evaluation-writer/isolated-evaluation-service';
import { createEvaluationAdmissionCapability,createEvaluationReviewerCapability } from '../../server/db/postgres-evaluation-writer';
import { finiteAuthority } from '../evaluation-writer/evaluation-composition';
export function composeScopedEvaluation(options:Omit<Parameters<typeof createScopedEvaluationService>[0],'mintReviewer'|'mintAdmission'>){
 return createScopedEvaluationService({...options,mintReviewer(context,value){return createEvaluationReviewerCapability({...finiteAuthority(context,options.identity),issuer:context.principal.issuer,subject:context.principal.subject,actorId:value.actorId,publicKeySha256:value.publicKeySha256,action:value.action,expectedTrustGeneration:value.control.trustGeneration,...(value.sessionId?{sessionId:value.sessionId}:{})});},
 mintAdmission(context,input){return createEvaluationAdmissionCapability({...finiteAuthority(context,options.identity),sessionId:input.sessionId,inputSha256:input.inputSha256,handoffIntentId:input.handoffIntentId,handoffPayloadSha256:input.handoffPayloadSha256});}});
}
