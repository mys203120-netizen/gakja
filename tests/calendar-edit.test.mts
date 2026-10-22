import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import ts from 'typescript';
import * as model from '../apps/web/src/lib/calendar-edit.ts';
import {shiftPlanDay} from '../apps/web/src/lib/planner-model.ts';
import {preserveHybridPlan,hybridTrainingDays,type HybridQuestion,type HybridDeadline} from '../apps/web/src/lib/hybrid-training.ts';

const today='2026-10-22';
const row=(id:string,date=today,extra:any={})=>({id,title:'계획 '+id,date,revision:1,completed:false,target:null,...extra});
test('day moves and merges preserve every plan identity and protect completed/started work',()=>{
 const plans=[row('a'),row('b'),row('done',today,{completed:true}),row('started',today,{target:{automaticPractice:{startedAt:'now'}}}),row('recorded',today,{performedAt:'now'}),row('locked',today,{locked:true}),row('other','2026-10-23')],before=structuredClone(plans);
 const result=model.previewCalendarEdit(plans,{fromDate:today,toDate:'2026-10-23',mode:'merge'},today);
 assert.deepEqual(result.changes.map(change=>change.id),['a','b']);assert.equal(result.excluded,4);assert.deepEqual(plans,before);
 assert.equal(result.changes.every(change=>change.to==='2026-10-23'),true);
 assert.throws(()=>model.previewCalendarEdit(plans,{ids:['foreign'],toDate:'2026-10-24',mode:'move'},today),/다시 불러/);
 assert.throws(()=>model.previewCalendarEdit(plans,{fromDate:today,toDate:'2026-10-21',mode:'move'},today),/오늘 이후/);
});
test('week moves keep date intervals, spreading redistributes the selected plans, shifts keep existing order',()=>{
 const plans=[row('a'),row('b','2026-10-23'),row('c','2026-10-25'),row('done','2026-10-24',{completed:true})];
 assert.deepEqual(model.previewCalendarEdit(plans,{fromDate:today,endDate:'2026-10-25',toDate:'2026-10-29',mode:'move'},today).changes.map(change=>change.to),['2026-10-29','2026-10-30','2026-11-01']);
 assert.deepEqual(model.previewCalendarEdit(plans,{ids:['a','b','c'],toDate:'2026-10-26',mode:'spread'},today).changes.map(change=>change.to),['2026-10-26','2026-10-27','2026-10-28']);
 assert.deepEqual(model.previewCalendarEdit(plans,{ids:['a'],toDate:'2026-10-23',mode:'shift'},today).changes.map(change=>[change.id,change.to]),[['a','2026-10-23'],['b','2026-10-24'],['c','2026-10-26']]);
});
test('natural language resolves Korean calendar days and whole weeks without partial or ambiguous execution',()=>{
 assert.deepEqual(model.calendarRequestFromText('오늘 일정은 내일로 미뤄줘.',today),{fromDate:today,toDate:'2026-10-23',mode:'move'});
 assert.deepEqual(model.calendarRequestFromText('이번 주 일정을 다음주로 미뤄줘.',today),{fromDate:'2026-10-19',endDate:'2026-10-25',toDate:'2026-10-26',mode:'move'});
 assert.deepEqual(model.calendarRequestFromText('내일 계획을 3일 뒤로 미뤄줘',today),{fromDate:'2026-10-23',toDate:'2026-10-26',mode:'move'});
 assert.deepEqual(model.calendarRequestFromText('10월 22일 일정을 11월 2일로 옮겨주세요',today),{fromDate:today,toDate:'2026-11-02',mode:'move'});
 for(const text of ['다 지워줘','오늘 일정은 내일로 미뤄줘 그리고 다른 일정 삭제','2월 30일 일정을 3월 1일로 옮겨줘','이번 주 일정을 모레로 옮겨줘','오늘 일정을 99일 미뤄줘'])assert.throws(()=>model.calendarRequestFromText(text,today));
});
test('manual calendar placement preserves an otherwise untouched automatic task',()=>{
 const plan=row('auto','2026-11-02',{target:{calendarPlacement:{operationId:'saved'},automaticPractice:{status:'active',hybrid:{kind:'focus'}}}});
 assert.equal(preserveHybridPlan(plan,today),true);assert.equal(model.calendarPlanMovable(plan),true);
});
test('moving all generated tasks leaves their original day free without replacement questions or phantom workload',()=>{
 const questions:HybridQuestion[]=['a','b','c'].map(id=>({id,title:id,targetId:'school',sourceType:'personal',sourceVersion:1,activityIds:[],category:'major',attempts:[]}));
 const deadline:HybridDeadline={targetId:'school',university:'학교',department:'학과',date:'2026-12-01',source:'goal',label:'준비 목표',periodStart:null,periodEnd:null,status:'ready',reason:'',daysLeft:40,availableMinutes:1000};
 const input={today,availability:{version:2,startDate:today,revision:1,savedAt:today+'T00:00:00Z',weekdayMinutes:120,weekendMinutes:120,blockedDates:[],overrides:{}},deadlines:[deadline],questions};
 const original=hybridTrainingDays(input);assert.ok(original[0].tasks.length>2);
 const deferred=hybridTrainingDays({...input,deferredTaskKeys:original[0].tasks.map(task=>task.id)});
 assert.equal(deferred[0].tasks.length,0);assert.equal(deferred[0].plannedMinutes,0);assert.equal(deferred[0].remainingMinutes,0);assert.equal(deferred[0].unallocatedMinutes,120);assert.ok(deferred[1].tasks.length>0);
});

const require=createRequire(import.meta.url);
function fixture(initial:any[]){
 let plans=structuredClone(initial),preferences:any={},failAfter=0,writes=0;
 const calls:{sql:string;args:any[]}[]=[];let queue=Promise.resolve();
 class ApiError extends Error{constructor(public status:number,message:string){super(message);}}
 const query=async(sql:string,args:any[]=[])=>{
  calls.push({sql,args});
  if(sql.includes('pg_advisory_xact_lock')){assert.equal(args[0],'automatic-practice:owner');return {rows:[]};}
  if(sql.startsWith('select data from student_preferences')){assert.equal(args[0],'owner');return {rows:[{data:structuredClone(preferences)}]};}
  if(sql.includes('from student_plans p')){assert.ok(sql.includes('p.student_id=$1'));assert.ok(sql.includes('for update of p'));return {rows:structuredClone(plans.filter(plan=>plan.student_id==='owner'))};}
  if(sql.startsWith('update student_plans')){
   assert.equal(args[1],'owner');assert.ok(sql.includes('where id=$1 and student_id=$2'));
   const plan=plans.find(plan=>plan.id===args[0]&&plan.student_id===args[1]);assert.ok(plan);
   plan.date=args[2];plan.revision++;
   if(sql.includes("nullif(target-'calendarPlacement'")){if(plan.target){if(args[3])plan.target.calendarPlacement=JSON.parse(args[3]);else{delete plan.target.calendarPlacement;if(!Object.keys(plan.target).length)plan.target=null;}}}
   else if(plan.target)plan.target.calendarPlacement=JSON.parse(args[3]);
   writes++;if(failAfter&&writes===failAfter)throw new Error('simulated write failure');return {rows:[]};
  }
  if(sql.startsWith('insert into student_preferences')){assert.equal(args[0],'owner');preferences.calendarEdits=JSON.parse(args[1]);return {rows:[]};}
  throw new Error('Unexpected SQL '+sql);
 };
 const transaction=async(work:any)=>{
  const beforeQueue=queue;let release!:()=>void;queue=new Promise(resolve=>{release=resolve;});await beforeQueue;
  const before=structuredClone({plans,preferences});
  try{return await work({query});}catch(error){plans=before.plans;preferences=before.preferences;throw error;}finally{release();}
 };
 const module={exports:{} as any};
 const code=ts.transpileModule(readFileSync('apps/web/src/lib/calendar-edit-store.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,Set,Map,Date,JSON,Number,Object,String,require(name:string){
  if(name==='server-only')return {};
  if(name==='node:crypto')return require(name);
  if(name==='./db')return {ApiError,transaction,query:async(sql:string,args:any[])=>{assert.equal(args[0],'owner');return [{journal:preferences.calendarEdits}];}};
  if(name==='./planner-model')return {koreaToday:()=>today,shiftPlanDay};
  if(name==='./calendar-edit')return model;
  throw new Error(name);
 }});
 return {store:module.exports,calls,snapshot:()=>structuredClone({plans,preferences}),change:(id:string,patch:any)=>Object.assign(plans.find(plan=>plan.id===id),patch),fail:(n:number)=>{writes=0;failAfter=n;}};
}
test('confirmed batches persist together, keep automatic linkage and expose no saved answer/title in the undo journal',async()=>{
 const automatic={kind:'question',id:'q',targetId:'school',questionSnapshot:{prompt:'question'},automaticPractice:{hybrid:{kind:'focus'}}};
 const f=fixture([row('a',today,{student_id:'owner',target:automatic}),row('b',today,{student_id:'owner'}),row('foreign',today,{student_id:'other'})]),before=f.snapshot();
 const request={fromDate:today,toDate:'2026-10-24',mode:'merge'};
 const preview=await f.store.editCalendarPlans('owner',request);assert.deepEqual(f.snapshot(),before);
 const applied=await f.store.editCalendarPlans('owner',request,preview.fingerprint),after=f.snapshot();
 assert.equal(after.plans[0].date,'2026-10-24');assert.equal(after.plans[1].date,'2026-10-24');assert.deepEqual(after.plans[2],before.plans[2]);
 assert.deepEqual(after.plans[0].target.automaticPractice,automatic.automaticPractice);assert.equal(after.plans[0].target.calendarPlacement.operationId,applied.operationId);assert.equal(after.plans[1].target,null);
 assert.equal(JSON.stringify(after.preferences).includes('계획 a'),false);assert.equal(applied.history[0].count,2);
 const undo=await f.store.undoCalendarEdit('owner',applied.operationId);assert.equal(undo.preview.changes[0].to,today);
 await f.store.undoCalendarEdit('owner',applied.operationId,undo.fingerprint);
 const restored=f.snapshot();assert.equal(restored.plans[0].date,today);assert.deepEqual(restored.plans[0].target,automatic);assert.equal((await f.store.calendarEditHistory('owner')).history.length,0);
});
test('a changed revision or started task cannot be silently applied or undone',async()=>{
 const f=fixture([row('a',today,{student_id:'owner'})]),request={fromDate:today,toDate:'2026-10-23',mode:'move'};
 const preview=await f.store.editCalendarPlans('owner',request);f.change('a',{revision:2});
 await assert.rejects(f.store.editCalendarPlans('owner',request,preview.fingerprint),(error:any)=>error.status===409);
 const fresh=await f.store.editCalendarPlans('owner',request),applied=await f.store.editCalendarPlans('owner',request,fresh.fingerprint);
 f.change('a',{locked:true});await assert.rejects(f.store.undoCalendarEdit('owner',applied.operationId),(error:any)=>error.status===409);
});
test('overlapping simultaneous confirmations allow one writer and a failed batch rolls back every date and revision',async()=>{
 const f=fixture([row('a',today,{student_id:'owner'}),row('b',today,{student_id:'owner'})]);
 const first={fromDate:today,toDate:'2026-10-23',mode:'move'},second={fromDate:today,toDate:'2026-10-24',mode:'move'};
 const [a,b]=await Promise.all([f.store.editCalendarPlans('owner',first),f.store.editCalendarPlans('owner',second)]);
 const results=await Promise.allSettled([f.store.editCalendarPlans('owner',first,a.fingerprint),f.store.editCalendarPlans('owner',second,b.fingerprint)]);
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
 const rollback=fixture([row('a',today,{student_id:'owner'}),row('b',today,{student_id:'owner'})]),before=rollback.snapshot();
 const proposal=await rollback.store.editCalendarPlans('owner',first);rollback.fail(2);
 await assert.rejects(rollback.store.editCalendarPlans('owner',first,proposal.fingerprint),/simulated/);assert.deepEqual(rollback.snapshot(),before);
});
test('successive undo operations restore prior revisions without overwriting a later independent edit',async()=>{
 const f=fixture([row('a',today,{student_id:'owner'})]);
 const a={ids:['a'],toDate:'2026-10-23',mode:'merge'},pa=await f.store.editCalendarPlans('owner',a),appliedA=await f.store.editCalendarPlans('owner',a,pa.fingerprint);
 const b={ids:['a'],toDate:'2026-10-24',mode:'move'},pb=await f.store.editCalendarPlans('owner',b),appliedB=await f.store.editCalendarPlans('owner',b,pb.fingerprint);
 await assert.rejects(f.store.undoCalendarEdit('owner',appliedA.operationId),(error:any)=>error.status===409);
 const undoB=await f.store.undoCalendarEdit('owner',appliedB.operationId);await f.store.undoCalendarEdit('owner',appliedB.operationId,undoB.fingerprint);
 const undoA=await f.store.undoCalendarEdit('owner',appliedA.operationId);await f.store.undoCalendarEdit('owner',appliedA.operationId,undoA.fingerprint);assert.equal(f.snapshot().plans[0].date,today);
});
