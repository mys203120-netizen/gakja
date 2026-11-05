import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireMicrophone, boundedDeviceOperation, DevicePreparationTimeout, CancelledDeviceRequest, defaultMicrophoneSelection, microphoneConstraints, microphoneErrorMessage, resolveMicrophone, SelectedInputMismatch, selectMicrophone, usableMicrophone, type InputDevice, type MicrophoneMediaDevices, type MicrophoneSelection } from '../lib/interview/audio-devices';

const selected: MicrophoneSelection = { id: 'headset-input', label: 'AirPods microphone', groupId: 'headset-group' };
const devices: InputDevice[] = [
  { kind: 'audioinput', deviceId: 'default', label: 'Default input', groupId: 'internal-group' },
  { kind: 'audioinput', deviceId: 'internal-input', label: 'Internal microphone', groupId: 'internal-group' },
  { kind: 'audioinput', deviceId: selected.id, label: selected.label, groupId: selected.groupId },
  { kind: 'audiooutput', deviceId: 'headset-output', label: 'AirPods headphones', groupId: selected.groupId },
];
const supported = { channelCount: true, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
function fakeStream(id = selected.id) {
  let stopped = 0;
  const track = { readyState: 'live', label: selected.label, getSettings: () => ({ deviceId: id }), stop: () => { stopped++; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  return { stream, stopped: () => stopped };
}
function failure(name: string, constraint?: string) { return Object.assign(new Error(name), { name, constraint }); }

test('Bluetooth selection is exact; processing is only ideal, with no sample-rate constraint', () => {
  const first = microphoneConstraints(selected, supported);
  assert.deepEqual(first.audio, { deviceId: { exact: selected.id }, channelCount: { ideal: 1 }, echoCancellation: { ideal: true }, noiseSuppression: { ideal: true }, autoGainControl: { ideal: true } });
  assert.equal(first.video, false);
  assert.equal('sampleRate' in (first.audio as MediaTrackConstraints), false);
  assert.deepEqual(microphoneConstraints(selected, supported, true).audio, { deviceId: { exact: selected.id } });
  assert.deepEqual(microphoneConstraints(selected, {}).audio, { deviceId: { exact: selected.id } });
});

test('unsupported processing falls back once on the same exact headset, never default', async () => {
  const calls: MediaStreamConstraints[] = [], success = fakeStream();
  const media: MicrophoneMediaDevices = {
    getSupportedConstraints: () => supported,
    getUserMedia: async constraints => { calls.push(constraints); if (calls.length === 1) throw failure('OverconstrainedError', 'channelCount'); return success.stream; },
  };
  assert.equal(await acquireMicrophone(media, selected), success.stream);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { audio: { deviceId: { exact: selected.id } }, video: false });
});

test('Bluetooth route/hardware open failure gets one minimal-constraint retry on the same input', async () => {
  const calls: MediaStreamConstraints[] = [], success = fakeStream();
  const media = { getSupportedConstraints: () => supported, getUserMedia: async (c: MediaStreamConstraints) => { calls.push(c); if (calls.length === 1) throw failure('NotReadableError'); return success.stream; } };
  await acquireMicrophone(media, selected);
  assert.equal(calls.length, 2);
  assert.deepEqual((calls[1].audio as MediaTrackConstraints).deviceId, { exact: selected.id });
});

test('permission denial, missing input and unavailable exact ID never retry on another microphone', async () => {
  for (const error of [failure('NotAllowedError'), failure('NotFoundError'), failure('OverconstrainedError', 'deviceId')]) {
    let calls = 0;
    await assert.rejects(acquireMicrophone({ getSupportedConstraints: () => supported, getUserMedia: async () => { calls++; throw error; } }, selected), error);
    assert.equal(calls, 1);
  }
});

test('a browser returning a different concrete microphone is rejected and stopped', async () => {
  const wrong = fakeStream('internal-input');
  await assert.rejects(acquireMicrophone({ getUserMedia: async () => wrong.stream }, selected), SelectedInputMismatch);
  assert.equal(wrong.stopped(), 1);
});

test('default selection and permission-gated blank IDs never request an empty exact device ID', async () => {
  const choice = selectMicrophone('', selected, [{ kind: 'audioinput', deviceId: '', label: '', groupId: '' }]);
  assert.equal(choice.id, 'default');
  assert.equal(microphoneConstraints(choice, {}).audio, true);
  const actual = fakeStream('internal-input');
  assert.equal(await acquireMicrophone({ getUserMedia: async () => actual.stream }, choice), actual.stream);
  assert.equal(actual.stopped(), 0);
});

test('reconnect without a new ID preserves an explicitly selected headset', () => {
  assert.equal(selectMicrophone(undefined, selected, []), selected);
  assert.deepEqual(selectMicrophone(selected.id, selected, []), selected);
  assert.deepEqual(selectMicrophone('headset-input', defaultMicrophoneSelection(), devices), selected);
});

test('headphone output alone does not count as an available headset microphone', () => {
  const outputsOnly = devices.filter(device => device.kind === 'audiooutput');
  assert.equal(resolveMicrophone(selected, outputsOnly).available, false);
  assert.equal(resolveMicrophone(selected, devices.filter(device => device.deviceId !== selected.id)).available, false);
  assert.equal(resolveMicrophone(selected, devices).available, true);
  assert.equal(resolveMicrophone(selected, [{ kind: 'audioinput', deviceId: '', label: '', groupId: '' }]).available, false);
});

test('rotated IDs reconnect only to the same unambiguous label and group, never a matching label alone', () => {
  const rotated: InputDevice = { kind: 'audioinput', deviceId: 'new-headset-id', label: selected.label, groupId: selected.groupId };
  assert.equal(resolveMicrophone(selected, [rotated]).selection.id, 'new-headset-id');
  assert.equal(resolveMicrophone(selected, [{ ...rotated, groupId: 'different-device' }]).available, false);
  assert.equal(resolveMicrophone(selected, [rotated, { ...rotated, deviceId: 'ambiguous-second' }]).available, false);
});

test('a late stream after stop or a newer device request is stopped instead of becoming active', async () => {
  let current = true, resolve!: (stream: MediaStream) => void;
  const late = fakeStream();
  const pending = acquireMicrophone({ getUserMedia: () => new Promise<MediaStream>(done => { resolve = done; }) }, selected, () => current);
  current = false; resolve(late.stream);
  await assert.rejects(pending, CancelledDeviceRequest);
  assert.equal(late.stopped(), 1);
});

test('cancellation after the first failed open prevents a stale fallback from opening hardware', async () => {
  let current = true, calls = 0;
  await assert.rejects(acquireMicrophone({ getUserMedia: async () => { calls++; current = false; throw failure('NotReadableError'); } }, selected, () => current), CancelledDeviceRequest);
  assert.equal(calls, 1);
});

test('an exhausted selected-device fallback reports a specific OS/input hint without claiming browser support', async () => {
  let calls = 0;
  const error = failure('NotReadableError');
  await assert.rejects(acquireMicrophone({ getSupportedConstraints: () => supported, getUserMedia: async c => { calls++; assert.deepEqual((c.audio as MediaTrackConstraints).deviceId, { exact: selected.id }); throw error; } }, selected), error);
  assert.equal(calls, 2);
  const message = microphoneErrorMessage(failure('NotFoundError'), selected);
  assert.match(message, /Windows.*소리.*입력/);
  assert.match(message, /Bluetooth 출력만/);
  assert.match(microphoneErrorMessage(failure('NotAllowedError'), selected), /권한/);
});

test('an ignored permission prompt times out, permits a fresh retry, and stops a stream granted too late', async () => {
  let resolve!: (stream: MediaStream) => void; const late = fakeStream();
  const pending = acquireMicrophone({ getUserMedia: () => new Promise<MediaStream>(done => { resolve = done; }) }, selected, () => true, { timeoutMs: 10 });
  await assert.rejects(pending, error => error instanceof DevicePreparationTimeout && error.stage === 'microphone_permission');
  const fresh = fakeStream(); assert.equal(await acquireMicrophone({ getUserMedia: async () => fresh.stream }, selected), fresh.stream);
  resolve(late.stream); await new Promise(done => setTimeout(done, 0));
  assert.equal(late.stopped(), 1); assert.equal(fresh.stopped(), 0);
});
test('cancelling a pending permission request settles promptly and cleans its eventual stream without retry', async () => {
  const controller = new AbortController(), late = fakeStream(); let resolve!: (stream: MediaStream) => void, calls = 0;
  const pending = acquireMicrophone({ getUserMedia: () => { calls++; return new Promise<MediaStream>(done => { resolve = done; }); } }, selected, () => true, { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, CancelledDeviceRequest);
  resolve(late.stream); await new Promise(done => setTimeout(done, 0)); assert.equal(late.stopped(), 1); assert.equal(calls, 1);
  await assert.rejects(acquireMicrophone({ getUserMedia: async () => { calls++; return late.stream; } }, selected, () => true, { signal: controller.signal }), CancelledDeviceRequest);
  assert.equal(calls, 1);
});
test('audio activation and worklet loading cannot leave preparation pending forever or claim readiness', async () => {
  for (const stage of ['audio_activation', 'audio_worklet'] as const) {
    await assert.rejects(boundedDeviceOperation(new Promise<void>(() => {}), stage, { timeoutMs: 10 }), error => error instanceof DevicePreparationTimeout && error.stage === stage);
    await assert.doesNotReject(boundedDeviceOperation(Promise.resolve(), stage, { timeoutMs: 10 }));
  }
  assert.match(microphoneErrorMessage(new DevicePreparationTimeout('audio_activation'), selected), /다시 확인/);
  assert.match(microphoneErrorMessage(new DevicePreparationTimeout('microphone_permission'), selected), /권한 응답/);
  const input = fakeStream(), track = input.stream.getAudioTracks()[0]; track.enabled = true;
  assert.equal(usableMicrophone(input.stream, 'suspended'), false); assert.equal(usableMicrophone(input.stream, 'closed'), false);
  assert.equal(usableMicrophone(input.stream, 'running'), true); track.enabled = false; assert.equal(usableMicrophone(input.stream, 'running'), false);
  assert.equal(usableMicrophone(null, 'running'), false);
});
test('camera permission cancellation uses the same late-resource cleanup without enabling a preview', async () => {
  const controller = new AbortController(), late = fakeStream(); let resolve!: (stream: MediaStream) => void;
  const pending = boundedDeviceOperation(new Promise<MediaStream>(done => { resolve = done; }), 'camera_permission', { timeoutMs: 1000, signal: controller.signal, onLateValue: stream => stream.getTracks().forEach(track => track.stop()) });
  controller.abort(); await assert.rejects(pending, CancelledDeviceRequest);
  resolve(late.stream); await new Promise(done => setTimeout(done, 0)); assert.equal(late.stopped(), 1);
});
