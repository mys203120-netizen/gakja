import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import {z} from 'zod';
import * as model from '../apps/web/src/lib/planner-model';
import {plannerMonthRange} from '../apps/web/src/lib/planner-range';

const require=createRequire(import.meta.url);
test('a monthly query covers its calendar grid and complete selected weeks, including leap February',()=>{
 for(const month of ['2024-02','2026-02','2026-08','2026-10','2026-12']){
  const range=plannerMonthRange(month),grid=model.monthDays(month);
  for(const day of grid)for(const weekday of model.planWeek(day))assert.ok(weekday>=range.startDate&&weekday<=range.endDate);
  assert.ok((Date.parse(range.endDate)-Date.parse(range.startDate))/86400000<49);
 }
 for(const invalid of ['2026-13','2026-00','2026-1','2026-10-01','2026-01;drop table','1999-12'])assert.throws(()=>plannerMonthRange(invalid));
});

test('planner history remains month scoped and only queries completion sessions linked to displayed plans',async()=>{
 const module={exports:{} as any},calls:{sql:string;params:any[]}[]=[],range=plannerMonthRange('2026-09');
 class ApiError extends Error{constructor(public status:number,message:string){super(message);}}
 const plan={id:'00000000-0000-4000-8000-000000000001',date:'2026-09-12',target:{automaticPractice:{hybrid:{kind:'focus'}}}};
 const query=async(sql:string,params:any[])=>{calls.push({sql,params});if(sql.includes('from student_plans'))return [plan];return [];};
 const source=ts.transpileModule(readFileSync('apps/web/src/app/api/planner/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{module,exports:module.exports,URL,Response,Set,require:(name:string)=>{
  if(name==='zod')return {z};
  if(name==='@/lib/auth')return {requireUser:async()=>({id:'student',role:'student'}),checkOrigin(){}};
  if(name==='@/lib/db')return {ApiError,query,errorResponse:(error:ApiError)=>Response.json({error:error.message},{status:error.status||500})};
  if(name==='@/lib/planner-model')return model;
  if(name==='@/lib/planner-range')return {plannerMonthRange};
  if(name==='@/lib/calendar-plan-evidence')return {calendarPlanEvidence:async(owner:string,plans:any[],actual:any)=>{assert.equal(owner,'student');assert.equal(plans[0].id,plan.id);assert.equal(actual.month,range.month);return [];}};
  if(name==='@/lib/planner-context')return {getPlanContext:async()=>({targets:[],sources:[],events:[]}),presentPlan:(row:any)=>row};
  if(name==='@/lib/admission-calendar-store')return {studentAdmissionCalendar:async()=>({interviewSchedules:[],interviewScheduleCoverage:{},refreshDue:false})};
  if(name==='next/server')return {after(){throw new Error('No refresh needed in fixture.');}};
  if(name==='@/lib/automatic-practice-store')return {synchronizeAutomaticPractice:async()=>[]};
  if(name==='@/lib/hybrid-training-store')return {presentHybridPlan:(row:any)=>row};
  return require(name);
 }});
 const response=await module.exports.GET(new Request('http://local/api/planner?month=2026-09&history=1')),body=await response.json();
 assert.equal(response.status,200);assert.equal(body.range.month,'2026-09');assert.equal(body.plans.length,1);
 for(const call of calls.filter(call=>call.sql.includes('from student_plans'))){assert.ok(call.sql.includes('planned_date between $2::date and $3::date'));assert.deepEqual(Array.from(call.params),['student',range.startDate,range.endDate]);}
 const sessions=calls.find(call=>call.sql.includes('from interview_sessions'))!;assert.ok(sessions.sql.includes("data->>'trainingPlanId'=any($2::text[])"));assert.equal(sessions.params[1][0],plan.id);
 const invalid=await module.exports.GET(new Request('http://local/api/planner?month=2026-99'));assert.equal(invalid.status,400);
});
