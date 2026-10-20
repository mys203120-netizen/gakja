type CachedValue = { value: unknown; expiresAt: number; size: number };
type RequestCacheOptions = {
  fetcher?: typeof fetch;
  now?: () => number;
  enabled?: () => boolean;
  origin?: () => string;
  maxEntries?: number;
};

const privatePaths = new Set(['/api/learning', '/api/planner', '/api/study-sessions', '/api/knowledge-bites', '/api/quiz', '/api/schools', '/api/schools/catalog', '/api/training']);
const quizLibraryParams = new Set(['targetId', 'sourceType', 'sourceVersion', 'activityId', 'questionId', 'memoryItemId', 'mode']);
const maxValueSize = 512_000;
const maxTotalSize = 4_000_000;

function copy<T>(value: T): T {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function changedIdentityError() {
  return new DOMException('계정 정보가 변경됐어요. 다시 불러와 주세요.', 'AbortError');
}

function abortReason(signal: AbortSignal) {
  return signal.reason ?? new DOMException('요청을 취소했어요.', 'AbortError');
}

/** JSON reads only. Values live in this tab's memory, never an HTTP or persistent cache. */
export function createClientRequestCache(settings: RequestCacheOptions = {}) {
  const fetcher = settings.fetcher || ((url, init) => fetch(url, init));
  const now = settings.now || Date.now;
  const enabled = settings.enabled || (() => typeof window !== 'undefined');
  const origin = settings.origin || (() => window.location.origin);
  const limit = settings.maxEntries ?? 32;
  const values = new Map<string, CachedValue>();
  const pending = new Map<string, Promise<unknown>>();
  let identity = '';
  let identityRevision = 0;
  let generation = 0;
  let bootstrapSequence = 0;
  let totalSize = 0;

  function invalidate() {
    generation++;
    values.clear();
    pending.clear();
    totalSize = 0;
  }

  function reset() {
    invalidate();
    identity = '';
    identityRevision++;
  }

  /** Server-rendered authentication belongs to this tab, never to server module memory. */
  function seedIdentity(nextIdentity: string) {
    if (!enabled() || !nextIdentity || identity === nextIdentity) return;
    invalidate();
    identity = nextIdentity;
    identityRevision++;
  }

  function localUrl(url: string) {
    if (!enabled()) return null;
    try {
      const base = origin();
      const parsed = new URL(url, base);
      return parsed.origin === base && parsed.pathname.startsWith('/api/') ? parsed : null;
    } catch { return null; }
  }

  function lifetime(url: URL | null, options?: RequestInit) {
    if (!url || !identity || !privatePaths.has(url.pathname) || options?.body || options?.headers || options?.credentials === 'omit') return 0;
    if (options?.cache === 'no-store' || options?.cache === 'reload' || options?.cache === 'no-cache') return 0;
    // A session, recording or detail is mutable or private media: only quiz library reads qualify.
    if (url.pathname === '/api/quiz' && [...url.searchParams.keys()].some(key => !quizLibraryParams.has(key))) return 0;
    if (url.pathname === '/api/study-sessions' && url.searchParams.has('id')) return 0;
    if (url.pathname === '/api/knowledge-bites' && url.searchParams.has('videoId')) return 0;
    if (url.pathname === '/api/training' && [...url.searchParams.keys()].some(key => key !== 'targetId' && key !== 'viewScope')) return 0;
    return url.pathname.startsWith('/api/schools') ? 60_000 : url.pathname === '/api/training' ? 3_000 : url.pathname === '/api/study-sessions' ? 5_000 : 15_000;
  }

  function peek<T = any>(url: string): T | undefined {
    const parsed = localUrl(url);
    if (!lifetime(parsed)) return;
    const entry = values.get(`${identity}:${parsed!.href}`);
    return entry && entry.expiresAt > now() ? copy(entry.value) as T : undefined;
  }

  function store(key: string, value: unknown, ttl: number) {
    const serialized = JSON.stringify(value);
    const size = serialized.length * 2;
    if (size > maxValueSize || limit < 1) return;
    while (values.size >= limit || totalSize + size > maxTotalSize) {
      const oldest = values.keys().next().value;
      if (oldest === undefined) break;
      totalSize -= values.get(oldest)!.size;
      values.delete(oldest);
    }
    values.set(key, { value: copy(value), expiresAt: now() + ttl, size });
    totalSize += size;
  }

  async function request<T = any>(url: string, options?: RequestInit): Promise<T> {
    if (options?.signal?.aborted) throw abortReason(options.signal);
    const method = (options?.method || 'GET').toUpperCase();
    const read = method === 'GET';
    const mutation = method !== 'GET' && method !== 'HEAD';
    const parsed = localUrl(url);
    const authentication = parsed?.pathname === '/api/auth' || parsed?.pathname.startsWith('/api/auth/');
    const bootstrap = read && parsed?.pathname === '/api/bootstrap';
    // Bootstrap is an explicit shell refresh as well as the authentication boundary.
    // It also catches mutations made through sendBeacon or direct fetch helpers.
    if (bootstrap) invalidate();
    if (mutation) authentication ? reset() : invalidate();
    const revision = identityRevision;
    const requestGeneration = generation;
    const sequence = bootstrap ? ++bootstrapSequence : 0;
    const ttl = read ? lifetime(parsed, options) : 0;
    const key = ttl ? `${identity}:${parsed!.href}` : '';

    const execute = async () => {
      try {
        const headers = new Headers(options?.headers);
        if (!(options?.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
        // No browser/proxy HTTP cache, including callers requesting force-cache.
        // An eligible read belongs to every subscriber, not the first caller's
        // signal. Mutable/session requests retain native fetch cancellation.
        const response = await fetcher(url, { ...options, ...(key ? { signal: undefined } : {}), headers, cache: 'no-store' });
        if (parsed && read && identityRevision !== revision) throw changedIdentityError();
        if (response.status === 401) reset();
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || result.message || '요청을 처리하지 못했습니다.');
        if (parsed && read && identityRevision !== revision) throw changedIdentityError();
        if (bootstrap && requestGeneration === generation && sequence === bootstrapSequence) {
          const nextIdentity = typeof result.user?.id === 'string' ? result.user.id : '';
          if (nextIdentity !== identity) {
            invalidate();
            identity = nextIdentity;
            identityRevision++;
          }
        }
        if (key && generation === requestGeneration && identityRevision === revision) store(key, result, ttl);
        return result;
      } finally {
        // A read started during a write cannot repopulate the old generation later.
        if (mutation) authentication ? reset() : invalidate();
      }
    };

    if (!key) return execute();
    const subscribe = (work: Promise<unknown>): Promise<T> => new Promise((resolve, reject) => {
      const signal = options?.signal;
      let settled = false;
      const cleanup = () => { signal?.removeEventListener('abort', abort); };
      const abort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(abortReason(signal!));
      };
      // Install the listener before awaiting even a cache hit. Preserve the
      // caller's TimeoutError/custom reason, and release listeners on every path.
      signal?.addEventListener('abort', abort, { once: true });
      work.then(value => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          if (identityRevision !== revision) throw changedIdentityError();
          resolve(copy(value) as T);
        } catch (error) { reject(error); }
      }, error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
      if (signal?.aborted) abort();
    });
    const cached = values.get(key);
    if (cached && cached.expiresAt > now()) return subscribe(Promise.resolve(cached.value));
    if (cached) { totalSize -= cached.size; values.delete(key); }
    const existing = pending.get(key);
    if (existing) return subscribe(existing);
    const work = execute();
    pending.set(key, work);
    // An aborted subscriber must not remove an unfinished shared request.
    const release = () => { if (pending.get(key) === work) pending.delete(key); };
    void work.then(release, release);
    return subscribe(work);
  }

  return { request, invalidate, reset, seedIdentity, peek };
}

const clientRequests = createClientRequestCache();
export const requestJson = clientRequests.request;
export const invalidateClientRequestCache = clientRequests.invalidate;
export const resetClientRequestCache = clientRequests.reset;
export const seedClientRequestIdentity = clientRequests.seedIdentity;
export const peekRequestJson = clientRequests.peek;
