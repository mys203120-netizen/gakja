/** Explicit localhost-only integration. Fresh random schema, synthetic facts, no model calls.
 * node --import tsx tests/training-review-placement-integration.mts */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import * as crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import pg from 'pg';
import {loadProjectEnv,redactEnvironmentSecrets} from '../scripts/load-env.mjs';
import * as calendarModel from '../apps/web/src/lib/calendar-edit';
import * as placementModel from '../apps/web/src/lib/training-review-placement';
import * as hybrid from '../apps/web/src/lib/hybrid-training';
import * as availability from '../apps/web/src/lib/training-availability';
import * as review from '../apps/web/src/lib/training-review';
import * as policy from '../apps/web/src/lib/curriculum-policy';
import * as identity from '../apps/web/src/lib/learning-target-scope';
import * as canonical from '../apps/web/src/lib/knowledge-flow-model';
import {questionDomain} from '../apps/web/src/lib/training-domain';
import {shiftPlanDay} from '../apps/web/src/lib/planner-model';
loadProjectEnv();
const connectionString=process.env.TEST_DATABASE_URL||process.env.DATABASE_URL!;
if(!['localhost','127.0.0.1'].includes(new URL(connectionString).hostname))throw Error('Isolated test requires localhost Postgres.');
const schema='review_placement_test_'+randomUUID().replaceAll('-',''),admin=new pg.Client({connectionString});await admin.connect();
const pool=new pg.Pool({connectionString,options:`-c search_path=${schema},public`,max:8});
const today='2026-10-23',owner=randomUUID(),other=randomUUID(),targetId=randomUUID();let checks=0,failInsert=false;
const check=(condition:unknown)=>{assert.ok(condition);checks++;};
class ApiError extends Error{constructor(public status:number,message:string){super(message);}}
const database={ApiError,query:async(sql:string,args:unknown[]=[]) =>(await pool.query(sql,args)).rows,transaction:async(fn:Function)=>{const db=await pool.connect();try{await db.query('begin');const proxy={query:async(sql:string,args:unknown[])=>{if(failInsert&&sql.startsWith('insert into student_plans'))throw Error('synthetic insert failure');return db.query(sql,args);}};const value=await fn(proxy);await db.query('commit');return value;}catch(error){await db.query('rollback');throw error;}finally{db.release();}}};
async function moduleAt(file:string,imports:Record<string,unknown>){const exported:any={};vm.runInNewContext(ts.transpileModule(await readFile(new URL('../apps/web/src/lib/'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:exported,Date,JSON,Map,Set,Number,Object,String,Promise,require(name:string){if(name==='server-only')return {};if(name==='node:crypto')return crypto;if(name==='./db')return database;if(name in imports)return imports[name];throw Error('Unexpected dependency '+name);}});return exported;}
try{
 await admin.query(`create schema ${schema}`);
 await pool.query(`create table profiles(id uuid primary key);
 create table support_targets(id text primary key,student_id uuid,data jsonb);
 create table student_preferences(student_id uuid primary key,data jsonb default '{}',updated_at timestamptz default now());
 create table student_plans(id uuid primary key default gen_random_uuid(),student_id uuid,title text,planned_date date,kind text,target jsonb,completed boolean default false,revision int default 1,created_at timestamptz default now(),updated_at timestamptz default now());
 create table interview_sessions(id uuid primary key default gen_random_uuid(),student_id uuid,data jsonb,state text);
 create table quiz_sessions(id uuid primary key default gen_random_uuid(),student_id uuid,metadata jsonb,state text);
 create table study_session_events(student_id uuid,data jsonb,created_at timestamptz,kind text);
 create table study_imported_events(student_id uuid,data jsonb,occurred_at timestamptz,kind text);
 create table student_document_guidelines(id uuid,version int,rules jsonb,kind text,status text);
 create table student_learning_revisions(student_id uuid primary key,revision bigint);
 create table learning_catalog_revision(singleton boolean primary key,revision bigint);
 create table fixture_learning(student_id uuid primary key,data jsonb);`);
 await pool.query('insert into profiles values($1),($2)',[owner,other]);
 await pool.query('insert into student_learning_revisions values($1,1),($2,1);',[owner,other]);await pool.query('insert into learning_catalog_revision values(true,1)');
 const target={id:targetId,university:'합성 QA 대학교',department:'환경공학과',admission_type:'학생부종합',admission_year:2027,schedule:{personal_date:'2026-10-27',status:'awaiting'}},targetKey=canonical.knowledgeTargetKey(identity.learningScopeIdentity(target));
 await pool.query('insert into support_targets values($1,$2,$3)',[targetId,owner,JSON.stringify(target)]);
 const prefs={trainingAvailability:{version:2,startDate:today,revision:1,savedAt:today+'T00:00:00Z',weekdayMinutes:30,weekendMinutes:30,blockedDates:[],overrides:{}}};
 await pool.query('insert into student_preferences values($1,$2,now()),($3,$2,now())',[owner,JSON.stringify(prefs),other]);
 const question={id:'review-q',title:'합성 탐구에서 방법을 선택한 근거를 설명해 주세요.',targetId,targetKey,sourceType:'personal',sourceVersion:2,activityIds:['activity-a'],category:'personal',attempts:[{id:'evidence-1',at:'2026-10-22T01:00:00Z',kind:'interview_answer',valid:true,assisted:true,assistanceKnown:true}]};
 await pool.query('insert into fixture_learning values($1,$2)',[owner,JSON.stringify({activities:[{id:'activity-a',title:'합성 과학 동아리',area:'동아리활동',activity_summary:'테스트에만 사용하는 합성 탐구 기록입니다.'}],questions:[question]})]);
 const contextFor=async(studentId:string,_:unknown,options:{readOnly?:boolean})=>{check(options.readOnly===true);const [schools,learning]=(await Promise.all([pool.query('select id,data from support_targets where student_id=$1',[studentId]),pool.query('select data from fixture_learning where student_id=$1',[studentId])]));return {schoolTargets:schools.rows,learning:learning.rows[0]?.data||{questions:[],activities:[]},contentVersion:2};};
 const factsFor=async(studentId:string,context:any,db:any)=>{const learning=(await db.query('select data from fixture_learning where student_id=$1',[studentId])).rows[0]?.data||{questions:[]};const questions=learning.questions.map((item:any)=>({...item,targetKey:canonical.knowledgeTargetKey(identity.learningScopeIdentity(context.schoolTargets.find((row:any)=>row.id===item.targetId)?.data||{}))}));return {questions,targets:new Map(questions.map((q:any)=>[`${q.targetId}:${q.sourceType}:${q.sourceVersion}:${q.id}`,{kind:'question',id:q.id,title:q.title,targetId:q.targetId,targetSnapshot:context.schoolTargets.find((row:any)=>row.id===q.targetId).data,sourceType:q.sourceType,sourceVersion:q.sourceVersion,activityIds:q.activityIds,questionSnapshot:{id:q.id,prompt:q.title}}]))};};
 const modelRevision=await moduleAt('student-read-model.ts',{});
 const calendar=await moduleAt('calendar-edit-store.ts',{'./planner-model':{koreaToday:()=>today},'./calendar-edit':calendarModel});
 const reviewStore=await moduleAt('training-review-store.ts',{'./knowledge-flow-model':canonical,'./learning-target-scope':identity,'./training-review':review});
 const store=await moduleAt('training-review-placement-store.ts',{'./planner-context':{buildPlanContext:contextFor},'./student-read-model':modelRevision,'./admission-calendar-store':{studentAdmissionCalendar:async()=>({interviewSchedules:[],interviewScheduleCoverage:{targets:[]}})},'./school-interview-scope':{interviewSupportForTarget:()=>({supported:true})},'./learning-target-scope':identity,'./knowledge-flow-model':canonical,'./planner-model':{koreaToday:()=>today},'./training-availability':availability,'./training-review-evidence-store':{loadReviewQuestionFacts:factsFor},'./training-review':review,'./training-review-store':reviewStore,'./training-practice-store':{trainingQuizQuestions:(questions:any[],context:any)=>questions.map(q=>({...q,...questionDomain(q,context.learning)}))},'./hybrid-training':hybrid,'./curriculum-policy':policy,'./calendar-edit-store':calendar,'./training-review-placement':placementModel});
 const seed=async(id:string,date= today,extra:any={})=>{const targetValue={kind:'question',id:'other-q',targetId,targetSnapshot:target,sourceType:'personal',sourceVersion:2,automaticPractice:{status:'active',minutes:10,hybrid:{kind:'focus',area:'세특',sequence:1}},...extra};await pool.query('insert into student_plans(id,student_id,title,planned_date,kind,target) values($1,$2,$3,$4,$5,$6)',[id,owner,'교체 전 합성 계획',date,'interview',JSON.stringify(targetValue)]);return targetValue;};
 const originalId=randomUUID(),originalTarget=await seed(originalId),foreign=randomUUID();await pool.query('insert into student_plans(id,student_id,title,planned_date,target) values($1,$2,$3,$4,$5)',[foreign,other,'다른 학생의 합성 계획',today,JSON.stringify(originalTarget)]);
 const snapshots=async()=>JSON.stringify((await pool.query("select * from (select 'plan' as kind,row_to_json(p)::jsonb as value from student_plans p union all select 'prefs',row_to_json(p)::jsonb from student_preferences p) snapshot order by kind,value::text")).rows);
 let before=await snapshots();const suggestions=await store.trainingReviewPlacement(owner);check(suggestions.suggestions.length===1);const selection={questionKey:suggestions.suggestions[0].questionKey,date:today};const preview=await store.trainingReviewPlacement(owner,selection);check(before===await snapshots());check(preview.preview.before[0].id===originalId);check(preview.preview.after.some((row:any)=>row.kind==='focus'));check(preview.preview.after.every((row:any)=>row.area==='동아리활동'));check(preview.preview.after.reduce((sum:number,row:any)=>sum+row.minutes,0)===30);check(preview.preview.after.at(-1).kind==='review');
 await assert.rejects(()=>store.trainingReviewPlacement(other,selection,preview.fingerprint),(error:any)=>error.status===404);checks++;check(before===await snapshots());
 await pool.query('update student_plans set revision=revision+1 where id=$1',[originalId]);await assert.rejects(()=>store.trainingReviewPlacement(owner,selection,preview.fingerprint),(error:any)=>error.status===409);checks++;
 const fresh=await store.trainingReviewPlacement(owner,selection);before=await snapshots();failInsert=true;await assert.rejects(()=>store.trainingReviewPlacement(owner,selection,fresh.fingerprint),/synthetic insert failure/);checks++;failInsert=false;check(before===await snapshots());
 const results=await Promise.allSettled([store.trainingReviewPlacement(owner,selection,fresh.fingerprint),store.trainingReviewPlacement(owner,selection,fresh.fingerprint)]);check(results.filter(item=>item.status==='fulfilled').length===1);check(results.filter(item=>item.status==='rejected').length===1);
 const applied=(results.find(item=>item.status==='fulfilled') as PromiseFulfilledResult<any>).value;
 let saved=(await pool.query('select * from student_plans where student_id=$1',[owner])).rows;check(saved.find(row=>row.id===originalId).target.automaticPractice.status==='superseded');check(saved.filter(row=>row.target.automaticPractice.status==='active').length===preview.preview.after.length);check((await pool.query('select revision from student_plans where id=$1',[foreign])).rows[0].revision===1);
 check((await store.trainingReviewPlacement(owner)).suggestions.length===0);
 // Undoing a later calendar move restores the replacement journal's expected revision too.
 const moveRequest={ids:[saved.find(row=>row.target.automaticPractice.status==='active').id],toDate:shiftPlanDay(today,1),mode:'move'},movePreview=await calendar.editCalendarPlans(owner,moveRequest),moved=await calendar.editCalendarPlans(owner,moveRequest,movePreview.fingerprint);
 await assert.rejects(()=>calendar.undoCalendarEdit(owner,applied.operationId),(error:any)=>error.status===409);checks++;
 const restoreMove=await calendar.undoCalendarEdit(owner,moved.operationId);await calendar.undoCalendarEdit(owner,moved.operationId,restoreMove.fingerprint);
 const undo=await calendar.undoCalendarEdit(owner,applied.operationId);check(undo.preview.replacement.after.length===1);await calendar.undoCalendarEdit(owner,applied.operationId,undo.fingerprint);saved=(await pool.query('select * from student_plans where student_id=$1',[owner])).rows;check(saved.find(row=>row.id===originalId).target.automaticPractice.status==='active');assert.deepEqual(saved.find(row=>row.id===originalId).target,originalTarget);checks++;check(saved.filter(row=>row.target.automaticPractice.status==='active').length===1);
 // Starting any created plan blocks undo even without an answer event or task_start marker.
 const p2=await store.trainingReviewPlacement(owner,selection),a2=await store.trainingReviewPlacement(owner,selection,p2.fingerprint);const created=(await pool.query("select id from student_plans where student_id=$1 and target->'automaticPractice'->>'status'='active' and id<>$2",[owner,originalId])).rows[0].id;
 await pool.query('insert into quiz_sessions(student_id,metadata,state) values($1,$2,$3)',[owner,JSON.stringify({trainingPlanId:created}),'active']);before=await snapshots();await assert.rejects(()=>calendar.undoCalendarEdit(owner,a2.operationId),(error:any)=>error.status===409);checks++;check(before===await snapshots());await pool.query('delete from quiz_sessions where student_id=$1',[owner]);const u2=await calendar.undoCalendarEdit(owner,a2.operationId);await calendar.undoCalendarEdit(owner,a2.operationId,u2.fingerprint);
 // A post-preview manual plan blocks replacement of the entire date, never silently excluding it.
 const p3=await store.trainingReviewPlacement(owner,selection),manual=randomUUID();await pool.query('insert into student_plans(id,student_id,title,planned_date,target) values($1,$2,$3,$4,null)',[manual,owner,'수동 보호 일정',today]);before=await snapshots();await assert.rejects(()=>store.trainingReviewPlacement(owner,selection,p3.fingerprint),(error:any)=>error.status===409);checks++;check(before===await snapshots());await pool.query('delete from student_plans where id=$1',[manual]);
 // UUID row-lock order must never change the displayed/restored learning sequence, including old journals.
 const orderedIds=[originalId,randomUUID(),randomUUID()].sort().reverse();for(const id of orderedIds)if(id!==originalId)await seed(id);
 for(const [index,id] of orderedIds.entries())await pool.query("update student_plans set title=$2,target=jsonb_set(target,'{automaticPractice,hybrid,sequence}',$3::jsonb) where id=$1",[id,['기록 복습','화상 답변 연습','오늘 정리'][index],JSON.stringify(index+1)]);
 const originalDay=(await pool.query("select id,title,target from student_plans where student_id=$1 and target->'automaticPractice'->>'status'='active' order by id",[owner])).rows;
 const orderPreview=await store.trainingReviewPlacement(owner,selection);assert.deepEqual(Array.from(orderPreview.preview.before,(row:any)=>row.title),['기록 복습','화상 답변 연습','오늘 정리']);checks++;
 const orderApplied=await store.trainingReviewPlacement(owner,selection,orderPreview.fingerprint);
 const journal=(await pool.query('select data from student_preferences where student_id=$1',[owner])).rows[0].data.calendarEdits,entry=journal.find((item:any)=>item.id===orderApplied.operationId);
 assert.deepEqual(entry.replacement.removed.map((item:any)=>item.id),orderedIds);checks++;
 entry.replacement.removed.reverse();entry.replacement.created.reverse();await pool.query("update student_preferences set data=jsonb_set(data,'{calendarEdits}',$2::jsonb) where student_id=$1",[owner,JSON.stringify(journal)]);
 const orderUndo=await calendar.undoCalendarEdit(owner,orderApplied.operationId);assert.deepEqual(Array.from(orderUndo.preview.replacement.after),['기록 복습','화상 답변 연습','오늘 정리']);checks++;
 assert.deepEqual(Array.from(orderUndo.preview.replacement.before),Array.from(orderPreview.preview.after,(row:any)=>row.title));checks++;
 await calendar.undoCalendarEdit(owner,orderApplied.operationId,orderUndo.fingerprint);
 assert.deepEqual((await pool.query("select id,title,target from student_plans where student_id=$1 and target->'automaticPractice'->>'status'='active' order by id",[owner])).rows,originalDay);checks++;
 // Latest source evidence and availability are part of confirmation, not trusted client snapshots.
 const p4=await store.trainingReviewPlacement(owner,selection);await pool.query('update student_learning_revisions set revision=revision+1 where student_id=$1',[owner]);await assert.rejects(()=>store.trainingReviewPlacement(owner,selection,p4.fingerprint),(error:any)=>error.status===409);checks++;
 const p5=await store.trainingReviewPlacement(owner,selection);await pool.query("update student_preferences set data=jsonb_set(data,'{trainingAvailability,weekdayMinutes}','0'::jsonb) where student_id=$1",[owner]);await assert.rejects(()=>store.trainingReviewPlacement(owner,selection,p5.fingerprint),(error:any)=>error.status===409);checks++;
 // No free pre-deadline day returns a settings path, no mutation or a past/post-deadline proposal.
 await pool.query("update student_preferences set data=jsonb_set(data,'{trainingAvailability,weekendMinutes}','0'::jsonb) where student_id=$1",[owner]);before=await snapshots();const blocked=await store.trainingReviewPlacement(owner);check(blocked.suggestions[0].status==='blocked');check(blocked.suggestions[0].resolution.href==='/availability');check(before===await snapshots());
 console.log(`Review placement integration: ${checks} checks passed. Real isolated PostgreSQL transactions; synthetic source facts; no external calls.`);
}catch(error){console.error(redactEnvironmentSecrets(error instanceof Error?error.stack:error));process.exitCode=1;}
finally{await pool.end();if(!/^review_placement_test_[a-f0-9]{32}$/.test(schema))throw Error('Unsafe test schema');await admin.query(`drop schema ${schema} cascade`);await admin.end();}
