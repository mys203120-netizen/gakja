'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { InterviewerScene } from './InterviewerScene';
import { SceneBridgeGate, sceneChannel } from '@/lib/live2d/bridge';
import { SceneCommandPlayer } from '@/lib/live2d/command-player';
import type { SceneCommand, SceneEvent, SceneState, SpeechIdentity, SpeakerId } from '@/lib/live2d/types';
import styles from './SceneHost.module.css';

declare global { interface Window { ReactNativeWebView?: { postMessage(message: string): void } } }

export function SceneHost() {
  const audio = useRef<HTMLAudioElement | null>(null), outputAnalyser = useRef<AnalyserNode | null>(null);
  const player = useRef<SceneCommandPlayer | null>(null), context = useRef<AudioContext | null>(null);
  const gate = useRef(new SceneBridgeGate()), readyEvent = useRef<SceneEvent | null>(null);
  const [state, setState] = useState<SceneState>('ready'), [identity, setIdentity] = useState<SpeechIdentity | null>(null);
  const [audioUrl, setAudioUrl] = useState(''), [events, setEvents] = useState<string[]>([]), [embedded, setEmbedded] = useState(false);
  const [activationNeeded, setActivationNeeded] = useState(false);
  const emit = useCallback((event: SceneEvent) => {
    if (event.type === 'ready') readyEvent.current = event;
    if (event.type === 'error' && ['render_failed', 'resize_failed', 'prepare_failed'].includes(event.code)) readyEvent.current = { type: 'ready', mode: 'static-fallback' };
    setEvents(previous => [...previous.slice(-9), JSON.stringify(event)]);
    const sessionId = gate.current.sessionId;
    if (sessionId) window.ReactNativeWebView?.postMessage(JSON.stringify({ channel: sceneChannel, sessionId, event }));
  }, []);
  const run = useCallback((command: SceneCommand) => {
    // Call resume in the same user gesture as play. Native WebView can explicitly permit autoplay.
    if (command.type === 'speak' || command.type === 'resume') {
      if (context.current?.state === 'suspended') void context.current.resume().then(() => {
        const blocked = context.current?.state !== 'running'; setActivationNeeded(blocked);
        if (blocked) emit({ type: 'error', code: 'audio_activation_required', message: '장면 안의 음성 활성화 버튼을 눌러 주세요.' });
      }).catch(() => { setActivationNeeded(true); });
    }
    void player.current?.execute(command).catch(() => emit({ type: 'error', code: 'invalid_command', message: '같은 서비스의 유효한 음성 주소를 사용해 주세요.' }));
  }, [emit]);
  useEffect(() => {
    setEmbedded(Boolean(window.ReactNativeWebView));
    const element = new Audio(); element.preload = 'auto'; audio.current = element;
    const audioContext = new AudioContext({ latencyHint: 'interactive' }); context.current = audioContext;
    const source = audioContext.createMediaElementSource(element), analyser = audioContext.createAnalyser(); analyser.fftSize = 512;
    source.connect(analyser).connect(audioContext.destination); outputAnalyser.current = analyser;
    const instance = new SceneCommandPlayer(element, location.origin, emit, (next, owner) => { setState(next); setIdentity(owner); }); player.current = instance;
    const message = (event: MessageEvent) => {
      if (event.origin !== location.origin && !(event.origin === '' && window.ReactNativeWebView)) return;
      const envelope = gate.current.accept(event.data); if (!envelope) return;
      run(envelope.command);
      if (envelope.command.type === 'prepare' && readyEvent.current) emit(readyEvent.current);
    };
    const hidden = () => { if (document.hidden) run({ type: 'pause' }); };
    const audioState = () => {
      if (audioContext.state !== 'running' && !element.paused) { run({ type: 'pause' }); setActivationNeeded(true); }
    };
    window.addEventListener('message', message); document.addEventListener('visibilitychange', hidden); audioContext.addEventListener('statechange', audioState);
    return () => {
      window.removeEventListener('message', message); document.removeEventListener('visibilitychange', hidden); audioContext.removeEventListener('statechange', audioState);
      instance.dispose(); player.current = null; source.disconnect(); analyser.disconnect(); outputAnalyser.current = null;
      void audioContext.close().catch(() => {}); context.current = null; audio.current = null;
    };
  }, [emit, run]);
  const speak = (speakerId: SpeakerId) => run({ type: 'speak', turnId: crypto.randomUUID(), speakerId, audioUrl });
  return <main className={`${styles.host} ${embedded ? styles.embedded : ''}`}>
    {!embedded && <header className={styles.header}><span>각자의답</span><h1>면접 장면 연결 확인</h1><p>전용 모델이 준비되기 전에는 정적 이미지로 표시합니다.</p></header>}
    <InterviewerScene state={state} identity={identity} audio={audio} outputAnalyser={outputAnalyser} onEvent={emit} />
    {activationNeeded && <button className={styles.activation} onClick={() => { void context.current?.resume().then(() => { setActivationNeeded(false); run({ type: 'resume' }); }); }}>음성 활성화</button>}
    {!embedded && <section className={styles.controls} aria-label="장면 연동 검수">
      <label>현재 서비스에서 제공하는 음성 주소<input value={audioUrl} onChange={event => setAudioUrl(event.target.value)} placeholder="/api/audio/실제-음성-ID" /></label>
      <div className={styles.buttons}>
        <button disabled={!audioUrl} onClick={() => speak('interviewer-1')}>면접관 1 발화</button><button disabled={!audioUrl} onClick={() => speak('interviewer-2')}>면접관 2 발화</button>
        <button onClick={() => run({ type: 'pause' })}>일시정지</button><button onClick={() => run({ type: 'resume' })}>재개</button>
        <button disabled={!identity} onClick={() => { if (identity) run({ type: 'cancel', turnId: identity.turnId }); }}>발화 취소</button><button onClick={() => run({ type: 'setListening', listening: true })}>학생 답변 상태</button>
      </div>
      <p className={styles.hint}>학생 마이크를 요청하지 않습니다. 실제 모델의 립싱크와 기기 성능 검수는 별도로 필요합니다.</p>
      <details><summary>실제 장면 이벤트</summary><pre aria-live="polite">{events.join('\n')}</pre></details>
    </section>}
  </main>;
}
