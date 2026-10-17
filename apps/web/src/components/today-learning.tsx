'use client';
import Link from 'next/link';
import {Suspense,useEffect,useState} from 'react';
import {useRouter,useSearchParams} from 'next/navigation';
import {ArrowUpRight,Check,RotateCcw,BookOpen,Mic,Quote} from 'lucide-react';
import {useApp} from './app-shell';
import {ActionButton,Alert,Breadcrumb,Empty,PageTitle,Spinner,api,post,type Item} from './shared';
import {LearningHelp} from './learning-help';
import {finishStudySession} from './study-session-provider';
import {koreaToday,shiftPlanDay} from '@/lib/planner-model';
import {learningHref,resolveJourneyQuestion} from '@/lib/learning-journey';
import {practiceHelpLabel,questionPracticeState,todayQuestionContext} from '@/lib/learning-flow-view';
import {todayLearningStage} from '@/lib/today-learning-stage';
import {matchesTodayReviewPlan,todayReviewPlan} from '@/lib/today-review-plan';
import {learningScopeIdentity,recordMatchesCurrentTarget} from '@/lib/learning-target-scope';
import styles from './learning-flow-ui.module.css';

export function TodayLearning(){return <Suspense fallback={<Spinner/>}><Journey/></Suspense>;}
function Journey(){
  const {data,targetId,toast,learningRevision=0}=useApp(),params=useSearchParams(),router=useRouter();
  const [content,setContent]=useState<Item|null>(null),[error,setError]=useState('');
  const [busy,setBusy]=useState(''),[planning,setPlanning]=useState(false),[reviewDate,setReviewDate]=useState(()=>shiftPlanDay(koreaToday(),3));
  const [reviewedQuestion,setReviewedQuestion]=useState('');
  const requested=params.get('questionId')||'',requestedMemory=params.get('memoryItemId')||'',selectedTarget=params.get('targetId')||targetId,requestedActivity=params.get('activityId')||'';
  const sourceType=['personal','common'].includes(params.get('sourceType')||'')?params.get('sourceType') as 'personal'|'common':undefined;
  const sourceVersion=params.get('sourceVersion')||undefined;
  const loadScope=JSON.stringify([data.user.id,selectedTarget,learningScopeIdentity(data.targets.find(t=>t.id===selectedTarget)||{}),data.package?.id,data.package?.active_version,requested,requestedMemory,requestedActivity,sourceType,sourceVersion]);
  useEffect(()=>{
    let disposed=false;const controller=new AbortController();setError('');setReviewedQuestion('');
    setContent({_scope:loadScope,_pending:['quiz','learning','study','knowledge','schools','evidence']});
    const query=new URLSearchParams({...selectedTarget?{targetId:selectedTarget}:{},...sourceType?{sourceType}:{},...sourceVersion?{sourceVersion}:{},...requested&&!requested.startsWith('concept:')?{questionId:requested}:{},...requestedMemory?{memoryItemId:requestedMemory}:{},...requestedActivity?{activityId:requestedActivity}:{}}).toString();
    const scope=selectedTarget?'?targetId='+encodeURIComponent(selectedTarget):'';
    const evidenceQuery=new URLSearchParams({...selectedTarget?{targetId:selectedTarget}:{},...sourceType?{sourceType}:{},...sourceVersion?{sourceVersion}:{},...requested&&!requested.startsWith('concept:')?{questionId:requested}:{},...requestedActivity?{activityId:requestedActivity}:{}}).toString();
    function load(key:string,url:string){
      void api(url,{signal:controller.signal}).then(value=>{
        if(disposed)return;setContent(previous=>previous?{...previous,[key]:value}:previous);
      }).catch(err=>{
        if(disposed||controller.signal.aborted)return;
        setContent(previous=>previous?{...previous,_failed:[...(previous._failed||[]),key]}:previous);
        setError(previous=>[previous,(err as Error).message].filter(Boolean).join(' '));
      }).finally(()=>{
        if(disposed)return;setContent(previous=>previous?{...previous,_pending:(previous._pending||[]).filter((name:string)=>name!==key)}:previous);
      });
    }
    load('quiz','/api/quiz'+(query?'?'+query:''));load('learning','/api/learning');load('study','/api/study-sessions');
    load('knowledge','/api/knowledge-bites'+scope);load('schools','/api/schools?scope=learning'+(selectedTarget?'&targetId='+encodeURIComponent(selectedTarget):''));load('evidence','/api/learning-help'+(evidenceQuery?'?'+evidenceQuery:''));
    return()=>{disposed=true;controller.abort();};
  },[loadScope,learningRevision]);
  const loading=(key:string)=>Boolean(content?._pending?.includes(key));
  const scopeCurrent=Boolean(content&&(!content._scope||content._scope===loadScope));
  if(!content||!scopeCurrent||['quiz','learning','study'].some(loading))return <><PageTitle title="오늘 학습"/>{scopeCurrent&&error&&<Alert>{error}</Alert>}<Spinner/></>;
  if(!data.targets.length)return <><Breadcrumb items={[{label:'오늘',href:'/my'},{label:'오늘 학습'}]}/><PageTitle title="오늘 학습"/><Empty title="지원 학교부터 골라볼까요?" href="/schools/new" label="학교 등록하기"/></>;
  // Missing history cannot be treated as a first attempt or a completed stage.
  if(content._failed?.some((key:string)=>['quiz','learning','study'].includes(key)))return <><Breadcrumb items={[{label:'오늘',href:'/my'},{label:'오늘 학습'}]}/><PageTitle title="오늘 학습"/>{error&&<Alert>{error}</Alert>}<Empty title="학습 기록을 모두 확인하지 못했어요." href="/interview" label="질문 골라 연습하기"/></>;
  const savedLearning=content.evidence?.learning;
  const versionFixed=Boolean(sourceVersion);
  // An unavailable historical source must never fall back to today's replacement text.
  if(versionFixed&&!savedLearning&&loading('evidence'))return <><PageTitle title="오늘 학습"/><Spinner/></>;
  if(versionFixed&&!savedLearning)return <><Breadcrumb items={[{label:'오늘',href:'/my'},{label:'오늘 학습'}]}/><PageTitle title="오늘 학습"/>{error&&<Alert>{error}</Alert>}<Empty title="저장 당시 자료를 확인하지 못했어요." href="/records" label="저장한 답변 보기"/></>;
  const candidates:Item[]=(savedLearning?.questions||[...(data.learning.questions||[]),...(content.schools?.commonQuestions||[])]).filter((q:Item)=>!q.support_target_ids?.length||q.support_target_ids.includes(selectedTarget));
  const library=content.quiz?.library||{},practiceItems:Item[]=[...(library.choice||[]),...(library.answer||[])];
  const memory:Item[]=versionFixed?practiceItems:(data.learning.memory_items||[]);
  const currentTargets=data.targets.filter(t=>t.id===selectedTarget);
  const nextId=requested||content.study?.totals?.weakPoints?.find((w:Item)=>recordMatchesCurrentTarget(w,currentTargets)&&(candidates.some(q=>q.id===w.questionId)||memory.some(m=>m.id===w.memoryItemId)))?.questionId||content.quiz?.recommendation?.items?.[0]?.question_id||((content.study?.nextQuestion&&recordMatchesCurrentTarget(content.study.nextQuestion,currentTargets))?content.study?.nextQuestion?.questionId:null)||candidates[0]?.id;
  const identity=resolveJourneyQuestion(nextId||'',candidates,memory,practiceItems,requestedMemory),question:Item|undefined=identity?.question;
  if(!question&&(loading('schools')||loading('evidence')))return <><PageTitle title="오늘 학습"/>{error&&<Alert>{error}</Alert>}<Spinner/></>;
  if(!question)return <><Breadcrumb items={[{label:'오늘',href:'/my'},{label:'오늘 학습'}]}/><PageTitle title="오늘 학습"/>{error&&<Alert>{error}</Alert>}<Empty title={requested?'지금 연습할 수 없는 질문이에요.':'면접 질문을 골라볼까요?'} href={requested?learningHref('/records/comparisons',{questionId:requested,targetId:selectedTarget,sourceType,sourceVersion}):'/interview/chat'} label={requested?'저장한 답변 보기':'공통 질문 연습'}/></>;
  const linkedTarget=question.support_target_ids?.length&&!question.support_target_ids.includes(selectedTarget)?data.targets.find(t=>question.support_target_ids.includes(t.id))?.id:selectedTarget;
  const target=data.targets.find(t=>t.id===linkedTarget),sourceTarget=content.quiz?.target||target;
  const activities:Item[]=savedLearning?.activities||data.learning.activities||[];
  const availableActivities=activities.filter(a=>['verified','approved','confirmed','synthetic_reviewed','confirmed_from_record','confirmed_by_student'].includes(a.fact_confirmation));
  const selectedActivity=question.talent_profile&&requestedActivity?availableActivities.find(a=>a.id===requestedActivity):null;
  const context={...todayQuestionContext(question,linkedTarget,sourceVersion||content.quiz?.contentVersion||data.package?.active_version),activityId:selectedActivity?.id||question.activity_ids?.[0],...(sourceType?{sourceType}:{}),...(sourceVersion?{sourceVersion}:{})};
  const activity=activities.find(a=>a.id===context.activityId);
  const sources:Item[]=savedLearning?.source_refs||data.learning.source_refs||[];
  const sourceIds=new Set([...(question.source_ref_ids||[]),...(activity?.source_ref_ids||[])]),quotes=sources.filter(s=>sourceIds.has(s.id)&&s.quote);
  const choice=(library.choice||[]).find((m:Item)=>identity?.memoryItem?m.id===identity.memoryItem.id:m.question_id===question.id),answer=(library.answer||[]).find((m:Item)=>identity?.memoryItem?m.id===identity.memoryItem.id:m.question_id===question.id);
  const application=identity?.interviewQuestion,applicationContext={...context,questionId:application?.id};
  const personalVersion=context.sourceType==='personal'?Number(context.sourceVersion):undefined;
  const currentCommon=content.schools?.commonQuestions?.find((q:Item)=>q.id===question.id);
  const archived=Boolean(personalVersion&&personalVersion!==Number(data.package?.active_version)||context.sourceType==='common'&&context.sourceVersion&&Number(context.sourceVersion)!==Number(currentCommon?.common_revision));
  const sourceDetached=archived||Boolean(content.quiz?.targetSnapshotStale);
  const video=!sourceDetached?content.knowledge?.videos?.find((v:Item)=>v.current&&v.relatedQuestions?.some((q:Item)=>q.id===application?.id)):null;
  const state=questionPracticeState(content.learning?.answerRevisions||[],question,target,personalVersion);
  const latest=state.latest;
  const recallHref=learningHref('/quiz?focus=today',{...context,memoryItemId:identity?.memoryItem?.id,mode:answer?'answer':'choice'});
  const cardParams=new URLSearchParams();
  if(params.get('experienceCardId')&&params.get('experienceRevision')){cardParams.set('experienceCardId',params.get('experienceCardId')!);cardParams.set('experienceRevision',params.get('experienceRevision')!);}
  const interviewHref=application?learningHref('/interview/chat',applicationContext)+'&questionCount=1'+(cardParams.size?'&'+cardParams.toString():''):null;
  const compareHref=learningHref('/records/comparisons',context);
  const questionKey=[question.id,linkedTarget,context.sourceType,context.sourceVersion].join(':');
  const checkingRecord=!state.attempts.length&&(activity||quotes.length)&&reviewedQuestion!==questionKey;
  const applicationState=application&&application.id!==question.id?questionPracticeState(content.learning?.answerRevisions||[],application,target,personalVersion):state;
  const currentStep=todayLearningStage({checkingRecord:Boolean(checkingRecord),recallAvailable:Boolean(choice||answer),interviewAvailable:Boolean(interviewHref),attempts:state.attempts,applicationAttempts:applicationState.attempts});
  const reviewState=applicationState.interviewSaved?applicationState:state,reviewHref=applicationState.interviewSaved&&application?.id!==question.id?learningHref('/records/comparisons',applicationContext):compareHref;
  const first=currentStep==='record'?{href:'#today-record',label:context.sourceType==='common'?'질문 근거부터 확인':'기록부터 확인'}:currentStep==='recall'?{href:recallHref,label:latest?'자료를 덮고 다시 떠올리기':'자료를 덮고 떠올리기'}:currentStep==='interview'&&interviewHref?{href:interviewHref,label:'이 질문에 새로 답하기'}:{href:reviewHref,label:reviewState.canCompare?'달라진 답 비교하고 복습하기':'답변과 피드백 확인'};
  const confirmations=(content.learning?.confirmations||[]).filter((c:Item)=>['needs_confirmation','student_says_different','cannot_confirm'].includes(c.confirmation_status)&&(c.entity_id===question.id||c.entity_id===activity?.id||sourceIds.has(c.entity_id)));
  const steps=[
    {id:'record',title:context.sourceType==='common'?'질문 근거 읽기':'기록에서 찾기',note:activity?.title||question.talent_profile?.point?.label||'질문의 근거 확인',state:quotes.length?`${context.sourceType==='common'?'연결 근거':'연결된 원문'} ${quotes.length}개`:'연결 근거 보기',href:'#today-record',label:'자료 확인',tone:'green'},
    ...(choice||answer?[{id:'recall',title:'자료 덮고 떠올리기',note:answer?'문장 암기보다 역할·과정·이유부터':'핵심 개념과 사실을 먼저 확인',state:state.attempts.length?`새 답변 ${state.attempts.length}개`:'아직 새 답변 없음',href:recallHref,label:latest?'새로 떠올리기':'회상 시작',tone:'blue'}]:[]),
    ...(interviewHref?[{id:'interview',title:'내 말로 답하기',note:identity?.sameQuestion?'같은 질문에 답하고 피드백 받기':'이 개념을 내 활동 질문에 적용',state:applicationState.interviewSaved?'면접 답변 기록 있음':'Chat 입력 · Live 말하기',href:interviewHref,label:'면접에서 답하기',tone:'peach'}]:[]),
    {id:'review',title:'보완하고 다시',note:'빠진 내용 한 가지를 다음 답에 더하기',state:reviewState.canCompare?'이전 답과 나란히 볼 수 있어요':'새 답을 남기면 비교할 수 있어요',href:reviewHref,label:'답변과 피드백 확인',tone:'purple'},
  ];
  async function finish(){if(busy)return;setBusy('finish');try{await finishStudySession('manual');router.push('/records');}catch(err){setError((err as Error).message);}finally{setBusy('');}}
  async function plan(){if(busy||!reviewDate)return;setBusy('plan');try{const planned=todayReviewPlan({question:question as {id:string;prompt:string},application:application as {id:string;prompt?:string}|undefined,hasRecall:Boolean(choice||answer),context,date:reviewDate});
    if(!planned){setError('이 개념에 연결된 면접 질문이 없어 복습 계획을 연결하지 못했어요.');return;}
    const existing=await api('/api/planner');
    if(!existing.plans?.some((p:Item)=>matchesTodayReviewPlan(p,planned)))await post('/api/planner',planned);
    setPlanning(false);toast('같은 질문·지원처·자료로 복습할 날을 계획표에 남겼어요.');
  }catch(err){setError((err as Error).message);}finally{setBusy('');}}
  async function schoolAssignment(){if(busy)return;setBusy('assignment');try{const result=await post('/api/learning',{action:'assignment_create',requestId:crypto.randomUUID(),targetId:linkedTarget,questionIds:[question!.id],...(selectedActivity?{activityId:selectedActivity.id}:{}),title:question!.talent_profile?.point?.label?String(question!.talent_profile.point.label).slice(0,170)+' 복습':String(question!.prompt).slice(0,180)});router.push('/quiz/assignments/'+result.assignment.id);}catch(err){setError((err as Error).message);}finally{setBusy('');}}
  return <div className={styles.today}>
    <Breadcrumb items={[{label:'오늘',href:'/my'},{label:'오늘 학습'}]}/><PageTitle title="오늘 학습" aside={<Link className="text-link" href={data.package?'/quiz?focus=free':'/interview/chat'}>다른 질문<ArrowUpRight size={15}/></Link>}/>{error&&<Alert>{error}</Alert>}
    <div className={styles.scope}><span>{[sourceTarget?.university,sourceTarget?.department||sourceTarget?.major].filter(Boolean).join(' · ')}</span>{activity&&<span><BookOpen size={14}/>{activity.title}</span>}</div>
    {content.quiz?.targetSnapshotStale&&<p className={styles.contextNotice}>현재 지원 정보와 다른 교재의 질문이에요. 이 자료의 지원처 기준으로 연습해요.</p>}
    <section className={styles.questionFocus}><span className={styles.kicker}>{latest?'같은 경험, 다음 나의 답':'이번에 꺼내 볼 나의 답'}</span><h2>{question.prompt}</h2><ol className={styles.stageTrail} aria-label="현재 학습 단계">{steps.map((step,index)=><li key={step.id} aria-current={step.id===currentStep?'step':undefined}><span>{index+1}</span>{step.title}{step.id===currentStep&&<small>지금</small>}</li>)}</ol><div><Link className="button primary" href={first.href} onClick={()=>{if(checkingRecord)setReviewedQuestion(questionKey);}}>{first.label}<ArrowUpRight size={17}/></Link>{latest&&<span className={styles.attemptState}>{practiceHelpLabel(latest)}</span>}</div></section>
    <div className={styles.questionWorkspace}>
      <section className={styles.recordMaterial} id="today-record"><div className={styles.sectionHeading}><h2><BookOpen size={18}/>{question.talent_profile?'학교의 시선과 내 경험':'답의 재료'}</h2></div><div className={styles.indented}>
        {question.talent_profile&&<><p className={styles.materialTitle}>{question.talent_profile.point?.label||'학교의 가치'}</p><p className={styles.materialBody}>{question.talent_profile.point?.description}</p>{question.source_snapshot?.url&&<a className="text-link" href={question.source_snapshot.url} target="_blank" rel="noreferrer">공식 원문<ArrowUpRight size={14}/></a>}
          {availableActivities.length>0&&<label className={styles.activityPicker}>연결할 나의 경험<select aria-label="인재상과 연결할 활동" value={selectedActivity?.id||''} onChange={e=>router.replace(learningHref('/my/today',{...context,activityId:e.target.value}))}><option value="">가치에 대한 생각부터 답할게요</option>{availableActivities.map(a=><option key={a.id} value={a.id}>{a.title}</option>)}</select></label>}</>}
        {activity&&<><p className={styles.materialTitle}>{activity.title}</p>{activity.activity_summary&&<p className={styles.materialBody}>{activity.activity_summary}</p>}</>}
        {quotes.length>0&&<details className={styles.evidence} open={!latest}><summary>{context.sourceType==='common'?'학교 기준·질문 근거':'학생부 원문'}<span>{quotes.length}개</span></summary>{quotes.map(source=><div key={source.id}><small>{[source.type==='school_talent'?'학교 기준 요약':source.type==='school_reference'?'제공 자료 질문':source.area,source.page&&`${source.page}쪽`].filter(Boolean).join(' · ')}</small><blockquote>{source.quote}</blockquote></div>)}</details>}
        {!!confirmations.length&&<Link className={styles.confirmation} href="/account/confirmations">확인 요청이 남아 있어요. 기억나지 않는 경험은 채우지 않아도 돼요.<ArrowUpRight size={14}/></Link>}
        <details className={styles.helpDisclosure}><summary>근거·힌트 도움</summary>{loading('evidence')?<Spinner/>:<LearningHelp questionId={application?.id} activityId={context.activityId} targetId={linkedTarget} sourceType={context.sourceType} sourceVersion={context.sourceVersion} snapshot={content.evidence||undefined}/>}</details>
        {video&&<Link className={styles.materialSupplement} href={learningHref(`/knowledge/${video.id}`,applicationContext)}>{video.kind==='reading'?'읽고 넓히기':'보고 넓히기'} · {video.label}<ArrowUpRight size={15}/></Link>}
      </div></section>
      <section className={styles.previousAnswer}><div className={styles.sectionHeading}><h2><Quote size={18}/>이전의 나의 답</h2></div><div className={styles.indented}>
        {latest?<><p className={styles.recordCaption}>{practiceHelpLabel(latest)} · {latest.response_mode==='audio'?'음성 답변':latest.response_mode==='video'?'영상 답변':'입력한 답변'}</p><blockquote>{latest.script}</blockquote><Link className={styles.recordNext} href={compareHref}>{state.canCompare?'달라진 문장 비교':'답변과 피드백 확인'}<ArrowUpRight size={15}/></Link></>:<p className={styles.emptyNote}>기록을 확인했으면 자료를 덮고 떠올려 보세요. 모르는 부분은 확인이 필요하다고 남겨도 좋아요.</p>}
      </div></section>
    </div>
    <details className={styles.otherWays}><summary>다른 단계·연습 방식</summary><nav className={styles.flowPaths} aria-label="필요한 곳부터 이어가는 학습">{steps.map(step=><a className={styles.flowPath} data-tone={step.tone} href={step.href} key={step.id}><span>{step.title}</span><small>{step.state}</small><ArrowUpRight size={15}/></a>)}</nav>{interviewHref&&<div className={styles.quietLinks}><Link href={interviewHref}>Chat으로 답하기<ArrowUpRight size={14}/></Link><Link href={learningHref('/interview/live',applicationContext)+'&questionCount=1'}><Mic size={14}/>Live로 말하기<ArrowUpRight size={14}/></Link></div>}</details>
    <footer className={styles.journeyEnd}><ActionButton onClick={finish} disabled={Boolean(busy)} pending={busy==='finish'} pendingLabel="기록 정리 중" className="button secondary">오늘 학습 마치기<Check size={16}/></ActionButton><button className="text-link" onClick={()=>setPlanning(v=>!v)} aria-expanded={planning}><RotateCcw size={15}/>복습일 정하기</button>{question.common_revision&&!sourceVersion&&!sourceDetached&&<ActionButton className="text-link" disabled={Boolean(busy)} pending={busy==='assignment'} pendingLabel="과제 만드는 중" onClick={schoolAssignment}>이 질문 과제로 담기<ArrowUpRight size={15}/></ActionButton>}</footer>
    {planning&&<form className={styles.reviewPlan} onSubmit={e=>{e.preventDefault();void plan();}}><label>다시 확인할 날<input type="date" min={koreaToday()} max="2099-12-31" aria-label="다시 확인할 날" value={reviewDate} onChange={e=>setReviewDate(e.target.value)}/></label><ActionButton className="button primary" disabled={Boolean(busy)||!reviewDate} pending={busy==='plan'} pendingLabel="복습일 저장 중" type="submit">복습일 등록<Check size={16}/></ActionButton>{sourceDetached&&<p>복습도 이 자료의 지원처와 발행본을 기준으로 이어가요.</p>}</form>}
  </div>;
}

