'use client';
import {ownedClassName} from './owned-class-name';


import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {useRecordPages,useRecordDetail} from './use-record-pages';
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
import { Mic, MessagesSquare, Sparkles, ArrowUpRight, RotateCcw, ListChecks, Download, LoaderCircle } from 'lucide-react';
import styles from './learning-surfaces.module.css';
import toolbarStyles from './records-toolbar.module.css';

function useStudyReports(id?:string) {
  const {data}=useApp(),identity=data.user.id+':'+(id||'all');
  const [reportIdentity,setReportIdentity]=useState('');
  const [reports,setReports]=useState<Item|null>(null),[error,setError]=useState(''),[loadingMore,setLoadingMore]=useState('');
  const generation=useRef(0);
  const reload=useCallback(async(preservePages=false)=>{
    const request=++generation.current;try {const result=await api('/api/study-sessions'+(id?'?id='+encodeURIComponent(id):''),{cache:'no-store'});if(request===generation.current){setReports(previous=>{if(!preservePages||!previous)return result;const merge=(name:string)=>(previous[name]?.length||0)>(result[name]?.length||0)?{[name]:[...(result[name]||[]),...(previous[name]||[]).filter((row:Item)=>!result[name]?.some((item:Item)=>item.id===row.id))],[name+'Page']:previous[name+'Page']}:{ };return {...result,...merge('history'),...merge('sessions')};});setReportIdentity(identity);setError('');}}
    catch(err) {if(request===generation.current){setReportIdentity(identity);setError((err as Error).message);}}
  },[id,identity]);
  useEffect(()=>{
    void reload();const update=()=>{if(document.visibilityState==='visible')void reload(true);};
    const timer=setInterval(update,30_000);window.addEventListener('gakja:study-session',update);window.addEventListener('focus',update);
    return()=>{generation.current++;clearInterval(timer);window.removeEventListener('gakja:study-session',update);window.removeEventListener('focus',update);};
  },[reload]);
  async function more(view:'history'|'sessions'){const cursor=reports?.[view+'Page']?.nextCursor;if(!cursor||loadingMore)return;const request=generation.current;setLoadingMore(view);try{const result=await api('/api/study-sessions?view='+view+'&cursor='+encodeURIComponent(cursor));if(request===generation.current)setReports(previous=>previous?{...previous,[view]:[...(previous[view]||[]),...(result[view]||[])].filter((row,index,all)=>all.findIndex(item=>item.id===row.id)===index),[view+'Page']:result[view+'Page']||result.page}:previous);}catch(error){if(request===generation.current)setError((error as Error).message);}finally{setLoadingMore('');}}
  return {reports:reportIdentity===identity?reports:null,error:reportIdentity===identity?error:'',reload,more,loadingMore};
}

function ReportNav({active='reports'}:{active?:string}) {
  return <nav className={ownedClassName(`subnav ${toolbarStyles.mobileReportNavigation}`,true)} data-mobile-child={active!=='reports'||undefined} aria-label="리포트 보기">{[['reports','/records','발화와 답변'],['history','/records/history','연습 이력'],['comparisons','/records/comparisons','답변 비교']].map(([key,href,label])=><Link key={key} href={href} className={ownedClassName(active===key?'active':'')} aria-current={active===key?'page':undefined}>{label}</Link>)}</nav>;
}
function interviewLabel(session?:Item){const kind=session?.data?.trainingPurpose;return ({diagnostic:'첫 진단',recall:'누적 복습',focus:'집중 보완',mixed:'연결 면접'} as Record<string,string>)[kind]||(session?.kind==='video'?'화상 모의면접':'채팅 모의면접');}

function useLearningHistory(scope:string,owner:string){
 const identity=owner+'|'+scope;
 const [state,setState]=useState<{scope:string;workflows:Item|null;loading:boolean;error:string}>({scope:'',workflows:null,loading:true,error:''});
 const generation=useRef(0),flight=useRef(false);
 const load=useCallback(async(cursor?:string)=>{if(flight.current)return;flight.current=true;const request=++generation.current;setState(previous=>({scope:identity,workflows:previous.scope===identity?previous.workflows:null,loading:true,error:''}));try{const result=await api('/api/learning?view=history'+(scope?'&'+scope:'')+(cursor?'&cursor='+encodeURIComponent(cursor):''));if(request===generation.current)setState(previous=>({scope:identity,workflows:cursor?{...result,versions:[...(previous.workflows?.versions||[]),...(result.versions||[])].filter((row:Item,index:number,all:Item[])=>all.findIndex(item=>item.id===row.id)===index)}:result,loading:false,error:''}));}catch(error){if(request===generation.current)setState(previous=>({...previous,loading:false,error:(error as Error).message}));}finally{if(request===generation.current)flight.current=false;}},[scope,identity]);
 useEffect(()=>{flight.current=false;void load();return()=>{generation.current++;flight.current=false;};},[load]);
 async function refreshVersion(id:string){const request=generation.current;const result=await api('/api/learning?view=version&id='+encodeURIComponent(id));const version=result.version;if(request===generation.current&&version)setState(previous=>({...previous,workflows:previous.workflows?{...previous.workflows,versions:previous.workflows.versions.map((row:Item)=>row.id===id?version:row)}:null}));}
 return state.scope===identity?{...state,reload:()=>load(),more:()=>load(state.workflows?.versionsPage?.nextCursor||state.workflows?.page?.nextCursor),refreshVersion}:{workflows:null,loading:true,error:'',reload:()=>load(),more:()=>load(),refreshVersion};
}

function StudyReportNumbers({report,showReview=true}:{report:Item;showReview?:boolean}) {
  return <div className={ownedClassName("records-overview",true)}>
    {[{label:'퀴즈 문항',value:report.quiz?.answered||0,unit:'문항'},{label:'면접 답변',value:report.interviews?.answered||0,unit:'개'},...(showReview?[{label:'다시 볼 질문',value:report.weakPointCount??report.weakPoints?.length??0,unit:'개'}]:[])].map(item=><div key={item.label} className={ownedClassName(undefined,true)}><span className={ownedClassName(undefined,true)}>{item.label}</span><strong className={ownedClassName(undefined,true)}>{item.value}<small className={ownedClassName(undefined,true)}>{item.unit}</small></strong></div>)}
  </div>;
}

export function RecordsPages({slug=[]}:{slug?:string[]}){
 if(slug[0]==='comparisons')return <AnswerComparisons questionId={slug[1]}/>;
 if(slug[0]==='reports'&&slug[1])return <Report key={slug[1]} id={slug[1]}/>;
 if(slug[0]==='sessions'&&slug[1])return <StudyReport key={slug[1]} id={slug[1]}/>;
 return <RecordsOverview slug={slug}/>;
}
function RecordsOverview({ slug = [] }: { slug?: string[] }) {
  const { data,targetId } = useApp();
  const {reports,error,reload,more,loadingMore}=useStudyReports();
  const history=slug[0]==='history';
  const feedback=useRecordPages('reports','',!history,data.user.id),interviews=useRecordPages('interviews','',history,data.user.id),memories=useRecordPages('memory','',history,data.user.id);
  const [finishing,setFinishing]=useState(false),[finishError,setFinishError]=useState('');
  const [exporting,setExporting]=useState(false);
  async function exportRecords() {
    setExporting(true);setFinishError('');
    try {
      const response=await fetch('/api/student-records/export',{cache:'no-store'});
      if(!response.ok){const value=await response.json();throw new Error(value.error||'내보내지 못했어요.');}
      const blob=await response.blob();
      const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='각자ON-내학습기록-'+koreaToday()+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch(err){setFinishError((err as Error).message);}finally{setExporting(false);}
  }
  async function finish() {
    if(finishing||!reports?.current)return;setFinishing(true);setFinishError('');
    try {await finishStudySession('manual',reports.current.id);await reload();}
    catch(err){setFinishError((err as Error).message);}finally{setFinishing(false);}
  }
  const memoryHistory=memories.items;
  return <div className={ownedClassName("records-view "+styles.report+' '+toolbarStyles.view,true)}>
    <Breadcrumb items={[{ label: '내 기록', href: slug.length ? '/records' : undefined }, ...(history ? [{ label: '연습 이력' }] : [])]} />
    <PageTitle title={history ? '연습 이력' : '내 기록'} />
    <div className={ownedClassName(toolbarStyles.toolbar,true)}><ReportNav active={history?'history':'reports'} /><button type="button" className={ownedClassName(toolbarStyles.export,true)} onClick={exportRecords} disabled={exporting||!reports} aria-label={exporting?'내 기록 내보내는 중':'내 기록 내보내기'} aria-busy={exporting||undefined} title="내 기록 내보내기">{exporting?<LoaderCircle size={18} className={ownedClassName("spin")}/>:<Download size={18}/>}</button></div>
    {(error||finishError||feedback.error||interviews.error||memories.error)&&<Alert>{finishError||error||feedback.error||interviews.error||memories.error}</Alert>}
    {history ? <>
      {!!reports?.history?.length&&<section className={ownedClassName("records-history-section",true)}><h2 className={ownedClassName(undefined,true)}>최근 학습</h2>{reports.history.map((event:Item)=><StudyAnswer key={event.id} event={event}/>)}{reports.historyPage?.hasMore&&<button className={ownedClassName("button ghost",true)} disabled={Boolean(loadingMore)} onClick={()=>void more('history')}>이전 학습 더 보기</button>}</section>}
      <>
      <div className={ownedClassName("records-overview",true)}>
        {[{ label: '면접 연습', value: data.summary?.interviews || 0, unit: '회' }, { label: '키워드 회상', value: data.summary?.memory || 0, unit: '회' }, { label: '나의 답변', value: data.summary?.answers || 0, unit: '개' }].map(s => <div key={s.label} className={ownedClassName(undefined,true)}><span className={ownedClassName(undefined,true)}>{s.label}</span><strong className={ownedClassName(undefined,true)}>{s.value}<small className={ownedClassName(undefined,true)}>{s.unit}</small></strong></div>)}
      </div>
      {!!interviews.items.length && <section className={ownedClassName("records-history-section",true)}>
        <h2 className={ownedClassName(undefined,true)}>면접 연습</h2>
        {interviews.items.map(i => <LinkedRow key={i.id} href={'/interview/' + i.id} title={interviewLabel(i)} subtitle={dateLabel(i.created_at)} end={<Badge tone={i.state === 'completed' ? 'green' : 'neutral'}>{i.state === 'completed' ? '완료' : i.state === 'cancelled' ? '취소' : '진행 중'}</Badge>}><span className={ownedClassName("records-row-icon",true)}>{i.kind === 'video' ? <Mic size={22} strokeWidth={1.5} /> : <MessagesSquare size={22} strokeWidth={1.5} />}</span></LinkedRow>)}
      {interviews.page?.hasMore&&<button className={ownedClassName("button ghost",true)} disabled={interviews.loading} onClick={()=>void interviews.more()}>이전 면접 더 보기</button>}</section>}
      {!!memoryHistory.length && <section className={ownedClassName("records-history-section",true)}>
        <h2 className={ownedClassName(undefined,true)}>암기 복습</h2>
        {memoryHistory.map((a: Item) => {
          const memory = data.learning.memory_items.find((m: Item) => m.id === a.memory_item_id);
          const question = data.learning.questions.find((q: Item) => q.id === memory?.question_id);
          const title = memory && ['keyword_recall', 'order', 'answer_order'].includes(memory.kind)
            ? question?.prompt || memory.prompt
            : memory?.prompt || '암기 훈련';
          return <LinkedRow key={a.id} href={'/practice/memory/' + a.memory_item_id} title={title} subtitle={dateLabel(a.created_at)} end={<Badge>{a.rating === 'again' ? '다시 준비' : '복습 기록'}</Badge>}><span className={ownedClassName("records-row-icon",true)}><Sparkles size={22} strokeWidth={1.5} /></span></LinkedRow>;
        })}
      {memories.page?.hasMore&&<button className={ownedClassName("button ghost",true)} disabled={memories.loading} onClick={()=>void memories.more()}>이전 복습 더 보기</button>}</section>}
      {!reports&&!error?<Spinner/>:!interviews.loading&&!memories.loading&&!data.summary?.interviews&&!data.summary?.memory&& <Empty title="아직 훈련 기록이 없어요" href="/practice" label="훈련 시작" />}
      </>
    </> : <>
      <SpeechGrowth currentContext={{targetId,contentVersion:Number(data.package?.active_version||0),questions:data.learning?.questions||[],targets:data.targets||[]}}/>
      {!!reports?.totals?.eventCount&&<>
        <details className={ownedClassName("speech-activity-details",true)}><summary className={ownedClassName(undefined,true)}>함께 쌓인 학습 기록</summary><section className={ownedClassName("study-total",true)}><StudyReportNumbers report={reports!.totals} showReview={false}/><div className={ownedClassName("study-facts",true)}>{[{label:'암기 복습',value:reports.totals.memory?.reviewed},{label:'과제 답변',value:reports.totals.assignments?.submitted},{label:'시청 체크',value:reports.totals.knowledge?.completed},{label:'영상 메모',value:reports.totals.knowledge?.reflections}].filter(item=>item.value>0).map(item=><span key={item.label} className={ownedClassName(undefined,true)}>{item.label} {item.value}개</span>)}</div></section></details>
      </>}
      {!!reports?.current?.report?.eventCount&&<section className={ownedClassName("study-current",true)}><div className={ownedClassName("section-heading",true)}><h2 className={ownedClassName(undefined,true)}>이번 학습</h2><Badge tone="green">자동 저장 중</Badge></div><div className={ownedClassName("study-report-actions",true)}><Link className={ownedClassName("text-link")} href={'/reports/sessions/'+reports.current.id}>진행 기록 보기<ArrowUpRight size={17}/></Link><button className={ownedClassName("button secondary",true)} onClick={finish} disabled={finishing}>{finishing?'저장하는 중':'학습 마치기'}</button></div></section>}
      {!!reports?.sessions?.length&&<section className={ownedClassName("records-history-section",true)}><h2 className={ownedClassName(undefined,true)}>학습 리포트</h2><div className={ownedClassName('records-report-list '+toolbarStyles.reportRows,true)}>{reports.sessions.map((session:Item)=><Link className={ownedClassName('records-report-row '+toolbarStyles.reportRow)} key={session.id} href={'/reports/sessions/'+session.id}><span className={ownedClassName("records-row-icon",true)}><ListChecks size={25}/></span><div className={ownedClassName(undefined,true)}><h2 className={ownedClassName(undefined,true)}>{dateLabel(session.started_at)} 학습</h2><p className={ownedClassName(undefined,true)}>그날 남긴 답변과 연습 기록</p></div><ArrowUpRight size={22} strokeWidth={1.5}/></Link>)}</div>{reports.sessionsPage?.hasMore&&<button className={ownedClassName("button ghost",true)} disabled={Boolean(loadingMore)} onClick={()=>void more('sessions')}>이전 리포트 더 보기</button>}</section>}
      {!!feedback.items.length&&<section className={ownedClassName("records-history-section",true)}><h2 className={ownedClassName(undefined,true)}>훈련·면접 피드백</h2><div className={ownedClassName('records-report-list '+toolbarStyles.reportRows,true)}>
      {feedback.items.map(r => <Link className={ownedClassName('records-report-row '+toolbarStyles.reportRow)} key={r.id} href={'/reports/reports/' + r.id}>
        <span className={ownedClassName("records-row-icon",true)}>{r.data?.kind === 'video' ? <Mic size={26} strokeWidth={1.5} /> : <MessagesSquare size={26} strokeWidth={1.5} />}</span>
        <div className={ownedClassName(undefined,true)}><h2 className={ownedClassName(undefined,true)}>{interviewLabel({kind:r.data?.kind,data:r.data})}</h2><p className={ownedClassName(undefined,true)}>{dateLabel(r.created_at)}</p></div>
        <ArrowUpRight size={22} strokeWidth={1.5} />
      </Link>)}
    </div>{feedback.page?.hasMore&&<button className={ownedClassName("button ghost",true)} disabled={feedback.loading} onClick={()=>void feedback.more()}>이전 면접 피드백 더 보기</button>}</section>}
    {!reports&&!error&&<div className={ownedClassName(toolbarStyles.reportSkeleton,true)} aria-hidden="true"><span/><span/></div>}
    </>}
  </div>;
}

function StudyReport({id}:{id:string}) {
  const {reports,error}=useStudyReports(id),session=reports?.session,report=session?.report;
  const events:Item[]=reports?.sourceFacts||report?.events||[];
  return <div className={ownedClassName("records-view study-report-view "+styles.report,true)}><Breadcrumb items={[{label:'내 리포트',href:'/reports'},{label:'학습 상세'}]}/><PageTitle title={session?dateLabel(session.started_at)+' 학습 리포트':'학습 리포트'} aside={session&&<Badge tone={session.state==='active'?'green':'neutral'}>{session.state==='active'?'자동 저장 중':'학습 완료'}</Badge>}/>
    {error&&<Alert>{error}</Alert>}
    {!reports&&!error?<Spinner/>:session&&<>
      <p className={ownedClassName("study-period",true)}>{sessionTime(session.started_at)}{session.ended_at&&' — '+sessionTime(session.ended_at)}</p><SpeechGrowth studySessionId={id}/><details className={ownedClassName("speech-activity-details",true)}><summary className={ownedClassName(undefined,true)}>학습 활동 수</summary><StudyReportNumbers report={report}/></details>
      {!!report.quiz?.answered&&<section className={ownedClassName("report-feedback-section",true)}><h2 className={ownedClassName(undefined,true)}>퀴즈</h2><div className={ownedClassName("study-facts",true)}><span className={ownedClassName(undefined,true)}>선택형 {report.quiz.choice}개</span><span className={ownedClassName(undefined,true)}>주관식 {report.quiz.written}개</span><span className={ownedClassName(undefined,true)}>녹음 답변 {report.quiz.oral}개</span><span className={ownedClassName(undefined,true)}>정답 {report.quiz.correct}개</span><span className={ownedClassName(undefined,true)}>오답 {report.quiz.wrong}개</span><span className={ownedClassName(undefined,true)}>채점하지 않은 답변 {report.quiz.ungraded}개</span><span className={ownedClassName(undefined,true)}>시간 초과 {report.quiz.timedOut}개</span></div></section>}
      {!!report.interviews?.answered&&<section className={ownedClassName("report-feedback-section",true)}><h2 className={ownedClassName(undefined,true)}>모의면접</h2><div className={ownedClassName("study-facts",true)}><span className={ownedClassName(undefined,true)}>Chat 답변 {report.interviews.chat}개</span><span className={ownedClassName(undefined,true)}>Live 답변 {report.interviews.live}개</span>{report.interviews.assisted>0&&<span className={ownedClassName(undefined,true)}>도움을 받은 답변 {report.interviews.assisted}개</span>}</div></section>}
      {!!(report.memory?.reviewed||report.assignments?.submitted||report.knowledge?.updates)&&<section className={ownedClassName("report-feedback-section",true)}><h2 className={ownedClassName(undefined,true)}>함께 한 학습</h2><div className={ownedClassName("study-facts",true)}><span className={ownedClassName(undefined,true)}>암기 복습 {report.memory?.reviewed||0}개</span><span className={ownedClassName(undefined,true)}>과제 답변 {report.assignments?.submitted||0}개</span><span className={ownedClassName(undefined,true)}>영상 기록 {report.knowledge?.updates||0}개</span></div></section>}
      {!!report.weakPoints?.length&&<section className={ownedClassName("records-history-section",true)}><h2 className={ownedClassName(undefined,true)}>다시 볼 질문</h2>{report.weakPoints.map((point:Item,index:number)=><LinkedRow key={point.memoryItemId||point.questionId||index} href={studyWeakPointHref(point)} title={point.prompt||'퀴즈 질문'} end={<span className={ownedClassName("muted",true)}>{[point.wrong>0?'오답 '+point.wrong+'회':'',point.timedOut>0?'시간 초과 '+point.timedOut+'회':''].filter(Boolean).join(' · ')}</span>}/>)}</section>}
      <section className={ownedClassName("records-history-section",true)}><h2 className={ownedClassName(undefined,true)}>저장한 답변</h2>{events.map((event:Item)=><StudyAnswer key={event.id} event={event}/>)}{!events.length&&<Empty title="아직 저장한 답변이 없어요" href="/quiz" label="퀴즈 시작"/>}</section>
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
  return <article className={ownedClassName("study-answer",true)}><div className={ownedClassName("section-heading",true)}><span className={ownedClassName("muted",true)}>{quiz?'Quiz':memory?'암기 복습':assignment?'과제':knowledge?'지식한입':'모의면접'} · {sessionTime(event.created_at)}{event.historical&&' · 이전 기록'}</span><Badge tone={value.outcome===true?'green':'neutral'}>{state}</Badge></div><h3 className={ownedClassName(undefined,true)}>{value.prompt||value.question||value.title||'저장한 학습'}</h3>{text&&<p className={ownedClassName(undefined,true)}>{text}</p>}{value.reflection&&<p className={ownedClassName(undefined,true)}>{value.reflection}</p>}{value.explanation&&<p className={ownedClassName(undefined,true)}>{value.explanation}</p>}{knowledge&&value.completed===true&&<p className={ownedClassName("muted",true)}>시청했다고 직접 체크했어요.</p>}{quiz&&audioId&&<audio controls preload="none" src={'/api/quiz?recordingId='+encodeURIComponent(audioId)} aria-label="내 녹음 답변" className={ownedClassName(undefined,true)}/>}{(value.hintUsed||value.assisted)&&<p className={ownedClassName("muted",true)}>도움을 사용한 답변</p>}{value.timedOut===true&&<span className={ownedClassName("muted",true)}>시간 초과</span>}{value.sessionId&&<Link className={ownedClassName("text-link")} href={'/interview/'+value.sessionId}>면접 기록<ArrowUpRight size={16}/></Link>}{value.questionId&&<Link className={ownedClassName("text-link")} href={studyAnswerComparisonHref(value.questionId,value,event.kind==='interview_answer'?event.source_id:undefined)}>이 질문의 답변 비교<ArrowUpRight size={16}/></Link>}</article>;
}

function Report({ id }: { id: string }) {
  const { data, toast } = useApp();
  const router = useRouter();
  const {workflows,reload}=useLearningWorkflows();
  const detail=useRecordDetail('reports','id='+encodeURIComponent(id),true,data.user.id);
  const report=detail.item?{...detail.item,...detail.item.data}:null;
  const [error, setError] = useState('');
  const [retraining, setRetraining] = useState('');
  const [feedbackBusy,setFeedbackBusy]=useState(false);
  const sending = useRef(false);
  const requestIds = useRef<Item>({});
  useEffect(()=>{if(report?.aiStatus!=='pending')return;let remaining=40;const timer=setInterval(()=>{if(--remaining<=0)clearInterval(timer);void detail.reload();},3000);return()=>clearInterval(timer);},[report?.aiStatus,detail.reload]);
  if(detail.loading)return <Spinner/>;
  if(detail.error)return <Alert>{detail.error}</Alert>;
  if (!report) return <Empty title="리포트를 찾을 수 없어요" />;
  const sections: Item[] = report.sections || [];
  const experienceCard=report.experienceCard||detail.session?.data?.experienceCard;
  async function retryFeedback(){if(feedbackBusy)return;setFeedbackBusy(true);setError('');try{await post('/api/interviews',{action:'report_feedback',sessionId:report.session_id});await detail.reload();}catch(cause){setError((cause as Error).message);}finally{setFeedbackBusy(false);}}
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
  return <div className={ownedClassName("records-view report-view "+styles.report,true)}>
    <Breadcrumb items={[{ label: '내 리포트', href: '/reports' }, { label: '면접 피드백' }]} />
    <PageTitle title={(report.kind === 'video' ? '화상' : '채팅') + ' 면접 리포트'} />
    {error && <Alert>{error}</Alert>}
    <div className={ownedClassName("report-summary",true)}><span className={ownedClassName(undefined,true)}>{dateLabel(report.created_at)}</span></div>
    {detail.session?.data?.experienceCard && <section className={ownedClassName("detail-section",true)}><h2 className={ownedClassName(undefined,true)}>이 경험을 더 다듬어볼까?</h2><p className={ownedClassName(undefined,true)}>이번 답변과 피드백을 보고, 내 행동과 배운 점을 보완해 보세요.</p><Link className={ownedClassName("button ghost")} href={'/armory?card='+detail.session!.data.experienceCard.id}>내 경험에서 보완하기</Link></section>}
    <SpeechGrowth reportId={id}/>
    {report.session_id && <RecordMedia sessionId={report.session_id} />}
    {report.aiFeedback && <section className={ownedClassName("report-feedback-section",true)}><h2 className={ownedClassName(undefined,true)}>AI 피드백</h2><p className={ownedClassName("muted small",true)}>표현 제안은 내 답변·원문과 확인해 사용해 주세요. 내가 하지 않은 행동은 답변에 넣지 않아요.</p><MarkdownMessage content={report.aiFeedback.content}/></section>}
    {report.aiStatus !== 'completed' && <div className={ownedClassName("inline-notice",true)}>내용 피드백 {report.aiStatus === 'failed' ? '처리 실패' : '대기'} · 아래 기록으로 직접 점검할 수 있어요.{sections.length>0&&report.session_id&&<button className={ownedClassName("text-link",true)} disabled={feedbackBusy||report.aiStatus==='pending'&&Date.now()-Number(report.aiAttemptedAt||0)<60000} onClick={()=>void retryFeedback()}>{feedbackBusy?'다시 요청하는 중':'피드백 다시 요청'}</button>}</div>}
    {sections.map((s, i) => <section className={ownedClassName("report-section",true)} key={s.turnId || i}>
      <span className={ownedClassName("question-index",true)}>질문 {i + 1}</span>
      <h2 className={ownedClassName(undefined,true)}>{s.question}</h2>
      <div className={ownedClassName("report-answer",true)}><h3 className={ownedClassName(undefined,true)}>내 답변</h3><p className={ownedClassName(undefined,true)}>{s.answer || s.response}</p></div>
      {(s.answerElements || s.answer_elements || s.expectedElements || []).length>0&&<div className={ownedClassName("report-elements",true)}><h3 className={ownedClassName(undefined,true)}>답변 요소</h3><div className={ownedClassName("tag-list",true)}>{(s.answerElements || s.answer_elements || s.expectedElements || []).map((k: string) => <span key={k} className={ownedClassName(undefined,true)}>{k}</span>)}</div></div>}
      {s.turnId&&<AnswerMeaningChecks version={workflows?.versions?.find((version:Item)=>version.turn_id===s.turnId&&version.script===(s.answer||s.response))} onSaved={reload}/>}
      {s.questionId&&!s.questionId.startsWith('briefing_')&&<div className={ownedClassName("learning-inline-links report-retry-actions",true)}><Link className={ownedClassName("button primary")} href={learningTodayHref(s.questionId,{experienceCard,content_version:report.contentVersion,source_type:s.sourceType,target_id:report.targetId,common_revision:s.commonRevision})}>다음 학습 이어서<ArrowUpRight size={17}/></Link><Link className={ownedClassName("text-link report-retry")} href={interviewRetryHref(s.questionId,{experienceCard,content_version:report.contentVersion,source_type:s.sourceType,target_id:report.targetId,common_revision:s.commonRevision})}>이 질문 다시 말하기<ArrowUpRight size={17}/></Link><Link className={ownedClassName("text-link")} href={'/records/comparisons/' + encodeURIComponent(s.questionId)+(report.targetId?'?targetId='+encodeURIComponent(report.targetId)+(s.turnId?'&turnId='+encodeURIComponent(s.turnId):''):s.turnId?'?turnId='+encodeURIComponent(s.turnId):'')}>답변 비교<ArrowUpRight size={17}/></Link><button className={ownedClassName("button ghost",true)} disabled={!!retraining} onClick={()=>retrain(s.questionId)}><RotateCcw size={16}/>{retraining===s.questionId?'과제 만드는 중':'재훈련 과제로 담기'}</button></div>}
    </section>)}
    {report.observations && report.observations.status !== 'not_measured' && <section className={ownedClassName("report-feedback-section",true)}><h2 className={ownedClassName(undefined,true)}>발화 관찰</h2><p className={ownedClassName("muted",true)}>{JSON.stringify(report.observations)}</p></section>}
    <Link className={ownedClassName("button primary report-new-session")} href="/interview/new">새 면접 연습<ArrowUpRight size={17} /></Link>
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
  return <fieldset className={ownedClassName("comparison-meaning-checks",true)}><legend className={ownedClassName(undefined,true)}>이 답변에서 직접 확인한 요소</legend>{required.map(text=><label key={text} className={ownedClassName(undefined,true)}><input type="checkbox" checked={checked.includes(text)} disabled={busy} onChange={event=>void change(text,event.target.checked)} className={ownedClassName(undefined,true)}/>{text}</label>)}<p className={ownedClassName("muted",true)}>이 답변에 남기는 자기 점검이에요.{busy?' 저장 중…':version.self_checked_at?' 저장됨':''}</p>{error&&<Alert>{error}</Alert>}</fieldset>;
}
function ComparisonAnswer({value,hideScript=false}:{value:Item;hideScript?:boolean}) {
  return <>{value.target_snapshot&&<p className={ownedClassName("muted comparison-school-context",true)}>{[value.target_snapshot.university,value.target_snapshot.department||value.target_snapshot.major].filter(Boolean).join(" · ")}</p>}<div className={ownedClassName("comparison-evidence",true)}><span className={ownedClassName(undefined,true)}>{comparisonDate(value.created_at)}</span>{value.hint_used?<Badge>힌트 사용{value.ai_assisted?' · AI 도움':''}</Badge>:value.assisted?<Badge>도움 사용</Badge>:<Badge>{value.assistance_recorded===true?'도움 기록 없음':'도움 여부 미기록'}</Badge>}{value.evaluation_method==='ungraded'&&<Badge>미채점</Badge>}{value.practice_kind==='concept'&&<Badge>개념 설명</Badge>}{value.practice_label&&<Badge>{value.practice_label}</Badge>}</div>{value.structure&&<div className={ownedClassName("comparison-structure",true)}><h4 className={ownedClassName(undefined,true)}>답변 설계</h4><p className={ownedClassName(undefined,true)}>{value.structure}</p></div>}{!hideScript&&<p className={ownedClassName("comparison-answer",true)}>{value.script||(value.audio_id?'텍스트 전사 없이 녹음으로 남긴 답변이에요.':'발화본 없이 설계만 저장한 답변이에요.')}</p>}{value.audio_id&&<audio className={ownedClassName("comparison-audio",true)} controls preload="none" src={'/api/quiz?recordingId='+encodeURIComponent(value.audio_id)} aria-label="이 시점의 녹음 답변"/>}{value.source_status==='unavailable'&&<p className={ownedClassName("muted",true)}>이 답변의 당시 자료 버전은 확인되지 않아요.</p>}</>;
}

function AnswerComparisons({ questionId }: { questionId?: string }) {
  const { data } = useApp();
  const params = useSearchParams();
  const requested = questionId || params.get('questionId') || '';
  const historyParams=new URLSearchParams();if(requested)historyParams.set('questionId',requested);for(const name of ['targetId','sourceType','sourceVersion']){const value=params.get(name);if(value)historyParams.set(name,value);}
  const history=useLearningHistory(historyParams.toString(),data.user.id);
  const {workflows,loading,error,reload}=history;
  const [selectedQuestion, setSelectedQuestion] = useState(requested);
  const [leftId, setLeftId] = useState('');
  const [rightId, setRightId] = useState('');
  const [viewMode, setViewMode] = useState<'columns'|'wipe'>('columns');
  const [selectedContext,setSelectedContext]=useState('');
  const comparisonTarget=params.get('targetId'),comparisonSource=params.get('sourceType'),comparisonVersion=params.get('sourceVersion');
  const activityFilter=params.get('activityId');
  const versions: Item[] = materialComparisonVersions(workflows?.versions || [],{targetId:comparisonTarget,sourceType:comparisonSource,sourceVersion:comparisonVersion}).filter(version=>{if(!activityFilter)return true;if(activityFilter.startsWith('experience:'))return version.experience_card?.id===activityFilter.slice(11);if(activityFilter.startsWith('question:'))return version.question_id===activityFilter.slice(9);const question=data.learning.questions?.find((q:Item)=>q.id===version.question_id);return version.activity_ids?.includes(activityFilter)||question?.activity_ids?.includes(activityFilter);});
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
  return <div className={ownedClassName("learning-v2 answer-comparisons",true)}>
    <Breadcrumb items={[{ label: '내 기록', href: '/records' }, { label: '답변 비교' }]} />
    <PageTitle title="답변 비교" />
    <ReportNav active="comparisons" />
    {error && <><Alert>{error}</Alert><button className={ownedClassName("button ghost",true)} onClick={reload}>다시 불러오기</button></>}
    {(workflows?.versionsPage?.hasMore||workflows?.page?.hasMore)&&<button className={ownedClassName("button ghost",true)} disabled={loading} onClick={()=>void history.more()}>이전 답변 더 보기</button>}
    {loading && !workflows ? <Spinner /> : !versions.length ? !error && <Empty title={comparisonTarget||comparisonSource||comparisonVersion?'선택한 학습 맥락에 저장한 답변이 없어요':'저장한 답변이 없어요'} href="/materials/answers" label="답변 초안 작성" /> : <>
      <label className={ownedClassName("comparison-question-select",true)}>비교할 질문<select value={selected} onChange={e => setSelectedQuestion(e.target.value)} className={ownedClassName(undefined,true)}>{requested && !questionIds.includes(requested) && <option value={requested} className={ownedClassName(undefined,true)}>{question?.prompt || '선택한 질문'}</option>}{questionIds.map(id => <option key={id} value={id} className={ownedClassName(undefined,true)}>{data.learning.questions?.find((q: Item) => q.id === id)?.prompt || versions.find(v => v.question_id === id)?.question || '저장된 질문'}</option>)}</select></label>
      {contexts.length>1&&<label className={ownedClassName("comparison-question-select",true)}>연습한 지원처<select aria-label="비교할 연습 맥락" value={comparisonContext} onChange={e=>setSelectedContext(e.target.value)} className={ownedClassName(undefined,true)}>{contexts.map(key=>{const group=matching.filter(v=>versionContext(v)===key),latest=group[0];return <option key={key} value={key} className={ownedClassName(undefined,true)}>{[latest.target_snapshot?.university,latest.target_snapshot?.department||latest.target_snapshot?.major,latest.target_snapshot?.admission_year&&latest.target_snapshot.admission_year+'학년도'].filter(Boolean).join(' · ')||'지원처 정보 없는 기록'} · {comparisonDate(latest.created_at)}</option>;})}</select></label>}
      {!current.length ? <Empty title="이 질문에 저장한 답변이 없어요" href={question ? '/materials/answers/' + selected : '/records'} label={question ? '답변 작성' : '면접 리포트'} /> : current.length < 2 ? <><section className={ownedClassName("comparison-single",true)}><h2 data-question-key={selected} className={ownedClassName(undefined,true)}>{questionPrompt}</h2><span className={ownedClassName("muted",true)}>{answerVersionLabel(right)}</span><ComparisonAnswer value={right}/></section><p className={ownedClassName("comparison-notice",true)}>{workflows?.versionsPage?.hasMore||workflows?.page?.hasMore?'이전 답변을 더 불러오면 함께 비교할 수 있어요.':'답변을 한 번 더 남기면 이전 기록과 비교할 수 있어요.'}</p>{right.source_status==='saved'?<Link className={ownedClassName("button primary")} href={interviewRetryHref(selected,right)}>이 질문 다시 말하기<ArrowUpRight size={17}/></Link>:right.session_id&&<Link className={ownedClassName("button primary")} href={'/interview/'+right.session_id}>면접 기록 보기<ArrowUpRight size={17}/></Link>}</> : <>
        <h2 className={ownedClassName("comparison-prompt",true)} data-question-key={selected}>{questionPrompt}</h2>
        <p className={ownedClassName("comparison-notice",true)}>같은 질문에 남긴 실제 답변이에요. 핵심 내용과 근거가 어떻게 달라졌는지 비교해 보세요.</p>
        <div className={ownedClassName("comparison-view-switch",true)} role="group" aria-label="답변 비교 보기 방식"><button type="button" aria-pressed={!wipeMode} onClick={()=>setViewMode('columns')} className={ownedClassName(undefined,true)}>나란히 보기</button><button type="button" aria-pressed={wipeMode} disabled={!canWipe} title={!canWipe?'두 답변에 텍스트가 필요해요.':undefined} onClick={()=>setViewMode('wipe')} className={ownedClassName(undefined,true)}>겹쳐 보기</button></div>
        <div className={ownedClassName('comparison-columns'+(wipeMode?' comparison-wipe-metadata':''),true)}>{[{ label: '먼저 볼 답변', value: left, set: setLeftId }, { label: '함께 볼 답변', value: right, set: setRightId }].map(column => <section key={column.label} className={ownedClassName(undefined,true)}>
          <div className={ownedClassName("comparison-column-heading",true)}><h3 className={ownedClassName(undefined,true)}>{answerVersionLabel(column.value)}</h3><select aria-label={column.label + ' 저장 시점'} value={column.value.id} onChange={e => { column.set(e.target.value); }} className={ownedClassName(undefined,true)}>{current.map(v => <option key={v.id} value={v.id} className={ownedClassName(undefined,true)}>{answerVersionLabel(v)} · {comparisonDate(v.created_at)}</option>)}</select></div>
          <ComparisonAnswer value={column.value} hideScript={wipeMode}/>
        </section>)}</div>
        {wipeMode&&<ComparisonWipe key={left.id+'|'+right.id} previous={left.script} current={right.script} previousLabel={answerVersionLabel(left)+' · '+comparisonDate(left.created_at)} currentLabel={answerVersionLabel(right)+' · '+comparisonDate(right.created_at)}/>}
        <ComparisonObservation before={left as any} after={right as any}/>
        <AnswerMeaningChecks version={right} onSaved={()=>history.refreshVersion(right.id)}/>
        <div className={ownedClassName("learning-inline-links",true)}><Link className={ownedClassName("button primary")} href={learningTodayHref(selected,{...right,target_id:right.target_id||comparisonTarget})}>다음 학습 이어서<ArrowUpRight size={17}/></Link>{right.source_status==='saved'&&<Link className={ownedClassName("text-link")} href={interviewRetryHref(selected,right)}>이 질문 다시 말하기<ArrowUpRight size={17}/></Link>}{question?<><Link className={ownedClassName("text-link")} href={'/materials/answers/' + selected}>답변 수정<ArrowUpRight size={16}/></Link><Link className={ownedClassName("text-link")} href={'/materials/questions/' + selected}>질문과 근거<ArrowUpRight size={16}/></Link></>:right.session_id&&<Link className={ownedClassName("text-link")} href={'/interview/'+right.session_id}>면접 기록 보기<ArrowUpRight size={17}/></Link>}</div>
      </>}
    </>}
  </div>;
}


