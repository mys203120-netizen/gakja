/** Accumulates active time only. A paused interval can never enter an answer duration. */
export class ActiveClock {
  private accumulated = 0;
  private since: number | null = null;
  start(now: number) { if(this.since===null) this.since=now; }
  pause(now: number) { if(this.since!==null) {this.accumulated+=Math.max(0,now-this.since);this.since=null;} }
  elapsed(now: number) { return this.accumulated+(this.since===null?0:Math.max(0,now-this.since)); }
  reset() {this.accumulated=0;this.since=null;}
}

/** Initial display only. A started session always confirms its budget from the server. */
export const INITIAL_INTERVIEW_DURATION_SECONDS = 12 * 60;
export function isInterviewDurationSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 86_400;
}

/** Preparation can refresh; a session's budget stays fixed until reset/new session. */
export class InterviewDurationBudget {
  private preparedSeconds = INITIAL_INTERVIEW_DURATION_SECONDS;
  private sessionSeconds: number | null = null;
  private confirmed = false;
  get seconds() { return this.sessionSeconds ?? this.preparedSeconds; }
  get milliseconds() { return this.seconds * 1000; }
  updatePreparation(value: unknown) {
    if (!isInterviewDurationSeconds(value)) return false;
    this.preparedSeconds = value;
    return true;
  }
  beginSession() { this.sessionSeconds = this.preparedSeconds; this.confirmed = false; return this.seconds; }
  confirmSession(value: unknown) {
    if (!isInterviewDurationSeconds(value)) throw new Error('서버에서 면접 시간을 확인하지 못했습니다. 면접 준비 상태를 다시 확인해 주세요.');
    if (this.confirmed && this.sessionSeconds !== value) throw new Error('진행 중인 면접의 시간 설정이 변경되었습니다.');
    this.sessionSeconds = value; this.confirmed = true;
    return value;
  }
  resetSession() { this.sessionSeconds = null; this.confirmed = false; }
  hasExpired(elapsedMs: number) { return Number.isFinite(elapsedMs) && elapsedMs >= this.milliseconds; }
  remainingSeconds(elapsedMs: number) {
    const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
    return Math.max(0, Math.ceil((this.milliseconds - elapsed) / 1000));
  }
}

export function shouldSubmitSpace(event: {code:string;repeat:boolean;isComposing:boolean;target:EventTarget|null}, phase:string) {
  if(phase!=='listening'||event.code!=='Space'||event.repeat||event.isComposing) return false;
  const element=event.target as {tagName?:string;isContentEditable?:boolean;closest?:(selector:string)=>unknown}|null;
  return !element?.isContentEditable && !/^(INPUT|TEXTAREA|SELECT|BUTTON)$/i.test(element?.tagName||'') && !element?.closest?.('[contenteditable="true"]');
}
