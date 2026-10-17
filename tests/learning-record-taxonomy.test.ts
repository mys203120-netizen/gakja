import assert from 'node:assert/strict';
import {test} from 'node:test';
import {quizAnswerContext} from '../apps/web/src/lib/learning-record-rules';
import {buildContentGrowth} from '../apps/web/src/lib/learning-growth';

const concept={id:'reviewed-concept',prompt:'대조 조건의 역할은 무엇인가요?',question_types:['concept','major'],verification_status:'approved'};
const task={id:'report-recall',question_id:concept.id,kind:'short_speech',category:'experiential',prompt:concept.prompt,question_snapshot:concept};
const source={questions:[concept]} as any;

test('existing report speaking task recovers reviewed concept identity from its frozen question',()=>{
  const before=JSON.stringify(task);
  assert.deepEqual(quizAnswerContext(task),{practice_kind:'concept',question_id:concept.id,linked_question_id:null,question:concept.prompt});
  assert.equal(JSON.stringify(task),before,'reading never rewrites the stored task');
});

test('archived reviewed question restores a legacy task without a question snapshot',()=>{
  const {question_snapshot:_,...legacy}=task;
  assert.equal(quizAnswerContext(legacy,{},source).practice_kind,'concept');
  assert.equal(quizAnswerContext(legacy,{},source).question_id,concept.id);
});

test('a frozen unreviewed or personal question cannot borrow a different classification',()=>{
  for(const verification_status of ['draft','needs_confirmation','rejected',undefined]) {
    const frozen={...task,question_snapshot:{...concept,verification_status}};
    assert.equal(quizAnswerContext(frozen,{},source).practice_kind,'personal');
  }
  assert.equal(quizAnswerContext({...task,question_snapshot:{...concept,question_types:['activity']}},{},source).practice_kind,'personal');
});

test('item category and mismatched snapshot or response IDs cannot manufacture a concept identity',()=>{
  const unreviewed={...task,category:'concept',question_snapshot:undefined};
  assert.equal(quizAnswerContext(unreviewed).practice_kind,'personal');
  assert.equal(quizAnswerContext({...unreviewed,question_snapshot:{...concept,id:'another-question'}}).practice_kind,'personal');
  assert.equal(quizAnswerContext(task,{question_id:'another-question'}).practice_kind,'personal');
});

test('legacy unrelated choice explanation still has its own separate concept question',()=>{
  const identity=quizAnswerContext({id:'old-choice',kind:'choice',question_id:'personal-question',prompt:'흡착을 설명하는 문장을 골라보세요.'},{},{questions:[{id:'personal-question',question_types:['activity']}]} as any);
  assert.equal(identity.question_id,'concept:old-choice');
  assert.equal(identity.linked_question_id,'personal-question');
});

test('quiz, mock interview, and already saved speaking task join one comparison without changing records',()=>{
  const target={university:'검증대학교',campus:'본교',department:'환경공학부',admission_year:2027,admission_type:'면접형'};
  const shared={question_id:concept.id,question:concept.prompt,target_id:'owned-target',target_snapshot:target,source_type:'personal',content_version:6};
  const history=[
    {...shared,id:'quiz-answer',practice_kind:'concept',revision_kind:'quiz_answer',script:'대조 조건은 비교 기준입니다.',created_at:'2026-10-15T10:00:00Z'},
    {...shared,id:'mock-answer',practice_kind:'concept',revision_kind:'interview_answer',script:'바꾸는 변인 외 조건을 맞춰 비교합니다.',created_at:'2026-10-15T10:01:00Z'},
    {...shared,...quizAnswerContext(task),id:'saved-task-answer',revision_kind:'assignment_answer',script:'조건을 맞추고 반복 측정으로 오차도 확인해야 합니다.',created_at:'2026-10-15T10:02:00Z'},
  ];
  const before=JSON.stringify(history),growth=buildContentGrowth(history);
  assert.equal(growth.comparisons.length,1);
  assert.equal(growth.comparisons[0].before.id,'quiz-answer');
  assert.equal(growth.comparisons[0].after.id,'saved-task-answer');
  assert.equal(growth.unpaired.length,0);
  assert.equal(JSON.stringify(history),before);
  assert.equal(buildContentGrowth([...history,{...history[2],id:'different-version',content_version:7}]).unpaired[0].version.id,'different-version');
});
