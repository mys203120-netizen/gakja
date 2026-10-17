import assert from 'node:assert/strict';
import test from 'node:test';
import { learningTargetIdentityMatches, schoolProfileIdentityMatches } from '../packages/content-contracts/src/workflows';

const target={university:'서울시립대학교',campus:'본교',department:'환경공학부',admission_year:2027,admission_type:'학생부종합전형Ⅰ(면접형)',interview_stage:'2단계'};
test('an absent old learning stage does not invent a target change while official profile matching stays strict',()=>{
  const old={...target,interview_stage:undefined};
  assert.equal(learningTargetIdentityMatches(old,target),true);
  assert.equal(learningTargetIdentityMatches(target,old),true);
  assert.equal(schoolProfileIdentityMatches(old,target),false);
  for(const stage of [null,'','미정','확인 필요','unknown'])assert.equal(learningTargetIdentityMatches({...target,interview_stage:stage},target),true);
});
test('every known identity mismatch remains a different learning context',()=>{
  for(const key of ['university','campus','department','admission_year','admission_type','interview_stage']){
    assert.equal(learningTargetIdentityMatches({...target,[key]:key==='admission_year'?2028:'다른 값'},target),false,key);
    assert.equal(learningTargetIdentityMatches(target,{...target,[key]:key==='admission_year'?2028:'다른 값'}),false,key);
  }
  for(const key of ['university','campus','department','admission_year','admission_type'])assert.equal(learningTargetIdentityMatches({...target,[key]:undefined},target),false,key);
  assert.equal(learningTargetIdentityMatches({...target,interview_stage:undefined,stage:'1단계'},target),false);
});
