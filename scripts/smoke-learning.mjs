import { loadProjectEnv, projectRoot } from './load-env.mjs';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

loadProjectEnv();
let savedUrl;
try { savedUrl=JSON.parse(readFileSync(join(projectRoot,'.local/server.json'),'utf8')).url; } catch { /* Explicit smoke URL is sufficient. */ }
const base=process.env.SMOKE_BASE_URL || savedUrl || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3100';
const localHosts=['localhost','127.0.0.1','[::1]'];
if (process.env.AUTH_MODE !== 'local' || !localHosts.includes(new URL(process.env.DATABASE_URL).hostname) || !localHosts.includes(new URL(base).hostname)) throw new Error('학습 API smoke는 로컬 테스트 DB와 웹 서버에서만 실행해 주세요.');
const db=new pg.Client({connectionString:process.env.DATABASE_URL}); await db.connect();
const prefix=`qa-learning-${randomUUID()}`, taskIds=new Set(), profileIds=new Set(), confirmationIds=new Set(), requestIds=[], jars=[];
let checks=0;
function check(value,label) { assert.ok(value,label); checks++; }
async function login(email) {
  const r=await fetch(`${base}/api/auth`,{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({action:'login',email,password:process.env.TEST_ACCOUNT_PASSWORD || 'Gakja!2026'})});
  check(r.status===200,`테스터 로그인: ${email}`); const user=(await r.json()).user;
  check(user?.is_test===true,'합성 테스트 계정만 사용');
  const cookie=r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');jars.push(cookie);
  return {cookie,user};
}
async function get(actor,studentId) {
  const r=await fetch(`${base}/api/learning${studentId?`?studentId=${studentId}`:''}`,{headers:{cookie:actor.cookie}});
  return {status:r.status,data:await r.json()};
}
async function post(actor,action,payload={},key) {
  const requestId=key || `${prefix}-${requestIds.length}`; requestIds.push(requestId);
  const r=await fetch(`${base}/api/learning`,{method:'POST',headers:{'content-type':'application/json',origin:base,cookie:actor.cookie},body:JSON.stringify({action,...payload,requestId})});
  const data=await r.json();if(data.assignment?.id)taskIds.add(data.assignment.id);if(data.schoolProfile?.id)profileIds.add(data.schoolProfile.id);
  return {status:r.status,data};
}
try {
  const harin=await login('harin@gakja.test'),doyun=await login('doyun@gakja.test'),admin=await login('admin@gakja.test'),staff=await login('staff@gakja.test');
  const initial=await get(harin);check(initial.status===200,'학생 학습 조회');const snapshot=initial.data;
  check(snapshot.memoryItems.every(m=>!('correct_option_id'in m)&&!('accepted_answers'in m)&&!('numeric_answer'in m)&&!('back'in m)),'과제 보기에서 정답 키 분리');
  const choice=snapshot.memoryItems.find(m=>m.kind==='choice'),recall=snapshot.memoryItems.find(m=>m.kind==='keyword_recall');check(choice&&recall,'기존 승인 객관/회상 항목');
  const payload={memoryItemIds:[choice.id,recall.id],title:'[QA] 학습 API 자동 점검',dueAt:null};
  const created=await post(harin,'assignment_create',payload);check(created.status===200,'실제 과제 배정');const task=created.data.assignment,key=requestIds[0];
  const duplicate=await post(harin,'assignment_create',payload,key);check(duplicate.status===200&&duplicate.data.assignment.id===task.id,'동일 요청은 동일 과제로 재사용');
  check((await post(harin,'assignment_create',{...payload,title:'[QA] 다른 내용'},key)).status===409,'식별자 재사용 시 payload 충돌');
  check((await post(doyun,'assignment_start',{assignmentId:task.id})).status===403,'다른 학생의 과제 접근 차단');
  const started=await post(harin,'assignment_start',{assignmentId:task.id});check(started.status===200&&started.data.assignment.state==='in_progress','과제 시작 상태');
  const content=(await db.query('select v.data from content_versions v join content_packages p on p.id=v.package_id where p.student_id=$1 and v.version=p.active_version',[harin.user.id])).rows[0].data;
  const objective=content.memory_items.find(m=>m.id===choice.id),wrong=objective.options.find(o=>o.id!==objective.correct_option_id).id;
  const responses=[{memoryItemId:choice.id,response:wrong,selectedOptionId:wrong,rating:'easy'},{memoryItemId:recall.id,response:'',rating:'again',cannotRecall:true}];
  check((await post(harin,'assignment_submit',{assignmentId:task.id,responses:[{...responses[0],selectedOptionId:'unknown',response:'unknown'},responses[1]]})).status===400,'보기 외 응답 거절');
  const submitted=await post(harin,'assignment_submit',{assignmentId:task.id,responses});check(submitted.status===200&&submitted.data.assignment.state==='retry_due','제출에서 재훈련으로 연결');
  check(submitted.data.results[0].correct===false&&submitted.data.results[1].correct===null,'객관 오답과 미회상 무채점 구분');
  const confirmation=submitted.data.data.confirmations.find(c=>c.data?.assignment_id===task.id);check(!!confirmation,'기억 안 남을 사실 확인함으로 연결');confirmationIds.add(confirmation.id);
  const repeated=await post(harin,'assignment_submit',{assignmentId:task.id,responses},requestIds.at(-1));check(repeated.status===200,'동일 제출 요청 재사용');
  check((await post(harin,'assignment_submit',{assignmentId:task.id,responses})).status===409,'다른 요청으로 이미 제출한 과제 중복 저장 차단');
  const retry=await post(harin,'assignment_retry',{assignmentId:task.id});check(retry.status===200&&retry.data.assignment.parent_assignment_id===task.id,'원본 승인 snapshot에 고정된 재훈련');
  check((await post(harin,'assignment_retry',{assignmentId:task.id})).data.assignment.id===retry.data.assignment.id,'열려 있는 재훈련 중복 생성 방지');
  const review=await post(admin,'assignment_review',{assignmentId:task.id,completed:false,note:'[QA] 자동 결과 보존 검수'});check(review.status===200&&review.data.assignment.review.review_kind==='staff','담당자 검토와 자동 채점 구분');
  check(review.data.data.assignments.find(a=>a.id===task.id).reviewHistory.length>0,'담당자 검수 이력');
  const answered=await post(harin,'confirmation_respond',{confirmationId:confirmation.id,response:'[QA] 기록과 다름을 확인 요청',status:'student_says_different'});check(answered.status===200&&answered.data.confirmation.confirmation_status==='student_says_different','타입이 있는 사실 회신');
  check((await post(harin,'confirmation_respond',{confirmationId:confirmation.id,response:'[QA]',status:'confirmed_from_record'})).status===403,'학생 진술을 원문 확정으로 승격하지 않음');
  check((await get(harin,doyun.user.id)).status===403,'다른 학생 데이터 조회 차단');
  const assigned=(await get(staff)).data.students;const outside=[harin,doyun].find(a=>!assigned.some(s=>s.id===a.user.id));
  if(outside)check((await get(staff,outside.user.id)).status===403,'미배정 학생 담당자 접근 차단');
  const target=snapshot.targets[0],previous=snapshot.schoolProfiles.find(p=>p.target_id===target.id);
  const data={admission_year:target.admission_year,university:target.university,campus:target.campus,department:target.department,admission_type:target.admission_type,interview_stage:target.interview_stage || target.stage || '[QA] 연습',format:'unknown',interview_conducted:null,interviewer_count:null,applicant_count:null,preparation_minutes:null,interview_minutes:null,admission_interview_weight:null,evaluation_weights:[],question_distribution:null,training_panelist_count:2};
  const provenance={source_url:null,page:null,document_title:null,applicable_year:data.admission_year,published_at:null,checked_at:null,review_note:'[QA] 임시 훈련 설정'};
  const profile=await post(admin,'school_profile',{studentId:harin.user.id,targetId:target.id,status:'training_configuration',data,provenance,expectedRevision:previous?.revision || 0});check(profile.status===200&&profile.data.schoolProfile.data.interviewer_count===null,'훈련 인원과 미확인 공식 인원 분리');
  const withHistory=await get(harin);check(withHistory.data.schoolProfiles.find(p=>p.id===profile.data.schoolProfile.id).history.length>0,'학교 프로필 revision 이력');
  check((await post(admin,'school_profile',{studentId:harin.user.id,targetId:target.id,status:'official_confirmed',data,provenance,expectedRevision:profile.data.schoolProfile.revision})).status===400,'출처 없는 학교 정보를 공식 확인으로 저장 차단');
  console.log(`학습 API smoke 통과: ${checks} checks`);
} finally {
  // Recover precise IDs even when mutation succeeded but response transport failed.
  const saved=(await db.query('select result from learning_requests where request_id=any($1::text[])',[requestIds])).rows;
  for(const {result}of saved){if(result.assignment?.id)taskIds.add(result.assignment.id);if(result.schoolProfile?.id)profileIds.add(result.schoolProfile.id);}
  if(taskIds.size){
    const ids=[...taskIds];const confirmations=(await db.query('select id from student_confirmations where data->>\'assignment_id\'=any($1::text[])',[ids])).rows;confirmations.forEach(c=>confirmationIds.add(c.id));
    await db.query('delete from memory_attempts where data->>\'assignment_id\'=any($1::text[])',[ids]);
    await db.query('delete from student_confirmations where data->>\'assignment_id\'=any($1::text[])',[ids]);
    await db.query('delete from quiz_assignments where id=any($1::uuid[])',[ids]);
  }
  if(profileIds.size)await db.query('delete from school_profiles where id=any($1::uuid[])',[[...profileIds]]);
  await db.query('delete from learning_requests where request_id=any($1::text[])',[requestIds]);
  const ids=[...taskIds,...profileIds,...confirmationIds];if(ids.length)await db.query('delete from audit_logs where data->>\'id\'=any($1::text[])',[ids]);
  const tokens=jars.map(jar=>jar.match(/(?:^|; )gakja_session=([^;]+)/)?.[1]).filter(Boolean).map(token=>createHash('sha256').update(token).digest('hex'));
  if(tokens.length)await db.query('delete from sessions where id=any($1::text[])',[tokens]);
  await db.end();console.log('학습 QA의 임시 레코드만 정리했습니다.');
}
