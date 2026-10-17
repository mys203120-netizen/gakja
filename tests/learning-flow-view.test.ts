import {test} from 'node:test';
import assert from 'node:assert/strict';
import {practiceHelpLabel,questionPracticeState,todayQuestionContext} from '../apps/web/src/lib/learning-flow-view';
import {learningHref} from '../apps/web/src/lib/learning-journey';

const question={id:'q1'},target={id:'t1'};
const attempt={id:'attempt',question_id:'q1',target_id:'t1',script:'제 담당은 측정이었습니다.',created_at:'2026-10-14T06:00:00Z',content_version:6,revision_kind:'interview_answer'};
test('fresh answers exclude edits, STT corrections and another target or source version',()=>{
 const rows=[attempt,{...attempt,id:'edit',revision_kind:'answer_edit'},{...attempt,id:'stt',revision_kind:'transcript_correction'},{...attempt,id:'other-school',target_id:'t2'},{...attempt,id:'old-book',content_version:5}];
 const state=questionPracticeState(rows,question,target,6);
 assert.equal(state.attempts.length,1);assert.equal(state.canCompare,false);assert.equal(state.helpNotOpened.length,0);assert.equal(state.helpUnknown.length,1);
});
test('missing help history never becomes an independent recall record',()=>{
 for(const flag of ['assisted','hint_used','ai_assisted'])assert.equal(questionPracticeState([{...attempt,[flag]:true}],question,target,6).helpUsed.length,1);
 const explicit=questionPracticeState([{...attempt,assistance_recorded:true}],question,target,6);
 assert.equal(explicit.helpNotOpened.length,1);assert.equal(practiceHelpLabel(explicit.latest),'도움 조회 기록 없음');
 assert.equal(practiceHelpLabel(attempt),'도움 여부 미기록');
});
test('school questions cannot compare practice from a previous school revision',()=>{
 const common={...question,common_revision:3},rows=[{...attempt,target_snapshot:target,common_revision:2},{...attempt,id:'new',target_snapshot:target,common_revision:3}];
 assert.equal(questionPracticeState(rows,common,target).attempts.length,1);
});
test('common question state survives an unrelated guidebook version change but never changes reviewed question revision',()=>{
 const common={...question,common_revision:3,source_type:'verified_past'};
 const rows=[{...attempt,id:'old-common',target_snapshot:target,common_revision:1},{...attempt,id:'book-6',target_snapshot:target,common_revision:3,source_type:'common'},{...attempt,id:'book-7',target_snapshot:target,common_revision:3,source_type:'verified_past',content_version:7}];
 assert.deepEqual(questionPracticeState(rows,common,target).attempts.map(row=>row.id).sort(),['book-6','book-7']);
 assert.equal(questionPracticeState(rows,common,target,9).attempts.length,2);
});
test('common state connects one unambiguous omitted stage and keeps known stage changes separate',()=>{
 const identity={...target,university:'학교',department:'학과',campus:'본교',admission_year:2027,admission_type:'학생부종합'};
 const selected={...identity,interview_stage:'2단계'};
 const common={...question,common_revision:3};
 const unknown={...attempt,id:'unknown-stage',target_snapshot:identity,common_revision:3};
 assert.equal(questionPracticeState([unknown],common,selected).attempts.length,1);
 const first={...attempt,id:'first-stage',target_snapshot:{...identity,interview_stage:'1단계'},common_revision:3};
 assert.equal(questionPracticeState([unknown,first],common,selected).attempts.length,0);
 const second={...attempt,id:'second-stage',target_snapshot:{...identity,stage:'2차 면접'},common_revision:3};
 assert.deepEqual(questionPracticeState([unknown,first,second],common,selected).attempts.map(row=>row.id),['second-stage']);
});
test('owned legacy answers stay visible with missing context without becoming current-school readiness',()=>{
 const selected={...target,university:'서울시립대학교',department:'환경공학부',admission_year:2027};
 const state=questionPracticeState([attempt,{...attempt,id:'legacy-second'}],question,selected,6);
 assert.equal(state.attempts.length,2);assert.equal(state.helpUnknown.length,2);
 assert.equal(state.contextUnknown.length,2);assert.equal(state.canCompare,false);assert.equal(state.interviewSaved,false);
 assert.ok(practiceHelpLabel(state.latest).includes('지원처 세부 기준 미기록'));
 assert.equal(questionPracticeState([{...attempt,target_snapshot:{...selected,department:'다른학과'}}],question,selected,6).attempts.length,0);
 assert.equal(questionPracticeState([{...attempt,content_version:5}],question,selected,6).attempts.length,0);
});
test('flow links preserve a personal source and common revision separately',()=>{
 assert.match(learningHref('/my/today',todayQuestionContext(question,'t1',6)),/sourceType=personal&sourceVersion=6/);
 assert.match(learningHref('/my/today',todayQuestionContext({...question,common_revision:3},'t1',6)),/sourceType=common&sourceVersion=3/);
});
