import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { registerLocalSource, installLocalWriterFence, sealLocalSource, restoreLocalSourceAfterEmptyRollback, withLocalWriterFence,inspectStoppedLocalParticipants } from '../../server/transition/local-writer-fence';

const execute = promisify(execFile), scope = {ownerId:'explicit-owner',studentId:'explicit-student',applicationTargetId:'explicit-personal-app',supportTargetId:'explicit-support'};
const base = path.resolve('artifacts/pr07g/local-source-tests');
async function fixture() {
  await mkdir(base,{recursive:true}); const root=await mkdtemp(path.join(base,'owned-')); await mkdir(path.join(root,'data/sessions'),{recursive:true});
  const original='{"id":"10000000-0000-4000-8000-000000000001","status":"completed","turns":[],"elapsedMs":3,"quote":"가😀"}\n';
  await writeFile(path.join(root,'data/sessions/10000000-0000-4000-8000-000000000001.json'),original);
  let allowed=true;
  const authority=registerLocalSource({root,scope,async authorize(){if(!allowed)throw new Error('OPERATOR_REVOKED');}});
  await installLocalWriterFence(authority);
  return {root,original,authority,revoke(){allowed=false;}};
}
test('local barrier excludes active legacy sessions without rewriting their bytes',async()=>{
  const f=await fixture(), file=path.join(f.root,'data/sessions/10000000-0000-4000-8000-000000000001.json');
  const raw=f.original.replace('completed','active');await writeFile(file,raw);let activated=false;
  await assert.rejects(sealLocalSource(f.authority,{generation:'0',stoppedParticipantProofSha256:'a'.repeat(64),async activate(){activated=true;}}),/LOCAL_SOURCE_ACTIVE_WORK_EXCLUDED/u);
  assert.equal(activated,false);assert.equal(await readFile(file,'utf8'),raw);
  assert.equal(await withLocalWriterFence(f.root,async()=> 'legacy-path-still-available'),'legacy-path-still-available');
});
test('same cross-process lock covers a final rename and activation; exact old F writer cannot restart through the physical barrier',{timeout:60_000},async()=>{
  const f=await fixture();
  const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./local-writer-child.ts',import.meta.url)),f.root,'current'],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  const events:Record<string,unknown>[]=[];let logs='';child.stderr!.on('data',v=>{logs+=v;});child.on('message',v=>events.push(v as Record<string,unknown>));
  const next=async(type:string)=>{if(events.some(v=>v.type===type))return;await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(new Error('CHILD_PHASE_TIMEOUT:'+type+logs));},15_000);const receive=(v:Record<string,unknown>)=>{if(v.type===type){cleanup();resolve();}};const cleanup=()=>{clearTimeout(timer);child.off('message',receive);};child.on('message',receive);});};
  try {
    await next('before-rename');let activated=false;
    const participant={pid:child.pid!,host:hostname(),rootHash:createHash('sha256').update(path.resolve(f.root)).digest('hex')};
    assert.equal(inspectStoppedLocalParticipants({root:f.root,inventoryComplete:true,participants:[participant]}).unparticipatingProcesses,1);
    const activation=sealLocalSource(f.authority,{generation:'0',stoppedParticipantProofSha256:'a'.repeat(64),async activate(){activated=true;return 'committed';}});
    await new Promise(resolve=>setTimeout(resolve,50));assert.equal(activated,false);
    child.send('release');assert.equal(await activation,'committed');await next('written');assert.equal(activated,true);
    assert.equal((await lstat(path.join(f.root,'data'))).isFile(),true);
    await assert.rejects(withLocalWriterFence(f.root,async()=>{}),/LOCAL_WRITER_FENCED/u);
    // Preserve and execute the exact F module bytes, resolving its imports to
    // the unchanged runtime in this checkout. No rewritten old writer guard.
    const legacyRoot=await mkdtemp(path.join(base,'legacy-code-'));await mkdir(path.join(legacyRoot,'storage'));
    const legacy=(await execute('git',['show','4261acbd0cbc763a838be102b565d66f6f01e036:server/storage/local-session-store.ts'],{maxBuffer:1024*1024})).stdout;
    await writeFile(path.join(legacyRoot,'storage/local-session-store.ts'),legacy);
    // Symlinks/dependency copies are unnecessary: only its runtime dependency
    // is a forwarding source module; original store source stays byte exact.
    const runtime=new URL('../../server/session-runtime.ts',import.meta.url).href;
    await writeFile(path.join(legacyRoot,'session-runtime.ts'),`export * from ${JSON.stringify(runtime)};\n`);
    const legacyChild=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./local-writer-child.ts',import.meta.url)),f.root,'legacy',path.join(legacyRoot,'storage/local-session-store.ts')],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
    const legacyEvents:Record<string,unknown>[]=[];let legacyLogs='';legacyChild.stderr!.on('data',v=>{legacyLogs+=v;});legacyChild.on('message',v=>legacyEvents.push(v as Record<string,unknown>));
    await new Promise<void>((resolve,reject)=>{legacyChild.once('exit',code=>code===0?resolve():reject(new Error('OLD_F_CHILD_FAILED:'+legacyLogs)));});
    assert.ok(legacyEvents.some(v=>v.type==='rejected'&&['ENOTDIR','EEXIST'].includes(String(v.code))),JSON.stringify({legacyEvents,legacyLogs}));
    assert.equal(await readFile(path.join(legacyRoot,'storage/local-session-store.ts'),'utf8'),legacy);
  } finally {if(child.exitCode===null&&child.signalCode===null)child.kill();}
});
test('activation response loss leaves the barrier closed and resumes the exact checkpoint without rewriting it',async()=>{
  const f=await fixture();let original='';
  await assert.rejects(sealLocalSource(f.authority,{generation:'0',stoppedParticipantProofSha256:'b'.repeat(64),async activate(e){original=e.checkpointJson;throw new Error('COMMIT_RESPONSE_LOST');}}),/COMMIT_RESPONSE_LOST/u);
  assert.equal((await lstat(path.join(f.root,'data'))).isFile(),true);
  await sealLocalSource(f.authority,{generation:'0',stoppedParticipantProofSha256:'b'.repeat(64),async activate(e){assert.equal(e.checkpointJson,original);}});
});
test('empty rollback requires confirmed durable proof, preserves checkpoint bytes; a revoked operator cannot unseal',async()=>{
  const f=await fixture();await sealLocalSource(f.authority,{generation:'0',stoppedParticipantProofSha256:'b'.repeat(64),async activate(e){assert.equal(JSON.parse(e.checkpointJson).files.length,1);}});
  await assert.rejects(restoreLocalSourceAfterEmptyRollback(f.authority,async()=>{throw new Error('POST_WRITE_RECOVERY_REQUIRED');}),/POST_WRITE_RECOVERY_REQUIRED/u);
  assert.equal((await lstat(path.join(f.root,'data'))).isFile(),true);
  await restoreLocalSourceAfterEmptyRollback(f.authority,async()=>{});
  assert.equal(await readFile(path.join(f.root,'data/sessions/10000000-0000-4000-8000-000000000001.json'),'utf8'),f.original);
  f.revoke();await assert.rejects(sealLocalSource(f.authority,{generation:'1',stoppedParticipantProofSha256:'b'.repeat(64),async activate(){}}),/OPERATOR_REVOKED/u);
});
test('empty rollback interruption before/after directory restore resumes its exact journal and keeps participating writes fenced',async()=>{
  for(const stop of ['barrier-removed','archive-restored']as const){
    const f=await fixture();await sealLocalSource(f.authority,{generation:'0',stoppedParticipantProofSha256:'c'.repeat(64),async activate(){}});
    await assert.rejects(restoreLocalSourceAfterEmptyRollback(f.authority,async()=>{}, {async observe(phase){if(phase===stop)throw new Error('CONTROLLED_ROLLBACK_INTERRUPTION');}}),/CONTROLLED_ROLLBACK_INTERRUPTION/u);
    await assert.rejects(withLocalWriterFence(f.root,async()=>{}),/LOCAL_WRITER_FENCED/u);
    await restoreLocalSourceAfterEmptyRollback(f.authority,async()=>{});
    assert.equal(await readFile(path.join(f.root,'data/sessions/10000000-0000-4000-8000-000000000001.json'),'utf8'),f.original);
  }
});
