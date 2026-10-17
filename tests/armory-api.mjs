import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
import {loadProjectEnv} from '../scripts/load-env.mjs';
loadProjectEnv();
const base=process.env.ARMORY_TEST_URL||'http://localhost:3100';
if(!['localhost','127.0.0.1'].includes(new URL(base).hostname))throw Error('Local test only');
const db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();
const users=[randomUUID(),randomUUID()],cardId=randomUUID(),sessionIds=[];
const tokens=users.map(()=>randomBytes(32).toString('hex'));
const hashes=tokens.map(t=>createHash('sha256').update(t).digest('hex'));
let checks=0;
async function request(path,body,actor=0,status=200){const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Origin:base,...(actor===null?{}:{Cookie:'gakja_session='+tokens[actor]})},...(body?{body:JSON.stringify(body)}:{})});const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));checks++;return result;}
try{
 for(let i=0;i<2;i++){await db.query('insert into profiles(id,email,name,role) values($1,$2,$3,$4)',[users[i],`armory-${users[i]}@gakja.test`,'무기고 자동검증','student']);await db.query("insert into sessions(id,user_id,expires_at) values($1,$2,now()+interval '15 minutes')",[hashes[i],users[i]]);}
 await request('/api/armory',null,null,401);
 const data={title:'검증 경험',category:'협업',situation:'형식이 달랐다',action:'양식을 정했다',result:'정리본을 사용했다',confirmed:false,pinned:false,sourceNote:'자동검증'};
 await request('/api/armory',{id:cardId,revision:0,data});
 const catalog=await request('/api/interviews?preview=1&sourceType=common');
 const question=catalog.questions.find(q=>q.common_revision);assert.ok(question,'common question exists');
 const selection={action:'start',kind:'chat',questionId:question.id,sourceType:'common',questionCount:1,experienceCardId:cardId,experienceRevision:1,requestId:randomUUID()};
 await request('/api/interviews',selection,0,409);
 await request('/api/armory',{id:cardId,revision:1,data:{...data,confirmed:true}});
 await request('/api/armory',{id:cardId,revision:1,data},0,409);
 await request('/api/armory',{id:cardId,revision:2,data},1,409);
 assert.equal((await request('/api/armory',null,1)).cards.length,0);
 await request('/api/interviews',{...selection,experienceRevision:2},1,404);
 for(const kind of ['chat','video']){const started=await request('/api/interviews',{...selection,kind,experienceRevision:2,requestId:randomUUID()});sessionIds.push(started.session.id);assert.equal(started.session.data.experienceCard.data.action,data.action);}
 await request('/api/armory',{id:cardId,revision:2,data:{...data,confirmed:true,action:'수정한 행동'}});
 const previous=await request('/api/interviews?id='+sessionIds[0]);assert.equal(previous.session.data.experienceCard.data.action,data.action);checks++;
 await request('/api/interviews',{...selection,experienceRevision:2,requestId:randomUUID()},0,409);
 const current=await request('/api/interviews?id='+sessionIds[0]);
 await request('/api/interviews',{action:'help',sessionId:sessionIds[0],turnId:current.question.turnId,helpKind:'evidence',requestId:randomUUID()});
 await request('/api/interviews',{action:'answer',sessionId:sessionIds[0],turnId:current.question.turnId,answer:'서로 원하는 자료 형식을 듣고 공통 양식을 정했습니다.',requestId:randomUUID()});
 const history=await request('/api/armory');assert.equal(history.sessions.length,2);assert.equal(history.sessions.find(s=>s.id===sessionIds[0]).answers.length,1);checks++;
 const bootstrap=await request('/api/bootstrap');assert.equal(bootstrap.interviews.find(s=>s.id===sessionIds[0]).data.experienceCard.id,cardId);checks++;

 console.log(`Armory API: ${checks} checks passed (ownership, draft, revision, Chat/Live, snapshot).`);
}finally{
 for(const id of sessionIds){await db.query('delete from interview_turns where session_id=$1 and student_id=$2',[id,users[0]]);await db.query('delete from interview_sessions where id=$1 and student_id=$2',[id,users[0]]);}
 await db.query('delete from experience_cards where id=$1 and student_id=$2',[cardId,users[0]]);
 await db.query('delete from sessions where id=any($1::text[])',[hashes]);
 await db.query('delete from study_sessions where student_id=any($1::uuid[])',[users]);
 await db.query('delete from profiles where id=any($1::uuid[])',[users]);await db.end();
}
