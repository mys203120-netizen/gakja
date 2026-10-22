import assert from 'node:assert/strict';
import {test,beforeEach,afterEach} from 'node:test';
import {IDBFactory,IDBKeyRange,IDBObjectStore} from 'fake-indexeddb';
import {beginRecordingRecovery,readRecordingRecovery,listRecordingRecovery,removeRecordingRecovery,recordingRecoveryKey,RECORDING_RECOVERY_TTL_MS,RECORDING_LEASE_MS,installRecordingExitGuard} from '../apps/web/src/lib/client/recording-recovery.ts';

const scope={studentId:'student-a',sessionId:'session-a',itemIndex:0,kind:'quiz' as const};
const originalNow=Date.now,originalPut=IDBObjectStore.prototype.put;
beforeEach(()=>{Object.assign(globalThis,{indexedDB:new IDBFactory(),IDBKeyRange});});
afterEach(()=>{Date.now=originalNow;IDBObjectStore.prototype.put=originalPut;});

test('an owning writer can explicitly discard recorded chunks while stale callbacks cannot erase a replacement',async()=>{
  const first=await beginRecordingRecovery(scope,'audio/webm');await first.append(new Blob(['discarded']),100);
  await first.discard();assert.equal(await readRecordingRecovery(scope),null);
  await assert.rejects(first.append(new Blob(['late']),200));
  const replacement=await beginRecordingRecovery(scope,'audio/webm');await replacement.append(new Blob(['keep']),100);
  await first.discard();assert.equal(await (await readRecordingRecovery(scope))!.blob.text(),'keep');
  await replacement.discard();
});

test('committed chunks survive independently before final stop and assemble in event order',async()=>{
  const writer=await beginRecordingRecovery(scope,'');
  await writer.append(new Blob(['first'],{type:'audio/mp4'}),240);
  const interrupted=await readRecordingRecovery(scope);
  assert.equal(interrupted?.complete,false);assert.equal(interrupted?.durationMs,240);assert.equal(interrupted?.blob.type,'audio/mp4');
  const early=writer.append(new Blob([' second'],{type:'audio/mp4'}),500);
  const late=writer.append(new Blob([' final'],{type:'audio/mp4'}),700);
  await Promise.all([early,late]);
  const finished=await writer.finish({durationMs:700});
  assert.equal(await finished.blob.text(),'first second final');assert.equal(finished.complete,true);
  assert.equal(await (await readRecordingRecovery(scope))!.blob.text(),'first second final');
});

test('video primary and analysis audio keep separate ordered tracks',async()=>{
  const live={...scope,kind:'interview' as const,sessionId:'session:turn:generation'};
  const writer=await beginRecordingRecovery(live,'');
  await writer.append(new Blob(['video'],{type:'video/webm'}),1000);
  await writer.appendAnalysis(new Blob(['audio-a'],{type:'audio/webm'}));
  await writer.appendAnalysis(new Blob(['audio-b'],{type:'audio/webm'}));
  const saved=await writer.finish({durationMs:1000,analysisAudio:new Blob(['audio-aaudio-b'],{type:'audio/webm'})});
  assert.equal(saved.blob.type,'video/webm');assert.equal(await saved.blob.text(),'video');assert.equal(await saved.analysisAudio!.text(),'audio-aaudio-b');
});

test('student, session, question and media kind scopes never restore another recording',async()=>{
  const different=[scope,{...scope,studentId:'student-b'},{...scope,sessionId:'session-b'},{...scope,itemIndex:1},{...scope,kind:'interview' as const}];
  for(let index=0;index<different.length;index++){const writer=await beginRecordingRecovery(different[index],'audio/webm');await writer.append(new Blob([String(index)]),100);}
  assert.equal(new Set(different.map(recordingRecoveryKey)).size,5);
  assert.equal(await (await readRecordingRecovery({...scope,studentId:'unknown'}))?.blob.text(),undefined);
  const own=await listRecordingRecovery(scope);assert.equal(own.length,2);assert.deepEqual(own.map(row=>row.studentId),['student-a','student-a']);
  assert.equal(await (await readRecordingRecovery({...scope,itemIndex:1}))!.blob.text(),'3');
});

test('starting a replacement cannot overwrite unsent audio',async()=>{
  const writer=await beginRecordingRecovery(scope,'audio/webm');await writer.append(new Blob(['original']),100);
  await assert.rejects(beginRecordingRecovery(scope,'audio/mp4'));
  assert.equal(await (await readRecordingRecovery(scope))!.blob.text(),'original');
});

test('two tabs preparing before the first chunk atomically reserve one recording attempt',async()=>{
  const attempts=await Promise.allSettled([beginRecordingRecovery(scope,''),beginRecordingRecovery(scope,'')]);
  const owners=attempts.flatMap(result=>result.status==='fulfilled'?[result.value]:[]);
  assert.equal(owners.length,1);assert.equal(attempts.filter(result=>result.status==='rejected').length,1);
  const owner=owners[0];assert.notEqual(owner.key,recordingRecoveryKey(scope));assert.ok(owner.attemptId);
  await owner.append(new Blob(['A first'],{type:'audio/webm'}),250);
  await assert.rejects(beginRecordingRecovery(scope,''),/다른 탭/);
  await owner.append(new Blob([' A final']),750);const saved=await owner.finish({durationMs:750});
  assert.equal(saved.key,owner.key);assert.equal(await saved.blob.text(),'A first A final');assert.equal(saved.inUse,false);
});

test('active captures cannot be discarded by a second tab reading their checkpoint',async()=>{
  const owner=await beginRecordingRecovery(scope,'audio/webm');await owner.append(new Blob(['still recording']),250);
  const checkpoint=await readRecordingRecovery(scope);assert.equal(checkpoint?.inUse,true);
  await assert.rejects(removeRecordingRecovery(checkpoint!.key),/다른 탭/);
  await owner.append(new Blob([' final']),500);await owner.finish({durationMs:500});
  await removeRecordingRecovery(owner.key);assert.equal(await readRecordingRecovery(scope),null);
});

test('expired empty preparation can be replaced without accepting stale chunks or stale deletion',async()=>{
  const now=Date.now();Date.now=()=>now;const a=await beginRecordingRecovery(scope,'audio/webm');
  Date.now=()=>now+RECORDING_LEASE_MS+1;const b=await beginRecordingRecovery(scope,'audio/webm');
  assert.notEqual(a.attemptId,b.attemptId);assert.notEqual(a.key,b.key);
  assert.throws(()=>a.assertFresh(),/만료/);await assert.rejects(a.assertActive());
  await b.append(new Blob(['B first']),250);await assert.rejects(a.append(new Blob(['A final']),300));
  await a.cancel();await removeRecordingRecovery(a.key);
  const saved=await b.finish({durationMs:500});assert.equal(await saved.blob.text(),'B first');
  assert.equal(await (await readRecordingRecovery(scope))!.blob.text(),'B first');
});

test('late receipt and final callbacks only address their own attempt after a newer attempt starts',async()=>{
  const a=await beginRecordingRecovery(scope,'audio/webm');await a.append(new Blob(['A']),250);await a.finish({durationMs:250});
  await removeRecordingRecovery(a.key);
  const b=await beginRecordingRecovery(scope,'audio/webm');await b.append(new Blob(['B']),250);await b.finish({durationMs:250});
  await removeRecordingRecovery(a.key);await assert.rejects(a.append(new Blob([' A late']),500));
  assert.equal((await readRecordingRecovery(scope))?.key,b.key);assert.equal(await (await readRecordingRecovery(scope))!.blob.text(),'B');
});

test('unused preparation cancellation releases only its own reservation',async()=>{
  const a=await beginRecordingRecovery(scope,'audio/webm');await a.cancel();
  const b=await beginRecordingRecovery(scope,'audio/webm');await a.cancel();
  await assert.rejects(beginRecordingRecovery(scope,'audio/webm'),/다른 탭/);
  await b.append(new Blob(['kept']),250);await b.finish({durationMs:250});
  assert.equal(await (await readRecordingRecovery(scope))!.blob.text(),'kept');
});

test('legacy question-keyed recordings remain discoverable and block replacement',async()=>{
  const seed=await beginRecordingRecovery({...scope,itemIndex:9},'audio/webm');await seed.cancel();
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('gakja-private-recordings',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  const key=recordingRecoveryKey(scope),now=Date.now();
  await new Promise<void>((resolve,reject)=>{const tx=db.transaction(['pending','chunks'],'readwrite');tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);tx.objectStore('pending').put({...scope,key,mimeType:'audio/webm',chunkCount:1,analysisCount:0,durationMs:250,updatedAt:now,expiresAt:now+RECORDING_RECOVERY_TTL_MS,complete:false});tx.objectStore('chunks').put({id:JSON.stringify([key,'primary',0]),recordingKey:key,lane:'primary',position:0,blob:new Blob(['legacy original'])});});db.close();
  const saved=await readRecordingRecovery(scope);assert.equal(saved?.key,key);assert.equal(saved?.inUse,false);assert.equal(await saved!.blob.text(),'legacy original');
  await assert.rejects(beginRecordingRecovery(scope,''));await removeRecordingRecovery(saved!.key);
});

test('expired recovery is unavailable and purged instead of being revived by a later read',async()=>{
  const now=Date.now();Date.now=()=>now;
  const writer=await beginRecordingRecovery(scope,'audio/webm');await writer.append(new Blob(['expired']),100);
  Date.now=()=>now+RECORDING_RECOVERY_TTL_MS+1;assert.equal(await readRecordingRecovery(scope),null);
  Date.now=()=>now;assert.equal(await readRecordingRecovery(scope),null);
});

test('quota failure preserves the last durable checkpoint and rejects navigation flush',async()=>{
  const writer=await beginRecordingRecovery(scope,'audio/webm');await writer.append(new Blob(['safe']),250);
  IDBObjectStore.prototype.put=function(...args:Parameters<IDBObjectStore['put']>){if(this.name==='chunks')throw new DOMException('full','QuotaExceededError');return originalPut.apply(this,args);};
  await assert.rejects(writer.append(new Blob(['not durable']),500));await assert.rejects(writer.flush());
  IDBObjectStore.prototype.put=originalPut;
  const checkpoint=await readRecordingRecovery(scope);assert.equal(await checkpoint!.blob.text(),'safe');assert.equal(checkpoint?.durationMs,250);
});

test('explicit receipt/discard removal deletes metadata and all media parts',async()=>{
  const writer=await beginRecordingRecovery(scope,'audio/webm');await writer.append(new Blob(['private']),100);await writer.appendAnalysis(new Blob(['analysis']));await writer.finish({durationMs:100});
  await removeRecordingRecovery(writer.key);assert.equal(await readRecordingRecovery(scope),null);
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('gakja-private-recordings',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  const count=await new Promise<number>(resolve=>{const request=db.transaction('chunks').objectStore('chunks').count();request.onsuccess=()=>resolve(request.result);});db.close();assert.equal(count,0);
});

test('unavailable browser storage refuses to start an unprotected recording',async()=>{
  Object.assign(globalThis,{indexedDB:undefined});await assert.rejects(beginRecordingRecovery(scope,'audio/webm'),/글로 답/);
});

function navigationHarness(confirm=true){
  const win=new Map<string,EventListener>(),doc=new Map<string,EventListener>();
  let pending=true;const navigations:string[]=[],history:string[]=[];
  const location={href:'https://gakja.test/quiz/session/a'};
  class FakeElement{closest(){return{href:'https://gakja.test/my',target:'',hasAttribute:()=>false};}}
  Object.assign(globalThis,{Element:FakeElement,window:{location,confirm:()=>confirm,history:{state:{owned:'router'},pushState(_state:unknown,_title:string,url:string){history.push(url);location.href=url;}},addEventListener:(name:string,fn:EventListener)=>win.set(name,fn),removeEventListener:(name:string)=>win.delete(name)},document:{addEventListener:(name:string,fn:EventListener)=>doc.set(name,fn),removeEventListener:(name:string)=>doc.delete(name)}});
  return{win,doc,location,history,navigations,setPending:(value:boolean)=>{pending=value;},element:new FakeElement(),hasPending:()=>pending,navigate:(href:string)=>navigations.push(href)};
}
test('link navigation waits for final durable save and cancelled back remains on the original question',async()=>{
  const h=navigationHarness();let release!:()=>void;const saved=new Promise<void>(resolve=>{release=resolve;});
  const cleanup=installRecordingExitGuard({hasPending:h.hasPending,save:()=>saved,navigate:h.navigate});
  let prevented=false;h.doc.get('click')!({button:0,target:h.element,preventDefault(){prevented=true;},stopImmediatePropagation(){}} as unknown as Event);
  assert.equal(prevented,true);assert.deepEqual(h.navigations,[]);release();await saved;await Promise.resolve();assert.deepEqual(h.navigations,['https://gakja.test/my']);cleanup();assert.equal(h.win.size,0);assert.equal(h.doc.size,0);
  const back=navigationHarness(false);const cleanBack=installRecordingExitGuard({hasPending:back.hasPending,save:async()=>{},navigate:back.navigate});back.location.href='https://gakja.test/my';let held=false;back.win.get('popstate')!({stopImmediatePropagation(){held=true;}} as unknown as Event);assert.equal(held,true);assert.equal(back.location.href,'https://gakja.test/quiz/session/a');assert.deepEqual(back.navigations,[]);cleanBack();
});

test('reload prompts while unsent audio exists and pagehide checkpoints it',async()=>{
  const h=navigationHarness();let saves=0;const cleanup=installRecordingExitGuard({hasPending:h.hasPending,save:async()=>{saves++;},navigate:h.navigate});let prevented=false;
  h.win.get('beforeunload')!({preventDefault(){prevented=true;},returnValue:undefined} as unknown as Event);assert.equal(prevented,true);
  h.win.get('pagehide')!({} as Event);await Promise.resolve();assert.equal(saves,1);h.setPending(false);prevented=false;h.win.get('beforeunload')!({preventDefault(){prevented=true;}} as unknown as Event);assert.equal(prevented,false);cleanup();
});
