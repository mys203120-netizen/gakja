import 'server-only';
import { Pool } from 'pg';
import { transcriptCleanupModel, TRANSCRIPT_CLEANUP_PROMPT_VERSION, TRANSCRIPT_VERBATIM_PROMPT_VERSION, transcriptRawHash } from './transcript-cleanup';
import type { RawTranscription, StoredTranscription } from './speech-transcription';
const shared=globalThis as unknown as {gakjaTranscriptionLockPool?:Pool};
const lockPool=shared.gakjaTranscriptionLockPool??new Pool({connectionString:process.env.DATABASE_URL,max:10,idleTimeoutMillis:30000,connectionTimeoutMillis:10000,ssl:process.env.DATABASE_SSL==='true'?{rejectUnauthorized:true}:false});
if(process.env.NODE_ENV!=='production')shared.gakjaTranscriptionLockPool=lockPool;
export async function closeRecordingTranscriptionLocks(){await lockPool.end();if(shared.gakjaTranscriptionLockPool===lockPool)delete shared.gakjaTranscriptionLockPool;}

/** A session lock, rather than a long transaction, lets raw STT commit before formatting. */
export async function withRecordingTranscriptionLock<T>(key:string,work:()=>Promise<T>):Promise<T> {
  const db=await lockPool.connect();
  try {
    await db.query('select pg_advisory_lock(hashtext($1))',['recording-transcription:'+key]);
    return await work();
  } finally {
    try {await db.query('select pg_advisory_unlock(hashtext($1))',['recording-transcription:'+key]);} finally {db.release();}
  }
}

export function storedRawTranscription(text:unknown,metadata:Record<string,any>):RawTranscription|null {
  if(typeof text!=='string'||!text.trim())return null;
  const descriptor=metadata?.transcription||{};
  return {text,provider:descriptor.provider||'stored_stt',modelId:descriptor.modelId||'legacy',alignmentStatus:descriptor.alignmentStatus==='word'?'word':'answer_only',words:Array.isArray(descriptor.words)?descriptor.words:[]};
}

export function cachedFormattedTranscription(raw:RawTranscription,metadata:Record<string,any>):StoredTranscription|null {
  const cleanup=metadata?.transcriptCleanup;
  if(cleanup?.status!=='completed'||typeof metadata.displayTranscript!=='string'||!metadata.displayTranscript.trim()||cleanup.rawHash!==transcriptRawHash(raw.text))return null;
  if(process.env.TRANSCRIPT_CLEANUP_ENABLED!=='true'){
    if(cleanup.modelId!=='verbatim'||cleanup.promptVersion!==TRANSCRIPT_VERBATIM_PROMPT_VERSION||metadata.displayTranscript!==raw.text)return null;
  }else if(cleanup.modelId!==transcriptCleanupModel()||cleanup.promptVersion!==TRANSCRIPT_CLEANUP_PROMPT_VERSION)return null;
  return {...raw,rawText:raw.text,displayText:metadata.displayTranscript,cleanup};
}

/** Only finished formatting is the normal answer text; raw speech remains separately inspectable. */
export function transcriptionResponse(metadata:Record<string,any>,rawText:string|null=null) {
  const cleanup=metadata?.transcriptCleanup;
  const cleanupError=cleanup?.status==='disabled'?'문장 정리가 꺼져 있어요. 원전사를 확인하거나 직접 입력해 주세요.':cleanup?.error==='AI_DAILY_LIMIT'?'오늘 문장 정리 횟수를 모두 사용했어요. 원전사는 보관했어요.':cleanup?.error==='CLEANUP_UNSUPPORTED_CHANGE'?'정리 결과가 원문과 달라 저장하지 않았어요. 다시 시도하거나 원전사를 확인해 주세요.':cleanup?.error?'문장 정리를 마치지 못했어요. 원전사는 보관했어요.':null;
  return {transcript:cleanup?.status==='completed'&&typeof metadata.displayTranscript==='string'?metadata.displayTranscript:null,
    rawTranscript:rawText,transcriptionStatus:metadata?.transcriptionStatus||'pending',cleanupStatus:cleanup?.status||metadata?.cleanupStatus||'pending',
    transcriptionError:metadata?.transcriptionError||null,cleanupError,cleanupCode:cleanup?.error||null};
}

export function transcriptionDescriptor(raw:RawTranscription) {
  return {provider:raw.provider,modelId:raw.modelId,alignmentStatus:raw.alignmentStatus,words:raw.words,locale:'ko-KR'};
}
