// Run against the local database only. Applies the migration inside a rolled-back
// transaction and verifies actual persistence/concurrency constraints, without GA.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadProjectEnv, redactEnvironmentSecrets } from '../scripts/load-env.mjs';

loadProjectEnv();
if (!['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname)) throw Error('Local isolated database only');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
let checks = 0;
async function student(role = 'student', testAccount = false) {
  const id = randomUUID();
  await db.query('insert into profiles(id,email,name,role) values($1,$2,$3,$4)', [id, `${id}@${testAccount ? 'gakja.test' : 'analytics.example.invalid'}`, 'Analytics synthetic fixture', role]);
  return id;
}
async function count(id: string, event: string, expected: number, label: string) {
  const row = (await db.query('select count(*)::int as n from analytics_conversion_receipts where student_id=$1 and event_name=$2', [id, event])).rows[0];
  assert.equal(row.n, expected, label); checks++;
}
try {
  await db.connect(); await db.query('begin');
  await db.query(readFileSync(new URL('../supabase/migrations/202610220002_analytics_conversions.sql', import.meta.url), 'utf8'));
  const saved = await student();
  await db.query("insert into user_answers(student_id,question_id) values($1,'first')", [saved]);
  await count(saved, 'first_answer_saved', 0, 'blank draft does not count');
  await db.query("update user_answers set script='실제 저장한 답변' where student_id=$1", [saved]);
  await db.query("insert into user_answers(student_id,question_id,script) values($1,'second','두 번째 답변')", [saved]);
  await count(saved, 'first_answer_saved', 1, 'only one first answer across updates and answers');
  for (const id of [await student('staff'), await student('student', true)]) {
    await db.query("insert into user_answers(student_id,question_id,script) values($1,'ignored','답변')", [id]);
    await count(id, 'first_answer_saved', 0, 'staff and test accounts do not count');
  }
  const rolled = await student();
  await db.query('savepoint unsaved');
  await db.query("insert into user_answers(student_id,question_id,script) values($1,'rollback','저장 실패')", [rolled]);
  await db.query('rollback to savepoint unsaved');
  await count(rolled, 'first_answer_saved', 0, 'failed transaction cannot produce a receipt');

  const interviewStudent = await student(), room = randomUUID(), turn = randomUUID();
  await db.query('insert into interview_sessions(id,student_id,content_version) values($1,$2,0)', [room, interviewStudent]);
  await db.query('insert into interview_turns(id,session_id,student_id,question_id,data) values($1,$2,$3,$4,$5)', [turn, room, interviewStudent, 'question', JSON.stringify({ draft: '초안만 있음' })]);
  await count(interviewStudent, 'first_answer_saved', 0, 'interview draft is not an answer');
  await db.query('update interview_turns set data=$2 where id=$1', [turn, JSON.stringify({ answer: '실제 면접 답변' })]);
  await count(interviewStudent, 'first_answer_saved', 1, 'submitted interview answer counts');
  await db.query("update interview_sessions set state='completed' where id=$1", [room]);
  await count(interviewStudent, 'interview_completed', 0, 'completed state without a persisted report does not count');
  await db.query("update interview_sessions set state='active' where id=$1", [room]);
  await db.query("insert into interview_reports(student_id,session_id,data) values($1,$2,'{}')", [interviewStudent, room]);
  await db.query("update interview_sessions set state='completed' where id=$1", [room]);
  await db.query("update interview_sessions set data=data||'{\"feedbackRetried\":true}'::jsonb where id=$1", [room]);
  await count(interviewStudent, 'interview_completed', 1, 'saved report and completed session count once; feedback retry does not count');

  const social = await student();
  await db.query("insert into social_identities(provider,provider_id,user_id,auth_mode) values('google',$1,$2,'local')", [randomUUID(), social]);
  await db.query("insert into audit_logs(actor_id,student_id,action,data) values($1,$1,'account.social.connected','{\"provider\":\"google\"}')", [social]);
  await count(social, 'sign_up', 0, 'existing account connection is not signup');
  await db.query("insert into audit_logs(actor_id,student_id,action,data) values($1,$1,'account.social.created','{\"provider\":\"google\"}')", [social]);
  await db.query("insert into audit_logs(actor_id,student_id,action,data) values($1,$1,'account.social.created','{\"provider\":\"google\"}')", [social]);
  await count(social, 'sign_up', 1, 'verified new account audit deduplicates signup');
  const unverified = await student();
  await db.query("insert into audit_logs(actor_id,student_id,action,data) values($1,$1,'account.social.created','{\"provider\":\"google\"}')", [unverified]);
  await count(unverified, 'sign_up', 0, 'an audit without verified social identity cannot fabricate signup');

  for (const mode of ['answer', 'oral', 'choice']) {
    const id = await student(), session = randomUUID();
    await db.query("insert into quiz_sessions(id,student_id,mode,content_version,items) values($1,$2,$3,0,'[]')", [session, id, mode]);
    await db.query("insert into quiz_responses(session_id,student_id,item_index,memory_item_id,response,elapsed_ms,rating) values($1,$2,0,'q','실제 답변',100,'good')", [session, id]);
    await count(id, 'first_answer_saved', mode === 'choice' ? 0 : 1, `${mode} quiz source matches answer semantics`);
  }
  const oral = await student(), oralSession = randomUUID(), recording = randomUUID();
  await db.query("insert into quiz_sessions(id,student_id,mode,content_version,items) values($1,$2,'oral',0,'[]')", [oralSession, oral]);
  await db.query("insert into quiz_recordings(id,session_id,student_id,item_index,data,mime,duration_ms) values($1,$2,$3,0,$4,'audio/webm',1000)", [recording, oralSession, oral, Buffer.from('synthetic audio bytes')]);
  await db.query("insert into quiz_responses(session_id,student_id,item_index,memory_item_id,response,elapsed_ms,rating,data) values($1,$2,0,'q','',100,'good',$3)", [oralSession, oral, JSON.stringify({ recording_id: recording })]);
  await count(oral, 'first_answer_saved', 1, 'owned persisted oral recording counts without waiting for transcription');
  const forgedOral = await student(), forgedSession = randomUUID();
  await db.query("insert into quiz_sessions(id,student_id,mode,content_version,items) values($1,$2,'oral',0,'[]')", [forgedSession, forgedOral]);
  await db.query("insert into quiz_responses(session_id,student_id,item_index,memory_item_id,response,elapsed_ms,rating,data) values($1,$2,0,'q','',100,'good',$3)", [forgedSession, forgedOral, JSON.stringify({ recording_id: recording })]);
  await count(forgedOral, 'first_answer_saved', 0, 'another student recording cannot fabricate a saved oral answer');
  const assignmentStudent = await student(), assignment = randomUUID(), packageId = `analytics-${randomUUID()}`, linkId = `analytics-${randomUUID()}`;
  await db.query("insert into production_links(id,student_id) values($1,$2)", [linkId, assignmentStudent]);
  await db.query('insert into content_packages(id,student_id) values($1,$2)', [packageId, assignmentStudent]);
  await db.query("insert into content_versions(package_id,version,data,learning_hash,production_job_ref) values($1,1,'{}','synthetic',$2)", [packageId, linkId]);
  await db.query("insert into quiz_assignments(id,student_id,assigned_by,title,package_id,content_version,items) values($1,$2,$2,'Synthetic assignment',$3,1,'[]')", [assignment, assignmentStudent, packageId]);
  await db.query("insert into quiz_submissions(assignment_id,student_id,memory_item_id,response,rating,result) values($1,$2,'q','{\"response\":\"실제 과제 답변\"}','good','{}')", [assignment, assignmentStudent]);
  await count(assignmentStudent, 'first_answer_saved', 1, 'persisted assignment answer counts');
  const memory = await student();
  await db.query("insert into memory_attempts(student_id,memory_item_id,rating,data,due_at) values($1,'q','good','{\"answer\":\"실제 회상 답변\"}',now())", [memory]);
  await count(memory, 'first_answer_saved', 1, 'saved manual recall answer counts');
  await db.query("insert into user_answers(student_id,question_id,script) values($1,'other-source','다른 화면 답변')", [interviewStudent]);
  await count(interviewStudent, 'first_answer_saved', 1, 'first answer is global across all sources');

  const consumeSql = `with pending as (select id from analytics_conversion_receipts where student_id=$1 and delivered_at is null for update skip locked) update analytics_conversion_receipts r set delivered_at=now() from pending where r.id=pending.id returning event_name,method`;
  assert.equal((await db.query(consumeSql, [social])).rows.length, 1); checks++;
  assert.equal((await db.query(consumeSql, [social])).rows.length, 0); checks++;
  assert.equal((await db.query("select relrowsecurity from pg_class where oid='analytics_conversion_receipts'::regclass")).rows[0].relrowsecurity, true); checks++;
  console.log(JSON.stringify({ passed: checks, actualPostgres: true, googleRequests: 0, rolledBack: true }));
} catch (error) { console.error(redactEnvironmentSecrets(error instanceof Error ? error.stack : String(error))); process.exitCode = 1; }
finally { await db.query('rollback').catch(() => {}); await db.end(); }
