export type AnswerStopSource = 'space' | 'button' | 'session_end';
export type AnswerCaptureStage = 'capturing' | 'end_requested' | 'stt_final' | 'candidate' | 'advance_locked';
export type CaptureScope = { turnId: string; answerId: string; captureRevision: number };

/** Transport finality belongs to a capture, not to the logical answer. */
export class AnswerCaptureLifecycle {
  private scope: CaptureScope | null = null;
  private stage: AnswerCaptureStage = 'capturing';
  private streamId: string | null = null;
  private candidateId: string | null = null;

  begin(turnId: string, answerId: string, captureRevision = 1) {
    this.scope = { turnId, answerId, captureRevision };
    this.stage = 'capturing'; this.streamId = null; this.candidateId = null;
    return this.snapshot();
  }
  restore(scope: CaptureScope, stage: AnswerCaptureStage, candidateId: string | null = null) {
    this.scope = { ...scope }; this.stage = stage; this.streamId = null; this.candidateId = candidateId;
    return this.snapshot();
  }
  snapshot() { return this.scope ? { ...this.scope, stage: this.stage, streamId: this.streamId, candidateId: this.candidateId } : null; }
  matches(event: { turnId?: string; answerId?: string; captureRevision?: number; streamId?: string }) {
    return !!this.scope && event.turnId === this.scope.turnId && event.answerId === this.scope.answerId
      && event.captureRevision === this.scope.captureRevision && (!event.streamId || !this.streamId || event.streamId === this.streamId);
  }
  bindStream(event: CaptureScope & { streamId: string }) {
    if (!this.matches(event) || this.stage !== 'capturing') return false;
    this.streamId = event.streamId; return true;
  }
  acceptsTranscript(event: { turnId?: string; answerId?: string; captureRevision?: number; streamId?: string }) {
    return this.matches(event) && (!this.streamId || event.streamId === this.streamId) && (this.stage === 'capturing' || this.stage === 'end_requested');
  }
  requestEnd() {
    if (!this.scope || this.stage !== 'capturing') return null;
    this.stage = 'end_requested'; return this.snapshot();
  }
  cancelEnd(scope: CaptureScope) {
    if (!this.matches(scope) || this.stage !== 'end_requested') return false;
    this.stage = 'capturing'; return true;
  }
  finalize(event: { turnId?: string; answerId?: string; captureRevision?: number; streamId?: string }) {
    if (!this.matches(event) || this.streamId && event.streamId !== this.streamId || this.stage !== 'end_requested') return false;
    this.stage = 'stt_final'; return true;
  }
  stageCandidate(scope: CaptureScope, candidateId: string) {
    if (!this.matches(scope) || this.stage !== 'stt_final') return false;
    this.candidateId = candidateId; this.stage = 'candidate'; return true;
  }
  /** Lock before dispatching /next. Aborting a request cannot release this lock. */
  lockAdvance() {
    if (!this.scope || this.stage !== 'candidate' || !this.candidateId) return null;
    this.stage = 'advance_locked'; return this.snapshot();
  }
  continueAnswer() {
    if (!this.scope || this.stage === 'advance_locked') return null;
    this.scope = { ...this.scope, captureRevision: this.scope.captureRevision + 1 };
    this.stage = 'capturing'; this.streamId = null; this.candidateId = null;
    return this.snapshot();
  }
  reset() { this.scope = null; this.streamId = null; this.candidateId = null; this.stage = 'capturing'; }
}

export type SpeechEndingObservation = {
  durationMs: number; speakingMs: number | null; firstSpeechMs: number | null;
  lastSpeechMs?: number | null; trailingSilenceMs?: number | null;
  speechActiveAtEnd?: boolean | null; vadAvailable?: boolean; vadCoverageComplete?: boolean;
};

/** The drain deadline bounds waiting, never the candidate's ongoing voice. */
export function answerCaptureTailAction(source: AnswerStopSource, observation: SpeechEndingObservation | undefined, waitedMs: number): 'drain' | 'continue_capture' | 'finalize' {
  if (source !== 'space') return 'finalize';
  const vadObserved = observation?.vadAvailable === true && observation.vadCoverageComplete !== false;
  if (waitedMs >= 800) return vadObserved && observation?.speechActiveAtEnd === true ? 'continue_capture' : 'finalize';
  if (!vadObserved) return waitedMs < 160 ? 'drain' : 'finalize';
  return observation?.speechActiveAtEnd === true || (observation?.trailingSilenceMs ?? 0) < 160 ? 'drain' : 'finalize';
}
export const shouldDrainAnswerTail = (source: AnswerStopSource, observation: SpeechEndingObservation | undefined, waitedMs: number) => answerCaptureTailAction(source, observation, waitedMs) === 'drain';

/** VAD facts use the active capture clock so browser pauses never look like answer silence. */
export class SpeechCaptureClock {
  private elapsedMs = 0;
  private beganAt: number | null = null;
  private speakingMs = 0;
  private firstSpeechMs: number | null = null;
  private lastSpeechMs: number | null = null;
  private speechActive = false;
  private coverageComplete = false;
  setListening(listening: boolean, now: number, vadAvailable: boolean) {
    if (listening && this.beganAt === null) { this.beganAt = now; if (!vadAvailable) this.coverageComplete = false; }
    if (!listening && this.beganAt !== null) { this.elapsedMs += Math.max(0, now - this.beganAt); this.beganAt = null; }
  }
  reset(now: number, listening: boolean, vadAvailable: boolean) {
    this.elapsedMs = 0; this.speakingMs = 0; this.firstSpeechMs = null; this.lastSpeechMs = null;
    this.speechActive = false; this.coverageComplete = vadAvailable; this.beganAt = listening ? now : null;
  }
  loseCoverage() { this.coverageComplete = false; this.speechActive = false; }
  frame(probability: number, frameMs: number, now: number) {
    if (this.beganAt === null) return;
    if (probability >= .6) this.speechActive = true; else if (probability < .35) this.speechActive = false;
    if (!this.speechActive) return;
    const activeMs = this.duration(now);
    this.speakingMs += frameMs;
    if (this.firstSpeechMs === null) this.firstSpeechMs = activeMs;
    this.lastSpeechMs = activeMs;
  }
  private duration(now: number) { return this.elapsedMs + (this.beganAt === null ? 0 : Math.max(0, now - this.beganAt)); }
  snapshot(now: number, vadAvailable: boolean) {
    const durationMs = this.duration(now), observed = vadAvailable && this.coverageComplete;
    return {
      durationMs, speakingMs: observed ? Math.min(this.speakingMs, durationMs) : null,
      firstSpeechMs: observed ? this.firstSpeechMs : null, lastSpeechMs: observed ? this.lastSpeechMs : null,
      trailingSilenceMs: observed && this.lastSpeechMs !== null ? Math.max(0, durationMs - this.lastSpeechMs) : null,
      speechActiveAtEnd: observed ? this.speechActive : null,
      vadAvailable, vadCoverageComplete: this.coverageComplete,
    };
  }
}
