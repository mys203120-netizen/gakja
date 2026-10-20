import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {adminTrainingSummary} from '../apps/web/src/lib/admin-training.ts';
import {koreaToday} from '../apps/web/src/lib/planner-model.ts';

const today='2026-10-20',studentId='student',target={id:'school',student_id:studentId,university:'학교',department:'학과',admission_type:'학종',campus:'본교',admission_year:2027};
const availability={version:1,startDate:'2026-10-01',revision:1,savedAt:'2026-10-19T00:00:00Z',weekdayMinutes:120,weekendMinutes:180,csatDate:'2026-11-19',beforeCsatWeekdayMinutes:60,beforeCsatWeekendMinutes:90,blockedDates:['2026-10-21'],overrides:{}};
const session={id:'diagnosis',student_id:studentId,target_id:target.id,target_snapshot:target,content_version:3,state:'completed',purpose:'diagnostic',training_plan_id:'plan',answers:3,text_answers:1,audio_answers:2,last_answer_at:'2026-10-20T05:00:00Z'};
const plan={id:'plan',student_id:studentId,date:today,completed:false,target:{targetId:target.id,targetSnapshot:target,sourceType:'personal',sourceVersion:3,automaticPractice:{status:'active',minutes:25,hybrid:{kind:'diagnostic'}}}};
const preferences={trainingAvailability:availability,trainingDiagnostics:{school:{sessionId:session.id,state:'completed',targetSnapshot:target,sourceType:'personal',sourceVersion:3,needsReviewQuestionIds:['q1','q1']}},preparationNote:'private note',trainingActivityNotes:[{body:'private fact'}]};
const input={studentId,activeVersion:3,today,targets:[target],preferences,plans:[plan],sessions:[session]};

test('administrative training summary uses actual submitted sessions, current capacity, and matching target',()=>{
  const value=adminTrainingSummary(input);
  assert.equal(value.availability.todayMinutes,60);assert.equal(value.availability.weekdayMinutes,60);assert.equal(value.availability.weekendMinutes,90);
  assert.equal(value.diagnosis.completed,1);assert.equal(value.targets[0].reviewRequests,1);
  assert.equal(value.training.completed,1);assert.equal(value.training.plannedMinutes,25);assert.equal(value.training.textAnswers,1);assert.equal(value.training.audioAnswers,2);
  assert.equal(value.nextStep,'오늘 훈련');
  assert.ok(!JSON.stringify(value).includes('private'));assert.ok(!JSON.stringify(value).includes('blockedDates'));assert.ok(!JSON.stringify(value).includes('target_snapshot'));
});

test('an unsubmitted or foreign, archived, changed-target or old-edition session cannot certify readiness',()=>{
  for(const bad of [{...session,answers:0},{...session,student_id:'other'},{...session,target_snapshot:{...target,department:'이전 학과'}},{...session,content_version:2},{...session,state:'cancelled'}]){
    const value=adminTrainingSummary({...input,sessions:[bad]});assert.equal(value.diagnosis.completed,0);assert.equal(value.training.completed,0);
  }
  const archived=adminTrainingSummary({...input,targets:[{...target,archived_at:'2026-10-19'}]});assert.equal(archived.schoolCount,0);assert.equal(archived.nextStep,'학교 등록');
  const noTime=adminTrainingSummary({...input,preferences:{}});assert.equal(noTime.nextStep,'학습 시간 설정');
});

test('manual review check is distinct from interview completion and superseded tasks leave today counts',()=>{
  const value=adminTrainingSummary({...input,sessions:[],plans:[{...plan,completed:true},{...plan,id:'review',completed:true,target:{automaticPractice:{status:'active',minutes:10,hybrid:{kind:'review'}}}},{...plan,id:'old',target:{...plan.target,automaticPractice:{...plan.target.automaticPractice,status:'superseded'}}}]});
  assert.equal(value.training.planned,2);assert.equal(value.training.completed,1);assert.equal(value.training.completedMinutes,10);
  assert.equal(adminTrainingSummary({...input,today:'2026-10-21'}).availability.todayMinutes,0);
});

test('actual admin query keeps assignment scope and sends only summarized additional training data',async()=>{
  const calls:Array<{sql:string;params:any[]}>=[],module={exports:{} as any};
  const query=async(sql:string,params:any[])=>{calls.push({sql,params});
    if(sql.includes("where p.role='student'"))return [{id:studentId,name:'학생',active_version:3}];
    if(sql.includes('from support_targets'))return [{id:target.id,student_id:studentId,data:target}];
    if(sql.includes('from student_preferences'))return [{student_id:studentId,data:preferences}];
    if(sql.includes('from student_plans'))return [{...plan,date:koreaToday()}];
    if(sql.includes('from interview_sessions'))return [session];return [];
  };
  vm.runInNewContext(ts.transpileModule(readFileSync('apps/web/src/lib/data.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require(name:string){
    if(name==='server-only')return {};if(name==='./db')return {query,ApiError:class extends Error{status:number;constructor(status:number,message:string){super(message);this.status=status;}}};
    if(name==='./school-directory')return {enrichSchoolTarget:(value:any)=>value};if(name==='./admin-training')return {adminTrainingSummary};if(name==='./planner-model')return {koreaToday};throw Error(name);
  }});
  const data=await module.exports.getAdminData({id:'assigned-staff',role:'staff'});
  assert.ok(calls[0].sql.includes('staff_assignments where staff_id=$1'));assert.equal(calls[0].params.join(','),'assigned-staff');
  for(const call of calls.filter(call=>/from (student_preferences|student_plans|interview_sessions)/.test(call.sql)))assert.equal(call.params[0][0],studentId);
  const sessionQuery=calls.find(call=>call.sql.includes('from interview_sessions'))!.sql;
  assert.ok(!sessionQuery.includes('select *'));assert.ok(!sessionQuery.includes(' as data'));assert.ok(sessionQuery.includes('t.student_id=s.student_id'));
  assert.equal(data.training.length,1);assert.equal(data.training[0].training.audioAnswers,2);assert.ok(!JSON.stringify(data.training).includes('private'));
  calls.length=0;await assert.rejects(()=>module.exports.getAdminData({id:studentId,role:'student'}),(error:any)=>error.status===403);assert.equal(calls.length,0);
});
