import test from 'node:test';
import assert from 'node:assert/strict';
import {foldTrainingEvidence} from '../apps/web/src/lib/training-evidence';
const target={id:'t1',university:'대학',admission_year:2027,campus:'본교',department:'환경공학부',admission_type:'면접형'};
const question={id:'q1',prompt:'내 역할은?',activity_ids:['a1']};
const learning={activities:[{id:'a1',title:'수질 탐구',fact_confirmation:'confirmed_by_student'}],questions:[question]};
const turn=(id:string,data:any={},extra:any={})=>({id,question_id:'q1',created_at:'2026-10-20T01:00:00Z',target_id:'t1',session_data:{context:{target,sourceKind:'personal',contentVersion:1,questions:[question]}},data:{answer:'제가 측정 조건을 제안했습니다.',rootQuestionId:'q1',...data},...extra});
const fold=(turns:any[],options:any={})=>foldTrainingEvidence({learning,cards:[],turns,events:[],target,contentVersion:1,...options});
test('same activity receives written, actual recording and follow-up evidence exactly once',()=>{
 const a=turn('one'),b=turn('two',{submissionSource:'recording',questionKind:'generated',followupDepth:1,assisted:true});
 const row=fold([a,b,b]).items[0];assert.equal(row.mainAnswers,1);assert.equal(row.followupAnswers,1);assert.equal(row.textAttempts,1);assert.equal(row.audioAttempts,1);assert.equal(row.assistedAttempts,1);
});
test('drafts, invalidated answers, other target and other publication cannot update current readiness',()=>{
 const other=turn('other',{}, {target_id:'t2',session_data:{context:{target:{...target,id:'t2',department:'경영학과'},sourceKind:'personal',contentVersion:1,questions:[question]}}});
 const past=turn('past',{}, {session_data:{context:{target,sourceKind:'personal',contentVersion:2,questions:[question]}}});
 const row=fold([turn('draft',{answer:'',draft:'초안'}),turn('invalid',{invalidated:true}),other,past]).items[0];assert.equal(row.mainAnswers,0);assert.ok(row.needsReview.includes('아직 답변하지 않음'));
});
test('edited transcription counts as a written submission and formatting is not an extra attempt',()=>{
 const row=fold([turn('one',{speechSource:{rawText:'원래 말',studentEdited:true}})]).items[0];assert.equal(row.textAttempts,1);assert.equal(row.audioAttempts,0);assert.equal(row.mainAnswers,1);
});

test('an explicit text submission takes priority over retained speech metadata',()=>{
 const row=fold([turn('typed',{submissionSource:'text',speechSource:{rawText:'이전 녹음',studentEdited:false}})]).items[0];
 assert.equal(row.textAttempts,1);assert.equal(row.audioAttempts,0);
});

test('mixed interview common answers follow their own question revision across personal republication',()=>{
 const common={...question,common_revision:3};
 const mixed=turn('mixed',{commonRevision:3},{session_data:{context:{target,sourceKind:'mixed',contentVersion:1,questions:[common]}}});
 const current=fold([mixed],{contentVersion:2,learning:{...learning,questions:[common]}}).items[0];
 assert.equal(current.mainAnswers,1);
 const changed=fold([mixed],{contentVersion:1,learning:{...learning,questions:[{...common,common_revision:4}]}}).items[0];
 assert.equal(changed.mainAnswers,0);
});
test('a common-source diagnosis without a personal guidebook still has visible submitted evidence',()=>{
 const common={id:'common1',prompt:'지원 동기는?',common_revision:2,activity_ids:[]};
 const result=foldTrainingEvidence({learning:{activities:[],questions:[common]},cards:[],events:[],target,contentVersion:null,turns:[turn('common',{rootQuestionId:common.id},{question_id:common.id,session_data:{context:{target,sourceKind:'common',contentVersion:2,questions:[common]}}})]});
 assert.equal(result.items[0].kind,'question');assert.equal(result.items[0].mainAnswers,1);
 const old=foldTrainingEvidence({learning:{activities:[],questions:[{...common,common_revision:3}]},cards:[],events:[],target,contentVersion:null,turns:[turn('common',{rootQuestionId:common.id},{question_id:common.id,session_data:{context:{target,sourceKind:'common',questions:[common]}}})]});assert.equal(old.items.length,0);
});
test('unconfirmed facts and own notes remain explicit while historical experience revisions stay separate',()=>{
 const card={id:'card1',revision:2,data:{title:'협업',confirmed:false}};
 const row=fold([], {cards:[card],notes:[{id:'note',activityId:'experience:card1',body:'확인한 역할',confirmedByStudent:true}]}).items.find(item=>item.kind==='experience')!;
 assert.equal(row.unconfirmed,true);assert.equal(row.notes.length,1);assert.equal(row.mainAnswers,0);
});
