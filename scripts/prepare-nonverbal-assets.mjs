import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=dirname(dirname(fileURLToPath(import.meta.url))),require=createRequire(import.meta.url),sdk=dirname(require.resolve('@mediapipe/tasks-vision'));
const target=join(root,'apps/web/public/nonverbal');
const models=[['face_landmarker.task','face_landmarker/face_landmarker/float16/1','64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff'],['pose_landmarker_lite.task','pose_landmarker/pose_landmarker_lite/float16/1','59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a'],['hand_landmarker.task','hand_landmarker/hand_landmarker/float16/1','fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1']];
await mkdir(join(target,'vendor/wasm'),{recursive:true});await mkdir(join(target,'models'),{recursive:true});
await copyFile(join(sdk,'vision_bundle.js'),join(target,'vendor/vision_bundle.js'));
for(const stem of ['vision_wasm_internal','vision_wasm_nosimd_internal'])for(const extension of ['js','wasm'])await copyFile(join(sdk,'wasm',stem+'.'+extension),join(target,'vendor/wasm',stem+'.'+extension));
const manifest={sdk:'@mediapipe/tasks-vision@1.1.1',license:'Apache-2.0',models:[]};
for(const [name,path,expectedHash] of models){
  const destination=join(target,'models',name),url=`https://storage.googleapis.com/mediapipe-models/${path}/${name}`;
  let bytes;try{bytes=await readFile(destination);}catch{
    const response=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw Error(`Model download failed (${response.status}): ${name}`);
    bytes=Buffer.from(await response.arrayBuffer());if(bytes.length<100000||bytes.length>20000000)throw Error('Unexpected model size: '+name);
  }
  const sha256=createHash('sha256').update(bytes).digest('hex');if(sha256!==expectedHash)throw Error('Model checksum mismatch: '+name);
  await writeFile(destination,bytes);manifest.models.push({name,url,sha256,bytes:bytes.length});
}
await writeFile(join(target,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log('Local video tracking assets ready (MediaPipe 1.1.1; no user data transmitted).');
