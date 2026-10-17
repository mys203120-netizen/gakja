/** Timing evidence from a real microphone capture. Text drafts never produce this. */
export type SpeechInterval = { startMs: number; endMs: number };
export type SpeechTelemetry = {
  version: 1;
  method: 'rms-vad';
  sampleIntervalMs: number;
  durationMs: number;
  speechSegments: SpeechInterval[];
  observedSegments: SpeechInterval[];
  analysis: { noiseFloorRms: number; speechThresholdRms: number; peakRms?: number };
  coverage: { observedMs: number; maxGapMs: number; truncated: boolean };
  limitations: Array<'background-noise-sensitive' | 'high-background-level' | 'capture-gaps'>;
};
export type RmsSample = { atMs: number; rms: number };

export const SPEECH_SAMPLE_INTERVAL_MS = 100;
export const MAX_SPEECH_CAPTURE_MS = 20 * 60 * 1000;
export const MAX_SPEECH_SAMPLES = MAX_SPEECH_CAPTURE_MS / SPEECH_SAMPLE_INTERVAL_MS;

function rounded(value: number) { return Math.round(value); }
function joinIntervals(intervals: SpeechInterval[], toleranceMs = 0): SpeechInterval[] {
  const result: SpeechInterval[] = [];
  for (const interval of intervals) {
    if (interval.endMs <= interval.startMs) continue;
    const previous = result.at(-1);
    if (previous && interval.startMs <= previous.endMs + toleranceMs) previous.endMs = Math.max(previous.endMs, interval.endMs);
    else result.push({ ...interval });
  }
  return result;
}

/** Pure reduction keeps raw amplitude samples out of uploads and storage. */
export function buildSpeechTelemetry(raw: readonly RmsSample[], durationMs: number, truncated = false): SpeechTelemetry | null {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const duration = Math.min(MAX_SPEECH_CAPTURE_MS, rounded(durationMs));
  const samples = raw.filter(sample => Number.isFinite(sample.atMs) && sample.atMs >= 0 && sample.atMs < duration && Number.isFinite(sample.rms) && sample.rms >= 0 && sample.rms <= 1)
    .slice(0, MAX_SPEECH_SAMPLES).sort((a, b) => a.atMs - b.atMs)
    .filter((sample, index, all) => !index || sample.atMs > all[index - 1].atMs);
  // A suspended AudioContext, unavailable device, or empty capture is missing evidence.
  if (!samples.length) return null;
  const levels = samples.map(sample => sample.rms).sort((a, b) => a - b);
  const noiseFloor = levels[Math.floor((levels.length - 1) * .1)];
  const threshold = Math.max(.012, Math.min(.008, noiseFloor) * 2.2);
  const observed: SpeechInterval[] = [];
  const voice: SpeechInterval[] = [];
  let speaking = false;
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    const next = samples[index + 1];
    // A throttled tab's unobserved time must not become a manufactured silent pause.
    const end = Math.min(duration, sample.atMs + SPEECH_SAMPLE_INTERVAL_MS, next?.atMs ?? duration);
    const gap = index ? sample.atMs - samples[index - 1].atMs : sample.atMs;
    if (gap > SPEECH_SAMPLE_INTERVAL_MS * 2) speaking = false;
    const interval = { startMs: rounded(sample.atMs), endMs: rounded(end) };
    observed.push(interval);
    speaking = sample.rms >= (speaking ? threshold * .7 : threshold);
    if (speaking) voice.push(interval);
  }
  const observedSegments = joinIntervals(observed, 2);
  // Merge one low amplitude sample between spoken syllables; do not erase a 0.7s pause.
  const speechSegments: SpeechInterval[] = [];
  let observedIndex = 0, previousObservedIndex = -1;
  for (const interval of voice) {
    while (observedIndex < observedSegments.length - 1 && observedSegments[observedIndex].endMs < interval.endMs) observedIndex++;
    const previous = speechSegments.at(-1);
    if (previous && observedIndex === previousObservedIndex && interval.startMs <= previous.endMs + SPEECH_SAMPLE_INTERVAL_MS + 2) previous.endMs = Math.max(previous.endMs, interval.endMs);
    else speechSegments.push({ ...interval });
    previousObservedIndex = observedIndex;
  }
  const observedMs = observedSegments.reduce((total, segment) => total + segment.endMs - segment.startMs, 0);
  let maxGapMs = observedSegments[0]?.startMs || 0;
  for (let index = 1; index < observedSegments.length; index++) maxGapMs = Math.max(maxGapMs, observedSegments[index].startMs - observedSegments[index - 1].endMs);
  maxGapMs = Math.max(maxGapMs, duration - (observedSegments.at(-1)?.endMs || 0));
  const limitations: SpeechTelemetry['limitations'] = ['background-noise-sensitive'];
  if (noiseFloor > .025) limitations.push('high-background-level');
  if (maxGapMs > 300 || observedMs / duration < .85) limitations.push('capture-gaps');
  return {
    version: 1, method: 'rms-vad', sampleIntervalMs: SPEECH_SAMPLE_INTERVAL_MS, durationMs: duration,
    speechSegments, observedSegments,
    analysis: { noiseFloorRms: Number(noiseFloor.toFixed(5)), speechThresholdRms: Number(threshold.toFixed(5)), peakRms: levels.at(-1)! },
    coverage: { observedMs, maxGapMs, truncated: truncated || durationMs > MAX_SPEECH_CAPTURE_MS || raw.length > MAX_SPEECH_SAMPLES },
    limitations,
  };
}
