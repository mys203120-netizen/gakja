import { checkOrigin, requireUser } from '@/lib/auth';
import { featureError, requireStudent } from '@/lib/ai';
import { closeQuizRealtimeTranscription, readRealtimeTranscriptionBody, realtimeTranscriptionCloseInput, realtimeTranscriptionInput, startQuizRealtimeTranscription } from '@/lib/realtime-transcription';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const headers = { 'Cache-Control': 'private, no-store' };

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const user = await requireUser(); requireStudent(user);
    const input = realtimeTranscriptionInput.parse(await readRealtimeTranscriptionBody(request));
    return Response.json(await startQuizRealtimeTranscription(user.id, input, request.signal), { headers });
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
    await closeQuizRealtimeTranscription(user.id, input);
    return Response.json({ closed: true }, { headers });
  } catch (error) {
    const result = featureError(error);
    return Response.json({ error: result.error, code: result.code }, { status: result.status, headers });
  }
}
