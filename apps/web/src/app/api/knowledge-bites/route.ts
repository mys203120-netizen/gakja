import { checkOrigin, requireUser } from '@/lib/auth';
import { ApiError, errorResponse } from '@/lib/db';
import { getKnowledgeBites, mutateKnowledgeBite } from '@/lib/knowledge-bites';
const privateHeaders = { 'Cache-Control': 'private, no-store' };
export async function GET(request: Request) {
  try { const params = new URL(request.url).searchParams; return Response.json(await getKnowledgeBites(await requireUser(), params.get('videoId'), params.get('questionId'),params.get('targetId')), { headers: privateHeaders }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const user = await requireUser();
    if (Number(request.headers.get('content-length') ?? 0) > 32_000) throw new ApiError(413, '메모가 너무 길어요.');
    const text = await request.text();
    if (text.length > 32_000) throw new ApiError(413, '메모가 너무 길어요.');
    let input: unknown; try { input = JSON.parse(text); } catch { throw new ApiError(400, '요청 형식을 확인해 주세요.'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, '요청 형식을 확인해 주세요.');
    return Response.json(await mutateKnowledgeBite(user, input as Record<string, unknown>), { headers: privateHeaders });
  } catch (error) { return errorResponse(error); }
}
