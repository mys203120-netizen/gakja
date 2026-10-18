'use client';
import Link from 'next/link';
import {useEffect, useRef, useState} from 'react';
import {useRouter} from 'next/navigation';
import {Camera, Check, Download, Mic, Pause, Play, Square} from 'lucide-react';
import {useApp} from './app-shell';
import {api, post, Breadcrumb, Modal, targetName, type Item} from './shared';
import {LiveInterviewerStage} from './live-interviewer-stage';
import {LiveInterviewController, type LiveSnapshot} from '@/lib/client/live-interview-controller';
import {createLiveAnswerCapture} from '@/lib/client/live-interview-recorder';
import {uploadRecording} from '@/lib/recording-upload-client';
import styles from './live-interview-session.module.css';

// Reuse the gesture-unlocked audio element for every interviewer question (including Safari).
const SILENT_WAV='data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEARKwAAESsAAABAAgAZGF0YQEAAACA';

export function LiveInterviewSession({id,initialInfo}:{id:string;initialInfo:Item}){
  const router=useRouter();const {refresh}=useApp();
  const [state,setState]=useState<LiveSnapshot>({phase:initialInfo.session.state==='completed'?'complete':'idle',info:initialInfo,error:''});
  const [consent,setConsent]=useState(false),[camera,setCamera]=useState(true),[leaveHref,setLeaveHref]=useState<string|null>(null),[exitOpen,setExitOpen]=useState(false),[download,setDownload]=useState('');
  const controller=useRef<LiveInterviewController|null>(null),stream=useRef<MediaStream|null>(null),video=useRef<HTMLVideoElement|null>(null),audio=useRef<HTMLAudioElement|null>(null);
  const cameraChoice=useRef(camera),leaving=useRef(false),destination=useRef<string|null>(null);cameraChoice.current=camera;
  const {phase,info,error,progress}=state;const settings=info.session.data||{},question=info.question;
  const turns:Item[]=(info.turns||[]).filter((turn:Item)=>turn.answer&&!turn.invalidated);
  const people=settings.panelists?.length?settings.panelists:[{id:'A',name:'면접관 A',gender:'female'},{id:'B',name:'면접관 B',gender:'male'}];
  const started=!['idle','complete'].includes(phase),active=!['idle','paused','error','complete'].includes(phase);
  const prepareAudio=()=>{audio.current??=new Audio();audio.current.src=SILENT_WAV;void audio.current.play().catch(()=>{});};
  function begin(){if(!consent)return;prepareAudio();void controller.current?.start();}
  useEffect(()=>{
    let mounted=true;
    const roomSuspension=initialInfo.session.state==='active'?post('/api/interviews',{action:'suspend',sessionId:id}):Promise.resolve();
    void roomSuspension.catch(()=>{});
    const release=()=>{stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;audio.current?.pause();};
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
      mute(paused){stream.current?.getTracks().forEach(track=>{track.enabled=!paused;});},
      async suspend(){await post('/api/interviews',{action:'suspend',sessionId:id});},
      async resume(){await post('/api/interviews',{action:'resume',sessionId:id});},
      async speak(current,generation,signal){
        const response=await fetch('/api/media',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'speech',sessionId:id,questionId:current.id,turnId:current.turnId,generation}),signal});
        if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.error||'질문 음성을 준비하지 못했어요. 다시 연결해서 계속해 주세요.');}
        const blob=await response.blob();if(signal.aborted)throw new DOMException('일시정지','AbortError');
        const player=audio.current??(audio.current=new Audio()),url=URL.createObjectURL(blob);
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
      capture(onProgress){if(!stream.current)throw new Error('마이크가 연결되지 않았어요.');return createLiveAnswerCapture(stream.current,{onProgress});},
      async upload(recording,current,generation){
        const form=new FormData(),extension=recording.blob.type.includes('mp4')?'mp4':'webm';
        form.set('recording',recording.blob,`answer.${extension}`);
        if(recording.analysisAudio)form.set('analysisAudio',recording.analysisAudio,recording.analysisAudio.type.includes('mp4')?'answer-audio.mp4':'answer-audio.webm');
        form.set('sessionId',id);form.set('questionId',current.id);form.set('turnId',current.turnId);form.set('generation',String(generation));form.set('consent','true');form.set('durationSeconds',String(recording.durationMs/1000));
        if(recording.telemetry)form.set('speechTelemetry',JSON.stringify(recording.telemetry));
        const result=await uploadRecording('/api/media',form);
        if(!result.media?.id)throw new Error('녹음 저장을 확인하지 못했어요. 보관한 녹음으로 다시 시도해 주세요.');
        return result.media.id;
      },
      async transcribe(mediaId){const result=await post('/api/media',{action:'transcribe',mediaId});if(result.cleanupStatus!=='completed'||!result.transcript?.trim())throw new Error(result.cleanupError||result.pipelineError||result.transcriptionError||'녹음은 저장했어요. 음성 전사를 다시 시도해 주세요.');},
      answer:(mediaId,current,generation)=>post('/api/interviews',{action:'answer_recording',sessionId:id,turnId:current.turnId,mediaId,generation,requestId:mediaId}),
      async finish(){await post('/api/interviews',{action:'finish',sessionId:id});},
      release,wait:()=>new Promise(resolve=>setTimeout(resolve,1200)),
    },next=>{if(mounted)setState(next);});
    controller.current=instance;
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
    const openAssistant=(event:Event)=>{if(!['idle','complete'].includes(instance.state.phase)){event.preventDefault();pause();}};
    const heartbeat=setInterval(()=>{if(!['idle','paused','error','complete'].includes(instance.state.phase))void post('/api/interviews',{action:'heartbeat',sessionId:id}).catch(()=>pause());},8000);
    document.addEventListener('visibilitychange',visibility);document.addEventListener('click',click,true);window.addEventListener('beforeunload',beforeUnload);window.addEventListener('pagehide',suspendOnUnload);window.addEventListener('gakja:open-on',openAssistant,true);navigation?.addEventListener('navigate',navigate);
    return()=>{mounted=false;clearInterval(heartbeat);document.removeEventListener('visibilitychange',visibility);document.removeEventListener('click',click,true);window.removeEventListener('beforeunload',beforeUnload);window.removeEventListener('pagehide',suspendOnUnload);window.removeEventListener('gakja:open-on',openAssistant,true);navigation?.removeEventListener('navigate',navigate);suspendOnUnload();instance.dispose();controller.current=null;};
  },[id]);
  useEffect(()=>{if(video.current&&stream.current)video.current.srcObject=stream.current;},[phase,camera]);
  useEffect(()=>{if(!state.recording){setDownload('');return;}const url=URL.createObjectURL(state.recording.blob);setDownload(url);return()=>URL.revokeObjectURL(url);},[state.recording]);
  useEffect(()=>{if(phase!=='complete')return;leaving.current=true;void refresh();if(destination.current){const url=new URL(destination.current,location.href);if(url.origin===location.origin)router.push(url.pathname+url.search+url.hash);else location.assign(url.href);}},[phase]);
  const finish=()=>{destination.current=leaveHref;setLeaveHref(null);setExitOpen(false);prepareAudio();void controller.current?.finish();};
  const hint=phase==='listening'?progress?.endingSoon?'답변을 마치셨다면 곧 다음 질문으로 넘어가요. 계속 말하면 녹음이 이어져요.':progress&&!progress.measurementAvailable?'자동 음성 감지를 사용할 수 없어요. 말한 뒤 답변 마침을 눌러 주세요.':'말을 마친 뒤 5초 동안 조용하면 자동으로 저장하고 다음 질문으로 넘어가요.':undefined;
  return <div className={styles.page}>
    <Breadcrumb items={[{label:'연습',href:'/learn'},{label:'Live 면접'}]}/>
    <header className={styles.heading}><div><span className={styles.eyebrow}>모의면접</span><h1>Live 면접</h1><div className={styles.meta}><span>{targetName(info.session.supportTarget)} {info.session.supportTarget?.department}</span><span>답변 {turns.length}개 저장</span>{info.session.practiceLabel&&<span>{info.session.practiceLabel}</span>}</div>{settings.practiceScope==='personal_record'&&settings.practiceNotice&&<p className={styles.note}>{settings.practiceNotice}</p>}</div>{started&&phase!=='complete'&&<button className="button secondary" onClick={()=>{controller.current?.pause();setExitOpen(true);}}><Square size={15}/>면접 종료</button>}</header>
    {error&&<div className={styles.error} role="alert">{error}{download&&<div><a className="text-link" href={download} download={`live-answer.${state.recording?.blob.type.includes('mp4')?'mp4':'webm'}`}><Download size={15}/>보관한 녹음 내려받기</a></div>}</div>}
    {phase==='complete'?<section className={styles.complete}><Check size={32}/><h2>면접을 마쳤어요</h2><p>질문 {turns.length}개에 답한 내용을 저장했어요. 리포트에서 피드백을 확인해 보세요.</p><div className={styles.actions}>{info.report?.id&&<Link className="button primary" href={`/records/reports/${info.report.id}`}>면접 리포트 보기</Link>}<Link className="button secondary" href="/learn">연습으로 돌아가기</Link></div></section>:<div className={styles.workspace}>
      <LiveInterviewerStage people={people} speakerId={question?.speakerId} phase={phase} question={question?.prompt} questionNumber={Number(question?.rootIndex??settings.index??0)+1} questionCount={settings.questionQueue?.length} questionKind={question?.questionKind} statusText={hint} answerSeconds={progress?progress.durationMs/1000:undefined}/>
      <aside className={styles.cameraPanel} aria-label="내 면접 상태"><h2>내 면접 화면</h2>{camera&&started?<video ref={video} className={styles.cameraVideo} autoPlay playsInline muted aria-label="내 카메라 미리보기"/>:<div className={styles.cameraPlaceholder}>{camera?<Camera size={24}/>:<Mic size={24}/>}<span>{camera?'시작하면 내 모습을 확인할 수 있어요.':'카메라 없이 목소리로 면접해요.'}</span></div>}
        <div className={styles.controls}>
          {(phase==='idle'||phase==='error'&&!stream.current)&&<><label className={styles.consent}><input type="checkbox" checked={camera} onChange={event=>setCamera(event.target.checked)}/>카메라 함께 사용</label><label className={styles.consent}><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/>음성·영상 저장과 답변 전사에 동의해요.</label></>}
          {phase==='idle'&&<button className="button primary" disabled={!consent} onClick={begin}><Play size={16}/>면접 시작</button>}
          {(phase==='paused'||phase==='error')&&<button className="button primary" disabled={!consent} onClick={begin}><Play size={16}/>{state.recording?state.recording.measurementAvailable&&!state.recording.speechStarted&&state.recording.reason!=='manual'?'같은 질문에 다시 답하기':'보관한 답변 저장하고 계속':'계속하기'}</button>}
          {phase==='error'&&question&&<button className="button secondary" disabled={!consent} onClick={()=>{if(consent){prepareAudio();void controller.current?.rerecord();}}}>같은 질문 다시 녹음</button>}
          {active&&<button className="button secondary" onClick={()=>controller.current?.pause()}><Pause size={16}/>일시정지</button>}
          {phase==='listening'&&<button className="text-link" onClick={()=>controller.current?.finishAnswer()}>답변 마침</button>}
          <p className={styles.note}>질문을 들은 뒤 편하게 답하세요. 면접관이 번갈아 질문하고 답변은 자동으로 저장돼요.</p><p className={styles.note}>한 답변은 최대 3분이에요. 이어폰을 사용하면 질문 소리가 녹음에 섞이는 것을 줄일 수 있어요.</p>
        </div>
      </aside>
    </div>}
    {turns.length>0&&<details className={styles.history}><summary>저장한 답변 {turns.length}개 보기</summary>{turns.map(turn=><article key={turn.id} className={styles.historyItem}><h3>{turn.question}</h3><p>{turn.answer}</p><small>{turn.submissionSource==='recording'||turn.speechSource?'음성 답변 · 자동 전사':'저장한 답변'}</small></article>)}</details>}
    {(exitOpen||leaveHref)&&<Modal title="여기까지 면접을 마칠까요?" onClose={()=>{setExitOpen(false);setLeaveHref(null);begin();}}><p>진행 중인 답변과 지금까지의 기록을 저장한 뒤 면접을 마쳐요.</p><div className={styles.actions}><button className="button secondary" onClick={()=>{setExitOpen(false);setLeaveHref(null);begin();}}>면접 계속하기</button><button className="button primary" onClick={finish}>여기까지 저장하고 종료</button></div></Modal>}
  </div>;
}
