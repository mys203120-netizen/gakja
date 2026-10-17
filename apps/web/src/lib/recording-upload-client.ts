'use client';
import { createBrowserClient } from '@supabase/ssr';
import type { RecordingUploadFile } from './recording-upload-contract';

async function result(response: Response) {
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '녹음 저장에 실패했어요.');
  return value;
}
export async function uploadPrivateFiles(endpoint: '/api/media' | '/api/quiz' | '/api/chat/attachments' | '/api/imports', form: FormData) {
  const kind = endpoint === '/api/media' ? 'interview' : endpoint === '/api/quiz' ? 'quiz' : endpoint === '/api/imports' ? 'guidebook' : 'attachment';
  const fields: Record<string, string> = {}, files: { field: string; name: string; size: number; mime: string }[] = [];
  for (const [field, value] of form.entries()) {
    if (typeof value === 'string') fields[field] = value;
    else files.push({ field: field === 'files' ? `file${files.length}` : field, name: value.name, size: value.size, mime: value.type.split(';')[0] || 'application/octet-stream' });
  }
  const intent = await result(await fetch('/api/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, fields, files }) }));
  if (intent.transport === 'multipart') return result(await fetch(endpoint, { method: 'POST', body: form }));
  const client = createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  for (const file of intent.files as RecordingUploadFile[]) {
    const blob = file.field.startsWith('file') ? form.getAll('files')[Number(file.field.slice(4))] : form.get(file.field);
    if (!(blob instanceof Blob)) throw new Error('녹음 파일을 다시 선택해 주세요.');
    // Storage's multipart parser uses the Blob MIME, not only contentType.
    const normalized = new Blob([blob], { type: file.mime });
    const { error } = await client.storage.from(file.bucket).upload(file.path, normalized, { contentType: file.mime, upsert: false });
    if (error) throw new Error('비공개 녹음 업로드에 실패했어요. 연결을 확인하고 다시 저장해 주세요.');
  }
  return result(await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Recording-Upload': 'complete' }, body: JSON.stringify({ uploadId: intent.uploadId }) }));
}
export const uploadRecording = uploadPrivateFiles;
