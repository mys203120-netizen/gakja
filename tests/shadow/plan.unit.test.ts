import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inventoryShadowFiles,readShadowSource,assertShadowInventory,type ShadowInventoryRequest } from '../../server/shadow/shadow-plan';

async function fixture() {
  const dir=await mkdtemp(path.join(tmpdir(),'gakja-shadow-inventory-'));
  const request:ShadowInventoryRequest={version:'shadow-inventory-request-v1',runId:'11111111-1111-4111-8111-111111111111',binding:'synthetic',ownerId:'owner-a',studentId:'student-a',applicationTargetId:'app-a',supportTargetId:'track-a',
    artifacts:[{artifactId:'raw',locatorId:'opaque-raw',role:'configured-input:raw',reference:'legacy/provenance.json',selection:'configured',scope:'common',required:true,dependencies:[],availability:'present',objectKind:'source-json',classification:'selected',source:{rootId:'owned',relativePath:'raw.json'}}]};
  const bytes=Buffer.from('\ufeff{"z":"한글🙂","n":null,"a":1}\r\n','utf8');await writeFile(path.join(dir,'raw.json'),bytes);
  const close=async()=>{const resolved=path.resolve(dir);assert.equal(path.dirname(resolved),path.resolve(tmpdir()));assert.ok(path.basename(resolved).startsWith('gakja-shadow-inventory-'));await rm(resolved,{recursive:true,force:true});};
  return {dir,request,bytes,close};
}
test('D inventory pins exact BOM/CRLF/Unicode bytes and keeps missing domain hash absent with zero backend writes',async()=>{
  const f=await fixture();try {
    const inventory=await inventoryShadowFiles(f.request,{owned:f.dir});assert.equal(inventory.eligible,true);assert.equal(inventory.backendWrites,0);assert.equal(inventory.providerCalls,0);
    assert.equal(Object.hasOwn(inventory.plan.artifacts[0],'domainSha256'),false);assertShadowInventory(inventory);
    assert.deepEqual(await readShadowSource(inventory,{owned:f.dir},'raw'),f.bytes);
    assert.equal(inventory.plan.artifacts[0].availability==='present'?inventory.plan.artifacts[0].rawSha256:'',createHash('sha256').update(f.bytes).digest('hex'));
    await writeFile(path.join(f.dir,'raw.json'),Buffer.from('{"changed":true}'));
    await assert.rejects(readShadowSource(inventory,{owned:f.dir},'raw'),{code:'SHADOW_SOURCE_CHANGED'});
  }finally{await f.close();}
});
test('D inventory treats explicit known absence, missing input and present empty journal as different states',async()=>{
  const f=await fixture();try {
    await writeFile(path.join(f.dir,'empty.jsonl'),'');
    f.request.artifacts=[...f.request.artifacts,
      {artifactId:'absent',role:'optional',locatorId:'opaque-absent',reference:'nothing',selection:'dependency',scope:'common',required:false,dependencies:[],availability:'absent',absenceReason:'known-absent'},
      {artifactId:'missing',role:'missing',locatorId:'opaque-missing',reference:'missing',selection:'dependency',scope:'common',required:true,dependencies:[],availability:'present',objectKind:'source-json',classification:'dependency',source:{rootId:'owned',relativePath:'missing.json'}},
      {artifactId:'empty',role:'journal',locatorId:'opaque-empty',reference:'empty',selection:'dependency',scope:'common',required:true,dependencies:[],availability:'present',objectKind:'review-journal',classification:'dependency',source:{rootId:'owned',relativePath:'empty.jsonl'}}];
    const inventory=await inventoryShadowFiles(f.request,{owned:f.dir});assert.equal(inventory.eligible,false);
    assert.equal(inventory.entries.find(e=>e.artifactId==='absent')?.classification,'absent');assert.equal(inventory.entries.find(e=>e.artifactId==='missing')?.classification,'missing');
    const empty=inventory.entries.find(e=>e.artifactId==='empty')!;assert.equal(empty.classification,'unsupported');assert.equal(empty.sizeBytes,0);assert.equal(empty.rawSha256,createHash('sha256').digest('hex'));
  }finally{await f.close();}
});
test('D inventory rejects root traversal and changed inventory metadata, preserves nonempty JSONL exact bytes',async()=>{
  const f=await fixture();try {
    await mkdir(path.join(f.dir,'journals'));const journal=Buffer.from('{"event":1}\r\n{"event":2}\n');await writeFile(path.join(f.dir,'journals','a.jsonl'),journal);
    const item=f.request.artifacts[0];assert.equal(item.availability,'present');if(item.availability!=='present')throw new Error();
    const input={...f.request,artifacts:[{...item,objectKind:'review-journal' as const,source:{rootId:'owned',relativePath:'journals/a.jsonl'}}]};
    const inventory=await inventoryShadowFiles(input,{owned:f.dir});assert.equal(inventory.eligible,true);assert.deepEqual(await readShadowSource(inventory,{owned:f.dir},'raw'),journal);
    const altered=structuredClone(inventory);altered.sources.raw.relativePath='raw.json';assert.throws(()=>assertShadowInventory(altered));
    const blocked=await inventoryShadowFiles({...f.request,artifacts:[{...item,source:{rootId:'owned',relativePath:'../outside.json'}}]},{owned:f.dir});
    assert.equal(blocked.eligible,false);assert.equal(blocked.entries[0].reason,'SHADOW_SOURCE_OUTSIDE_ROOT');assert.deepEqual(await readFile(path.join(f.dir,'raw.json')),f.bytes);
  }finally{await f.close();}
});
