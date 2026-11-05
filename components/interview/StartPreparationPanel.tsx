'use client';
import { useEffect, useRef, useState } from 'react';
import { Camera, CameraOff, Check, LoaderCircle, Mic, X } from 'lucide-react';
import type { AudioDevices } from '@/hooks/useAudioDevices';
import { mayStartInterview, type InterviewStartupState } from '@/lib/interview/startup-flow';
import styles from './StartPreparationPanel.module.css';

export function StartPreparationPanel({ state, media, faceStatus, onCalibrate, onMicrophone, onCamera, onWithoutCamera, onStart, onCancel }: { state: InterviewStartupState; media: AudioDevices; faceStatus: string; onCalibrate(): void; onMicrophone(): void; onCamera(): void; onWithoutCamera(): void; onStart(): void; onCancel(): void }) {
  const video = useRef<HTMLVideoElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const [level, setLevel] = useState(0);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => { const element = video.current; if (element) { element.srcObject = media.cameraStream; if (media.cameraStream) void element.play().catch(() => {}); } return () => { if (element) element.srcObject = null; }; }, [media.cameraStream]);
  useEffect(() => {
    let raf = 0, last = 0; const values = new Float32Array(512);
    const frame = (now: number) => { if (now - last >= 100) { last = now; const analyser = media.micAnalyser.current; if (analyser && media.micEnabled) { analyser.getFloatTimeDomainData(values); const rms = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length); setLevel(Math.min(1, rms * 8)); } else setLevel(0); } raf = requestAnimationFrame(frame); };
    raf = requestAnimationFrame(frame); return () => cancelAnimationFrame(raf);
  }, [media.micAnalyser, media.micEnabled]);
  const microphoneReady = state.microphone === 'ready' && media.micEnabled;
  const cameraReady = state.camera === 'ready' && media.cameraEnabled;
  const canStart = mayStartInterview(state, { microphoneLive: media.micEnabled, cameraLive: media.cameraEnabled });
  return <div className={styles.backdrop}>
    <section className={styles.panel} role="dialog" aria-modal="true" aria-labelledby="start-check-title" onKeyDown={event => {
      if (event.key === 'Escape' && state.microphone !== 'checking' && state.camera !== 'checking' && !state.fullscreenPending) { event.stopPropagation(); onCancel(); }
      if (event.key === 'Tab') { const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]; const first = buttons[0], last = buttons.at(-1); if (event.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
    }}>
      <button type="button" className={styles.close} aria-label="시작 전 확인 닫기" onClick={onCancel} disabled={state.fullscreenPending}><X size={18} /></button>
      <h2 id="start-check-title" ref={heading} tabIndex={-1}>시작 전 확인</h2>
      <p className={styles.intro}>마이크와 카메라를 확인해 주세요.<br />아직 질문과 면접 시간은 시작되지 않았어요.</p>
      <div className={styles.devices}>
        <div className={styles.microphone}>
          <div className={styles.deviceHeading}><Mic size={17} /><strong>마이크</strong>{microphoneReady && <Check size={15} />}</div>
          <span className={styles.deviceName}>{media.selectedMicLabel}</span>
          <meter className={styles.level} min={0} max={1} value={level} aria-label="실제 마이크 입력 크기" />
          <p aria-live="polite">{state.microphone === 'checking' ? '브라우저의 마이크 권한을 확인해 주세요.' : microphoneReady ? '말씀하시면 입력 크기가 움직여요.' : state.microphoneError || '마이크 연결을 확인해 주세요.'}</p>
          {!microphoneReady && <button type="button" className={styles.link} onClick={onMicrophone} disabled={state.microphone === 'checking'}>{state.microphone === 'checking' ? <><LoaderCircle size={13} className="spinning" /> 확인 중</> : '마이크 다시 확인'}</button>}
        </div>
        <div className={styles.camera}>
          <video ref={video} muted autoPlay playsInline aria-label="시작 전 카메라 미리보기" className={!cameraReady ? styles.hiddenVideo : ''} />
          {!cameraReady && <div className={styles.cameraEmpty}>{state.camera === 'checking' ? <LoaderCircle size={24} className="spinning" /> : <CameraOff size={24} />}<span>{state.camera === 'checking' ? '카메라 권한 확인 중' : state.camera === 'skipped' ? '카메라 없이 진행합니다' : '카메라를 확인해 주세요'}</span></div>}
          <span className={styles.cameraCaption}><Camera size={12} /> 내 카메라 미리보기</span>
        </div>
      </div>
      {state.cameraError && <p className={styles.notice} role="status">{state.cameraError}</p>}
      <div className={styles.cameraActions}>{cameraReady && <button type="button" className={styles.link} onClick={onCalibrate} disabled={['loading', 'unavailable', 'calibrating'].includes(faceStatus)}>{faceStatus === 'calibrating' ? '카메라를 바라봐 주세요' : faceStatus === 'calibrated' ? '기준점 다시 잡기' : faceStatus === 'unavailable' ? '시선 관찰 사용 불가' : '카메라 보고 기준점 잡기'}</button>}{!cameraReady && state.camera !== 'checking' && <button type="button" className={styles.link} onClick={onCamera}>카메라 다시 확인</button>}{state.camera !== 'skipped' && <button type="button" className={styles.link} onClick={onWithoutCamera}>카메라 없이 진행</button>}</div>
      {state.startError && <p className={styles.error} role="alert">{state.startError}</p>}
      <button type="button" className={`primary-button ${styles.start}`} disabled={!canStart} onClick={onStart}>{state.fullscreenPending ? <><LoaderCircle size={15} className="spinning" /> 전체화면 확인 중</> : '전체화면으로 면접 시작'}</button>
    </section>
  </div>;
}

export function InterviewStartCountdown({ value }: { value: number }) { return <div className={styles.countdown} role="status" aria-live="assertive" aria-atomic="true"><span>잠시 후 면접을 시작합니다</span><strong>{value}</strong></div>; }
