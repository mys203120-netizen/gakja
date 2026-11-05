import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const directory=path.resolve('public/live2d/production');
const sha256=buffer=>createHash('sha256').update(buffer).digest('hex');
const speakers=[];
for(const id of ['interviewer-1','interviewer-2']) {
  const folder=path.join(directory,id), proof=JSON.parse(await fs.readFile(path.join(folder,'psd-verification.json'),'utf8'));
  const manifestBuffer=await fs.readFile(path.join(folder,'parts','manifest.json'));
  const manifest=JSON.parse(manifestBuffer.toString('utf8'));
  if(sha256(manifestBuffer)!==proof.manifestSha256)throw new Error(`${id}: source manifest changed after PSD verification`);
  const outputs=[];
  for(const record of proof.outputs) {
    const filename=record.kind+'.psd',buffer=await fs.readFile(path.join(folder,filename));
    if(buffer.subarray(0,4).toString('ascii')!=='8BPS'||buffer.readUInt16BE(4)!==1||buffer.readUInt16BE(22)!==8||buffer.readUInt16BE(24)!==3)throw new Error(`${id}/${filename}: not PSD v1 RGB8`);
    if(sha256(buffer)!==record.sha256)throw new Error(`${id}/${filename}: hash differs from verified saved PSD`);
    const expected=record.kind==='artwork_master'?manifest.layers:manifest.layers.filter(l=>l.role==='part');
    if(record.rasterLayers!==expected.length||record.layers.length!==expected.length)throw new Error(`${id}: layer count mismatch`);
    const savedNames=new Set(record.layers.map(l=>l.name));
    for(const name of ['Face_Base','EyeWhite_L','EyeWhite_R','Iris_L','Iris_R','UpperLip','LowerLip','Mouth_Inside','Teeth_Upper','Hand_L','Hand_R'])if(!savedNames.has(name))throw new Error(`${id}: missing independent required part ${name}`);
    if(record.kind==='cubism_import'&&record.layers.some(l=>!l.visible))throw new Error(`${id}: import art layer unexpectedly hidden`);
    outputs.push({file:filename,bytes:buffer.length,sha256:record.sha256,layers:record.rasterLayers,rgb8:true,srgbIccVerified:true,independentLayerRgbaExact:true});
  }
  for(const layer of manifest.layers)await fs.access(path.join(folder,'parts',layer.path));
  speakers.push({id,partPngs:manifest.layers.length,artLayers:manifest.layers.filter(l=>l.role==='part').length,outputs,cubismImportTested:false,rigCreated:false,moc3Exported:false});
}
const catalog=JSON.parse(await fs.readFile(path.join(directory,'motions','catalog.json'),'utf8'));
const report={status:'partial-complete',scope:'existing PSD package hashes, recorded exact layer roundtrip and required independent parts',checkedAt:new Date().toISOString(),speakers,motionCatalogPresent:Boolean(catalog),photoshopVerification:'excluded-by-user',computerUse:'prohibited-by-user',cubismEditorAvailable:false,actualRigCreated:false,actualModelRuntimeTested:false,releaseReady:false,blockers:['No available Cubism Editor authoring/export path in this environment; GUI automation prohibited by user.','Dedicated cmo3/can3/moc3/model3/texture atlas/MotionSync mapping have not been authored or exported.','Natural deformation, Korean audio lip sync and mobile performance require the dedicated exported models.']};
await fs.writeFile(path.join(directory,'qa-summary.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,verifiedPsdFiles:speakers.flatMap(s=>s.outputs).length,speakers:speakers.map(s=>({id:s.id,partPngs:s.partPngs,artLayers:s.artLayers})),actualRigCreated:false,releaseReady:false},null,2));
