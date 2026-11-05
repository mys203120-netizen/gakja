import { cp, mkdir, access, stat, readdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const packageRoot = name => {
  let directory = path.dirname(require.resolve(name));
  while (!existsSync(path.join(directory, 'package.json'))) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate ${name}`);
    directory = parent;
  }
  return directory;
};
const exists = async p => access(p).then(()=>true,()=>false);
async function copyDir(source, destination, filter) {
  await mkdir(destination, { recursive: true });
  for (const item of await readdir(source)) {
    if (!filter(item)) continue;
    const src = path.join(source, item), dst = path.join(destination,item);
    if (await exists(dst) && (await stat(src)).size === (await stat(dst)).size) continue;
    await cp(src,dst,{recursive:true});
  }
}
try {
  await copyDir(path.join(packageRoot('@mediapipe/tasks-vision'),'wasm'),path.join(root,'public/vendor/mediapipe/wasm'),()=>true);
    await copyDir(packageRoot('@mediapipe/tasks-vision'),path.join(root,'public/vendor/mediapipe'),n=>n==='vision_bundle.mjs'||n==='vision_bundle.js');
  await copyDir(path.join(packageRoot('@ricky0123/vad-web'),'dist'),path.join(root,'public/vendor/vad'),n=>/\.onnx$|vad\.worklet.*\.js$/.test(n));
  // vad-web requires its own tested ONNX runtime version, rather than a second incompatible WASM build.
  const vadRequire = createRequire(path.join(packageRoot('@ricky0123/vad-web'),'package.json'));
  let ort = path.dirname(vadRequire.resolve('onnxruntime-web'));
  while (!existsSync(path.join(ort, 'package.json'))) ort = path.dirname(ort);
  await copyDir(path.join(ort,'dist'),path.join(root,'public/vendor/onnx'),n=>/\.wasm$|\.mjs$/.test(n));
  const model = path.join(root,'public/models/face_landmarker.task');
  if (!await exists(model)) {
    await mkdir(path.dirname(model),{recursive:true});
    console.log('MediaPipe 얼굴 관찰 모델을 준비합니다 (최초 실행).');
    const r = await fetch('https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',{signal:AbortSignal.timeout(90000)});
    if(!r.ok) throw new Error(`MediaPipe model download ${r.status}`);
    await writeFile(model+'.tmp',new Uint8Array(await r.arrayBuffer()));
    await rename(model+'.tmp',model);
  }
  console.log('로컬 음성·얼굴 관찰 리소스 준비 완료');
} catch(e) {
  // Camera analysis is optional; the interview should remain usable with unavailable measurements.
  console.warn(`관찰 모델 준비 실패: ${e.message}. 화면에서 측정 불가로 표시합니다.`);
}
