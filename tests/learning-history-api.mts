// Isolated, rolled-back PostgreSQL fixture. No existing student or paid provider is changed.
// node --import tsx tests/learning-history-api.mts
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import pg from 'pg';
import ts from 'typescript';
import {loadProjectEnv,redactEnvironmentSecrets} from '../scripts/load-env.mjs';
import * as cursors from '../apps/web/src/lib/record-cursor';
import * as rules from '../apps/web/src/lib/learning-record-rules';
import * as provenance from '../apps/web/src/lib/transcript-provenance';

loadProjectEnv();const require=createRequire(import.meta.url),database=new URL(process.env.DATABASE_URL!);
if(!['localhost','127.0.0.1'].includes(database.hostname))throw Error('Local isolated database only.');
const client=new pg.Client({connectionString:process.env.DATABASE_URL}),student=randomUUID(),foreign=randomUUID(),target=`history-${randomUUID()}`,targetOther=`history-${randomUUID()}`;
const stamp='2026-10-20T10:00:00.123456Z',queries:{sql:string;rows:number;ms:number}[]=[],checks:string[]=[];
const check=(value:unknown,label:string)=>{assert.ok(value,label);checks.push(label);};
class ApiError extends Error{constructor(public status:number,message:string){super(message);}}
const module={exports:{}as any};
vm.runInNewContext(ts.transpileModule(readFileSync('apps/web/src/lib/learning-history.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
  module,exports:module.exports,Date,Map,Set,Number,JSON,Promise,Error,
  require(name:string){if(name==='server-only')return{};if(name==='./record-cursor')return cursors;if(name==='./learning-record-rules')return rules;if(name==='./transcript-provenance')return provenance;if(name==='./db')return{ApiError,query:async(sql:string,params:any[])=>{const started=performance.now();const result=await client.query(sql,params);queries.push({sql,rows:result.rows.length,ms:performance.now()-started});return result.rows;}};return require(name);},
});
const user={id:student,role:'student',active:true,email:`history-${student}@gakja.test`,name:'History isolated fixture'};
const history=(options:any={})=>module.exports.getLearningHistoryPage(user,undefined,options);
try{
  await client.connect();await client.query('begin');
  await client.query('insert into profiles(id,email,name,role) values($1,$2,$3,$4),($5,$6,$3,$4)',[student,user.email,user.name,'student',foreign,`history-${foreign}@gakja.test`]);
  await client.query('insert into support_targets(id,student_id,data) values($1,$2,$3),($4,$2,$3)',[target,student,'{}',targetOther]);
  const job=`history-job-${student}`,pkg=`history-package-${student}`;
  await client.query('insert into production_links(id,student_id,data) values($1,$2,$3)',[job,student,'{}']);
  await client.query('insert into content_packages(id,student_id,active_version) values($1,$2,1)',[pkg,student]);
  const question=(id:string,concept=false)=>({id,prompt:id+' 질문',support_target_ids:[target],activity_ids:['activity-a'],answer_elements:['직접'],question_types:[concept?'concept':'personal'],category:concept?'concept':'personal',verification_status:'verified'});
  const content={questions:[question('q-personal'),question('q-concept',true)],answer_designs:[{question_id:'q-personal',required_meanings:['직접']}]};
  await client.query("insert into content_versions(package_id,version,data,learning_hash,status,production_job_ref) values($1,1,$2,'synthetic','published',$3)",[pkg,JSON.stringify(content),job]);
  const answer=(await client.query('insert into user_answers(student_id,question_id,script) values($1,$2,$3) returning id',[student,'q-personal','현재 답변'])).rows[0].id;
  const edit=(await client.query('insert into answer_revisions(answer_id,revision,structure,script,data,created_at) values($1,1,$2,$3,$4,$5) returning id',[answer,'도입','직접 수정한 답변',JSON.stringify({contentVersion:1,question:question('q-personal'),assisted:true,ai_assisted:true}),stamp])).rows[0].id;
  const interview=(await client.query('insert into interview_sessions(student_id,kind,mode,target_id,content_version,data) values($1,$2,$3,$4,1,$5) returning id',[student,'video','basic',target,JSON.stringify({context:{sourceKind:'personal',questions:content.questions,target:{id:target}},experienceCard:{id:'experience-a',revision:2}})])).rows[0].id;
  const turns:any[]=[];
  for(const data of [
    {answer:'최신 답변',answerRevisions:[{revision:1,text:'직접 말한 원본',kind:'answer',at:stamp},{revision:2,text:'정정한 전사',kind:'transcript_correction',at:stamp}],submissionSource:'recording',speechSource:{cleanupStatus:'completed',rawText:'직접 말한 원음'},assistance_recorded:true},
    {answer:'수정된 답변',originalAnswer:'직접 답한 이전 원본',transcriptRevisions:[{revision:3,transcript:'직접 정정한 문장',at:stamp}],answeredAt:stamp},
    {answer:'현재 답변 대체',originalAnswer:'',answeredAt:stamp},
  ])turns.push((await client.query('insert into interview_turns(session_id,student_id,question_id,data,created_at) values($1,$2,$3,$4,$5) returning id',[interview,student,'q-personal',JSON.stringify({question:'현재 질문',rootQuestionId:'q-personal',...data}),stamp])).rows[0].id);
  await client.query('insert into interview_turns(session_id,student_id,question_id,data,created_at) values($1,$2,$3,$4,$5)',[interview,student,'q-personal',JSON.stringify({answer:'무효 답변',invalidated:true}),stamp]);
  const quizItem={id:'memory-legacy',kind:'choice',question_id:'q-concept',prompt:'개념 질문',source_kind:'personal',target_id:target};
  const quiz=(await client.query('insert into quiz_sessions(student_id,mode,content_version,items,metadata) values($1,$2,1,$3,$4) returning id',[student,'oral',JSON.stringify([quizItem]),'{}'])).rows[0].id;
  const oral=(await client.query('insert into quiz_responses(session_id,student_id,item_index,memory_item_id,response,elapsed_ms,rating,data,created_at) values($1,$2,0,$3,$4,1,$5,$6,$7) returning id',[quiz,student,quizItem.id,'직접 개념을 설명했어요','good',JSON.stringify({recording_id:'audio-a',speech_source:{cleanupStatus:'completed',rawText:'직접 발화'}}),stamp])).rows[0].id;
  const commonItem={id:'common-item',kind:'short_speech',question_id:'common-q',prompt:'공통 질문',source_kind:'common',source_type:'general_practice',common_revision:7,target_id:targetOther,target_snapshot:{id:targetOther},source_snapshot:{},category:'experiential',evaluation_method:'self_check'};
  const commonSecond={...commonItem,id:'common-second',question_id:'common-second-question',common_revision:8};
  const assignment=(await client.query('insert into quiz_assignments(student_id,assigned_by,title,package_id,content_version,items,source_kind,target_id,target_snapshot,source_snapshot) values($1,$1,$2,null,0,$3,$4,$5,$6,$7) returning id',[student,'공통 과제',JSON.stringify([commonItem,commonSecond]),'common',targetOther,JSON.stringify(commonItem.target_snapshot),JSON.stringify({questions:[commonItem,commonSecond]})])).rows[0].id;
  const submission=(await client.query('insert into quiz_submissions(assignment_id,student_id,memory_item_id,response,rating,result,submitted_at) values($1,$2,$3,$4,$5,$6,$7) returning id',[assignment,student,commonItem.id,JSON.stringify({response:'공통 답변',hintUsed:true}),'good',JSON.stringify({correct:true,evaluation_method:'self_check'}),stamp])).rows[0].id;
  const secondSubmission=(await client.query('insert into quiz_submissions(assignment_id,student_id,memory_item_id,response,rating,result,submitted_at) values($1,$2,$3,$4,$5,$6,$7) returning id',[assignment,student,commonSecond.id,JSON.stringify({response:'두 번째 공통 답변'}),'good',JSON.stringify({correct:true,evaluation_method:'self_check'}),stamp])).rows[0].id;
  await client.query('insert into student_preferences(student_id,data) values($1,$2)',[student,JSON.stringify({answer_meaning_checks:{[edit]:{checkedMeanings:['직접','없는 의미'],checkedAt:stamp}}})]);
  const all=await history({limit:250});
  const expected=[edit,`${turns[0]}:revision:1`,`${turns[0]}:revision:2`,`${turns[1]}:answer`,`${turns[1]}:transcript:3`,`${turns[2]}:answer-current`,`quiz:${oral}`,`assignment:${submission}`,`assignment:${secondSubmission}`];
  assert.deepEqual(new Set(all.versions.map((row:any)=>row.id)),new Set(expected));checks.push('all four source types and legacy/saved transcript revisions retain canonical identities');
  const edited=all.versions.find((row:any)=>row.id===edit),spoken=all.versions.find((row:any)=>row.id===`${turns[0]}:revision:1`),corrected=all.versions.find((row:any)=>row.id===`${turns[0]}:revision:2`);
  assert.deepEqual(Array.from(edited.self_checked_meanings),['직접']);check(edited.ai_assisted&&edited.assistance_recorded,'AI assistance and valid meaning checks are preserved');
  check(spoken.raw_script==='직접 말한 원음'&&spoken.response_mode==='audio'&&spoken.activity_ids[0]==='activity-a','raw voice, activity, target and response-mode provenance remain attached');
  check(!corrected.raw_script&&corrected.revision_kind==='transcript_correction','a corrected transcript is not relabelled as original speech');
  check(all.versions.find((row:any)=>row.id===`quiz:${oral}`).question_id==='q-concept','legacy dedicated concept ID is recovered from frozen published source');
  const common=await history({sourceType:'common',sourceVersion:7,targetId:targetOther});check(common.versions.length===1&&common.versions[0].id===`assignment:${submission}`,'common sourceVersion is the common revision and target remains scoped');
  const personal=await history({sourceType:'personal',sourceVersion:1,targetId:target});check(personal.versions.length===7,'personal sourceVersion uses the frozen content version');
  let page=await history({limit:3}),found=page.versions.map((row:any)=>row.id),cursor=page.versionsPage.nextCursor;
  await client.query('insert into answer_revisions(answer_id,revision,structure,script,data,created_at) values($1,2,$2,$3,$4,$5)',[answer,'','새로 추가한 답변',JSON.stringify({contentVersion:1,question:question('q-personal')}),'2026-10-21T10:00:00Z']);
  while(cursor){page=await history({limit:3,cursor});found.push(...page.versions.map((row:any)=>row.id));cursor=page.versionsPage.nextCursor;}
  assert.deepEqual(new Set(found),new Set(expected));assert.equal(found.length,expected.length);checks.push('same-microsecond + ID cursors have no duplicates or missing records while a newer record is inserted');
  await assert.rejects(()=>module.exports.getLearningHistoryPage(user,foreign),error=>(error as any).status===403);checks.push('foreign student history is forbidden before any source body query');
  await assert.rejects(()=>history({targetId:'foreign-target'}),error=>(error as any).status===404);checks.push('foreign target is rejected');
  await assert.rejects(()=>history({cursor:(all.versionsPage.nextCursor||'invalid')}),error=>(error as any).status===400);checks.push('malformed or wrong-scope cursors cannot fetch unrelated history');
  check(queries.filter(row=>row.sql.includes('from learning_answer_history_index')).every(row=>row.rows<=251),'metadata retrieval is bounded before projection');
  check(!queries.some(row=>/select v.version,v.data from content_versions/.test(row.sql)),'archive queries return only page-required question/design fragments');
  const smallStarted=performance.now(),small=await history({limit:3}),smallMs=performance.now()-smallStarted;
  await client.query(`insert into answer_revisions(answer_id,revision,structure,script,data,created_at)
    select $1,n+2,'','직접 쓴 대량 검증 답변',$2::jsonb,$3::timestamptz from generate_series(1,10000)n`,[answer,JSON.stringify({contentVersion:1,question:question('q-personal')}),stamp]);
  const scaleQueryStart=queries.length,scaleStarted=performance.now(),scaled=await history({limit:3}),scaleMs=performance.now()-scaleStarted,scaleQueries=queries.slice(scaleQueryStart);
  assert.equal(scaled.versions.length,3);check(scaleQueries.every(row=>row.rows<=4),'10,000 historical revisions still fetch only one metadata page and selected source bodies');
  const bytes=(value:any)=>Buffer.byteLength(JSON.stringify(value));check(bytes(scaled)<15000,'response size stays bounded after 10,000 added revisions');
  console.log(JSON.stringify({passed:checks.length,checks,queryCount:queries.length,metadataMaxMs:Math.max(...queries.filter(row=>row.sql.includes('learning_answer_history_index')).map(row=>row.ms)),scale:{smallMs,scaleMs,smallBytes:bytes(small),scaleBytes:bytes(scaled),maxRowsReturned:Math.max(...scaleQueries.map(row=>row.rows))}}));
}catch(error){console.error(redactEnvironmentSecrets(error instanceof Error?error.stack:String(error)));process.exitCode=1;}
finally{await client.query('rollback').catch(()=>{});await client.end();}
