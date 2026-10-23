'use client';
import {useEffect,useRef,useState} from 'react';
import {Scan,Play} from 'lucide-react';
import {api,ActionButton,Alert,type Item} from './shared';
import {ownedClassName} from './owned-class-name';
import {TIMELINE_NOTICE,type TrackingSummary,type TrackInterval} from '@/lib/nonverbal-timeline';
import {trackStoredVideo,supportsLocalVideoTracking,type TrackingProgress} from '@/lib/client/video-samples';
import styles from './nonverbal-review.module.css';
const time=(ms:number)=>`${Math.floor(ms/60000)}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${Math.floor(ms%1000/100)}`;
const reasons:Record<string,string>={not_detected:'미검출',low_confidence:'낮은 검출 신뢰·가림',multiple_people:'여러 사람 감지',out_of_frame:'화면 밖·크기 부족',decode_failed:'프레임 읽기 실패'};
function Intervals({items,seek}:{items:TrackInterval[];seek:(ms:number)=>void}){
  const [count,setCount]=useState(20);
  return <><div className={styles.timestamps}>{items.slice(0,count).map((item,index)=><button type="button" key={index} onClick={()=>seek(item.startMs)} aria-label={`원본 영상 ${time(item.startMs)}부터 ${time(item.endMs)}까지 확인`}><Play size={12}/>{time(item.startMs)}–{time(item.endMs)}{item.reason?' · '+(reasons[item.reason]||item.reason):''}</button>)}</div>{items.length>count&&<button type="button" className={ownedClassName('text-link')} onClick={()=>setCount(value=>value+20)}>다음 구간 더 보기 ({items.length-count}개)</button>}</>;
}
export function NonverbalReview({mediaId,durationSeconds,onSeek}:{mediaId:string;videoUrl?:string;durationSeconds?:number;onSeek?:(seconds:number)=>void}){
  const [data,setData]=useState<Item|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[progress,setProgress]=useState<TrackingProgress|null>(null),[reload,setReload]=useState(0),[supported,setSupported]=useState(true);
  const controller=useRef<AbortController|null>(null),run=useRef<{mediaId:string;lease:string}|null>(null);
  const release=(current:{mediaId:string;lease:string})=>api('/api/nonverbal-analysis',{method:'POST',keepalive:true,body:JSON.stringify({...current,action:'cancel'})});
  useEffect(()=>{setSupported(supportsLocalVideoTracking());const abort=new AbortController();setData(null);setError('');setBusy(false);setProgress(null);
    api('/api/nonverbal-analysis?mediaId='+encodeURIComponent(mediaId),{cache:'no-store',signal:abort.signal}).then(result=>{if(!abort.signal.aborted)setData(result);}).catch(err=>{if(!abort.signal.aborted)setError((err as Error).message);});
    return()=>{abort.abort();controller.current?.abort();if(run.current){void release(run.current).catch(()=>{});run.current=null;}};
  },[mediaId,reload]);
  async function cancel(){controller.current?.abort();const current=run.current||data?.analysis?.lease&&{mediaId,lease:data.analysis.lease};run.current=null;setBusy(false);setProgress(null);if(current)try{setData(await release(current));}catch(err){setError((err as Error).message);}}
  async function analyze(){
    if(busy||!data?.configured||!supported)return;
    const abort=new AbortController(),lease=crypto.randomUUID(),current={mediaId,lease};controller.current=abort;run.current=current;setBusy(true);setError('');setProgress({stage:'loading',completed:0,total:0,atMs:0});
    try{
      const begun=await api('/api/nonverbal-analysis',{method:'POST',body:JSON.stringify({...current,action:'begin'}),signal:abort.signal});
      if(begun.analysis?.status==='completed'){setData(begun);run.current=null;return;}
      if(!abort.signal.aborted)setData(previous=>({...previous,...begun}));
      const tracking=await trackStoredVideo(mediaId,begun.durationSeconds||data.durationSeconds||durationSeconds||0,abort.signal,setProgress);
      const result=await api('/api/nonverbal-analysis',{method:'POST',body:JSON.stringify({...current,action:'save',tracking}),signal:abort.signal});
      if(!abort.signal.aborted){setData(previous=>({...previous,...result}));run.current=null;}
    }catch(err){if(!abort.signal.aborted)setError((err as Error).message);}
    finally{if(run.current?.lease===lease){run.current=null;try{const released=await release(current);if(!abort.signal.aborted)setData(previous=>({...previous,...released}));}catch{/* Keep the owned processing receipt visible so cancellation can be retried. */}}if(!abort.signal.aborted){setBusy(false);setProgress(null);}}
  }
  const result=data?.analysis as (TrackingSummary&{lease?:string})|undefined,completed=result?.status==='completed',processing=data?.analysis?.status==='processing';
  function seek(ms:number){if(onSeek){onSeek(ms/1000);return;}const video=document.querySelector<HTMLVideoElement>(`video[data-nonverbal-media="${mediaId}"]`);if(video){video.currentTime=ms/1000;video.scrollIntoView({block:'center'});video.focus();}}
  const percent=progress?.total?Math.round(progress.completed/progress.total*100):0;
  return <section className={ownedClassName(styles.panel,true)} aria-label="영상 움직임 시간축 관찰">
    <div className={ownedClassName(styles.heading,true)}><Scan size={17}/><h4>영상 속 움직임</h4></div><p className={ownedClassName(styles.notice,true)}>{TIMELINE_NOTICE}</p>
    {error&&<Alert>{error}</Alert>}
    {!data&&!error&&<p className={styles.status}>관찰 상태 확인 중</p>}
    {!data&&error&&<button type="button" className={ownedClassName('text-link')} onClick={()=>setReload(value=>value+1)}>상태 다시 확인</button>}
    {!supported&&<p className={styles.status}>이 브라우저는 로컬 영상 추적을 지원하지 않아요. 최신 Chrome 또는 Edge에서 다시 시도하거나 원본 영상을 직접 확인해 주세요.</p>}
    {completed&&result?<>
      <p className={styles.status}>전체 {time(result.durationMs)} · {result.frameCount.toLocaleString()}개 시간 위치 확인 · 관측 신뢰: 제한적</p>
      <div className={styles.coverage}>{result.channels.map(channel=><article key={channel.channel}>
        <strong>{channel.label}</strong><p>{channel.observedMs>0?`확인된 ${channel.count}회`:'관측 불가'}{channel.partialCount>0?` · 경계가 끊긴 ${channel.partialCount}구간은 횟수 제외`:''}</p>
        <meter min={0} max={100} value={channel.coverage} aria-label={`${channel.label} 관측 비율`}/><p>관측 {channel.coverage}% · 미관측 {time(channel.unavailableMs)}</p>
        <details><summary>관측 구간 원본 보기</summary><Intervals items={result.events.filter(event=>event.channel===channel.channel).map(event=>({...event,reason:event.complete?'시작·복귀 확인':'횟수 제외: 시작 또는 복귀 미확인'}))} seek={seek}/>{!result.events.some(event=>event.channel===channel.channel)&&<p>기준을 충족한 구간이 없어요. 움직임이 없었다는 뜻은 아니에요.</p>}</details>
        {channel.unavailable.length>0&&<details><summary>미관측 구간 {channel.unavailable.length}개</summary><Intervals items={channel.unavailable} seek={seek}/></details>}
      </article>)}</div>
      <ul className={styles.limitations}>{result.limitations.map(item=><li key={item}>{item}</li>)}</ul>
      <p className={styles.disclosure}>영상은 이 기기에서 처리했어요. 원본 이미지·얼굴 좌표를 전송하거나 별도 저장하지 않고, 관측 시간과 횟수 요약만 저장해요. 추가 AI API 이용료는 없어요.</p>
    </>:data?.configured&&<>
      {busy&&<div className={styles.progress}><p role="status">{progress?.stage==='loading'?'영상·로컬 관측 도구 준비 중':`시간축 추적 ${percent}% · ${time(progress?.atMs||0)}까지 확인`}</p><progress max={100} value={percent} aria-label="영상 시간축 추적 진행률"/></div>}
      <div className={styles.actions}><ActionButton className={ownedClassName('button ghost small')} pending={busy} pendingLabel="영상 추적 중" disabled={!supported||processing&&!busy} onClick={analyze}><Scan size={14}/>{error?'영상 추적 다시 시도':'전체 영상 움직임 살펴보기'}</ActionButton>{(busy||processing)&&<button type="button" className={ownedClassName('button ghost small')} onClick={cancel}>추적 취소</button>}</div>
      {processing&&!busy&&<p className={styles.status}>이 영상의 추적 요청이 남아 있어요. 진행 중인 창을 확인하거나 취소한 뒤 다시 시작할 수 있어요.</p>}
      <p className={styles.disclosure}>영상과 관측 모델을 이 기기로 불러와 처리해요. 영상 길이와 기기 성능에 따라 시간이 걸릴 수 있어요. 취소하면 부분 결과를 저장하지 않으며 원본은 유지돼요. 원본 이미지는 외부 AI에 전송하지 않아요.</p>
    </>}
    {data?.legacyAnalysis&&<details className={styles.legacy}><summary>이전 정지 화면 표본 관찰</summary><p>{data.legacyAnalysis.notice}</p>{data.legacyAnalysis.observations?.map((item:Item,i:number)=><p key={i}>{item.description}</p>)}<p>이전 표본 관찰은 연속 추적 횟수에 포함하지 않아요.</p></details>}
  </section>;
}
