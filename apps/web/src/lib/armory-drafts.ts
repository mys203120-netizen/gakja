import {experienceSchema,type Experience} from './armory-model';

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
 const record=value as Partial<ExperienceDraft>&{draftId?:string},draft=experienceSchema.safeParse(record.draft),id=record.id||record.draftId;
 if(!id||!draft.success||!Number.isInteger(record.revision)||Number(record.revision)<0)return null;
 return {id,draft:{...draft.data,confirmed:false},revision:Number(record.revision),step:Math.min(3,Math.max(0,Number(record.step)||0)),updatedAt:record.updatedAt||new Date().toISOString(),serverRevision:Math.max(0,Number(record.serverRevision)||0)};
}
export function writeExperienceDraft(storage:DraftStorage,studentId:string,record:ExperienceDraft){
 storage.setItem(experienceDraftKey(studentId,record.id),JSON.stringify(record));
 storage.setItem(indexKey(studentId),JSON.stringify([...new Set([...ids(storage,studentId),record.id])]));
}
export function readExperienceDrafts(storage:DraftStorage,studentId:string):ExperienceDraft[]{
 return ids(storage,studentId).flatMap(id=>{try{const draft=parseExperienceDraft(JSON.parse(storage.getItem(experienceDraftKey(studentId,id))||'null'));return draft?[draft]:[];}catch{return [];}}).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
}
export function removeExperienceDraft(storage:DraftStorage,studentId:string,id:string){storage.removeItem(experienceDraftKey(studentId,id));storage.setItem(indexKey(studentId),JSON.stringify(ids(storage,studentId).filter(item=>item!==id)));}
/** Delete the old session key only after a durable per-card copy has been written. */
export function migrateExperienceDraft(storage:DraftStorage,legacy:DraftStorage,studentId:string){
 const key='armory-draft:'+studentId,raw=legacy.getItem(key);if(!raw)return;
 let parsed:unknown;try{parsed=JSON.parse(raw);}catch{return;}const record=parseExperienceDraft(parsed);if(!record)return;
 if(!storage.getItem(experienceDraftKey(studentId,record.id)))writeExperienceDraft(storage,studentId,record);
 legacy.removeItem(key);
}
export const experienceDraftContent=(record:ExperienceDraft)=>JSON.stringify([record.id,record.revision,record.draft,record.step]);
/** One queue per card prevents an old autosave response overtaking a newer edit. */
export function createExperienceDraftSync(put:(record:ExperienceDraft)=>Promise<ExperienceDraft>){
 const queues=new Map<string,Promise<ExperienceDraft>>(),versions=new Map<string,number>();
 return {sync(record:ExperienceDraft){
  const previous=queues.get(record.id),run=async()=>{const result=await put({...record,serverRevision:versions.get(record.id)??record.serverRevision});versions.set(record.id,result.serverRevision);return {...record,serverRevision:result.serverRevision};};
  const task=(previous?previous.catch(()=>undefined).then(run):run());queues.set(record.id,task);return task;
 },forget(id:string){queues.delete(id);versions.delete(id);}};
}
