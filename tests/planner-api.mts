// Local integration: node --import tsx tests/planner-api.mts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash } from 'bcryptjs';
import pg from 'pg';
import { loadProjectEnv, projectRoot, redactEnvironmentSecrets } from '../scripts/load-env.mjs';
import {koreaToday,shiftPlanDay} from '../apps/web/src/lib/planner-model';

loadProjectEnv();
let lastServerUrl: string | undefined;
try { lastServerUrl = JSON.parse(readFileSync(join(projectRoot, '.local/server.json'), 'utf8')).url; }
catch { /* An explicit local test URL is also supported. */ }
const base = process.env.TEST_BASE_URL || process.env.SMOKE_BASE_URL || lastServerUrl || 'http://localhost:3100';
let localDatabase = false, localServer = false;
try {
  const database = new URL(process.env.DATABASE_URL!);
  const server = new URL(base);
  localDatabase = ['postgres:', 'postgresql:'].includes(database.protocol) && ['localhost', '127.0.0.1'].includes(database.hostname);
  localServer = server.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(server.hostname) && !server.username && !server.password;
} catch { /* Malformed settings fail without printing a connection string. */ }
if (process.env.AUTH_MODE !== 'local' || !localDatabase || !localServer) throw new Error('계획표 검증은 로컬 인증·DB·HTTP 서버에서만 실행해 주세요.');

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const fixture = randomUUID(), fixtureIds: string[] = [];
const actors: Record<string, string> = {}, cookies: Record<string, string> = {};
const password = `Planner!${fixture}`;
let checks = 0;
function check(value: unknown, label: string): asserts value { assert.ok(value, label); checks++; }
async function request(actor: string, path: string, body?: unknown, origin = base) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, ...(cookies[actor] ? { Cookie: cookies[actor] } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = response.headers.getSetCookie();
  if (set.length) cookies[actor] = set.map(value => value.split(';')[0]).join('; ');
  return { status: response.status, body: await response.json(), headers: response.headers };
}
const get = (actor: string, query = '') => request(actor, `/api/planner${query}`);
const create = (actor: string, data: Record<string, unknown> = {}) => request(actor, '/api/planner', { action: 'create', title: '계획표 합성 검증', date: '2026-10-12', ...data });
const update = (actor: string, id: string, expectedRevision: unknown, data: Record<string, unknown> = {}) => request(actor, '/api/planner', { action: 'update', id, expectedRevision, ...data });

await db.connect();
try {
  check(Boolean((await db.query("select to_regclass('student_plans') as plans")).rows[0]?.plans), 'planner migration applied');
  const passwordHash = await hash(password, 12);
  for (const [actor, role] of [['student', 'student'], ['other', 'student'], ['staff', 'staff'], ['admin', 'admin']]) {
    const id = randomUUID(), email = `planner-${actor}-${fixture}@gakja.test`;
    await db.query('insert into profiles(id,email,name,role,password_hash) values($1,$2,$3,$4,$5)', [id, email, '계획표 API 격리 검증', role, passwordHash]);
    fixtureIds.push(id); actors[actor] = id;
    check((await request(actor, '/api/auth', { action: 'login', email, password })).status === 200, `${actor} independent synthetic login`);
  }
  for (const actor of ['student','other']) {
    const packageId=`planner-${fixture}-${actor}`,jobId=`planner-job-${fixture}-${actor}`;
    const learning={activities:[{id:`${actor}-${fixture}-activity`,title:'합성 미세플라스틱 분리 활동'}],questions:[{id:`${actor}-${fixture}-question`,prompt:'합성 분리 조건을 설명해 보세요.',activity_ids:[`${actor}-${fixture}-activity`]}],source_refs:[],memory_items:[],answer_scripts:[],support_targets:[]};
    await db.query('insert into production_links(id,student_id,data) values($1,$2,$3)',[jobId,actors[actor],JSON.stringify({synthetic:true,fixture:'planner-api'})]);
    await db.query('insert into content_packages(id,student_id,active_version) values($1,$2,1)',[packageId,actors[actor]]);
    await db.query("insert into content_versions(package_id,version,data,learning_hash,status,production_job_ref) values($1,1,$2,'planner-api-synthetic','published',$3)",[packageId,JSON.stringify(learning),jobId]);
  }

  check((await get('anonymous')).status === 401, 'anonymous read denied');
  check((await create('anonymous')).status === 401, 'anonymous write denied');
  for (const actor of ['staff', 'admin']) {
    check((await get(actor)).status === 403, `${actor} student plans read denied`);
    check((await create(actor)).status === 403, `${actor} student plans write denied`);
  }
  const empty = await get('student');
  check(empty.status === 200 && empty.body.plans.length === 0, 'new synthetic student has empty plans');
  check(empty.headers.get('cache-control')?.includes('private') && empty.headers.get('cache-control')?.includes('no-store'), 'plan reads cannot enter shared cache');
  for (const date of ['2026-02-29', '2026-02-30', '2026-04-31', '2026-00-12', '2026-13-01', '2026-10-12T00:00:00Z']) {
    check((await create('student', { date })).status === 400, `invalid calendar day ${date} rejected`);
  }
  check((await create('student', { title: ' \n\t ' })).status === 400, 'blank title rejected');
  check((await create('student', { title: '가'.repeat(161) })).status === 400, 'title length bound enforced');
  check((await create('student', { kind: 'unknown' })).status === 400, 'unknown plan kind rejected');
  check((await request('student', '/api/planner', { action: 'create', title: '검증', date: '2026-10-12' }, 'https://example.test')).status === 403, 'cross-origin mutation denied');

  const first = await create('student', { title: '  미세 플라스틱 자료 읽기  ', kind: 'reading', studentId: actors.other });
  check(first.status === 200 && first.body.plan.title === '미세 플라스틱 자료 읽기', 'creation trims title');
  const id: string = first.body.plan.id;
  check(first.body.plan.completed === false && first.body.plan.revision === 1 && first.body.plan.kind === 'reading', 'new plan starts incomplete at revision one');
  check(first.body.plan.date === '2026-10-12', 'date-only creation keeps selected calendar day');
  check(first.headers.get('cache-control')?.includes('private') && first.headers.get('cache-control')?.includes('no-store'), 'mutation response remains private');
  const stored = (await db.query("select student_id,to_char(planned_date,'YYYY-MM-DD') as date from student_plans where id=$1", [id])).rows[0];
  check(stored.student_id === actors.student && stored.date === '2026-10-12', 'server uses authenticated owner despite forged studentId');
  const strangerRead = await get('other', `?studentId=${actors.student}`);
  check(strangerRead.status === 200 && strangerRead.body.plans.length === 0, 'GET ignores forged owner query and exposes own plans only');
  check((await update('other', id, 1, { completed: true })).status === 404, 'other student cannot update owner plan');
  check((await update('student', randomUUID(), 1, { completed: true })).status === 404, 'absent plan update returns not found');
  check((await update('staff', id, 1, { completed: true })).status === 403, 'staff cannot update student plan');
  check((await update('admin', id, 1, { completed: true })).status === 403, 'admin cannot update student plan');

  const complete = await update('student', id, 1, { completed: true });
  check(complete.status === 200 && complete.body.plan.completed === true && complete.body.plan.revision === 2, 'completion false to true persists with next revision');
  check((await update('student', id, 1, { completed: false, title: '오래된 화면' })).status === 409, 'stale revision rejected');
  check((await get('student')).body.plans[0].completed === true && (await get('student')).body.plans[0].title === '미세 플라스틱 자료 읽기', 'conflict preserves current data');
  const reopen = await update('student', id, 2, { completed: false });
  check(reopen.status === 200 && reopen.body.plan.completed === false && reopen.body.plan.revision === 3, 'completion true to false persists');
  check((await update('student', id, 0, { completed: true })).status === 400, 'nonpositive expected revision rejected');
  check((await update('student', id, undefined, { completed: true })).status === 400, 'missing expected revision rejected');
  check((await update('student', id, 3, { date: '2026-02-30' })).status === 400, 'update rejects nonexistent calendar date');
  const reschedule = await update('student', id, 3, { title: '  윤년 계획  ', date: '2028-02-29' });
  check(reschedule.status === 200 && reschedule.body.plan.date === '2028-02-29' && reschedule.body.plan.title === '윤년 계획' && reschedule.body.plan.revision === 4, 'valid leap day and trimmed title update persist');
  await db.query("set time zone 'America/Los_Angeles'");
  check((await db.query("select to_char(planned_date,'YYYY-MM-DD') as date from student_plans where id=$1", [id])).rows[0].date === '2028-02-29', 'date-only storage remains calendar day in another DB timezone');

  const other = await create('other', { title: '다른 학생의 격리 계획', date: '2026-11-01', kind: 'interview' });
  check(other.status === 200, 'other student creates own separate plan');
  const ownRead = await get('student'), otherRead = await get('other');
  check(ownRead.body.plans.length === 1 && ownRead.body.plans[0].id === id && ownRead.body.plans[0].date === '2028-02-29', 'GET owner list excludes other student plan and preserves date');
  check(otherRead.body.plans.length === 1 && otherRead.body.plans[0].id === other.body.plan.id, 'GET other list excludes first student plan');
  const racing = await Promise.all([update('student', id, 4, { completed: true }), update('student', id, 4, { completed: true })]);
  check(racing.map(result => result.status).sort().join(',') === '200,409', 'concurrent updates with same revision permit exactly one writer');
  check((await get('student')).body.plans[0].revision === 5, 'concurrent conflict does not increment revision twice');
  check((await request('student', '/api/planner', { action: 'create', title: '가'.repeat(8100), date: '2026-10-12' })).status === 413, 'oversized request rejected before validation');
  const currentTargets=(await get('student')).body.targets;
  check(currentTargets.some((target:any)=>target.id===`student-${fixture}-question`)&&!currentTargets.some((target:any)=>target.id===`other-${fixture}-question`),'context options expose only owned published question IDs');
  check((await create('student',{target:{kind:'question',id:`other-${fixture}-question`}})).status===404,'other student target rejected');
  check((await create('student',{target:{kind:'question',id:`student-${fixture}-question`,href:'https://example.test'}})).status===400,'arbitrary client target href rejected');
  const linked=await create('student',{title:'같은 질문 모의면접',kind:'interview',target:{kind:'question',id:`student-${fixture}-question`}});
  check(linked.status===200&&linked.body.plan.href===`/interview/new?questionId=student-${fixture}-question&sourceType=personal&sourceVersion=1`,'linked plan starts exact owned interview question and published source version');
  const manual=await update('student',linked.body.plan.id,1,{completed:true});
  check(manual.body.plan.completed===true&&manual.body.plan.completionSource==='manual'&&manual.body.plan.performedAt===null,'manual checking never fabricates actual practice');
  const videoPlan=await create('student',{title:'영상 보고 설명하기',kind:'reading',target:{kind:'video',id:'lQRsqMiBTsI'}});
  check(videoPlan.status===200&&videoPlan.body.plan.href==='/knowledge/lQRsqMiBTsI'&&videoPlan.body.plan.performedAt===null,'video plan starts genuine linked video without guessing completion');
  const watched=await request('student','/api/knowledge-bites',{action:'complete',videoId:'lQRsqMiBTsI',value:true,expectedRevision:0});
  check(watched.status===200,'actual selfreported video progress saved');
  const recorded=(await get('student')).body.plans.find((plan:any)=>plan.id===videoPlan.body.plan.id);
  check(recorded.performedAt&&recorded.completed===false&&recorded.completionSource===null,'matching saved source event is displayed independently of manual completion');
  const futurePlan=await create('student',{title:'나중에 다시 설명하기',date:'2040-01-01',kind:'reading',target:{kind:'video',id:'lQRsqMiBTsI'}});
  const explained=await request('student','/api/knowledge-bites',{action:'explanation',videoId:'lQRsqMiBTsI',value:'합성 테스트에서 지금 설명한 내용',expectedRevision:watched.body.progress.revision});
  check(explained.status===200,'explanation creates a real saved event after future plan creation');
  const futureRecorded=(await get('student')).body.plans.find((plan:any)=>plan.id===futurePlan.body.plan.id);
  check(futureRecorded.performedAt===null&&futureRecorded.completed===false,'today practice never satisfies a future spaced review');
  const common=currentTargets.find((target:any)=>target.common);
  if(common){const commonPlan=await create('student',{kind:'interview',target:{kind:'question',id:common.id}});check(commonPlan.status===200&&commonPlan.body.plan.href.startsWith('/interview/new?questionId='),'common question target works without personal quiz items');}
  const autoTarget=`auto-${fixture}`;
  const schoolData={university:'고려대학교',campus:'본교',department:'경영학과',admission_type:'학생부종합',admission_year:2027};
  await db.query('insert into support_targets(id,student_id,data) values($1,$2,$3)',[autoTarget,actors.student,JSON.stringify(schoolData)]);
  const auto=(actor:string,body:Record<string,unknown>={})=>request(actor,'/api/planner/automatic',{action:'preview',targetId:autoTarget,interviewDate:shiftPlanDay(koreaToday(),3),minutes:20,...body});
  check((await auto('anonymous')).status===401,'automatic plan requires login');
  check((await auto('other')).status===404,'automatic plan rejects another student school');
  check((await auto('staff')).status===403,'automatic plan student-only');
  check((await auto('student',{interviewDate:koreaToday()})).status===400,'past or same-day plan rejected');
  const preview=await auto('student');
  check(preview.status===200&&preview.body.plans.length>0,'automatic plan preview uses owned current questions');
  check(preview.body.plans.every((plan:any)=>plan.target.targetId===autoTarget),'every generated question retains current school');
  check((await auto('student',{action:'save',previewToken:'forged'})).status===409,'save rejects stale or forged preview');
  const saveBody={action:'save',previewToken:preview.body.previewToken};
  const doubleSave=await Promise.all([auto('student',saveBody),auto('student',saveBody)]);
  check(doubleSave.every(result=>result.status===200),'parallel saves accepted idempotently');
  let generated=(await get('student')).body.plans.filter((plan:any)=>plan.target?.automaticPractice);
  check(generated.length===preview.body.plans.length,'parallel save never duplicates planned tasks');
  check(generated.every((plan:any)=>plan.href?.includes(encodeURIComponent(autoTarget))&&plan.targetAvailable),'generated calendar entries open validated school scope');
  const completed=generated[0],edited=generated[1];
  await update('student',completed.id,completed.revision,{completed:true});
  await update('student',edited.id,edited.revision,{title:'직접 수정한 계획'});
  const nextPreview=await auto('student',{minutes:10});
  check((await auto('student',{action:'save',minutes:10,previewToken:nextPreview.body.previewToken})).status===200,'regenerate with a changed daily budget');
  const afterAuto=(await get('student')).body.plans;
  check(afterAuto.some((plan:any)=>plan.id===completed.id&&plan.completed),'completed auto plan survives regeneration');
  check(afterAuto.some((plan:any)=>plan.id===edited.id&&plan.title==='직접 수정한 계획'&&!plan.target.automaticPractice),'manually edited auto plan survives regeneration');
  check(afterAuto.some((plan:any)=>plan.id===id),'ordinary manual plan survives regeneration');
  check((await request('other',`/api/reports?targetId=${autoTarget}`)).status===404,'growth refuses another student target');
  await db.query("update support_targets set data=data||'{\"archived_at\":\"2026-10-17\"}'::jsonb where id=$1",[autoTarget]);
  check((await auto('student')).status===404,'deleted school cannot generate new practice');
  check((await request('student',`/api/reports?targetId=${autoTarget}`)).status===404,'deleted school cannot be current report scope');
  console.log(`Planner API checks passed: ${checks}. Only isolated UUID fixtures used; no seeded data or external services touched.`);
} catch (error) {
  console.error(redactEnvironmentSecrets(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  // Bound every cleanup to IDs successfully inserted by this run.
  try {
    await db.query('begin');
    await db.query('delete from student_plans where student_id=any($1::uuid[])', [fixtureIds]);
    await db.query('delete from knowledge_bite_progress where student_id=any($1::uuid[])',[fixtureIds]);
    await db.query('delete from study_sessions where student_id=any($1::uuid[])',[fixtureIds]);
    await db.query('delete from study_imported_events where student_id=any($1::uuid[])',[fixtureIds]);
    await db.query('delete from sessions where user_id=any($1::uuid[])', [fixtureIds]);
    await db.query('delete from content_versions where package_id=any($1::text[])',[[`planner-${fixture}-student`,`planner-${fixture}-other`]]);
    await db.query('delete from content_packages where student_id=any($1::uuid[])',[fixtureIds]);
    await db.query('delete from production_links where student_id=any($1::uuid[])',[fixtureIds]);
    await db.query('delete from support_targets where student_id=any($1::uuid[])',[fixtureIds]);
    await db.query('delete from profiles where id=any($1::uuid[])', [fixtureIds]);
    await db.query('commit');
    const remaining = Number((await db.query('select count(*)::int as n from profiles where id=any($1::uuid[])', [fixtureIds])).rows[0].n);
    assert.equal(remaining, 0, 'synthetic fixture cleanup');
  } catch (error) {
    await db.query('rollback');
    console.error(`Planner fixture cleanup failed: ${redactEnvironmentSecrets(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 1;
  }
  await db.end();
}
