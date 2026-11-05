import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('actual vision worker exposes bounded initialization diagnostics without stack or URL query values', async () => {
  const messages: Record<string, any>[] = [];
  const failure = Object.assign(new Error(`Wasm loader denied https://localhost/model?token=private-value&signature=secret-value\n${'x'.repeat(400)}`), { name: 'EvalError' });
  const imports: string[] = [];
  const context = vm.createContext({ importScripts: (url: string) => imports.push(url), Vision: { FaceLandmarker: { createFromOptions: async () => { throw failure; } }, FilesetResolver: { forVisionTasks: async () => ({}) } }, postMessage: (value: Record<string, unknown>) => messages.push(value), performance: { now: () => 0 } });
  const source = await readFile('public/face-metrics.worker.js', 'utf8');
  vm.runInContext(source, context); await context.onmessage({ data: { type: 'init' } });
  assert.deepEqual(imports, ['/vendor/mediapipe/vision_bundle.js']);
  assert.equal(messages.length, 1); assert.equal(messages[0].reason, 'model_unavailable');
  assert.equal(messages[0].diagnostic.stage, 'model_create'); assert.equal(messages[0].diagnostic.name, 'EvalError');
  assert.ok(messages[0].diagnostic.message.length <= 280); assert.doesNotMatch(messages[0].diagnostic.message, /private-value|secret-value|\n/);
  assert.equal(messages[0].diagnostic.stack, undefined); assert.equal(messages[0].bitmap, undefined);
});

test('actual vision worker invalidates gaze calibration when the camera changes and rejects old-camera calibration samples', async () => {
  const messages: Record<string, any>[] = [];
  const points = Array.from({ length: 478 }, () => ({ x: .5, y: .5, z: 0 }));
  Object.assign(points, { 33: { x: .2, y: .4 }, 133: { x: .4, y: .4 }, 159: { x: .3, y: .38 }, 145: { x: .3, y: .42 }, 468: { x: .3, y: .4 }, 362: { x: .6, y: .4 }, 263: { x: .8, y: .4 }, 386: { x: .7, y: .38 }, 374: { x: .7, y: .42 }, 473: { x: .7, y: .4 } });
  const detector = { detectForVideo: () => ({ faceLandmarks: [points], faceBlendshapes: [{ categories: [] }], facialTransformationMatrixes: [{ data: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }] }) };
  const context = vm.createContext({ importScripts: () => {}, Vision: { FaceLandmarker: { createFromOptions: async () => detector }, FilesetResolver: { forVisionTasks: async () => ({}) } }, postMessage: (value: Record<string, unknown>) => messages.push(value), performance: { now: () => 0 } });
  const source = await readFile('public/face-metrics.worker.js', 'utf8');
  vm.runInContext(source, context);
  const send = (data: Record<string, unknown>) => context.onmessage({ data });
  let timestamp = 0;
  const frame = (cameraRevision: number) => send({ type: 'frame', bitmap: { close() {} }, timestamp: timestamp += 150, phase: 'listening', turnId: 't1', cameraEnabled: true, cameraRevision });
  await send({ type: 'init' }); await send({ type: 'calibrate', cameraRevision: 1 });
  for (let index = 0; index < 12; index++) await frame(1);
  assert.equal(messages.filter(message => message.type === 'calibrated').length, 1);
  assert.equal(messages.at(-1)?.gazeOff, false);
  await send({ type: 'reset_calibration', cameraRevision: 2 }); await frame(2);
  assert.equal(messages.at(-1)?.gazeOff, null); assert.equal(messages.at(-1)?.qualityReason, 'not_calibrated');
  await send({ type: 'calibrate', cameraRevision: 2 });
  for (let index = 0; index < 11; index++) await frame(2);
  await frame(1); assert.equal(messages.filter(message => message.type === 'calibrated').length, 1);
  await frame(2);
  const calibrated = messages.filter(message => message.type === 'calibrated'); assert.equal(calibrated.length, 2); assert.equal(calibrated[1].cameraRevision, 2);
});
