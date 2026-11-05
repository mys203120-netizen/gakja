import { readFile, realpath, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const origin = 'https://live2d-assets.invalid';
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = value => typeof value === 'string' && value.trim().length > 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const within = (root, target) => { const relative = path.relative(root, target); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

/** Static delivery check. Does not execute Core or certify art, rigging, licenses or devices. */
export async function verifyLive2DAssets(options = {}) {
  const publicRoot = path.resolve(options.publicRoot ?? path.join(repositoryRoot, 'public'));
  const manifestPath = path.resolve(options.manifestPath ?? path.join(publicRoot, 'live2d', 'scene.json'));
  const report = { status: 'blocked', scope: 'static-asset-integrity', runtimeValidation: 'not-run', releaseReady: false, checkedAt: new Date().toISOString(), manifestPath, errors: [], warnings: [], checkedFiles: [] };
  const error = message => { if (!report.errors.includes(message)) report.errors.push(message); };
  const warning = message => { if (!report.warnings.includes(message)) report.warnings.push(message); };
  const files = new Map();
  report.models = [];
  let realPublicRoot;
  try { realPublicRoot = await realpath(publicRoot); }
  catch { error(`공개 에셋 디렉터리가 없습니다: ${publicRoot}`); return report; }

  function assetUrl(value, base = `${origin}/`) {
    if (!text(value)) throw new Error('비어 있는 파일 경로');
    if (options.strictPaths) {
      if (/[\\\0%?#]/.test(value) || value.split('/').some(p => p === '..' || p === '.') || (base !== `${origin}/` && value.startsWith('/'))) throw new Error('상위 경로·인코딩·쿼리·절대 참조 없이 패키지 내부의 상대 경로를 사용해야 합니다');
    }
    const url = new URL(value, base);
    if (url.origin !== origin || url.username || url.password || !['https:', 'http:'].includes(url.protocol)) throw new Error('외부 URL은 검사할 수 없습니다');
    const decoded = decodeURIComponent(url.pathname);
    if (decoded.includes('\\') || decoded.includes('\0')) throw new Error('올바르지 않은 파일 경로');
    const filename = path.resolve(publicRoot, `.${decoded}`);
    if (!within(publicRoot, filename)) throw new Error('공개 디렉터리를 벗어난 경로');
    return { url, filename };
  }
  async function asset(value, kind, base, suffix) {
    try {
      const location = assetUrl(value, base);
      if (suffix && !location.url.pathname.toLowerCase().endsWith(suffix)) throw new Error(`${suffix} 확장자가 필요합니다`);
      if (options.strictPaths) {
        let parent = publicRoot;
        for (const segment of path.relative(publicRoot, location.filename).split(path.sep)) {
          const entries = await readdir(parent);
          if (!entries.includes(segment)) {
            const candidate = entries.find(e => e.toLowerCase() === segment.toLowerCase());
            throw new Error(candidate ? `경로 대소문자가 다릅니다: ${segment} (실제 ${candidate})` : `파일/디렉터리가 없습니다: ${segment}`);
          }
          parent = path.join(parent, segment);
        }
      }
      const real = await realpath(location.filename);
      if (!within(realPublicRoot, real)) throw new Error('공개 디렉터리 밖을 가리키는 링크');
      const info = await stat(real);
      if (!info.isFile() || info.size === 0) throw new Error('빈 파일이거나 일반 파일이 아닙니다');
      if (files.has(real)) return { ...files.get(real), url: location.url };
      const bytes = await readFile(real);
      const entry = { url: location.url.pathname, kind, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      report.checkedFiles.push(entry);
      const result = { bytes, url: location.url, entry, filename: real };
      files.set(real, result);
      return result;
    } catch (failure) { error(`${kind}: ${String(value)} — ${failure.message}`); return null; }
  }
  async function jsonAsset(value, kind, base, suffix) {
    const file = await asset(value, kind, base, suffix);
    if (!file) return null;
    try {
      const value = JSON.parse(file.bytes.toString('utf8').replace(/^\uFEFF/, ''));
      if (!object(value) || Object.keys(value).length === 0) throw new Error('내용이 있는 JSON 객체가 필요합니다');
      return { ...file, value };
    } catch (failure) { error(`${kind}: JSON 형식 오류 — ${failure.message}`); return null; }
  }
  async function pngAsset(value, kind, base, canvas, requireAlpha = false) {
    const file = await asset(value, kind, base, '.png');
    if (!file) return;
    const b = file.bytes;
    if (b.length < 45 || !b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || b.toString('ascii', 12, 16) !== 'IHDR' || b.toString('ascii', b.length - 8, b.length - 4) !== 'IEND') { error(`${kind}: PNG 서명/IHDR/IEND가 올바르지 않습니다: ${value}`); return; }
    const width = b.readUInt32BE(16), height = b.readUInt32BE(20), colorType = b[25];
    file.entry.dimensions = { width, height };
    if (!width || !height || width > 16384 || height > 16384) error(`${kind}: 텍스처 크기를 확인해 주세요: ${width}×${height}`);
    if (canvas && (width !== canvas.width || height !== canvas.height)) error(`${kind}: 레이어는 공유 캔버스 ${canvas.width}×${canvas.height}와 같아야 합니다. 실제 ${width}×${height}`);
    if (!options.decodeImages && requireAlpha && ![4, 6].includes(colorType)) error(`${kind}: 실제 알파 채널을 가진 PNG가 필요합니다: ${value}`);
    if (options.decodeImages) {
      try {
        const sharp = (await import('sharp')).default;
        const decoder = sharp(b, { limitInputPixels: 64 * 1024 * 1024, failOn: 'warning' });
        const metadata = await decoder.metadata();
        const decoded = await decoder.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        if (decoded.info.width !== width || decoded.info.height !== height || !decoded.data.length) throw new Error('디코딩 크기/픽셀 데이터가 일치하지 않습니다');
        if (requireAlpha && !metadata.hasAlpha) throw new Error('실제 알파 채널이 없습니다');
        file.entry.imageDecoded = true;
      } catch (failure) { error(`${kind}: 실제 이미지 디코딩 실패 — ${failure.message}`); }
    }
  }
  function validateMotionSync(file, label) {
    if (!file) return;
    const v = file.value;
    if (v.Version !== 1 || !object(v.Meta) || !Array.isArray(v.Settings) || !v.Settings.length || v.Meta.SettingCount !== v.Settings.length) { error(`${label}: 비어 있거나 지원되지 않는 MotionSync 설정입니다.`); return; }
    for (const setting of v.Settings) {
      if (!object(setting) || !text(setting.Id) || !text(setting.AnalysisType) || !text(setting.UseCase) || !Array.isArray(setting.CubismParameters) || !setting.CubismParameters.length || !Array.isArray(setting.AudioParameters) || !setting.AudioParameters.length || !Array.isArray(setting.Mappings) || !setting.Mappings.length) { error(`${label}: 분석기·파라미터·매핑이 있는 실제 설정이 필요합니다.`); continue; }
      if (setting.CubismParameters.some(p => !object(p) || !text(p.Id) || !finite(p.Min) || !finite(p.Max) || p.Max <= p.Min)) error(`${label}: CubismParameters 범위가 유효하지 않습니다.`);
      if (setting.Mappings.some(m => !object(m) || !text(m.Id) || !Array.isArray(m.Targets) || !m.Targets.length || m.Targets.some(t => !object(t) || !text(t.Id) || !finite(t.Value)))) error(`${label}: 입 모양 매핑이 유효하지 않습니다.`);
    }
  }
  async function verifyModel(model, index, runtime) {
    const label = `면접관 ${model?.speakerId ?? index}`;
    if (!object(model) || !['interviewer-1', 'interviewer-2'].includes(model.speakerId)) { error(`${label}: 지원하는 speakerId가 필요합니다.`); return; }
    const l = model.layout;
    if (!options.modelsOnly && (!object(l) || !['centerX', 'centerY', 'width', 'height'].every(k => finite(l[k])) || l.width <= 0 || l.height <= 0)) error(`${label}: 공유 캔버스 배치 정보가 필요합니다.`);
    const file = await jsonAsset(model.url, `${label} model3`, undefined, '.model3.json');
    if (!file) return;
    const refs = file.value.FileReferences, base = file.url.href;
    const inspected = { speakerId: model.speakerId, modelPath: file.filename, motionFiles: [], expressionFiles: [], motionSyncFiles: [] };
    report.models.push(inspected);
    if (file.value.Version !== 3 || !object(refs)) { error(`${label}: Version 3과 FileReferences가 있는 모델 설정이 필요합니다.`); return; }
    const moc = await asset(refs.Moc, `${label} Moc`, base, '.moc3');
    if (moc) {
      inspected.mocPath = moc.filename;
      // No guessed MOC3 magic/version test: only the licensed Core can load/validate it.
      moc.entry.firstBytesHex = moc.bytes.subarray(0, 8).toString('hex');
      const start = moc.bytes.subarray(0, 128).toString('utf8').trimStart();
      if (/^(?:[<{\[]|placeholder\b|dummy\b|todo\b|not a\b)/i.test(start) || moc.bytes.every(b => b === 0)) error(`${label}: MOC 대신 텍스트/빈 자리 파일이 들어 있습니다.`);
    }
    if (!Array.isArray(refs.Textures) || !refs.Textures.length) error(`${label}: 실제 PNG 텍스처가 하나 이상 필요합니다.`);
    else for (const [i, texture] of refs.Textures.entries()) await pngAsset(texture, `${label} texture ${i}`, base);
    for (const [key, suffix, requiredKey] of [['Physics', '.physics3.json', 'PhysicsSettings'], ['Pose', '.pose3.json', 'Groups'], ['UserData', '.userdata3.json', 'UserData'], ['DisplayInfo', '.cdi3.json', 'Parameters']]) {
      if (refs[key] === undefined) continue;
      const extra = await jsonAsset(refs[key], `${label} ${key}`, base, suffix);
      if (extra && (!Array.isArray(extra.value[requiredKey]) || (key === 'Physics' && (!extra.value[requiredKey].length || extra.value.Version !== 3)))) error(`${label} ${key}: ${requiredKey} 구성이 올바르지 않습니다.`);
    }
    if (refs.Motions !== undefined) {
      if (!object(refs.Motions) || !Object.keys(refs.Motions).length) error(`${label}: 빈 Motions 자리 파일은 사용할 수 없습니다.`);
      else for (const [group, motions] of Object.entries(refs.Motions)) {
        if (!Array.isArray(motions) || !motions.length) { error(`${label}: 모션 그룹 ${group}가 비어 있습니다.`); continue; }
        for (const [i, motion] of motions.entries()) {
          if (!object(motion)) { error(`${label}: ${group}/${i} 모션 참조가 올바르지 않습니다.`); continue; }
          const f = await jsonAsset(motion.File, `${label} motion ${group}/${i}`, base, '.motion3.json');
          if (f) inspected.motionFiles.push(f.filename);
          if (f && (f.value.Version !== 3 || !object(f.value.Meta) || !finite(f.value.Meta.Duration) || !Array.isArray(f.value.Curves) || !f.value.Curves.length || f.value.Curves.some(c => !object(c) || !text(c.Id) || !Array.isArray(c.Segments) || !c.Segments.length || !c.Segments.every(finite)))) error(`${label}: ${group}/${i} 모션 곡선이 유효하지 않습니다.`);
          if (motion.Sound !== undefined) { await asset(motion.Sound, `${label} motion sound`, base); warning('모션에 포함된 Sound는 실제 CLOVA 재생기와 중복 재생되지 않도록 런타임에서 비활성화해야 합니다.'); }
        }
      }
    } else warning(`${label}: 별도 모션 파일이 없습니다. 상태별 동작 품질은 검수하지 않았습니다.`);
    if (refs.Expressions !== undefined) {
      if (!Array.isArray(refs.Expressions) || !refs.Expressions.length) error(`${label}: 빈 Expressions 자리 파일은 사용할 수 없습니다.`);
      else for (const [i, expression] of refs.Expressions.entries()) {
        if (!object(expression) || !text(expression.Name)) { error(`${label}: 표정 ${i}의 이름/참조가 필요합니다.`); continue; }
        const f = await jsonAsset(expression.File, `${label} expression ${expression.Name}`, base, '.exp3.json');
        if (f) inspected.expressionFiles.push(f.filename);
        if (f && (f.value.Type !== 'Live2D Expression' || !Array.isArray(f.value.Parameters) || !f.value.Parameters.length || f.value.Parameters.some(p => !object(p) || !text(p.Id) || !finite(p.Value)))) error(`${label}: 표정 파라미터가 유효하지 않습니다.`);
      }
    } else warning(`${label}: 표정 파일이 없습니다. 중립/미소/집중 표현은 검수하지 않았습니다.`);
    let embeddedSync = null, manifestSync = null;
    if (refs.MotionSync !== undefined) { embeddedSync = await jsonAsset(refs.MotionSync, `${label} model MotionSync`, base, '.motionsync3.json'); validateMotionSync(embeddedSync, label); if (embeddedSync) inspected.motionSyncFiles.push(embeddedSync.filename); }
    if (model.motionSyncUrl !== undefined) { manifestSync = await jsonAsset(model.motionSyncUrl, `${label} scene MotionSync`, undefined, '.motionsync3.json'); validateMotionSync(manifestSync, label); }
    if (embeddedSync && manifestSync && embeddedSync.url.pathname !== manifestSync.url.pathname) error(`${label}: model3와 장면의 MotionSync 설정이 서로 다릅니다.`);
    if (runtime?.lipSync === 'motion-sync' && !manifestSync) error(`${label}: MotionSync 모드에는 장면의 motionSyncUrl 및 실제 설정 파일이 필요합니다.`);
    if (options.requireMotionSync && !embeddedSync) error(`${label}: 실제 모델의 FileReferences.MotionSync 설정이 필요합니다.`);
    if (options.requireMotionAndExpression && (!inspected.motionFiles.length || !inspected.expressionFiles.length)) error(`${label}: 실제 모델에 매핑된 모션·표정이 모두 필요합니다.`);
  }

  if (Array.isArray(options.modelsOnly)) {
    for (const [i, model] of options.modelsOnly.entries()) await verifyModel(model, i, null);
    report.status = report.errors.length ? 'blocked' : 'ready';
    return report;
  }

  let manifest;
  try { manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (failure) { error(`장면 설정을 읽을 수 없습니다: ${failure.message}`); return report; }
  if (!object(manifest)) { error('장면 설정은 JSON 객체여야 합니다.'); return report; }
  if (manifest.version !== 1 || !['ready', 'blocked'].includes(manifest.status)) error('장면 version/status가 유효하지 않습니다.');
  if (manifest.status !== 'ready') error('장면 상태가 blocked입니다. 전용 모델과 실행 SDK 준비를 마쳐야 합니다.');
  if (!Array.isArray(manifest.blockers)) error('장면 blockers 목록이 필요합니다.');
  else for (const blocker of manifest.blockers) error(`제작 차단: ${String(blocker)}`);
  const canvas = manifest.canvas;
  if (!object(canvas) || !finite(canvas.width) || !finite(canvas.height) || canvas.width <= 0 || canvas.height <= 0 || canvas.width > 8192 || canvas.height > 8192) error('공유 캔버스 크기가 유효하지 않습니다.');
  await asset(manifest.fallback, '장애 대체 이미지');
  if (!object(manifest.runtime)) error('실제 Cubism 렌더러 모듈과 Core 경로가 없습니다.');
  else {
    await asset(manifest.runtime.moduleUrl, '렌더러 모듈');
    await asset(manifest.runtime.coreUrl, 'Cubism Core');
    if (!['amplitude', 'motion-sync'].includes(manifest.runtime.lipSync)) error('립싱크 모드가 유효하지 않습니다.');
    if (manifest.runtime.lipSync === 'motion-sync' && !text(manifest.runtime.motionSyncCoreUrl)) error('MotionSync Core 경로가 없습니다.');
    if (manifest.runtime.motionSyncCoreUrl) await asset(manifest.runtime.motionSyncCoreUrl, 'MotionSync Core');
    if (manifest.runtime.lipSync === 'amplitude') warning('진폭 립싱크는 입 열기 정도만 제어합니다. 요청한 MotionSync 입 모양 완성 기준을 충족하지 않습니다.');
  }
  if (!Array.isArray(manifest.models) || manifest.models.length !== 2) error('실제 전용 모델 2개가 필요합니다.');
  if (Array.isArray(manifest.models)) {
    if (new Set(manifest.models.map(m => m?.speakerId)).size !== manifest.models.length) error('면접관 speakerId가 중복됩니다.');
    if (new Set(manifest.models.map(m => m?.url)).size !== manifest.models.length) error('두 면접관이 같은 모델 설정 파일을 참조합니다.');
    for (const [i, model] of manifest.models.entries()) await verifyModel(model, i, manifest.runtime);
  }
  if (!Array.isArray(manifest.layers)) error('레이어 목록이 필요합니다.');
  else {
    if (new Set(manifest.layers.map(l => l?.id)).size !== manifest.layers.length) error('레이어 ID가 중복됩니다.');
    for (const layer of manifest.layers) {
      if (!object(layer) || !text(layer.id) || !finite(layer.order)) { error('레이어 id/order가 유효하지 않습니다.'); continue; }
      await pngAsset(layer.url, `레이어 ${layer.id}`, undefined, object(canvas) ? canvas : undefined, true);
    }
    if (!manifest.layers.length) warning('분리된 장면 레이어가 없습니다. 합성 및 손/책상 가림 관계는 검수되지 않았습니다.');
  }
  warning('이 검사는 파일 참조·비어 있지 않은 파일·JSON 구성만 확인합니다. MOC3/Core의 실제 로드·파라미터 일치·알파 합성·예술 품질·기기 성능·라이선스는 검증하지 않습니다.');
  report.status = report.errors.length ? 'blocked' : 'ready';
  return report;
}

