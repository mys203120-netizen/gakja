'use client';
import { useEffect, useRef, useState } from 'react';
import { SpeechCaptureClock } from '@/lib/interview/answer-capture';
export function useSpeechMetrics(stream: MediaStream | null, listening: boolean) {
  const [available, setAvailable] = useState(false);
  const availableRef = useRef(false), clock = useRef(new SpeechCaptureClock());
  const listeningRef = useRef(listening), speech = useRef(false);
  listeningRef.current = listening;
  useEffect(() => {
    clock.current.setListening(listening, performance.now(), availableRef.current);
  }, [listening]);
  useEffect(() => {
    const captureClock = clock.current;
    if (listeningRef.current) captureClock.loseCoverage();
    availableRef.current = false;
    if (!stream) { setAvailable(false); return; }
    let disposed = false, vad: { start: () => Promise<void> | void; destroy?: () => Promise<void> | void; pause: () => Promise<void> | void } | null = null;
    void import('@ricky0123/vad-web').then(async ({ MicVAD }) => {
      const instance = await MicVAD.new({ model: 'v5', baseAssetPath: '/vendor/vad/', onnxWASMBasePath: '/vendor/onnx/', getStream: async () => stream, pauseStream: async () => {}, resumeStream: async () => stream, onFrameProcessed: (p, frame) => {
        if (disposed || !listeningRef.current) { speech.current = false; return; }
        captureClock.frame(p.isSpeech, frame.length / 16, performance.now());
        speech.current = captureClock.snapshot(performance.now(), availableRef.current).speechActiveAtEnd === true;
      } });
      if (disposed) { await instance.destroy(); return; }
      vad = instance; await instance.start(); availableRef.current = true; setAvailable(true);
    }).catch(() => { if (!disposed) { availableRef.current = false; setAvailable(false); } });
    return () => { disposed = true; availableRef.current = false; if (listeningRef.current) captureClock.loseCoverage(); void vad?.destroy?.(); };
  }, [stream]);
  return {
    available,
    activity: speech,
    reset: () => { clock.current.reset(performance.now(), listeningRef.current, availableRef.current); speech.current = false; },
    snapshot: () => clock.current.snapshot(performance.now(), availableRef.current),
  };
}
