import {registerReviewedSchool} from './school-registration-fixture.mts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { hash } from 'bcryptjs';
import { loadProjectEnv,projectRoot } from '../scripts/load-env.mjs';
loadProjectEnv();
const base=process.env.SMOKE_BASE_URL||JSON.parse(readFileSync(join(projectRoot,'.local/server.json'),'utf8')).url;
if(process.env.AUTH_MODE!=='local'||!['localhost','127.0.0.1'].includes(new URL(base).hostname)||!['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname))throw new Error('로컬 합성 DB에서만 검증해 주세요.');
const db=new pg.Client({connectionString:process.env.DATABASE_URL});const students=[randomUUID(),randomUUID()];const fixture=randomUUID();const packageId=`school-test-${fixture}`;const jobId=packageId+'-job';const cookies:Record<string,string>={};let checks=0;
async function req(actor:string,path:string,body?:unknown,origin=base){const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Origin:origin,...(cookies[actor]?{Cookie:cookies[actor]}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const set=response.headers.getSetCookie();if(set.length)cookies[actor]=set.map(cookie=>cookie.split(';')[0]).join('; ');return {status:response.status,body:await response.json()};}
function check(value:unknown,label:string){assert.ok(value,label);checks++;}
await db.connect();
try{
  const password='School!Check2026';const passwordHash=await hash(password,12);
  for(let index=0;index<students.length;index++){await db.query("insert into profiles(id,email,name,role,password_hash) values($1,$2,'학교 흐름 합성 검증','student',$3)",[students[index],`school-${index}-${fixture}@gakja.test`,passwordHash]);check((await req(String(index),'/api/auth',{action:'login',email:`school-${index}-${fixture}@gakja.test`,password})).status===200,'synthetic login');}
  check((await req('anonymous','/api/schools')).status===401,'school catalog requires authenticated student');
  const schools=await req('0','/api/schools');check(schools.status===200&&schools.body.catalog.length===88,'88 reference schools loaded');check(schools.body.commonAvailable&&schools.body.commonQuestions.length===10,'common practice ready without personal package, including value questions');check(schools.body.catalog.every((school:any)=>school.status==='historical_reference'&&school.questionDistribution===null),'historical references do not pretend official topic percentages');
  const selected=schools.body.catalog.find((school:any)=>school.university==='건국대학교');
  const input={referenceId:selected.id,admissionYear:2027,campus:'서울',track:'KU자기추천',major:'사회환경공학부',status:'official_confirmed',checkedAt:'today'};
  check((await req('0','/api/schools',input,'https://other.example')).status===403,'foreign origin registration denied');
  const created=await registerReviewedSchool((path,body)=>req('0',path,body),input);check(created.status===200&&created.body.target.admission_type==='KU자기추천','student registers university campus track unit');const targetId=created.body.target.id;
  check(created.body.target.information_status==='needs_confirmation'&&!created.body.target.status,'student cannot mark admissions verified');check(created.body.target.department===created.body.target.major&&created.body.target.department==='사회환경공학부','registration requires and stores department for profile identity');
  const again=await registerReviewedSchool((path,body)=>req('0',path,body),input);check(again.body.target.id===targetId,'duplicate registration reuses support target');
  const own=await req('0','/api/schools?targetId='+targetId);check(own.body.targets[0].profile.overview.length>0&&own.body.targets[0].profile.source.sha256.length===64,'registration immediately offers source-bearing overview');
  check((await req('1','/api/schools?targetId='+targetId)).status===404,'foreign target common scope denied');
  const preview=await req('0','/api/interviews?preview=1&questionId=common_motivation&sourceType=common&sourceVersion=1&targetId='+targetId);check(preview.status===200&&preview.body.question.id==='common_motivation'&&preview.body.sourceKind==='common','common question preview works without published content');
  check((await req('0','/api/interviews?preview=1&questionId=common_motivation&sourceType=common&sourceVersion=999&targetId='+targetId)).status===404,'missing common revision rejected without fallback');
  check((await req('0','/api/interviews',{action:'start',targetId,activityId:'other-activity'})).status===404,'personal activity cannot be fabricated for public practice');
  check((await req('0','/api/interviews',{action:'start',targetId,questionId:'missing'})).status===404,'unknown question cannot be fabricated');
  const start=await req('0','/api/interviews',{action:'start',targetId,questionId:'common_motivation',sourceType:'common',sourceVersion:1,questionCount:1,followups:false,feedbackTiming:'end',assisted:true});check(start.status===200&&start.body.question.id==='common_motivation','first common interview starts immediately');const sessionId=start.body.session.id;
  const saved=(await db.query('select data from interview_sessions where id=$1',[sessionId])).rows[0].data;check(saved.context.ownerStudentId===students[0]&&saved.context.packageId==='common-bank'&&saved.context.activities.length===0,'common session fixes ownership and has no invented private activities');check(saved.schoolPracticeOnly&&saved.schoolProfile.status==='historical_reference'&&saved.schoolProfile.data.question_distribution===null,'reference overview never becomes official format or question mix');check(start.body.turn.assisted===true&&start.body.turn.commonRevision===1,'help use and common version snapshot preserved');
  check((await req('1','/api/interviews?id='+sessionId)).status===404,'other student cannot read common session');check((await req('1','/api/interviews',{action:'pause',sessionId})).status===404,'other student cannot mutate common session');
  check(start.body.session.data.context.sourceKind==='common'&&start.body.session.data.context.questions.some((question:any)=>question.id==='common_motivation')&&!('ownerStudentId' in start.body.session.data.context)&&!('studentContext' in start.body.session.data.context)&&!('learningHistory' in start.body.session.data.context),'start returns fixed safe context resources without internal student fields');
  const resume=await req('0','/api/interviews?id='+sessionId);check(resume.body.session.data.context.questions.some((question:any)=>question.id==='common_motivation'),'session reload preserves common root source context');
  const answer=await req('0','/api/interviews',{action:'answer',sessionId,turnId:start.body.question.turnId,answer:'[합성 학교 흐름 검증] 관심을 갖게 된 이유와 배우고 싶은 내용을 설명합니다.'});check(answer.status===200&&answer.body.turn.assisted===true,'common answer saved with assistance context');
  const unhelped=await req('0','/api/interviews',{action:'start',targetId,questionId:'common_motivation',sourceType:'common',sourceVersion:1,questionCount:1,followups:false,feedbackTiming:'end'});
  await req('0','/api/interviews',{action:'pause',sessionId:unhelped.body.session.id,turnId:unhelped.body.question.turnId});
  const plainResume=await req('0','/api/interviews',{action:'resume',sessionId:unhelped.body.session.id,turnId:unhelped.body.question.turnId});
  check(plainResume.body.turn.assisted!==true,'plain pause and resume cannot claim AI help');
  const clientFlagResume=await req('0','/api/interviews',{action:'resume',sessionId:unhelped.body.session.id,turnId:unhelped.body.question.turnId,assisted:true});
  check(clientFlagResume.status===200&&clientFlagResume.body.turn.assisted!==true,'client resume flag cannot manufacture help evidence');
  check((await req('0','/api/interviews',{action:'pause',sessionId:unhelped.body.session.id,turnId:unhelped.body.question.turnId})).status===200,'pause before opening owned source evidence');
  const helpRequestId=randomUUID(),helpBody={action:'help',sessionId:unhelped.body.session.id,turnId:unhelped.body.question.turnId,helpKind:'evidence',requestId:helpRequestId};
  const evidenceHelp=await req('0','/api/interviews',helpBody);
  check(evidenceHelp.status===200&&evidenceHelp.body.turn.assisted===true&&evidenceHelp.body.turn.helpKinds.includes('evidence')&&evidenceHelp.body.turn.helpEvents.some((event:any)=>event.receiptId===helpRequestId),'owned evidence lookup creates a canonical help receipt');
  const duplicateHelp=await req('0','/api/interviews',helpBody);
  check(duplicateHelp.body.turn.helpEvents.filter((event:any)=>event.receiptId===helpRequestId).length===1,'same evidence receipt is idempotent');
  const assistedResume=await req('0','/api/interviews',{action:'resume',sessionId:unhelped.body.session.id,turnId:unhelped.body.question.turnId,assisted:false});
  check(assistedResume.status===200&&assistedResume.body.turn.assisted===true&&assistedResume.body.turn.helpKinds.includes('evidence'),'resume preserves canonical help even if the client flag disagrees');
  check(Number((await db.query('select count(*)::int as n from ai_usage_logs where student_id=any($1::uuid[])',[students])).rows[0].n)===0,'no paid AI calls made');
  await db.query('insert into production_links(id,student_id,data) values($1,$2,$3)',[jobId,students[1],JSON.stringify({synthetic:true})]);await db.query('insert into content_packages(id,student_id,active_version) values($1,$2,2)',[packageId,students[1]]);
  const secondTarget=(await registerReviewedSchool((path,body)=>req('1',path,body),input)).body.target;
  const old={support_targets:[secondTarget],activities:[],questions:[{id:'school-test-old',prompt:'과거 발행본 합성 질문',activity_ids:[],support_target_ids:[secondTarget.id],source_ref_ids:[]}],answer_scripts:[],source_refs:[],student_context:{}};
  for(const version of [1,2])await db.query("insert into content_versions(package_id,version,data,learning_hash,status,production_job_ref) values($1,$2,$3,'synthetic','published',$4)",[packageId,version,JSON.stringify(version===1?old:{...old,questions:[{...old.questions[0],id:'school-test-current',prompt:'현재 발행본 합성 질문'}]}),jobId]);
  const officialData={...secondTarget,interview_stage:'1단계',format:'document_individual',interviewer_count:{min:2,max:2},question_distribution:{basis:'official',unit:'root_question_count',includes_followups:false,buckets:[{id:'academic',label:'합성',weight:100}]}};
  await db.query("insert into school_profiles(student_id,target_id,revision,status,data,provenance,reviewed_by) values($1,$2,1,'official_confirmed',$3,$4,$1)",[students[1],secondTarget.id,JSON.stringify(officialData),JSON.stringify({synthetic:true,source_url:'https://example.test/owned-fixture',applicable_year:2027})]);
  check((await req('1','/api/schools')).body.targets[0].profile.status==='official_confirmed','matching synthetic reviewed overview keeps declared status');
  await db.query("update support_targets set data=data || '{\"admission_year\":2028}'::jsonb where id=$1 and student_id=$2",[secondTarget.id,students[1]]);
  const stale=(await req('1','/api/schools')).body.targets[0].profile;check(stale.stale&&stale.status==='needs_confirmation'&&stale.declared_status==='official_confirmed','changed target never displays stale official status as current');
  const historical=await req('1','/api/interviews?preview=1&questionId=school-test-old&sourceType=personal&sourceVersion=1');check(historical.status===200&&historical.body.question.prompt==='과거 발행본 합성 질문'&&historical.body.contentVersion==='1','old personal retry reads owned published historical version');check(historical.body.supportTarget.admission_year===2027&&historical.body.targetSnapshotStale,'old published support identity stays pinned after current target changes');
  const historicalStart=await req('1','/api/interviews',{action:'start',targetId:secondTarget.id,questionId:'school-test-old',sourceType:'personal',sourceVersion:1,questionCount:1,followups:false,feedbackTiming:'end'});check(historicalStart.status===200&&historicalStart.body.session.data.schoolProfile===null&&historicalStart.body.session.data.schoolPracticeOnly,'old question retry excludes mismatched current school profile and quotas');check((await req('0','/api/interviews?preview=1&questionId=school-test-old&sourceType=personal&sourceVersion=1')).status===409,'new student cannot use someone else private version');
  console.log(JSON.stringify({checks,paidAiCalls:0,syntheticStudents:2,cleanup:'owned fixtures only'}));
}finally{
  await db.query('begin');
  for(const table of ['study_sessions','interview_reports','media_assets','interview_sessions','ai_usage_logs','student_preferences','sessions','audit_logs','school_profiles','support_targets']){
    if(table==='sessions')await db.query('delete from sessions where user_id=any($1::uuid[])',[students]);else if(table==='audit_logs')await db.query('delete from audit_logs where actor_id=any($1::uuid[]) or student_id=any($1::uuid[])',[students]);else await db.query(`delete from ${table} where student_id=any($1::uuid[])`,[students]);
  }
  await db.query('delete from content_versions where package_id=$1',[packageId]);await db.query('delete from content_packages where id=$1',[packageId]);await db.query('delete from production_links where id=$1',[jobId]);await db.query('delete from profiles where id=any($1::uuid[])',[students]);await db.query('commit');await db.end();
}
