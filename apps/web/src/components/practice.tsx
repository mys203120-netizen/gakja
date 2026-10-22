'use client';
import {setDeviceItem} from '@/lib/client/device-storage';
import {ownedClassName} from './owned-class-name';


import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Clock3, Sparkles, Mic, ArrowUpRight, Check, RotateCcw, GripVertical, Play, ChevronRight, ListChecks, ArrowUp, ArrowDown } from 'lucide-react';
import {useRecordPages,useRecordDetail} from './use-record-pages';
import { useApp } from './app-shell';
import { action, api, post, PageTitle, Breadcrumb, Empty, Alert, Badge, Modal, Spinner, dateLabel, type Item } from './shared';
import { InterviewSetup, InterviewSession } from './interview';
import { QuizHome, QuizSession } from './quiz-v3';
import { QuizLibrary } from './quiz-library';
import { learningRetryHref } from '@/lib/learning-navigation';
import { growthContextKey } from '@/lib/learning-growth';
import { LearningHelp } from './learning-help';
import { TrainingContinuation } from './training-continuation';

export function QuizPages({ slug = [] }: { slug?: string[] }) {
  if (slug[0] === 'assignments') return slug[1] ? <AssignmentSession key={slug[1]} id={slug[1]} /> : <AssignmentList />;
  if (slug[0] === 'memory') return slug[1] ? <MemorySession key={slug[1]} id={slug[1]} /> : <MemoryList />;
  if (slug[0] === 'session' && slug[1]) return <QuizSession key={slug[1]} id={slug[1]} />;
  return <QuizHome />;
}

function memoryTitle(item: Item, learning: Item) {
  const question = learning.questions?.find((q: Item) => q.id === item.question_id);
  return ['keyword_recall', 'order', 'answer_order'].includes(item.kind)
    ? question?.prompt || item.prompt
    : item.prompt;
}

export function PracticePages({ slug = [] }: { slug?: string[] }) {
  if (slug[0] === 'assignments') return slug[1] ? <AssignmentSession key={slug[1]} id={slug[1]} /> : <AssignmentList />;
  if (slug[0] === 'video') return slug[1] && slug[1] !== 'new' ? <InterviewSession id={slug[1]} kind="video" /> : <InterviewSetup kind="video" />;
  if (slug[0] === 'memory') return slug[1] ? <MemorySession key={slug[1]} id={slug[1]} /> : <MemoryList />;
  return <QuizHome />;
}

function PracticeOverview() {
  const { data } = useApp();
  return <div className={ownedClassName("training-view training-overview",true)}>
    <PageTitle title="훈련" />
    <div className={ownedClassName("training-paths",true)}>
      <Link className={ownedClassName("training-path")} href="/quiz/memory">
        <Sparkles size={28} strokeWidth={1.5} />
        <div className={ownedClassName(undefined,true)}><h2 className={ownedClassName(undefined,true)}>암기 훈련</h2><p className={ownedClassName(undefined,true)}>회상 · 개념 확인 · 순서 정리</p></div>
        <span className={ownedClassName("training-path-action",true)}><span className={ownedClassName(undefined,true)}>복습 시작</span><ArrowUpRight size={22} strokeWidth={1.5} /></span>
      </Link>
      <Link className={ownedClassName("training-path")} href="/quiz/assignments">
        <ListChecks size={28} strokeWidth={1.5} />
        <div className={ownedClassName(undefined,true)}><h2 className={ownedClassName(undefined,true)}>퀴즈 과제</h2><p className={ownedClassName(undefined,true)}>학생부 사실 확인 · 경험 복원 · 재훈련</p></div>
        <span className={ownedClassName("training-path-action",true)}><span className={ownedClassName(undefined,true)}>과제 보기</span><ArrowUpRight size={22} strokeWidth={1.5} /></span>
      </Link>
      <Link className={ownedClassName("training-path")} href="/interview/new?kind=video">
        <Mic size={28} strokeWidth={1.5} />
        <div className={ownedClassName(undefined,true)}><h2 className={ownedClassName(undefined,true)}>화상 모의면접</h2><p className={ownedClassName(undefined,true)}>질문을 듣고 내 말로 답하기</p></div>
        <span className={ownedClassName("training-path-action",true)}><span className={ownedClassName(undefined,true)}>연습 시작</span><ArrowUpRight size={22} strokeWidth={1.5} /></span>
      </Link>
    </div>
    <section className={ownedClassName("training-keywords",true)}>
      <div className={ownedClassName("section-heading",true)}><h2 className={ownedClassName(undefined,true)}>복습할 키워드</h2><Link className={ownedClassName("text-link")} href="/quiz/memory">전체 보기<ChevronRight size={16} /></Link></div>
      <div className={ownedClassName("training-keyword-list",true)}>
        {data.learning?.memory_items?.slice(0, 3).map((m: Item) => <Link key={m.id} href={'/quiz/memory/' + m.id}><strong className={ownedClassName(undefined,true)}>{memoryTitle(m, data.learning)}</strong><ArrowUpRight size={20} strokeWidth={1.5} /></Link>)}
      </div>
      {!data.learning?.memory_items?.length && <Empty title="발행된 훈련 항목이 없어요" />}
    </section>
  </div>;
}

const kindNames: Item = { keyword_recall: '키워드 회상', order: '순서 배열', answer_order: '순서 배열', choice: '개념 선택', concept_choice: '개념 선택', flip_card: '카드 뒤집기', self_check: '자기 점검', short_answer: '단답 확인', short_speech: '짧게 말하기' };

function MemoryList() { return <QuizLibrary/>; }

function MemorySession({ id }: { id: string }) {
  const { data, refresh } = useApp();
  const m: Item = data.learning?.memory_items?.find((m: Item) => m.id === id);
  const [started, setStarted] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [seconds, setSeconds] = useState(m?.default_time_limit_seconds || 10);
  const [limit, setLimit] = useState(m?.default_time_limit_seconds || 10);
  const [answer, setAnswer] = useState('');
  const [selection, setSelection] = useState<number | null>(null);
  const [order, setOrder] = useState<any[]>(() => [...(m?.ordered_steps || m?.sequence || m?.answer_order || m?.items || m?.options || [])].reverse());
  const [completed, setCompleted] = useState(false);
  const [rating, setRating] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!started || revealed || !limit) return;
    const timer = setInterval(() => setSeconds((s: number) => { if (s <= 1) { setRevealed(true); return 0; } return s - 1; }), 1000);
    return () => clearInterval(timer);
  }, [started, revealed, limit]);
  if (!m) return <Empty title="훈련 항목을 찾을 수 없어요" />;
  const keywords = m.memory_keywords || m.keywords || [];
  const options = m.options || m.choices || [];
  const isChoice = m.kind === 'choice' || m.kind === 'concept_choice';
  const isOrder = m.kind === 'order' || m.kind === 'answer_order';
  const q = data.learning.questions.find((q: Item) => q.id === m.question_id);
  const all: Item[] = data.learning.memory_items;
  const next = all[(all.indexOf(m) + 1) % all.length];

  async function finish(value: string) {
    setBusy(true); setError('');
    try {
      await action('memory_attempt', { memoryItemId: id, rating: value, answer: isChoice ? (selection === null ? null : options[selection]?.id || String(selection)) : answer, elapsedSeconds: limit ? Math.max(0, limit - seconds) : null, data: { selection, order, timerDisabled: limit === 0 } });
      setRating(value); setCompleted(true); await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return <div className={ownedClassName("training-view recall-view",true)}>
    <Breadcrumb items={[{ label: '퀴즈', href: '/quiz' }, { label: '암기 훈련', href: '/quiz/memory' }, { label: kindNames[m.kind] || '자기 점검' }]} />
    <PageTitle title={kindNames[m.kind] || '자기 점검'} />
    {error && <Alert>{error}</Alert>}
    <section className={ownedClassName('recall-card ' + (revealed ? 'revealed' : ''),true)}>
      <div className={ownedClassName("recall-card-header",true)}>
        <span className={ownedClassName("recall-state",true)}><i aria-hidden="true" className={ownedClassName(undefined,true)} />{completed ? '완료' : started ? '회상 중' : '시작 전'}</span>
        <div className={ownedClassName("recall-timer",true)}><Clock3 size={18} strokeWidth={1.5} /><strong className={ownedClassName(undefined,true)}>{!limit ? '∞' : seconds.toString().padStart(2, '0')}</strong>{limit > 0 && <small className={ownedClassName(undefined,true)}>초</small>}</div>
      </div>
      <h2 className={ownedClassName(undefined,true)}>{m.prompt}</h2>
      {q && q.prompt !== m.prompt && <p className={ownedClassName("recall-question",true)}>{q.prompt}</p>}
      {!started ? <div className={ownedClassName("recall-start",true)}>
        <label className={ownedClassName("timer-select",true)}>제한 시간<select value={limit} onChange={e => { setLimit(Number(e.target.value)); setSeconds(Number(e.target.value)); }} className={ownedClassName(undefined,true)}><option value={10} className={ownedClassName(undefined,true)}>10초</option><option value={20} className={ownedClassName(undefined,true)}>20초</option><option value={30} className={ownedClassName(undefined,true)}>30초</option>{m.kind === 'short_speech' && <><option value={60} className={ownedClassName(undefined,true)}>60초</option><option value={90} className={ownedClassName(undefined,true)}>90초</option></>}<option value={0} className={ownedClassName(undefined,true)}>시간 제한 없음</option></select></label>
        <button className={ownedClassName("button primary large",true)} onClick={() => setStarted(true)}><Play size={17} />시작</button>
      </div> : completed ? <div className={ownedClassName("recall-completed",true)}>
        <span className={ownedClassName("completion-check",true)}><Check size={30} strokeWidth={1.7} /></span>
        <h3 className={ownedClassName(undefined,true)}>{rating === 'again' ? '다시 복습할 항목에 담았어요.' : '복습 기록을 저장했어요.'}</h3>
        <div className={ownedClassName("recall-completed-actions",true)}><Link className={ownedClassName("button primary")} href={'/quiz/memory/' + next.id}>다음 항목<ChevronRight size={17} /></Link><Link className={ownedClassName("text-link")} href="/quiz/memory">훈련 목록</Link></div>
      </div> : <>
        <div className={ownedClassName("recall-answer-area",true)}>
          {isChoice ? <div className={ownedClassName("choice-grid",true)}>{options.map((o: any, i: number) => <button key={i} className={ownedClassName(selection === i ? 'selected' : '',true)} disabled={revealed} onClick={() => setSelection(i)}><span className={ownedClassName(undefined,true)}>{String.fromCharCode(65 + i)}</span>{typeof o === 'string' ? o : o.label || o.text}</button>)}</div> : isOrder ? <div className={ownedClassName("order-items",true)}>{order.map((o: any, i: number) => <button key={i} disabled={revealed} onClick={() => { if (i === 0) return; setOrder(prev => { const copy = [...prev]; [copy[i - 1], copy[i]] = [copy[i], copy[i - 1]]; return copy; }); }} className={ownedClassName(undefined,true)}><GripVertical size={17} /><span className={ownedClassName(undefined,true)}>{i + 1}</span>{typeof o === 'string' ? o : o.label || o.text}<small className={ownedClassName(undefined,true)}>눌러서 위로</small></button>)}</div> : m.kind === 'flip_card' ? <button className={ownedClassName("flip-card",true)} onClick={() => setRevealed(true)}><span className={ownedClassName(undefined,true)}>생각한 답을 말해보세요.</span><RotateCcw size={28} strokeWidth={1.5} /><small className={ownedClassName(undefined,true)}>눌러서 확인</small></button> : <textarea aria-label={m.kind === 'short_speech' ? '말한 내용 기록' : '떠오른 키워드 또는 답변 요소'} placeholder={m.kind === 'short_speech' ? '짧게 말해본 뒤, 말한 내용을 기록해주세요.' : m.kind === 'short_answer' ? '기억나는 사실을 적어주세요.' : '떠오른 키워드 또는 답변 요소'} value={answer} onChange={e => setAnswer(e.target.value)} disabled={revealed} className={ownedClassName(undefined,true)} />}
        </div>
        {!revealed ? <button className={ownedClassName("button ghost",true)} onClick={() => setRevealed(true)}>키워드 확인</button> : <div className={ownedClassName("recall-feedback",true)}>
          <h3 className={ownedClassName(undefined,true)}>핵심 확인</h3>
          <div className={ownedClassName("recall-keywords",true)}>{keywords.map((k: any, i: number) => <span key={i} className={ownedClassName(undefined,true)}>{typeof k === 'string' ? k : k.keyword || k.label}</span>)}</div>
          {isChoice && <p className={ownedClassName(undefined,true)}>{selection !== null && (options[selection]?.id === m.correct_option_id || selection === Number(m.correct_index ?? m.correct_answer_index)) ? '맞았어요.' : '정답: ' + (options.find((o: any) => o.id === m.correct_option_id)?.text || options[Number(m.correct_index ?? m.correct_answer_index)]?.text || options[Number(m.correct_index ?? m.correct_answer_index)] || m.correct_answer || '정답 확인 필요')}</p>}
          {isOrder && <p className={ownedClassName("muted",true)}>{(m.ordered_steps || m.sequence || m.answer_order || m.items || m.options || []).map((s: any) => typeof s === 'string' ? s : s.text || s.label).join(' → ')}</p>}
          {m.kind === 'flip_card' && <p className={ownedClassName("body-copy",true)}>{m.back}</p>}
          <p className={ownedClassName("muted",true)}>{isChoice ? '개념을 다시 확인해 보세요.' : '표현이 달라도 핵심 흐름이 떠올랐다면 괜찮아요.'}</p>
          <div className={ownedClassName("rating-buttons",true)}>{[['again', '다시 준비'], ['hard', '어려웠어요'], ['good', '떠올랐어요'], ['easy', '자신 있어요']].map(([key, label]) => <button disabled={busy} onClick={() => finish(key)} key={key} className={ownedClassName(key === 'good' ? 'button primary' : 'button ghost',true)}>{label}</button>)}</div>
        </div>}
      </>}
    </section>
  </div>;
}

export function useLearningWorkflows() {
  const [workflows, setWorkflows] = useState<Item | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try { const next = await api<Item>('/api/learning'); setWorkflows(next); return next; }
    catch (err) { setError((err as Error).message); return null; }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { let active = true; const controller = new AbortController();
    api<Item>('/api/learning', { signal: controller.signal }).then(value => { if (active) setWorkflows(value); }).catch(err => { if (active) setError((err as Error).message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, []);
  return { workflows, setWorkflows, loading, error, reload };
}

const assignmentStates: Item = { assigned: '시작 전', in_progress: '진행 중', submitted: '제출 완료', reviewed: '검토 완료', retry_due: '다시 준비', completed: '완료' };
const categoryNames: Item = { factual: '사실 회상', experiential: '경험 복원', concept: '개념·적용' };
const valueText = (value: any): string => typeof value === 'string' ? value : value?.text || value?.label || value?.keyword || '';
const itemId = (value: any, index: number): string => typeof value === 'string' ? value : String(value?.id ?? index);

function AssignmentList() {
  const { data } = useApp();
  const router = useRouter();
  const { workflows, setWorkflows, loading, error, reload } = useLearningWorkflows();
  const [filter, setFilter] = useState('active');
  const assignmentPages=useRecordPages('assignments','state='+filter,true,data.user.id);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [saveError, setSaveError] = useState('');
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const requestId = useRef('');
  const assignments:Item[]=assignmentPages.items;
  const items: Item[] = workflows?.memoryItems || [];
  const visible = assignments.filter(a => filter === 'all' || (filter === 'completed' ? a.state === 'completed' : a.state !== 'completed'));
  async function create() {
    if (sending.current || !selected.length) return;
    sending.current = true; setBusy(true); setSaveError('');
    requestId.current ||= crypto.randomUUID();
    try {
      const result = await post('/api/learning', { action: 'assignment_create', memoryItemIds: selected, title: title.trim() || undefined, requestId: requestId.current });
      if (result.data) setWorkflows(result.data);
      requestId.current = ''; setCreating(false); setSelected([]); setTitle('');
      if (result.assignment?.id) router.push('/quiz/assignments/' + result.assignment.id); else await reload();
    } catch (err) { setSaveError((err as Error).message); }
    finally { sending.current = false; setBusy(false); }
  }
  return <div className={ownedClassName("learning-v2 assignment-library",true)}>
    <Breadcrumb items={[{ label: '퀴즈', href: '/quiz' }, { label: '퀴즈 과제' }]} />
    <PageTitle title="퀴즈 과제" aside={<button className={ownedClassName("button primary",true)} disabled={loading || !items.length} onClick={() => { setCreating(true); setSaveError(''); }}>복습 과제 만들기</button>} />
    <nav className={ownedClassName("learning-tabs",true)} aria-label="과제 상태">{[['active', '해야 할 과제'], ['completed', '완료한 과제'], ['all', '전체']].map(([key, label]) => <button key={key} className={ownedClassName(filter === key ? 'active' : '',true)} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}</nav>
    {(error||assignmentPages.error) && <><Alert>{error||assignmentPages.error}</Alert><button className={ownedClassName("button ghost",true)} onClick={()=>{void reload();void assignmentPages.reload();}}>다시 불러오기</button></>}
    {assignmentPages.loading&&!assignments.length ? <Spinner /> : visible.length ? <div className={ownedClassName("learning-rows",true)}>{visible.map(a => <Link className={ownedClassName("learning-row")} key={a.id} href={'/quiz/assignments/' + a.id}>
      <ListChecks size={23} strokeWidth={1.5} /><div className={ownedClassName(undefined,true)}><h2 className={ownedClassName(undefined,true)}>{a.title}</h2><p className={ownedClassName(undefined,true)}>{a.item_count || 0}개 항목{a.due_at ? ' · ' + dateLabel(a.due_at) + '까지' : ''}{a.data?.origin === 'report' || a.report_id ? ' · 면접 후 재훈련' : ''}</p></div><Badge tone={a.state === 'completed' ? 'green' : 'neutral'}>{assignmentStates[a.state] || '확인 중'}</Badge><ArrowUpRight size={20} />
    </Link>)}</div> : !error&&!assignmentPages.error && <Empty title={filter === 'completed' ? '완료한 과제가 없어요' : '배정된 과제가 없어요'} href={!items.length ? '/my' : undefined} label={!items.length ? '오늘의 학습' : undefined}>{items.length ? '복습할 항목을 골라 과제를 시작할 수 있어요.' : '지원 학교의 질문으로 과제를 시작해 보세요.'}</Empty>}
    {assignmentPages.page?.hasMore&&<button className={ownedClassName('button ghost',true)} disabled={assignmentPages.loading} onClick={()=>void assignmentPages.more()}>이전 과제 더 보기</button>}
    <div className={ownedClassName("learning-inline-links",true)}><Link href="/quiz/memory">암기 훈련<ArrowUpRight size={16} /></Link><Link href="/account/confirmations">사실 확인함<ArrowUpRight size={16} /></Link></div>
    {creating && <Modal title="복습 과제 만들기" onClose={() => { if (!busy) setCreating(false); }}>
      {saveError && <Alert>{saveError}</Alert>}
      <label className={ownedClassName(undefined,true)}>과제 이름<input value={title} maxLength={120} onChange={e => { setTitle(e.target.value); requestId.current = ''; }} placeholder="예: 탐구 활동 다시 떠올리기" className={ownedClassName(undefined,true)} /></label>
      <div className={ownedClassName("assignment-picker",true)}>{items.map(m => { const q = data.learning?.questions?.find((q: Item) => q.id === m.question_id); const checked = selected.includes(m.memory_item_id || m.id); return <label key={m.memory_item_id || m.id} className={ownedClassName(undefined,true)}><input type="checkbox" checked={checked} disabled={!checked && selected.length >= 30} onChange={e => { requestId.current = ''; setSelected(prev => e.target.checked ? [...prev, m.memory_item_id || m.id] : prev.filter(id => id !== (m.memory_item_id || m.id))); }} className={ownedClassName(undefined,true)} /><span className={ownedClassName(undefined,true)}><strong className={ownedClassName(undefined,true)}>{q?.prompt || m.prompt}</strong><small className={ownedClassName(undefined,true)}>{categoryNames[m.category] || kindNames[m.kind] || '자기 점검'}</small></span></label>; })}</div>
      <button className={ownedClassName("button primary full",true)} disabled={busy || !selected.length} onClick={create}>{busy ? '저장 중' : selected.length + '개 항목으로 시작'}</button>
    </Modal>}
  </div>;
}

function AssignmentSession({ id }: { id: string }) {
  const {data}=useApp(),params=useSearchParams();
  const requestedPlan=params.get('trainingPlanId');
  const trainingPlanId=requestedPlan&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestedPlan)?requestedPlan:null;
  // A query change preserves this assignment draft; another account or task owns a new form.
  return <AssignmentSessionBody key={`${data.user.id}:${id}`} id={id} trainingPlanId={trainingPlanId}/>;
}

function AssignmentSessionBody({ id, trainingPlanId }: { id: string; trainingPlanId: string|null }) {
  const { data, refresh } = useApp();
  const router = useRouter();
  const detail=useRecordDetail('assignments','id='+encodeURIComponent(id),true,data.user.id);
  const {loading,error,reload}=detail;
  const [responses, setResponses] = useState<Item>({});
  const [saveError, setSaveError] = useState('');
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const requestIds = useRef<Item>({});
  const restored = useRef(false);
  const activeItem=useRef('');
  const visit=useRef({active:true});
  useEffect(()=>{const current=visit.current;current.active=true;return()=>{current.active=false;};},[]);
  const [assistantRequest,setAssistantRequest]=useState<{itemId:string;token:number}>({itemId:'',token:0});
  const assignment:Item|null=detail.item;
  const draftKey = `gakja-assignment:${data.user.id}:${id}`;
  useEffect(() => { try { const stored = sessionStorage.getItem(draftKey); if (stored) setResponses(JSON.parse(stored)); } catch {} restored.current = true; }, [draftKey]);
  useEffect(() => { if (restored.current && Object.keys(responses).length) setDeviceItem(sessionStorage,draftKey, JSON.stringify(responses)); }, [responses, draftKey]);
  const items: Item[] = assignment?.items || [];
  const schoolAssignment = assignment?.source_kind === 'common';
  const savedTarget = assignment?.target_snapshot;
  const currentTarget = data.targets?.find((target:Item)=>target.id===assignment?.target_id);
  const savedStage=savedTarget?.interview_stage||savedTarget?.stage,currentStage=currentTarget?.interview_stage||currentTarget?.stage;
  const targetUnchanged = assignment?.target_unchanged ?? (!savedTarget || !!currentTarget && growthContextKey({id:'saved',question_id:'scope',script:'',created_at:'',target_id:currentTarget.id,target_snapshot:{...savedTarget,interview_stage:savedStage||currentStage}})===growthContextKey({id:'current',question_id:'scope',script:'',created_at:'',target_id:currentTarget.id,target_snapshot:{...currentTarget,interview_stage:currentStage||savedStage}}));
  const locked = !!assignment && ['submitted', 'reviewed', 'retry_due', 'completed'].includes(assignment.state);
  useEffect(()=>{
    function openAssistant(event:Event){
      if(!assignment||assignment.state!=='in_progress'||locked)return;
      event.preventDefault();
      if(busy||sending.current){setSaveError('답변을 저장한 뒤 도움을 열 수 있어요.');return;}
      const item=items.find(item=>item.memory_item_id===activeItem.current)||items[0];
      if(!item){setSaveError('도움을 받을 질문을 먼저 확인해 주세요.');return;}
      if(!item.question_snapshot&&assignment.source_kind!=='common'&&assignment.content_version!==data.package?.active_version){setSaveError('당시 질문의 자료를 확인할 수 없어요. 원래 기록에서 확인해 주세요.');return;}
      try{setDeviceItem(sessionStorage,draftKey,JSON.stringify(responses));}
      catch{setSaveError('초안을 보관하지 못했어요. 답변을 복사한 뒤 다시 시도해 주세요.');return;}
      setAssistantRequest(previous=>({itemId:item.memory_item_id,token:previous.token+1}));
    }
    window.addEventListener('gakja:open-on',openAssistant);
    return()=>window.removeEventListener('gakja:open-on',openAssistant);
  },[assignment,locked,busy,items,responses,draftKey,data.package?.active_version]);
  function update(item: Item, patch: Item) { setResponses(prev => ({ ...prev, [item.memory_item_id]: { ...prev[item.memory_item_id], ...patch } })); requestIds.current.assignment_submit = ''; }
  async function mutate(actionName: string, extra: Item = {}) {
    if (sending.current) return;
    sending.current = true; setBusy(true); setSaveError('');
    requestIds.current[actionName] ||= crypto.randomUUID();
    try {
      const result = await post('/api/learning', { action: actionName, assignmentId: id, requestId: requestIds.current[actionName], ...extra });
      if(!visit.current.active)return;
      await reload();
      if(!visit.current.active)return;
      if (actionName === 'assignment_submit') { sessionStorage.removeItem(draftKey); setResponses({}); await refresh(); }
      if(!visit.current.active)return;
      if (actionName === 'assignment_retry' && result.assignment?.id) router.push('/quiz/assignments/' + result.assignment.id);
      requestIds.current[actionName] = '';
    } catch (err) { setSaveError((err as Error).message); }
    finally { sending.current = false; setBusy(false); }
  }
  function submit() {
    const payload = items.map(m => {
      const r = responses[m.memory_item_id] || {};
      const sequence = m.sequence || [];
      return { memoryItemId: m.memory_item_id, response: r.response || '', rating: r.rating || 'again', selectedOptionId: r.selectedOptionId, order: ['order', 'answer_order'].includes(m.kind) ? r.order || sequence.map(itemId).reverse() : undefined, cannotRecall: !!r.cannotRecall, selfCheckedMeanings: r.checked || [],assisted:r.assisted===true,hintUsed:r.hintUsed===true,helpKinds:r.helpKinds||[] };
    });
    return mutate('assignment_submit', { responses: payload });
  }
  if (loading) return <Spinner />;
  if (!assignment) return <div className={ownedClassName("learning-v2",true)}><Breadcrumb items={[{ label: '퀴즈 과제', href: '/quiz/assignments' }, { label: '과제' }]} />{error ? <><Alert>{error}</Alert><button className={ownedClassName("button ghost",true)} onClick={reload}>다시 불러오기</button></> : <Empty title="과제를 찾을 수 없어요" href="/quiz/assignments" label="과제 목록" />}</div>;
  const canSubmit = items.length > 0 && items.every(m => { const r = responses[m.memory_item_id] || {}; return r.cannotRecall || (r.rating && (r.response?.trim() || r.selectedOptionId || ['order', 'answer_order'].includes(m.kind))); });
  const pageTitle=schoolAssignment&&items.length===1&&assignment.title===items[0].prompt?(items[0].talent_profile?.point?.label||'학교 질문')+' 복습':assignment.title;
  return <div className={ownedClassName("learning-v2 assignment-session",true)}>
    <Breadcrumb items={[{ label: '퀴즈', href: '/quiz' }, { label: '퀴즈 과제', href: '/quiz/assignments' }, { label: assignment.title }]} />
    <PageTitle title={pageTitle} aside={<Badge tone={assignment.state === 'completed' ? 'green' : 'neutral'}>{assignmentStates[assignment.state] || '확인 중'}</Badge>}>
      {savedTarget && <>{savedTarget?.university} · {savedTarget?.department} · </>}{items.length}개 항목{assignment.due_at ? ' · ' + dateLabel(assignment.due_at) + '까지' : ''}
    </PageTitle>
    {locked&&trainingPlanId&&<TrainingContinuation planId={trainingPlanId}/>}
    {trainingPlanId&&!locked&&<div className={ownedClassName("learning-inline-links",true)}><span className={ownedClassName("muted small",true)}>오늘 계획에서 진행 중</span><Link className={ownedClassName("text-link")} href={'/my/train?planId='+encodeURIComponent(trainingPlanId)}>오늘 계획으로 돌아가기<ArrowUpRight size={16}/></Link></div>}
    {savedTarget && !targetUnchanged && <p className={ownedClassName("confirmation-review-note",true)}>당시 학교·학과의 질문과 근거로 다시 말해요. 현재 지원처의 준비 기록과 구분해 보관합니다.</p>}
    {assignment.review?.note && <p className={ownedClassName("confirmation-review-note",true)}>담당자 의견 · {assignment.review.note}</p>}
    {(error || saveError) && <Alert>{saveError || error}</Alert>}
    {assignment.state === 'assigned' ? <section className={ownedClassName("assignment-start",true)}><p className={ownedClassName(undefined,true)}>{schoolAssignment ? '학교의 기준에 연결할 내 생각이나 경험을 짧게 말해보세요.' : '정답이 있는 사실은 확인하고, 내 경험은 핵심 흐름을 되짚어보세요.'}</p><button className={ownedClassName("button primary",true)} disabled={busy} onClick={() => mutate('assignment_start')}><Play size={17} />과제 시작</button></section> : <>
      {items.map((m, index) => {
        const r = responses[m.memory_item_id] || {};
        const attempt = [...(assignment.attempts || [])].filter((a: Item) => a.memory_item_id === m.memory_item_id).sort((a: Item, b: Item) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime())[0];
        const result = attempt?.result;
        const submitted = typeof attempt?.response === 'object' && !Array.isArray(attempt.response) ? attempt.response : { response: attempt?.response };
        const isChoice = ['choice', 'concept_choice'].includes(m.kind);
        const isOrder = ['order', 'answer_order'].includes(m.kind);
        const options: any[] = m.options || [];
        const sequence: any[] = m.sequence || [];
        const submittedChoice = options.find((option, optionIndex) => itemId(option, optionIndex) === submitted.selectedOptionId);
        const submittedAnswer = result?.cannot_recall ? '기억이 안 나요' : submittedChoice ? valueText(submittedChoice) : isOrder && submitted.order?.length ? submitted.order.map((key: string) => valueText(sequence.find((v, i) => itemId(v, i) === key))).join(' → ') : Array.isArray(submitted.response) ? submitted.response.join(' → ') : submitted.response || '제출한 응답';
        const sameVersion=assignment.content_version===data.package?.active_version;
        const approvedQuestion = m.question_snapshot || (schoolAssignment ? {id:m.question_id,prompt:m.prompt,answer_elements:m.required_meaning_elements,activity_ids:m.activity_ids,source_ref_ids:m.source_ref_ids} : sameVersion ? data.learning.questions?.find((q: Item) => q.id === m.question_id) : null);
        const variations: Item[] = m.followup_questions?.length ? m.followup_questions : sameVersion ? (approvedQuestion?.followup_question_ids || []).map((questionId: string) => data.learning.questions?.find((q: Item) => q.id === questionId)).filter(Boolean) : [];
        const retryContext={target_id:assignment.target_id,content_version:assignment.content_version,source_kind:assignment.source_kind,common_revision:m.common_revision,...m};
        const snapshots=m.activity_snapshots?.length?m.activity_snapshots:m.activity_snapshot?[m.activity_snapshot]:[];
        const evidenceSnapshot={learning:{questions:[approvedQuestion,...variations].filter(Boolean),activities:snapshots,source_refs:(m.sourceQuotes||[]).map((source:Item)=>({...source,quote:source.text})),answer_scripts:[],memory_items:[]},documents:[]};
        const order: string[] = r.order || sequence.map(itemId).reverse();
        const meanings: string[] = (m.required_meaning_elements || []).map(valueText).filter(Boolean);
        const officialUrl=typeof m.source_snapshot?.url==='string' && /^https?:\/\//.test(m.source_snapshot.url)?m.source_snapshot.url:null;
        const activityUnchanged=!m.activity_ids?.length||m.activity_content_version===data.package?.active_version&&m.activity_ids.every((activityId:string)=>data.learning.activities?.some((activity:Item)=>activity.id===activityId&&['verified','approved','confirmed','synthetic_reviewed','confirmed_from_record','confirmed_by_student'].includes(activity.fact_confirmation)));
        return <section className={ownedClassName("assignment-item",true)} key={m.memory_item_id} onFocusCapture={()=>{activeItem.current=m.memory_item_id;}} onPointerDownCapture={()=>{activeItem.current=m.memory_item_id;}}>
          <div className={ownedClassName("assignment-item-label",true)}><span className={ownedClassName(undefined,true)}>{index + 1}</span><strong className={ownedClassName(undefined,true)}>{schoolAssignment ? '학교·전공 질문' : categoryNames[m.category] || kindNames[m.kind] || '자기 점검'}</strong></div>
          <h2 className={ownedClassName(undefined,true)}>{!isChoice&&!isOrder&&approvedQuestion?.prompt?approvedQuestion.prompt:m.prompt}</h2>
          {!isChoice&&!isOrder&&approvedQuestion?.prompt&&approvedQuestion.prompt!==m.prompt&&<p className={ownedClassName("assignment-response-label",true)}>{m.prompt}</p>}
          <div className={ownedClassName("assignment-evidence",true)}>{approvedQuestion&&<LearningHelp questionId={m.question_id} targetId={assignment.target_id||undefined} sourceType={schoolAssignment?'common':'personal'} sourceVersion={schoolAssignment?m.common_revision:assignment.content_version} snapshot={evidenceSnapshot} assignmentId={locked?undefined:id} itemId={locked?undefined:m.memory_item_id} openRequest={assistantRequest.itemId===m.memory_item_id?assistantRequest.token:0} onAssisted={()=>update(m,{assisted:true})}/>} {schoolAssignment&&officialUrl&&<a href={officialUrl} target="_blank" rel="noreferrer" onClick={async event=>{if(locked)return;event.preventDefault();try{await post('/api/learning',{action:'assignment_help',assignmentId:id,itemId:m.memory_item_id,helpKind:'evidence',requestId:crypto.randomUUID()});update(m,{assisted:true});window.open(officialUrl,'_blank','noopener,noreferrer');}catch(err){setSaveError((err as Error).message);}}} className={ownedClassName(undefined,true)}>공식 근거<ArrowUpRight size={15}/></a>}{locked&&(!schoolAssignment||targetUnchanged&&activityUnchanged)&&<Link href={learningRetryHref(m.question_id,retryContext)+(m.activity_ids?.[0]&&schoolAssignment?'&activityId='+encodeURIComponent(m.activity_ids[0]):'')}>면접으로 이어가기<ArrowUpRight size={15}/></Link>}</div>
          {m.kind === 'short_speech' && !locked && !r.cannotRecall && <p className={ownedClassName("assignment-response-label",true)}>말한 내용 기록</p>}
          {locked ? <div className={ownedClassName("assignment-result",true)}>
            <p className={ownedClassName("assignment-saved-answer",true)}>{submittedAnswer}</p>
            {result && <><h3 className={ownedClassName(undefined,true)}>{result.cannot_recall ? schoolAssignment ? '다시 준비할 질문이에요' : '사실 확인함에 담았어요' : result.correct === true ? '검수된 정답과 같아요' : result.correct === false ? '근거를 다시 확인해보세요' : schoolAssignment ? '내 답변을 점검했어요' : '내 경험을 점검했어요'}</h3><p className={ownedClassName(undefined,true)}>{result.feedback}</p>{result.reviewed_answer && <p className={ownedClassName("assignment-reviewed-answer",true)}>검수된 답 · {result.reviewed_answer}</p>}{result.evaluation_method === 'self_check' && result.required_meanings?.length > 0 && <div className={ownedClassName("assignment-meaning-results",true)}>{result.required_meanings.map((text: string) => <span key={text} className={ownedClassName(undefined,true)}><Check size={15} className={ownedClassName(result.checked_meanings?.includes(text) ? 'checked' : '')} />{text}{result.checked_meanings?.includes(text) ? ' · 직접 확인' : ' · 다시 확인'}</span>)}</div>}</>}
            {!!variations.length && <div className={ownedClassName("assignment-variations",true)}><h3 className={ownedClassName(undefined,true)}>이어서 답해볼 질문</h3>{variations.map(q => <Link key={q.id} href={learningRetryHref(q.id,retryContext)}>{q.prompt}<ArrowUpRight size={17} /></Link>)}</div>}
          </div> : <>
            {!r.cannotRecall && (isChoice ? <div className={ownedClassName("assignment-options",true)}>{options.map((o, i) => <button key={itemId(o, i)} disabled={busy} className={ownedClassName(r.selectedOptionId === itemId(o, i) ? 'selected' : '',true)} aria-pressed={r.selectedOptionId === itemId(o, i)} onClick={() => update(m, { selectedOptionId: itemId(o, i), response: valueText(o) })}><span className={ownedClassName(undefined,true)}>{String.fromCharCode(65 + i)}</span>{valueText(o)}</button>)}</div> : isOrder ? <ol className={ownedClassName("assignment-order",true)}>{order.map((key, position) => { const o = sequence.find((value, i) => itemId(value, i) === key); function move(direction: number) { const copy = [...order]; const other = position + direction; [copy[position], copy[other]] = [copy[other], copy[position]]; update(m, { order: copy, response: copy.map(k => valueText(sequence.find((v, i) => itemId(v, i) === k))).join(' → ') }); } return <li key={key} className={ownedClassName(undefined,true)}><span className={ownedClassName(undefined,true)}>{position + 1}</span><strong className={ownedClassName(undefined,true)}>{valueText(o)}</strong><button className={ownedClassName("icon-button",true)} disabled={busy || position === 0} onClick={() => move(-1)} aria-label={valueText(o) + ' 위로'}><ArrowUp size={17} /></button><button className={ownedClassName("icon-button",true)} disabled={busy || position === order.length - 1} onClick={() => move(1)} aria-label={valueText(o) + ' 아래로'}><ArrowDown size={17} /></button></li>; })}</ol> : <textarea aria-label={m.prompt + ' 답변'} disabled={busy} value={r.response || ''} onChange={e => update(m, { response: e.target.value })} placeholder={m.kind === 'short_speech' ? '짧게 말해본 뒤, 말한 내용을 기록해주세요' : m.category === 'factual' ? '기억나는 사실을 적어주세요' : '본인 역할과 과정을 내 말로 적어주세요'} maxLength={10000} className={ownedClassName(undefined,true)} />)}
            <label className={ownedClassName("assignment-cannot-recall",true)}><input type="checkbox" disabled={busy} checked={!!r.cannotRecall} onChange={e => update(m, { cannotRecall: e.target.checked })} className={ownedClassName(undefined,true)} />{schoolAssignment ? '답변이 떠오르지 않아요 · 다시 준비' : '기억이 안 나요 · 사실 확인함에 남기기'}</label>
            {!r.cannotRecall && <div className={ownedClassName("assignment-self-check",true)}>{meanings.length > 0 && <><h3 className={ownedClassName(undefined,true)}>내가 설명한 요소</h3><div className={ownedClassName("assignment-meaning-checks",true)}>{meanings.map(text => <label key={text} className={ownedClassName(undefined,true)}><input type="checkbox" disabled={busy} checked={(r.checked || []).includes(text)} onChange={e => update(m, { checked: e.target.checked ? [...(r.checked || []), text] : (r.checked || []).filter((value: string) => value !== text) })} className={ownedClassName(undefined,true)} />{text}</label>)}</div></>}<fieldset className={ownedClassName("assignment-rating",true)}><legend className={ownedClassName(undefined,true)}>다시 설명할 수 있나요?</legend>{[['again', '다시 준비'], ['hard', '어려웠어요'], ['good', '설명할 수 있어요'], ['easy', '도움 없이 가능해요']].map(([value, label]) => <label key={value} className={ownedClassName(undefined,true)}><input type="radio" name={'rating-' + m.memory_item_id} disabled={busy} checked={r.rating === value} onChange={() => update(m, { rating: value })} className={ownedClassName(undefined,true)} />{label}</label>)}</fieldset></div>}
          </>}
        </section>;
      })}
      <div className={ownedClassName("assignment-bottom-actions",true)}>{locked ? <><button className={ownedClassName("button primary",true)} disabled={busy} onClick={() => mutate('assignment_retry')}><RotateCcw size={16} />다시 말하기 과제</button><Link className={ownedClassName("button ghost")} href={schoolAssignment ? '/reports' : '/account/confirmations'}>{schoolAssignment ? '답변 변화 보기' : '사실 확인함'}</Link></> : <button className={ownedClassName("button primary",true)} disabled={busy || !canSubmit} onClick={submit}>{busy ? '제출 중' : '과제 제출'}<Check size={17} /></button>}<Link className={ownedClassName("text-link")} href="/quiz/assignments">과제 목록</Link></div>
    </>}
  </div>;
}




