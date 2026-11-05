import type { CaptureScope } from './answer-capture';
export const TURN_WAIT_TIMEOUT_MESSAGE = '다음 질문을 기다리는 시간이 초과되었습니다. 기록을 저장하고 면접을 마쳐 주세요.';
export interface SubmissionWaitClock { setTimeout(callback: () => void, milliseconds: number): unknown; clearTimeout(timer: unknown): void }
/** Browser-local total wait starts at submit, before PCM tail/flush/network time. */
export class SubmissionWait {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  finishSent = false;
  private timer: unknown;
  private stopped = false;
  constructor(readonly scope: CaptureScope, readonly attemptId: string, timeoutMs: number, onTimeout: () => void,
    private clock: SubmissionWaitClock = { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) }) {
    this.timer = clock.setTimeout(() => { if (this.stopped) return; this.controller.abort(new Error(TURN_WAIT_TIMEOUT_MESSAGE)); this.stopped = true; onTimeout(); }, timeoutMs);
  }
  assertLive() { if (this.signal.aborted) throw this.signal.reason; }
  complete() { this.stopped = true; this.clock.clearTimeout(this.timer); }
  cancel() { this.complete(); this.controller.abort(); }
}
