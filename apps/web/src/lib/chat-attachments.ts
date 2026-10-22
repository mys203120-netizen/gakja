import 'server-only';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { supabaseServer } from '@/lib/auth';
import { query } from '@/lib/db';
import { FeatureError } from '@/lib/ai';
import type { RecordingUploadFile } from './recording-upload-contract';

export const CHAT_ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024;
export const CHAT_ATTACHMENT_MAX_FILES = 3;
const MAX_TEXT = 100000;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export type ChatAttachmentInput = { kind: 'text'; name: string; text: string } | { kind: 'image'; name: string; mime: string; dataUrl: string } | { kind: 'pdf'; name: string; mime: string; dataUrl: string };
export type ChatAttachmentRow = Record<string, any> & { id: string; student_id: string; name: string; mime: string; kind: 'text' | 'image' | 'pdf'; size: number; storage: { provider: string; path: string; bucket?: string }; extracted_text?: string | null; };

function invalid(message = '파일 형식과 내용을 확인해 주세요.') { return new FeatureError(415, message, 'ATTACHMENT_FORMAT_MISMATCH'); }
function boundedText(text: string) {
  if (!text.trim()) throw new FeatureError(422, '텍스트를 읽을 수 없는 파일이에요. PDF 또는 텍스트 파일로 첨부해 주세요.', 'ATTACHMENT_EMPTY_TEXT');
  if (text.length > MAX_TEXT) throw new FeatureError(413, '문서 한 개는 10만 자까지 읽을 수 있어요. 필요한 부분을 나누어 첨부해 주세요.', 'ATTACHMENT_TEXT_TOO_LONG');
  return text;
}
function xmlText(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw invalid();
  return xml.replace(/<w:(?:tab)[\s\S]*?\/>/g, '\t').replace(/<\/w:(?:p|tr)>/g, '\n').replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos);|&#(?:x[0-9a-fA-F]+|[0-9]+);/g, entity => {
      const basic: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
      if (basic[entity]) return basic[entity];
      const value = entity.startsWith('&#x') ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
      return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : '';
    }).replace(/\n{3,}/g, '\n\n').trim();
}

/** Read only the main Word XML; bounded central/local headers and inflate prevent ZIP bombs. */
function docxText(bytes: Buffer) {
  if (bytes.readUInt32LE(0) !== 0x04034b50) throw invalid();
  let eocd = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index--) {
    if (bytes.readUInt32LE(index) === 0x06054b50 && index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) { eocd = index; break; }
  }
  if (eocd < 0 || bytes.readUInt16LE(eocd + 4) || bytes.readUInt16LE(eocd + 6)) throw invalid();
  const count = bytes.readUInt16LE(eocd + 10), offset = bytes.readUInt32LE(eocd + 16), size = bytes.readUInt32LE(eocd + 12);
  if (!count || count > 1024 || offset + size > eocd) throw invalid();
  let cursor = offset, document: Buffer | null = null, contentTypes = false;
  const names = new Set<string>();
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > offset + size || bytes.readUInt32LE(cursor) !== 0x02014b50) throw invalid();
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), compressed = bytes.readUInt32LE(cursor + 20), uncompressed = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32), local = bytes.readUInt32LE(cursor + 42);
    if (cursor + 46 + nameLength + extra + comment > offset + size || flags & 1) throw invalid();
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (names.has(name) || name.includes('..') || name.startsWith('/') || name.includes('\\') || /vbaProject|\.exe$|\.js$/i.test(name)) throw invalid();
    names.add(name);
    if (name === '[Content_Types].xml') contentTypes = true;
    if (name === 'word/document.xml') {
      if (uncompressed > 4 * 1024 * 1024 || !uncompressed || ![0, 8].includes(method) || local + 30 > offset || bytes.readUInt32LE(local) !== 0x04034b50) throw invalid();
      const localNameSize = bytes.readUInt16LE(local + 26), start = local + 30 + localNameSize + bytes.readUInt16LE(local + 28);
      if (bytes.subarray(local + 30, local + 30 + localNameSize).toString('utf8') !== name || start + compressed > offset || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt16LE(local + 6) & 1) throw invalid();
      const data = bytes.subarray(start, start + compressed);
      try { document = method === 8 ? inflateRawSync(data, { maxOutputLength: 4 * 1024 * 1024 }) : data; } catch { throw invalid(); }
      if (document.length !== uncompressed) throw invalid();
    }
    cursor += 46 + nameLength + extra + comment;
  }
  if (!document || !contentTypes || cursor !== offset + size) throw invalid('일반 DOCX 문서만 첨부할 수 있어요. 암호·매크로 문서는 PDF로 변환해 주세요.');
  return boundedText(xmlText(new TextDecoder('utf-8', { fatal: true }).decode(document)));
}

export function validateChatAttachment(file: { name: string; type: string; size: number }, bytes: Buffer) {
  if (!bytes.length || bytes.length !== file.size || bytes.length > CHAT_ATTACHMENT_MAX_BYTES) throw new FeatureError(413, '파일 한 개는 15MB까지 첨부할 수 있어요.', 'ATTACHMENT_SIZE_LIMIT');
  const name = file.name.replace(/[/\\\x00-\x1f\x7f]/g, '_').trim().slice(0, 180);
  if (!name) throw invalid();
  const extension = extname(name).toLowerCase(), declared = file.type.split(';')[0].toLowerCase();
  const formats: Record<string, string[]> = { '.txt': ['text/plain'], '.md': ['text/markdown', 'text/plain'], '.pdf': ['application/pdf'], '.docx': [DOCX_MIME], '.png': ['image/png'], '.jpg': ['image/jpeg'], '.jpeg': ['image/jpeg'], '.webp': ['image/webp'], '.gif': ['image/gif'] };
  if (!formats[extension] || declared && declared !== 'application/octet-stream' && !formats[extension].includes(declared)) throw new FeatureError(415, 'PDF, DOCX, TXT, MD, PNG, JPG, WebP, GIF 파일을 첨부해 주세요.', 'ATTACHMENT_UNSUPPORTED');
  const mime = formats[extension][0];
  if (extension === '.txt' || extension === '.md') {
    let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw invalid('UTF-8 텍스트 파일로 저장해 첨부해 주세요.'); }
    if (text.includes('\0')) throw invalid();
    return { name, mime, kind: 'text' as const, text: boundedText(text) };
  }
  if (extension === '.docx') { try { return { name, mime, kind: 'text' as const, text: docxText(bytes) }; } catch (error) { if (error instanceof FeatureError) throw error; throw invalid(); } }
  if (extension === '.pdf') {
    if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-' || !bytes.subarray(Math.max(0, bytes.length - 2048)).includes(Buffer.from('%%EOF'))) throw invalid();
    return { name, mime, kind: 'pdf' as const, text: null };
  }
  const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.subarray(12, 16).toString('ascii') === 'IHDR';
  const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  const webp = bytes.length >= 20 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length;
  const gif = bytes.length >= 14 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')) && bytes[bytes.length - 1] === 0x3b;
  if (mime === 'image/png' && !png || mime === 'image/jpeg' && !jpeg || mime === 'image/webp' && !webp || mime === 'image/gif' && !gif) throw invalid();
  return { name, mime, kind: 'image' as const, text: null };
}

export function chatAttachmentView(row: ChatAttachmentRow) {
  return { id: row.id, name: row.name, mime: row.mime, kind: row.kind, size: row.size, createdAt: row.created_at, url: `/api/chat/attachments/${row.id}` };
}
function privateRoot() {
  // Private runtime uploads are not build assets and must stay outside traced bundles.
  let root = resolve(/* turbopackIgnore: true */ process.cwd());
  for (let index = 0; index < 5 && !existsSync(join(root, 'supabase', 'migrations')); index++) root = dirname(root);
  if (!existsSync(join(root, 'supabase', 'migrations'))) throw new FeatureError(503, '파일 저장 경로를 확인해 주세요.', 'ATTACHMENT_STORAGE_UNAVAILABLE');
  return resolve(root, '.local', 'private-chat-files');
}
function privatePath(storagePath: string) {
  if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z0-9]+$/.test(storagePath)) throw invalid();
  const root = privateRoot(), path = resolve(root, storagePath);
  if (!path.startsWith(root + sep)) throw invalid();
  return path;
}

export async function storeChatAttachment(studentId: string, file: File, bytes: Buffer, uploaded?: RecordingUploadFile) {
  if (process.env.AUTH_MODE === 'supabase' && !uploaded) throw new FeatureError(415, '직접 업로드로 파일을 저장해 주세요.', 'DIRECT_UPLOAD_REQUIRED');
  const valid = validateChatAttachment(file, bytes), id = randomUUID(), path = `${studentId}/${id}${extname(valid.name).toLowerCase()}`;
  const storage = uploaded ? { provider: 'supabase', path: uploaded.path, bucket: uploaded.bucket } : { provider: 'local', path, bucket: 'student-chat-files' };
  if (storage.provider === 'local') {
    const absolute = privatePath(path); await mkdir(dirname(absolute), { recursive: true, mode: 0o700 }); await writeFile(absolute, bytes, { flag: 'wx', mode: 0o600 });
  }
  try {
    const [row] = await query<ChatAttachmentRow>('insert into chat_attachments(id,student_id,name,mime,kind,size,extracted_text,storage) values($1,$2,$3,$4,$5,$6,$7,$8) returning *', [id, studentId, valid.name, valid.mime, valid.kind, bytes.length, valid.text, JSON.stringify(storage)]);
    return row;
  } catch (error) { if (!uploaded) await removeStoredBytes(storage); throw error; }
}
async function removeStoredBytes(storage: ChatAttachmentRow['storage']) {
  // Direct-upload objects are immutable to browsers. Unreferenced objects are
  // removed by the server-only expired-upload cleanup, not a permissive policy.
  if (storage.provider === 'supabase' && !storage.path.includes('/uploads/')) await (await supabaseServer()).storage.from(storage.bucket || 'student-chat-files').remove([storage.path]);
  else if (storage.provider === 'local') { try { await unlink(privatePath(storage.path)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
}
export async function discardChatAttachment(row: ChatAttachmentRow) {
  // Only unused upload drafts can be discarded; a sent message keeps its readable evidence.
  const removed = await query<ChatAttachmentRow>('delete from chat_attachments where id=$1 and student_id=$2 and message_id is null returning *', [row.id, row.student_id]);
  if (removed[0]) await removeStoredBytes(removed[0].storage);
  return removed.length > 0;
}
export async function readChatAttachment(row: ChatAttachmentRow) {
  if (!row.storage.path.startsWith(row.student_id + '/')) throw new FeatureError(404, '첨부 파일을 가져오지 못했어요.', 'ATTACHMENT_UNAVAILABLE');
  let bytes: Buffer;
  if (row.storage.provider === 'supabase') {
    const { data, error } = await (await supabaseServer()).storage.from(row.storage.bucket || 'student-chat-files').download(row.storage.path);
    if (error || !data) throw new FeatureError(404, '첨부 파일을 가져오지 못했어요.', 'ATTACHMENT_UNAVAILABLE');
    bytes = Buffer.from(await data.arrayBuffer());
  } else if (row.storage.provider === 'local') {
    try { bytes = await readFile(privatePath(row.storage.path)); } catch { throw new FeatureError(404, '첨부 파일을 가져오지 못했어요.', 'ATTACHMENT_UNAVAILABLE'); }
  } else throw new FeatureError(404, '첨부 파일을 찾을 수 없어요.', 'ATTACHMENT_UNAVAILABLE');
  if (bytes.length !== row.size || !row.storage.path.startsWith(row.student_id + '/')) throw new FeatureError(404, '첨부 파일을 가져오지 못했어요.', 'ATTACHMENT_UNAVAILABLE');
  return bytes;
}
/** Data management has already verified the snapshot owner and the storage reference. */
export async function removeLocalAccountAttachment(row: ChatAttachmentRow) {
  if (row.storage.provider !== 'local' || !row.storage.path.startsWith(row.student_id + '/')) throw new FeatureError(404, '첨부 파일을 찾을 수 없어요.', 'ATTACHMENT_UNAVAILABLE');
  try { await unlink(privatePath(row.storage.path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export async function chatAttachmentInputs(rows: ChatAttachmentRow[]): Promise<ChatAttachmentInput[]> {
  if (rows.filter(row => row.kind === 'text').reduce((sum, row) => sum + (row.extracted_text?.length || 0), 0) > 160000) throw new FeatureError(413, '한 대화 요청의 첨부 텍스트는 16만 자까지 읽을 수 있어요.', 'ATTACHMENT_CONTEXT_TOO_LONG');
  return Promise.all(rows.map(async row => row.kind === 'text' ? { kind: 'text' as const, name: row.name, text: row.extracted_text || '' } : { kind: row.kind, name: row.name, mime: row.mime, dataUrl: `data:${row.mime};base64,${(await readChatAttachment(row)).toString('base64')}` }));
}
