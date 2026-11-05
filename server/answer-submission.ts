import type { AnswerSubmissionObservation } from "./protocol";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** No speech is asserted only from observed VAD zeroes; empty STT alone does not diagnose a device failure. */
export function observeAnswerSubmission(rawTranscript: string, metrics: unknown, readiness: { microphoneEnabled?: boolean } = {}): AnswerSubmissionObservation {
  const speech = object(object(metrics).speech);
  const observed = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const durationMs = observed(speech.durationMs);
  const speaking = observed(speech.speakingMs), first = observed(speech.firstSpeechMs);
  const speakingMs = speaking !== null && durationMs !== null && speaking <= durationMs ? speaking : null;
  const firstSpeechMs = first !== null && durationMs !== null && first <= durationMs ? first : null;
  const nonAnswer = !rawTranscript.trim();
  // VAD zeroes from a disabled input do not observe the student's silence.
  // Keep the original metrics untouched; only the derived readiness is held.
  const inputUnavailable = nonAnswer && readiness.microphoneEnabled === false;
  return {
    classification: nonAnswer ? !inputUnavailable && speakingMs === 0 && firstSpeechMs === null ? "silence_observed" : "empty_transcript" : "speech_transcribed",
    nonAnswer, durationMs, speakingMs: inputUnavailable ? null : speakingMs,
    silenceMs: !inputUnavailable && speakingMs !== null && durationMs !== null ? durationMs - speakingMs : null,
    firstSpeechMs: inputUnavailable ? null : firstSpeechMs,
    speechDetected: inputUnavailable ? null : firstSpeechMs !== null ? true : speakingMs === null ? null : speakingMs > 0,
    rawTranscriptPreserved: true,
    origin: "finalized-stt-and-observed-speech-timing",
  };
}
