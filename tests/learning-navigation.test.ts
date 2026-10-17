import assert from 'node:assert/strict';
import test from 'node:test';
import { learningRetryHref } from '../apps/web/src/lib/learning-navigation.ts';
import { interviewPreviewHref, interviewSetupState } from '../apps/web/src/lib/interview-flow.ts';
import { studyAnswerComparisonHref, studyWeakPointHref } from '../apps/web/src/lib/study-record-links.ts';

const briefingId='90bdbba7-789b-4d4e-a5a0-ffb52c1c809c';
const parse=(questionId:string,version:Record<string,unknown>={})=>new URL(learningRetryHref(questionId,version),'http://localhost:3100');

test('a saved briefing retry resolves the exact briefing and question index through setup and preview',()=>{
  for(let index=0;index<=10;index++){
    const retry=parse(`briefing_${briefingId}_${index}`,{target_id:'owned/old target',content_version:2,source_type:'personal'});
    assert.equal(retry.pathname,'/interview/new');
    assert.equal(retry.searchParams.get('briefingId'),briefingId);
    assert.equal(retry.searchParams.get('briefingQuestionIndex'),String(index));
    assert.equal(retry.searchParams.get('targetId'),'owned/old target');
    assert.equal(retry.searchParams.get('sourceVersion'),'2');
    assert.equal(retry.searchParams.has('questionId'),false);
    assert.equal(retry.searchParams.has('sourceType'),false);
    assert.equal(interviewSetupState(retry.searchParams).count,1);
    const preview=new URL(interviewPreviewHref(retry.searchParams,'owned/old target'),'http://localhost:3100');
    assert.equal(preview.searchParams.get('briefingId'),briefingId);
    assert.equal(preview.searchParams.get('briefingQuestionIndex'),String(index));
    assert.equal(preview.searchParams.get('sourceVersion'),'2');
    assert.equal(preview.searchParams.has('questionId'),false);
  }
});

test('malformed or unrelated identities never become a briefing selection',()=>{
  for(const id of [
    'briefing_not-a-uuid_0',`briefing_${briefingId}_-1`,`briefing_${briefingId}_11`,
    `briefing_${briefingId}_01`,`briefing_${briefingId}_1.0`,`briefing_${briefingId}_0_extra`,
    `prefix_briefing_${briefingId}_0`,'briefing_90bdbba7-789b-0d4e-a5a0-ffb52c1c809c_0',
    'briefing_90bdbba7-789b-4d4e-75a0-ffb52c1c809c_0',
  ]){
    const retry=parse(id,{content_version:2,source_type:'personal'});
    assert.equal(retry.searchParams.has('briefingId'),false);
    assert.equal(retry.searchParams.get('questionId'),id);
  }
});

test('personal, common, and concept retries retain their existing source identities',()=>{
  assert.equal(learningRetryHref('my_question',{target_id:'owned-old',content_version:2,source_type:'personal'}),'/interview/new?questionId=my_question&targetId=owned-old&sourceType=personal&sourceVersion=2');
  assert.equal(learningRetryHref('bible_saved_general_1',{target_id:'owned-old',source_type:'book_reference',common_revision:3}),'/interview/new?questionId=bible_saved_general_1&targetId=owned-old&sourceType=common&sourceVersion=3');
  assert.equal(learningRetryHref('concept:memory:id',{practice_kind:'concept',memory_item_id:'memory:id'}),'/quiz?memoryItemId=memory%3Aid&mode=answer');
});

test('briefing practice without a personal publication does not invent a personal source version',()=>{
  const retry=parse(`briefing_${briefingId}_0`,{target_id:'owned-target',source_kind:'common',content_version:1,common_revision:3});
  assert.equal(retry.searchParams.get('targetId'),'owned-target');
  assert.equal(retry.searchParams.has('sourceVersion'),false);
  assert.equal(retry.searchParams.has('sourceType'),false);
  assert.equal(retry.searchParams.has('questionId'),false);
});

test('study history comparisons keep the saved school and common revision independently of guidebook versions',()=>{
  const record={target_id:'saved-school',source_type:'school_talent',common_revision:3,contentVersion:8};
  const href=new URL(studyAnswerComparisonHref('common_motivation',record,'saved-turn'),'http://localhost');
  assert.equal(href.pathname,'/records/comparisons/common_motivation');
  assert.equal(href.searchParams.get('targetId'),'saved-school');
  assert.equal(href.searchParams.get('sourceType'),'common');
  assert.equal(href.searchParams.get('sourceVersion'),'3');
  assert.equal(href.searchParams.get('turnId'),'saved-turn');
});

test('weak-point retries preserve both event naming conventions and the original personal publication',()=>{
  const common=new URL(studyWeakPointHref({memoryItemId:'school:memory',targetId:'saved-school',sourceType:'general_practice',commonRevision:4,contentVersion:8}),'http://localhost');
  assert.equal(common.searchParams.get('memoryItemId'),'school:memory');
  assert.equal(common.searchParams.get('targetId'),'saved-school');
  assert.equal(common.searchParams.get('sourceType'),'common');
  assert.equal(common.searchParams.get('sourceVersion'),'4');
  const personal=new URL(studyWeakPointHref({questionId:'owned-question',target_snapshot:{id:'old-school'},source_type:'personal',content_version:6}),'http://localhost');
  assert.equal(personal.searchParams.get('questionId'),'owned-question');
  assert.equal(personal.searchParams.get('targetId'),'old-school');
  assert.equal(personal.searchParams.get('sourceType'),'personal');
  assert.equal(personal.searchParams.get('sourceVersion'),'6');
});

test('legacy study links never invent the current school or borrow a personal version for a common question',()=>{
  assert.equal(studyAnswerComparisonHref('legacy-question',{}),'/records/comparisons/legacy-question');
  assert.equal(studyWeakPointHref({memoryItemId:'legacy-memory'}),'/quiz?memoryItemId=legacy-memory');
  assert.equal(studyWeakPointHref({}),'/quiz');
  const common=new URL(studyWeakPointHref({questionId:'common_motivation',sourceKind:'common',contentVersion:8}),'http://localhost');
  assert.equal(common.searchParams.get('sourceType'),'common');
  assert.equal(common.searchParams.has('sourceVersion'),false);
});
