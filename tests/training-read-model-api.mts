// Full-history aggregation versus bounded warm reads, in an isolated local schema.
// node --conditions=react-server --import tsx tests/training-read-model-api.mts
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {loadProjectEnv,projectRoot,redactEnvironmentSecrets} from '../scripts/load-env.mjs';

loadProjectEnv();const original=process.env.DATABASE_URL!,address=new URL(original);
if(process.env.AUTH_MODE!=='local'||!['localhost','127.0.0.1'].includes(address.hostname))throw Error('Local isolated PostgreSQL only.');
const schema='training_model_qa_'+randomUUID().replaceAll('-',''),student=randomUUID();
assert.match(schema,/^training_model_qa_[a-f0-9]{32}$/);
const admin=new pg.Client({connectionString:original});await admin.connect();await admin.query(`create schema ${schema}`);
address.searchParams.set('options',`-c search_path=${schema},public`);process.env.DATABASE_URL=address.toString();
registerHooks({resolve(specifier,context,nextResolve){
 if(specifier==='server-only')return {url:pathToFileURL(join(projectRoot,'node_modules/next/dist/compiled/server-only/empty.js')).href,shortCircuit:true};
 if(specifier.startsWith('@/'))return {url:pathToFileURL(join(projectRoot,'apps/web/src',specifier.slice(2)+'.ts')).href,shortCircuit:true};
 return nextResolve(specifier,context);
}});
const {pool}=await import('../apps/web/src/lib/db.ts');
const {getTrainingReadModel}=await import('../apps/web/src/lib/training-read-model.ts');
const {readStudentModel}=await import('../apps/web/src/lib/student-read-model.ts');
const {getHybridTraining}=await import('../apps/web/src/lib/hybrid-training-store.ts');
const {getLearningWorkflows}=await import('../apps/web/src/lib/learning-workflows.ts');
let traces:{sql:string;rows:number;ms:number}[]=[];
pool.on('connect',client=>{
 const originalQuery=client.query.bind(client);
 (client as any).query=(...args:any[])=>{
  const started=performance.now(),result=(originalQuery as any)(...args);
  if(result&&typeof result.then==='function')return result.then((value:any)=>{traces.push({sql:String(args[0]),rows:value.rows?.length||0,ms:performance.now()-started});return value;});
  return result;
 };
});
let failure:unknown;const metrics:any[]=[];
try{
 // Upload/storage migrations explicitly address public; this read-model fixture never executes them.
 for(const file of readdirSync(join(projectRoot,'supabase/migrations')).filter(name=>name.endsWith('.sql')&&(name<'20261017'||name>='20261021')).sort())await pool.query(readFileSync(join(projectRoot,'supabase/migrations',file),'utf8'));
 await pool.query('insert into profiles(id,email,name,role) values($1,$2,$3,$4)',[student,`training-model-${student}@gakja.test`,'격리 집계 검사','student']);
 const target={id:'qa-target',university:'서울시립대학교',department:'환경공학부',campus:'본교',admission_year:2027,admission_type:'학생부종합Ⅰ',interview_stage:'2단계'};
 const question={id:'qa-question',prompt:'내가 한 탐구를 설명해 주세요.',activity_ids:['qa-activity'],support_target_ids:[target.id],question_types:['personal'],answer_elements:[],depth:'basic'};
 const learning={activities:[{id:'qa-activity',title:'탐구 활동',fact_confirmation:'confirmed_from_record',priority_assignments:[]}],questions:[question],answer_designs:[],memory_items:[],source_refs:[],answer_scripts:[],support_targets:[target],student_context:{core_keywords:[],representative_activity_ids:[],confirmed_goals:[]}};
 await pool.query('insert into support_targets(id,student_id,data) values($1,$2,$3)',[target.id,student,JSON.stringify(target)]);
 await pool.query("insert into production_links(id,student_id) values('qa-job',$1)",[student]);
 await pool.query("insert into content_packages(id,student_id,active_version) values('qa-package',$1,1)",[student]);
 await pool.query("insert into content_versions(package_id,version,data,learning_hash,status,production_job_ref) values('qa-package',1,$1,'qa','published','qa-job')",[JSON.stringify(learning)]);
 await pool.query("insert into student_preferences(student_id,data) values($1,'{}')",[student]);
 const session=(await pool.query("insert into interview_sessions(student_id,kind,target_id,content_version,state,data) values($1,'chat',$2,1,'completed',$3) returning id",[student,target.id,JSON.stringify({context:{sourceKind:'personal',contentVersion:1,target,questions:[question],activities:learning.activities}})])).rows[0].id;
 const visit=(await pool.query("insert into study_sessions(student_id,state) values($1,'finalized') returning id",[student])).rows[0].id;
 for(const count of [100,1000,10000]){
  await pool.query('delete from study_session_events where student_id=$1',[student]);await pool.query('delete from interview_turns where student_id=$1',[student]);
  await pool.query("insert into interview_turns(student_id,session_id,question_id,data,created_at) select $1,$2,'qa-question',$3::jsonb,timestamptz '2026-10-20T10:00:00Z'+n*interval '1 millisecond' from generate_series(1,$4::int)n",[student,session,JSON.stringify({question:question.prompt,answer:'직접 관찰하고 비교한 과정을 설명했습니다.',assistance_recorded:true,assisted:false,submissionSource:'text'}),count]);
  await pool.query("insert into study_session_events(student_id,session_id,kind,source_id,data,created_at) select $1,$2,'interview_answer',id::text,$3::jsonb,created_at from interview_turns where student_id=$1",[student,visit,JSON.stringify({questionId:question.id,targetId:target.id,targetSnapshot:target,contentVersion:1,sourceType:'personal',sessionId:session,answer:'직접 관찰하고 비교한 과정을 설명했습니다.',assistance_recorded:true,assisted:false})]);
  traces=[];const start=performance.now(),cold=await getTrainingReadModel(student,'2026-10-21'),coldMs=performance.now()-start;
  assert.equal(cold.readiness[target.id].items.find((item:any)=>item.id==='qa-activity')?.mainAnswers,count);
  const coldDbMs=traces.reduce((sum,row)=>sum+row.ms,0),coldQueries=traces.length;
  traces=[];const samples:number[]=[];let warm=cold,first:any[]=[];
  for(let n=0;n<5;n++){const start=performance.now();warm=await getTrainingReadModel(student,'2026-10-21');samples.push(performance.now()-start);if(n===0){first=traces;traces=[];}}
  assert.equal(warm.readiness[target.id].items.find((item:any)=>item.id==='qa-activity')?.mainAnswers,count);
  assert.ok(!first.some(trace=>/from (interview_turns|study_session_events|content_versions|experience_cards)/.test(trace.sql)),'warm aggregate must not reread source history');
  assert.ok(first.every(trace=>trace.rows<=1),'warm DB returns at most one compact row per query');
  assert.ok(warm.questions.every((item:any)=>item.attempts.length<=1),'planning carries only the latest attempt, while readiness counts the entire history');
  samples.sort((a,b)=>a-b);metrics.push({records:count,compactBytes:Buffer.byteLength(JSON.stringify(warm)),coldMs:+coldMs.toFixed(2),coldDbMs:+coldDbMs.toFixed(2),coldQueries,warmP50Ms:+samples[2].toFixed(2),warmMaxMs:+samples[4].toFixed(2),warmQueries:first.length,warmReturnedRows:first.reduce((sum,row)=>sum+row.rows,0)});
 }
 assert.ok(Math.max(...metrics.map(row=>row.compactBytes))-Math.min(...metrics.map(row=>row.compactBytes))<200,'repeat attempts do not expand the warm aggregate payload');
 const before=await getTrainingReadModel(student,'2026-10-21');
 await pool.query("update interview_turns set data=data||'{\"invalidated\":true}' where id=(select id from interview_turns where student_id=$1 limit 1)",[student]);
 const after=await getTrainingReadModel(student,'2026-10-21');assert.notEqual(after.sourceRevision,before.sourceRevision);assert.equal(after.readiness[target.id].items.find((item:any)=>item.id==='qa-activity')?.mainAnswers,9999);
 await pool.query("update interview_turns set data=data||'{\"assisted\":true}' where student_id=$1",[student]);
 await getTrainingReadModel(student,'2026-10-21');
 const manyReviews=await getTrainingReadModel(student,'2026-10-21'),review=manyReviews.review.questions.find(row=>row.questionId===question.id)!;
 assert.equal(review.requestCount,9999);assert.equal(review.requestIds.length,30);assert.equal(review.status,'active');
 assert.ok(Buffer.byteLength(JSON.stringify(manyReviews))<100_000,'ten thousand automatic requests stay out of screen payloads');
 const user={id:student,role:'student',active:true,name:'격리 집계 검사',email:`training-model-${student}@gakja.test`} as any;
 const overview=await getLearningWorkflows(user);
 assert.deepEqual(overview.readiness.find((row:any)=>row.target_id===target.id)?.unanswered_question_ids,[],'grouped SQL preserves numeric admission-year identity and all valid answers');
 await pool.query("update student_preferences set data=data||jsonb_build_object('trainingDiagnostics',$2::jsonb) where student_id=$1",[student,JSON.stringify({[target.id]:{state:'completed',targetSnapshot:target,sourceType:'personal',sourceVersion:1}})]);
 assert.equal((await getHybridTraining(student,target.id,'2026-10-21')).diagnostics[target.id].state,'completed');
 await pool.query("insert into content_versions(package_id,version,data,learning_hash,status,production_job_ref) values('qa-package',2,$1,'qa-2','published','qa-job')",[JSON.stringify({...learning,questions:[{...question,prompt:'재발행한 질문'}]})]);
 await pool.query("update content_packages set active_version=2 where student_id=$1",[student]);
 assert.equal((await getHybridTraining(student,target.id,'2026-10-21')).diagnostics[target.id],undefined,'a diagnosis for the previous publication cannot skip the new diagnosis');
 assert.deepEqual((await getLearningWorkflows(user)).readiness.find((row:any)=>row.target_id===target.id)?.unanswered_question_ids,[question.id],'an old-publication answer cannot mark the new question answered');
 const longScope=Array.from({length:250},()=>randomUUID()).join('|');
 assert.deepEqual(await readStudentModel(student,'qa-long-scope',longScope,async()=>({stable:true})),{stable:true});
 assert.deepEqual(await readStudentModel(student,'qa-long-scope',longScope,async()=>{throw Error('The same scope must hit the cache.');}),{stable:true});
 assert.equal((await pool.query("select length(scope) as length from student_read_models where student_id=$1 and kind='qa-long-scope'",[student])).rows[0].length,64);
 await pool.query("update student_read_models set computed_at=now()-interval '15 days' where student_id=$1 and kind='qa-long-scope'",[student]);
 await readStudentModel(student,'qa-retention','current',async()=>({stable:true}));
 assert.equal((await pool.query("select count(*)::int as n from student_read_models where student_id=$1 and kind='qa-long-scope'",[student])).rows[0].n,0);
 console.log(JSON.stringify({schemaIsolation:true,existingAccountsChanged:false,fullCountsAndInvalidationVerified:true,tenThousandReviewRequestsBounded:true,oldDiagnosisExcludedAfterRepublication:true,longScopeAndCacheRetentionVerified:true,metrics},null,2));
}catch(error){failure=error;}finally{
 await pool.end();await admin.query(`drop schema ${schema} cascade`);await admin.end();process.env.DATABASE_URL=original;
}
if(failure){console.error(redactEnvironmentSecrets((failure as Error).stack||failure));process.exitCode=1;}
