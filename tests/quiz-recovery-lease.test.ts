import assert from 'node:assert/strict';
import {afterEach,beforeEach,test} from 'node:test';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {beginRecordingRecovery,readRecordingRecovery,removeRecordingRecovery,RECORDING_LEASE_MS} from '../apps/web/src/lib/client/recording-recovery.ts';

const scope={studentId:'lease-student',sessionId:'lease-quiz',itemIndex:2,kind:'quiz' as const};
const originalNow=Date.now;
const originalGlobals=new Map(['indexedDB','IDBKeyRange'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
beforeEach(()=>{Object.assign(globalThis,{indexedDB:new IDBFactory(),IDBKeyRange});});
afterEach(()=>{Date.now=originalNow;for(const [key,descriptor] of originalGlobals)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);});

test('a suspended quiz checkpoint becomes recoverable after its lease and still retains the original final chunk',async t=>{
  // An app killed or frozen in the background cannot run its lease heartbeat.
  t.mock.timers.enable({apis:['setInterval']});let now=originalNow();Date.now=()=>now;
  const original=await beginRecordingRecovery(scope,'audio/webm');await original.append(new Blob(['spoken before lock'],{type:'audio/webm'}),750);
  const immediate=await readRecordingRecovery(scope);assert.equal(immediate?.key,original.key);assert.equal(immediate.inUse,true);assert.equal(immediate.complete,false);
  await assert.rejects(removeRecordingRecovery(original.key),/다른 탭/);
  now+=RECORDING_LEASE_MS+1;
  const recovered=await readRecordingRecovery(scope);assert.equal(recovered?.key,original.key);assert.equal(recovered.inUse,false);assert.equal(await recovered.blob.text(),'spoken before lock');assert.equal(recovered.durationMs,750);
  // Recovery availability never authorizes a new recording to overwrite this file.
  await assert.rejects(beginRecordingRecovery(scope,'audio/webm'),/다른 탭/);
  // If the original app wakes, its final MediaRecorder event still belongs to it.
  await original.append(new Blob([' and final queued chunk'],{type:'audio/webm'}),1000);
  const final=await original.finish({durationMs:1000});assert.equal(final.key,recovered.key);assert.equal(final.complete,true);assert.equal(final.inUse,false);assert.equal(final.durationMs,1000);assert.equal(await final.blob.text(),'spoken before lock and final queued chunk');
  assert.equal(await (await readRecordingRecovery(scope))!.blob.text(),'spoken before lock and final queued chunk');
});

test('a late suspended writer cannot recreate discarded audio or delete a replacement recording',async t=>{
  t.mock.timers.enable({apis:['setInterval']});let now=originalNow();Date.now=()=>now;
  const old=await beginRecordingRecovery(scope,'audio/webm');await old.append(new Blob(['old checkpoint']),250);now+=RECORDING_LEASE_MS+1;
  await removeRecordingRecovery(old.key);const replacement=await beginRecordingRecovery(scope,'audio/webm');assert.notEqual(replacement.attemptId,old.attemptId);
  await replacement.append(new Blob(['replacement first']),250);await assert.rejects(old.append(new Blob(['late old final']),500));
  await old.cancel();await removeRecordingRecovery(old.key);
  const stillOwned=await readRecordingRecovery(scope);assert.equal(stillOwned?.key,replacement.key);assert.equal(stillOwned.inUse,true);assert.equal(await stillOwned.blob.text(),'replacement first');
  await replacement.append(new Blob([' replacement final']),500);const final=await replacement.finish({durationMs:500});assert.equal(await final.blob.text(),'replacement first replacement final');
});

test('a complete file with an unknown native stop time keeps its measurement requirement across reload',async()=>{
  const writer=await beginRecordingRecovery(scope,'audio/webm');await writer.append(new Blob(['real encoded audio before native stop']),1200);
  const finished=await writer.finish({durationMs:181_000,needsMeasurement:true});
  assert.equal(finished.complete,true);assert.equal(finished.needsMeasurement,true);assert.equal(finished.inUse,false);
  // A final chunk was received, but its delayed JS timestamp is not media duration.
  const reloaded=await readRecordingRecovery(scope);assert.equal(reloaded?.complete,true);assert.equal(reloaded.needsMeasurement,true);assert.equal(reloaded.durationMs,181_000);assert.equal(await reloaded.blob.text(),'real encoded audio before native stop');
  await removeRecordingRecovery(writer.key);assert.equal(await readRecordingRecovery(scope),null);
  const measured=await beginRecordingRecovery(scope,'audio/webm');await measured.append(new Blob(['measured file']),1500);await measured.finish({durationMs:1500});
  assert.equal((await readRecordingRecovery(scope))?.needsMeasurement,undefined);
});
