import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export interface ShadowEffects {privateFileReads:number;databaseReads:number;storageReads:number;writes:number;aiProviderCalls:number;payloadReturned:boolean}
export interface ShadowObservation {
  ok:boolean;value?:unknown;errorCode?:string;availability:'present'|'known-absent'|'failed'|'indeterminate';
  rawArtifacts:readonly{role:string;reference:string;sizeBytes:number;sha256:string}[];
  effects:ShadowEffects;selectedRevision?:string;generation?:string;
}
export type ShadowComparisonExpectation='equivalent-success'|'equivalent-domain-refusal'|'authority-refusal'|'snapshot-refusal'|'confirmed-absent'|'indeterminate';
export interface ProvenanceComparisonRule {
  /** Exact JSON pointer, never an unrestricted payload/path rewriter. */
  path:string;kind:'native-separator-provenance';reason:string;
}
export interface ShadowComparisonCase {caseId:string;expectation:ShadowComparisonExpectation;rules?:readonly ProvenanceComparisonRule[];privateReport?:boolean;expectedCandidateErrorCodes?:readonly string[]}
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const digest=(v:unknown)=>sha(JSON.stringify(v,(_k,value)=>Buffer.isBuffer(value)?{bytes:value.length,sha256:createHash('sha256').update(value).digest('hex')}:value)??'undefined');
function pointer(path:string,key:string){return path+'/'+key.replaceAll('~','~0').replaceAll('/','~1');}
function observed(value:ShadowObservation) {
  if(!value||!Array.isArray(value.rawArtifacts)||!['present','known-absent','failed','indeterminate'].includes(value.availability)||
    !value.effects||!['privateFileReads','databaseReads','storageReads','writes','aiProviderCalls'].every(k=>Number.isSafeInteger(Reflect.get(value.effects,k))&&Reflect.get(value.effects,k)>=0))throw new Error('SHADOW_OBSERVATION_INVALID');
}
/** Compare already independent executions. Common canonical codecs are allowed;
 * neither expected values nor a shared path translator are produced here. */
export function compareShadowObservations(config:ShadowComparisonCase,baseline:ShadowObservation,candidate:ShadowObservation) {
  observed(baseline);observed(candidate);
  const allowed:{path:string;reason:string;baseline:unknown;candidate:unknown}[]=[],differences:{path:string;kind:string;baselineSha256:string;candidateSha256:string}[]=[];
  for(const rule of config.rules??[])if(rule.kind!=='native-separator-provenance'||!/^\/(?:[^/]+\/)*(?:revisionPath|manifestPath|provenancePath)$/u.test(rule.path)||!rule.reason)throw new Error('SHADOW_COMPARISON_RULE_INVALID');
  const diff=(path:string,kind:string,a:unknown,b:unknown)=>{if(differences.length<100)differences.push({path:config.privateReport?sha(path):path,kind,baselineSha256:digest(a),candidateSha256:digest(b)});};
  function equal(a:unknown,b:unknown,path=''):boolean {
    if(isDeepStrictEqual(a,b))return true;
    const rule=config.rules?.find(r=>r.path===path);
    if(rule&&typeof a==='string'&&typeof b==='string'&&a.replaceAll('\\','/')===b.replaceAll('\\','/')) {
      allowed.push({path,reason:rule.reason,baseline:config.privateReport?{sha256:sha(a)}:a,candidate:config.privateReport?{sha256:sha(b)}:b});return true;
    }
    if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Buffer.isBuffer(a)&&!Buffer.isBuffer(b)&&Array.isArray(a)===Array.isArray(b)) {
      const ak=Object.keys(a),bk=Object.keys(b);let result=true;
      if(ak.length!==bk.length||ak.some(k=>!Object.hasOwn(b,k))){diff(path,'own-fields',ak,bk);result=false;}
      for(const k of ak)if(Object.hasOwn(b,k)&&!equal(Reflect.get(a,k),Reflect.get(b,k),pointer(path,k)))result=false;
      return result;
    }
    diff(path,'exact-value',a,b);return false;
  }
  const sideEffectsSafe=baseline.effects.writes===0&&candidate.effects.writes===0&&baseline.effects.aiProviderCalls===0&&candidate.effects.aiProviderCalls===0;
  let passed=false,equivalence:'equal'|'different'|'not-applicable'|'indeterminate'='different';
  switch(config.expectation) {
    case 'equivalent-success': {
      const values=baseline.ok&&candidate.ok&&baseline.availability==='present'&&candidate.availability==='present'&&baseline.value!=null&&candidate.value!=null&&
        baseline.effects.payloadReturned&&candidate.effects.payloadReturned&&equal(baseline.value,candidate.value);
      const raw=equal(baseline.rawArtifacts,candidate.rawArtifacts,'/rawArtifacts');
      passed=values&&raw&&baseline.selectedRevision===candidate.selectedRevision&&candidate.effects.privateFileReads===0&&candidate.effects.databaseReads>0&&candidate.effects.storageReads>0&&sideEffectsSafe;
      equivalence=passed?'equal':'different';break;
    }
    case 'equivalent-domain-refusal':
      passed=!baseline.ok&&!candidate.ok&&Boolean(baseline.errorCode)&&baseline.errorCode===candidate.errorCode&&!candidate.effects.payloadReturned&&sideEffectsSafe;
      equivalence=passed?'equal':'different';break;
    case 'authority-refusal':case 'snapshot-refusal':
      // The old local development mode is not an authentication oracle. These
      // are intentional stricter refusals, not a fabricated equality success.
      passed=!candidate.ok&&Boolean(candidate.errorCode)&&Boolean(config.expectedCandidateErrorCodes?.includes(candidate.errorCode!))&&!candidate.effects.payloadReturned&&candidate.effects.privateFileReads===0&&
        (config.expectation!=='authority-refusal'||candidate.effects.storageReads===0)&&sideEffectsSafe;
      equivalence='not-applicable';break;
    case 'confirmed-absent':
      passed=baseline.ok&&candidate.ok&&baseline.availability==='known-absent'&&candidate.availability==='known-absent'&&
        baseline.value==null&&candidate.value==null&&candidate.effects.privateFileReads===0&&sideEffectsSafe;
      equivalence=passed?'equal':'different';break;
    case 'indeterminate':equivalence='indeterminate';break;
  }
  if(baseline.availability==='indeterminate'||candidate.availability==='indeterminate'){passed=false;equivalence='indeterminate';}
  return {version:'independent-shadow-comparison-v1',caseId:config.caseId,expectation:config.expectation,passed,equivalence,
    baseline:{ok:baseline.ok,errorCode:baseline.errorCode,availability:baseline.availability,valueSha256:digest(baseline.value),effects:baseline.effects,selectedRevision:baseline.selectedRevision},
    candidate:{ok:candidate.ok,errorCode:candidate.errorCode,availability:candidate.availability,valueSha256:digest(candidate.value),effects:candidate.effects,selectedRevision:candidate.selectedRevision},
    differences,allowedProvenanceDifferences:allowed,normalEqualityCount:passed&&equivalence==='equal'&&config.expectation==='equivalent-success'?1:0};
}
export async function runIndependentShadow(config:ShadowComparisonCase,baseline:()=>Promise<ShadowObservation>,candidate:()=>Promise<ShadowObservation>) {
  const [left,right]=await Promise.allSettled([baseline(),candidate()]);
  if(left.status!=='fulfilled'||right.status!=='fulfilled')throw new Error('SHADOW_EXECUTION_OBSERVATION_REQUIRED');
  return compareShadowObservations(config,left.value,right.value);
}
