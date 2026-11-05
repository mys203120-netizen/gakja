'use client';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { BrowserInterviewScene } from '@/lib/live2d/browser-scene';
import { scenePreparationFailure } from '@/lib/live2d/manifest';
import type { SceneEvent, SceneState, SpeechIdentity } from '@/lib/live2d/types';
import styles from './InterviewerScene.module.css';

export function InterviewerScene({ state, identity, audio, outputAnalyser, onEvent }: {
  state: SceneState;
  identity: SpeechIdentity | null;
  audio: RefObject<HTMLAudioElement | null>;
  outputAnalyser: RefObject<AnalyserNode | null>;
  onEvent?: (event: SceneEvent) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null), scene = useRef<BrowserInterviewScene | null>(null);
  const eventRef = useRef(onEvent); eventRef.current = onEvent;
  const [mode, setMode] = useState<'loading' | 'live2d' | 'static-fallback'>('loading');
  const [fallback, setFallback] = useState('/live2d/art/reference.png');
  const [notice, setNotice] = useState('면접실을 준비하고 있어요.');
  useEffect(() => {
    let mounted = true;
    const instance = new BrowserInterviewScene(canvas.current!, event => {
      if (!mounted) return;
      if (event.type === 'ready') {
        setMode(event.mode);
        setNotice(event.mode === 'static-fallback' ? '장면 이미지 · Live2D 모델 제작 및 연결 대기' : '');
      }
      if (event.type === 'error') { setMode('static-fallback'); setNotice(event.message); }
      eventRef.current?.(event);
    });
    scene.current = instance;
    void instance.prepare().then(manifest => { if (mounted) setFallback(manifest.fallback); }).catch(error => {
      if (!mounted || error?.name === 'AbortError') return;
      const failure = scenePreparationFailure(error);
      instance.dispose(); setMode('static-fallback'); setNotice(failure.message);
      eventRef.current?.({ type: 'error', ...failure });
    });
    return () => { mounted = false; instance.dispose(); scene.current = null; };
  }, []);
  useEffect(() => { scene.current?.update({ state, identity, audio: audio.current, outputAnalyser: outputAnalyser.current }); }, [state, identity, audio, outputAnalyser]);
  return <figure className={styles.scene} data-mode={mode}>
    <div className={styles.viewport}>
      {/* Shared 16:9 frame: no independent cover crop for any scene layer. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={styles.fallback} src={fallback} alt="따뜻한 면접실의 책상 뒤에 나란히 앉은 두 면접관" hidden={mode === 'live2d'} />
      <canvas ref={canvas} className={styles.canvas} aria-label="두 면접관의 Live2D 장면" hidden={mode !== 'live2d'} />
    </div>
    <figcaption className={styles.caption}>
      <span className={styles.names}><span data-active={identity?.speakerId === 'interviewer-1' && state === 'speaking'}>면접관 1</span><span data-active={identity?.speakerId === 'interviewer-2' && state === 'speaking'}>면접관 2</span></span>
      {notice && <span className={styles.notice} role="status">{notice}</span>}
    </figcaption>
  </figure>;
}
