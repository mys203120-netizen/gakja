import 'server-only';
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {FeatureError} from './ai';

/** Called under the session/current-turn lock. Automatic submission additionally
 * requires the exact capture generation and a successful completed transcription. */
export async function ownedInterviewTranscriptSelection(db:PoolClient,studentId:string,sessionId:string,turnId:string,mediaId:string,automatic?:{generation:number}) {
  // Raw text is immutable. Read the committed metadata without an asset lock to
  // avoid reversing the formatter's asset -> session/turn lock order.
  const [asset]=(await db.query("select id,text,metadata from media_assets where id=$1 and student_id=$2 and session_id=$3 and metadata->>'kind'='answer_recording' and metadata->>'turnId'=$4",[mediaId,studentId,sessionId,turnId])).rows;
  if(!asset)throw new FeatureError(404,'현재 질문의 녹음을 찾을 수 없어요.','TRANSCRIPT_MEDIA_NOT_FOUND');
  if(automatic){
    if(asset.metadata?.generation!==automatic.generation)throw new FeatureError(409,'녹음 이후 질문 상태가 바뀌었어요. 현재 질문에서 다시 녹음해 주세요.','STALE_GENERATION');
    if(asset.metadata?.transcriptionStatus!=='completed'||asset.metadata?.transcriptionErrorCode==='NO_SPEECH_DETECTED')throw new FeatureError(409,'음성이 확인되고 전사가 완료된 녹음만 제출할 수 있어요.','TRANSCRIPT_NOT_READY');
  }
  const cleanup=asset.metadata?.transcriptCleanup,display=asset.metadata?.displayTranscript;
  if(typeof asset.text!=='string'||!asset.text.trim()||cleanup?.status!=='completed'||typeof display!=='string'||!display.trim()||cleanup.rawHash!==createHash('sha256').update(asset.text).digest('hex'))throw new FeatureError(409,'문장 정리가 끝난 전사를 선택해 주세요.','TRANSCRIPT_NOT_READY');
  return {mediaId:asset.id,rawTranscriptMediaId:asset.id,rawTranscript:asset.text,displayTranscript:display,transcriptCleanup:cleanup,
    transcript:display,draft:display,autoTranscriptApplied:true,transcriptSelection:automatic?'automatic':'student',transcriptSelectedAt:new Date().toISOString()};
}
