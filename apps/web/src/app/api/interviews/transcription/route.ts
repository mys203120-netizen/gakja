import { checkOrigin, requireUser } from '@/lib/auth';
import { aiEnabled,featureError, requireStudent } from '@/lib/ai';
import { closeInterviewRealtimeTranscription, readRealtimeTranscriptionBody, realtimeTranscriptionCloseInput, realtimeTranscriptionInput, startInterviewRealtimeTranscription } from '@/lib/interview-realtime-transcription';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const headers = { 'Cache-Control': 'private, no-store' };

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const user = await requireUser(); requireStudent(user);
    const input = realtimeTranscriptionInput.parse(await readRealtimeTranscriptionBody(request));
    return Response.json(await startInterviewRealtimeTranscription(user.id, input, request.signal), { headers });
  } catch (error) {
    const result = featureError(error);
    return Response.json({ error: result.error, code: result.code }, { status: result.status, headers });
  }
}

export async function DELETE(request: Request) {
  try {
    checkOrigin(request);
    const user = await requireUser(); requireStudent(user);
    const input = realtimeTranscriptionCloseInput.parse(await readRealtimeTranscriptionBody(request));
    await closeInterviewRealtimeTranscription(user.id, input);
    return Response.json({ closed: true }, { headers });
  } catch (error) {
    const result = featureError(error);
    return Response.json({ error: result.error, code: result.code }, { status: result.status, headers });
  }
}

export async function GET(){const user=await requireUser();requireStudent(user);return Response.json({enabled:aiEnabled()&&process.env.INTERVIEW_LIVE_TRANSCRIPTION_ENABLED==='true'},{headers});}
