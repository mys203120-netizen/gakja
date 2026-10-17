import { z } from 'zod';
import { checkOrigin, requireUser } from '@/lib/auth';
import { ApiError, errorResponse } from '@/lib/db';
import { prepareRecordingUpload, uploadJson } from '@/lib/recording-upload';
import { recordingUploadSchema } from '@/lib/recording-upload-contract';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const user = await requireUser();
    const input = recordingUploadSchema.parse(await uploadJson(request));
    if (input.kind === 'guidebook' ? !['staff','admin'].includes(user.role) : user.role !== 'student') throw new ApiError(403, '파일을 등록할 계정을 확인해 주세요.');
    const result = await prepareRecordingUpload(user.id, input);
    return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return Response.json({ error: '업로드 정보를 확인해 주세요.' }, { status: 400 });
    return errorResponse(error);
  }
}
