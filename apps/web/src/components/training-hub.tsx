'use client';

import Link from 'next/link';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {usePathname,useRouter} from 'next/navigation';
import {ArrowRight,ArrowUpRight,BookOpen,CalendarDays,Check,ChevronDown,Clock3,History,Play,RefreshCw,Settings2} from 'lucide-react';
import {useApp} from './app-shell';
import {ActionButton,Alert,Spinner,InfoTip,api,post,targetName,type Item} from './shared';
import {learningScopeIdentity,splitInterviewsByLearningTarget} from '@/lib/learning-target-scope';
import {scheduleTrainingDayRefresh} from '@/lib/training-day-refresh';
import {TrainingCalendar} from './training-calendar';
import {summarizeTrainingPlans} from '@/lib/training-plan-summary';
import {trainingSequence,trainingTaskDone,nextTrainingStep} from '@/lib/training-flow';
import styles from './training-hub.module.css';

type TrainingTask={id:string;title:string;kind:string;minutes:number;reason:string;targetId:string;questionId?:string;href?:string;status:string;performedAt?:string;completed?:boolean;startedAt?:string;manual?:boolean};
type TrainingDay={date:string;capacityMinutes:number;plannedMinutes:number;remainingMinutes:number;tasks:TrainingTask[]};
type Deadline={targetId:string;university:string;department:string;date:string|null;source:string|null;label:string;periodStart?:string|null;periodEnd?:string|null;status:string;reason:string;daysLeft:number|null;availableMinutes:number};
type ReadinessItem={id:string;kind:'activity'|'experience'|'question';title:string;sourceHref?:string;editHref?:string;questionCount:number;mainAnswers:number;followupAnswers:number;textAttempts:number;audioAttempts:number;assistedAttempts:number;needsReview:string[];lastPracticedAt?:string|null;unconfirmed:boolean;notes?:Array<{id:string;body:string;confirmedByStudent:boolean;createdAt:string}>};
type TrainingData={availability:Item|null;needsAvailability:boolean;registeredAt?:string;deadlines:Deadline[];days:TrainingDay[];today:TrainingDay;readiness:{items:ReadinessItem[];summary:{total:number;practiced:number;unconfirmed:number}};diagnostics:Item|null;warnings?:string[]};
const kindLabels:Record<string,string>={diagnostic:'첫 진단',recall:'누적 복습',focus:'집중 보완',mixed:'연결 면접',review:'오늘 정리',break:'휴식'};
const done=trainingTaskDone;
function minuteLabel(value:number){if(!Number.isFinite(value))return '시간 확인 필요';const hours=Math.floor(value/60),minutes=value%60;return hours?`${hours}시간${minutes?` ${minutes}분`:''}`:`${minutes}분`;}
function dayLabel(day:string,weekday=false){if(!/^\d{4}-\d{2}-\d{2}/.test(day))return '일정 확인 필요';return new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'long',day:'numeric',...(weekday?{weekday:'short' as const}:{})}).format(new Date(day.slice(0,10)+'T12:00:00+09:00'));}
function deadlineDate(item:Deadline){if(item.source==='public_period'&&item.periodStart&&item.periodEnd)return `${dayLabel(item.periodStart)}–${dayLabel(item.periodEnd)}`;return item.date?dayLabel(item.date):'일정 확인 필요';}
function isPreparationGoal(item?:Deadline){return item?.source==='public_period'||item?.source==='goal';}
function deadlineCountdown(item:Deadline){
  if(item.status==='no_interview')return '대상 아님';
  if(item.daysLeft===null)return '확인 필요';
  const goal=isPreparationGoal(item);
  if(item.daysLeft<0)return goal?'준비 목표 지남':'면접일 지남';
  return `${goal?'준비 목표 ':''}${item.daysLeft===0?'D-day':`D-${item.daysLeft}`}`;
}

/** Refresh on answer saves, school changes and browser history restoration. */
function useTrainingData(){
  const {data,target,learningRevision}=useApp(),path=usePathname();
  const scope=JSON.stringify([data.user.id,target?.id,learningScopeIdentity(target||{}),data.package?.id,data.package?.active_version]);
  const [loaded,setLoaded]=useState<{scope:string;value:TrainingData}|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0);
  const reload=useCallback(()=>setRevision(value=>value+1),[]);
  useEffect(()=>scheduleTrainingDayRefresh(reload),[reload]);
  useEffect(()=>{const visible=()=>{if(document.visibilityState==='visible')reload();};window.addEventListener('focus',reload);window.addEventListener('pageshow',reload);document.addEventListener('visibilitychange',visible);return()=>{window.removeEventListener('focus',reload);window.removeEventListener('pageshow',reload);document.removeEventListener('visibilitychange',visible);};},[reload]);
  useEffect(()=>{
    const controller=new AbortController();let disposed=false;setLoading(true);setError('');
    void api<TrainingData>('/api/training'+(target?.id?'?targetId='+encodeURIComponent(target.id):''),{signal:controller.signal,cache:'no-store'}).then(value=>{if(!disposed)setLoaded({scope,value});}).catch(err=>{if(!disposed&&!controller.signal.aborted)setError((err as Error).message);}).finally(()=>{if(!disposed)setLoading(false);});
    return()=>{disposed=true;controller.abort();};
  },[scope,learningRevision,revision,path,target?.id]);
  return {value:loaded?.scope===scope?loaded.value:null,error,loading:loading||loaded?.scope!==scope,reload};
}

function TrainingHeader({title,description,aside}:{title:string;description:string;aside?:React.ReactNode}){
  return <header className={styles.header}><div><h1>{title}</h1><p>{description}</p></div>{aside}</header>;
}
function LoadingOrError({error,reload}:{error:string;reload:()=>void}){return error?<div className={styles.error}><Alert>{error}</Alert><button className="button ghost" onClick={reload}><RefreshCw size={16}/>다시 불러오기</button></div>:<Spinner/>;}
function DeadlineList({deadlines,targetId}:{deadlines:Deadline[];targetId:string}){
  const rows=[...deadlines].sort((a,b)=>Number(b.targetId===targetId)-Number(a.targetId===targetId));
  return <div className={styles.deadlines}>{rows.map(item=><div className={styles.deadline} key={item.targetId}><div><Link href={'/schools/'+encodeURIComponent(item.targetId)}>{item.university}<ArrowUpRight size={13}/></Link><span>{item.department}</span></div><div className={styles.deadlineDate}><strong>{item.status==='no_interview'?'면접 미실시':deadlineDate(item)}</strong><span>{item.label}</span>{item.status==='ready'&&<span>{isPreparationGoal(item)?'준비 목표 전':'면접 전'} 설정 시간 {minuteLabel(item.availableMinutes)}</span>}</div><span className={styles.daysLeft}>{deadlineCountdown(item)}</span></div>)}{!rows.length&&<p className={styles.note}>지원할 학교·학과·전형을 연결하면 실제 일정에 맞춰 계획을 준비해요. <Link href="/schools/new">지원 학교 등록</Link></p>}</div>;
}
function Tools(){return <nav className={styles.tools} aria-label="필요한 연습 직접 선택"><Link href="/learn">직접 연습 선택<ArrowUpRight size={14}/></Link><Link href="/interview">모의면접<ArrowUpRight size={14}/></Link><Link href="/on" onClick={event=>{const pause=new Event('gakja:open-on',{cancelable:true});window.dispatchEvent(pause);if(pause.defaultPrevented)event.preventDefault();}}>AI 비서<ArrowUpRight size={14}/></Link><Link href="/quiz/assignments">과제 확인<ArrowUpRight size={14}/></Link></nav>;}

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
  return <div className={styles.hub}>
    <TrainingHeader title="오늘 훈련" description={`${data.user.name||'학생'}님, 오늘 가능한 시간에 맞춰 순서대로 준비해요.`} aside={<div className={styles.headerLinks}><a className={styles.settingsLink} href="#training-calendar"><CalendarDays size={16}/>캘린더</a><Link className={styles.settingsLink} href="/availability"><Settings2 size={16}/>학습 시간 설정</Link></div>}/>
    {!value?<LoadingOrError error={error} reload={reload}/>:<>
      {error&&<Alert>{error}</Alert>}{actionError&&<Alert>{actionError}</Alert>}
      {value.needsAvailability?<section className={styles.setup} aria-labelledby="availability-title"><span className={styles.eyebrow}>내 일정으로 시작하기</span><h2 id="availability-title">면접 전, 언제 얼마나 준비할 수 있나요?</h2><p>평일·주말의 학습 시간과 학습하지 못하는 날을 알려 주세요. 지원 학교의 면접일까지 가능한 시간으로 계획을 만들어요.</p><Link className="button primary" href="/availability">학습 시간 설정<ArrowRight size={16}/></Link></section>:<>
        {active&&<aside className={styles.resume}><span><History size={17}/>이어서 답할 면접이 있어요.</span><Link href={resumeHref!}>저장한 질문에서 계속<ArrowRight size={15}/></Link></aside>}
        <section className={styles.focus} aria-labelledby="today-focus-title"><div><span className={styles.eyebrow}>{today?dayLabel(today.date,true):'오늘'}{selectedDeadline?.daysLeft!==null&&selectedDeadline?.daysLeft!==undefined&&selectedDeadline.daysLeft>=0?` · ${isPreparationGoal(selectedDeadline)?'준비 목표':'면접'}까지 ${selectedDeadline.daysLeft}일`:''}</span><h2 id="today-focus-title">{focus?.title.split(' · ')[0]||((today?.capacityMinutes||0)===0?'오늘은 학습을 쉬는 날이에요.':tasks.length?pending.length?'직접 추가한 계획을 확인해요.':'오늘 계획을 모두 마쳤어요.':'면접 일정과 연습 질문을 먼저 확인해요.')}</h2><p>{focus?.reason||((today?.capacityMinutes||0)===0?'가능한 시간이 달라지면 학습 시간 설정에서 변경할 수 있어요.':tasks.length?'새 답변은 준비 현황에 함께 반영돼요. 기록에서 보완한 내용을 확인해 보세요.':'지원 학교의 정확한 면접 일정과 질문을 연결하면 오늘 가능한 시간에 맞춰 계획을 준비해요.')}</p><div className={styles.dayMeta}><span><Clock3 size={15}/>오늘 가능 {minuteLabel(today?.capacityMinutes||0)}</span><span>계획 {minuteLabel(today?.plannedMinutes||0)}</span><span>{finished}/{tasks.filter(task=>task.kind!=='break').length}개 마침</span></div></div><div className={styles.focusAction} data-has-next={Boolean(next)}>{next?<ActionButton className="button primary" pending={starting===next.id} disabled={Boolean(starting)} pendingLabel="훈련 준비 중" onClick={()=>void start(next)}><Play size={16}/>{next.kind==='diagnostic'?'첫 진단 시작':finished?'다음 훈련 시작':'오늘 계획 시작'}<ArrowRight size={16}/></ActionButton>:<Link className="button ghost" href="/preparation">준비 현황 확인<ArrowRight size={16}/></Link>}<Link className={styles.subtleLink} href="/availability">시간·쉬는 날 변경</Link></div></section>
        {!!value.warnings?.length&&<details className={styles.warnings}><summary>계획에 참고할 내용 {value.warnings.length}개<ChevronDown size={14}/></summary>{value.warnings.map((warning,index)=><p key={index}>{warning}</p>)}</details>}
        <section className={styles.section} aria-labelledby="today-plan-title"><div className={styles.sectionHeading}><h2 id="today-plan-title">오늘의 순서</h2>{loading&&<span role="status">기록 반영 중…</span>}</div><ol className={styles.taskList}>{tasks.map((task,index)=>{
          const complete=done(task),actionable=!complete&&(!task.manual||Boolean(task.href));
          const content=<><span className={styles.taskNumber} aria-label={complete?'완료':undefined}>{complete?<Check size={15}/>:String(index+1).padStart(2,'0')}</span><span className={styles.taskCopy}><span className={styles.taskTop}><span>{kindLabels[task.kind]||'훈련'} · {minuteLabel(task.minutes)}</span>{task.targetId&&task.targetId!==targetId&&<span>{targetName(data.targets.find(item=>item.id===task.targetId))}</span>}</span><strong>{task.title}</strong>{task.reason&&<span className={styles.taskReason}>{task.reason}</span>}</span>{complete?<span className={styles.complete}><Check size={14}/>마침</span>:actionable?<span className={styles.taskArrow} aria-hidden="true">{starting===task.id?<span className={styles.taskState}>준비 중</span>:<ArrowRight size={19}/>}</span>:<span className={styles.taskState}>직접 추가한 계획</span>}</>;
          return <li key={task.id} data-complete={complete||undefined}>{actionable?<button type="button" className={styles.taskTrigger} disabled={Boolean(starting)&&startFlight.current?.scope===scopeToken} aria-busy={starting===task.id||undefined} aria-label={`${kindLabels[task.kind]||'훈련'} · ${task.title} · ${minuteLabel(task.minutes)} · ${task.status==='in_progress'?'이어 하기':'열기'}`} onClick={()=>void start(task)}>{content}</button>:<div className={styles.taskStatic}>{content}</div>}</li>;
        })}</ol>{!tasks.length&&<p className={styles.note}>{(today?.capacityMinutes||0)===0?'설정한 휴식일에는 새 훈련을 배치하지 않아요.':'연결한 일정과 연습할 질문을 확인해 주세요.'}</p>}</section>
      </>}
      <section className={styles.section} aria-labelledby="interview-dates-title"><div className={styles.sectionHeading}><h2 id="interview-dates-title">지원 학교 면접 일정</h2><Link href="/schools">일정 관리<ArrowUpRight size={14}/></Link></div><DeadlineList deadlines={value.deadlines} targetId={targetId}/></section>
      <TrainingCalendar revision={`${value.availability?.savedAt||''}:${value.today?.date||''}`} onPlanChange={reload}/>
      {!value.needsAvailability&&<section className={styles.section} aria-labelledby="week-plan-title"><div className={styles.sectionHeading}><div><h2 id="week-plan-title">앞으로의 훈련</h2><p>새 답변과 가능한 시간이 바뀌면 우선순위를 다시 맞춰요.</p></div><Link href="/preparation">전체 준비 현황<ArrowUpRight size={14}/></Link></div><div className={styles.weekList}>{value.days.map(day=><div className={styles.weekDay} key={day.date}><time dateTime={day.date}>{dayLabel(day.date,true)}</time><div className={styles.weekCategories}>{summarizeTrainingPlans(day.tasks).map(group=><span key={group.kind}><strong>{group.label} {group.count}회</strong>{group.minutes!==null&&<small>{group.minutes}분</small>}</span>)}</div><span className={styles.weekMinutes}>{minuteLabel(day.plannedMinutes)}<small>가능 {minuteLabel(day.capacityMinutes)}</small></span></div>)}</div></section>}
      <Tools/>
    </>}
  </div>;
}

function ReadinessEntry({item,targetId}:{item:ReadinessItem;targetId:string}){
  const comparisonHref='/records/comparisons?activityId='+encodeURIComponent(item.id)+(targetId?'&targetId='+encodeURIComponent(targetId):'');
  const actionHref=item.kind==='question'?comparisonHref:item.editHref||item.sourceHref||comparisonHref;
  return <article className={styles.readinessCard}>
    <div className={styles.readinessCardHeading}><span className={styles.activityKind}>{item.kind==='activity'?'학생부':item.kind==='experience'?'내 경험':'질문 연습'}</span><span className={styles.modeCounts}><span>글 {item.textAttempts}</span><span>음성 {item.audioAttempts}</span></span></div>
    <h3>{item.title}</h3>
    <div className={styles.readinessNext}>{item.needsReview?.length?<><span>다음 확인</span><strong>{item.needsReview[0]}</strong>{item.needsReview.length>1&&<small>외 {item.needsReview.length-1}개</small>}</>:<span>저장한 답변을 다시 확인할 수 있어요.</span>}</div>
    <nav className={styles.readinessActions} aria-label={item.title+' 준비 행동'}><Link className="button ghost small" href={actionHref}>{item.unconfirmed?'활동 사실 확인':item.kind==='question'?'답변 확인·비교':'활동 확인·보완'}<ArrowUpRight size={14}/></Link><Link className={styles.subtleLink} href="/my">오늘 훈련<ArrowRight size={14}/></Link></nav>
    <details className={styles.readinessDetails}><summary>세부 기록<ChevronDown size={15}/></summary><div className={styles.activityDetail}>
      <dl className={styles.evidenceCounts}><div><dt>본질문 답변</dt><dd>{item.mainAnswers}개</dd></div><div><dt>꼬리질문 답변</dt><dd>{item.followupAnswers}개</dd></div><div><dt>도움 사용 기록</dt><dd>{item.assistedAttempts}회</dd></div><div><dt>최근 연습</dt><dd>{item.lastPracticedAt?dayLabel(item.lastPracticedAt):'아직 없음'}</dd></div></dl>
      {!!item.needsReview?.length&&<div className={styles.reviewNotes}><strong>남은 확인</strong><ul>{item.needsReview.map((note,index)=><li key={index}>{note}</li>)}</ul></div>}
      {!!item.notes?.some(note=>note.confirmedByStudent)&&<div className={styles.confirmedNotes}><h3>직접 확인한 내용</h3>{item.notes.filter(note=>note.confirmedByStudent).map(note=><div key={note.id}><p>{note.body}</p><span>{dayLabel(note.createdAt)} · 학생 확인 메모</span></div>)}</div>}
      <nav className={styles.evidenceLinks} aria-label={item.title+' 관련 자료'}>{item.kind!=='question'&&item.sourceHref&&<Link href={item.sourceHref}><BookOpen size={14}/>원문·근거</Link>}<Link href={comparisonHref}>답변 비교<ArrowUpRight size={14}/></Link></nav>
    </div></details>
  </article>;
}

export function PreparationOverview(){
  const {data,targetId}=useApp(),{value,error,loading,reload}=useTrainingData();
  const [filter,setFilter]=useState<'all'|'review'|'unconfirmed'>('all');
  const items=value?.readiness?.items||[],summary=value?.readiness?.summary;
  const visible=useMemo(()=>items.filter(item=>filter==='review'?item.needsReview?.length:filter==='unconfirmed'?item.unconfirmed:true).sort((a,b)=>Number(b.unconfirmed)-Number(a.unconfirmed)||Number(a.mainAnswers+a.followupAnswers>0)-Number(b.mainAnswers+b.followupAnswers>0)||(b.needsReview?.length||0)-(a.needsReview?.length||0)),[items,filter]);
  const reviewCount=items.filter(item=>item.needsReview?.length).length,practiced=summary?.practiced??items.filter(item=>item.mainAnswers+item.followupAnswers>0).length;
  const next=value?.today.tasks.find(task=>!done(task)&&task.kind!=='break'&&(!task.manual||task.href));
  const confirmation=items.find(item=>item.unconfirmed&&(item.editHref||item.sourceHref));
  const nextTitle=value?.needsAvailability?'학습 가능 시간을 설정해요.':next?next.title.split(' · ')[0]:items.length?'답변과 남은 보완점을 확인해요.':'면접에서 이야기할 활동을 연결해요.';
  const nextHref=value?.needsAvailability?'/availability':next?'/my':items.length?'#activity-readiness-title':'/armory';
  return <div className={styles.hub}>
    <TrainingHeader title="준비 현황" description="지금 준비할 내용과 쌓인 답변을 확인해요." aside={<div className={styles.headerLinks}><a className={styles.settingsLink} href="#training-calendar"><CalendarDays size={16}/>캘린더</a><Link className={styles.settingsLink} href="/availability"><Settings2 size={16}/>학습 시간</Link></div>}/>
    {!value?<LoadingOrError error={error} reload={reload}/>:<>
      {error&&<Alert>{error}</Alert>}
      <section className={styles.preparationFocus} aria-labelledby="preparation-next-title"><div><span className={styles.eyebrow}>다음 준비</span><h2 id="preparation-next-title">{nextTitle}</h2>{next&&<span className={styles.preparationMeta}>{kindLabels[next.kind]||'훈련'} · {minuteLabel(next.minutes)}{value.today.capacityMinutes>0?` · 오늘 가능 ${minuteLabel(value.today.capacityMinutes)}`:''}</span>}</div><div className={styles.preparationActions}><Link className="button primary" href={nextHref}>{value.needsAvailability?'학습 시간 설정':next?'오늘 훈련':items.length?'답변 살펴보기':'내 경험 연결'}<ArrowRight size={16}/></Link>{confirmation&&<Link className={styles.subtleLink} href={confirmation.editHref||confirmation.sourceHref!}>활동 사실 확인<ArrowUpRight size={14}/></Link>}</div></section>
      <section className={styles.section} aria-labelledby="preparation-dates-title"><div className={styles.sectionHeading}><h2 id="preparation-dates-title">면접까지 남은 시간</h2><Link href="/schools">학교·일정 수정<ArrowUpRight size={14}/></Link></div><DeadlineList deadlines={value.deadlines} targetId={targetId}/></section>
      <section className={styles.section} aria-labelledby="activity-readiness-title"><div className={styles.sectionHeading}><h2 id="activity-readiness-title">활동별 준비<InfoTip label="준비 현황 집계 기준">제출한 글·음성 답변만 집계해요. 답변 횟수는 실력이나 합격 가능성을 뜻하지 않으며, 활동 사실과 말하기·꼬리질문 확인 여부를 구분해요.</InfoTip></h2>{loading&&<span role="status">기록 반영 중…</span>}</div>
        <div className={styles.readinessSummary} role="group" aria-label="준비 항목 보기"><button type="button" aria-pressed={filter==='all'} onClick={()=>setFilter('all')}><span>전체 항목</span><strong>{summary?.total??items.length}</strong><small>답변 {practiced}개</small></button><button type="button" aria-pressed={filter==='review'} onClick={()=>setFilter('review')}><span>보완할 항목</span><strong>{reviewCount}</strong></button><button type="button" aria-pressed={filter==='unconfirmed'} onClick={()=>setFilter('unconfirmed')}><span>사실 확인</span><strong>{summary?.unconfirmed??items.filter(item=>item.unconfirmed).length}</strong></button></div>
        <div className={styles.activityToolbar}><span>{filter==='all'?'전체 항목':filter==='review'?'보완할 항목':'사실 확인'} · {visible.length}개</span><Link href="/armory">경험 정리·추가<ArrowUpRight size={14}/></Link></div>
        <div className={styles.activityList}>{visible.map(item=><ReadinessEntry key={item.kind+':'+item.id} item={item} targetId={targetId}/>)}</div>
        {!items.length?<div className={styles.empty}><BookOpen size={26}/><h3>아직 연결한 활동이 없어요.</h3><Link className="button primary" href="/armory">내 경험 정리<ArrowRight size={16}/></Link></div>:!visible.length&&<p className={styles.note}>이 조건에 해당하는 활동이 없어요.</p>}
      </section>

      <TrainingCalendar revision={`${value.availability?.savedAt||''}:${value.today?.date||''}`} onPlanChange={reload}/>
      <nav className={styles.tools} aria-label="준비 자료"><Link href="/materials">학생부·교재<ArrowUpRight size={14}/></Link><Link href="/account/confirmations">사실 확인<ArrowUpRight size={14}/></Link></nav>
    </>}
  </div>;
}
