'use client';
import {setDeviceItem} from '@/lib/client/device-storage';
import {ownedClassName} from './owned-class-name';

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
  if (variant === 'compact') return <section className={ownedClassName(`${styles.news} ${styles.compact}`,true)} aria-labelledby={showHeading ? 'department-news-heading' : undefined} aria-label={!showHeading ? '시사 브리핑' : undefined}>
    {showHeading && <div className={ownedClassName(styles.heading,true)}><h2 id="department-news-heading" className={ownedClassName(undefined,true)}>시사 브리핑</h2><Link href="/materials/briefings" className={ownedClassName("text-link")}>모두 보기<ArrowUpRight size={15}/></Link></div>}
    {error && <p role="alert" className={ownedClassName(styles.notice,true)}>{error}<button onClick={reload} disabled={refreshing} className={ownedClassName(undefined,true)}>다시 불러오기</button></p>}
    {!content ? !error && <p className={ownedClassName(styles.notice,true)} role="status">학과 관련 뉴스를 확인하고 있어요.</p> : <>
      <div className={ownedClassName(styles.compactContext,true)}><span className={ownedClassName(styles.major,true)}>{content.major || '학과 선택'}</span>{content.connection && <span className={ownedClassName(styles.connection,true)}>{connectionLabel(content.connection)}</span>}</div>
      {refreshing && content.status !== 'unavailable' && <p className={ownedClassName(styles.notice,true)} role="status">최근 기사를 확인하고 있어요.</p>}
      {content.message && <p className={ownedClassName(styles.notice,true)} role="status">{content.message}</p>}
      {content.status === 'setup_required' ? <Link href="/schools/new" className={ownedClassName("text-link")}>학교·학과 선택<ArrowUpRight size={15}/></Link> : <div className={ownedClassName(styles.compactList,true)}>{content.articles.slice(0, 3).map(article => <Link className={ownedClassName(styles.compactArticle)} href={articleHref(article.id)} key={article.id}><span className={ownedClassName(undefined,true)}>{article.title}</span><small className={ownedClassName(undefined,true)}>{article.publisher} · {stamp(article.publishedAt)}</small></Link>)}</div>}
    </>}
  </section>;
  return <div className={ownedClassName(`department-news-full ${styles.news}`,true)}>
    <PageTitle title={articleId ? selected?.title || '시사 브리핑' : '시사 브리핑'} aside={!articleId ? <button className={ownedClassName("button ghost",true)} onClick={reload} disabled={refreshing} aria-label="최근 뉴스 새로 확인"><RefreshCw size={16} className={ownedClassName(refreshing ? styles.refreshing : '')}/>{refreshing ? '확인 중' : '새로 확인'}</button> : undefined}/>
    <MaterialNavigation/>
    {error && <Alert>{error}<button className={ownedClassName("text-link",true)} onClick={reload} disabled={refreshing}>다시 불러오기</button></Alert>}
    {refreshing && content && content.status !== 'unavailable' && <p className={ownedClassName(styles.notice,true)} role="status">최근 기사를 확인하고 있어요.</p>}
    {!content ? !error && <Spinner/> : articleId ? selected ? <NewsDetail key={`${data.user.id}:${selected.id}:${content.targetId}`} article={selected} major={content.major} connection={content.connection} targetId={content.targetId} onUpdate={update}/> : <Empty title="현재 학과에 연결된 기사를 찾을 수 없어요" href="/materials/briefings" label="브리핑 목록"/> : <>
      <div className={ownedClassName(styles.meta,true)}><span className={ownedClassName(styles.major,true)}>{content.major || '학과 선택'}</span>{content.connection && <span className={ownedClassName(styles.connection,true)}>{connectionLabel(content.connection)}</span>}{content.fetchedAt && <small className={ownedClassName(undefined,true)}>최근 30일 · {stamp(content.fetchedAt, true)} 확인</small>}</div>
      {content.message && <p className={ownedClassName(`${styles.notice} ${content.status === 'stale' ? styles.stale : ''}`,true)} role="status">{content.message}</p>}
      {content.status === 'setup_required' ? <Empty title="내 학과의 뉴스부터 시작해요" href="/schools/new" label="학교·학과 선택"/> : !content.articles.length ? <Empty title={content.status === 'empty' ? '지금은 새로운 기사가 없어요' : '뉴스 연결을 기다리고 있어요'}/> : <div className={ownedClassName(styles.list,true)}>{content.articles.map(article => <article className={ownedClassName(styles.article,true)} key={article.id}><div className={ownedClassName(styles.articleSource,true)}><span className={ownedClassName(undefined,true)}>{article.publisher}</span><time dateTime={article.publishedAt} className={ownedClassName(undefined,true)}>{stamp(article.publishedAt)}</time>{article.thought && <span className={ownedClassName(styles.saved,true)}><Check size={13}/>내 생각 저장</span>}</div><h2 className={ownedClassName(undefined,true)}><Link href={articleHref(article.id)}>{article.title}<ArrowUpRight size={18}/></Link></h2>{article.snippet && (snippetCounts.get(article.snippet.slice(0, 120)) || 0) === 1 && <p className={ownedClassName(undefined,true)}>{article.snippet}</p>}<div className={ownedClassName(styles.keywords,true)}>{article.keywords.map(word => <span key={word} className={ownedClassName(undefined,true)}>{word}</span>)}</div></article>)}</div>}
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
  function write(value: string) { setThought(value); setDeviceItem(sessionStorage,draftKey, value); }
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
  return <div className={ownedClassName(`department-news-detail ${styles.detail}`,true)}>
    <div className={ownedClassName(styles.articleSource,true)}><span className={ownedClassName(undefined,true)}>{article.publisher}</span><time dateTime={article.publishedAt} className={ownedClassName(undefined,true)}>{stamp(article.publishedAt, true)}</time><span className={ownedClassName(undefined,true)}>{major}</span>{connection && <span className={ownedClassName(undefined,true)}>{connectionLabel(connection)}</span>}</div>
    {older && <p className={ownedClassName(styles.notice,true)}>이전에 생각을 저장한 기사예요. 현재의 최근 뉴스 목록에는 포함되지 않아요.</p>}
    {article.snippet && <p className={ownedClassName(styles.lead,true)}>{article.snippet}</p>}
    <div className={ownedClassName(styles.detailLinks,true)}><a href={article.url} target="_blank" rel="noopener noreferrer" className={ownedClassName("button primary",true)}>기사 원문 읽기<ArrowUpRight size={16}/></a><div className={ownedClassName(styles.keywords,true)}>{article.keywords.map(word => <span key={word} className={ownedClassName(undefined,true)}>{word}</span>)}</div></div>
    <section className={ownedClassName(styles.reflection,true)} aria-labelledby="news-thought-heading"><div className={ownedClassName(styles.heading,true)}><h2 id="news-thought-heading" className={ownedClassName(undefined,true)}>읽고 난 내 생각</h2><span className={ownedClassName(styles.saveStatus,true)} role="status">{busy === 'save' ? '저장 중' : dirty ? '아직 저장하지 않았어요' : revision ? '저장됨' : ''}</span></div><div className={ownedClassName(styles.reflectionBody,true)}><label className={ownedClassName(styles.prompt,true)} htmlFor={`news-thought-${article.id}`}>이 기사에서 중요했던 점과 그 이유는 무엇인가요?</label><textarea id={`news-thought-${article.id}`} rows={5} value={thought} onChange={event => write(event.target.value)} maxLength={4000} disabled={Boolean(busy)} placeholder="확인한 내용과 내 관점을 나누어 적어보세요." className={ownedClassName(undefined,true)}/>{error && <Alert>{error}</Alert>}<div className={ownedClassName(styles.thoughtActions,true)}><button className={ownedClassName("button primary",true)} disabled={Boolean(busy) || !thought.trim() || !dirty} onClick={save}><Save size={16}/>{busy === 'save' ? '저장 중' : '내 생각 저장'}</button><button className={ownedClassName("button ghost",true)} disabled={Boolean(busy) || !revision} onClick={openHistory}><History size={15}/>이전 생각</button></div></div></section>
    <section className={ownedClassName(styles.next,true)} aria-labelledby="news-practice-heading"><h2 id="news-practice-heading" className={ownedClassName(undefined,true)}>이번에는 내 말로</h2><div className={ownedClassName(styles.nextBody,true)}><p className={ownedClassName(undefined,true)}>{savedContent && !dirty ? '같은 기사와 내 생각을 이어서 연습해요.' : '내 생각을 저장하면 면접에서 이어갈 수 있어요.'}</p><div className={ownedClassName(styles.nextActions,true)}><button className={ownedClassName("button primary",true)} disabled={Boolean(busy) || dirty || !savedContent} onClick={() => practice('interview')}>{busy === 'interview' ? '준비 중' : '모의면접에서 답하기'}<ArrowUpRight size={16}/></button><button className={ownedClassName("text-link",true)} disabled={Boolean(busy) || dirty || !savedContent} onClick={() => practice('assistant')}>AI 비서와 정리<ArrowUpRight size={15}/></button></div></div></section>
    <Link href="/materials/briefings" className={ownedClassName("text-link")}>다른 기사 보기<ArrowUpRight size={15}/></Link>
    {history && <Modal title="내 생각의 변화" onClose={() => setHistory(null)}>{history.length ? <div className={ownedClassName(styles.history,true)}>{history.map(item => <article key={item.revision} className={ownedClassName(undefined,true)}><time dateTime={item.created_at} className={ownedClassName(undefined,true)}>{stamp(item.created_at, true)}</time><p className={ownedClassName(undefined,true)}>{item.content}</p></article>)}</div> : <Empty title="저장한 생각이 없어요"/>}</Modal>}
  </div>;
}
