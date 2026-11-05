export type DeviceCheckState = 'checking' | 'ready' | 'error';
export type InterviewStartupState = { microphone: DeviceCheckState; camera: DeviceCheckState | 'skipped'; microphoneError: string; cameraError: string; startError: string; fullscreenPending: boolean; countdown: number | null };
export const initialStartupState: InterviewStartupState = { microphone: 'checking', camera: 'checking', microphoneError: '', cameraError: '', startError: '', fullscreenPending: false, countdown: null };
export type StartupAction = { type: 'open' } | { type: 'microphone'; status: DeviceCheckState; error?: string } | { type: 'camera'; status: DeviceCheckState | 'skipped'; error?: string } | { type: 'fullscreen_request' } | { type: 'blocked'; message: string } | { type: 'countdown'; value: number } | { type: 'launch' };
export function startupReducer(state: InterviewStartupState, action: StartupAction): InterviewStartupState {
  if (action.type === 'open') return { ...initialStartupState };
  if (action.type === 'microphone') return { ...state, microphone: action.status, microphoneError: action.error ?? '', startError: '' };
  if (action.type === 'camera') return { ...state, camera: action.status, cameraError: action.error ?? '', startError: '' };
  if (action.type === 'fullscreen_request') return { ...state, fullscreenPending: true, startError: '' };
  if (action.type === 'blocked') return { ...state, fullscreenPending: false, countdown: null, startError: action.message };
  if (action.type === 'countdown') return { ...state, fullscreenPending: false, countdown: action.value, startError: '' };
  return { ...state, fullscreenPending: false, countdown: null };
}
export function mayStartInterview(state: InterviewStartupState, devices: { microphoneLive: boolean; cameraLive: boolean }) {
  return !state.fullscreenPending && state.microphone === 'ready' && devices.microphoneLive && (state.camera === 'skipped' || state.camera === 'ready' && devices.cameraLive);
}
export function acceptStartupDeviceResult(requestEpoch: number, currentEpoch: number, choice?: string, requestId = 0, currentRequestId = requestId) { return requestEpoch === currentEpoch && requestId === currentRequestId && choice !== 'skipped'; }
export function isPreQuestionStartupPhase(phase: string) { return ['countdown', 'preparing', 'speaking_acknowledgement', 'preparing_next'].includes(phase); }
export function phaseAfterAcknowledgement(hadBegun: boolean): 'preparing' | 'preparing_next' { return hadBegun ? 'preparing_next' : 'preparing'; }
export function mayBeginFirstQuestion(input: { phase: string; fullscreenElement: unknown; startupTarget: unknown; hidden: boolean }) { return ['preparing', 'speaking_acknowledgement'].includes(input.phase) && input.startupTarget !== null && input.fullscreenElement === input.startupTarget && !input.hidden; }
/** A delayed native playing event must not cancel a newer countdown while its audio gate is paused. */
export function startupPlaybackAction(input: Parameters<typeof mayBeginFirstQuestion>[0] & { hadBegun: boolean; paused: boolean }): 'play' | 'pause' | 'return_to_check' {
  if (input.paused || input.phase === 'suspended') return 'pause';
  return !input.hadBegun && !mayBeginFirstQuestion(input) ? 'return_to_check' : 'play';
}
export function browserInterruptionAction(phase: string): 'ignore' | 'return_to_check' | 'pause' {
  if (phase === 'countdown' || phase === 'preparing') return 'return_to_check';
  return ['speaking_question', 'listening', 'finalizing_transcript', 'preparing_next', 'speaking_acknowledgement'].includes(phase) ? 'pause' : 'ignore';
}
export function startupFailureMessage(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (error instanceof Error && error.name === 'Error' && /[가-힣]/.test(message) && !/illegal invocation|cannot read|is not a function|not defined/i.test(message)) return message.slice(0, 300);
  return '면접 시작을 준비하지 못했습니다. 마이크와 전체화면 상태를 확인한 뒤 다시 눌러 주세요.';
}
type FullscreenTarget = { requestFullscreen?: () => Promise<void> };
type FullscreenDocument = { fullscreenEnabled: boolean; fullscreenElement: unknown };
/** A cancelled request may clean up its fullscreen only until a newer user request owns the shell. */
export class FullscreenRequestGate {
  private latest = 0;
  begin() { return ++this.latest; }
  isCurrent(token: number) { return token === this.latest; }
}
/** Calls the native request synchronously, before any promise or permission wait can consume the gesture. */
export function requestConfirmedFullscreen(target: FullscreenTarget | null, document: FullscreenDocument): Promise<void> {
  if (!target || !document.fullscreenEnabled || !target.requestFullscreen) return Promise.reject(new Error('이 브라우저에서 전체화면을 시작할 수 없습니다. 전체화면을 지원하는 브라우저에서 다시 시도해 주세요.'));
  if (document.fullscreenElement === target) return Promise.resolve();
  let request: Promise<void>;
  try { request = target.requestFullscreen(); } catch { return Promise.reject(new Error('전체화면을 허용한 뒤 다시 시작해 주세요.')); }
  return Promise.resolve(request).then(() => { if (document.fullscreenElement !== target) throw new Error('전체화면 전환을 확인하지 못했습니다. 다시 눌러 주세요.'); });
}

export class InterviewStartupCountdown {
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private schedule: typeof setTimeout = setTimeout, private unschedule: typeof clearTimeout = clearTimeout) {}
  cancel() { this.revision++; if (this.timer !== null) this.unschedule.call(globalThis, this.timer); this.timer = null; }
  start(callbacks: { valid(): boolean; tick(value: number): void; ready(): void; interrupted(): void }, seconds = 3) {
    this.cancel(); const revision = this.revision;
    const tick = (remaining: number) => {
      if (revision !== this.revision) return;
      this.timer = null;
      if (!callbacks.valid()) { this.cancel(); callbacks.interrupted(); return; }
      if (remaining === 0) { callbacks.ready(); return; }
      callbacks.tick(remaining); this.timer = this.schedule.call(globalThis, () => tick(remaining - 1), 1000);
    };
    tick(seconds);
  }
}
