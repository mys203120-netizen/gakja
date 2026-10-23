import 'server-only';
import {recordMatchesCurrentTarget} from './learning-target-scope';
import { createHash } from 'node:crypto';
import { supabaseServer,type Profile } from './auth';
import { ApiError, query, transaction } from './db';
import { getLearningWorkflows } from './learning-workflows';
import { learningRetryHref } from './learning-navigation';
import { analyzeSpeech, SPEECH_ANALYSIS_VERSION, validateSpeechTelemetry, type SpeechAnalysis } from './speech-analysis';
import { buildContentGrowth,compareAnswerGrowth,growthContextKey,growthContextResolver,growthNextReason, type GrowthVersion } from './learning-growth';
import { formatStoredTranscription,transcribeStoredAudio,type RawTranscription } from './speech-transcription';
import { cachedFormattedTranscription,storedRawTranscription,transcriptionDescriptor,transcriptionResponse,withRecordingTranscriptionLock } from './recording-transcription';
import { FeatureError } from './ai';
import { NO_SPEECH_MESSAGE } from './speech-silence';

type GrowthScope={targetId?:string;sessionId?:string;reportId?:string;studySessionId?:string};
function studentOnly(user:Profile) {if(user.role!=='student')throw new ApiError(403,'내 학습 기록은 학생 계정에서 확인해 주세요.');}
function serializeVersion(version:Record<string,any>):GrowthVersion {
  // Readable copy edits must not replace the utterance used as growth evidence.
  return {experience_card:version.experience_card||null,id:version.id,question_id:version.question_id,question:version.question,script:version.script||'',raw_script:version.raw_script,transcript_formatting:version.transcript_formatting,created_at:version.created_at,
    revision_kind:version.revision_kind,assisted:version.assisted,ai_assisted:version.ai_assisted,hint_used:version.hint_used,assistance_recorded:version.assistance_recorded,session_id:version.session_id,target_id:version.target_id,target_snapshot:version.target_snapshot||null,
    content_version:version.content_version,source_type:version.source_type,common_revision:version.common_revision,practice_kind:version.practice_kind,answer_attempt_kind:version.answer_attempt_kind,practice_due_at:version.practice_due_at,response_mode:version.response_mode,
    required_meanings:(version.required_meanings||version.comparison?.required_meanings||[]).map((meaning:string|{text:string})=>typeof meaning==='string'?meaning:meaning.text).filter(Boolean)};
}
function storedAnalysis(row:Record<string,any>):SpeechAnalysis {
  // Recalculate text observations from raw STT, never from a corrected/polished submitted answer.
  const telemetry=row.metadata?.speechTelemetry;
  const transcript=typeof row.raw_transcript==='string'?row.raw_transcript:typeof row.text==='string'?row.text:typeof row.metadata?.transcript==='string'?row.metadata.transcript:null;
  return analyzeSpeech({telemetry,transcript,transcriptSource:row.metadata?.transcription?.provider||'stored_stt'});
}
function recordingGrowthEligible(row:Record<string,any>):boolean {
  const metadata=row.metadata||{};
  // Preserve historical files and ordinary STT outages. Only an explicit no-speech
  // diagnosis without a saved utterance is ineligible for growth observations.
  return !(metadata.transcriptionStatus==='failed'&&!row.text&&!metadata.transcript&&
    (metadata.transcriptionErrorCode==='NO_SPEECH_DETECTED'||metadata.transcriptionError===NO_SPEECH_MESSAGE));
}
export async function getGrowthPayload(user:Profile,scope:GrowthScope={}) {
  studentOnly(user);
  const pinned=Boolean(scope.reportId||scope.sessionId||scope.studySessionId);
  const activeTargets=pinned?[]:(await query("select id,data from support_targets where student_id=$1 and nullif(data->>'archived_at','') is null",[user.id])).map(row=>({...row.data,id:row.id}));
  if(!pinned&&scope.targetId&&!activeTargets.some(target=>target.id===scope.targetId))throw new ApiError(404,'현재 등록된 지원 학교를 선택해 주세요.');
  const currentTargets=scope.targetId?activeTargets.filter(target=>target.id===scope.targetId):activeTargets;
  const inScope=(row:Record<string,any>)=>pinned||recordMatchesCurrentTarget(row,currentTargets)||
    (!scope.targetId&&!activeTargets.length&&!row.target_id&&!row.targetId&&!row.target_snapshot&&!row.targetSnapshot);
  let cutoff:string|null=null,sessionId=scope.sessionId||null,scopeQuestions:string[]|null=null;
  if(scope.reportId) {
    const [report]=await query('select session_id,created_at,data from interview_reports where id=$1 and student_id=$2',[scope.reportId,user.id]);
    if(!report)throw new ApiError(404,'리포트를 찾을 수 없어요.');
    sessionId=report.session_id;cutoff=new Date(report.created_at).toISOString();scopeQuestions=(report.data.sections||[]).map((section:Record<string,any>)=>section.questionId).filter(Boolean);
  }
  if(sessionId) {
    const [session]=await query("select id from interview_sessions where id=$1 and student_id=$2 and state not in ('cancelled','deleted')",[sessionId,user.id]);
    if(!session)throw new ApiError(404,'면접 기록을 찾을 수 없어요.');
  }
  if(scope.studySessionId) {
    const [session]=await query('select id,ended_at,report from study_sessions where id=$1 and student_id=$2',[scope.studySessionId,user.id]);
    if(!session)throw new ApiError(404,'학습 기록을 찾을 수 없어요.');
    cutoff=session.ended_at?new Date(session.ended_at).toISOString():null;
    const events=await query('select data from study_session_events where session_id=$1 and student_id=$2',[session.id,user.id]);
    scopeQuestions=[...new Set(events.map(event=>event.data.questionId).filter(Boolean))] as string[];
  }
  const [workflow,media,quiz,newsThoughts,newsTurns]=await Promise.all([
    getLearningWorkflows(user),
    query("select m.id,m.session_id,m.mime,m.text,m.metadata,m.created_at,t.question_id,t.data->>'question' as prompt,s.target_id,s.content_version,s.data->'context'->'target' as target_snapshot,t.data->'commonRevision' as common_revision from media_assets m join interview_sessions s on s.id=m.session_id and s.student_id=m.student_id left join interview_turns t on t.id::text=m.metadata->>'turnId' and t.student_id=m.student_id where m.student_id=$1 and m.metadata->>'kind'='answer_recording' and s.state not in ('cancelled','deleted') and ($2::uuid is null or m.session_id=$2) and ($3::timestamptz is null or m.created_at<=$3) order by m.created_at desc limit 120",[user.id,sessionId,cutoff]),
    sessionId?Promise.resolve([]):query("select r.id,r.session_id,r.mime,r.duration_ms,r.metadata,r.created_at,s.content_version,s.items->r.item_index->>'question_id' as question_id,s.items->r.item_index->>'prompt' as prompt,coalesce(s.items->r.item_index->>'target_id',s.metadata->>'targetId') as target_id,coalesce(s.items->r.item_index->'target_snapshot',s.metadata->'targetSnapshot') as target_snapshot,s.items->r.item_index->'common_revision' as common_revision from quiz_recordings r join quiz_sessions s on s.id=r.session_id and s.student_id=r.student_id where r.student_id=$1 and ($2::timestamptz is null or r.created_at<=$2) order by r.created_at desc limit 120",[user.id,cutoff]),
    query('select r.id,r.content,r.created_at,t.article_id,a.title from department_news_thought_revisions r join department_news_thoughts t on t.id=r.thought_id and t.student_id=r.student_id join department_news_articles a on a.id=t.article_id where r.student_id=$1 and ($2::timestamptz is null or r.created_at<=$2) order by r.created_at',[user.id,cutoff]),
    query("select t.id,t.session_id,t.question_id,t.data,s.target_id,s.data->'context'->'target' as target_snapshot,coalesce(t.data->>'answeredAt',t.created_at::text) as answered_at,coalesce(s.data->'context'->'briefing'->>'article_id',b.data->>'article_id') as article_id,b.id as briefing_id,b.title,s.data->'context'->'briefing'->'thought_snapshot' as thought_snapshot from interview_turns t join interview_sessions s on s.id=t.session_id and s.student_id=t.student_id join briefings b on b.id::text=coalesce(s.data->>'briefingId',s.data->'context'->>'briefingId') and b.data->>'owner_student_id'=t.student_id::text where t.student_id=$1 and b.data->>'source_kind'='rss_news' and s.state not in ('cancelled','deleted') and coalesce(t.data->>'invalidated','false')<>'true' and length(trim(coalesce(t.data->>'originalAnswer',t.data->>'answer','')))>0 and t.question_id='briefing_'||b.id::text||'_0' and ($2::uuid is null or t.session_id=$2) and ($3::timestamptz is null or coalesce(nullif(t.data->>'answeredAt','')::timestamptz,t.created_at)<=$3) order by coalesce(nullif(t.data->>'answeredAt','')::timestamptz,t.created_at)",[user.id,sessionId,cutoff]),
  ]);
  const recordings=[...media.map(row=>({id:row.id,kind:'interview',questionId:row.question_id||row.metadata.questionId,prompt:row.prompt||'녹음 답변',createdAt:row.created_at,sessionId:row.session_id,targetId:row.target_id,targetSnapshot:row.target_snapshot,contentVersion:row.content_version,commonRevision:row.common_revision,contextKey:growthContextKey({id:row.id,question_id:row.question_id||'',script:'',created_at:row.created_at,target_id:row.target_id,target_snapshot:row.target_snapshot,common_revision:row.common_revision}),
    playbackUrl:'/api/media?id='+row.id,analysisAudioUrl:row.metadata.analysisMediaId?'/api/media?id='+row.metadata.analysisMediaId:row.mime.startsWith('audio/')?'/api/media?id='+row.id:null,growthEligible:recordingGrowthEligible(row),analysis:storedAnalysis(row),...transcriptionResponse(row.metadata,row.text||row.metadata?.transcript||null)})),
    ...quiz.map(row=>({id:row.id,kind:'quiz',questionId:row.question_id,prompt:row.prompt||'녹음 퀴즈',createdAt:row.created_at,sessionId:row.session_id,targetId:row.target_id,targetSnapshot:row.target_snapshot,contentVersion:row.content_version,commonRevision:row.common_revision,contextKey:growthContextKey({id:row.id,question_id:row.question_id||'',script:'',created_at:row.created_at,target_id:row.target_id,target_snapshot:row.target_snapshot,common_revision:row.common_revision}),
    playbackUrl:'/api/quiz?recordingId='+row.id,analysisAudioUrl:'/api/quiz?recordingId='+row.id,growthEligible:recordingGrowthEligible(row),analysis:storedAnalysis(row),...transcriptionResponse(row.metadata,row.text||row.metadata?.transcript||null)}))]
    .filter(inScope).filter(row=>scopeQuestions===null||scopeQuestions.includes(row.questionId)).sort((a,b)=>new Date(b.createdAt).getTime()-new Date(a.createdAt).getTime());
  const versions=workflow.versions.map(serializeVersion).filter(inScope).filter(version=>(!cutoff||new Date(version.created_at).getTime()<=new Date(cutoff).getTime())&&(!scopeQuestions||scopeQuestions.includes(version.question_id)));
  const content=buildContentGrowth(versions);
  if(sessionId)content.comparisons=content.comparisons.filter(comparison=>comparison.after.session_id===sessionId);
  const newsComparisons=newsTurns.filter(inScope).filter(turn=>scopeQuestions===null||scopeQuestions.includes(turn.question_id)).map(turn=>{
    const thoughts=newsThoughts.filter(thought=>thought.article_id===turn.article_id&&new Date(thought.created_at).getTime()<=new Date(turn.answered_at).getTime());
    const thought=thoughts[0];
    const snapshot=turn.thought_snapshot;
    const beforeText=thought?.content||snapshot?.content;
    if(!beforeText?.trim())return null;
    const identity='news:'+turn.article_id;
    const savedVersion=workflow.versions.find(version=>version.turn_id===turn.id);
    const before:GrowthVersion={id:thought?.id||'thought-snapshot:'+turn.id,question_id:identity,question:turn.title,script:beforeText,created_at:thought?.created_at||snapshot?.updated_at||turn.answered_at,revision_kind:'news_thought'};
    const after:GrowthVersion={id:turn.id,question_id:identity,question:turn.title,script:turn.data.originalAnswer||turn.data.answer,created_at:turn.answered_at,revision_kind:'interview_answer',raw_script:turn.data.speechSource?.rawText||null,transcript_formatting:turn.data.speechSource||null,assisted:turn.data.assisted,assistance_recorded:turn.data.assistance_recorded===true||turn.data.assistanceRecorded===true,response_mode:savedVersion?.response_mode||'unknown',session_id:turn.session_id};
    return {...compareAnswerGrowth(before,after),articleId:turn.article_id,sourceQuestionId:turn.question_id,sourceHref:'/materials/briefings/news/'+turn.article_id,
      retryHref:learningRetryHref(turn.question_id,{...savedVersion,target_id:turn.target_id}),
      note:'기사에서 남긴 생각과 같은 기사로 연습한 면접 답변이에요. 분량이나 표현만으로 실력을 판정하지 않아요.'};
  }).filter((comparison):comparison is NonNullable<typeof comparison>=>!!comparison).reverse().filter((comparison,index,all)=>all.findIndex(other=>other.articleId===comparison.articleId)===index);
  const recordingVersion=(row:typeof recordings[number]):GrowthVersion=>({id:row.id,question_id:row.questionId,script:'',created_at:row.createdAt,target_id:row.targetId,target_snapshot:row.targetSnapshot,content_version:row.contentVersion,common_revision:row.commonRevision});
  const resolveRecordingContext=growthContextResolver(recordings.map(recordingVersion));
  for(const recording of recordings)recording.contextKey=resolveRecordingContext(recordingVersion(recording));
  const eligibleRecordings=recordings.filter(row=>row.growthEligible);
  const measured=eligibleRecordings.filter(row=>row.analysis.timing?.reliable),latest=measured[0];
  const same=latest?measured.filter(row=>row.questionId===latest.questionId&&row.contextKey===latest.contextKey).sort((a,b)=>new Date(a.createdAt).getTime()-new Date(b.createdAt).getTime()):[];
  const first=same[0],last=same.at(-1);
  const trend=first&&last&&first.id!==last.id?{questionId:last.questionId,prompt:last.prompt,before:{id:first.id,createdAt:first.createdAt,analysis:first.analysis},after:{id:last.id,createdAt:last.createdAt,analysis:last.analysis}}:null;
  const contentNext=content.comparisons.find(comparison=>comparison.missingElements.length)||content.comparisons[0];
  const nextVersion=contentNext?.after||content.unpaired[0]?.version;
  const newsNext=newsComparisons.find(comparison=>comparison.sourceQuestionId===nextVersion?.question_id)||(!nextVersion?newsComparisons[0]:null);
  const next=newsNext?{questionId:newsNext.sourceQuestionId,prompt:newsNext.prompt,reason:'같은 기사에 대한 생각을 면접 답변으로 다시 말해 보세요.',href:newsNext.retryHref}:nextVersion?{questionId:nextVersion.question_id,prompt:nextVersion.question||'이 질문 다시 말하기',reason:growthNextReason(nextVersion,contentNext),href:learningRetryHref(nextVersion.question_id,nextVersion as any)}:
    {questionId:null,prompt:'녹음으로 첫 발화 남기기',reason:'녹음이 쌓이면 쉼과 반복의 변화를 비교할 수 있어요.',href:'/interview/new?kind=video'+(scope.targetId?'&targetId='+encodeURIComponent(scope.targetId):'')};
  return {speech:{status:measured.length?'measured':eligibleRecordings.some(row=>row.analysis.timing)?'partial':'not_measured',defaultRecordingId:eligibleRecordings[0]?.id||null,recordings,trend},content:{...content,newsComparisons},next,
    scope:{cutoff,reportId:scope.reportId||null,studySessionId:scope.studySessionId||null},method:{timing:'microphone-rms',content:'quoted-sentence-cues',frozenReportsUnchanged:true}};
}
export async function analyzeOwnedRecording(user:Profile,input:{recordingId:string;kind:'interview'|'quiz';speechTelemetry?:unknown}) {
  studentOnly(user);
  return transaction(async db=>{
    const sql=input.kind==='interview'?"select r.* from media_assets r join interview_sessions s on s.id=r.session_id and s.student_id=r.student_id where r.id=$1 and r.student_id=$2 and r.metadata->>'kind'='answer_recording' and s.state not in ('cancelled','deleted') for update of r":
      'select r.* from quiz_recordings r join quiz_sessions s on s.id=r.session_id and s.student_id=r.student_id where r.id=$1 and r.student_id=$2 for update of r';
    const [row]=(await db.query(sql,[input.recordingId,user.id])).rows;
    if(!row)throw new ApiError(404,'내 녹음을 찾을 수 없어요.');
    let telemetry=row.metadata?.speechTelemetry;
    if(input.speechTelemetry!==undefined) {
      telemetry=validateSpeechTelemetry(input.speechTelemetry);
      if(!telemetry)throw new ApiError(400,'녹음의 시간 측정 형식을 확인해 주세요.');
      const storedDuration=input.kind==='quiz'?Number(row.duration_ms):Number(row.metadata?.durationSeconds||0)*1000;
      if(storedDuration&&Math.abs(storedDuration-telemetry.durationMs)>Math.max(1000,storedDuration*.05))throw new ApiError(400,'저장한 녹음 길이와 분석 길이가 달라요.');
    }
    const analysis=storedAnalysis({...row,metadata:{...row.metadata,speechTelemetry:telemetry}});
    if(!analysis.timing&&!analysis.transcript)throw new ApiError(409,'저장한 음성을 다시 읽어 시간 측정을 준비해 주세요.');
    const hash=createHash('sha256').update(JSON.stringify({digest:row.metadata?.digest,telemetry:telemetry||null,transcript:analysis.transcript?.text||null})).digest('hex');
    await db.query('insert into speech_analysis_versions(student_id,recording_id,recording_kind,source_hash,algorithm_version,analysis) values($1,$2,$3,$4,$5,$6) on conflict do nothing',[user.id,row.id,input.kind,hash,SPEECH_ANALYSIS_VERSION,JSON.stringify(analysis)]);
    const table=input.kind==='interview'?'media_assets':'quiz_recordings';
    await db.query(`update ${table} set metadata=metadata || $3::jsonb where id=$1 and student_id=$2`,[row.id,user.id,JSON.stringify({speechTelemetry:telemetry||null,speechAnalysis:analysis,measurementStatus:analysis.status})]);
    return {recordingId:row.id,analysis};
  });
}

/** Recognized speech stays separate from the student's typed Q&A answer. */
export async function transcribeOwnedQuizRecording(user:Profile,recordingId:string) {
  studentOnly(user);
  return withRecordingTranscriptionLock('quiz:'+user.id+':'+recordingId,async()=>{
    const [row]=await query('select r.* from quiz_recordings r join quiz_sessions s on s.id=r.session_id and s.student_id=r.student_id where r.id=$1 and r.student_id=$2',[recordingId,user.id]);
    if(!row)throw new ApiError(404,'내 녹음을 찾을 수 없어요.');
    const raw=storedRawTranscription(row.metadata?.transcript,row.metadata);
    if(raw&&cachedFormattedTranscription(raw,row.metadata))return {recordingId,...transcriptionResponse(row.metadata,raw.text),cached:true};
    await query("update quiz_recordings set metadata=metadata || jsonb_build_object('transcriptionStatus',$3::text,'cleanupStatus','pending') where id=$1 and student_id=$2",[row.id,user.id,raw?'completed':'processing']);
    async function saveRaw(recognized:RawTranscription) {
      await transaction(async db=>{
        const [latest]=(await db.query('select metadata from quiz_recordings where id=$1 and student_id=$2 for update',[row.id,user.id])).rows;
        if(!latest)throw new ApiError(404,'내 녹음을 찾을 수 없어요.');
        if(latest.metadata?.transcript&&latest.metadata.transcript!==recognized.text)throw new ApiError(409,'원전사는 이미 저장되어 있어요.');
        const analysis=analyzeSpeech({telemetry:latest.metadata?.speechTelemetry,transcript:recognized.text,transcriptSource:recognized.provider});
        await db.query('update quiz_recordings set metadata=metadata || $3::jsonb where id=$1 and student_id=$2',[row.id,user.id,JSON.stringify({transcript:latest.metadata?.transcript||recognized.text,transcriptionStatus:'completed',transcriptionError:null,transcriptionErrorCode:null,cleanupStatus:'pending',transcription:latest.metadata?.transcription||transcriptionDescriptor(recognized),speechAnalysis:analysis,measurementStatus:analysis.status})]);
      });
    }
    try {
      let result;
      if(raw)result=await formatStoredTranscription(user.id,row.session_id,raw);
      else {
        let bytes=row.data as Buffer;
        if(row.metadata?.provider==='supabase') {
          const {data,error}=await (await supabaseServer()).storage.from(row.metadata.bucket).download(row.metadata.path);
          if(error||!data)throw new ApiError(404,'녹음을 가져오지 못했어요.');bytes=Buffer.from(await data.arrayBuffer());
        }
        result=await transcribeStoredAudio(user.id,row.session_id,bytes,row.mime,Number(row.duration_ms)/1000,{speechTelemetry:row.metadata?.speechTelemetry,onRawTranscription:saveRaw});
      }
      await query('update quiz_recordings set metadata=metadata || $3::jsonb where id=$1 and student_id=$2',[row.id,user.id,JSON.stringify({displayTranscript:result.cleanup.status==='completed'?result.displayText:null,transcriptCleanup:result.cleanup,cleanupStatus:result.cleanup.status})]);
      const [saved]=await query('select metadata from quiz_recordings where id=$1 and student_id=$2',[row.id,user.id]);
      return {recordingId,...transcriptionResponse(saved.metadata,saved.metadata.transcript||null),cached:false};
    } catch(error) {
      const message=error instanceof FeatureError?error.message:'전사를 가져오지 못했어요. 녹음은 보관했어요. 다시 시도하거나 직접 입력해 주세요.';
      await query("update quiz_recordings set metadata=metadata || jsonb_build_object('transcriptionStatus',case when length(coalesce(metadata->>'transcript',''))>0 then 'completed' else 'failed' end,'transcriptionError',case when length(coalesce(metadata->>'transcript',''))>0 then null else $3::text end,'transcriptionErrorCode',case when length(coalesce(metadata->>'transcript',''))>0 then null else $4::text end,'cleanupStatus',case when length(coalesce(metadata->>'transcript',''))>0 then 'failed' else 'pending' end) where id=$1 and student_id=$2",[row.id,user.id,message,error instanceof FeatureError?error.code:'TRANSCRIPTION_FAILED']);
      throw error;
    }
  });
}
