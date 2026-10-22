import assert from 'node:assert/strict';
import {afterEach,beforeEach,test} from 'node:test';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {clearDeviceData,collectDeviceEntries,deviceBackupParts,deviceEntryKind,exportDeviceData,removeTrashedDeviceDrafts,restoreTrashedDeviceDrafts,stashTrashedDeviceDrafts} from '../apps/web/src/lib/client/device-data.ts';
import {beginRecordingRecovery,clearAccountRecordingRecovery,listAccountRecordingRecovery} from '../apps/web/src/lib/client/recording-recovery.ts';

class StorageFixture implements Storage {
  values=new Map<string,string>();
  get length(){return this.values.size;}
  key(index:number){return [...this.values.keys()][index]??null;}
  getItem(key:string){return this.values.get(key)??null;}
  setItem(key:string,value:string){this.values.set(key,value);}
  removeItem(key:string){this.values.delete(key);}
  clear(){throw Error('Browser-wide clear must never be used.');}
}
const originalWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
beforeEach(()=>{Object.assign(globalThis,{indexedDB:new IDBFactory(),IDBKeyRange});});
afterEach(()=>{if(originalWindow)Object.defineProperty(globalThis,'window',originalWindow);else Reflect.deleteProperty(globalThis,'window');});
const stores=()=>({local:new StorageFixture(),session:new StorageFixture()});

test('device cleanup recognizes explicit account boundaries and never touches authentication or other accounts',async()=>{
  const storage=stores();
  const own=['gakja-on:student-a:["chat"]','armory-drafts:v2:student-a:one','armory-draft-backups:v1:student-a:b','gakja-first-question:student-a:school','gakja-quiz:student-a:quiz:1','gakja-learning-help:student-a:scope'];
  const keep=['gakja-on:student-a-other:["chat"]','armory-drafts:v2:student-ab:one','sb-provider-auth-token','gakja-sidebar-collapsed','unrelated','gakja-device-cleanup-on-logout:student-a'];
  for(const key of [...own,...keep])storage.local.setItem(key,'original');
  storage.local.setItem('gakja-target:student-a','school');storage.session.setItem('gakja-draft:student-a:q','text');
  assert.equal(deviceEntryKind('gakja-on:student-a-other:key','student-a'),null);
  assert.equal(deviceEntryKind('gakja-on::key',''),null);
  assert.equal(collectDeviceEntries('student-a',storage).length,own.length+2);
  await clearDeviceData('student-a',{drafts:true,recordings:false,cache:false},storage);
  assert.deepEqual(keep.map(key=>storage.local.getItem(key)),keep.map(()=>'original'));
  assert.equal(storage.session.getItem('gakja-draft:student-a:q'),null);assert.equal(storage.local.getItem('gakja-target:student-a'),'school');
  await clearDeviceData('student-a',{drafts:false,recordings:false,cache:true},storage);assert.equal(storage.local.getItem('gakja-target:student-a'),null);
});

test('account recording cleanup is atomic while this account records and leaves another account intact',async()=>{
  const a=await beginRecordingRecovery({studentId:'student-a',sessionId:'live',itemIndex:0,kind:'quiz'},'audio/webm');await a.append(new Blob(['active']),100);
  const b=await beginRecordingRecovery({studentId:'student-b',sessionId:'other',itemIndex:0,kind:'quiz'},'audio/webm');await b.append(new Blob(['other']),100);await b.finish({durationMs:100});
  const storage=stores();storage.local.setItem('gakja-draft:student-a:q','unsent');
  await assert.rejects(clearDeviceData('student-a',{drafts:true,recordings:true,cache:true},storage),/다른 탭/);
  assert.equal(storage.local.getItem('gakja-draft:student-a:q'),'unsent');
  assert.equal((await listAccountRecordingRecovery('student-a')).length,1);
  await a.finish({durationMs:100});assert.equal(await clearAccountRecordingRecovery('student-a'),1);
  assert.equal((await listAccountRecordingRecovery('student-a')).length,0);
  assert.equal(await (await listAccountRecordingRecovery('student-b'))[0].blob.text(),'other');
});

test('local unsynced chat drafts move beside the trash receipt and restore without overwriting newer text',()=>{
  const storage=stores(),key='gakja-on:student-a:["thread-one","school"]',other='gakja-on:student-a:["thread-two","school"]';
  storage.local.setItem(key,'old unsent draft');storage.session.setItem(key,'old unsent draft');storage.local.setItem(other,'keep');
  const root={id:'thread-one',type:'thread'},receipt={id:'trash-one',sourceId:'thread-one',type:'thread'};
  stashTrashedDeviceDrafts('student-a',[root],[receipt],storage);
  assert.equal(storage.local.getItem(key),null);assert.equal(storage.session.getItem(key),null);assert.equal(storage.local.getItem(other),'keep');
  assert.match(storage.local.getItem('gakja-device-trash:student-a:trash-one')||'',/old unsent draft/);
  storage.local.setItem(key,'new draft written by another tab');assert.equal(restoreTrashedDeviceDrafts('student-a',[receipt],storage),1);
  assert.equal(storage.local.getItem(key),'new draft written by another tab');assert.equal(storage.session.getItem(key),'old unsent draft');
  assert.notEqual(storage.local.getItem('gakja-device-trash:student-a:trash-one'),null);
  storage.local.removeItem(key);assert.equal(restoreTrashedDeviceDrafts('student-a',[receipt],storage),0);assert.equal(storage.local.getItem(key),'old unsent draft');
  assert.equal(storage.local.getItem('gakja-device-trash:student-a:trash-one'),null);
});

test('permanent deletion removes only matching device trash sidecar',()=>{
  const storage=stores();storage.local.setItem('gakja-device-trash:student-a:one','backup');storage.local.setItem('gakja-device-trash:student-b:one','other');storage.local.setItem('gakja-device-trash:student-a:two','keep');
  removeTrashedDeviceDrafts('student-a',[{id:'one',type:'thread'}],storage);
  assert.equal(storage.local.getItem('gakja-device-trash:student-a:one'),null);assert.equal(storage.local.getItem('gakja-device-trash:student-b:one'),'other');assert.equal(storage.local.getItem('gakja-device-trash:student-a:two'),'keep');
});

test('device backup contains actual original bytes and only the selected account drafts and media',async()=>{
  const storage=stores();storage.local.setItem('gakja-draft:student-a:q','private draft');storage.local.setItem('gakja-draft:student-b:q','other account');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{localStorage:storage.local,sessionStorage:storage.session}});
  const own=await beginRecordingRecovery({studentId:'student-a',sessionId:'interview',itemIndex:0,kind:'interview'},'video/webm');await own.append(new Blob(['video-original'],{type:'video/webm'}),100);await own.appendAnalysis(new Blob(['audio-original'],{type:'audio/webm'}));await own.finish({durationMs:100});
  const other=await beginRecordingRecovery({studentId:'student-b',sessionId:'interview',itemIndex:0,kind:'interview'},'audio/webm');await other.append(new Blob(['secret other']),100);await other.finish({durationMs:100});
  const backup=await exportDeviceData('student-a');assert.equal(backup.entries.length,1);assert.equal(backup.entries[0].value,'private draft');assert.equal(backup.recordings.length,1);
  assert.equal(atob(backup.recordings[0].data),'video-original');assert.equal(atob(backup.recordings[0].analysisAudio!.data),'audio-original');assert.equal(backup.recordings[0].mime,'video/webm');
});

test('streaming device backup preserves base64 across chunk boundaries and refuses an active recording',async()=>{
  const storage=stores();Object.defineProperty(globalThis,'window',{configurable:true,value:{localStorage:storage.local,sessionStorage:storage.session}});
  const original=new Uint8Array(147459);for(let index=0;index<original.length;index++)original[index]=index%251;
  const own=await beginRecordingRecovery({studentId:'student-a',sessionId:'large',itemIndex:0,kind:'quiz'},'audio/webm');await own.append(new Blob([original]),100);
  await assert.rejects(async()=>{for await(const part of deviceBackupParts('student-a'))void part;},/녹음 중/);
  await own.finish({durationMs:100});const parts:string[]=[];for await(const part of deviceBackupParts('student-a'))parts.push(part);
  assert.ok(parts.length>4);assert.ok(parts.every(part=>part.length<70000));
  const parsed=JSON.parse(parts.join(''));assert.deepEqual(Buffer.from(parsed.recordings[0].data,'base64'),Buffer.from(original));
});
