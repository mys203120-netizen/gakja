/** Private, device-local recording recovery. No audio leaves the browser here. */
export type RecordingRecoveryScope = {studentId:string;sessionId:string;itemIndex:number;kind:'quiz'|'interview'};
type Measurement = {durationMs:number;telemetry?:Record<string,unknown>;analysisAudio?:Blob;needsMeasurement?:boolean};
type StoredRecording = RecordingRecoveryScope & {key:string;attemptId?:string;leaseUntil?:number;mimeType:string;chunkCount:number;analysisCount:number;durationMs:number;telemetry?:Record<string,unknown>;needsMeasurement?:boolean;updatedAt:number;expiresAt:number;complete:boolean};
type StoredChunk={id:string;recordingKey:string;lane:'primary'|'analysis';position:number;blob:Blob};
export type RecoveredRecording = RecordingRecoveryScope & {key:string;attemptId?:string;inUse:boolean;blob:Blob;analysisAudio?:Blob;durationMs:number;telemetry?:Record<string,unknown>;needsMeasurement?:boolean;updatedAt:number;expiresAt:number;complete:boolean};
export const RECORDING_RECOVERY_TTL_MS = 7*24*60*60*1000;
export const RECORDING_LEASE_MS = 30_000;
const DB='gakja-private-recordings',STORE='pending',PARTS='chunks';
/** Without an attempt ID this is only a scope/legacy key. Never delete by scope. */
export const recordingRecoveryKey=(scope:RecordingRecoveryScope,attemptId?:string)=>JSON.stringify([scope.studentId,scope.kind,scope.sessionId,scope.itemIndex,...(attemptId?[attemptId]:[])]);
const unavailable=()=>new Error('이 기기에 녹음을 임시 보관할 수 없어요. 브라우저 저장 공간을 허용하거나 글로 답해 주세요.');
const locked=()=>new Error('다른 탭에서 이 질문의 녹음을 준비하거나 진행 중이에요. 그 탭에서 녹음을 마치거나 준비를 취소한 뒤 다시 시도해 주세요.');
const hasParts=(row:StoredRecording)=>row.chunkCount>0||row.analysisCount>0;
const inUse=(row:StoredRecording)=>!row.complete&&(row.leaseUntil||0)>Date.now();
const matches=(row:StoredRecording,scope:RecordingRecoveryScope)=>row.studentId===scope.studentId&&row.kind===scope.kind&&row.sessionId===scope.sessionId&&row.itemIndex===scope.itemIndex;
function database():Promise<IDBDatabase> {
  if(typeof indexedDB==='undefined')return Promise.reject(unavailable());
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB,1);
    request.onupgradeneeded=()=>{
      if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE,{keyPath:'key'});
      if(!request.result.objectStoreNames.contains(PARTS)){const parts=request.result.createObjectStore(PARTS,{keyPath:'id'});parts.createIndex('recordingKey','recordingKey');}
    };
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(unavailable());request.onblocked=()=>reject(unavailable());
  });
}
async function operation<T>(mode:IDBTransactionMode,work:(store:IDBObjectStore,done:(value:T)=>void,parts:IDBObjectStore,fail:(error:Error)=>void)=>void):Promise<T> {
  const db=await database();
  return new Promise<T>((resolve,reject)=>{
    const tx=db.transaction([STORE,PARTS],mode);let value:T,failure:Error|undefined;
    tx.oncomplete=()=>{db.close();resolve(value);};tx.onerror=tx.onabort=()=>{db.close();reject(failure||unavailable());};
    try{work(tx.objectStore(STORE),result=>{value=result;},tx.objectStore(PARTS),error=>{failure=error;tx.abort();});}catch(error){tx.abort();db.close();reject(error);}
  });
}
function deleteParts(parts:IDBObjectStore,key:string){const request=parts.index('recordingKey').openKeyCursor(IDBKeyRange.only(key));request.onsuccess=()=>{const cursor=request.result;if(cursor){parts.delete(cursor.primaryKey);cursor.continue();}};}
function hydrate(row:StoredRecording,parts:StoredChunk[]):RecoveredRecording {
  const {chunkCount,analysisCount,mimeType,leaseUntil,...rest}=row;
  const primary=parts.filter(part=>part.lane==='primary').sort((a,b)=>a.position-b.position).map(part=>part.blob);
  const audio=parts.filter(part=>part.lane==='analysis').sort((a,b)=>a.position-b.position).map(part=>part.blob);
  return {...rest,inUse:inUse(row),blob:new Blob(primary.length?primary:audio,{type:primary.length?mimeType||primary[0]?.type||'audio/webm':audio[0]?.type||'audio/webm'}),...(audio.length&&primary.length?{analysisAudio:new Blob(audio,{type:audio[0].type||'audio/webm'})}:{})};
}
function readParts(parts:IDBObjectStore,row:StoredRecording,done:(result:RecoveredRecording)=>void){const request=parts.index('recordingKey').getAll(IDBKeyRange.only(row.key));request.onsuccess=()=>done(hydrate(row,request.result));}
export async function removeRecordingRecovery(key:string):Promise<void> {await operation<void>('readwrite',(store,done,parts,fail)=>{const request=store.get(key);request.onsuccess=()=>{if(request.result&&inUse(request.result)){fail(locked());return;}store.delete(key);deleteParts(parts,key);done();};});}
/** Account data management reads a consistent snapshot, including unfinished private recordings. */
export async function listAccountRecordingRecovery(studentId:string):Promise<RecoveredRecording[]> {
  if(!studentId)throw unavailable();
  return operation<RecoveredRecording[]>('readonly',(store,done,parts)=>{const request=store.getAll();request.onsuccess=()=>{
    const selected=(request.result as StoredRecording[]).filter(row=>row.studentId===studentId&&hasParts(row));
    if(!selected.length){done([]);return;}const result:RecoveredRecording[]=[];for(const row of selected)readParts(parts,row,value=>{result.push(value);if(result.length===selected.length)done(result.sort((a,b)=>b.updatedAt-a.updatedAt));});
  };});
}
/** All-or-nothing for this account; another tab's live capture blocks cleanup. */
export async function clearAccountRecordingRecovery(studentId:string):Promise<number> {
  if(!studentId)throw unavailable();
  return operation<number>('readwrite',(store,done,parts,fail)=>{const request=store.getAll();request.onsuccess=()=>{
    const selected=(request.result as StoredRecording[]).filter(row=>row.studentId===studentId);
    if(selected.some(inUse)){fail(locked());return;}
    for(const row of selected){store.delete(row.key);deleteParts(parts,row.key);}done(selected.filter(hasParts).length);
  };});
}
export async function listRecordingRecovery(scope:Pick<RecordingRecoveryScope,'studentId'|'sessionId'|'kind'>):Promise<RecoveredRecording[]> {
  return operation<RecoveredRecording[]>('readwrite',(store,done,parts)=>{
    const request=store.getAll();request.onsuccess=()=>{
      const rows:StoredRecording[]=request.result,now=Date.now();
      for(const row of rows)if(row.expiresAt<=now){store.delete(row.key);deleteParts(parts,row.key);}
      const selected=rows.filter(row=>row.expiresAt>now&&row.studentId===scope.studentId&&row.sessionId===scope.sessionId&&row.kind===scope.kind&&hasParts(row));
      if(!selected.length){done([]);return;}const result:RecoveredRecording[]=[];
      for(const row of selected)readParts(parts,row,value=>{result.push(value);if(result.length===selected.length)done(result.sort((a,b)=>b.updatedAt-a.updatedAt));});
    };
  });
}
export async function readRecordingRecovery(scope:RecordingRecoveryScope):Promise<RecoveredRecording|null> {
  return (await listRecordingRecovery(scope)).find(row=>row.itemIndex===scope.itemIndex)||null;
}
/** Start before opening the recorder. Each chunk has its own row: no growing Blob rewrite. */
export async function beginRecordingRecovery(scope:RecordingRecoveryScope,mimeType:string) {
  const now=Date.now(),attemptId=crypto.randomUUID(),key=recordingRecoveryKey(scope,attemptId);
  let row:StoredRecording={...scope,key,attemptId,leaseUntil:now+RECORDING_LEASE_MS,mimeType,chunkCount:0,analysisCount:0,durationMs:0,updatedAt:now,expiresAt:now+RECORDING_RECOVERY_TTL_MS,complete:false};
  // The reservation and conflict check share one readwrite transaction across tabs,
  // including the preparation window before either recorder has emitted data.
  await operation<void>('readwrite',(store,done,parts,fail)=>{const request=store.getAll();request.onsuccess=()=>{
    const previous=(request.result as StoredRecording[]).filter(prior=>matches(prior,scope));
    if(previous.some(prior=>prior.expiresAt>Date.now()&&(hasParts(prior)||inUse(prior)))){fail(locked());return;}
    for(const prior of previous){store.delete(prior.key);deleteParts(parts,prior.key);}store.put(row);done();
  };});
  let queue=Promise.resolve(),closed=false;
  const write=(update:(parts:IDBObjectStore)=>void)=>{queue=queue.then(()=>operation<void>('readwrite',(store,done,parts,fail)=>{
    const request=store.get(key);request.onsuccess=()=>{
      // A stale callback can never recreate an acknowledged/cancelled attempt.
      if(closed||!request.result||request.result.attemptId!==attemptId){fail(new Error('이 녹음 시도는 종료됐어요. 현재 녹음 원본을 내려받아 주세요.'));return;}
      try{update(parts);row={...row,leaseUntil:row.complete?0:Date.now()+RECORDING_LEASE_MS,updatedAt:Date.now(),expiresAt:Date.now()+RECORDING_RECOVERY_TTL_MS};store.put(row);done();}catch(error){fail(error instanceof Error?error:unavailable());}
    };
  }));return queue;};
  const heartbeat=setInterval(()=>{if(!closed)void write(()=>{}).catch(()=>{clearInterval(heartbeat);});},RECORDING_LEASE_MS/3);
  // Node regression tests must not be kept alive by an abandoned synthetic tab.
  (heartbeat as unknown as {unref?:()=>void}).unref?.();
  const close=()=>{closed=true;clearInterval(heartbeat);};
  const add=(parts:IDBObjectStore,blob:Blob,lane:StoredChunk['lane'])=>{const position=lane==='primary'?row.chunkCount++:row.analysisCount++;parts.put({id:JSON.stringify([key,lane,position]),recordingKey:key,lane,position,blob} satisfies StoredChunk);if(lane==='primary'&&!row.mimeType)row.mimeType=blob.type;};
  return {
    key,attemptId,
    /** Revalidate after a permission dialog/countdown, before opening a recorder. */
    async assertActive(){await write(()=>{});},
    assertFresh(){if(closed||(row.leaseUntil||0)<=Date.now())throw new Error('녹음 준비 시간이 만료됐어요. 다시 시작해 마이크와 임시 저장을 확인해 주세요.');},
    append(blob:Blob,durationMs?:number){if(!blob.size)return queue;return write(parts=>{add(parts,blob,'primary');if(typeof durationMs==='number'&&Number.isFinite(durationMs)&&durationMs>0)row.durationMs=Math.round(durationMs);});},
    appendAnalysis(blob:Blob){if(!blob.size)return queue;return write(parts=>add(parts,blob,'analysis'));},
    async finish(measurement:Measurement):Promise<RecoveredRecording>{try{await write(parts=>{row.durationMs=Math.max(1,Math.round(measurement.durationMs));row.telemetry=measurement.telemetry;row.needsMeasurement=measurement.needsMeasurement===true||undefined;row.complete=true;if(measurement.analysisAudio&&!row.analysisCount)add(parts,measurement.analysisAudio,'analysis');});return await operation<RecoveredRecording>('readonly',(store,done,parts,fail)=>{const request=store.get(key);request.onsuccess=()=>{if(!request.result||!hasParts(request.result)){fail(unavailable());return;}readParts(parts,request.result,done);};});}finally{close();await operation<void>('readwrite',(store,done)=>{const request=store.get(key);request.onsuccess=()=>{const saved=request.result as StoredRecording|undefined;if(saved?.attemptId===attemptId)store.put({...saved,leaseUntil:0});done();};}).catch(()=>{});}},
    /** Only unused reservations can be cancelled; recorded data needs explicit discard. */
    async cancel(){await queue.catch(()=>{});await operation<void>('readwrite',(store,done,parts,fail)=>{const request=store.get(key);request.onsuccess=()=>{const saved=request.result as StoredRecording|undefined;if(saved&&hasParts(saved)){fail(new Error('이미 녹음한 내용이 있어요. 원본을 보관한 뒤 삭제해 주세요.'));return;}store.delete(key);deleteParts(parts,key);done();};});close();},
    /** The owning capture may explicitly discard its own attempt, including its lease. */
    async discard(){close();await queue.catch(()=>{});await operation<void>('readwrite',(store,done,parts)=>{const request=store.get(key);request.onsuccess=()=>{if(request.result?.attemptId===attemptId){store.delete(key);deleteParts(parts,key);}done();};});},
    async flush(){await queue;},
  };
}
export type RecordingRecoveryWriter=Awaited<ReturnType<typeof beginRecordingRecovery>>;

/** Guard route links and reload/close while media still needs a server receipt. */
export function installRecordingExitGuard(options:{hasPending:()=>boolean;save:()=>Promise<void>;navigate:(href:string)=>void;message?:string}) {
  let leaving=false;
  const currentHref=window.location.href,currentState=window.history.state;
  const message=options.message||'보내지 않은 녹음이 있어요. 이 기기에 보관하고 이동할까요?';
  const beforeUnload=(event:BeforeUnloadEvent)=>{if(options.hasPending()&&!leaving){event.preventDefault();event.returnValue='';}};
  const click=(event:MouseEvent)=>{if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey||!options.hasPending()||leaving)return;const element=event.target instanceof Element?event.target.closest<HTMLAnchorElement>('a[href]'):null;if(!element||element.target==='_blank'||element.hasAttribute('download'))return;const destination=new URL(element.href,window.location.href);if(destination.href===window.location.href||destination.hash&&destination.pathname===window.location.pathname&&destination.search===window.location.search)return;event.preventDefault();event.stopImmediatePropagation();if(!window.confirm(message))return;void options.save().then(()=>{leaving=true;options.navigate(destination.href);}).catch(()=>{/* A failed local save must keep the current screen and source. */});};
  const popState=(event:PopStateEvent)=>{if(!options.hasPending()||leaving)return;const destination=window.location.href;event.stopImmediatePropagation();window.history.pushState(currentState,'',currentHref);if(!window.confirm(message))return;void options.save().then(()=>{leaving=true;options.navigate(destination);}).catch(()=>{});};
  const pageHide=()=>{if(options.hasPending())void options.save().catch(()=>{});};
  window.addEventListener('beforeunload',beforeUnload);
  window.addEventListener('popstate',popState,true);
  window.addEventListener('pagehide',pageHide);
  document.addEventListener('click',click,true);
  return()=>{window.removeEventListener('beforeunload',beforeUnload);window.removeEventListener('popstate',popState,true);window.removeEventListener('pagehide',pageHide);document.removeEventListener('click',click,true);};
}
