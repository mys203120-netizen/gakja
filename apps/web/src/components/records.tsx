'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useApp } from './app-shell';
import { RecordMedia } from './record-media';
import { SpeechGrowth } from './speech-growth';
import { growthContextResolver } from '@/lib/learning-growth';
import { materialComparisonVersions } from '@/lib/material-learning-flow';
import { ComparisonObservation } from './comparison-observation';
import { MarkdownMessage } from './markdown-message';
import { ComparisonWipe } from './comparison-wipe';
import { useLearningWorkflows } from './practice';
import { finishStudySession } from './study-session-provider';
import { learningRetryHref } from '@/lib/learning-navigation';
import { studyAnswerComparisonHref, studyWeakPointHref } from '@/lib/study-record-links';
import { koreaToday } from '@/lib/planner-model';
import { action, api, post, PageTitle, Breadcrumb, Badge, Empty, LinkedRow, Alert, Spinner, dateLabel, type Item } from './shared';
import { Mic, MessagesSquare, Sparkles, ArrowUpRight, RotateCcw, ListChecks } from 'lucide-react';
import styles from './learning-surfaces.module.css';

function useStudyReports(id?:string) {
  const [reports,setReports]=useState<Item|null>(null),[error,setError]=useState('');
  const reload=useCallback(async()=>{
    try {setReports(await api('/api/study-sessions'+(id?'?id='+encodeURIComponent(id):''),{cache:'no-store'}));setError('');}
    catch(err) {setError((err as Error).message);}
  },[id]);
  useEffect(()=>{
    void reload();const update=()=>{if(document.visibilityState==='visible')void reload();};
    const timer=setInterval(update,30_000);window.addEventListener('gakja:study-session',update);window.addEventListener('focus',update);
    return()=>{clearInterval(timer);window.removeEventListener('gakja:study-session',update);window.removeEventListener('focus',update);};
  },[reload]);
  return {reports,error,reload};
}

function ReportNav({active='reports'}:{active?:string}) {
  return <nav className="subnav" aria-label="리포트 보기">{[['reports','/records','발화와 답변'],['history','/records/history','연습 이력'],['comparisons','/records/comparisons','답변 비교']].map(([key,href,label])=><Link key={key} href={href} className={active===key?'active':''} aria-current={active===key?'page':undefined}>{label}</Link>)}</nav>;
}

function StudyReportNumbers({report,showReview=true}:{report:Item;showReview?:boolean}) {
  return <div className="records-overview">
    {[{label:'퀴즈 문항',value:report.quiz?.answered||0,unit:'문항'},{label:'면접 답변',value:report.interviews?.answered||0,unit:'개'},...(showReview?[{label:'다시 볼 질문',value:report.weakPoints?.length||0,unit:'개'}]:[])].map(item=><div key={item.label}><span>{item.label}</span><strong>{item.value}<small>{item.unit}</small></strong></div>)}
  </div>;
}

export function RecordsPages({ slug = [] }: { slug?: string[] }) {
  const { data,targetId } = useApp();
  const {reports,error,reload}=useStudyReports();
  const [finishing,setFinishing]=useState(false),[finishError,setFinishError]=useState('');
  const [exporting,setExporting]=useState(false);
  async function exportRecords() {
    setExporting(true);setFinishError('');
    try {
      const answers = await api('/api/learning',{cache:'no-store'});
      const blob = new Blob([JSON.stringify({exportedAt:new Date().toISOString(),studyHistory:reports?.history||[],studyReports:reports?.sessions||[],answers:answers.versions||[],interviewReports:data.reports||[]},null,2)],{type:'application/json;charset=utf-8'});
      const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='각자ON-내학습기록-'+koreaToday()+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch(err){setFinishError((err as Error).message);}finally{setExporting(false);}
  }
  async function finish() {
    if(finishing||!reports?.current)return;setFinishing(true);setFinishError('');
    try {await finishStudySession('manual',reports.current.id);await reload();}
    catch(err){setFinishError((err as Error).message);}finally{setFinishing(false);}
  }
  if (slug[0] === 'comparisons') return <AnswerComparisons questionId={slug[1]} />;
  if (slug[0] === 'reports' && slug[1]) return <Report key={slug[1]} id={slug[1]} />;
  if (slug[0] === 'sessions' && slug[1]) return <StudyReport key={slug[1]} id={slug[1]} />;
  const history = slug[0] === 'history';
  const memoryHistory = (data.memoryHistory || data.memoryAttempts)?.slice(0, 30) || [];
  return <div className={"records-view "+styles.report}>
    <Breadcrumb items={[{ label: '내 리포트', href: slug.length ? '/reports' : undefined }, ...(history ? [{ label: '연습 이력' }] : [])]} />
    <PageTitle title={history ? '연습 이력' : '내 리포트'} aside={<button className="button ghost" onClick={exportRecords} disabled={exporting||!reports}>{exporting?'내보내는 중':'내 기록 내보내기'}</button>} />
    <ReportNav active={history?'history':'reports'} />
    {(error||finishError)&&<Alert>{finishError||error}</Alert>}
    {history ? <>
      {!!reports?.history?.length&&<section className="records-history-section"><h2>최근 학습</h2>{[...reports.history].reverse().slice(0,50).map((event:Item)=><StudyAnswer key={event.id} event={event}/>)}</section>}
      {!reports?.history?.length&&<>
      <div className="records-overview">
        {[{ label: '면접 연습', value: data.interviews?.length || 0, unit: '회' }, { label: '키워드 회상', value: data.memoryAttempts?.length || 0, unit: '회' }, { label: '나의 답변', value: new Set(data.answers.map(a => a.question_id)).size, unit: '개' }].map(s => <div key={s.label}><span>{s.label}</span><strong>{s.value}<small>{s.unit}</small></strong></div>)}
      </div>
      {!!data.interviews?.length && <section className="records-history-section">
        <h2>면접 연습</h2>
        {data.interviews.map(i => <LinkedRow key={i.id} href={'/interview/' + i.id} title={i.kind === 'video' ? '화상 모의면접' : '채팅 모의면접'} subtitle={dateLabel(i.created_at)} end={<Badge tone={i.state === 'completed' ? 'green' : 'neutral'}>{i.state === 'completed' ? '완료' : i.state === 'cancelled' ? '취소' : '진행 중'}</Badge>}><span className="records-row-icon">{i.kind === 'video' ? <Mic size={22} strokeWidth={1.5} /> : <MessagesSquare size={22} strokeWidth={1.5} />}</span></LinkedRow>)}
      </section>}
      {!!memoryHistory.length && <section className="records-history-section">
        <h2>암기 복습</h2>
        {memoryHistory.map((a: Item) => {
          const memory = data.learning.memory_items.find((m: Item) => m.id === a.memory_item_id);
          const question = data.learning.questions.find((q: Item) => q.id === memory?.question_id);
          const title = memory && ['keyword_recall', 'order', 'answer_order'].includes(memory.kind)
            ? question?.prompt || memory.prompt
            : memory?.prompt || '암기 훈련';
          return <LinkedRow key={a.id} href={'/practice/memory/' + a.memory_item_id} title={title} subtitle={dateLabel(a.created_at)} end={<Badge>{a.rating === 'again' ? '다시 준비' : '복습 기록'}</Badge>}><span className="records-row-icon"><Sparkles size={22} strokeWidth={1.5} /></span></LinkedRow>;
        })}
      </section>}
      {!data.interviews?.length && !data.memoryAttempts?.length && <Empty title="아직 훈련 기록이 없어요" href="/practice" label="훈련 시작" />}
      </>}
    </> : <>
      <SpeechGrowth currentContext={{targetId,contentVersion:Number(data.package?.active_version||0),questions:data.learning?.questions||[],targets:data.targets||[]}}/>
      {!!reports?.totals?.eventCount&&<>
        <details className="speech-activity-details"><summary>함께 쌓인 학습 기록</summary><section className="study-total"><StudyReportNumbers report={reports!.totals} showReview={false}/><div className="study-facts">{[{label:'암기 복습',value:reports.totals.memory?.reviewed},{label:'과제 답변',value:reports.totals.assignments?.submitted},{label:'시청 체크',value:reports.totals.knowledge?.completed},{label:'영상 메모',value:reports.totals.knowledge?.reflections}].filter(item=>item.value>0).map(item=><span key={item.label}>{item.label} {item.value}개</span>)}</div></section></details>
      </>}
      {!!reports?.current?.report?.eventCount&&<section className="study-current"><div className="section-heading"><h2>이번 학습</h2><Badge tone="green">자동 저장 중</Badge></div><div className="study-report-actions"><Link className="text-link" href={'/reports/sessions/'+reports.current.id}>진행 기록 보기<ArrowUpRight size={17}/></Link><button className="button secondary" onClick={finish} disabled={finishing}>{finishing?'저장하는 중':'학습 마치기'}</button></div></section>}
      {!!reports?.sessions?.length&&<section className="records-history-section"><h2>학습 리포트</h2><div className="records-report-list">{reports.sessions.map((session:Item)=><Link className="records-report-row" key={session.id} href={'/reports/sessions/'+session.id}><span className="records-row-icon"><ListChecks size={25}/></span><div><h2>{dateLabel(session.started_at)} 학습</h2><p>그날 남긴 답변과 연습 기록</p></div><ArrowUpRight size={22} strokeWidth={1.5}/></Link>)}</div></section>}
      {!!data.reports?.length&&<section className="records-history-section"><h2>모의면접 피드백</h2><div className="records-report-list">
      {data.reports.map(r => <Link className="records-report-row" key={r.id} href={'/reports/reports/' + r.id}>
        <span className="records-row-icon">{r.data?.kind === 'video' ? <Mic size={26} strokeWidth={1.5} /> : <MessagesSquare size={26} strokeWidth={1.5} />}</span>
        <div><h2>{r.data?.kind === 'video' ? '화상' : '채팅'} 모의면접</h2><p>{dateLabel(r.created_at)}</p></div>
        <ArrowUpRight size={22} strokeWidth={1.5} />
      </Link>)}
    </div></section>}
    {!reports&&!error&&<Spinner/>}
    </>}
  </div>;
}

function StudyReport({id}:{id:string}) {
  const {reports,error}=useStudyReports(id),session=reports?.session,report=session?.report;
  const events:Item[]=reports?.sourceFacts||report?.events||[];
  return <div className={"records-view study-report-view "+styles.report}><Breadcrumb items={[{label:'내 리포트',href:'/reports'},{label:'학습 상세'}]}/><PageTitle title={session?dateLabel(session.started_at)+' 학습 리포트':'학습 리포트'} aside={session&&<Badge tone={session.state==='active'?'green':'neutral'}>{session.state==='active'?'자동 저장 중':'학습 완료'}</Badge>}/>
    {error&&<Alert>{error}</Alert>}
    {!reports&&!error?<Spinner/>:session&&<>
      <p className="study-period">{sessionTime(session.started_at)}{session.ended_at&&' — '+sessionTime(session.ended_at)}</p><SpeechGrowth studySessionId={id}/><details className="speech-activity-details"><summary>학습 활동 수</summary><StudyReportNumbers report={report}/></details>
      {!!report.quiz?.answered&&<section className="report-feedback-section"><h2>퀴즈</h2><div className="study-facts"><span>선택형 {report.quiz.choice}개</span><span>주관식 {report.quiz.written}개</span><span>녹음 답변 {report.quiz.oral}개</span><span>정답 {report.quiz.correct}개</span><span>오답 {report.quiz.wrong}개</span><span>채점하지 않은 답변 {report.quiz.ungraded}개</span><span>시간 초과 {report.quiz.timedOut}개</span></div></section>}
      {!!report.interviews?.answered&&<section className="report-feedback-section"><h2>모의면접</h2><div className="study-facts"><span>Chat 답변 {report.interviews.chat}개</span><span>Live 답변 {report.interviews.live}개</span>{report.interviews.assisted>0&&<span>도움을 받은 답변 {report.interviews.assisted}개</span>}</div></section>}
      {!!(report.memory?.reviewed||report.assignments?.submitted||report.knowledge?.updates)&&<section className="report-feedback-section"><h2>함께 한 학습</h2><div className="study-facts"><span>암기 복습 {report.memory?.reviewed||0}개</span><span>과제 답변 {report.assignments?.submitted||0}개</span><span>영상 기록 {report.knowledge?.updates||0}개</span></div></section>}
      {!!report.weakPoints?.length&&<section className="records-history-section"><h2>다시 볼 질문</h2>{report.weakPoints.map((point:Item,index:number)=><LinkedRow key={point.memoryItemId||point.questionId||index} href={studyWeakPointHref(point)} title={point.prompt||'퀴즈 질문'} end={<span className="muted">{[point.wrong>0?'오답 '+point.wrong+'회':'',point.timedOut>0?'시간 초과 '+point.timedOut+'회':''].filter(Boolean).join(' · ')}</span>}/>)}</section>}
      <section className="records-history-section"><h2>저장한 답변</h2>{events.map((event:Item)=><StudyAnswer key={event.id} event={event}/>)}{!events.length&&<Empty title="아직 저장한 답변이 없어요" href="/quiz" label="퀴즈 시작"/>}</section>
    </>}
  </div>;
}
function sessionTime(value:string) {return new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value));}
function StudyAnswer({event}:{event:Item}) {
  const value=event.data||{},quiz=event.kind==='quiz_response';
  const knowledge=event.kind==='knowledge_progress',memory=event.kind==='memory_review',assignment=event.kind==='assignment_submission';
  const state=quiz||memory||assignment?(value.timedOut===true?'시간 초과':value.outcome===true?'검수 정답':value.outcome===false?'오답':value.mode==='oral'?'녹음 답변':'미채점 답변'):knowledge?'직접 남긴 기록':value.kind==='video'||value.kind==='live'?'Live':'Chat';
  const text=typeof(value.response||value.answer)==='string'?value.response||value.answer:Array.isArray(value.response)?value.response.join(' · '):'';
  const audioId=typeof value.audioId==='string'&&/^[0-9a-f-]{36}$/i.test(value.audioId)?value.audioId:'';
  return <article className="study-answer"><div className="section-heading"><span className="muted">{quiz?'Quiz':memory?'암기 복습':assignment?'과제':knowledge?'지식한입':'모의면접'} · {sessionTime(event.created_at)}{event.historical&&' · 이전 기록'}</span><Badge tone={value.outcome===true?'green':'neutral'}>{state}</Badge></div><h3>{value.prompt||value.question||value.title||'저장한 학습'}</h3>{text&&<p>{text}</p>}{value.reflection&&<p>{value.reflection}</p>}{value.explanation&&<p>{value.explanation}</p>}{knowledge&&value.completed===true&&<p className="muted">시청했다고 직접 체크했어요.</p>}{quiz&&audioId&&<audio controls preload="none" src={'/api/quiz?recordingId='+encodeURIComponent(audioId)} aria-label="내 녹음 답변"/>}{(value.hintUsed||value.assisted)&&<p className="muted">도움을 사용한 답변</p>}{value.timedOut===true&&<span className="muted">시간 초과</span>}{value.sessionId&&<Link className="text-link" href={'/interview/'+value.sessionId}>면접 기록<ArrowUpRight size={16}/></Link>}{value.questionId&&<Link className="text-link" href={studyAnswerComparisonHref(value.questionId,value,event.kind==='interview_answer'?event.source_id:undefined)}>이 질문의 답변 비교<ArrowUpRight size={16}/></Link>}</article>;
}

function Report({ id }: { id: string }) {
  const { data, toast } = useApp();
  const router = useRouter();
  const {workflows,reload}=useLearningWorkflows();
  const initial = data.reports.find(r => r.id === id);
  const [report, setReport] = useState<Item | null>(initial ? { ...initial, ...initial.data } : null);
  const [error, setError] = useState('');
  const [retraining, setRetraining] = useState('');
  const sending = useRef(false);
  const requestIds = useRef<Item>({});
  useEffect(() => { if (initial) setReport({ ...initial, ...initial.data }); }, [initial]);
  if (!report) return <Empty title="리포트를 찾을 수 없어요" />;
  const sections: Item[] = report.sections || [];
  const experienceCard=report.experienceCard||data.interviews?.find(session=>session.id===report.session_id)?.data?.experienceCard;
  async function retrain(questionId: string) {
    if (sending.current) return;
    sending.current = true; setRetraining(questionId); setError('');
    requestIds.current[questionId] ||= crypto.randomUUID();
    try {
      const result = await post('/api/learning', { action: 'assignment_create', questionId, reportId: id, title: '면접 후 다시 말하기', requestId: requestIds.current[questionId] });
      if (result.assignment?.id) router.push('/practice/assignments/' + result.assignment.id);
      else { toast('재훈련 과제를 만들었어요.'); router.push('/practice/assignments'); }
      requestIds.current[questionId] = '';
    } catch (err) { setError((err as Error).message); }
    finally { sending.current = false; setRetraining(''); }
  }
  return <div className={"records-view report-view "+styles.report}>
    <Breadcrumb items={[{ label: '내 리포트', href: '/reports' }, { label: '면접 피드백' }]} />
    <PageTitle title={(report.kind === 'video' ? '화상' : '채팅') + ' 면접 리포트'} />
    {error && <Alert>{error}</Alert>}
    <div className="report-summary"><span>{dateLabel(report.created_at)}</span></div>
    {data.interviews?.find(session=>session.id===report.session_id)?.data?.experienceCard && <section className="detail-section"><h2>이 경험을 더 다듬어볼까?</h2><p>이번 답변과 피드백을 보고, 내 행동과 배운 점을 보완해 보세요.</p><Link className="button ghost" href={'/armory?card='+data.interviews.find(session=>session.id===report.session_id)!.data.experienceCard.id}>무기고에서 경험 보완하기</Link></section>}
    <SpeechGrowth reportId={id}/>
    {report.session_id && <RecordMedia sessionId={report.session_id} />}
    {report.aiFeedback && <section className="report-feedback-section"><h2>AI 피드백</h2><p className="muted small">표현 제안은 내 답변·원문과 확인해 사용해 주세요. 내가 하지 않은 행동은 답변에 넣지 않아요.</p><MarkdownMessage content={report.aiFeedback.content}/></section>}
    {report.aiStatus !== 'completed' && <div className="inline-notice">내용 피드백 {report.aiStatus === 'failed' ? '처리 실패' : '대기'} · 아래 기록으로 직접 점검할 수 있어요.</div>}
    {sections.map((s, i) => <section className="report-section" key={s.turnId || i}>
      <span className="question-index">질문 {i + 1}</span>
      <h2>{s.question}</h2>
      <div className="report-answer"><h3>내 답변</h3><p>{s.answer || s.response}</p></div>
      {(s.answerElements || s.answer_elements || s.expectedElements || []).length>0&&<div className="report-elements"><h3>답변 요소</h3><div className="tag-list">{(s.answerElements || s.answer_elements || s.expectedElements || []).map((k: string) => <span key={k}>{k}</span>)}</div></div>}
      {s.turnId&&<AnswerMeaningChecks version={workflows?.versions?.find((version:Item)=>version.turn_id===s.turnId&&version.script===(s.answer||s.response))} onSaved={reload}/>}
      {s.questionId&&!s.questionId.startsWith('briefing_')&&<div className="learning-inline-links report-retry-actions"><Link className="button primary" href={learningTodayHref(s.questionId,{experienceCard,content_version:report.contentVersion,source_type:s.sourceType,target_id:report.targetId,common_revision:s.commonRevision})}>다음 학습 이어서<ArrowUpRight size={17}/></Link><Link className="text-link report-retry" href={interviewRetryHref(s.questionId,{experienceCard,content_version:report.contentVersion,source_type:s.sourceType,target_id:report.targetId,common_revision:s.commonRevision})}>이 질문 다시 말하기<ArrowUpRight size={17}/></Link><Link className="text-link" href={'/records/comparisons/' + encodeURIComponent(s.questionId)+(report.targetId?'?targetId='+encodeURIComponent(report.targetId)+(s.turnId?'&turnId='+encodeURIComponent(s.turnId):''):s.turnId?'?turnId='+encodeURIComponent(s.turnId):'')}>답변 비교<ArrowUpRight size={17}/></Link><button className="button ghost" disabled={!!retraining} onClick={()=>retrain(s.questionId)}><RotateCcw size={16}/>{retraining===s.questionId?'과제 만드는 중':'재훈련 과제로 담기'}</button></div>}
    </section>)}
    {report.observations && report.observations.status !== 'not_measured' && <section className="report-feedback-section"><h2>발화 관찰</h2><p className="muted">{JSON.stringify(report.observations)}</p></section>}
    <Link className="button primary report-new-session" href="/interview/new">새 면접 연습<ArrowUpRight size={17} /></Link>
  </div>;
}

function comparisonDate(value: string) {
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
}

function answerVersionLabel(version: Item) {
  return ({transcript_correction:'발화 기록 정정',interview_answer:'면접에서 한 답변',quiz_answer:'Q&A 답변',quiz_oral:'퀴즈 녹음',assignment_answer:'과제 답변'} as Record<string,string>)[version.revision_kind]||'작성한 답변';
}
function interviewRetryHref(questionId:string,version:Item) {
  return learningRetryHref(questionId,version);
}
function learningTodayHref(questionId:string,version:Item) {
  return learningRetryHref(questionId,version).replace(/^\/interview\/new\?/,'/my/today?');
}
function AnswerMeaningChecks({version,onSaved}:{version?:Item;onSaved:()=>unknown|Promise<unknown>}) {
  const [checked,setChecked]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const sending=useRef(false);
  const required:string[]=(version?.comparison?.required_meanings||[]).map((meaning:any)=>typeof meaning==='string'?meaning:meaning.text).filter(Boolean);
  const savedKey=JSON.stringify(version?.self_checked_meanings||[]);
  useEffect(()=>{setChecked(version?.self_checked_meanings||[]);setError('');},[version?.id,savedKey]);
  if(!version||!required.length)return null;
  async function change(text:string,value:boolean){
    if(sending.current||!version)return;
    sending.current=true;setBusy(true);setError('');
    const next=value?[...checked,text]:checked.filter(item=>item!==text);
    try{await post('/api/learning',{action:'answer_meaning_check',versionId:version.id,checkedMeanings:next,requestId:crypto.randomUUID()});setChecked(next);await onSaved();}
    catch(err){setError((err as Error).message);}
    finally{sending.current=false;setBusy(false);}
  }
  return <fieldset className="comparison-meaning-checks"><legend>이 답변에서 직접 확인한 요소</legend>{required.map(text=><label key={text}><input type="checkbox" checked={checked.includes(text)} disabled={busy} onChange={event=>void change(text,event.target.checked)}/>{text}</label>)}<p className="muted">이 답변에 남기는 자기 점검이에요.{busy?' 저장 중…':version.self_checked_at?' 저장됨':''}</p>{error&&<Alert>{error}</Alert>}</fieldset>;
}
function ComparisonAnswer({value,hideScript=false}:{value:Item;hideScript?:boolean}) {
  return <>{value.target_snapshot&&<p className="muted comparison-school-context">{[value.target_snapshot.university,value.target_snapshot.department||value.target_snapshot.major].filter(Boolean).join(" · ")}</p>}<div className="comparison-evidence"><span>{comparisonDate(value.created_at)}</span>{value.hint_used?<Badge>힌트 사용{value.ai_assisted?' · AI 도움':''}</Badge>:value.assisted?<Badge>도움 사용</Badge>:<Badge>{value.assistance_recorded===true?'도움 기록 없음':'도움 여부 미기록'}</Badge>}{value.evaluation_method==='ungraded'&&<Badge>미채점</Badge>}{value.practice_kind==='concept'&&<Badge>개념 설명</Badge>}{value.practice_label&&<Badge>{value.practice_label}</Badge>}</div>{value.structure&&<div className="comparison-structure"><h4>답변 설계</h4><p>{value.structure}</p></div>}{!hideScript&&<p className="comparison-answer">{value.script||(value.audio_id?'텍스트 전사 없이 녹음으로 남긴 답변이에요.':'발화본 없이 설계만 저장한 답변이에요.')}</p>}{value.audio_id&&<audio className="comparison-audio" controls preload="none" src={'/api/quiz?recordingId='+encodeURIComponent(value.audio_id)} aria-label="이 시점의 녹음 답변"/>}{value.source_status==='unavailable'&&<p className="muted">이 답변의 당시 자료 버전은 확인되지 않아요.</p>}</>;
}

function AnswerComparisons({ questionId }: { questionId?: string }) {
  const { data } = useApp();
  const params = useSearchParams();
  const requested = questionId || params.get('questionId') || '';
  const { workflows, loading, error, reload } = useLearningWorkflows();
  const [selectedQuestion, setSelectedQuestion] = useState(requested);
  const [leftId, setLeftId] = useState('');
  const [rightId, setRightId] = useState('');
  const [viewMode, setViewMode] = useState<'columns'|'wipe'>('columns');
  const [selectedContext,setSelectedContext]=useState('');
  const comparisonTarget=params.get('targetId'),comparisonSource=params.get('sourceType'),comparisonVersion=params.get('sourceVersion');
  const versions: Item[] = materialComparisonVersions(workflows?.versions || [],{targetId:comparisonTarget,sourceType:comparisonSource,sourceVersion:comparisonVersion});
  const questionIds = [...new Set<string>(versions.map(v => v.question_id))];
  const selected = selectedQuestion || questionIds[0] || '';
  const matching=versions.filter(v=>v.question_id===selected);
  const resolveContext=growthContextResolver(matching as any);
  const versionContext=(version:Item)=>resolveContext(version as any)+'|'+(version.practice_kind==='concept'?'concept':'answer');
  const contexts=[...new Set(matching.map(versionContext))];
  const anchor=matching.find(version=>version.turn_id===params.get('turnId'));
  const comparisonContext=contexts.includes(selectedContext)?selectedContext:anchor?versionContext(anchor):contexts[0];
  const current = matching.filter(v=>versionContext(v)===comparisonContext).sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || a.revision - b.revision);
  const left = current.find(v => v.id === leftId) || current[0];
  const right = current.find(v => v.id === rightId) || current[current.length - 1];
  const canWipe = typeof left?.script === 'string' && !!left.script.trim() && typeof right?.script === 'string' && !!right.script.trim();
  const wipeMode = viewMode === 'wipe' && canWipe;
  const question = data.learning.questions?.find((q: Item) => q.id === selected);
  const questionPrompt = right?.question || left?.question || question?.prompt || '나의 답변';
  useEffect(() => { setSelectedQuestion(requested); }, [requested]);
  useEffect(() => { setSelectedContext(''); }, [selected,comparisonTarget,comparisonSource,comparisonVersion]);
  useEffect(() => { setLeftId(''); setRightId(''); setViewMode('columns'); }, [selected,comparisonTarget,comparisonSource,comparisonVersion,comparisonContext]);
  return <div className="learning-v2 answer-comparisons">
    <Breadcrumb items={[{ label: '내 리포트', href: '/records' }, { label: '답변 비교' }]} />
    <PageTitle title="답변 비교" />
    <ReportNav active="comparisons" />
    {error && <><Alert>{error}</Alert><button className="button ghost" onClick={reload}>다시 불러오기</button></>}
    {loading && !workflows ? <Spinner /> : !versions.length ? !error && <Empty title={comparisonTarget||comparisonSource||comparisonVersion?'선택한 학습 맥락에 저장한 답변이 없어요':'저장한 답변이 없어요'} href="/materials/answers" label="답변 초안 작성" /> : <>
      <label className="comparison-question-select">비교할 질문<select value={selected} onChange={e => setSelectedQuestion(e.target.value)}>{requested && !questionIds.includes(requested) && <option value={requested}>{question?.prompt || '선택한 질문'}</option>}{questionIds.map(id => <option key={id} value={id}>{data.learning.questions?.find((q: Item) => q.id === id)?.prompt || versions.find(v => v.question_id === id)?.question || '저장된 질문'}</option>)}</select></label>
      {contexts.length>1&&<label className="comparison-question-select">연습한 지원처<select aria-label="비교할 연습 맥락" value={comparisonContext} onChange={e=>setSelectedContext(e.target.value)}>{contexts.map(key=>{const group=matching.filter(v=>versionContext(v)===key),latest=group[0];return <option key={key} value={key}>{[latest.target_snapshot?.university,latest.target_snapshot?.department||latest.target_snapshot?.major,latest.target_snapshot?.admission_year&&latest.target_snapshot.admission_year+'학년도'].filter(Boolean).join(' · ')||'지원처 정보 없는 기록'} · {comparisonDate(latest.created_at)}</option>;})}</select></label>}
      {!current.length ? <Empty title="이 질문에 저장한 답변이 없어요" href={question ? '/materials/answers/' + selected : '/records'} label={question ? '답변 작성' : '면접 리포트'} /> : current.length < 2 ? <><section className="comparison-single"><h2 data-question-key={selected}>{questionPrompt}</h2><span className="muted">{answerVersionLabel(right)}</span><ComparisonAnswer value={right}/></section><p className="comparison-notice">답변을 한 번 더 남기면 이전 기록과 비교할 수 있어요.</p>{right.source_status==='saved'?<Link className="button primary" href={interviewRetryHref(selected,right)}>이 질문 다시 말하기<ArrowUpRight size={17}/></Link>:right.session_id&&<Link className="button primary" href={'/interview/'+right.session_id}>면접 기록 보기<ArrowUpRight size={17}/></Link>}</> : <>
        <h2 className="comparison-prompt" data-question-key={selected}>{questionPrompt}</h2>
        <p className="comparison-notice">같은 질문에 남긴 실제 답변이에요. 핵심 내용과 근거가 어떻게 달라졌는지 비교해 보세요.</p>
        <div className="comparison-view-switch" role="group" aria-label="답변 비교 보기 방식"><button type="button" aria-pressed={!wipeMode} onClick={()=>setViewMode('columns')}>나란히 보기</button><button type="button" aria-pressed={wipeMode} disabled={!canWipe} title={!canWipe?'두 답변에 텍스트가 필요해요.':undefined} onClick={()=>setViewMode('wipe')}>겹쳐 보기</button></div>
        <div className={'comparison-columns'+(wipeMode?' comparison-wipe-metadata':'')}>{[{ label: '먼저 볼 답변', value: left, set: setLeftId }, { label: '함께 볼 답변', value: right, set: setRightId }].map(column => <section key={column.label}>
          <div className="comparison-column-heading"><h3>{answerVersionLabel(column.value)}</h3><select aria-label={column.label + ' 저장 시점'} value={column.value.id} onChange={e => { column.set(e.target.value); }}>{current.map(v => <option key={v.id} value={v.id}>{answerVersionLabel(v)} · {comparisonDate(v.created_at)}</option>)}</select></div>
          <ComparisonAnswer value={column.value} hideScript={wipeMode}/>
        </section>)}</div>
        {wipeMode&&<ComparisonWipe key={left.id+'|'+right.id} previous={left.script} current={right.script} previousLabel={answerVersionLabel(left)+' · '+comparisonDate(left.created_at)} currentLabel={answerVersionLabel(right)+' · '+comparisonDate(right.created_at)}/>}
        <ComparisonObservation before={left as any} after={right as any}/>
        <AnswerMeaningChecks version={right} onSaved={reload}/>
        <div className="learning-inline-links"><Link className="button primary" href={learningTodayHref(selected,{...right,target_id:right.target_id||comparisonTarget})}>다음 학습 이어서<ArrowUpRight size={17}/></Link>{right.source_status==='saved'&&<Link className="text-link" href={interviewRetryHref(selected,right)}>이 질문 다시 말하기<ArrowUpRight size={17}/></Link>}{question?<><Link className="text-link" href={'/materials/answers/' + selected}>답변 수정<ArrowUpRight size={16}/></Link><Link className="text-link" href={'/materials/questions/' + selected}>질문과 근거<ArrowUpRight size={16}/></Link></>:right.session_id&&<Link className="text-link" href={'/interview/'+right.session_id}>면접 기록 보기<ArrowUpRight size={17}/></Link>}</div>
      </>}
    </>}
  </div>;
}


