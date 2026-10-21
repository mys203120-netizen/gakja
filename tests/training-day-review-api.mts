// Local API/DB lifecycle verification. All writes and cleanup belong to one randomly generated synthetic owner.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {loadProjectEnv,redactEnvironmentSecrets} from '../scripts/load-env.mjs';
import {registerReviewedSchool} from './school-registration-fixture.mts';

loadProjectEnv();
const base=process.env.HYBRID_TRAINING_TEST_URL||'http://127.0.0.1:3117';
if(process.env.AUTH_MODE!=='local'||!['localhost','127.0.0.1'].includes(new URL(base).hostname)||!['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname))throw Error('Local QA server and local database only.');
const db=new pg.Client({connectionString:process.env.DATABASE_URL}),student=randomUUID(),email=`day-review-${student}@gakja.test`,token=randomBytes(32).toString('hex'),hash=createHash('sha256').update(token).digest('hex');
type Value=Record<string,any>;
const labels:string[]=[];let created=false,failure:unknown;
const check=(value:unknown,label:string)=>{assert.ok(value,label);labels.push(label);};
async function request(path:string,body?:unknown,status=200){
 const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Origin:base,Cookie:'gakja_session='+token},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60_000)});
 const value=await response.json();assert.equal(response.status,status,`${path.split('?')[0]} ${response.status} ${value.error||''}`);return value as Value;
}
async function preferences(){return (await db.query('select data from student_preferences where student_id=$1',[student])).rows[0]?.data||{};}
async function revision(){return String((await db.query('select revision from student_learning_revisions where student_id=$1',[student])).rows[0]?.revision||0);}
async function complete(input:Value){
 const started=await request('/api/interviews',{action:'start',kind:'video',mode:'basic',...input,followups:false,feedbackTiming:'end',requestId:randomUUID()});
 assert.equal(started.aiAvailable,false,'API verification requires external AI disabled before submitting any answer');
 await request('/api/interviews',{action:'resume',sessionId:started.session.id});
 const answer=await request('/api/interviews',{action:'answer',sessionId:started.session.id,turnId:started.question.turnId,answer:'제가 맡은 측정 조건을 먼저 기록했습니다. 차이를 비교하면서 제가 한 행동과 남은 한계를 구분해 설명했습니다.',requestId:randomUUID()});
 await request('/api/interviews',{action:'finish',sessionId:started.session.id});return answer.turn;
}
await db.connect();
try{
 await db.query("insert into profiles(id,email,name,role) values($1,$2,'오늘정리 합성 검증','student')",[student,email]);created=true;
 await db.query("insert into sessions(id,user_id,expires_at) values($1,$2,now()+interval '45 minutes')",[hash,student]);
 const catalog=await request('/api/schools/catalog'),school=catalog.schools.find((row:Value)=>row.canonicalName==='서울시립대학교');assert.ok(school);
 const details=await request('/api/schools/catalog?schoolId='+school.id),department=details.school.departments.find((row:Value)=>row.name==='환경공학부');assert.ok(department);
 const registration=await registerReviewedSchool(async(path,body)=>({status:200,body:await request(path,body)}),{referenceId:school.id,departmentId:department.id,admissionYear:2027,track:'학생부종합전형Ⅰ(면접형)'}),target=registration.body.target;
 await request('/api/training/preferences',{expectedRevision:0,availability:{weekdayMinutes:120,weekendMinutes:120,csatDate:null,beforeCsatWeekdayMinutes:120,beforeCsatWeekendMinutes:120,blockedDates:[],overrides:{}}});
 const initial=await request('/api/training?targetId='+target.id),input=initial.diagnosticInput;assert.ok(input?.questionIds?.length);
 const scope={targetId:target.id,sourceType:input.sourceType,sourceVersion:input.sourceVersion,questionId:input.questionIds[0],questionCount:1};
 await complete(scope);
 const current=await request('/api/training?targetId='+target.id),review=current.today.tasks.find((task:Value)=>task.kind==='review');assert.ok(review);
 const page=await request('/api/training?planId='+review.id);check(page.dayReview.answers===1&&page.dayReview.questions.length===1&&page.dayReview.targetId===null,'Daily reflection shows actual current submitted work across the student support targets');
 const key=page.dayReview.questions[0].key,payload={action:'day_reflection',planId:review.id,requestId:randomUUID(),improvement:'내가 한 행동을 먼저 답했다.',revisitQuestionKeys:[key]};
 await request('/api/training',{action:'task_complete',planId:review.id},409);
 const foreign=JSON.parse(key);foreign[0]=randomUUID();await request('/api/training',{...payload,revisitQuestionKeys:[JSON.stringify(foreign)]},409);
 const former=JSON.parse(key);former[3]=Number(former[3])+100;await request('/api/training',{...payload,revisitQuestionKeys:[JSON.stringify(former)]},409);
 const beforeRevision=await revision(),saved=await request('/api/training',payload);check(saved.completed===true,'Saving one improvement and selected questions completes the reflection without inventing an interview answer');
 const afterRevision=await revision();check(Number(afterRevision)>Number(beforeRevision),'New manual review selection invalidates the shared training projection');
 const before=JSON.stringify((await preferences()).trainingReview);await request('/api/training',payload);check(JSON.stringify((await preferences()).trainingReview)===before&&await revision()===afterRevision,'A repeated reflection request preserves one scoped review request, original baseline and projection revision');
 await request('/api/training',{...payload,requestId:randomUUID()},409);
 let snapshot=await request('/api/training?planId='+review.id),requestId=JSON.stringify(['day-review',review.id,key]);
 check(snapshot.selectedTask.completed&&snapshot.selectedTask.dayReflection.improvement===payload.improvement,'Reopening reflection restores the saved result');
 check(snapshot.review.questions.some((row:Value)=>row.questionKey===key&&row.status==='active')&&snapshot.readiness.items.some((row:Value)=>row.reviewQuestionKeys?.includes(key)&&row.reviewStatus==='active'),'Today plan and readiness share the active reflection review state');
 const independent=await complete(scope);snapshot=await request('/api/training?targetId='+target.id);
 check((await preferences()).trainingReview.requests.find((row:Value)=>row.id===requestId)?.status==='resolved'&&snapshot.readiness.items.some((row:Value)=>row.reviewQuestionKeys?.includes(key)&&row.reviewStatus==='resolved'),'A later same-scope unaided answer resolves the selected question in plan and readiness');
 const original=(await db.query('select data from interview_turns where id=$1 and student_id=$2',[independent.id,student])).rows[0].data;
 await db.query('update interview_turns set data=$3::jsonb where id=$1 and student_id=$2',[independent.id,student,JSON.stringify({...original,invalidated:true})]);
 snapshot=await request('/api/training?targetId='+target.id);check((await preferences()).trainingReview.requests.find((row:Value)=>row.id===requestId)?.status==='active'&&snapshot.readiness.items.some((row:Value)=>row.reviewQuestionKeys?.includes(key)&&row.reviewStatus==='active'),'Invalidating the resolving source reactivates the same request in both views');
 await db.query('update interview_turns set data=$3::jsonb where id=$1 and student_id=$2',[independent.id,student,JSON.stringify({...original,assisted:true,assistance_recorded:true})]);
 await request('/api/training?targetId='+target.id);check((await preferences()).trainingReview.requests.find((row:Value)=>row.id===requestId)?.status==='active','Corrected help usage cannot certify an independent answer');
 await db.query("update support_targets set data=jsonb_set(data,'{department}','\"변경 학과\"'::jsonb) where id=$1 and student_id=$2",[target.id,student]);
 await request('/api/training',payload,409);check(true,'A stale support-target reflection receipt cannot be replayed into a changed department');
 check((await db.query('select count(*)::int count from ai_usage_logs where student_id=$1',[student])).rows[0].count===0,'Lifecycle used no paid AI calls');
}catch(error){failure=error;}
finally{
 try{if(created){
  assert.equal((await db.query('select email from profiles where id=$1',[student])).rows[0]?.email,email);
  await db.query('begin');await db.query('delete from answer_revisions where answer_id in(select id from user_answers where student_id=$1)',[student]);
  for(const table of ['answer_comments','user_answers','interview_reports','media_assets','interview_turns','interview_sessions','study_session_events','study_session_tabs','study_sessions','experience_card_drafts','experience_cards','student_plans','ai_usage_logs','notifications','student_preferences','school_profiles','support_targets'])await db.query(`delete from ${table} where student_id=$1`,[student]);
  await db.query('delete from audit_logs where actor_id=$1 or student_id=$1',[student]);await db.query('delete from sessions where user_id=$1',[student]);await db.query('delete from profiles where id=$1 and email=$2',[student,email]);await db.query('commit');
 }}catch(error){await db.query('rollback');failure??=error;}await db.end();
}
if(failure){console.error(redactEnvironmentSecrets(failure instanceof Error?failure.stack||failure.message:'Daily reflection verification failed'));process.exitCode=1;}
else console.log(JSON.stringify({checks:labels.length,labels,paidAiCalls:0,cleanup:'Exact synthetic student only'}));
