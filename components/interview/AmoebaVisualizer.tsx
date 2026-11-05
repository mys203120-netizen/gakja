'use client';
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { Phase } from '@/hooks/useInterviewSession';
import { MorphMotionTracker, morphRoleForPhase } from '@/lib/interview/morph-motion';
import styles from './AmoebaVisualizer.module.css';
export function AmoebaVisualizer({ phase, micAnalyser, outputAnalyser, speechActivity, vadAvailable = false, onStart, startDisabled = false }: { phase: Phase; micAnalyser: RefObject<AnalyserNode | null>; outputAnalyser: RefObject<AnalyserNode | null>; speechActivity?: RefObject<boolean>; vadAvailable?: boolean; onStart?: () => void; startDisabled?: boolean }) {
  const wrapper = useRef<HTMLDivElement>(null);
  const tracker = useRef(new MorphMotionTracker());
  const startRequested = useRef(false);
  const [hovered, setHovered] = useState(false), [keyboardFocused, setKeyboardFocused] = useState(false);
  const mode = morphRoleForPhase(phase);
  const interactive = phase === 'idle' && Boolean(onStart);
  const engaged = interactive && !startDisabled && (hovered || keyboardFocused);
  useEffect(() => { if (phase === 'idle') startRequested.current = false; }, [phase]);
  useEffect(() => { if (!interactive) { setHovered(false); setKeyboardFocused(false); } }, [interactive]);
  useEffect(() => {
    let raf = 0;
    const values = new Float32Array(512);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const tick = (now: number) => {
      const analyser = mode === 'candidate' ? micAnalyser.current : mode === 'interviewer' ? outputAnalyser.current : null;
      let rms = 0;
      if (analyser) {
        analyser.getFloatTimeDomainData(values);
        rms = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
      }
      const movement = tracker.current.step(mode, rms, now, mode === 'candidate' && vadAvailable && speechActivity ? speechActivity.current : null);
      if (wrapper.current) {
        wrapper.current.dataset.motion = movement.motion;
        wrapper.current.style.setProperty('--energy', movement.energy.toFixed(3));
        const pulse = reducedMotion.matches ? 1 + (movement.pulseScale - 1) * .35 : movement.pulseScale;
        wrapper.current.style.setProperty('--pulse-scale', pulse.toFixed(4));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, [micAnalyser, mode, outputAnalyser, speechActivity, vadAvailable]);
  return <div ref={wrapper} className={styles.energy} data-visualizer="amoeba" data-mode={mode} data-interactive={interactive} data-engaged={engaged} data-motion={mode === 'processing' ? 'processing' : 'silence'} style={{ '--energy': 0, '--pulse-scale': 1 } as CSSProperties} aria-hidden={interactive ? undefined : true}>
    <div className={styles.sculpture} data-state={mode} aria-hidden="true">
      {(['ready', 'processing', 'interviewer', 'candidate'] as const).map(color => <div key={color} className={`${styles.palette} ${styles[color]}`} data-active={color === mode}>
        <div className={styles.aura} />
        <div className={styles.fluidRing} data-fluid="ring"><div className={styles.fluidOne} data-fluid="back" /></div>
      </div>)}
      <div className={styles.core} />
    </div>
    {interactive && <button
      type="button"
      className={styles.startAction}
      data-morph-start="true"
      aria-label="면접 시작"
      disabled={startDisabled}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={event => setKeyboardFocused(event.currentTarget.matches(':focus-visible'))}
      onBlur={() => setKeyboardFocused(false)}
      onClick={() => {
        if (startDisabled || startRequested.current) return;
        startRequested.current = true;
        onStart?.();
      }}
    />}
  </div>;
}
