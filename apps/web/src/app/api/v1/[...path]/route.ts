import { requireUser } from '@/lib/auth';
import { bootstrap } from '@/lib/data';
import { ApiError, errorResponse } from '@/lib/db';
import { GET as chatGet, POST as chatPost } from '@/app/api/chat/route';
import { GET as interviewsGet, POST as interviewsPost } from '@/app/api/interviews/route';
import { GET as answersHistory, POST as actionsPost } from '@/app/api/actions/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Context = { params: Promise<{ path: string[] }> };
function json(value: unknown) { return Response.json(value, { headers: { 'Cache-Control': 'private, no-store' } }); }
async function student() { const user = await requireUser(); if (user.role !== 'student') throw new ApiError(403, '학생 전용 API예요.'); return user; }
function withQuery(request: Request, key: string, value?: string) {
  const url = new URL(request.url); if (value) url.searchParams.set(key, value);
  return new Request(url, { method: 'GET', headers: request.headers });
}
function withBody(request: Request, value: unknown) { return new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(value) }); }
function own(items: any[], id: string, field = 'id') { const item = items.find((i) => i[field] === id); if (!item) throw new ApiError(404, '자료를 찾을 수 없어요.'); return item; }

export async function GET(request: Request, context: Context) {
  try {
    const user = await student(), paths = (await context.params).path;
    const [root, id, detail] = paths;
    if (root === 'chat') return chatGet(withQuery(request, 'threadId', id === 'threads' ? detail : id));
    if (root === 'interviews') return interviewsGet(withQuery(request, 'id', id));
    if (root === 'answers' && id && detail === 'versions') return answersHistory(withQuery(request, 'questionId', id));
    const data = await bootstrap(user);
    if ('admin' in data) throw new ApiError(403, '학생 전용 API예요.');
    if (root === 'dashboard' || root === 'me' && id === 'dashboard') return json(data);
    if (root === 'content') return json({ package: data.package, documents: data.documents });
    if (root === 'documents') return json(id ? { document: own(data.documents, id) } : { documents: data.documents });
    if (root === 'activities') return json(id ? { activity: own(data.learning.activities, id) } : { activities: data.learning.activities });
    if (root === 'questions') return json(id ? { question: own(data.learning.questions, id) } : { questions: data.learning.questions });
    if (root === 'answers') { if (id && !data.answers.some((a) => a.question_id === id)) own(data.learning.questions, id); return json(id ? { answer: data.answers.find((a) => a.question_id === id) ?? null } : { answers: data.answers }); }
    if (root === 'memory') return json(id && id !== 'items' ? { item: own(data.learning.memory_items, id) } : { items: data.learning.memory_items, attempts: data.memoryAttempts, history: data.memoryHistory });
    if (root === 'reports') return json(id ? { report: own(data.reports, id) } : { reports: data.reports });
    if (root === 'history') return json({ interviews: data.interviews, memoryHistory: data.memoryHistory });
    if (root === 'briefings') return json(id ? { briefing: own(data.briefings ?? [], id) } : { briefings: data.briefings });
    if (root === 'preferences') return json({ preferences: data.preferences });
    if (root === 'confirmations') return json(id ? { confirmation: own(data.confirmations, id) } : { confirmations: data.confirmations });
    throw new ApiError(404, 'API 경로를 확인해 주세요.');
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    await student(); const [root, id, detail, operation] = (await context.params).path;
    const raw = await request.text(); let payload: any;
    try { payload = raw.trim() ? JSON.parse(raw) : {}; } catch { throw new ApiError(400, 'JSON 요청을 확인해 주세요.'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ApiError(400, '요청 형식을 확인해 주세요.');
    if (root === 'chat') {
      if (id === 'threads' && detail && operation !== 'messages') throw new ApiError(404, '지원하지 않는 대화 작업이에요.');
      return chatPost(withBody(request, { ...payload, ...(id === 'threads' && detail ? { threadId: detail } : {}) }));
    }
    if (root === 'interviews') {
      if (id && !['turns','finish'].includes(detail)) throw new ApiError(404, '지원하지 않는 면접 작업이에요.');
      return interviewsPost(withBody(request, { ...payload, action: id ? detail === 'turns' ? 'answer' : 'finish' : 'start', ...(id ? { sessionId: id } : {}) }));
    }
    const action: Record<string, string> = { answers: 'save_answer', memory: 'memory_attempt', preferences: 'preference', confirmations: 'confirmation' };
    if (!action[root]) throw new ApiError(404, 'API 경로를 확인해 주세요.');
    // Keep original authentication and Origin headers. The existing mutation
    // handler performs its own role, ownership and CSRF checks again.
    if (root === 'answers' && id) payload.questionId = id;
    if (root === 'confirmations' && id) { if (detail !== 'respond') throw new ApiError(404, '지원하지 않는 확인 작업이에요.'); payload.id = id; }
    return actionsPost(withBody(request, { action: action[root], payload }));
  } catch (error) { return errorResponse(error); }
}
export const PATCH = POST;
