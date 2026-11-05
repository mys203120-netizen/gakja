'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Clock3, MessageSquare, Play, RotateCcw, X, CircleAlert, LoaderCircle, Pause } from 'lucide-react';
import { useAudioDevices } from '@/hooks/useAudioDevices';
import { useInterviewSession, type Phase } from '@/hooks/useInterviewSession';
import { useSpeechMetrics } from '@/hooks/useSpeechMetrics';
import { useFaceMetrics } from '@/hooks/useFaceMetrics';
import { shouldSubmitSpace } from '@/lib/interview/timing';
import { browserInterruptionAction, requestConfirmedFullscreen } from '@/lib/interview/startup-flow';
import { InterviewerScene } from './InterviewerScene';
import { sceneStateForPhase } from '@/lib/live2d/phase';
import { QuestionCard } from './QuestionCard';
import { ConversationDrawer } from './ConversationDrawer';
import { SelfCameraPreview } from './SelfCameraPreview';
import { DeviceControls } from './DeviceControls';
import { InterviewStartCountdown, StartPreparationPanel } from './StartPreparationPanel';
import sceneStyles from './SceneInterview.module.css';

const labels: Record<Phase, string> = { idle: '', device_check: '', countdown: '', preparing: '면접을 준비하고 있어요', speaking_question: '질문을 듣는 중', listening: '답변 중', finalizing_transcript: '답변을 확인하고 있어요', preparing_next: '다음 질문을 준비하고 있어요', speaking_acknowledgement: '면접관의 이야기를 듣는 중', suspended: '잠시 멈추어도 괜찮아요', ending: '면접 기록을 저장하고 있어요', completed: '오늘의 면접을 마쳤어요', error: '잠시 확인이 필요해요' };
export function InterviewShell() {
  const shellRef = useRef<HTMLDivElement>(null), videoRef = useRef<HTMLVideoElement>(null);
  const media = useAudioDevices();
  const metricsSnapshot = useRef<() => unknown>(() => ({})), speechReset = useRef<() => void>(() => {});
  const session = useInterviewSession(media, () => metricsSnapshot.current(), () => speechReset.current());
  const speech = useSpeechMetrics(media.micStream, session.phase === 'listening' || session.capturingTail);
  const face = useFaceMetrics(videoRef, media.cameraEnabled, session.phase, session.visibleTurn?.id ?? null);
  metricsSnapshot.current = () => ({ speech: speech.snapshot(), vision: face.snapshot() }); speechReset.current = speech.reset;
  const [drawer, setDrawer] = useState(false), [unread, setUnread] = useState(0), [confirmEnd, setConfirmEnd] = useState(false);
  const [fullscreenError, setFullscreenError] = useState('');
  const requestedFullscreen = useRef(false), priorMessageCount = useRef(0), explicitlyEnding = useRef(false);
  const cancelEndRef = useRef<HTMLButtonElement>(null);
  const preparation = session.preparation;
  const enterFullscreen = useCallback(() => {
    setFullscreenError('');
    requestedFullscreen.current = true;
    const requested = requestConfirmedFullscreen(shellRef.current, document);
    const unlocked = media.unlock();
    return Promise.all([requested, unlocked]).then(() => true).catch(() => { setFullscreenError('전체화면을 허용한 뒤 이어하기를 다시 눌러 주세요.'); return false; });
  }, [media]);
  const start = () => { requestedFullscreen.current = false; setFullscreenError(''); face.reset(); session.prepareDevices(); };
  const resume = () => { void enterFullscreen().then(inside => { if (inside) void session.resume(); }); };
  useEffect(() => {
    const onFullscreen = () => {
      const inside = document.fullscreenElement === shellRef.current;
      const action = browserInterruptionAction(session.phase);
      if (!inside && action === 'return_to_check') session.interruptStartup();
      else if (!inside && requestedFullscreen.current && action === 'pause') session.pause();
    };
    const onVisibility = () => { if (!document.hidden) return; const action = browserInterruptionAction(session.phase); if (action === 'return_to_check') session.interruptStartup(); else if (action === 'pause') session.pause(); };
    document.addEventListener('fullscreenchange', onFullscreen); document.addEventListener('visibilitychange', onVisibility);
    return () => { document.removeEventListener('fullscreenchange', onFullscreen); document.removeEventListener('visibilitychange', onVisibility); };
  }, [session]);
  useEffect(() => {
    if (document.fullscreenElement === shellRef.current) return;
    const action = browserInterruptionAction(session.phase);
    if (action === 'return_to_check') session.interruptStartup();
    else if (action === 'pause' && requestedFullscreen.current && document.fullscreenEnabled) session.pause();
  }, [session]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (shouldSubmitSpace(event, session.phase)) { event.preventDefault(); void session.submit('space'); } };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [session]);
  useEffect(() => {
    if (session.messages.length > priorMessageCount.current && !drawer && session.messages.at(-1)?.role === 'candidate') setUnread(v => v + 1);
    priorMessageCount.current = session.messages.length;
    if (drawer) setUnread(0);
  }, [drawer, session.messages]);
  useEffect(() => { if (confirmEnd) cancelEndRef.current?.focus(); }, [confirmEnd]);
  useEffect(() => {
    if (session.phase === 'completed' && explicitlyEnding.current && document.fullscreenElement) { explicitlyEnding.current = false; void document.exitFullscreen(); }
  }, [session.phase]);
  const readyMode = ['idle', 'device_check', 'countdown', 'preparing'].includes(session.phase);
  const processing = ['preparing', 'finalizing_transcript', 'preparing_next', 'ending'].includes(session.phase);
  const mm = String(Math.floor(session.remainingSeconds / 60)).padStart(2, '0'), ss = String(session.remainingSeconds % 60).padStart(2, '0');
  const retryEvaluation = async () => {
    if (session.sessionId) await fetch(`/api/sessions/${encodeURIComponent(session.sessionId)}/retry-evaluation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  };
  return <div ref={shellRef} className={`interview-shell ${sceneStyles.layout} ${drawer ? 'drawer-open' : ''}`}>
    <main className="interview-stage">
      <header className="room-header"><div className="room-name"><span className="room-mark"><span /><span /></span><span>실전 모의면접</span><span className="header-separator" /><span className="private-label">면접 연습실</span></div><div className="room-meta">{!readyMode && <span className="compact-target">서울시립대학교 · 융합응용화학과</span>}<span className={`timer ${session.remainingSeconds < 60 ? 'time-low' : ''}`}><Clock3 size={14} /><span>{mm}<i>:</i>{ss}</span></span></div></header>
      <QuestionCard turn={session.visibleTurn} phase={session.phase} endingRequested={session.endingRequested} preparation={preparation} loadingError={session.preparationError} refresh={() => void session.refreshPreparation()} micReady={media.micEnabled} cameraReady={media.cameraEnabled} />
      {!drawer && <div className="conversation-toggle-wrap"><button className="conversation-toggle" aria-label="실시간 대화 열기" aria-expanded={false} onClick={() => { setDrawer(true); setUnread(0); }}><MessageSquare size={20} />{unread > 0 && <span className="unread-dot">{unread}</span>}</button></div>}
      <section className={`center-stage ${readyMode ? 'is-ready' : ''}`} aria-label="면접 진행">
        <InterviewerScene state={sceneStateForPhase(session.phase, session.activeSpeech)} identity={session.activeSpeech} audio={media.audio} outputAnalyser={media.outputAnalyser} />
        <div className="center-copy">{session.phase !== 'idle' && <div className={`phase-label ${session.phase === 'listening' ? 'candidate-label' : ''}`}>{processing && <LoaderCircle size={13} className="spinning" />}{session.phase === 'suspended' && <Pause size={13} />}{labels[session.phase]}</div>}
          {session.phase === 'idle' && <button className="primary-button start-button" onClick={start} disabled={!preparation?.ready}><Play size={15} /> 면접 준비하기</button>}
          {processing && <><h2>{session.phase === 'preparing' ? '차분히 호흡을 가다듬어 주세요.' : '잠시만 기다려 주세요.'}</h2><p>화면을 떠나지 않아도 괜찮아요.</p></>}
          {session.phase === 'listening' && <><div className="answer-action"><button className="primary-button" onClick={() => void session.submit()}>다 말했어요 <Check size={17} /></button><span><kbd>Space</kbd> 로도 제출할 수 있어요</span></div>{!media.micEnabled && <button className="inline-recovery" onClick={() => void media.toggleMic().catch(() => {})}>마이크가 꺼져 있어요 · 다시 켜기</button>}{session.finishAfterAnswer && <p className="finish-hint">시간이 다 되었어요. 지금 답변을 마치면 면접이 종료됩니다.</p>}</>}
          {(session.phase === 'speaking_question' || session.phase === 'speaking_acknowledgement') && <><h2>질문에 귀 기울여 주세요.</h2><p>면접관의 음성이 끝나면 답변할 수 있어요.</p><button className="text-button" onClick={session.pause}><Pause size={13} /> 잠시 멈추기</button></>}
          {session.phase === 'suspended' && <><h2>면접이 일시 중단되었습니다.</h2><p>지금까지의 질문과 답변은 그대로 남아 있어요.</p><button className="primary-button" onClick={resume}><Play size={16} /> 전체화면으로 이어하기</button></>}
          {session.phase === 'error' && <><h2>진행을 잠시 멈추었어요.</h2><p className="session-error">{session.error}</p>{session.questionRecoveryRequiresEnd ? <button className="primary-button" onClick={() => void session.end()}>기록 저장하고 마치기</button> : <button className="primary-button" onClick={() => { void enterFullscreen().then(inside => { if (inside) session.retry(); }); }}><RotateCcw size={15} /> 다시 시도</button>}</>}
          {session.phase === 'completed' && <><h2>수고하셨습니다, 윤지우 님.</h2><p>{session.evaluationStatus === 'completed' ? '면접 기록과 평가 결과가 안전하게 저장되었어요.' : session.evaluationStatus === 'failed' || session.evaluationStatus === 'error' ? '면접 기록은 저장되었어요. 평가를 다시 준비할 수 있어요.' : '면접 기록을 바탕으로 평가를 준비하고 있어요.'}</p>{(session.evaluationStatus === 'failed' || session.evaluationStatus === 'error') && <button className="text-button" onClick={() => void retryEvaluation()}>평가 다시 준비하기</button>}<button className="primary-button" onClick={() => { session.reset(); face.reset(); }}><RotateCcw size={16} /> 다시 준비하기</button></>}
        </div>
      </section>
      {fullscreenError && <div className="fullscreen-notice"><CircleAlert size={14} /><span>{fullscreenError}</span></div>}
      {media.error && <div className="device-error" role="status"><CircleAlert size={15} /><span>{media.error}</span><button className="icon-button" onClick={() => media.setError('')} aria-label="장치 안내 닫기"><X size={15} /></button></div>}
      <SelfCameraPreview stream={media.cameraStream} enabled={media.cameraEnabled} videoRef={videoRef} onEnable={() => void media.requestCamera().catch(() => {})} faceStatus={face.status} calibrate={face.calibrate} showCalibration={readyMode} />
      <DeviceControls media={media} onEnd={() => setConfirmEnd(true)} canEnd={!readyMode && session.phase !== 'completed' && session.phase !== 'ending'} />
      {!readyMode && <div className="room-footer">{session.phase === 'completed' ? '면접 종료' : '답변에만 집중하세요'}</div>}
    </main>
    <ConversationDrawer open={drawer} messages={session.messages} phase={session.phase} onClose={() => setDrawer(false)} />
    {session.phase === 'device_check' && <StartPreparationPanel state={session.startup} media={media} faceStatus={face.status} onCalibrate={face.calibrate} onMicrophone={() => void session.retryMicrophone()} onCamera={() => void session.retryCamera()} onWithoutCamera={session.continueWithoutCamera} onStart={() => { requestedFullscreen.current = true; session.startFullscreen(shellRef.current); }} onCancel={() => { requestedFullscreen.current = false; if (document.fullscreenElement === shellRef.current) void document.exitFullscreen().catch(() => {}); session.cancelPreparation(); }} />}
    {session.phase === 'countdown' && session.startup.countdown !== null && <InterviewStartCountdown value={session.startup.countdown} />}
    {confirmEnd && <div className="dialog-backdrop" onClick={e => { if (e.target === e.currentTarget) setConfirmEnd(false); }}><section className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="end-title" onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); setConfirmEnd(false); }
      if (event.key === 'Tab') { const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button'); const first = buttons[0], last = buttons[buttons.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }
    }}><span className="dialog-symbol"><CircleAlert size={23} /></span><h2 id="end-title">면접을 마무리할까요?</h2><p>지금까지의 답변을 저장하고 면접을 종료합니다.{session.phase === 'listening' && <><br />말씀하신 답변의 마지막 음성도 확인할게요.</>}</p><div className="dialog-actions"><button ref={cancelEndRef} className="secondary-button" onClick={() => setConfirmEnd(false)}>계속하기</button><button className="primary-button" onClick={() => { setConfirmEnd(false); explicitlyEnding.current = true; void session.end(); }}>면접 종료</button></div></section></div>}
  </div>;
}
