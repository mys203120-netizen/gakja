import 'server-only';
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {FeatureError} from './ai';

/** Called under the session/current-turn lock after an explicit student selection. */
export async function ownedInterviewTranscriptSelection(db:PoolClient,studentId:string,sessionId:string,turnId:string,mediaId:string) {
  // Raw text is immutable. Read the committed metadata without an asset lock to
  // avoid reversing the formatter's asset -> session/turn lock order.
  const [asset]=(await db.query("select id,text,metadata from media_assets where id=$1 and student_id=$2 and session_id=$3 and metadata->>'kind'='answer_recording' and metadata->>'turnId'=$4",[mediaId,studentId,sessionId,turnId])).rows;
  if(!asset)throw new FeatureError(404,'현재 질문의 녹음을 찾을 수 없어요.','TRANSCRIPT_MEDIA_NOT_FOUND');
  const cleanup=asset.metadata?.transcriptCleanup,display=asset.metadata?.displayTranscript;
  if(typeof asset.text!=='string'||!asset.text.trim()||cleanup?.status!=='completed'||typeof display!=='string'||!display.trim()||cleanup.rawHash!==createHash('sha256').update(asset.text).digest('hex'))throw new FeatureError(409,'문장 정리가 끝난 전사를 선택해 주세요.','TRANSCRIPT_NOT_READY');
  return {mediaId:asset.id,rawTranscriptMediaId:asset.id,rawTranscript:asset.text,displayTranscript:display,transcriptCleanup:cleanup,
    transcript:display,draft:display,autoTranscriptApplied:true,transcriptSelection:'student',transcriptSelectedAt:new Date().toISOString()};
}
