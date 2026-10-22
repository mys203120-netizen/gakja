'use client';
import {setDeviceItem} from '@/lib/client/device-storage';
import {ownedClassName} from './owned-class-name';

import Link from 'next/link';
import { useEffect, useRef, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowUpRight, BookOpen, Bookmark, Check, ChevronRight, ExternalLink, History, Play, Search, Timer } from 'lucide-react';
import { useApp } from './app-shell';
import { Alert, Empty, Modal, PageTitle, Spinner, api, post, type Item } from './shared';
import { KNOWLEDGE_FOCUS, type KnowledgeContext, type KnowledgeFocus, type KnowledgeMatch, type KnowledgeSearch, type KnowledgeActivity, type KnowledgeProgress, type KnowledgeQuestion } from '@/lib/knowledge-bites-catalog';
import { knowledgeCheckPrompt, knowledgeTargetKey } from '@/lib/knowledge-flow-model';
import { LearningHelp } from './learning-help';
import {learningScopeIdentity} from '@/lib/learning-target-scope';
import styles from './learning-surfaces.module.css';
type KnowledgeData = { videos: KnowledgeMatch[]; readings:KnowledgeMatch[];selectedTarget:{id:string;university:string;department:string;departmentField:string|null;departmentCategory:string|null}|null; searches: KnowledgeSearch[]; activities: KnowledgeActivity[]; contextQuestion: KnowledgeQuestion | null; history: Item[]; stats: { available: number; saved: number; completed: number }; contentVersion: number | null };
function contextQuery(questionId?: string | null, flow?: string | null, sessionId?: string | null,targetId?:string|null) { const params = new URLSearchParams(); if (questionId) params.set('questionId', questionId);if(targetId)params.set('targetId',targetId); if (flow === 'today') params.set('flow', 'today'); if (sessionId && /^[a-f0-9-]{36}$/i.test(sessionId)) params.set('sessionId', sessionId); return params.size ? `?${params}` : ''; }
function duration(value?: number) { return value ? `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}` : ''; }
function stamp(value?: string) { return value ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : ''; }
function recordContexts(video: KnowledgeMatch): KnowledgeContext[] { return video.contexts?.length ? video.contexts : video.activities.map(activity => ({ ...activity, kind: 'activity' as const, sourceRefIds: [] })); }
function contextTitle(context: KnowledgeContext) { const prefix = { activity: '', goal: '진로 목표', plan: '학업 계획', career: '진로 흐름', record: '',major:'지원 학과',school:'학교',question:'연습 질문' }[context.kind]; return prefix ? `${prefix} · ${context.title}` : context.title; }
function sameSavedContext(video:KnowledgeMatch) {return !video.current || knowledgeTargetKey(video.progress?.snapshot?.targetSnapshot as Record<string,unknown>|null)===knowledgeTargetKey(video.targetSnapshot);}
function visibleLearning(video:KnowledgeMatch) { const learning=sameSavedContext(video) ? video.progress?.snapshot?.learning : undefined;return video.current&&learning?.sourceKind==='common'&&!video.relatedQuestions?.some(question=>question.id===learning.questionId&&question.commonRevision===learning.commonRevision)?undefined:learning; }
function ContextLink({context}:{context:KnowledgeContext}) { const {openResource,data}=useApp();return context.kind==='school'||context.kind==='major' ? context.url?<a className={ownedClassName("knowledge-context-link",true)} href={context.url} target="_blank" rel="noopener noreferrer">{contextTitle(context)}<ExternalLink size={14}/></a>:<span className={ownedClassName("knowledge-context-label",true)}>{contextTitle(context)}</span> : context.kind==='question'?<span className={ownedClassName("knowledge-context-label",true)}>{contextTitle(context)}</span>:<button disabled={context.kind==='activity'?!data.learning.activities.some((item:Item)=>item.id===context.id):!data.learning.source_refs?.some((item:Item)=>item.id===context.sourceRefIds[0])} onClick={()=>openResource(context.kind==='activity'?{kind:'activity',id:context.id}:{kind:'source',id:context.sourceRefIds[0]})} className={ownedClassName(undefined,true)}>{contextTitle(context)}<ChevronRight size={14}/></button>; }
export function KnowledgeBites({ slug = [] }: { slug?: string[] }) {
  return <Suspense fallback={<Spinner />}><KnowledgePage slug={slug} /></Suspense>;
}
function KnowledgePage({ slug }: { slug: string[] }) {
  const { data,targetId:activeTargetId } = useApp();
  const params = useSearchParams(), questionId = params.get('questionId'), flow = params.get('flow'), sessionId = params.get('sessionId');
  const targetId=params.get('targetId') || activeTargetId;
  const endpoint = `/api/knowledge-bites${contextQuery(questionId,null,null,targetId)}`;
  const selectionScope=knowledgeTargetKey(learningScopeIdentity(data.targets.find(item=>item.id===targetId)||{}));
  const requestScope=JSON.stringify([data.user.id,data.package?.active_version,endpoint,selectionScope]);
  const [content, setContent] = useState<KnowledgeData | null>(null);
  const [loadedScope,setLoadedScope]=useState(''),generation=useRef(0);
  const [error, setError] = useState('');
  const load = async () => {const current=++generation.current;setContent(null);setError('');try{const result=await api<KnowledgeData>(endpoint);if(current===generation.current){setContent(result);setLoadedScope(requestScope);}}catch(error){if(current===generation.current){setError((error as Error).message);setLoadedScope(requestScope);}}};
  useEffect(() => {void load();return()=>{generation.current++;};}, [requestScope]);
  const selected = slug[0] ? content?.videos.find(item => item.id === slug[0]) : null;
  function update(videoId: string, progress: KnowledgeProgress) { setContent(previous => previous ? { ...previous, videos: previous.videos.map(item => item.id === videoId ? { ...item, progress } : item) } : previous); }
  return <section className={ownedClassName("knowledge-page",true)}>
    {loadedScope===requestScope&&error&&<Alert>{error}<button className={ownedClassName("text-link",true)} onClick={load}>다시 불러오기</button></Alert>}
    {loadedScope!==requestScope?<Spinner/>:!content ? !error && <Spinner /> : slug[0] ? selected ? <KnowledgeDetail key={`${data.user.id}:${selected.id}:${questionId || ''}:${targetId || ''}:${selectionScope}`} video={selected} onUpdate={update} contextQuestion={content.contextQuestion} flow={flow} /> : <Empty title="연결된 자료가 없어요" href={`/knowledge${contextQuery(questionId, flow,null,targetId)}`} label="자료 목록" /> : <KnowledgeList key={`${content.selectedTarget?.id || 'record'}:${selectionScope}`} content={content} />}
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
  return <div className={ownedClassName(styles.knowledge,true)}>
    <PageTitle title="지식한입" aside={<span className={ownedClassName("knowledge-count",true)}>{content.videos.filter(video=>video.current).length}<span className={ownedClassName(undefined,true)}>개 자료</span></span>} />
    {content.selectedTarget && <p className={ownedClassName("knowledge-target-name",true)}>{content.selectedTarget.university} <span className={ownedClassName(undefined,true)}>·</span> {content.selectedTarget.department}</p>}
    {content.contextQuestion && <div className={ownedClassName("knowledge-flow-context",true)}><span className={ownedClassName(undefined,true)}>이 질문 이어서</span><strong className={ownedClassName(undefined,true)}>{content.contextQuestion.prompt}</strong><Link className={ownedClassName("text-link")} href={`/quiz${contextQuery(questionId, flow,null,content.selectedTarget?.id)}`}>퀴즈로 돌아가기<ArrowUpRight size={15}/></Link></div>}
    <div className={ownedClassName(styles.knowledgeToolbar,true)}>
      <nav className={ownedClassName("knowledge-tabs",true)} aria-label="자료 보기"><button className={ownedClassName(filter === 'all' ? 'active' : '',true)} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>추천</button><button className={ownedClassName(filter === 'saved' ? 'active' : '',true)} aria-pressed={filter === 'saved'} onClick={() => setFilter('saved')}>저장 {savedCount > 0 && <span className={ownedClassName(undefined,true)}>{savedCount}</span>}</button></nav>
      <label className={ownedClassName('knowledge-search '+styles.knowledgeSearch,true)}><Search size={17} /><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="자료·활동 검색" aria-label="자료·활동 검색" className={ownedClassName(undefined,true)} /></label>
    </div>
    <div className={ownedClassName(styles.knowledgeFilters,true)} role="group" aria-label="자료 찾기">
      <label className={ownedClassName(styles.knowledgeFilter,true)}><span className={ownedClassName("sr-only",true)}>학습 연결</span><select aria-label="학습 연결" value={origin} onChange={event=>setOrigin(event.target.value)} className={ownedClassName(undefined,true)}><option value="all" className={ownedClassName(undefined,true)}>전체 연결</option>{['내 기록','학과 연결','학교 연결'].filter(label=>content.videos.some(item=>item.originLabels?.includes(label))).map(label=><option key={label} value={label} className={ownedClassName(undefined,true)}>{label}</option>)}</select></label>
      <label className={ownedClassName(styles.knowledgeFilter,true)}><span className={ownedClassName("sr-only",true)}>연결 활동</span><select aria-label="연결 활동" value={activity} onChange={event => setActivity(event.target.value)} className={ownedClassName(undefined,true)}><option value="all" className={ownedClassName(undefined,true)}>전체 활동</option>{content.activities.map(item => <option key={item.id} value={item.id} className={ownedClassName(undefined,true)}>{item.title}</option>)}</select></label>
      {availableFocus.length > 1 && <label className={ownedClassName(styles.knowledgeFilter,true)}><span className={ownedClassName("sr-only",true)}>주제 분야</span><select aria-label="주제 분야" value={focus} onChange={event => setFocus(event.target.value as KnowledgeFocus | 'all')} className={ownedClassName(undefined,true)}><option value="all" className={ownedClassName(undefined,true)}>전체 주제</option>{availableFocus.map(([key,label])=><option key={key} value={key} className={ownedClassName(undefined,true)}>{label}</option>)}</select></label>}
      <label className={ownedClassName(styles.viewedFilter,true)}><input type="checkbox" checked={viewedOnly} onChange={event=>setViewedOnly(event.target.checked)} className={ownedClassName(undefined,true)}/>본 자료만</label>
      {activeConditions>0&&<button className={ownedClassName("text-link",true)} onClick={()=>{setActivity('all');setFocus('all');setSearch('');setOrigin('all');setViewedOnly(false);}}>조건 초기화</button>}
    </div>
    {(activeConditions>0||filter==='saved')&&<p className={ownedClassName(styles.knowledgeResultCount,true)} role="status">{ranked.length}개 자료</p>}
    <div className={ownedClassName("knowledge-list",true)}>
      {ranked.map((item, index) => <article className={ownedClassName(`knowledge-row ${index === 0 && filter === 'all' ? 'knowledge-first' : ''}`,true)} key={item.id}>
        <Link className={ownedClassName("knowledge-thumbnail")} href={href(item.id)} aria-label={`${item.label} 자세히 보기`}><VideoThumbnail video={item} />{item.kind!=='reading'&&<span className={ownedClassName("knowledge-play",true)}><Play size={20} fill="currentColor" /></span>}{item.durationSeconds && <span className={ownedClassName("knowledge-duration",true)}>{duration(item.durationSeconds)}</span>}</Link>
        <div className={ownedClassName("knowledge-row-copy",true)}><div className={ownedClassName("knowledge-kicker",true)}><span className={ownedClassName(undefined,true)}>{item.kind==='reading'?(item.sourceSnapshot?.kind==='department_learning'?`학과 개념 · ${item.topic}`:`공식 ${item.topic}`):item.topic}</span>{item.originLabels?.map(label=><span className={ownedClassName("knowledge-origin",true)} key={label}>{label}</span>)}{item.progress?.completed_at ? <span className={ownedClassName("knowledge-done",true)}><Check size={14} />{item.kind==='reading'?'읽었어요':'봤어요'}</span> : item.progress?.saved ? <Bookmark size={15} aria-label="저장한 자료" /> : null}</div><h2 className={ownedClassName(undefined,true)}><Link href={href(item.id)}>{item.label}</Link></h2>{item.recommendedReason && <p className={ownedClassName("knowledge-reason",true)}>{item.recommendedReason}</p>}{!item.recommendedReason&&<p className={ownedClassName("knowledge-stretch",true)}>{item.stretch}</p>}<span className={ownedClassName("knowledge-channel",true)}>{item.channel}</span><div className={ownedClassName("knowledge-related",true)}>{recordContexts(item).slice(0, 2).map(related => <ContextLink key={related.id} context={related}/>)}</div><Link className={ownedClassName("knowledge-detail-link")} href={href(item.id)}>한입 보기<ArrowUpRight size={17} /></Link></div>
      </article>)}
    </div>
    {!matches.length && <><Empty title={activeConditions ? viewedOnly&&!term&&activity==='all'&&focus==='all'&&origin==='all'?'본 자료가 없어요':'조건에 맞는 자료가 없어요' : filter === 'saved' ? '저장한 자료가 없어요' : '연결된 자료가 없어요'} />{(activeConditions>0||filter!=='all')&&<button className={ownedClassName("button ghost",true)} onClick={()=>{setFilter('all');setActivity('all');setFocus('all');setSearch('');setOrigin('all');setViewedOnly(false);}}>전체 추천 자료 보기</button>}</>}
    {filter === 'all' && focus === 'all' && searches.length > 0 && <section className={ownedClassName(styles.moreTopics,true)} aria-labelledby="knowledge-more-topics"><h2 id="knowledge-more-topics" className={ownedClassName(undefined,true)}>더 찾아볼 주제</h2>{searches.map(item => <div className={ownedClassName("knowledge-topic-row",true)} key={item.activityId}><div className={ownedClassName(undefined,true)}><strong className={ownedClassName(undefined,true)}>{item.topic}</strong>{item.kind==='major'?<span className={ownedClassName("knowledge-search-kind",true)}>지원 학과에서 넓혀볼 주제</span>:<button onClick={() => openResource({ kind: 'activity', id: item.activityId })} className={ownedClassName(undefined,true)}>{item.activityTitle}<ChevronRight size={14} /></button>}</div><a href={item.url} target="_blank" rel="noopener noreferrer" className={ownedClassName("text-link",true)}>YouTube 검색<ExternalLink size={15} /></a></div>)}</section>}
  </div>;
}
function VideoThumbnail({ video }: { video: KnowledgeMatch }) {
  const [failed, setFailed] = useState(false);
  if(video.kind==='reading')return <span className={ownedClassName("knowledge-reading-art",true)}><BookOpen size={32}/><span className={ownedClassName(undefined,true)}>{video.topic}</span><small className={ownedClassName(undefined,true)}>{video.channel}</small></span>;
  return failed ? <span className={ownedClassName("knowledge-thumbnail-fallback",true)}><Play size={34} /><span className={ownedClassName(undefined,true)}>{video.topic}</span></span> : <img src={video.thumbnail} alt={`${video.channel} 영상 썸네일`} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className={ownedClassName(undefined,true)} />;
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
    <PageTitle title={video.label} aside={<button className={ownedClassName(`knowledge-bookmark ${video.progress?.saved ? 'selected' : ''}`,true)} aria-pressed={Boolean(video.progress?.saved)} disabled={Boolean(busy)} onClick={() => mutate('save', !video.progress?.saved)}><Bookmark size={19} fill={video.progress?.saved ? 'currentColor' : 'none'} />{video.progress?.saved ? '저장됨' : '저장'}</button>} />
    {returnSession && <div className={ownedClassName("knowledge-session-return",true)}><Link className={ownedClassName("text-link")} href={`/interview/${returnSession.id}`}>멈춘 면접 이어서<ArrowUpRight size={15}/></Link></div>}
    {error && <Alert>{error}<button className={ownedClassName("text-link",true)} onClick={reloadProgress}>최신 기록 불러오기</button></Alert>}
    <div className={ownedClassName(`knowledge-watch ${video.kind==='reading'?'knowledge-reading-watch':''}`,true)}>
      {video.kind==='reading'?<div className={ownedClassName("knowledge-official-reading",true)}><span className={ownedClassName(undefined,true)}>{video.sourceSnapshot?.kind==='department_learning'?'학과 개념 학습 · ':'공식 '}{video.topic}</span><p className={ownedClassName(undefined,true)}>{video.summary}</p><a className={ownedClassName("text-link",true)} href={video.source} target="_blank" rel="noopener noreferrer">{video.sourceSnapshot?.kind==='department_learning'?'학습 출처 확인':'학교 원문 확인'}<ExternalLink size={15}/></a></div>:<a className={ownedClassName("knowledge-watch-image",true)} href={video.url} target="_blank" rel="noopener noreferrer" aria-label={`${video.label} YouTube에서 보기`}><VideoThumbnail video={video} /><span className={ownedClassName("knowledge-watch-play",true)}><Play size={32} fill="currentColor" /></span>{video.durationSeconds && <span className={ownedClassName("knowledge-duration",true)}>{duration(video.durationSeconds)}</span>}</a>}
      <div className={ownedClassName("knowledge-watch-copy",true)}><span className={ownedClassName("knowledge-kicker",true)}>{video.topic}</span><h2 className={ownedClassName(undefined,true)}>{video.title}</h2><span className={ownedClassName("knowledge-channel",true)}>{video.channel}</span><p className={ownedClassName("knowledge-stretch",true)}>{video.stretch}</p><a className={ownedClassName("knowledge-watch-link",true)} href={video.url} target="_blank" rel="noopener noreferrer">{video.kind==='reading'?(video.sourceSnapshot?.kind==='department_learning'?'학습 출처에서 보기':'학교 원문에서 보기'):'YouTube에서 보기'}<ArrowUpRight size={18} /></a><a className={ownedClassName("knowledge-publisher-link",true)} href={video.source} target="_blank" rel="noopener noreferrer">원본 자료<ExternalLink size={14} /></a><div className={ownedClassName("knowledge-completed",true)}><button className={ownedClassName(video.progress?.completed_at ? 'is-done' : '',true)} aria-pressed={Boolean(video.progress?.completed_at)} disabled={Boolean(busy)} onClick={() => mutate('complete', !video.progress?.completed_at)}><Check size={19} />{video.kind==='reading'?(video.progress?.completed_at?'읽었어요':'다 읽었어요'):(video.progress?.completed_at?'봤어요':'다 봤어요')}</button>{video.progress?.completed_at && <time className={ownedClassName(undefined,true)}>{stamp(String(video.progress.completed_at))}</time>}</div></div>
    </div>
    <section className={ownedClassName("knowledge-understanding",true)}><div className={ownedClassName("section-heading",true)}><h2 className={ownedClassName(undefined,true)}>{video.kind==='reading'?'원문 닫고, 내 말로':'영상 닫고, 내 말로'}</h2><span className={ownedClassName(undefined,true)}>스스로 확인</span></div>{related.length > 0 && <label className={ownedClassName("knowledge-question-label",true)}>연결할 질문<select aria-label="자료와 연결할 질문" value={questionId} onChange={event => setQuestionId(event.target.value)} className={ownedClassName(undefined,true)}>{related.map(item => <option key={item.id} value={item.id} className={ownedClassName(undefined,true)}>{item.prompt}</option>)}</select></label>}<p className={ownedClassName("knowledge-check-prompt",true)} data-question-key={question?.id}>{knowledgeCheckPrompt(video.topic, question)}</p><div className={ownedClassName("knowledge-timer",true)}><button className={ownedClassName("text-link",true)} onClick={() => { if (running) { setRunning(false); } else { if (!seconds) setSeconds(30); setRunning(true); } }}><Timer size={17}/>{running ? '잠시 멈추기' : seconds && seconds > 0 ? '이어서 말하기' : '30초 말해보기'}</button>{seconds !== null && <time className={ownedClassName(undefined,true)}>{seconds}초</time>}<span role="status" className={ownedClassName(undefined,true)}>{seconds === 0 ? '말한 내용을 한 줄로 남겨보세요.' : ''}</span></div><textarea aria-label="내 말로 설명한 내용" maxLength={4000} value={explanation} onChange={event => { setExplanation(event.target.value); setDeviceItem(sessionStorage,`${draftKey}:explanation:${questionId}`, event.target.value); }} placeholder="기억한 개념과 내 기록에 연결할 점" className={ownedClassName(undefined,true)} /><div className={ownedClassName("knowledge-note-actions",true)}><span className={ownedClassName(undefined,true)}>정답 점수로 평가하지 않아요.</span><button className={ownedClassName("button primary",true)} disabled={Boolean(busy) || !explanation.trim() || explanation.trim() === savedLearning?.explanation && questionId === savedLearning?.questionId} onClick={() => mutate('explanation', explanation)}>{busy === 'explanation' ? '저장 중' : '내 설명 저장'}</button></div><div className={ownedClassName("knowledge-self-check",true)} role="group" aria-label="설명 후 스스로 확인">{[['explained','내 말로 설명했어요'],['needs_review','더 확인할 점이 있어요'],['not_yet','다음에 설명할게요']].map(([value,label]) => <button key={value} aria-pressed={savedLearning?.selfCheck === value && savedLearning?.questionId === (questionId || undefined)} disabled={Boolean(busy)} onClick={() => mutate('self_check', value)} className={ownedClassName(undefined,true)}>{label}{savedLearning?.selfCheck === value && savedLearning?.questionId === (questionId || undefined) && <Check size={14}/>}</button>)}</div>{question && video.current && <div className={ownedClassName("knowledge-next-actions",true)}><Link className={ownedClassName("button primary")} href={`/interview/chat${nextQuery}&questionCount=1`}>이 질문 면접에서 말하기<ArrowUpRight size={16}/></Link><Link className={ownedClassName("text-link")} href={`/quiz${nextQuery}`}>퀴즈에서 다시 떠올리기<ChevronRight size={16}/></Link>{question.sourceKind!=='common'&&<Link className={ownedClassName("text-link")} href={`/materials/answers/${encodeURIComponent(question.id)}`}>내 활동 답변에 연결하기<ChevronRight size={16}/></Link>}{flow === 'today' && <Link className={ownedClassName("text-link")} href={`/my/today${nextQuery}`}>오늘 학습으로 돌아가기<ChevronRight size={16}/></Link>}</div>}</section>
    {video.current && <LearningHelp questionId={question?.id} targetId={nextTarget} activityId={question?.activityIds[0] || video.activities[0]?.id} sourceType={question?.sourceKind==='common'?'common':'personal'} sourceVersion={question?.sourceKind==='common'?question.commonRevision:data.package?.active_version} onAssisted={()=>{assisted.current=true;setDeviceItem(sessionStorage,`${draftKey}:assisted:${questionId}`,'true');}} />}
    <section className={ownedClassName("knowledge-context",true)}><h2 className={ownedClassName(undefined,true)}>{video.current ? '연결된 기록' : '저장 당시 기록'}</h2><div className={ownedClassName("section-body",true)}>{recordContexts(video).map(related => <div className={ownedClassName("knowledge-context-row",true)} key={related.id}><ContextLink context={related}/></div>)}</div></section>
    <section className={ownedClassName("knowledge-note",true)}><div className={ownedClassName("section-heading",true)}><h2 className={ownedClassName(undefined,true)}>한 줄 메모</h2><button className={ownedClassName("text-link",true)} disabled={!video.progress} onClick={openHistory}><History size={15} />이력</button></div><textarea aria-label="학습 자료 메모" maxLength={4000} value={reflection} onChange={event => { setReflection(event.target.value); setDeviceItem(sessionStorage,draftKey, event.target.value); }} placeholder="내 기록과 연결해서 기억하고 싶은 점" className={ownedClassName(undefined,true)} /><div className={ownedClassName("knowledge-note-actions",true)}><span className={ownedClassName(undefined,true)}>{reflection.length.toLocaleString()} / 4,000</span><button className={ownedClassName("button primary",true)} disabled={Boolean(busy) || reflection.trim() === String(video.progress?.reflection || '')} onClick={() => mutate('reflection', reflection)}>{busy === 'reflection' ? '저장 중' : '메모 저장'}</button></div></section>
    {history !== null && <Modal title="학습 기록 이력" onClose={() => setHistory(null)}>{history.filter(item => item.reflection || item.metadata?.learning?.explanation).length ? history.filter((item, index, items) => (item.reflection && item.reflection !== items[index + 1]?.reflection) || (item.metadata?.learning?.explanation && item.metadata.learning.explanation !== items[index + 1]?.metadata?.learning?.explanation)).map(item => <div className={ownedClassName("knowledge-history-row",true)} key={item.revision}><time className={ownedClassName(undefined,true)}>{stamp(item.created_at)}</time>{item.metadata?.targetSnapshot&&<p className={ownedClassName("knowledge-history-target",true)}>{item.metadata.targetSnapshot.university} · {item.metadata.targetSnapshot.department}</p>}{item.metadata?.learning?.prompt && <strong className={ownedClassName(undefined,true)}>{item.metadata.learning.prompt}</strong>}{item.metadata?.learning?.explanation && <p className={ownedClassName(undefined,true)}>{item.metadata.learning.explanation}</p>}{item.reflection && <p className={ownedClassName(undefined,true)}>{item.reflection}</p>}</div>) : <p className={ownedClassName("muted",true)}>저장한 설명과 메모가 없어요.</p>}</Modal>}
  </>;
}


