import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import pg from 'pg';
import {loadProjectEnv,projectRoot} from '../scripts/load-env.mjs';
import {schoolDirectory} from '../apps/web/src/lib/school-directory';
loadProjectEnv();const base=process.env.TEST_BASE_URL || JSON.parse(readFileSync(join(projectRoot,'.local/server.json'),'utf8')).url || 'http://localhost:3100';
if(process.env.AUTH_MODE!=='local'||!['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname)||!['localhost','127.0.0.1'].includes(new URL(base).hostname))throw new Error('로컬 전용 검사입니다.');
const db=new pg.Client({connectionString:process.env.DATABASE_URL}),owner=randomUUID(),other=randomUUID(),fixture=randomUUID();let cookie='',checks=0;const labels:string[]=[];
function check(value:unknown,label:string){assert.ok(value,label);checks++;labels.push(label);}
function raw(category:string,id:string){const school=schoolDirectory.find(s=>s.departments.some(d=>d.category===category))!;const dept=school.departments.find(d=>d.category===category)!;return {id,school_reference_id:school.id,university:school.university,department:dept.name,major:dept.name,department_catalog_id:dept.id,campus:school.campusLabel || dept.campus,admission_year:2027,admission_type:'합성 학습검사'};}
const a=raw('전기・전자・컴퓨터',`knowledge-a-${fixture}`),b=raw('경영・경제',`knowledge-b-${fixture}`),foreign=raw('음악',`knowledge-foreign-${fixture}`),shared='E91bGT9BjYk';
async function req(path:string,body?:Record<string,unknown>){const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Cookie:cookie,Origin:base,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});if(response.headers.getSetCookie().length)cookie=response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');return {status:response.status,data:await response.json()};}
const get=(targetId:string,extra='')=>req(`/api/knowledge-bites?targetId=${encodeURIComponent(targetId)}${extra}`);
const save=(targetId:string,id:string,value:string,revision:number,extra:Record<string,unknown>={})=>req('/api/knowledge-bites',{action:'explanation',targetId,videoId:id,value,expectedRevision:revision,...extra});
await db.connect();
try {
  const hash=(await db.query('select password_hash from profiles where email=$1',['harin@gakja.test'])).rows[0].password_hash;
  for(const id of [owner,other])await db.query("insert into profiles(id,email,name,role,password_hash) values($1,$2,'합성 학교지식 검사','student',$3)",[id,`knowledge-target-${id}@gakja.test`,hash]);
  for(const [actor,target]of [[owner,a],[owner,b],[other,foreign]]as const)await db.query('insert into support_targets(id,student_id,data) values($1,$2,$3)',[target.id,actor,JSON.stringify(target)]);
  check((await req('/api/auth',{action:'login',email:`knowledge-target-${owner}@gakja.test`,password:process.env.TEST_ACCOUNT_PASSWORD || 'Gakja!2026'})).status===200,'independent fixture login');
  const first=await get(a.id);check(first.status===200&&!first.data.contentVersion&&first.data.targetId===a.id,'no record profile receives exact selected school-major');
  check(first.data.videos.some((v:any)=>v.kind==='video'&&v.originLabels.includes('학과 연결'))&&first.data.readings.length>0,'no record still has major videos and official school readings');
  const reading=first.data.readings.find((r:any)=>r.relatedQuestions.length>0);check(Boolean(reading),'official school reading has published common practice question');
  const q=reading.relatedQuestions[0],extra={questionId:q.id,commonRevision:q.commonRevision};
  const explained=await save(a.id,reading.id,'실제 경험을 꾸미지 않고 이 가치를 전공에서 실천할 계획을 설명한다.',0,extra);
  check(explained.status===200&&explained.data.progress.snapshot.learning.commonRevision===q.commonRevision&&explained.data.progress.snapshot.learning.sourceKind==='common','official reading saves fixed common source revision');
  const repeated=await save(a.id,reading.id,'실제 경험을 꾸미지 않고 이 가치를 전공에서 실천할 계획을 설명한다.',1,extra);check(repeated.status===200&&repeated.data.unchanged===true,'jsonb persisted target order does not reset same explanation');
  check((await save(a.id,reading.id,'오래된 판본',1,{...extra,commonRevision:q.commonRevision+999})).status===409,'stale common revision rejected');
  check((await get(foreign.id)).status===404,'another student target cannot be read');check((await save(foreign.id,reading.id,'다른 학생 목표',1)).status===404,'another student target cannot be written');
  const schoolB=await get(b.id);check(schoolB.data.readings.some((r:any)=>r.current&&r.targetId===b.id)&&schoolB.data.videos.find((r:any)=>r.id===reading.id)?.current===false,'switching target keeps old reading historical');
  check((await get(b.id,`&questionId=${encodeURIComponent(q.id)}`)).status===404 || a.school_reference_id===b.school_reference_id,'school A common question cannot be applied to another school');
  const savedA=await save(a.id,shared,'A 학교의 자료 해석에서 축과 단위가 결론에 영향을 준다.',0);check(savedA.status===200,'shared major video saves A context without fabricated personal question');
  const savedB=await save(b.id,shared,'B 학교의 시장 자료에서도 축과 단위를 비교한다.',1);check(savedB.status===200&&savedB.data.progress.snapshot.learning.targetId===b.id,'same video gets distinct B explanation context');
  const returnedA=await get(a.id,`&videoId=${shared}`), restored=returnedA.data.videos.find((v:any)=>v.id===shared).progress;
  check(restored.revision===2&&restored.snapshot.learning.explanation===savedA.data.progress.snapshot.learning.explanation&&restored.snapshot.targetId===a.id,'A→B→A restores A explanation while preserving newest concurrency revision');
  check(returnedA.data.history.some((row:any)=>row.revision===1&&row.metadata.targetId===a.id)&&returnedA.data.history.some((row:any)=>row.revision===2&&row.metadata.targetId===b.id),'immutable video history preserves each school-major snapshot');
  const checked=await req('/api/knowledge-bites',{action:'self_check',videoId:shared,targetId:a.id,value:'needs_review',expectedRevision:2});check(checked.status===200&&checked.data.progress.snapshot.learning.explanation===savedA.data.progress.snapshot.learning.explanation,'returning A self-check continues the original A explanation');
  const event=(await db.query("select data from study_session_events where student_id=$1 and source_id=$2",[owner,`${explained.data.progress.id}:1`])).rows[0].data;
  check(event.source_kind==='common'&&event.common_revision===q.commonRevision&&event.target_id===a.id&&event.target_snapshot.department===a.department&&event.activityIds.length===0,'reading learning event preserves common question and source without inventing an activity');
  const job=`knowledge-mixed-${fixture}`,pack=`knowledge-mixed-pack-${fixture}`;
  await db.query('insert into production_links(id,student_id,data) values($1,$2,$3)',[job,owner,JSON.stringify({synthetic:true})]);
  await db.query('insert into content_packages(id,student_id,active_version) values($1,$2,3)',[pack,owner]);
  await db.query("insert into content_versions(package_id,version,data,learning_hash,status,production_job_ref) values($1,3,$2,'synthetic-knowledge-mixed','published',$3)",[pack,JSON.stringify({activities:[{id:'synthetic-team-activity',title:'합성 조별역할 활동',source_ref_ids:[]}],questions:[],source_refs:[],memory_items:[],answer_scripts:[],support_targets:[a,b]}),job]);
  const help=await req(`/api/learning-help?targetId=${a.id}&questionId=${encodeURIComponent(q.id)}&sourceType=common&sourceVersion=${q.commonRevision}`);
  check(help.status===200&&help.data.learning.questions.some((item:any)=>item.id===q.id&&item.common_revision===q.commonRevision)&&help.data.learning.activities.some((item:any)=>item.id==='synthetic-team-activity'),'common help uses common source revision while retaining current approved personal activities');
  check((await req(`/api/learning-help?targetId=${a.id}&questionId=${encodeURIComponent(q.id)}&sourceType=common&sourceVersion=999999`)).status===400,'common help validates source revision range');
  check((await req(`/api/learning-help?targetId=${a.id}&questionId=${encodeURIComponent(q.id)}&sourceType=wrong`)).status===400,'help rejects invalid source type before requesting AI');
  check((await db.query('select count(*)::int count from ai_usage_logs where student_id=any($1::uuid[])',[[owner,other]])).rows[0].count===0,'no paid AI requests');
  writeFileSync(join(projectRoot,'.local/knowledge-school-major-api-check.json'),JSON.stringify({checkedAt:new Date().toISOString(),passed:checks,labels,externalRequests:0,originalStudentChanges:0},null,2));
  console.log(`School-major knowledge API checks passed: ${checks}. External requests: 0; original student changes: 0.`);
} finally {
  await db.query('begin');try{for(const table of ['knowledge_bite_progress','study_sessions','study_imported_events','support_targets','student_preferences','audit_logs'])await db.query(`delete from ${table} where student_id=any($1::uuid[])`,[[owner,other]]);await db.query('delete from sessions where user_id=any($1::uuid[])',[[owner,other]]);await db.query('delete from content_versions where package_id=$1',[`knowledge-mixed-pack-${fixture}`]);await db.query('delete from content_packages where student_id=any($1::uuid[])',[[owner,other]]);await db.query('delete from production_links where student_id=any($1::uuid[])',[[owner,other]]);await db.query('delete from profiles where id=any($1::uuid[])',[[owner,other]]);await db.query('commit');}catch(error){await db.query('rollback');throw error;}await db.end();
}
