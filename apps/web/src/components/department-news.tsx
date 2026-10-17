'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, Check, History, RefreshCw, Save } from 'lucide-react';
import { useApp } from './app-shell';
import { Alert, Empty, Modal, PageTitle, Spinner, api, post } from './shared';
import type { DepartmentNewsData, NewsArticle, NewsThought } from '@/lib/department-news-model';
import styles from './department-news.module.css';
import { MaterialNavigation } from './material-navigation';
type Article = NewsArticle & { thought: NewsThought | null; practiceBriefingId?: string | null };
type NewsSnapshot = DepartmentNewsData & { refreshDue?: boolean; refreshPending?: boolean };
function waitForNews(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, ms);
    signal.addEventListener('abort', aborted, { once: true });
  });
}
/** Keep the saved snapshot visible; at most three reads follow a queued refresh. */
export async function loadDepartmentNewsSnapshots(endpoint: string, signal: AbortSignal, onSnapshot: (snapshot: NewsSnapshot) => void, force = false) {
  const first = await api<NewsSnapshot>(endpoint + (force ? '&refresh=1' : ''), { signal });
  signal.throwIfAborted(); onSnapshot(first);
  if (!first.refreshPending && !first.refreshDue) return;
  for (const delay of [1500, 2500, 8000]) {
    await waitForNews(delay, signal);
    const next = await api<NewsSnapshot>(endpoint, { signal });
    signal.throwIfAborted(); onSnapshot(next);
    // A forced refresh can start from a fresh snapshot. Keep waiting until its
    // timestamp changes, or a completed failed attempt updates checkedAt.
    if (!next.refreshPending && (next.fetchedAt !== first.fetchedAt || next.checkedAt !== first.checkedAt)) return;
  }
}
function stamp(value: string | null, includeTime = false) {
  if (!value) return '';
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', ...(includeTime ? { hour: 'numeric', minute: '2-digit' } : {}) }).format(new Date(value));
}
function connectionLabel(connection: DepartmentNewsData['connection']) {
  if (!connection) return '';
  return connection.basis === 'related_field' ? `관련 분야 · ${connection.label}` : connection.label;
}
const articleHref = (id: string) => `/materials/briefings/news/${encodeURIComponent(id)}`;

/** Both the dashboard and the full briefings page use the same authenticated feed. */
export function DepartmentNews({ variant = 'full', articleId, showHeading = true }: { variant?: 'full' | 'compact'; articleId?: string; showHeading?: boolean }) {
  const { data, targetId } = useApp();
  const [content, setContent] = useState<NewsSnapshot | null>(null), [error, setError] = useState(''), [refreshing, setRefreshing] = useState(false);
  const current = useRef(0), controller = useRef<AbortController | null>(null);
  const endpoint = `/api/news?${new URLSearchParams({ ...(targetId ? { targetId } : {}), ...(articleId ? { articleId } : {}) })}`;
  useEffect(() => {
    setContent(null); void load(false);
    return () => { ++current.current; controller.current?.abort(); controller.current = null; };
  }, [data.user.id, endpoint]);
  async function load(force: boolean) {
    const request = ++current.current; controller.current?.abort();
    const active = new AbortController(); controller.current = active; setRefreshing(force); setError('');
    let pending = force;
    try { await loadDepartmentNewsSnapshots(endpoint, active.signal, result => { if (request === current.current) { pending ||= Boolean(result.refreshPending || result.refreshDue); setContent(result); setRefreshing(pending); } }, force); }
    catch (error) { if (!active.signal.aborted && request === current.current) setError((error as Error).message); }
    finally { if (request === current.current) setRefreshing(false); }
  }
  async function reload() { await load(true); }
  function update(id: string, thought: NewsThought) { setContent(previous => previous ? { ...previous, articles: previous.articles.map(item => item.id === id ? { ...item, thought } : item) } : previous); }
  const selected = articleId ? content?.articles.find(item => item.id === articleId) : null;
  const snippetCounts = new Map<string, number>();
  for (const article of content?.articles || []) if (article.snippet) { const key = article.snippet.slice(0, 120); snippetCounts.set(key, (snippetCounts.get(key) || 0) + 1); }
  if (variant === 'compact') return <section className={`${styles.news} ${styles.compact}`} aria-labelledby={showHeading ? 'department-news-heading' : undefined} aria-label={!showHeading ? '시사 브리핑' : undefined}>
    {showHeading && <div className={styles.heading}><h2 id="department-news-heading">시사 브리핑</h2><Link href="/materials/briefings" className="text-link">모두 보기<ArrowUpRight size={15}/></Link></div>}
    {error && <p role="alert" className={styles.notice}>{error}<button onClick={reload} disabled={refreshing}>다시 불러오기</button></p>}
    {!content ? !error && <p className={styles.notice} role="status">학과 관련 뉴스를 확인하고 있어요.</p> : <>
      <div className={styles.compactContext}><span className={styles.major}>{content.major || '학과 선택'}</span>{content.connection && <span className={styles.connection}>{connectionLabel(content.connection)}</span>}</div>
      {refreshing && content.status !== 'unavailable' && <p className={styles.notice} role="status">최근 기사를 확인하고 있어요.</p>}
      {content.message && <p className={styles.notice} role="status">{content.message}</p>}
      {content.status === 'setup_required' ? <Link href="/schools/new" className="text-link">학교·학과 선택<ArrowUpRight size={15}/></Link> : <div className={styles.compactList}>{content.articles.slice(0, 3).map(article => <Link className={styles.compactArticle} href={articleHref(article.id)} key={article.id}><span>{article.title}</span><small>{article.publisher} · {stamp(article.publishedAt)}</small></Link>)}</div>}
    </>}
  </section>;
  return <div className={`department-news-full ${styles.news}`}>
    <PageTitle title={articleId ? selected?.title || '시사 브리핑' : '시사 브리핑'} aside={!articleId ? <button className="button ghost" onClick={reload} disabled={refreshing} aria-label="최근 뉴스 새로 확인"><RefreshCw size={16} className={refreshing ? styles.refreshing : ''}/>{refreshing ? '확인 중' : '새로 확인'}</button> : undefined}/>
    <MaterialNavigation/>
    {error && <Alert>{error}<button className="text-link" onClick={reload} disabled={refreshing}>다시 불러오기</button></Alert>}
    {refreshing && content && content.status !== 'unavailable' && <p className={styles.notice} role="status">최근 기사를 확인하고 있어요.</p>}
    {!content ? !error && <Spinner/> : articleId ? selected ? <NewsDetail key={`${data.user.id}:${selected.id}:${content.targetId}`} article={selected} major={content.major} connection={content.connection} targetId={content.targetId} onUpdate={update}/> : <Empty title="현재 학과에 연결된 기사를 찾을 수 없어요" href="/materials/briefings" label="브리핑 목록"/> : <>
      <div className={styles.meta}><span className={styles.major}>{content.major || '학과 선택'}</span>{content.connection && <span className={styles.connection}>{connectionLabel(content.connection)}</span>}{content.fetchedAt && <small>최근 30일 · {stamp(content.fetchedAt, true)} 확인</small>}</div>
      {content.message && <p className={`${styles.notice} ${content.status === 'stale' ? styles.stale : ''}`} role="status">{content.message}</p>}
      {content.status === 'setup_required' ? <Empty title="내 학과의 뉴스부터 시작해요" href="/schools/new" label="학교·학과 선택"/> : !content.articles.length ? <Empty title={content.status === 'empty' ? '지금은 새로운 기사가 없어요' : '뉴스 연결을 기다리고 있어요'}/> : <div className={styles.list}>{content.articles.map(article => <article className={styles.article} key={article.id}><div className={styles.articleSource}><span>{article.publisher}</span><time dateTime={article.publishedAt}>{stamp(article.publishedAt)}</time>{article.thought && <span className={styles.saved}><Check size={13}/>내 생각 저장</span>}</div><h2><Link href={articleHref(article.id)}>{article.title}<ArrowUpRight size={18}/></Link></h2>{article.snippet && (snippetCounts.get(article.snippet.slice(0, 120)) || 0) === 1 && <p>{article.snippet}</p>}<div className={styles.keywords}>{article.keywords.map(word => <span key={word}>{word}</span>)}</div></article>)}</div>}
    </>}
  </div>;
}

function NewsDetail({ article, major, connection, targetId, onUpdate }: { article: Article; major: string; connection: DepartmentNewsData['connection']; targetId: string | null; onUpdate: (id: string, thought: NewsThought) => void }) {
  const { data, toast } = useApp(), router = useRouter();
  const draftKey = `gakja-news-thought:${data.user.id}:${article.id}`;
  const [thought, setThought] = useState(article.thought?.content || ''), [revision, setRevision] = useState(article.thought?.revision || 0), [savedContent, setSavedContent] = useState(article.thought?.content || '');
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [history, setHistory] = useState<{ content: string; revision: number; created_at: string }[] | null>(null), lock = useRef(false);
  useEffect(() => { const draft = sessionStorage.getItem(draftKey); if (draft !== null) setThought(draft); }, [draftKey]);
  const dirty = thought.trim() !== savedContent, older = Date.now() - new Date(article.publishedAt).getTime() > 30 * 86_400_000;
  function write(value: string) { setThought(value); sessionStorage.setItem(draftKey, value); }
  async function save() {
    if (lock.current || !thought.trim()) return; lock.current = true; setBusy('save'); setError('');
    try {
      const result = await post('/api/news', { action: 'thought', articleId: article.id, targetId, content: thought.trim(), expectedRevision: revision });
      setRevision(result.thought.revision); setSavedContent(result.thought.content); setThought(result.thought.content); onUpdate(article.id, result.thought); sessionStorage.removeItem(draftKey); toast('내 생각을 저장했어요.');
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(''); lock.current = false; }
  }
  async function practice(kind: 'interview' | 'assistant') {
    if (lock.current || dirty || !savedContent) return; lock.current = true; setBusy(kind); setError('');
    try { const result = await post('/api/news', { action: 'practice', articleId: article.id, targetId }); router.push(kind === 'interview' ? result.href : result.assistantHref); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(''); lock.current = false; }
  }
  async function openHistory() {
    setError('');
    try { const result = await api<{ history: { content: string; revision: number; created_at: string }[] }>(`/api/news?history=1&articleId=${article.id}`); setHistory(result.history); }
    catch (error) { setError((error as Error).message); }
  }
  return <div className={`department-news-detail ${styles.detail}`}>
    <div className={styles.articleSource}><span>{article.publisher}</span><time dateTime={article.publishedAt}>{stamp(article.publishedAt, true)}</time><span>{major}</span>{connection && <span>{connectionLabel(connection)}</span>}</div>
    {older && <p className={styles.notice}>이전에 생각을 저장한 기사예요. 현재의 최근 뉴스 목록에는 포함되지 않아요.</p>}
    {article.snippet && <p className={styles.lead}>{article.snippet}</p>}
    <div className={styles.detailLinks}><a href={article.url} target="_blank" rel="noopener noreferrer" className="button primary">기사 원문 읽기<ArrowUpRight size={16}/></a><div className={styles.keywords}>{article.keywords.map(word => <span key={word}>{word}</span>)}</div></div>
    <section className={styles.reflection} aria-labelledby="news-thought-heading"><div className={styles.heading}><h2 id="news-thought-heading">읽고 난 내 생각</h2><span className={styles.saveStatus} role="status">{busy === 'save' ? '저장 중' : dirty ? '아직 저장하지 않았어요' : revision ? '저장됨' : ''}</span></div><div className={styles.reflectionBody}><label className={styles.prompt} htmlFor={`news-thought-${article.id}`}>이 기사에서 중요했던 점과 그 이유는 무엇인가요?</label><textarea id={`news-thought-${article.id}`} rows={5} value={thought} onChange={event => write(event.target.value)} maxLength={4000} disabled={Boolean(busy)} placeholder="확인한 내용과 내 관점을 나누어 적어보세요."/>{error && <Alert>{error}</Alert>}<div className={styles.thoughtActions}><button className="button primary" disabled={Boolean(busy) || !thought.trim() || !dirty} onClick={save}><Save size={16}/>{busy === 'save' ? '저장 중' : '내 생각 저장'}</button><button className="button ghost" disabled={Boolean(busy) || !revision} onClick={openHistory}><History size={15}/>이전 생각</button></div></div></section>
    <section className={styles.next} aria-labelledby="news-practice-heading"><h2 id="news-practice-heading">이번에는 내 말로</h2><div className={styles.nextBody}><p>{savedContent && !dirty ? '같은 기사와 내 생각을 이어서 연습해요.' : '내 생각을 저장하면 면접에서 이어갈 수 있어요.'}</p><div className={styles.nextActions}><button className="button primary" disabled={Boolean(busy) || dirty || !savedContent} onClick={() => practice('interview')}>{busy === 'interview' ? '준비 중' : '모의면접에서 답하기'}<ArrowUpRight size={16}/></button><button className="text-link" disabled={Boolean(busy) || dirty || !savedContent} onClick={() => practice('assistant')}>AI 비서와 정리<ArrowUpRight size={15}/></button></div></div></section>
    <Link href="/materials/briefings" className="text-link">다른 기사 보기<ArrowUpRight size={15}/></Link>
    {history && <Modal title="내 생각의 변화" onClose={() => setHistory(null)}>{history.length ? <div className={styles.history}>{history.map(item => <article key={item.revision}><time dateTime={item.created_at}>{stamp(item.created_at, true)}</time><p>{item.content}</p></article>)}</div> : <Empty title="저장한 생각이 없어요"/>}</Modal>}
  </div>;
}
