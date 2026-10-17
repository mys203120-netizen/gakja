import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { tsImport } from 'tsx/esm/api';

// Execute the actual store, route and client loader. PostgreSQL and publisher
// boundaries are in-memory fixtures; no network, application DB or AI is used.
const model = await tsImport('../apps/web/src/lib/department-news-model.ts', import.meta.url);
const topic = model.majorNewsTopic('환경공학과');
const key = `${model.NEWS_TOPIC_REVISION}:${topic.key}`;
const owner = { id: 'owner', role: 'student' }, other = { id: 'other', role: 'student' };
const articleId = '11111111-1111-4111-8111-111111111111';
const historicId = '22222222-2222-4222-8222-222222222222';
const baseNow = Date.parse('2026-10-15T10:00:00Z');
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
function compile(path, require, globals = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, Date, Map, Set, Promise, Response, Request, URL, URLSearchParams, AbortSignal, AbortController, Uint8Array, TextDecoder, console, setTimeout, clearTimeout, require, ...globals });
  return module.exports;
}
function fixture({ missing = false, fresh = false } = {}) {
  const state = { now: baseNow, caches: new Map(), articles: new Map(), thoughts: new Map(), queries: [], fetches: 0, claims: 0, transactions: 0, failPublishers: false, gate: null, articleWrites: 0 };
  if (!missing) state.caches.set(key, { topic_key: key, article_ids: [articleId], status: 'fresh', fetched_at: new Date(baseNow - (fresh ? 1000 : 7200000)), checked_at: new Date(baseNow - (fresh ? 1000 : 7200000)), retry_after: new Date(baseNow - 1), source_failures: [] });
  state.articles.set(articleId, { id: articleId, canonical_url: 'https://www.waterjournal.co.kr/news/articleView.html?idxno=123', title: '하천 수질과 미세플라스틱 연구', publisher: '워터저널', snippet: '검증된 짧은 RSS 발췌', published_at: new Date(baseNow - 86400000), fetched_at: new Date(baseNow - 7200000), feed_key: 'water' });
  state.thoughts.set(`owner:${articleId}`, { content: '내가 저장한 개인 생각', revision: 1, updated_at: new Date(baseNow - 10000) });
  const asRows = rows => ({ rows });
  async function query(sql, params = []) {
    state.queries.push({ sql, params });
    if (sql.startsWith('select id,data from support_targets')) return [{ id: `${params[0]}-target`, data: { university: '검사 대학', major: '환경공학과' } }];
    if (sql.startsWith('select data from student_preferences')) return [];
    if (sql.startsWith('select * from department_news_cache')) return state.caches.has(params[0]) ? [{ ...state.caches.get(params[0]) }] : [];
    if (sql.startsWith('select * from department_news_articles')) return params[0].map(id => state.articles.get(id)).filter(row => row && new Date(row.published_at).getTime() >= state.now - 30 * 86400000);
    if (sql.startsWith('select a.* from department_news_articles a join department_news_thoughts')) return state.thoughts.has(`${params[1]}:${params[0]}`) ? [state.articles.get(params[0])] : [];
    if (sql.startsWith('select article_id,content,revision,updated_at')) return params[1].flatMap(id => state.thoughts.has(`${params[0]}:${id}`) ? [{ article_id: id, ...state.thoughts.get(`${params[0]}:${id}`) }] : []);
    if (sql.startsWith('select article_id,briefing_id')) return [];
    if (sql.startsWith('select r.content,r.revision,r.created_at')) return state.thoughts.has(`${params[0]}:${params[1]}`) ? [{ ...state.thoughts.get(`${params[0]}:${params[1]}`) }] : [];
    if (sql.startsWith('insert into department_news_cache')) {
      // This is the database uniqueness/conditional UPSERT boundary, shared by
      // separately loaded workers. An app-only inflight map cannot pass it.
      assert.match(sql, /on conflict\(topic_key\) do update.*where department_news_cache.retry_after<=now\(\)/);
      assert.match(sql, /date_trunc\('milliseconds',now\(\)\)/, 'claim fencing timestamp round-trips pg Date precision');
      const cached = state.caches.get(params[0]);
      if (cached && (new Date(cached.retry_after).getTime() > state.now || !params[1] && cached.status !== 'error' && cached.fetched_at && state.now - new Date(cached.fetched_at).getTime() < 3600000)) return [];
      const claim = new Date(state.now + 300000);
      state.caches.set(params[0], { topic_key: params[0], article_ids: [], status: 'error', fetched_at: null, checked_at: new Date(state.now), source_failures: [], ...cached, retry_after: claim });
      state.claims++;
      return [{ retry_after: new Date(claim) }];
    }
    if (sql.startsWith('select topic_key from department_news_cache')) {
      assert.match(sql, /retry_after=\$2 for update$/);
      return new Date(state.caches.get(params[0]).retry_after).getTime() === new Date(params[1]).getTime() ? [{ topic_key: params[0] }] : [];
    }
    if (sql.startsWith('insert into department_news_articles')) {
      state.articleWrites++;
      const id = `33333333-3333-4333-8333-${String(state.articleWrites).padStart(12, '0')}`;
      state.articles.set(id, { id, canonical_url: params[0], title: params[1], publisher: params[2], snippet: params[3], published_at: params[4], feed_key: params[5], fetched_at: new Date(state.now) });
      return [{ id }];
    }
    if (sql.startsWith('update department_news_cache')) {
      const cached = state.caches.get(params[0]);
      if (new Date(cached.retry_after).getTime() !== new Date(params[1]).getTime()) return [];
      if (sql.includes("set status='error'")) Object.assign(cached, { status: 'error', checked_at: new Date(state.now), retry_after: new Date(state.now + 300000), source_failures: JSON.parse(params[2]) });
      else Object.assign(cached, { article_ids: Array.from(params[2]), status: params[3], fetched_at: new Date(state.now), checked_at: new Date(state.now), retry_after: new Date(state.now + 60000), source_failures: JSON.parse(params[4]) });
      return [];
    }
    if (sql.startsWith('select pg_advisory_xact_lock')) return [];
    if (sql.startsWith('select * from department_news_thoughts')) return state.thoughts.has(`${params[0]}:${params[1]}`) ? [{ ...state.thoughts.get(`${params[0]}:${params[1]}`), id: 'thought' }] : [];
    if (sql.startsWith('insert into department_news_thoughts')) {
      const thought = { content: params[2], revision: params[3], updated_at: new Date(state.now), id: 'thought' };
      state.thoughts.set(`${params[0]}:${params[1]}`, thought); return [thought];
    }
    if (sql.startsWith('insert into department_news_thought_revisions')) return [];
    throw new Error('Unexpected database query: ' + sql);
  }
  async function fetcher(url) {
    state.fetches++; check(state.claims > 0, 'publisher request occurs only after a database claim');
    if (state.gate) await state.gate;
    if (state.failPublishers) throw new Error('publisher offline');
    const feedKey = Object.keys(model.NEWS_FEEDS).find(key => model.NEWS_FEEDS[key].url === String(url));
    const host = model.NEWS_FEEDS[feedKey].articleHosts[0];
    return new Response(`<rss><channel><item><title>하천 수질과 미세플라스틱 최신 연구</title><link>https://${host}/article/fixture</link><pubDate>${new Date(state.now - 1000).toUTCString()}</pubDate><description>공개 RSS 발췌</description></item></channel></rss>`, { headers: { 'Content-Type': 'application/rss+xml' } });
  }
  const db = { ApiError, query, transaction: async callback => { state.transactions++; return callback({ query: async (sql, params) => asRows(await query(sql, params)) }); } };
  class ClockDate extends Date { constructor(...values) { super(...(values.length ? values : [state.now])); } static now() { return state.now; } }
  const worker = () => compile('../apps/web/src/lib/department-news.ts', name => {
    if (name === 'server-only') return {};
    if (name === './db') return db;
    if (name === './department-news-model') return model;
    if (name === './school-directory') return { schoolDirectoryForTarget: () => null };
    throw new Error('Unexpected dependency: ' + name);
  }, { fetch: fetcher, Date: ClockDate });
  return { state, worker };
}

// Response assembly is independent of unreachable or stalled publishers.
let { state, worker } = fixture();
let store = worker();
let snapshot = await store.getDepartmentNews(owner);
check(snapshot.status === 'stale' && snapshot.refreshDue && snapshot.articles[0].id === articleId, 'stale owned snapshot is returned immediately and requests a background refresh');
check(state.fetches === 0 && state.claims === 0 && state.queries.every(row => row.sql.startsWith('select ')), 'GET snapshot reads neither fetch publishers nor claim/write cache');
check(snapshot.articles[0].thought.content === '내가 저장한 개인 생각', 'private reflection remains attached to its authenticated owner');
const foreign = await store.getDepartmentNews(other);
check(foreign.articles[0].thought === null && foreign.targetId === 'other-target', 'shared public cache never shares student reflections or target identity');
await assert.rejects(store.getDepartmentNews(owner, { targetId: 'other-target' }), error => error.status === 404); checks++;
await assert.rejects(store.getDepartmentNews({ id: 'admin', role: 'admin' }), error => error.status === 403); checks++;

// Independent workers contend on the same cache row before any feed request.
let release;
state.gate = new Promise(resolve => { release = resolve; });
const firstWorker = store.refreshDepartmentNews(topic), secondWorker = worker().refreshDepartmentNews(topic);
await new Promise(setImmediate);
check(state.claims === 1 && state.fetches === topic.feeds.length, 'two independent app workers fetch one set of publisher feeds');
release(); await Promise.all([firstWorker, secondWorker]);
check(state.caches.get(key).status === 'fresh' && state.caches.get(key).article_ids.length > 0, 'the claim owner publishes a successful snapshot');
check(state.transactions === 1, 'worker without the database lease does not enter snapshot publication');
const cooldown = await store.getDepartmentNews(owner, { refresh: true });
check(!cooldown.refreshDue && !cooldown.refreshPending, 'fresh successful cooldown is not mislabeled as an active refresh');
state.now += 120000;
await worker().refreshDepartmentNews(topic);
check(state.claims === 1, 'fresh TTL is rechecked atomically even if a stale client requests background work');
await worker().refreshDepartmentNews(topic, { force: true });
check(state.claims === 2, 'legacy refresh=1 can claim a fresh snapshot after its retry cooldown');

// Failures retain exactly the preceding successful IDs and fetched time.
({ state, worker } = fixture()); store = worker(); state.failPublishers = true;
const beforeFailure = structuredClone(state.caches.get(key));
await store.refreshDepartmentNews(topic);
const failed = state.caches.get(key);
check(failed.status === 'error' && JSON.stringify(failed.article_ids) === JSON.stringify(beforeFailure.article_ids) && +failed.fetched_at === +beforeFailure.fetched_at, 'publisher failure preserves saved article IDs and last successful fetchedAt');
snapshot = await store.getDepartmentNews(owner);
check(snapshot.status === 'stale' && !snapshot.refreshDue && !snapshot.refreshPending && snapshot.articles[0].id === articleId, 'failed refresh keeps stale readable articles during five-minute backoff');
await worker().refreshDepartmentNews(topic, { force: true });
check(state.claims === 1, 'manual refresh cannot bypass failure or concurrency cooldown');

// A worker whose lease expired cannot overwrite a newer successful result.
({ state, worker } = fixture()); store = worker();
state.gate = new Promise(resolve => { release = resolve; });
const delayed = store.refreshDepartmentNews(topic); await new Promise(setImmediate);
state.now += 301000; state.gate = null;
await worker().refreshDepartmentNews(topic);
const published = structuredClone(state.caches.get(key)), writeCount = state.articleWrites;
release(); await delayed;
check(state.articleWrites === writeCount && JSON.stringify(state.caches.get(key)) === JSON.stringify(published), 'fencing token prevents expired delayed worker from changing a newer snapshot');

// Missing cache does not block the first visit, and queued work is disclosed.
({ state, worker } = fixture({ missing: true })); store = worker();
snapshot = await store.getDepartmentNews(owner);
check(snapshot.status === 'unavailable' && snapshot.refreshPending && snapshot.refreshDue && state.fetches === 0, 'first visit reports preparing state without waiting on a publisher');
state.gate = new Promise(resolve => { release = resolve; });
const initialRefresh = store.refreshDepartmentNews(topic); await new Promise(setImmediate);
snapshot = await store.getDepartmentNews(owner);
check(snapshot.refreshPending && !snapshot.refreshDue, 'another first visit sees the existing empty-cache lease instead of starting another refresh');
release(); await initialRefresh;

// Private historic thoughts remain available after RSS age-out, including saves.
({ state, worker } = fixture()); store = worker();
state.articles.set(historicId, { ...state.articles.get(articleId), id: historicId, published_at: new Date(baseNow - 45 * 86400000) });
state.thoughts.set(`owner:${historicId}`, { content: '지난 기사에 대한 내 생각', revision: 1, updated_at: new Date(baseNow - 10000) });
snapshot = await store.getDepartmentNews(owner, { articleId: historicId });
check(snapshot.articles.some(row => row.id === historicId && row.thought.content === '지난 기사에 대한 내 생각'), 'owned saved historic article survives publisher RSS expiry');
check(!(await store.getDepartmentNews(other, { articleId: historicId })).articles.some(row => row.id === historicId), 'historic saved article is not disclosed to another student');
check((await store.newsThoughtHistory(other, historicId)).length === 0, 'historic thought revisions keep their owner constraint');
await store.mutateDepartmentNews(owner, { action: 'thought', articleId: historicId, content: '다시 확인한 내 생각', expectedRevision: 1 });
check(state.fetches === 0 && state.claims === 0 && state.thoughts.get(`owner:${historicId}`).revision === 2, 'saving a historic reflection never fetches or refreshes news');

// Route after() owns work: responding, history and rejected requests do not wait.
const afterTasks = [];
const route = compile('../apps/web/src/app/api/news/route.ts', name => {
  if (name === '@/lib/auth') return { requireUser: async () => owner, checkOrigin() {} };
  if (name === '@/lib/db') return { ApiError, errorResponse: error => Response.json({ error: error.message }, { status: error.status || 500 }) };
  if (name === 'next/server') return { after: task => afterTasks.push(task) };
  if (name === '@/lib/department-news') return store;
  throw new Error(name);
});
const response = await route.GET(new Request('http://app.test/api/news?targetId=owner-target&refresh=1'));
check(response.status === 200 && response.headers.get('cache-control') === 'private, no-store', 'private response remains uncacheable by shared browser/CDN caches');
check(afterTasks.length === 1 && state.fetches === 0, 'route schedules refresh after returning a snapshot instead of awaiting it');
await route.GET(new Request(`http://app.test/api/news?history=1&articleId=${historicId}`));
await route.GET(new Request('http://app.test/api/news?targetId=other-target'));
check(afterTasks.length === 1, 'history and foreign-target requests cannot schedule publisher refresh');
await afterTasks[0]();
check(state.claims === 1 && state.fetches === topic.feeds.length, 'scheduled callback executes claimed background work');

// Client fetches are bounded, retain scope and never repeat the force parameter.
function clientLoader(replies, { abortAt = -1 } = {}) {
  const urls = [], delays = [], shown = [], controller = new AbortController();
  const component = compile('../apps/web/src/components/department-news.tsx', name => {
    if (name === './shared') return { api: async (url, options) => { urls.push(url); assert.equal(options.signal, controller.signal); if (urls.length === abortAt) controller.abort(new Error('scope changed')); const reply = replies[Math.min(urls.length - 1, replies.length - 1)]; if (reply instanceof Error) throw reply; return reply; } };
    if (name === 'react/jsx-runtime' || name === 'react' || name === 'lucide-react' || name === './app-shell' || name === './material-navigation' || name === 'next/navigation') return {};
    if (name === 'next/link' || name.endsWith('.css')) return { default: {} };
    throw new Error(name);
  }, { setTimeout: (callback, ms) => { delays.push(ms); queueMicrotask(callback); return delays.length; }, clearTimeout() {} });
  return { run: force => component.loadDepartmentNewsSnapshots('/api/news?targetId=owner-target', controller.signal, snapshot => shown.push(snapshot), force), urls, delays, shown };
}
const stale = { status: 'stale', fetchedAt: 'old', checkedAt: 'old', refreshPending: true, refreshDue: true, articles: [{ id: articleId }] };
const fresh = { ...stale, status: 'fresh', fetchedAt: 'new', checkedAt: 'new', refreshPending: false, refreshDue: false };
let client = clientLoader([stale, fresh]); await client.run(false);
check(client.shown[0].articles[0].id === articleId && client.shown[1].status === 'fresh' && client.urls.length === 2, 'client displays saved articles before updating to the refreshed snapshot');
client = clientLoader([stale]); await client.run(true);
check(client.urls.length === 4 && JSON.stringify(client.delays) === JSON.stringify([1500, 2500, 8000]), 'a stalled publisher causes only three bounded follow-up reads');
check(client.urls[0].endsWith('&refresh=1') && client.urls.slice(1).every(url => url === '/api/news?targetId=owner-target'), 'polling preserves target identity and never forces another publisher refresh');
client = clientLoader([{ ...fresh, fetchedAt: 'old', checkedAt: 'old', refreshDue: true, refreshPending: true }, { ...fresh, fetchedAt: 'old', checkedAt: 'old' }, fresh]); await client.run(true);
check(client.urls.length === 3, 'manual refresh of an already-fresh snapshot waits for an actual changed timestamp');
client = clientLoader([stale, { ...stale, refreshPending: false, refreshDue: false, checkedAt: 'failed-attempt' }]); await client.run(false);
check(client.urls.length === 2 && client.shown.at(-1).articles[0].id === articleId, 'completed failure stops polling while preserving the readable article');
client = clientLoader([stale, new Error('temporary network failure')]);
await assert.rejects(client.run(false), /temporary network failure/); checks++;
check(client.shown.length === 1 && client.shown[0].articles[0].id === articleId, 'a polling transport failure leaves the previously displayed articles intact');
client = clientLoader([stale, fresh], { abortAt: 2 });
await assert.rejects(client.run(false), /scope changed/); checks++;
check(client.shown.length === 1, 'an aborted old target request cannot commit a new snapshot after scope changes');
console.log(`Department news snapshot/background regression: ${checks} checks passed; external requests, application DB writes and AI calls: 0.`);
