import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { spawnSync } from 'node:child_process';
import { validateLive2DDelivery, validatePackagePath, deliveryReadiness } from '../lib/live2d/delivery-validation.mjs';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
// These are deliberately synthetic structural fixtures, NOT executable Cubism
// models. No supplied/mock Core is run, and no test claims actual model PASS.
async function fixture(textureName = 'atlas.png') {
  const root = path.resolve('tmp/live2d-delivery-tests', randomUUID());
  await fs.mkdir(root, { recursive: true });
  const files: Array<{path:string,bytes:number,sha256:string}> = [];
  const put = async (relative: string, value: Buffer | object) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    await fs.mkdir(path.dirname(path.join(root,relative)),{recursive:true});
    await fs.writeFile(path.join(root,relative),bytes); files.push({path:relative,bytes:bytes.length,sha256:sha256(bytes)});
  };
  const png = await sharp({create:{width:2,height:2,channels:4,background:'#cc9977aa'}}).png().toBuffer();
  const models = [];
  for(const speakerId of ['interviewer-1','interviewer-2']) {
    const folder=`models/${speakerId}`;
    await put(`${folder}/model.moc3`,Buffer.from([77,79,67,51,1,2,3,4,5,6,7,8]));
    await put(`${folder}/${textureName}`,png);
    await put(`${folder}/neutral.motion3.json`,{Version:3,Meta:{Duration:1,Fps:30,Loop:false,CurveCount:1,TotalSegmentCount:1,TotalPointCount:2},Curves:[{Target:'Parameter',Id:'ParamAngleX',Segments:[0,0,0,1,0]}]});
    await put(`${folder}/neutral.exp3.json`,{Type:'Live2D Expression',Parameters:[{Id:'ParamAngleX',Value:0,Blend:'Add'}]});
    await put(`${folder}/sync.motionsync3.json`,{Version:1,Meta:{SettingCount:1},Settings:[{Id:'fixture',AnalysisType:'CRI',UseCase:'fixture-only',CubismParameters:[{Id:'ParamMouthOpenY',Min:0,Max:1}],AudioParameters:[{Id:'fixture-only'}],Mappings:[{Id:'fixture-only',Targets:[{Id:'ParamMouthOpenY',Value:1}]}]}]});
    await put(`${folder}/parameters.json`,{parameters:[{id:'ParamAngleX',min:-5,max:5,default:0},{id:'ParamMouthOpenY',min:0,max:1,default:0}]});
    await put(`${folder}/editor.cmo3`,Buffer.from('synthetic-file-presence-fixture-not-a-Cubism-project'));
    await put(`${folder}/animations.can3`,Buffer.from('synthetic-file-presence-fixture-not-an-animation'));
    await put(`${folder}/model.model3.json`,{Version:3,FileReferences:{Moc:'model.moc3',Textures:[textureName],Motions:{Idle:[{File:'neutral.motion3.json'}]},Expressions:[{Name:'Neutral',File:'neutral.exp3.json'}],MotionSync:'sync.motionsync3.json'}});
    models.push({speakerId,model3:`${folder}/model.model3.json`,cmo3:`${folder}/editor.cmo3`,can3:[`${folder}/animations.can3`],parameters:`${folder}/parameters.json`});
  }
  const manifest={schemaVersion:1,deliveryId:'synthetic-file-integrity-fixture',modelKind:'sample',versions:{editor:'fixture',exporter:'fixture',cubismWeb:'5-r.5',motionSyncWeb:'5-r.3',cubismCore:'5.0.0',motionSyncCore:'fixture'},models,files};
  const save=()=>fs.writeFile(path.join(root,'delivery.json'),JSON.stringify(manifest));
  await save(); return {root,manifest,save};
}
test('structural PASS cannot establish Core, dedicated interviewers, runtime QA or release readiness',async()=>{
  const f=await fixture(),r=await validateLive2DDelivery({deliveryRoot:f.root});
  assert.equal(r.levels.level1.status,'PASS'); assert.equal(r.assetValidationPassed,true);
  assert.equal(r.levels.level2.status,'BLOCKED'); assert.equal(r.levels.level3.status,'NOT_RUN');
  assert.equal(r.modelLoadVerified,false); assert.equal(r.motionSyncVerified,false); assert.equal(r.releaseReady,false);
  assert.equal(r.actualModelNewlyAuthored,false);
});
test('case errors in model references are rejected even on Windows',async()=>{
  const f=await fixture(),file=f.manifest.models[0].model3;
  const json=JSON.parse(await fs.readFile(path.join(f.root,file),'utf8'));json.FileReferences.Textures=['Atlas.png'];
  const bytes=Buffer.from(JSON.stringify(json));await fs.writeFile(path.join(f.root,file),bytes);
  Object.assign(f.manifest.files.find(x=>x.path===file)!,{bytes:bytes.length,sha256:sha256(bytes)});await f.save();
  const r=await validateLive2DDelivery({deliveryRoot:f.root});assert.equal(r.levels.level1.status,'FAIL');assert.match(r.levels.level1.errors.join('\n'),/대소문자/);
});
test('literal Korean names and spaces remain valid exact-case package paths',async()=>{
  const f=await fixture('텍스처 atlas.png'),r=await validateLive2DDelivery({deliveryRoot:f.root});
  assert.equal(r.levels.level1.status,'PASS',r.levels.level1.errors.join('\n'));assert.equal(r.releaseReady,false);
});
test('parent traversal, encoded paths and remote/absolute references are rejected before file reads',()=>{
  for(const value of ['../a.moc3','a/../b.png','C:/outside.png','/root.png','a\\b.png','a%2fb.png','https://example.test/a','a.png?x=1','a//b'])assert.throws(()=>validatePackagePath(value));
});
test('file manifest tampering fails and prevents even attempted Core execution',async()=>{
  const f=await fixture();await fs.appendFile(path.join(f.root,f.manifest.files[0].path),'tampered');
  const r=await validateLive2DDelivery({deliveryRoot:f.root,corePath:'missing-do-not-run.js'});
  assert.equal(r.levels.level1.status,'FAIL');assert.equal(r.levels.level2.status,'BLOCKED');assert.equal(r.levels.level2.models.length,0);
});
test('a PNG with valid-looking header/trailer but damaged pixels fails actual decoding',async()=>{
  const f=await fixture(),entry=f.manifest.files.find(x=>x.path.endsWith('atlas.png'))!;
  const bytes=await fs.readFile(path.join(f.root,entry.path));
  let cursor=8, corrupted=false;
  while(cursor+12<=bytes.length){const length=bytes.readUInt32BE(cursor),kind=bytes.toString('ascii',cursor+4,cursor+8);if(kind==='IDAT'){bytes[cursor+8]=0;bytes[cursor+9]=0;corrupted=true;break;}cursor+=length+12;}
  assert.equal(corrupted,true);await fs.writeFile(path.join(f.root,entry.path),bytes);
  entry.sha256=sha256(bytes);await f.save();const r=await validateLive2DDelivery({deliveryRoot:f.root});
  assert.equal(r.levels.level1.status,'FAIL');assert.match(r.levels.level1.errors.join('\n'),/디코딩|PNG/);
});
test('missing mandatory version and duplicate model reference cannot pass',async()=>{
  const f=await fixture();f.manifest.versions.editor='';f.manifest.models[1].model3=f.manifest.models[0].model3;await f.save();
  const r=await validateLive2DDelivery({deliveryRoot:f.root});assert.equal(r.levels.level1.status,'FAIL');assert.match(r.levels.level1.errors.join('\n'),/버전/);assert.match(r.levels.level1.errors.join('\n'),/같은 model3/);
});
test('no returned delivery is BLOCKED, rather than an invented successful model check',async()=>{
  const r=await validateLive2DDelivery({deliveryRoot:path.resolve('tmp/live2d-delivery-tests',randomUUID())});
  assert.equal(r.levels.level1.status,'BLOCKED');assert.equal(r.levels.level2.status,'BLOCKED');assert.equal(r.levels.level3.status,'NOT_RUN');assert.equal(r.releaseReady,false);
});
test('sample origin and non-execution override a dossier of optimistic PASS flags',()=>{
  const levels={level1:{status:'PASS'},level2:{status:'PASS',executedWithCore:true},level3:{status:'PASS',executed:true,motionSyncVerified:true,runtimeQAComplete:true}};
  assert.equal(deliveryReadiness(levels,'sample').releaseReady,false);
  levels.level2.executedWithCore=false;assert.equal(deliveryReadiness(levels,'dedicated').releaseReady,false);
  levels.level2.executedWithCore=true;levels.level3.status='NOT_RUN';assert.equal(deliveryReadiness(levels,'dedicated').releaseReady,false);
});
test('reading valid external QA evidence does not count as executing LEVEL 3',async()=>{
  const f=await fixture(),parent=path.join(f.root,'..',randomUUID());await fs.mkdir(parent,{recursive:true});
  const artifact=Buffer.from('external QA recording placeholder, not a device run in this process');
  await fs.writeFile(path.join(parent,'recording.txt'),artifact);
  const deliveryHash=sha256(await fs.readFile(path.join(f.root,'delivery.json')));
  const evidence={deliveryManifestSha256:deliveryHash,runs:[{category:'synthetic-dossier-integrity-only',status:'PASS',command:'fixture',environment:{fixture:true},artifacts:[{path:'recording.txt',bytes:artifact.length,sha256:sha256(artifact)}]}]};
  const evidencePath=path.join(parent,'evidence.json');await fs.writeFile(evidencePath,JSON.stringify(evidence));
  const r=await validateLive2DDelivery({deliveryRoot:f.root,level3Evidence:evidencePath});
  assert.equal(r.levels.level3.evidenceReview.status,'PASS');assert.equal(r.levels.level3.status,'NOT_RUN');assert.equal(r.runtimeQAComplete,false);assert.equal(r.releaseReady,false);
});
test('the real plain-Node CLI completes, writes a new report, and refuses overwriting existing evidence',async()=>{
  const f=await fixture(),reportFile=path.resolve('tmp/live2d-delivery-tests',randomUUID(),'report.json');
  const args=['scripts/verify-live2d-assets.mjs','--delivery-root',f.root,'--report',reportFile];
  const run=spawnSync(process.execPath,args,{encoding:'utf8',timeout:15000,windowsHide:true});
  assert.equal(run.status,2,run.stderr);const before=await fs.readFile(reportFile);
  const report=JSON.parse(before.toString('utf8'));assert.equal(report.levels.level1.status,'PASS');assert.equal(report.releaseReady,false);
  const repeated=spawnSync(process.execPath,args,{encoding:'utf8',timeout:15000,windowsHide:true});
  assert.equal(repeated.status,1);assert.match(repeated.stderr,/덮어쓰지/);assert.deepEqual(await fs.readFile(reportFile),before);
});
