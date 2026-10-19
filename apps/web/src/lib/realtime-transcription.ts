import 'server-only';
import { z } from 'zod';
import { aiEnabled, completeUsage, FeatureError, reserveUsage } from './ai';
import { query } from './db';
import { withRecordingTranscriptionLock } from './recording-transcription';

export const REALTIME_TRANSCRIPTION_MODEL = 'gpt-live-transcribe';
const FEATURE = 'quiz_realtime_transcription';
const MAX_BODY_BYTES = 65_536;
const CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const uuid = z.string().uuid();
const scopeSchema = z.object({ sessionId: uuid, itemIndex: z.number().int().min(0).max(10_000), attemptId: uuid });
export const realtimeTranscriptionInput = scopeSchema.extend({
  consent: z.literal(true),
  sdp: z.string().min(20).max(60_000).refine(value => value.startsWith('v=0') && value.includes('m=audio'), 'Invalid audio offer'),
});
export const realtimeTranscriptionCloseInput = scopeSchema.extend({ callId: z.string().regex(/^rtc_[a-zA-Z0-9_-]{1,150}$/) });
type RealtimeScope = z.infer<typeof scopeSchema>;
type RealtimeInput = z.infer<typeof realtimeTranscriptionInput>;
type CloseInput = z.infer<typeof realtimeTranscriptionCloseInput>;
type ActiveQuiz = { id: string; revision: number };

function contextId(input: RealtimeScope) { return `quiz-rt:${input.sessionId}:${input.itemIndex}:${input.attemptId}`; }
function questionContext(input: RealtimeScope) { return `quiz-rt:${input.sessionId}:${input.itemIndex}:`; }
function cancelled() { return new FeatureError(499, '실시간 전사 연결을 멈췄어요.', 'REALTIME_CANCELLED'); }
function checkSignal(signal: AbortSignal) { if (signal.aborted) throw cancelled(); }

/** Bound actual streamed bytes too: Content-Length can be absent or incorrect. */
async function boundedText(body: ReadableStream<Uint8Array> | null, maxBytes: number) {
  if (!body) return '';
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new FeatureError(413, '실시간 전사 연결 정보가 너무 커요.', 'REALTIME_REQUEST_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export async function readRealtimeTranscriptionBody(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new FeatureError(415, '전사 연결 정보를 확인해 주세요.', 'REALTIME_INVALID_CONTENT_TYPE');
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY_BYTES) throw new FeatureError(413, '실시간 전사 연결 정보가 너무 커요.', 'REALTIME_REQUEST_TOO_LARGE');
  try { return JSON.parse(await boundedText(request.body, MAX_BODY_BYTES)); }
  catch (error) {
    if (error instanceof FeatureError) throw error;
    throw new FeatureError(400, '전사 연결 정보를 확인해 주세요.', 'REALTIME_INVALID_INPUT');
  }
}

/** Recheck the active profile together with the owned, unanswered current item. */
async function activeQuiz(studentId: string, input: RealtimeScope): Promise<ActiveQuiz> {
  const [session] = await query('select s.id,s.state,s.mode,s.current_index,s.revision,jsonb_array_length(s.items) as total from quiz_sessions s join profiles p on p.id=s.student_id and p.active=true where s.id=$1 and s.student_id=$2', [input.sessionId, studentId]);
  if (!session) throw new FeatureError(404, '퀴즈 기록을 찾을 수 없어요.', 'QUIZ_NOT_FOUND');
  if (session.state !== 'active' || session.mode === 'choice' || session.current_index !== input.itemIndex || input.itemIndex >= session.total) throw new FeatureError(409, '현재 녹음 질문에서 다시 시작해 주세요.', 'REALTIME_QUIZ_CHANGED');
  return session;
}

async function reserveRealtimeUsage(studentId: string, input: RealtimeScope) {
  // The shared DB advisory lock covers the cooldown read and daily reservation
  // across instances; daily accounting remains in the normal AI quota function.
  return withRecordingTranscriptionLock(`realtime-reserve:${studentId}`, async () => {
    const [recent] = await query("select count(*)::int as count,count(*) filter(where context_id=$2 or context_id like $2||':%')::int as attempt_count,coalesce(bool_or(created_at>now()-interval '3 seconds' and context_id like $3||'%'),false) as question_cooldown from ai_usage_logs where student_id=$1 and feature=$4 and created_at>now()-interval '1 minute'", [studentId, contextId(input), questionContext(input), FEATURE]);
    if (Number(recent?.attempt_count || 0) > 0) throw new FeatureError(409, '이미 연결한 녹음이에요. 새 녹음에서 다시 시작해 주세요.', 'REALTIME_ATTEMPT_USED');
    if (Number(recent?.count || 0) >= 6 || recent?.question_cooldown) throw new FeatureError(429, '전사를 다시 연결하기 전에 잠시 기다려 주세요. 녹음은 계속할 수 있어요.', 'REALTIME_RATE_LIMIT');
    return reserveUsage(studentId, FEATURE, contextId(input), `openai:${REALTIME_TRANSCRIPTION_MODEL}`);
  });
}

function upstreamCallId(response: Response): string | null {
  const location = response.headers.get('location');
  if (!location) return null;
  try {
    const url = new URL(location, CALLS_URL);
    if (url.origin !== 'https://api.openai.com') return null;
    return /^\/v1\/realtime\/calls\/(rtc_[a-zA-Z0-9_-]{1,150})$/.exec(url.pathname)?.[1] || null;
  } catch { return null; }
}

async function hangup(callId: string) {
  try {
    const result = await fetch(`${CALLS_URL}/${encodeURIComponent(callId)}/hangup`, {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY?.trim()}` }, signal: AbortSignal.timeout(8_000),
    });
    // Hanging up twice or after the peer has disconnected is harmless.
    if (!result.ok && result.status !== 404 && result.status !== 409) throw new Error('Hangup unavailable');
  } catch {
    throw new FeatureError(502, '전사 연결 종료를 다시 시도해 주세요.', 'REALTIME_CLOSE_FAILED');
  }
}

/** SDP is negotiated by our server; the permanent credential never reaches the browser. */
export async function startQuizRealtimeTranscription(studentId: string, input: RealtimeInput, signal: AbortSignal) {
  checkSignal(signal);
  const before = await activeQuiz(studentId, input);
  if (!aiEnabled()) throw new FeatureError(503, '실시간 전사 연결을 준비 중이에요. 녹음 후 전사를 이용해 주세요.', 'REALTIME_NOT_CONFIGURED');
  const usageId = await reserveRealtimeUsage(studentId, input);
  let callId: string | null = null;
  try {
    checkSignal(signal);
    const form = new FormData();
    form.set('sdp', input.sdp);
    form.set('session', JSON.stringify({
      type: 'transcription',
      audio: { input: { transcription: { model: REALTIME_TRANSCRIPTION_MODEL, languages: ['ko'], delay: 'low' }, turn_detection: null } },
    }));
    const response = await fetch(CALLS_URL, {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY?.trim()}` }, body: form,
      signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
    });
    callId = upstreamCallId(response);
    if (!response.ok || !callId) throw new FeatureError(502, '실시간 전사를 연결하지 못했어요. 녹음 후 전사로 이어갈 수 있어요.', 'REALTIME_CONNECT_FAILED');
    const sdp = await boundedText(response.body, MAX_BODY_BYTES);
    if (!sdp.startsWith('v=0') || !sdp.includes('m=audio')) throw new FeatureError(502, '실시간 전사를 연결하지 못했어요. 녹음 후 전사로 이어갈 수 있어요.', 'REALTIME_CONNECT_FAILED');
    checkSignal(signal);
    const after = await activeQuiz(studentId, input);
    if (after.revision !== before.revision) throw new FeatureError(409, '녹음 질문 상태가 바뀌었어요. 다시 시작해 주세요.', 'REALTIME_QUIZ_CHANGED');
    await query('update ai_usage_logs set context_id=$3,status=$4 where id=$1 and student_id=$2', [usageId, studentId, `${contextId(input)}:${callId}`, 'connected']);
    checkSignal(signal);
    return { sdp, callId };
  } catch (error) {
    if (callId) await hangup(callId).catch(() => {});
    await completeUsage(usageId, 'failed').catch(() => {});
    if (signal.aborted) throw cancelled();
    if (error instanceof FeatureError) throw error;
    throw new FeatureError(502, '실시간 전사를 연결하지 못했어요. 녹음 후 전사로 이어갈 수 있어요.', 'REALTIME_CONNECT_FAILED');
  }
}

/** Only an exact issued call for this student/attempt can be closed, including after pausing. */
export async function closeQuizRealtimeTranscription(studentId: string, input: CloseInput) {
  const [usage] = await query('select id,status from ai_usage_logs where student_id=$1 and feature=$2 and context_id=$3 order by created_at desc limit 1', [studentId, FEATURE, `${contextId(input)}:${input.callId}`]);
  if (!usage) throw new FeatureError(404, '전사 연결을 찾을 수 없어요.', 'REALTIME_CALL_NOT_FOUND');
  if (usage.status === 'completed') return;
  await hangup(input.callId);
  await completeUsage(usage.id, 'completed');
}
