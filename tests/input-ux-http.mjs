// Disposable local HTTP + PostgreSQL check. Requires AI disabled on this validation server.
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
import {loadProjectEnv} from '../scripts/load-env.mjs';
loadProjectEnv();
const base=process.env.INPUT_UX_TEST_URL||'http://localhost:3103',databaseUrl=new URL(process.env.DATABASE_URL);
if(!['localhost','127.0.0.1'].includes(new URL(base).hostname)||!['localhost','127.0.0.1'].includes(databaseUrl.hostname))throw Error('Local app and database only.');
const db=new pg.Client({connectionString:databaseUrl.href});await db.connect();
const studentId=randomUUID(),token=randomBytes(32).toString('hex'),hash=createHash('sha256').update(token).digest('hex');let checks=0;
const check=(value,message)=>{assert.ok(value,message);checks++;};
async function call(path,body){const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Origin:base,'Content-Type':'application/json',Cookie:'gakja_session='+token},...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;}
try{
 await db.query('insert into profiles(id,email,name,role) values($1,$2,$3,$4)',[studentId,`input-qa-${studentId}@gakja.test`,'입력 UX 합성 검증','student']);
 await db.query("insert into sessions(id,user_id,expires_at) values($1,$2,now()+interval '15 minutes')",[hash,studentId]);
 const catalog=await call('/api/quiz?sourceType=common&general=1'),item=catalog.library.answer.find(item=>item.source_kind==='common');check(Boolean(item),'common first question exists without school or student record');
 const created=await call('/api/quiz',{action:'create',mode:'oral',sourceType:'common',targetId:null,itemIds:[item.id],focus:'free'}),sessionId=created.session.id;
 await call('/api/quiz',{action:'draft',sessionId,itemIndex:0,response:'저는 의견을 정리하고 공통 양식을 만들었습니다.',requestId:randomUUID()});
 const savedDraft=await call('/api/quiz?sessionId='+sessionId);check(savedDraft.session.current_index===0&&savedDraft.session.metadata.drafts['0'].response.includes('공통 양식'),'first-item text draft survives API roundtrip');
 const listed=(await call('/api/quiz?sourceType=common&general=1')).sessions.find(session=>session.id===sessionId);check(listed.student_id===studentId&&Boolean(listed.updated_at),'dashboard overview includes owned current draft and recent activity timestamp');
 await call('/api/quiz',{action:'start',sessionId,itemIndex:0});
 const payload={action:'answer',sessionId,itemIndex:0,response:'  저는 의견을 정리하고 공통 양식을 만들었습니다.  ',responseMode:'text',recallStatus:'unchecked',requestId:randomUUID()};
 const answered=await call('/api/quiz',payload),retry=await call('/api/quiz',payload);
 check(answered.session.state==='completed'&&retry.response.id===answered.response.id,'a repeated text answer uses the durable receipt and finishes once');
 const quiz=(await db.query('select * from quiz_responses where session_id=$1 and student_id=$2',[sessionId,studentId])).rows;
 check(quiz.length===1&&quiz[0].data.response_mode==='text'&&quiz[0].data.submitted_mode==='answer'&&!quiz[0].data.recording_id&&!quiz[0].data.speech_source,'oral text alternative has one text record and no invented audio evidence');
 const started=await call('/api/interviews',{action:'start',kind:'video',sourceType:'common',questionId:item.question_id,questionCount:1,requestId:randomUUID()});
 if(started.aiAvailable)throw Error('Use the isolated validation server with OPENAI_API_KEY empty.');
 const interviewId=started.session.id,turnId=started.question.turnId,text='실제로 맡았던 자료 정리를 한 문장으로 설명했습니다.',requestId=randomUUID();
 await call('/api/interviews',{action:'resume',sessionId:interviewId,turnId});
 await call('/api/interviews',{action:'answer',sessionId:interviewId,turnId,answer:text,requestId});
 const live=await call('/api/interviews?id='+interviewId),turn=live.turns.find(turn=>turn.id===turnId);
 check(turn.answer===text&&turn.submissionSource==='text'&&!turn.speechSource,'same Live session stores a typed answer with honest provenance');
 check(live.question===null&&live.turns.filter(turn=>turn.answer).length===1,'one-question Live text practice reaches the finish boundary');
 const finished=await call('/api/interviews',{action:'finish',sessionId:interviewId});check(Boolean(finished.report.id),'Live text fallback produces the normal saved report');
 check((await db.query('select count(*)::int as n from media_assets where student_id=$1',[studentId])).rows[0].n===0,'typing never creates a synthetic media asset');
 console.log(`Input UX local HTTP: ${checks} checks passed (common first question, first-item draft, list identity, oral text receipt, Live text provenance/report; AI/STT/Storage calls 0).`);
}finally{
 // Only this script's random disposable student is removed; existing students are untouched.
 for(const table of ['interview_reports','interview_turns','interview_sessions','quiz_recordings','quiz_responses','quiz_sessions','memory_attempts','study_sessions'])await db.query(`delete from ${table} where student_id=$1`,[studentId]);
 await db.query('delete from sessions where id=$1',[hash]);await db.query('delete from profiles where id=$1',[studentId]);await db.end();
}
