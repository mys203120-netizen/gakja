import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { checkOrigin, requireUser, supabaseServer } from '@/lib/auth';
import { query, transaction } from '@/lib/db';
import { assertPublishedAccess, completeUsage, FeatureError, featureError, googleSpeechToken, openai, requireStudent, reserveUsage, speechConfigured, speechProvider, type LearningContext } from '@/lib/ai';
import { analyzeSpeech, validateSpeechTelemetry } from '@/lib/speech-analysis';
import { transcribeOwnedInterviewRecording } from '@/lib/interview-transcription';
import { transcriptionResponse,withRecordingTranscriptionLock } from '@/lib/recording-transcription';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;
const MAX_BYTES = 20 * 1024 * 1024;
const mimeTypes = new Set(['video/webm', 'video/mp4', 'audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg']);
function json(value: unknown, status = 200) { return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } }); }
async function ownedSession(studentId: string, sessionId: string, questionId: string, turnId?: string | null) {
  z.string().uuid().parse(sessionId);
  const [session] = await query('select * from interview_sessions where id=$1 and student_id=$2', [sessionId, studentId]);
  if (!session) throw new FeatureError(404, '면접 기록을 찾을 수 없어요.', 'SESSION_NOT_FOUND');
  await assertPublishedAccess(studentId, session.data.context as LearningContext);
  const turns = await query('select * from interview_turns where session_id=$1 and student_id=$2 and question_id=$3 order by created_at desc', [sessionId, studentId, questionId]);
  const turn = turnId ? turns.find((item) => item.id === turnId) : turns[0];
  if (!turn) throw new FeatureError(404, '면접 질문을 찾을 수 없어요.', 'QUESTION_NOT_FOUND');
  return { session, turn };
}

function validateRecording(file: File, bytes: Buffer) {
  const mime = file.type.split(';')[0];
  if (!mimeTypes.has(mime)) throw new FeatureError(415, 'WebM, MP4, MP3, WAV, OGG 형식으로 녹화해 주세요.', 'UNSUPPORTED_MEDIA');
  const signature = bytes.subarray(0, 12);
  const webm = signature.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  const mp4 = signature.subarray(4, 8).toString('ascii') === 'ftyp';
  const wav = signature.subarray(0, 4).toString('ascii') === 'RIFF' && signature.subarray(8, 12).toString('ascii') === 'WAVE';
  const ogg = signature.subarray(0, 4).toString('ascii') === 'OggS';
  const mp3 = signature.subarray(0, 3).toString('ascii') === 'ID3' || signature[0] === 0xff && (signature[1] & 0xe0) === 0xe0;
  if (mime.includes('webm') && !webm || mime.includes('mp4') && !mp4 || mime.includes('wav') && !wav || mime.includes('ogg') && !ogg || mime.includes('mpeg') && !mp3) throw new FeatureError(415, '녹화 파일 형식을 확인해 주세요.', 'MEDIA_FORMAT_MISMATCH');
  return mime;
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(); requireStudent(user);
    const id = z.string().uuid().parse(new URL(request.url).searchParams.get('id'));
    const [asset] = await query('select * from media_assets where id=$1 and student_id=$2', [id, user.id]);
    if (!asset) throw new FeatureError(404, '녹화를 찾을 수 없어요.', 'MEDIA_NOT_FOUND');
    await ownedSession(user.id, asset.session_id, asset.metadata.questionId, asset.metadata.turnId);
    let bytes = asset.data as Buffer;
    if (asset.metadata.provider === 'supabase') {
      const { data, error } = await (await supabaseServer()).storage.from(asset.metadata.bucket).download(asset.metadata.path);
      if (error || !data) throw new FeatureError(404, '녹화를 가져오지 못했어요.', 'MEDIA_UNAVAILABLE');
      bytes = Buffer.from(await data.arrayBuffer());
    }
    const range = request.headers.get('range');
    const headers = { 'Content-Type': asset.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes', 'Content-Disposition': 'inline' };
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || !match[1] && !match[2]) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${bytes.length}` } });
      const start = match[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match[2]));
      const end = match[1] && match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
      if (start > end || start >= bytes.length) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${bytes.length}` } });
      return new Response(new Uint8Array(bytes.subarray(start, end + 1)), { status: 206, headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } });
    }
    return new Response(new Uint8Array(bytes), { headers: { ...headers, 'Content-Length': String(bytes.length) } });
  } catch (error) { const result = featureError(error); return json({ error: result.error, code: result.code }, result.status); }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request); const user = await requireUser(); requireStudent(user);
    if (request.headers.get('content-type')?.includes('application/json')) {
      const input = z.object({ action: z.enum(['speech', 'transcribe']), sessionId: z.string().uuid().optional(), questionId: z.string().min(1).max(160).optional(), turnId: z.string().uuid().optional(), mediaId: z.string().uuid().optional(), generation: z.number().int().nonnegative().optional() }).parse(await request.json());
      if (input.action === 'transcribe') {
        if (!input.mediaId) throw new FeatureError(400, '전사할 녹화를 선택해 주세요.', 'MEDIA_ID_REQUIRED');
        const [originalAsset] = await query('select * from media_assets where id=$1 and student_id=$2', [input.mediaId, user.id]);
        if (!originalAsset) throw new FeatureError(404, '녹화를 찾을 수 없어요.', 'MEDIA_NOT_FOUND');
        await ownedSession(user.id, originalAsset.session_id, originalAsset.metadata.questionId, originalAsset.metadata.turnId);
        return json(await transcribeOwnedInterviewRecording(user.id,originalAsset.id));
      }
      if (!input.sessionId || !input.questionId) throw new FeatureError(400, '면접 질문을 선택해 주세요.', 'QUESTION_REQUIRED');
      const { session, turn } = await ownedSession(user.id, input.sessionId, input.questionId, input.turnId);
      if (session.state !== 'active' || session.data.paused || turn.data.invalidated || turn.data.answer) throw new FeatureError(409, '현재 질문에서 다시 듣기를 선택해 주세요.', 'SPEECH_NOT_ACTIVE');
      if (input.generation !== undefined && input.generation !== Number(session.data.generation || 0)) throw new FeatureError(409, '질문 상태가 바뀌었어요.', 'STALE_GENERATION');
      const bytes = await questionSpeech(user.id, session, turn);
      return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, no-store', 'X-AI-Generated-Audio': 'true' } });
    }
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > MAX_BYTES * 2 + 65536) throw new FeatureError(413, '녹화는 파일당 20MB까지 저장할 수 있어요.', 'MEDIA_TOO_LARGE');
    const form = await request.formData();
    const file = form.get('recording');
    if (!(file instanceof File) || !file.size) throw new FeatureError(400, '녹화 파일을 선택해 주세요.', 'MEDIA_REQUIRED');
    if (file.size > MAX_BYTES) throw new FeatureError(413, '녹화는 파일당 20MB까지 저장할 수 있어요.', 'MEDIA_TOO_LARGE');
    if (form.get('consent') !== 'true') throw new FeatureError(400, '녹화와 비공개 저장에 동의해 주세요.', 'RECORDING_CONSENT_REQUIRED');
    const sessionId = z.string().uuid().parse(form.get('sessionId'));
    const questionId = z.string().min(1).max(160).parse(form.get('questionId'));
    const turnId = form.get('turnId') ? z.string().uuid().parse(form.get('turnId')) : null;
    const { session, turn } = await ownedSession(user.id, sessionId, questionId, turnId);
    if (session.state !== 'active') throw new FeatureError(409, '종료된 면접에는 새 녹화를 저장할 수 없어요.', 'SESSION_ENDED');
    if (turn.data.answer || turn.data.invalidated) throw new FeatureError(409, '현재 답변의 녹화를 저장해 주세요.', 'STALE_TURN');
    const generation = form.get('generation') ? z.coerce.number().int().nonnegative().parse(form.get('generation')) : Number(session.data.generation || 0);
    if (generation !== Number(session.data.generation || 0)) throw new FeatureError(409, '녹화 중 질문 상태가 바뀌었어요.', 'STALE_GENERATION');
    const durationSeconds = z.coerce.number().finite().min(0).max(1200).parse(form.get('durationSeconds') || 0);
    const telemetryValue = form.get('speechTelemetry');
    let speechTelemetry = null;
    if (typeof telemetryValue === 'string' && telemetryValue) {
      if (telemetryValue.length > 65_536) throw new FeatureError(413, '음성 시간 측정 자료가 너무 커요.', 'TELEMETRY_TOO_LARGE');
      let value; try { value = JSON.parse(telemetryValue); } catch { throw new FeatureError(400, '음성 시간 측정 형식을 확인해 주세요.', 'INVALID_TELEMETRY'); }
      speechTelemetry = validateSpeechTelemetry(value);
      if (!speechTelemetry || Math.abs(speechTelemetry.durationMs - durationSeconds * 1000) > 1000) throw new FeatureError(400, '녹음 길이와 시간 측정이 일치하지 않아요.', 'INVALID_TELEMETRY');
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const mime = validateRecording(file, bytes);
    const analysisAudio = form.get('analysisAudio');
    let audioBytes: Buffer | null = mime.startsWith('audio/') ? bytes : null;
    let audioMime = mime;
    if (analysisAudio instanceof File && analysisAudio.size) {
      if (analysisAudio.size > MAX_BYTES) throw new FeatureError(413, '분석 음성은 20MB까지 업로드해 주세요.', 'ANALYSIS_AUDIO_TOO_LARGE');
      audioBytes = Buffer.from(await analysisAudio.arrayBuffer());
      audioMime = validateRecording(analysisAudio, audioBytes);
      if (!audioMime.startsWith('audio/')) throw new FeatureError(415, '분석 음성 파일을 별도로 녹음해 주세요.', 'ANALYSIS_AUDIO_REQUIRED');
    }
    const digest = createHash('sha256').update(bytes).update(audioBytes || Buffer.alloc(0)).digest('hex');
    const stored=await withRecordingTranscriptionLock('upload:'+user.id+':'+turn.id+':'+digest,async()=>{
    const [existing] = await query("select id,mime,text,metadata from media_assets where student_id=$1 and session_id=$2 and metadata->>'turnId'=$3 and metadata->>'digest'=$4 and metadata->>'kind'='answer_recording' order by created_at desc limit 1", [user.id, sessionId, turn.id, digest]);
    if (existing) return {id:existing.id,mime:existing.mime,metadata:existing.metadata};
    const id = randomUUID();
    const analysisMediaId = !mime.startsWith('audio/') && audioBytes ? randomUUID() : null;
    const speechAnalysis = analyzeSpeech({telemetry:speechTelemetry});
    const metadata: Record<string, unknown> = { kind: 'answer_recording', digest, questionId, turnId: turn.id, size: bytes.length, consentAt: new Date().toISOString(), measurementStatus: speechAnalysis.status, speechTelemetry, speechAnalysis, transcriptionStatus: audioBytes ? 'pending' : 'audio_required', provider: 'postgresql', analysisMediaId, durationSeconds, generation };
    await persistAsset(user.id, sessionId, id, bytes, mime, metadata);
    if (analysisMediaId && audioBytes) await persistAsset(user.id, sessionId, analysisMediaId, audioBytes, audioMime, { ...metadata, kind: 'analysis_audio', size: audioBytes.length, analysisMediaId: null, analysisFor: id });
    return {id,mime,metadata};
    });
    let result:Record<string,any>=transcriptionResponse(stored.metadata);
    if(audioBytes) {
      try {result=await transcribeOwnedInterviewRecording(user.id,stored.id);}
      catch(error) {
        const [saved]=await query('select text,metadata from media_assets where id=$1 and student_id=$2',[stored.id,user.id]);
        result={...transcriptionResponse(saved?.metadata||stored.metadata,saved?.text||null),pipelineError:featureError(error).error};
      }
    }
    const [saved]=await query('select metadata from media_assets where id=$1 and student_id=$2',[stored.id,user.id]);
    return json({ media: { id:stored.id, session_id: sessionId, mime:stored.mime, metadata:saved?.metadata||stored.metadata, url: `/api/media?id=${stored.id}` }, ...result });
  } catch (error) { const result = featureError(error); return json({ error: result.error, code: result.code }, result.status); }
}

async function persistAsset(studentId: string, sessionId: string, id: string, bytes: Buffer, mime: string, metadata: Record<string, unknown>) {
  let dbBytes = bytes;
  if (process.env.AUTH_MODE === 'supabase') {
    const bucket = process.env.SUPABASE_MEDIA_BUCKET || 'student-media';
    const path = `${studentId}/${sessionId}/${id}.${mime.split('/')[1].replace('x-', '')}`;
    const { error } = await (await supabaseServer()).storage.from(bucket).upload(path, bytes, { contentType: mime, upsert: false });
    if (error) throw new FeatureError(502, '비공개 녹화 저장에 실패했어요. Storage 설정을 확인해 주세요.', 'STORAGE_UPLOAD_FAILED');
    metadata.provider = 'supabase'; metadata.bucket = bucket; metadata.path = path; dbBytes = Buffer.alloc(0);
  }
  try {
    await query('insert into media_assets(id,student_id,session_id,data,mime,metadata) values($1,$2,$3,$4,$5,$6)', [id, studentId, sessionId, dbBytes, mime, JSON.stringify(metadata)]);
  } catch (error) {
    if (metadata.provider === 'supabase') await (await supabaseServer()).storage.from(String(metadata.bucket)).remove([String(metadata.path)]);
    throw error;
  }
}

async function questionSpeech(studentId: string, session: Record<string, any>, turn: Record<string, any>) {
  const selected = speechProvider();
  const speaker = (session.data.panelists || []).find((person: Record<string, any>) => person.id === turn.data.speakerId);
  const voice = selected === 'google' ? speaker?.voice || process.env.GOOGLE_TTS_VOICE_FEMALE || 'ko-KR-Chirp3-HD-Aoede' : speaker?.gender === 'male' ? 'onyx' : 'nova';
  const model = selected === 'google' ? 'chirp3-hd' : process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
  const locale = process.env.GOOGLE_TTS_LANGUAGE_CODE || 'ko-KR';
  const input = String(turn.data.question).slice(0, 2500);
  const cacheKey = createHash('sha256').update(JSON.stringify({ studentId, turnId: turn.id, input, selected, voice, model, locale })).digest('hex');
  return transaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`question-voice:${studentId}:${cacheKey}`]);
    const saved = await client.query("select * from media_assets where student_id=$1 and session_id=$2 and metadata->>'kind'='question_voice' and metadata->>'cacheKey'=$3 limit 1", [studentId, session.id, cacheKey]);
    const cached = saved.rows[0];
    if (cached) {
      if (cached.metadata.provider !== 'supabase') return cached.data as Buffer;
      const { data, error } = await (await supabaseServer()).storage.from(cached.metadata.bucket).download(cached.metadata.path);
      if (error || !data) throw new FeatureError(502, '질문 음성을 가져오지 못했어요.', 'SPEECH_UNAVAILABLE');
      return Buffer.from(await data.arrayBuffer());
    }
    if (!speechConfigured()) throw new FeatureError(503, '음성 연결을 준비 중이에요. 질문을 읽고 이어가 주세요.', 'SPEECH_NOT_CONFIGURED');
    const usageId = await reserveUsage(studentId, 'speech', session.id, `${selected}:${model}:${voice}`);
    try {
      let bytes: Buffer;
      if (selected === 'google') {
        const response = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', { method: 'POST', headers: { Authorization: `Bearer ${await googleSpeechToken()}`, 'Content-Type': 'application/json', ...(process.env.GOOGLE_CLOUD_PROJECT ? { 'X-Goog-User-Project': process.env.GOOGLE_CLOUD_PROJECT } : {}) }, body: JSON.stringify({ input: { text: input }, voice: { languageCode: locale, name: voice }, audioConfig: { audioEncoding: 'MP3' } }), signal: AbortSignal.timeout(40000) });
        if (!response.ok) throw new Error('Speech synthesis failed');
        const result = await response.json(); if (typeof result.audioContent !== 'string') throw new Error('Speech synthesis failed'); bytes = Buffer.from(result.audioContent, 'base64');
      } else {
        const audio = await openai().audio.speech.create({ model, voice, input, response_format: 'mp3' }); bytes = Buffer.from(await audio.arrayBuffer());
      }
      const [latest] = await query('select state,data from interview_sessions where id=$1 and student_id=$2', [session.id, studentId]);
      if (!latest || latest.state !== 'active' || latest.data.paused || Number(latest.data.generation || 0) !== Number(session.data.generation || 0)) throw new FeatureError(409, '질문 상태가 바뀌었어요.', 'STALE_GENERATION');
      await persistAsset(studentId, session.id, randomUUID(), bytes, 'audio/mpeg', { kind: 'question_voice', questionId: turn.question_id, turnId: turn.id, speakerId: speaker?.id || 'A', voiceId: voice, model, speechProvider: selected, locale, cacheKey, size: bytes.length, aiGenerated: true, provider: 'postgresql' });
      await completeUsage(usageId, 'completed'); return bytes;
    } catch (error) { await completeUsage(usageId, 'failed'); if (error instanceof FeatureError) throw error; throw new FeatureError(502, '질문 음성을 가져오지 못했어요. 질문을 읽고 이어가 주세요.', 'SPEECH_FAILED'); }
  });
}

