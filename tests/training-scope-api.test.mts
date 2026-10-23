import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {z} from 'zod';
import * as domain from '../apps/web/src/lib/training-domain';
import {reviewQuestionKey} from '../apps/web/src/lib/training-review';

test('reading scope covers every activity in its saved area and school and preserves planned pressure',async()=>{
 const planId='00000000-0000-4000-8000-000000000001';
 const activities=[{id:'a1',title:'첫 활동',area:'세특',activity_summary:'첫 원문',source_ref_ids:['s1']},{id:'a2',title:'둘째 활동',area:'세특',activity_summary:'둘째 원문',source_ref_ids:['s2']},{id:'a3',title:'다른 영역',area:'동아리활동',source_ref_ids:[]}];
 const learning={activities,source_refs:[{id:'s1',quote:'첫 원문',page:1},{id:'s2',quote:'둘째 원문',page:2}]};
 const q=(id:string,activityIds:string[],targetId='school',sourceVersion=1)=>({id,title:id,activityIds,targetId,sourceType:'personal',sourceVersion});
 const snapshot={questions:[q('q1',['a1']),q('q2',['a2']),q('q3',['a3']),q('other-school',['a3'],'other'),q('other-version',['a3'],'school',2)],readiness:{}};
 const context={schoolTargets:[{id:'school'}],learning:{...learning,activities:activities.map(row=>({...row,area:'새 발행본 영역'}))},sources:[{sourceType:'personal',sourceVersion:1,learning}]};
 const plan={id:planId,title:'세특 기록 복습',target:{targetId:'school',id:'q1',sourceType:'personal',sourceVersion:1,activityIds:['a1'],automaticPractice:{minutes:15,hybrid:{kind:'reading',area:'세특',pressure:true}}}};
 const module={exports:{} as any};
 vm.runInNewContext(ts.transpileModule(readFileSync('apps/web/src/app/api/training/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,Response,Request,URL,Set,require(name:string){
  if(name==='zod')return {z};if(name==='node:crypto')return {randomUUID:()=>planId};
  if(name==='@/lib/auth')return {requireUser:async()=>({id:'owner',role:'student'})};
  if(name==='@/lib/db')return {ApiError:Error,errorResponse:(error:Error)=>Response.json({error:error.message},{status:500}),query:async(sql:string,args:unknown[])=>{if(sql.includes('from student_plans')){assert.equal(args[1],'owner');return [plan];}return [];}};
  if(name==='@/lib/training-records')return {refreshTrainingDiagnostics:async()=>{}};
  if(name==='@/lib/training-read-model')return {getTrainingReadModel:async()=>snapshot,trainingReadContext:()=>context};
  if(name==='@/lib/hybrid-training-store')return {getHybridTraining:async()=>({diagnostics:{school:{}},refreshDue:false})};
  if(name==='@/lib/automatic-practice-store')return {automaticQuestionTargets:()=>new Map()};
  if(name==='@/lib/planner-model')return {koreaToday:()=> '2026-10-23'};
  if(name==='@/lib/training-domain')return domain;
  if(name==='@/lib/training-review')return {reviewQuestionKey};
  return {};
 }});
 const response=await module.exports.GET(new Request('http://local/api/training?planId='+planId));assert.equal(response.status,200,await response.clone().text());
 const result=await response.json();assert.equal(result.selectedTask.pressure,true);assert.deepEqual(result.scopeQuestions.map((row:any)=>row.id),['q1','q2']);assert.deepEqual(result.scopeActivities.map((row:any)=>row.id),['a1','a2']);assert.equal(result.scopeActivities[1].sources[0].quote,'둘째 원문');assert.equal(result.scopeActivities[1].sources[0].page,2);
});
