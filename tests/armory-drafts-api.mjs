// Explicit local HTTP + PostgreSQL regression. Creates only disposable students.
// Does not call AI, STT, Storage, or mutate existing student records.
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
import {loadProjectEnv} from '../scripts/load-env.mjs';
loadProjectEnv();
const base=process.env.ARMORY_TEST_URL||'http://localhost:3101';
const databaseUrl=new URL(process.env.TEST_DATABASE_URL||process.env.DATABASE_URL);
if(!['localhost','127.0.0.1'].includes(new URL(base).hostname)||!['localhost','127.0.0.1'].includes(databaseUrl.hostname))throw Error('Draft regression requires a local app and database.');
const db=new pg.Client({connectionString:databaseUrl.href});await db.connect();
const users=[randomUUID(),randomUUID()],id=randomUUID(),tokens=users.map(()=>randomBytes(32).toString('hex')),hashes=tokens.map(token=>createHash('sha256').update(token).digest('hex'));
let checks=0;
async function call(path,{method='GET',body,actor=0}={}){const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Origin:base,...(actor===null?{}:{Cookie:'gakja_session='+tokens[actor]})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,result:await response.json()};}
function check(value,message){assert.ok(value,message);checks++;}
try{
 for(let i=0;i<users.length;i++){await db.query('insert into profiles(id,email,name,role) values($1,$2,$3,$4)',[users[i],`draft-test-${users[i]}@gakja.test`,'초안 회귀용 합성 학생','student']);await db.query("insert into sessions(id,user_id,expires_at) values($1,$2,now()+interval '15 minutes')",[hashes[i],users[i]]);}
 check((await call('/api/armory/drafts',{actor:null})).status===401,'unauthenticated draft reads are rejected');
 const data={title:'',category:'협업',situation:'조별 자료 형식이 달랐다.',action:'',result:'',confirmed:false,pinned:false,sourceNote:'합성 회귀 검사'};
 const draft={id,draft:data,revision:0,step:1,serverRevision:0,updatedAt:new Date().toISOString()};
 const created=await call('/api/armory/drafts',{method:'PUT',body:draft});check(created.status===200&&created.result.draft.serverRevision===1,'first autosave is acknowledged with revision 1');
 check(created.result.draft.draft.title==='','autosave preserves an optional blank title');
 const retried=await call('/api/armory/drafts',{method:'PUT',body:draft});check(retried.status===200&&retried.result.draft.serverRevision===1,'lost-response retry accepts an untitled draft without incrementing the revision');
 check((await call('/api/armory/drafts')).result.drafts.some(item=>item.id===id&&item.draft.title===''),'untitled server draft remains discoverable on a fresh read');
 check((await call('/api/armory/drafts',{actor:1})).result.drafts.length===0,'another student cannot list the draft');
 const concurrent=await Promise.all(['새 행동 A','새 행동 B'].map(action=>call('/api/armory/drafts',{method:'PUT',body:{...draft,serverRevision:1,draft:{...data,action}}})));
 check(concurrent.filter(result=>result.status===200).length===1&&concurrent.filter(result=>result.status===409).length===1,'same-version concurrent autosaves have exactly one winner');
 const winner=concurrent.find(result=>result.status===200).result.draft;
 const stolen=await call('/api/armory/drafts',{method:'PUT',actor:1,body:{...draft,serverRevision:2}});check(stolen.status===409&&!JSON.stringify(stolen.result).includes(data.situation),'foreign update rejects without leaking title or body');
 const incompleteConfirm=await call('/api/armory',{method:'POST',body:{id,revision:0,draftRevision:2,data:{...data,confirmed:true}}});check(incompleteConfirm.status===400,'a blank title is allowed but missing personal action still prevents confirmation');
 const staleConfirm=await call('/api/armory',{method:'POST',body:{id,revision:0,draftRevision:1,data:{...winner.draft,confirmed:true}}});check(staleConfirm.status===409,'stale final save cannot delete a newer draft');
 check((await db.query('select revision from experience_card_drafts where id=$1',[id])).rows[0].revision===2,'failed final save retains server draft');
 const committed=await call('/api/armory',{method:'POST',body:{id,revision:0,draftRevision:2,data:{...winner.draft,confirmed:true}}});check(committed.status===200&&committed.result.card.data.confirmed,'explicit final save creates the confirmed card');
 check(committed.result.card.data.title==='협업 경험','explicit card save generates a title for an untitled experience');
 check((await db.query('select id from experience_card_drafts where id=$1',[id])).rowCount===0,'draft is removed only in successful card-save transaction');
 const edit={...draft,revision:1,draft:{...data,action:'편집 중인 별도 행동'},serverRevision:0};check((await call('/api/armory/drafts',{method:'PUT',body:edit})).status===200,'a saved card can have an independent server draft');
 const original=(await db.query('select data,revision from experience_cards where id=$1',[id])).rows[0];check(original.data.confirmed&&original.data.action===winner.draft.action&&original.revision===1,'autosaving edits preserves the confirmed source and revision');
 await call('/api/armory',{method:'POST',body:{id,revision:1,data:{...original.data,pinned:true}}});
 check((await call('/api/armory/drafts',{method:'PUT',body:{...edit,serverRevision:1}})).status===409,'an edit based on a stale confirmed card is rejected');
 check((await db.query('select data from experience_card_drafts where id=$1',[id])).rows[0].data.action===edit.draft.action,'stale-card conflict preserves the earlier server draft');
 await db.query('update profiles set active=false where id=$1',[users[0]]);check((await call('/api/armory/drafts')).status!==200,'inactive account cannot read drafts with an existing token');
 console.log(`Armory draft HTTP: ${checks} checks passed (local API + PostgreSQL, ownership, concurrent CAS, final acknowledgement, source preservation, inactive account).`);
}finally{
 await db.query('delete from experience_card_drafts where student_id=any($1::uuid[])',[users]);await db.query('delete from experience_cards where student_id=any($1::uuid[])',[users]);await db.query('delete from sessions where id=any($1::text[])',[hashes]);await db.query('delete from study_sessions where student_id=any($1::uuid[])',[users]);await db.query('delete from profiles where id=any($1::uuid[])',[users]);await db.end();
}
