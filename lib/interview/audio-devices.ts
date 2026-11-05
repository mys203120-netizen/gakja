/** Browser input devices, including Bluetooth headsets, use the same MediaDevices API.
 * MDN: /MediaDevices/getUserMedia, /MediaDevices/enumerateDevices,
 * /MediaStreamTrack/mute_event, /MediaStreamTrack/ended_event.
 */
export interface MicrophoneSelection { id: string; label: string; groupId: string }
export type InputDevice = Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label' | 'groupId'>;
export type MicrophoneStatus = 'idle' | 'connecting' | 'ready' | 'muted' | 'disconnected' | 'unavailable';
export interface MicrophoneMediaDevices {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  getSupportedConstraints?(): MediaTrackSupportedConstraints;
}
export const defaultMicrophoneSelection = (): MicrophoneSelection => ({ id: 'default', label: '', groupId: '' });
export const isInputAlias = (id: string) => !id || id === 'default' || id === 'communications';
export const liveAudioTrack = (stream: MediaStream | null) => stream?.getAudioTracks().find(track => track.readyState === 'live') ?? null;
export function stopMediaStream(stream: MediaStream | null) { stream?.getTracks().forEach(track => track.stop()); }
export const devicePreparationTimeouts = Object.freeze({ permissionMs: 20000, audioActivationMs: 5000, workletMs: 10000, enumerationMs: 3000 });
export type DevicePreparationStage = 'microphone_permission' | 'camera_permission' | 'audio_activation' | 'audio_worklet' | 'speaker_output' | 'device_enumeration';
export class DevicePreparationTimeout extends Error {
  constructor(readonly stage: DevicePreparationStage) { super(`DEVICE_PREPARATION_TIMEOUT:${stage}`); this.name = 'DevicePreparationTimeout'; }
}
/** Native permission prompts cannot be aborted. Reject our attempt and dispose any eventual late resource. */
export function boundedDeviceOperation<T>(operation: PromiseLike<T>, stage: DevicePreparationStage, options: { timeoutMs: number; signal?: AbortSignal; isCurrent?: () => boolean; onLateValue?: (value: T) => void }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (failure: Error) => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', cancelled); reject(failure); };
    const cancelled = () => finish(new CancelledDeviceRequest());
    const timer = setTimeout(() => finish(new DevicePreparationTimeout(stage)), options.timeoutMs);
    options.signal?.addEventListener('abort', cancelled, { once: true });
    if (options.signal?.aborted) cancelled();
    Promise.resolve(operation).then(value => {
      if (settled || options.signal?.aborted || options.isCurrent?.() === false) { options.onLateValue?.(value); if (!settled) cancelled(); return; }
      settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', cancelled); resolve(value);
    }, failure => { if (!settled) finish(failure instanceof Error ? failure : new Error('장치 연결을 확인하지 못했습니다.')); });
  });
}
export function usableMicrophone(stream: MediaStream | null, audioState: string | undefined, wanted = true) {
  const track = liveAudioTrack(stream);
  return Boolean(wanted && track?.enabled && !track.muted && audioState === 'running');
}

/** Undefined means reconnect the remembered input; an empty permission-gated ID means default. */
export function selectMicrophone(id: string | undefined, previous: MicrophoneSelection, devices: readonly InputDevice[]): MicrophoneSelection {
  if (id === undefined) return previous;
  const normalized = id.trim() || 'default';
  const device = devices.find(item => item.kind === 'audioinput' && item.deviceId === normalized);
  return { id: normalized, label: device?.label || (normalized === previous.id ? previous.label : ''), groupId: device?.groupId || (normalized === previous.id ? previous.groupId : '') };
}

/** Reconnect an explicit input only by its ID or an unambiguous label AND group identity. */
export function resolveMicrophone(selection: MicrophoneSelection, devices: readonly InputDevice[]) {
  const inputs = devices.filter(device => device.kind === 'audioinput');
  const exact = inputs.find(device => device.deviceId === selection.id);
  if (exact) return { available: true, selection: { ...selection, label: exact.label || selection.label, groupId: exact.groupId || selection.groupId } };
  if (selection.id === 'default') return { available: inputs.some(device => Boolean(device.deviceId || device.label)), selection };
  if (selection.label && selection.groupId && !isInputAlias(selection.id)) {
    const same = inputs.filter(device => !isInputAlias(device.deviceId) && device.label === selection.label && device.groupId === selection.groupId);
    if (same.length === 1) return { available: true, selection: { id: same[0].deviceId, label: same[0].label, groupId: same[0].groupId } };
  }
  return { available: false, selection };
}

export function microphoneConstraints(selection: MicrophoneSelection, supported: MediaTrackSupportedConstraints, relaxed = false): MediaStreamConstraints {
  const audio: MediaTrackConstraints = selection.id && selection.id !== 'default' ? { deviceId: { exact: selection.id } } : {};
  if (!relaxed) {
    if (supported.channelCount) audio.channelCount = { ideal: 1 };
    if (supported.echoCancellation) audio.echoCancellation = { ideal: true };
    if (supported.noiseSuppression) audio.noiseSuppression = { ideal: true };
    if (supported.autoGainControl) audio.autoGainControl = { ideal: true };
  }
  // No sampleRate or mandatory processing settings: AudioWorklet resamples the actual rate.
  return { audio: Object.keys(audio).length ? audio : true, video: false };
}

export class CancelledDeviceRequest extends Error {
  constructor() { super('장치 준비가 취소되었습니다.'); this.name = 'CancelledDeviceRequest'; }
}
export class SelectedInputMismatch extends Error {
  constructor() { super('선택한 마이크와 실제 입력 장치가 다릅니다.'); this.name = 'SelectedInputMismatch'; }
}
function errorName(error: unknown) { return error && typeof error === 'object' && 'name' in error ? String(error.name) : ''; }
function canRelax(error: unknown) {
  const name = errorName(error);
  const constraint = error && typeof error === 'object' && 'constraint' in error ? String(error.constraint) : '';
  return (name === 'OverconstrainedError' && constraint !== 'deviceId') || ['NotReadableError', 'AbortError', 'NotSupportedError'].includes(name);
}

/** A single processing fallback keeps the exact chosen input. Permission failures never retry. */
export async function acquireMicrophone(media: MicrophoneMediaDevices, selection: MicrophoneSelection, isCurrent: () => boolean = () => true, options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  if (!isCurrent() || options.signal?.aborted) throw new CancelledDeviceRequest();
  const supported = media.getSupportedConstraints?.() ?? {};
  const deadline = Date.now() + (options.timeoutMs ?? devicePreparationTimeouts.permissionMs);
  const open = (relaxed = false) => boundedDeviceOperation(media.getUserMedia(microphoneConstraints(selection, supported, relaxed)), 'microphone_permission', { timeoutMs: Math.max(1, deadline - Date.now()), signal: options.signal, isCurrent, onLateValue: stopMediaStream });
  let stream: MediaStream;
  try { stream = await open(); }
  catch (error) {
    if (!isCurrent()) throw new CancelledDeviceRequest();
    if (!canRelax(error)) throw error;
    stream = await open(true);
  }
  if (!isCurrent()) { stopMediaStream(stream); throw new CancelledDeviceRequest(); }
  const track = liveAudioTrack(stream);
  const actualId = track?.getSettings().deviceId ?? '';
  if (!track || (!isInputAlias(selection.id) && actualId && !isInputAlias(actualId) && actualId !== selection.id)) {
    stopMediaStream(stream);
    throw !track ? new DOMException('입력 트랙이 없습니다.', 'NotFoundError') : new SelectedInputMismatch();
  }
  return stream;
}

export function microphoneErrorMessage(error: unknown, selection: MicrophoneSelection) {
  const label = selection.label ? `선택한 마이크(${selection.label})` : '선택한 마이크';
  switch (errorName(error)) {
    case 'DevicePreparationTimeout': {
      const stage = (error as DevicePreparationTimeout).stage;
      return stage === 'microphone_permission' ? '마이크 권한 응답을 기다리는 시간이 길어졌습니다. 브라우저의 마이크 권한을 확인한 뒤 다시 확인을 눌러 주세요.' : stage === 'audio_activation' ? '음성 장치를 활성화하지 못했습니다. 화면에서 마이크 다시 확인을 눌러 주세요.' : '음성 장치 준비에 시간이 걸리고 있습니다. 연결 상태를 확인한 뒤 마이크 다시 확인을 눌러 주세요.';
    }
    case 'NotAllowedError': case 'SecurityError': return '마이크 권한이 허용되지 않았습니다. 브라우저와 Windows의 마이크 권한을 확인한 뒤 다시 켜 주세요.';
    case 'NotFoundError': case 'OverconstrainedError': return `${label} 입력을 브라우저에서 찾을 수 없습니다. Windows 설정 → 시스템 → 소리 → 입력에서 장치가 표시되는지 확인하고 다시 연결해 주세요. Bluetooth 출력만 연결된 경우 통화용 마이크(핸즈프리/HFP)가 Windows 입력 장치로 활성화되어 있는지도 확인해 주세요.`;
    case 'NotReadableError': case 'AbortError': return `${label}를 열 수 없습니다. 다른 통화 앱의 마이크 사용과 Windows 입력 설정을 확인한 뒤 다시 켜 주세요.`;
    case 'SelectedInputMismatch': return '선택한 장치와 실제 마이크 입력이 달라 사용하지 않았습니다. 장치 목록에서 사용할 마이크를 다시 선택해 주세요.';
    default: return `${label}를 사용할 수 없습니다. 장치 연결과 브라우저 권한을 확인한 뒤 다시 켜 주세요.`;
  }
}
