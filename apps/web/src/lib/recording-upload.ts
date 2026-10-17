import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireStaff, supabaseServer } from './auth';
import { ApiError, query, transaction } from './db';
import { assertPublishedAccess } from './ai';
import { attachmentMimes, recordingUploadSchema, type UploadKind, type RecordingUploadFile } from './recording-upload-contract';

export async function uploadJson(request: Request) {
  const limit = 100_000;
  if (Number(request.headers.get('content-length')) > limit || !request.body) throw new ApiError(413, '업로드 정보가 너무 커요.');
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new ApiError(413, '업로드 정보가 너무 커요.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, '업로드 정보를 확인해 주세요.'); }
}

// Only metadata crosses the app API. The authenticated Storage request checks
// active status at upload time; no bearer upload capability survives deactivation.
export async function prepareRecordingUpload(studentId: string, value: unknown) {
  const input = recordingUploadSchema.parse(value);
  if (process.env.AUTH_MODE !== 'supabase') return { transport: 'multipart' as const };
  if (process.env.SUPABASE_MEDIA_BUCKET && process.env.SUPABASE_MEDIA_BUCKET !== 'student-media') throw new ApiError(503, 'student-media 비공개 버킷을 설정해 주세요.');
  await validateUploadContext(studentId, input.kind, input.fields);
  const id = randomUUID();
  const bucket = input.kind === 'attachment' ? 'student-chat-files' : input.kind === 'guidebook' ? 'content-imports' : 'student-media';
  const files = input.files.map(file => ({ ...file, mime: input.kind === 'guidebook' ? 'text/html' : input.kind === 'attachment' ? attachmentMimes[file.name!.split('.').pop()!.toLowerCase()] : file.mime, bucket, path: `${studentId}/uploads/${id}/${file.field}` }));
  await transaction(async db => {
    await db.query('select pg_advisory_xact_lock(hashtext($1))', ['recording-upload:' + studentId]);
    const [{ count }] = (await db.query("select count(*)::int as count from recording_uploads where student_id=$1 and created_at>now()-interval '1 hour'", [studentId])).rows;
    if (count >= 60) throw new ApiError(429, '녹음 저장 요청이 많아요. 잠시 후 다시 시도해 주세요.');
    await db.query('insert into recording_uploads(id,student_id,kind,fields,files) values($1,$2,$3,$4,$5)', [id, studentId, input.kind, JSON.stringify(input.fields), JSON.stringify(files)]);
  });
  return { transport: 'storage' as const, uploadId: id, files };
}

export async function validateUploadContext(studentId: string, kind: UploadKind, fields: Record<string, string>) {
  if (kind === 'attachment') return;
  if (kind === 'guidebook') {
    const targetId = z.string().uuid().parse(fields.studentId);
    const staff = await requireStaff(targetId, 'import');
    if (staff.id !== studentId) throw new ApiError(403, '등록 계정을 확인해 주세요.');
    const [production] = await query("select l.id from production_links l join profiles p on p.id=l.student_id where l.id=$1 and l.student_id=$2 and p.active=true and p.role='student'", [fields.productionJobRef, targetId]);
    if (!production) throw new ApiError(404, '학생과 제작 건을 확인해 주세요.');
    return;
  }
  if (fields.consent !== 'true') throw new ApiError(400, '비공개 녹음 저장에 동의해 주세요.');
  const sessionId = z.string().uuid().parse(fields.sessionId);
  if (kind === 'quiz') {
    const index = z.coerce.number().int().nonnegative().parse(fields.itemIndex);
    const [session] = await query('select * from quiz_sessions where id=$1 and student_id=$2', [sessionId, studentId]);
    if (!session) throw new ApiError(404, '퀴즈 기록을 찾을 수 없어요.');
    if (session.state !== 'active' || session.current_index !== index || session.mode === 'choice') throw new ApiError(409, '현재 답변의 녹음을 저장해 주세요.');
  } else {
    const turnId = z.string().uuid().parse(fields.turnId);
    const generation = z.coerce.number().int().nonnegative().parse(fields.generation);
    const [session] = await query('select * from interview_sessions where id=$1 and student_id=$2', [sessionId, studentId]);
    const [turn] = await query('select * from interview_turns where id=$1 and session_id=$2 and student_id=$3 and question_id=$4', [turnId, sessionId, studentId, fields.questionId]);
    if (!session || !turn) throw new ApiError(404, '면접 질문을 찾을 수 없어요.');
    await assertPublishedAccess(studentId, session.data.context);
    if (session.state !== 'active' || turn.data.answer || turn.data.invalidated || generation !== Number(session.data.generation || 0)) throw new ApiError(409, '현재 답변의 녹화를 저장해 주세요.');
  }
}

export async function recordingForm(request: Request, studentId: string, kind: UploadKind) {
  if (request.headers.get('content-type')?.includes('multipart/form-data')) {
    if (process.env.AUTH_MODE === 'supabase') throw new ApiError(415, '직접 업로드로 녹음을 저장해 주세요. 화면을 새로고침해 주세요.');
    return { form: await request.formData(), files: [] as RecordingUploadFile[] };
  }
  const parsed = z.object({ uploadId: z.string().uuid() }).safeParse(await uploadJson(request));
  if (!parsed.success) throw new ApiError(400, '업로드 요청을 확인해 주세요.');
  const { uploadId } = parsed.data;
  const [intent] = await query('select * from recording_uploads where id=$1 and student_id=$2 and kind=$3 and expires_at>now()', [uploadId, studentId, kind]);
  if (!intent) throw new ApiError(404, '업로드 요청이 만료되었거나 찾을 수 없어요. 다시 저장해 주세요.');
  await validateUploadContext(studentId, kind, intent.fields);
  // Freeze the upload before reading; Storage never grants UPDATE or DELETE.
  await query('update recording_uploads set locked_at=coalesce(locked_at,now()) where id=$1 and student_id=$2', [uploadId, studentId]);
  const form = new FormData(), files = intent.files as RecordingUploadFile[];
  for (const [key, value] of Object.entries(intent.fields)) form.set(key, String(value));
  const storage = (await supabaseServer()).storage;
  for (const file of files) {
    const bucket = storage.from(file.bucket);
    const { data: info, error: infoError } = await bucket.info(file.path);
    if (infoError || !info || Number(info.size) !== file.size || info.contentType?.split(';')[0] !== file.mime) throw new ApiError(415, '업로드한 파일 크기와 형식을 확인해 주세요.');
    const { data, error } = await bucket.download(file.path);
    if (error || !data) throw new ApiError(502, '녹음을 가져오지 못했어요. 다시 시도해 주세요.');
    if (data.size !== file.size) throw new ApiError(415, '업로드한 파일 크기가 일치하지 않아요.');
    form.append(file.field.startsWith('file') ? 'files' : file.field, new File([data], file.name || file.field, { type: file.mime }));
  }
  return { form, files };
}

export async function recordingRedirect(bucket: string, path: string, download?: string) {
  const { data, error } = await (await supabaseServer()).storage.from(bucket).createSignedUrl(path, 60, download ? { download } : undefined);
  if (error || !data) throw new ApiError(404, '녹음을 가져오지 못했어요.');
  return new Response(null, { status: 307, headers: { Location: data.signedUrl, 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } });
}
