'use client';
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
import { startSpeechCapture,decodeRecordingTelemetry, type SpeechCapture } from '@/lib/client/speech-recorder';
import {beginRecordingRecovery,readRecordingRecovery,removeRecordingRecovery,installRecordingExitGuard,type RecordingRecoveryWriter} from '@/lib/client/recording-recovery';
import { learningTargetIdentityMatches } from '@gakja/content-contracts/workflows';
import { quizAssistanceLabel, quizResponseNeedsReview, recallRating, savedQuizSubmission, type RecallStatus } from '@/lib/quiz-session-view';
import styles from './quiz-session-ui.module.css';
const modeNames:Item={choice:'10초 퀴즈',answer:'Q&A',oral:'답변 녹음'};
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
  const choiceTiming=(location:string)=><fieldset className={styles.choiceTiming} disabled={!!busy}><legend>선택형 퀴즈 시간</legend><div>{[[false,'10초'],[true,'제한 없음']].map(([value,label])=><label key={String(value)}><input type="radio" name={'choice-time-'+location} checked={untimed===value} onChange={()=>setUntimed(Boolean(value))}/><span>{label}</span></label>)}</div></fieldset>;
  const resumeName=(s:Item)=>{const saved=s.metadata?.targetSnapshot;return [saved?.university,saved?.department||saved?.major].filter(Boolean).join(' · ')||'시작 당시 지원처 정보 없음';};
  async function saveHere(sessionId:string){setBusy(sessionId);try{await post('/api/quiz',{action:'end',sessionId});setDto(await api('/api/quiz'+(contextQuery?'?'+contextQuery:'')));}catch(e){setError((e as Error).message);}finally{setBusy('');}}
  const resumeRow=(s:Item,main=false,showSchool=false)=><div className={'quiz-resume-row '+styles.resumeRow} key={s.id}><div className={styles.resumeCopy}>{showSchool&&<small>{resumeName(s)}</small>}<strong>{s.mode==='choice'&&!s.timed?'선택형 연습':modeNames[s.mode]}</strong><span>{s.topicLabel}</span><small>{new Date(s.created_at).toLocaleDateString('ko-KR',{month:'long',day:'numeric'})} · {s.current_index}/{s.total}개 답변 · {Math.max(0,s.total-s.current_index)}개 남음</small></div><div className={styles.resumeActions}><Link className={'button '+(main?'primary':'secondary')} href={'/quiz/session/'+s.id}>이어서 풀기<Play size={16}/></Link><ActionButton className="text-link" disabled={!!busy} pending={busy===s.id} pendingLabel="기록 저장 중" onClick={()=>void saveHere(s.id)}>여기까지 저장</ActionButton></div></div>;
  const resumeList=!!resumes.length&&<><section className="quiz-resume-list"><div className="section-heading"><h2>이어서 풀기</h2></div>{resumes.slice(0,showAllReady?30:1).map((s:Item,index:number)=>resumeRow(s,index===0))}</section>{resumes.length>1&&<button className="text-link quiz-show-ready" aria-expanded={showAllReady} onClick={()=>setShowAllReady(value=>!value)}>{showAllReady?'접기':`다른 진행 중 퀴즈 ${resumes.length-1}개`}<ChevronRight size={16}/></button>}</>;
  return <div className={'quiz-v3 quiz-home '+styles.home}><PageTitle title="퀴즈"/>{error&&<Alert>{error}</Alert>}
    {scopeName&&<p className={styles.homeScope}>현재 지원처 · {scopeName}</p>}
    <nav className="quiz-paths" aria-label="퀴즈 학습 경로"><Link href={'/quiz?'+new URLSearchParams({...navigationQuery,focus:'today'}).toString()} aria-current={focus==='today'?'page':undefined}>오늘 복습</Link><Link href={'/quiz?'+new URLSearchParams({...navigationQuery,focus:'free'}).toString()} aria-current={focus==='free'?'page':undefined}>자유 연습</Link></nav>
    {dto?.targetSnapshotStale&&<p className="quiz-note">이 교재의 {dto.target?.university} · {dto.target?.department} 기준으로 연습해요. 현재 지원 정보와 달라요.</p>}
    {!dto&&!error?<Spinner/>:<>{requested&&<section className="quiz-context"><span>다시 준비할 질문</span><h2>{requested.prompt}</h2>{dto?.requested?.reason&&<p>{dto.requested.reason}</p>}{dto?.requested?.sessionId&&<Link className="text-link" href={'/quiz/session/'+dto.requested.sessionId}>저장 당시 기록<ArrowUpRight size={16}/></Link>}</section>}{hasRequested&&dto&&!requested&&<p className="quiz-note">현재 발행 자료에 연결된 연습 항목이 없어요. <Link href={libraryHref}>전체 복습 항목 보기</Link></p>}
    {focus==='today'&&resumeList}
    {(focus==='today'||selectedMode)&&matching(recommendedMode).length>0&&<section className="quiz-today"><div><h2>{recommendationTitle}</h2><p>{recommendationReason} · {recommendationCount}문항</p>{recommendedMode==='choice'&&choiceTiming('today')}</div><ActionButton className={'button '+(resumes.length?'secondary':'primary')} disabled={!!busy} pending={busy===recommendedMode} pendingLabel="퀴즈 준비 중" onClick={()=>start(recommendedMode)}>{oralSelected?'녹음 답변 시작':answerSelected?'Q&A 시작':'복습 시작'}{oralSelected?<Mic size={17}/>:<Play size={17}/>}</ActionButton></section>}
    {focus==='free'&&<section className="quiz-new-practice"><h2 className="section-label">새로 연습하기</h2><div className="quiz-mode-list">{[['choice','선택형 퀴즈',untimed?'보기를 고른 뒤, 정답과 근거를 천천히 확인해요.':'10초 안에 4개의 보기 중 하나를 고르세요.',Clock3],['answer','Q&A','기억한 내용을 내 말로 적어보세요.',Type],['oral','답변 녹음','생각한 답을 내 목소리로 남겨보세요.',Mic]].sort(([a],[b])=>Number(matching(String(b)).length>0)-Number(matching(String(a)).length>0)).map(([key,title,description,Icon]:any)=>{const available=matching(key).length>0;return <div key={key} className={styles.modeEntry}><button className="quiz-mode-row" disabled={!!busy||!available} aria-busy={busy===key} onClick={()=>start(key)}><Icon size={30} strokeWidth={1.4}/><div><h2>{title}</h2><p>{available?description:'문제 준비 중이에요.'}</p></div><span>{busy===key?'준비 중':available?`${matching(key).length}문항`:'준비 중'}{busy===key?<LoaderCircle className="spin" size={23} aria-hidden="true"/>:available&&<ArrowUpRight size={23} aria-hidden="true"/>}</span></button>{key==='choice'&&available&&choiceTiming('free')}</div>;})}</div></section>}
    {focus==='free'&&resumeList}
    {!!otherOpen.length&&<details className={styles.otherSessions}><summary>다른 지원처·지원처 미지정 퀴즈 {otherOpen.length}개<ChevronRight size={16}/></summary><p>저장 당시 학교·학과 기준으로 이어가요.</p>{otherOpen.map((s:Item)=>resumeRow(s,false,true))}</details>}
    <div className="quiz-library-links"><Link href={libraryHref}>전체 복습 항목<ArrowUpRight size={18}/></Link><Link href="/records/history">연습 이력<ArrowUpRight size={18}/></Link></div>
    {dto&&!dto.library?.choice?.length&&<p className="quiz-note">객관식 문제 준비 중이에요. {matching('answer').length?'지금은 Q&A로 연습할 수 있어요.':matching('oral').length?'지금은 답변 녹음으로 연습할 수 있어요.':<>관련 자료를 읽으며 질문을 준비해보세요. <Link href={'/knowledge'+(libraryQuery?'?'+libraryQuery:'')}>관련 자료 보기</Link></>}</p>}</>}
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
  const [pendingAudio,setPendingAudio]=useState<{blob:Blob;durationMs:number;index:number;telemetry:Item|undefined;recoveryKey?:string;complete?:boolean}|null>(null);
  const [transcriptProcessing,setTranscriptProcessing]=useState(false);
  const [submissionAction,setSubmissionAction]=useState<'answer'|'again'>('answer');
  const [choiceReview,setChoiceReview]=useState<Item|null>(null);
  const [textAlternative,setTextAlternative]=useState(false),[preparation,setPreparation]=useState<number|null>(null),[skipPreparation,setSkipPreparation]=useState(false),[pendingAudioUrl,setPendingAudioUrl]=useState('');
  const latestAnswer=useRef(answer),latestRecording=useRef(recording),pendingSubmission=useRef<Item|null>(null),draftQueue=useRef<Promise<void>>(Promise.resolve()),savedDraft=useRef<{key:string;response:string}>({key:'',response:''}),draftRequest=useRef<{key:string;response:string;requestId:string}|null>(null);
  const offset=useRef(0),sending=useRef(false),recorder=useRef<MediaRecorder|null>(null),stream=useRef<MediaStream|null>(null),recordStart=useRef(0),mounted=useRef(true),latest=useRef<Item|null>(null),loadedDraft=useRef(''),recordingPhase=useRef(recordingState);
  const speechCapture=useRef<SpeechCapture|null>(null);
  const stoppedRecording=useRef<{durationMs:number;telemetry:Item|undefined}|null>(null);
  const recoveryWriter=useRef<RecordingRecoveryWriter|null>(null),recordingFinished=useRef<Promise<void>>(Promise.resolve()),resolveRecordingFinished=useRef<(()=>void)|null>(null),pendingAudioRef=useRef(pendingAudio),questionHeading=useRef<HTMLHeadingElement|null>(null),captureGeneration=useRef(0);
  pendingAudioRef.current=pendingAudio;
  latest.current=dto;
  latestAnswer.current=answer;
  latestRecording.current=recording;
  recordingPhase.current=recordingState;
  const apply=useCallback((value:Item)=>{offset.current=new Date(value.serverTime).getTime()-Date.now();latest.current=value;setDto(value);},[]);
  const applySavedChoice=useCallback((value:Item,receipt?:Item)=>{
    apply(value);
    const current=value.session;
    const saved=receipt||(value.responses||[]).find((response:Item)=>response.item_index===current.current_index-1);
    let reviewed=false;try{reviewed=Boolean(saved)&&sessionStorage.getItem('gakja-quiz:'+id+':reviewed')===String(saved.id??saved.item_index);}catch{}
    setChoiceReview(current.mode==='choice'&&current.timed===false&&['ready','completed'].includes(current.state)&&saved&&!reviewed?saved:null);
  },[id,apply]);
  useEffect(()=>{mounted.current=true;captureGeneration.current++;const controller=new AbortController();api<Item>('/api/quiz?sessionId='+id,{signal:controller.signal}).then(async value=>{if(value.session.state==='active')value=await post('/api/quiz',{action:'pause',sessionId:id,itemIndex:value.session.current_index});if(mounted.current)applySavedChoice(value);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>{mounted.current=false;captureGeneration.current++;controller.abort();if(recorder.current?.state==='recording'||recorder.current?.state==='paused'){finishRecordingMeasurement();recorder.current.stop();}else{speechCapture.current?.dispose();speechCapture.current=null;if(!resolveRecordingFinished.current)void recoveryWriter.current?.cancel().catch(()=>{});}stream.current?.getTracks().forEach(t=>t.stop());};},[id,applySavedChoice]);
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
  useEffect(()=>{if(!draftKey)return;loadedDraft.current='';const remote=session.metadata?.drafts?.[String(session.current_index)],remoteText=typeof remote==='string'?remote:remote?.response||'';let local:string|null=null;try{local=localStorage.getItem(draftKey)??sessionStorage.getItem(draftKey);}catch{}savedDraft.current={key:draftKey,response:remoteText};const priorRecording=dto?.recordings?.find((r:Item)=>r.item_index===session?.current_index);setAnswer(local??(remoteText||((priorRecording?.transcript_cleanup?.status==='completed'&&priorRecording.display_transcript)||'')));setRecallStatus('unchecked');try{const pending=JSON.parse(sessionStorage.getItem(draftKey+':submission')||'null');pendingSubmission.current=pending?.itemIndex===session.current_index?pending:null;if(pendingSubmission.current&&['remembered','uncertain','needs_confirmation','unchecked'].includes(pendingSubmission.current.recallStatus))setRecallStatus(pendingSubmission.current.recallStatus);}catch{pendingSubmission.current=null;}setDraftStatus(remoteText?'saved':'idle');setHint(null);setFeedback(null);setSelected(null);setRecordingSaved(false);setPendingAudio(null);setRecording(dto?.recordings?.find((r:Item)=>r.item_index===session?.current_index)||null);},[draftKey]);
  useEffect(()=>{if(!draftKey)return;let active=true;try{setTextAlternative(localStorage.getItem(draftKey+':text-mode')==='true');}catch{setTextAlternative(false);}void readRecordingRecovery({studentId:session.student_id,sessionId:id,itemIndex:session.current_index,kind:'quiz'}).then(saved=>{if(active&&saved){if(saved.inUse){setError('다른 탭에서 이 질문을 녹음 중이에요. 그 탭에서 마친 뒤 다시 열어 주세요.');return;}const candidate={blob:saved.blob,durationMs:saved.durationMs,index:saved.itemIndex,telemetry:saved.telemetry,recoveryKey:saved.key,complete:saved.complete};pendingAudioRef.current=candidate;setPendingAudio(candidate);}}).catch(()=>{});return()=>{active=false;};},[draftKey]);
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
  useEffect(()=>{if(!draftKey||session?.mode==='choice'||done||busy)return;if(loadedDraft.current!==draftKey){loadedDraft.current=draftKey;return;}try{localStorage.setItem(draftKey,answer);sessionStorage.setItem(draftKey,answer);const hasRecording=!!pendingAudioRef.current||!!latestRecording.current||recordingPhase.current==='recording';localStorage.setItem(activityKey,JSON.stringify({itemIndex:session.current_index,updatedAt:new Date().toISOString(),hasDraft:!!answer.trim()||hasRecording,hasRecording}));}catch{}if(savedDraft.current.key===draftKey&&savedDraft.current.response===answer)return;setDraftStatus('saving');const timer=setTimeout(()=>{void saveDraft(answer,session.current_index,draftKey).catch(()=>{});},450);return()=>clearTimeout(timer);},[answer,draftKey,session?.mode,session?.current_index,done,busy,saveDraft,activityKey]);
  useEffect(()=>{const openAssistant=(event:Event)=>{const value=latest.current?.session;if(!value||['completed','ended'].includes(value.state))return;event.preventDefault();if(value.mode==='choice'){toast('답변 저장 후 AI 비서에서 확인해 주세요.');return;}if(recordingPhase.current!=='idle'||pendingAudio){toast('녹음을 마치고 저장한 뒤 이동해 주세요.');return;}if(sending.current||busy)return;setBusy(true);setError('');void(async()=>{try{const currentItem=value.items[value.current_index];await saveDraft(latestAnswer.current,value.current_index,draftKey);apply(await post('/api/quiz',{action:'pause',sessionId:id,itemIndex:value.current_index}));router.push('/on?'+new URLSearchParams({quizSessionId:id,quizItemIndex:String(value.current_index),questionId:currentItem.question_id||'',...(currentItem.target_id||value.metadata?.targetId?{targetId:currentItem.target_id||value.metadata.targetId}:{}),sourceType:currentItem.source_kind==='common'?'common':'personal',sourceVersion:String(currentItem.source_kind==='common'?currentItem.common_revision||1:value.content_version||'')}).toString());}catch(e){setError('초안 저장을 확인하지 못했어요. 다시 저장한 뒤 이동해 주세요.');setDraftStatus('failed');}finally{setBusy(false);}})();};window.addEventListener('gakja:open-on',openAssistant);return()=>window.removeEventListener('gakja:open-on',openAssistant);},[id,draftKey,saveDraft,apply,pendingAudio,busy,router,toast]);
  async function transition(action:string,extra:Item={}) {setError('');return post('/api/quiz',{action,sessionId:id,itemIndex:latest.current?.session.current_index,...extra});}
  async function start() {if(sending.current)return;setCountdown(3);}
  useEffect(()=>{if(countdown===null)return;const timer=setTimeout(async()=>{if(countdown>1)setCountdown(countdown-1);else{setCountdown(null);setBusy(true);try{apply(await transition('start'));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}},400);return()=>clearTimeout(timer);},[countdown]);
  const submit=useCallback(async(selectedOptionId:string|null,timedOut=false,rating?:string,recallOverride?:RecallStatus)=>{
    if(sending.current||choiceReview||!latest.current||latest.current.session.state!=='active'||recordingPhase.current!=='idle'||pendingAudio||preparation!==null)return;const current=latest.current.session,receiptOrigin=document.activeElement instanceof HTMLElement?document.activeElement.getBoundingClientRect():undefined;
    const selectedRecall=recallOverride||recallStatus,payload={action:'answer',sessionId:id,itemIndex:current.current_index,selectedOptionId,timedOut,response:current.mode==='choice'?'':answer,rating:rating||(current.mode==='choice'?'good':recallRating(selectedRecall)),recallStatus:current.mode==='choice'?undefined:selectedRecall,hintUsed:!!hint,recordingId:textAlternative?undefined:recording?.id,...(current.mode==='oral'&&textAlternative?{responseMode:'text'}:{})};
    if(!pendingSubmission.current||JSON.stringify({...pendingSubmission.current,requestId:undefined})!==JSON.stringify(payload))pendingSubmission.current={...payload,requestId:crypto.randomUUID()};
    const request=pendingSubmission.current;try{if(draftKey)sessionStorage.setItem(draftKey+':submission',JSON.stringify(request));}catch{}
    sending.current=true;setSubmissionAction(rating==='again'?'again':'answer');setBusy(true);setError('');setSelected(selectedOptionId);
    const clearDraft=()=>{pendingSubmission.current=null;savedDraft.current={key:'',response:''};try{localStorage.removeItem(activityKey);if(draftKey){localStorage.removeItem(draftKey);sessionStorage.removeItem(draftKey);sessionStorage.removeItem(draftKey+':submission');}}catch{}};
    try {
      await draftQueue.current.catch(()=>{});
      const response=await post('/api/quiz',request);
      clearDraft();setFeedback(response.response);if(['completed','ended'].includes(response.session.state))animateStudyReceipt(receiptOrigin);
      if(response.session.mode==='choice'&&response.session.timed!==false&&response.session.state==='ready') {
        setTimeout(async()=>{if(!mounted.current)return;try{apply(await post('/api/quiz',{action:'start',sessionId:id,itemIndex:response.session.current_index}));setFeedback(null);setSelected(null);}catch(e){apply(response);setError((e as Error).message);}finally{sending.current=false;setBusy(false);}},650);
      }else{applySavedChoice(response,response.response);sending.current=false;setBusy(false);}
      await refresh();
    }catch(e){try{const recovered=await api<Item>('/api/quiz?sessionId='+id),saved=savedQuizSubmission(recovered.responses||[],request);if(saved){clearDraft();applySavedChoice(recovered,saved);setFeedback(saved);toast('저장된 답변을 다시 불러왔어요.');await refresh();}else setError('답변 저장을 확인하지 못했어요. 같은 요청으로 다시 저장해 주세요.');}catch{setError((e as Error).message);}sending.current=false;setBusy(false);setSelected(null);}
  },[id,answer,hint,recording,draftKey,refresh,apply,applySavedChoice,choiceReview,recallStatus,pendingAudio,toast,textAlternative,activityKey,preparation]);
  async function nextChoice() {
    if(!choiceReview||sending.current||busy||!latest.current)return;
    sending.current=true;setBusy(true);setError('');
    try {
      const current=latest.current.session;
      if(!['completed','ended'].includes(current.state))apply(await post('/api/quiz',{action:'start',sessionId:id,itemIndex:current.current_index}));
      try{sessionStorage.setItem('gakja-quiz:'+id+':reviewed',String(choiceReview.id??choiceReview.item_index));}catch{}
      setChoiceReview(null);setFeedback(null);setSelected(null);
    }catch(e){setError('다음 문제를 시작하지 못했어요. 다시 눌러 주세요.');}
    finally{sending.current=false;setBusy(false);}
  }
  useEffect(()=>{if(!session||session.mode!=='choice'||session.state!=='active'||!session.deadline_at||feedback||error)return;const tick=()=>{const ms=Math.max(0,new Date(session.deadline_at).getTime()-(Date.now()+offset.current));setLeft(ms/1000);if(ms<=0&&!sending.current)submit(null,true);};tick();const timer=setInterval(tick,80);return()=>clearInterval(timer);},[session?.state,session?.deadline_at,feedback,error,submit]);
  useEffect(()=>{const onKey=(event:KeyboardEvent)=>{
    if(!session||session.mode!=='choice'||session.state!=='active'||busy||sending.current||feedback||choiceReview||countdown!==null)return;
    if(event.defaultPrevented||event.isComposing||event.repeat||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return;
    const editable='input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]';
    if([event.target,document.activeElement,...(event.composedPath?.()||[])].some(target=>target instanceof Element&&target.closest(editable)))return;
    if(document.querySelector('dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'))return;
    const index=['1','2','3','4'].indexOf(event.key);if(index>=0&&item?.options?.[index]){event.preventDefault();void submit(item.options[index].id);}
  };window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);},[session,item,busy,feedback,choiceReview,countdown,submit]);
  useEffect(()=>{const pause=(beacon=true)=>{const s=latest.current?.session;if(s?.state==='active'&&!sending.current&&recordingPhase.current==='idle'){const payload={action:'pause',sessionId:id,itemIndex:s.current_index};if(beacon)navigator.sendBeacon('/api/quiz',new Blob([JSON.stringify(payload)],{type:'application/json'}));else{setDto(value=>value?{...value,session:{...value.session,state:'paused'}}:value);post('/api/quiz',payload).then(value=>{if(mounted.current)apply(value);}).catch(e=>{if(mounted.current)setError(e.message);});}}};const hide=()=>{if(document.visibilityState==='hidden')pause(false);};const pageHide=()=>pause();window.addEventListener('pagehide',pageHide);document.addEventListener('visibilitychange',hide);return()=>{pause();window.removeEventListener('pagehide',pageHide);document.removeEventListener('visibilitychange',hide);};},[id,apply]);
  useEffect(()=>{if(recordingState!=='recording')return;const elapsedMs=()=>speechCapture.current?.elapsedMs()??performance.now()-recordStart.current;
    // Leave one polling interval for normal timer scheduling; never relabel an overlong file.
    const limit=setTimeout(stopRecording,Math.max(0,179_750-elapsedMs()));
    const timer=setInterval(()=>{const elapsed=elapsedMs();setRecordSeconds(Math.floor(elapsed/1000));if(elapsed>=179_750)stopRecording();},250);
    return()=>{clearTimeout(limit);clearInterval(timer);};},[recordingState]);
  async function pause() {if(recordingState!=='idle'||sending.current)return;setBusy(true);try{if(session.mode!=='choice')await saveDraft(latestAnswer.current,session.current_index,draftKey);apply(await transition('pause'));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function revealHint() {setBusy(true);try{const result=await transition('hint');setHint(result.hint);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function end() {if(recordingState!=='idle'||sending.current||pendingAudio)return;const receiptOrigin=document.activeElement instanceof HTMLElement?document.activeElement.getBoundingClientRect():undefined;setBusy(true);try{if(session.mode!=='choice')await saveDraft(latestAnswer.current,session.current_index,draftKey);const result=await transition('end');apply(result);setChoiceReview(null);if(['completed','ended'].includes(result.session.state))animateStudyReceipt(receiptOrigin);await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function finishRecordingTranscript(saved:Item,index:number,baseline:string) {
    const result=await post('/api/reports',{action:'transcribe',recordingId:saved.id,kind:'quiz'});
    if(!mounted.current||latest.current?.session.id!==id||latest.current?.session.current_index!==index)return;
    const updated={...saved,raw_transcript:result.rawTranscript,display_transcript:result.transcript,transcript_cleanup:{status:result.cleanupStatus,error:result.cleanupError},transcription_status:result.transcriptionStatus};
    setRecording(updated);
    if(result.cleanupStatus==='completed'&&typeof result.transcript==='string'&&latestAnswer.current===baseline&&!baseline.trim())setAnswer(result.transcript);
    if(result.cleanupStatus!=='completed')setError(result.cleanupError||result.transcriptionError||'녹음은 저장했어요. 문장 정리를 다시 시도하거나 직접 입력해 주세요.');
  }
  async function retryRecordingTranscript() {
    if(!recording||recordingState!=='idle'||busy)return;const baseline=latestAnswer.current,index=session.current_index;setTranscriptProcessing(true);setRecordingState('uploading');setError('');
    try{await finishRecordingTranscript(recording,index,baseline);}catch(e){if(mounted.current)setError((e as Error).message);}finally{if(mounted.current){setTranscriptProcessing(false);setRecordingState('idle');}}
  }
  function useRecordingTranscript() {
    const current=latest.current?.session,audio=latestRecording.current;
    if(!transcriptReady||busy||sending.current||recordingPhase.current!=='idle'||pendingAudio||transcriptProcessing||current?.id!==id||current?.current_index!==session.current_index||audio?.id!==recording?.id||audio?.item_index!==current.current_index||audio?.transcript_cleanup?.status!=='completed'||typeof audio.display_transcript!=='string'||!audio.display_transcript.trim())return;
    setAnswer(audio.display_transcript);
  }
  async function uploadRecording(candidate:NonNullable<typeof pendingAudio>) {
    if(candidate.complete===false){setError('중단된 녹음이에요. 원본을 먼저 확인해 주세요. 이어서 저장하려면 복구 카드에서 확인해 주세요.');return;}
    if(candidate.durationMs>180_000){setError('화면이 멈춰 녹음이 3분을 넘었어요. 원본을 내려받은 뒤 다시 녹음해 주세요.');return;}
    const baseline=latestAnswer.current;setRecordingState('uploading');setTranscriptProcessing(false);setError('');
    try{const form=new FormData();form.set('recording',candidate.blob,'answer.'+(candidate.blob.type.includes('mp4')?'mp4':candidate.blob.type.includes('ogg')?'ogg':'webm'));form.set('sessionId',id);form.set('itemIndex',String(candidate.index));form.set('consent','true');form.set('durationMs',String(candidate.durationMs));if(candidate.telemetry)form.set('speechTelemetry',JSON.stringify(candidate.telemetry));const saved=await sendRecording('/api/quiz',form);if(!saved.recording?.id)throw new Error('녹음 저장 확인을 받지 못했어요. 원본을 보관하고 다시 저장해 주세요.');if(candidate.recoveryKey)await removeRecordingRecovery(candidate.recoveryKey);pendingAudioRef.current=null;if(mounted.current){setRecording(saved.recording);setRecordingSaved(true);setPendingAudio(null);setTranscriptProcessing(true);await finishRecordingTranscript(saved.recording,candidate.index,baseline);}}catch(e){if(mounted.current)setError((e as Error).message);}finally{if(mounted.current){setRecordingState('idle');setTranscriptProcessing(false);}}
  }
  function finishRecordingMeasurement() {
    if(stoppedRecording.current)return stoppedRecording.current;
    const elapsed=speechCapture.current?.elapsedMs()??performance.now()-recordStart.current;
    const telemetry=speechCapture.current?.finish();speechCapture.current=null;
    stoppedRecording.current={durationMs:Math.max(1,Math.round(telemetry?.durationMs??elapsed)),telemetry:telemetry||undefined};
    return stoppedRecording.current;
  }
  function stopRecording() {
    if(!recorder.current||recorder.current.state==='inactive')return;
    // Final data/stop events may arrive much later than the user's stop request.
    finishRecordingMeasurement();recorder.current.stop();if(mounted.current)setRecordingState('uploading');
  }
  function downloadPendingRecording() {
    if(!pendingAudio)return;
    const url=URL.createObjectURL(pendingAudio.blob),link=document.createElement('a');
    link.href=url;link.download='내-답변-녹음.'+(pendingAudio.blob.type.includes('mp4')?'mp4':pendingAudio.blob.type.includes('ogg')?'ogg':'webm');link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function retryPendingRecording() {
    if(!pendingAudio)return;
    if(latest.current?.session.state!=='active'){try{apply(await transition('start'));}catch(error){setError((error as Error).message);return;}}
    if(pendingAudio.complete===false){const measured=await decodeRecordingTelemetry(pendingAudio.blob);if(!measured){setError('중단된 파일의 재생 시간을 확인하지 못했어요. 원본을 내려받아 보관하고 다시 녹음해 주세요.');return;}await uploadRecording({...pendingAudio,complete:true,durationMs:measured.durationMs,telemetry:measured});return;}
    await uploadRecording(pendingAudio);
  }
  async function discardPendingRecording() {
    if(!pendingAudio||!window.confirm('저장하지 못한 녹음을 지울까요? 필요하면 먼저 원본을 내려받아 주세요.'))return;
    try{if(pendingAudio.recoveryKey)await removeRecordingRecovery(pendingAudio.recoveryKey);pendingAudioRef.current=null;setPendingAudio(null);setError('');try{localStorage.setItem(activityKey,JSON.stringify({itemIndex:session.current_index,updatedAt:new Date().toISOString(),hasDraft:!!latestAnswer.current.trim()||!!latestRecording.current}));}catch{}}catch{setError('기기에 보관된 녹음을 지우지 못했어요. 다시 시도해 주세요.');}
  }
  async function changeAnswerMode(text:boolean) {
    if(recordingState!=='idle'||pendingAudio)return;if(preparation!==null)await cancelPreparation();setPreparation(null);setTextAlternative(text);try{localStorage.setItem(draftKey+':text-mode',String(text));}catch{}
  }
  async function record() {
    if(!consent||recordingState!=='idle'||!item||pendingAudio||preparation!==null)return;setError('');setRecordingSaved(false);recordingPhase.current='uploading';setRecordingState('uploading');const generation=captureGeneration.current;
    try {
      if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)throw new Error('이 브라우저에서는 녹음을 지원하지 않아요.');
      const writer=await beginRecordingRecovery({studentId:session.student_id,sessionId:id,itemIndex:session.current_index,kind:'quiz'},'');recoveryWriter.current=writer;
      const device=await navigator.mediaDevices.getUserMedia({audio:true,video:false});if(!mounted.current||generation!==captureGeneration.current){device.getTracks().forEach(t=>t.stop());await writer.cancel().catch(()=>{});return;}
      stream.current=device;setMeterStream(device);recordingPhase.current='idle';setRecordingState('idle');
      if(skipPreparation)await beginRecord();else setPreparation(0);
    }catch(cause){stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;await recoveryWriter.current?.cancel().catch(()=>{});recoveryWriter.current=null;setMeterStream(null);recordingPhase.current='idle';setRecordingState('idle');setError((cause as Error).message);}
  }
  useEffect(()=>{if(preparation===null||preparation===0)return;const timer=setTimeout(()=>{if(preparation>1)setPreparation(preparation-1);else{setPreparation(null);void beginRecord();}},1000);return()=>clearTimeout(timer);},[preparation]);
  async function cancelPreparation() {
    setPreparation(null);stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;setMeterStream(null);const writer=recoveryWriter.current;recoveryWriter.current=null;
    if(writer){recordingPhase.current='uploading';setRecordingState('uploading');try{await writer.cancel();}catch{setError('준비 중인 녹음을 정리하지 못했어요. 잠시 후 다시 시도해 주세요.');}finally{recordingPhase.current='idle';if(mounted.current)setRecordingState('idle');}}
  }
  async function beginRecord() {
    if(!consent||recordingPhase.current!=='idle'||pendingAudioRef.current||!item)return;
    recordingPhase.current='uploading';setRecordingState('uploading');const generation=captureGeneration.current;
    try {
      const writer=recoveryWriter.current,device=stream.current;if(!writer||!device)throw new Error('마이크를 다시 확인해 주세요.');
      await writer.assertActive();if(!mounted.current||generation!==captureGeneration.current){device.getTracks().forEach(track=>track.stop());await writer.cancel().catch(()=>{});return;}writer.assertFresh();
      stream.current=device;const mime=['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus'].find(type=>MediaRecorder.isTypeSupported(type));
      const capture=new MediaRecorder(device,mime?{mimeType:mime}:undefined),chunks:Blob[]=[];recorder.current=capture;const index=session.current_index;
      speechCapture.current?.dispose();speechCapture.current=null;stoppedRecording.current=null;
      recordingFinished.current=new Promise(resolve=>{resolveRecordingFinished.current=resolve;});
      capture.onstart=()=>{recordStart.current=performance.now();speechCapture.current=startSpeechCapture(device);};
      capture.onpause=()=>speechCapture.current?.pause();capture.onresume=()=>speechCapture.current?.resume();
      capture.ondataavailable=event=>{if(event.data.size){chunks.push(event.data);try{localStorage.setItem(activityKey,JSON.stringify({itemIndex:index,updatedAt:new Date().toISOString(),hasDraft:true,hasRecording:true}));}catch{}void writer.append(event.data,stoppedRecording.current?.durationMs??speechCapture.current?.elapsedMs()??performance.now()-recordStart.current).catch(()=>{if(mounted.current)setError('기기 임시 저장이 멈췄어요. 녹음을 마친 뒤 원본을 내려받아 주세요.');});}};
      capture.onstop=async()=>{const measurement=finishRecordingMeasurement();device.getTracks().forEach(t=>t.stop());const blob=new Blob(chunks,{type:capture.mimeType});
        let candidate:NonNullable<typeof pendingAudio>={blob,...measurement,index,complete:true,recoveryKey:writer.key};
        try{const durable=await writer.finish(measurement);candidate={...candidate,recoveryKey:durable.key};}catch{if(mounted.current)setError('기기에 보관하지 못했어요. 이동하기 전에 원본을 내려받아 주세요.');}
        pendingAudioRef.current=candidate;resolveRecordingFinished.current?.();resolveRecordingFinished.current=null;
        if(!mounted.current||generation!==captureGeneration.current)return;setMeterStream(null);setPendingAudio(candidate);setRecordingState('idle');await uploadRecording(candidate);
      };recordStart.current=performance.now();setRecordSeconds(0);capture.start(250);setMeterStream(device);setRecordingState('recording');setSkipPreparation(true);try{localStorage.setItem('gakja-recording-ready-seen:'+data.user.id,'true');}catch{}
    }catch(e){speechCapture.current?.dispose();speechCapture.current=null;stream.current?.getTracks().forEach(t=>t.stop());await recoveryWriter.current?.cancel().catch(()=>{});recoveryWriter.current=null;setMeterStream(null);setRecordingState('idle');setError((e as Error).message);}
  }
  if(!dto)return <div className="quiz-v3">{error?<Alert>{error}</Alert>:<Spinner/>}</div>;
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
    return <article className="quiz-result-answer" key={response.id} data-result={outcome} aria-labelledby={'quiz-result-'+response.id}>
      <header className="quiz-result-answer-heading"><span className="quiz-result-index" aria-label={`${response.item_index+1}번 문항`}>{String(response.item_index+1).padStart(2,'0')}</span><h3 id={'quiz-result-'+response.id}>{savedItem.prompt||response.data?.prompt}</h3><span className={'quiz-result-status '+outcome}>{status}</span></header>
      <dl className="quiz-result-answer-content">
        {session.mode==='choice'&&<div><dt>내 선택</dt><dd>{savedItem.options?.find((option:Item)=>option.id===response.selected_option_id)?.text||'선택하지 않음'}</dd></div>}
        {!!response.response&&<div><dt>내 답변</dt><dd>{response.response}</dd></div>}
        {!!response.data?.correct_answer&&response.outcome!==true&&<div className="quiz-result-correction"><dt>검수된 정답</dt><dd>{response.data.correct_answer}</dd></div>}
      </dl>
      {audio&&<div className="quiz-result-audio"><span><Mic size={15} aria-hidden="true"/>저장한 녹음</span><audio controls preload="metadata" aria-label={`${response.item_index+1}번 답변 녹음`} src={audio.url}/></div>}
      {quizAssistanceLabel(response)&&<p className="quiz-result-assistance">{quizAssistanceLabel(response)}</p>}
      {(response.data?.model_answer||sources.length>0)&&<div className="quiz-result-reference">
        {response.data?.model_answer&&<details><summary>{savedItem.kind==='choice'?'검수된 개념 설명':'모범답안과 비교'}</summary><p>{response.data.model_answer}</p></details>}
        {sources.length>0&&<details open={inReview||undefined}><summary>{response.outcome===false?'정답 근거 확인':'저장 당시 근거 보기'}</summary>{sources.map((source:Item,index:number)=><blockquote key={source.id||index}><p>{source.text}</p><cite>{source.area||'발행 자료'}{source.page?` · ${source.page}쪽`:''}</cite></blockquote>)}</details>}
      </div>}
      {!sources.length&&dto.originalSourceUnavailable&&<p className="quiz-note quiz-result-source-note">저장 당시 근거를 불러올 수 없어요. 질문과 답변은 보존되어 있어요.</p>}
      {!inReview&&(needsReview(response)||sourceQuestion)&&<div className="quiz-result-answer-actions">
        {needsReview(response)&&<><Link href={repeatLink({...savedItem,id:response.memory_item_id||savedItem.id},session)}>다시 연습<RotateCcw size={14}/></Link><Link href={knowledgeLink({...savedItem,target_id:savedItem.target_id||session.metadata?.targetId})}>관련 자료<ArrowUpRight size={14}/></Link></>}
        {sourceQuestion&&<button className="text-link" onClick={()=>openResource({kind:'question',id:sourceQuestion.id,snapshot:{learning:sessionLearning,documents:[]}})}>질문과 원문<ArrowUpRight size={14}/></button>}
      </div>}
    </article>;
  };
  return <div className={'quiz-v3 quiz-session '+(!done||choiceReview?styles.sessionWorkspace:'')} data-quiz-mode={session.mode} data-quiz-state={choiceReview?'review':session.state}><Breadcrumb items={[{label:'퀴즈',href:'/quiz'},{label:sessionName}]}/><PageTitle title={sessionName} aside={!done?<button className="text-link" disabled={busy||recordingState!=='idle'||!!pendingAudio} onClick={end}>여기까지 저장<X size={17}/></button>:undefined}/>{error&&<Alert>{error}</Alert>}
    {pendingAudio&&recordingState==='idle'&&<section className={styles.pendingRecording} aria-label="아직 보내지 않은 음성 복구"><strong>{pendingAudio.complete===false?'중단된 녹음이 이 기기에 남아 있어요.':'녹음이 아직 저장되지 않았어요.'}</strong><span>같은 학생·같은 문항의 원본이에요. 서버 저장 확인 전까지 이 기기에서 7일 내에 복구할 수 있어요.</span>{pendingAudioUrl&&<audio controls preload="metadata" src={pendingAudioUrl} aria-label="보내지 않은 녹음 미리 듣기"/>}<div>{pendingAudio.durationMs<=180_000&&<button className="text-link" onClick={retryPendingRecording}>녹음 다시 저장</button>}<button className="text-link" onClick={downloadPendingRecording}>원본 내려받기</button><button className="text-link" onClick={discardPendingRecording}>저장 안 된 녹음 지우기</button></div></section>}
    {changedSessionTarget&&<p className="quiz-note">{sessionTarget.university} · {sessionTarget.department||sessionTarget.major}에서 준비한 기록이에요. 질문과 답변은 당시 기준으로 유지돼요.</p>}
    {choiceReview?<section className={'quiz-result-screen '+styles.choiceReview} aria-label="선택형 답변 확인"><div className={styles.reviewHeading}><h2 ref={questionHeading} tabIndex={-1} aria-live="polite">{choiceReview.outcome===true?'맞았어요.':'정답을 확인해 보세요.'}</h2><span>{choiceReview.item_index+1} / {session.items.length}문항</span></div>{renderResult(choiceReview,true)}<div className={styles.reviewNext}><p>답변은 저장됐어요. 충분히 확인한 뒤 넘어가세요.</p><ActionButton className="button primary" disabled={busy} pending={busy} pendingLabel="다음 문제 준비 중" onClick={nextChoice}>{done?'결과 보기':'다음 문제'}<ChevronRight size={17}/></ActionButton></div></section>:done?<section className="quiz-result-screen" aria-labelledby="quiz-result-title">
      <header className="quiz-result-overview"><div className="quiz-result-completion"><Check size={21} strokeWidth={1.8} aria-hidden="true"/><span>{session.state==='completed'?'답변 저장':'여기까지 저장'}</span></div><h2 id="quiz-result-title" ref={questionHeading} tabIndex={-1}>{responses.length?`${responses.length}문항의 답을 남겼어요.`:'다음에 다시 준비해요.'}</h2>
        <dl className="quiz-result-stats"><div><dt>답변한 문항</dt><dd className="quiz-result-count">{responses.length}<small> / {session.items.length}</small><span className="quiz-result-stat-track" aria-hidden="true"><i style={{width:`${session.items.length?Math.min(100,responses.length/session.items.length*100):0}%`}}/></span></dd></div>
          <div data-tone={session.mode==='oral'||(session.mode!=='choice'&&!correctCount&&!responses.some(response=>response.outcome===false))?'saved':'correct'}><dt>{session.mode==='oral'?'저장한 녹음':session.mode!=='choice'&&!correctCount&&!responses.some(response=>response.outcome===false)?'미채점 저장':'확인한 정답'}</dt><dd>{session.mode==='oral'?recordedCount:session.mode!=='choice'&&!correctCount&&!responses.some(response=>response.outcome===false)?ungradedCount:correctCount}<small>{session.mode==='oral'?'개':'문항'}</small></dd></div>
          <div data-tone="review"><dt>다시 볼 답변</dt><dd>{reviewResponses.length}<small>문항</small></dd></div>
        </dl>
      </header>
      {nextItem&&<section className="quiz-result-next" aria-labelledby="quiz-result-next-title"><div><span className="quiz-result-eyebrow">{practiceItem?'다음은 면접에서':'다음 복습'}</span><h3 id="quiz-result-next-title" data-question-key={practiceItem&&nextQuestion?.prompt===nextItem.prompt?practiceItem.question_id:undefined}>{nextItem.prompt}</h3>{!practiceItem&&<p className="quiz-note">{changedTarget?'지원 정보가 바뀌었어요. 이 답변은 당시 학교·학과의 기록으로 남아 있어요.':'현재 자료에 같은 면접 질문이 없어요. 아래에서 저장한 답변을 확인할 수 있어요.'}</p>}</div>
        {practiceItem?<Link className="button primary" href={practiceLink(practiceItem,session.content_version)+'&quizSessionId='+id}>{appliedActivity?'이 활동 면접에 적용':'면접에서 말하기'}<ChevronRight size={17}/></Link>:<Link className="button primary" href={repeatLink(nextItem,session)}>복습 항목 확인<ChevronRight size={17}/></Link>}
        <div className="quiz-result-next-links">{['uncertain','needs_confirmation'].includes(responses.find(quizResponseNeedsReview)?.data?.recall_state||'')&&<Link href={'/my/today?'+new URLSearchParams({questionId:nextItem.question_id||'',targetId:nextItem.target_id||session.metadata?.targetId||'',sourceType:nextItem.source_kind==='common'?'common':'personal',sourceVersion:String(nextItem.source_kind==='common'?nextItem.common_revision||1:session.content_version)}).toString()+'#today-record'}>기억이 불확실한 부분 확인<ArrowUpRight size={14}/></Link>}<Link href={knowledgeLink(contextItem||nextItem)}>관련 자료<ArrowUpRight size={14}/></Link><Link href={repeatLink(nextItem,{...session,mode:'answer'})}>내 말로 다시 설명<ArrowUpRight size={14}/></Link></div>
      </section>}
      {!!responses.length&&<section className="quiz-result-review" aria-labelledby="quiz-result-review-title"><div className="quiz-result-section-title"><h2 id="quiz-result-review-title">답변 돌아보기</h2><span>{responses.length}문항</span></div>
        {!!reviewResponses.length&&<section className="quiz-result-group" aria-labelledby="quiz-result-review-group"><h3 id="quiz-result-review-group" className="quiz-result-group-title">다시 볼 답변 <span>{reviewResponses.length}</span></h3>{reviewResponses.map(response=>renderResult(response))}</section>}
        {!!savedResponses.length&&(reviewResponses.length?<details className="quiz-result-saved-group"><summary>저장한 답변 <span>{savedResponses.length}</span><ChevronRight size={16} aria-hidden="true"/></summary><div>{savedResponses.map(response=>renderResult(response))}</div></details>:<div className="quiz-result-group">{savedResponses.map(response=>renderResult(response))}</div>)}
      </section>}
      <footer className="quiz-result-footer"><Link className="text-link" href="/quiz">퀴즈 목록<ChevronRight size={16}/></Link><Link className="text-link" href="/reports">내 리포트<ArrowUpRight size={16}/></Link></footer>
    </section>:
    <><div className="quiz-progress" aria-label={`${session.current_index}개 답변, 전체 ${session.items.length}개`}>{session.items.map((m:Item,index:number)=><i key={m.id} className={index<session.current_index?'answered':index===session.current_index?'current':''}/>)}</div>
    {session.state!=='active'?<section className="quiz-ready"><div className="quiz-ready-numbers"><span><strong>{session.items.length}</strong>문항</span>{session.mode==='choice'&&<span><strong>{session.timed===false?'∞':'10'}</strong>{session.timed===false?'시간 제한 없음':'초 / 문항'}</span>}</div>{countdown!==null?<strong className="quiz-countdown" aria-live="polite">{countdown}</strong>:<><h2>{session.state==='paused'?'잠깐 쉬어가요.':session.current_index>0?'다음 질문을 시작할까요?':'준비됐나요?'}</h2><ActionButton className="button primary large" disabled={busy} pending={busy} pendingLabel="퀴즈 준비 중" onClick={start}><Play size={18}/>{session.state==='paused'?'이어서 풀기':'퀴즈 시작'}</ActionButton></>}</section>:
    <section className={'quiz-question '+(feedback?'quiz-feedback':'')}><div className="quiz-question-meta"><span className="quiz-number">{String(session.current_index+1).padStart(2,'0')}<small> / {String(session.items.length).padStart(2,'0')}</small></span><div className="quiz-question-actions"><button className="icon-button" aria-label="일시정지" disabled={busy||recordingState!=='idle'} onClick={pause}><CirclePause size={23}/></button>{session.mode==='choice'&&session.timed!==false&&<div className={'quiz-clock '+(left<=3?'urgent':'')} role="timer" aria-label={`남은 시간 ${Math.ceil(left)}초`}><svg width="64" height="64" viewBox="0 0 60 60"><circle cx="30" cy="30" r="26" fill="none" strokeWidth="3"/><circle className="quiz-clock-line" cx="30" cy="30" r="26" fill="none" strokeWidth="3" strokeDasharray={circumference} strokeDashoffset={circumference*(1-left/10)}/></svg><strong>{Math.ceil(left)}</strong></div>}</div></div>
    <h2 className="quiz-prompt" ref={questionHeading} tabIndex={-1} data-question-key={item?.question_id}>{item?.prompt}</h2>{session.mode!=='choice'&&<LearningHelp questionId={item?.question_id} activityId={item?.activity_ids?.[0]} targetId={item?.target_id||session.metadata?.targetId} quizSessionId={id} itemIndex={session.current_index} sourceType={item?.source_kind==='common'?'common':'personal'} sourceVersion={item?.source_kind==='common'?item.common_revision:session.content_version||undefined}/>}
    {session.mode==='choice'?<><div className="quiz-options">{item.options.map((option:Item,index:number)=><button key={option.id} className={selected===option.id?'selected':''} data-outcome={selected===option.id&&feedback?(feedback.outcome===true?'correct':feedback.outcome===false?'incorrect':undefined):undefined} aria-pressed={selected===option.id} disabled={busy} onClick={()=>submit(option.id)}><span>{index+1}</span><strong>{option.text}</strong>{selected===option.id&&feedback?.outcome===true&&<Check className="quiz-outcome-check" size={22} aria-hidden="true"/>}</button>)}</div><div className="quiz-choice-footer"><span aria-live="polite">{feedback?feedback.timed_out?'시간 초과':feedback.outcome?'맞았어요.':'다시 떠올려보세요.':busy?'저장 중':'보기 선택'}</span><span>키보드 1–4</span></div>{error&&left<=0&&<button className="button ghost" disabled={busy} onClick={()=>submit(null,true)}>시간 초과 기록 다시 저장</button>}</>:
    <div className="quiz-answer-workspace"><div className="quiz-hint">{hint?<><span>{item?.kind==='choice'?'검수된 개념 힌트':'모범답안 힌트'}</span><p><span className="quiz-hint-first">{hint.first}</span>{hint.rest&&<span className="quiz-blurred" aria-hidden="true">{' '+hint.rest}</span>}</p></>:item.hasHint?<button className="text-link" disabled={busy} onClick={revealHint}>{item?.kind==='choice'?'검수된 개념 힌트':'모범답안 힌트'}<ChevronRight size={17}/></button>:<span className="muted">발행된 모범답안이 없어요.</span>}</div>
    {session.mode==='oral'&&<div className={styles.answerMode}><p>{textAlternative?'같은 질문에 글로 답해요. 음성 녹음·말하기 분석으로 기록하지 않아요.':'마이크를 쓰기 어렵다면 같은 질문에 글로 답할 수 있어요.'}</p><button className="text-link" disabled={busy||recordingState!=='idle'||!!pendingAudio} onClick={()=>changeAnswerMode(!textAlternative)}>{textAlternative?'다시 음성으로 답하기':'이 질문은 글로 답하기'}</button></div>}
    <textarea aria-label="내 답변" value={answer} maxLength={10_000} onChange={e=>setAnswer(e.target.value)} placeholder={session.mode==='oral'?'말한 내용이나 다시 생각할 점을 적어보세요.':'내 답을 적어보세요.'} disabled={busy||recordingState==='uploading'}/>
    <PracticeWritingHelp maxLength={10_000} key={id+':'+session.current_index} draftKey={`gakja-writing:${data.user.id}:${id}:${session.current_index}`} value={answer} rawTranscript={recording?.raw_transcript||undefined} disabled={busy||recordingState!=='idle'||!!pendingAudio} onApply={setAnswer} onAssisted={async()=>{apply(await transition('assist',{helpKind:'writing',requestId:crypto.randomUUID()}));}} evidence={(item.source_quotes||[]).map((source:Item)=>source.text).filter(Boolean)}/>
    <p className={styles.draftStatus} data-status={draftStatus} role="status">{draftStatus==='failed'?<>초안 저장 미확인 <button className="text-link" disabled={busy} onClick={()=>void saveDraft(answer,session.current_index,draftKey).catch(()=>{})}>다시 저장</button></>:draftStatus==='saving'?'초안 저장 중':draftStatus==='saved'?'초안 저장됨':''}</p>
    <fieldset className={styles.recallState} disabled={busy}><legend>답변을 돌아보면</legend><div className={styles.recallOptions}>{([['remembered','내 말로 설명했어요'],['uncertain','기억이 불확실해요'],['needs_confirmation','사실 확인이 필요해요']] as const).map(([value,label])=><label key={value}><input type="radio" name={'recall-'+id+'-'+session.current_index} value={value} checked={recallStatus===value} onChange={()=>setRecallStatus(value)}/>{label}</label>)}</div></fieldset>
    {recallStatus==='needs_confirmation'&&<Link className="text-link" href={'/account/confirmations'+(item?.activity_ids?.[0]?'?activityId='+encodeURIComponent(item.activity_ids[0]):'')}>활동 사실 확인<ArrowUpRight size={14}/></Link>}
    {!textAlternative&&<div className="quiz-record">{preparation!==null&&<section className={styles.recordingPreparation} aria-label="녹음 준비"><strong aria-live="polite">{preparation===0?'마이크를 확인해 주세요.':`${preparation}초 뒤 녹음을 시작해요.`}</strong><p><AudioLevelDot stream={meterStream} phase="recording"/>말해 보며 음량을 확인해 주세요. 아직 답변을 녹음하지 않아요. 전사는 저장한 뒤 보여드려요.</p><div>{preparation===0&&<button className="button primary" onClick={()=>setPreparation(3)}>준비됐어요 · 3초 뒤 시작</button>}<button className="button secondary" onClick={()=>{setPreparation(null);void beginRecord();}}>지금 시작</button><button className="text-link" onClick={cancelPreparation}>취소</button></div><label><input type="checkbox" checked={skipPreparation} onChange={event=>{setSkipPreparation(event.target.checked);try{localStorage.setItem('gakja-recording-skip-ready:'+data.user.id,String(event.target.checked));}catch{}}}/>다음부터 준비 단계 건너뛰기</label></section>}<label className="quiz-record-consent"><input type="checkbox" checked={consent} disabled={recordingState!=='idle'} onChange={e=>{setConsent(e.target.checked);if(!e.target.checked&&preparation!==null)void cancelPreparation();}}/>마이크 사용과 비공개 녹음 저장에 동의해요.</label><div className="quiz-record-controls">{recordingState==='recording'?<button className="button quiz-record-stop" onClick={stopRecording}><AudioLevelDot stream={meterStream} phase="recording"/>녹음 완료 · {recordSeconds}초</button>:<button className="button ghost" disabled={!consent||busy||recordingState==='uploading'||!!pendingAudio||preparation!==null} onClick={record}>{recordingState==='uploading'?<AudioLevelDot stream={null} phase="uploading"/>:recording?<RotateCcw size={17}/>:<AudioLevelDot stream={null} phase="idle"/>} {recordingState==='uploading'?(transcriptProcessing?'문장 정리 중':'녹음 저장 중'):recording?'다시 녹음':'답변 녹음'}</button>}{recordingSaved&&recordingState==='idle'&&<span className="quiz-record-saved" role="status"><AudioLevelDot stream={null} phase="saved"/>녹음 저장됨</span>}{recording&&recordingState==='idle'&&<audio controls preload="metadata" src={recording.url}/>}</div>{transcriptProcessing&&<p className="transcript-processing" role="status">녹음을 글로 옮기고 문장을 정리하고 있어요.</p>}{recording?.raw_transcript&&<details className="transcript-raw"><summary>원전사 보기</summary><p>{recording.raw_transcript}</p></details>}{recording&&recordingState==='idle'&&recording.transcript_cleanup?.status!=='completed'&&<button className="button ghost small" disabled={busy} onClick={retryRecordingTranscript}>{recording.raw_transcript?'문장 정리 다시 시도':'전사 다시 시도'}</button>}{transcriptReady&&answer!==recording?.display_transcript&&<button className="text-link" disabled={busy||recordingState!=='idle'||!!pendingAudio||transcriptProcessing} onClick={useRecordingTranscript}>정리된 전사 사용</button>}</div>}
    <div className="quiz-submit-actions"><ActionButton className="button ghost" disabled={busy||recordingState!=='idle'||!!pendingAudio||preparation!==null||(!answer.trim()&&!recording)} pending={busy&&sending.current&&submissionAction==='again'} pendingLabel="복습으로 남기는 중" onClick={()=>{setRecallStatus('uncertain');void submit(null,false,'again','uncertain');}}>다시 준비</ActionButton><ActionButton className="button primary" disabled={busy||recordingState!=='idle'||!!pendingAudio||preparation!==null||(session.mode==='oral'&&!textAlternative?!recording:textAlternative?!answer.trim():!answer.trim()&&!recording)} pending={busy&&sending.current&&submissionAction==='answer'} pendingLabel="답변 저장 중" onClick={()=>submit(null)}>답변 저장<ChevronRight size={17}/></ActionButton></div>
    </div>}
    </section>}</>}
  </div>;
}


