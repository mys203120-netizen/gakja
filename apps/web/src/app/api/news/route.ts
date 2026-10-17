import { checkOrigin, requireUser } from '@/lib/auth';
import { ApiError, errorResponse } from '@/lib/db';
import { after } from 'next/server';
import { getDepartmentNews, mutateDepartmentNews, newsThoughtHistory, refreshDepartmentNews } from '@/lib/department-news';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: Request) {
  try {
    const user = await requireUser(), params = new URL(request.url).searchParams;
    if (params.get('history') === '1' && params.get('articleId')) return Response.json({ history: await newsThoughtHistory(user, params.get('articleId')!) }, { headers });
    const refresh = params.get('refresh') === '1';
    const snapshot = await getDepartmentNews(user, { targetId: params.get('targetId'), articleId: params.get('articleId'), refresh });
    if (snapshot.refreshDue && snapshot.topic) {
      const topic = snapshot.topic;
      after(async () => {
        try { await refreshDepartmentNews(topic, { force: refresh }); }
        catch { console.error('학과 뉴스 갱신에 실패해 이전 자료를 유지합니다.'); }
      });
    }
    return Response.json(snapshot, { headers });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    checkOrigin(request); const user = await requireUser();
    if (Number(request.headers.get('content-length') || 0) > 32_000) throw new ApiError(413, '기록이 너무 길어요.');
    const body = await request.text(); if (body.length > 32_000) throw new ApiError(413, '기록이 너무 길어요.');
    let input: unknown; try { input = JSON.parse(body); } catch { throw new ApiError(400, '요청 형식을 확인해 주세요.'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, '요청 형식을 확인해 주세요.');
    return Response.json(await mutateDepartmentNews(user, input as Record<string, unknown>), { headers });
  } catch (error) { return errorResponse(error); }
}
