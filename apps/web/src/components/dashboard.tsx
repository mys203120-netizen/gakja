'use client';
import Link from 'next/link';
import {useEffect,useState} from 'react';
import {ArrowUpRight,Play,BookOpen,Check,Clock3,CalendarDays,Newspaper,Quote} from 'lucide-react';
import {useApp} from './app-shell';
import {ActionButton,dateLabel,LinkedRow,api,post,Modal,Alert,targetName,type Item} from './shared';
import {DashboardPlanner,type InterviewScheduleItem,type InterviewScheduleCoverage} from './dashboard-planner';
import {koreaToday,validPlanDay} from '@/lib/planner-model';
import {todayPlanAgenda} from '@/lib/automatic-practice';
import {dashboardDeadlineRows,primaryDeadlineRow} from '@/lib/dashboard-deadlines';
import {scheduleDateLabel} from '@/lib/schedule';
import {chooseTodayAction,learningHref,localQuizDraftActivity,type QuizDraftActivity} from '@/lib/learning-journey';
import {practiceHelpLabel,questionPracticeState,todayQuestionContext} from '@/lib/learning-flow-view';
import {DepartmentNews} from './department-news';
import {splitInterviewsByLearningTarget} from '@/lib/learning-target-scope';
import {learningTargetIdentityMatches} from '@gakja/content-contracts/workflows';
import {learningScopeIdentity} from '@/lib/learning-target-scope';
import styles from './learning-flow-ui.module.css';

type ReadingView='briefing'|'knowledge';
const readingViews=[{id:'briefing' as const,label:'시사 브리핑',href:'/materials/briefings',icon:Newspaper},{id:'knowledge' as const,label:'지식한입',href:'/knowledge',icon:BookOpen}];
export function Dashboard() {
  const {data,target,learningRevision=0}=useApp();
  const loadScope=JSON.stringify([data.user.id,target?.id,learningScopeIdentity(target||{}),data.package?.id,data.package?.active_version]);
  const [workflows,setWorkflows]=useState<Item|null>(null),[study,setStudy]=useState<Item|null>(null),[plans,setPlans]=useState<Item[]>([]),[videos,setVideos]=useState<Item[]>([]),[quiz,setQuiz]=useState<Item|null>(null),[schools,setSchools]=useState<Item|null>(null),[error,setError]=useState(''),[ready,setReady]=useState(false);
  const [plannerLoaded,setPlannerLoaded]=useState(false),[knowledgeLoaded,setKnowledgeLoaded]=useState(false),[readingView,setReadingView]=useState<ReadingView>('briefing');
  const [interviewSchedules,setInterviewSchedules]=useState<InterviewScheduleItem[]>([]),[interviewScheduleCoverage,setInterviewScheduleCoverage]=useState<InterviewScheduleCoverage>();
  const [automaticPractice,setAutomaticPractice]=useState<Item[]>([]);
  const [loading,setLoading]=useState({scope:loadScope,learning:true,planner:true,study:true,knowledge:true,quiz:true,schools:true});
  const [localDrafts,setLocalDrafts]=useState<{scope:string;items:QuizDraftActivity[]}>({scope:'',items:[]});
  useEffect(()=>{
    const read=()=>{const stores:Storage[]=[];try{stores.push(localStorage);}catch{}try{stores.push(sessionStorage);}catch{}setLocalDrafts({scope:loadScope,items:localQuizDraftActivity(data.user.id,quiz?.sessions||[],stores)});};
    read();window.addEventListener('storage',read);window.addEventListener('focus',read);return()=>{window.removeEventListener('storage',read);window.removeEventListener('focus',read);};
  },[data.user.id,loadScope,quiz]);
  useEffect(()=>{
    let disposed=false;const controller=new AbortController(),pendingCore=new Set(['learning','study','quiz']);let coreFailed=false;
    setReady(false);setError('');setWorkflows(null);setStudy(null);setQuiz(null);setSchools(null);setPlans([]);setAutomaticPractice([]);setVideos([]);setInterviewSchedules([]);setInterviewScheduleCoverage(undefined);setPlannerLoaded(false);setKnowledgeLoaded(false);
    setLoading({scope:loadScope,learning:true,planner:true,study:true,knowledge:true,quiz:true,schools:true});
    const scope=target?.id?'?targetId='+encodeURIComponent(target.id):'';
    function load(key:'learning'|'planner'|'study'|'knowledge'|'quiz'|'schools',url:string,apply:(value:Item)=>void){
      void api(url,{signal:controller.signal}).then(value=>{if(!disposed)apply(value);}).catch(err=>{
        if(disposed||controller.signal.aborted)return;
        if(pendingCore.has(key))coreFailed=true;
        setError(previous=>[previous,(err as Error).message].filter(Boolean).join(' '));
      }).finally(()=>{
        if(disposed)return;
        setLoading(previous=>({...previous,[key]:false}));pendingCore.delete(key);
        if(!pendingCore.size)setReady(!coreFailed);
      });
    }
    load('learning','/api/learning',setWorkflows);
    load('planner','/api/planner',value=>{setPlans(value.plans||[]);setAutomaticPractice(value.automaticPractice||[]);setInterviewSchedules(value.interviewSchedules||[]);setInterviewScheduleCoverage(value.interviewScheduleCoverage);setPlannerLoaded(true);});
    load('study','/api/study-sessions',setStudy);
    load('knowledge','/api/knowledge-bites'+scope,value=>{setVideos((value.videos||[]).filter((v:Item)=>v.current));setKnowledgeLoaded(true);});
    load('quiz','/api/quiz'+scope,setQuiz);
    load('schools','/api/schools?scope=learning'+(target?.id?'&targetId='+encodeURIComponent(target.id):''),setSchools);
    return()=>{disposed=true;controller.abort();};
  },[loadScope,learningRevision]);
  // A target switch renders its own pending state immediately, before effects run.
  if(loading.scope!==loadScope)return <div className={styles.dashboard}><header className={styles.pageHeading}><div><p>{data.user.name}님의 각자ON</p><h1>내 기록에서, 내 말로.</h1></div></header><p role="status">선택한 지원처의 학습을 불러오고 있어요.</p></div>;
  const coreLoading=loading.learning||loading.study||loading.quiz;
  const today=koreaToday(),activities:Item[]=data.learning?.activities||[],questions:Item[]=[...(data.learning?.questions||[]),...(schools?.commonQuestions||[])];
  const deadlineRows=dashboardDeadlineRows(data.targets,interviewSchedules,interviewScheduleCoverage,today),firstDeadline=primaryDeadlineRow(deadlineRows,target?.id);
  const calendarTasks:Item[]=(workflows?.assignments||[]).filter((t:Item)=>!['reviewed','completed','cancelled'].includes(t.state));
  const tasks:Item[]=calendarTasks.filter((t:Item)=>!t.target_id||t.target_id===target?.id);
  const readiness=workflows?.readiness?.find((r:Item)=>r.target_id===target?.id);
  const todayPlans=todayPlanAgenda(plans,today,target?.id),remaining=todayPlans.filter(p=>!p.completed&&!p.performedAt).length;
  const preparation=automaticPractice.find(item=>item.targetId===target?.id);
  const interviews=splitInterviewsByLearningTarget(data.interviews||[],target).current;
  const active=interviews.find(s=>s.state==='active');
  const scopedQuiz=quiz?{...quiz,sessions:(quiz.sessions||[]).filter((session:Item)=>{
    const savedId=session.metadata?.targetId||session.metadata?.target_id||session.metadata?.targetSnapshot?.id;
    const snapshot=session.metadata?.targetSnapshot;
    return Boolean(target&&snapshot&&savedId===target.id&&learningTargetIdentityMatches(learningScopeIdentity(snapshot),learningScopeIdentity(target)));
  })}:null;
  const next=chooseTodayAction({studentId:data.user.id,localDrafts:localDrafts.scope===loadScope?localDrafts.items:[],targets:target?[target]:[],quiz:scopedQuiz,study,assignments:tasks,interviews,hasPackage:Boolean(data.package),commonQuestions:schools?.commonQuestions});
  const focusedInterview=next.resume==='interview'?active:undefined;
  const suggestedId=next.questionId||quiz?.recommendation?.items?.[0]?.question_id;
  const question=focusedInterview?.data?.currentQuestion||focusedInterview?.data?.questionQueue?.[Number(focusedInterview.data.index||0)]||(!next.resume&&questions.find(q=>q.id===suggestedId&&(!q.support_target_ids?.length||q.support_target_ids.includes(target?.id))));
  const focusedTarget=focusedInterview?.data?.context?.target||target,focusedVersion=focusedInterview?.content_version||data.package?.active_version;
  const context=question?todayQuestionContext(question,focusedTarget?.id,focusedVersion):null;
  const activity=(focusedInterview?.data?.context?.activities||activities).find((a:Item)=>question?.activity_ids?.includes(a.id));
  const progress=question?questionPracticeState(workflows?.answerRevisions||[],question,focusedTarget,question.common_revision?undefined:Number(focusedVersion)):null;
  const primary=context&&next.href==='/my/today'?{href:learningHref('/my/today',context),label:progress?.latest?'이 질문 이어가기':'이 질문에 답하기'}:next;
  const latest=progress?.latest,currentReading=readingViews.find(view=>view.id===readingView)!;
  const schoolHref=target?`/schools/${target.id}`:'/schools/new';
  const confirmations=(workflows?.confirmations||[]).filter((item:Item)=>['needs_confirmation','student_says_different','cannot_confirm'].includes(item.confirmation_status)&&(item.entity_id===question?.id||item.entity_id===activity?.id||activity?.source_ref_ids?.includes(item.entity_id)));
  return <div className={styles.dashboard}>
    <header className={styles.pageHeading}><div><p>{data.user.name}님의 각자ON</p><h1>내 기록에서, 내 말로.</h1></div><time>{new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'long',day:'numeric',weekday:'long'}).format(new Date())}</time></header>
    {error&&<Alert>{error}</Alert>}
    <section className={styles.focus} aria-labelledby="dashboard-next-title">
      <div className={styles.focusCopy}><span className={styles.kicker}>{next.resume?'하던 답을 이어서':latest?'이번에 보완할 한 가지':'이번에 꺼내 볼 나의 답'}</span><h2 id="dashboard-next-title">{ready?(question?.prompt||next.title):coreLoading?'오늘의 질문을 불러오고 있어요.':'오늘의 질문을 확인하지 못했어요.'}</h2>{ready&&<p>{next.reason}</p>}
        {context&&<div className={styles.contextTrail}>{activity&&<Link href={learningHref('/my/today',context)}><BookOpen size={14}/>{activity.title}</Link>}<span>{targetName(focusedTarget)}{focusedTarget?.department||focusedTarget?.major?' · '+(focusedTarget.department||focusedTarget.major):''}</span></div>}
        {!!confirmations.length&&<Link className={styles.confirmation} href="/account/confirmations">확인이 필요한 경험이 있어요.<ArrowUpRight size={14}/></Link>}
      </div><div className={styles.focusActions}>{ready?<Link className="button primary" href={primary.href}><Play size={16}/>{primary.label}<ArrowUpRight size={17}/></Link>:coreLoading?<ActionButton className="button primary" pending pendingLabel="질문 불러오는 중">질문 준비</ActionButton>:<Link className="button primary" href="/interview">질문 골라 연습하기<ArrowUpRight size={17}/></Link>}{primary.href!==schoolHref&&<Link className="text-link" href={schoolHref}>{target?'학교 면접 안내':'지원 학교 등록'}<ArrowUpRight size={14}/></Link>}</div>
    </section>
    <section className={styles.deadlines} aria-labelledby="dashboard-deadlines-title"><div className={styles.sectionHeading}><h2 id="dashboard-deadlines-title">지원 대학 면접 일정</h2><Link className="text-link" href="/schools">일정 관리<ArrowUpRight size={14}/></Link></div>
      {firstDeadline?<><ul className={styles.deadlineList}><DeadlineRow row={firstDeadline} loading={loading.planner}/></ul>{deadlineRows.length>1&&<details className={styles.remainingDeadlines}><summary>다른 지원처 일정 {deadlineRows.length-1}개</summary><ul className={styles.deadlineList}>{deadlineRows.filter(row=>row.school.id!==firstDeadline.school.id).map(row=><DeadlineRow key={row.school.id} row={row} loading={loading.planner}/>)}</ul></details>}</>:<p className={styles.emptyNote}>지원 학교는 첫 질문을 답한 뒤 등록해도 돼요. <Link className="text-link" href="/schools/new">지원 학교 등록<ArrowUpRight size={14}/></Link></p>}
    </section>
    <div className={styles.workspace}>
      <section className={styles.agenda} aria-labelledby="dashboard-agenda-title"><div className={styles.sectionHeading}><h2 id="dashboard-agenda-title"><CalendarDays size={18}/>오늘 할 일</h2><Link className="text-link" href="/quiz/assignments">과제 전체<ArrowUpRight size={14}/></Link></div><div className={styles.indented}>
        {preparation&&<p className={styles.smallNote}><strong>{preparation.daysLeft>0?`D-${preparation.daysLeft}`:preparation.daysLeft===0?'D-day':'면접일 지남'}</strong> · {preparation.status==='paused'?'자동 계획 중지':preparation.daysLeft<0?'다음 면접일을 확인해 주세요':preparation.phaseLabel}<br/>{preparation.dateLabel} · {preparation.date}</p>}
        {(remaining>0||tasks.length>0)&&<p className={styles.smallNote}>{[remaining>0?`남은 계획 ${remaining}개`:null,tasks.length>0?`과제 ${tasks.length}개`:null].filter(Boolean).join(' · ')}</p>}
        <DashboardAgenda plans={todayPlans} tasks={tasks} today={today} onPlans={setPlans} loading={loading.learning||loading.planner} available={Boolean(workflows&&plannerLoaded)}/>
        <nav className={styles.quietLinks} aria-label="직접 연습하기">{data.package&&<Link href="/quiz?focus=free">퀴즈 연습<ArrowUpRight size={14}/></Link>}<Link href={active?`/interview/${active.id}?kind=${active.kind}`:'/interview'}>{active?'면접 이어가기':'모의면접'}<ArrowUpRight size={14}/></Link><Link href={'/start'+(target?'?targetId='+encodeURIComponent(target.id):'')}>3분 · 질문 한 개<ArrowUpRight size={14}/></Link></nav>
      </div></section>
      <section className={styles.answerRecord} aria-labelledby="dashboard-answer-title"><div className={styles.sectionHeading}><h2 id="dashboard-answer-title"><Quote size={18}/>이 답의 기록</h2><Link className="text-link" href={context?learningHref('/records/comparisons',context):'/records'}>변화 보기<ArrowUpRight size={14}/></Link></div><div className={styles.indented}>
        {latest?<><blockquote>{latest.script}</blockquote><p className={styles.recordCaption}>{dateLabel(latest.created_at)} · {latest.response_mode==='audio'?'음성 답변':latest.response_mode==='video'?'영상 답변':'입력한 답변'} · {practiceHelpLabel(latest)}</p><Link className={styles.recordNext} href={context?learningHref('/my/today',context):'/records'}>{latest.assisted||latest.ai_assisted||latest.hint_used?'이번엔 자료를 덮고 새로 답하기':progress?.canCompare?'이전 답과 달라진 문장 확인':'새 답을 남겨 나란히 보기'}<ArrowUpRight size={15}/></Link></>:<p className={styles.emptyNote}>{loading.learning?'답변 기록을 불러오고 있어요.':workflows?'직접 남긴 답변이 아직 없어요. 새 답을 남기면 이 질문의 기록으로 이어져요.':'답변 기록을 확인하지 못했어요.'}</p>}
        {Boolean(readiness?.needs_confirmation_ids?.length)&&<Link className={styles.confirmation} href="/account/confirmations">사실 확인 {readiness.needs_confirmation_ids.length}개<ArrowUpRight size={14}/></Link>}
      </div></section>
    </div>
    <div className={styles.lowerWorkspace}>
    <section className={styles.reading} data-view={readingView} aria-labelledby="dashboard-reading-title"><div className={styles.sectionHeading}><h2 id="dashboard-reading-title">답에 더할 한 가지</h2><Link className="text-link" href={currentReading.href}>전체 보기<ArrowUpRight size={14}/></Link></div><div className={styles.indented}>
      <div className={styles.readingSwitch} role="group" aria-label="이어 볼 자료 선택">{readingViews.map(view=>{const Icon=view.icon;return <button key={view.id} type="button" aria-pressed={readingView===view.id} onClick={()=>setReadingView(view.id)}><Icon size={15}/>{view.label}</button>;})}</div>
      <div className={styles.readingContent} aria-live="polite">{readingView==='briefing'&&<DepartmentNews variant="compact" showHeading={false}/>}{readingView==='knowledge'&&(videos.length?<Link className={styles.readingVideo} href={`/knowledge/${videos[0].id}`}><img src={videos[0].thumbnail} alt="" loading="lazy"/><div><span>{videos[0].label}</span>{videos[0].activities?.[0]?.title&&<small>{videos[0].activities[0].title}</small>}</div><ArrowUpRight size={16}/></Link>:loading.knowledge?<p className={styles.emptyNote}>자료를 불러오고 있어요.</p>:activities.length?<LinkedRow href={`/knowledge?activity=${activities[0].id}`} title={activities[0].title} subtitle="이 경험에서 넓혀 볼 주제"/>:<p className={styles.emptyNote}>{knowledgeLoaded?'연결된 자료가 아직 없어요.':'자료를 불러오지 못했어요.'}</p>)}</div>
    </div></section>
    <div className={styles.calendar}>{!loading.planner&&!plannerLoaded?<p className={styles.emptyNote}>일정을 확인하지 못했어요. <Link className="text-link" href={target?`/schools/${target.id}`:'/schools/new'}>학교 일정 안내<ArrowUpRight size={14}/></Link></p>:<DashboardPlanner plans={plans} onPlans={setPlans} tasks={calendarTasks} interviewSchedules={interviewSchedules} interviewScheduleCoverage={interviewScheduleCoverage} automaticPractice={automaticPractice} onAutomaticPractice={setAutomaticPractice} loaded={plannerLoaded}/>}</div>
    </div>
  </div>;
}

function DeadlineRow({row,loading}:{row:ReturnType<typeof dashboardDeadlineRows>[number];loading:boolean}){
  const {school,deadline,days,label}=row;
  return <li><Link className={styles.deadlineRow} href={`/schools/${school.id}`}><div><strong>{targetName(school)}</strong><small>{[school.department||school.major,school.admission_type||school.track,deadline&&scheduleDateLabel(deadline.date)].filter(Boolean).join(' · ')}{deadline?.source==='public_day'&&' · 학교 공개일, 개별 일정 확인 필요'}</small></div><span className={days===null?styles.deadlineMissing:styles.deadlineCount}>{loading&&days===null?'일정 확인 중':label}{days===null&&row.canRegister&&<ArrowUpRight size={16}/>}</span></Link></li>;
}

function DashboardAgenda({plans,tasks,today,onPlans,loading,available}:{plans:Item[];tasks:Item[];today:string;onPlans:React.Dispatch<React.SetStateAction<Item[]>>;loading:boolean;available:boolean}){
  const [moving,setMoving]=useState<Item|null>(null),[date,setDate]=useState(today),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const current=plans.filter(plan=>!plan.overdue),overdue=plans.filter(plan=>plan.overdue);
  const pastTasks=tasks.filter(task=>task.due_at&&koreaToday(new Date(task.due_at))<today);
  const currentTasks=tasks.filter(task=>!pastTasks.includes(task)).sort((a,b)=>String(a.due_at||'9999').localeCompare(String(b.due_at||'9999')));
  const planRow=(plan:Item)=><div key={plan.id} className={`${styles.todayPlan} ${plan.completed?styles.completed:''}`}>{plan.completed?<Check size={15}/>:<Clock3 size={15}/>}<span>{plan.title}{plan.performedAt?' · 실제 연습 기록 있음':''}{plan.overdue&&<small>{plan.date} 계획</small>}</span><div className={styles.planActions}>{plan.href&&(!plan.completed||plan.performedAt)&&<Link className="text-link" href={plan.href}>{plan.performedAt?'다시 연습':'시작'}<ArrowUpRight size={13}/></Link>}{plan.overdue&&<button type="button" className="text-link" onClick={()=>{setMoving(plan);setDate(today);setConfirmed(false);setError('');}}>다른 날로</button>}</div></div>;
  const taskRow=(task:Item)=><LinkedRow key={task.id} href={`/quiz/assignments/${task.id}`} title={task.title||'퀴즈 과제'} subtitle={`${task.items?.length||0}문항${task.due_at?` · ${dateLabel(task.due_at)}까지`:''}`} end={<span className={styles.itemState}>{task.state==='submitted'?'검토 중':'풀기'}{task.state!=='submitted'&&<ArrowUpRight size={14}/>}</span>}/>;
  async function move(){
    if(!moving||!confirmed||!validPlanDay(date)||date<today||busy)return;
    setBusy(true);setError('');try{
      const result=await post('/api/planner',{action:'update',id:moving.id,expectedRevision:moving.revision,date});
      onPlans(previous=>previous.map(plan=>plan.id===moving.id?result.plan:plan));setMoving(null);
    }catch(err){setError((err as Error).message);}finally{setBusy(false);}
  }
  return <div className={styles.agendaItems}>
    {currentTasks.slice(0,2).map(taskRow)}{current.slice(0,3).map(planRow)}
    {!currentTasks.length&&!current.length&&<p className={styles.emptyNote}>{loading?'할 일을 불러오고 있어요.':!available?'할 일을 모두 확인하지 못했어요.':'오늘은 질문 한 개부터 가볍게 시작해요.'}</p>}
    {(current.length>3||currentTasks.length>2)&&<details className={styles.agendaDisclosure}><summary>오늘 남은 계획·과제 {Math.max(0,current.length-3)+Math.max(0,currentTasks.length-2)}개 더 보기</summary>{currentTasks.slice(2).map(taskRow)}{current.slice(3).map(planRow)}</details>}
    {(overdue.length>0||pastTasks.length>0)&&<details className={styles.agendaDisclosure}><summary>밀린 계획·과제 {overdue.length+pastTasks.length}개 · 오늘 할 만큼 고르기</summary><p className={styles.smallNote}>하나만 골라 시작하거나 다른 날로 옮겨도 돼요. 직접 완료하기 전에는 완료로 바뀌지 않아요.</p>{overdue.map(planRow)}{pastTasks.map(taskRow)}</details>}
    <a className={styles.recordNext} href="#dashboard-planner">전체 계획 보기<ArrowUpRight size={14}/></a>
    {moving&&<Modal title="이 계획을 다른 날로 옮길까요?" onClose={()=>!busy&&setMoving(null)}><p>{moving.title}</p><label className={styles.moveDate}>옮길 날짜<input type="date" min={today} value={date} onChange={event=>{setDate(event.target.value);setConfirmed(false);}}/></label><label className={styles.moveConfirmation}><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>날짜만 옮기고 완료 여부와 기존 연습 기록은 유지할게요.</label>{error&&<Alert>{error}</Alert>}<div className="inline-actions"><button className="button ghost" disabled={busy} onClick={()=>setMoving(null)}>취소</button><ActionButton className="button primary" pending={busy} disabled={!confirmed||!validPlanDay(date)||date<today} onClick={()=>void move()}>확인하고 옮기기</ActionButton></div></Modal>}
  </div>;
}
