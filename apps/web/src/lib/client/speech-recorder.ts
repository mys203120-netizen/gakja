import { buildSpeechTelemetry, MAX_SPEECH_CAPTURE_MS, MAX_SPEECH_SAMPLES, SPEECH_SAMPLE_INTERVAL_MS, type RmsSample, type SpeechTelemetry } from '../speech-telemetry';

export type SpeechCapture = {
  /** MediaRecorder pause/resume use an active clock rather than wall time. */
  pause(): void;
  resume(): void;
  elapsedMs(): number;
  finish(): SpeechTelemetry | null;
  dispose(): void;
};

/** Shares the recorder's existing stream. This object never stops its tracks. */
export function startSpeechCapture(stream: MediaStream): SpeechCapture | null {
  if (typeof window === 'undefined' || !stream.getAudioTracks().some(track => track.readyState === 'live')) return null;
  const AudioContextClass = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return null;
  let context: AudioContext | undefined, source: MediaStreamAudioSourceNode | undefined, analyser: AnalyserNode | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let disposed = false, paused = false, truncated = false, activeMs = 0, activeSince = performance.now();
  let result: SpeechTelemetry | null | undefined;
  const samples: RmsSample[] = [];
  const elapsedMs = () => activeMs + (paused || disposed ? 0 : Math.max(0, performance.now() - activeSince));
  const release = () => {
    if (interval !== undefined) clearInterval(interval);
    interval = undefined;
    source?.disconnect(); analyser?.disconnect();
    if (context && context.state !== 'closed') void context.close().catch(() => {});
  };
  const dispose = () => {
    if (disposed) return;
    activeMs = elapsedMs(); disposed = true; release();
  };
  try {
    context = new AudioContextClass();
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser(); analyser.fftSize = 2048;
    source.connect(analyser);
    // No connection to AudioContext.destination: microphone sound is never replayed.
    const buffer = new Float32Array(analyser.fftSize);
    const measure = () => {
      if (disposed || paused || !analyser || context?.state !== 'running') return;
      const atMs = elapsedMs();
      if (atMs >= MAX_SPEECH_CAPTURE_MS || samples.length >= MAX_SPEECH_SAMPLES) { truncated = true; return; }
      analyser.getFloatTimeDomainData(buffer);
      let squares = 0;
      for (const value of buffer) squares += value * value;
      samples.push({ atMs, rms: Math.sqrt(squares / buffer.length) });
    };
    interval = setInterval(measure, SPEECH_SAMPLE_INTERVAL_MS);
    // If WebAudio is unavailable, the recorder still has an honest active timer.
    void context.resume().then(() => { if (!disposed) measure(); }).catch(() => { release(); });
    return {
      elapsedMs,
      pause() { if (disposed || paused) return; activeMs = elapsedMs(); paused = true; },
      resume() { if (disposed || !paused) return; activeSince = performance.now(); paused = false; void context?.resume().catch(() => {}); },
      finish() {
        if (result !== undefined) return result;
        const duration = elapsedMs();
        if (!disposed && !paused) measure();
        result = buildSpeechTelemetry(samples, duration, truncated);
        dispose(); samples.length = 0;
        return result;
      },
      dispose() { dispose(); samples.length = 0; result = null; },
    };
  } catch { dispose(); return null; }
}

/** Re-measures an already owned recording without playing it or opening a device. */
export async function decodeRecordingTelemetry(blob: Blob): Promise<SpeechTelemetry | null> {
  if (typeof window === 'undefined' || !blob.size || blob.size > 50 * 1024 * 1024) return null;
  const AudioContextClass = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return null;
  let context: AudioContext | undefined;
  try {
    context = new AudioContextClass();
    // Decoding reads the private file only. No audio node is connected or played.
    const audio = await context.decodeAudioData(await blob.arrayBuffer());
    if (!Number.isFinite(audio.duration) || audio.duration <= 0 || audio.duration > MAX_SPEECH_CAPTURE_MS / 1000 || audio.numberOfChannels < 1 || audio.numberOfChannels > 8) return null;
    const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index));
    const step = Math.max(1, Math.round(audio.sampleRate * SPEECH_SAMPLE_INTERVAL_MS / 1000));
    const samples: RmsSample[] = [];
    for (let start = 0; start < audio.length && samples.length < MAX_SPEECH_SAMPLES; start += step) {
      const end = Math.min(audio.length, start + step);
      let squares = 0;
      for (const channel of channels) for (let index = start; index < end; index++) squares += channel[index] ** 2;
      samples.push({ atMs: start * 1000 / audio.sampleRate, rms: Math.sqrt(squares / ((end - start) * channels.length)) });
      // Give navigation and UI a turn while reducing long recordings.
      if (samples.length % 200 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    return buildSpeechTelemetry(samples, audio.duration * 1000);
  } catch { return null; }
  finally { if (context && context.state !== 'closed') await context.close().catch(() => {}); }
}
