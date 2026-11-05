#!/usr/bin/env node
/**
 * Private, additive handoff packaging. Never rewrites production art, PSDs,
 * manifests, existing reports or detailed specifications. No GUI or network use.
 *
 * 1. node scripts/package-live2d-handoff.mjs --capture-only --date 2026-11-05
 * 2. Finish explicitly authorized code revisions, then:
 *    node scripts/package-live2d-handoff.mjs --finalize production/live2d/handoffs/2026-11-05
 * Optional: --evidence <new nonpublic JSON/text report> (repeatable).
 *
 * Uses Python 3.11's stdlib zipfile for exclusive ZIP creation, CRC testing,
 * safe actual extraction and SHA-256 verification. No app dependencies change.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const handoffs = path.join(root, 'production', 'live2d', 'handoffs');
const posix = value => value.split(path.sep).join('/');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const speakerIds = ['interviewer-1', 'interviewer-2'];
const selection = {
  directories: ['public/live2d/production', 'public/live2d/art', 'docs/live2d', 'lib/live2d', 'integrations/live2d', 'examples/expo-scene'],
  files: ['public/live2d/scene.json', 'public/live2d/runtime/provenance.json',
    'scripts/build-interviewer-psd.mjs', 'scripts/prepare-interviewer-motions.mjs', 'scripts/prepare-interviewer-parts.mjs',
    'scripts/source-artwork-inspection.mjs', 'scripts/verify-interviewer-production.mjs', 'scripts/verify-live2d-assets.mjs',
    'scripts/setup-live2d-sdk.mjs', 'scripts/package-live2d-handoff.mjs',
    'components/interview/InterviewerScene.tsx', 'components/interview/InterviewerScene.module.css',
    'components/interview/SceneHost.tsx', 'components/interview/SceneHost.module.css', 'components/interview/SceneInterview.module.css',
    'app/interview/scene/page.tsx', 'package.json', 'package-lock.json', 'tsconfig.json',
    'tests/live2d-delivery-validation.test.ts', 'tests/live2d-core-validation.test.ts',
    'tests/live2d-manifest-gate.test.ts', 'tests/live2d-scene.test.ts'],
  skipDirectories: ['node_modules', '.expo', '.git', 'android', 'ios'], excludeEnvironmentFiles: true,
};
// These are the exact code revisions authorized for the current handoff task.
// Artwork, detailed docs and existing evidence are never in this allowlist.
const authorizedRevisions = new Set([
  'scripts/verify-live2d-assets.mjs', 'lib/live2d/types.ts', 'lib/live2d/manifest.ts',
  'components/interview/InterviewerScene.tsx', 'integrations/live2d/renderer.mjs',
  'lib/live2d/core-validation.mjs', 'scripts/package-live2d-handoff.mjs',
  'lib/live2d/delivery-contract.schema.json', 'lib/live2d/delivery-validation.mjs', 'lib/live2d/asset-validation.mjs', 'scripts/setup-live2d-sdk.mjs',
  'tests/live2d-delivery-validation.test.ts', 'tests/live2d-core-validation.test.ts',
  'tests/live2d-manifest-gate.test.ts', 'tests/live2d-scene.test.ts',
]);
const targetFlags = {
  currentHandOff: true, assetValidationPassed: false, artworkFinal: false, actualRigCreated: false,
  moc3Exported: false, modelLoadVerified: false, motionSyncVerified: false,
  runtimeQAComplete: false, expoDeviceVerified: false, performance30FpsMeasured: false, releaseReady: false,
};

async function exists(target) { try { await fs.access(target); return true; } catch { return false; } }
function safeRelative(value) {
  assert(typeof value === 'string' && value && !value.includes('\\') && !value.includes('\0'), `Unsafe relative path: ${value}`);
  const normalized = path.posix.normalize(value);
  assert(!path.posix.isAbsolute(value) && normalized !== '..' && !normalized.startsWith('../') && !value.includes(':'), `Unsafe relative path: ${value}`);
  return normalized;
}
async function privateDirectory(input) {
  const target = path.resolve(input), relative = path.relative(handoffs, target);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Handoff directory must be a new child of production/live2d/handoffs.');
  const actual = await fs.realpath(target), actualParent = await fs.realpath(handoffs);
  assert(actual.startsWith(actualParent + path.sep), 'Handoff path resolves outside the private handoff root.');
  return target;
}
async function inventory() {
  const names = new Set(), skip = new Set(selection.skipDirectories);
  async function walk(relative) {
    const full = path.join(root, relative);
    let stat; try { stat = await fs.lstat(full); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    assert(!stat.isSymbolicLink(), `Source symlink/junction is not packaged: ${relative}`);
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(full, { withFileTypes: true })) {
        if (skip.has(entry.name) || entry.name.startsWith('.env')) continue;
        await walk(`${relative}/${entry.name}`);
      }
    } else if (stat.isFile()) names.add(posix(relative));
  }
  for (const relative of [...selection.directories, ...selection.files]) await walk(relative);
  return [...names].sort();
}
async function snapshot() {
  const records = [];
  for (const relative of await inventory()) {
    const bytes = await fs.readFile(path.join(root, relative));
    records.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
  }
  return records;
}
function sameSnapshot(first, second) { return JSON.stringify(first) === JSON.stringify(second); }
function changesBetween(initial, current) {
  const old = new Map(initial.map(record => [record.path, record])), next = new Map(current.map(record => [record.path, record]));
  return [...new Set([...old.keys(), ...next.keys()])].sort().flatMap(relative => {
    const before = old.get(relative), after = next.get(relative);
    if (before?.sha256 === after?.sha256 && before?.bytes === after?.bytes) return [];
    return [{ path: relative, change: !before ? 'added' : !after ? 'removed' : 'modified', before: before ?? null, after: after ?? null,
      authorizedCodeRevision: authorizedRevisions.has(relative) }];
  });
}
async function capture(date) {
  assert(/^\d{4}-\d{2}-\d{2}$/u.test(date), 'Use an ISO client date, for example 2026-11-05.');
  const captureStartedAt = new Date().toISOString(), files = await snapshot();
  assert(sameSnapshot(files, await snapshot()), 'Source changed during initial capture. Try after the source is stable.');
  await fs.mkdir(handoffs, { recursive: true });
  let outputDirectory;
  for (let version = 1; ; version++) {
    const candidate = path.join(handoffs, `${date}${version === 1 ? '' : `-v${version}`}`);
    try { await fs.mkdir(candidate); outputDirectory = candidate; break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const report = { schemaVersion: 1, phase: 'initial', status: 'captured-before-authorized-code-revision', captureStartedAt,
    capturedAt: new Date().toISOString(), clientDate: date, timezone: 'Asia/Seoul', selection,
    sourceFileCount: files.length, sourceTotalBytes: files.reduce((total, record) => total + record.bytes, 0), files };
  await fs.writeFile(path.join(outputDirectory, 'baseline-initial.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  return { outputDirectory, initialBaseline: path.join(outputDirectory, 'baseline-initial.json'), sourceFileCount: files.length };
}
async function readCurrentProduction(records) {
  const byPath = new Map(records.map(record => [record.path, record]));
  const read = relative => fs.readFile(path.join(root, safeRelative(relative)));
  const json = async relative => JSON.parse((await read(relative)).toString('utf8'));
  const speakers = [];
  for (const id of speakerIds) {
    const base = `public/live2d/production/${id}`, manifestPath = `${base}/parts/manifest.json`;
    const manifestBytes = await read(manifestPath), manifest = JSON.parse(manifestBytes.toString('utf8'));
    const proof = await json(`${base}/psd-verification.json`);
    assert(proof.status === 'verified-file-format' && proof.manifestSha256 === hash(manifestBytes), `${id}: original PSD evidence/manifest hash no longer matches.`);
    const layers = manifest.layers, art = layers.filter(layer => layer.role === 'part'), refs = layers.filter(layer => layer.role === 'reference');
    const pngs = records.filter(record => record.path.startsWith(`${base}/parts/`) && record.path.endsWith('.png'));
    assert(layers.length === 37 && art.length === 35 && refs.length === 2 && pngs.length === 37, `${id}: expected 37 part PNGs, 35 art layers and 2 references.`);
    assert(refs.every(layer => layer.visible === false), `${id}: master reference layers must remain hidden.`);
    const proofInputs = new Map(proof.inputs.map(input => [input.id, input]));
    assert(proofInputs.size === 37, `${id}: original round-trip evidence does not cover 37 input layers.`);
    for (const layer of layers) {
      const inputPath = `${base}/parts/${safeRelative(layer.path)}`, record = byPath.get(inputPath), input = proofInputs.get(layer.id);
      assert(record && input && record.sha256 === input.pngSha256, `${id}/${layer.id}: PNG differs from the existing verified PSD input.`);
      assert(input.x === layer.x && input.y === layer.y && input.name === layer.name && input.role === layer.role && input.visible === layer.visible,
        `${id}/${layer.id}: source coordinates/name/role/visibility differ from original PSD evidence.`);
    }
    assert(proof.outputs.length === 2, `${id}: expected exactly the two original PSD output records.`);
    const outputs = [];
    for (const kind of ['artwork_master', 'cubism_import']) {
      const output = proof.outputs.find(item => item.kind === kind), filename = `${base}/${kind}.psd`, buffer = await read(filename);
      const expected = kind === 'artwork_master' ? layers : art;
      assert(output && hash(buffer) === output.sha256 && buffer.length === output.bytes, `${id}/${kind}: PSD hash/length differs from preserved evidence.`);
      assert(buffer.subarray(0, 4).toString('ascii') === '8BPS' && buffer.readUInt16BE(4) === 1 && buffer.readUInt16BE(22) === 8 && buffer.readUInt16BE(24) === 3,
        `${id}/${kind}: expected a genuine PSD v1 RGB8 header.`);
      assert(output.rasterLayers === expected.length && output.layers.length === expected.length, `${id}/${kind}: recorded layer count mismatch.`);
      const names = new Set(output.layers.map(layer => layer.name));
      assert(names.size === expected.length && expected.every(layer => names.has(layer.name)), `${id}/${kind}: recorded names do not match part roles.`);
      if (kind === 'cubism_import') assert(refs.every(ref => !names.has(ref.name)), `${id}: reference layer leaked into Cubism import.`);
      outputs.push({ path: filename, bytes: buffer.length, sha256: hash(buffer), rasterLayers: expected.length,
        currentFileMatchesPreservedRoundTripEvidence: true, currentHeaderPsdV1Rgb8: true });
    }
    speakers.push({ speakerId: id, canvas: manifest.canvas, partPngs: pngs.length, artLayers: art.length, referenceLayers: refs.map(ref => ref.name),
      referencesExcludedFromImport: true, recordedLayerRoundTripEvidencePreserved: true, actualPsdApplicationImportTested: false, outputs });
  }
  const motionRoot = 'public/live2d/production/motions', catalog = await json(`${motionRoot}/catalog.json`);
  const counted = { motion3: 0, exp3: 0 };
  assert(Array.isArray(catalog.files) && catalog.files.length === 18, 'Expected 18 catalogued motion/expression files.');
  for (const file of catalog.files) {
    const relative = `${motionRoot}/${safeRelative(file.file)}`, record = byPath.get(relative);
    assert(record && record.sha256 === file.sha256, `Motion catalog hash mismatch: ${file.file}`);
    if (file.file.endsWith('.motion3.json')) { assert(file.kind === 'motion', 'Motion kind mismatch.'); counted.motion3++; }
    else if (file.file.endsWith('.exp3.json')) { assert(file.kind === 'expression', 'Expression kind mismatch.'); counted.exp3++; }
    else throw new Error(`Unexpected motion catalog extension: ${file.file}`);
  }
  assert(counted.motion3 === 12 && counted.exp3 === 6, 'Expected 12 motion3 and 6 exp3 files.');
  assert(catalog.modelLoadTested === false && catalog.runtimePlaybackTested === false && catalog.handGestureEnabled === false,
    'Motion catalog status changed; reassess handoff completion statements before packaging.');
  const scene = await json('public/live2d/scene.json');
  assert(scene.status === 'blocked' && scene.models.length === 0 && scene.runtime === null, 'Scene runtime status changed; reassess this handoff before packaging.');
  const runtimeFiles = records.filter(record => /\.(?:moc3|cmo3|can3)$|\.(?:model3|motionsync3)\.json$/u.test(record.path));
  assert(runtimeFiles.length === 0, 'Unexpected dedicated model/export appeared; this package must not reuse stale incomplete-model statements.');
  return { schemaVersion: 1, status: 'current-artwork-handoff-files-verified', checkedAt: new Date().toISOString(),
    scope: 'Existing production file hashes, original recorded PSD round-trip evidence, role/count/name/reference checks and motion catalogue hashes; not a new PSD app import, rig, SDK load or device test.',
    speakers, motions: { ...counted, status: catalog.status, modelLoadTested: false, runtimePlaybackTested: false, handGestureEnabled: false },
    sceneStatus: scene.status, targetFlags,
    missingRequiredFinalDeliverables: ['Dedicated .cmo3 rig sources', '.can3 motion authoring sources', '.moc3 exports', '.model3.json model packages',
      'Texture atlases', 'Dedicated .motionsync3.json mappings', 'Required final physics/settings as applicable',
      'Verified room/desk/chair/foreground separation and occlusion', 'Licensed Core execution combination', 'Actual Korean CLOVA output lip-sync QA',
      'Web and Expo device QA with camera/recording/transcription/gaze analysis', 'Measured lower-bound-device 30FPS/memory/thermal/battery results'],
  };
}
function readme(date) {
  return `# 각자의답 · 외부 제작 인계 보관본 (${date})

이 ZIP은 현재 제작물을 기준선으로 고정한 **비공개 작업 폴더의 인계 준비본**입니다. 외부 전송·연락·발주·공유 권한 변경은 하지 않았습니다. 웹의 public 폴더 밖에 새로 만들었으며 기존 원본·PSD·상세 문서·검사 보고서는 덮어쓰지 않았습니다.

## 시작 위치와 기준선

- 남성: source/public/live2d/production/interviewer-1/
- 여성: source/public/live2d/production/interviewer-2/
- 각각 artwork_master.psd는 **래스터 37레이어**입니다. 모든 원화 저작 과정이 비파괴 조정·벡터·스마트 오브젝트로 남은 원본은 아닙니다.
- 각각 cubism_import.psd는 **독립 아트 35레이어**입니다. 마스터의 숨긴 참고 레이어 Approved_Master_Reference, Mouth_Open_Reference 두 개를 제외했습니다.
- parts/manifest.json과 layer_manifest.csv에 1672×941 기준 캔버스의 실제 x/y·순서·역할·해부학적 L/R 기준이 있습니다. 잘린 PNG를 원점 정보 없이 재배치하지 마세요.
- baseline-initial.json은 코드 수정 전 초기 경로·크기·SHA-256입니다. baseline-manifest.json은 실제 인계 복사본의 기준선입니다. validation/code-revision-diff.json에 허용된 코드 수정과 초기/최종 해시를 구분했습니다.
- validation/production-input-check.json은 현재 파일과 기존 PSD 재읽기 증거의 해시·레이어 분류·참고 제외·모션 목록을 대조한 새 보고서입니다. 기존 상세 검수 결과의 정본은 source/public/live2d/production/<speaker>/psd-verification.json입니다. 그 보고서의 원래 절대 경로는 그대로 보존했으며, 이 인계본에서는 baseline의 상대 경로를 사용하세요.

## 제작 범위와 남은 납품

사용자는 현재 얼굴을 승인했고 앞서 제안한 네 가지 시각 보정은 건너뛰었습니다. 이를 다시 승인받는 작업은 요구하지 않습니다. 새로 분리한 눈·입·안경·팔·손의 기능과 변형 검수는 필요합니다. 실제 Cubism 가져오기·메쉬·디포머·키폼 리깅은 아직 수행되지 않았습니다.

남녀별 motion3 6개와 exp3 3개, 총 **motion3 12개 / exp3 6개**는 전용 모델 매핑·재생 전의 초안 데이터입니다. 파라미터는 계획값이며 일반 모션에 입 채널을 넣지 않았습니다. 손 제스처는 0이고 독립 손·펜 동작은 구현되지 않았습니다. 손과 책상·노트·소매의 가림도 실제 리깅에서 해결해야 합니다.

현재 실제 납품물에는 전용 .cmo3, .can3, .moc3, .model3.json, 텍스처 아틀라스, 모델별 .motionsync3.json과 필요한 최종 물리/추가 설정이 없습니다. 실제 출력 음성과 입 모양의 한국어 합성 검수, 웹·Expo 기기의 카메라·녹음·전사·시선 분석 동시 검수도 없습니다. **30FPS는 초기 목표이며 실측 결과가 아닙니다.** 릴리스 완료로 표시하지 마세요.

공식 Cubism Core·MotionSync Core와 공식 SDK 번들·샘플 모델은 재배포하지 않았습니다. source/public/live2d/runtime/provenance.json은 기존 빌드의 버전·출처 기록일 뿐 실행 파일 제공이 아닙니다. 인계 코드의 SDK 계약과 준비 스크립트를 참고하고 사용권을 확인한 공식 패키지를 별도로 확보해야 합니다.

## 상세 문서 — 원본 파일을 한 세트로 보존

아래 상대 경로가 이 ZIP 안의 실제 상세 문서입니다. 별도 요약 사본을 중복 작성하지 않았습니다.

- source/docs/live2d/qa_report.md — 실제 파츠·PSD·검수 상태와 현재 차단
- source/docs/live2d/mouth_rigging_spec.md — 입 2축·음소 키폼·입안/치아/입술·가림 설계
- source/docs/live2d/parameter_spec.md — 계획 ID/범위·소유권·실제 모델 대조
- source/docs/live2d/motion_spec.md — 모션·표정 목록·사용 조건·중단/인계 규칙
- source/docs/live2d/runtime_integration.md — 기존 출력 오디오·웹·Expo 연결 및 검증 범위
- source/docs/live2d/authoring-tools.md — 실제 저작 도구 확인과 미확보 경로
- source/docs/live2d/sdk-research.md — SDK/Core 버전·공식 출처·라이선스·CLOVA 저장 정책
- source/docs/live2d/production-spec.md — 장면 좌표·책상/손 가림을 포함한 계획 명세
- source/docs/live2d/art-review.md — 이전 정적 원화 검토 기록. 현재 얼굴 승인·4개 보정 건너뛰기는 이 README와 qa_report.md의 사용자 지시를 우선합니다.
- source/integrations/live2d/README.md — 애플리케이션 renderer 계약과 공식 SDK 빌드 절차
- source/examples/expo-scene/README.md — Expo/WebView 예제의 실제 설치·기기 미검증 범위

이 패키지의 source/는 제작물·연결 모듈·예제의 보존본입니다. 학생 자료·계정 키·기존 서비스 전체를 복제하지 않았으므로 source/만으로 완성 면접 서비스를 실행했다고 판단하지 마세요.

## 읽기 전용 확인과 향후 모델 납품 검사

source/에서 다음 모션 검사는 저장된 생성물을 바꾸지 않습니다.

\`\`\`text
node scripts/prepare-interviewer-motions.mjs --check
node scripts/prepare-interviewer-motions.mjs --self-test
\`\`\`

향후 실제 모델 폴더의 **정확한 납품 JSON 계약은 source/lib/live2d/delivery-contract.schema.json 한 파일**을 참조하세요. 별도 계약 요약 사본을 만들지 않았습니다. 실제 검사 진입점은 source/scripts/verify-live2d-assets.mjs이며, 구현은 source/lib/live2d/asset-validation.mjs, source/lib/live2d/delivery-validation.mjs 및 source/lib/live2d/core-validation.mjs에 있습니다. 실제 수신 파일은 새 비공개 경로 production/live2d/incoming/DELIVERY_ID/에 두고 새 보고서 경로를 사용하세요. 이 경로는 향후 수신용 예시이며 현재 완성 모델이 있다는 뜻은 아닙니다.

\`\`\`text
node scripts/verify-live2d-assets.mjs --delivery-root <새 모델 납품 폴더> --report <새 비공개 보고서.json>
node scripts/verify-live2d-assets.mjs --delivery-root <새 모델 납품 폴더> --core <정식 로컬 Core.js> --report <다른 새 보고서.json>
\`\`\`

실제 QA 증거가 준비된 경우에만 --level3-evidence <실제 QA 증거.json>를 추가합니다. 파일 검사·Core 모델 로드·MotionSync/실기기 QA의 결과 플래그를 구분해야 합니다. Core를 제공하지 않은 검사를 실제 모델 로드 성공으로 계산하지 마세요.

L1 통과는 정적 납품 파일 검증입니다. Core가 없으면 L2는 차단 상태이며, L3는 실제 MotionSync·음성·웹/모바일 검수 실행 증거가 있어야 합니다. 외부 QA dossier 파일을 읽은 사실만으로 이 도구가 L3를 실행했다고 표시하지 않습니다. ready 등록의 정확한 조건은 source/lib/live2d/types.ts와 source/lib/live2d/manifest.ts를 참조하세요. ready에는 전용 모델·정적 검사·Core 모델 로드·보고서 해시 등의 등록 gate가 필요하며, releaseReady에는 실제 MotionSync 검증과 필수 실기기 QA를 추가로 갖춰야 합니다. 기존 source/public/live2d/scene.json은 blocked 그대로 보존했습니다.

validation/external/provenance.json이 있다면 새 비공개 경로에서 만든 런타임 번들의 출처 기록입니다. 실제 번들·셰이더·SDK 소스·Core는 이 인계 ZIP에 포함하지 않았습니다. 이전 source/public/live2d/runtime/provenance.json도 역사적 빌드 기록으로 그대로 보존했습니다.

source/scripts/source-artwork-inspection.mjs는 inspection.json을 쓰고, prepare-interviewer-parts/motions 및 build-interviewer-psd는 생성 작업을 합니다. 기존 인계본의 기준선을 다시 쓰는 명령으로 실행하지 마세요. source/scripts/verify-interviewer-production.mjs와 기존 production/README.md에는 과거 보고서 작성 명령이 남아 있으므로 원본 보존본을 대상으로 재실행하지 마세요. 수정 작업은 새 버전의 복사본에서 시작하고 결과·버전·검수 증거를 새 경로에 저장하세요.

ZIP CRC 검사와 실제 압축 해제 후 모든 상대 경로·파일 길이·SHA-256 대조 결과는 ZIP과 같은 보관 폴더의 archive-verification.json에 있습니다. 이 ZIP은 암호화 ZIP이 아니며, 비공개 보관 위치 자체가 외부 공유를 실행하지는 않습니다.
`;
}
async function payloadFiles(directory) {
  const records = [];
  async function walk(relative = '') {
    const folder = path.join(directory, relative);
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      assert(!entry.isSymbolicLink(), `Unexpected payload symlink: ${name}`);
      if (entry.isDirectory()) await walk(name);
      else { const buffer = await fs.readFile(path.join(directory, name)); records.push({ path: posix(name), bytes: buffer.length, sha256: hash(buffer) }); }
    }
  }
  await walk(); return records.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
const pythonZip = String.raw`
import sys, json, zipfile, hashlib, pathlib, platform, stat
plan = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
payload = pathlib.Path(plan['payloadDirectory']).resolve()
archive = pathlib.Path(plan['archivePath'])
extract = pathlib.Path(plan['extractionDirectory'])
expected = {r['path']: r for r in plan['files']}
def digest(p):
    h = hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda: f.read(1024*1024), b''): h.update(b)
    return h.hexdigest()
assert not archive.exists(), 'Archive exists; refusing overwrite'
assert not extract.exists(), 'Extraction directory exists; refusing overwrite'
with zipfile.ZipFile(archive, mode='x', compression=zipfile.ZIP_DEFLATED, compresslevel=6, strict_timestamps=False) as z:
    for name in sorted(expected):
        p = pathlib.PurePosixPath(name)
        assert not p.is_absolute() and '..' not in p.parts and '\\' not in name and ':' not in name, 'Unsafe ZIP member path'
        source = payload.joinpath(*p.parts)
        assert source.is_file() and source.stat().st_size == expected[name]['bytes'] and digest(source) == expected[name]['sha256'], 'Payload changed before archive write: '+name
        z.write(source, arcname=name)
extract.mkdir()
results = []
with zipfile.ZipFile(archive, mode='r') as z:
    names = z.namelist()
    assert len(names) == len(set(names)), 'Duplicate archive member'
    assert set(names) == set(expected), 'Archive relative path list differs from payload'
    bad = z.testzip()
    assert bad is None, 'CRC failed: '+str(bad)
    for info in z.infolist():
        name = info.filename
        p = pathlib.PurePosixPath(name)
        assert not p.is_absolute() and '..' not in p.parts and '\\' not in name and ':' not in name and not info.is_dir(), 'Unsafe ZIP entry'
        assert stat.S_IFMT(info.external_attr >> 16) != stat.S_IFLNK, 'ZIP symlink is prohibited'
        destination = extract.joinpath(*p.parts)
        assert destination.resolve().is_relative_to(extract.resolve()), 'Extraction would leave the new private directory'
        destination.parent.mkdir(parents=True, exist_ok=True)
        with z.open(info) as source, destination.open('xb') as output:
            for chunk in iter(lambda: source.read(1024*1024), b''): output.write(chunk)
        actual = {'path': name, 'bytes': destination.stat().st_size, 'sha256': digest(destination), 'crc32': format(info.CRC, '08x')}
        assert actual['bytes'] == expected[name]['bytes'] and actual['sha256'] == expected[name]['sha256'], 'Extracted file mismatch: '+name
        results.append(actual)
report = {'schemaVersion': 1, 'status': 'archive-CRC-and-actual-extraction-verified', 'python': platform.python_version(),
    'zipImplementation': 'Python stdlib zipfile / ZIP_DEFLATED', 'archivePath': str(archive), 'archiveBytes': archive.stat().st_size,
    'archiveSha256': digest(archive), 'crcCheckedAllMembers': True, 'relativePathListExact': True,
    'actualExtractionPerformed': True, 'extractionDirectory': str(extract), 'extractedFileHashesExact': True, 'fileCount': len(results),
    'files': sorted(results, key=lambda r: r['path'])}
with pathlib.Path(plan['resultPath']).open('x', encoding='utf-8') as output: json.dump(report, output, ensure_ascii=False, indent=2); output.write('\n')
print(json.dumps({'status': report['status'], 'archiveBytes': report['archiveBytes'], 'fileCount': report['fileCount']}))
`;

async function finalize(inputDirectory, evidencePaths) {
  const directory = await privateDirectory(inputDirectory), initialPath = path.join(directory, 'baseline-initial.json');
  const initialBytes = await fs.readFile(initialPath), initial = JSON.parse(initialBytes.toString('utf8'));
  assert(initial.schemaVersion === 1 && initial.phase === 'initial', 'Expected the untouched capture-only baseline.');
  assert(!(await exists(path.join(directory, 'package'))) && !(await exists(path.join(directory, 'archive-verification.json'))), 'This handoff was already started/finalized. Capture a new version instead of overwriting.');
  const before = await snapshot(), revisions = changesBetween(initial.files, before);
  assert(revisions.every(change => change.authorizedCodeRevision && change.change !== 'removed'), `Immutable source changed or unauthorized code revision: ${revisions.filter(change => !change.authorizedCodeRevision || change.change === 'removed').map(change => change.path).join(', ')}`);
  const inputCheck = await readCurrentProduction(before);
  const payload = path.join(directory, 'package'); await fs.mkdir(payload);
  await fs.mkdir(path.join(payload, 'validation'));
  const copied = [];
  for (const record of before) {
    const bytes = await fs.readFile(path.join(root, record.path));
    assert(hash(bytes) === record.sha256 && bytes.length === record.bytes, `Source changed while copying: ${record.path}`);
    const target = path.join(payload, 'source', record.path); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: 'wx' });
    copied.push({ path: `source/${record.path}`, originalPath: record.path, bytes: bytes.length, sha256: hash(bytes) });
  }
  const additionalEvidence = [];
  for (const evidence of evidencePaths) {
    const full = path.resolve(evidence), relative = posix(path.relative(root, full));
    assert(!relative.startsWith('../') && !path.isAbsolute(relative) && !relative.startsWith('public/'), 'Additional evidence must be an explicitly supplied nonpublic workspace file.');
    assert(full !== initialPath && !full.startsWith(payload + path.sep), 'Do not recursively include packaging files as external evidence.');
    const name = path.basename(full); assert(/\.(?:json|md|txt|log)$/u.test(name), 'Only explicit JSON/text evidence is supported.');
    const bytes = await fs.readFile(full), target = path.join(payload, 'validation', 'external', name);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes, { flag: 'wx' });
    additionalEvidence.push({ path: `validation/external/${name}`, originalPath: relative, bytes: bytes.length, sha256: hash(bytes) });
  }
  assert(sameSnapshot(before, await snapshot()), 'Source changed while building payload; no archive was finalized.');
  assert((await fs.readFile(initialPath)).equals(initialBytes), 'Initial baseline changed during finalization.');
  await fs.writeFile(path.join(payload, 'baseline-initial.json'), initialBytes, { flag: 'wx' });
  await fs.writeFile(path.join(payload, 'README.md'), readme(initial.clientDate), { flag: 'wx' });
  await fs.writeFile(path.join(payload, 'validation', 'production-input-check.json'), `${JSON.stringify(inputCheck, null, 2)}\n`, { flag: 'wx' });
  await fs.writeFile(path.join(payload, 'validation', 'code-revision-diff.json'), `${JSON.stringify({ initialCapturedAt: initial.capturedAt,
    finalSnapshotAt: new Date().toISOString(), changeSemantics: 'Snapshot inventory difference; added does not assert filesystem creation time.',
    immutableArtworkPsdDocsAndExistingEvidenceUnchanged: true, changes: revisions }, null, 2)}\n`, { flag: 'wx' });
  const supplemental = await payloadFiles(payload);
  const baseline = { schemaVersion: 1, status: 'current-handoff-payload-baseline', clientDate: initial.clientDate, timezone: 'Asia/Seoul',
    initialCaptureAt: initial.capturedAt, finalizedAt: new Date().toISOString(), targetFlags,
    publicOriginalsLeftInPlace: true, publicOriginalFilesChangedByPackager: false, computerUsePerformed: false,
    officialCoreOrSdkBinariesRedistributed: false, officialSdkProvenance: 'source/public/live2d/runtime/provenance.json',
    originalDetailedSpecificationsCopiedOnce: 'source/docs/live2d/', sourceFileCount: before.length,
    files: copied, additionalEvidence, supplementalFiles: supplemental.filter(record => !record.path.startsWith('source/')),
    sourceInventorySha256: hash(Buffer.from(JSON.stringify(before))), initialBaselineSha256: hash(initialBytes),
    archiveVerificationSidecar: '../archive-verification.json', limitations: inputCheck.missingRequiredFinalDeliverables };
  await fs.writeFile(path.join(payload, 'baseline-manifest.json'), `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx' });
  const files = await payloadFiles(payload), archivePath = path.join(directory, `each-answer-live2d-handoff-${initial.clientDate}.zip`);
  const plan = { payloadDirectory: payload, archivePath, extractionDirectory: path.join(directory, '.verification-extracted'),
    resultPath: path.join(directory, 'archive-verification.data.json'), files };
  const planPath = path.join(directory, 'archive-plan.json'); await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' });
  const command = process.platform === 'win32' ? 'py' : 'python3';
  const args = [...(process.platform === 'win32' ? ['-3.11'] : []), '-c', pythonZip, planPath];
  await run(command, args, { cwd: root, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  const archive = JSON.parse(await fs.readFile(plan.resultPath, 'utf8'));
  assert(sameSnapshot(before, await snapshot()), 'Source changed during ZIP creation/extraction; archive is not certified as final.');
  assert(sameSnapshot(files, await payloadFiles(payload)), 'Payload changed during ZIP verification.');
  assert((await fs.readFile(initialPath)).equals(initialBytes), 'Initial baseline changed during archive verification.');
  for (const evidence of additionalEvidence) {
    const current = await fs.readFile(path.join(root, evidence.originalPath));
    assert(current.length === evidence.bytes && hash(current) === evidence.sha256, `Additional evidence changed: ${evidence.originalPath}`);
  }
  const verification = { ...archive, handoffReady: true, verifiedAt: new Date().toISOString(), sourceStableAcrossCopyZipAndExtraction: true,
    originalImmutableSourceMatchesInitialCapture: true, authorizedCodeRevisionsRecorded: revisions, initialBaselineSha256: hash(initialBytes),
    baselineManifest: { path: 'package/baseline-manifest.json', sha256: hash(await fs.readFile(path.join(payload, 'baseline-manifest.json'))) }, targetFlags };
  await fs.writeFile(path.join(directory, 'archive-verification.json'), `${JSON.stringify(verification, null, 2)}\n`, { flag: 'wx' });
  return { status: 'private-current-handoff-verified', handoffReady: true, outputDirectory: directory, archivePath, archiveBytes: archive.archiveBytes,
    archiveSha256: archive.archiveSha256, fileCount: archive.fileCount, sourceFileCount: before.length,
    baselineManifest: path.join(payload, 'baseline-manifest.json'), archiveVerification: path.join(directory, 'archive-verification.json'), targetFlags };
}

async function main() {
  const args = process.argv.slice(2), captureOnly = args.includes('--capture-only'), finalIndex = args.indexOf('--finalize');
  if (args.includes('--help') || (!captureOnly && finalIndex < 0)) {
    console.log('Capture: node scripts/package-live2d-handoff.mjs --capture-only [--date 2026-11-05]\nFinalize after authorized code revisions: node scripts/package-live2d-handoff.mjs --finalize production/live2d/handoffs/2026-11-05 [--evidence <new nonpublic report>]\nExisting output directories/files are never overwritten. Uses Python 3.11 stdlib ZIP/CRC/extraction.'); return;
  }
  assert(!(captureOnly && finalIndex >= 0), 'Choose capture-only or finalize.');
  const evidence = [];
  for (let index = 0; index < args.length; index++) {
    if (['--date', '--finalize', '--evidence'].includes(args[index])) { assert(args[index + 1] && !args[index + 1].startsWith('--'), `${args[index]} requires a value.`); if (args[index] === '--evidence') evidence.push(args[index + 1]); index++; }
    else assert(args[index] === '--capture-only', `Unknown option: ${args[index]}`);
  }
  let result;
  if (captureOnly) {
    const dateIndex = args.indexOf('--date');
    const date = dateIndex >= 0 ? args[dateIndex + 1] : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    result = await capture(date);
  } else result = await finalize(args[finalIndex + 1], evidence);
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(`Handoff packaging failed: ${error.message}`); process.exitCode = 1; });
