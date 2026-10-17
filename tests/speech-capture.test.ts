import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSpeechTelemetry, MAX_SPEECH_CAPTURE_MS, MAX_SPEECH_SAMPLES, type RmsSample } from '../apps/web/src/lib/speech-telemetry';
import { decodeRecordingTelemetry, startSpeechCapture } from '../apps/web/src/lib/client/speech-recorder';
import { analyzeSpeech, validateSpeechTelemetry } from '../apps/web/src/lib/speech-analysis';

function frames(durationMs: number, level: (atMs: number) => number): RmsSample[] {
  return Array.from({ length: Math.ceil(durationMs / 100) }, (_, index) => ({ atMs: index * 100, rms: level(index * 100) }));
}

test('microphone evidence separates speech intervals while retaining breathing and longer gaps', () => {
  const telemetry = buildSpeechTelemetry(frames(5000, at => at >= 500 && at < 1500 || at >= 1800 && at < 2500 || at >= 4200 && at < 4500 ? .05 : .004), 5000)!;
  assert.deepEqual(telemetry.speechSegments, [{ startMs: 500, endMs: 1500 }, { startMs: 1800, endMs: 2500 }, { startMs: 4200, endMs: 4500 }]);
  assert.equal(telemetry.coverage.observedMs, 5000);
  assert.equal(telemetry.coverage.maxGapMs, 0);
  assert.equal(telemetry.method, 'rms-vad');
  // The report decides which internal gaps exceed 700ms/1500ms; no fabricated score here.
  assert.equal('score' in telemetry, false);
  assert.equal('samples' in telemetry, false);
  assert.ok(validateSpeechTelemetry(telemetry));
  assert.equal(analyzeSpeech({telemetry}).timing?.pauses.length, 1);
  assert.equal(analyzeSpeech({telemetry}).timing?.longPauseCount, 1);
});

test('normal room noise stays quiet and one low amplitude sample does not split a syllable', () => {
  const telemetry = buildSpeechTelemetry(frames(1000, at => at < 200 || at >= 800 || at === 500 ? .004 : .04), 1000)!;
  assert.deepEqual(telemetry.speechSegments, [{ startMs: 200, endMs: 800 }]);
  assert.ok(telemetry.analysis.speechThresholdRms > telemetry.analysis.noiseFloorRms);
});

test('soft continuous speech is retained without requiring an opening silence', () => {
  const telemetry = buildSpeechTelemetry(frames(1000, () => .018), 1000)!;
  assert.deepEqual(telemetry.speechSegments, [{ startMs: 0, endMs: 1000 }]);
});

test('background throttling is missing evidence rather than a long silent pause', () => {
  const telemetry = buildSpeechTelemetry([{ atMs: 0, rms: .04 }, { atMs: 100, rms: .04 }, { atMs: 3000, rms: .04 }, { atMs: 3100, rms: .04 }], 4000)!;
  assert.deepEqual(telemetry.observedSegments, [{ startMs: 0, endMs: 200 }, { startMs: 3000, endMs: 3200 }]);
  assert.deepEqual(telemetry.speechSegments, [{ startMs: 0, endMs: 200 }, { startMs: 3000, endMs: 3200 }]);
  assert.equal(telemetry.coverage.observedMs, 400);
  assert.equal(telemetry.coverage.maxGapMs, 2800);
  assert.ok(telemetry.limitations.includes('capture-gaps'));
  assert.ok(validateSpeechTelemetry(telemetry));
  assert.equal(analyzeSpeech({telemetry}).timing?.pauses.length, 0);
});

test('even a single missed frame cannot be labelled or merged into spoken time', () => {
  const telemetry = buildSpeechTelemetry([{ atMs: 0, rms: .04 }, { atMs: 200, rms: .04 }], 300)!;
  assert.deepEqual(telemetry.speechSegments, [{ startMs: 0, endMs: 100 }, { startMs: 200, endMs: 300 }]);
  assert.equal(telemetry.coverage.observedMs, 200);
  assert.ok(validateSpeechTelemetry(telemetry));
});

test('unavailable capture is unknown, while a fully observed quiet recording has empty speech', () => {
  assert.equal(buildSpeechTelemetry([], 1000), null);
  assert.equal(buildSpeechTelemetry([{ atMs: 0, rms: .03 }], NaN), null);
  const telemetry = buildSpeechTelemetry(frames(1000, () => 0), 1000)!;
  assert.deepEqual(telemetry.speechSegments, []);
  assert.equal(telemetry.coverage.observedMs, 1000);
});

test('amplitude and time bounds reject corrupt samples and deduplicate time stamps', () => {
  const telemetry = buildSpeechTelemetry([{ atMs: 100, rms: .03 }, { atMs: 0, rms: .03 }, { atMs: 0, rms: .03 }, { atMs: 200, rms: 2 }, { atMs: -20, rms: .03 }, { atMs: NaN, rms: .03 }, { atMs: 900, rms: Infinity }, { atMs: 1000, rms: .03 }], 1000)!;
  assert.deepEqual(telemetry.observedSegments, [{ startMs: 0, endMs: 200 }]);
  assert.equal(telemetry.coverage.observedMs, 200);
});

test('high background level is disclosed and bounded captures flag truncation', () => {
  const noisy = buildSpeechTelemetry(frames(1000, () => .04), 1000)!;
  assert.ok(noisy.limitations.includes('high-background-level'));
  const long = buildSpeechTelemetry(frames(MAX_SPEECH_CAPTURE_MS + 100, () => .03), MAX_SPEECH_CAPTURE_MS + 100)!;
  assert.equal(long.durationMs, MAX_SPEECH_CAPTURE_MS);
  assert.equal(long.coverage.truncated, true);
  assert.equal(long.coverage.observedMs, MAX_SPEECH_SAMPLES * 100);
});

async function fakeAudio(run: (state: { now: number; rms: number; tick(): void; connections: unknown[]; closes: number; disconnects: number; timers: Map<number, () => void>; stream: MediaStream }) => void | Promise<void>) {
  const originals = Object.fromEntries(['window', 'performance', 'setInterval', 'clearInterval'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const state = { now: 0, rms: .03, connections: [] as unknown[], closes: 0, disconnects: 0, timers: new Map<number, () => void>(), stream: { getAudioTracks: () => [{ readyState: 'live', stop() { throw new Error('Capture must not stop recorder-owned microphone tracks'); } }] } as unknown as MediaStream, tick() { for (const callback of this.timers.values()) callback(); } };
  let nextTimer = 0;
  class FakeAudioContext {
    state = 'suspended';
    destination = { speaker: true };
    createMediaStreamSource() { return { connect(node: unknown) { state.connections.push(node); }, disconnect() { state.disconnects++; } }; }
    createAnalyser() { return { fftSize: 0, getFloatTimeDomainData(values: Float32Array) { values.fill(state.rms); }, disconnect() { state.disconnects++; } }; }
    async decodeAudioData() { return { duration: 1, numberOfChannels: 1, sampleRate: 1000, length: 1000, getChannelData: () => Float32Array.from({length:1000},(_,index)=>index<200||index>=800?.004:.04) }; }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; state.closes++; }
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { AudioContext: FakeAudioContext } });
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => state.now } });
  Object.defineProperty(globalThis, 'setInterval', { configurable: true, value: (callback: () => void) => { const id = ++nextTimer; state.timers.set(id, callback); return id; } });
  Object.defineProperty(globalThis, 'clearInterval', { configurable: true, value: (id: number) => state.timers.delete(id) });
  try { await run(state); } finally {
    for (const [name, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
}

test('capture clocks exclude recorder pauses and dispose only owned WebAudio nodes', async () => {
  await fakeAudio(async state => {
    const capture = startSpeechCapture(state.stream)!;
    assert.ok(capture);
    await Promise.resolve();
    for (let index = 1; index <= 10; index++) { state.now = index * 100; state.tick(); }
    capture.pause();
    state.now = 10_000; state.tick();
    assert.equal(capture.elapsedMs(), 1000);
    capture.resume();
    for (let index = 1; index <= 5; index++) { state.now = 10_000 + index * 100; state.tick(); }
    const telemetry = capture.finish()!;
    assert.equal(telemetry.durationMs, 1500);
    assert.equal(telemetry.coverage.observedMs, 1500);
    assert.equal(capture.finish(), telemetry);
    assert.equal(state.connections.length, 1); // source -> analyser, never speaker.
    assert.equal(state.closes, 1);
    assert.equal(state.disconnects, 2);
    assert.equal(state.timers.size, 0);
    capture.dispose();
    assert.equal(state.closes, 1);
  });
});

test('discarding a recording clears intervals and cannot resurrect its measurement', async () => {
  await fakeAudio(async state => {
    const capture = startSpeechCapture(state.stream)!;
    await Promise.resolve(); state.now = 100; state.tick();
    capture.dispose(); state.now = 5000;
    assert.equal(capture.finish(), null);
    assert.equal(state.timers.size, 0);
    assert.equal(state.closes, 1);
  });
});

test('a stopped microphone never starts WebAudio analysis', async () => {
  await fakeAudio(state => {
    assert.equal(startSpeechCapture({ getAudioTracks: () => [{ readyState: 'ended' }] } as unknown as MediaStream), null);
    assert.equal(state.connections.length, 0);
    assert.equal(state.timers.size, 0);
  });
});

test('re-analysis decodes an owned file without microphone access or speaker playback', async () => {
  await fakeAudio(async state => {
    const telemetry = await decodeRecordingTelemetry(new Blob(['synthetic-decoder-fixture'], {type:'audio/wav'}));
    assert.ok(telemetry);
    assert.deepEqual(telemetry.speechSegments, [{startMs:200,endMs:800}]);
    assert.equal(telemetry.coverage.observedMs, 1000);
    assert.ok(validateSpeechTelemetry(telemetry));
    assert.equal(state.connections.length, 0);
    assert.equal(state.timers.size, 0);
    assert.equal(state.closes, 1);
    assert.equal(await decodeRecordingTelemetry(new Blob([])), null);
    assert.equal(state.closes, 1);
  });
});
