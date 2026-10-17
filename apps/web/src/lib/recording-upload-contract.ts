import { z } from 'zod';

export const recordingUploadSchema = z.object({
  kind: z.enum(['interview', 'quiz', 'attachment', 'guidebook']),
  fields: z.record(z.string(), z.string().max(65_536)),
  files: z.array(z.object({
    field: z.enum(['recording', 'analysisAudio', 'file0', 'file1', 'file2']),
    name: z.string().min(1).max(180).optional(),
    size: z.number().int().positive().max(20 * 1024 * 1024),
    mime: z.string().min(1).max(150),
  })).min(1).max(3),
}).superRefine((input, ctx) => {
  const fields = input.files.map(file => file.field);
  if (input.kind === 'attachment' || input.kind === 'guidebook') {
    if (input.kind === 'guidebook' && input.files.length !== 1) ctx.addIssue({ code: 'custom', message: 'HTML 파일 한 개를 선택해 주세요.' });
    input.files.forEach((file, index) => {
      const extension = file.name?.split('.').pop()?.toLowerCase();
      const allowed = input.kind === 'guidebook' ? ['html','htm'] : Object.keys(attachmentMimes);
      if (file.field !== `file${index}` || !extension || !allowed.includes(extension) || file.size > (input.kind === 'guidebook' ? 5 : 15) * 1024 * 1024) ctx.addIssue({ code: 'custom', message: '파일 형식·개수·크기를 확인해 주세요.' });
      const mime = input.kind === 'guidebook' ? 'text/html' : attachmentMimes[extension || ''];
      if (file.mime !== mime && file.mime !== 'application/octet-stream' && !(extension === 'md' && file.mime === 'text/plain')) ctx.addIssue({ code: 'custom', message: '파일 확장자와 형식을 확인해 주세요.' });
    });
    return;
  }
  if (fields.some(field => !['recording','analysisAudio'].includes(field))) ctx.addIssue({ code: 'custom', message: '녹화 파일 구성을 확인해 주세요.' });
  if (!fields.includes('recording') || new Set(fields).size !== fields.length) ctx.addIssue({ code: 'custom', message: '녹화 파일 구성을 확인해 주세요.' });
  for (const file of input.files) {
    if (!['video/webm','video/mp4','audio/webm','audio/mp4','audio/mpeg','audio/wav','audio/x-wav','audio/ogg'].includes(file.mime)) ctx.addIssue({ code: 'custom', message: '녹화 파일 형식을 확인해 주세요.' });
    if ((input.kind === 'quiz' || file.field === 'analysisAudio') && !file.mime.startsWith('audio/')) ctx.addIssue({ code: 'custom', message: '음성 파일을 선택해 주세요.' });
    if (input.kind === 'quiz' && (file.size > 10 * 1024 * 1024 || file.field !== 'recording' || file.mime === 'audio/mpeg')) ctx.addIssue({ code: 'custom', message: '퀴즈 녹음 형식과 10MB 제한을 확인해 주세요.' });
  }
});
export const attachmentMimes: Record<string,string> = { txt:'text/plain',md:'text/markdown',pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif' };
export type UploadKind = z.infer<typeof recordingUploadSchema>['kind'];
export type RecordingUploadFile = { field: string; name?: string; size: number; mime: string; bucket: string; path: string };
