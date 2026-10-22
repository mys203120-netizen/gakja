/** Every authenticated document holds a shared browser lock. Device cleanup needs
 * exclusive access, so suspended/other tabs cannot race an old draft back to disk. */
type LockManagerLike=Pick<LockManager,'request'>;
type Scope={userId:string;generation:string|null;closed:boolean;release?:()=>void;finished?:Promise<void>;ready:Promise<void>;locks:LockManagerLike|null};
const scopes=new Map<string,Scope>();
const families=['armory-drafts:v2','armory-draft-backups:v1','armory-draft','gakja-on','gakja-first-question','gakja-draft','gakja-assignment','gakja-quiz','gakja-quiz-activity','gakja-interview','gakja-interview-submit','gakja-live-text','gakja-writing','gakja-briefing-thought','gakja-news-thought','gakja-knowledge','gakja-learning-help','gakja-device-trash','gakja-target','gakja-recording-skip-ready','gakja-recording-ready-seen'];
const generationKey=(userId:string)=>`gakja-device-generation:${userId}`;
const lockName=(userId:string)=>`gakja:private-device-data:${userId}`;
const generation=(userId:string)=>{try{return window.localStorage.getItem(generationKey(userId))||'initial';}catch{return null;}};
export function deviceStorageOwner(key:string){for(const family of families){const prefix=family+':';if(key.startsWith(prefix))return key.slice(prefix.length).split(':')[0]||null;}return null;}
export class DeviceDataClearedError extends Error{constructor(){super('이 기기의 자료가 정리됐어요. 새로고침한 뒤 이어서 작성해 주세요.');this.name='DeviceDataClearedError';}}
export function setDeviceItem(storage:Pick<Storage,'setItem'>,key:string,value:string){
  const owner=deviceStorageOwner(key),scope=owner?scopes.get(owner):null;
  if(scope&&typeof window!=='undefined'&&scope.generation!==null){const current=generation(scope.userId);if(current!==null&&scope.generation!==current)throw new DeviceDataClearedError();}
  storage.setItem(key,value);
}
async function shared(scope:Scope,initial:boolean){
  if(!scope.locks){if(initial)scope.generation=generation(scope.userId);return;}
  let granted!:()=>void;const ready=new Promise<void>(resolve=>{granted=resolve;});
  scope.finished=Promise.resolve(scope.locks.request(lockName(scope.userId),{mode:'shared'},async()=>{
    if(scope.closed){granted();return;}
    if(initial)scope.generation=generation(scope.userId);
    const held=new Promise<void>(resolve=>{scope.release=resolve;});granted();await held;
  })).then(()=>{});
  // A rejected lock request must reject readiness, instead of leaving the shell loading.
  await Promise.race([ready,scope.finished]);
}
export function openDeviceDocumentScope(userId:string,locks:LockManagerLike|null=typeof navigator!=='undefined'?navigator.locks||null:null){
  const previous=scopes.get(userId);previous?.release?.();if(previous)previous.closed=true;
  const scope:Scope={userId,generation:'initial',closed:false,ready:Promise.resolve(),locks};scopes.set(userId,scope);
  scope.ready=shared(scope,true).catch(()=>{scope.locks=null;scope.generation=generation(userId);});
  return {ready:scope.ready,close(){scope.closed=true;scope.release?.();}};
}
export async function withDeviceCleanupLock<T>(userId:string,work:()=>Promise<T>):Promise<T>{
  // Pure-storage/IndexedDB regression tests do not create an authenticated document.
  if(typeof window==='undefined')return work();
  const scope=scopes.get(userId);
  if(!scope||!scope.locks||generation(userId)===null)throw Error('이 브라우저에서는 안전한 기기 정리를 지원하지 않아요. 브라우저 저장 공간을 허용한 뒤 새로고침해 주세요.');
  await scope.ready;scope.release?.();await scope.finished;
  try{return await scope.locks.request(lockName(userId),{mode:'exclusive',ifAvailable:true},async lock=>{
    if(!lock)throw Error('다른 탭에서 각자ON이 열려 있어요. 다른 탭을 닫은 뒤 이 기기를 정리해 주세요.');
    return work();
  });}finally{if(!scope.closed)await shared(scope,false);}
}
/** The current document stays on its old generation until reload, including all
 * queued autosaves/pagehide callbacks after a cleanup-on-logout operation. */
export function markDeviceStorageCleared(userId:string){if(typeof window!=='undefined')window.localStorage.setItem(generationKey(userId),crypto.randomUUID());}
