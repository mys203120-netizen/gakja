import test from 'node:test';
import assert from 'node:assert/strict';
import { compareShadowObservations,type ShadowObservation } from '../../server/shadow/shadow-compare';
function observation(local:boolean,value:unknown):ShadowObservation{return {ok:true,value,availability:'present',rawArtifacts:[{role:'raw',reference:'same.json',sizeBytes:1,sha256:'a'.repeat(64)}],effects:{privateFileReads:local?1:0,databaseReads:local?0:1,storageReads:local?0:1,writes:0,aiProviderCalls:0,payloadReturned:true}};}
test('D comparison requires a positive independent candidate and exact IDs/quotes/raw pins',()=>{
  const baseline=observation(true,{ids:['id-1'],quote:'한글🙂',nullable:null}),candidate=observation(false,{ids:['id-1'],quote:'한글🙂',nullable:null});
  assert.equal(compareShadowObservations({caseId:'normal',expectation:'equivalent-success'},baseline,candidate).passed,true);
  const bad=structuredClone(candidate);bad.value={ids:['changed'],quote:'한글🙂',nullable:null};assert.equal(compareShadowObservations({caseId:'id',expectation:'equivalent-success'},baseline,bad).passed,false);
  const fallback=structuredClone(candidate);fallback.effects.privateFileReads=1;assert.equal(compareShadowObservations({caseId:'fallback',expectation:'equivalent-success'},baseline,fallback).passed,false);
  const compare=(a:unknown,b:unknown)=>compareShadowObservations({caseId:'own-array-value',expectation:'equivalent-success'},observation(true,a),observation(false,b)).passed;
  const sparse=[1];sparse.length=2;assert.equal(compare([1],sparse),false);
  assert.equal(compare(new Date('2026-01-01'),new Date('2026-01-02')),false);
});
test('D comparison permits only declared native-separator display differences and retains both originals',()=>{
  const baseline=observation(true,{staged:{revisionPath:'archive\\r1\\analysis.json'},hash:'hash'}),candidate=observation(false,{staged:{revisionPath:'archive/r1/analysis.json'},hash:'hash'});
  const result=compareShadowObservations({caseId:'display',expectation:'equivalent-success',rules:[{path:'/staged/revisionPath',kind:'native-separator-provenance',reason:'C Windows display only'}]},baseline,candidate);
  assert.equal(result.passed,true);assert.equal(result.allowedProvenanceDifferences.length,1);assert.equal(result.allowedProvenanceDifferences[0].baseline,'archive\\r1\\analysis.json');
  assert.throws(()=>compareShadowObservations({caseId:'hash-rewrite',expectation:'equivalent-success',rules:[{path:'/hash',kind:'native-separator-provenance',reason:'bad'}]},baseline,candidate));
});
test('D comparison keeps authority refusal and indeterminate local null separate from equality',()=>{
  const baseline=observation(true,{value:1}),denied:ShadowObservation={...observation(false,undefined),ok:false,errorCode:'ACCESS_DENIED',availability:'failed',effects:{privateFileReads:0,databaseReads:1,storageReads:0,writes:0,aiProviderCalls:0,payloadReturned:false}};
  const r=compareShadowObservations({caseId:'cross-owner',expectation:'authority-refusal',expectedCandidateErrorCodes:['ACCESS_DENIED']},baseline,denied);
  assert.equal(r.passed,true);assert.equal(r.equivalence,'not-applicable');assert.equal(r.normalEqualityCount,0);
  assert.equal(compareShadowObservations({caseId:'infra-not-auth',expectation:'authority-refusal',expectedCandidateErrorCodes:['ACCESS_DENIED']},baseline,{...denied,errorCode:'DB_UNAVAILABLE'}).passed,false);
  assert.equal(compareShadowObservations({caseId:'unknown-null',expectation:'confirmed-absent'},{...baseline,value:null,availability:'indeterminate'},{...denied,ok:true,value:null,availability:'known-absent'}).passed,false);
});
