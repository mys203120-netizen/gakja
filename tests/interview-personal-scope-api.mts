import * as interviewPolicyModule from '../apps/web/src/lib/interview-policy';
import * as interviewFeedbackModule from '../apps/web/src/lib/interview-feedback';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
import {loadProjectEnv,redactEnvironmentSecrets} from '../scripts/load-env.mjs';
loadProjectEnv();
const base=process.env.TEST_BASE_URL||'http://localhost:3101';
if(process.env.AUTH_MODE!=='local'||!['localhost','127.0.0.1'].includes(new URL(base).hostname)||!['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname))throw Error('Local synthetic accounts only');
const db=new pg.Client({connectionString:process.env.DATABASE_URL});
const users=[randomUUID(),randomUUID()],fixture=randomUUID(),targetId='target_'+fixture,packageId='interview-scope-'+fixture,jobId=packageId+'-job';
const tokens=users.map(()=>randomBytes(32).toString('hex')),hashes=tokens.map(token=>createHash('sha256').update(token).digest('hex'));
let checks=0;
function check(value:unknown,label:string){assert.ok(value,label);checks++;}
async function request(path:string,body?:Record<string,unknown>,actor:number|null=0,status=200){
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Origin:base,'Content-Type':'application/json',...(actor===null?{}:{Cookie:'gakja_session='+tokens[actor]})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000)});
  const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));checks++;return result;
}
const target={id:targetId,university:'고려대학교',department:'경영학과',major:'경영학과',campus:'본교',admission_type:'고른기회',admission_year:2027,synthetic:true};
const question={id:'personal-'+fixture,prompt:'동아리 활동에서 맡은 역할과 배운 점을 설명해 주세요.',support_target_ids:[targetId],activity_ids:[],source_ref_ids:[],grounding_types:['document_based'],question_types:['activity'],verification_status:'confirmed_from_record'};
const passage={...question,id:'passage-'+fixture,prompt:'제시문을 읽고 두 주장에 대해 설명해 주세요.',grounding_types:['passage_based']};
const learning={synthetic:true,student_context:{},support_targets:[target],questions:[question,passage],activities:[],source_refs:[],answer_scripts:[],memory_items:[]};
await db.connect();
try{
  const protectedBefore=(await db.query('select id,md5(data::text) digest from support_targets order by id')).rows;
  for(let index=0;index<users.length;index++){
    await db.query('insert into profiles(id,email,name,role) values($1,$2,$3,$4)',[users[index],`interview-scope-${fixture}-${index}@gakja.test`,'개인 면접 범위 검증','student']);
    await db.query("insert into sessions(id,user_id,expires_at) values($1,$2,now()+interval '15 minutes')",[hashes[index],users[index]]);
  }
  await db.query('insert into support_targets(id,student_id,data) values($1,$2,$3)',[targetId,users[0],JSON.stringify(target)]);
  await db.query('insert into production_links(id,student_id,data) values($1,$2,$3)',[jobId,users[0],JSON.stringify({synthetic:true})]);
  await db.query('insert into content_packages(id,student_id,active_version) values($1,$2,2)',[packageId,users[0]]);
  for(const version of [1,2])await db.query("insert into content_versions(package_id,version,data,learning_hash,status,production_job_ref) values($1,$2,$3,'synthetic-scope','published',$4)",[packageId,version,JSON.stringify({...learning,questions:[{...question,prompt:version===1?question.prompt:'활동에서 어려움을 해결한 과정을 설명해 주세요.'},passage]}),jobId]);
  const previewPath='/api/interviews?preview=1&targetId='+targetId;
  await request(previewPath,undefined,null,401);
  const preview=await request(previewPath);
  check(preview.practiceAllowed&&preview.practiceScope==='personal_record','general Chat entry permits personal record practice');
  check(preview.questions.length===1&&preview.questions[0].id===question.id,'preview excludes passage questions');
  const common=await request(previewPath+'&sourceType=common');check(common.practiceAllowed===false&&common.questions.length===0,'explicit common selection cannot use the personal exception');
  const start={action:'start',kind:'chat',targetId,questionCount:1};
  const started=await request('/api/interviews',{...start,mode:'university',requestId:randomUUID()});
  check(started.session.mode==='basic'&&started.session.practiceLabel==='일반 경험 면접','school mode becomes explicitly general practice');
  const saved=(await db.query('select data,content_version,target_id from interview_sessions where id=$1 and student_id=$2',[started.session.id,users[0]])).rows[0];
  check(saved.content_version===2&&saved.target_id===targetId&&saved.data.practiceScope==='personal_record','saved session preserves target and published version');
  check(saved.data.schoolProfile===null&&saved.data.schoolPracticeOnly&&saved.data.context.schoolTalent===null&&saved.data.context.majorContext===null,'general practice never borrows an official school profile');
  check(saved.data.questionQueue.length===1&&saved.data.questionQueue[0].id===question.id,'only the published personal root enters the session');
  const finished=await request('/api/interviews',{action:'finish',sessionId:started.session.id});
  check(finished.report.practiceScope==='personal_record'&&finished.report.practiceLabel==='일반 경험 면접'&&finished.report.sections.length===0,'empty self-check report preserves scope without a paid AI call');
  await request('/api/interviews',{...start,sourceType:'common'},0,409);
  await request('/api/interviews',{...start,sourceType:'personal',questionId:passage.id,sourceVersion:1},0,409);
  await request('/api/interviews',{...start,sourceType:'personal',questionId:question.id,sourceVersion:99},0,404);
  await request(previewPath+'&sourceType=personal&sourceVersion=1',undefined,1,409);
  await request('/api/interviews',{...start},1,404);
  await request('/api/interviews?id='+started.session.id,undefined,1,404);
  await db.query('update support_targets set data=$2::jsonb where id=$1 and student_id=$3',[targetId,JSON.stringify({...target,department:'경제학과',major:'경제학과'}),users[0]]);
  const historical=await request('/api/interviews',{...start,sourceType:'personal',questionId:question.id,sourceVersion:1,requestId:randomUUID()});
  check(historical.session.content_version===1&&historical.session.supportTarget.department==='경영학과'&&historical.session.data.context.targetSnapshotStale,'explicit old-version practice preserves its frozen support target');
  check(historical.question.prompt===question.prompt,'old-version question text is not replaced by current content');
  const persisted=(await request('/api/interviews?id='+historical.session.id)).session;
  check(persisted.practiceLabel==='일반 경험 면접'&&persisted.data.practiceNotice.includes('실제 면접 방식'),'session read retains the same practice boundary');
  check((await db.query('select count(*)::int count from ai_usage_logs where student_id=any($1::uuid[])',[users])).rows[0].count===0,'no paid AI usage');
  const protectedAfter=(await db.query('select id,md5(data::text) digest from support_targets where not(student_id=any($1::uuid[])) order by id',[users])).rows;
  assert.deepEqual(protectedAfter,protectedBefore);checks++;
  console.log(`Personal interview scope API: ${checks} checks passed; existing students untouched; paid AI calls: 0.`);
}catch(error){console.error(redactEnvironmentSecrets(error instanceof Error?error.stack:String(error)));process.exitCode=1;}
finally{
  try{
    const owned=(await db.query('select email from profiles where id=any($1::uuid[])',[users])).rows;
    if(owned.some(row=>!row.email.startsWith('interview-scope-'+fixture+'-')))throw Error('Refusing to clean non-fixture account');
    await db.query('begin');
    for(const table of ['interview_reports','interview_turns','interview_sessions','study_session_events','study_session_tabs','study_sessions','support_targets'])await db.query(`delete from ${table} where student_id=any($1::uuid[])`,[users]);
    await db.query('delete from content_versions where package_id=$1',[packageId]);
    await db.query('delete from content_packages where id=$1 and student_id=$2',[packageId,users[0]]);
    await db.query('delete from production_links where id=$1 and student_id=$2',[jobId,users[0]]);
    await db.query('delete from sessions where user_id=any($1::uuid[])',[users]);
    await db.query('delete from profiles where id=any($1::uuid[])',[users]);await db.query('commit');
  }catch(error){await db.query('rollback');console.error(redactEnvironmentSecrets(String(error)));process.exitCode=1;}
  await db.end();
}
