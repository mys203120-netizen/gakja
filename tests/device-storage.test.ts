import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import {assertDeviceDocumentCurrent,DeviceDataClearedError,markDeviceStorageCleared,openDeviceDocumentScope,setDeviceItem,withDeviceCleanupLock} from '../apps/web/src/lib/client/device-storage.ts';

const originalWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
afterEach(()=>{if(originalWindow)Object.defineProperty(globalThis,'window',originalWindow);else Reflect.deleteProperty(globalThis,'window');});
function fixture(){const values=new Map<string,string>();const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)};Object.defineProperty(globalThis,'window',{configurable:true,value:{localStorage:storage}});return {storage,values};}
class BrowserLocks {
  held:{name:string;mode:string}[]=[];
  waiting:(()=>void)[]=[];
  request(name:string,options:any,callback:any):Promise<any>{
    return new Promise((resolve,reject)=>{
      const run=()=>{const blocked=this.held.some(lock=>lock.name===name&&(options.mode==='exclusive'||lock.mode==='exclusive'));if(blocked){if(options.ifAvailable){Promise.resolve(callback(null)).then(resolve,reject);return;}this.waiting.push(run);return;}
        const lock={name,mode:options.mode||'exclusive'};this.held.push(lock);const release=()=>{this.held=this.held.filter(item=>item!==lock);for(const retry of this.waiting.splice(0))retry();};Promise.resolve().then(()=>callback(lock)).then(value=>{release();resolve(value);},error=>{release();reject(error);});
      };run();
    });
  }
}
test('another open authenticated document blocks cleanup without deleting text; close releases the native lock',async()=>{
  const {storage}=fixture(),locks=new BrowserLocks(),scope=openDeviceDocumentScope('lock-test',locks as any);await scope.ready;
  storage.setItem('gakja-draft:lock-test:q','unsent');let closeOther!:()=>void;
  const other=locks.request('gakja:private-device-data:lock-test',{mode:'shared'},()=>new Promise<void>(resolve=>{closeOther=resolve;}));await new Promise(resolve=>setImmediate(resolve));
  let cleared=false;await assert.rejects(withDeviceCleanupLock('lock-test',async()=>{cleared=true;}),/다른 탭/);assert.equal(cleared,false);assert.equal(storage.getItem('gakja-draft:lock-test:q'),'unsent');
  closeOther();await other;await withDeviceCleanupLock('lock-test',async()=>{cleared=true;});assert.equal(cleared,true);scope.close();
});
test('cleanup generation refuses stale autosave and pagehide writes until a new document is mounted',async()=>{
  const {storage}=fixture(),locks=new BrowserLocks(),scope=openDeviceDocumentScope('generation-test',locks as any);await scope.ready;
  setDeviceItem(storage,'gakja-draft:generation-test:q','before');
  assert.doesNotThrow(()=>assertDeviceDocumentCurrent('generation-test'));
  await withDeviceCleanupLock('generation-test',async()=>markDeviceStorageCleared('generation-test'));
  assert.throws(()=>setDeviceItem(storage,'gakja-draft:generation-test:q','old pagehide draft'),DeviceDataClearedError);
  assert.throws(()=>assertDeviceDocumentCurrent('generation-test'),DeviceDataClearedError);
  assert.equal(storage.getItem('gakja-draft:generation-test:q'),'before');
  setDeviceItem(storage,'gakja-draft:other-user:q','other unchanged scope');
  scope.close();const reloaded=openDeviceDocumentScope('generation-test',locks as any);await reloaded.ready;setDeviceItem(storage,'gakja-draft:generation-test:q','fresh document');assert.equal(storage.getItem('gakja-draft:generation-test:q'),'fresh document');reloaded.close();
});
test('blocked browser storage or lock access never blocks normal app readiness, but cleanup stays unavailable',async()=>{
  Object.defineProperty(globalThis,'window',{configurable:true,value:{get localStorage(){throw new DOMException('Blocked','SecurityError');}}});
  const blocked=openDeviceDocumentScope('blocked-storage',new BrowserLocks() as any);await blocked.ready;await assert.rejects(withDeviceCleanupLock('blocked-storage',async()=>{}),/브라우저 저장 공간/);blocked.close();
  fixture();const denied=openDeviceDocumentScope('blocked-lock',{request:()=>Promise.reject(new DOMException('Blocked','SecurityError'))} as any);await denied.ready;await assert.rejects(withDeviceCleanupLock('blocked-lock',async()=>{}),/브라우저 저장 공간/);denied.close();
  const unsupported=openDeviceDocumentScope('unsupported',null);await unsupported.ready;await assert.rejects(withDeviceCleanupLock('unsupported',async()=>{}),/브라우저 저장 공간/);unsupported.close();
});
