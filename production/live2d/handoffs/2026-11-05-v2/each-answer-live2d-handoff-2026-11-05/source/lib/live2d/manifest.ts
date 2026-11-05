import { isSpeakerId, type SceneManifest } from './types';

export class ScenePreparationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'ScenePreparationError'; }
}

// This is the application's required control contract, not a list of IDs every
// Cubism model inherently has. The actual Core-extracted IDs are the authority.
export const requiredRuntimeParameterIds = [
  'ParamEyeLOpen', 'ParamEyeROpen', 'ParamEyeBallX', 'ParamEyeBallY',
  'ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBreath',
  'ParamMouthOpenY', 'ParamMouthForm',
] as const;

export function assertRuntimeParameterIds(ids: ReadonlySet<string>, speakerId: string): void {
  const missing = requiredRuntimeParameterIds.filter(id => !ids.has(id));
  if (missing.length) throw new ScenePreparationError('model_parameter_missing', `${speakerId} 모델에 필요한 제어 항목이 없습니다: ${missing.join(', ')}`);
}

export function assertRuntimeFrameParameters(parameters: Record<string, number>, ids: ReadonlySet<string>, speakerId: string): void {
  for (const [id, value] of Object.entries(parameters)) {
    if (!Number.isFinite(value)) throw new ScenePreparationError('frame_parameter_invalid', `${speakerId}의 제어 값이 올바르지 않습니다: ${id}`);
    if (!ids.has(id) && !(id === 'ParamQuestionGesture' && value === 0)) throw new ScenePreparationError('frame_parameter_missing', `${speakerId} 모델에 전달할 제어 항목이 없습니다: ${id}`);
  }
}

export function scenePreparationFailure(error: unknown): { code: string; message: string } {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(error.code)) {
    const message = 'message' in error && typeof error.message === 'string' ? error.message.slice(0, 1000) : '면접 장면을 준비하지 못했습니다.';
    return { code: error.code, message };
  }
  const message = error instanceof Error ? error.message : '';
  // loadCoreScript already gives useful Core-specific messages. Preserve their
  // category when that older loader reports an ordinary Error without a code.
  if (/MotionSync.*Core/i.test(message)) return { code: 'motionsync_core_unavailable', message: 'MotionSync Core 파일을 불러오지 못해 이미지로 표시합니다.' };
  if (/Cubism\s*Core/i.test(message)) return { code: 'cubism_core_unavailable', message: 'Cubism Core 파일을 불러오지 못해 이미지로 표시합니다.' };
  if (/Core|코어/i.test(message)) return { code: 'core_unavailable', message: 'Live2D Core 파일을 불러오지 못해 이미지로 표시합니다.' };
  if (/moc3|dedicated model|model settings/i.test(message)) return { code: 'model_load_failed', message: '전용 면접관 모델을 불러오지 못해 이미지로 표시합니다.' };
  return { code: 'prepare_failed', message: '면접 장면을 준비하지 못해 이미지로 표시합니다.' };
}

function assertSceneValidation(m: SceneManifest): void {
  const v = m.validation;
  if (v === undefined) {
    if (m.status === 'ready') throw new ScenePreparationError('delivery_validation_required', '전용 모델의 납품 검사와 실제 Core 로드 확인이 필요합니다.');
    return;
  }
  const flags = ['assetValidationPassed', 'modelLoadVerified', 'motionSyncVerified', 'runtimeQAComplete', 'releaseReady'] as const;
  if (!v || typeof v !== 'object' || typeof v.deliveryId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(v.deliveryId) || !['dedicated', 'sample'].includes(v.modelKind) || typeof v.reportSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(v.reportSha256) || flags.some(flag => typeof v[flag] !== 'boolean')) throw new ScenePreparationError('delivery_validation_invalid', '모델 납품 검사 기록의 형식과 보고서 해시를 확인해 주세요.');
  if (v.releaseReady && (m.status !== 'ready' || v.modelKind !== 'dedicated' || !v.assetValidationPassed || !v.modelLoadVerified || !v.motionSyncVerified || !v.runtimeQAComplete)) throw new ScenePreparationError('release_validation_incomplete', '필수 모델·립싱크·실행 검수가 모두 확인되어야 출시 준비 상태로 등록할 수 있습니다.');
  if (m.status === 'ready' && v.modelKind !== 'dedicated') throw new ScenePreparationError('sample_model_not_allowed', '샘플 모델은 전용 면접관 장면으로 등록할 수 없습니다.');
  if (m.status === 'ready' && (!v.assetValidationPassed || !v.modelLoadVerified)) throw new ScenePreparationError('model_validation_incomplete', '파일 검사와 실제 Core의 전용 모델 로드 확인이 필요합니다.');
}

export function sameOriginAsset(value: unknown, origin: string): string {
  if (typeof value !== 'string' || !value) throw new Error('장면 파일 경로가 필요합니다.');
  const url = new URL(value, origin);
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('장면 파일은 현재 서비스에서 불러와야 합니다.');
  return url.href;
}

export function parseSceneManifest(value: unknown, origin: string): SceneManifest {
  if (!value || typeof value !== 'object') throw new Error('장면 설정을 확인할 수 없습니다.');
  const m = value as SceneManifest;
  if (m.version !== 1 || !['blocked', 'ready'].includes(m.status) || !m.canvas || !Number.isFinite(m.canvas.width) || !Number.isFinite(m.canvas.height) || m.canvas.width <= 0 || m.canvas.height <= 0 || m.canvas.width > 8192 || m.canvas.height > 8192 || !Array.isArray(m.models) || !Array.isArray(m.layers) || !Array.isArray(m.blockers) || !m.blockers.every(x => typeof x === 'string')) throw new Error('장면 설정 형식이 올바르지 않습니다.');
  assertSceneValidation(m);
  sameOriginAsset(m.fallback, origin);
  for (const model of m.models) {
    if (!isSpeakerId(model.speakerId) || !model.layout || !['centerX', 'centerY', 'width', 'height'].every(key => Number.isFinite(model.layout[key as keyof typeof model.layout])) || model.layout.width <= 0 || model.layout.height <= 0) throw new Error('면접관의 배치 정보를 확인해 주세요.');
    sameOriginAsset(model.url, origin);
    if (model.motionSyncUrl) sameOriginAsset(model.motionSyncUrl, origin);
  }
  for (const layer of m.layers) {
    if (typeof layer.id !== 'string' || !Number.isFinite(layer.order)) throw new Error('장면 레이어 정보가 올바르지 않습니다.');
    sameOriginAsset(layer.url, origin);
  }
  if (m.runtime) {
    sameOriginAsset(m.runtime.moduleUrl, origin); sameOriginAsset(m.runtime.coreUrl, origin);
    if (!['amplitude', 'motion-sync'].includes(m.runtime.lipSync)) throw new Error('립싱크 방식을 확인해 주세요.');
    if (m.runtime.motionSyncCoreUrl) sameOriginAsset(m.runtime.motionSyncCoreUrl, origin);
  }
  if (m.status === 'ready' && (!m.runtime || m.models.length !== 2 || new Set(m.models.map(model => model.speakerId)).size !== 2 || m.blockers.length > 0)) throw new Error('두 면접관의 실제 실행 파일이 모두 필요합니다.');
  if (m.status === 'ready' && m.runtime?.lipSync === 'motion-sync' && (!m.runtime.motionSyncCoreUrl || m.models.some(model => !model.motionSyncUrl))) throw new Error('MotionSync 실행 파일과 모델별 설정이 필요합니다.');
  return m;
}
