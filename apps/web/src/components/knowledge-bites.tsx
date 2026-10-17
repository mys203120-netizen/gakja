'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowUpRight, BookOpen, Bookmark, Check, ChevronRight, ExternalLink, History, Play, Search, Timer } from 'lucide-react';
import { useApp } from './app-shell';
import { Alert, Breadcrumb, Empty, Modal, PageTitle, Spinner, api, post, type Item } from './shared';
import { KNOWLEDGE_FOCUS, type KnowledgeContext, type KnowledgeFocus, type KnowledgeMatch, type KnowledgeSearch, type KnowledgeActivity, type KnowledgeProgress, type KnowledgeQuestion } from '@/lib/knowledge-bites-catalog';
import { knowledgeCheckPrompt, knowledgeTargetKey } from '@/lib/knowledge-flow-model';
import { LearningHelp } from './learning-help';
import styles from './learning-surfaces.module.css';
type KnowledgeData = { videos: KnowledgeMatch[]; readings:KnowledgeMatch[];selectedTarget:{id:string;university:string;department:string;departmentField:string|null;departmentCategory:string|null}|null; searches: KnowledgeSearch[]; activities: KnowledgeActivity[]; contextQuestion: KnowledgeQuestion | null; history: Item[]; stats: { available: number; saved: number; completed: number }; contentVersion: number | null };
function contextQuery(questionId?: string | null, flow?: string | null, sessionId?: string | null,targetId?:string|null) { const params = new URLSearchParams(); if (questionId) params.set('questionId', questionId);if(targetId)params.set('targetId',targetId); if (flow === 'today') params.set('flow', 'today'); if (sessionId && /^[a-f0-9-]{36}$/i.test(sessionId)) params.set('sessionId', sessionId); return params.size ? `?${params}` : ''; }
function duration(value?: number) { return value ? `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}` : ''; }
function stamp(value?: string) { return value ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : ''; }
function recordContexts(video: KnowledgeMatch): KnowledgeContext[] { return video.contexts?.length ? video.contexts : video.activities.map(activity => ({ ...activity, kind: 'activity' as const, sourceRefIds: [] })); }
function contextTitle(context: KnowledgeContext) { const prefix = { activity: '', goal: '진로 목표', plan: '학업 계획', career: '진로 흐름', record: '',major:'지원 학과',school:'학교',question:'연습 질문' }[context.kind]; return prefix ? `${prefix} · ${context.title}` : context.title; }
function sameSavedContext(video:KnowledgeMatch) {return !video.current || knowledgeTargetKey(video.progress?.snapshot?.targetSnapshot as Record<string,unknown>|null)===knowledgeTargetKey(video.targetSnapshot);}
function visibleLearning(video:KnowledgeMatch) { const learning=sameSavedContext(video) ? video.progress?.snapshot?.learning : undefined;return video.current&&learning?.sourceKind==='common'&&!video.relatedQuestions?.some(question=>question.id===learning.questionId&&question.commonRevision===learning.commonRevision)?undefined:learning; }
function ContextLink({context}:{context:KnowledgeContext}) { const {openResource,data}=useApp();return context.kind==='school'||context.kind==='major' ? context.url?<a className="knowledge-context-link" href={context.url} target="_blank" rel="noopener noreferrer">{contextTitle(context)}<ExternalLink size={14}/></a>:<span className="knowledge-context-label">{contextTitle(context)}</span> : context.kind==='question'?<span className="knowledge-context-label">{contextTitle(context)}</span>:<button disabled={context.kind==='activity'?!data.learning.activities.some((item:Item)=>item.id===context.id):!data.learning.source_refs?.some((item:Item)=>item.id===context.sourceRefIds[0])} onClick={()=>openResource(context.kind==='activity'?{kind:'activity',id:context.id}:{kind:'source',id:context.sourceRefIds[0]})}>{contextTitle(context)}<ChevronRight size={14}/></button>; }
export function KnowledgeBites({ slug = [] }: { slug?: string[] }) {
  return <Suspense fallback={<Spinner />}><KnowledgePage slug={slug} /></Suspense>;
}
function KnowledgePage({ slug }: { slug: string[] }) {
  const { data,targetId:activeTargetId } = useApp();
  const params = useSearchParams(), questionId = params.get('questionId'), flow = params.get('flow'), sessionId = params.get('sessionId');
  const targetId=params.get('targetId') || activeTargetId;
  const endpoint = `/api/knowledge-bites${contextQuery(questionId,null,null,targetId)}`;
  const [content, setContent] = useState<KnowledgeData | null>(null);
  const [error, setError] = useState('');
  const load = async () => { try { setContent(await api<KnowledgeData>(endpoint)); setError(''); } catch (error) { setError((error as Error).message); } };
  useEffect(() => { let alive = true; setContent(null); api<KnowledgeData>(endpoint).then(result => { if (alive) { setContent(result); setError(''); } }).catch(error => { if (alive) setError(error.message); }); return () => { alive = false; }; }, [data.user.id, data.package?.active_version, endpoint]);
  const selected = slug[0] ? content?.videos.find(item => item.id === slug[0]) : null;
  function update(videoId: string, progress: KnowledgeProgress) { setContent(previous => previous ? { ...previous, videos: previous.videos.map(item => item.id === videoId ? { ...item, progress } : item) } : previous); }
  return <section className="knowledge-page">
    <Breadcrumb items={[{ label: '지식한입', href: slug[0] ? `/knowledge${contextQuery(questionId, flow, sessionId,targetId)}` : undefined }, ...(slug[0] ? [{ label: selected?.label || '학습 자료' }] : [])]} />
    {error && <Alert>{error}<button className="text-link" onClick={load}>다시 불러오기</button></Alert>}
    {!content ? !error && <Spinner /> : slug[0] ? selected ? <KnowledgeDetail key={`${data.user.id}:${selected.id}:${questionId || ''}:${targetId || ''}`} video={selected} onUpdate={update} contextQuestion={content.contextQuestion} flow={flow} /> : <Empty title="연결된 자료가 없어요" href={`/knowledge${contextQuery(questionId, flow,null,targetId)}`} label="자료 목록" /> : <KnowledgeList key={content.selectedTarget?.id || 'record'} content={content} />}
  </section>;
}
function KnowledgeList({ content }: { content: KnowledgeData }) {
  const { openResource } = useApp();
  const query = useSearchParams();
  const questionId = content.contextQuestion?.id, flow = query.get('flow');
  const href = (id: string) => `/knowledge/${id}${contextQuery(questionId, flow, query.get('sessionId'),content.selectedTarget?.id)}`;
  const requestedActivity = query.get('activity') || query.get('activityId');
  const [filter, setFilter] = useState('all');
  const [activity, setActivity] = useState('all');
  const [focus, setFocus] = useState<KnowledgeFocus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [origin,setOrigin]=useState('all');
  const [viewedOnly,setViewedOnly]=useState(false);
  useEffect(() => { setActivity(requestedActivity && content.activities.some(item => item.id === requestedActivity) ? requestedActivity : 'all'); }, [requestedActivity, content.activities]);
  const term = search.trim().toLowerCase();
  const availableFocus = Object.entries(KNOWLEDGE_FOCUS).filter(([key]) => content.videos.some(item => item.focus === key));
  const matches = content.videos.filter(item => (filter === 'saved' ? item.progress?.saved : viewedOnly ? item.progress?.completed_at : item.current) && (!viewedOnly||item.progress?.completed_at) && (origin==='all'||item.originLabels?.includes(origin)) && (focus === 'all' || item.focus === focus) && (activity === 'all' || item.activities.some(related => related.id === activity)) && (!term || [item.label, item.title, item.topic, item.stretch, ...recordContexts(item).map(related => related.title)].join(' ').toLowerCase().includes(term)));
  const activeConditions=[origin!=='all',focus!=='all',activity!=='all',Boolean(term),viewedOnly].filter(Boolean).length;
  // Keep published order within each rank; a question connection comes before a general school link.
  const ranked=matches.map((item,index)=>({item,index,rank:questionId&&(item.relatedQuestions?.some(question=>question.id===questionId)||recordContexts(item).some(context=>context.kind==='question'&&context.id===questionId))?0:1})).sort((a,b)=>a.rank-b.rank||a.index-b.index).map(value=>value.item);
  const savedCount = content.videos.filter(item => item.progress?.saved).length;
  const searches = content.searches.filter(item => (activity === 'all' || item.activityId === activity) && (!term || `${item.activityTitle} ${item.topic}`.toLowerCase().includes(term)));
  return <div className={styles.knowledge}>
    <PageTitle title="지식한입" aside={<span className="knowledge-count">{content.videos.filter(video=>video.current).length}<span>개 자료</span></span>} />
    {content.selectedTarget && <p className="knowledge-target-name">{content.selectedTarget.university} <span>·</span> {content.selectedTarget.department}</p>}
    {content.contextQuestion && <div className="knowledge-flow-context"><span>이 질문 이어서</span><strong>{content.contextQuestion.prompt}</strong><Link className="text-link" href={`/quiz${contextQuery(questionId, flow,null,content.selectedTarget?.id)}`}>퀴즈로 돌아가기<ArrowUpRight size={15}/></Link></div>}
    <div className={styles.knowledgeToolbar}>
      <nav className="knowledge-tabs" aria-label="자료 보기"><button className={filter === 'all' ? 'active' : ''} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>추천</button><button className={filter === 'saved' ? 'active' : ''} aria-pressed={filter === 'saved'} onClick={() => setFilter('saved')}>저장 {savedCount > 0 && <span>{savedCount}</span>}</button></nav>
      <label className={'knowledge-search '+styles.knowledgeSearch}><Search size={17} /><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="자료·활동 검색" aria-label="자료·활동 검색" /></label>
    </div>
    <div className={styles.knowledgeFilters} role="group" aria-label="자료 찾기">
      <label className={styles.knowledgeFilter}><span className="sr-only">학습 연결</span><select aria-label="학습 연결" value={origin} onChange={event=>setOrigin(event.target.value)}><option value="all">전체 연결</option>{['내 기록','학과 연결','학교 연결'].filter(label=>content.videos.some(item=>item.originLabels?.includes(label))).map(label=><option key={label} value={label}>{label}</option>)}</select></label>
      <label className={styles.knowledgeFilter}><span className="sr-only">연결 활동</span><select aria-label="연결 활동" value={activity} onChange={event => setActivity(event.target.value)}><option value="all">전체 활동</option>{content.activities.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      {availableFocus.length > 1 && <label className={styles.knowledgeFilter}><span className="sr-only">주제 분야</span><select aria-label="주제 분야" value={focus} onChange={event => setFocus(event.target.value as KnowledgeFocus | 'all')}><option value="all">전체 주제</option>{availableFocus.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>}
      <label className={styles.viewedFilter}><input type="checkbox" checked={viewedOnly} onChange={event=>setViewedOnly(event.target.checked)}/>본 자료만</label>
      {activeConditions>0&&<button className="text-link" onClick={()=>{setActivity('all');setFocus('all');setSearch('');setOrigin('all');setViewedOnly(false);}}>조건 초기화</button>}
    </div>
    {(activeConditions>0||filter==='saved')&&<p className={styles.knowledgeResultCount} role="status">{ranked.length}개 자료</p>}
    <div className="knowledge-list">
      {ranked.map((item, index) => <article className={`knowledge-row ${index === 0 && filter === 'all' ? 'knowledge-first' : ''}`} key={item.id}>
        <Link className="knowledge-thumbnail" href={href(item.id)} aria-label={`${item.label} 자세히 보기`}><VideoThumbnail video={item} />{item.kind!=='reading'&&<span className="knowledge-play"><Play size={20} fill="currentColor" /></span>}{item.durationSeconds && <span className="knowledge-duration">{duration(item.durationSeconds)}</span>}</Link>
        <div className="knowledge-row-copy"><div className="knowledge-kicker"><span>{item.kind==='reading'?`공식 ${item.topic}`:item.topic}</span>{item.originLabels?.map(label=><span className="knowledge-origin" key={label}>{label}</span>)}{item.progress?.completed_at ? <span className="knowledge-done"><Check size={14} />{item.kind==='reading'?'읽었어요':'봤어요'}</span> : item.progress?.saved ? <Bookmark size={15} aria-label="저장한 자료" /> : null}</div><h2><Link href={href(item.id)}>{item.label}</Link></h2>{item.recommendedReason && <p className="knowledge-reason">{item.recommendedReason}</p>}{!item.recommendedReason&&<p className="knowledge-stretch">{item.stretch}</p>}<span className="knowledge-channel">{item.channel}</span><div className="knowledge-related">{recordContexts(item).slice(0, 2).map(related => <ContextLink key={related.id} context={related}/>)}</div><Link className="knowledge-detail-link" href={href(item.id)}>한입 보기<ArrowUpRight size={17} /></Link></div>
      </article>)}
    </div>
    {!matches.length && <><Empty title={activeConditions ? viewedOnly&&!term&&activity==='all'&&focus==='all'&&origin==='all'?'본 자료가 없어요':'조건에 맞는 자료가 없어요' : filter === 'saved' ? '저장한 자료가 없어요' : '연결된 자료가 없어요'} />{(activeConditions>0||filter!=='all')&&<button className="button ghost" onClick={()=>{setFilter('all');setActivity('all');setFocus('all');setSearch('');setOrigin('all');setViewedOnly(false);}}>전체 추천 자료 보기</button>}</>}
    {filter === 'all' && focus === 'all' && searches.length > 0 && <section className={styles.moreTopics} aria-labelledby="knowledge-more-topics"><h2 id="knowledge-more-topics">더 찾아볼 주제</h2>{searches.map(item => <div className="knowledge-topic-row" key={item.activityId}><div><strong>{item.topic}</strong>{item.kind==='major'?<span className="knowledge-search-kind">지원 학과에서 넓혀볼 주제</span>:<button onClick={() => openResource({ kind: 'activity', id: item.activityId })}>{item.activityTitle}<ChevronRight size={14} /></button>}</div><a href={item.url} target="_blank" rel="noopener noreferrer" className="text-link">YouTube 검색<ExternalLink size={15} /></a></div>)}</section>}
  </div>;
}
function VideoThumbnail({ video }: { video: KnowledgeMatch }) {
  const [failed, setFailed] = useState(false);
  if(video.kind==='reading')return <span className="knowledge-reading-art"><BookOpen size={32}/><span>{video.topic}</span><small>{video.channel}</small></span>;
  return failed ? <span className="knowledge-thumbnail-fallback"><Play size={34} /><span>{video.topic}</span></span> : <img src={video.thumbnail} alt={`${video.channel} 영상 썸네일`} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}
function KnowledgeDetail({ video, onUpdate, contextQuestion, flow }: { video: KnowledgeMatch; onUpdate: (id: string, progress: KnowledgeProgress) => void; contextQuestion: KnowledgeQuestion | null; flow: string | null }) {
  const { data, targetId: activeTargetId, toast, openResource } = useApp();
  const query = useSearchParams();
  const returnSession = data.interviews.find((item: Item) => item.id === query.get('sessionId') && !['cancelled','deleted'].includes(item.state));
  const savedLearning=visibleLearning(video);
  const historicalQuestion:KnowledgeQuestion|null=!video.current && savedLearning?.questionId && savedLearning.prompt ? {id:savedLearning.questionId,prompt:savedLearning.prompt,activityIds:video.activities.map(item=>item.id),sourceKind:savedLearning.sourceKind,sourceType:savedLearning.sourceType,commonRevision:savedLearning.commonRevision,sourceSnapshot:savedLearning.sourceSnapshot,targetId:video.targetId,targetSnapshot:video.targetSnapshot}:null;
  const related = historicalQuestion?[historicalQuestion]:video.relatedQuestions || [];
  const initialQuestionId = related.find(question => question.id === contextQuestion?.id)?.id || related.find(question => question.id === savedLearning?.questionId)?.id || related[0]?.id || '';
  const [questionId, setQuestionId] = useState(initialQuestionId);
  const question = related.find(item => item.id === questionId);
  const sourceQuestion = data.learning.questions?.find((item: Item) => item.id === questionId);
  const supportedTargets: string[] = sourceQuestion?.support_target_ids || [];
  const nextTarget = [question?.targetId,video.targetId,query.get('targetId'), activeTargetId, ...supportedTargets].find(id => id && data.targets.some((item: Item) => item.id === id) && (!supportedTargets.length || supportedTargets.includes(id))) || undefined;
  const nextParams = new URLSearchParams(contextQuery(question?.id, flow).slice(1));
  if (nextTarget) nextParams.set('targetId', nextTarget);
  if (question?.sourceKind==='common' && question.commonRevision) {nextParams.set('sourceType','common');nextParams.set('sourceVersion',String(question.commonRevision));}
  if (question?.activityIds.length) nextParams.set('activityId', question.activityIds.includes(query.get('activityId') || '') ? query.get('activityId')! : question.activityIds[0]);
  if (question?.sourceKind!=='common' && video.current && data.package?.active_version) nextParams.set('sourceVersion', String(data.package.active_version));
  const nextQuery = nextParams.size ? `?${nextParams}` : '';
  const draftKey = `gakja-knowledge:${data.user.id}:${video.id}:${video.targetId || 'record'}:${encodeURIComponent(knowledgeTargetKey(video.targetSnapshot))}:${question?.sourceKind==='common'?`common-${question.commonRevision}`:`personal-${data.package?.active_version || 'none'}`}`;
  const savedReflection = sameSavedContext(video) ? String(video.progress?.reflection || '') : '';
  const [reflection, setReflection] = useState(savedReflection);
  const [explanation, setExplanation] = useState(savedLearning?.questionId === initialQuestionId || !initialQuestionId && !savedLearning?.questionId ? String(savedLearning?.explanation || '') : '');
  const [seconds, setSeconds] = useState<number | null>(null), [running, setRunning] = useState(false);
  const assisted = useRef(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [history, setHistory] = useState<Item[] | null>(null);
  const lock = useRef(false);
  useEffect(() => { const draft = sessionStorage.getItem(draftKey); if (draft !== null) setReflection(draft); }, [draftKey]);
  useEffect(() => { if (!running) return; const timer = setInterval(() => setSeconds(value => { if (value === null || value <= 1) { setRunning(false); return 0; } return value - 1; }), 1000); return () => clearInterval(timer); }, [running]);
  useEffect(() => { const draft = sessionStorage.getItem(`${draftKey}:explanation:${questionId}`); assisted.current = sessionStorage.getItem(`${draftKey}:assisted:${questionId}`) === 'true' || questionId === savedLearning?.questionId && savedLearning?.assisted === true; setExplanation(draft ?? (questionId === savedLearning?.questionId || !questionId && !savedLearning?.questionId ? String(savedLearning?.explanation || '') : '')); }, [draftKey, questionId]);
  async function mutate(action: 'save' | 'complete' | 'reflection' | 'explanation' | 'self_check', value: string | boolean) {
    if (lock.current) return;
    lock.current = true; setBusy(action); setError('');
    try {
      const result = await post('/api/knowledge-bites', { action, videoId: video.id, value, ...(nextTarget?{targetId:nextTarget}:{}), expectedRevision: video.progress?.revision || 0, ...(questionId&&video.current ? { questionId } : {}), ...(question?.sourceKind==='common'?{commonRevision:question.commonRevision}:{}), ...(action === 'explanation' ? { assisted:assisted.current } : {}) });
      onUpdate(video.id, result.progress);
      if (action === 'reflection') { setReflection(result.progress.reflection); sessionStorage.removeItem(draftKey); toast('메모를 저장했어요.'); }
      if (action === 'explanation') { setExplanation(result.progress.snapshot.learning.explanation); sessionStorage.removeItem(`${draftKey}:explanation:${questionId}`); toast('내 설명을 저장했어요.'); }
    } catch (error) { setError((error as Error).message); }
    finally { lock.current = false; setBusy(''); }
  }
  async function openHistory() {
    try { const result = await api<KnowledgeData>(`/api/knowledge-bites?videoId=${video.id}${nextTarget?`&targetId=${encodeURIComponent(nextTarget)}`:''}`); setHistory(result.history); setError(''); }
    catch (error) { setError((error as Error).message); }
  }
  async function reloadProgress() {
    try { const result = await api<KnowledgeData>(`/api/knowledge-bites?videoId=${video.id}${nextTarget?`&targetId=${encodeURIComponent(nextTarget)}`:''}`); const latest = result.videos.find(item => item.id === video.id)?.progress; if (latest) onUpdate(video.id, latest); setError(''); }
    catch (error) { setError((error as Error).message); }
  }
  return <>
    <PageTitle title={video.label} aside={<button className={`knowledge-bookmark ${video.progress?.saved ? 'selected' : ''}`} aria-pressed={Boolean(video.progress?.saved)} disabled={Boolean(busy)} onClick={() => mutate('save', !video.progress?.saved)}><Bookmark size={19} fill={video.progress?.saved ? 'currentColor' : 'none'} />{video.progress?.saved ? '저장됨' : '저장'}</button>} />
    {returnSession && <div className="knowledge-session-return"><Link className="text-link" href={`/interview/${returnSession.id}`}>멈춘 면접 이어서<ArrowUpRight size={15}/></Link></div>}
    {error && <Alert>{error}<button className="text-link" onClick={reloadProgress}>최신 기록 불러오기</button></Alert>}
    <div className={`knowledge-watch ${video.kind==='reading'?'knowledge-reading-watch':''}`}>
      {video.kind==='reading'?<div className="knowledge-official-reading"><span>공식 {video.topic}</span><p>{video.summary}</p><a className="text-link" href={video.source} target="_blank" rel="noopener noreferrer">학교 원문 확인<ExternalLink size={15}/></a></div>:<a className="knowledge-watch-image" href={video.url} target="_blank" rel="noopener noreferrer" aria-label={`${video.label} YouTube에서 보기`}><VideoThumbnail video={video} /><span className="knowledge-watch-play"><Play size={32} fill="currentColor" /></span>{video.durationSeconds && <span className="knowledge-duration">{duration(video.durationSeconds)}</span>}</a>}
      <div className="knowledge-watch-copy"><span className="knowledge-kicker">{video.topic}</span><h2>{video.title}</h2><span className="knowledge-channel">{video.channel}</span><p className="knowledge-stretch">{video.stretch}</p><a className="knowledge-watch-link" href={video.url} target="_blank" rel="noopener noreferrer">{video.kind==='reading'?'학교 원문에서 보기':'YouTube에서 보기'}<ArrowUpRight size={18} /></a><a className="knowledge-publisher-link" href={video.source} target="_blank" rel="noopener noreferrer">원본 자료<ExternalLink size={14} /></a><div className="knowledge-completed"><button className={video.progress?.completed_at ? 'is-done' : ''} aria-pressed={Boolean(video.progress?.completed_at)} disabled={Boolean(busy)} onClick={() => mutate('complete', !video.progress?.completed_at)}><Check size={19} />{video.kind==='reading'?(video.progress?.completed_at?'읽었어요':'다 읽었어요'):(video.progress?.completed_at?'봤어요':'다 봤어요')}</button>{video.progress?.completed_at && <time>{stamp(String(video.progress.completed_at))}</time>}</div></div>
    </div>
    <section className="knowledge-understanding"><div className="section-heading"><h2>{video.kind==='reading'?'원문 닫고, 내 말로':'영상 닫고, 내 말로'}</h2><span>스스로 확인</span></div>{related.length > 0 && <label className="knowledge-question-label">연결할 질문<select aria-label="자료와 연결할 질문" value={questionId} onChange={event => setQuestionId(event.target.value)}>{related.map(item => <option key={item.id} value={item.id}>{item.prompt}</option>)}</select></label>}<p className="knowledge-check-prompt" data-question-key={question?.id}>{knowledgeCheckPrompt(video.topic, question)}</p><div className="knowledge-timer"><button className="text-link" onClick={() => { if (running) { setRunning(false); } else { if (!seconds) setSeconds(30); setRunning(true); } }}><Timer size={17}/>{running ? '잠시 멈추기' : seconds && seconds > 0 ? '이어서 말하기' : '30초 말해보기'}</button>{seconds !== null && <time>{seconds}초</time>}<span role="status">{seconds === 0 ? '말한 내용을 한 줄로 남겨보세요.' : ''}</span></div><textarea aria-label="내 말로 설명한 내용" maxLength={4000} value={explanation} onChange={event => { setExplanation(event.target.value); sessionStorage.setItem(`${draftKey}:explanation:${questionId}`, event.target.value); }} placeholder="기억한 개념과 내 기록에 연결할 점" /><div className="knowledge-note-actions"><span>정답 점수로 평가하지 않아요.</span><button className="button primary" disabled={Boolean(busy) || !explanation.trim() || explanation.trim() === savedLearning?.explanation && questionId === savedLearning?.questionId} onClick={() => mutate('explanation', explanation)}>{busy === 'explanation' ? '저장 중' : '내 설명 저장'}</button></div><div className="knowledge-self-check" role="group" aria-label="설명 후 스스로 확인">{[['explained','내 말로 설명했어요'],['needs_review','더 확인할 점이 있어요'],['not_yet','다음에 설명할게요']].map(([value,label]) => <button key={value} aria-pressed={savedLearning?.selfCheck === value && savedLearning?.questionId === (questionId || undefined)} disabled={Boolean(busy)} onClick={() => mutate('self_check', value)}>{label}{savedLearning?.selfCheck === value && savedLearning?.questionId === (questionId || undefined) && <Check size={14}/>}</button>)}</div>{question && video.current && <div className="knowledge-next-actions"><Link className="button primary" href={`/interview/chat${nextQuery}&questionCount=1`}>이 질문 면접에서 말하기<ArrowUpRight size={16}/></Link><Link className="text-link" href={`/quiz${nextQuery}`}>퀴즈에서 다시 떠올리기<ChevronRight size={16}/></Link>{question.sourceKind!=='common'&&<Link className="text-link" href={`/materials/answers/${encodeURIComponent(question.id)}`}>내 활동 답변에 연결하기<ChevronRight size={16}/></Link>}{flow === 'today' && <Link className="text-link" href={`/my/today${nextQuery}`}>오늘 학습으로 돌아가기<ChevronRight size={16}/></Link>}</div>}</section>
    {video.current && <LearningHelp questionId={question?.id} targetId={nextTarget} activityId={question?.activityIds[0] || video.activities[0]?.id} sourceType={question?.sourceKind==='common'?'common':'personal'} sourceVersion={question?.sourceKind==='common'?question.commonRevision:data.package?.active_version} onAssisted={()=>{assisted.current=true;sessionStorage.setItem(`${draftKey}:assisted:${questionId}`,'true');}} />}
    <section className="knowledge-context"><h2>{video.current ? '연결된 기록' : '저장 당시 기록'}</h2><div className="section-body">{recordContexts(video).map(related => <div className="knowledge-context-row" key={related.id}><ContextLink context={related}/></div>)}</div></section>
    <section className="knowledge-note"><div className="section-heading"><h2>한 줄 메모</h2><button className="text-link" disabled={!video.progress} onClick={openHistory}><History size={15} />이력</button></div><textarea aria-label="학습 자료 메모" maxLength={4000} value={reflection} onChange={event => { setReflection(event.target.value); sessionStorage.setItem(draftKey, event.target.value); }} placeholder="내 기록과 연결해서 기억하고 싶은 점" /><div className="knowledge-note-actions"><span>{reflection.length.toLocaleString()} / 4,000</span><button className="button primary" disabled={Boolean(busy) || reflection.trim() === String(video.progress?.reflection || '')} onClick={() => mutate('reflection', reflection)}>{busy === 'reflection' ? '저장 중' : '메모 저장'}</button></div></section>
    {history !== null && <Modal title="학습 기록 이력" onClose={() => setHistory(null)}>{history.filter(item => item.reflection || item.metadata?.learning?.explanation).length ? history.filter((item, index, items) => (item.reflection && item.reflection !== items[index + 1]?.reflection) || (item.metadata?.learning?.explanation && item.metadata.learning.explanation !== items[index + 1]?.metadata?.learning?.explanation)).map(item => <div className="knowledge-history-row" key={item.revision}><time>{stamp(item.created_at)}</time>{item.metadata?.targetSnapshot&&<p className="knowledge-history-target">{item.metadata.targetSnapshot.university} · {item.metadata.targetSnapshot.department}</p>}{item.metadata?.learning?.prompt && <strong>{item.metadata.learning.prompt}</strong>}{item.metadata?.learning?.explanation && <p>{item.metadata.learning.explanation}</p>}{item.reflection && <p>{item.reflection}</p>}</div>) : <p className="muted">저장한 설명과 메모가 없어요.</p>}</Modal>}
  </>;
}


