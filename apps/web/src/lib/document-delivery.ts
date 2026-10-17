import 'server-only';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { ApiError } from './db';
import type { PublicationDocument } from './content-publication';

/** Call only after authorization and validatePublication. Never expose service credentials. */
export async function documentDelivery(document: PublicationDocument, localUrl: string) {
  let url = localUrl;
  if (process.env.AUTH_MODE === 'supabase') {
    const endpoint = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!endpoint || !key) throw new ApiError(503, '교재 저장소 설정을 확인해 주세요.');
    const storage = createClient(endpoint, key, { auth: { persistSession: false, autoRefreshToken: false } }).storage.from('document-originals');
    const hash = createHash('sha256').update(document.html).digest('hex');
    if (hash !== document.file_hash) throw new ApiError(409, '교재 원본이 변경되었어요.');
    const path = `${document.id}/${hash}.html`;
    // Immutable, content-addressed cache also supports books imported before this migration.
    const existing = await storage.info(path);
    if (existing.error) {
      if (!('statusCode' in existing.error && String(existing.error.statusCode) === '404')) throw new ApiError(503, '교재 저장소를 확인하지 못했어요.');
      const { error } = await storage.upload(path, Buffer.from(document.html), { contentType: 'text/html', upsert: false, cacheControl: '0' });
      // Another authorized reader may have filled the cache concurrently.
      if (error && !('statusCode' in error && String(error.statusCode) === '409')) throw new ApiError(503, '교재 원본을 저장하지 못했어요. 다시 시도해 주세요.');
    }
    const signed = await storage.createSignedUrl(path, 60);
    if (signed.error || !signed.data?.signedUrl) throw new ApiError(503, '교재 원본을 불러오지 못했어요.');
    url = signed.data.signedUrl;
  }
  return { id: document.id, kind: document.kind, file_hash: document.file_hash, original_url: url };
}

export function localDocumentResponse(html: string) {
  if (process.env.AUTH_MODE === 'supabase') throw new ApiError(400, '교재 저장소 주소로 원본을 요청해 주세요.');
  return new Response(html, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
}
