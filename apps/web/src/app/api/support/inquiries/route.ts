import { checkOrigin, getUser, requireUser } from '@/lib/auth';
import { ApiError, errorResponse, query, transaction } from '@/lib/db';
import { supportConfig } from '@/lib/support-config';
import { InquiryValidationError, readInquiryBody, validateInquiry } from '@/lib/support-inquiry';

const headers = { 'Cache-Control': 'private, no-store' };
async function requireAdmin() {
  const user = await requireUser();
  if (user.role !== 'admin') throw new ApiError(403, '문의는 운영 관리자만 확인할 수 있어요.');
  return user;
}
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    if (request.headers.get('sec-fetch-site') === 'cross-site') throw new ApiError(403, '허용되지 않은 요청이에요.');
    const config = supportConfig();
    if (!config.available) throw new ApiError(503, '문의 창구를 준비하고 있어요. 잠시 후 다시 확인해 주세요.');
    const input = validateInquiry(await readInquiryBody(request));
    const user = await getUser();
    const saved = await transaction(async db => {
      // Shared intake guard also bounds anonymous senders rotating email addresses.
      // Lock before deduplication so concurrent different-email reuse stays a 409.
      await db.query('select pg_advisory_xact_lock(hashtext($1))', ['support:public-intake']);
      const existing = (await db.query('select id,email,type,content,response_time_notice from support_inquiries where request_id=$1', [input.requestId])).rows[0];
      if (existing) {
        if (existing.email !== input.email || existing.type !== input.type || existing.content !== input.content) throw new ApiError(409, '이미 접수된 양식이에요. 새 문의로 작성해 주세요.');
        return { ...existing, duplicate: true };
      }
      const total = (await db.query("select count(*) filter(where created_at>now()-interval '1 hour')::int hourly,count(*)::int daily from support_inquiries where created_at>now()-interval '1 day'")).rows[0];
      if (total.hourly >= 100 || total.daily >= 500) throw new ApiError(429, '현재 문의가 많아요. 잠시 후 다시 접수해 주세요.');
      const count = (await db.query("select count(*) filter (where created_at>now()-interval '1 hour')::int as hourly,count(*)::int as daily from support_inquiries where email=$1 and created_at>now()-interval '1 day'", [input.email])).rows[0];
      if (count.hourly >= 3 || count.daily >= 10) throw new ApiError(429, '문의가 여러 번 접수됐어요. 답변을 기다리거나 잠시 후 다시 보내 주세요.');
      const row = (await db.query('insert into support_inquiries(request_id,student_id,email,type,content,policy_version,response_time_notice,retention_notice) values($1,$2,$3,$4,$5,$6,$7,$8) returning id,email,response_time_notice', [input.requestId, user?.id || null, input.email, input.type, input.content, input.policyVersion, config.responseTime, config.retention])).rows[0];
      return { ...row, duplicate: false };
    });
    return Response.json({ receipt: saved.id, replyChannel: 'email', email: saved.email, responseTime: saved.response_time_notice }, { status: saved.duplicate ? 200 : 201, headers });
  } catch (error) {
    if (error instanceof InquiryValidationError) return Response.json({ error: error.message }, { status: 400, headers });
    return errorResponse(error);
  }
}
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const raw = new URL(request.url).searchParams.get('offset') || '0';
    const offset = Number(raw);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new ApiError(400, '목록 위치를 확인해 주세요.');
    const inquiries = await query('select id,email,type,content,status,policy_version,consented_at,response_time_notice,operator_note,created_at,updated_at from support_inquiries order by created_at desc,id desc limit 31 offset $1', [offset]);
    return Response.json({ inquiries: inquiries.slice(0, 30), hasMore: inquiries.length > 30 }, { headers });
  } catch (error) { return errorResponse(error); }
}
export async function PATCH(request: Request) {
  try {
    checkOrigin(request);
    const user = await requireAdmin();
    const value = await readInquiryBody(request) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || !/^[0-9a-f-]{36}$/i.test(String(value.id)) || !['received', 'in_progress', 'resolved'].includes(String(value.status)) || typeof value.note !== 'string' || value.note.length > 5000) throw new ApiError(400, '처리 상태와 메모를 확인해 주세요.');
    await transaction(async db => {
      const rows = (await db.query('update support_inquiries set status=$2,operator_note=$3,updated_by=$4,updated_at=now() where id=$1 returning id,student_id', [value.id, value.status, value.note, user.id])).rows;
      if (!rows.length) throw new ApiError(404, '문의를 찾을 수 없어요.');
      await db.query('insert into audit_logs(actor_id,student_id,action,data) values($1,$2,$3,$4)', [user.id, rows[0].student_id, 'support.inquiry.updated', JSON.stringify({ inquiryId: value.id, status: value.status })]);
    });
    return Response.json({ ok: true }, { headers });
  } catch (error) {
    if (error instanceof InquiryValidationError) return Response.json({ error: error.message }, { status: 400, headers });
    return errorResponse(error);
  }
}
