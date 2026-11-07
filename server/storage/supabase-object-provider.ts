import type { ObjectStorageProvider, StorageObjectRef, StorageReadOptions } from './private-object-ports';

export class ObjectProviderError extends Error {
  constructor(readonly code: 'STORAGE_REFERENCE_DENIED' | 'STORAGE_UNAVAILABLE' | 'STORAGE_NOT_FOUND' |
    'STORAGE_CONFLICT' | 'STORAGE_LIMIT' | 'STORAGE_TIMEOUT' | 'STORAGE_ABORTED') {
    super(code); this.name = 'ObjectProviderError';
  }
}
export interface SupabaseObjectProviderOptions {
  /** Trusted server configuration. Local HTTP requires an explicit opt-in. */
  apiUrl: string;
  serviceCredential: string;
  bucket: string;
  keyPrefix: string;
  allowLoopbackHttp?: boolean;
  maxObjectBytes?: number;
  maxConcurrent?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  observe?: (event: { operation: string; status: number | null }) => void;
}

/** Official Supabase Storage REST API. Credentials never leave this configured
 * origin, redirects are rejected, and browser-provided URLs are not accepted.
 * This privileged provider does not itself authenticate an application owner;
 * the A/B authority and registration ledger must authorize every operation. */
export function createSupabaseObjectProvider(options: SupabaseObjectProviderOptions): ObjectStorageProvider & {
  createSignedDownload(ref: StorageObjectRef, expiresInSeconds: number): Promise<string>;
  createSignedUpload(ref: StorageObjectRef): Promise<string>;
  uploadSigned(ref: StorageObjectRef, signedUrl: string, bytes: Buffer, contentType: string): Promise<void>;
} {
  let base: URL;
  try { base = new URL(options.apiUrl); } catch { throw new ObjectProviderError('STORAGE_REFERENCE_DENIED'); }
  const prefix = base.pathname.replace(/\/$/u, '');
  const isLoopback = ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash ||
    !(base.protocol === 'https:' || options.allowLoopbackHttp === true && isLoopback && base.protocol === 'http:') ||
    !['', '/storage/v1'].includes(prefix) || !/^[a-z0-9][a-z0-9-]{2,62}$/u.test(options.bucket) ||
    !/^[a-zA-Z0-9_-]{8,64}$/u.test(options.keyPrefix) || typeof options.serviceCredential !== 'string' || !options.serviceCredential || /\s/u.test(options.serviceCredential)) {
    throw new ObjectProviderError('STORAGE_REFERENCE_DENIED');
  }
  const maxBytes = options.maxObjectBytes ?? 16 * 1024 * 1024;
  const maxConcurrent = options.maxConcurrent ?? 4;
  const defaultTimeout = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024 ||
    !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8 ||
    !Number.isInteger(defaultTimeout) || defaultTimeout < 1 || defaultTimeout > 30_000) throw new ObjectProviderError('STORAGE_LIMIT');
  const fetcher = options.fetch ?? fetch;
  let active = 0;
  function objectPath(ref: StorageObjectRef) {
    if (!ref || ref.bucket !== options.bucket || typeof ref.key !== 'string' ||
      !new RegExp('^' + options.keyPrefix + '/(?:staging|final)/[a-f0-9-]{36}$', 'u').test(ref.key)) {
      throw new ObjectProviderError('STORAGE_REFERENCE_DENIED');
    }
    return encodeURIComponent(ref.bucket) + '/' + ref.key.split('/').map(encodeURIComponent).join('/');
  }
  function endpoint(route: string) { return new URL(base.origin + prefix + route); }
  async function bounded(response: Response, limit: number, controller: AbortController) {
    const length = response.headers.get('content-length');
    if (length !== null && /^\d+$/u.test(length) && Number(length) > limit) {
      controller.abort(); throw new ObjectProviderError('STORAGE_LIMIT');
    }
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Buffer[] = []; let size = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > limit) { controller.abort(); throw new ObjectProviderError('STORAGE_LIMIT'); }
        chunks.push(Buffer.from(next.value));
      }
      return Buffer.concat(chunks, size);
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async function request(operation: string, url: URL, init: RequestInit, input: { limit?: number; timeoutMs?: number; signal?: AbortSignal; credential?: boolean } = {}) {
    const timeoutMs = input.timeoutMs ?? defaultTimeout;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 || active >= maxConcurrent) throw new ObjectProviderError('STORAGE_LIMIT');
    if (input.signal?.aborted) throw new ObjectProviderError('STORAGE_ABORTED');
    active += 1;
    const controller = new AbortController(); let timedOut = false;
    const abort = () => controller.abort(); input.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    let status: number | null = null;
    try {
      const headers = new Headers(init.headers);
      if (input.credential !== false) headers.set('Authorization', 'Bearer ' + options.serviceCredential);
      const response = await fetcher(url, { ...init, headers, redirect: 'error', signal: controller.signal, cache: 'no-store' });
      status = response.status;
      if (!response.ok) {
        // Official Storage v1.89.12 renders NoSuchKey as HTTP 400 while its
        // bounded JSON body retains statusCode "404". Only that explicit read
        // response means absence; auth, bucket and availability failures cannot
        // authorize the recovery uploader to treat an object as missing.
        // https://github.com/supabase/storage/blob/v1.89.12/src/internal/errors/storage-error.ts#L83
        // https://github.com/supabase/storage/blob/v1.89.12/src/http/error-handler.ts#L65
        let missingObject = false;
        if (operation === 'read' && response.status === 400 &&
          /^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) {
          try {
            const bytes = await bounded(response, 4096, controller);
            const error = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown> | null;
            missingObject = !!error && !Array.isArray(error) && error.statusCode === '404' && error.code === 'NoSuchKey' &&
              (error.error === 'not_found' || error.error === 'NoSuchKey') && error.message === 'Object not found';
          } catch {
            if (timedOut || input.signal?.aborted) throw new ObjectProviderError(timedOut ? 'STORAGE_TIMEOUT' : 'STORAGE_ABORTED');
            // Invalid, excessive or incomplete error bodies remain unavailable.
          }
        }
        await response.body?.cancel().catch(() => {});
        throw new ObjectProviderError(response.status === 404 || missingObject ? 'STORAGE_NOT_FOUND' :
          response.status === 409 ? 'STORAGE_CONFLICT' : 'STORAGE_UNAVAILABLE');
      }
      return await bounded(response, input.limit ?? 64 * 1024, controller);
    } catch (error) {
      if (error instanceof ObjectProviderError) throw error;
      throw new ObjectProviderError(timedOut ? 'STORAGE_TIMEOUT' : input.signal?.aborted ? 'STORAGE_ABORTED' : 'STORAGE_UNAVAILABLE');
    } finally {
      clearTimeout(timer); input.signal?.removeEventListener('abort', abort); active -= 1;
      // No key, URL, response body, credential or signed token is observable.
      try { options.observe?.({ operation, status }); } catch { /* metrics cannot change authorization/results */ }
    }
  }
  function checkUpload(bytes: Buffer) { if (!Buffer.isBuffer(bytes) || bytes.length > maxBytes) throw new ObjectProviderError('STORAGE_LIMIT'); }
  function parseSigned(ref: StorageObjectRef, value: unknown, upload: boolean) {
    if (typeof value !== 'string') throw new ObjectProviderError('STORAGE_UNAVAILABLE');
    let url: URL;
    try { url = new URL(value, base.origin); } catch { throw new ObjectProviderError('STORAGE_UNAVAILABLE'); }
    const required = prefix + '/object/' + (upload ? 'upload/sign/' : 'sign/') + objectPath(ref);
    // The direct local API returns /object/..., hosted gateway may add its prefix.
    if (prefix && url.pathname === required.slice(prefix.length)) url.pathname = required;
    if (url.origin !== base.origin || url.username || url.password || url.hash || url.pathname !== required ||
      !url.searchParams.get('token') || [...url.searchParams.keys()].some(key => key !== 'token')) throw new ObjectProviderError('STORAGE_REFERENCE_DENIED');
    return url;
  }
  function signedValue(bytes: Buffer, name: string): unknown {
    try { return JSON.parse(bytes.toString('utf8'))[name]; } catch { throw new ObjectProviderError('STORAGE_UNAVAILABLE'); }
  }
  return Object.freeze({
    async read(ref: StorageObjectRef, input: StorageReadOptions) {
      if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > maxBytes) throw new ObjectProviderError('STORAGE_LIMIT');
      return request('read', endpoint('/object/authenticated/' + objectPath(ref)), { method: 'GET' }, { ...input, limit: input.maxBytes });
    },
    async upload(ref: StorageObjectRef, bytes: Buffer, input: { contentType: string; signal?: AbortSignal }) {
      checkUpload(bytes);
      await request('upload', endpoint('/object/' + objectPath(ref)), { method: 'POST', body: new Uint8Array(bytes),
        headers: { 'Content-Type': input.contentType, 'x-upsert': 'false', 'cache-control': 'max-age=0' } }, { signal: input.signal });
    },
    async copy(from: StorageObjectRef, to: StorageObjectRef, input?: { signal?: AbortSignal }) {
      objectPath(from); objectPath(to);
      await request('copy', endpoint('/object/copy'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-upsert': 'false' },
        body: JSON.stringify({ bucketId: from.bucket, sourceKey: from.key, destinationBucket: to.bucket, destinationKey: to.key }) }, input);
    },
    async remove(ref: StorageObjectRef, input?: { signal?: AbortSignal }) {
      objectPath(ref);
      await request('remove', endpoint('/object/' + encodeURIComponent(ref.bucket)), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [ref.key] }) }, input);
    },
    async createSignedDownload(ref: StorageObjectRef, expiresInSeconds: number) {
      if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 60) throw new ObjectProviderError('STORAGE_LIMIT');
      const bytes = await request('sign-download', endpoint('/object/sign/' + objectPath(ref)), { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: expiresInSeconds }) });
      return parseSigned(ref, signedValue(bytes, 'signedURL'), false).href;
    },
    async createSignedUpload(ref: StorageObjectRef) {
      if (!ref.key.startsWith(options.keyPrefix + '/staging/')) throw new ObjectProviderError('STORAGE_REFERENCE_DENIED');
      const bytes = await request('sign-upload', endpoint('/object/upload/sign/' + objectPath(ref)), { method: 'POST', headers: { 'x-upsert': 'false' } });
      return parseSigned(ref, signedValue(bytes, 'url'), true).href;
    },
    async uploadSigned(ref: StorageObjectRef, signedUrl: string, bytes: Buffer, contentType: string) {
      checkUpload(bytes);
      if (!ref.key.startsWith(options.keyPrefix + '/staging/')) throw new ObjectProviderError('STORAGE_REFERENCE_DENIED');
      await request('signed-upload', parseSigned(ref, signedUrl, true), { method: 'PUT', headers: { 'Content-Type': contentType, 'x-upsert': 'false' }, body: new Uint8Array(bytes) }, { credential: false });
    },
  });
}
