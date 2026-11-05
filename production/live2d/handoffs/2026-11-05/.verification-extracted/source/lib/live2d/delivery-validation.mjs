import { readFile, writeFile, readdir, realpath, lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { verifyLive2DAssets } from './asset-validation.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = value => typeof value === 'string' && Boolean(value.trim());
const inside = (root, target) => { const relative = path.relative(root, target); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const ids = ['interviewer-1', 'interviewer-2'];
export const requiredDeliveryVersions = ['editor', 'exporter', 'cubismWeb', 'motionSyncWeb', 'cubismCore', 'motionSyncCore'];

export function validatePackagePath(value) {
  if (!text(value) || value !== value.trim() || value.startsWith('/') || /[\\\0:%?#]/.test(value) || value.split('/').some(p => !p || p === '.' || p === '..')) throw new Error(`패키지 내부의 정확한 상대 경로가 필요합니다: ${String(value)}`);
  return value;
}

export async function readDeliveryFile(root, relative) {
  validatePackagePath(relative);
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const segment of relative.split('/')) {
    const entries = await readdir(current);
    if (!entries.includes(segment)) {
      const correct = entries.find(e => e.toLowerCase() === segment.toLowerCase());
      throw new Error(correct ? `경로 대소문자 불일치: ${relative}; 실제 이름 ${correct}` : `파일이 없습니다: ${relative}`);
    }
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`납품 패키지에 심볼릭 링크는 허용하지 않습니다: ${relative}`);
  }
  const canonical = await realpath(current), info = await lstat(canonical);
  if (!inside(canonicalRoot, canonical) || !info.isFile() || info.size === 0 || info.size > 256 * 1024 * 1024) throw new Error(`빈 파일·패키지 경계·파일 크기를 확인해 주세요: ${relative}`);
  const bytes = await readFile(canonical);
  return { path: relative, filename: canonical, bytes, size: bytes.length, sha256: hash(bytes) };
}

async function inventory(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`패키지 링크는 허용하지 않습니다: ${relative}`);
    if (entry.isDirectory()) result.push(...await inventory(root, relative));
    else if (entry.isFile()) result.push(relative);
    else throw new Error(`지원하지 않는 파일 유형: ${relative}`);
    if (result.length > 4096) throw new Error('납품 파일 수가 검사 한도 4096개를 넘습니다.');
  }
  return result;
}

function parse(file) { return JSON.parse(file.bytes.toString('utf8').replace(/^\uFEFF/, '')); }
function checkVersions(versions, errors) {
  for (const key of requiredDeliveryVersions) if (!text(versions?.[key]) || /^(unknown|todo|tbd|none|null|미정|미확인)$/i.test(versions[key].trim())) errors.push(`필수 버전 정보가 없습니다: versions.${key}`);
  if (text(versions?.cubismWeb) && versions.cubismWeb !== '5-r.5') errors.push('현재 런타임의 Cubism Web 기준은 5-r.5입니다. 다른 버전은 호환성 검증 후 계약을 변경해야 합니다.');
  if (text(versions?.motionSyncWeb) && versions.motionSyncWeb !== '5-r.3') errors.push('현재 런타임의 MotionSync Web 기준은 5-r.3입니다. 다른 버전은 호환성 검증 후 계약을 변경해야 합니다.');
  if (text(versions?.cubismCore) && !/^\d+\.\d+\.\d+$/.test(versions.cubismCore)) errors.push('versions.cubismCore는 실제 Core의 major.minor.patch 값이어야 합니다.');
}

export function deliveryReadiness(levels, modelKind) {
  const dedicated = modelKind === 'dedicated';
  const assetValidationPassed = levels.level1.status === 'PASS';
  const modelLoadVerified = dedicated && assetValidationPassed && levels.level2.status === 'PASS' && levels.level2.executedWithCore === true;
  const actualQa = dedicated && modelLoadVerified && levels.level3.status === 'PASS' && levels.level3.executed === true;
  const motionSyncVerified = actualQa && levels.level3.motionSyncVerified === true;
  const runtimeQAComplete = actualQa && levels.level3.runtimeQAComplete === true;
  return { assetValidationPassed, modelLoadVerified, motionSyncVerified, runtimeQAComplete, releaseReady: dedicated && assetValidationPassed && modelLoadVerified && motionSyncVerified && runtimeQAComplete };
}

/** Checks a returned PRIVATE directory. Does not install, render, approve licenses or publish assets. */
export async function validateLive2DDelivery(options = {}) {
  const root = path.resolve(options.deliveryRoot ?? 'production/live2d/incoming');
  const levels = {
    level1: { status: 'NOT_RUN', errors: [], warnings: [], files: [], models: [] },
    level2: { status: 'NOT_RUN', executedWithCore: false, models: [], reason: 'LEVEL 1 검사 전입니다.' },
    level3: { status: 'NOT_RUN', executed: false, motionSyncVerified: false, runtimeQAComplete: false, reason: '허용된 렌더링·실제 출력 음성·실기기 실행기가 없어 실행하지 않았습니다.' },
  };
  const report = { schemaVersion: 1, runId: randomUUID(), checkedAt: new Date().toISOString(), command: options.command ?? [process.execPath, 'scripts/verify-live2d-assets.mjs', '--delivery-root', root], environment: { node: process.version, platform: process.platform, arch: process.arch, cwd: process.cwd() }, deliveryRoot: root, levels, modelKind: null, actualModelNewlyAuthored: false, validationScope: 'returned delivery validation, not authorship or visual approval' };
  const l1 = levels.level1;
  let manifest, manifestFile;
  try { manifestFile = await readDeliveryFile(root, 'delivery.json'); manifest = parse(manifestFile); report.deliveryManifestSha256 = manifestFile.sha256; }
  catch (error) {
    l1.status = error.code === 'ENOENT' || /파일이 없습니다/.test(error.message) ? 'BLOCKED' : 'FAIL';
    if (error.code === 'ENOENT' || !await lstat(root).catch(() => null)) l1.status = 'BLOCKED';
    l1.errors.push(`납품 manifest를 읽지 못했습니다: ${error.message}`);
    levels.level2.status = 'BLOCKED'; levels.level2.reason = '실제 모델 납품 패키지가 없습니다.';
    return finish(report);
  }
  if (!object(manifest) || manifest.schemaVersion !== 1 || !text(manifest.deliveryId) || !['dedicated', 'sample'].includes(manifest.modelKind)) l1.errors.push('delivery.json의 schemaVersion:1, deliveryId, modelKind(dedicated/sample)가 필요합니다.');
  report.deliveryId = manifest?.deliveryId ?? null; report.modelKind = manifest?.modelKind ?? null;
  if (report.modelKind === 'sample') l1.warnings.push('샘플 모델 검사입니다. 전용 면접관 제작·모델 로드·립싱크 완료로 집계하지 않습니다.');
  checkVersions(manifest?.versions, l1.errors); report.declaredVersions = manifest?.versions ?? null;
  const declared = new Map();
  if (!Array.isArray(manifest?.files) || !manifest.files.length) l1.errors.push('파일별 path/bytes/sha256 목록이 필요합니다. delivery.json 자체는 자기 해시 목록에서 제외합니다.');
  for (const item of Array.isArray(manifest?.files) ? manifest.files : []) {
    try {
      if (!object(item)) throw new Error('파일 목록 항목은 객체여야 합니다.');
      validatePackagePath(item.path);
      if (item.path === 'delivery.json' || declared.has(item.path.toLowerCase())) throw new Error(`자기 참조 또는 중복 경로: ${item.path}`);
      if (!Number.isSafeInteger(item.bytes) || item.bytes <= 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error(`파일 크기/SHA256 형식: ${item.path}`);
      declared.set(item.path.toLowerCase(), item);
      const actual = await readDeliveryFile(root, item.path);
      l1.files.push({ path: item.path, bytes: actual.size, sha256: actual.sha256 });
      if (actual.size !== item.bytes || actual.sha256 !== item.sha256) throw new Error(`납품 manifest의 크기/해시가 실제 파일과 다릅니다: ${item.path}`);
    } catch (error) { l1.errors.push(error.message); }
  }
  try { for (const file of await inventory(root)) if (file !== 'delivery.json' && !declared.has(file.toLowerCase())) l1.errors.push(`해시 목록에 없는 파일: ${file}`); }
  catch (error) { l1.errors.push(error.message); }
  const models = Array.isArray(manifest?.models) ? manifest.models : [];
  if (models.length !== 2 || new Set(models.map(m => m?.speakerId)).size !== 2 || models.some(m => !ids.includes(m?.speakerId))) l1.errors.push('서로 다른 전용 면접관 ID interviewer-1/interviewer-2의 모델 2개가 필요합니다.');
  if (new Set(models.map(m => m?.model3)).size !== models.length) l1.errors.push('두 면접관이 같은 model3 설정을 참조합니다.');
  const resolvedModels = [];
  for (const model of models) {
    try {
      const descriptor = { speakerId: model.speakerId, expectedParameters: [] };
      for (const [key, suffix] of [['model3', '.model3.json'], ['cmo3', '.cmo3'], ['parameters', '.json']]) {
        validatePackagePath(model[key]); if (!model[key].endsWith(suffix)) throw new Error(`${model.speakerId}.${key}: ${suffix} 파일이 필요합니다.`);
        const file = await readDeliveryFile(root, model[key]);
        if (!declared.has(model[key].toLowerCase())) throw new Error(`해시 목록에 없는 필수 파일: ${model[key]}`);
        if (key === 'model3') descriptor.url = `/${model[key]}`;
        if (key === 'parameters') {
          const params = parse(file).parameters;
          if (!Array.isArray(params) || !params.length || new Set(params.map(p => p.id)).size !== params.length || params.some(p => !text(p.id) || ![p.min, p.max, p.default].every(Number.isFinite) || p.min > p.default || p.default > p.max || p.max <= p.min)) throw new Error(`${model.speakerId}: 실제 파라미터 목록(id/min/max/default)이 필요합니다.`);
          descriptor.expectedParameters = params;
        }
      }
      if (!Array.isArray(model.can3) || !model.can3.length) throw new Error(`${model.speakerId}: 제작한 애니메이션의 can3 편집 원본이 필요합니다.`);
      for (const file of model.can3) { validatePackagePath(file); if (!file.endsWith('.can3') || !declared.has(file.toLowerCase())) throw new Error(`can3 참조/해시 목록을 확인해 주세요: ${file}`); await readDeliveryFile(root, file); }
      resolvedModels.push(descriptor);
    } catch (error) { l1.errors.push(error.message); }
  }
  if (resolvedModels.length) {
    const staticReport = await verifyLive2DAssets({ publicRoot: root, modelsOnly: resolvedModels, strictPaths: true, decodeImages: true, requireMotionSync: true, requireMotionAndExpression: true });
    l1.errors.push(...staticReport.errors); l1.warnings.push(...staticReport.warnings);
    l1.references = staticReport.checkedFiles; l1.models = staticReport.models;
    for (const file of staticReport.checkedFiles) {
      const relative = decodeURIComponent(file.url).replace(/^\//, '');
      const entry = declared.get(relative.toLowerCase());
      if (!entry || entry.path !== relative || entry.bytes !== file.bytes || entry.sha256 !== file.sha256) l1.errors.push(`모델 참조와 납품 해시 목록 불일치: ${relative}`);
    }
  }
  l1.errors = [...new Set(l1.errors)]; l1.status = l1.errors.length ? 'FAIL' : 'PASS';
  if (l1.status !== 'PASS') { levels.level2.status = 'BLOCKED'; levels.level2.reason = 'LEVEL 1 실패로 실제 모델 실행을 진행하지 않았습니다.'; return finish(report); }
  if (!options.corePath) { levels.level2.status = 'BLOCKED'; levels.level2.reason = '실제 Cubism Core가 제공되지 않았습니다. Mock으로 대신 실행하지 않았습니다.'; }
  else {
    const { validateWithCore } = await import('./core-validation.mjs');
    for (const inspected of l1.models) {
      const model = resolvedModels.find(m => m.speakerId === inspected.speakerId);
      const evidenceDirectory = options.evidenceDirectory ? path.join(options.evidenceDirectory, inspected.speakerId) : undefined;
      const mocRelative = path.relative(root, inspected.mocPath).split(path.sep).join('/');
      const result = await validateWithCore({ corePath: path.resolve(options.corePath), mocPath: inspected.mocPath, modelId: inspected.speakerId, motionFiles: inspected.motionFiles, expressionFiles: inspected.expressionFiles, motionSyncFiles: inspected.motionSyncFiles, expectedParameters: model.expectedParameters, runEvidenceDirectory: evidenceDirectory, targetHashes: { moc: declared.get(mocRelative.toLowerCase())?.sha256 } });
      if (result.status === 'PASS' && result.coreVersion) {
        const actual = [result.coreVersion.major, result.coreVersion.minor, result.coreVersion.patch];
        const declaredVersion = manifest.versions.cubismCore.split('.').map(Number);
        if (actual.some((value, i) => value !== declaredVersion[i])) { result.status = 'FAIL'; result.checks.push({id:'declared_core_version',status:'FAIL',message:'납품 버전 정보가 실제 실행한 Core 버전과 다릅니다.',details:{declared:manifest.versions.cubismCore,actual:actual.join('.')}}); }
      }
      levels.level2.models.push({ speakerId: inspected.speakerId, ...result });
    }
    levels.level2.executedWithCore = levels.level2.models.every(m => m.status === 'PASS' && m.loadedCoreHash && m.parameters?.length);
    levels.level2.status = levels.level2.models.some(m => m.status === 'FAIL') ? 'FAIL' : levels.level2.models.every(m => m.status === 'PASS') ? 'PASS' : 'BLOCKED';
    levels.level2.reason = levels.level2.status === 'PASS' ? '제공된 실제 Core로 두 모델과 파라미터를 검사했습니다.' : 'Core 기반 검사가 완료되지 않았습니다. 모델별 실제 출력과 이유를 확인해 주세요.';
  }
  if (options.level3Evidence) levels.level3.evidenceReview = await inspectRecordedEvidence(path.resolve(options.level3Evidence), report.deliveryManifestSha256);
  return finish(report);
}

async function inspectRecordedEvidence(filename, manifestSha256) {
  // Reading another party's dossier is not equivalent to running a renderer,
  // audio or a physical device in this process. It cannot switch LEVEL 3 to PASS.
  const review = { status: 'NOT_RUN', filename, errors: [], artifacts: [], establishesRuntimeExecution: false };
  try {
    const bytes = await readFile(filename), value = JSON.parse(bytes.toString('utf8'));
    review.sha256 = hash(bytes);
    if (value.deliveryManifestSha256 !== manifestSha256 || !Array.isArray(value.runs) || !value.runs.length) throw new Error('근거의 납품 해시와 실제 실행 run 목록이 필요합니다.');
    for (const run of value.runs) {
      if (!text(run.category) || !['PASS', 'FAIL', 'NOT_RUN', 'BLOCKED'].includes(run.status) || !text(run.command) || !object(run.environment) || !Array.isArray(run.artifacts) || !run.artifacts.length) throw new Error('실행 범주·명령·환경·상태·실제 출력 파일 근거가 필요합니다.');
      for (const artifact of run.artifacts) {
        const actual = await readDeliveryFile(path.dirname(filename), artifact.path);
        if (actual.sha256 !== artifact.sha256 || actual.size !== artifact.bytes) throw new Error(`근거 파일 해시 불일치: ${artifact.path}`);
        review.artifacts.push({ path: artifact.path, sha256: actual.sha256, bytes: actual.size });
      }
    }
    review.status = 'PASS';
    review.reason = '제출된 근거의 파일 정합성만 확인했습니다. 이 실행의 LEVEL 3 결과는 계속 NOT_RUN입니다.';
  } catch (error) { review.status = 'FAIL'; review.errors.push(error.message); }
  return review;
}

function finish(report) {
  Object.assign(report, deliveryReadiness(report.levels, report.modelKind));
  report.status = Object.values(report.levels).some(l => l.status === 'FAIL') ? 'FAIL' : report.releaseReady ? 'PASS' : 'BLOCKED';
  report.summary = { level1: report.levels.level1.status, level2: report.levels.level2.status, level3: report.levels.level3.status, actualModelNewlyAuthored: false, releaseReady: report.releaseReady };
  return report;
}

export async function deliveryCli(args) {
  const options = { command: [process.execPath, 'scripts/verify-live2d-assets.mjs', ...args] };
  const keys = { '--delivery-root': 'deliveryRoot', '--core': 'corePath', '--report': 'reportPath', '--level3-evidence': 'level3Evidence' };
  for (let i = 0; i < args.length; i++) { const key = keys[args[i]], value = args[++i]; if (!key || !value || value.startsWith('--')) throw new Error('사용법: node scripts/verify-live2d-assets.mjs --delivery-root <비공개 납품 폴더> [--core <실제 Core.js>] [--level3-evidence <실측 근거.json>] [--report <새 보고서.json>]'); options[key] = path.resolve(value); }
  if (options.reportPath) {
    const publicRoot = path.resolve('public');
    if (inside(publicRoot, options.reportPath) || inside(options.deliveryRoot, options.reportPath)) throw new Error('보고서는 공개 폴더 및 원본 납품 폴더 밖의 새 경로에 저장해야 합니다.');
    if (await lstat(options.reportPath).catch(() => null)) throw new Error('기존 검수 결과는 덮어쓰지 않습니다. 새 --report 경로를 지정하세요.');
    options.evidenceDirectory = `${options.reportPath}.evidence-${randomUUID()}`;
  }
  const report = await validateLive2DDelivery(options);
  if (options.reportPath) { await mkdir(path.dirname(options.reportPath), { recursive: true }); await writeFile(options.reportPath, JSON.stringify(report, null, 2)+'\n', { flag: 'wx' }); }
  process.stdout.write(JSON.stringify({ status: report.status, deliveryId: report.deliveryId ?? null, ...report.summary, assetValidationPassed: report.assetValidationPassed, modelLoadVerified: report.modelLoadVerified, motionSyncVerified: report.motionSyncVerified, runtimeQAComplete: report.runtimeQAComplete, errors: report.levels.level1.errors, reportPath: options.reportPath ?? null }, null, 2)+'\n');
  process.exitCode = report.releaseReady ? 0 : report.status === 'FAIL' ? 1 : 2;
  return report;
}
