import assert from 'node:assert/strict';
import { test } from 'node:test';
import { choiceExplanationPrompt, eligibleQuizItems, firstSentenceHint, quizOutcome, quizPracticeIdentity, remainingChoiceMs } from '../apps/web/src/lib/quiz-rules';
import { createDemoPack,validatePair } from '../packages/content-contracts/src/index';
const base:any={id:'m1',kind:'choice',question_id:'q1',answer_script_id:null,activity_ids:[],source_ref_ids:[],prompt:'검증용 질문',memory_keywords:['검증'],default_time_limit_seconds:10,evaluation_method:'reviewed_correct_answer',verification_status:'confirmed_from_record',options:[1,2,3,4].map(n=>({id:String(n),text:`검증 보기 ${n}`})),correct_option_id:'2'};
const learning:any={memory_items:[base],questions:[{id:'q1',answer_elements:['검증']}],answer_designs:[],source_refs:[],answer_scripts:[]};
test('only four approved distinct choices are eligible',()=>{assert.equal(eligibleQuizItems(learning,'choice').length,1);for(const bad of [{options:base.options.slice(0,3)},{correct_option_id:'missing'},{verification_status:'needs_confirmation'},{category:'experiential'},{options:[base.options[0],...base.options.slice(0,3)]}])assert.equal(eligibleQuizItems({...learning,memory_items:[{...base,...bad}]},'choice').length,0);});
test('first sentence hint preserves reviewed text and separates remainder',()=>{assert.deepEqual(firstSentenceHint('첫 문장입니다. 두 번째 문장입니다.\n세 번째.'),{first:'첫 문장입니다.',rest:'두 번째 문장입니다.\n세 번째.'});assert.deepEqual(firstSentenceHint('한 줄 답변'),{first:'한 줄 답변',rest:''});assert.deepEqual(firstSentenceHint('첫 줄\n둘째 줄'),{first:'첫 줄',rest:'둘째 줄'});});
test('deadline uses server timestamp with a fixed ten-second ceiling',()=>{assert.equal(remainingChoiceMs(new Date(10500),1000),9500);assert.equal(remainingChoiceMs(new Date(10500),11000),0);assert.equal(remainingChoiceMs(new Date(60000),1000),10000);assert.equal(remainingChoiceMs(null,1000,4500),4500);});
test('timeout is wrong while oral and personal Q&A are never guessed as correct',()=>{const item=eligibleQuizItems(learning,'choice')[0];assert.equal(quizOutcome(item,'choice','', '2',false),true);assert.equal(quizOutcome(item,'choice','','2',true),false);assert.equal(quizOutcome(item,'oral','답변',null,false),null);const short:any={...item,kind:'short_answer',category:'factual',accepted_answers:['미세 플라스틱']};assert.equal(quizOutcome(short,'answer','미세플라스틱',null,false),true);assert.equal(quizOutcome({...short,category:'experiential'},'answer','미세플라스틱',null,false),null);});
test('unverified items cannot leak fallback or approved-script hints in Q&A or oral',()=>{
  for(const mode of ['answer','oral'] as const)for(const verification_status of ['needs_confirmation','student_says_different','cannot_confirm','unknown']) {
    const item={...base,kind:'short_answer',verification_status,answer_script_id:'script1',back:'미확인 뒷면',accepted_answers:['미확인 정답']};
    const script={id:'script1',question_id:'q1',verification_status:'approved',text:'승인된 다른 답변',claims:[]};
    assert.equal(eligibleQuizItems({...learning,memory_items:[item],answer_scripts:[script]},mode).length,0);
  }
});
test('a disputed/missing linked script suppresses every fallback; verified script has precedence',()=>{
  const item={...base,kind:'short_answer',answer_script_id:'script1',back:'뒷면 답변',accepted_answers:['단답 정답']};
  const script={id:'script1',question_id:'q1',verification_status:'approved',text:'검수된 발화본 첫 문장. 다음 문장.',claims:[]};
  for(const mode of ['answer','oral'] as const) {
    assert.equal(eligibleQuizItems({...learning,memory_items:[item],answer_scripts:[script]},mode)[0].modelAnswer,script.text);
    for(const verification_status of ['needs_confirmation','student_says_different','cannot_confirm','unknown'])assert.equal(eligibleQuizItems({...learning,memory_items:[item],answer_scripts:[{...script,verification_status}]},mode)[0].modelAnswer,'');
    assert.equal(eligibleQuizItems({...learning,memory_items:[item],answer_scripts:[]},mode)[0].modelAnswer,'');
    assert.equal(eligibleQuizItems({...learning,memory_items:[item],answer_scripts:[{...script,question_id:'different-question'}]},mode)[0].modelAnswer,'');
    for(const statusKey of ['verification_status','confirmation_status'])assert.equal(eligibleQuizItems({...learning,memory_items:[item],answer_scripts:[{...script,claims:[{[statusKey]:'needs_confirmation'}]}]},mode)[0].modelAnswer,'');
    assert.equal(eligibleQuizItems({...learning,memory_items:[{...item,answer_script_id:null}],answer_scripts:[]},mode)[0].modelAnswer,'뒷면 답변');
    assert.equal(eligibleQuizItems({...learning,memory_items:[{...item,answer_script_id:null,back:undefined}],answer_scripts:[]},mode)[0].modelAnswer,'단답 정답');
  }
});
test('reviewed choices can be explained orally or in writing without inventing an ideal personal answer or correctness',()=>{
  for(const mode of ['answer','oral'] as const){const item=eligibleQuizItems(learning,mode)[0];assert.equal(item.id,base.id);assert.equal(item.modelAnswer,'검증 보기 2');assert.equal(quizOutcome(item,mode,'검증 보기 2',null,false),null);}
  assert.equal(choiceExplanationPrompt('흡착을 설명하는 문장을 골라보세요.'),'흡착을 내 말로 설명해 주세요.');
  assert.equal(choiceExplanationPrompt('측정 실험에서 변인을 바꾸는 방법으로 알맞은 것은?'),'측정 실험에서 변인을 바꾸는 방법을 내 말로 설명해 주세요.');
  for(const mode of ['answer','oral'] as const)assert.equal(eligibleQuizItems({...learning,memory_items:[{...base,options:base.options.slice(0,3)}]},mode).length,0);
});
test('legacy concept explanations cannot inherit an unrelated personal question identity or rubric',()=>{
  const concept:any={...base,prompt:'흡착을 설명하는 문장을 골라보세요.'},personal={id:'q1',prompt:'팀원과 의견이 달랐을 때 어떤 행동을 했나요?',question_types:['community'],verification_status:'approved',answer_elements:['본인 역할','협업']};
  const item=eligibleQuizItems({...learning,memory_items:[concept],questions:[personal]},'answer')[0];
  assert.equal(item.question_id,'concept:m1');assert.equal(item.linked_question_id,'q1');assert.equal(item.practice_kind,'concept');assert.equal(item.prompt,'흡착을 내 말로 설명해 주세요.');assert.deepEqual(item.required_meaning_elements,[]);
  assert.equal(quizPracticeIdentity({...item,practice_kind:undefined,practice_question_id:undefined,question_id:'q1'}).questionId,'concept:m1');
});
test('new demo definitions have dedicated grounded question identities and matching meaning elements',()=>{
  for(const track of ['environment','biology'] as const){
    const pair=createDemoPack('semantic-student','개념 확인',track);validatePair(pair,{studentId:'semantic-student',productionJobRef:pair[0].production_job_ref,registeredTargetIds:pair[0].learning_data.support_targets.map(target=>target.id)});
    const data=pair[0].learning_data;assert.equal(data.questions.length,15);assert.equal(data.answer_scripts.length,12);
    for(const item of eligibleQuizItems(data,'answer').filter(item=>item.kind==='choice')){const question=data.questions.find(question=>question.id===item.question_id)!;assert.ok(question.question_types.includes('concept'));assert.equal(item.prompt,question.prompt);assert.deepEqual(item.required_meaning_elements,item.memory_keywords);assert.deepEqual(item.activity_ids,question.activity_ids);assert.ok(!['본인 역할','핵심 목표','협업'].some(element=>item.required_meaning_elements.includes(element)));assert.equal(item.linked_question_id,null);}
    assert.equal(data.questions.find(question=>question.id==='semantic-student-q-7')?.prompt,'팀원과 의견이 달랐을 때 어떤 행동으로 문제를 풀었나요?');
  }
});
