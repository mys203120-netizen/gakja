import assert from 'node:assert/strict';
import test from 'node:test';
import { materialActivityEvaluation, materialFactStatusLabel, materialInterviewHref, materialQuestionMatchesTarget, materialQuestionPracticeItems, materialQuizHref, publishedMaterialBooks } from '../apps/web/src/lib/material-learning-flow.ts';
import { eligibleQuizItems } from '../apps/web/src/lib/quiz-rules.ts';

const activity = {
  interview_priority: 'S', priority_reason: '공통 평가', talent_tags: ['탐구'], major_relevance: '공통 전공 연결',
  priority_assignments: [
    { support_target_id: 'seoul/environment', priority: 'A', reason: '환경공학 실험의 오차 분석', source_ref_ids: ['source-a'], talent_tags: ['융합'], major_relevance: '수질 분석', representative_candidate: true, representative_reason: '본인 역할이 구체적' },
    { support_target_id: 'busan/biology', priority: 'C', reason: '직접 전공 연결은 약함', source_ref_ids: ['source-b'], talent_tags: [], major_relevance: null, representative_candidate: false },
  ],
};
const question = { id: 'authored-question', verification_status: 'approved', support_target_ids: ['seoul/environment'] };
const choice = { id: 'memory:choice/id', kind: 'choice', question_id: question.id, verification_status: 'confirmed_from_record', evaluation_method: 'reviewed_correct_answer', options: [1,2,3,4].map(id=>({id:String(id),text:'검수된 보기 '+id})), correct_option_id: '2', category: 'concept', activity_ids: [], source_ref_ids: [], memory_keywords: [], prompt: '개념을 골라보세요.', answer_script_id: null };
const qa = { ...choice, id: 'memory:qa/id', kind: 'keyword_recall', evaluation_method: 'self_check', category: 'experiential' };

test('activity evaluation follows selected target without borrowing another target grade or reason',()=>{
  const selected=materialActivityEvaluation(activity,'seoul/environment');
  assert.equal(selected.priority,'A');assert.equal(selected.reason,'환경공학 실험의 오차 분석');
  assert.deepEqual(selected.sourceRefIds,['source-a']);assert.deepEqual(selected.talentTags,['융합']);
  assert.equal(selected.majorRelevance,'수질 분석');assert.equal(selected.representativeCandidate,true);
  const absent=materialActivityEvaluation(activity,'other-school');
  assert.equal(absent.priority,null);assert.equal(absent.reason,null);assert.deepEqual(absent.sourceRefIds,[]);
  assert.equal(materialActivityEvaluation(activity).priority,'S');
});

test('explicit no relation and no representative candidate are retained while legacy evaluations keep optional fallback fields',()=>{
  const selected=materialActivityEvaluation(activity,'busan/biology');
  assert.deepEqual(selected.talentTags,[]);assert.equal(selected.majorRelevance,null);assert.equal(selected.representativeCandidate,false);
  const legacy=materialActivityEvaluation({...activity,priority_assignments:[{support_target_id:'legacy',priority:'B',reason:'검수 사유'}]},'legacy');
  assert.deepEqual(legacy.talentTags,['탐구']);assert.equal(legacy.majorRelevance,'공통 전공 연결');
});

test('authored questions are scoped to the selected support target and general questions remain accessible',()=>{
  assert.equal(materialQuestionMatchesTarget(question,'seoul/environment'),true);
  assert.equal(materialQuestionMatchesTarget(question,'busan/biology'),false);
  assert.equal(materialQuestionMatchesTarget({...question,support_target_ids:[]},'busan/biology'),true);
  assert.equal(materialQuestionMatchesTarget(question),true);
});

test('practice links include only approved authored memory items for the actual question and target',()=>{
  const unrelated={...qa,id:'unrelated',question_id:'other-question'};
  assert.deepEqual(materialQuestionPracticeItems(question,[choice,qa,unrelated], 'seoul/environment').map(item=>item.id),[choice.id,qa.id]);
  assert.deepEqual(materialQuestionPracticeItems(question,[choice,qa], 'busan/biology'),[]);
  for(const status of ['needs_confirmation','student_says_different','cannot_confirm','unknown']){
    assert.deepEqual(materialQuestionPracticeItems({...question,verification_status:status},[choice,qa],'seoul/environment'),[]);
    assert.deepEqual(materialQuestionPracticeItems(question,[{...qa,verification_status:status}],'seoul/environment'),[]);
  }
});

test('UI practice availability matches server exclusions for malformed or experiential choices',()=>{
  for(const item of [choice,qa,{...choice,options:choice.options.slice(0,3)},{...choice,correct_option_id:'missing'},{...choice,options:[choice.options[0],...choice.options.slice(0,3)]},{...choice,category:'experiential'},{...choice,evaluation_method:'self_check'},{...qa,kind:'order'}]){
    const ui=materialQuestionPracticeItems(question,[item],'seoul/environment');
    const server=eligibleQuizItems({memory_items:[item],questions:[question],answer_designs:[],answer_scripts:[],source_refs:[]} as any,'answer');
    assert.equal(ui.length,server.length,JSON.stringify(item));
  }
});

test('quiz navigation selects exact authored memory identity even when choice practice has a separate concept identity',()=>{
  const url=new URL(materialQuizHref(choice,'seoul/environment',undefined,7),'http://localhost');
  assert.equal(url.pathname,'/quiz');assert.equal(url.searchParams.get('memoryItemId'),choice.id);
  assert.equal(url.searchParams.get('targetId'),'seoul/environment');assert.equal(url.searchParams.get('mode'),'choice');
  assert.equal(url.searchParams.get('sourceType'),'personal');assert.equal(url.searchParams.get('sourceVersion'),'7');
  assert.equal(url.searchParams.has('questionId'),false);
  const oral=new URL(materialQuizHref(qa,'seoul/environment','oral'),'http://localhost');
  assert.equal(oral.searchParams.get('mode'),'oral');assert.equal(oral.searchParams.get('memoryItemId'),qa.id);
});

test('interview navigation fixes authored question, support target and publication version',()=>{
  const url=new URL(materialInterviewHref('question:with/slash',{targetId:'target:with/slash',sourceVersion:7}),'http://localhost');
  assert.equal(url.pathname,'/interview/new');assert.equal(url.searchParams.get('questionId'),'question:with/slash');
  assert.equal(url.searchParams.get('targetId'),'target:with/slash');assert.equal(url.searchParams.get('sourceType'),'personal');assert.equal(url.searchParams.get('sourceVersion'),'7');
  assert.equal(url.searchParams.has('activityId'),false);
});

test('single guidebook publications never promote a missing handbook and legacy pairs retain both books',()=>{
  assert.deepEqual(publishedMaterialBooks([{kind:'guidebook'}]).map(book=>book.kind),['guidebook']);
  assert.deepEqual(publishedMaterialBooks([]),[]);
  assert.deepEqual(publishedMaterialBooks([{kind:'guidebook'},{kind:'handbook'}]).map(book=>book.kind),['guidebook','handbook']);
  assert.deepEqual(publishedMaterialBooks([{kind:'guidebook'},{kind:'memory_handbook'}]).map(book=>book.kind),['guidebook','handbook']);
});

test('all approved fact statuses are distinguished from confirmation required',()=>{
  for(const status of ['verified','approved','confirmed','synthetic_reviewed','confirmed_from_record','confirmed_by_student'])assert.notEqual(materialFactStatusLabel(status),'확인 필요');
  assert.equal(materialFactStatusLabel('needs_confirmation'),'확인 필요');assert.equal(materialFactStatusLabel('student_says_different'),'기록과 다름');
});
