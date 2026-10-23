import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewPlacementSuggestions,type ReviewPlacementInput} from '../apps/web/src/lib/training-review-placement';
import {DEFAULT_CURRICULUM_POLICY} from '../apps/web/src/lib/curriculum-policy';
import {knowledgeTargetKey} from '../apps/web/src/lib/knowledge-flow-model';
import {learningScopeIdentity} from '../apps/web/src/lib/learning-target-scope';
const today='2026-10-23',target={id:'school',university:'합성대학교',department:'환경공학과',admission_type:'학생부종합',admission_year:2027},key=knowledgeTargetKey(learningScopeIdentity(target));
const question={id:'review-q',title:'보완할 질문',targetId:target.id,targetKey:key,sourceType:'personal' as const,sourceVersion:2,activityIds:['a'],category:'personal' as const,area:'동아리활동',attempts:[{id:'e',at:'2026-10-22T01:00:00Z',valid:true,assisted:true}]};
const base:ReviewPlacementInput={today,policy:DEFAULT_CURRICULUM_POLICY,questions:[question],plans:[],availability:{version:2,startDate:today,revision:1,savedAt:today+'T00:00:00Z',weekdayMinutes:30,weekendMinutes:30,blockedDates:[],overrides:{}},deadlines:[{targetId:target.id,university:target.university,department:target.department,date:'2026-10-27',source:'personal',label:'내 면접일',periodStart:null,periodEnd:null,status:'ready',reason:'개인 일정',daysLeft:4,availableMinutes:120}]};
function plan(id:string,date=today,patch:any={}){return {id,title:id,date,revision:1,completed:false,target:{kind:'question',id:'other-q',targetId:target.id,targetSnapshot:target,sourceType:'personal',sourceVersion:2,automaticPractice:{status:'active',minutes:30,hybrid:{kind:'focus',area:'세특',sequence:1}}},...patch};}
test('missing area proposes complete untouched days or an empty day without mutating input',()=>{
 const input={...base,plans:[plan('b'),plan('a',today,{...plan('a'),target:{...plan('a').target,automaticPractice:{status:'active',hybrid:{kind:'reading',area:'세특',sequence:0}}}})]},before=structuredClone(input);
 const result=reviewPlacementSuggestions(input)[0];assert.deepEqual(input,before);assert.equal(result.status,'ready');assert.equal(result.area,'동아리활동');assert.equal(result.candidates[0].date,'2026-10-24');
 assert.deepEqual(result.candidates.find(day=>day.date===today)?.before.map(row=>row.id),['a','b']);assert.ok(result.candidates.every(day=>day.date<'2026-10-27'));assert.match(result.reason,/도움/);
});
test('coverage requires pending same-school/source namespace/version/domain/target identity',()=>{
 const covered=plan('covered');covered.target.automaticPractice.hybrid.area=question.area;
 assert.equal(reviewPlacementSuggestions({...base,plans:[covered]})[0].status,'covered');
 for(const change of [{sourceVersion:1},{sourceType:'common'},{targetId:'foreign'},{targetSnapshot:{...target,department:'다른학과'}}])assert.equal(reviewPlacementSuggestions({...base,plans:[{...covered,target:{...covered.target,...change}}]})[0].status,'ready');
 for(const change of [{completed:true},{locked:true},{performedAt:'now'}])assert.equal(reviewPlacementSuggestions({...base,plans:[{...covered,...change}]})[0].status,'ready');
});
test('manual, started, completed, student moved/ordered and assignment days are conflict-only',()=>{
 for(const patch of [{target:null},{completed:true},{locked:true},{target:{...plan('a').target,automaticPractice:{startedAt:'now',hybrid:{kind:'focus'}}}},{target:{...plan('a').target,calendarPlacement:{operationId:'manual'}}},{target:{...plan('a').target,automaticPractice:{hybrid:{kind:'focus',studentOrderedAt:'now'}}}},{target:{...plan('a').target,automaticPractice:{hybrid:{kind:'assignment'}}}}]){
  const result=reviewPlacementSuggestions({...base,plans:[plan('protected',today,patch)]})[0];assert.ok(!result.candidates.some(day=>day.date===today));assert.ok(result.conflicts.some(day=>day.date===today));
 }
 const all=reviewPlacementSuggestions({...base,plans:['2026-10-23','2026-10-24','2026-10-25','2026-10-26'].map(date=>plan(date,date,{target:null}))})[0];assert.equal(all.status,'blocked');assert.equal(all.conflicts.length,4);assert.equal(all.resolution?.href,'/availability');
});
test('availability and repeat interval are explicit constraints, including no possible pre-deadline day',()=>{
 for(const availability of [null,{...base.availability!,weekdayMinutes:0,weekendMinutes:0},{...base.availability!,weekdayMinutes:4,weekendMinutes:4}]){const result=reviewPlacementSuggestions({...base,availability})[0];assert.equal(result.status,'blocked');assert.equal(result.candidates.length,0);assert.equal(result.resolution?.href,'/availability');}
 const later={...question,repetition:{enabled:true,intervalDays:7}};assert.equal(reviewPlacementSuggestions({...base,questions:[later]})[0].status,'blocked');
 const paused={...question,review:{questionKey:'key',targetId:'school',questionId:'review-q',sourceType:'personal' as const,sourceVersion:2,activityIds:['a'],status:'active' as const,needsReview:true,requestIds:['r'],resolvedEvidenceIds:[],reason:'직접 보완 요청',requestedAtUnknown:false},repetition:{enabled:false,intervalDays:1}};assert.equal(reviewPlacementSuggestions({...base,questions:[paused]})[0].status,'paused');
 const due={...question,repetition:{enabled:true,intervalDays:3}};assert.deepEqual(reviewPlacementSuggestions({...base,questions:[due]})[0].candidates.map(day=>day.date),['2026-10-25','2026-10-26']);
});
test('unclassified area and unavailable deadlines provide concrete resolution; one suggestion per actual scope',()=>{
 assert.equal(reviewPlacementSuggestions({...base,questions:[{...question,area:'영역 확인 필요'}]})[0].resolution?.href,'/preparation');
 assert.match(reviewPlacementSuggestions({...base,deadlines:[]})[0].resolution?.href||'',/^\/schools\//);
 assert.equal(reviewPlacementSuggestions({...base,questions:[question,{...question,id:'q2'}]}).length,1);
 assert.equal(reviewPlacementSuggestions({...base,questions:[question,{...question,sourceVersion:3}]}).length,2);
});
