import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as hybrid from '../apps/web/src/lib/hybrid-training';
import * as scope from '../apps/web/src/lib/learning-target-scope';
import * as planner from '../apps/web/src/lib/planner-model';

function load(file:string){
 const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,module={exports:{} as any};
 vm.runInNewContext(code,{module,exports:module.exports,require(name:string){
  if(name==='./hybrid-training')return hybrid;if(name==='./learning-target-scope')return scope;if(name==='./planner-model')return planner;
  if(name==='./db')return {ApiError:Error};return {};
 }});return module.exports;
}
const {pendingTrainingAssignments}=load('apps/web/src/lib/training-practice-store.ts');
const {fixedHybridPlans}=load('apps/web/src/lib/hybrid-training-store.ts');
const today='2026-10-21',school={university:'검증대학교',department:'환경공학부',admission_year:2027,campus:'본교',admission_type:'학생부종합Ⅰ'};
const current=[{id:'school-a',data:school}],question={id:'question-a',title:'내 활동 설명',targetId:'school-a',sourceType:'personal',sourceVersion:3,activityIds:[],category:'personal',attempts:[]};

test('a pending assignment with an explicit former question cannot be attached to a different current question',async()=>{
 const assignment=(id:string,questionId:string|null)=>({id,title:'받은 과제',target_id:'school-a',target_snapshot:school,source_kind:'personal',content_version:3,item_count:1,question_id:questionId,due_at:null});
 const rows=[assignment('exact','question-a'),assignment('replaced','old-question'),assignment('unlinked-memory',null),assignment('empty-question','')],before=JSON.stringify(rows);
 const result=await pendingTrainingAssignments('student-a',{schoolTargets:current},[question],{query:async()=>({rows})});
 assert.deepEqual(Array.from(result,(row:any)=>row.id),['exact']);
 assert.equal(result.find((row:any)=>row.id==='exact').questionId,'question-a');assert.equal(result.find((row:any)=>row.id==='replaced'),undefined);
 assert.equal(JSON.stringify(rows),before,'source assignment snapshots remain intact in the archive');
});

test('a started plan with a changed department or admission track cannot consume the new target daily budget',()=>{
 const row=(id:string,snapshot:any)=>({id,date:today,completed:false,target:{targetId:'school-a',targetSnapshot:snapshot,sourceType:'personal',sourceVersion:3,automaticPractice:{status:'active',minutes:25,startedAt:today+'T01:00:00Z',hybrid:{kind:'quiz'}}}});
 for(const snapshot of [{...school,department:'경제학부'},{...school,admission_type:'다른 전형'}]){
  const stale=row('stale',snapshot),before=JSON.stringify(stale),fixed=fixedHybridPlans([stale],current,today);
  assert.equal(fixed.length,0);assert.equal(JSON.stringify(stale),before,'unfinished historical source and session links are not erased');
  const planned=hybrid.hybridTrainingDays({today,availability:{version:2,startDate:today,revision:1,savedAt:today+'T00:00:00Z',weekdayMinutes:120,weekendMinutes:120,blockedDates:[],overrides:{}},questions:[question as any],deadlines:[{targetId:'school-a',university:school.university,department:school.department,date:'2026-11-29',status:'ready'} as any],fixedTasks:fixed});
  assert.equal(planned[0].plannedMinutes,120);assert.ok(!planned[0].tasks.some(task=>task.id===stale.id),'all available time can be assigned to usable current training');
 }
});

test('a publication change preserves a started same-school lesson while completed work keeps its actually spent time',()=>{
 const started={id:'started',date:today,completed:false,target:{targetId:'school-a',targetSnapshot:school,sourceType:'personal',sourceVersion:2,automaticPractice:{status:'active',minutes:25,startedAt:today+'T01:00:00Z',hybrid:{kind:'quiz'}}}};
 const completed={...started,id:'completed',completed:true,target:{...started.target,targetSnapshot:{...school,department:'이전 학과'}}};
 const performed={...completed,id:'performed',completed:false,performedAt:today+'T02:00:00Z'};
 const untouched={...started,id:'untouched',target:{...started.target,automaticPractice:{...started.target.automaticPractice,startedAt:null}}};
 const fixed=fixedHybridPlans([started,completed,performed,untouched],current,today);
 assert.deepEqual(Array.from(fixed,(row:any)=>row.id),['started','completed','performed']);assert.equal(fixed[0],started);assert.equal(fixed[0].target.sourceVersion,2);
});
