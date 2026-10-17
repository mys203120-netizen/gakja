import 'server-only';
import type { Profile } from './auth';
import { ApiError, query, transaction } from './db';
import { NEWS_FEEDS, NEWS_TOPIC_REVISION, majorNewsConnection, matchingNewsKeywords, newsPracticeQuestion, parsePublisherFeed, filterNewsTopic, type DepartmentNewsData, type NewsArticle, type NewsFeedKey, type NewsTopic } from './department-news-model';
import { schoolDirectoryForTarget } from './school-directory';

const CACHE_TTL_MS = 60 * 60_000;
const MAX_ARTICLES = 20;
const inflight = new Map<string, Promise<void>>();
const publisherCache = new Map<NewsFeedKey,{expiresAt:number;articles:Omit<NewsArticle,'id'>[]}>();
const publisherInflight = new Map<NewsFeedKey,Promise<Omit<NewsArticle,'id'>[]>>();
type CacheRow = { topic_key: string; article_ids: string[]; status: 'fresh' | 'empty' | 'error'; fetched_at: string | Date | null; checked_at: string | Date; retry_after: string | Date; source_failures: string[] };
type ArticleRow = { id: string; canonical_url: string; title: string; publisher: string; snippet: string; published_at: string | Date; fetched_at: string | Date; feed_key: NewsFeedKey };
const iso = (value: string | Date | null | undefined) => value ? new Date(value).toISOString() : null;
function assertStudent(user: Profile) { if (user.role !== 'student') throw new ApiError(403, '학생 계정에서 이용해 주세요.'); }
function uuid(value: unknown) { return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value); }

/** Select from the authenticated student's registered targets, never a client-supplied major. */
export function newsConnectionForTarget(target:Record<string,any>) {
  const unitName=String(target.major||target.department||'').trim(),school=schoolDirectoryForTarget(target);
  // IDs resolve only inside the owned target's selected school. Legacy targets
  // without catalog IDs can use an unambiguous exact canonical name.
  const byName=school?.departments.filter(row=>row.name===unitName);
  const department=target.department_catalog_id?school?.departments.find(row=>row.id===target.department_catalog_id&&row.name===unitName&&(!target.campus||row.campus===target.campus||school.campusLabel===target.campus)):(byName?.length===1?byName[0]:null);
  const major=department?.programs?.includes(target.interest_department)?String(target.interest_department):unitName;
  return {major,...majorNewsConnection(major,department?{category:department.category,field:department.field}:{})};
}
export async function departmentNewsSelection(studentId: string, requestedTarget?: string | null) {
  const [targets, preferences] = await Promise.all([
    query("select id,data from support_targets where student_id=$1 and nullif(data->>'archived_at','') is null order by created_at,id", [studentId]),
    query('select data from student_preferences where student_id=$1', [studentId]),
  ]);
  if (requestedTarget && !targets.some(row => row.id === requestedTarget)) throw new ApiError(404, '지원 학교를 찾을 수 없어요.');
  const target = targets.find(row => row.id === (requestedTarget || preferences[0]?.data?.selectedTargetId)) || targets[0];
  return { targetId: target?.id || null, ...newsConnectionForTarget(target?.data||{}) };
}
async function publisherArticles(key:NewsFeedKey,now:Date,fetcher:typeof fetch,shared:boolean) {
  if(!shared)return parsePublisherFeed(await boundedFeed(key,fetcher),key,now);
  const cached=publisherCache.get(key);
  if(cached&&cached.expiresAt>Date.now())return cached.articles.filter(article=>now.getTime()-new Date(article.publishedAt).getTime()<=30*86_400_000);
  const old=publisherInflight.get(key);if(old)return old;
  const promise=(async()=>{const articles=parsePublisherFeed(await boundedFeed(key,fetcher),key,now);publisherCache.set(key,{articles,expiresAt:Date.now()+5*60_000});return articles;})();
  publisherInflight.set(key,promise);
  try{return await promise;}finally{if(publisherInflight.get(key)===promise)publisherInflight.delete(key);}
}
/** Read-only coverage audit; each fixed publisher is requested once for all topics. */
export async function collectPublisherNews(options:{now?:Date;fetcher?:typeof fetch}={}) {
  const now=options.now||new Date(),fetcher=options.fetcher||fetch,keys=Object.keys(NEWS_FEEDS) as NewsFeedKey[];
  const results=await Promise.allSettled(keys.map(async key=>({key,articles:await publisherArticles(key,now,fetcher,!options.fetcher)})));
  return results.map((result,index)=>result.status==='fulfilled'?{...result.value,status:'ok' as const}:{key:keys[index],articles:[],status:'failed' as const});
}

async function boundedFeed(key: NewsFeedKey, fetcher: typeof fetch) {
  const response = await fetcher(NEWS_FEEDS[key].url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/rss+xml, application/xml, text/xml', 'User-Agent': 'GakjaON-NewsReader/1.0' } });
  if (!response.ok || !/(?:xml|rss)/i.test(response.headers.get('content-type') || '') || Number(response.headers.get('content-length') || 0) > 2_000_000 || !response.body) throw new Error('뉴스 피드를 읽을 수 없음');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read(); if (result.done) break;
      length += result.value.byteLength;
      if (length > 2_000_000) { await reader.cancel(); throw new Error('뉴스 피드 크기 초과'); }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Injectable fetch is for deterministic tests only; URLs always come from NEWS_FEEDS. */
export async function collectDepartmentNews(topic: NewsTopic, options: { now?: Date; fetcher?: typeof fetch } = {}) {
  const now = options.now || new Date(), fetcher = options.fetcher || fetch;
  const keys = topic.feeds.slice(0, 3).filter(key => Object.hasOwn(NEWS_FEEDS, key));
  const results = await Promise.allSettled(keys.map(async key => filterNewsTopic(await publisherArticles(key,now,fetcher,!options.fetcher),topic)));
  const failedSources: string[] = [], articles: Omit<NewsArticle, 'id'>[] = [];
  results.forEach((result, index) => { if (result.status === 'fulfilled') articles.push(...result.value); else failedSources.push(keys[index]); });
  const urls = new Set<string>(), headlines = new Set<string>();
  const deduped = articles.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).filter(article => {
    const title = article.title.replace(/[\s\p{P}]/gu, '').toLocaleLowerCase('ko-KR');
    if (urls.has(article.url) || headlines.has(title)) return false;
    urls.add(article.url); headlines.add(title); return true;
  }).slice(0, MAX_ARTICLES);
  return { articles: deduped, failedSources, successfulSources: keys.length - failedSources.length };
}
/** Claim in PostgreSQL before fetching: independent web workers share one lease. */
export async function refreshDepartmentNews(topic: NewsTopic, options: { force?: boolean } = {}) {
  const key = `${NEWS_TOPIC_REVISION}:${topic.key}`;
  if (inflight.has(key)) return inflight.get(key)!;
  const promise = (async () => {
    // Millisecond precision survives pg's Date conversion when comparing the
    // returned token. PostgreSQL's default microseconds would not round-trip.
    const [claim] = await query<{ retry_after: string | Date }>("insert into department_news_cache(topic_key,status,retry_after) values($1,'error',date_trunc('milliseconds',now())+interval '5 minutes') on conflict(topic_key) do update set retry_after=excluded.retry_after where department_news_cache.retry_after<=now() and ($2::boolean or department_news_cache.status='error' or department_news_cache.fetched_at is null or department_news_cache.fetched_at<=now()-interval '1 hour') returning retry_after", [key, options.force === true]);
    if (!claim) return;
    try {
      const result = await collectDepartmentNews(topic);
      await transaction(async client => {
        // The lease is also a fencing token: a delayed worker cannot replace a
        // newer snapshot after its claim expired and another worker took over.
        const owned = await client.query('select topic_key from department_news_cache where topic_key=$1 and retry_after=$2 for update', [key, claim.retry_after]);
        if (!owned.rows.length) return;
        if (!result.successfulSources || !result.articles.length && result.failedSources.length) {
          await client.query("update department_news_cache set status='error',checked_at=now(),retry_after=now()+interval '5 minutes',source_failures=$3 where topic_key=$1 and retry_after=$2", [key, claim.retry_after, JSON.stringify(result.failedSources)]);
          return;
        }
        const ids: string[] = [];
        for (const article of result.articles) {
          const row = (await client.query("insert into department_news_articles(canonical_url,title,publisher,snippet,published_at,feed_key) values($1,$2,$3,$4,$5,$6) on conflict(canonical_url) do update set title=excluded.title,publisher=excluded.publisher,snippet=excluded.snippet,published_at=excluded.published_at,feed_key=excluded.feed_key,fetched_at=now() returning id", [article.url, article.title, article.publisher, article.snippet, article.publishedAt, article.feedKey])).rows[0];
          ids.push(row.id);
        }
        await client.query("update department_news_cache set article_ids=$3,status=$4,fetched_at=now(),checked_at=now(),retry_after=now()+interval '1 minute',source_failures=$5 where topic_key=$1 and retry_after=$2", [key, claim.retry_after, ids, ids.length ? 'fresh' : 'empty', JSON.stringify(result.failedSources)]);
      });
    } catch (error) {
      // Preserve the last successful article IDs and fetched_at on any failure.
      await query("update department_news_cache set status='error',checked_at=now(),retry_after=now()+interval '5 minutes',source_failures=$3 where topic_key=$1 and retry_after=$2", [key, claim.retry_after, JSON.stringify(topic.feeds)]);
      throw error;
    }
  })();
  inflight.set(key, promise);
  try { await promise; } finally { if (inflight.get(key) === promise) inflight.delete(key); }
}
function viewArticle(row: ArticleRow, topic: NewsTopic): NewsArticle {
  return { id: row.id, title: row.title, url: row.canonical_url, publisher: row.publisher, snippet: row.snippet, publishedAt: iso(row.published_at)!, fetchedAt: iso(row.fetched_at)!, feedKey: row.feed_key, keywords: matchingNewsKeywords(row.title,topic) };
}
export async function getDepartmentNews(user: Profile, input: { targetId?: string | null; refresh?: boolean; articleId?: string | null } = {}): Promise<DepartmentNewsData & { refreshDue: boolean; refreshPending: boolean }> {
  assertStudent(user);
  const selection = await departmentNewsSelection(user.id, input.targetId), { topic, major, targetId, connection } = selection;
  if (!topic) return { ...selection, status: 'setup_required', fetchedAt: null, checkedAt: null, articles: [], message: '학교와 학과를 선택하면 관련 뉴스를 볼 수 있어요.', sources: [], refreshDue: false, refreshPending: false };
  const key = `${NEWS_TOPIC_REVISION}:${topic.key}`;
  let [cache] = await query<CacheRow>('select * from department_news_cache where topic_key=$1', [key]);
  const expired = !cache || cache.status === 'error' || Date.now() - new Date(cache.fetched_at || 0).getTime() >= CACHE_TTL_MS;
  const due = expired || input.refresh === true;
  const refreshDue = due && (!cache || new Date(cache.retry_after).getTime() <= Date.now());
  // Reads and reflection saves never wait for a publisher. The route schedules
  // eligible refreshes with after(), once the private snapshot has been sent.
  const refreshPending = refreshDue || Boolean(cache && expired && new Date(cache.retry_after).getTime() > Date.now() && (cache.status !== 'error' || !cache.fetched_at && !cache.source_failures.length));
  // A taxonomy rollout must not hide the last known semantic-topic cache when
  // publishers are temporarily offline. It remains explicitly stale and each
  // headline is rechecked against the current topic before display.
  if((!cache || cache.status==='error')&&!cache?.article_ids?.length){
    const [previous]=await query<CacheRow>('select * from department_news_cache where topic_key=$1',['v1:'+topic.key]);
    if(previous?.article_ids?.length)cache={...previous,...cache,status:'error',article_ids:previous.article_ids,fetched_at:previous.fetched_at};
  }
  let rows = cache?.article_ids?.length ? await query<ArticleRow>('select * from department_news_articles where id=any($1::uuid[]) and published_at>=now()-interval \'30 days\' and published_at<=now() order by published_at desc limit 20', [cache.article_ids]) : [];
  rows=rows.filter(row=>topic.feeds.includes(row.feed_key)&&matchingNewsKeywords(row.title,topic).length);
  // Saved reflections remain reachable after the article drops out of a publisher's finite RSS window.
  if (input.articleId) {
    if (!uuid(input.articleId)) throw new ApiError(404, '기사를 찾을 수 없어요.');
    if (!rows.some(row => row.id === input.articleId)) {
      const old = await query<ArticleRow>('select a.* from department_news_articles a join department_news_thoughts t on t.article_id=a.id where a.id=$1 and t.student_id=$2', [input.articleId, user.id]);
      rows = [...rows, ...old];
    }
  }
  const [thoughts, practices] = await Promise.all([
    query('select article_id,content,revision,updated_at from department_news_thoughts where student_id=$1 and article_id=any($2::uuid[])', [user.id, rows.map(row => row.id)]),
    query('select article_id,briefing_id from department_news_practice where student_id=$1 and target_id=$2 and major=$3 and article_id=any($4::uuid[])', [user.id, targetId || '', major, rows.map(row => row.id)]),
  ]);
  const articles = rows.map(row => ({ ...viewArticle(row, topic), thought: (() => { const thought = thoughts.find(item => item.article_id === row.id); return thought ? { content: thought.content, revision: thought.revision, updatedAt: iso(thought.updated_at)! } : null; })(), practiceBriefingId: practices.find(item => item.article_id === row.id)?.briefing_id || null }));
  const latest = articles.filter(row => new Date(row.publishedAt).getTime() >= Date.now() - 30 * 86_400_000);
  const stale = cache?.status === 'error' || !cache?.fetched_at || Date.now() - new Date(cache.fetched_at).getTime() >= CACHE_TTL_MS;
  const status = !latest.length ? stale ? 'unavailable' : 'empty' : stale ? 'stale' : 'fresh';
  return { major, targetId, topic, connection, status, fetchedAt: iso(cache?.fetched_at), checkedAt: iso(cache?.checked_at), articles, refreshDue, refreshPending, message: status === 'stale' ? '마지막으로 확인한 기사를 보여드려요.' : status === 'unavailable' ? refreshPending ? '새 기사를 준비하고 있어요. 잠시 후 다시 확인해 주세요.' : '뉴스를 불러오지 못했어요. 잠시 후 다시 확인해 주세요.' : status === 'empty' ? '최근 30일 이내에 선택한 분야와 연결되는 새 기사가 없어요.' : cache?.source_failures?.length ? '일부 뉴스 출처의 갱신이 지연되고 있어요.' : null, sources: topic.feeds.map(feed => ({ name: NEWS_FEEDS[feed].name, url: NEWS_FEEDS[feed].url })) };
}
export async function newsThoughtHistory(user: Profile, articleId: string) {
  assertStudent(user); if (!uuid(articleId)) throw new ApiError(404, '기사를 찾을 수 없어요.');
  return query('select r.content,r.revision,r.created_at from department_news_thought_revisions r join department_news_thoughts t on t.id=r.thought_id where t.student_id=$1 and t.article_id=$2 order by r.revision desc limit 30', [user.id, articleId]);
}
async function ownedNewsArticle(user: Profile, articleId: string, targetId?: string | null) {
  const result = await getDepartmentNews(user, { articleId, targetId });
  const article = result.articles.find(item => item.id === articleId);
  if (!article || !result.targetId || !result.topic || !article.keywords.length) throw new ApiError(404, '선택한 학과에 연결된 기사를 찾을 수 없어요.');
  return { result, article };
}
export async function mutateDepartmentNews(user: Profile, input: Record<string, unknown>) {
  assertStudent(user);
  if (!uuid(input.articleId)) throw new ApiError(400, '기사를 선택해 주세요.');
  if (input.targetId != null && (typeof input.targetId !== 'string' || input.targetId.length > 160)) throw new ApiError(400, '지원 학교를 확인해 주세요.');
  if (!['thought', 'practice'].includes(String(input.action))) throw new ApiError(400, '작업을 확인해 주세요.');
  if (input.action === 'thought' && (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 4000 || !Number.isInteger(input.expectedRevision) || Number(input.expectedRevision) < 0)) throw new ApiError(400, '생각은 1~4,000자까지 저장할 수 있어요.');
  const { result, article } = await ownedNewsArticle(user, input.articleId as string, input.targetId as string | null | undefined);
  return transaction(async client => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`news-thought:${user.id}:${article.id}`]);
    const old = (await client.query('select * from department_news_thoughts where student_id=$1 and article_id=$2 for update', [user.id, article.id])).rows[0];
    if (input.action === 'thought') {
      const content = (input.content as string).trim();
      if (old?.content === content) return { thought: { content: old.content, revision: old.revision, updatedAt: iso(old.updated_at) }, unchanged: true };
      if ((old?.revision || 0) !== input.expectedRevision) throw new ApiError(409, '다른 화면에서 생각을 수정했어요. 다시 불러온 뒤 저장해 주세요.');
      const revision = (old?.revision || 0) + 1;
      const thought = (await client.query('insert into department_news_thoughts(student_id,article_id,content,revision) values($1,$2,$3,$4) on conflict(student_id,article_id) do update set content=excluded.content,revision=excluded.revision,updated_at=now() returning *', [user.id, article.id, content, revision])).rows[0];
      await client.query('insert into department_news_thought_revisions(thought_id,student_id,content,revision) values($1,$2,$3,$4)', [thought.id, user.id, content, revision]);
      return { thought: { content, revision, updatedAt: iso(thought.updated_at) }, unchanged: false };
    }
    if (!old?.content?.trim()) throw new ApiError(409, '기사에 대한 내 생각을 먼저 저장해 주세요.');
    const previous = (await client.query('select briefing_id from department_news_practice where student_id=$1 and article_id=$2 and target_id=$3 and major=$4', [user.id, article.id, result.targetId, result.major])).rows[0];
    const data = { source_kind: 'rss_news', owner_student_id: user.id, target_id: result.targetId, article_id: article.id, major: result.major, published_date: article.publishedAt, checked_at: article.fetchedAt, source_url: article.url, source_name: article.publisher, summary: article.snippet, concepts: article.keywords, sources: [{ title: article.publisher, url: article.url, published_date: article.publishedAt }], questions: [newsPracticeQuestion(article, result.major)], discussion_question: newsPracticeQuestion(article, result.major), thought_snapshot: { content: old.content, revision: old.revision, updated_at: iso(old.updated_at) }, practice_basis: 'headline_and_student_reflection' };
    // A session later snapshots this briefing. Updating here cannot rewrite previous interview records.
    const briefingId = previous?.briefing_id || (await client.query("insert into briefings(title,category,data,status,created_by) values($1,$2,$3,'published',$4) returning id", [article.title, result.major, JSON.stringify(data), user.id])).rows[0].id;
    if (previous) await client.query("update briefings set data=$1,title=$2 where id=$3 and created_by=$4 and data->>'owner_student_id'=$4::text", [JSON.stringify(data), article.title, briefingId, user.id]);
    else await client.query('insert into department_news_practice(student_id,article_id,target_id,major,briefing_id) values($1,$2,$3,$4,$5)', [user.id, article.id, result.targetId, result.major, briefingId]);
    return { briefingId, articleId: article.id, question: data.questions[0], href: `/interview/new?briefingId=${briefingId}&briefingQuestionIndex=0&targetId=${encodeURIComponent(result.targetId!)}`, assistantHref: `/on?briefingId=${briefingId}&targetId=${encodeURIComponent(result.targetId!)}` };
  });
}
