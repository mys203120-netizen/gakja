import { requireUser } from '@/lib/auth';
import {getStudentRecords} from '@/lib/student-records';
import {bootstrap,getLearning} from '@/lib/data';
// Legacy compatibility endpoints still use owned bounded read contracts.
import { ApiError, errorResponse,query } from '@/lib/db';
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
    if(root==='dashboard'||root==='me'&&id==='dashboard')return json(await bootstrap(user));
    const recordKinds:Record<string,string>={answers:'answers',reports:'reports',briefings:'briefings',confirmations:'confirmations'};
    if(recordKinds[root]){
      const params=new URL(request.url).searchParams;params.set('kind',recordKinds[root]);
      if(id)params.set(root==='answers'?'questionId':'id',id);
      const result=await getStudentRecords(user.id,params);
      const singular:Record<string,string>={answers:'answer',reports:'report',briefings:'briefing',confirmations:'confirmation'};
      return json(id?{[singular[root]]:'item' in result?result.item:null}:{[root]:'items' in result?result.items:[],page:'page' in result?result.page:null});
    }
    if(root==='history'){const params=new URL(request.url).searchParams;params.set('kind','interviews');const result=await getStudentRecords(user.id,params);return json({interviews:'items' in result?result.items:[],page:'page' in result?result.page:null});}
    if(root==='preferences'){const [row]=await query("select data-array['trainingReview','answer_meaning_checks','trainingActivityNotes','trainingDiagnostics','automaticPractice','briefingThoughts']::text[] as data from student_preferences where student_id=$1",[user.id]);return json({preferences:row?.data||{}});}
    const data=await getLearning(user.id);
    if (root === 'content') return json({ package: data.package, documents: data.documents });
    if (root === 'documents') return json(id ? { document: own(data.documents, id) } : { documents: data.documents });
    if (root === 'activities') return json(id ? { activity: own(data.learning.activities, id) } : { activities: data.learning.activities });
    if (root === 'questions') return json(id ? { question: own(data.learning.questions, id) } : { questions: data.learning.questions });
    if (root === 'memory') {if(id&&id!=='items')return json({item:own(data.learning.memory_items,id)});const params=new URL(request.url).searchParams;params.set('kind','memory');const records=await getStudentRecords(user.id,params);return json({items:data.learning.memory_items,history:'items' in records?records.items:[],page:'page' in records?records.page:null});}
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
