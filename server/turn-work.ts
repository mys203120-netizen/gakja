/** One submission's technical waiting budget. Never part of the model contract. */
export interface TurnWorkClock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(timer: unknown): void;
}
export const systemTurnWorkClock: TurnWorkClock = {
  now: () => performance.now(),
  setTimeout: (callback, milliseconds) => { const timer = setTimeout(callback, milliseconds); timer.unref?.(); return timer; },
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
export type TurnWorkFailureCode = 'TURN_WORK_TIMEOUT' | 'TURN_WORK_CANCELLED' | 'TURN_WORK_RETIRED' | 'TURN_STAGE_TIMEOUT';
export class TurnWorkError extends Error {
  get status() { return this.code === 'TURN_WORK_TIMEOUT' || this.code === 'TURN_STAGE_TIMEOUT' ? 408 : 409; }
  constructor(readonly code: TurnWorkFailureCode) { super(code === 'TURN_WORK_TIMEOUT' ? '다음 질문을 기다리는 시간이 초과되었습니다. 기록을 저장하고 면접을 마쳐 주세요.' : '현재 질문 준비가 중단되었습니다.'); }
}
export interface TurnWorkStage { signal: AbortSignal; timeoutMs: number }
export interface TurnWorkContextOptions {
  attemptId: string; timeoutMs: number; clock?: TurnWorkClock;
  assertCurrent?: () => void;
  onCancelled?: (code: TurnWorkFailureCode) => void;
}
export class TurnWorkContext {
  readonly attemptId: string;
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly clock: TurnWorkClock;
  private readonly deadline: number;
  private timer: unknown;
  private finished = false;
  constructor(private readonly options: TurnWorkContextOptions) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('TURN_WORK_BUDGET_INVALID');
    this.attemptId = options.attemptId; this.signal = this.controller.signal;
    this.clock = options.clock ?? systemTurnWorkClock;
    this.deadline = this.clock.now() + options.timeoutMs;
    this.timer = this.clock.setTimeout(() => this.cancel('TURN_WORK_TIMEOUT'), options.timeoutMs);
  }
  remainingMs() { return Math.max(0, this.deadline - this.clock.now()); }
  assertNotCancelled() {
    if (!this.finished && this.remainingMs() <= 0 && !this.signal.aborted) this.cancel('TURN_WORK_TIMEOUT');
    if (this.signal.aborted) throw this.signal.reason;
  }
  assertLive() {
    this.assertNotCancelled();
    this.options.assertCurrent?.();
  }
  cancel(code: TurnWorkFailureCode = 'TURN_WORK_CANCELLED') {
    if (this.finished || this.signal.aborted) return;
    this.clock.clearTimeout(this.timer);
    this.controller.abort(new TurnWorkError(code));
    this.options.onCancelled?.(code);
  }
  /** Durable work already accepted before cancellation retains its identity. */
  complete() { if (this.finished) return; this.finished = true; this.clock.clearTimeout(this.timer); }
  async run<T>(capMs: number, operation: (stage: TurnWorkStage) => Promise<T>): Promise<T> {
    if (this.finished) throw new TurnWorkError('TURN_WORK_RETIRED');
    this.assertLive();
    const timeoutMs = Math.min(capMs, this.remainingMs());
    if (!(timeoutMs > 0)) { this.cancel('TURN_WORK_TIMEOUT'); throw new TurnWorkError('TURN_WORK_TIMEOUT'); }
    const controller = new AbortController();
    const onAbort = () => controller.abort(this.signal.reason);
    this.signal.addEventListener('abort', onAbort, { once: true });
    const timer = this.clock.setTimeout(() => controller.abort(new TurnWorkError(this.remainingMs() <= 0 ? 'TURN_WORK_TIMEOUT' : 'TURN_STAGE_TIMEOUT')), timeoutMs);
    let rejectAbort!: (error: unknown) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const reject = () => rejectAbort(controller.signal.reason);
    controller.signal.addEventListener('abort', reject, { once: true });
    try {
      if (this.signal.aborted) onAbort();
      if (controller.signal.aborted) throw controller.signal.reason;
      const value = await Promise.race([operation({ signal: controller.signal, timeoutMs }), aborted]);
      this.assertLive();
      return value;
    } finally {
      this.clock.clearTimeout(timer);
      this.signal.removeEventListener('abort', onAbort);
      controller.signal.removeEventListener('abort', reject);
    }
  }
}
export function createTurnWorkContext(options: TurnWorkContextOptions) { return new TurnWorkContext(options); }
export function runTurnWorkStage<T>(context: TurnWorkContext | undefined, capMs: number, operation: (stage: TurnWorkStage) => Promise<T>) {
  if (context) return context.run(capMs, operation);
  // Legacy/offline callers retain their existing independent provider cap.
  return operation({ signal: Number.isFinite(capMs) ? AbortSignal.timeout(capMs) : new AbortController().signal, timeoutMs: capMs });
}
