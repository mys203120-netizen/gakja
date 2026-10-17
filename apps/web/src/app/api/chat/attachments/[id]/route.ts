import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { query } from '@/lib/db';
import { FeatureError, featureError, requireStudent } from '@/lib/ai';
import { readChatAttachment, type ChatAttachmentRow } from '@/lib/chat-attachments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); requireStudent(user);
    const id = z.string().uuid().parse((await params).id);
    const [row] = await query<ChatAttachmentRow>('select a.* from chat_attachments a left join chat_threads t on t.id=a.thread_id and t.student_id=a.student_id where a.id=$1 and a.student_id=$2 and a.deleted_at is null and (a.thread_id is null or t.deleted_at is null and t.id is not null)', [id, user.id]);
    if (!row) throw new FeatureError(404, '첨부 파일을 찾을 수 없어요.', 'ATTACHMENT_NOT_FOUND');
    const bytes = await readChatAttachment(row);
    return new Response(new Uint8Array(bytes), { headers: {
      'Content-Type': row.mime, 'Content-Length': String(bytes.length), 'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': `attachment; filename="attachment${row.mime === 'application/pdf' ? '.pdf' : ''}"; filename*=UTF-8''${encodeURIComponent(row.name)}`,
    } });
  } catch (error) { const result = featureError(error); return Response.json({ error: result.error, code: result.code }, { status: result.status, headers: { 'Cache-Control': 'private, no-store' } }); }
}
