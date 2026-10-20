// Real PostgreSQL predicate and pure completion agree; temporary synthetic records are rolled back.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {loadProjectEnv,redactEnvironmentSecrets} from '../scripts/load-env.mjs';
import {interviewCompletion,allInterviewRootsAnsweredSql} from '../apps/web/src/lib/interview-completion';

loadProjectEnv();if(!['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname))throw Error('Local isolated database only');
const db=new pg.Client({connectionString:process.env.DATABASE_URL}),student=randomUUID(),room=randomUUID();let checks=0;
const data={questionQueue:[{id:'a'},{id:'b'},{id:'c'}]},turns:any[]=[];
async function verify(expected:boolean,label:string){
 await db.query('update interview_sessions set data=$2 where id=$1',[room,JSON.stringify(data)]);
 const result=(await db.query(`select ${allInterviewRootsAnsweredSql('s')} as complete from interview_sessions s where id=$1`,[room])).rows[0];
 assert.equal(result.complete,expected,label+' SQL');assert.equal(interviewCompletion(data,turns).allRootsAnswered,expected,label+' pure');checks++;
}
async function add(question:string,extra:any={}){const turn={id:randomUUID(),question_id:question,data:{question,rootQuestionId:question,answer:'저장한 답변',...extra}};turns.push(turn);await db.query('insert into interview_turns(id,session_id,student_id,question_id,data) values($1,$2,$3,$4,$5)',[turn.id,room,student,question,JSON.stringify(turn.data)]);return turn;}
try{
 await db.connect();await db.query('begin');await db.query("insert into profiles(id,email,name,role) values($1,$2,'isolated completion fixture','student')",[student,`completion-${student}@gakja.test`]);
 await db.query("insert into interview_sessions(id,student_id,kind,content_version,data) values($1,$2,'video',0,$3)",[room,student,JSON.stringify(data)]);
 await verify(false,'no answer or room state is not a completed diagnosis');await add('a',{answer:'몰라요'});await verify(false,'one short answer does not complete three diagnostic questions');
 const b=await add('b',{answer:'',draft:'작성한 초안만 있음'});await add('c',{followupDepth:1});await verify(false,'drafts and followup answers cannot supply missing root answers');
 b.data.answer='직접 보낸 답변';await db.query('update interview_turns set data=$2 where id=$1',[b.id,JSON.stringify(b.data)]);const c=await add('c');await verify(true,'every owned frozen root has an actual submitted answer');
 c.data.invalidated=true;await db.query('update interview_turns set data=$2 where id=$1',[c.id,JSON.stringify(c.data)]);await verify(false,'invalidating the last root reopens lesson completion');
 c.data.invalidated=false;c.data.answer='  ';await db.query('update interview_turns set data=$2 where id=$1',[c.id,JSON.stringify(c.data)]);await verify(false,'whitespace is not an answer');
 c.data.answer='답변';await db.query('update interview_turns set data=$2 where id=$1',[c.id,JSON.stringify(c.data)]);data.questionQueue.push({id:'a'});await verify(false,'duplicate frozen roots cannot fabricate a valid completed scope');
 data.questionQueue=[];await verify(false,'unknown or empty frozen scope remains unconfirmed');assert.throws(()=>allInterviewRootsAnsweredSql('s;delete'));checks++;
 console.log(JSON.stringify({passed:checks,actualPostgres:true,providerCalls:0,physicalMicrophone:false,rolledBack:true}));
}catch(error){console.error(redactEnvironmentSecrets(error instanceof Error?error.stack:String(error)));process.exitCode=1;}finally{await db.query('rollback').catch(()=>{});await db.end();}
