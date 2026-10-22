import {parseExperienceDraft,removeExperienceDraft,writeExperienceDraft} from '../armory-drafts';
import {clearAccountRecordingRecovery,listAccountRecordingRecovery} from './recording-recovery';
import {invalidateClientRequestCache} from './request-cache';
import {markDeviceStorageCleared,withDeviceCleanupLock} from './device-storage';

type Stores={local:Storage;session:Storage};
export type DeviceEntry={area:keyof Stores;key:string;value:string;kind:'draft'|'cache'};
export type DeviceCleanupOptions={drafts:boolean;recordings:boolean;cache:boolean};
type RecordRef={id:string;type:string;href?:string|null;sourceId?:string};
const draftFamilies=['gakja-on','gakja-first-question','gakja-draft','gakja-assignment','gakja-quiz','gakja-quiz-activity','gakja-interview','gakja-interview-submit','gakja-live-text','gakja-writing','gakja-briefing-thought','gakja-news-thought','gakja-knowledge','gakja-learning-help','gakja-device-trash'];
const cleanupKey=(userId:string)=>`gakja-device-cleanup-on-logout:${userId}`;
const trashKey=(userId:string,id:string)=>`gakja-device-trash:${userId}:${id}`;
const hasScope=(key:string,scope:string)=>key===scope||key.startsWith(scope+':');
function browserStores():Stores{return {local:window.localStorage,session:window.sessionStorage};}

/** Match exact account boundaries; never clear browser-wide storage or another account. */
export function deviceEntryKind(key:string,userId:string):DeviceEntry['kind']|null {
  if(!userId)return null;
  if(draftFamilies.some(family=>hasScope(key,`${family}:${userId}`))||hasScope(key,`armory-draft:${userId}`)||hasScope(key,`armory-drafts:v2:${userId}`)||hasScope(key,`armory-draft-backups:v1:${userId}`))return 'draft';
  if(['gakja-target','gakja-recording-skip-ready','gakja-recording-ready-seen'].some(family=>key===`${family}:${userId}`))return 'cache';
  return null;
}
export function collectDeviceEntries(userId:string,stores:Stores=browserStores()):DeviceEntry[]{
  const entries:DeviceEntry[]=[];
  for(const area of ['local','session'] as const){const storage=stores[area];for(let index=0;index<storage.length;index++){const key=storage.key(index);if(!key)continue;const kind=deviceEntryKind(key,userId),value=storage.getItem(key);if(kind&&value!==null)entries.push({area,key,value,kind});}}
  return entries;
}
export function isDeviceCleanupOnLogout(userId:string){try{return localStorage.getItem(cleanupKey(userId))==='true';}catch{return false;}}
export function setDeviceCleanupOnLogout(userId:string,value:boolean){if(value)localStorage.setItem(cleanupKey(userId),'true');else localStorage.removeItem(cleanupKey(userId));}
export async function deviceDataSummary(userId:string){
  const entries=collectDeviceEntries(userId);
  let recordings:number|null=null;try{recordings=(await listAccountRecordingRecovery(userId)).length;}catch{/* Browser audio storage may be disabled; don't report an inaccurate zero. */}
  return {drafts:entries.filter(entry=>entry.kind==='draft').length,cache:entries.filter(entry=>entry.kind==='cache').length,recordings};
}
export async function clearDeviceData(userId:string,options:DeviceCleanupOptions,stores:Stores=browserStores()){
  return withDeviceCleanupLock(userId,async()=>{
    const entries=collectDeviceEntries(userId,stores).filter(entry=>entry.kind==='draft'?options.drafts:options.cache);
    // Check recording leases before removing any text; an active capture must survive cleanup.
    const recordings=options.recordings?await clearAccountRecordingRecovery(userId):0;
    if(options.drafts||options.cache)markDeviceStorageCleared(userId);
    for(const entry of entries)stores[entry.area].removeItem(entry.key);
    invalidateClientRequestCache();
    return {entries:entries.length,recordings};
  });
}
async function blobBase64(blob:Blob){const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';for(let index=0;index<bytes.length;index+=32768)binary+=String.fromCharCode(...bytes.subarray(index,index+32768));return btoa(binary);}
async function* blobBase64Parts(blob:Blob){for(let offset=0;offset<blob.size;offset+=49152){const bytes=new Uint8Array(await blob.slice(offset,offset+49152).arrayBuffer());let binary='';for(let index=0;index<bytes.length;index+=16384)binary+=String.fromCharCode(...bytes.subarray(index,index+16384));yield btoa(binary);}}
/** Stream a JSON backup without holding every recording's base64 text in memory. */
export async function* deviceBackupParts(userId:string){
  const entries=collectDeviceEntries(userId),recordings=await listAccountRecordingRecovery(userId);
  if(recordings.some(recording=>recording.inUse))throw Error('다른 탭에서 녹음 중이에요. 녹음을 마친 뒤 기기 백업을 내려받아 주세요.');
  yield JSON.stringify({format:'gakjaon-device-backup',version:1,exportedAt:new Date().toISOString(),userId,entries}).slice(0,-1)+',"recordings":[';
  for(let index=0;index<recordings.length;index++){
    const {blob,analysisAudio,...recording}=recordings[index];
    yield (index?',':'')+JSON.stringify({...recording,mime:blob.type,encoding:'base64'}).slice(0,-1)+',"data":"';
    yield* blobBase64Parts(blob);yield '"';
    if(analysisAudio){yield ',"analysisAudio":'+JSON.stringify({mime:analysisAudio.type,encoding:'base64'}).slice(0,-1)+',"data":"';yield* blobBase64Parts(analysisAudio);yield '"}';}
    yield '}';
  }
  yield ']}';
}
export async function exportDeviceData(userId:string){
  const entries=collectDeviceEntries(userId),recordings=await listAccountRecordingRecovery(userId);
  if(recordings.some(recording=>recording.inUse))throw Error('다른 탭에서 녹음 중이에요. 녹음을 마친 뒤 기기 백업을 내려받아 주세요.');
  const files=await Promise.all(recordings.map(async({blob,analysisAudio,...recording})=>({...recording,mime:blob.type,encoding:'base64',data:await blobBase64(blob),...(analysisAudio?{analysisAudio:{mime:analysisAudio.type,encoding:'base64',data:await blobBase64(analysisAudio)}}:{})})));
  return {format:'gakjaon-device-backup',version:1,exportedAt:new Date().toISOString(),userId,entries,recordings:files};
}

function belongsToRecord(entry:DeviceEntry,userId:string,item:RecordRef){
  const id=item.sourceId||item.id,key=entry.key;
  if(item.type==='draft'||item.type==='experience'){
    if(key===`armory-drafts:v2:${userId}:${id}`)return true;
    if(key===`armory-draft:${userId}`||key.startsWith(`armory-draft-backups:v1:${userId}:`)){try{const parsed=JSON.parse(entry.value);return (parsed.record?.id||parsed.id||parsed.draftId)===id;}catch{return false;}}
  }
  if(item.type==='thread'&&key.startsWith(`gakja-on:${userId}:`)){try{return JSON.parse(key.slice(`gakja-on:${userId}:`.length))[0]===id;}catch{return false;}}
  if(item.type==='interview'&&['gakja-interview','gakja-interview-submit','gakja-live-text','gakja-writing'].some(family=>hasScope(key,`${family}:${userId}:${id}`)))return true;
  if(item.type==='quiz'&&['gakja-quiz','gakja-quiz-activity','gakja-writing'].some(family=>hasScope(key,`${family}:${userId}:${id}`)))return true;
  if(item.type==='assignment'&&hasScope(key,`gakja-assignment:${userId}:${id}`))return true;
  if(item.type==='answer'&&item.href){const questionId=item.href.split('?')[0].split('/').pop();if(questionId&&key===`gakja-draft:${userId}:${decodeURIComponent(questionId)}`)return true;}
  return false;
}
/** Keep unsynced local versions beside the durable trash receipt, so undo/restore can recover them. */
export function stashTrashedDeviceDrafts(userId:string,items:RecordRef[],receipts:RecordRef[],stores:Stores=browserStores()){
  const entries=collectDeviceEntries(userId,stores);
  for(const receipt of receipts){const item=items.find(item=>item.type===receipt.type&&item.id===(receipt.sourceId||receipt.id));if(!item)continue;const scoped=entries.filter(entry=>belongsToRecord(entry,userId,item));if(!scoped.length)continue;
    const key=trashKey(userId,receipt.id),snapshot=JSON.stringify(scoped);stores.local.setItem(key,snapshot);if(stores.local.getItem(key)!==snapshot)throw Error('이 기기의 초안 보관을 확인하지 못했어요.');
    for(const entry of scoped)stores[entry.area].removeItem(entry.key);
    if(item.type==='draft'||item.type==='experience')removeExperienceDraft(stores.local,userId,item.id);
  }
}
export function restoreTrashedDeviceDrafts(userId:string,receipts:RecordRef[],stores:Stores=browserStores()){
  let conflicts=0;
  for(const receipt of receipts){const key=trashKey(userId,receipt.id),raw=stores.local.getItem(key);if(!raw)continue;const entries=JSON.parse(raw) as DeviceEntry[];if(!Array.isArray(entries))throw Error('기기 보관본을 확인하지 못했어요.');let complete=true;
    for(const entry of entries){if(!entry||!['local','session'].includes(entry.area)||typeof entry.key!=='string'||typeof entry.value!=='string'||!deviceEntryKind(entry.key,userId))continue;const current=stores[entry.area].getItem(entry.key);if(current!==null&&current!==entry.value){conflicts++;complete=false;continue;}stores[entry.area].setItem(entry.key,entry.value);if(entry.key.startsWith(`armory-drafts:v2:${userId}:`)){const draft=parseExperienceDraft(JSON.parse(entry.value));if(draft)writeExperienceDraft(stores[entry.area],userId,draft);}}
    if(complete)stores.local.removeItem(key);
  }
  return conflicts;
}
export function removeTrashedDeviceDrafts(userId:string,receipts:RecordRef[],stores:Stores=browserStores()){for(const receipt of receipts)stores.local.removeItem(trashKey(userId,receipt.id));}
