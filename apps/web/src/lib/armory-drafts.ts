import {setDeviceItem} from './client/device-storage';
import {experienceDraftSchema,type Experience,type ExperienceCard} from './armory-model';

export type ExperienceDraft={id:string;draft:Experience;revision:number;step:number;updatedAt:string;serverRevision:number};
type DraftStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>&Partial<Pick<Storage,'length'|'key'>>;
const indexKey=(studentId:string)=>'armory-drafts:v2:'+studentId;
export const experienceDraftKey=(studentId:string,id:string)=>indexKey(studentId)+':'+id;
function ids(storage:DraftStorage,studentId:string):string[]{
 let indexed:string[]=[];try{const value=JSON.parse(storage.getItem(indexKey(studentId))||'[]');if(Array.isArray(value))indexed=value.filter(id=>typeof id==='string');}catch{}
 // The per-card values remain discoverable even when two tabs update the index together.
 const prefix=indexKey(studentId)+':';if(storage.key)for(let i=0;i<(storage.length||0);i++){const key=storage.key(i);if(key?.startsWith(prefix))indexed.push(key.slice(prefix.length));}
 return [...new Set(indexed)];
}
export function parseExperienceDraft(value:unknown):ExperienceDraft|null{
 if(!value||typeof value!=='object')return null;
 const record=value as Partial<ExperienceDraft>&{draftId?:string},draft=experienceDraftSchema.safeParse(record.draft),id=record.id||record.draftId;
 if(!id||!draft.success||!Number.isInteger(record.revision)||Number(record.revision)<0)return null;
 return {id,draft:{...draft.data,confirmed:false},revision:Number(record.revision),step:Math.min(3,Math.max(0,Number(record.step)||0)),updatedAt:record.updatedAt||new Date().toISOString(),serverRevision:Math.max(0,Number(record.serverRevision)||0)};
}
export function writeExperienceDraft(storage:DraftStorage,studentId:string,record:ExperienceDraft){
 setDeviceItem(storage,experienceDraftKey(studentId,record.id),JSON.stringify(record));
 setDeviceItem(storage,indexKey(studentId),JSON.stringify([...new Set([...ids(storage,studentId),record.id])]));
}
export function readExperienceDrafts(storage:DraftStorage,studentId:string):ExperienceDraft[]{
 return ids(storage,studentId).flatMap(id=>{try{const draft=parseExperienceDraft(JSON.parse(storage.getItem(experienceDraftKey(studentId,id))||'null'));return draft?[draft]:[];}catch{return [];}}).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
}
export function removeExperienceDraft(storage:DraftStorage,studentId:string,id:string){storage.removeItem(experienceDraftKey(studentId,id));setDeviceItem(storage,indexKey(studentId),JSON.stringify(ids(storage,studentId).filter(item=>item!==id)));}
/** Delete the old session key only after a durable per-card copy has been written. */
export function migrateExperienceDraft(storage:DraftStorage,legacy:DraftStorage,studentId:string){
 const key='armory-draft:'+studentId,raw=legacy.getItem(key);if(!raw)return;
 let parsed:unknown;try{parsed=JSON.parse(raw);}catch{return;}const record=parseExperienceDraft(parsed);if(!record)return;
 if(!storage.getItem(experienceDraftKey(studentId,record.id)))writeExperienceDraft(storage,studentId,record);
 legacy.removeItem(key);
}
export const experienceDraftContent=(record:ExperienceDraft)=>JSON.stringify([record.id,record.revision,record.draft,record.step]);
export type ExperienceDraftBackup={id:string;label:string;record:ExperienceDraft};
const backupsKey=(studentId:string)=>'armory-draft-backups:v1:'+studentId;
/** Write every original before a user replaces the editable draft. Never reuse a backup key. */
export function preserveExperienceDraftVersions(storage:DraftStorage,studentId:string,records:ExperienceDraftBackup[]){
 const previous=readExperienceDraftBackups(storage,studentId);
 for(const item of records)setDeviceItem(storage,backupsKey(studentId)+':'+item.id,JSON.stringify(item));
 setDeviceItem(storage,backupsKey(studentId),JSON.stringify([...new Set([...previous.map(item=>item.id),...records.map(item=>item.id)])]));
}
export function readExperienceDraftBackups(storage:DraftStorage,studentId:string):ExperienceDraftBackup[]{
 const prefix=backupsKey(studentId)+':';let keys:string[]=[];try{const value=JSON.parse(storage.getItem(backupsKey(studentId))||'[]');if(Array.isArray(value))keys=value.filter(id=>typeof id==='string');}catch{}
 if(storage.key)for(let i=0;i<(storage.length||0);i++){const key=storage.key(i);if(key?.startsWith(prefix))keys.push(key.slice(prefix.length));}
 return [...new Set(keys)].flatMap(id=>{try{const item=JSON.parse(storage.getItem(prefix+id)||'null'),record=parseExperienceDraft(item?.record);return record?[{id,label:String(item.label||'보관한 버전'),record}]:[];}catch{return [];}}).reverse();
}
export function draftMatchesSource(record:ExperienceDraft,card?:ExperienceCard|null){return card?record.revision===card.revision:record.revision===0;}
export function chooseExperienceDraftVersion(local:ExperienceDraft,remote:ExperienceDraft|null,card:ExperienceCard|null,choice:'local'|'remote'|'card'|'copy',copyId?:string):ExperienceDraft{
 const record=choice==='remote'?remote:choice==='card'&&card?{...local,draft:{...card.data,confirmed:false},revision:card.revision,step:0}:local;
 if(!record)throw Error('선택한 버전을 찾을 수 없어요. 최신 버전을 다시 불러와 주세요.');
 if(choice==='copy'){if(!copyId)throw Error('새 경험 번호가 필요해요.');return {...record,id:copyId,revision:0,serverRevision:0,updatedAt:new Date().toISOString()};}
 if(!draftMatchesSource(record,card))throw Error('저장된 경험의 버전이 달라요. 새 경험으로 보관하거나 최신 경험을 선택해 주세요.');
 return {...record,draft:{...record.draft,confirmed:false},serverRevision:remote?.serverRevision||0,updatedAt:new Date().toISOString()};
}
/** One queue per card prevents an old autosave response overtaking a newer edit. */
export function createExperienceDraftSync(put:(record:ExperienceDraft)=>Promise<ExperienceDraft>){
 const queues=new Map<string,Promise<ExperienceDraft>>(),versions=new Map<string,number>(),generations=new Map<string,number>();
 return {sync(record:ExperienceDraft){
  const previous=queues.get(record.id),generation=generations.get(record.id)||0,assertCurrent=()=>{if((generations.get(record.id)||0)!==generation)throw Object.assign(Error('이전 초안 저장을 중지했어요.'),{name:'DraftSyncCancelled'});},run=async()=>{assertCurrent();const result=await put({...record,serverRevision:versions.get(record.id)??record.serverRevision});assertCurrent();versions.set(record.id,result.serverRevision);return {...record,serverRevision:result.serverRevision};};
  const task=(previous?previous.catch(()=>undefined).then(run):run());queues.set(record.id,task);return task;
 },forget(id:string){generations.set(id,(generations.get(id)||0)+1);queues.delete(id);versions.delete(id);}};
}
