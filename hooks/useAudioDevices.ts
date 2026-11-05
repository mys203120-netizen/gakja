'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { acquireMicrophone, boundedDeviceOperation, devicePreparationTimeouts, CancelledDeviceRequest, defaultMicrophoneSelection, isInputAlias, liveAudioTrack, microphoneErrorMessage, resolveMicrophone, selectMicrophone, stopMediaStream, usableMicrophone, type MicrophoneSelection, type MicrophoneStatus } from '@/lib/interview/audio-devices';

type SinkContext = AudioContext & { setSinkId?: (deviceId: string) => Promise<void> };
export function useAudioDevices() {
  const [micStream, setMicStream] = useState<MediaStream | null>(null), [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [micEnabled, setMicEnabled] = useState(false), [cameraEnabled, setCameraEnabled] = useState(false);
  const [micStatus, setMicStatus] = useState<MicrophoneStatus>('idle');
  const [selectedMicId, setSelectedMicId] = useState('default'), [selectedMicLabel, setSelectedMicLabel] = useState('기본 마이크');
  const [error, setError] = useState(''), [volume, setVolumeState] = useState(.85), [outputId, setOutputId] = useState('');
  const [canSetSinkId, setCanSetSinkId] = useState(false);
  const micRef = useRef<MediaStream | null>(null), cameraRef = useRef<MediaStream | null>(null), deviceList = useRef<MediaDeviceInfo[]>([]);
  const selectedMic = useRef<MicrophoneSelection>(defaultMicrophoneSelection()), micWanted = useRef(false), captureWanted = useRef(false);
  const context = useRef<SinkContext | null>(null), worklet = useRef<AudioWorkletNode | null>(null);
  const source = useRef<MediaStreamAudioSourceNode | null>(null), micAnalyser = useRef<AnalyserNode | null>(null);
  const outputAnalyser = useRef<AnalyserNode | null>(null), gain = useRef<GainNode | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null), pcmCallback = useRef<(b: ArrayBuffer) => void>(() => {});
  const flushResolvers = useRef(new Map<string, () => void>()), micListenerCleanup = useRef<() => void>(() => {});
  const lifecycle = useRef(0), micRequest = useRef(0), cameraRequest = useRef(0), enumeration = useRef(0), deviceChangeRequest = useRef(0);
  const initialization = useRef<Promise<void> | null>(null), micConnecting = useRef(false), resumePending = useRef<Promise<void> | null>(null);
  const micAttempt = useRef<AbortController | null>(null), cameraAttempt = useRef<AbortController | null>(null);
  const volumeRef = useRef(volume), outputRef = useRef(outputId), lastMicError = useRef('');
  const permissionPreviouslyGranted = useRef(false), recoveryPending = useRef(false), lastRecoveryKey = useRef('');
  const requestMicRef = useRef<(id?: string, automatic?: boolean) => Promise<MediaStream>>(async () => { throw new CancelledDeviceRequest(); });
  const deviceChangeRef = useRef<() => Promise<void>>(async () => {}), resumeRef = useRef<() => Promise<void>>(async () => {});
  volumeRef.current = volume; outputRef.current = outputId;

  const reportMicError = useCallback((message: string) => { lastMicError.current = message; setError(message); }, []);
  const clearMicError = useCallback(() => { const previous = lastMicError.current; lastMicError.current = ''; setError(value => value === previous ? '' : value); }, []);
  const rememberMic = useCallback((selection: MicrophoneSelection, actualLabel?: string) => {
    selectedMic.current = { ...selection, label: actualLabel || selection.label };
    setSelectedMicId(selection.id);
    const label = actualLabel || selection.label;
    setSelectedMicLabel(selection.id === 'default' ? (label ? `기본 입력 · ${label}` : '기본 마이크') : label || '선택한 마이크');
  }, []);
  const syncCapture = useCallback(() => {
    const track = liveAudioTrack(micRef.current);
    const enabled = Boolean(captureWanted.current && micWanted.current && track?.enabled && !track.muted && context.current?.state === 'running');
    worklet.current?.port.postMessage({ type: 'capture', enabled });
  }, []);
  const reflectMic = useCallback(() => {
    const track = liveAudioTrack(micRef.current);
    const usable = Boolean(track && micWanted.current && track.enabled && !track.muted && context.current?.state === 'running');
    setMicEnabled(usable);
    if (track) setMicStatus(usable ? 'ready' : 'muted');
    syncCapture();
  }, [syncCapture]);
  const detachMic = useCallback(() => {
    const old = micRef.current; micRef.current = null;
    micListenerCleanup.current(); micListenerCleanup.current = () => {};
    syncCapture(); source.current?.disconnect(); source.current = null;
    micAnalyser.current?.disconnect(); micAnalyser.current = null;
    stopMediaStream(old); setMicStream(null); setMicEnabled(false);
  }, [syncCapture]);
  const refreshDevices = useCallback(async () => {
    const request = ++enumeration.current, epoch = lifecycle.current;
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
      const list = await boundedDeviceOperation(navigator.mediaDevices.enumerateDevices(), 'device_enumeration', { timeoutMs: devicePreparationTimeouts.enumerationMs, isCurrent: () => epoch === lifecycle.current && request === enumeration.current });
      if (epoch === lifecycle.current && request === enumeration.current) { deviceList.current = list; setDevices(list); }
      return list;
    } catch { return deviceList.current; }
  }, []);

  const resumeContext = useCallback(async () => {
    if (resumePending.current) return resumePending.current;
    const current = context.current, epoch = lifecycle.current;
    if (!current || current.state === 'closed') return;
    const task = (async () => {
      try {
        if (current.state !== 'running' && !document.hidden) await boundedDeviceOperation(current.resume(), 'audio_activation', { timeoutMs: devicePreparationTimeouts.audioActivationMs, isCurrent: () => epoch === lifecycle.current && context.current === current });
        if (epoch !== lifecycle.current || context.current !== current) return;
        if (current.state !== 'running') throw new Error('interrupted');
        reflectMic();
        if (liveAudioTrack(micRef.current) && !liveAudioTrack(micRef.current)?.muted) clearMicError();
      } catch {
        if (epoch === lifecycle.current && context.current === current) {
          setMicEnabled(false); syncCapture();
          reportMicError('음성 장치가 일시 중단되었습니다. Bluetooth 연결을 확인하고 마이크 버튼을 눌러 다시 켜 주세요.');
        }
      }
    })();
    resumePending.current = task;
    try { await task; } finally { if (resumePending.current === task) resumePending.current = null; }
  }, [clearMicError, reflectMic, reportMicError, syncCapture]);
  resumeRef.current = resumeContext;

  const unlock = useCallback(async () => {
    if (initialization.current) return initialization.current;
    const epoch = lifecycle.current;
    let ownedContext: SinkContext | undefined;
    const task = (async () => {
      let activation: Promise<void> | undefined;
      if (context.current?.state === 'closed') { context.current = null; worklet.current = null; }
      if (!context.current) {
        // Keep the actual device sample rate; AudioWorklet performs the 16 kHz conversion.
        const current = new AudioContext({ latencyHint: 'interactive' }) as SinkContext;
        ownedContext = current; context.current = current;
        // Invoke the native resume inside the user's click, before worklet/network awaits consume activation.
        activation = boundedDeviceOperation(current.resume(), 'audio_activation', { timeoutMs: devicePreparationTimeouts.audioActivationMs, isCurrent: () => epoch === lifecycle.current && context.current === current });
        void activation.catch(() => {});
        setCanSetSinkId(typeof current.setSinkId === 'function');
        if (outputRef.current && current.setSinkId) await boundedDeviceOperation(current.setSinkId(outputRef.current), 'speaker_output', { timeoutMs: devicePreparationTimeouts.audioActivationMs });
        if (epoch !== lifecycle.current || context.current !== current) throw new CancelledDeviceRequest();
        const player = new Audio(); player.preload = 'auto'; audio.current = player;
        const output = current.createMediaElementSource(player);
        outputAnalyser.current = current.createAnalyser(); outputAnalyser.current.fftSize = 512;
        gain.current = current.createGain(); gain.current.gain.value = volumeRef.current;
        output.connect(outputAnalyser.current).connect(gain.current).connect(current.destination);
        await boundedDeviceOperation(current.audioWorklet.addModule('/audio-capture.worklet.js'), 'audio_worklet', { timeoutMs: devicePreparationTimeouts.workletMs, isCurrent: () => epoch === lifecycle.current && context.current === current });
        if (epoch !== lifecycle.current || context.current !== current) throw new CancelledDeviceRequest();
        const processor = new AudioWorkletNode(current, 'interview-pcm'); worklet.current = processor;
        const silent = current.createGain(); silent.gain.value = 0; processor.connect(silent).connect(current.destination);
        processor.port.onmessage = ({ data }) => {
          if (epoch !== lifecycle.current || worklet.current !== processor) return;
          if (data.type === 'pcm') pcmCallback.current(data.buffer);
          if (data.type === 'flushed') { flushResolvers.current.get(data.id)?.(); flushResolvers.current.delete(data.id); }
        };
        current.onstatechange = () => {
          if (epoch !== lifecycle.current || context.current !== current) return;
          if (current.state === 'running') reflectMic();
          else {
            setMicEnabled(false); syncCapture();
            if (micWanted.current && current.state !== 'closed' && !initialization.current) void resumeRef.current();
            else if (micWanted.current) reportMicError('음성 연결이 종료되었습니다. 마이크를 다시 켜 주세요.');
          }
        };
      }
      const current = context.current;
      await (activation ?? boundedDeviceOperation(current.resume(), 'audio_activation', { timeoutMs: devicePreparationTimeouts.audioActivationMs, isCurrent: () => epoch === lifecycle.current && context.current === current }));
      if (epoch !== lifecycle.current || context.current !== current) throw new CancelledDeviceRequest();
      if (current.state !== 'running') throw new Error('음성 장치를 재개하지 못했습니다. 마이크 버튼을 눌러 다시 시도해 주세요.');
      reflectMic();
    })();
    initialization.current = task;
    try { await task; }
    catch (failure) {
      if (ownedContext && context.current === ownedContext && epoch === lifecycle.current) {
        ownedContext.onstatechange = null; void ownedContext.close().catch(() => {}); context.current = null;
        if (worklet.current) { worklet.current.port.onmessage = null; worklet.current.disconnect(); worklet.current = null; }
        outputAnalyser.current?.disconnect(); outputAnalyser.current = null; gain.current?.disconnect(); gain.current = null;
        audio.current?.pause(); audio.current = null;
      }
      throw failure;
    } finally { if (initialization.current === task) initialization.current = null; }
  }, [reflectMic, reportMicError, syncCapture]);

  const requestMicInternal = useCallback(async (deviceId?: string, automatic = false) => {
    micAttempt.current?.abort(); const attempt = new AbortController(); micAttempt.current = attempt;
    ++deviceChangeRequest.current;
    const selection = selectMicrophone(deviceId, selectedMic.current, deviceList.current);
    const wanted = liveAudioTrack(micRef.current) ? micWanted.current : true;
    rememberMic(selection);
    if (!automatic) lastRecoveryKey.current = '';
    const requestId = ++micRequest.current, epoch = lifecycle.current;
    const ownsRequest = () => requestId === micRequest.current && epoch === lifecycle.current;
    const valid = () => ownsRequest() && !attempt.signal.aborted;
    micConnecting.current = true; micWanted.current = wanted;
    detachMic(); setMicStatus('connecting');
    let acquired: MediaStream | null = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new DOMException('마이크 입력 API를 사용할 수 없습니다.', 'NotFoundError');
      // Permission and audio activation are independent: neither may prevent the other's user prompt.
      const activated = unlock();
      const microphone = acquireMicrophone(navigator.mediaDevices, selection, valid, { signal: attempt.signal }).then(stream => { if (!valid()) { stopMediaStream(stream); throw new CancelledDeviceRequest(); } acquired = stream; return stream; });
      const [, installedMicrophone] = await Promise.all([activated, microphone]);
      acquired = installedMicrophone;
      const current = context.current;
      if (!valid() || context.current !== current || !current || current.state === 'closed') throw new CancelledDeviceRequest();
      const track = liveAudioTrack(acquired)!;
      track.enabled = micWanted.current;
      const input = current.createMediaStreamSource(acquired), analyser = current.createAnalyser(); analyser.fftSize = 512;
      input.connect(analyser); input.connect(worklet.current!);
      source.current = input; micAnalyser.current = analyser; micRef.current = acquired;
      const installed = acquired;
      const ended = () => {
        if (micRef.current !== installed) return;
        detachMic(); setMicStatus('disconnected');
        reportMicError(`${selectedMic.current.label || '마이크'} 연결이 끊겼습니다. 선택한 장치를 기억하고 있습니다. 다시 연결하거나 마이크를 다시 켜 주세요.`);
        void deviceChangeRef.current();
      };
      const muted = () => {
        if (micRef.current !== installed) return;
        reflectMic(); reportMicError('마이크 입력이 일시 중단되었습니다. Bluetooth 연결과 Windows 입력 설정을 확인해 주세요.');
      };
      const unmuted = () => { if (micRef.current === installed) { void resumeRef.current(); reflectMic(); clearMicError(); } };
      track.addEventListener('ended', ended); track.addEventListener('mute', muted); track.addEventListener('unmute', unmuted);
      micListenerCleanup.current = () => { track.removeEventListener('ended', ended); track.removeEventListener('mute', muted); track.removeEventListener('unmute', unmuted); };
      permissionPreviouslyGranted.current = true;
      rememberMic({ ...selection, groupId: track.getSettings().groupId || selection.groupId }, track.label);
      setMicStream(installed); reflectMic(); clearMicError();
      if (track.muted) reportMicError('선택한 마이크의 입력이 일시 중단되어 있습니다. Bluetooth 통화용 입력과 Windows 소리 설정을 확인한 뒤 다시 켜 주세요.');
      void refreshDevices();
      if (!valid()) throw new CancelledDeviceRequest();
      return installed;
    } catch (failure) {
      attempt.abort();
      if (acquired && micRef.current !== acquired) stopMediaStream(acquired);
      if (ownsRequest() && !(failure instanceof CancelledDeviceRequest)) { setMicStatus('unavailable'); setMicEnabled(false); reportMicError(microphoneErrorMessage(failure, selection)); }
      throw failure;
    } finally { if (ownsRequest()) micConnecting.current = false; if (micAttempt.current === attempt) micAttempt.current = null; }
  }, [clearMicError, detachMic, reflectMic, refreshDevices, rememberMic, reportMicError, unlock]);
  requestMicRef.current = requestMicInternal;
  const requestMic = useCallback((deviceId?: string) => requestMicInternal(deviceId), [requestMicInternal]);

  const handleDeviceChange = useCallback(async () => {
    const changeId = ++deviceChangeRequest.current, epoch = lifecycle.current, list = await refreshDevices();
    if (changeId !== deviceChangeRequest.current || epoch !== lifecycle.current || !micWanted.current || micConnecting.current) return;
    const resolved = resolveMicrophone(selectedMic.current, list);
    if (resolved.selection.id !== selectedMic.current.id) rememberMic(resolved.selection);
    const selection = selectedMic.current;
    let track = liveAudioTrack(micRef.current);
    const exposed = list.some(device => device.kind === 'audioinput' && Boolean(device.deviceId || device.label));
    const actual = track?.getSettings();
    const wrongInput = Boolean(track && !isInputAlias(selection.id) && actual?.deviceId && !isInputAlias(actual.deviceId) && actual.deviceId !== selection.id);
    const defaultDevice = list.find(device => device.kind === 'audioinput' && device.deviceId === 'default');
    const defaultChanged = Boolean(selection.id === 'default' && defaultDevice?.groupId && actual?.groupId && defaultDevice.groupId !== actual.groupId);
    if (wrongInput || (exposed && !resolved.available)) {
      detachMic(); setMicStatus('disconnected');
      reportMicError(microphoneErrorMessage(new DOMException('입력 연결이 끊겼습니다.', 'NotFoundError'), selection));
      if (!resolved.available) return;
      track = null;
    }
    await resumeContext();
    if (changeId !== deviceChangeRequest.current || epoch !== lifecycle.current || !micWanted.current || micConnecting.current) return;
    if ((!track || track.muted || defaultChanged) && resolved.available && permissionPreviouslyGranted.current && !recoveryPending.current) {
      const key = JSON.stringify({ selection: selection.id, devices: list.filter(device => device.kind === 'audioinput').map(device => [device.deviceId, device.groupId, device.label]) });
      if (lastRecoveryKey.current === key) return;
      recoveryPending.current = true;
      try {
        // Permission is read, never changed. Automatic recovery cannot request a new grant.
        const permission = await navigator.permissions?.query({ name: 'microphone' as PermissionName }).catch(() => null);
        if (permission?.state !== 'granted' || changeId !== deviceChangeRequest.current || epoch !== lifecycle.current || !micWanted.current || micConnecting.current || selectedMic.current.id !== selection.id) return;
        lastRecoveryKey.current = key;
        await requestMicRef.current(selection.id, true);
      } catch { /* requestMic reports the concrete error while preserving the selected input. */ }
      finally { recoveryPending.current = false; }
    }
  }, [detachMic, refreshDevices, rememberMic, reportMicError, resumeContext]);
  deviceChangeRef.current = handleDeviceChange;

  const requestCamera = useCallback(async (deviceId?: string) => {
    cameraAttempt.current?.abort(); const attempt = new AbortController(); cameraAttempt.current = attempt;
    const requestId = ++cameraRequest.current;
    try {
      const stream = await boundedDeviceOperation(navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 640 }, height: { ideal: 360 }, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) } }), 'camera_permission', { timeoutMs: devicePreparationTimeouts.permissionMs, signal: attempt.signal, isCurrent: () => requestId === cameraRequest.current, onLateValue: stopMediaStream });
      if (requestId !== cameraRequest.current) { stopMediaStream(stream); throw new CancelledDeviceRequest(); }
      stopMediaStream(cameraRef.current); cameraRef.current = stream;
      stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => { if (cameraRef.current === stream) { setCameraEnabled(false); setError('카메라 연결이 끊겼습니다. 장치를 확인하고 다시 켜 주세요.'); void refreshDevices(); } }));
      setCameraStream(stream); setCameraEnabled(true); setError(value => value.startsWith('카메라') ? '' : value);
      void refreshDevices();
      if (requestId !== cameraRequest.current) { stopMediaStream(stream); throw new CancelledDeviceRequest(); }
      return stream;
    } catch (failure) { if (requestId === cameraRequest.current && !(failure instanceof CancelledDeviceRequest)) setError('카메라 연결을 확인하지 못했습니다. 권한을 확인하고 다시 시도하거나 카메라 없이 진행해 주세요.'); throw failure; }
    finally { if (cameraAttempt.current === attempt) cameraAttempt.current = null; }
  }, [refreshDevices]);
  const disableCamera = useCallback(() => {
    // Invalidate a pending permission request before stopping an installed preview.
    ++cameraRequest.current;
    cameraAttempt.current?.abort(); cameraAttempt.current = null;
    const current = cameraRef.current; cameraRef.current = null;
    stopMediaStream(current); setCameraStream(null); setCameraEnabled(false);
    setError(value => value.startsWith('카메라') ? '' : value);
  }, []);
  const toggleMic = useCallback(async () => {
    const track = liveAudioTrack(micRef.current);
    if (!track || track.muted || context.current?.state !== 'running') { micWanted.current = true; await requestMic(); return; }
    micWanted.current = !micWanted.current; track.enabled = micWanted.current; reflectMic(); clearMicError();
  }, [clearMicError, reflectMic, requestMic]);
  const toggleCamera = useCallback(async () => {
    if (!cameraRef.current?.active) { await requestCamera(); return; }
    const enabled = !cameraRef.current.getVideoTracks()[0]?.enabled;
    cameraRef.current.getVideoTracks().forEach(track => { track.enabled = enabled; }); setCameraEnabled(enabled);
  }, [requestCamera]);
  const setVolume = useCallback((value: number) => { setVolumeState(value); volumeRef.current = value; if (gain.current) gain.current.gain.value = value; }, []);
  const selectOutput = useCallback(async (id: string) => {
    try { await unlock(); if (context.current?.setSinkId) { await context.current.setSinkId(id); outputRef.current = id; setOutputId(id); await resumeContext(); } }
    catch { setError('선택한 스피커를 사용할 수 없습니다. 기본 출력을 선택해 주세요.'); }
  }, [resumeContext, unlock]);
  const capture = useCallback((enabled: boolean) => { captureWanted.current = enabled; syncCapture(); }, [syncCapture]);
  const setPcmHandler = useCallback((handler: (buffer: ArrayBuffer) => void) => { pcmCallback.current = handler; }, []);
  const flush = useCallback(() => new Promise<void>(resolve => {
    if (!worklet.current) return resolve();
    const id = crypto.randomUUID(); flushResolvers.current.set(id, resolve); worklet.current.port.postMessage({ type: 'flush', id });
    setTimeout(() => { flushResolvers.current.delete(id); resolve(); }, 500);
  }), []);
  const stop = useCallback(() => {
    ++lifecycle.current; ++micRequest.current; ++cameraRequest.current; ++enumeration.current; ++deviceChangeRequest.current;
    micAttempt.current?.abort(); micAttempt.current = null; cameraAttempt.current?.abort(); cameraAttempt.current = null;
    initialization.current = null; resumePending.current = null; micConnecting.current = false;
    captureWanted.current = false; micWanted.current = false; recoveryPending.current = false; lastRecoveryKey.current = '';
    detachMic(); stopMediaStream(cameraRef.current); cameraRef.current = null;
    setCameraStream(null); setCameraEnabled(false); setMicStatus('idle'); audio.current?.pause();
    if (audio.current) { audio.current.removeAttribute('src'); audio.current.load(); audio.current = null; }
    outputAnalyser.current?.disconnect(); outputAnalyser.current = null; gain.current?.disconnect(); gain.current = null;
    if (worklet.current) { worklet.current.port.onmessage = null; worklet.current.disconnect(); worklet.current = null; }
    flushResolvers.current.forEach(resolve => resolve()); flushResolvers.current.clear();
    const current = context.current; context.current = null;
    if (current) { current.onstatechange = null; void current.close().catch(() => {}); }
  }, [detachMic]);
  useEffect(() => {
    setCanSetSinkId(typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype);
    void refreshDevices();
    const changed = () => { void deviceChangeRef.current(); };
    const visible = () => { if (!document.hidden) void deviceChangeRef.current(); };
    navigator.mediaDevices?.addEventListener('devicechange', changed);
    document.addEventListener('visibilitychange', visible);
    return () => { navigator.mediaDevices?.removeEventListener('devicechange', changed); document.removeEventListener('visibilitychange', visible); stop(); };
  }, [refreshDevices, stop]);
  const isMicrophoneReady = useCallback(() => Boolean(worklet.current && usableMicrophone(micRef.current, context.current?.state, micWanted.current)), []);
  return { micStream, cameraStream, devices, micEnabled, cameraEnabled, micStatus, selectedMicId, selectedMicLabel, error, setError, volume, outputId, canSetSinkId, requestMic, reconnectMic: requestMic, requestCamera, disableCamera, toggleMic, toggleCamera, selectOutput, setVolume, unlock, capture, flush, stop, audio, micAnalyser, outputAnalyser, setPcmHandler, isMicrophoneReady };
}
export type AudioDevices = ReturnType<typeof useAudioDevices>;
