'use client';
import {ownedClassName} from './owned-class-name';


import Link from 'next/link';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {usePathname,useRouter} from 'next/navigation';
import {ArrowRight,ArrowUpRight,BookOpen,CalendarDays,Check,ChevronDown,Clock3,History,Library,MessagesSquare,Play,RefreshCw,Settings2} from 'lucide-react';
import {useApp} from './app-shell';
import {ActionButton,Alert,Spinner,InfoTip,api,peekApi,post,targetName,type Item} from './shared';
import {learningScopeIdentity,splitInterviewsByLearningTarget} from '@/lib/learning-target-scope';
import {scheduleTrainingDayRefresh} from '@/lib/training-day-refresh';
import {TrainingCalendar} from './training-calendar';
import {summarizeTrainingPlans} from '@/lib/training-plan-summary';
import {trainingSequence,trainingTaskDone,nextTrainingStep} from '@/lib/training-flow';
import styles from './training-hub.module.css';
import {LearningDiscovery} from './learning-discovery';

type TrainingTask={id:string;title:string;kind:string;minutes:number;reason:string;targetId:string;questionId?:string;href?:string;status:string;performedAt?:string;completed?:boolean;startedAt?:string;manual?:boolean};
type TrainingDay={date:string;capacityMinutes:number;plannedMinutes:number;remainingMinutes:number;tasks:TrainingTask[]};
type Deadline={targetId:string;university:string;department:string;date:string|null;source:string|null;label:string;periodStart?:string|null;periodEnd?:string|null;status:string;reason:string;daysLeft:number|null;availableMinutes:number};
type ReviewStatus='active'|'resolved'|'clear';
type ReviewQuestion={questionKey:string;targetId:string;questionId:string;sourceType:string;sourceVersion:number;activityIds:string[];status:ReviewStatus;needsReview:boolean;requestIds:string[];resolvedEvidenceIds:string[];reason:string;requestedAtUnknown:boolean};
type ReadinessItem={id:string;kind:'activity'|'experience'|'question';title:string;sourceHref?:string;editHref?:string;questionCount:number;mainAnswers:number;followupAnswers:number;textAttempts:number;audioAttempts:number;assistedAttempts:number;needsReview:string[];reviewStatus?:ReviewStatus;reviewQuestionKeys?:string[];reviewReasons?:string[];lastPracticedAt?:string|null;unconfirmed:boolean;notes?:Array<{id:string;body:string;confirmedByStudent:boolean;createdAt:string}>};
type TrainingData={availability:Item|null;needsAvailability:boolean;registeredAt?:string;deadlines:Deadline[];days:TrainingDay[];today:TrainingDay;readiness:{items:ReadinessItem[];summary:{total:number;practiced:number;unconfirmed:number}};review?:{questions:ReviewQuestion[]};diagnostics:Item|null;warnings?:string[]};
const kindLabels:Record<string,string>={diagnostic:'첫 진단',recall:'누적 복습',quiz:'퀴즈',assignment:'받은 과제',focus:'집중 보완',mixed:'연결 면접',review:'오늘 정리',break:'휴식'};
const done=trainingTaskDone;
function minuteLabel(value:number){if(!Number.isFinite(value))return '시간 확인 필요';const hours=Math.floor(value/60),minutes=value%60;return hours?`${hours}시간${minutes?` ${minutes}분`:''}`:`${minutes}분`;}
function dayLabel(day:string,weekday=false){if(!/^\d{4}-\d{2}-\d{2}/.test(day))return '일정 확인 필요';return new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'long',day:'numeric',...(weekday?{weekday:'short' as const}:{})}).format(new Date(day.slice(0,10)+'T12:00:00+09:00'));}
function deadlineDate(item:Deadline){if(item.source==='public_period'&&item.periodStart&&item.periodEnd)return `${dayLabel(item.periodStart)}–${dayLabel(item.periodEnd)}`;return item.date?dayLabel(item.date):'일정 확인 필요';}
function isPreparationGoal(item?:Deadline){return item?.source==='public_period'||item?.source==='goal';}
function reviewStatusLabel(status?:ReviewStatus){return status==='active'?'보완 중':status==='resolved'?'재확인 완료':'';}
function hasReview(item:ReadinessItem){return item.reviewStatus==='active'||Boolean(item.needsReview?.length);}
function deadlineCountdown(item:Deadline){
  if(item.status==='no_interview')return '대상 아님';
  if(item.daysLeft===null)return '확인 필요';
  const goal=isPreparationGoal(item);
  if(item.daysLeft<0)return goal?'준비 목표 지남':'면접일 지남';
  return item.daysLeft===0?'D-day':`D-${item.daysLeft}`;
}

/** Refresh on answer saves, school changes and browser history restoration. */
function useTrainingData(){
  const {data,target,learningRevision}=useApp(),path=usePathname();
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const sourceScope=JSON.stringify([learningScopeIdentity(target||{}),data.package?.id,data.package?.active_version,day]);
  const scope=JSON.stringify([data.user.id,target?.id,learningScopeIdentity(target||{}),data.package?.id,data.package?.active_version,day]);
  // Even a fresh snapshot belongs to its exact school/content and Korea calendar day.
  const url='/api/training?'+new URLSearchParams({...(target?.id?{targetId:String(target.id)}:{}),viewScope:sourceScope});
  const [loaded,setLoaded]=useState<{scope:string;value:TrainingData}|null>(()=>{
    const value=peekApi?.<TrainingData>(url);
    return value?.today?.date===day?{scope,value}:null;
  }),[error,setError]=useState(''),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0);
  const reload=useCallback(()=>setRevision(value=>value+1),[]);
  useEffect(()=>scheduleTrainingDayRefresh(reload),[reload]);
  useEffect(()=>{const visible=()=>{if(document.visibilityState==='visible')reload();};window.addEventListener('focus',reload);window.addEventListener('pageshow',reload);document.addEventListener('visibilitychange',visible);return()=>{window.removeEventListener('focus',reload);window.removeEventListener('pageshow',reload);document.removeEventListener('visibilitychange',visible);};},[reload]);
  useEffect(()=>{
    const controller=new AbortController();let disposed=false;setLoading(true);setError('');
    void api<TrainingData>(url,{signal:controller.signal,...(revision?{cache:'no-store' as const}:{})}).then(value=>{if(!disposed)setLoaded({scope,value});}).catch(err=>{if(!disposed&&!controller.signal.aborted)setError((err as Error).message);}).finally(()=>{if(!disposed)setLoading(false);});
    return()=>{disposed=true;controller.abort();};
  },[scope,learningRevision,revision,path,target?.id,url]);
  return {value:loaded?.scope===scope?loaded.value:null,error,loading:loading||loaded?.scope!==scope,reload};
}

export function TrainingHeader({title,aside}:{title:string;aside?:React.ReactNode}){
  return <header className={ownedClassName(styles.header,true)}><div className={ownedClassName(undefined,true)}><h1 className={ownedClassName(undefined,true)}>{title}</h1></div>{aside}</header>;
}
function LoadingOrError({error,reload}:{error:string;reload:()=>void}){return error?<div className={ownedClassName(styles.error,true)}><Alert>{error}</Alert><button className={ownedClassName("button ghost",true)} onClick={reload}><RefreshCw size={16}/>다시 불러오기</button></div>:<Spinner/>;}
function ReviewSummary({questions,targetId,linkToPreparation=false}:{questions:ReviewQuestion[];targetId:string;linkToPreparation?:boolean}){
  const selected=questions.filter(item=>item.targetId===targetId),active=selected.filter(item=>item.status==='active').length,resolved=selected.filter(item=>item.status==='resolved').length;
  if(!active&&!resolved)return null;
  return <aside className={ownedClassName(styles.resume,true)} aria-label="현재 지원처 보완 상태"><span className={ownedClassName(undefined,true)}>{`${reviewStatusLabel('active')} ${active}개 질문 · ${reviewStatusLabel('resolved')} ${resolved}개 질문`}</span>{linkToPreparation&&<Link href="/preparation">준비 현황<ArrowRight size={15}/></Link>}</aside>;
}
function DeadlineList({deadlines,targetId}:{deadlines:Deadline[];targetId:string}){
  const rows=[...deadlines].sort((a,b)=>Number(b.targetId===targetId)-Number(a.targetId===targetId));
  return <div className={ownedClassName(styles.deadlines,true)}>{rows.map(item=>{
    const countdown=item.status!=='no_interview'&&item.daysLeft!==null&&item.daysLeft>=0;
    return <div className={ownedClassName(styles.deadline,true)} key={item.targetId}><div className={ownedClassName(undefined,true)}><Link href={'/schools/'+encodeURIComponent(item.targetId)}>{item.university}<ArrowUpRight size={13}/></Link><span className={ownedClassName(undefined,true)}>{item.department}</span></div><div className={ownedClassName(styles.deadlineDate,true)}><strong className={ownedClassName(undefined,true)}>{item.status==='no_interview'?'면접 미실시':deadlineDate(item)}</strong>{item.label!==deadlineDate(item)&&!['면접 일정 확인 필요','면접 미실시'].includes(item.label)&&<span className={ownedClassName(undefined,true)}>{item.label}</span>}{item.status==='ready'&&<span className={ownedClassName(undefined,true)}>{isPreparationGoal(item)?'준비 목표 전':'면접 전'} 설정 시간 {minuteLabel(item.availableMinutes)}</span>}</div>{item.daysLeft!==null&&item.status!=='no_interview'&&<span className={ownedClassName(styles.daysLeft,true)} data-countdown={countdown||undefined}>{countdown&&<span className={ownedClassName(styles.deadlineCaption,true)}>{isPreparationGoal(item)?'준비 목표':'면접일'}</span>}<strong className={ownedClassName(undefined,true)}>{deadlineCountdown(item)}</strong></span>}</div>;
  })}{!rows.length&&<p className={ownedClassName(styles.note,true)}>지원할 학교·학과·전형을 연결하면 실제 일정에 맞춰 계획을 준비해요. <Link href="/schools/new">지원 학교 등록</Link></p>}</div>;
}
export function TodayTraining(){
  const {data,target,targetId,refresh}=useApp(),router=useRouter();
  const {value,error,loading,reload}=useTrainingData();
  const [starting,setStarting]=useState(''),[actionError,setActionError]=useState('');
  const startFlight=useRef<{scope:object;id:string}|null>(null);
  const currentScope=JSON.stringify([data.user.id,targetId,learningScopeIdentity(target||{})]),scope=useRef({key:currentScope});if(scope.current.key!==currentScope)scope.current={key:currentScope};const scopeToken=scope.current;
  const active=splitInterviewsByLearningTarget(data.interviews||[],target).current.find(session=>session.state==='active');
  const resumeHref=active?.data?.trainingPlanId?'/my/train?planId='+encodeURIComponent(active.data.trainingPlanId):active?`/interview/${encodeURIComponent(active.id)}?kind=${active.kind==='video'?'video':'chat'}`:null;
  async function start(task:TrainingTask){
    if(startFlight.current?.scope===scopeToken||done(task))return;
    if(task.manual){if(task.href)router.push(task.href);return;}
    const flight={scope:scopeToken,id:task.id};startFlight.current=flight;setStarting(task.id);setActionError('');
    try{const result=await post('/api/training',{action:'task_start',planId:task.id});if(scope.current!==flight.scope)return;if(result.href)router.push(result.href);else{await refresh();reload();}}
    catch(err){if(scope.current===flight.scope)setActionError((err as Error).message);}
    finally{if(startFlight.current===flight){startFlight.current=null;setStarting('');}}
  }
  const today=value?.today,tasks=trainingSequence(today?.tasks||[]),pending=tasks.filter(task=>!done(task)),next=nextTrainingStep(tasks),finished=tasks.filter(done).length;
  const selectedDeadline=value?.deadlines.find(item=>item.targetId===targetId);
  const focus=next;
  return <div className={ownedClassName(styles.hub,true)}>
    <TrainingHeader title="오늘 훈련" aside={<div className={ownedClassName(styles.headerLinks,true)}><a className={ownedClassName(styles.settingsLink,true)} href="#training-calendar" aria-label="캘린더"><CalendarDays size={16}/><span>캘린더</span></a><Link className={ownedClassName(styles.settingsLink)} href="/availability" aria-label="학습 시간 설정"><Settings2 size={16}/><span>학습 시간 설정</span></Link></div>}/>
    {!value?<LoadingOrError error={error} reload={reload}/>:<>
      {error&&<Alert>{error}</Alert>}{actionError&&<Alert>{actionError}</Alert>}
      {value.needsAvailability?<section className={ownedClassName(styles.setup,true)} aria-labelledby="availability-title"><span className={ownedClassName(styles.eyebrow,true)}>내 일정으로 시작하기</span><h2 id="availability-title" className={ownedClassName(undefined,true)}>면접 전, 언제 얼마나 준비할 수 있나요?</h2><p className={ownedClassName(undefined,true)}>평일·주말의 학습 시간과 학습하지 못하는 날을 알려 주세요. 지원 학교의 면접일까지 가능한 시간으로 계획을 만들어요.</p><Link className={ownedClassName("button primary")} href="/availability">학습 시간 설정<ArrowRight size={16}/></Link></section>:<>
        {active&&<aside className={ownedClassName(styles.resume,true)}><span className={ownedClassName(undefined,true)}><History size={17}/>진행 중인 면접</span><Link href={resumeHref!}>이어 하기<ArrowRight size={15}/></Link></aside>}
        <ReviewSummary questions={value.review?.questions||[]} targetId={targetId} linkToPreparation/>
        <section className={ownedClassName(styles.focus,true)} aria-labelledby="today-focus-title"><div className={ownedClassName(undefined,true)}><span className={ownedClassName(styles.eyebrow,true)}>{today?dayLabel(today.date,true):'오늘'}{selectedDeadline?.daysLeft!==null&&selectedDeadline?.daysLeft!==undefined&&selectedDeadline.daysLeft>=0?` · ${isPreparationGoal(selectedDeadline)?'준비 목표':'면접'}까지 ${selectedDeadline.daysLeft}일`:''}</span><h2 id="today-focus-title" className={ownedClassName(undefined,true)}>{focus?.title.split(' · ')[0]||((today?.capacityMinutes||0)===0?'오늘은 학습을 쉬는 날이에요.':tasks.length?pending.length?'직접 추가한 계획을 확인해요.':'오늘 계획을 모두 마쳤어요.':'면접 일정과 연습 질문을 먼저 확인해요.')}</h2><div className={ownedClassName(styles.dayMeta,true)}><span className={ownedClassName(undefined,true)}><Clock3 size={15}/>오늘 가능 {minuteLabel(today?.capacityMinutes||0)}</span><span className={ownedClassName(undefined,true)}>계획 {minuteLabel(today?.plannedMinutes||0)}</span><span className={ownedClassName(undefined,true)}>{finished}/{tasks.filter(task=>task.kind!=='break').length}개 마침</span></div></div><div className={ownedClassName(styles.focusAction,true)} data-has-next={Boolean(next)}>{next?<ActionButton className={ownedClassName("button primary")} pending={starting===next.id} disabled={Boolean(starting)} pendingLabel="훈련 준비 중" onClick={()=>void start(next)}><Play size={16}/>{next.kind==='diagnostic'?'첫 진단 시작':finished?'다음 훈련 시작':'오늘 계획 시작'}<ArrowRight size={16}/></ActionButton>:<Link className={ownedClassName("button ghost")} href="/preparation">준비 현황 확인<ArrowRight size={16}/></Link>}</div></section>
        <LearningDiscovery targetId={targetId}/>
        {!!value.warnings?.length&&<details className={ownedClassName(styles.warnings,true)}><summary className={ownedClassName(undefined,true)}>계획에 참고할 내용 {value.warnings.length}개<ChevronDown size={14}/></summary>{value.warnings.map((warning,index)=><p key={index} className={ownedClassName(undefined,true)}>{warning}</p>)}</details>}
        <section className={ownedClassName(styles.section,true)} aria-labelledby="today-plan-title"><div className={ownedClassName(styles.sectionHeading,true)}><h2 id="today-plan-title" className={ownedClassName(undefined,true)}>오늘의 순서</h2>{loading&&<span role="status" className={ownedClassName(undefined,true)}>기록 반영 중…</span>}</div><ol className={ownedClassName(styles.taskList,true)}>{tasks.map((task,index)=>{
          const complete=done(task),actionable=!complete&&(!task.manual||Boolean(task.href));
          const content=<><span className={ownedClassName(styles.taskNumber,true)} aria-label={complete?'완료':undefined}>{complete?<Check size={15}/>:String(index+1).padStart(2,'0')}</span><span className={ownedClassName(styles.taskCopy,true)}><span className={ownedClassName(styles.taskTop,true)}><span className={ownedClassName(undefined,true)}>{kindLabels[task.kind]||'훈련'} · 권장 {minuteLabel(task.minutes)}</span>{task.targetId&&task.targetId!==targetId&&<span className={ownedClassName(undefined,true)}>{targetName(data.targets.find(item=>item.id===task.targetId))}</span>}</span><strong className={ownedClassName(undefined,true)}>{task.title}</strong></span>{complete?<span className={ownedClassName(styles.complete,true)}><Check size={14}/>마침</span>:actionable?<span className={ownedClassName(styles.taskArrow,true)} aria-hidden="true">{starting===task.id?<span className={ownedClassName(styles.taskState,true)}>준비 중</span>:<ArrowRight size={19}/>}</span>:<span className={ownedClassName(styles.taskState,true)}>직접 추가한 계획</span>}</>;
          return <li key={task.id} data-complete={complete||undefined} className={ownedClassName(undefined,true)}>{actionable?<button type="button" className={ownedClassName(styles.taskTrigger,true)} disabled={Boolean(starting)&&startFlight.current?.scope===scopeToken} aria-busy={starting===task.id||undefined} aria-label={`${kindLabels[task.kind]||'훈련'} · ${task.title} · 권장 ${minuteLabel(task.minutes)} · ${task.status==='in_progress'?'이어 하기':'열기'}`} onClick={()=>void start(task)}>{content}</button>:<div className={ownedClassName(styles.taskStatic,true)}>{content}</div>}</li>;
        })}</ol>{!tasks.length&&<p className={ownedClassName(styles.note,true)}>{(today?.capacityMinutes||0)===0?'설정한 휴식일에는 새 훈련을 배치하지 않아요.':'연결한 일정과 연습할 질문을 확인해 주세요.'}</p>}</section>
      </>}
      {value.needsAvailability&&<LearningDiscovery targetId={targetId}/>}
      <section className={ownedClassName(styles.section,true)} aria-labelledby="interview-dates-title"><div className={ownedClassName(styles.sectionHeading,true)}><h2 id="interview-dates-title" className={ownedClassName(undefined,true)}>지원 학교 면접 일정</h2><Link href="/schools">일정 관리<ArrowUpRight size={14}/></Link></div><DeadlineList deadlines={value.deadlines} targetId={targetId}/></section>
      <TrainingCalendar revision={`${value.availability?.savedAt||''}:${value.today?.date||''}`} onPlanChange={reload}/>
      {!value.needsAvailability&&<section className={ownedClassName(styles.section,true)} aria-labelledby="week-plan-title"><div className={ownedClassName(styles.sectionHeading,true)}><div className={ownedClassName(undefined,true)}><h2 id="week-plan-title" className={ownedClassName(undefined,true)}>앞으로의 훈련</h2></div><Link href="/preparation">전체 준비 현황<ArrowUpRight size={14}/></Link></div><div className={ownedClassName(styles.weekList,true)}>{value.days.map(day=><div className={ownedClassName(styles.weekDay,true)} key={day.date}><time dateTime={day.date} className={ownedClassName(undefined,true)}>{dayLabel(day.date,true)}</time><div className={ownedClassName(styles.weekCategories,true)}>{summarizeTrainingPlans(day.tasks).map(group=><span key={group.kind} className={ownedClassName(undefined,true)}><strong className={ownedClassName(undefined,true)}>{group.label} {group.count}회</strong></span>)}</div><span className={ownedClassName(styles.weekMinutes,true)}>{minuteLabel(day.plannedMinutes)}<small className={ownedClassName(undefined,true)}>가능 {minuteLabel(day.capacityMinutes)}</small></span></div>)}</div></section>}
    </>}
  </div>;
}

function ReadinessEntry({item,targetId,reviewQuestions}:{item:ReadinessItem;targetId:string;reviewQuestions:ReviewQuestion[]}){
  const comparisonHref='/records/comparisons?activityId='+encodeURIComponent(item.id)+(targetId?'&targetId='+encodeURIComponent(targetId):'');
  const actionHref=item.kind==='question'?comparisonHref:item.editHref||item.sourceHref||comparisonHref;
  const reviewLabel=reviewStatusLabel(item.reviewStatus),reviewReason=item.reviewStatus==='active'?item.reviewReasons?.[0]:undefined;
  const unknownRequest=item.reviewStatus==='active'&&reviewQuestions.some(question=>question.targetId===targetId&&question.status==='active'&&question.requestedAtUnknown&&item.reviewQuestionKeys?.includes(question.questionKey));
  return <article className={ownedClassName(styles.readinessCard,true)}>
    <div className={ownedClassName(styles.readinessCardHeading,true)}><span className={ownedClassName(styles.activityKind,true)}>{item.kind==='activity'?'학생부':item.kind==='experience'?'내 경험':'질문 연습'}</span><span className={ownedClassName(styles.modeCounts,true)}><span className={ownedClassName(undefined,true)}>글 {item.textAttempts}</span><span className={ownedClassName(undefined,true)}>음성 {item.audioAttempts}</span></span></div>
    <h3 className={ownedClassName(undefined,true)}>{item.title}</h3>
    {reviewLabel&&<div className={ownedClassName(styles.readinessNext,true)} data-review-status={item.reviewStatus}><strong className={ownedClassName(undefined,true)}>{reviewLabel}</strong>{unknownRequest&&<InfoTip label="보완 요청 시점">요청 시점 미확인 · 이전에 선택한 보완점을 다시 확인해요.</InfoTip>}</div>}
    {(reviewReason||Boolean(item.needsReview?.length))&&<div className={ownedClassName(styles.readinessNext,true)}><span className={ownedClassName(undefined,true)}>다음 확인</span><strong className={ownedClassName(undefined,true)}>{reviewReason||item.needsReview[0]}</strong>{!reviewReason&&item.needsReview.length>1&&<small className={ownedClassName(undefined,true)}>외 {item.needsReview.length-1}개</small>}</div>}
    <nav className={ownedClassName(styles.readinessActions,true)} aria-label={item.title+' 준비 행동'}><Link className={ownedClassName("button ghost small")} href={actionHref}>{item.unconfirmed?'활동 사실 확인':item.kind==='question'?'답변 확인·비교':'활동 확인·보완'}<ArrowUpRight size={14}/></Link><Link className={ownedClassName(styles.subtleLink)} href="/my">오늘 훈련<ArrowRight size={14}/></Link></nav>
    <details className={ownedClassName(styles.readinessDetails,true)}><summary className={ownedClassName(undefined,true)}>세부 기록<ChevronDown size={15}/></summary><div className={ownedClassName(styles.activityDetail,true)}>
      <dl className={ownedClassName(styles.evidenceCounts,true)}><div className={ownedClassName(undefined,true)}><dt className={ownedClassName(undefined,true)}>본질문 답변</dt><dd className={ownedClassName(undefined,true)}>{item.mainAnswers}개</dd></div><div className={ownedClassName(undefined,true)}><dt className={ownedClassName(undefined,true)}>꼬리질문 답변</dt><dd className={ownedClassName(undefined,true)}>{item.followupAnswers}개</dd></div><div className={ownedClassName(undefined,true)}><dt className={ownedClassName(undefined,true)}>도움 사용 기록</dt><dd className={ownedClassName(undefined,true)}>{item.assistedAttempts}회</dd></div><div className={ownedClassName(undefined,true)}><dt className={ownedClassName(undefined,true)}>최근 연습</dt><dd className={ownedClassName(undefined,true)}>{item.lastPracticedAt?dayLabel(item.lastPracticedAt):'아직 없음'}</dd></div></dl>
      {!!(item.needsReview?.length||item.reviewStatus==='active'&&item.reviewReasons?.length)&&<div className={ownedClassName(styles.reviewNotes,true)}><strong className={ownedClassName(undefined,true)}>남은 확인</strong><ul className={ownedClassName(undefined,true)}>{[...new Set([...(item.reviewStatus==='active'?item.reviewReasons||[]:[]),...item.needsReview||[]])].map((note,index)=><li key={index} className={ownedClassName(undefined,true)}>{note}</li>)}</ul></div>}
      {!!item.notes?.some(note=>note.confirmedByStudent)&&<div className={ownedClassName(styles.confirmedNotes,true)}><h3 className={ownedClassName(undefined,true)}>직접 확인한 내용</h3>{item.notes.filter(note=>note.confirmedByStudent).map(note=><div key={note.id} className={ownedClassName(undefined,true)}><p className={ownedClassName(undefined,true)}>{note.body}</p><span className={ownedClassName(undefined,true)}>{dayLabel(note.createdAt)} · 학생 확인 메모</span></div>)}</div>}
      <nav className={ownedClassName(styles.evidenceLinks,true)} aria-label={item.title+' 관련 자료'}>{item.kind!=='question'&&item.sourceHref&&<Link href={item.sourceHref}><BookOpen size={14}/>원문·근거</Link>}<Link href={comparisonHref}>답변 비교<ArrowUpRight size={14}/></Link></nav>
    </div></details>
  </article>;
}

export function PreparationOverview(){
  const {data,targetId}=useApp(),{value,error,loading,reload}=useTrainingData();
  const [filter,setFilter]=useState<'all'|'review'|'unconfirmed'>('all');
  const items=value?.readiness?.items||[],summary=value?.readiness?.summary;
  const visible=useMemo(()=>items.filter(item=>filter==='review'?hasReview(item):filter==='unconfirmed'?item.unconfirmed:true).sort((a,b)=>Number(b.unconfirmed)-Number(a.unconfirmed)||Number(a.mainAnswers+a.followupAnswers>0)-Number(b.mainAnswers+b.followupAnswers>0)||Number(hasReview(b))-Number(hasReview(a))||(b.needsReview?.length||0)-(a.needsReview?.length||0)),[items,filter]);
  const reviewCount=items.filter(hasReview).length,practiced=summary?.practiced??items.filter(item=>item.mainAnswers+item.followupAnswers>0).length;
  const next=value?.today.tasks.find(task=>!done(task)&&task.kind!=='break'&&(!task.manual||task.href));
  const confirmation=items.find(item=>item.unconfirmed&&(item.editHref||item.sourceHref));
  const nextTitle=value?.needsAvailability?'학습 시간 설정':next?next.title.split(' · ')[0]:items.length?'남은 보완점':'면접에 쓸 내 경험';
  const nextHref=value?.needsAvailability?'/availability':next?'/my':items.length?'#activity-readiness-title':'/armory';
  return <div className={ownedClassName(styles.hub,true)}>
    <TrainingHeader title="준비 현황" aside={<div className={ownedClassName(styles.headerLinks,true)}><a className={ownedClassName(styles.settingsLink,true)} href="#training-calendar" aria-label="캘린더"><CalendarDays size={16}/><span>캘린더</span></a><Link className={ownedClassName(styles.settingsLink)} href="/availability" aria-label="학습 시간"><Settings2 size={16}/><span>학습 시간</span></Link></div>}/>
    <details className={ownedClassName(styles.mobileResources,true)}><summary>준비 자료<ChevronDown size={16}/></summary><nav aria-label="준비 자료 바로가기">{[['/armory','내 경험'],['/materials','학생부·교재'],['/knowledge','지식한입'],['/materials/briefings','시사 브리핑'],['/schools','지원 학교'],['/account/confirmations','사실 확인']].map(([href,label])=><Link key={href} href={href}>{label}<ArrowUpRight size={16}/></Link>)}</nav></details>
    {!value?<LoadingOrError error={error} reload={reload}/>:<>
      {error&&<Alert>{error}</Alert>}
      <div className={ownedClassName(styles.preparationLead,true)}><section className={ownedClassName(styles.preparationFocus,true)} aria-labelledby="preparation-next-title"><div className={ownedClassName(undefined,true)}><span className={ownedClassName(styles.eyebrow,true)}>다음 준비</span><h2 id="preparation-next-title" className={ownedClassName(undefined,true)}>{nextTitle}</h2>{next&&<span className={ownedClassName(styles.preparationMeta,true)}>{minuteLabel(next.minutes)}{value.today.capacityMinutes>0?` · 오늘 가능 ${minuteLabel(value.today.capacityMinutes)}`:''}</span>}</div><div className={ownedClassName(styles.preparationActions,true)}><Link className={ownedClassName("button primary")} href={nextHref}>{value.needsAvailability?'학습 시간 설정':next?'오늘 훈련':items.length?'답변 확인':'내 경험 연결'}<ArrowRight size={16}/></Link>{confirmation&&<Link className={ownedClassName(styles.subtleLink)} href={confirmation.editHref||confirmation.sourceHref!}>활동 사실 확인<ArrowUpRight size={14}/></Link>}</div></section>
      <section className={ownedClassName(styles.preparationDates,true)} aria-labelledby="preparation-dates-title"><div className={ownedClassName(styles.sectionHeading,true)}><h2 id="preparation-dates-title" className={ownedClassName(undefined,true)}>면접까지 남은 시간</h2><Link href="/schools">학교·일정 수정<ArrowUpRight size={14}/></Link></div><DeadlineList deadlines={value.deadlines} targetId={targetId}/></section></div>
      <ReviewSummary questions={value.review?.questions||[]} targetId={targetId}/>
      <section className={ownedClassName(styles.section,true)} aria-labelledby="activity-readiness-title"><div className={ownedClassName(styles.sectionHeading,true)}><h2 id="activity-readiness-title" className={ownedClassName(undefined,true)}>활동별 준비<InfoTip label="준비 현황 집계 기준">제출한 글·음성 답변만 집계해요. 답변 횟수는 실력이나 합격 가능성을 뜻하지 않으며, 활동 사실과 말하기·꼬리질문 확인 여부를 구분해요.</InfoTip></h2>{loading&&<span role="status" className={ownedClassName(undefined,true)}>기록 반영 중…</span>}</div>
        <div className={ownedClassName(styles.readinessSummary,true)} role="group" aria-label="준비 항목 보기"><button type="button" aria-pressed={filter==='all'} onClick={()=>setFilter('all')} className={ownedClassName(undefined,true)}><span className={ownedClassName(undefined,true)}>전체 항목</span><strong className={ownedClassName(undefined,true)}>{summary?.total??items.length}</strong><small className={ownedClassName(undefined,true)}>답변한 항목 {practiced}개</small></button><button type="button" aria-pressed={filter==='review'} onClick={()=>setFilter('review')} className={ownedClassName(undefined,true)}><span className={ownedClassName(undefined,true)}>확인할 항목</span><strong className={ownedClassName(undefined,true)}>{reviewCount}</strong></button><button type="button" aria-pressed={filter==='unconfirmed'} onClick={()=>setFilter('unconfirmed')} className={ownedClassName(undefined,true)}><span className={ownedClassName(undefined,true)}>사실 확인</span><strong className={ownedClassName(undefined,true)}>{summary?.unconfirmed??items.filter(item=>item.unconfirmed).length}</strong></button></div>
        <div className={ownedClassName(styles.activityToolbar,true)}><span className={ownedClassName(undefined,true)}>{filter==='all'?'전체 항목':filter==='review'?'확인할 항목':'사실 확인'} · {visible.length}개</span><Link href="/armory">경험 정리·추가<ArrowUpRight size={14}/></Link></div>
        <div className={ownedClassName(styles.activityList,true)}>{visible.map(item=><ReadinessEntry key={item.kind+':'+item.id} item={item} targetId={targetId} reviewQuestions={value.review?.questions||[]}/>)}</div>
        {!items.length?<div className={ownedClassName(styles.preparationStart,true)}>{[{href:'/armory',title:'경험 정리',detail:'내가 한 행동부터',icon:Library},{href:'/materials',title:'학생부·교재',detail:'기록과 근거 확인',icon:BookOpen},{href:'/interview/chat',title:'첫 답변 남기기',detail:'공통 질문으로 시작',icon:MessagesSquare}].map(({href,title,detail,icon:Icon},index)=><Link href={href} key={href}><span className={ownedClassName(styles.startIcon,true)}><Icon size={21}/></span><span><small>0{index+1}</small><strong>{title}</strong><span>{detail}</span></span><ArrowUpRight size={17}/></Link>)}</div>:!visible.length&&<p className={ownedClassName(styles.note,true)}>이 조건에 해당하는 활동이 없어요.</p>}
      </section>

      <TrainingCalendar revision={`${value.availability?.savedAt||''}:${value.today?.date||''}`} onPlanChange={reload}/>
      <nav className={ownedClassName(styles.tools,true)} aria-label="준비 자료"><Link href="/materials">학생부·교재<ArrowUpRight size={14}/></Link><Link href="/account/confirmations">사실 확인<ArrowUpRight size={14}/></Link></nav>
    </>}
  </div>;
}
