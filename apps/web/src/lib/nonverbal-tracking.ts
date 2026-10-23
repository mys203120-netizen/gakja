import 'server-only';
import {ApiError,query} from './db';
import {ownedNonverbalMedia} from './nonverbal-analysis';
import {TIMELINE_VERSION,validateTracking,summarizeTracking} from './nonverbal-timeline';

const expiry=()=>new Date(Date.now()-45*60_000).toISOString();
export async function getNonverbalTracking(studentId:string,mediaId:string){
  const row=await ownedNonverbalMedia(studentId,mediaId);
  const analysis=row.metadata.nonverbalTimeline||null;
  return {configured:true,engine:'browser_local_landmarks',durationSeconds:Number(row.metadata.durationSeconds)||0,analysis,legacyAnalysis:row.metadata.nonverbalAnalysis?.status==='completed'?row.metadata.nonverbalAnalysis:null};
}
export async function beginNonverbalTracking(studentId:string,mediaId:string,lease:string){
  const row=await ownedNonverbalMedia(studentId,mediaId);
  const current=row.metadata.nonverbalTimeline;
  if(current?.status==='completed'&&current.version===TIMELINE_VERSION)return getNonverbalTracking(studentId,mediaId);
  const pending={version:TIMELINE_VERSION,status:'processing',lease,startedAt:new Date().toISOString()};
  const [claimed]=await query(`update media_assets set metadata=jsonb_set(metadata,'{nonverbalTimeline}',$3::jsonb) where id=$1 and student_id=$2
    and (coalesce(metadata->'nonverbalTimeline'->>'status','') not in ('processing','completed')
      or (metadata->'nonverbalTimeline'->>'status'='processing' and coalesce(metadata->'nonverbalTimeline'->>'startedAt','')<$4)
      or (metadata->'nonverbalTimeline'->>'status'='completed' and coalesce(metadata->'nonverbalTimeline'->>'version','')<>$5)) returning id`,[mediaId,studentId,JSON.stringify(pending),expiry(),TIMELINE_VERSION]);
  if(!claimed)throw new ApiError(409,'다른 창에서 영상 추적 중이에요. 그 창에서 취소한 뒤 다시 시도해 주세요.');
  return {configured:true,analysis:pending,durationSeconds:Number(row.metadata.durationSeconds)||0};
}
export async function cancelNonverbalTracking(studentId:string,mediaId:string,lease:string){
  await ownedNonverbalMedia(studentId,mediaId);
  await query("update media_assets set metadata=jsonb_set(metadata,'{nonverbalTimeline}',$4::jsonb) where id=$1 and student_id=$2 and metadata->'nonverbalTimeline'->>'status'='processing' and metadata->'nonverbalTimeline'->>'lease'=$3 returning id",[mediaId,studentId,lease,JSON.stringify({version:TIMELINE_VERSION,status:'cancelled'})]);
  return getNonverbalTracking(studentId,mediaId);
}
export async function saveNonverbalTracking(studentId:string,mediaId:string,lease:string,value:unknown){
  const row=await ownedNonverbalMedia(studentId,mediaId),current=row.metadata.nonverbalTimeline;
  if(current?.status!=='processing'||current.lease!==lease||current.startedAt<expiry())throw new ApiError(409,'영상 추적이 취소되었거나 만료되었어요. 다시 시작해 주세요.');
  let tracking;try{tracking=validateTracking(value,Number(row.metadata.durationSeconds)*1000);}catch{throw new ApiError(400,'원본 영상 시간축과 추적 좌표를 확인해 주세요.');}
  const analysis={...summarizeTracking(tracking),startedAt:current.startedAt,completedAt:new Date().toISOString(),model:'MediaPipe Tasks Vision 1.1.1 / face1 pose-lite1 hand1'};
  // Never store image pixels, raw face landmarks, or client-authored assessment text. Recompute bounded physical summaries.
  const saved=await query("update media_assets set metadata=jsonb_set(metadata,'{nonverbalTimeline}',$4::jsonb) where id=$1 and student_id=$2 and metadata->'nonverbalTimeline'->>'status'='processing' and metadata->'nonverbalTimeline'->>'lease'=$3 returning id",[mediaId,studentId,lease,JSON.stringify(analysis)]);
  if(!saved.length)throw new ApiError(409,'영상 추적이 취소되었어요. 결과를 저장하지 않았어요.');
  return {configured:true,analysis};
}
