'use client';
import {ownedClassName} from './owned-class-name';

import { uploadRecording as sendRecording } from '@/lib/recording-upload-client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronRight, CirclePause, Clock3, LoaderCircle, Mic, Play, RotateCcw, Type, X } from 'lucide-react';
import { api, post, ActionButton, Alert, Breadcrumb, Empty, PageTitle, Spinner, type Item } from './shared';
import { useApp } from './app-shell';
import { LearningHelp } from './learning-help';
import {PracticeWritingHelp} from './practice-writing-help';
import { AudioLevelDot } from './audio-level-dot';
import { animateStudyReceipt } from './playful-flow';
import {connectLiveTranscription,type LiveTranscription,type LiveTranscript} from '@/lib/client/realtime-transcription';
import { startSpeechCapture,decodeRecordingTelemetry, type SpeechCapture } from '@/lib/client/speech-recorder';
import {beginRecordingRecovery,readRecordingRecovery,removeRecordingRecovery,installRecordingExitGuard,type RecordingRecoveryWriter} from '@/lib/client/recording-recovery';
import {registerDraftSaver} from '@/lib/client/draft-save';
import {resetEnterSequence,sendOnEnter} from '@/lib/client/enter-send';
import { learningTargetIdentityMatches } from '@gakja/content-contracts/workflows';
import { quizAssistanceLabel, quizResponseNeedsReview, recallRating, savedQuizSubmission, type RecallStatus } from '@/lib/quiz-session-view';
import styles from './quiz-session-ui.module.css';
const modeNames:Item={choice:'10초 퀴즈',answer:'Q&A',oral:'답변 녹음'};
type RecordingPreparation={generation:number;index:number;writer:RecordingRecoveryWriter|null;device:MediaStream|null;live:LiveTranscription|null};
const scopeIdentity=(target:Item)=>({...target,department:target.department||target.major||'',admission_type:target.admission_type||target.track||'',admission_year:target.admission_year||target.year||null,interview_stage:target.interview_stage||target.stage||null});
const practiceLink=(item:Item,contentVersion:number,mode='chat')=>'/interview/'+(mode==='video'?'live':'chat')+'?'+new URLSearchParams({kind:mode,questionId:item.question_id||'',...(item.activity_ids?.[0]?{activityId:item.activity_ids[0]}:{}),...(item.targetId||item.target_id?{targetId:item.targetId||item.target_id}:{}),sourceType:item.source_kind==='common'?'common':'personal',sourceVersion:String(item.source_kind==='common'?item.commonRevision||item.common_revision||1:contentVersion),from:'quiz'}).toString();
const repeatLink=(item:Item,session:Item)=>'/quiz?'+new URLSearchParams({memoryItemId:item.id,focus:'free',mode:session.mode,sourceType:item.source_kind==='common'?'common':'personal',...(item.source_kind==='common'?{sourceVersion:String(item.common_revision||1)}:session.content_version?{sourceVersion:String(session.content_version)}:{}),...(item.target_id||session.metadata?.targetId?{targetId:item.target_id||session.metadata.targetId}:{})}).toString();
const knowledgeLink=(item:Item)=>'/knowledge?'+new URLSearchParams({...item.activity_ids?.[0]?{activityId:item.activity_ids[0]}:{},questionId:item.question_id||'',...(item.targetId||item.target_id?{targetId:item.targetId||item.target_id}:{}),from:'quiz'}).toString();
export function QuizHome() {
  const {targetId:appTargetId,data}=useApp();
  const [dto,setDto]=useState<Item|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(''),[untimed,setUntimed]=useState(false),[showAllReady,setShowAllReady]=useState(false);
  const router=useRouter();
  const search=useSearchParams(),requestedId=search.get('memoryItemId'),questionId=search.get('questionId'),activityId=search.get('activityId'),focus=search.get('focus')==='free'?'free':'today';
  const targetId=search.get('targetId')||appTargetId,hasRequested=Boolean(requestedId||questionId||activityId);
  const sourceType=['common','personal'].includes(search.get('sourceType')||'')?search.get('sourceType'):null;
  const sourceVersion=sourceType&&search.get('sourceVersion')?Number(search.get('sourceVersion')):null;
  const requestedMode=['choice','answer','oral'].includes(search.get('mode')||'')?search.get('mode'):null;
  const contextQuery=new URLSearchParams({...requestedId?{memoryItemId:requestedId}:{},...questionId?{questionId}:{},...activityId?{activityId}:{},...targetId?{targetId}:{},...requestedMode?{mode:requestedMode}:{},...sourceType?{sourceType}:{},...sourceVersion?{sourceVersion:String(sourceVersion)}:{}}).toString();
  const navigationQuery={...Object.fromEntries(new URLSearchParams(contextQuery)),...(requestedMode?{mode:requestedMode}:{})};
  const libraryQuery=new URLSearchParams({...targetId?{targetId}:{},...sourceType?{sourceType}:{},...sourceVersion?{sourceVersion:String(sourceVersion)}:{}}).toString();
  const libraryHref='/quiz/memory'+(libraryQuery?'?'+libraryQuery:'');
  useEffect(()=>{const controller=new AbortController();setDto(null);setError('');api<Item>('/api/quiz'+(contextQuery?'?'+contextQuery:''),{signal:controller.signal}).then(setDto).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[contextQuery]);
  const requested=dto?.requested?.item;
  function matching(mode:string) { const items=dto?.library?.[mode]||[]; return items.filter((item:Item)=>requestedId?item.id===(dto?.requested?.mappedItemId||requestedId):questionId?item.question_id===questionId:activityId?item.activity_ids?.includes(activityId):true); }
  async function start(mode:string) {if(busy||!dto)return;setBusy(mode);setError('');try{const ids=matching(mode).map((item:Item)=>item.id);const selectedSource=sourceType==='common'?{sourceType:'common',...(sourceVersion?{sourceVersion}:{})}:dto.contentVersion?{sourceType:'personal',sourceVersion:dto.contentVersion}:{};const result=await post('/api/quiz',{action:'create',mode,focus,timed:mode==='choice'&&!untimed,...(targetId?{targetId}:{}),...(activityId?{activityId}:{}),...selectedSource,...(hasRequested?{itemIds:ids.slice(0,6)}:{})});router.push('/quiz/session/'+result.session.id);}catch(e){setError((e as Error).message);setBusy('');}}
  const selectedTarget=data.targets.find((target:Item)=>target.id===targetId)||dto?.target;
  const scopeName=[selectedTarget?.university,selectedTarget?.department||selectedTarget?.major].filter(Boolean).join(' · ');
  const allOpen:Item[]=dto?.sessions?.filter((s:Item)=>!['completed','ended'].includes(s.state))||[];
  const inCurrentScope=(s:Item)=>{
    const savedId=s.metadata?.targetId||s.metadata?.target_id||s.metadata?.targetSnapshot?.id;
    if(savedId)return Boolean(savedId===targetId&&s.metadata?.targetSnapshot&&selectedTarget&&learningTargetIdentityMatches(scopeIdentity(s.metadata.targetSnapshot),scopeIdentity(selectedTarget)));
    return Boolean(s.metadata?.targetSnapshot&&selectedTarget&&learningTargetIdentityMatches(scopeIdentity(s.metadata.targetSnapshot),scopeIdentity(selectedTarget)));
  };
  const open=allOpen.filter(inCurrentScope),otherOpen=allOpen.filter(s=>!inCurrentScope(s));
  const resumes=[...open].filter((s:Item)=>!hasRequested || (requestedId?s.memoryItemIds?.includes(requestedId):questionId?s.questionIds?.includes(questionId):s.metadata?.activityId===activityId)).sort((a:Item,b:Item)=>Number(b.current_index>0)-Number(a.current_index>0)||new Date(b.created_at).getTime()-new Date(a.created_at).getTime());
  const selectedMode=requestedMode&&matching(requestedMode).length?requestedMode:null;
  const recommendedMode=selectedMode||(matching('choice').length?'choice':'answer');
  const oralSelected=selectedMode==='oral',answerSelected=selectedMode==='answer';
  const recommendationTitle=oralSelected?(hasRequested?'이 질문 소리 내어 답하기':'내 말하기 기록 시작'):answerSelected?(hasRequested?'이 질문 내 말로 쓰기':'내 답변 쓰기'):hasRequested?'이 질문 다시 떠올리기':'오늘의 기억 확인';
  const recommendationReason=oralSelected?'생각한 답을 내 목소리로 남겨보세요.':answerSelected?'기억한 내용을 내 말로 적어보세요.':hasRequested?'같은 질문을 떠올린 뒤 면접에서 말해보세요.':dto?.recommendation?.reason;
  const recommendationCount=hasRequested?Math.min(6,matching(recommendedMode).length):selectedMode?Math.min(focus==='free'?12:6,matching(recommendedMode).length):dto?.recommendation?.count;
  const choiceTiming=(location:string)=><fieldset className={ownedClassName(styles.choiceTiming,true)} disabled={!!busy}><legend className={ownedClassName(undefined,true)}>선택형 퀴즈 시간</legend><div className={ownedClassName(undefined,true)}>{[[false,'10초'],[true,'제한 없음']].map(([value,label])=><label key={String(value)} className={ownedClassName(undefined,true)}><input type="radio" name={'choice-time-'+location} checked={untimed===value} onChange={()=>setUntimed(Boolean(value))} className={ownedClassName(undefined,true)}/><span className={ownedClassName(undefined,true)}>{label}</span></label>)}</div></fieldset>;
  const resumeName=(s:Item)=>{const saved=s.metadata?.targetSnapshot;return [saved?.university,saved?.department||saved?.major].filter(Boolean).join(' · ')||'시작 당시 지원처 정보 없음';};
  async function saveHere(sessionId:string){setBusy(sessionId);try{await post('/api/quiz',{action:'end',sessionId});setDto(await api('/api/quiz'+(contextQuery?'?'+contextQuery:'')));}catch(e){setError((e as Error).message);}finally{setBusy('');}}
  const resumeRow=(s:Item,main=false,showSchool=false)=><div className={ownedClassName('quiz-resume-row '+styles.resumeRow,true)} key={s.id}><div className={ownedClassName(styles.resumeCopy,true)}>{showSchool&&<small className={ownedClassName(undefined,true)}>{resumeName(s)}</small>}<strong className={ownedClassName(undefined,true)}>{s.mode==='choice'&&!s.timed?'선택형 연습':modeNames[s.mode]}</strong><span className={ownedClassName(undefined,true)}>{s.topicLabel}</span><small className={ownedClassName(undefined,true)}>{new Date(s.created_at).toLocaleDateString('ko-KR',{month:'long',day:'numeric'})} · {s.current_index}/{s.total}개 답변 · {Math.max(0,s.total-s.current_index)}개 남음</small></div><div className={ownedClassName(styles.resumeActions,true)}><Link className={ownedClassName('button '+(main?'primary':'secondary'))} href={'/quiz/session/'+s.id}>이어서 풀기<Play size={16}/></Link><ActionButton className={ownedClassName("text-link")} disabled={!!busy} pending={busy===s.id} pendingLabel="기록 저장 중" onClick={()=>void saveHere(s.id)}>여기까지 저장</ActionButton></div></div>;
  const resumeList=!!resumes.length&&<><section className={ownedClassName("quiz-resume-list",true)}><div className={ownedClassName("section-heading",true)}><h2 className={ownedClassName(undefined,true)}>이어서 풀기</h2></div>{resumes.slice(0,showAllReady?30:1).map((s:Item,index:number)=>resumeRow(s,index===0))}</section>{resumes.length>1&&<button className={ownedClassName("text-link quiz-show-ready",true)} aria-expanded={showAllReady} onClick={()=>setShowAllReady(value=>!value)}>{showAllReady?'접기':`다른 진행 중 퀴즈 ${resumes.length-1}개`}<ChevronRight size={16}/></button>}</>;
  return <div className={ownedClassName('quiz-v3 quiz-home '+styles.home,true)}><PageTitle title="퀴즈"/>{error&&<Alert>{error}</Alert>}
    {scopeName&&<p className={ownedClassName(styles.homeScope,true)}>현재 지원처 · {scopeName}</p>}
    <nav className={ownedClassName("quiz-paths",true)} aria-label="퀴즈 학습 경로"><Link href={'/quiz?'+new URLSearchParams({...navigationQuery,focus:'today'}).toString()} aria-current={focus==='today'?'page':undefined}>오늘 복습</Link><Link href={'/quiz?'+new URLSearchParams({...navigationQuery,focus:'free'}).toString()} aria-current={focus==='free'?'page':undefined}>자유 연습</Link></nav>
    {dto?.targetSnapshotStale&&<p className={ownedClassName("quiz-note",true)}>이 교재의 {dto.target?.university} · {dto.target?.department} 기준으로 연습해요. 현재 지원 정보와 달라요.</p>}
    {!dto&&!error?<Spinner/>:<>{requested&&<section className={ownedClassName("quiz-context",true)}><span className={ownedClassName(undefined,true)}>다시 준비할 질문</span><h2 className={ownedClassName(undefined,true)}>{requested.prompt}</h2>{dto?.requested?.reason&&<p className={ownedClassName(undefined,true)}>{dto.requested.reason}</p>}{dto?.requested?.sessionId&&<Link className={ownedClassName("text-link")} href={'/quiz/session/'+dto.requested.sessionId}>저장 당시 기록<ArrowUpRight size={16}/></Link>}</section>}{hasRequested&&dto&&!requested&&<p className={ownedClassName("quiz-note",true)}>현재 발행 자료에 연결된 연습 항목이 없어요. <Link href={libraryHref}>전체 복습 항목 보기</Link></p>}
    {focus==='today'&&resumeList}
    {(focus==='today'||selectedMode)&&matching(recommendedMode).length>0&&<section className={ownedClassName("quiz-today",true)}><div className={ownedClassName(undefined,true)}><h2 className={ownedClassName(undefined,true)}>{recommendationTitle}</h2><p className={ownedClassName(undefined,true)}>{recommendationReason} · {recommendationCount}문항</p>{recommendedMode==='choice'&&choiceTiming('today')}</div><ActionButton className={ownedClassName('button '+(resumes.length?'secondary':'primary'))} disabled={!!busy} pending={busy===recommendedMode} pendingLabel="퀴즈 준비 중" onClick={()=>start(recommendedMode)}>{oralSelected?'녹음 답변 시작':answerSelected?'Q&A 시작':'복습 시작'}{oralSelected?<Mic size={17}/>:<Play size={17}/>}</ActionButton></section>}
    {focus==='free'&&<section className={ownedClassName("quiz-new-practice",true)}><h2 className={ownedClassName("section-label",true)}>새로 연습하기</h2><div className={ownedClassName("quiz-mode-list",true)}>{[['choice','선택형 퀴즈',untimed?'보기를 고른 뒤, 정답과 근거를 천천히 확인해요.':'10초 안에 4개의 보기 중 하나를 고르세요.',Clock3],['answer','Q&A','기억한 내용을 내 말로 적어보세요.',Type],['oral','답변 녹음','생각한 답을 내 목소리로 남겨보세요.',Mic]].sort(([a],[b])=>Number(matching(String(b)).length>0)-Number(matching(String(a)).length>0)).map(([key,title,description,Icon]:any)=>{const available=matching(key).length>0;return <div key={key} className={ownedClassName(styles.modeEntry,true)}><button className={ownedClassName("quiz-mode-row",true)} disabled={!!busy||!available} aria-busy={busy===key} onClick={()=>start(key)}><Icon size={30} strokeWidth={1.4}/><div className={ownedClassName(undefined,true)}><h2 className={ownedClassName(undefined,true)}>{title}</h2><p className={ownedClassName(undefined,true)}>{available?description:'문제 준비 중이에요.'}</p></div><span className={ownedClassName(undefined,true)}>{busy===key?'준비 중':available?`${matching(key).length}문항`:'준비 중'}{busy===key?<LoaderCircle className={ownedClassName("spin")} size={23} aria-hidden="true"/>:available&&<ArrowUpRight size={23} aria-hidden="true"/>}</span></button>{key==='choice'&&available&&choiceTiming('free')}</div>;})}</div></section>}
    {focus==='free'&&resumeList}
    {!!otherOpen.length&&<details className={ownedClassName(styles.otherSessions,true)}><summary className={ownedClassName(undefined,true)}>다른 지원처·지원처 미지정 퀴즈 {otherOpen.length}개<ChevronRight size={16}/></summary><p className={ownedClassName(undefined,true)}>저장 당시 학교·학과 기준으로 이어가요.</p>{otherOpen.map((s:Item)=>resumeRow(s,false,true))}</details>}
    <div className={ownedClassName("quiz-library-links",true)}><Link href={libraryHref}>전체 복습 항목<ArrowUpRight size={18}/></Link><Link href="/records/history">연습 이력<ArrowUpRight size={18}/></Link></div>
    {dto&&!dto.library?.choice?.length&&<p className={ownedClassName("quiz-note",true)}>객관식 문제 준비 중이에요. {matching('answer').length?'지금은 Q&A로 연습할 수 있어요.':matching('oral').length?'지금은 답변 녹음으로 연습할 수 있어요.':<>관련 자료를 읽으며 질문을 준비해보세요. <Link href={'/knowledge'+(libraryQuery?'?'+libraryQuery:'')}>관련 자료 보기</Link></>}</p>}</>}
  </div>;
}

export function QuizSession({id}:{id:string}) {
  const {refresh,data,openResource,toast}=useApp();
  const router=useRouter();
  const [dto,setDto]=useState<Item|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[left,setLeft]=useState(10);
  const [answer,setAnswer]=useState(''),[hint,setHint]=useState<Item|null>(null),[feedback,setFeedback]=useState<Item|null>(null),[countdown,setCountdown]=useState<number|null>(null);
  const [selected,setSelected]=useState<string|null>(null),[recording,setRecording]=useState<Item|null>(null),[consent,setConsent]=useState(false),[recordingState,setRecordingState]=useState<'idle'|'recording'|'uploading'>('idle'),[recordSeconds,setRecordSeconds]=useState(0);
  const [meterStream,setMeterStream]=useState<MediaStream|null>(null),[recordingSaved,setRecordingSaved]=useState(false);
  const [recallStatus,setRecallStatus]=useState<RecallStatus>('unchecked'),[draftStatus,setDraftStatus]=useState<'idle'|'saving'|'saved'|'failed'>('idle');
  const [pendingAudio,setPendingAudio]=useState<{blob:Blob;durationMs:number;index:number;telemetry:Item|undefined;recoveryKey?:string;complete?:boolean;needsMeasurement?:boolean}|null>(null);
  const [transcriptProcessing,setTranscriptProcessing]=useState(false);
  const [submissionAction,setSubmissionAction]=useState<'answer'|'again'>('answer');
  const [choiceReview,setChoiceReview]=useState<Item|null>(null);
  const [textAlternative,setTextAlternative]=useState(false),[preparation,setPreparation]=useState<number|null>(null),[skipPreparation,setSkipPreparation]=useState(false),[pendingAudioUrl,setPendingAudioUrl]=useState('');
  const [liveTranscript,setLiveTranscript]=useState<LiveTranscript|null>(null);
  const [recordingNotice,setRecordingNotice]=useState<''|'background'|'microphone'>(''),[recoveryWaiting,setRecoveryWaiting]=useState(false);
  const latestAnswer=useRef(answer),latestRecording=useRef(recording),pendingSubmission=useRef<Item|null>(null),draftQueue=useRef<Promise<void>>(Promise.resolve()),savedDraft=useRef<{key:string;response:string}>({key:'',response:''}),draftRequest=useRef<{key:string;response:string;requestId:string}|null>(null);
  const offset=useRef(0),sending=useRef(false),recorder=useRef<MediaRecorder|null>(null),stream=useRef<MediaStream|null>(null),recordStart=useRef(0),mounted=useRef(true),latest=useRef<Item|null>(null),loadedDraft=useRef(''),recordingPhase=useRef(recordingState);
  const speechCapture=useRef<SpeechCapture|null>(null);
  const stoppedRecording=useRef<{durationMs:number;telemetry:Item|undefined}|null>(null);
  const recoveryWriter=useRef<RecordingRecoveryWriter|null>(null),recordingFinished=useRef<Promise<void>>(Promise.resolve()),resolveRecordingFinished=useRef<(()=>void)|null>(null),pendingAudioRef=useRef(pendingAudio),questionHeading=useRef<HTMLHeadingElement|null>(null),captureGeneration=useRef(0);
  const preparationAttempt=useRef<RecordingPreparation|null>(null),preparationTimer=useRef<ReturnType<typeof setTimeout>|null>(null),sessionUpdateVersion=useRef(0);
  const liveCapture=useRef<LiveTranscription|null>(null),liveCaptionBody=useRef<HTMLParagraphElement|null>(null);
  const recordingLifecycle=useRef<{capture:MediaRecorder;interrupted:boolean;needsMeasurement:boolean;cleanup:()=>void}|null>(null),pendingSaveLock=useRef(false);
  const logoutSaving=useRef(false),suspendedForLogout=useRef(false),savePendingLocal=useRef(false),latestSelected=useRef(selected),logoutSave=useRef<()=>Promise<void>>(async()=>{});
  const submissionFinished=useRef<Promise<void>>(Promise.resolve()),resolveSubmissionFinished=useRef<(()=>void)|null>(null);
  const recordingWork=useRef<Promise<void>>(Promise.resolve());
  const sessionWork=useRef<Promise<Item>|null>(null);
  const answerComposing=useRef(false);
  const answerScope=useRef(dto?.session?`gakja-quiz:${dto.session.student_id}:${id}:${dto.session.current_index}`:'');
  useEffect(()=>{const body=liveCaptionBody.current;if(body&&liveTranscript?.phase==='listening')body.scrollTop=body.scrollHeight;},[liveTranscript?.text,liveTranscript?.phase]);
  pendingAudioRef.current=pendingAudio;
  latest.current=dto;
  latestAnswer.current=answer;
  latestRecording.current=recording;
  recordingPhase.current=recordingState;
  latestSelected.current=selected;
  const apply=useCallback((value:Item)=>{sessionUpdateVersion.current++;offset.current=new Date(value.serverTime).getTime()-Date.now();latest.current=value;setDto(value);},[]);
  const pauseOnExit=useCallback((beacon=true)=>{
    if(logoutSaving.current)return;
    const value=latest.current,current=value?.session,preparing=!!preparationAttempt.current;
    if(preparing)void cancelPreparation();
    if(current?.state!=='active'||sending.current||!preparing&&!recordingLifecycle.current?.interrupted&&recordingPhase.current!=='idle')return;
    const requestVersion=++sessionUpdateVersion.current;
    const payload={action:'pause',sessionId:id,itemIndex:current.current_index};
    latest.current={...value,session:{...current,state:'paused'}};
    if(mounted.current)setDto(latest.current);
    if(beacon)navigator.sendBeacon('/api/quiz',new Blob([JSON.stringify(payload)],{type:'application/json'}));
    else {
      // A processed pause may arrive after the student has already resumed.
      const isCurrentResponse=()=>mounted.current&&sessionUpdateVersion.current===requestVersion&&latest.current?.session.id===id&&latest.current.session.current_index===current.current_index;
      post('/api/quiz',payload).then(value=>{if(isCurrentResponse())apply(value);}).catch(error=>{if(isCurrentResponse())setError(error.message);});
    }
  },[id,apply]);
  const applySavedChoice=useCallback((value:Item,receipt?:Item)=>{
    apply(value);
    const current=value.session;
    const saved=receipt||(value.responses||[]).find((response:Item)=>response.item_index===current.current_index-1);
    let reviewed=false;try{reviewed=Boolean(saved)&&sessionStorage.getItem('gakja-quiz:'+id+':reviewed')===String(saved.id??saved.item_index);}catch{}
    setChoiceReview(current.mode==='choice'&&current.timed===false&&['ready','completed'].includes(current.state)&&saved&&!reviewed?saved:null);
  },[id,apply]);
  useEffect(()=>{mounted.current=true;sessionUpdateVersion.current++;captureGeneration.current++;const controller=new AbortController();api<Item>('/api/quiz?sessionId='+id,{signal:controller.signal}).then(async value=>{if(value.session.state==='active')value=await post('/api/quiz',{action:'pause',sessionId:id,itemIndex:value.session.current_index});if(mounted.current)applySavedChoice(value);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>{mounted.current=false;sessionUpdateVersion.current++;captureGeneration.current++;controller.abort();recordingLifecycle.current?.cleanup();liveCapture.current?.close();liveCapture.current=null;if(preparationAttempt.current){pauseOnExit();return;}if(recorder.current?.state==='recording'||recorder.current?.state==='paused'){finishRecordingMeasurement();recorder.current.stop();}else{speechCapture.current?.dispose();speechCapture.current=null;if(!resolveRecordingFinished.current)void recoveryWriter.current?.cancel().catch(()=>{});}stream.current?.getTracks().forEach(t=>t.stop());};},[id,applySavedChoice,pauseOnExit]);
  const session=dto?.session,item=session?.items?.[session.current_index],done=session&&['completed','ended'].includes(session.state);
  const sessionName=session?.mode==='choice'&&session?.timed===false?'선택형 연습':modeNames[session?.mode];
  const nextItem=session?.items?.[(dto?.responses?.find(quizResponseNeedsReview)||dto?.responses?.at(-1))?.item_index];
  const sessionLearning=dto?.learning;
  const savedMemory=nextItem&&sessionLearning?.memory_items?.find((memory:Item)=>memory.id===nextItem.id);
  const sameConcept=nextItem?.practice_kind==='concept'&&sessionLearning?.questions?.find((question:Item)=>question.question_types?.includes('concept')&&(question.id===nextItem.question_id||question.id===savedMemory?.question_id)&&question.prompt===nextItem.practice_prompt);
  const samePersonal=nextItem&&nextItem.practice_kind!=='concept'&&sessionLearning?.questions?.find((question:Item)=>question.id===nextItem.question_id);
  const appliedActivity=!sameConcept&&!samePersonal&&nextItem?.practice_kind==='concept'&&sessionLearning?.questions?.find((question:Item)=>question.id===nextItem.linked_question_id||question.activity_ids?.some((activityId:string)=>(nextItem.activity_ids||[]).includes(activityId)));
  const savedCommon=nextItem?.source_kind==='common';
  const nextQuestion=savedCommon?{id:nextItem.question_id,prompt:nextItem.practice_prompt||nextItem.prompt}:sameConcept||samePersonal||appliedActivity;
  const contextItem=nextItem?{...nextItem,target_id:nextItem.target_id||session?.metadata?.targetId,activity_ids:nextItem.activity_ids}:null;
  const savedTarget=nextItem?.target_snapshot||session?.metadata?.targetSnapshot;
  const currentTarget=data.targets.find(t=>t.id===(nextItem?.target_id||session?.metadata?.targetId));
  const changedTarget=Boolean(savedTarget&&(!currentTarget||!learningTargetIdentityMatches(savedTarget,currentTarget)));
  const sessionTarget=session?.metadata?.targetSnapshot;
  const registeredSessionTarget=data.targets.find(target=>target.id===session?.metadata?.targetId);
  const changedSessionTarget=Boolean(sessionTarget&&(!registeredSessionTarget||!learningTargetIdentityMatches(sessionTarget,registeredSessionTarget)));
  const publishedTarget=sessionLearning?.support_targets?.find((target:Item)=>target.id===currentTarget?.id);
  const historicTargetAvailable=Boolean(currentTarget&&publishedTarget&&savedTarget&&learningTargetIdentityMatches(publishedTarget,savedTarget));
  const practiceItem=contextItem&&nextQuestion&&(!changedTarget||!savedCommon&&historicTargetAvailable)?{...contextItem,question_id:nextQuestion.id}:null;
  const draftKey=item?`gakja-quiz:${session.student_id}:${id}:${session.current_index}`:'';
  const activityKey=`gakja-quiz-activity:${data.user.id}:${id}`;
  const transcriptReady=Boolean(recording?.id&&recording.item_index===session?.current_index&&(!recording.session_id||recording.session_id===id)&&recording.transcript_cleanup?.status==='completed'&&typeof recording.display_transcript==='string'&&recording.display_transcript.trim());
  useEffect(()=>{if(!draftKey)return;liveCapture.current?.close();liveCapture.current=null;setLiveTranscript(null);setRecordingNotice('');setRecoveryWaiting(false);loadedDraft.current='';const remote=session.metadata?.drafts?.[String(session.current_index)],remoteText=typeof remote==='string'?remote:remote?.response||'';let local:string|null=null;try{local=localStorage.getItem(draftKey)??sessionStorage.getItem(draftKey);}catch{}savedDraft.current={key:draftKey,response:remoteText};const priorRecording=dto?.recordings?.find((r:Item)=>r.item_index===session?.current_index);const initialAnswer=local??(remoteText||((priorRecording?.transcript_cleanup?.status==='completed'&&priorRecording.display_transcript)||''));latestAnswer.current=initialAnswer;answerScope.current=draftKey;setAnswer(initialAnswer);setRecallStatus('unchecked');try{const pending=JSON.parse(sessionStorage.getItem(draftKey+':submission')||'null');pendingSubmission.current=pending?.itemIndex===session.current_index?pending:null;if(pendingSubmission.current&&['remembered','uncertain','needs_confirmation','unchecked'].includes(pendingSubmission.current.recallStatus))setRecallStatus(pendingSubmission.current.recallStatus);}catch{pendingSubmission.current=null;}setDraftStatus(remoteText?'saved':'idle');setHint(null);setFeedback(null);let restoredChoice:string|null=null;if(session.mode==='choice'&&!(dto?.responses||[]).some((response:Item)=>response.item_index===session.current_index)){try{const choice=JSON.parse(localStorage.getItem(draftKey+':choice')??sessionStorage.getItem(draftKey+':choice')??'null');if(choice?.studentId===data.user.id&&choice.sessionId===id&&choice.itemIndex===session.current_index&&choice.memoryItemId===item.id&&item.options?.some((option:Item)=>option.id===choice.selectedOptionId))restoredChoice=choice.selectedOptionId;}catch{}}latestSelected.current=restoredChoice;setSelected(restoredChoice);setRecordingSaved(false);setPendingAudio(null);setRecording(dto?.recordings?.find((r:Item)=>r.item_index===session?.current_index)||null);},[draftKey]);
  useEffect(()=>{
    if(!draftKey)return;let active=true,reading=false,timer:ReturnType<typeof setTimeout>|undefined;
    try{setTextAlternative(localStorage.getItem(draftKey+':text-mode')==='true');}catch{setTextAlternative(false);}
    const recover=async()=>{
      if(!active||reading||document.visibilityState==='hidden'||recordingPhase.current!=='idle'||preparationAttempt.current||pendingAudioRef.current)return;
      clearTimeout(timer);reading=true;
      try{const saved=await readRecordingRecovery({studentId:session.student_id,sessionId:id,itemIndex:session.current_index,kind:'quiz'});
        if(!active||recordingPhase.current!=='idle'||preparationAttempt.current||pendingAudioRef.current)return;
        setRecoveryWaiting(Boolean(saved?.inUse));
        if(saved?.inUse){timer=setTimeout(()=>void recover(),5000);return;}
        if(saved){const candidate={blob:saved.blob,durationMs:saved.durationMs,index:saved.itemIndex,telemetry:saved.telemetry,recoveryKey:saved.key,complete:saved.complete,needsMeasurement:saved.needsMeasurement};pendingAudioRef.current=candidate;setPendingAudio(candidate);}
      }catch{if(active)setError('기기에 보관한 녹음을 확인하지 못했어요. 저장 공간을 확인하고 화면을 다시 열어 주세요.');}finally{reading=false;}
    };
    const revisit=()=>{if(document.visibilityState!=='hidden')void recover();};void recover();
    window.addEventListener('focus',revisit);window.addEventListener('pageshow',revisit);document.addEventListener('visibilitychange',revisit);
    return()=>{active=false;clearTimeout(timer);window.removeEventListener('focus',revisit);window.removeEventListener('pageshow',revisit);document.removeEventListener('visibilitychange',revisit);};
  },[draftKey]);
  useEffect(()=>{if(!pendingAudio){setPendingAudioUrl('');return;}const url=URL.createObjectURL(pendingAudio.blob);setPendingAudioUrl(url);return()=>URL.revokeObjectURL(url);},[pendingAudio]);
  useEffect(()=>{try{setSkipPreparation(localStorage.getItem('gakja-recording-skip-ready:'+data.user.id)==='true'||localStorage.getItem('gakja-recording-ready-seen:'+data.user.id)==='true');}catch{}},[data.user.id]);
  useEffect(()=>{if(!session||(!done&&!choiceReview&&session.state!=='active'))return;const frame=requestAnimationFrame(()=>{const title=questionHeading.current;if(!title)return;title.focus({preventScroll:true});title.scrollIntoView({block:'start',behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});});return()=>cancelAnimationFrame(frame);},[session?.current_index,session?.state,done,choiceReview?.id]);
  useEffect(()=>installRecordingExitGuard({hasPending:()=>recordingPhase.current!=='idle'||!!pendingAudioRef.current,save:async()=>{if(recorder.current?.state==='recording'||recorder.current?.state==='paused')stopRecording();await recordingFinished.current;await recoveryWriter.current?.flush();},navigate:href=>router.push(href)}),[router]);
  const saveDraft=useCallback(async(text:string,index:number,key:string)=>{
    if(!key||latest.current?.session.mode==='choice')return;
    if(savedDraft.current.key===key&&savedDraft.current.response===text)return;
    if(draftRequest.current?.key!==key||draftRequest.current.response!==text)draftRequest.current={key,response:text,requestId:crypto.randomUUID()};
    const request=draftRequest.current;
    setDraftStatus('saving');
    const work=draftQueue.current.catch(()=>{}).then(async()=>{await post('/api/quiz',{action:'draft',sessionId:id,itemIndex:index,response:text,requestId:request.requestId});savedDraft.current={key,response:text};});
    draftQueue.current=work;
    try{await work;if(mounted.current&&latestAnswer.current===text)setDraftStatus('saved');}catch(e){if(mounted.current)setDraftStatus('failed');throw e;}
  },[id]);
  function persistChoice(current:Item,optionId:string|null){
    if(!optionId||!current.items?.[current.current_index]?.options?.some((option:Item)=>option.id===optionId))return true;
    const key=`gakja-quiz:${current.student_id}:${id}:${current.current_index}:choice`;
    const value=JSON.stringify({studentId:data.user.id,sessionId:id,itemIndex:current.current_index,memoryItemId:current.items[current.current_index].id,selectedOptionId:optionId});
    let stored=false;try{localStorage.setItem(key,value);stored=true;}catch{}try{sessionStorage.setItem(key,value);stored=true;}catch{}return stored;
  }
  logoutSave.current=async()=>{
    logoutSaving.current=true;suspendedForLogout.current=true;savePendingLocal.current=true;setBusy(true);setCountdown(null);
    const opening=latest.current;
    if(opening?.session.state==='active'){latest.current={...opening,session:{...opening.session,state:'paused'}};setDto(latest.current);}
    try{
      await sessionWork.current?.catch(()=>{});
      if(sending.current)await submissionFinished.current;
      if(sending.current)throw new Error('진행 중인 요청을 확인한 뒤 다시 로그아웃해 주세요.');
      const pending=pendingSubmission.current;
      if(pending){
        const recovered=await api<Item>('/api/quiz?sessionId='+id),receipt=savedQuizSubmission(recovered.responses||[],pending);
        if(!receipt)throw new Error('보낸 답변의 저장을 확인하지 못했어요. 답변을 다시 확인한 뒤 로그아웃해 주세요.');
        const key=`gakja-quiz:${recovered.session.student_id}:${id}:${pending.itemIndex}`;
        pendingSubmission.current=null;try{localStorage.removeItem(key);localStorage.removeItem(key+':choice');sessionStorage.removeItem(key);sessionStorage.removeItem(key+':submission');sessionStorage.removeItem(key+':choice');}catch{}
        applySavedChoice(recovered,receipt);
      }
      await cancelPreparation();
      if(recorder.current?.state==='recording'||recorder.current?.state==='paused')stopRecording();
      await recordingFinished.current;
      await recordingWork.current;
      await recoveryWriter.current?.flush();
      const audio=pendingAudioRef.current;
      if(audio){const stored=await readRecordingRecovery({studentId:data.user.id,sessionId:id,itemIndex:audio.index,kind:'quiz'});if(!stored||stored.key!==audio.recoveryKey||!stored.blob.size)throw new Error('녹음의 기기 저장을 확인하지 못했어요. 원본을 보관한 뒤 다시 로그아웃해 주세요.');}
      const current=latest.current?.session;
      if(!current||['completed','ended'].includes(current.state))return;
      if(current.id!==id||current.student_id!==data.user.id)throw new Error('초안을 저장할 계정을 확인하지 못했어요.');
      const key=`gakja-quiz:${current.student_id}:${id}:${current.current_index}`;
      if(current.mode!=='choice'&&answerScope.current!==key){
        const remote=current.metadata?.drafts?.[String(current.current_index)],remoteText=typeof remote==='string'?remote:remote?.response||'';
        let local:string|null=null;try{local=localStorage.getItem(key)??sessionStorage.getItem(key);}catch{}
        latestAnswer.current=local??remoteText;answerScope.current=key;setAnswer(latestAnswer.current);
      }
      const text=latestAnswer.current;
      if(current.mode==='choice'){
        if(!persistChoice(current,latestSelected.current))throw new Error('선택한 보기를 기기에 보관하지 못했어요. 저장 공간을 확인해 주세요.');
      }else{
        try{localStorage.setItem(key,text);}catch{}try{sessionStorage.setItem(key,text);}catch{}
        await draftQueue.current.catch(()=>{});
        savedDraft.current={key:'',response:''};draftRequest.current=null;
        await saveDraft(text,current.current_index,key);
        await draftQueue.current;
      }
      try{localStorage.setItem(activityKey,JSON.stringify({itemIndex:current.current_index,updatedAt:new Date().toISOString(),hasDraft:current.mode==='choice'?!!latestSelected.current:!!text.trim()||!!audio||!!latestRecording.current,hasRecording:!!audio||!!latestRecording.current}));}catch{}
      apply(await post('/api/quiz',{action:'pause',sessionId:id,itemIndex:current.current_index}));
    }catch(cause){if(mounted.current)setError((cause as Error).message);throw cause;}
    finally{logoutSaving.current=false;savePendingLocal.current=false;if(mounted.current)setBusy(false);}
  };
  useEffect(()=>registerDraftSaver(data.user.id,()=>logoutSave.current()),[data.user.id,id]);
  useEffect(()=>{if(!draftKey||session?.mode==='choice'||done||busy)return;if(loadedDraft.current!==draftKey){loadedDraft.current=draftKey;return;}try{localStorage.setItem(draftKey,answer);sessionStorage.setItem(draftKey,answer);const hasRecording=!!pendingAudioRef.current||!!latestRecording.current||recordingPhase.current==='recording';localStorage.setItem(activityKey,JSON.stringify({itemIndex:session.current_index,updatedAt:new Date().toISOString(),hasDraft:!!answer.trim()||hasRecording,hasRecording}));}catch{}if(savedDraft.current.key===draftKey&&savedDraft.current.response===answer)return;setDraftStatus('saving');const timer=setTimeout(()=>{void saveDraft(answer,session.current_index,draftKey).catch(()=>{});},450);return()=>clearTimeout(timer);},[answer,draftKey,session?.mode,session?.current_index,done,busy,saveDraft,activityKey]);
  useEffect(()=>{const openAssistant=(event:Event)=>{const value=latest.current?.session;if(!value||['completed','ended'].includes(value.state))return;event.preventDefault();if(value.mode==='choice'){toast('답변 저장 후 AI 비서에서 확인해 주세요.');return;}if(recordingPhase.current!=='idle'||pendingAudio){toast('녹음을 마치고 저장한 뒤 이동해 주세요.');return;}if(sending.current||busy)return;setBusy(true);setError('');void(async()=>{try{const currentItem=value.items[value.current_index];await cancelPreparation();await saveDraft(latestAnswer.current,value.current_index,draftKey);apply(await post('/api/quiz',{action:'pause',sessionId:id,itemIndex:value.current_index}));router.push('/on?'+new URLSearchParams({quizSessionId:id,quizItemIndex:String(value.current_index),questionId:currentItem.question_id||'',...(currentItem.target_id||value.metadata?.targetId?{targetId:currentItem.target_id||value.metadata.targetId}:{}),sourceType:currentItem.source_kind==='common'?'common':'personal',sourceVersion:String(currentItem.source_kind==='common'?currentItem.common_revision||1:value.content_version||'')}).toString());}catch(e){setError('초안 저장을 확인하지 못했어요. 다시 저장한 뒤 이동해 주세요.');setDraftStatus('failed');}finally{setBusy(false);}})();};window.addEventListener('gakja:open-on',openAssistant);return()=>window.removeEventListener('gakja:open-on',openAssistant);},[id,draftKey,saveDraft,apply,pendingAudio,busy,router,toast]);
  async function transition(action:string,extra:Item={}) {sessionUpdateVersion.current++;setError('');const work=post('/api/quiz',{action,sessionId:id,itemIndex:latest.current?.session.current_index,...extra});sessionWork.current=work;return work;}
  async function start() {if(logoutSaving.current||sending.current)return;suspendedForLogout.current=false;sessionUpdateVersion.current++;setCountdown(3);}
  useEffect(()=>{if(countdown===null)return;const timer=setTimeout(async()=>{if(logoutSaving.current)return;if(countdown>1)setCountdown(countdown-1);else{setCountdown(null);setBusy(true);try{apply(await transition('start'));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}},400);return()=>clearTimeout(timer);},[countdown]);
  const submit=useCallback(async(selectedOptionId:string|null,timedOut=false,rating?:string,recallOverride?:RecallStatus)=>{
    if(logoutSaving.current||sending.current||choiceReview||!latest.current||latest.current.session.state!=='active'||recordingPhase.current!=='idle'||pendingAudio||preparation!==null)return;const current=latest.current.session,receiptOrigin=document.activeElement instanceof HTMLElement?document.activeElement.getBoundingClientRect():undefined;
    const selectedRecall=recallOverride||recallStatus,payload={action:'answer',sessionId:id,itemIndex:current.current_index,selectedOptionId,timedOut,response:current.mode==='choice'?'':answer,rating:rating||(current.mode==='choice'?'good':recallRating(selectedRecall)),recallStatus:current.mode==='choice'?undefined:selectedRecall,hintUsed:!!hint,recordingId:textAlternative?undefined:recording?.id,...(current.mode==='oral'&&textAlternative?{responseMode:'text'}:{})};
    if(!pendingSubmission.current||JSON.stringify({...pendingSubmission.current,requestId:undefined})!==JSON.stringify(payload))pendingSubmission.current={...payload,requestId:crypto.randomUUID()};
    const request=pendingSubmission.current;try{if(draftKey)sessionStorage.setItem(draftKey+':submission',JSON.stringify(request));}catch{}
    submissionFinished.current=new Promise(resolve=>{resolveSubmissionFinished.current=resolve;});sending.current=true;latestSelected.current=selectedOptionId;if(current.mode==='choice')persistChoice(current,selectedOptionId);setSubmissionAction(rating==='again'?'again':'answer');setBusy(true);setError('');setSelected(selectedOptionId);
    const clearDraft=()=>{pendingSubmission.current=null;savedDraft.current={key:'',response:''};try{localStorage.removeItem(activityKey);if(draftKey){localStorage.removeItem(draftKey);sessionStorage.removeItem(draftKey);sessionStorage.removeItem(draftKey+':submission');localStorage.removeItem(draftKey+':choice');sessionStorage.removeItem(draftKey+':choice');}}catch{}};
    try {
      await draftQueue.current.catch(()=>{});
      const response=await post('/api/quiz',request);
      clearDraft();setFeedback(response.response);if(['completed','ended'].includes(response.session.state))animateStudyReceipt(receiptOrigin);
      if(response.session.mode==='choice'&&response.session.timed!==false&&response.session.state==='ready'&&!suspendedForLogout.current) {
        setTimeout(async()=>{if(!mounted.current){sending.current=false;resolveSubmissionFinished.current?.();resolveSubmissionFinished.current=null;return;}if(suspendedForLogout.current){applySavedChoice(response,response.response);sending.current=false;setBusy(false);resolveSubmissionFinished.current?.();resolveSubmissionFinished.current=null;return;}try{apply(await transition('start',{itemIndex:response.session.current_index}));setFeedback(null);setSelected(null);}catch(e){apply(response);setError((e as Error).message);}finally{sending.current=false;setBusy(false);resolveSubmissionFinished.current?.();resolveSubmissionFinished.current=null;}},650);
      }else{applySavedChoice(response,response.response);sending.current=false;setBusy(false);}
      await refresh();
    }catch(e){try{const recovered=await api<Item>('/api/quiz?sessionId='+id),saved=savedQuizSubmission(recovered.responses||[],request);if(saved){clearDraft();applySavedChoice(recovered,saved);setFeedback(saved);toast('저장된 답변을 다시 불러왔어요.');await refresh();}else setError('답변 저장을 확인하지 못했어요. 같은 요청으로 다시 저장해 주세요.');}catch{setError((e as Error).message);}sending.current=false;setBusy(false);setSelected(null);}finally{if(!sending.current){resolveSubmissionFinished.current?.();resolveSubmissionFinished.current=null;}}
  },[id,answer,hint,recording,draftKey,refresh,apply,applySavedChoice,choiceReview,recallStatus,pendingAudio,toast,textAlternative,activityKey,preparation]);
  async function nextChoice() {
    if(logoutSaving.current||!choiceReview||sending.current||busy||!latest.current)return;
    suspendedForLogout.current=false;
    sending.current=true;setBusy(true);setError('');
    try {
      const current=latest.current.session;
      if(!['completed','ended'].includes(current.state))apply(await transition('start',{itemIndex:current.current_index}));
      try{sessionStorage.setItem('gakja-quiz:'+id+':reviewed',String(choiceReview.id??choiceReview.item_index));}catch{}
      setChoiceReview(null);setFeedback(null);setSelected(null);
    }catch(e){setError('다음 문제를 시작하지 못했어요. 다시 눌러 주세요.');}
    finally{sending.current=false;setBusy(false);}
  }
  useEffect(()=>{if(!session||session.mode!=='choice'||session.state!=='active'||!session.deadline_at||feedback||error)return;const tick=()=>{if(logoutSaving.current||suspendedForLogout.current)return;const ms=Math.max(0,new Date(session.deadline_at).getTime()-(Date.now()+offset.current));setLeft(ms/1000);if(ms<=0&&!sending.current)submit(null,true);};tick();const timer=setInterval(tick,80);return()=>clearInterval(timer);},[session?.state,session?.deadline_at,feedback,error,submit]);
  useEffect(()=>{const onKey=(event:KeyboardEvent)=>{
    if(!session||session.mode!=='choice'||session.state!=='active'||busy||sending.current||feedback||choiceReview||countdown!==null)return;
    if(event.defaultPrevented||event.isComposing||event.repeat||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return;
    const editable='input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]';
    if([event.target,document.activeElement,...(event.composedPath?.()||[])].some(target=>target instanceof Element&&target.closest(editable)))return;
    if(document.querySelector('dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'))return;
    const index=['1','2','3','4'].indexOf(event.key);if(index>=0&&item?.options?.[index]){event.preventDefault();void submit(item.options[index].id);}
  };window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);},[session,item,busy,feedback,choiceReview,countdown,submit]);
  useEffect(()=>{
    const hide=()=>{if(document.visibilityState==='hidden'){interruptRecording('background');pauseOnExit(false);}};
    const pageHide=()=>{interruptRecording('background');liveCapture.current?.close();liveCapture.current=null;pauseOnExit();};
    const freeze=()=>{interruptRecording('background');pauseOnExit();};
    window.addEventListener('pagehide',pageHide);document.addEventListener('visibilitychange',hide);document.addEventListener('freeze',freeze);
    return()=>{pauseOnExit();window.removeEventListener('pagehide',pageHide);document.removeEventListener('visibilitychange',hide);document.removeEventListener('freeze',freeze);};
  },[pauseOnExit]);
  useEffect(()=>{if(recordingState!=='recording')return;const elapsedMs=()=>speechCapture.current?.elapsedMs()??performance.now()-recordStart.current;
    // Leave one polling interval for normal timer scheduling; never relabel an overlong file.
    const limit=setTimeout(stopRecording,Math.max(0,179_750-elapsedMs()));
    const timer=setInterval(()=>{const elapsed=elapsedMs();setRecordSeconds(Math.floor(elapsed/1000));if(elapsed>=179_750)stopRecording();},250);
    return()=>{clearTimeout(limit);clearInterval(timer);};},[recordingState]);
  async function pause() {
    const value=latest.current,current=value?.session;
    if(!current||(recordingPhase.current!=='idle'&&!preparationAttempt.current)||sending.current)return;
    sessionUpdateVersion.current++;
    setBusy(true);const cancelled=cancelPreparation();
    latest.current={...value,session:{...current,state:'paused'}};setDto(latest.current);
    try{await cancelled;if(current.mode!=='choice')await saveDraft(latestAnswer.current,current.current_index,draftKey);apply(await transition('pause'));}
    catch(error){setError((error as Error).message);}finally{setBusy(false);}
  }
  async function revealHint() {setBusy(true);try{const result=await transition('hint');setHint(result.hint);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function end() {if(recordingState!=='idle'||sending.current||pendingAudio)return;const receiptOrigin=document.activeElement instanceof HTMLElement?document.activeElement.getBoundingClientRect():undefined;setBusy(true);try{await cancelPreparation();if(session.mode!=='choice')await saveDraft(latestAnswer.current,session.current_index,draftKey);const result=await transition('end');apply(result);setChoiceReview(null);if(['completed','ended'].includes(result.session.state))animateStudyReceipt(receiptOrigin);await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function finishRecordingTranscript(saved:Item,index:number,baseline:string) {
    const result=await post('/api/reports',{action:'transcribe',recordingId:saved.id,kind:'quiz'});
    if(!mounted.current||latest.current?.session.id!==id||latest.current?.session.current_index!==index)return;
    const updated={...saved,raw_transcript:result.rawTranscript,display_transcript:result.transcript,transcript_cleanup:{status:result.cleanupStatus,error:result.cleanupError},transcription_status:result.transcriptionStatus};
    setRecording(updated);
    if(result.cleanupStatus==='completed'&&typeof result.transcript==='string'&&latestAnswer.current===baseline&&!baseline.trim()){latestAnswer.current=result.transcript;setAnswer(result.transcript);}
    if(result.cleanupStatus!=='completed')setError(result.cleanupError||result.transcriptionError||'녹음은 저장했어요. 문장 정리를 다시 시도하거나 직접 입력해 주세요.');
  }
  async function retryRecordingTranscript() {
    if(!recording||recordingState!=='idle'||busy)return;const baseline=latestAnswer.current,index=session.current_index;setTranscriptProcessing(true);setRecordingState('uploading');setError('');
    const finishWork=trackRecordingWork();
    try{await finishRecordingTranscript(recording,index,baseline);}catch(e){if(mounted.current)setError((e as Error).message);}finally{if(mounted.current){setTranscriptProcessing(false);setRecordingState('idle');}finishWork();}
  }
  function useRecordingTranscript() {
    const current=latest.current?.session,audio=latestRecording.current;
    if(!transcriptReady||busy||sending.current||recordingPhase.current!=='idle'||pendingAudio||transcriptProcessing||current?.id!==id||current?.current_index!==session.current_index||audio?.id!==recording?.id||audio?.item_index!==current.current_index||audio?.transcript_cleanup?.status!=='completed'||typeof audio.display_transcript!=='string'||!audio.display_transcript.trim())return;
    setAnswer(audio.display_transcript);
  }
  async function uploadRecording(candidate:NonNullable<typeof pendingAudio>) {
    if(logoutSaving.current||suspendedForLogout.current)return;
    if(candidate.complete===false){setError('중단된 녹음이에요. 원본을 먼저 확인해 주세요. 이어서 저장하려면 복구 카드에서 확인해 주세요.');return;}
    if(candidate.durationMs>180_000){setError('화면이 멈춰 녹음이 3분을 넘었어요. 원본을 내려받은 뒤 다시 녹음해 주세요.');return;}
    const finishWork=trackRecordingWork(),baseline=latestAnswer.current;setRecordingState('uploading');setTranscriptProcessing(false);setError('');
    try{const form=new FormData();form.set('recording',candidate.blob,'answer.'+(candidate.blob.type.includes('mp4')?'mp4':candidate.blob.type.includes('ogg')?'ogg':'webm'));form.set('sessionId',id);form.set('itemIndex',String(candidate.index));form.set('consent','true');form.set('durationMs',String(candidate.durationMs));if(candidate.telemetry)form.set('speechTelemetry',JSON.stringify(candidate.telemetry));const saved=await sendRecording('/api/quiz',form);if(!saved.recording?.id)throw new Error('녹음 저장 확인을 받지 못했어요. 원본을 보관하고 다시 저장해 주세요.');if(candidate.recoveryKey)await removeRecordingRecovery(candidate.recoveryKey);pendingAudioRef.current=null;if(mounted.current){latestRecording.current=saved.recording;setRecording(saved.recording);setRecordingSaved(true);setRecordingNotice('');setPendingAudio(null);setTranscriptProcessing(true);await finishRecordingTranscript(saved.recording,candidate.index,baseline);}}catch(e){if(mounted.current)setError((e as Error).message);}finally{if(mounted.current){setRecordingState('idle');setTranscriptProcessing(false);}finishWork();}
  }
  function trackRecordingWork(){let finish!:()=>void;recordingWork.current=new Promise(resolve=>{finish=resolve;});return finish;}
  function finishRecordingMeasurement() {
    if(stoppedRecording.current)return stoppedRecording.current;
    liveCapture.current?.finish();
    const elapsed=speechCapture.current?.elapsedMs()??performance.now()-recordStart.current;
    const telemetry=speechCapture.current?.finish();speechCapture.current=null;
    stoppedRecording.current={durationMs:Math.max(1,Math.round(telemetry?.durationMs??elapsed)),telemetry:telemetry||undefined};
    return stoppedRecording.current;
  }
  function stopRecording() {
    if(!recorder.current||recorder.current.state==='inactive')return;
    // Final data/stop events may arrive much later than the user's stop request.
    finishRecordingMeasurement();recordingPhase.current='uploading';recorder.current.stop();if(mounted.current)setRecordingState('uploading');
  }
  function interruptRecording(reason:'background'|'microphone') {
    const lifecycle=recordingLifecycle.current;
    if(!lifecycle||lifecycle.interrupted||lifecycle.capture!==recorder.current||lifecycle.capture.state==='inactive'&&(recordingPhase.current!=='recording'||stoppedRecording.current))return;
    lifecycle.interrupted=true;lifecycle.needsMeasurement=reason==='microphone';if(mounted.current)setRecordingNotice(reason);
    liveCapture.current?.close();liveCapture.current=null;setLiveTranscript(value=>value?{...value,phase:'finished'}:null);
    if(lifecycle.capture.state==='inactive'){finishRecordingMeasurement();recordingPhase.current='uploading';if(mounted.current)setRecordingState('uploading');}else stopRecording();
    lifecycle.cleanup();stream.current?.getTracks().forEach(track=>track.stop());
  }
  function downloadPendingRecording() {
    if(!pendingAudio)return;
    const url=URL.createObjectURL(pendingAudio.blob),link=document.createElement('a');
    link.href=url;link.download='내-답변-녹음.'+(pendingAudio.blob.type.includes('mp4')?'mp4':pendingAudio.blob.type.includes('ogg')?'ogg':'webm');link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function retryPendingRecording() {
    const candidate=pendingAudioRef.current;
    if(logoutSaving.current||!candidate||pendingSaveLock.current||recordingPhase.current!=='idle')return;
    const current=()=>mounted.current&&latest.current?.session.id===id&&latest.current.session.current_index===candidate.index&&pendingAudioRef.current===candidate;
    if(!current())return;
    suspendedForLogout.current=false;
    pendingSaveLock.current=true;recordingPhase.current='uploading';setRecordingState('uploading');setError('');
    try{
      if(latest.current?.session.state!=='active'){const value=await transition('start');if(!current())return;apply(value);}
      if(!current())return;
      if(candidate.complete===false||candidate.needsMeasurement){
        const measured=await decodeRecordingTelemetry(candidate.blob);if(!current())return;
        if(!measured){setError('중단된 파일의 재생 시간을 확인하지 못했어요. 원본을 내려받아 보관하고 다시 녹음해 주세요.');return;}
        await uploadRecording({...candidate,complete:true,needsMeasurement:false,durationMs:measured.durationMs,telemetry:measured});
      }else await uploadRecording(candidate);
    }catch(error){if(current())setError((error as Error).message);}
    finally{pendingSaveLock.current=false;if(mounted.current&&latest.current?.session.id===id&&latest.current.session.current_index===candidate.index){recordingPhase.current='idle';setRecordingState('idle');}}
  }
  async function discardPendingRecording() {
    if(!pendingAudio||pendingSaveLock.current||recordingPhase.current!=='idle'||!window.confirm('저장하지 못한 녹음을 지울까요? 필요하면 먼저 원본을 내려받아 주세요.'))return;
    try{if(pendingAudio.recoveryKey)await removeRecordingRecovery(pendingAudio.recoveryKey);pendingAudioRef.current=null;setPendingAudio(null);setRecordingNotice('');setError('');try{localStorage.setItem(activityKey,JSON.stringify({itemIndex:session.current_index,updatedAt:new Date().toISOString(),hasDraft:!!latestAnswer.current.trim()||!!latestRecording.current}));}catch{}}catch{setError('기기에 보관된 녹음을 지우지 못했어요. 다시 시도해 주세요.');}
  }
  async function changeAnswerMode(text:boolean) {
    if(recordingState!=='idle'||pendingAudio)return;if(preparation!==null)await cancelPreparation();setPreparation(null);liveCapture.current?.close();liveCapture.current=null;setLiveTranscript(null);setTextAlternative(text);try{localStorage.setItem(draftKey+':text-mode',String(text));}catch{}
  }
  function isCurrentPreparation(attempt:RecordingPreparation) {
    const current=latest.current?.session;
    return preparationAttempt.current===attempt&&mounted.current&&attempt.generation===captureGeneration.current&&current?.id===id&&current.state==='active'&&current.current_index===attempt.index&&document.visibilityState!=='hidden';
  }
  async function releasePreparation(attempt:RecordingPreparation) {
    const device=attempt.device,writer=attempt.writer;attempt.device=null;attempt.writer=null;
    attempt.live?.close();if(liveCapture.current===attempt.live)liveCapture.current=null;attempt.live=null;
    device?.getTracks().forEach(track=>track.stop());
    if(writer)await writer.cancel();
  }
  async function record() {
    const current=latest.current?.session;
    if(logoutSaving.current||!consent||recordingPhase.current!=='idle'||!item||pendingAudioRef.current||preparationAttempt.current||current?.state!=='active'||document.visibilityState==='hidden')return;
    const attempt:RecordingPreparation={generation:captureGeneration.current,index:current.current_index,writer:null,device:null,live:null};preparationAttempt.current=attempt;
    setError('');setRecordingNotice('');setLiveTranscript(null);liveCapture.current?.close();liveCapture.current=null;setRecordingSaved(false);recordingPhase.current='uploading';setRecordingState('uploading');
    try {
      if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)throw new Error('이 브라우저에서는 녹음을 지원하지 않아요.');
      attempt.writer=await beginRecordingRecovery({studentId:current.student_id,sessionId:id,itemIndex:attempt.index,kind:'quiz'},'');
      if(!isCurrentPreparation(attempt)){if(preparationAttempt.current===attempt)await cancelPreparation();else await releasePreparation(attempt).catch(()=>{});return;}
      recoveryWriter.current=attempt.writer;
      attempt.device=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
      if(!isCurrentPreparation(attempt)){if(preparationAttempt.current===attempt)await cancelPreparation();else await releasePreparation(attempt).catch(()=>{});return;}
      stream.current=attempt.device;setMeterStream(attempt.device);
      const live=connectLiveTranscription(attempt.device,{sessionId:id,itemIndex:attempt.index,attemptId:crypto.randomUUID()},snapshot=>{
        if(mounted.current&&captureGeneration.current===attempt.generation&&latest.current?.session.id===id&&latest.current.session.current_index===attempt.index)setLiveTranscript(snapshot);
      });attempt.live=live;liveCapture.current=live;
      await live.ready;
      if(!isCurrentPreparation(attempt)){if(preparationAttempt.current===attempt)await cancelPreparation();else await releasePreparation(attempt).catch(()=>{});return;}
      recordingPhase.current='idle';setRecordingState('idle');
      if(skipPreparation)await beginRecord(attempt);else setPreparation(0);
    }catch(cause){if(preparationAttempt.current!==attempt)return;await cancelPreparation();if(mounted.current&&!preparationAttempt.current)setError((cause as Error).message);}
  }
  useEffect(()=>{
    if(preparation===null||preparation===0)return;
    const attempt=preparationAttempt.current;if(!attempt)return;
    const timer=setTimeout(()=>{
      if(!isCurrentPreparation(attempt)){if(preparationAttempt.current===attempt)void cancelPreparation();return;}
      preparationTimer.current=null;
      if(preparation>1)setPreparation(preparation-1);else{setPreparation(null);void beginRecord(attempt);}
    },1000);preparationTimer.current=timer;
    return()=>{clearTimeout(timer);if(preparationTimer.current===timer)preparationTimer.current=null;};
  },[preparation]);
  async function cancelPreparation() {
    if(preparationTimer.current!==null){clearTimeout(preparationTimer.current);preparationTimer.current=null;}
    const attempt=preparationAttempt.current;if(!attempt)return;
    // Invalidate synchronously, before a draft request, permission dialog or IDB wait can finish.
    preparationAttempt.current=null;const generation=++captureGeneration.current;
    if(stream.current===attempt.device)stream.current=null;
    if(recoveryWriter.current===attempt.writer)recoveryWriter.current=null;
    recordingPhase.current='uploading';if(mounted.current){setPreparation(null);setMeterStream(null);setRecordingState('uploading');}
    try{await releasePreparation(attempt);}catch{if(mounted.current&&generation===captureGeneration.current)setError('준비 중인 녹음을 정리하지 못했어요. 잠시 후 다시 시도해 주세요.');}
    finally{if(generation===captureGeneration.current){recordingPhase.current='idle';if(mounted.current)setRecordingState('idle');}}
  }
  async function beginRecord(attempt=preparationAttempt.current) {
    if(!attempt||!consent||recordingPhase.current!=='idle'||pendingAudioRef.current)return;
    if(!isCurrentPreparation(attempt)){if(preparationAttempt.current===attempt)await cancelPreparation();return;}
    recordingPhase.current='uploading';setRecordingState('uploading');const generation=attempt.generation;
    try {
      const writer=attempt.writer,device=attempt.device;if(!writer||!device)throw new Error('마이크를 다시 확인해 주세요.');
      await writer.assertActive();if(!isCurrentPreparation(attempt)){if(preparationAttempt.current===attempt)await cancelPreparation();return;}writer.assertFresh();
      stream.current=device;const mime=['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus'].find(type=>MediaRecorder.isTypeSupported(type));
      const capture=new MediaRecorder(device,mime?{mimeType:mime}:undefined),chunks:Blob[]=[];recorder.current=capture;const index=session.current_index;
      const interrupted=()=>{if(recordingLifecycle.current===lifecycle){interruptRecording('microphone');pauseOnExit(false);}};
      const tracks=device.getAudioTracks?.()||device.getTracks();
      const lifecycle={capture,interrupted:false,needsMeasurement:false,cleanup:()=>{for(const track of tracks){track.removeEventListener?.('mute',interrupted);track.removeEventListener?.('ended',interrupted);}}};recordingLifecycle.current=lifecycle;
      for(const track of tracks){track.addEventListener?.('mute',interrupted);track.addEventListener?.('ended',interrupted);}
      capture.onerror=interrupted;
      speechCapture.current?.dispose();speechCapture.current=null;stoppedRecording.current=null;
      recordingFinished.current=new Promise(resolve=>{resolveRecordingFinished.current=resolve;});
      capture.onstart=()=>{if(stoppedRecording.current||lifecycle.interrupted)return;recordStart.current=performance.now();speechCapture.current=startSpeechCapture(device);};
      capture.onpause=()=>speechCapture.current?.pause();capture.onresume=()=>speechCapture.current?.resume();
      capture.ondataavailable=event=>{if(event.data.size){chunks.push(event.data);try{localStorage.setItem(activityKey,JSON.stringify({itemIndex:index,updatedAt:new Date().toISOString(),hasDraft:true,hasRecording:true}));}catch{}void writer.append(event.data,stoppedRecording.current?.durationMs??speechCapture.current?.elapsedMs()??performance.now()-recordStart.current).catch(()=>{if(mounted.current)setError('기기 임시 저장이 멈췄어요. 녹음을 마친 뒤 원본을 내려받아 주세요.');});}};
      capture.onstop=async()=>{
        if(!stoppedRecording.current){lifecycle.interrupted=true;lifecycle.needsMeasurement=true;if(mounted.current)setRecordingNotice('microphone');liveCapture.current?.close();liveCapture.current=null;pauseOnExit(false);}
        lifecycle.cleanup();if(recordingLifecycle.current===lifecycle)recordingLifecycle.current=null;const measurement=finishRecordingMeasurement();device.getTracks().forEach(t=>t.stop());const blob=new Blob(chunks,{type:capture.mimeType});
        let candidate:NonNullable<typeof pendingAudio>={blob,...measurement,index,complete:true,needsMeasurement:lifecycle.needsMeasurement,recoveryKey:writer.key};
        try{const durable=await writer.finish({...measurement,needsMeasurement:lifecycle.needsMeasurement});candidate={...candidate,recoveryKey:durable.key};}catch{if(mounted.current)setError('기기에 보관하지 못했어요. 이동하기 전에 원본을 내려받아 주세요.');}
        pendingAudioRef.current=candidate;resolveRecordingFinished.current?.();resolveRecordingFinished.current=null;
        if(!mounted.current||generation!==captureGeneration.current)return;recordingPhase.current='idle';setMeterStream(null);setPendingAudio(candidate);setRecordingState('idle');if(!savePendingLocal.current&&!lifecycle.interrupted&&document.visibilityState!=='hidden')await uploadRecording(candidate);
      };recordStart.current=performance.now();setRecordSeconds(0);capture.start(250);attempt.live?.start();preparationAttempt.current=null;recordingPhase.current='recording';setMeterStream(device);setRecordingState('recording');setSkipPreparation(true);try{localStorage.setItem('gakja-recording-ready-seen:'+data.user.id,'true');}catch{}
    }catch(e){if(preparationAttempt.current!==attempt)return;speechCapture.current?.dispose();speechCapture.current=null;await cancelPreparation();if(mounted.current&&!preparationAttempt.current)setError((e as Error).message);}
  }
  if(!dto)return <div className={ownedClassName("quiz-v3",true)}>{error?<Alert>{error}</Alert>:<Spinner/>}</div>;
  const voiceFirst=session.mode==='oral'&&!textAlternative;
  const answerEditor=<div className={ownedClassName(styles.answerEditorBody,true)}><label htmlFor={'quiz-answer-'+id} className={ownedClassName(undefined,true)}>{voiceFirst?(recording?'말한 답변을 확인하고 다듬어 보세요.':'필요하면 말할 내용을 짧게 메모해 두세요.'):'내 답변'}</label>
    <textarea id={'quiz-answer-'+id} aria-label="내 답변" value={answer} maxLength={10_000} onChange={e=>{answerScope.current=draftKey;latestAnswer.current=e.target.value;setAnswer(e.target.value);}} onKeyDown={event=>{sendOnEnter(event,!voiceFirst&&data.preferences?.enterToSend!==false,()=>submit(null),{composing:answerComposing.current,keyboardDisabled:voiceFirst,blocked:busy||session.state!=='active'||recordingState!=='idle'||!!pendingAudio||preparation!==null||(!answer.trim()&&!recording)});}} onBlur={event=>resetEnterSequence(event.currentTarget)} onCompositionStart={()=>{answerComposing.current=true;}} onCompositionEnd={()=>{answerComposing.current=false;}} placeholder={voiceFirst?'말할 내용이나 다시 생각할 점을 적어보세요.':'내 답을 적어보세요.'} disabled={busy||recordingState==='uploading'} className={ownedClassName(undefined,true)}/>
  </div>;
  const recordingControls=<div className={ownedClassName('quiz-record '+styles.recordingAction,true)}>{preparation!==null&&<section className={ownedClassName(styles.recordingPreparation,true)} aria-label="녹음 준비"><strong aria-live="polite" className={ownedClassName(undefined,true)}>{preparation===0?'마이크를 확인해 주세요.':`${preparation}초 뒤 녹음을 시작해요.`}</strong><p className={ownedClassName(undefined,true)}><AudioLevelDot stream={meterStream} phase="recording"/>말해 보며 음량을 확인해 주세요. 아직 답변을 녹음하거나 전사하지 않아요. 시작하면 말하는 내용이 실시간으로 보여요.</p><div className={ownedClassName(undefined,true)}>{preparation===0&&<button className={ownedClassName("button primary",true)} onClick={()=>setPreparation(3)}>준비됐어요 · 3초 뒤 시작</button>}<button className={ownedClassName("button secondary",true)} onClick={()=>{setPreparation(null);void beginRecord();}}>지금 시작</button><button className={ownedClassName("text-link",true)} onClick={cancelPreparation}>취소</button></div><label className={ownedClassName(undefined,true)}><input type="checkbox" checked={skipPreparation} onChange={event=>{setSkipPreparation(event.target.checked);try{localStorage.setItem('gakja-recording-skip-ready:'+data.user.id,String(event.target.checked));}catch{}}} className={ownedClassName(undefined,true)}/>다음부터 준비 단계 건너뛰기</label></section>}<label className={ownedClassName("quiz-record-consent",true)}><input type="checkbox" checked={consent} disabled={recordingState!=='idle'} onChange={e=>{setConsent(e.target.checked);if(!e.target.checked&&preparation!==null)void cancelPreparation();}} className={ownedClassName(undefined,true)}/>마이크 사용·OpenAI 실시간 전사·비공개 녹음 저장에 동의해요.</label><div className={ownedClassName("quiz-record-controls",true)}>{recordingState==='recording'?<button className={ownedClassName("button quiz-record-stop",true)} onClick={stopRecording}><AudioLevelDot stream={meterStream} phase="recording"/>녹음 완료 · {recordSeconds}초</button>:<button className={ownedClassName('button '+(voiceFirst?'primary '+styles.recordStart:'ghost'),true)} disabled={!consent||busy||recordingState==='uploading'||!!pendingAudio||preparation!==null||recoveryWaiting} onClick={record}>{recordingState==='uploading'?<AudioLevelDot stream={null} phase="uploading"/>:recording?<RotateCcw size={17}/>:<AudioLevelDot stream={null} phase="idle"/>} {recordingState==='uploading'?(preparationAttempt.current?'마이크·전사 준비 중':transcriptProcessing?'문장 정리 중':'녹음 저장 중'):recording?'다시 녹음':'답변 녹음'}</button>}{recordingSaved&&recordingState==='idle'&&<span className={ownedClassName("quiz-record-saved",true)} role="status"><AudioLevelDot stream={null} phase="saved"/>녹음 저장됨</span>}{recording&&recordingState==='idle'&&<audio controls preload="metadata" src={recording.url} className={ownedClassName(undefined,true)}/>}</div>{liveTranscript&&preparation===null&&<section className={ownedClassName(styles.liveTranscript,true)} aria-label="실시간 전사 미리보기" data-phase={liveTranscript.phase}><div className={ownedClassName(undefined,true)}><strong className={ownedClassName(undefined,true)}>{liveTranscript.phase==='connecting'?'실시간 전사 연결 중':liveTranscript.phase==='unavailable'?'저장 후 전사로 이어갈게요':liveTranscript.phase==='listening'?'말하는 내용을 듣고 있어요':liveTranscript.phase==='finishing'?'마지막 말을 옮기고 있어요':'실시간 전사 미리보기'}</strong><span className={ownedClassName(undefined,true)}>미리보기</span></div>{liveTranscript.text?<p ref={liveCaptionBody} aria-live="off" tabIndex={0} aria-label="실시간으로 전사된 내용" className={ownedClassName(undefined,true)}>{liveTranscript.text}</p>:<p className={ownedClassName(undefined,true)}>{liveTranscript.phase==='unavailable'?'녹음은 계속할 수 있어요. 저장한 뒤 전체 음성으로 전사해요.':'녹음을 시작하고 말하면 여기에 글이 나타나요.'}</p>}<small className={ownedClassName(undefined,true)}>미리보기는 답변에 자동으로 입력되지 않아요. 녹음 저장 후 전사를 확인하고 수정해 주세요.</small></section>}{transcriptProcessing&&<p className={ownedClassName("transcript-processing",true)} role="status">녹음을 글로 옮기고 문장을 정리하고 있어요.</p>}{recording?.raw_transcript&&<details className={ownedClassName("transcript-raw",true)}><summary className={ownedClassName(undefined,true)}>원전사 보기</summary><p className={ownedClassName(undefined,true)}>{recording.raw_transcript}</p></details>}{recording&&recordingState==='idle'&&recording.transcript_cleanup?.status!=='completed'&&<button className={ownedClassName("button ghost small",true)} disabled={busy} onClick={retryRecordingTranscript}>{recording.raw_transcript?'문장 정리 다시 시도':'전사 다시 시도'}</button>}{transcriptReady&&answer!==recording?.display_transcript&&<button className={ownedClassName("text-link",true)} disabled={busy||recordingState!=='idle'||!!pendingAudio||transcriptProcessing} onClick={useRecordingTranscript}>정리된 전사 사용</button>}</div>;
  const circumference=2*Math.PI*26;
  const responses:Item[]=dto.responses||[],correctCount=responses.filter(r=>r.outcome===true).length,ungradedCount=responses.filter(r=>r.outcome===null).length;
  const needsReview=quizResponseNeedsReview;
  const reviewResponses=responses.filter(needsReview),savedResponses=responses.filter(response=>!needsReview(response));
  const recordedCount=responses.filter(response=>dto.recordings?.some((audio:Item)=>audio.id===response.data?.recording_id)).length;
  const renderResult=(response:Item,inReview=false)=>{
    const savedItem=session.items[response.item_index]||{id:response.memory_item_id,prompt:response.data?.prompt,question_id:response.data?.question_id,activity_ids:response.data?.activity_ids};
    const sources:Item[]=response.data?.source_quotes||[],originalMemory=sessionLearning?.memory_items?.find((memory:Item)=>memory.id===savedItem.id);
    const sourceQuestion=sessionLearning?.questions?.find((question:Item)=>question.id===savedItem.question_id||(savedItem.practice_kind==='concept'&&question.id===originalMemory?.question_id&&question.question_types?.includes('concept')&&question.prompt===savedItem.practice_prompt));
    const audio=dto.recordings?.find((record:Item)=>record.id===response.data?.recording_id);
    const outcome=response.outcome===true?'correct':needsReview(response)?'review':'saved';
    const status=response.data?.response_mode==='text'&&response.data?.original_mode==='oral'?'글 답변 · 미채점':response.timed_out?'시간 초과':response.outcome===true?'정답':response.outcome===false?'다시 확인':needsReview(response)?'다시 준비 · 미채점':'답변 저장 · 미채점';
    return <article className={ownedClassName("quiz-result-answer",true)} key={response.id} data-result={outcome} aria-labelledby={'quiz-result-'+response.id}>
      <header className={ownedClassName("quiz-result-answer-heading",true)}><span className={ownedClassName("quiz-result-index",true)} aria-label={`${response.item_index+1}번 문항`}>{String(response.item_index+1).padStart(2,'0')}</span><h3 id={'quiz-result-'+response.id} className={ownedClassName(undefined,true)}>{savedItem.prompt||response.data?.prompt}</h3><span className={ownedClassName('quiz-result-status '+outcome,true)}>{status}</span></header>
      <dl className={ownedClassName("quiz-result-answer-content",true)}>
        {session.mode==='choice'&&<div className={ownedClassName(undefined,true)}><dt className={ownedClassName(undefined,true)}>내 선택</dt><dd className={ownedClassName(undefined,true)}>{savedItem.options?.find((option:Item)=>option.id===response.selected_option_id)?.text||'선택하지 않음'}</dd></div>}
        {!!response.response&&<div className={ownedClassName(undefined,true)}><dt className={ownedClassName(undefined,true)}>내 답변</dt><dd className={ownedClassName(undefined,true)}>{response.response}</dd></div>}
        {!!response.data?.correct_answer&&response.outcome!==true&&<div className={ownedClassName("quiz-result-correction",true)}><dt className={ownedClassName(undefined,true)}>검수된 정답</dt><dd className={ownedClassName(undefined,true)}>{response.data.correct_answer}</dd></div>}
      </dl>
      {audio&&<div className={ownedClassName("quiz-result-audio",true)}><span className={ownedClassName(undefined,true)}><Mic size={15} aria-hidden="true"/>저장한 녹음</span><audio controls preload="metadata" aria-label={`${response.item_index+1}번 답변 녹음`} src={audio.url} className={ownedClassName(undefined,true)}/></div>}
      {quizAssistanceLabel(response)&&<p className={ownedClassName("quiz-result-assistance",true)}>{quizAssistanceLabel(response)}</p>}
      {(response.data?.model_answer||sources.length>0)&&<div className={ownedClassName("quiz-result-reference",true)}>
        {response.data?.model_answer&&<details className={ownedClassName(undefined,true)}><summary className={ownedClassName(undefined,true)}>{savedItem.kind==='choice'?'검수된 개념 설명':'모범답안과 비교'}</summary><p className={ownedClassName(undefined,true)}>{response.data.model_answer}</p></details>}
        {sources.length>0&&<details open={inReview||undefined} className={ownedClassName(undefined,true)}><summary className={ownedClassName(undefined,true)}>{response.outcome===false?'정답 근거 확인':'저장 당시 근거 보기'}</summary>{sources.map((source:Item,index:number)=><blockquote key={source.id||index} className={ownedClassName(undefined,true)}><p className={ownedClassName(undefined,true)}>{source.text}</p><cite className={ownedClassName(undefined,true)}>{source.area||'발행 자료'}{source.page?` · ${source.page}쪽`:''}</cite></blockquote>)}</details>}
      </div>}
      {!sources.length&&dto.originalSourceUnavailable&&<p className={ownedClassName("quiz-note quiz-result-source-note",true)}>저장 당시 근거를 불러올 수 없어요. 질문과 답변은 보존되어 있어요.</p>}
      {!inReview&&(needsReview(response)||sourceQuestion)&&<div className={ownedClassName("quiz-result-answer-actions",true)}>
        {needsReview(response)&&<><Link href={repeatLink({...savedItem,id:response.memory_item_id||savedItem.id},session)}>다시 연습<RotateCcw size={14}/></Link><Link href={knowledgeLink({...savedItem,target_id:savedItem.target_id||session.metadata?.targetId})}>관련 자료<ArrowUpRight size={14}/></Link></>}
        {sourceQuestion&&<button className={ownedClassName("text-link",true)} onClick={()=>openResource({kind:'question',id:sourceQuestion.id,snapshot:{learning:sessionLearning,documents:[]}})}>질문과 원문<ArrowUpRight size={14}/></button>}
      </div>}
    </article>;
  };
  return <div className={ownedClassName('quiz-v3 quiz-session '+(!done||choiceReview?styles.sessionWorkspace:''),true)} data-quiz-mode={session.mode} data-quiz-state={choiceReview?'review':session.state}><Breadcrumb items={[{label:'퀴즈',href:'/quiz'},{label:sessionName}]}/><PageTitle title={sessionName} aside={!done?<button className={ownedClassName("text-link",true)} disabled={busy||recordingState!=='idle'||!!pendingAudio} onClick={end}>여기까지 저장<X size={17}/></button>:undefined}/>{error&&<Alert>{error}</Alert>}
    {recordingNotice&&<p role="status" className={ownedClassName(styles.recordingNotice,true)}>{recordingNotice==='background'?'화면을 벗어나 녹음을 멈췄어요.':'마이크 연결이 중단되어 녹음을 멈췄어요.'} {recordingState==='uploading'?'마지막 음성을 기기에 보관하고 있어요.':'말한 내용을 확인한 뒤 같은 질문에서 저장해 주세요. 자동으로 다시 녹음하지 않아요.'}</p>}
    {recoveryWaiting&&<p role="status" className={ownedClassName(styles.recordingNotice,true)}>다른 탭에서 이 질문을 녹음 중이거나, 중단된 녹음을 확인하고 있어요. 다른 탭의 녹음을 마쳐 주세요. 연결이 풀리면 이 화면에서 자동으로 복구해요.</p>}
    {pendingAudio&&recordingState==='idle'&&<section className={ownedClassName(styles.pendingRecording,true)} aria-label="아직 보내지 않은 음성 복구"><strong className={ownedClassName(undefined,true)}>{pendingAudio.complete===false?'중단된 녹음이 이 기기에 남아 있어요.':'녹음이 아직 저장되지 않았어요.'}</strong><span className={ownedClassName(undefined,true)}>같은 학생·같은 문항의 원본이에요. 서버 저장 확인 전까지 이 기기에서 7일 내에 복구할 수 있어요.</span>{pendingAudioUrl&&<audio controls preload="metadata" src={pendingAudioUrl} aria-label="보내지 않은 녹음 미리 듣기" className={ownedClassName(undefined,true)}/>}<div className={ownedClassName(undefined,true)}>{(pendingAudio.durationMs<=180_000||pendingAudio.complete===false||pendingAudio.needsMeasurement)&&<button className={ownedClassName("text-link",true)} onClick={retryPendingRecording}>녹음 다시 저장</button>}<button className={ownedClassName("text-link",true)} onClick={downloadPendingRecording}>원본 내려받기</button><button className={ownedClassName("text-link",true)} onClick={discardPendingRecording}>저장 안 된 녹음 지우기</button></div></section>}
    {changedSessionTarget&&<p className={ownedClassName("quiz-note",true)}>{sessionTarget.university} · {sessionTarget.department||sessionTarget.major}에서 준비한 기록이에요. 질문과 답변은 당시 기준으로 유지돼요.</p>}
    {choiceReview?<section className={ownedClassName('quiz-result-screen '+styles.choiceReview,true)} aria-label="선택형 답변 확인"><div className={ownedClassName(styles.reviewHeading,true)}><h2 ref={questionHeading} tabIndex={-1} aria-live="polite" className={ownedClassName(undefined,true)}>{choiceReview.outcome===true?'맞았어요.':'정답을 확인해 보세요.'}</h2><span className={ownedClassName(undefined,true)}>{choiceReview.item_index+1} / {session.items.length}문항</span></div>{renderResult(choiceReview,true)}<div className={ownedClassName(styles.reviewNext,true)}><p className={ownedClassName(undefined,true)}>답변은 저장됐어요. 충분히 확인한 뒤 넘어가세요.</p><ActionButton className={ownedClassName("button primary")} disabled={busy} pending={busy} pendingLabel="다음 문제 준비 중" onClick={nextChoice}>{done?'결과 보기':'다음 문제'}<ChevronRight size={17}/></ActionButton></div></section>:done?<section className={ownedClassName("quiz-result-screen",true)} aria-labelledby="quiz-result-title">
      <header className={ownedClassName("quiz-result-overview",true)}><div className={ownedClassName("quiz-result-completion",true)}><Check size={21} strokeWidth={1.8} aria-hidden="true"/><span className={ownedClassName(undefined,true)}>{session.state==='completed'?'답변 저장':'여기까지 저장'}</span></div><h2 id="quiz-result-title" className={ownedClassName(styles.resultTitle,true)} ref={questionHeading} tabIndex={-1}>{responses.length?`${responses.length}문항의 답을 남겼어요.`:'다음에 다시 준비해요.'}</h2>
        <dl className={ownedClassName("quiz-result-stats",true)}><div className={ownedClassName(undefined,true)}><dt className={ownedClassName(undefined,true)}>답변한 문항</dt><dd className={ownedClassName("quiz-result-count",true)}>{responses.length}<small className={ownedClassName(undefined,true)}> / {session.items.length}</small><span className={ownedClassName("quiz-result-stat-track",true)} aria-hidden="true"><i style={{width:`${session.items.length?Math.min(100,responses.length/session.items.length*100):0}%`}} className={ownedClassName(undefined,true)}/></span></dd></div>
          <div data-tone={session.mode==='oral'||(session.mode!=='choice'&&!correctCount&&!responses.some(response=>response.outcome===false))?'saved':'correct'} className={ownedClassName(undefined,true)}><dt className={ownedClassName(undefined,true)}>{session.mode==='oral'?'저장한 녹음':session.mode!=='choice'&&!correctCount&&!responses.some(response=>response.outcome===false)?'미채점 저장':'확인한 정답'}</dt><dd className={ownedClassName(undefined,true)}>{session.mode==='oral'?recordedCount:session.mode!=='choice'&&!correctCount&&!responses.some(response=>response.outcome===false)?ungradedCount:correctCount}<small className={ownedClassName(undefined,true)}>{session.mode==='oral'?'개':'문항'}</small></dd></div>
          <div data-tone="review" className={ownedClassName(undefined,true)}><dt className={ownedClassName(undefined,true)}>다시 볼 답변</dt><dd className={ownedClassName(undefined,true)}>{reviewResponses.length}<small className={ownedClassName(undefined,true)}>문항</small></dd></div>
        </dl>
      </header>
      {nextItem&&<section className={ownedClassName("quiz-result-next",true)} aria-labelledby="quiz-result-next-title"><div className={ownedClassName(undefined,true)}><span className={ownedClassName("quiz-result-eyebrow",true)}>{practiceItem?'다음은 면접에서':'다음 복습'}</span><h3 id="quiz-result-next-title" data-question-key={practiceItem&&nextQuestion?.prompt===nextItem.prompt?practiceItem.question_id:undefined} className={ownedClassName(undefined,true)}>{nextItem.prompt}</h3>{!practiceItem&&<p className={ownedClassName("quiz-note",true)}>{changedTarget?'지원 정보가 바뀌었어요. 이 답변은 당시 학교·학과의 기록으로 남아 있어요.':'현재 자료에 같은 면접 질문이 없어요. 아래에서 저장한 답변을 확인할 수 있어요.'}</p>}</div>
        {practiceItem?<Link className={ownedClassName("button primary")} href={practiceLink(practiceItem,session.content_version)+'&quizSessionId='+id}>{appliedActivity?'이 활동 면접에 적용':'면접에서 말하기'}<ChevronRight size={17}/></Link>:<Link className={ownedClassName("button primary")} href={repeatLink(nextItem,session)}>복습 항목 확인<ChevronRight size={17}/></Link>}
        <div className={ownedClassName("quiz-result-next-links",true)}>{['uncertain','needs_confirmation'].includes(responses.find(quizResponseNeedsReview)?.data?.recall_state||'')&&<Link href={'/my/today?'+new URLSearchParams({questionId:nextItem.question_id||'',targetId:nextItem.target_id||session.metadata?.targetId||'',sourceType:nextItem.source_kind==='common'?'common':'personal',sourceVersion:String(nextItem.source_kind==='common'?nextItem.common_revision||1:session.content_version)}).toString()+'#today-record'}>기억이 불확실한 부분 확인<ArrowUpRight size={14}/></Link>}<Link href={knowledgeLink(contextItem||nextItem)}>관련 자료<ArrowUpRight size={14}/></Link><Link href={repeatLink(nextItem,{...session,mode:'answer'})}>내 말로 다시 설명<ArrowUpRight size={14}/></Link></div>
      </section>}
      {!!responses.length&&<section className={ownedClassName("quiz-result-review",true)} aria-labelledby="quiz-result-review-title"><div className={ownedClassName("quiz-result-section-title",true)}><h2 id="quiz-result-review-title" className={ownedClassName(undefined,true)}>답변 돌아보기</h2><span className={ownedClassName(undefined,true)}>{responses.length}문항</span></div>
        {!!reviewResponses.length&&<section className={ownedClassName("quiz-result-group",true)} aria-labelledby="quiz-result-review-group"><h3 id="quiz-result-review-group" className={ownedClassName("quiz-result-group-title",true)}>다시 볼 답변 <span className={ownedClassName(undefined,true)}>{reviewResponses.length}</span></h3>{reviewResponses.map(response=>renderResult(response))}</section>}
        {!!savedResponses.length&&(reviewResponses.length?<details className={ownedClassName("quiz-result-saved-group",true)}><summary className={ownedClassName(undefined,true)}>저장한 답변 <span className={ownedClassName(undefined,true)}>{savedResponses.length}</span><ChevronRight size={16} aria-hidden="true"/></summary><div className={ownedClassName(undefined,true)}>{savedResponses.map(response=>renderResult(response))}</div></details>:<div className={ownedClassName("quiz-result-group",true)}>{savedResponses.map(response=>renderResult(response))}</div>)}
      </section>}
      <footer className={ownedClassName("quiz-result-footer",true)}><Link className={ownedClassName("text-link")} href="/quiz">퀴즈 목록<ChevronRight size={16}/></Link><Link className={ownedClassName("text-link")} href="/reports">내 리포트<ArrowUpRight size={16}/></Link></footer>
    </section>:
    <><div className={ownedClassName("quiz-progress",true)} aria-label={`${session.current_index}개 답변, 전체 ${session.items.length}개`}>{session.items.map((m:Item,index:number)=><i key={m.id} className={ownedClassName(index<session.current_index?'answered':index===session.current_index?'current':'',true)}/>)}</div>
    {session.state!=='active'?<section className={ownedClassName("quiz-ready",true)}><div className={ownedClassName("quiz-ready-numbers",true)}><span className={ownedClassName(undefined,true)}><strong className={ownedClassName(undefined,true)}>{session.items.length}</strong>문항</span>{session.mode==='choice'&&<span className={ownedClassName(undefined,true)}><strong className={ownedClassName(undefined,true)}>{session.timed===false?'∞':'10'}</strong>{session.timed===false?'시간 제한 없음':'초 / 문항'}</span>}</div>{countdown!==null?<strong className={ownedClassName("quiz-countdown",true)} aria-live="polite">{countdown}</strong>:<><h2 className={ownedClassName(undefined,true)}>{session.state==='paused'?'잠깐 쉬어가요.':session.current_index>0?'다음 질문을 시작할까요?':'준비됐나요?'}</h2><ActionButton className={ownedClassName("button primary large")} disabled={busy} pending={busy} pendingLabel="퀴즈 준비 중" onClick={start}><Play size={18}/>{session.state==='paused'?'이어서 풀기':'퀴즈 시작'}</ActionButton></>}</section>:
    <section className={ownedClassName('quiz-question '+(feedback?'quiz-feedback':''),true)}><div className={ownedClassName("quiz-question-meta",true)}><span className={ownedClassName("quiz-number",true)}>{String(session.current_index+1).padStart(2,'0')}<small className={ownedClassName(undefined,true)}> / {String(session.items.length).padStart(2,'0')}</small></span><div className={ownedClassName("quiz-question-actions",true)}><button className={ownedClassName("icon-button",true)} aria-label="일시정지" disabled={busy||recordingState!=='idle'&&!preparationAttempt.current} onClick={pause}><CirclePause size={23}/></button>{session.mode==='choice'&&session.timed!==false&&<div className={ownedClassName('quiz-clock '+(left<=3?'urgent':''),true)} role="timer" aria-label={`남은 시간 ${Math.ceil(left)}초`}><svg width="64" height="64" viewBox="0 0 60 60" className={ownedClassName(undefined,true)}><circle cx="30" cy="30" r="26" fill="none" strokeWidth="3" className={ownedClassName(undefined,true)}/><circle className={ownedClassName("quiz-clock-line",true)} cx="30" cy="30" r="26" fill="none" strokeWidth="3" strokeDasharray={circumference} strokeDashoffset={circumference*(1-left/10)}/></svg><strong className={ownedClassName(undefined,true)}>{Math.ceil(left)}</strong></div>}</div></div>
    <h2 className={ownedClassName("quiz-prompt",true)} ref={questionHeading} tabIndex={-1} data-question-key={item?.question_id}>{item?.prompt}</h2>
    {session.mode==='choice'?<><div className={ownedClassName("quiz-options",true)}>{item.options.map((option:Item,index:number)=><button key={option.id} className={ownedClassName(selected===option.id?'selected':'',true)} data-outcome={selected===option.id&&feedback?(feedback.outcome===true?'correct':feedback.outcome===false?'incorrect':undefined):undefined} aria-pressed={selected===option.id} disabled={busy} onClick={()=>submit(option.id)}><span className={ownedClassName(undefined,true)}>{index+1}</span><strong className={ownedClassName(undefined,true)}>{option.text}</strong>{selected===option.id&&feedback?.outcome===true&&<Check className={ownedClassName("quiz-outcome-check")} size={22} aria-hidden="true"/>}</button>)}</div><div className={ownedClassName("quiz-choice-footer",true)}><span aria-live="polite" className={ownedClassName(undefined,true)}>{feedback?feedback.timed_out?'시간 초과':feedback.outcome?'맞았어요.':'다시 떠올려보세요.':busy?'저장 중':'보기 선택'}</span><span className={ownedClassName(undefined,true)}>키보드 1–4</span></div>{error&&left<=0&&<button className={ownedClassName("button ghost",true)} disabled={busy} onClick={()=>submit(null,true)}>시간 초과 기록 다시 저장</button>}</>:
    <div className={ownedClassName("quiz-answer-workspace",true)}>
    {session.mode==='oral'&&<div className={ownedClassName(styles.answerMode,true)} role="group" aria-label="답변 방식">
      <button type="button" aria-pressed={!textAlternative} disabled={busy||recordingState!=='idle'||!!pendingAudio} onClick={()=>{if(textAlternative)void changeAnswerMode(false);}} className={ownedClassName(undefined,true)}><Mic size={16} aria-hidden="true"/>말로 답하기</button>
      <button type="button" aria-pressed={textAlternative} disabled={busy||recordingState!=='idle'||!!pendingAudio} onClick={()=>{if(!textAlternative)void changeAnswerMode(true);}} className={ownedClassName(undefined,true)}><Type size={16} aria-hidden="true"/>글로 답하기</button>
      <p className={ownedClassName(undefined,true)}>{textAlternative?'같은 질문에 글로 답해요. 음성 녹음·말하기 분석으로 기록하지 않아요.':'동의하고 마이크를 확인한 뒤, 내 목소리로 답해보세요.'}</p>
    </div>}
    {voiceFirst&&recordingControls}
    {voiceFirst?<details className={ownedClassName(styles.answerEditor,true)} key={draftKey} open={Boolean(recording||answer.trim())}><summary className={ownedClassName(undefined,true)}>{recording?'전사 확인 · 답변 다듬기':'말할 내용 메모 · 선택'}</summary>{answerEditor}</details>:answerEditor}
    <p className={ownedClassName(styles.draftStatus,true)} data-status={draftStatus} role="status">{draftStatus==='failed'?<>초안 저장 미확인 <button className={ownedClassName("text-link",true)} disabled={busy} onClick={()=>void saveDraft(answer,session.current_index,draftKey).catch(()=>{})}>다시 저장</button></>:draftStatus==='saving'?'초안 저장 중':draftStatus==='saved'?'자동 저장됨':''}</p>
    <details className={ownedClassName(styles.practiceTools,true)} key={draftKey+':tools'}><summary className={ownedClassName(undefined,true)}>답변이 막혀요 · 힌트와 도움</summary>
      <LearningHelp questionId={item?.question_id} activityId={item?.activity_ids?.[0]} targetId={item?.target_id||session.metadata?.targetId} quizSessionId={id} itemIndex={session.current_index} sourceType={item?.source_kind==='common'?'common':'personal'} sourceVersion={item?.source_kind==='common'?item.common_revision:session.content_version||undefined}/>
      <div className={ownedClassName("quiz-hint",true)}>{hint?<><span className={ownedClassName(undefined,true)}>{item?.kind==='choice'?'검수된 개념 힌트':'모범답안 힌트'}</span><p className={ownedClassName(undefined,true)}><span className={ownedClassName("quiz-hint-first",true)}>{hint.first}</span>{hint.rest&&<span className={ownedClassName("quiz-blurred",true)} aria-hidden="true">{' '+hint.rest}</span>}</p></>:item.hasHint?<button className={ownedClassName("text-link",true)} disabled={busy} onClick={revealHint}>{item?.kind==='choice'?'검수된 개념 힌트':'모범답안 힌트'}<ChevronRight size={17}/></button>:<span className={ownedClassName("muted",true)}>발행된 모범답안이 없어요.</span>}</div>
      <PracticeWritingHelp maxLength={10_000} key={id+':'+session.current_index} draftKey={`gakja-writing:${data.user.id}:${id}:${session.current_index}`} value={answer} rawTranscript={recording?.raw_transcript||undefined} disabled={busy||recordingState!=='idle'||!!pendingAudio} onApply={setAnswer} onAssisted={async()=>{apply(await transition('assist',{helpKind:'writing',requestId:crypto.randomUUID()}));}} evidence={(item.source_quotes||[]).map((source:Item)=>source.text).filter(Boolean)}/>
    </details>
    {!voiceFirst&&!textAlternative&&recordingControls}
    <details className={ownedClassName(styles.selfReview,true)} key={draftKey+':review'}><summary className={ownedClassName(undefined,true)}>답변 돌아보기 · 선택</summary>
      <fieldset className={ownedClassName(styles.recallState,true)} disabled={busy}><legend className={ownedClassName(undefined,true)}>답변을 돌아보면</legend><div className={ownedClassName(styles.recallOptions,true)}>{([['remembered','내 말로 설명했어요'],['uncertain','기억이 불확실해요'],['needs_confirmation','사실 확인이 필요해요']] as const).map(([value,label])=><label key={value} className={ownedClassName(undefined,true)}><input type="radio" name={'recall-'+id+'-'+session.current_index} value={value} checked={recallStatus===value} onChange={()=>setRecallStatus(value)} className={ownedClassName(undefined,true)}/>{label}</label>)}</div></fieldset>
    {recallStatus==='needs_confirmation'&&<Link className={ownedClassName("text-link")} href={'/account/confirmations'+(item?.activity_ids?.[0]?'?activityId='+encodeURIComponent(item.activity_ids[0]):'')}>활동 사실 확인<ArrowUpRight size={14}/></Link>}
    </details>
    <div className={ownedClassName("quiz-submit-actions",true)}><ActionButton className={ownedClassName("button ghost")} disabled={busy||recordingState!=='idle'||!!pendingAudio||preparation!==null||(!answer.trim()&&!recording)} pending={busy&&sending.current&&submissionAction==='again'} pendingLabel="복습으로 남기는 중" onClick={()=>{setRecallStatus('uncertain');void submit(null,false,'again','uncertain');}}>다시 준비</ActionButton><ActionButton className={ownedClassName("button primary")} disabled={busy||recordingState!=='idle'||!!pendingAudio||preparation!==null||(session.mode==='oral'&&!textAlternative?!recording:textAlternative?!answer.trim():!answer.trim()&&!recording)} pending={busy&&sending.current&&submissionAction==='answer'} pendingLabel="답변 저장 중" onClick={()=>submit(null)}>답변 저장<ChevronRight size={17}/></ActionButton></div>
    </div>}
    </section>}</>}
  </div>;
}


