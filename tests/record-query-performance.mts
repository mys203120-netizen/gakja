// Local PostgreSQL QA: all tables and writes are inside a fresh, exact random schema.
// node --import tsx tests/record-query-performance.mts
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import pg from 'pg';
import {loadProjectEnv,redactEnvironmentSecrets} from '../scripts/load-env.mjs';
import {plannerMonthRange} from '../apps/web/src/lib/planner-range';
import * as cursors from '../apps/web/src/lib/record-cursor';

loadProjectEnv();
const address=new URL(process.env.DATABASE_URL!);
if(!['localhost','127.0.0.1'].includes(address.hostname))throw new Error('This QA uses local PostgreSQL only.');
const schema='record_read_qa_'+randomBytes(8).toString('hex'),student=randomUUID(),other=randomUUID();
assert.match(schema,/^record_read_qa_[a-f0-9]{16}$/);
const client=new pg.Client({connectionString:process.env.DATABASE_URL});
const require=createRequire(import.meta.url);class ApiError extends Error{constructor(public status:number,message:string){super(message);}}
let observations:{sql:string;rows:number}[]=[],queryTail=Promise.resolve();
const query=(sql:string,params:unknown[]=[])=>{const pending=queryTail.then(async()=>{const result=await client.query(sql,params);observations.push({sql,rows:result.rows.length});return result.rows;});queryTail=pending.then(()=>{},()=>{});return pending;};
const database={ApiError,query,transaction:async(fn:any)=>fn({query:async(sql:string,params:unknown[])=>({rows:await query(sql,params)})})};
function load(path:string,mocks:Record<string,unknown>){const module={exports:{} as any};vm.runInNewContext(ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,Buffer,Date,URLSearchParams,console,require:(name:string)=>name in mocks?mocks[name]:require(name)});return module.exports;}
const model=load('apps/web/src/lib/student-read-model.ts',{'server-only':{},'./db':database});
const server=load('apps/web/src/lib/data.ts',{'server-only':{},'./db':database,'./student-read-model':model,'./school-directory':{enrichSchoolTarget:(target:any)=>target},'./admin-training':{adminTrainingSummary:()=>{throw new Error('No administrative reads in student QA.');}},'./planner-model':{koreaToday:()=> '2026-10-21'}});
const calendar=load('apps/web/src/lib/calendar-plan-evidence.ts',{'server-only':{},'./db':database});
const records=load('apps/web/src/lib/student-records.ts',{'server-only':{},'./db':database,'./record-cursor':cursors,'./student-assignment-records':{}});
let created=false,failure:unknown;
await client.connect();
try{
 await client.query(`create schema "${schema}"`);created=true;await client.query(`set search_path to "${schema}",public`);
 await client.query(`
 create table profiles(id uuid primary key);
 create table interview_turns(id uuid primary key default gen_random_uuid(),student_id uuid,session_id uuid,question_id text,data jsonb,created_at timestamptz default now());
 create table study_session_events(id uuid primary key default gen_random_uuid(),student_id uuid,session_id uuid,kind text,source_id text,data jsonb,created_at timestamptz default now());
 create table study_imported_events(id uuid primary key default gen_random_uuid(),student_id uuid,kind text,source_id text,data jsonb,occurred_at timestamptz default now());
 create table quiz_assignments(id uuid primary key default gen_random_uuid(),student_id uuid,title text,state text,due_at timestamptz,report_id uuid,target_id text,source_kind text,content_version int,items jsonb,created_at timestamptz default now(),updated_at timestamptz default now());
 create table content_packages(id text,student_id uuid,active_version int);
 create table support_targets(id text,student_id uuid,data jsonb,created_at timestamptz default now());
 create table user_answers(id uuid primary key default gen_random_uuid(),student_id uuid,question_id text,revision int default 1,structure text default '',script text default '',created_at timestamptz default now(),updated_at timestamptz default now());
 create table interview_sessions(id uuid primary key default gen_random_uuid(),student_id uuid,kind text,mode text,target_id text,content_version int,state text,data jsonb,created_at timestamptz default now(),updated_at timestamptz default now(),completed_at timestamptz);
 create table interview_reports(id uuid primary key default gen_random_uuid(),student_id uuid,session_id uuid,data jsonb,created_at timestamptz default now());
 create table memory_attempts(id uuid primary key default gen_random_uuid(),student_id uuid,memory_item_id text,rating text,due_at timestamptz,created_at timestamptz default now());
 create table student_confirmations(id uuid primary key default gen_random_uuid(),student_id uuid,created_at timestamptz default now());
 create table notifications(id uuid primary key default gen_random_uuid(),student_id uuid,title text,body text,href text,read_at timestamptz,created_at timestamptz default now());
 create table student_preferences(student_id uuid primary key,data jsonb);
 create table reading_progress(student_id uuid,document_kind text,section_id text);
 create table student_learning_revisions(student_id uuid primary key,revision bigint);
 create table learning_catalog_revision(singleton boolean primary key,revision bigint);
 create table student_read_models(student_id uuid,kind text,scope text,source_revision text,payload jsonb,computed_at timestamptz default now(),primary key(student_id,kind,scope));
 create index answer_cursor_qa on user_answers(student_id,created_at desc,id desc);
 create index interview_cursor_qa on interview_sessions(student_id,created_at desc,id desc);
 create index active_resume_qa on interview_sessions(student_id,target_id,kind,created_at desc,id desc) where state='active';
 create index report_cursor_qa on interview_reports(student_id,created_at desc,id desc);
 insert into learning_catalog_revision values(true,1);
 `);
 await client.query(readFileSync('supabase/migrations/202610210005_student_read_models.sql','utf8'));
 await client.query(readFileSync('supabase/migrations/202610210007_read_model_scope_invalidation.sql','utf8'));
 await client.query(readFileSync('supabase/migrations/202610210010_read_model_answer_corrections.sql','utf8'));
 await client.query(readFileSync('supabase/migrations/202610210011_read_model_json_operator_fix.sql','utf8'));
 await client.query(readFileSync('supabase/migrations/202610210012_read_model_timer_updates.sql','utf8'));
 await client.query('insert into profiles(id) values($1),($2)',[student,other]);
 await client.query("insert into support_targets(id,student_id,data) values('school',$1,'{\"university\":\"QA school\",\"department\":\"QA department\"}')",[student]);
 await client.query("insert into student_preferences values($1,'{}')",[student]);await client.query('insert into student_learning_revisions values($1,1) on conflict do nothing',[student]);
 const metrics:any[]=[];
 for(const count of [100,1000,10000]){
  await client.query('truncate user_answers,interview_sessions,interview_reports,interview_turns,memory_attempts,notifications,student_read_models');
  await client.query("insert into user_answers(student_id,question_id,script,created_at) select $1,'q-'||n,repeat('answer ',300),timestamptz '2026-10-20 00:00:00+00'+n*interval '1 microsecond' from generate_series(1,$2::int)n",[student,count]);
  await client.query("insert into interview_sessions(student_id,kind,mode,target_id,content_version,state,data) select $1,'video','basic','school',1,case when n=1 then 'active' else 'completed' end,'{\"context\":{\"target\":{\"id\":\"school\",\"university\":\"QA school\",\"department\":\"QA department\"}},\"questionQueue\":[{\"id\":\"q\",\"prompt\":\"Current question\"}],\"index\":0}'::jsonb from generate_series(1,$2::int)n",[student,count]);
  await client.query("insert into interview_reports(student_id,session_id,data) select $1,id,jsonb_build_object('kind','video','sections',repeat('feedback ',300)) from interview_sessions",[student]);
  await client.query('analyze user_answers');await client.query('analyze interview_sessions');await client.query('analyze interview_reports');
  observations=[];const coldStart=performance.now(),cold=await server.bootstrap({id:student,role:'student',name:'QA'}),coldMs=performance.now()-coldStart,coldCalls=observations.length;
  assert.equal(cold.summary.answers,count);assert.equal(cold.summary.interviews,count);assert.equal(cold.interviews.length,1);
  observations=[];const warmStart=performance.now(),warm=await server.bootstrap({id:student,role:'student',name:'QA'}),warmMs=performance.now()-warmStart;
  assert.equal(warm.answers.length,0);assert.equal(warm.reports.length,0);assert.ok(!observations.some(call=>call.sql.includes('as unread_notifications')),'warm bootstrap must not rescan full-history counts');
  const warmSamples=[warmMs];for(let sample=0;sample<6;sample++){const start=performance.now();await server.bootstrap({id:student,role:'student',name:'QA'});warmSamples.push(performance.now()-start);}
  const firstWarmObservations=observations.slice(0,observations.length/7);
  const warmRows=firstWarmObservations.reduce((sum,call)=>sum+call.rows,0),bytes=Buffer.byteLength(JSON.stringify(warm));
  observations=[];const listStart=performance.now(),page=await records.getStudentRecords(student,new URLSearchParams({kind:'answers'})),listMs=performance.now()-listStart;
  assert.equal(page.items.length,30);assert.ok(page.items.every((item:any)=>!('script'in item)));const firstQuery=observations.find(call=>call.sql.includes('from user_answers'))!;
  assert.equal(firstQuery.rows,31);const plan=(await client.query('explain (analyze,buffers,format json) '+firstQuery.sql,[student,31])).rows[0]['QUERY PLAN'][0];
  const second=await records.getStudentRecords(student,new URLSearchParams({kind:'answers',cursor:page.page.nextCursor}));assert.equal(second.items.length,30);
  assert.equal(new Set([...page.items,...second.items].map((item:any)=>item.id)).size,60);
  const forbidden=await records.getStudentRecords(other,new URLSearchParams({kind:'answers',questionId:'q-1'}));assert.equal(forbidden.item,null);
  const report=await records.getStudentRecords(student,new URLSearchParams({kind:'reports'}));assert.equal(report.items.length,30);assert.ok(report.items.every((item:any)=>!item.data.sections));
  const revision=async()=>String((await client.query('select revision from student_learning_revisions where student_id=$1',[student])).rows[0].revision);
  let before=await revision();await client.query("update user_answers set script='corrected answer' where student_id=$1 and question_id='q-1'",[student]);assert.notEqual(await revision(),before);
  observations=[];await server.bootstrap({id:student,role:'student',name:'QA'});assert.ok(observations.some(call=>call.sql.includes('as unread_notifications')),'answer correction invalidates the cached source epoch');
  await client.query("insert into notifications(student_id,title,body) values($1,'QA notice','owned')",[student]);let notified=await server.bootstrap({id:student,role:'student',name:'QA'});assert.equal(notified.summary.unread_notifications,1);
  await client.query('update notifications set read_at=now() where student_id=$1',[student]);notified=await server.bootstrap({id:student,role:'student',name:'QA'});assert.equal(notified.summary.unread_notifications,0);
  await client.query("delete from user_answers where student_id=$1 and question_id='q-1'",[student]);const deleted=await server.bootstrap({id:student,role:'student',name:'QA'});assert.equal(deleted.summary.answers,count-1);
  const turn=(await client.query("insert into interview_turns(student_id,question_id,data) values($1,'q','{\"answer\":\"owned\",\"assisted\":false}') returning id",[student])).rows[0];before=await revision();
  await client.query("update interview_turns set data=data||'{\"assisted\":true}' where id=$1 and student_id=$2",[turn.id,student]);assert.notEqual(await revision(),before,'help correction reopens the source epoch');before=await revision();
  await client.query("update interview_turns set data=data||'{\"draft\":\"in progress\"}' where id=$1 and student_id=$2",[turn.id,student]);assert.equal(await revision(),before,'draft-only writes do not destroy the warm cache');
  const activeSession=(await client.query("select id from interview_sessions where student_id=$1 and state='active' limit 1",[student])).rows[0];
  before=await revision();await client.query("update interview_sessions set data=data||'{\"elapsedMs\":8000,\"activeSince\":123,\"timerLeaseUntil\":456,\"paused\":false}',updated_at=now() where id=$1 and student_id=$2",[activeSession.id,student]);assert.equal(await revision(),before,'timer-only interview heartbeats preserve the warm cache');
  await client.query("update interview_sessions set data=jsonb_set(data,'{context,sourceKind}','\"personal\"'),updated_at=now() where id=$1 and student_id=$2",[activeSession.id,student]);assert.notEqual(await revision(),before,'interview context changes invalidate readiness');
  warmSamples.sort((left,right)=>left-right);
  before=await revision();await client.query("update interview_turns set data=data||'{\"hintUsed\":true}' where id=$1 and student_id=$2",[turn.id,student]);assert.notEqual(await revision(),before,'legacy hint alias corrections invalidate cached review');before=await revision();await client.query("update interview_turns set data=data||'{\"aiAssisted\":true}' where id=$1 and student_id=$2",[turn.id,student]);assert.notEqual(await revision(),before,'legacy AI help alias corrections invalidate cached review');
  const otherBefore=String((await client.query('select coalesce((select revision from student_learning_revisions where student_id=$1),0) as revision',[other])).rows[0].revision);before=await revision();
  await client.query("update user_answers set student_id=$2 where student_id=$1 and question_id='q-2'",[student,other]);assert.notEqual(await revision(),before,'old owner revision changes on reassignment');const otherAfter=String((await client.query('select revision from student_learning_revisions where student_id=$1',[other])).rows[0].revision);assert.notEqual(otherAfter,otherBefore,'new owner revision changes on reassignment');
  before=await revision();await client.query("update interview_turns set question_id='scope-corrected-question' where id=$1 and student_id=$2",[turn.id,student]);assert.notEqual(await revision(),before,'question identity correction invalidates the source scope');
  metrics.push({records:count,bootstrapBytes:bytes,coldMs:+coldMs.toFixed(2),warmMs:+warmMs.toFixed(2),warmSamples:7,warmP50Ms:+warmSamples[3].toFixed(2),warmP95Ms:+warmSamples[6].toFixed(2),coldQueries:coldCalls,warmReturnedRows:warmRows,listReturnedRows:firstQuery.rows,listMs:+listMs.toFixed(2),listPlan:plan.Plan['Node Type'],listPlanRows:plan.Plan['Actual Rows'],listSharedHits:plan.Plan['Shared Hit Blocks']});
 }
 await client.query("insert into quiz_assignments(student_id,title,state,source_kind,items,created_at) select $1,'task-'||n,case when n=1 then 'assigned' else 'completed' end,'common','[{\"id\":\"item\",\"correct_answer\":\"private\"}]',timestamptz '2026-10-20 00:00:00+00'+n*interval '1 microsecond' from generate_series(1,80)n",[student]);
 const activeAssignments=await records.getStudentRecords(student,new URLSearchParams({kind:'assignments',state:'active'}));assert.equal(activeAssignments.items.length,1);assert.equal(activeAssignments.items[0].title,'task-1');assert.equal(activeAssignments.items[0].item_count,1);assert.ok(!('items'in activeAssignments.items[0]));
 const firstAssignments=await records.getStudentRecords(student,new URLSearchParams({kind:'assignments'}));const secondAssignments=await records.getStudentRecords(student,new URLSearchParams({kind:'assignments',cursor:firstAssignments.page.nextCursor}));assert.equal(firstAssignments.items.length,30);assert.equal(secondAssignments.items.length,30);
 const commonSession=(await client.query("insert into interview_sessions(student_id,kind,mode,target_id,content_version,state,data) values($1,'video','basic','school',1,'completed','{\"context\":{\"sourceKind\":\"common\"},\"questionQueue\":[{\"id\":\"common_q\",\"common_revision\":7}]}') returning id",[student])).rows[0];
 await client.query("insert into interview_sessions(student_id,kind,mode,target_id,content_version,state,data) values($1,'video','basic','school',7,'completed','{\"context\":{\"sourceKind\":\"personal\"},\"questionQueue\":[{\"id\":\"personal_q\"}]}')",[student]);
 await client.query("insert into interview_reports(student_id,session_id,data) values($1,$2,'{\"kind\":\"video\"}')",[student,commonSession.id]);
 const commonPage=await records.getStudentRecords(student,new URLSearchParams({kind:'interviews',sourceType:'common',sourceVersion:'7'}));assert.equal(commonPage.items.length,1);assert.equal(commonPage.items[0].id,commonSession.id);
 const commonReports=await records.getStudentRecords(student,new URLSearchParams({kind:'reports',sourceType:'common',sourceVersion:'7'}));assert.equal(commonReports.items.length,1);assert.equal(commonReports.items[0].session_id,commonSession.id);
 const hybridId=randomUUID(),manualId=randomUUID(),calendarPlans=[{id:hybridId,date:'2026-09-12',created_at:'2026-09-01T00:00:00Z',target:{id:'hybrid-q',kind:'question',automaticPractice:{hybrid:{kind:'focus'}}}},{id:manualId,date:'2026-09-15',created_at:'2026-09-01T00:00:00Z',target:{id:'manual-q',kind:'question'}}];
 const savedTurns:{id:string;questionId:string}[]=[];
 for(const [questionId,day,trainingPlanId] of [['hybrid-q','2026-09-12T01:00:00Z',hybridId],['hybrid-q','2026-09-12T02:00:00Z',hybridId],['manual-q','2026-09-15T01:00:00Z',null],['manual-q','2026-10-11T01:00:00Z',null]] as const){
  const session=(await client.query("insert into interview_sessions(student_id,kind,mode,target_id,content_version,state,data) values($1,'video','basic','school',1,'completed',$2::jsonb) returning id",[student,JSON.stringify({trainingPlanId,context:{contentVersion:'1'}})])).rows[0];
  const turn=(await client.query('insert into interview_turns(student_id,session_id,question_id,data,created_at) values($1,$2,$3,$4::jsonb,$5) returning id',[student,session.id,questionId,JSON.stringify({answer:'private answer body',assisted:false}),day])).rows[0];savedTurns.push({id:turn.id,questionId});
  await client.query("insert into study_session_events(student_id,session_id,kind,source_id,data,created_at) values($1,$2,'interview_answer',$3,$4::jsonb,$5)",[student,session.id,turn.id,JSON.stringify({sessionId:session.id,questionId,trainingPlanId,contentVersion:'1',sourceType:'personal',answer:'must not be projected'}),day]);
 }
 const monthEvidence=await calendar.calendarPlanEvidence(student,calendarPlans,plannerMonthRange('2026-09'));assert.equal(monthEvidence.filter((event:any)=>event.data.trainingPlanId===hybridId).length,1,'same-plan sessions compact to the latest valid root');assert.ok(monthEvidence.some((event:any)=>event.created_at.toISOString().startsWith('2026-10-11')),'manual September plan retains a later qualifying October answer');assert.ok(monthEvidence.every((event:any)=>!('answer'in event.data)&&!('script'in event.data)));
 await client.query("update interview_turns set data=data||'{\"invalidated\":true}' where id=$1 and student_id=$2",[savedTurns[1].id,student]);const afterInvalidation=await calendar.calendarPlanEvidence(student,calendarPlans,plannerMonthRange('2026-09'));assert.equal(afterInvalidation.find((event:any)=>event.data.trainingPlanId===hybridId).source_id,savedTurns[0].id);
 await client.query("update interview_turns set question_id='changed-source' where id=$1 and student_id=$2",[savedTurns[0].id,student]);const afterScopeCorrection=await calendar.calendarPlanEvidence(student,calendarPlans,plannerMonthRange('2026-09'));assert.equal(afterScopeCorrection.filter((event:any)=>event.data.trainingPlanId===hybridId).length,0,'a corrected question cannot reuse an old plan evidence scope');
 assert.ok(Math.max(...metrics.map(row=>row.bootstrapBytes))-Math.min(...metrics.map(row=>row.bootstrapBytes))<100,'bootstrap bytes must stay constant apart from decimal count widths');
 assert.equal(new Set(metrics.map(row=>row.warmReturnedRows)).size,1,'warm database rows are bounded independently of history size');
 console.log(JSON.stringify({schemaIsolation:true,existingAccountsChanged:false,actualRevisionTriggers:true,correctionDeleteHelpNotificationInvalidation:true,draftOnlyPreservesCache:true,timerHeartbeatPreservesCache:true,legacyHelpAliasesInvalidate:true,bothOwnersInvalidate:true,historicalCalendarEvidence:true,oldAssignmentsAccessible:true,sameNumberSourceVersionsSeparated:true,metrics},null,2));
}catch(error){failure=error;}
finally{if(created){assert.match(schema,/^record_read_qa_[a-f0-9]{16}$/);await client.query('set search_path to public');await client.query(`drop schema "${schema}" cascade`);}await client.end();}
if(failure){console.error(redactEnvironmentSecrets((failure as Error).stack||failure));process.exitCode=1;}
