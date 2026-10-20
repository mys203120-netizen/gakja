'use client';
import {ownedClassName} from './owned-class-name';


import { useEffect, useRef } from 'react';
import { Check } from 'lucide-react';

type Phase = 'idle' | 'recording' | 'uploading' | 'saved';

/** Reads the recorder's existing stream; this component never owns its tracks. */
export function AudioLevelDot({ stream, phase }: { stream: MediaStream | null; phase: Phase }) {
  const dot = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const element = dot.current;
    if (!element) return;
    element.style.removeProperty('transform');
    element.style.removeProperty('opacity');
    if (phase !== 'recording' || !stream) return;

    let context: AudioContext | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let analyser: AnalyserNode | undefined;
    let frame = 0;
    let closed = false;
    let envelope = 0;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const resetMotion = () => { if (reduced.matches) element.style.transform = 'none'; };
    const release = () => {
      closed = true;
      cancelAnimationFrame(frame);
      reduced.removeEventListener('change', resetMotion);
      source?.disconnect();
      analyser?.disconnect();
      if (context && context.state !== 'closed') void context.close().catch(() => {});
      element.style.removeProperty('transform');
      element.style.removeProperty('opacity');
    };

    try {
      const AudioContextClass = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return;
      context = new AudioContextClass();
      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      // Do not connect to destination: the speaker must never replay the microphone.
      const samples = new Uint8Array(analyser.fftSize);
      const measure = () => {
        if (closed || !analyser) return;
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
        const level = Math.min(1, Math.max(0, (Math.sqrt(sum / samples.length) - .006) * 7));
        envelope += (level - envelope) * (level > envelope ? .38 : .12);
        element.style.opacity = String(.5 + envelope * .5);
        element.style.transform = reduced.matches ? 'none' : `scale(${1 + envelope * .85})`;
        frame = requestAnimationFrame(measure);
      };
      reduced.addEventListener('change', resetMotion);
      void context.resume().then(() => { if (!closed) measure(); }).catch(() => {});
    } catch {
      release();
      return;
    }
    return release;
  }, [stream, phase]);

  return <span className={ownedClassName(`audio-level-indicator is-${phase}`,true)} aria-hidden="true">{phase === 'saved' ? <Check className={ownedClassName("quiz-outcome-check")} size={17} strokeWidth={2} /> : <span className={ownedClassName("audio-level-dot",true)} ref={dot} />}</span>;
}
