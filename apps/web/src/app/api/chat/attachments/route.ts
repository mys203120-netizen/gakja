import { z } from 'zod';
import { checkOrigin, requireUser } from '@/lib/auth';
import { query } from '@/lib/db';
import { FeatureError, featureError, requireStudent } from '@/lib/ai';
import { CHAT_ATTACHMENT_MAX_BYTES, CHAT_ATTACHMENT_MAX_FILES, chatAttachmentView, discardChatAttachment, storeChatAttachment, validateChatAttachment, type ChatAttachmentRow } from '@/lib/chat-attachments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
function json(value: unknown, status = 200) { return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } }); }
async function boundedForm(request: Request) {
  if (!request.body) throw new FeatureError(400, '첨부 파일을 선택해 주세요.', 'ATTACHMENT_FORM_REQUIRED');
  const reader = request.body.getReader(), chunks: Buffer[] = [], limit = CHAT_ATTACHMENT_MAX_BYTES * CHAT_ATTACHMENT_MAX_FILES + 65536;
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new FeatureError(413, '파일은 한 개당 15MB, 한 번에 3개까지 첨부할 수 있어요.', 'ATTACHMENT_SIZE_LIMIT'); }
      chunks.push(Buffer.from(part.value));
    }
  } finally { reader.releaseLock(); }
  try { return await new Response(new Uint8Array(Buffer.concat(chunks)), { headers: { 'Content-Type': request.headers.get('content-type') || '' } }).formData(); }
  catch { throw new FeatureError(400, '첨부 요청을 확인하지 못했어요. 파일을 다시 선택해 주세요.', 'ATTACHMENT_FORM_INVALID'); }
}

export async function POST(request: Request) {
  const stored: ChatAttachmentRow[] = [];
  try {
    checkOrigin(request); const user = await requireUser(); requireStudent(user);
    if (!request.headers.get('content-type')?.startsWith('multipart/form-data')) throw new FeatureError(415, '첨부 파일을 선택해 주세요.', 'ATTACHMENT_FORM_REQUIRED');
    const length = Number(request.headers.get('content-length') || 0);
    if (length > CHAT_ATTACHMENT_MAX_BYTES * CHAT_ATTACHMENT_MAX_FILES + 65536) throw new FeatureError(413, '파일은 한 개당 15MB, 한 번에 3개까지 첨부할 수 있어요.', 'ATTACHMENT_SIZE_LIMIT');
    // Count the actual incoming bytes too; a chunked request can omit Content-Length.
    const form = await boundedForm(request);
    const files = [...form.getAll('files'), ...form.getAll('file')].filter((entry): entry is File => typeof entry !== 'string');
    if (!files.length || files.length > CHAT_ATTACHMENT_MAX_FILES) throw new FeatureError(400, '파일을 1~3개 선택해 주세요.', 'ATTACHMENT_COUNT_LIMIT');
    // Check every file before creating any row/blob, so mixed invalid batches cannot leave partial drafts.
    const prepared = await Promise.all(files.map(async file => {
      if (!file.size || file.size > CHAT_ATTACHMENT_MAX_BYTES) throw new FeatureError(413, '파일 한 개는 15MB까지 첨부할 수 있어요.', 'ATTACHMENT_SIZE_LIMIT');
      const bytes = Buffer.from(await file.arrayBuffer()); validateChatAttachment(file, bytes); return { file, bytes };
    }));
    for (const item of prepared) stored.push(await storeChatAttachment(user.id, item.file, item.bytes));
    return json({ attachments: stored.map(chatAttachmentView) }, 201);
  } catch (error) {
    await Promise.allSettled(stored.map(discardChatAttachment));
    const result = featureError(error); return json({ error: result.error, code: result.code }, result.status);
  }
}

export async function DELETE(request: Request) {
  try {
    checkOrigin(request); const user = await requireUser(); requireStudent(user);
    const id = z.string().uuid().parse(new URL(request.url).searchParams.get('id'));
    const [row] = await query<ChatAttachmentRow>('select * from chat_attachments where id=$1 and student_id=$2 and deleted_at is null', [id, user.id]);
    if (!row) throw new FeatureError(404, '첨부 파일을 찾을 수 없어요.', 'ATTACHMENT_NOT_FOUND');
    if (!await discardChatAttachment(row)) throw new FeatureError(409, '보낸 자료는 대화 기록과 함께 보관돼요.', 'ATTACHMENT_ALREADY_SENT');
    return json({ deleted: true, id });
  } catch (error) { const result = featureError(error); return json({ error: result.error, code: result.code }, result.status); }
}
