'use client';
import {ownedClassName} from './owned-class-name';

import Link from 'next/link';
import {Suspense,useCallback,useEffect,useRef,useState} from 'react';
import {useSearchParams} from 'next/navigation';
import {ArrowRight,Check} from 'lucide-react';
import {useApp} from './app-shell';
import {api,post,Alert,Spinner,ActionButton,InfoTip,type Item} from './shared';
import {InterviewSession} from './interview';
import {QuestionExperiencePicker} from './question-experience-picker';
import {MarkdownMessage} from './markdown-message';
import {nextTrainingStep,trainingStepHref,trainingTaskDone,trainingSequence} from '@/lib/training-flow';
import {learningScopeIdentity} from '@/lib/learning-target-scope';
import styles from './training-run.module.css';

export function TrainingRun({diagnostic=false}:{diagnostic?:boolean}){return <Suspense fallback={<Spinner/>}><Run diagnostic={diagnostic}/></Suspense>;}
function Run({diagnostic}:{diagnostic:boolean}){
 const {targetId,target,data:appData,refresh,learningRevision}=useApp(),params=useSearchParams();
 const planId=params.get('planId'),scope=JSON.stringify([appData.user.id,targetId,learningScopeIdentity(target||{}),appData.package?.id,appData.package?.active_version,planId,diagnostic]),scopeRef=useRef({key:scope});
 // A new visit gets a distinct receipt, including switching A → B → A while A is saving.
 if(scopeRef.current.key!==scope)scopeRef.current={key:scope};
 const scopeToken=scopeRef.current;
 const [data,setData]=useState<Item|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[sessionId,setSessionId]=useState(''),[info,setInfo]=useState<Item|null>(null);
 const [reviewIds,setReviewIds]=useState<string[]>([]),[categories,setCategories]=useState<string[]>([]),[reflectionSaved,setReflectionSaved]=useState(false),[note,setNote]=useState(''),[noteActivity,setNoteActivity]=useState(''),[noteSaved,setNoteSaved]=useState(false);
 const [experience,setExperience]=useState<any>(null),[improvement,setImprovement]=useState('');
 const [reviewDone,setReviewDone]=useState(false),[nextData,setNextData]=useState<{token:object;sessionId:string;day:Item}|null>(null),[nextError,setNextError]=useState(''),[nextRevision,setNextRevision]=useState(0);
 const pendingStart=useRef<string|null>(null),noteRequest=useRef<string|null>(null),retryRequest=useRef<string|null>(null);
 useEffect(()=>{const controller=new AbortController();scopeRef.current=scopeToken;setBusy(false);setData(null);setInfo(null);setSessionId('');setError('');setReflectionSaved(false);setExperience(null);setReviewIds([]);setCategories([]);setNote('');setNoteActivity('');setNoteSaved(false);setImprovement('');setReviewDone(false);setNextData(null);setNextError('');pendingStart.current=null;retryRequest.current=null;noteRequest.current=null;
  const query=new URLSearchParams({...targetId?{targetId}:{},...planId?{planId}:{}});
  api('/api/training?'+query,{signal:controller.signal,cache:'no-store'}).then(value=>{if(controller.signal.aborted||scopeRef.current!==scopeToken)return;setData(value);const diagnosticState=value.diagnostics||{},selection=(active:string,legacy:string)=>{const selected=Object.prototype.hasOwnProperty.call(diagnosticState,active)?diagnosticState[active]:diagnosticState[legacy];return Array.isArray(selected)?selected.filter((id:unknown):id is string=>typeof id==='string'):[];};setReviewIds(selection('activeNeedsReviewQuestionIds','needsReviewQuestionIds'));setCategories(selection('activeFocusCategories','focusCategories'));setReviewDone(value.selectedTask?.kind==='review'&&value.selectedTask?.completed===true);const existing=value.selectedTask?.sessionId||(diagnostic&&value.diagnostics?.state==='in_progress'?value.diagnostics.sessionId:null);if(existing)setSessionId(existing);}).catch(cause=>{if(!controller.signal.aborted&&scopeRef.current===scopeToken)setError(cause.message);});return()=>{controller.abort();if(scopeRef.current===scopeToken)scopeRef.current={key:''};};
 },[scopeToken]);
 const task=data?.selectedTask,isDiagnostic=diagnostic||task?.kind==='diagnostic';
 const taskLabel=isDiagnostic?'첫 진단':({focus:'집중 보완',recall:'누적 복습',mixed:'연결 면접',review:'오늘 정리',break:'휴식'} as Record<string,string>)[task?.kind]||'답변 훈련';
 const taskParts=String(task?.title||'').split(' · '),taskPrompt=taskParts.slice(1).join(' · ');
 const update=useCallback((value:Item)=>{if(scopeRef.current===scopeToken)setInfo(value);},[scopeToken]);
 const completed=info?.session?.state==='completed';
 useEffect(()=>{
  setNextData(null);setNextError('');if(!completed&&!reviewDone)return;
  const controller=new AbortController(),capture=scopeToken,completedSession=sessionId;
  const query=new URLSearchParams({...task?.targetId||targetId?{targetId:task?.targetId||targetId}:{}});
  void api('/api/training?'+query,{signal:controller.signal,cache:'no-store'}).then(value=>{
   if(!Array.isArray(value.today?.tasks))throw new Error('오늘 계획을 확인하지 못했어요. 다시 불러와 주세요.');
   if(!controller.signal.aborted&&scopeRef.current===capture)setNextData({token:capture,sessionId:completedSession,day:value.today});
  }).catch(cause=>{if(!controller.signal.aborted&&scopeRef.current===capture)setNextError((cause as Error).message);});
  return()=>controller.abort();
 },[completed,reviewDone,sessionId,scopeToken,reflectionSaved,learningRevision,nextRevision,task?.targetId,targetId]);
 const continuation=nextData?.token===scopeToken&&nextData.sessionId===sessionId?nextData.day:null;
 const nextStep=continuation?nextTrainingStep(continuation.tasks||[],planId):null;
 const remaining=continuation?trainingSequence(continuation.tasks||[]).filter(row=>row.id!==planId&&!trainingTaskDone(row)).length:0;

 async function start(){
  if(busy||!data)return;setBusy(true);setError('');const capture=scopeToken;
  try{
   let current=task;if(planId){const result=await post('/api/training',{action:'task_start',planId});current=result.task;}
   if(scopeRef.current!==capture)return;
   const source=isDiagnostic?data.diagnosticInput:current;
   if(!source?.targetId)throw new Error('지원 학교와 연습할 질문을 확인해 주세요.');
   pendingStart.current??=current?.requestId||'training-'+crypto.randomUUID();
   const input={action:'start',kind:'video',mode:'basic',targetId:current?.targetId||source.targetId,sourceType:current?.sourceType||source.sourceType,sourceVersion:current?.sourceVersion||source.sourceVersion,questionId:isDiagnostic?undefined:source.questionId,
    ...(isDiagnostic&&source.sourceType===(current?.sourceType||source.sourceType)?{questionIds:data.diagnosticQuestions.filter((q:Item)=>q.sourceType===undefined||q.sourceType===source.sourceType).map((q:Item)=>q.id)}:{}),...(experience&&!isDiagnostic&&current?.kind!=='mixed'?{experienceCardId:experience.id,experienceRevision:experience.revision}:{}),questionCount:isDiagnostic?source.questionCount:current?.kind==='mixed'?4:1,followups:!isDiagnostic&&current?.kind==='focus',feedbackTiming:'turn',interviewerReactions:false,trainingPlanId:planId||undefined,trainingPurpose:isDiagnostic?'diagnostic':['focus','mixed','recall'].includes(current?.kind)?current.kind:'focus',requestId:pendingStart.current};
   const result=await post('/api/interviews',input);
   await post('/api/training',{action:'link_session',...(planId?{planId}:{}),sessionId:result.session.id,diagnostic:isDiagnostic});
   if(scopeRef.current!==capture)return;setSessionId(result.session.id);setInfo(null);
  }catch(cause){if(scopeRef.current===capture)setError((cause as Error).message);}finally{if(scopeRef.current===capture)setBusy(false);}
 }
 async function finishReview(){if(busy||!planId)return;const capture=scopeToken;setBusy(true);setError('');try{await post('/api/training',{action:'task_complete',planId});if(scopeRef.current!==capture)return;setReviewDone(true);await refresh();}catch(cause){if(scopeRef.current===capture)setError((cause as Error).message);}finally{if(scopeRef.current===capture)setBusy(false);}}
 async function retryAnswer(){
  if(busy||!planId||!task||!improvement.trim())return;const capture=scopeToken;setBusy(true);setError('');
  try{retryRequest.current??='training-'+crypto.randomUUID();const card=info?.session?.data?.experienceCard;
   const result=await post('/api/interviews',{action:'start',kind:'video',mode:'basic',targetId:task.targetId,sourceType:task.sourceType,sourceVersion:task.sourceVersion,questionId:task.questionId,questionCount:1,followups:false,feedbackTiming:'turn',interviewerReactions:false,trainingPlanId:planId,trainingPurpose:task.kind,trainingImprovement:improvement.trim(),requestId:retryRequest.current,...(card?{experienceCardId:card.id,experienceRevision:card.revision}:{})});
   await post('/api/training',{action:'link_session',planId,sessionId:result.session.id,diagnostic:false});
   if(scopeRef.current!==capture)return;setSessionId(result.session.id);setInfo(null);setNoteSaved(false);setNote('');retryRequest.current=null;setImprovement('');
  }catch(cause){if(scopeRef.current===capture)setError((cause as Error).message);}finally{if(scopeRef.current===capture)setBusy(false);}
 }
 async function saveReflection(){if(busy||!sessionId)return;const capture=scopeToken;setBusy(true);setError('');try{await post('/api/training',{action:'diagnostic_reflection',sessionId,needsReviewQuestionIds:reviewIds,focusCategories:categories});if(scopeRef.current!==capture)return;setReflectionSaved(true);await refresh();}catch(cause){if(scopeRef.current===capture)setError((cause as Error).message);}finally{if(scopeRef.current===capture)setBusy(false);}}
 async function saveNote(){if(busy||!note.trim()||!noteActivity)return;const turns=(info?.turns||[]).filter((t:Item)=>t.answer&&!t.invalidated);const turn=turns.find((t:Item)=>{const root=(info?.session?.data?.context?.questions||[]).find((q:Item)=>q.id===(t.rootQuestionId||t.question_id));return root?.activity_ids?.includes(noteActivity)||'experience:'+info?.session?.data?.experienceCard?.id===noteActivity;});if(!turn){setError('이 활동에 연결된 제출 답변을 선택해 주세요.');return;}const capture=scopeToken;setBusy(true);setError('');try{noteRequest.current??=crypto.randomUUID();await post('/api/training',{action:'activity_note',turnId:turn.id,activityId:noteActivity,body:note,requestId:noteRequest.current});if(scopeRef.current!==capture)return;setNoteSaved(true);noteRequest.current=null;await refresh();}catch(cause){if(scopeRef.current===capture)setError((cause as Error).message);}finally{if(scopeRef.current===capture)setBusy(false);}}
 const turns:Item[]=(info?.turns||[]).filter((turn:Item)=>turn.answer&&!turn.invalidated);
 const activityIds=new Set((info?.session?.data?.context?.questions||[]).flatMap((q:Item)=>q.activity_ids||[]));if(info?.session?.data?.experienceCard)activityIds.add('experience:'+info.session.data.experienceCard.id);
 const activities=(data?.readiness?.items||[]).filter((row:Item)=>activityIds.has(row.id));
 if(!data)return <div className={ownedClassName(styles.page,true)}>{error?<><Alert>{error}</Alert><Link href="/my">오늘 훈련으로</Link></>:<Spinner/>}</div>;
 if(!diagnostic&&!task)return <Alert>오늘 계획에서 훈련을 선택해 주세요. <Link href="/my">오늘 훈련</Link></Alert>;
 return <div className={ownedClassName(styles.page,true)}>
  <div className={ownedClassName(styles.context,true)}><Link href="/my">오늘 훈련</Link><span className={ownedClassName(undefined,true)}>›</span><span className={ownedClassName(undefined,true)}>{taskLabel}</span>{task?.minutes&&<span className={ownedClassName(undefined,true)}>약 {task.minutes}분</span>}</div>
  {error&&<Alert>{error}</Alert>}
  {!sessionId&&!reviewDone?<section className={ownedClassName(styles.intro,true)}><span className={ownedClassName(styles.eyebrow,true)}>{isDiagnostic?'먼저, 지금의 답변을 확인해요.':'같은 활동, 다음 나의 답'}</span><h1 className={ownedClassName(undefined,true)}>{isDiagnostic?'첫 진단':taskParts[0]||taskLabel}</h1>
   {!isDiagnostic&&taskPrompt&&<h2 className={ownedClassName(styles.practiceQuestion,true)}>{taskPrompt}</h2>}
   <p className={ownedClassName(undefined,true)}>{isDiagnostic?'지금 답할 수 있는 질문에 짧게 답해요. 아직 묻지 않은 영역은 미확인으로 남겨요.':task?.reason}</p>
   {isDiagnostic&&<ol className={ownedClassName(styles.questionList,true)}>{data.diagnosticQuestions?.map((q:Item)=><li key={q.id} className={ownedClassName(undefined,true)}>{q.title}</li>)}</ol>}
   {!isDiagnostic&&['focus','recall'].includes(task?.kind)&&<QuestionExperiencePicker question={{id:task.questionId,prompt:task.title}} targetId={task.targetId} value={experience} onSelect={setExperience}/>}
   {['review','break'].includes(task?.kind)?<><div className={ownedClassName(styles.actions,true)}><Link className={ownedClassName("button ghost")} href="/records">저장한 답변 확인</Link><ActionButton className={ownedClassName("button primary")} pending={busy} onClick={()=>void finishReview()}>오늘 정리 마치기<Check size={16}/></ActionButton></div></>:<div className={ownedClassName(styles.actions,true)}><ActionButton className={ownedClassName("button primary")} pending={busy} disabled={isDiagnostic&&!data.diagnosticInput} pendingLabel="질문 준비 중" onClick={()=>void start()}>{isDiagnostic?'진단 질문에 답하기':'이 훈련 시작'}<ArrowRight size={16}/></ActionButton><Link href="/preparation">활동과 근거 확인</Link></div>}
  </section>:!completed&&!reviewDone&&<InterviewSession id={sessionId} kind="video" onTrainingUpdate={update}/>}
  {(completed||reviewDone)&&<section className={ownedClassName(styles.summary,true)}><div className={ownedClassName(styles.summaryTop,true)}><h2 className={ownedClassName(undefined,true)}>{reviewDone?'오늘 정리 완료':'훈련 완료'}</h2>{!reviewDone&&<span className={ownedClassName(undefined,true)}>답변 {turns.length}개 저장</span>}</div>
   {info?.session?.data?.trainingImprovement&&<p className={ownedClassName(styles.improvementSaved,true)}><span className={ownedClassName(undefined,true)}>보완한 점</span>{info.session.data.trainingImprovement}</p>}
   {!!turns.length&&<details className={ownedClassName(styles.answerDetails,true)}><summary className={ownedClassName(undefined,true)}>질문별 답변과 피드백 {turns.length}개</summary>{turns.map(turn=><article key={turn.id} className={ownedClassName(undefined,true)}><h3 className={ownedClassName(undefined,true)}>{turn.question}</h3><p className={ownedClassName(undefined,true)}>{turn.answer}</p><small className={ownedClassName(undefined,true)}>{turn.submissionSource==='recording'?'음성 답변 · 원음과 전사 보존':'글로 제출한 답변'}{turn.assisted?' · 도움 사용':''}</small>{turn.feedback?.content&&<div className={ownedClassName(styles.feedback,true)}><MarkdownMessage content={turn.feedback.content}/></div>}</article>)}</details>}
   {isDiagnostic&&<section className={ownedClassName(styles.reflectionSection,true)}><div className={ownedClassName(styles.sectionHeading,true)}><h3 className={ownedClassName(undefined,true)}>다음에 더 연습할 부분</h3><InfoTip label="다음 계획 반영 안내">선택한 질문과 주제의 비중을 다음 훈련 계획에 반영해요. 선택은 실력 점수가 아니에요.</InfoTip></div><fieldset className={ownedClassName(styles.reflection,true)} disabled={busy}><legend className={ownedClassName(undefined,true)}>다시 답할 질문 · 선택</legend>{turns.filter(turn=>!turn.followupDepth).map(turn=><label key={turn.id} className={ownedClassName(undefined,true)}><input type="checkbox" checked={reviewIds.includes(turn.rootQuestionId||turn.question_id)} onChange={event=>{const id=turn.rootQuestionId||turn.question_id;setReviewIds(previous=>event.target.checked?[...previous,id]:previous.filter(item=>item!==id));setReflectionSaved(false);}} className={ownedClassName(undefined,true)}/><span className={ownedClassName(undefined,true)}>{turn.question}</span></label>)}</fieldset><fieldset className={ownedClassName(styles.categoryChoices,true)} disabled={busy}><legend className={ownedClassName(undefined,true)}>더 준비할 주제 · 선택</legend><div className={ownedClassName(styles.topicButtons,true)}>{[['personal','내 활동 설명'],['major','전공 개념·이유'],['talent','학교·학과와의 연결']].map(([id,label])=><button type="button" key={id} aria-pressed={categories.includes(id)} onClick={()=>{setCategories(previous=>previous.includes(id)?previous.filter(value=>value!==id):[...previous,id]);setReflectionSaved(false);}} className={ownedClassName(undefined,true)}>{label}</button>)}</div></fieldset><ActionButton className={ownedClassName("button ghost")} pending={busy} onClick={()=>void saveReflection()}>{reflectionSaved?'보완할 부분 저장됨':'선택한 부분을 다음 계획에 반영'}</ActionButton></section>}
   {!!activities.length&&<details className={ownedClassName(undefined,true)}><summary className={ownedClassName(undefined,true)}>이번 답변에서 활동 정보 보완하기</summary><p className={ownedClassName(styles.note,true)}>실제로 한 일을 직접 확인해 메모해요. 학생부 원문과 과거 답변은 보존해요.</p><label className={ownedClassName(undefined,true)}>연결할 활동<select disabled={busy} value={noteActivity} onChange={event=>{setNoteActivity(event.target.value);setNoteSaved(false);noteRequest.current=null;}} className={ownedClassName(undefined,true)}><option value="" className={ownedClassName(undefined,true)}>활동 선택</option>{activities.map((row:Item)=><option key={row.id} value={row.id} className={ownedClassName(undefined,true)}>{row.title}</option>)}</select></label><label className={ownedClassName(undefined,true)}>내가 확인한 내용<textarea disabled={busy} value={note} maxLength={1500} rows={3} onChange={event=>{setNote(event.target.value);setNoteSaved(false);noteRequest.current=null;}} className={ownedClassName(undefined,true)}/></label><ActionButton className={ownedClassName("button ghost")} pending={busy} disabled={!note.trim()||!noteActivity} onClick={()=>void saveNote()}>{noteSaved?'활동에 반영됨':'내가 한 일로 확인하고 반영'}</ActionButton></details>}
   {!isDiagnostic&&['focus','recall'].includes(task?.kind)&&<section className={ownedClassName(undefined,true)}><div className={ownedClassName(styles.sectionHeading,true)}><h3 className={ownedClassName(undefined,true)}>한 가지 보완하고 다시 답하기</h3><InfoTip label="재답변 저장 안내">보완점과 새 답변을 함께 저장해요. 이전 답변은 내 기록에서 비교할 수 있어요.</InfoTip></div><label className={ownedClassName(undefined,true)}>이번에 바꿀 한 가지<textarea disabled={busy} rows={2} maxLength={500} value={improvement} placeholder="예: 내가 직접 한 행동을 먼저 말하기" onChange={event=>{setImprovement(event.target.value);retryRequest.current=null;}} className={ownedClassName(undefined,true)}/></label><ActionButton className={ownedClassName("button ghost")} pending={busy} disabled={!improvement.trim()} onClick={()=>void retryAnswer()}>이 질문에 다시 답하기</ActionButton></section>}
   {/* A completed Live room crosses a document boundary so its prior router transition cannot hold the next plan. */}
   <section className={ownedClassName(styles.continuation,true)} aria-labelledby="training-next-title" aria-live="polite">
    <span className={ownedClassName(styles.nextEyebrow,true)}>{nextStep?.kind==='review'?'마지막 순서':nextStep?'다음 순서':continuation?'오늘의 훈련':'다음 순서 확인'}</span>
    {nextError?<><h3 id="training-next-title" className={ownedClassName(undefined,true)}>다음 계획을 다시 확인해 주세요.</h3><p className={ownedClassName(undefined,true)}>{nextError}</p><button className={ownedClassName("button ghost",true)} onClick={()=>setNextRevision(value=>value+1)}>다음 계획 다시 확인</button></>:!continuation?<p id="training-next-title" role="status" className={ownedClassName(undefined,true)}>저장한 답변을 반영하고 있어요.</p>:nextStep?<a className={ownedClassName(styles.nextStep,true)} href={trainingStepHref(nextStep)} aria-label={`${nextStep.kind==='review'?'오늘 정리로':nextStep.status==='in_progress'?'이어서 훈련하기':'다음 훈련으로'} · ${nextStep.title}`}><span className={ownedClassName(undefined,true)}><h3 id="training-next-title" className={ownedClassName(undefined,true)}>{nextStep.title}</h3><span className={ownedClassName(undefined,true)}>{nextStep.minutes}분{nextStep.kind==='review'?' · 오늘 답변 돌아보기':''}</span></span><ArrowRight size={22} aria-hidden="true"/></a>:<><h3 id="training-next-title" className={ownedClassName(undefined,true)}>{remaining?'직접 추가한 계획을 확인해요.':'오늘 계획을 모두 마쳤어요.'}</h3><Link className={ownedClassName("button primary")} href="/my">{remaining?'오늘 계획 확인':'오늘 훈련으로'}<Check size={16}/></Link></>}
   </section>
   <div className={ownedClassName(styles.actions,true)}><Link href="/my">오늘의 순서</Link><Link href="/preparation">준비 현황</Link><Link href="/records">내 기록</Link></div>
  </section>}
 </div>;
}
