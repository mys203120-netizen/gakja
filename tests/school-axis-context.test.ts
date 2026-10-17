import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nextUnappliedQuestion} from '../apps/web/src/lib/next-learning-question';
import {buildContentGrowth,growthContextKey} from '../apps/web/src/lib/learning-growth';
import {chooseTodayAction} from '../apps/web/src/lib/learning-journey';
const target={university:'학교 A',department_catalog_id:'dept-a',campus:'본교',admission_year:2027,admission_type:'학생부종합'};
const version={id:'first',question_id:'same-common',question:'협업을 어떻게 생각하나요?',script:'공동체의 일을 함께했습니다.',created_at:'2026-10-12',target_id:'target-a',target_snapshot:target,common_revision:1};
const after={...version,id:'next',script:'저는 기록을 맡았습니다. 측정 조건을 3회 비교했습니다.',created_at:'2026-10-13'};
const quiz={kind:'quiz_response',created_at:'2026-10-12',data:{questionId:version.question_id,response:version.script,target_id:'target-a',target_snapshot:target,common_revision:1}};
const interview={kind:'interview_answer',created_at:'2026-10-13',data:{questionId:version.question_id,answer:after.script,targetId:'target-a',targetSnapshot:target,commonRevision:1}};
test('matching source and school context connects quiz to interview across storage naming',()=>assert.equal(nextUnappliedQuestion([quiz,interview]),null));
test('same common question at another school does not finish this school practice',()=>assert.equal(nextUnappliedQuestion([quiz,{...interview,data:{...interview.data,targetId:'target-b'}}]),quiz));
test('same target after a major change does not finish the earlier major practice',()=>assert.equal(nextUnappliedQuestion([quiz,{...interview,data:{...interview.data,targetSnapshot:{...target,department_catalog_id:'dept-b'}}}]),quiz));
test('different official source revision is not the same completed application',()=>assert.equal(nextUnappliedQuestion([quiz,{...interview,data:{...interview.data,commonRevision:2}}]),quiz));
test('content growth compares actual Q&A and interview in the same school context',()=>assert.equal(buildContentGrowth([{...version,practice_kind:'personal',revision_kind:'quiz_answer'},{...after,revision_kind:'interview_answer'}]).comparisons.length,1));
test('same question ID across schools is not counted as content growth',()=>assert.equal(buildContentGrowth([version,{...after,target_id:'target-b'}]).comparisons.length,0));
test('a reused target ID with different major or source revision forms separate baselines',()=>{
  for(const changed of [{...after,target_snapshot:{...target,department_catalog_id:'dept-b'}},{...after,common_revision:2}])assert.equal(buildContentGrowth([version,changed]).comparisons.length,0);
  assert.equal(buildContentGrowth([{...version,target_snapshot:{...target,interview_stage:'1단계'}},{...after,target_snapshot:{...target,interview_stage:'2단계'}}]).comparisons.length,0);
  assert.notEqual(growthContextKey(version),growthContextKey({...version,target_snapshot:{...target,campus:'다른 캠퍼스'}}));
});
test('selected school dashboard does not link a pending answer from another school',()=>{
  const action=chooseTodayAction({targets:[{id:'target-b'}],hasPackage:false,study:{nextQuestion:{questionId:'from-a',targetId:'target-a'}},commonQuestions:[{id:'from-b'}]});
  assert.equal(action.questionId,'from-b');assert.match(action.href,/targetId=target-b/);
});
