import {z} from 'zod';

export const TIMELINE_VERSION='local-landmarks-2026-10-23-v1';
export const TIMELINE_INTERVAL_MS=100;
export const TIMELINE_NOTICE='영상 전체 시간축을 0.1초 간격으로 추적해 관측된 구간만 정리해요. 얼굴 방향은 눈의 시선이 아니며, 감정·태도·능력을 평가하지 않아요.';
export const TRACK_CHANNELS=['face','body','left','right'] as const;
export type TrackChannel=typeof TRACK_CHANNELS[number];
export const TRACK_LABELS:Record<TrackChannel,string>={face:'얼굴 방향 이탈',body:'상체 왕복 움직임',left:'왼손 왕복 움직임',right:'오른손 왕복 움직임'};
export const trackQualitySchema=z.enum(['observed','not_detected','low_confidence','multiple_people','out_of_frame','decode_failed']);
export type TrackQuality=z.infer<typeof trackQualitySchema>;
const point=z.tuple([z.number().finite().min(-180).max(180),z.number().finite().min(-180).max(180)]).nullable();
export const trackFrameSchema=z.object({atMs:z.number().int().nonnegative(),v:z.tuple([point,point,point,point]),q:z.tuple([trackQualitySchema,trackQualitySchema,trackQualitySchema,trackQualitySchema])}).strict();
export type TrackFrame=z.infer<typeof trackFrameSchema>;
export const trackingSchema=z.object({version:z.literal(TIMELINE_VERSION),durationMs:z.number().int().min(500).max(1_200_000),intervalMs:z.literal(TIMELINE_INTERVAL_MS),frames:z.array(trackFrameSchema).min(5).max(12_000)}).strict();
export type Tracking=z.infer<typeof trackingSchema>;
export type TrackInterval={startMs:number;endMs:number;reason?:string};
export type TrackEvent=TrackInterval&{channel:TrackChannel;kind:'direction_away'|'round_trip';confidence:'limited';complete:boolean;};
export function trackingTimes(durationMs:number){if(!Number.isFinite(durationMs)||durationMs<500||durationMs>1_200_000)throw Error('0.5초 이상 20분 이하 영상으로 확인해 주세요.');return Array.from({length:Math.ceil(durationMs/100)},(_,i)=>i*100);}

export function validateTracking(value:unknown,durationMs:number):Tracking{
  const track=trackingSchema.parse(value);
  if(!Number.isFinite(durationMs)||Math.abs(track.durationMs-durationMs)>Math.max(300,durationMs*.02))throw Error('원본 영상 길이와 추적 결과가 다릅니다.');
  // Every planned position must be reported, including failures. Omitted time cannot become observed time.
  const times=trackingTimes(track.durationMs);
  if(track.frames.length!==times.length)throw Error('영상 시간축 일부가 누락되었습니다.');
  track.frames.forEach((frame,i)=>{if(frame.atMs!==times[i])throw Error('영상 시간 순서가 다릅니다.');frame.q.forEach((quality,c)=>{
    const value=frame.v[c];if((quality==='observed')!==Boolean(value))throw Error('관측 품질과 좌표가 일치하지 않습니다.');
    if(value&&(c===0?(Math.abs(value[0])>90||value[1]!==0):Math.abs(value[0])>8||Math.abs(value[1])>8))throw Error('관측 좌표 범위를 확인해 주세요.');
  });});return track;
}
function appendInterval(items:TrackInterval[],startMs:number,endMs:number,reason:string){const last=items.at(-1);if(last?.endMs===startMs&&last.reason===reason)last.endMs=endMs;else items.push({startMs,endMs,reason});}
const distance=(a:number[],b:number[])=>Math.hypot(a[0]-b[0],a[1]-b[1]);

/** Deterministic physical observations only. Never extrapolates across missing/low-quality frames. */
export function summarizeTracking(track:Tracking){
  const events:TrackEvent[]=[];
  const channels=TRACK_CHANNELS.map((channel,c)=>{
    let observedMs=0;const unavailable:TrackInterval[]=[];
    let faceStart:number|null=null,faceLast=0,faceNeutral=false,faceHasStart=false;
    let anchor:number[]|null=null,anchorAt=0,settled=0,excursion:number|null=null,peak=0;
    const reset=()=>{anchor=null;settled=0;excursion=null;peak=0;};
    const closeFace=(complete=false)=>{if(faceStart!==null&&faceLast-faceStart>=300)events.push({channel,kind:'direction_away',startMs:faceStart,endMs:faceLast,confidence:'limited',complete:complete&&faceHasStart});faceStart=null;};
    for(const frame of track.frames){
      const end=Math.min(track.durationMs,frame.atMs+100),value=frame.v[c];
      if(frame.q[c]!=='observed'||!value){appendInterval(unavailable,frame.atMs,end,frame.q[c]);closeFace();faceNeutral=false;reset();continue;}
      observedMs+=end-frame.atMs;
      if(c===0){const angle=Math.abs(value[0]);if(faceStart===null&&angle>=25){faceStart=frame.atMs;faceHasStart=faceNeutral;}if(faceStart!==null){if(angle<=18)closeFace(true);else faceLast=end;}if(angle<=18)faceNeutral=true;continue;}
      // Hands use shoulder-width units relative to the torso; body uses image-width/height units.
      const outward=c===1?.065:.30,home=c===1?.022:.10;
      if(!anchor){anchor=value;anchorAt=frame.atMs;settled=1;continue;}
      const d=distance(value,anchor);
      if(excursion===null){
        if(d<=home){settled++;anchorAt=Math.max(anchorAt,frame.atMs-200);continue;}
        if(d>=outward&&settled>=3){excursion=anchorAt;peak=d;}
        else if(settled<3||frame.atMs-anchorAt>8000){anchor=value;anchorAt=frame.atMs;settled=1;}
      }else{
        peak=Math.max(peak,d);
        if(frame.atMs-excursion>8000){reset();continue;}
        if(d<=home){const span=end-excursion;if(span>=700&&peak>=outward)events.push({channel,kind:'round_trip',startMs:excursion,endMs:end,confidence:'limited',complete:true});anchor=value;anchorAt=end;settled=0;excursion=null;peak=0;}
      }
    }
    closeFace();
    return {channel,label:TRACK_LABELS[channel],observedMs,unavailableMs:track.durationMs-observedMs,coverage:Math.round(observedMs/track.durationMs*1000)/10,unavailable,count:events.filter(event=>event.channel===channel&&event.complete).length,partialCount:events.filter(event=>event.channel===channel&&!event.complete).length};
  });
  return {version:TIMELINE_VERSION,source:'browser_local_landmarks' as const,status:'completed' as const,durationMs:track.durationMs,intervalMs:100,frameCount:track.frames.length,decodedFrames:track.frames.filter(frame=>frame.q.some(q=>q!=='decode_failed')).length,channels,events:events.sort((a,b)=>a.startMs-b.startMs||a.channel.localeCompare(b.channel)),notice:TIMELINE_NOTICE,confidence:'limited' as const,
    limitations:['횟수는 관측 가능한 연속 구간에서만 센 최소 횟수예요. 인식 실패 전후를 이어 세지 않아요.','0.1초보다 빠른 움직임과 가려진 부분은 놓칠 수 있어요. 얼굴 방향은 회전의 근사값이며 눈의 시선은 측정하지 않아요.','신뢰 수준은 제한적이에요. 모델의 검출 기준을 통과한 좌표를 사용하며 정확도 확률을 뜻하지 않아요.','상체 움직임에는 카메라 움직임이 섞일 수 있어요. 원본 구간에서 직접 확인해 주세요.'],billing:'local_no_api_charge' as const};
}
export type TrackingSummary=ReturnType<typeof summarizeTracking>;
