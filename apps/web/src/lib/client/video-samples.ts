import {nonverbalSampleTimes,type VideoSample} from '../nonverbal-analysis-model';
import {TIMELINE_VERSION,TIMELINE_INTERVAL_MS,trackingTimes,type Tracking,type TrackFrame} from '../nonverbal-timeline';

function waitFor(video:HTMLVideoElement,event:string,signal?:AbortSignal){return new Promise<void>((resolve,reject)=>{
  const done=()=>{cleanup();resolve();},failed=()=>{cleanup();reject(Error('이 브라우저에서 질문 영상을 읽지 못했어요.'));},aborted=()=>{cleanup();reject(new DOMException('Aborted','AbortError'));};
  const timer=setTimeout(failed,15_000),cleanup=()=>{clearTimeout(timer);video.removeEventListener(event,done);video.removeEventListener('error',failed);signal?.removeEventListener('abort',aborted);};
  video.addEventListener(event,done,{once:true});video.addEventListener('error',failed,{once:true});signal?.addEventListener('abort',aborted,{once:true});if(signal?.aborted)aborted();
});}
/** Only the authenticated stored recording is fetched. Frames never enter persistent browser storage. */
export async function extractVideoSamples(mediaId:string,durationSeconds:number,signal?:AbortSignal):Promise<VideoSample[]>{
  const times=nonverbalSampleTimes(durationSeconds*1000);if(!times.length)throw Error('영상 길이를 확인할 수 없어 표본 관찰을 준비하지 못했어요. 원본을 직접 확인해 주세요.');
  const response=await fetch('/api/media?id='+encodeURIComponent(mediaId),{credentials:'same-origin',cache:'no-store',signal});if(!response.ok)throw Error('종료된 질문 영상을 불러오지 못했어요.');
  const blob=await response.blob();if(blob.size>20*1024*1024)throw Error('영상 크기를 확인해 주세요.');
  const url=URL.createObjectURL(blob),video=document.createElement('video');video.muted=true;video.playsInline=true;video.preload='auto';
  try{
    const loaded=waitFor(video,'loadedmetadata',signal);video.src=url;await loaded;
    if(!video.videoWidth||!video.videoHeight)throw Error('영상 화면이 없어 자세를 관찰할 수 없어요.');
    const canvas=document.createElement('canvas'),scale=Math.min(1,640/video.videoWidth,640/video.videoHeight);canvas.width=Math.max(1,Math.round(video.videoWidth*scale));canvas.height=Math.max(1,Math.round(video.videoHeight*scale));const context=canvas.getContext('2d');if(!context)throw Error('영상 표본을 만들 수 없는 브라우저예요.');
    const samples:VideoSample[]=[];
    for(const [index,time] of times.entries()){
      if(signal?.aborted)throw new DOMException('Aborted','AbortError');
      const seeked=waitFor(video,'seeked',signal);video.currentTime=time/1000;await seeked;
      context.drawImage(video,0,0,canvas.width,canvas.height);const dataUrl=canvas.toDataURL('image/jpeg',.65);
      if(dataUrl.length>280_000)throw Error('영상 표본이 너무 커요. 원본 영상으로 확인해 주세요.');
      samples.push({id:index+1,atMs:Math.round(video.currentTime*1000),dataUrl});
    }
    canvas.width=0;canvas.height=0;return samples;
  }finally{video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
}

export type TrackingProgress={stage:'loading'|'tracking';completed:number;total:number;atMs:number};
export function supportsLocalVideoTracking(){return typeof Worker!=='undefined'&&typeof createImageBitmap==='function'&&typeof OffscreenCanvas!=='undefined'&&typeof WebAssembly!=='undefined';}
const abortError=()=>new DOMException('Aborted','AbortError');
/** One decoded frame in flight. Models and recording are same-origin; no image is uploaded. */
export async function trackVideoBlob(blob:Blob,durationSeconds:number,signal?:AbortSignal,onProgress?:(progress:TrackingProgress)=>void):Promise<Tracking>{
  if(!supportsLocalVideoTracking())throw Error('로컬 영상 추적을 지원하지 않는 브라우저예요. 최신 Chrome 또는 Edge에서 원본 영상으로 다시 확인해 주세요.');
  if(blob.size>20*1024*1024)throw Error('20MB 이하 영상으로 확인해 주세요. 원본은 그대로 보존돼요.');
  const expectedMs=Math.round(durationSeconds*1000);trackingTimes(expectedMs);
  if(signal?.aborted)throw abortError();
  const worker=new Worker('/nonverbal/worker.js'),url=URL.createObjectURL(blob),video=document.createElement('video');
  video.muted=true;video.playsInline=true;video.preload='auto';
  let seq=0;
  const call=(type:string,payload:Record<string,unknown>={},transfer:Transferable[]=[])=>new Promise<any>((resolve,reject)=>{
    if(signal?.aborted){reject(abortError());return;}
    const id=++seq,cleanup=()=>{clearTimeout(timer);worker.removeEventListener('message',done);worker.removeEventListener('error',failed);signal?.removeEventListener('abort',cancel);};
    const done=(event:MessageEvent)=>{if(event.data.id!==id)return;cleanup();event.data.error?reject(Error(event.data.error)):resolve(event.data);};
    const failed=()=>{cleanup();reject(Error('영상 추적 도구가 중단되었어요. 최신 브라우저에서 다시 시도해 주세요.'));};
    const cancel=()=>{cleanup();worker.terminate();reject(abortError());};
    const timer=setTimeout(failed,type==='init'?90000:15000);
    worker.addEventListener('message',done);worker.addEventListener('error',failed);signal?.addEventListener('abort',cancel,{once:true});worker.postMessage({id,type,...payload},transfer);
  });
  const canvas=document.createElement('canvas');
  try{
    onProgress?.({stage:'loading',completed:0,total:0,atMs:0});
    const loaded=waitFor(video,'loadedmetadata',signal);video.src=url;await loaded;
    if(!video.videoWidth||!video.videoHeight)throw Error('영상 화면을 읽을 수 없어요. 원본을 직접 확인해 주세요.');
    const actualMs=Number.isFinite(video.duration)?Math.round(video.duration*1000):expectedMs;
    if(Math.abs(actualMs-expectedMs)>Math.max(300,expectedMs*.02))throw Error('저장된 영상 길이와 실제 영상 길이가 달라요. 원본 영상을 확인해 주세요.');
    const times=trackingTimes(actualMs),scale=Math.min(1,640/video.videoWidth,640/video.videoHeight);canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);
    const context=canvas.getContext('2d',{alpha:false});if(!context)throw Error('영상 프레임을 읽지 못했어요.');
    await call('init');const frames:TrackFrame[]=[];let consecutiveFailures=0;
    for(const atMs of times){
      if(signal?.aborted)throw abortError();
      let bitmap:ImageBitmap|undefined;
      try{
        if(Math.abs(video.currentTime-atMs/1000)>.001){const sought=waitFor(video,'seeked',signal);video.currentTime=atMs/1000;await sought;}
        else if(video.readyState<2)await waitFor(video,'loadeddata',signal);
        if(Math.abs(video.currentTime*1000-atMs)>60)throw Error('Frame timestamp mismatch');
        context.drawImage(video,0,0,canvas.width,canvas.height);bitmap=await createImageBitmap(canvas);
      }catch(error){
        if(signal?.aborted)throw abortError();
        frames.push({atMs,v:[null,null,null,null],q:['decode_failed','decode_failed','decode_failed','decode_failed']});
        consecutiveFailures++;if(consecutiveFailures>=5)throw Error('연속된 영상 프레임을 읽지 못했어요. 부분 결과를 전체 관측으로 저장하지 않았어요.');
      }
      if(bitmap){try{const result=await call('frame',{bitmap,atMs},[bitmap]);frames.push(result.frame);consecutiveFailures=0;}finally{bitmap.close();}}
      onProgress?.({stage:'tracking',completed:frames.length,total:times.length,atMs});
    }
    return {version:TIMELINE_VERSION,durationMs:actualMs,intervalMs:TIMELINE_INTERVAL_MS,frames};
  }finally{worker.terminate();canvas.width=0;canvas.height=0;video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
}
export async function trackStoredVideo(mediaId:string,durationSeconds:number,signal?:AbortSignal,onProgress?:(progress:TrackingProgress)=>void){
  const response=await fetch('/api/media?id='+encodeURIComponent(mediaId),{credentials:'same-origin',cache:'no-store',signal});if(!response.ok)throw Error('종료된 질문 영상을 불러오지 못했어요.');
  const limit=20*1024*1024;if(Number(response.headers.get('content-length'))>limit)throw Error('20MB 이하 영상으로 확인해 주세요.');
  const reader=response.body?.getReader();if(!reader)throw Error('영상 응답을 읽지 못했어요.');const chunks:Uint8Array<ArrayBuffer>[]=[];let size=0;
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>limit){await reader.cancel();throw Error('20MB 이하 영상으로 확인해 주세요.');}chunks.push(new Uint8Array(part.value));}}finally{reader.releaseLock();}
  return trackVideoBlob(new Blob(chunks,{type:response.headers.get('content-type')||'video/webm'}),durationSeconds,signal,onProgress);
}
