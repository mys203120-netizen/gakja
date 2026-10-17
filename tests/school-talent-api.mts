import {registerReviewedSchool} from './school-registration-fixture.mts';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import pg from 'pg';
import {hash} from 'bcryptjs';
import {loadProjectEnv,projectRoot} from '../scripts/load-env.mjs';
loadProjectEnv();
const base=process.env.SMOKE_BASE_URL || JSON.parse(readFileSync(join(projectRoot,'.local/server.json'),'utf8')).url;
if(process.env.AUTH_MODE!=='local' || !['localhost','127.0.0.1'].includes(new URL(base).hostname) || !['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname))throw Error('Local synthetic fixtures only');
const db=new pg.Client({connectionString:process.env.DATABASE_URL});const students=[randomUUID(),randomUUID()];const fixture=randomUUID();const cookies:Record<string,string>={};let checks=0;
async function request(actor:string,path:string,body?:unknown){const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Origin:base,...(cookies[actor]?{Cookie:cookies[actor]}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const set=response.headers.getSetCookie();if(set.length)cookies[actor]=set.map(cookie=>cookie.split(';')[0]).join('; ');return {status:response.status,body:await response.json()};}
function check(value:unknown,label:string){assert.ok(value,label);checks++;}
await db.connect();
try{
  const password='Talent!Only2026';const passwordHash=await hash(password,12);
  for(let index=0;index<students.length;index++){await db.query("insert into profiles(id,email,name,role,password_hash) values($1,$2,'인재상 합성 검증','student',$3)",[students[index],`talent-${index}-${fixture}@gakja.test`,passwordHash]);check((await request(String(index),'/api/auth',{action:'login',email:`talent-${index}-${fixture}@gakja.test`,password})).status===200,'synthetic login');}
  const catalogue=(await request('0','/api/schools')).body.catalog;
  check(catalogue.length===88,'all88 school catalogue visible');check(catalogue.filter((school:any)=>school.talent?.status==='official_source').length===88,'all88 schools have source-confirmed university definitions');check(catalogue.every((school:any)=>school.talent?.universityProfile?.points.length),'every institution includes its own official value or accurately labelled education goal');
  const uos=catalogue.find((school:any)=>school.canonicalName==='서울시립대학교');
  const registered=await registerReviewedSchool((path,body)=>request('0',path,body),{referenceId:uos.id,admissionYear:2027,campus:'본교',track:'학생부종합전형Ⅰ(면접형)',major:'환경공학부',talentProfile:{status:'official_source',points:['forged']}});
  check(registered.status===200,'actual-school fixture registered');const targetId=registered.body.target.id;const talent=registered.body.target.talentProfile;
  check(talent.status==='official_source'&&talent.scope==='department','environment target gets verified department talent');check(talent.points.length===6&&talent.points.some((point:any)=>point.label==='배려와 공학윤리')&&talent.points.some((point:any)=>point.label==='학업역량'),'actual ethics and university values both present');check(!JSON.stringify(talent).includes('forged'),'client cannot forge source-confirmed talent');
  const schoolData=await request('0','/api/schools?targetId='+targetId);const questions=schoolData.body.commonQuestions;
  check(questions.filter((question:any)=>question.talent_profile).length===6,'university and department values both eligible');check(questions.every((question:any)=>!question.talent_profile||question.practice_label==='공식 인재상 기반 연습'),'talent question disclosed as practice');
  const selected=questions.find((question:any)=>question.talent_profile?.point?.id==='ethics');
  check(selected.common_revision===1&&selected.source_snapshot.officialPastQuestion===false,'source revision and no fabricated past question');
  const preview=await request('0',`/api/interviews?preview=1&questionId=${selected.id}&targetId=${targetId}&sourceType=common&sourceVersion=1`);
  check(preview.status===200&&preview.body.question.id===selected.id,'source-specific talent preview');check(preview.body.sources.filter((source:any)=>source.type==='school_talent').length===2,'one deduplicated source per talent profile');check(preview.body.question.activity_ids.length===0,'no invented private activities');
  const mixed=await request('0','/api/interviews',{action:'start',mode:'basic',targetId,questionCount:4,followups:false,feedbackTiming:'end'});
  check(mixed.status===200,'normal basic interview includes talent');const mixedData=(await db.query('select data from interview_sessions where id=$1',[mixed.body.session.id])).rows[0].data;
  check(mixedData.questionQueue.length===4&&mixedData.questionQueue.filter((question:any)=>question.talent_profile).length===1,'normal4 questions contain1 official talent plus other learning');check(mixedData.questionPlan.basis==='training'&&mixedData.schoolProfile.data.question_distribution===null,'training mix never becomes official quota');check(mixedData.schoolProfile.data.evaluation_weights.length===3&&mixedData.schoolProfile.data.evaluation_weights.some((weight:any)=>weight.element==='사회역량'&&weight.weight===25),'real evaluationweights remain separate');
  const start=await request('0','/api/interviews',{action:'start',mode:'university',targetId,questionId:selected.id,sourceType:'common',sourceVersion:1,questionCount:1,followups:false,feedbackTiming:'end'});
  check(start.status===200&&start.body.question.id===selected.id,'talent may start university mode without private package');check(start.body.turn.sourceSnapshot.url===talent.source.url&&start.body.turn.sourceSnapshot.questionBasis==='training','turn pins verified source and practice basis');check(!('ownerStudentId' in start.body.session.data.context),'internal ownership excluded from clientDTO');
  check((await request('1','/api/interviews?id='+start.body.session.id)).status===404,'foreign session denied');check((await request('1',`/api/interviews?preview=1&questionId=${selected.id}&targetId=${targetId}&sourceType=common`)).status===404,'foreign target denied');
  const answer=await request('0','/api/interviews',{action:'answer',sessionId:start.body.session.id,turnId:start.body.question.turnId,answer:'[합성 인재상 검증] 아직 직접 경험은 없습니다. 편의보다 타인에게 미칠 영향을 먼저 검토하고, 근거를 확인하며 책임 있게 판단하겠습니다.'});
  check(answer.status===200&&answer.body.turn.answer.includes('아직 직접 경험은 없습니다'),'experience-free values answer saved without inventing experience');
  await db.query("update support_targets set data=data || '{\"major\":\"간호학과\",\"department\":\"간호학과\"}'::jsonb where id=$1 and student_id=$2",[targetId,students[0]]);
  check((await request('0',`/api/interviews?preview=1&questionId=${selected.id}&targetId=${targetId}&sourceType=common&sourceVersion=1`)).status===404,'old environment-specific question not reused for wrong major');
  const preserved=await request('0','/api/interviews?id='+start.body.session.id);check(preserved.status===200&&preserved.body.turns[0].sourceSnapshot.url===talent.source.url,'old owned session retains original source after target changes');
  const changed=(await request('0','/api/schools?targetId='+targetId)).body.targets.find((target:any)=>target.id===targetId);check(changed.talentProfile.scope==='university','differentmajor gets university fallback, not environment values');
  const dongguk=catalogue.find((school:any)=>school.canonicalName==='동국대학교');
  const wrong=await registerReviewedSchool((path,body)=>request('0',path,body),{referenceId:dongguk.id,admissionYear:2027,campus:'WISE',track:'합성 검증',major:'합성학과'});check(wrong.status===200&&wrong.body.target.talentProfile.status==='needs_confirmation','manual wrongcampus cannot inherit Seoul talent');check(!(await request('0','/api/schools?targetId='+wrong.body.target.id)).body.commonQuestions.some((question:any)=>question.talent_profile),'wrongcampus official questions excluded');
  const missingTarget=(await registerReviewedSchool((path,body)=>request('0',path,body),{university:'미등록 합성 검증 대학',admissionYear:2027,campus:'본교',track:'합성 검증',major:'합성학과'})).body.target;
  check(missingTarget.talentProfile.status==='needs_confirmation'&&missingTarget.talentProfile.points.length===0,'unknown university cannot inherit another institution definitions');check((await request('0','/api/schools?targetId='+missingTarget.id)).body.commonQuestions.some((question:any)=>question.id==='common_talent_values'),'unknown university still has general values practice');
  const khu=catalogue.find((school:any)=>school.canonicalName==='경희대학교');const futureTarget=(await registerReviewedSchool((path,body)=>request('0',path,body),{referenceId:khu.id,admissionYear:2028,campus:'본교',track:'합성 검증',major:'환경학및환경공학과'})).body.target;
  check(futureTarget.talentProfile.status==='needs_confirmation','yearbound2027 values not applied to2028 registration');check(!(await request('0','/api/schools?targetId='+futureTarget.id)).body.commonQuestions.some((question:any)=>question.talent_profile),'yearbound questions excluded for newyear');
  const cau=catalogue.find((school:any)=>school.canonicalName==='중앙대학교');const cauTarget=(await registerReviewedSchool((path,body)=>request('0',path,body),{referenceId:cau.id,admissionYear:2027,campus:'본교',track:'합성 검증',major:'합성학과'})).body.target;
  const latestCau=(await request('0','/api/schools?targetId='+cauTarget.id)).body.commonQuestions.filter((question:any)=>question.talent_profile);check(latestCau.length===4&&latestCau.every((question:any)=>question.common_revision===2),'central source note revision2 uses all4 officialvalues');
  const oldCau=await request('0',`/api/interviews?preview=1&questionId=${latestCau[0].id}&targetId=${cauTarget.id}&sourceType=common&sourceVersion=1`);check(oldCau.status===200&&oldCau.body.question.common_revision===1&&oldCau.body.question.source_snapshot.profileRevision===1,'old publicrevision retained rather than overwritten');
  const paid=Number((await db.query('select count(*)::int as n from ai_usage_logs where student_id=any($1::uuid[])',[students])).rows[0].n);check(paid===0,'no paidAI calls');
  const result={checks,paidAiCalls:paid,syntheticStudents:2,officialSchools:88,unconfirmedSchools:0,cleanup:'owned fixtures only'};writeFileSync(join(projectRoot,'.local/school-talent-api-check.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{
  await db.query('begin');for(const table of ['study_sessions','interview_reports','media_assets','interview_sessions','ai_usage_logs','student_preferences','sessions','audit_logs','school_profiles','support_targets']){if(table==='sessions')await db.query('delete from sessions where user_id=any($1::uuid[])',[students]);else if(table==='audit_logs')await db.query('delete from audit_logs where actor_id=any($1::uuid[]) or student_id=any($1::uuid[])',[students]);else await db.query(`delete from ${table} where student_id=any($1::uuid[])`,[students]);}await db.query('delete from profiles where id=any($1::uuid[])',[students]);await db.query('commit');await db.end();
}
