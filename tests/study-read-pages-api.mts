// Real PostgreSQL cache/pagination QA, entirely rolled back and confined to a synthetic student.
// node --import tsx tests/study-read-pages-api.mts
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import pg from 'pg';
import ts from 'typescript';
import {createRequire} from 'node:module';
import {loadProjectEnv,redactEnvironmentSecrets} from '../scripts/load-env.mjs';
import * as rules from '../apps/web/src/lib/learning-record-rules';
import * as targets from '../apps/web/src/lib/learning-target-scope';
import * as next from '../apps/web/src/lib/next-learning-question';
import * as growth from '../apps/web/src/lib/learning-growth';
import * as cursors from '../apps/web/src/lib/record-cursor';

loadProjectEnv();if(!['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname))throw Error('Local isolated database only.');
const require=createRequire(import.meta.url),client=new pg.Client({connectionString:process.env.DATABASE_URL}),student=randomUUID(),other=randomUUID(),current=randomUUID(),old=randomUUID();
const queries:{sql:string;params:any[];rows:number;ms:number}[]=[],checks:string[]=[],target=`study-target-${student}`;
const check=(value:unknown,label:string)=>{assert.ok(value,label);checks.push(label);};
class ApiError extends Error{constructor(public status:number,message:string){super(message);}}
const db={query:async(sql:string,params:any[]=[])=>{const before=performance.now(),result=await client.query(sql,params);queries.push({sql,params,rows:result.rows.length,ms:performance.now()-before});return result;}};
function load(file:string,dependencies:Record<string,any>){const module={exports:{}as any};vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,Date,Map,Set,Number,JSON,Promise,Error,require(name:string){if(name==='server-only')return{};if(dependencies[name])return dependencies[name];return require(name);}});return module.exports;}
const adapter={ApiError,transaction:async(work:Function)=>work(db)},cache=load('apps/web/src/lib/student-read-model.ts',{'./db':adapter});
const api=load('apps/web/src/lib/study-sessions.ts',{'./db':adapter,'./student-read-model':cache,'./record-cursor':cursors,'./learning-record-rules':rules,'./learning-target-scope':targets,'./next-learning-question':next,'./learning-growth':growth});
const user={id:student,role:'student',active:true,email:`study-read-${student}@gakja.test`,name:'isolated study read fixture'};
const snapshot={id:target,university:'합성대학교',campus:'본교',department:'합성학과',admission_year:2027,admission_type:'학생부종합',interview_stage:'1단계'};
const data=(n:number)=>({questionId:'question-'+n%5,memoryItemId:'memory-'+n%5,prompt:'전체 이력 질문 '+n%5,mode:'choice',response:'검증 답변',outcome:false,verified:true,assistance_recorded:true,sourceType:'personal',contentVersion:1,targetId:target,targetSnapshot:snapshot});
try{
  await client.connect();await client.query('begin');
  await client.query("insert into profiles(id,email,name,role) values($1,$2,'isolated read fixture','student'),($3,$4,'other isolated fixture','student')",[student,user.email,other,`study-read-${other}@gakja.test`]);
  await client.query('insert into support_targets(id,student_id,data) values($1,$2,$3)',[target,student,JSON.stringify(snapshot)]);
  await client.query('insert into study_sessions(id,student_id,last_seen_at) values($1,$2,now())',[current,student]);
  await client.query('insert into study_session_tabs(session_id,student_id,tab_id) values($1,$2,$3)',[current,student,randomUUID()]);
  const frozen={eventCount:1,quiz:{answered:1},events:[{id:'frozen-event',kind:'quiz_response',source_id:'frozen-source',created_at:'2026-10-01T00:00:00Z',data:{response:'원본 고정 답변'}}]};
  await client.query("insert into study_sessions(id,student_id,state,started_at,ended_at,report) values($1,$2,'finalized','2026-10-01','2026-10-01',$3)",[old,student,JSON.stringify(frozen)]);
  for(let index=0;index<100;index++)await client.query('insert into study_session_events(session_id,student_id,kind,source_id,data,created_at) values($1,$2,$3,$4,$5,$6)',[current,student,'quiz_response',randomUUID(),JSON.stringify(data(index)),'2026-10-20T10:00:00.123456Z']);
  for(let index=0;index<35;index++)await client.query("insert into study_sessions(student_id,state,started_at,ended_at,report) values($1,'finalized','2026-10-02','2026-10-02',$2)",[student,JSON.stringify(frozen)]);
  const cold=await api.getStudySessions(user);
  check(cold.totals.eventCount===100&&cold.totals.weakPoints.length===5,'full historical totals and weakness groups are independent of the visible page');
  check(cold.history.length===30&&cold.historyPage.hasMore&&cold.sessions.length===30&&cold.sessionsPage.hasMore,'default response includes only first30 history and session summaries');
  check(cold.current.report.eventCount===100&&cold.current.report.events.length===30&&cold.current.eventsPage.hasMore,'current session keeps full counters and bounded recent event bodies');
  const warmStart=queries.length,warm=await api.getStudySessions(user),warmQueries=queries.slice(warmStart);
  assert.deepEqual(JSON.parse(JSON.stringify(warm.totals)),JSON.parse(JSON.stringify(cold.totals)));check(!warmQueries.some(row=>row.sql.includes('from study_imported_events where student_id=$1 order by created_at,id')),'warm overview never rereads all historical event bodies');
  check(warmQueries.filter(row=>row.sql.includes("select 'quiz_response' as kind")).every(row=>row.params.slice(1).every((ids:any[])=>ids.length<=30)),'warm source normalization fetches only source IDs in the visible page');
  let page=await api.getStudySessions(user,null,{view:'history',limit:17}),seen=page.history.map((row:any)=>row.id),cursor=page.historyPage.nextCursor;
  await client.query('insert into study_session_events(session_id,student_id,kind,source_id,data) values($1,$2,$3,$4,$5)',[current,student,'quiz_response',randomUUID(),JSON.stringify({...data(0),outcome:true})]);
  while(cursor){page=await api.getStudySessions(user,null,{view:'history',cursor,limit:17});seen.push(...page.history.map((row:any)=>row.id));cursor=page.historyPage.nextCursor;}
  check(seen.length===100&&new Set(seen).size===100,'same-time history pagination does not duplicate or miss old records while a newer event is added');
  const changed=await api.getStudySessions(user);check(changed.totals.eventCount===101&&changed.totals.weakPoints.length===4&&changed.totals.resolvedPoints.length===1,'source revision changes invalidate compact summary and independent success resolves the correct scope');
  let reports=await api.getStudySessions(user,null,{view:'sessions',limit:11}),reportIds=reports.sessions.map((row:any)=>row.id),reportCursor=reports.sessionsPage.nextCursor;
  while(reportCursor){reports=await api.getStudySessions(user,null,{view:'sessions',limit:11,cursor:reportCursor});reportIds.push(...reports.sessions.map((row:any)=>row.id));reportCursor=reports.sessionsPage.nextCursor;}
  check(reportIds.length===36&&new Set(reportIds).size===36,'session summaries use started timestamp and stable ID pagination');
  const detail=await api.getStudySessions(user,old);assert.deepEqual(detail.session.report,frozen);checks.push('owned frozen report detail remains byte-equivalent in content and never rewrites original events');
  await assert.rejects(()=>api.getStudySessions({...user,id:other},old),(error:any)=>error.status===404);checks.push('another student cannot fetch a private report');
  await assert.rejects(()=>api.getStudySessions({...user,role:'admin'}),(error:any)=>error.status===403);checks.push('nonstudent access is rejected');
  const counts=await client.query('select count(*)::int as count from student_read_models where student_id=$1',[student]);check(counts.rows[0].count===1,'repeat overview builds reuse one compact summary record rather than storing page history');
  const correctionItem={id:'corrected-memory',kind:'short_speech',question_id:'correction-question',prompt:'정정 대상 질문'};
  const quiz=(await client.query("insert into quiz_sessions(student_id,mode,content_version,items) values($1,'answer',0,$2) returning id",[student,JSON.stringify([correctionItem])])).rows[0].id;
  const correctedSource=(await client.query("insert into quiz_responses(session_id,student_id,item_index,memory_item_id,response,elapsed_ms,rating,hint_used,outcome,data) values($1,$2,0,$3,'정정 대상 답변',1,'good',true,true,$4) returning id",[quiz,student,correctionItem.id,JSON.stringify({assisted:true,assistance_recorded:true})])).rows[0].id;
  const correctionScope={...data(0),questionId:correctionItem.question_id,memoryItemId:correctionItem.id,contentVersion:0};
  await client.query("insert into study_session_events(session_id,student_id,kind,source_id,data,created_at) values($1,$2,'quiz_response',$3,$4,'2026-10-20T10:00:01Z'),($1,$2,'quiz_response',$5,$6,'2026-10-20T10:00:02Z')",[current,student,randomUUID(),JSON.stringify(correctionScope),correctedSource,JSON.stringify({...correctionScope,quizSessionId:quiz,assisted:true,hintUsed:true,timedOut:true})]);
  const assisted=await api.getStudySessions(user);check(assisted.totals.weakPoints.some((row:any)=>row.questionId===correctionItem.question_id),'a corrected true outcome with current assistance does not independently resolve the older failure');
  await client.query("update quiz_responses set hint_used=false,data=$2 where id=$1",[correctedSource,JSON.stringify({assisted:false,assistance_recorded:true})]);
  const independent=await api.getStudySessions(user);check(!independent.totals.weakPoints.some((row:any)=>row.questionId===correctionItem.question_id),'explicit false assistance in the current source overrides true historical snapshots and resolves on rebuild');
  await client.query('update quiz_responses set outcome=false where id=$1',[correctedSource]);
  const reopened=await api.getStudySessions(user);check(reopened.totals.weakPoints.some((row:any)=>row.questionId===correctionItem.question_id),'source outcome correction reactivates the exact weakness scope');
  await client.query('delete from quiz_responses where id=$1',[correctedSource]);
  const deleted=await api.getStudySessions(user);check(deleted.totals.eventCount===reopened.totals.eventCount-1,'deleted known source is excluded from current totals instead of reusing its old valid event snapshot');
  const room=(await client.query("insert into interview_sessions(student_id,kind,content_version,data) values($1,'video',0,'{}') returning id",[student])).rows[0].id;
  const turn=(await client.query("insert into interview_turns(session_id,student_id,question_id,data) values($1,$2,'interview-correction',$3) returning id",[room,student,JSON.stringify({answer:'현재 면접 답변',assisted:true,assistance_recorded:true})])).rows[0].id;
  await client.query("insert into study_session_events(session_id,student_id,kind,source_id,data) values($1,$2,'interview_answer',$3,$4)",[current,student,turn,JSON.stringify({sessionId:room,questionId:'interview-correction',kind:'video',answer:'과거 면접 답변',assisted:false})]);
  const sourceHelp=await api.getStudySessions(user);check(sourceHelp.totals.interviews.assisted===1,'interview assistance is reread from the owned current turn');
  await client.query('update interview_turns set data=$2 where id=$1',[turn,JSON.stringify({answer:'현재 면접 답변',assisted:false,assistance_recorded:true})]);
  check((await api.getStudySessions(user)).totals.interviews.assisted===0,'interview help correction overrides the old source snapshot');
  await client.query("update interview_turns set data=data||'{\"invalidated\":true}'::jsonb where id=$1",[turn]);
  check((await api.getStudySessions(user)).totals.interviews.answered===0,'invalidated interview turns leave current totals while frozen reports stay unchanged');
  await client.query("update interview_turns set data=data-'invalidated' where id=$1",[turn]);await client.query("update interview_sessions set state='cancelled' where id=$1",[room]);
  check((await api.getStudySessions(user)).totals.interviews.answered===0,'cancelled interview sessions cannot supply a current successful source fact');
  const exhaustive=api.studySummary(Array.from({length:100},(_,n)=>[
    {id:'failed-'+n,kind:'quiz_response',source_id:'failed-'+n,created_at:'2026-10-19',data:{...data(0),questionId:'resolved-'+n,memoryItemId:'resolved-'+n}},
    {id:'verified-'+n,kind:'quiz_response',source_id:'verified-'+n,created_at:'2026-10-20',data:{...data(0),questionId:'resolved-'+n,memoryItemId:'resolved-'+n,outcome:true}},
    {id:'weak-'+n,kind:'quiz_response',source_id:'weak-'+n,created_at:'2026-10-21',data:{...data(0),questionId:'weak-'+n,memoryItemId:'weak-'+n}},
  ]).flat()),compact=api.compactStudySummary(exhaustive);
  check(exhaustive.weakPoints.length===100&&exhaustive.resolvedPoints.length===100&&exhaustive.independentlyVerified.questions.length===100&&compact.weakPointCount===100&&compact.resolvedPointCount===100&&compact.independentlyVerified.count===100&&compact.weakPoints.length===30&&compact.resolvedPoints.length===30&&compact.independentlyVerified.questions.length===30,'overview compaction bounds every question array while preserving complete counts and the pure frozen-report summary');
  const beforeLarge=(await api.getStudySessions(user)).totals.eventCount;
  const largeStart=queries.length;
  const insertDistinct=async(start:number,end:number)=>client.query(`insert into study_session_events(session_id,student_id,kind,source_id,data,created_at) select $1,$2,'quiz_response',gen_random_uuid()::text,$3::jsonb||jsonb_build_object('questionId','old-question-'||lpad(n::text,5,'0'),'memoryItemId','old-memory-'||lpad(n::text,5,'0'),'contentVersion',n+10),'2026-10-19'::timestamptz from generate_series($4::int,$5::int)n`,[current,student,JSON.stringify(data(2)),start,end]);
  await insertDistinct(1,1000);await api.getStudySessions(user);
  const thousandWarm=await api.getStudySessions(user),thousandWarmBytes=Buffer.byteLength(JSON.stringify(thousandWarm));
  await insertDistinct(1001,10000);
  const largeCold=await api.getStudySessions(user);const largeWarmStart=performance.now(),startIndex=queries.length,largeWarm=await api.getStudySessions(user),largeWarmMs=performance.now()-largeWarmStart,largeWarmQueries=queries.slice(startIndex);
  const largeWarmBytes=Buffer.byteLength(JSON.stringify(largeWarm));
  check(largeCold.totals.eventCount===beforeLarge+10000&&largeWarm.totals.eventCount===beforeLarge+10000&&largeWarm.history.length===30,'ten thousand distinct old question/version scopes change full totals but never expand visible history');
  check(largeWarm.totals.weakPointCount===thousandWarm.totals.weakPointCount+9000&&largeWarm.totals.weakPoints.length===30&&largeWarm.current.report.weakPointCount===largeWarm.totals.weakPointCount&&largeWarm.current.report.weakPoints.length===30&&Math.abs(largeWarmBytes-thousandWarmBytes)<2000,'one thousand to ten thousand distinct old scopes keep warm overview bytes bounded and current-session full counts aligned');
  check(!largeWarmQueries.some(row=>row.sql.includes('order by created_at,id'))&&largeWarmQueries.every(row=>row.rows<=31),'warm DB rows are bounded after ten thousand history events');
  console.log(JSON.stringify({passed:checks.length,checks,warmQueries:warmQueries.length,largeWarmQueries:largeWarmQueries.length,largeWarmMs,thousandWarmBytes,largeWarmBytes,largestWarmRowCount:Math.max(...largeWarmQueries.map(row=>row.rows)),coldBuildQueries:queries.slice(largeStart,startIndex).length,providerCalls:0,rolledBack:true}));
}catch(error){console.error(redactEnvironmentSecrets(error instanceof Error?error.stack:String(error)));process.exitCode=1;}
finally{await client.query('rollback').catch(()=>{});await client.end();}
