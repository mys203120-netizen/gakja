// Local-only HTTP checks. All student writes belong to disposable fixture profiles.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { hash } from 'bcryptjs';
import { loadProjectEnv, projectRoot } from '../scripts/load-env.mjs';
import { NEWS_TOPIC_REVISION } from '../apps/web/src/lib/department-news-model.ts';
loadProjectEnv();
let stateUrl = ''; try { stateUrl = JSON.parse(readFileSync(join(projectRoot, '.local/server.json'), 'utf8')).url; } catch { /* explicitly provided local URL is supported */ }
const base = process.env.TEST_BASE_URL || stateUrl || 'http://localhost:3100';
if (process.env.AUTH_MODE !== 'local' || !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname) || !['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('로컬 DB와 서버에서만 실행할 수 있어요.');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL }), fixture = randomUUID();
const ids = { owner: randomUUID(), other: randomUUID(), empty: randomUUID(), admin: randomUUID() };
const target = `news-${fixture}-environment`, otherTarget = `news-${fixture}-computing`, cookies: Record<string, string> = {};
let checks = 0; const log: string[] = [];
let historicalArticle:string|null=null;
const cacheFixtureKeys:string[]=[],cacheFixtureArticles:string[]=[];
function check(value: unknown, label: string) { assert.ok(value, label); checks++; log.push(label); }
async function request(actor: string, path: string, body?: unknown, origin = base) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, ...(cookies[actor] ? { Cookie: cookies[actor] } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const jar = response.headers.getSetCookie(); if (jar.length) cookies[actor] = jar.map(item => item.split(';')[0]).join('; ');
  return { status: response.status, data: await response.json(), headers: response.headers };
}
await db.connect();
try {
  check(Boolean((await db.query("select to_regclass('department_news_articles') as table_name")).rows[0].table_name), 'news migration applied');
  const password = `News!${fixture}`, passwordHash = await hash(password, 8);
  for (const [actor, id] of Object.entries(ids)) {
    const email = `news-${actor}-${fixture}@gakja.test`;
    await db.query("insert into profiles(id,email,name,role,password_hash) values($1,$2,$3,$4,$5)", [id, email, `뉴스 ${actor} 합성 검사`, actor === 'admin' ? 'admin' : 'student', passwordHash]);
    check((await request(actor, '/api/auth', { action: 'login', email, password })).status === 200, `${actor} independent login`);
  }
  await db.query('insert into support_targets(id,student_id,data) values($1,$2,$3),($4,$5,$6)', [target, ids.owner, JSON.stringify({ university: '테스트 전용', major: '환경공학과' }), otherTarget, ids.other, JSON.stringify({ university: '테스트 전용', major: '컴퓨터공학과' })]);
  check((await request('anonymous', '/api/news')).status === 401, 'anonymous news denied');
  check((await request('admin', '/api/news')).status === 403, 'admin student-news endpoint denied');
  const empty = await request('empty', '/api/news'); check(empty.status === 200 && empty.data.status === 'setup_required' && empty.data.articles.length === 0, 'new student needs major, no fake default articles');
  check((await request('owner', `/api/news?targetId=${otherTarget}`)).status === 404, 'foreign target selection denied');
  const news = await request('owner', `/api/news?targetId=${target}`);
  check(news.status === 200 && ['fresh', 'stale'].includes(news.data.status), 'live publisher news cached and returned');
  check(news.data.major === '환경공학과' && news.data.articles.length > 0 && news.data.articles.length <= 20, 'server-owned major and bounded relevant articles');
  check(news.data.connection.basis==='major_topic'&&news.data.connection.label==='환경·수질','major topic disclosure survives API');
  // A reflection saved under the previous topic cache revision is not required
  // to remain inside today's finite RSS. Its source and private history survive.
  historicalArticle=(await db.query("insert into department_news_articles(canonical_url,title,publisher,snippet,published_at,feed_key) values($1,'수질 보전 과거 기사','워터저널','합성 과거 기사',now()-interval '45 days','water') returning id",[`https://www.waterjournal.co.kr/news/articleView.html?qa=${fixture}`])).rows[0].id;
  const historicalThought=(await db.query("insert into department_news_thoughts(student_id,article_id,content,revision) values($1,$2,'합성 과거 생각',1) returning id",[ids.owner,historicalArticle])).rows[0].id;
  await db.query("insert into department_news_thought_revisions(thought_id,student_id,content,revision) values($1,$2,'합성 과거 생각',1)",[historicalThought,ids.owner]);
  const historical=await request('owner',`/api/news?targetId=${target}&articleId=${historicalArticle}`);
  check(historical.data.articles.some((row:any)=>row.id===historicalArticle&&row.thought?.content==='합성 과거 생각'&&row.keywords.includes('수질')),'past owned reflection accessible after topic revision and RSS expiry');
  check(!news.data.articles.some((row:any)=>row.id===historicalArticle),'past article never enters fresh list');
  check(!(await request('other',`/api/news?targetId=${otherTarget}&articleId=${historicalArticle}`)).data.articles.some((row:any)=>row.id===historicalArticle),'past article does not leak across students');
  const legacyMajor=`희귀학제${fixture}`,legacyTarget=`news-${fixture}-legacy`,emptyMajor=`미연결검색${fixture}`,emptyTarget=`news-${fixture}-no-articles`;
  await db.query('insert into support_targets(id,student_id,data) values($1,$2,$3),($4,$2,$5)',[legacyTarget,ids.owner,JSON.stringify({university:'테스트 전용',major:legacyMajor+'학과'}),emptyTarget,JSON.stringify({university:'테스트 전용',major:emptyMajor+'학과'})]);
  for(const [title,suffix] of [[`${legacyMajor} 소식`,'related'],['관계없는 행사 소식','unrelated']])cacheFixtureArticles.push((await db.query("insert into department_news_articles(canonical_url,title,publisher,snippet,published_at,feed_key) values($1,$2,'경향신문','합성 캐시 회귀 기사',now()-interval '1 day','society') returning id",[`https://www.khan.co.kr/article/qa-${fixture}-${suffix}`,title])).rows[0].id);
  const legacyKey=`v1:major:${legacyMajor}`,newKey=`${NEWS_TOPIC_REVISION}:major:${legacyMajor}`,emptyKey=`${NEWS_TOPIC_REVISION}:major:${emptyMajor}`;
  cacheFixtureKeys.push(legacyKey,newKey,emptyKey);
  await db.query("insert into department_news_cache(topic_key,article_ids,status,fetched_at,retry_after) values($1,$2,'fresh',now()-interval '2 hours',now()+interval '1 hour'),($3,'{}','error',null,now()+interval '1 hour'),($4,'{}','empty',now(),now()+interval '1 hour')",[legacyKey,cacheFixtureArticles,newKey,emptyKey]);
  const offline=await request('owner',`/api/news?targetId=${legacyTarget}`);
  check(offline.status===200&&offline.data.status==='stale'&&offline.data.articles.length===1&&offline.data.articles[0].id===cacheFixtureArticles[0],'taxonomy rollover retains safe legacy cache when publishers are unavailable');
  check(!offline.data.articles.some((row:any)=>row.id===cacheFixtureArticles[1]),'legacy cache is re-filtered with current topic keywords');
  const actualEmpty=await request('owner',`/api/news?targetId=${emptyTarget}`);
  check(actualEmpty.status===200&&actualEmpty.data.status==='empty'&&actualEmpty.data.articles.length===0&&actualEmpty.data.connection.basis==='keyword','unknown manually entered major with no article stays explicitly empty');
  check(news.headers.get('cache-control') === 'private, no-store', 'no shared caching of private reflections');
  check(news.data.articles.every((row: any) => row.keywords.length && new Date(row.publishedAt).getTime() <= Date.now() && Date.now() - new Date(row.publishedAt).getTime() <= 30 * 86400_000 && row.snippet.length <= 180 && /^https:\/\//.test(row.url)), 'real dates within 30 days, keywords, limited excerpt and original URL');
  const article = news.data.articles[0];
  const save = (content: string, expectedRevision: number) => request('owner', '/api/news', { action: 'thought', articleId: article.id, targetId: target, content, expectedRevision, studentId: ids.other });
  const practice = () => request('owner', '/api/news', { action: 'practice', articleId: article.id, targetId: target });
  check((await practice()).status === 409, 'same-article practice requires saved personal reflection');
  check((await save(' '.repeat(5), 0)).status === 400, 'empty thought rejected');
  check((await save('a'.repeat(4001), 0)).status === 400, 'oversized thought rejected');
  check((await request('owner', '/api/news', { action: 'thought', articleId: article.id, content: 'x', expectedRevision: 0 }, 'https://foreign.test')).status === 403, 'foreign-origin writes denied');
  const first = await save('  생물다양성이 수질 보전과 어떻게 연결되는지 원문을 확인하고 싶다.  ', 0);
  check(first.status === 200 && first.data.thought.revision === 1 && !first.data.thought.content.startsWith(' '), 'reflection trimmed and revision saved');
  const own = (await db.query('select student_id from department_news_thoughts where article_id=$1 and student_id=any($2::uuid[])', [article.id, [ids.owner, ids.other]])).rows;
  check(own.length === 1 && own[0].student_id === ids.owner, 'forged studentId ignored');
  const duplicate = await save(first.data.thought.content, 0); check(duplicate.status === 200 && duplicate.data.unchanged && duplicate.data.thought.revision === 1, 'duplicate retry idempotent');
  check((await save('이전 화면의 오래된 수정', 0)).status === 409, 'concurrent thought revision guarded');
  const second = await save('수질 관리의 기술적 조건뿐 아니라 지역 생태계의 변화를 함께 살펴보겠다.', 1);
  check(second.status === 200 && second.data.thought.revision === 2, 'reflection evolves with revision');
  const history = await request('owner', `/api/news?history=1&articleId=${article.id}`);
  check(history.status === 200 && history.data.history.length === 2 && history.data.history[0].content === second.data.thought.content, 'ordered content growth history preserved');
  check((await request('other', `/api/news?history=1&articleId=${article.id}`)).data.history.length === 0, 'foreign reflection history hidden');
  const linked = await practice(); check(linked.status === 200 && linked.data.href.includes(`briefingId=${linked.data.briefingId}`) && linked.data.href.includes(`targetId=${target}`) && linked.data.question.includes(article.title), 'same article becomes an interview setup link');
  const briefing = (await db.query('select * from briefings where id=$1', [linked.data.briefingId])).rows[0];
  check(briefing.data.owner_student_id === ids.owner && briefing.data.article_id === article.id && briefing.data.target_id === target && briefing.data.source_url === article.url && briefing.data.thought_snapshot.content === second.data.thought.content, 'fixed source and owned reflection are connected in briefing context');
  const preview = await request('owner', `/api/interviews?preview=1&briefingId=${linked.data.briefingId}&targetId=${target}`);
  check(preview.status === 200 && preview.data.question?.prompt?.includes(article.title), 'interview preview uses the exact article practice prompt');
  check((await request('other', `/api/interviews?preview=1&briefingId=${linked.data.briefingId}&targetId=${otherTarget}`)).status === 404, 'private news briefing cannot enter another student interview');
  const started = await request('owner', '/api/interviews', { action: 'start', kind: 'chat', mode: 'major', briefingId: linked.data.briefingId, targetId: target, questionCount: 1, followups: false, requestId: randomUUID() });
  check(started.status === 200 && started.data.question?.prompt?.includes(article.title) && started.data.session?.data?.context?.briefing?.thought_snapshot?.revision === 2, 'real interview start snapshots same article and saved reflection without provider call');
  const retry = await practice(); check(retry.data.briefingId === linked.data.briefingId, 'practice bridge does not duplicate');
  await save('기사의 주장과 내 생각을 구분하고 반론에 필요한 근거를 준비하겠다.', 2);
  await practice();
  const updated = (await db.query('select data from briefings where id=$1', [linked.data.briefingId])).rows[0];
  check(updated.data.thought_snapshot.revision === 3 && updated.data.source_url === article.url, 'updated thought keeps the same source and practice bridge');
  const fixedSession = await request('owner', `/api/interviews?id=${started.data.session.id}`);
  check(fixedSession.status === 200 && fixedSession.data.session?.data?.context?.briefing?.thought_snapshot?.revision === 2, 'later reflection changes cannot rewrite an existing interview snapshot');
  const reload = await request('owner', `/api/news?targetId=${target}&articleId=${article.id}`);
  check(reload.data.articles.find((row: any) => row.id === article.id)?.thought?.revision === 3, 'reflection survives reload');
  check((await request('other', '/api/news', { action: 'practice', articleId: article.id, targetId: target })).status === 404, 'foreign target practice denied');
  const countBefore = (await db.query('select count(*)::int as n from department_news_thought_revisions r join department_news_thoughts t on t.id=r.thought_id where t.student_id=$1', [ids.owner])).rows[0].n;
  check(countBefore === 4, 'no revision inflation after retry, historical revision preserved');
  const cache = (await db.query('select checked_at from department_news_cache where topic_key=$1', [`${NEWS_TOPIC_REVISION}:environment`])).rows[0];
  await request('owner', `/api/news?targetId=${target}`);
  const cacheAfter = (await db.query('select checked_at from department_news_cache where topic_key=$1', [`${NEWS_TOPIC_REVISION}:environment`])).rows[0];
  check(new Date(cache.checked_at).getTime() === new Date(cacheAfter.checked_at).getTime(), 'TTL prevents per-view crawling');
  console.log(`Department news HTTP/DB checks: ${checks} passed`);
  writeFileSync(join(projectRoot, '.local', 'department-news-api-check.json'), JSON.stringify({ checkedAt: new Date().toISOString(), checks, passed: true, cases: log, fixtureCleanup: true, externalAIRequests: 0 }, null, 2));
} finally {
  await db.query('begin');
  // Every deletion is scoped to generated profile UUIDs; real students and collected public news stay intact.
  const students = Object.values(ids);
  await db.query('delete from interview_sessions where student_id=any($1::uuid[])', [students]);
  await db.query('delete from department_news_practice where student_id=any($1::uuid[])', [students]);
  await db.query('delete from department_news_thoughts where student_id=any($1::uuid[])', [students]);
  if(historicalArticle)await db.query('delete from department_news_articles where id=$1',[historicalArticle]);
  await db.query('delete from department_news_cache where topic_key=any($1::text[])',[cacheFixtureKeys]);
  await db.query('delete from department_news_articles where id=any($1::uuid[])',[cacheFixtureArticles]);
  await db.query("delete from briefings where created_by=any($1::uuid[]) and data->>'source_kind'='rss_news'", [students]);
  await db.query('delete from support_targets where student_id=any($1::uuid[])', [students]);
  await db.query('delete from student_preferences where student_id=any($1::uuid[])', [students]);
  await db.query('delete from profiles where id=any($1::uuid[])', [students]);
  await db.query('commit'); await db.end();
}
