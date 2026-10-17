'use client';

/** Fetch bytes directly from Storage, then preserve the sandboxed srcDoc rendering. */
export async function loadDocumentOriginal<T extends { original_url: string; file_hash: string }>(document: T) {
  const response = await fetch(document.original_url, { cache: 'no-store', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error('교재 원본을 불러오지 못했어요. 다시 열어 주세요.');
  const bytes = await response.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== document.file_hash) throw new Error('교재 원본을 확인할 수 없어요. 다시 열어 주세요.');
  const html = new TextDecoder().decode(bytes);
  const source = new DOMParser().parseFromString(html, 'text/html').querySelector('script#gakja-learning-pack');
  const pack = JSON.parse(source?.textContent || '{}');
  if (!pack.document) throw new Error('교재 본문을 찾을 수 없어요.');
  return { ...document, html, data: pack.document };
}
