// node --conditions=react-server --import tsx tests/study-session-api.mts
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {loadProjectEnv,projectRoot} from '../scripts/load-env.mjs';
loadProjectEnv();
let server:string|undefined;
try {server=JSON.parse(readFileSync(join(projectRoot,'.local/server.json'),'utf8')).url;}catch{}
const base=process.env.TEST_BASE_URL||server||process.env.NEXT_PUBLIC_APP_URL||'http://localhost:3100';
if(process.env.AUTH_MODE!=='local'||!['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname)||!['localhost','127.0.0.1'].includes(new URL(base).hostname))throw new Error('학습 세션 검사는 로컬 DB와 로컬 HTTP 서버에서만 실행해 주세요.');
// Match Next's server compiler marker resolution for this server-side integration test.
registerHooks({resolve(specifier,context,nextResolve){return specifier==='server-only'?{url:pathToFileURL(join(projectRoot,'node_modules/next/dist/compiled/server-only/empty.js')).href,shortCircuit:true}:nextResolve(specifier,context);}});
const {recordStudyEvent}=await import('../apps/web/src/lib/study-sessions.ts');
const {pool}=await import('../apps/web/src/lib/db.ts');
const db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();
const students=[randomUUID(),randomUUID()],staff=randomUUID(),all=[...students,staff],tokens=all.map(()=>randomUUID()),tabs=[randomUUID(),randomUUID()];
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
let count=0;
function check(value:unknown,message:string){assert.ok(value,message);count++;}
async function request(actor:number,path='/api/study-sessions',body?:unknown){
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Origin:base,...(actor>=0?{Cookie:`gakja_session=${tokens[actor]}`} :{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  return {status:response.status,body:await response.json(),headers:response.headers};
}
const heartbeat=(actor:number,tabId:string=tabs[0],extra:Record<string,unknown>={})=>request(actor,undefined,{action:'heartbeat',tabId,...extra});
try{
  for(let index=0;index<all.length;index++){
    await db.query('insert into profiles(id,email,name,role) values($1,$2,$3,$4)',[all[index],`study-session-${all[index]}@gakja.test`,'학습 세션 합성 검증',index===2?'staff':'student']);
    await db.query("insert into sessions(id,user_id,expires_at) values($1,$2,now()+interval '1 hour')",[digest(tokens[index]),all[index]]);
  }
  check((await request(-1)).status===401,'anonymous read denied');check((await heartbeat(-1)).status===401,'anonymous write denied');
  check((await request(2)).status===403,'staff read denied');check((await heartbeat(2)).status===403,'staff cannot own student session');
  check((await heartbeat(0,'bad')).status===400,'invalid tab ID rejected');
  check((await request(0,undefined,{action:'event',data:{correct:true}})).status===400,'browser cannot forge learning events');
  const a=await heartbeat(0),id=a.body.sessionId;check(a.status===200&&Boolean(id),'heartbeat creates own current session');
  const b=await heartbeat(0,tabs[1]);check(b.body.sessionId===id,'tabs share same app session');
  check((await heartbeat(0)).body.sessionId===id,'heartbeat retry does not create new session');
  const other=await heartbeat(1,randomUUID(),{studentId:students[0]});check(other.body.sessionId!==id,'client owner spoof ignored');
  check((await request(1,'/api/study-sessions?id='+id)).status===404,'another student cannot read session');
  check((await request(1,undefined,{action:'finish',reason:'manual',sessionId:id})).status===404,'another student cannot finish session');
  check((await request(0,'/api/study-sessions?id=not-uuid')).status===400,'invalid detail ID rejected');
  const leftA=await request(0,undefined,{action:'leave',tabId:tabs[0]});check(leftA.body.pendingFinish===false,'closing one tab keeps other tab active');
  const unknown=await request(0,undefined,{action:'leave',tabId:randomUUID()});check(unknown.body.pendingFinish===false,'unknown lease cannot close session');
  const leftB=await request(0,undefined,{action:'leave',tabId:tabs[1]});check(leftB.body.pendingFinish===true,'last tab marks pending close');
  check((await request(0)).body.current?.id===id,'reload grace does not finalize immediately');
  await heartbeat(0);
  check((await db.query('select closing_at from study_sessions where id=$1',[id])).rows[0].closing_at===null,'reload heartbeat cancels pending close');

  const quizSource=randomUUID(),oralSource=randomUUID(),turnSource=randomUUID(),interviewId=randomUUID();
  await db.query("insert into memory_attempts(id,student_id,memory_item_id,rating,data,due_at) values($1,$2,'synthetic-quiz','again',$3,now())",[quizSource,students[0],JSON.stringify({synthetic:true,answer:'합성 오답'})]);
  await db.query("insert into memory_attempts(id,student_id,memory_item_id,rating,data,due_at) values($1,$2,'synthetic-oral','good',$3,now())",[oralSource,students[0],JSON.stringify({synthetic:true,answer:'합성 녹음 답변'})]);
  await db.query("insert into interview_sessions(id,student_id,kind,content_version,data) values($1,$2,'video',1,$3)",[interviewId,students[0],JSON.stringify({synthetic:true})]);
  await db.query("insert into interview_turns(id,session_id,student_id,question_id,data) values($1,$2,$3,'synthetic-interview',$4)",[turnSource,interviewId,students[0],JSON.stringify({synthetic:true,response:'합성 면접 답변'})]);
  const client=await pool.connect();
  try{
    await client.query('begin');
    const first=await recordStudyEvent(client,students[0],{kind:'quiz_response',sourceId:quizSource,data:{quizSessionId:randomUUID(),memoryItemId:'synthetic-quiz',questionId:'synthetic-question',prompt:'합성 선택형 질문',mode:'choice',outcome:false,timedOut:true,elapsedMs:10000,response:'합성 오답'}});
    const duplicate=await recordStudyEvent(client,students[0],{kind:'quiz_response',sourceId:quizSource,data:{outcome:true}});
    check(first.sessionId===id&&!first.duplicate&&duplicate.duplicate,'persisted source retries counted once');
    await recordStudyEvent(client,students[0],{kind:'quiz_response',sourceId:oralSource,data:{memoryItemId:'synthetic-oral',questionId:'synthetic-oral-question',prompt:'합성 말하기 질문',mode:'oral',outcome:null,timedOut:false,elapsedMs:8000,response:'합성 녹음 답변'}});
    await recordStudyEvent(client,students[0],{kind:'interview_answer',sourceId:turnSource,data:{sessionId:interviewId,kind:'video',questionId:'synthetic-interview',question:'합성 면접 질문',answer:'합성 면접 답변',assisted:true}});
    await client.query('commit');
  }catch(err){await client.query('rollback');throw err;}finally{client.release();}
  const active=await request(0);const report=active.body.current.report;
  check(active.headers.get('cache-control')?.includes('private')&&active.headers.get('cache-control')?.includes('no-store'),'private reports not shared cached');
  check(report.eventCount===3&&report.quiz.answered===2&&report.interviews.answered===1,'actual quiz and interview answers accumulate');
  check(report.quiz.wrong===1&&report.quiz.correct===0&&report.quiz.ungraded===1&&report.quiz.oral===1,'oral answers stay ungraded and quiz answer outcome preserved');
  check(report.quiz.timedOut===1&&report.quiz.elapsedMs===18000,'actual timeout and recorded response times counted');
  check(report.interviews.live===1&&report.interviews.chat===0&&report.interviews.assisted===1,'live and assisted responses distinct');
  check(report.weakPoints.length===1&&report.weakPoints[0].wrong===1&&report.weakPoints[0].timedOut===1,'timeout plus wrong produces one question without duplicate weakness counts');
  check(active.body.totals.eventCount===3&&active.body.sessions.length===0,'active data contributes totals without false finalized report');
  check((await request(1)).body.current.report.eventCount===0,'other student report excludes owner answers');
  const finished=await request(0,undefined,{action:'finish',reason:'manual',sessionId:id});
  check(finished.status===200&&finished.body.session.state==='finalized'&&finished.body.session.report.events.length===3,'explicit finish freezes factual report');
  const again=await request(0,undefined,{action:'finish',reason:'logout',sessionId:id});
  check(again.body.session.ended_at===finished.body.session.ended_at&&again.body.session.finish_reason==='manual','finish retries idempotent and original report timestamp preserved');
  check((await request(0)).body.sessions.length===1,'finalized session listed once');
  const next=await heartbeat(0);check(next.body.sessionId!==id,'new learning after finish starts separate session');
  // Missed beacon is recovered on next app request; no browser close API can guarantee delivery.
  await db.query("update study_session_tabs set last_seen_at=now()-interval '4 minutes' where session_id=$1",[next.body.sessionId]);
  await db.query("update study_sessions set last_seen_at=now()-interval '4 minutes' where id=$1",[next.body.sessionId]);
  const recovered=await request(0);check(recovered.body.current===null,'stale leases reconciled after missed exit beacon');
  check((await db.query('select state,finish_reason from study_sessions where id=$1',[next.body.sessionId])).rows[0].finish_reason==='idle_recovery','recovery reason saved');
  check(recovered.body.sessions.length===1,'empty abandoned visits do not create empty report rows');
  const third=await heartbeat(0);await request(0,undefined,{action:'leave',tabId:tabs[0]});
  await db.query("update study_sessions set closing_at=now()-interval '1 second' where id=$1",[third.body.sessionId]);
  await request(0);check((await db.query('select finish_reason from study_sessions where id=$1',[third.body.sessionId])).rows[0].finish_reason==='app_exit','delivered last-tab exit reconciles after grace');
  check((await request(0,'/api/study-sessions?id='+id)).body.session.report.events.find((event:any)=>event.source_id===quizSource)?.data.response==='합성 오답','snapshot preserves saved answer and source');
  console.log(`PASS ${count} study-session checks (auth, ownership, multi-tab, retries, factual reports, timeout, ungraded oral, idle/exit recovery; paid API calls 0).`);
}finally{
  await db.query('delete from study_sessions where student_id=any($1::uuid[])',[all]);
  await db.query('delete from memory_attempts where student_id=any($1::uuid[])',[all]);
  await db.query('delete from interview_sessions where student_id=any($1::uuid[])',[all]);
  await db.query('delete from sessions where user_id=any($1::uuid[])',[all]);
  await db.query("delete from profiles where id=any($1::uuid[]) and email like 'study-session-%@gakja.test'",[all]);
  await db.end();await pool.end();
}
