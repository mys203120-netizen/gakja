import test from 'node:test';
import assert from 'node:assert/strict';
test('paste suggestions are editable and cancellable before application and retain the exact original',async()=>{
 const {inputHarness}=await import('./armory-input-render.mjs');
 const applied:any[]=[],h=inputHarness('experience-text-classifier.tsx','ExperienceTextClassifier',{onApply:(value:any)=>applied.push(value)});await h.flush();
 const original='조별 자료가 달랐다.\n저는 공통 양식을 제안했다.';
 h.nodes((node:any)=>node.type==='textarea')[0].props.onChange({target:{value:original}});await h.flush();h.button('내 글에서 상황·행동 나누기').props.onClick();await h.flush();assert.equal(applied.length,0);
 const inputs=h.nodes((node:any)=>node.type==='textarea');assert.equal(inputs.length,4);inputs[2].props.onChange({target:{value:'저는 양식 초안을 직접 만들었다.'}});await h.flush();h.button('분류 취소').props.onClick();await h.flush();assert.equal(h.nodes((node:any)=>node.type==='textarea')[0].props.value,original);assert.equal(applied.length,0);
 h.button('내 글에서 상황·행동 나누기').props.onClick();await h.flush();h.nodes((node:any)=>node.type==='textarea')[2].props.onChange({target:{value:'저는 양식 초안을 직접 만들었다.'}});await h.flush();h.button('확인한 분류를 초안에 적용').props.onClick();await h.flush();assert.equal(applied.length,1);assert.equal(applied[0].originalText,original);assert.equal(applied[0].action,'저는 양식 초안을 직접 만들었다.');
});
test('question experience picker requests owned cards only on open and attaches only after explicit apply',async()=>{
 const {inputHarness}=await import('./armory-input-render.mjs');
 const cards=Array.from({length:5},(_,index)=>({id:'card-'+index,revision:index+1,updated_at:'2026-10-19',data:{title:'협업 '+index,category:'협업',situation:'자료 형식이 달랐다',action:'양식을 만들었다',result:'',confirmed:index!==0,pinned:false,sourceNote:'직접 작성'}}));
 const applied:any[]=[],props={question:{id:'question',prompt:'협업에서 맡은 역할을 말해주세요.'},targetId:'target-a',onSelect:(value:any)=>applied.push(value)},h=inputHarness('question-experience-picker.tsx','QuestionExperiencePicker',props,{cards});await h.flush();assert.equal(h.requests.length,0);
 h.button('쓸 경험 고르기').props.onClick();await h.flush();assert.deepEqual(h.requests,['/api/armory']);const choices=h.nodes((node:any)=>node.type==='input');assert.equal(choices.length,4);assert.ok(choices.every((node:any)=>node.props.value!=='card-0'));assert.equal(applied.length,0);
 choices[0].props.onChange();await h.flush();h.button('취소').props.onClick();await h.flush();assert.equal(applied.length,0);
 h.button('쓸 경험 고르기').props.onClick();await h.flush();h.nodes((node:any)=>node.type==='input')[0].props.onChange();await h.flush();h.button('선택 적용').props.onClick();await h.flush();assert.equal(applied.length,1);assert.equal(applied[0].revision,2);
 h.button('쓸 경험 고르기').props.onClick();await h.flush();h.setProps({...props,targetId:'target-b',question:{id:'another',prompt:'지원 대학의 역사를 설명해주세요.'}});await h.flush();assert.equal(h.nodes((node:any)=>node.type==='input').length,0);assert.equal(applied.length,1);
 h.button('쓸 경험 고르기').props.onClick();await h.flush();assert.equal(h.nodes((node:any)=>node.type==='input').length,1);h.button('선택 적용').props.onClick();await h.flush();assert.equal(applied.at(-1),null);
});
