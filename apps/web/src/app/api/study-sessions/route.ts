import { checkOrigin, requireUser } from '@/lib/auth';
import { ApiError, errorResponse } from '@/lib/db';
import { getStudySessions, studySessionAction } from '@/lib/study-sessions';
const headers = {'Cache-Control':'private, no-store'};
export async function GET(request: Request) {
  try { return Response.json(await getStudySessions(await requireUser(),new URL(request.url).searchParams.get('id')),{headers}); }
  catch(error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    checkOrigin(request); const user = await requireUser();
    const body = await request.text(); if(body.length>4_000) throw new ApiError(413,'요청 내용이 너무 커요.');
    let value; try {value=JSON.parse(body);} catch {throw new ApiError(400,'요청 형식을 확인해 주세요.');}
    return Response.json(await studySessionAction(user,value),{headers});
  } catch(error) { return errorResponse(error); }
}
