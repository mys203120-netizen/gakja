import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

export const conversationEventTypes = ['session.created', 'session.snapshot', 'question.prepared', 'acknowledgement.prepared', 'playback.started', 'playback.ended', 'stt.partial', 'stt.final', 'answer.relevance', 'ai.attempt', 'ai.validation', 'phase.changed', 'timings.observed', 'provider.config', 'rules.snapshot', 'sources.snapshot', 'session.ended', 'evaluation.status', 'error'] as const;
export interface ConversationEvent {
  eventId?: string;
  type: typeof conversationEventTypes[number] | (string & {});
  actor: 'system' | 'server' | 'client' | 'interviewer' | 'candidate' | 'provider';
  turnId?: string | null;
  answerId?: string | null;
  role?: string;
  payload?: unknown;
}
export interface ConversationLogRecord extends ConversationEvent { schemaVersion: 1; sessionId: string; seq: number; eventId: string; timestamp: string }
export interface ConversationLogError { code: string; message: string }
export interface ConversationLogStatus { sessionId: string; available: boolean | null; queued: number; appended: number; duplicates: number; failedCount: number; lastSeq: number; malformedLines: number; lastAppendedAt: string | null; lastError: ConversationLogError | null }
export interface ConversationAppendResult { ok: boolean; eventId: string; seq?: number; duplicate?: boolean; error?: ConversationLogError }
type SecretEnvironment = Record<string, string | undefined>;
const validSession = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const secretField = (name: string) => /(?:^|_)(?:api_keys?|secrets?(?:_key)?|access_tokens?|refresh_tokens?|passwords?|authorization|credentials?|client_id|client_secret|private_key|tokens?|keys?)(?:_(?:id|value|hash))?$/i.test(name.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[-\s]/g, '_'));
// Exact numeric usage counters are measurements, not bearer/access token values.
// Strings, generic token fields and credential-shaped names still follow redaction.
const usageCounters = new Set(['inputTokens', 'outputTokens', 'cachedInputTokens', 'reviewInputTokens', 'reviewOutputTokens', 'reviewCachedInputTokens', 'cacheWriteInputTokens', 'reviewCacheWriteInputTokens', 'input_tokens', 'output_tokens', 'cached_tokens', 'cache_write_tokens', 'ttl_30m_tokens', 'ttl_12h_tokens', 'reasoning_tokens', 'total_tokens']);
const safeUsageCounter = (name: string, value: unknown) => usageCounters.has(name) && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** No stack, binary media, environment dump or secret values are needed for local conversation review. */
export function maskConversationSecrets(value: unknown, environment: SecretEnvironment = process.env): unknown {
  const secrets = Object.entries(environment).filter(([key, item]) => item && /key|secret|token|password|credential|authorization|client_?id/i.test(key)).map(([, item]) => item!).sort((a, b) => b.length - a.length);
  const text = (input: string) => { let result = input; for (const secret of secrets) result = result.split(secret).join('[redacted]'); return result.replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[redacted]').replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]'); };
  const ancestors = new WeakSet<object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (typeof item === 'string') return text(item);
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') return Number.isFinite(item) ? item : null;
    if (typeof item === 'bigint') return item.toString();
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') return null;
    if (depth > 32) return '[depth_limit]';
    if (item instanceof Date) return Number.isFinite(item.getTime()) ? item.toISOString() : null;
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer || item instanceof Blob) return '[binary_omitted]';
    if (ancestors.has(item as object)) return '[circular]';
    ancestors.add(item as object);
    try {
      if (Array.isArray(item)) return item.map(child => visit(child, depth + 1));
      const input = item instanceof Error ? { name: item.name, message: item.message, ...Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'stack')), ...(item.cause !== undefined ? { cause: item.cause } : {}) } : item as Record<string, unknown>;
      return Object.fromEntries(Object.entries(input).map(([key, child]) => [text(key), secretField(key) && !safeUsageCounter(key, child) ? '[redacted]' : visit(child, depth + 1)]));
    } finally { ancestors.delete(item as object); }
  };
  return visit(value, 0);
}

type State = { status: ConversationLogStatus; eventIds: Map<string, number>; loaded: boolean; loadedVersion: number; needsNewline: boolean };
const fileQueues = new Map<string, Promise<unknown>>(), fileVersions = new Map<string, number>();
function serialize<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const pending = (fileQueues.get(file) ?? Promise.resolve()).catch(() => {}).then(operation);
  fileQueues.set(file, pending);
  void pending.finally(() => { if (fileQueues.get(file) === pending) fileQueues.delete(file); }).catch(() => {});
  return pending;
}
const emptyStatus = (sessionId: string): ConversationLogStatus => ({ sessionId, available: null, queued: 0, appended: 0, duplicates: 0, failedCount: 0, lastSeq: 0, malformedLines: 0, lastAppendedAt: null, lastError: null });
function failure(error: unknown): ConversationLogError { const code = error && typeof error === 'object' && 'code' in error ? String(error.code).replace(/[^A-Z0-9_]/g, '').slice(0, 48) : 'LOG_WRITE_FAILED'; return { code: code || 'LOG_WRITE_FAILED', message: '로컬 대화 로그를 기록하지 못했습니다.' }; }

/** Append-only, one local JSONL per session. Failures are returned, never thrown into interview flow. */
export class ConversationLogger {
  private states = new Map<string, State>();
  private directory: string;
  constructor(options: { directory?: string; environment?: SecretEnvironment | (() => SecretEnvironment) } = {}) { this.directory = path.resolve(options.directory ?? path.join(process.cwd(), 'data/conversation-logs')); this.environment = options.environment ?? (() => process.env); }
  private environment: SecretEnvironment | (() => SecretEnvironment);
  private state(sessionId: string) { let state = this.states.get(sessionId); if (!state) { state = { status: emptyStatus(sessionId), eventIds: new Map(), loaded: false, loadedVersion: -1, needsNewline: false }; this.states.set(sessionId, state); } return state; }
  private async load(file: string, sessionId: string, state: State) {
    const version = fileVersions.get(file) ?? 0; if (state.loaded && state.loadedVersion === version) return;
    let content = ''; try { content = await readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    state.eventIds.clear(); state.status.lastSeq = 0; state.status.malformedLines = 0;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { const row = JSON.parse(line); if (row.sessionId !== sessionId || !Number.isSafeInteger(row.seq) || row.seq < 1 || typeof row.eventId !== 'string') throw new Error('Invalid log row'); state.status.lastSeq = Math.max(state.status.lastSeq, row.seq); state.eventIds.set(row.eventId, row.seq); }
      catch { state.status.malformedLines++; }
    }
    state.needsNewline = Boolean(content && !content.endsWith('\n')); state.loaded = true; state.loadedVersion = version;
  }
  append(sessionId: string, event: ConversationEvent): Promise<ConversationAppendResult> {
    const suppliedId = event.eventId ?? randomUUID();
    if (!validSession(sessionId) || !/^[a-z][a-z0-9_.:-]{0,95}$/i.test(event.type) || !/^[A-Za-z0-9_.:-]{1,160}$/.test(suppliedId)) return Promise.resolve({ ok: false, eventId: '[invalid]', error: { code: 'INVALID_LOG_EVENT', message: '대화 로그 식별자가 올바르지 않습니다.' } });
    let safe: ConversationEvent;
    try { safe = maskConversationSecrets({ ...event, eventId: suppliedId }, typeof this.environment === 'function' ? this.environment() : this.environment) as ConversationEvent; }
    catch { return Promise.resolve({ ok: false, eventId: '[invalid]', error: { code: 'LOG_SERIALIZATION_FAILED', message: '대화 로그 데이터를 준비하지 못했습니다.' } }); }
    const timestamp = new Date().toISOString(), file = path.join(this.directory, `${sessionId}.jsonl`), state = this.state(sessionId); state.status.queued++;
    return serialize(file, async () => {
      const eventId = safe.eventId!;
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 }); await this.load(file, sessionId, state);
        const duplicate = state.eventIds.get(eventId); if (duplicate !== undefined) { state.status.duplicates++; state.status.available = true; return { ok: true, eventId, seq: duplicate, duplicate: true }; }
        const seq = state.status.lastSeq + 1;
        const row: ConversationLogRecord = { ...safe, schemaVersion: 1, sessionId, seq, eventId, timestamp };
        const handle = await open(file, 'a', 0o600);
        try { await handle.chmod(0o600); await handle.writeFile(`${state.needsNewline ? '\n' : ''}${JSON.stringify(row)}\n`); } finally { await handle.close(); }
        state.eventIds.set(eventId, seq); state.status.lastSeq = seq; state.status.appended++; state.status.lastAppendedAt = timestamp; state.status.available = true; state.status.lastError = null; state.needsNewline = false;
        const version = (fileVersions.get(file) ?? 0) + 1; fileVersions.set(file, version); state.loadedVersion = version;
        return { ok: true, eventId, seq };
      } catch (error) { const diagnostic = failure(error); state.status.available = false; state.status.failedCount++; state.status.lastError = diagnostic; state.loaded = false; return { ok: false, eventId, error: diagnostic }; }
      finally { state.status.queued--; }
    });
  }
  getStatus(sessionId?: string): ConversationLogStatus[] { return [...this.states.values()].filter(state => !sessionId || state.status.sessionId === sessionId).map(state => ({ ...state.status, lastError: state.status.lastError ? { ...state.status.lastError } : null })); }
  async flush(sessionId?: string): Promise<ConversationLogStatus[]> {
    const states = [...this.states.values()].filter(state => !sessionId || state.status.sessionId === sessionId);
    await Promise.all(states.map(state => {
      const file = path.join(this.directory, `${state.status.sessionId}.jsonl`);
      return serialize(file, async () => { if (!state.status.available || !state.status.lastSeq) return; try { const handle = await open(file, 'r+'); try { await handle.sync(); } finally { await handle.close(); } } catch (error) { state.status.available = false; state.status.failedCount++; state.status.lastError = failure(error); } });
    }));
    return this.getStatus(sessionId);
  }
}
const defaultLogger = new ConversationLogger();
export const appendConversationEvent = (sessionId: string, event: ConversationEvent) => defaultLogger.append(sessionId, event);
export const flushConversationLog = (sessionId?: string) => defaultLogger.flush(sessionId);
export const getConversationLogStatus = (sessionId?: string) => defaultLogger.getStatus(sessionId);
