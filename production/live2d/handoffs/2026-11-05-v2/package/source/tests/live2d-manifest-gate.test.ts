import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRuntimeFrameParameters, assertRuntimeParameterIds, parseSceneManifest, requiredRuntimeParameterIds, ScenePreparationError, scenePreparationFailure } from '../lib/live2d/manifest';
import type { SceneManifest } from '../lib/live2d/types';

// Synthetic reader-contract data only. No files, Core/model load, rendering or
// release qualification are asserted by the successful parsing cases below.
const origin = 'https://interview.test';
function developmentManifest(): SceneManifest {
  return {
    version: 1, status: 'ready', canvas: { width: 1920, height: 1080 }, fallback: '/reference.png',
    runtime: { moduleUrl: '/renderer.mjs', coreUrl: '/core.js', lipSync: 'motion-sync', motionSyncCoreUrl: '/motionsync-core.js' },
    models: [
      { speakerId: 'interviewer-1', url: '/male/model.model3.json', motionSyncUrl: '/male/model.motionsync3.json', layout: { centerX: 590, centerY: 520, width: 760, height: 850 } },
      { speakerId: 'interviewer-2', url: '/female/model.model3.json', motionSyncUrl: '/female/model.motionsync3.json', layout: { centerX: 1390, centerY: 520, width: 760, height: 850 } },
    ],
    layers: [], blockers: [],
    validation: { deliveryId: 'synthetic-reader-contract', modelKind: 'dedicated', assetValidationPassed: true, modelLoadVerified: true, motionSyncVerified: false, runtimeQAComplete: false, releaseReady: false, reportSha256: 'a'.repeat(64) },
  };
}
const coded = (code: string) => (error: unknown) => error instanceof ScenePreparationError && error.code === code;

test('existing blocked manifest needs no fabricated receipt and cannot imply release readiness', () => {
  const blocked = { version: 1, status: 'blocked', canvas: { width: 1920, height: 1080 }, fallback: '/reference.png', runtime: null, models: [], layers: [], blockers: ['Actual dedicated models are unavailable'] };
  const parsed = parseSceneManifest(blocked, origin);
  assert.equal(parsed.status, 'blocked');
  assert.equal(parsed.validation, undefined);
});

test('ready requires a dedicated L1/L2 delivery summary and a report hash, while dev ready remains unreleased', () => {
  const manifest = developmentManifest();
  const parsed = parseSceneManifest(manifest, origin);
  assert.equal(parsed.validation?.releaseReady, false);
  assert.equal(parsed.validation?.motionSyncVerified, false);
  const missing = developmentManifest(); delete missing.validation;
  assert.throws(() => parseSceneManifest(missing, origin), coded('delivery_validation_required'));
  for (const flag of ['assetValidationPassed', 'modelLoadVerified'] as const) {
    const incomplete = developmentManifest(); incomplete.validation![flag] = false;
    assert.throws(() => parseSceneManifest(incomplete, origin), coded('model_validation_incomplete'));
  }
});

test('a sample delivery cannot be enabled as the dedicated interviewer scene', () => {
  const sample = developmentManifest(); sample.validation!.modelKind = 'sample';
  assert.throws(() => parseSceneManifest(sample, origin), coded('sample_model_not_allowed'));
});

test('incomplete or malformed delivery evidence is rejected rather than inferred from paths', () => {
  for (const mutation of [
    (v: Record<string, unknown>) => { delete v.modelLoadVerified; },
    (v: Record<string, unknown>) => { v.assetValidationPassed = 'true'; },
    (v: Record<string, unknown>) => { v.reportSha256 = 'not-a-sha256'; },
    (v: Record<string, unknown>) => { v.deliveryId = ''; },
    (v: Record<string, unknown>) => { v.modelKind = 'dedicated-by-filename'; },
  ]) {
    const manifest = developmentManifest(); mutation(manifest.validation!);
    assert.throws(() => parseSceneManifest(manifest, origin), coded('delivery_validation_invalid'));
  }
});

test('releaseReady is accepted only after every required verification flag and ready/dedicated state', () => {
  const incomplete = developmentManifest(); incomplete.validation!.releaseReady = true;
  assert.throws(() => parseSceneManifest(incomplete, origin), coded('release_validation_incomplete'));
  const complete = developmentManifest();
  complete.validation!.motionSyncVerified = true; complete.validation!.runtimeQAComplete = true; complete.validation!.releaseReady = true;
  assert.equal(parseSceneManifest(complete, origin).validation?.releaseReady, true);
  for (const flag of ['assetValidationPassed', 'modelLoadVerified', 'motionSyncVerified', 'runtimeQAComplete'] as const) {
    const changed = structuredClone(complete); changed.validation![flag] = false;
    assert.throws(() => parseSceneManifest(changed, origin), coded('release_validation_incomplete'));
  }
  const blocked = structuredClone(complete); blocked.status = 'blocked';
  assert.throws(() => parseSceneManifest(blocked, origin), coded('release_validation_incomplete'));
});

test('each canonical runtime channel is required from the actual Core-extracted ID set', () => {
  const ids = new Set<string>(requiredRuntimeParameterIds);
  assert.doesNotThrow(() => assertRuntimeParameterIds(ids, 'interviewer-1'));
  for (const missing of requiredRuntimeParameterIds) {
    const actualIds = new Set(ids); actualIds.delete(missing);
    assert.throws(() => assertRuntimeParameterIds(actualIds, 'interviewer-2'), error => coded('model_parameter_missing')(error) && (error as Error).message.includes(missing));
  }
});

test('missing frame targets cannot be silently skipped; only a zero disabled hand target is optional', () => {
  const ids = new Set<string>(requiredRuntimeParameterIds);
  assert.doesNotThrow(() => assertRuntimeFrameParameters({ ParamAngleX: .2, ParamQuestionGesture: 0 }, ids, 'interviewer-1'));
  const missingTargets: Record<string, number>[] = [{ ParamQuestionGesture: .1 }, { MissingFromActualModel: .1 }, { MissingFromActualModel: 0 }];
  for (const parameters of missingTargets) assert.throws(() => assertRuntimeFrameParameters(parameters, ids, 'interviewer-1'), coded('frame_parameter_missing'));
  assert.throws(() => assertRuntimeFrameParameters({ ParamAngleX: NaN }, ids, 'interviewer-1'), coded('frame_parameter_invalid'));
});

test('specific preparation failures survive UI event forwarding, including older Core loader errors', () => {
  const missing = new ScenePreparationError('model_parameter_missing', 'interviewer-1: ParamMouthForm');
  assert.deepEqual(scenePreparationFailure(missing), { code: 'model_parameter_missing', message: missing.message });
  assert.equal(scenePreparationFailure(new Error('Live2D Core 파일이 필요합니다.')).code, 'core_unavailable');
  assert.equal(scenePreparationFailure(new Error('Live2DCubismCore is not defined')).code, 'cubism_core_unavailable');
  assert.equal(scenePreparationFailure(new Error('MotionSync Core has not been supplied.')).code, 'motionsync_core_unavailable');
  assert.equal(scenePreparationFailure(new Error('The dedicated moc3 file could not be loaded.')).code, 'model_load_failed');
  assert.equal(scenePreparationFailure(new Error('Unclassified network failure')).code, 'prepare_failed');
});
