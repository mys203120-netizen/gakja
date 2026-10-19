import test from 'node:test';
import assert from 'node:assert/strict';
import {createExperienceDraftSync,experienceDraftKey,migrateExperienceDraft,readExperienceDrafts,removeExperienceDraft,writeExperienceDraft,type ExperienceDraft} from '../apps/web/src/lib/armory-drafts';
import {classifyExperienceText,experienceQuestionSuggestions,questionExperienceSuggestions} from '../apps/web/src/lib/armory-recommendations';
const experience={title:'조별 조사',category:'협업' as const,situation:'조별 자료의 형식이 달랐다.',action:'저는 공통 양식을 제안했다.',result:'',confirmed:false,pinned:false,sourceNote:'학생 작성'};
const record=(id:string):ExperienceDraft=>({id,draft:{...experience},revision:0,step:0,updatedAt:'2026-10-19T00:00:00.000Z',serverRevision:0});
function memory(){const values=new Map<string,string>();return {values,getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};}
test('legacy draft migration and a new card preserve separate durable drafts and student isolation',()=>{
 const durable=memory(),legacy=memory();legacy.setItem('armory-draft:student-a',JSON.stringify({draft:experience,draftId:'old-card',revision:2,step:1}));
 migrateExperienceDraft(durable,legacy,'student-a');writeExperienceDraft(durable,'student-a',record('new-card'));writeExperienceDraft(durable,'student-b',record('other-student'));
 assert.equal(legacy.getItem('armory-draft:student-a'),null);assert.deepEqual(readExperienceDrafts(durable,'student-a').map(item=>item.id).sort(),['new-card','old-card']);assert.equal(readExperienceDrafts(durable,'student-a').find(item=>item.id==='old-card')?.draft.situation,experience.situation);
 removeExperienceDraft(durable,'student-a','new-card');assert.equal(readExperienceDrafts(durable,'student-a').length,1);assert.equal(readExperienceDrafts(durable,'student-b').length,1);
});
test('failed durable migration never deletes a recoverable legacy source',()=>{
 const durable=memory(),legacy=memory();legacy.setItem('armory-draft:student',JSON.stringify({draft:experience,draftId:'old',revision:0,step:0}));
 assert.throws(()=>migrateExperienceDraft({...durable,setItem(){throw Error('Storage full');}},legacy,'student'));assert.ok(legacy.getItem('armory-draft:student'));assert.equal(durable.getItem(experienceDraftKey('student','old')),null);
});
test('autosaves serialize per card and use acknowledged revisions without overwriting newer content',async()=>{
 const requests:ExperienceDraft[]=[],resolve:Array<(value:ExperienceDraft)=>void>=[];
 const sync=createExperienceDraftSync(async value=>{requests.push(value);return new Promise<ExperienceDraft>(done=>resolve.push(done));});
 const first=record('one'),second={...first,draft:{...experience,action:'제가 수정한 새 행동'}};
 const a=sync.sync(first),b=sync.sync(second);assert.equal(requests.length,1);resolve[0]({...first,serverRevision:1});await a;await new Promise(done=>setImmediate(done));
 assert.equal(requests.length,2);assert.equal(requests[1].serverRevision,1);assert.equal(requests[1].draft.action,second.draft.action);resolve[1]({...second,serverRevision:2});assert.equal((await b).serverRevision,2);assert.equal(first.draft.action,experience.action);
});
test('a failed autosave does not consume a revision or block later retry',async()=>{
 let count=0;const versions:number[]=[];const sync=createExperienceDraftSync(async value=>{versions.push(value.serverRevision);if(++count===1)throw Error('offline');return {...value,serverRevision:1};});
 await assert.rejects(sync.sync(record('one')),/offline/);assert.equal((await sync.sync(record('one'))).serverRevision,1);assert.deepEqual(versions,[0,0]);
});
test('paste classification only moves source sentences and leaves the original unchanged',()=>{
 const original='조별 자료의 형식이 달랐다.\n저는 공통 양식을 제안했다.\n그 결과 같은 기준으로 기록했다.';const proposal=classifyExperienceText(original);
 assert.equal(proposal.situation,'조별 자료의 형식이 달랐다.');assert.equal(proposal.action,'저는 공통 양식을 제안했다.');assert.equal(proposal.result,'그 결과 같은 기준으로 기록했다.');for(const field of Object.values(proposal))assert.ok(original.includes(field));assert.equal(original,'조별 자료의 형식이 달랐다.\n저는 공통 양식을 제안했다.\n그 결과 같은 기준으로 기록했다.');
});
test('suggestions show at most three genuine keyword matches and no match stays empty',()=>{
 const questions=Array.from({length:5},(_,index)=>({id:String(index),prompt:'협업에서 맡은 역할은?'}));assert.equal(experienceQuestionSuggestions(experience,questions).length,3);assert.ok(experienceQuestionSuggestions(experience,questions).every(item=>item.reason));assert.equal(experienceQuestionSuggestions(experience,[{id:'none',prompt:'지원 대학의 역사에 대해 설명해주세요.'}]).length,0);
 const cards=Array.from({length:5},(_,index)=>({id:String(index),revision:index+1,updated_at:'2026-10-19',data:{...experience,confirmed:index!==0}}));const found=questionExperienceSuggestions('협업에서 맡은 역할은?',cards);assert.equal(found.length,3);assert.ok(found.every(item=>item.card.id!=='0'&&item.reason));assert.equal(questionExperienceSuggestions('지원 대학의 역사',cards).length,0);
});
