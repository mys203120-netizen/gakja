/** A conservative amplitude endpointer, not speech recognition or an ability score. */
export type LiveTurnEndpoint = {
  lastSampleMs: number | null;
  speechStarted: boolean;
  candidateSpeechMs: number;
  silenceMs: number;
  speaking: boolean;
  endingSoon: boolean;
  shouldStop: boolean;
};
export type LiveTurnEndpointOptions = {
  minimumSpeechMs?: number;
  silenceWarningMs?: number;
  silenceStopMs?: number;
  speechThreshold?: number;
};
export const INITIAL_LIVE_TURN: LiveTurnEndpoint = {
  lastSampleMs: null, speechStarted: false, candidateSpeechMs: 0,
  silenceMs: 0, speaking: false, endingSoon: false, shouldStop: false,
};

/** Only consecutive observed frames count. Missing/background time is not silence. */
export function observeLiveTurn(previous: LiveTurnEndpoint, atMs: number, rms: number, options: LiveTurnEndpointOptions = {}): LiveTurnEndpoint {
  if (!Number.isFinite(atMs) || atMs < 0 || !Number.isFinite(rms) || rms < 0 || rms > 1 || previous.lastSampleMs !== null && atMs <= previous.lastSampleMs) return previous;
  const gap = previous.lastSampleMs === null ? 0 : atMs - previous.lastSampleMs;
  const continuous = gap > 0 && gap <= 250;
  const threshold = options.speechThreshold ?? .012;
  const speaking = rms >= threshold * (previous.speaking && continuous ? .7 : 1);
  const observedMs = continuous ? gap : 0;
  const silenceMs = !speaking && continuous ? previous.silenceMs + observedMs : 0;
  const candidateSpeechMs = !continuous || !previous.speechStarted && silenceMs > 1000 ? 0 : previous.candidateSpeechMs + (speaking ? observedMs : 0);
  const speechStarted = previous.speechStarted || candidateSpeechMs >= (options.minimumSpeechMs ?? 600);
  const stopMs = Math.max(1000, options.silenceStopMs ?? 5000);
  const warningMs = Math.min(stopMs, Math.max(0, options.silenceWarningMs ?? 4000));
  return {lastSampleMs:atMs,speechStarted,candidateSpeechMs,silenceMs,speaking,
    endingSoon:speechStarted && silenceMs >= warningMs,shouldStop:speechStarted && silenceMs >= stopMs};
}
