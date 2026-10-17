import 'server-only';
import { supabaseServer } from './auth';
import { FeatureError, transcriptionConfigured } from './ai';
import { query, transaction } from './db';
import { analyzeSpeech } from './speech-analysis';
import { formatStoredTranscription,transcribeStoredAudio,type RawTranscription,type StoredTranscription } from './speech-transcription';
import { cachedFormattedTranscription,storedRawTranscription,transcriptionDescriptor,transcriptionResponse,withRecordingTranscriptionLock } from './recording-transcription';

export async function transcribeOwnedInterviewRecording(studentId:string,mediaId:string) {
  return withRecordingTranscriptionLock('interview:'+studentId+':'+mediaId,async()=>{
    const [original]=await query("select m.*,t.data as turn_data from media_assets m join interview_sessions s on s.id=m.session_id and s.student_id=m.student_id join interview_turns t on t.id::text=m.metadata->>'turnId' and t.student_id=m.student_id where m.id=$1 and m.student_id=$2 and m.metadata->>'kind'='answer_recording' and s.state not in ('cancelled','deleted')",[mediaId,studentId]);
    if(!original)throw new FeatureError(404,'내 녹음을 찾을 수 없어요.','MEDIA_NOT_FOUND');
    const [asset]=original.metadata.analysisMediaId?await query('select * from media_assets where id=$1 and student_id=$2',[original.metadata.analysisMediaId,studentId]):[original];
    if(!asset||!asset.mime.startsWith('audio/'))throw new FeatureError(409,'분석 음성을 별도로 녹음해 주세요.','ANALYSIS_AUDIO_REQUIRED');
    const raw=storedRawTranscription(original.text||asset.text,original.text?original.metadata:asset.metadata);
    const cached=raw&&cachedFormattedTranscription(raw,original.metadata);
    if(cached)return {...transcriptionResponse(original.metadata,raw.text),cached:true};
    if(!raw&&!transcriptionConfigured()) {
      const patch={transcriptionStatus:'not_configured',cleanupStatus:'pending',transcriptionError:'음성 연결을 준비 중이에요. 녹음은 보관했어요.'};
      await query('update media_assets set metadata=metadata || $3::jsonb where student_id=$1 and (id=$2 or metadata->>\'analysisFor\'=$2::text)',[studentId,mediaId,JSON.stringify(patch)]);
      return {...transcriptionResponse({...original.metadata,...patch},null),cached:false};
    }
    await query("update media_assets set metadata=metadata || jsonb_build_object('transcriptionStatus',$3::text,'cleanupStatus','pending') where student_id=$1 and (id=$2 or metadata->>'analysisFor'=$2::text)",[studentId,mediaId,raw?'completed':'processing']);
    try {
      let result:StoredTranscription;
      if(raw) {await storeInterviewRaw(studentId,mediaId,raw);result=await formatStoredTranscription(studentId,original.session_id,raw);}
      else {
        let bytes=asset.data as Buffer;
        if(asset.metadata.provider==='supabase') {
          const {data,error}=await (await supabaseServer()).storage.from(asset.metadata.bucket).download(asset.metadata.path);
          if(error||!data)throw new FeatureError(404,'녹음을 가져오지 못했어요.','MEDIA_UNAVAILABLE');
          bytes=Buffer.from(await data.arrayBuffer());
        }
        result=await transcribeStoredAudio(studentId,original.session_id,bytes,asset.mime,Number(asset.metadata.durationSeconds||original.metadata.durationSeconds||0),{speechTelemetry:asset.metadata.speechTelemetry||original.metadata.speechTelemetry,onRawTranscription:async recognized=>{await storeInterviewRaw(studentId,mediaId,recognized);}});
      }
      await storeInterviewFormatting(studentId,mediaId,result);
      const [saved]=await query('select text,metadata from media_assets where id=$1 and student_id=$2',[mediaId,studentId]);
      return {...transcriptionResponse(saved.metadata,saved.text),cached:false};
    } catch(error) {
      const [saved]=await query('select text,metadata from media_assets where id=$1 and student_id=$2',[mediaId,studentId]);
      const rawSaved=!!saved?.text;
      const message=error instanceof FeatureError?error.message:'전사를 가져오지 못했어요. 녹음은 보관했어요. 다시 시도하거나 직접 입력해 주세요.';
      await query("update media_assets set metadata=metadata || jsonb_build_object('transcriptionStatus',$3::text,'transcriptionError',$4::text,'cleanupStatus',$5::text,'transcriptionErrorCode',$6::text) where student_id=$1 and (id=$2 or metadata->>'analysisFor'=$2::text)",[studentId,mediaId,rawSaved?'completed':'failed',rawSaved?null:message,rawSaved?'failed':'pending',rawSaved?null:error instanceof FeatureError?error.code:'TRANSCRIPTION_FAILED']);
      throw error;
    }
  });
}

async function storeInterviewRaw(studentId:string,mediaId:string,raw:RawTranscription) {
  await transaction(async db=>{
    const [asset]=(await db.query('select text,metadata from media_assets where id=$1 and student_id=$2 for update',[mediaId,studentId])).rows;
    if(!asset)throw new FeatureError(404,'내 녹음을 찾을 수 없어요.','MEDIA_NOT_FOUND');
    if(asset.text&&asset.text!==raw.text)throw new FeatureError(409,'원전사는 이미 저장되어 있어요.','TRANSCRIPT_IMMUTABLE');
    const speechAnalysis=analyzeSpeech({telemetry:asset.metadata.speechTelemetry,transcript:raw.text,transcriptSource:raw.provider});
    const patch={transcriptionStatus:'completed',transcriptionError:null,transcriptionErrorCode:null,cleanupStatus:'pending',transcription:transcriptionDescriptor(raw),speechAnalysis,measurementStatus:speechAnalysis.status};
    await db.query('update media_assets set text=coalesce(text,$3),metadata=metadata || $4::jsonb where student_id=$1 and (id=$2 or metadata->>\'analysisFor\'=$2::text)',[studentId,mediaId,raw.text,JSON.stringify(patch)]);
    await db.query("update interview_turns set data=data || jsonb_build_object('rawTranscript',case when data->>'answer' is null and coalesce(data->>'invalidated','false')<>'true' then $3::text else coalesce(data->>'rawTranscript',$3::text) end,'rawTranscriptMediaId',case when data->>'answer' is null and coalesce(data->>'invalidated','false')<>'true' then $2::text else coalesce(data->>'rawTranscriptMediaId',$2::text) end) where student_id=$1 and id::text=$4",[studentId,mediaId,raw.text,asset.metadata.turnId]);
  });
}

async function storeInterviewFormatting(studentId:string,mediaId:string,result:StoredTranscription) {
  await transaction(async db=>{
    const [asset]=(await db.query('select text,metadata from media_assets where id=$1 and student_id=$2 for update',[mediaId,studentId])).rows;
    if(!asset||asset.text!==result.rawText)throw new FeatureError(409,'원전사 상태가 바뀌었어요.','TRANSCRIPT_IMMUTABLE');
    const patch={displayTranscript:result.cleanup.status==='completed'?result.displayText:null,transcriptCleanup:result.cleanup,cleanupStatus:result.cleanup.status};
    await db.query('update media_assets set metadata=metadata || $3::jsonb where student_id=$1 and (id=$2 or metadata->>\'analysisFor\'=$2::text)',[studentId,mediaId,JSON.stringify(patch)]);
    const [turn]=(await db.query("select t.*,s.state from interview_turns t join interview_sessions s on s.id=t.session_id and s.student_id=t.student_id where t.id::text=$1 and t.student_id=$2 for update of s,t",[asset.metadata.turnId,studentId])).rows;
    if(!turn)return;
    const data=turn.data;
    const versions=Array.isArray(data.mediaVersions)?data.mediaVersions:[];
    const version={mediaId,transcript:result.rawText,displayTranscript:patch.displayTranscript,transcriptCleanup:result.cleanup,...transcriptionDescriptor(result),createdAt:new Date().toISOString()};
    const old=versions.find((item:Record<string,any>)=>item.mediaId===mediaId);
    const mediaVersions=old?versions.map((item:Record<string,any>)=>item.mediaId===mediaId?{...item,displayTranscript:patch.displayTranscript,transcriptCleanup:result.cleanup}:item):[...versions,version];
    // A completed, invalidated or manually edited answer is never replaced by late formatting.
    const autoDraft=turn.state==='active'&&!data.answer&&!data.invalidated&&result.cleanup.status==='completed'&&!!result.displayText&&(!String(data.draft||'').trim()||(data.autoTranscriptApplied===true&&data.mediaId===mediaId&&data.draft===data.displayTranscript));
    const next={...data,rawTranscript:data.rawTranscript||result.rawText,mediaVersions,
      ...(autoDraft?{transcript:result.displayText,displayTranscript:result.displayText,transcriptCleanup:result.cleanup,draft:result.displayText,mediaId,autoTranscriptApplied:true}:{}),alignmentStatus:data.alignmentStatus||result.alignmentStatus,transcriptRevisions:data.transcriptRevisions||[]};
    await db.query('update interview_turns set data=$3 where id=$1 and student_id=$2',[turn.id,studentId,JSON.stringify(next)]);
  });
}
