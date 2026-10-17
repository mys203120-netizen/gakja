import test from 'node:test';
import assert from 'node:assert/strict';
import {learningRetryHref} from '../apps/web/src/lib/learning-navigation';
import {interviewSetupHref,interviewPreviewHref} from '../apps/web/src/lib/interview-flow';
import {validateArmorySuggestion} from '../apps/web/src/lib/armory-assistance';
import {focusTraining} from '../apps/web/src/lib/focus-training';
const school={id:'korea',university:'고려대학교',campus:'본교',department:'경영학과',admission_type:'종합',admission_year:2027};
test('card and revision survive report retry, Chat/Live and preview without advancing to latest',()=>{
  for(const question of ['common_collaboration','personal_question','briefing_12345678-1234-4123-8123-123456789012_0']){
    const href=learningRetryHref(question,{target_id:school.id,content_version:4,common_revision:2,experience_card:{id:'card-owned',revision:3}});
    const params=new URL(href,'http://local').searchParams;
    for(const path of [href,interviewSetupHref('video',params),interviewPreviewHref(params,school.id)]){
      const url=new URL(path,'http://local');assert.equal(url.searchParams.get('experienceCardId'),'card-owned');assert.equal(url.searchParams.get('experienceRevision'),'3');assert.equal(url.searchParams.get('targetId'),school.id);
    }
  }
});
const experience={title:'팀 경험',category:'협업' as const,situation:'팀 의견이 달랐다.',action:'나는 의견을 표로 정리했다.',result:'공통 목표를 정했다.',confirmed:true,pinned:false,sourceNote:'학생 작성'};
const suggestion={sections:{situation:[experience.situation],action:[experience.action],result:[experience.result]},checks:['왜 표로 정리했나요?'],questions:[{id:'q',reason:'함께 의견을 정리한 경험이에요.'}]};
test('AI proposals preserve student phrases and reject invented facts and foreign questions',()=>{
  assert.deepEqual(validateArmorySuggestion(suggestion,experience,new Set(['q'])),suggestion);
  assert.throws(()=>validateArmorySuggestion({...suggestion,sections:{...suggestion.sections,action:['전교 1등으로 수상했다.']}},experience,new Set(['q'])));
  assert.throws(()=>validateArmorySuggestion(suggestion,experience,new Set(['other'])));
  assert.equal(experience.action,'나는 의견을 표로 정리했다.');
});
const question={id:'q',sourceType:'common',sourceVersion:1,title:'협업 질문'};
const event=(id:string,data:Record<string,unknown>={},date='2026-10-17T01:00:00Z')=>({id,kind:'quiz_response',created_at:date,data:{questionId:'q',targetId:school.id,targetSnapshot:school,sourceType:'common',commonRevision:1,outcome:false,...data}});
test('focus uses repeated owned evidence and clears after a later independent correct response',()=>{
  const events=[event('a'),event('b',{},'2026-10-16T01:00:00Z')];
  assert.equal(focusTraining(events,school,[question])[0].reason,'오답 2회');
  assert.equal(focusTraining([...events,event('c',{outcome:true},'2026-10-18T01:00:00Z')],school,[question]).length,0);
  assert.equal(focusTraining([event('a',{targetId:'deleted'})],school,[question]).length,0);
  assert.equal(focusTraining([event('a',{targetSnapshot:{...school,department:'다른 학과'}})],school,[question]).length,0);
  assert.equal(focusTraining([event('a',{commonRevision:2})],school,[question]).length,0);
});
test('ungraded answers and absent literal keywords are never diagnosed as wrong',()=>{
  assert.equal(focusTraining([event('a',{outcome:null,comparison:{required_meanings:[{text:'역할',present:false}]}})],school,[question]).length,0);
  assert.equal(focusTraining([event('a',{outcome:null,hintUsed:true})],school,[question])[0].reason,'도움 사용 1회');
});
