'use client';
import Link from 'next/link';
import {useEffect,useState} from 'react';
import {ArrowUpRight,Play,BookOpen,Check,Clock3,CalendarDays,Newspaper,Quote} from 'lucide-react';
import {useApp} from './app-shell';
import {ActionButton,dateLabel,LinkedRow,api,Alert,targetName,type Item} from './shared';
import {DashboardPlanner,type InterviewScheduleItem,type InterviewScheduleCoverage} from './dashboard-planner';
import {koreaToday} from '@/lib/planner-model';
import {practiceDeadline,practiceDaysLeft,todayPlanAgenda} from '@/lib/automatic-practice';
import {scheduleDateLabel} from '@/lib/schedule';
import {chooseTodayAction,learningHref} from '@/lib/learning-journey';
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
  const deadlineRows=data.targets.map(school=>{
    const matched=interviewSchedules.filter(item=>item.targetId===school.id&&item.applicability==='track_match'&&item.format!=='video_submission');
    const publicDay=matched.length&&matched.every(item=>item.startDate===item.endDate&&item.startDate===matched[0].startDate)?matched[0].startDate:undefined;
    const deadline=practiceDeadline(school)||practiceDeadline({...school,school_interview_date:publicDay});
    return {school,deadline,days:deadline?practiceDaysLeft(today,deadline.date):null};
  });
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
  const next=chooseTodayAction({targets:target?[target]:[],quiz:scopedQuiz,study,assignments:tasks,interviews,hasPackage:Boolean(data.package),commonQuestions:schools?.commonQuestions});
  const suggestedId=next.questionId||quiz?.recommendation?.items?.[0]?.question_id;
  const question=active?.data?.currentQuestion||active?.data?.questionQueue?.[Number(active.data.index||0)]||questions.find(q=>q.id===suggestedId&&(!q.support_target_ids?.length||q.support_target_ids.includes(target?.id)));
  const focusedTarget=active?.data?.context?.target||target,focusedVersion=active?.content_version||data.package?.active_version;
  const context=question?todayQuestionContext(question,focusedTarget?.id,focusedVersion):null;
  const activity=(active?.data?.context?.activities||activities).find((a:Item)=>question?.activity_ids?.includes(a.id));
  const progress=question?questionPracticeState(workflows?.answerRevisions||[],question,focusedTarget,question.common_revision?undefined:Number(focusedVersion)):null;
  const primary=active?{href:`/interview/${active.id}?kind=${active.kind}`,label:'면접 이어가기'}:context&&next.href==='/my/today'?{href:learningHref('/my/today',context),label:progress?.latest?'이 질문 이어가기':'이 질문에 답하기'}:next;
  const latest=progress?.latest,currentReading=readingViews.find(view=>view.id===readingView)!;
  const schoolHref=target?`/schools/${target.id}`:'/schools/new';
  const confirmations=(workflows?.confirmations||[]).filter((item:Item)=>['needs_confirmation','student_says_different','cannot_confirm'].includes(item.confirmation_status)&&(item.entity_id===question?.id||item.entity_id===activity?.id||activity?.source_ref_ids?.includes(item.entity_id)));
  return <div className={styles.dashboard}>
    <header className={styles.pageHeading}><div><p>{data.user.name}님의 각자ON</p><h1>내 기록에서, 내 말로.</h1></div><time>{new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'long',day:'numeric',weekday:'long'}).format(new Date())}</time></header>
    {error&&<Alert>{error}</Alert>}
    <section className={styles.deadlines} aria-labelledby="dashboard-deadlines-title"><div className={styles.sectionHeading}><h2 id="dashboard-deadlines-title">지원 대학 면접 일정</h2><Link className="text-link" href="/schools">일정 관리<ArrowUpRight size={14}/></Link></div>
      {deadlineRows.length?<ul className={styles.deadlineList}>{deadlineRows.map(({school,deadline,days})=><li key={school.id}><Link className={styles.deadlineRow} href={`/schools/${school.id}`}><div><strong>{targetName(school)}</strong><small>{[school.department||school.major,school.admission_type||school.track,deadline&&scheduleDateLabel(deadline.date)].filter(Boolean).join(' · ')}{deadline?.source==='public_day'&&' · 학교 공개일, 개별 일정 확인 필요'}</small></div><span className={days===null?styles.deadlineMissing:styles.deadlineCount}>{days===null?<>{loading.planner?'일정 확인 중':'면접일 등록'}<ArrowUpRight size={16}/></>:days>0?`D-${days}`:days===0?'D-day':'면접일 지남'}</span></Link></li>)}</ul>:<p className={styles.emptyNote}>면접까지 남은 날을 함께 준비해요. <Link className="text-link" href="/schools/new">지원 학교 등록<ArrowUpRight size={14}/></Link></p>}
    </section>
    <section className={styles.focus} aria-labelledby="dashboard-next-title">
      <div className={styles.focusCopy}><span className={styles.kicker}>{active?'하던 답을 이어서':latest?'이번에 보완할 한 가지':'이번에 꺼내 볼 나의 답'}</span><h2 id="dashboard-next-title">{ready?(question?.prompt||next.title):coreLoading?'오늘의 질문을 불러오고 있어요.':'오늘의 질문을 확인하지 못했어요.'}</h2>{ready&&<p>{active?'저장한 질문과 답변에서 계속해요.':next.reason}</p>}
        {context&&<div className={styles.contextTrail}>{activity&&<Link href={learningHref('/my/today',context)}><BookOpen size={14}/>{activity.title}</Link>}<span>{targetName(focusedTarget)}{focusedTarget?.department||focusedTarget?.major?' · '+(focusedTarget.department||focusedTarget.major):''}</span></div>}
        {!!confirmations.length&&<Link className={styles.confirmation} href="/account/confirmations">확인이 필요한 경험이 있어요.<ArrowUpRight size={14}/></Link>}
      </div><div className={styles.focusActions}>{ready?<Link className="button primary" href={primary.href}><Play size={16}/>{primary.label}<ArrowUpRight size={17}/></Link>:coreLoading?<ActionButton className="button primary" pending pendingLabel="질문 불러오는 중">질문 준비</ActionButton>:<Link className="button primary" href="/interview">질문 골라 연습하기<ArrowUpRight size={17}/></Link>}{primary.href!==schoolHref&&<Link className="text-link" href={schoolHref}>{target?'학교 면접 안내':'지원 학교 등록'}<ArrowUpRight size={14}/></Link>}</div>
    </section>
    <div className={styles.workspace}>
      <section className={styles.agenda} aria-labelledby="dashboard-agenda-title"><div className={styles.sectionHeading}><h2 id="dashboard-agenda-title"><CalendarDays size={18}/>오늘 할 일</h2><Link className="text-link" href="/quiz/assignments">과제 전체<ArrowUpRight size={14}/></Link></div><div className={styles.indented}>
        {preparation&&<p className={styles.smallNote}><strong>{preparation.daysLeft>0?`D-${preparation.daysLeft}`:preparation.daysLeft===0?'D-day':'면접일 지남'}</strong> · {preparation.status==='paused'?'자동 계획 중지':preparation.daysLeft<0?'다음 면접일을 확인해 주세요':preparation.phaseLabel}<br/>{preparation.dateLabel} · {preparation.date}</p>}
        {(remaining>0||tasks.length>0)&&<p className={styles.smallNote}>{[remaining>0?`남은 계획 ${remaining}개`:null,tasks.length>0?`과제 ${tasks.length}개`:null].filter(Boolean).join(' · ')}</p>}
        <div className={styles.agendaItems}>{tasks.slice(0,2).map(t=><LinkedRow key={t.id} href={`/quiz/assignments/${t.id}`} title={t.title||'퀴즈 과제'} subtitle={`${t.items?.length||0}문항${t.due_at?` · ${dateLabel(t.due_at)}까지`:''}`} end={<span className={styles.itemState}>{t.state==='submitted'?'검토 중':'풀기'}{t.state!=='submitted'&&<ArrowUpRight size={14}/>}</span>}/>)}
          {todayPlans.slice(0,3).map(p=><div key={p.id} className={`${styles.todayPlan} ${p.completed?styles.completed:''}`}>{p.completed?<Check size={15}/>:<Clock3 size={15}/>}<span>{p.overdue?'밀린 직접 계획 · ':''}{p.title}{p.performedAt?' · 실제 연습 기록 있음':''}</span>{p.href&&(!p.completed||p.performedAt)&&<Link className="text-link" href={p.href}>{p.performedAt?'다시 연습':'시작'}<ArrowUpRight size={13}/></Link>}</div>)}
          {!tasks.length&&!todayPlans.length&&<p className={styles.emptyNote}>{loading.learning||loading.planner?'할 일을 불러오고 있어요.':!workflows||!plannerLoaded?'할 일을 모두 확인하지 못했어요.':'예정된 할 일이 없어요. 오늘의 질문부터 가볍게 시작해요.'}</p>}
        </div><nav className={styles.quietLinks} aria-label="직접 연습하기">{data.package&&<Link href="/quiz?focus=free">퀴즈 연습<ArrowUpRight size={14}/></Link>}<Link href={active?`/interview/${active.id}?kind=${active.kind}`:'/interview'}>{active?'면접 이어가기':'모의면접'}<ArrowUpRight size={14}/></Link></nav>
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
