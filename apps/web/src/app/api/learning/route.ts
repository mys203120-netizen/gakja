import { checkOrigin, requireUser } from '@/lib/auth';
import { ApiError, errorResponse } from '@/lib/db';
import { getLearningWorkflows, learningAction } from '@/lib/learning-workflows';

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const studentId = new URL(request.url).searchParams.get('studentId') ?? undefined;
    return Response.json(await getLearningWorkflows(user,studentId),{headers:{'Cache-Control':'private, no-store'}});
  } catch(error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request); const user = await requireUser();
    const length = Number(request.headers.get('content-length') ?? 0);
    if (length > 100_000) throw new ApiError(413,'제출 내용이 너무 커요.');
    const body = await request.text(); if (body.length > 100_000) throw new ApiError(413,'제출 내용이 너무 커요.');
    let value; try { value = JSON.parse(body); } catch { throw new ApiError(400,'요청 형식을 확인해 주세요.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400,'요청 형식을 확인해 주세요.');
    const input = value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload) ? {...value.payload,action:value.action,requestId:value.requestId ?? value.payload.requestId} : value;
    const result = await learningAction(user,input);
    return Response.json({...result,data:await getLearningWorkflows(user,user.role==='student'?undefined:result.studentId)},{headers:{'Cache-Control':'private, no-store'}});
  } catch(error) { return errorResponse(error); }
}
