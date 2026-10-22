'use client';
import {setDeviceItem} from '@/lib/client/device-storage';
import {ownedClassName} from './owned-class-name';

import Link from 'next/link';
import {useEffect, useRef, useState} from 'react';
import {useRouter} from 'next/navigation';
import {Camera, Check, Download, Mic, Pause, Play, Square} from 'lucide-react';
import {useApp} from './app-shell';
import {registerDraftSaver} from '@/lib/client/draft-save';
import {action, api, post, Breadcrumb, InfoTip, Modal, targetName, type Item} from './shared';
import {LiveInterviewerStage} from './live-interviewer-stage';
import {LiveInterviewController, type LiveSnapshot} from '@/lib/client/live-interview-controller';
import {createLiveAnswerCapture} from '@/lib/client/live-interview-recorder';
import {uploadRecording} from '@/lib/recording-upload-client';
import {PRIVACY_POLICY_VERSION} from '@/lib/privacy-policy';
import {beginRecordingRecovery, readRecordingRecovery, removeRecordingRecovery, type RecordingRecoveryWriter} from '@/lib/client/recording-recovery';
import type {LiveAnswerRecording} from '@/lib/client/live-interview-recorder';
import {InterviewerAvatarSignal} from '@/lib/client/interviewer-avatar';
import {InterviewerAudioOutput} from '@/lib/client/interviewer-audio-output';
import {connectRealtimeInterview,type RealtimeInterviewConnection} from '@/lib/client/realtime-interview';
import {ChatComposer} from './chat-composer';
import {LearningHelp} from './learning-help';
import styles from './live-interview-session.module.css';

// Reuse the gesture-unlocked audio element for every interviewer question (including Safari).
const SILENT_WAV='data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEARKwAAESsAAABAAgAZGF0YQEAAACA';

function revealTypedAnswer(){
  if(!window.matchMedia?.('(max-width:700px)').matches)return;
  requestAnimationFrame(()=>{
    const input=document.getElementById('live-text-answer') as HTMLTextAreaElement|null;
    if(!input||input.disabled)return;
    const section=input.closest<HTMLElement>('[data-live-typed-answer]');
    const question=section?.parentElement?.querySelector<HTMLElement>(`.${styles.questionArea}`)||section;
    input.focus({preventScroll:true});
    if(!question)return;
    const header=document.querySelector<HTMLElement>('.topbar');
    const padding=Number.parseFloat(window.getComputedStyle(document.scrollingElement||document.documentElement).scrollPaddingTop)||0;
    question.style.scrollMarginTop=`${Math.max(0,(header?.getBoundingClientRect().bottom||64)+16-padding)}px`;
    question.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth',block:'start'});
  });
}

export function LiveInterviewSession({id,initialInfo,onTrainingUpdate}:{id:string;initialInfo:Item;onTrainingUpdate?:(info:Item)=>void}){
  const router=useRouter();const {data:appData,refresh}=useApp();
  const studentId=appData?.user?.id||initialInfo.session.student_id;
  const [state,setState]=useState<LiveSnapshot>({phase:initialInfo.session.state==='completed'?'complete':'idle',info:initialInfo,error:''});
  const [consent,setConsent]=useState(appData?.preferences?.liveRecordingConsent===true),[camera,setCamera]=useState(appData?.preferences?.liveCameraEnabled!==false),[leaveHref,setLeaveHref]=useState<string|null>(null),[exitOpen,setExitOpen]=useState(false),[download,setDownload]=useState('');
  const [recordingSettingsOpen,setRecordingSettingsOpen]=useState(false),[preferenceBusy,setPreferenceBusy]=useState(false),[preferenceError,setPreferenceError]=useState('');
  const preferenceScope=useRef<string|undefined>(appData?.user?.id);
  const consentPolicyVersion=useRef<string|undefined>(appData?.preferences?.liveRecordingPolicyVersion);
  const preferenceReceipt=useRef<{studentId:string;consent:boolean;camera:boolean}|null>(null);
  const voiceChoice=useRef({consent,camera,busy:preferenceBusy});voiceChoice.current={consent,camera,busy:preferenceBusy};
  const controller=useRef<LiveInterviewController|null>(null),stream=useRef<MediaStream|null>(null),video=useRef<HTMLVideoElement|null>(null),audio=useRef<HTMLAudioElement|null>(null);
  const avatarSignal=useRef(new InterviewerAvatarSignal()),audioOutput=useRef<InterviewerAudioOutput|null>(null);
  const realtime=useRef<RealtimeInterviewConnection|null>(null),realtimeEnabled=useRef(false),realtimeRun=useRef(0);
  const realtimeClosing=useRef(new Map<string,Set<RealtimeInterviewConnection>>());
  const closingForStudent=()=>{let pending=realtimeClosing.current.get(studentId);if(!pending){pending=new Set();realtimeClosing.current.set(studentId,pending);}return pending;};
  const closeRealtime=(connection:RealtimeInterviewConnection|null)=>{
    if(!connection)return Promise.resolve(true);
    const pending=closingForStudent();pending.add(connection);
    return connection.close().then(confirmed=>{if(confirmed)pending.delete(connection);return confirmed;});
  };
  const [realtimePreview,setRealtimePreview]=useState(''),[realtimeNotice,setRealtimeNotice]=useState('');
  const cameraChoice=useRef(camera),leaving=useRef(false),destination=useRef<string|null>(null);cameraChoice.current=camera;
  const [recoveryChecked,setRecoveryChecked]=useState(false),[localStatus,setLocalStatus]=useState(''),[countdown,setCountdown]=useState(0),[textMode,setTextMode]=useState(initialInfo.session.data?.trainingPurpose==='diagnostic'),[textAnswer,setTextAnswer]=useState(''),[textTurn,setTextTurn]=useState(''),[textBusy,setTextBusy]=useState(false),[textStatus,setTextStatus]=useState('');
  const [exiting,setExiting]=useState(false);
  const [assistantRequest,setAssistantRequest]=useState({turnId:'',token:0});
  const writer=useRef<RecordingRecoveryWriter|null>(null),preparationAbort=useRef<(()=>void)|null>(null),readyOnce=useRef(false),skipReady=useRef<(()=>void)|null>(null),thinkingUntil=useRef(0),textRef=useRef(''),textRequest=useRef<{turnId:string;answer:string;requestId:string}|null>(null);
  const uploadedRecordings=useRef(new WeakMap<LiveAnswerRecording,{mediaId:string;turnId:string;generation:number}>());
  textRef.current=textAnswer;
  const recoveryScope=(current:Item,generation:number)=>({studentId,sessionId:`${id}:${current.turnId}:${generation}`,itemIndex:0,kind:'interview' as const});
  const {phase,info,error,progress}=state;const settings=info.session.data||{},question=info.question;
  const diagnostic=settings.trainingPurpose==='diagnostic',trainingLabel=diagnostic?'첫 진단':settings.trainingPlanId?'답변 훈련':'Live 면접';
  useEffect(()=>{onTrainingUpdate?.(info);},[info,onTrainingUpdate]);
  const turns:Item[]=(info.turns||[]).filter((turn:Item)=>turn.answer&&!turn.invalidated);
  const people=settings.panelists?.length?settings.panelists:[{id:'A',name:'면접관 A',gender:'female'},{id:'B',name:'면접관 B',gender:'male'}];
  const started=!['idle','complete'].includes(phase),active=!['idle','paused','error','complete'].includes(phase);
  const prepareAudio=()=>{audio.current??=new Audio();audioOutput.current??=new InterviewerAudioOutput(audio.current,avatarSignal.current);void audioOutput.current.unlock();audio.current.src=SILENT_WAV;void audio.current.play().catch(()=>{});};
  useEffect(()=>{const next=phase==='listening'?'listening':['preparing','speaking','saving','recovering'].includes(phase)?'thinking':'idle';if(audioOutput.current)audioOutput.current.syncState(next,question?.speakerId||'');else avatarSignal.current.state(next,question?.speakerId||'');},[phase,question?.speakerId]);
  useEffect(()=>{let alive=true;realtimeEnabled.current=false;void api('/api/interviews/realtime').then(value=>{if(alive)realtimeEnabled.current=value.enabled===true;}).catch(()=>{});return()=>{alive=false;void closeRealtime(realtime.current);realtime.current=null;};},[id,studentId]);
  useEffect(()=>{
    if(!appData?.user?.id)return;
    const scope=appData.user.id,savedConsent=appData.preferences?.liveRecordingConsent===true,savedCamera=appData.preferences?.liveCameraEnabled!==false;
    if(preferenceScope.current!==scope){preferenceScope.current=scope;preferenceReceipt.current=null;setRecordingSettingsOpen(false);setPreferenceError('');}
    const receipt=preferenceReceipt.current;
    // An older bootstrap response cannot undo a setting just acknowledged by the server.
    if(receipt&&receipt.studentId===scope&&(receipt.consent!==savedConsent||receipt.camera!==savedCamera))return;
    preferenceReceipt.current=null;setConsent(savedConsent);setCamera(savedCamera);consentPolicyVersion.current=appData.preferences?.liveRecordingPolicyVersion;
    voiceChoice.current={consent:savedConsent,camera:savedCamera,busy:voiceChoice.current.busy};cameraChoice.current=savedCamera;
  },[appData?.user?.id,appData?.preferences?.liveRecordingConsent,appData?.preferences?.liveRecordingPolicyVersion,appData?.preferences?.liveCameraEnabled,studentId]);
  async function saveRecordingSettings(next:{liveRecordingConsent?:boolean;liveCameraEnabled?:boolean}){
    if(voiceChoice.current.busy||active)return false;
    const scope=studentId;
    voiceChoice.current.busy=true;
    setPreferenceBusy(true);setPreferenceError('');
    try{
      const result=await action('preference',{...next,...(next.liveRecordingConsent!==undefined?{policyVersion:PRIVACY_POLICY_VERSION}:{})});
      if(preferenceScope.current!==scope)return false;
      const saved={studentId:scope,consent:result.preferences.liveRecordingConsent===true,camera:result.preferences.liveCameraEnabled!==false};
      preferenceReceipt.current=saved;voiceChoice.current={consent:saved.consent,camera:saved.camera,busy:true};cameraChoice.current=saved.camera;
      setConsent(saved.consent);setCamera(saved.camera);consentPolicyVersion.current=result.preferences.liveRecordingPolicyVersion;if(next.liveRecordingConsent)setRecordingSettingsOpen(false);
      // Preserve a paused capture before releasing its tracks. A later start checks the remembered choices.
      if(stream.current)await controller.current?.resetDevices();
      await refresh();return true;
    }catch(cause){setPreferenceError((cause as Error).message||'녹음 설정을 저장하지 못했어요. 다시 선택해 주세요.');return false;}
    finally{voiceChoice.current.busy=false;setPreferenceBusy(false);}
  }
  function begin(){if(!voiceChoice.current.consent||!recoveryChecked||voiceChoice.current.busy)return;leaving.current=false;cameraChoice.current=voiceChoice.current.camera;setTextMode(false);prepareAudio();void controller.current?.start();}
  useEffect(()=>{
    let mounted=true;
    const roomSuspension=initialInfo.session.state==='active'?post('/api/interviews',{action:'suspend',sessionId:id}):Promise.resolve();
    void roomSuspension.catch(()=>{});
    const release=()=>{void closeRealtime(realtime.current);realtime.current=null;stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;audioOutput.current?.stop();audio.current?.pause();avatarSignal.current.silence();const pending=writer.current;writer.current=null;void pending?.cancel().catch(()=>{});};
    const instance=new LiveInterviewController(initialInfo,{
      load:()=>api(`/api/interviews?id=${id}`),
      async prepare(){
        await roomSuspension;
        if(!mounted)return;
        if(stream.current?.getAudioTracks().some(track=>track.readyState==='live'))return;
        stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;
        if(!navigator.mediaDevices?.getUserMedia)throw new Error('이 브라우저에서는 마이크를 사용할 수 없어요. HTTPS 또는 localhost에서 Chrome·Safari로 열어 주세요.');
        try{
          const next=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:cameraChoice.current?{width:{ideal:640},height:{ideal:480},frameRate:{ideal:20,max:24}}:false});
          if(!mounted){next.getTracks().forEach(track=>track.stop());return;}
          stream.current=next;if(video.current)video.current.srcObject=next;
        }catch{throw new Error(cameraChoice.current?'마이크·카메라 권한을 확인해 주세요. 카메라가 없으면 카메라 사용을 끄고 음성으로 시작할 수 있어요.':'마이크 사용 권한과 연결을 확인한 뒤 다시 시작해 주세요.');}
      },
      mute(paused){stream.current?.getTracks().forEach(track=>{track.enabled=!paused;});if(paused){void closeRealtime(realtime.current);realtime.current=null;avatarSignal.current.silence();const pending=writer.current;writer.current=null;void pending?.cancel().catch(()=>{});}},
      async suspend(){await post('/api/interviews',{action:'suspend',sessionId:id});},
      async resume(){await post('/api/interviews',{action:'resume',sessionId:id});},
      async speak(current,generation,signal){
        setRealtimePreview('');setRealtimeNotice('');
        if(realtimeEnabled.current&&stream.current&&audioOutput.current){
          void closeRealtime(realtime.current);
          const run=++realtimeRun.current;
          const connection=connectRealtimeInterview(stream.current,{sessionId:id,turnId:current.turnId,generation,attemptId:crypto.randomUUID()},{prompt:current.prompt,speakerId:current.speakerId||'A'},audioOutput.current,snapshot=>{
            if(!mounted||realtimeRun.current!==run)return;
            if(snapshot.preview)setRealtimePreview(snapshot.preview);
            if(['speaking','listening','thinking'].includes(snapshot.phase))audioOutput.current?.syncState(snapshot.phase as 'speaking'|'listening'|'thinking',current.speakerId||'A');
            if(snapshot.phase==='unavailable')setRealtimeNotice('연결이 끊겨도 녹음 원본은 계속 보관해요.');
          },{allowBargeIn:true,onInterruption:()=>{readyOnce.current=true;}});realtime.current=connection;
          const stop=()=>{void closeRealtime(connection);};signal.addEventListener('abort',stop,{once:true});
          try{await connection.playQuestion();if(signal.aborted)throw new DOMException('일시정지','AbortError');return;}
          catch(error){void closeRealtime(connection);if(realtime.current===connection)realtime.current=null;if(signal.aborted)throw error;realtimeEnabled.current=false;setRealtimeNotice('같은 질문을 다시 들려드릴게요.');}
          finally{signal.removeEventListener('abort',stop);}
        }
        const response=await fetch('/api/media',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'speech',sessionId:id,questionId:current.id,turnId:current.turnId,generation}),signal});
        if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.error||'질문 음성을 준비하지 못했어요. 다시 연결해서 계속해 주세요.');}
        const blob=await response.blob();if(signal.aborted)throw new DOMException('일시정지','AbortError');
        const player=audio.current??(audio.current=new Audio()),url=URL.createObjectURL(blob);
        audioOutput.current??=new InterviewerAudioOutput(player,avatarSignal.current);audioOutput.current.clear();audioOutput.current.select(current.speakerId||'');
        await new Promise<void>((resolve,reject)=>{
          let ended=false;
          const done=(error?:Error)=>{if(ended)return;ended=true;clearTimeout(timeout);signal.removeEventListener('abort',abort);player.onended=null;player.onerror=null;player.pause();URL.revokeObjectURL(url);error?reject(error):resolve();};
          const abort=()=>done(new DOMException('일시정지','AbortError'));
          const timeout=setTimeout(()=>done(new Error('질문 음성 재생이 지연됐어요. 연결을 확인하고 계속해 주세요.')),120000);
          signal.addEventListener('abort',abort,{once:true});player.onended=()=>done();player.onerror=()=>done(new Error('질문 음성을 재생하지 못했어요. 소리 설정을 확인하고 계속해 주세요.'));
          player.src=url;void player.play().catch(()=>done(new Error('질문 소리를 켜려면 계속하기를 눌러 주세요.')));
          if(signal.aborted)abort();
        });
      },
      captureDuringQuestion:()=>realtimeEnabled.current,
      async beforeCapture(current,generation,signal){
        const pending=await beginRecordingRecovery(recoveryScope(current,generation),'');writer.current=pending;
        const cancel=()=>{void pending.cancel().catch(()=>{});if(writer.current===pending)writer.current=null;};
        signal.addEventListener('abort',cancel,{once:true});preparationAbort.current=()=>signal.removeEventListener('abort',cancel);
        try{
        if(signal.aborted)throw new DOMException('일시정지','AbortError');
        if(!readyOnce.current){
          await new Promise<void>((resolve,reject)=>{
            let remaining=3,settled=false;setCountdown(remaining);
            const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);skipReady.current=null;setCountdown(0);resolve();};
            const abort=()=>{if(settled)return;settled=true;clearTimeout(timer);skipReady.current=null;setCountdown(0);reject(new DOMException('일시정지','AbortError'));};
            const tick=()=>{remaining--;setCountdown(remaining);if(remaining<=0)finish();else timer=setTimeout(tick,1000);};
            let timer=setTimeout(tick,1000);skipReady.current=finish;signal.addEventListener('abort',abort,{once:true});
          });readyOnce.current=true;
        }
        await pending.assertActive();if(signal.aborted)throw new DOMException('일시정지','AbortError');
        }catch(cause){signal.removeEventListener('abort',cancel);preparationAbort.current=null;await pending.cancel().catch(()=>{});if(writer.current===pending)writer.current=null;throw cause;}
      },
      capture(onProgress){
        if(!stream.current||!writer.current)throw new Error('마이크와 기기 임시 저장을 확인해 주세요.');
        const recovery=writer.current;
        recovery.assertFresh();
        realtime.current?.startInput();
        preparationAbort.current?.();preparationAbort.current=null;
        let capture;try{capture=createLiveAnswerCapture(stream.current,{onProgress,autoStop:()=>controller.current?.state.phase==='listening'&&avatarSignal.current.snapshot.state!=='speaking'&&Date.now()>=thinkingUntil.current,
          onChunk:(blob,kind,durationMs)=>{void (kind==='primary'?recovery.append(blob,durationMs):recovery.appendAnalysis(blob)).catch(()=>{if(mounted)setLocalStatus('기기 저장을 확인하지 못했어요. 화면을 닫기 전에 답변을 저장해 주세요.');});},
          async onComplete(recording){realtime.current?.finishInput();recording.recoveryKey=recovery.key;await recovery.finish({durationMs:recording.durationMs,telemetry:recording.telemetry,analysisAudio:recording.analysisAudio});if(mounted)setLocalStatus('기기에 보관됨 · 서버 저장 확인 전까지 유지해요.');},
        });}catch(cause){void recovery.cancel().catch(()=>{});throw cause;}finally{writer.current=null;}
        return capture;
      },
      async upload(recording,current,generation,options){
        const form=new FormData(),extension=recording.blob.type.includes('mp4')?'mp4':'webm';
        form.set('recording',recording.blob,`answer.${extension}`);
        if(recording.analysisAudio)form.set('analysisAudio',recording.analysisAudio,recording.analysisAudio.type.includes('mp4')?'answer-audio.mp4':'answer-audio.webm');
        form.set('sessionId',id);form.set('questionId',current.id);form.set('turnId',current.turnId);form.set('generation',String(generation));form.set('consent','true');if(consentPolicyVersion.current)form.set('policyVersion',consentPolicyVersion.current);form.set('durationSeconds',String(recording.durationMs/1000));
        if(options?.deferTranscription)form.set('deferTranscription','true');
        if(recording.telemetry)form.set('speechTelemetry',JSON.stringify(recording.telemetry));
        const result=await uploadRecording('/api/media',form);
        if(!result.media?.id)throw new Error('녹음 저장을 확인하지 못했어요. 보관한 녹음으로 다시 시도해 주세요.');
        uploadedRecordings.current.set(recording,{mediaId:result.media.id,turnId:current.turnId,generation});
        if(recording.recoveryKey)await removeRecordingRecovery(recording.recoveryKey).catch(()=>{});
        if(mounted)setLocalStatus(options?.deferTranscription?'서버에 저장됨 · 미제출 녹음 원본을 보관했어요.':'서버에 저장됨 · 문장 정리 중');
        return result.media.id;
      },
      async transcribe(mediaId){const result=await post('/api/media',{action:'transcribe',mediaId});if(result.cleanupStatus!=='completed'||!result.transcript?.trim())throw new Error(result.cleanupError||result.pipelineError||result.transcriptionError||'녹음은 저장했어요. 음성 전사를 다시 시도해 주세요.');},
      answer:(mediaId,current,generation)=>post('/api/interviews',{action:'answer_recording',sessionId:id,turnId:current.turnId,mediaId,generation,requestId:mediaId}),
      async finish(){await post('/api/interviews',{action:'finish',sessionId:id});},
      release,wait:()=>new Promise(resolve=>setTimeout(resolve,1200)),
    },next=>{if(mounted)setState(next);});
    controller.current=instance;
    void (async()=>{
      try{
        const current=initialInfo.question,generation=Number(initialInfo.session.data?.generation||0);
        if(current&&studentId){
          const saved=await readRecordingRecovery(recoveryScope(current,generation));
          if(saved?.inUse){if(mounted)setLocalStatus('다른 탭에서 이 질문을 녹음 중이에요. 그 탭에서 마친 뒤 면접을 다시 열어 주세요.');}
          else if(saved&&mounted){
            const restored:LiveAnswerRecording={recoveryKey:saved.key,blob:saved.blob,analysisAudio:saved.analysisAudio,durationMs:saved.durationMs,telemetry:saved.telemetry as LiveAnswerRecording['telemetry'],reason:'interrupted',partial:!saved.complete,speechStarted:true,measurementAvailable:false};
            instance.restoreRecording(restored,current,generation);setLocalStatus('이 기기에서 보관한 답변을 찾았어요. 재생 후 저장하거나 내려받을 수 있어요.');
          }
        }
      }catch{if(mounted)setLocalStatus('기기 임시 저장을 확인하지 못했어요. 글로 답하기를 사용할 수 있어요.');}
      finally{if(mounted)setRecoveryChecked(true);}
    })();
    // Reopened rooms stay quiet until the student's start gesture.
    const pause=()=>instance.pause();
    const visibility=()=>{if(document.visibilityState==='hidden'&&instance.state.phase!=='idle')pause();};
    const suspendOnUnload=()=>{
      if(leaving.current||instance.state.info.session.state!=='active')return;
      pause();void fetch('/api/interviews',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'suspend',sessionId:id}),keepalive:true}).catch(()=>{});
    };
    const beforeUnload=(event:BeforeUnloadEvent)=>{if(!leaving.current&&!['idle','complete'].includes(instance.state.phase)){suspendOnUnload();event.preventDefault();event.returnValue='';}};
    const askLeave=(href:string)=>{if(leaving.current||['idle','complete'].includes(instance.state.phase))return false;pause();setLeaveHref(href);return true;};
    const click=(event:MouseEvent)=>{
      if(event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
      const link=(event.target as Element)?.closest?.('a[href]') as HTMLAnchorElement|null;
      if(!link||link.hasAttribute('download')||link.target&&link.target!=='_self')return;
      const url=new URL(link.href,location.href);if(!['http:','https:'].includes(url.protocol)||url.origin===location.origin&&url.pathname===location.pathname&&url.search===location.search)return;
      if(askLeave(url.href)){event.preventDefault();event.stopPropagation();}
    };
    const navigation=(window as unknown as {navigation?:EventTarget}).navigation;
    const navigate=(event:Event)=>{const nav=event as Event&{navigationType?:string;destination?:{url:string}};if(nav.navigationType==='traverse'&&nav.cancelable&&nav.destination&&askLeave(nav.destination.url))nav.preventDefault();};
    const openAssistant=(event:Event)=>{if(instance.state.info.question&&instance.state.phase!=='complete'){event.preventDefault();setAssistantRequest(value=>({turnId:instance.state.info.question.turnId,token:value.token+1}));}};
    const heartbeat=setInterval(()=>{if(!['idle','paused','error','complete'].includes(instance.state.phase))void post('/api/interviews',{action:'heartbeat',sessionId:id}).catch(()=>pause());},8000);
    document.addEventListener('visibilitychange',visibility);document.addEventListener('click',click,true);window.addEventListener('beforeunload',beforeUnload);window.addEventListener('pagehide',suspendOnUnload);window.addEventListener('gakja:open-on',openAssistant,true);navigation?.addEventListener('navigate',navigate);
    return()=>{mounted=false;clearInterval(heartbeat);document.removeEventListener('visibilitychange',visibility);document.removeEventListener('click',click,true);window.removeEventListener('beforeunload',beforeUnload);window.removeEventListener('pagehide',suspendOnUnload);window.removeEventListener('gakja:open-on',openAssistant,true);navigation?.removeEventListener('navigate',navigate);suspendOnUnload();instance.dispose();controller.current=null;audioOutput.current?.dispose();audioOutput.current=null;audio.current=null;};
  },[id,studentId]);
  useEffect(()=>{if(video.current&&stream.current)video.current.srcObject=stream.current;},[phase,camera]);
  const loadedTextTurn=useRef('');
  useEffect(()=>registerDraftSaver(studentId,async()=>{
    const room=controller.current;
    if(!room||room.state.phase==='complete')return;
    const current=room.state.info.question;
    const generation=Number(room.state.info.session.data.generation||0);
    if(realtime.current)closingForStudent().add(realtime.current);
    const recording=await room.preserveAnswer();
    await writer.current?.flush();
    if(recording?.blob.size){
      const receipt=uploadedRecordings.current.get(recording);
      const onServer=Boolean(receipt?.mediaId&&(!current||receipt.turnId===current.turnId)&&receipt.generation===generation);
      let onDevice=false;
      if(current)try{const saved=await readRecordingRecovery(recoveryScope(current,generation));onDevice=Boolean(saved?.complete&&saved.key===recording.recoveryKey&&saved.blob.size===recording.blob.size);}catch(cause){if(!onServer)throw cause;}
      // A confirmed upload already acknowledges/removes this exact device copy, even while transcription is pending.
      if(!onDevice&&!onServer)throw new Error('녹음 초안 보관을 확인하지 못했어요.');
    }
    if(current){
      const draft=loadedTextTurn.current===current.turnId?textRef.current:String(current.draft||'');
      const key=`gakja-live-text:${studentId}:${id}:${current.turnId}`;
      setDeviceItem(localStorage,key,draft);
      if(localStorage.getItem(key)!==draft)throw new Error('답변 초안 보관을 확인하지 못했어요.');
      try{await post('/api/interviews',{action:'draft',sessionId:id,turnId:current.turnId,draft});}
      catch(cause){
        const fresh=await api(`/api/interviews?id=${id}`);
        if(!fresh.turns?.some((turn:Item)=>turn.id===current.turnId&&turn.answer&&!turn.invalidated))throw cause;
      }
    }
    await post('/api/interviews',{action:'suspend',sessionId:id});
    if((await Promise.all([...closingForStudent()].map(closeRealtime))).some(confirmed=>!confirmed))throw new Error('실시간 음성 연결 종료를 확인하지 못했어요. 다시 시도해 주세요.');
  }),[id,studentId]);
  useEffect(()=>{
    const handoff=(event:Event)=>{if((event as CustomEvent<{userId?:string}>).detail?.userId===studentId)leaving.current=true;};
    window.addEventListener('gakja:logout-ready',handoff);return()=>window.removeEventListener('gakja:logout-ready',handoff);
  },[id,studentId]);
  useEffect(()=>{
    const turnId=question?.turnId;if(!turnId)return;
    let value=question.draft||'';
    try{value=localStorage.getItem(`gakja-live-text:${studentId}:${id}:${turnId}`)??value;}catch{}
    loadedTextTurn.current=turnId;setTextTurn(turnId);setTextAnswer(value);setTextStatus(value?'보관한 초안을 불러왔어요.':'');textRequest.current=null;
  },[id,studentId,question?.turnId]);
  useEffect(()=>{
    if(phase==='complete'||!textMode||!question?.turnId||textTurn!==question.turnId||textBusy)return;
    const turnId=question.turnId,key=`gakja-live-text:${studentId}:${id}:${turnId}`,draft=textAnswer;
    try{setDeviceItem(localStorage,key,draft);setTextStatus('이 기기에 초안 보관됨');}catch{setTextStatus('기기 저장을 확인하지 못했어요. 답변을 보내기 전 화면을 닫지 마세요.');}
    const timer=setTimeout(()=>{void post('/api/interviews',{action:'draft',sessionId:id,turnId,draft}).then(()=>{if(loadedTextTurn.current===turnId&&textRef.current===draft)setTextStatus('초안 저장됨');}).catch(()=>{if(loadedTextTurn.current===turnId)setTextStatus('기기에 보관됨 · 연결 후 다시 저장해 주세요.');});},600);
    return()=>clearTimeout(timer);
  },[id,studentId,question?.turnId,textTurn,textMode,textAnswer,textBusy,phase]);
  useEffect(()=>{if(!state.recording){setDownload('');return;}const url=URL.createObjectURL(state.recording.blob);setDownload(url);return()=>URL.revokeObjectURL(url);},[state.recording]);
  useEffect(()=>{if(phase!=='complete')return;leaving.current=true;void refresh();if(destination.current){const url=new URL(destination.current,location.href);if(url.origin===location.origin)router.push(url.pathname+url.search+url.hash);else location.assign(url.href);}},[phase]);
  useEffect(()=>{if(phase==='error'||phase==='complete')setExiting(false);},[phase]);
  const finish=()=>{if(exiting)return;setExiting(true);destination.current=leaveHref;setLeaveHref(null);setExitOpen(false);setLocalStatus('답변과 녹음 원본의 저장을 확인하고 있어요.');if(textMode){setTextBusy(true);void (async()=>{try{if(question)await post('/api/interviews',{action:'draft',sessionId:id,turnId:question.turnId,draft:textAnswer});const receipt=await post('/api/interviews',{action:'finish',sessionId:id});controller.current?.dispose();setState(previous=>({phase:'complete',info:{...previous.info,session:receipt.session||previous.info.session,report:receipt.report||previous.info.report,question:null},error:''}));}catch(cause){setExiting(false);setState(previous=>({...previous,error:(cause as Error).message}));}finally{setTextBusy(false);}})();}else{if(error)setLocalStatus('녹음 원본은 보관하고, 제출한 답변까지 면접 기록에 남겨요.');else prepareAudio();void controller.current?.finish({preserveOnly:Boolean(error)});}};
  async function switchToText(){let switched=false;setTextBusy(true);try{await controller.current?.preserveAnswer();setTextMode(true);switched=true;}catch(cause){setState(previous=>({...previous,error:(cause as Error).message}));}finally{setTextBusy(false);if(switched)revealTypedAnswer();}}
  async function prepareHelp(){
    const room=controller.current,current=room?.state.info.question;
    if(!room||!current||textBusy||exiting||['saving','recovering','complete'].includes(room.state.phase))return false;
    // pause() retains an in-progress recorder; help must never submit or discard its bytes.
    room.pause();
    const draft=textMode?textRef.current:String(current.draft||'');
    if(textMode)try{setDeviceItem(localStorage,`gakja-live-text:${studentId}:${id}:${current.turnId}`,draft);}catch{}
    await post('/api/interviews',{action:'pause',sessionId:id,turnId:current.turnId,draft});
    if(room.state.info.question?.turnId!==current.turnId)throw new Error('질문이 바뀌었어요. 현재 질문에서 다시 도움받아 주세요.');
    return true;
  }
  async function refreshHelp(){
    const current=question?.turnId,fresh=await api(`/api/interviews?id=${id}`);
    if(current&&fresh.question?.turnId!==current)throw new Error('현재 질문의 도움 기록을 다시 확인해 주세요.');
    setState(previous=>({...previous,info:fresh}));
  }
  async function replaceRecording(){
    if(!consent||preferenceBusy||!question||!window.confirm('이 기기에 보관한 미제출 녹음을 지우고 같은 질문에 다시 답할까요? 필요한 녹음은 먼저 내려받아 주세요. 서버에 저장한 원본은 유지돼요.'))return;
    try{if(state.recording?.recoveryKey)await removeRecordingRecovery(state.recording.recoveryKey);setLocalStatus('새 녹음을 준비해요.');prepareAudio();await controller.current?.rerecord();}catch(cause){setState(previous=>({...previous,error:(cause as Error).message}));}
  }
  async function submitTyped(){
    if(phase==='complete'||!question||!textAnswer.trim()||textBusy)return;
    const current=question,answer=textAnswer;
    if(!textRequest.current||textRequest.current.turnId!==current.turnId||textRequest.current.answer!==answer)textRequest.current={turnId:current.turnId,answer,requestId:crypto.randomUUID()};
    const requestId=textRequest.current!.requestId;let nextQuestion=false;setTextBusy(true);setTextStatus('저장 확인 중');
    try{
      await post('/api/interviews',{action:'resume',sessionId:id,turnId:current.turnId});
      try{await post('/api/interviews',{action:'answer',sessionId:id,turnId:current.turnId,answer,requestId});}
      catch(cause){const receipt=await api(`/api/interviews?id=${id}`);if(!receipt.turns?.some((turn:Item)=>turn.id===current.turnId&&turn.answer&&turn.requestId===requestId))throw cause;}
      let fresh=await api(`/api/interviews?id=${id}`);
      if(!fresh.question&&!fresh.session.data?.processing&&fresh.session.state==='active'){await post('/api/interviews',{action:'finish',sessionId:id});fresh=await api(`/api/interviews?id=${id}`);}
      await controller.current?.acceptTypedAnswer(fresh);
      nextQuestion=Boolean(fresh.question?.turnId&&fresh.question.turnId!==current.turnId);
      try{localStorage.removeItem(`gakja-live-text:${studentId}:${id}:${current.turnId}`);}catch{}
      textRequest.current=null;setTextStatus('답변 저장됨');void refresh();
    }catch(cause){setTextStatus('기기에 보관됨 · 같은 요청으로 다시 저장할 수 있어요.');setState(previous=>({...previous,error:(cause as Error).message}));}
    finally{setTextBusy(false);if(nextQuestion)revealTypedAnswer();}
  }
  const hint=phase==='listening'?progress?.endingSoon?'답변을 마치셨다면 곧 다음 질문으로 넘어가요. 계속 말하면 녹음이 이어져요.':progress&&!progress.measurementAvailable?'자동 음성 감지를 사용할 수 없어요. 말한 뒤 답변 마침을 눌러 주세요.':'말을 마친 뒤 5초 동안 조용하면 자동으로 저장하고 다음 질문으로 넘어가요.':undefined;
  return <div className={ownedClassName(styles.page,true)} data-answer-mode={textMode?'text':'voice'}>
    <Breadcrumb items={settings.trainingPlanId?[{label:'오늘 훈련',href:'/my'},{label:'답변 훈련'}]:[{label:'연습',href:'/learn'},{label:'Live 면접'}]}/>
    <header className={ownedClassName(styles.heading,true)}><div className={ownedClassName(undefined,true)}><span className={ownedClassName(styles.eyebrow,true)}>{settings.trainingPlanId?'오늘 훈련':'모의면접'}</span><h1 className={ownedClassName(undefined,true)}>{trainingLabel}</h1><div className={ownedClassName(styles.meta,true)}><span className={ownedClassName(undefined,true)}>{targetName(info.session.supportTarget)} {info.session.supportTarget?.department}</span><span className={ownedClassName(undefined,true)}>답변 {turns.length}개 저장</span>{info.session.practiceLabel&&<span className={ownedClassName(undefined,true)}>{info.session.practiceLabel}</span>}</div>{settings.practiceScope==='personal_record'&&settings.practiceNotice&&<p className={ownedClassName(styles.note,true)}>{settings.practiceNotice}</p>}</div>{started&&phase!=='complete'&&<button className={ownedClassName("button secondary",true)} disabled={exiting} onClick={()=>{controller.current?.pause();setExitOpen(true);}}><Square size={15}/>{settings.trainingPlanId?'훈련 종료':'면접 종료'}</button>}</header>
    {error&&<div className={ownedClassName(styles.error,true)} role="alert">{error}{camera&&!stream.current&&<button className={ownedClassName("button secondary",true)} disabled={!consent||preferenceBusy} onClick={()=>{void (async()=>{if(await saveRecordingSettings({liveCameraEnabled:false}))begin();})();}}>카메라 없이 계속</button>}{download&&<div className={ownedClassName(undefined,true)}><a className={ownedClassName("text-link",true)} href={download} download={`live-answer.${state.recording?.blob.type.includes('mp4')?'mp4':'webm'}`}><Download size={15}/>보관한 녹음 내려받기</a></div>}</div>}
    {localStatus&&<p className={ownedClassName(styles.note,true)} role="status">{localStatus}</p>}
    {realtimeNotice&&<p className={ownedClassName(styles.note,true)} role="status">{realtimeNotice}</p>}
    {realtimePreview&&phase!=='complete'&&<aside className={ownedClassName(styles.liveCaption,true)} aria-label="음성 자막 미리보기"><div className={ownedClassName(undefined,true)}><span className={ownedClassName(undefined,true)}>자막 미리보기</span><InfoTip label="실시간 자막과 저장 답변 안내">이 자막은 미리보기예요. 녹음 원본을 저장하고 기존 전사·문장 정리를 확인한 뒤에만 답변과 준비 현황에 반영돼요.</InfoTip></div><p className={ownedClassName(undefined,true)}>{realtimePreview}</p></aside>}
    {download&&<div className={ownedClassName(styles.recovery,true)}><strong className={ownedClassName(undefined,true)}>보관한 답변 · {Math.round((state.recording?.durationMs||0)/1000)}초</strong>{state.recording?.blob.type.startsWith('video')?<video src={download} controls playsInline className={ownedClassName(undefined,true)}/>:<audio src={download} controls className={ownedClassName(undefined,true)}/>}<a className={ownedClassName("text-link",true)} href={download} download="live-answer.webm">보관한 녹음 내려받기</a><p className={ownedClassName(styles.note,true)}>이 기기의 미제출 녹음은 7일 동안 보관해요. 서버 저장이 확인되면 기기 사본을 지워요.</p></div>}
    {countdown>0&&<div className={ownedClassName(styles.ready,true)} role="status">마이크 연결됨 · {countdown}초 뒤 답변 녹음을 시작해요.<button className={ownedClassName("button secondary",true)} onClick={()=>skipReady.current?.()}>준비 시간 건너뛰기</button><button className={ownedClassName("text-link",true)} onClick={()=>controller.current?.pause()}>잠깐 대기</button></div>}
    {exiting&&<p role="status" className={ownedClassName(styles.note,true)}>저장을 확인하는 중이에요. AI 피드백은 저장 후 정리해요.</p>}{phase==='complete'?<section className={ownedClassName(styles.complete,true)}><Check size={32}/><h2 className={ownedClassName(undefined,true)}>{diagnostic?'진단 답변을 저장했어요':'여기까지 저장했어요'}</h2><p className={ownedClassName(undefined,true)}>답변 {turns.length}개를 기록했어요. {settings.trainingProgress?.allRootsAnswered===false?'답하지 않은 질문은 미확인으로 남아요.':'저장한 답변에서 보완할 내용을 확인해 보세요.'}</p><div className={ownedClassName(styles.actions,true)}>{info.report?.id&&<Link className={ownedClassName("button primary")} href={`/records/reports/${info.report.id}`}>면접 리포트 보기</Link>}<Link className={ownedClassName("button secondary")} href={settings.trainingPlanId?"/my":"/learn"}>{settings.trainingPlanId?"오늘 훈련으로":"연습으로 돌아가기"}</Link></div></section>:<div className={ownedClassName(styles.workspace,true)}>
      <LiveInterviewerStage diagnostic={diagnostic} answerMode={textMode?'text':'voice'} avatarSignal={avatarSignal.current} people={people} speakerId={question?.speakerId} phase={phase} question={question?.prompt} questionNumber={Number(question?.rootIndex??settings.index??0)+1} questionCount={settings.questionCount} questionKind={question?.questionKind} statusText={diagnostic&&textMode?'생각나는 내용부터 적어 주세요. 답변하지 않은 질문은 미확인으로 남아요.':hint} answerSeconds={progress?progress.durationMs/1000:undefined}/>
      {textMode&&question&&<section className={ownedClassName(styles.typedAnswer,true)} data-live-typed-answer aria-label="같은 질문에 글로 답하기"><h2 className={ownedClassName(undefined,true)}>같은 질문에 글로 답하기</h2><p className={ownedClassName(styles.note+' '+styles.typedIntro,true)}>현재 학교와 질문을 그대로 이어가요. 작성한 글은 초안으로 보관하고, 보낸 답변만 학습 기록에 남겨요.</p><ChatComposer enterToSend={appData?.preferences?.enterToSend!==false} inputId="live-text-answer" label="글 답변" value={textAnswer} onChange={value=>{textRef.current=value;setTextAnswer(value);}} onSend={()=>void submitTyped()} maxLength={12000} busy={textBusy} disabled={textBusy} sendLabel="글 답변 보내기" placeholder="나의 행동을 한 문장으로 시작해 보세요." showCount/><p className={ownedClassName(styles.note,true)} role="status">{textStatus}</p></section>}
      <aside className={ownedClassName(styles.cameraPanel,true)} aria-label="내 면접 상태"><h2 className={ownedClassName(undefined,true)}>{textMode?'현재 답변 방식':'내 면접 화면'}</h2>{camera&&started&&!textMode&&stream.current?<video ref={video} className={ownedClassName(styles.cameraVideo,true)} autoPlay playsInline muted aria-label="내 카메라 미리보기"/>:<div className={ownedClassName(styles.cameraPlaceholder,true)}>{camera&&!textMode?<Camera size={24}/>:<Mic size={24}/>}<span className={ownedClassName(undefined,true)}>{textMode?'같은 질문에 글로 답하고 있어요.':camera?'시작하면 내 모습을 확인할 수 있어요.':'카메라 없이 목소리로 면접해요.'}</span></div>}
        <div className={ownedClassName(styles.controls,true)}>
          <details className={ownedClassName(styles.recordingSettings,true)} open={!consent||recordingSettingsOpen} onToggle={event=>setRecordingSettingsOpen(event.currentTarget.open)}><summary className={ownedClassName(undefined,true)}><span className={ownedClassName(undefined,true)}>녹음 설정</span><span className={ownedClassName(undefined,true)}>{preferenceBusy?'저장 중':consent?'설정됨':'처음 한 번 설정'}</span></summary><div className={ownedClassName(styles.recordingSettingsBody,true)}>
            <label className={ownedClassName(styles.consent,true)}><span className={ownedClassName(undefined,true)}>음성·영상 저장과 답변 전사에 동의해요.</span><span className={ownedClassName("motion-toggle-field",true)}><input className={ownedClassName("motion-toggle-input",true)} type="checkbox" checked={consent} disabled={preferenceBusy||active} onChange={event=>void saveRecordingSettings({liveRecordingConsent:event.target.checked})}/><span className={ownedClassName("motion-toggle-track",true)} aria-hidden="true"><span className={ownedClassName("motion-toggle-thumb",true)}/></span></span></label>
            <label className={ownedClassName(styles.consent,true)}><span className={ownedClassName(undefined,true)}>카메라 함께 사용</span><span className={ownedClassName("motion-toggle-field",true)}><input className={ownedClassName("motion-toggle-input",true)} type="checkbox" checked={camera} disabled={preferenceBusy||active} onChange={event=>void saveRecordingSettings({liveCameraEnabled:event.target.checked})}/><span className={ownedClassName("motion-toggle-track",true)} aria-hidden="true"><span className={ownedClassName("motion-toggle-thumb",true)}/></span></span></label>
            <Link href="/privacy" className={ownedClassName("text-link")}>개인정보 처리방침 · 녹음·AI 처리 안내</Link><div className={ownedClassName(styles.settingsHelp,true)}><span className={ownedClassName(undefined,true)}>계정에 저장됨</span><InfoTip label="녹음 설정과 권한 안내">동의와 카메라 선택은 다음 면접에도 유지돼요. 마이크 연결은 면접 시작을 눌렀을 때 확인하며, 브라우저가 요청하는 권한은 직접 허용해야 해요. 녹음은 비공개로 저장되고 AI 전사·피드백에 사용돼요. 일시정지 후 동의를 끌 수 있으며, 이미 저장한 답변은 유지돼요.</InfoTip></div>
          </div></details>
          {preferenceError&&<p className={ownedClassName(styles.error,true)} role="alert">{preferenceError}</p>}
          {phase==='idle'&&!textMode&&<button className={ownedClassName("button primary",true)} disabled={!consent||!recoveryChecked||preferenceBusy} onClick={begin}><Play size={16}/>{state.recording?'보관한 답변 저장하고 계속':'면접 시작'}</button>}
          {(phase==='paused'||phase==='error')&&!textMode&&<button className={ownedClassName("button primary",true)} disabled={!consent||!recoveryChecked||preferenceBusy} onClick={begin}><Play size={16}/>{state.recording?state.recording.measurementAvailable&&!state.recording.speechStarted&&state.recording.reason!=='manual'?'같은 질문에 다시 답하기':'보관한 답변 저장하고 계속':'계속하기'}</button>}
          {(phase==='error'||phase==='idle'&&state.recording)&&question&&<button className={ownedClassName("button secondary",true)} disabled={!consent||preferenceBusy} onClick={()=>{if(preferenceBusy)return;if(state.recording)void replaceRecording();else if(consent){prepareAudio();void controller.current?.rerecord();}}}>같은 질문 다시 녹음</button>}
          {active&&<button className={ownedClassName("button secondary",true)} onClick={()=>controller.current?.pause()}><Pause size={16}/>일시정지</button>}
          {phase==='listening'&&<><button className={ownedClassName("text-link",true)} onClick={()=>controller.current?.finishAnswer()}>답변 마침</button><button className={ownedClassName("text-link",true)} onClick={()=>{thinkingUntil.current=Date.now()+30000;setLocalStatus('30초 동안 자동 마침을 기다려요. 준비되면 말하거나 답변 마침을 눌러 주세요.');}}>잠깐 생각할게요</button></>}
          {question&&!textMode&&<button className={ownedClassName("button secondary",true)} disabled={textBusy||phase==='saving'||phase==='recovering'} onClick={()=>void switchToText()}>이번 질문은 글로 답하기</button>}
          {question&&<LearningHelp key={question.turnId} interviewSessionId={id} interviewTurnId={question.turnId} targetId={settings.context?.targetId||info.session.target_id} sourceVersion={settings.context?.contentVersion} questionPrompt={question.prompt} answerDraft={textMode?textAnswer:question.draft} openRequest={assistantRequest.turnId===question.turnId?assistantRequest.token:0} beforeOpen={prepareHelp} onAssisted={refreshHelp} onClose={()=>{if(textMode)revealTypedAnswer();}} showEvidence={false} disabled={textBusy||exiting||phase==='saving'||phase==='recovering'}/>}
          {textMode&&<><button className={ownedClassName("text-link",true)} disabled={textBusy||Boolean(textAnswer.trim())||!consent||preferenceBusy} onClick={begin}>{diagnostic?'음성으로 답하기':'음성 면접으로 돌아가기'}</button>{!consent&&<p className={ownedClassName(styles.note,true)}>음성으로 바꾸려면 위에서 저장·전사 동의를 선택해 주세요.</p>}</>}
          {!textMode&&<div className={ownedClassName(styles.voiceHelp,true)}><InfoTip label="음성 답변 사용 안내">한 답변은 최대 3분이에요. 말을 마친 뒤 5초 동안 조용하면 자동 저장돼요. 이어폰을 사용하면 질문 소리가 녹음에 섞이는 것을 줄일 수 있어요. 면접 종료로 언제든 마칠 수 있어요.</InfoTip></div>}
        </div>
      </aside>
    </div>}
    {turns.length>0&&!(phase==='complete'&&onTrainingUpdate)&&<details className={ownedClassName(styles.history,true)}><summary className={ownedClassName(undefined,true)}>저장한 답변 {turns.length}개 보기</summary>{turns.map(turn=><article key={turn.id} className={ownedClassName(styles.historyItem,true)}><h3 className={ownedClassName(undefined,true)}>{turn.question}</h3><p className={ownedClassName(undefined,true)}>{turn.answer}</p><small className={ownedClassName(undefined,true)}>{turn.submissionSource==='recording'||turn.speechSource?'음성 답변 · 자동 전사':'글 답변'}</small></article>)}</details>}
    {(exitOpen||leaveHref)&&<Modal title="여기까지 면접을 마칠까요?" onClose={()=>{setExitOpen(false);setLeaveHref(null);begin();}}><p className={ownedClassName(undefined,true)}>{error&&!textMode?'녹음 원본은 보관하고 제출한 답변까지 저장해요. 전사를 마치지 못한 녹음은 답변 수에 포함하지 않아요.':'진행 중인 답변과 지금까지의 기록을 저장한 뒤 면접을 마쳐요.'}</p><div className={ownedClassName('inline-actions '+styles.actions,true)}><button className={ownedClassName("button secondary",true)} onClick={()=>{setExitOpen(false);setLeaveHref(null);begin();}}>면접 계속하기</button><button className={ownedClassName('button primary '+styles.finishButton,true)} data-single-line onClick={finish}>저장 후 종료</button></div></Modal>}
  </div>;
}
