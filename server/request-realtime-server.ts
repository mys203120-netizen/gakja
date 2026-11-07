import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import type { InterviewSession } from './protocol';
import { createRequestIdentityBoundary, RequestAccessError, type RequestContext, type ResourceBinding } from './auth/request-identity';
import type { ServiceSessionMutations } from './session-writer/service-session-mutations';
import { SessionCommandError } from './session-writer/session-command-ports';
import { SessionDomainError } from './session-lifecycle';
import { TurnWorkError } from './turn-work';
import { EvaluationWriterError } from './evaluation-writer/evaluation-writer-ports';
import type { ServiceEvaluationMutations, EvaluationQueryAction, EvaluationMutationAction } from './evaluation-writer/service-evaluation';

type IdentityBoundary = ReturnType<typeof createRequestIdentityBoundary>;
type AuthenticatedContext = Extract<RequestContext, { mode: 'authenticated' }>;
export interface SessionAccessBinding extends ResourceBinding {
  sessionId: string;
  contextSnapshotSha256: string;
}
export interface AudioAccessBinding extends ResourceBinding {
  resourceId: string;
  /** Optional C-only digest of the exact verified object binding. Existing
   * domain/audio IDs stay unchanged; in-flight reads include this frozen pin. */
  objectIdentity?: string;
  contentType?: 'audio/mpeg' | 'audio/wav';
}
/** Trusted metadata is resolved before any session recovery, private bytes or
 * provider operation. This is an injected server composition, never a DTO. */
export interface ServiceRequestResources {
  kind: 'operational' | 'synthetic';
  sessionBinding(context: AuthenticatedContext, id: string): Promise<SessionAccessBinding | null>;
  audioBinding(context: AuthenticatedContext, id: string): Promise<AudioAccessBinding | null>;
  readStatus(context: AuthenticatedContext): Promise<unknown>;
  readSession(context: AuthenticatedContext, binding: SessionAccessBinding): Promise<InterviewSession | null>;
  readAudio(context: AuthenticatedContext, binding: AudioAccessBinding): Promise<Buffer | null>;
}
export interface ServiceRealtimeOptions {
  identity?: IdentityBoundary;
  resources?: ServiceRequestResources;
  /** E only: a trusted, explicitly isolated mutation composition. Default
   * service and production requests retain the existing mutation503 boundary. */
  sessionMutations?: ServiceSessionMutations;
  /** Explicit F isolation only. No service/production evaluation writer fallback. */
  evaluationMutations?: ServiceEvaluationMutations;
  environment?: 'operational' | 'test';
  webPort?: number;
  allowedOrigins?: readonly string[];
  allowedHosts?: readonly string[];
  now?: () => number;
  ticketLifetimeMs?: number;
  accessCheckIntervalMs?: number;
}
const sessionPattern = /^\/api\/sessions\/([0-9a-f-]{36})(?:\/(next|answer|answer-candidate|capture-start|capture-finish|recover|context|end|closing|retry-evaluation|timings|events|commands|realtime-ticket))?$/u;
const evaluationPattern = /^\/api\/sessions\/([0-9a-f-]{36})\/evaluation(?:\/(registry|review|approval|withdraw|consume|retry|commands|revision))?$/u;
const unavailable = () => new RequestAccessError(503, 'AUTHENTICATED_STORAGE_UNAVAILABLE');
const notFound = () => new RequestAccessError(404, 'RESOURCE_NOT_FOUND');
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', Vary: 'Authorization, Cookie', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
const sessionGuardCodes = new Set(['ANSWER_ADVANCE_LOCKED', 'ANSWER_CANDIDATE_SOURCE_CHANGED', 'CAPTURE_FINAL_NOT_CONFIRMED', 'CAPTURE_PART_CHANGED']);
function requestFailure(error: unknown) {
  if (error instanceof RequestAccessError || error instanceof SessionCommandError || error instanceof SessionDomainError || error instanceof TurnWorkError || error instanceof EvaluationWriterError)
    return { status: error.status, code: error.code ?? 'SESSION_DOMAIN_CONFLICT' };
  // These existing shared domain guards throw exact bounded codes. Preserve a
  // conflict response without exposing arbitrary provider exception messages.
  if (error instanceof Error && sessionGuardCodes.has(error.message)) return { status: 409, code: error.message };
  return { status: 503, code: 'REQUEST_DEPENDENCY_UNAVAILABLE' };
}
function fail(res: ServerResponse, error: unknown) {
  const { status, code } = requestFailure(error);
  send(res, status, { error: status === 404 ? '요청한 자료를 찾을 수 없습니다.' : status === 401 ? '인증을 확인해 주세요.' : '요청을 처리할 수 없습니다.', code });
}
async function body(req: IncomingMessage, maxBytes = 16_384) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw new RequestAccessError(413, 'INVALID_REQUEST'); chunks.push(Buffer.from(chunk)); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown; }
  catch { throw new RequestAccessError(400, 'INVALID_REQUEST'); }
}
function onlyAuthenticated(context: RequestContext): asserts context is AuthenticatedContext {
  if (context.mode !== 'authenticated') throw new RequestAccessError(503, 'IDENTITY_CONFIGURATION_INVALID');
}
function selection(url: URL) {
  return Object.fromEntries(['studentId', 'applicationTargetId', 'supportTargetId'].flatMap(key => url.searchParams.has(key) ? [[key, url.searchParams.get(key)!]] : []));
}
function rejectIdentitySpoof(req: IncomingMessage, url: URL) {
  if (['owner', 'ownerId', 'role', 'accountId', 'token', 'access_token'].some(key => url.searchParams.has(key)) ||
    ['x-owner-id', 'x-account-id', 'x-role', 'x-student-id', 'x-target-id', 'x-support-target-id'].some(key => req.headers[key] !== undefined)) throw new RequestAccessError(400, 'CLIENT_IDENTITY_NOT_ALLOWED');
}
function flightKey(context: AuthenticatedContext, kind: string, id = '', binding?: ResourceBinding) {
  const scope = context.scope;
  return JSON.stringify([context.principal.issuer, context.principal.subject, context.account.accountId, context.account.ownerId, context.account.revision,
    scope?.studentId ?? null, scope?.applicationTargetId ?? null, scope?.supportTargetId ?? null, scope?.sourceRevision ?? null, kind, id, binding ?? null]);
}

/** Service HTTP/WSS boundary. The existing runtime-v1 local writer is deliberately
 * not a service writer. Supported service operations are explicitly read-only. */
export function createServiceRealtimeServer(options: ServiceRealtimeOptions = {}) {
  const identity = options.identity ?? createRequestIdentityBoundary({ mode: 'service' });
  const now = options.now ?? Date.now;
  const lifetime = Math.min(30_000, Math.max(1, options.ticketLifetimeMs ?? 30_000));
  const checkInterval = Math.min(5_000, Math.max(10, options.accessCheckIntervalMs ?? 5_000));
  const tickets = new Map<string, { context: AuthenticatedContext; binding: SessionAccessBinding; expiresAt: number }>();
  const flights = new Map<string, Promise<unknown>>();
  const sockets = new Set<WebSocket>();
  const resources = () => {
    if (!options.resources || options.resources.kind === 'synthetic' && (options.environment !== 'test' || process.env.NODE_ENV === 'production')) throw unavailable();
    return options.resources;
  };
  const mutations = () => {
    if (!options.sessionMutations || options.sessionMutations.kind !== 'isolated-db-session-writer' ||
      options.environment !== 'test' || process.env.NODE_ENV === 'production') throw unavailable();
    return options.sessionMutations;
  };
  const evaluations = () => {
    if (!options.evaluationMutations || options.evaluationMutations.kind !== 'isolated-db-evaluation-writer' ||
      options.environment !== 'test' || process.env.NODE_ENV === 'production') throw unavailable();
    return options.evaluationMutations;
  };
  const singleFlight = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const existing = flights.get(key); if (existing) return existing as Promise<T>;
    const pending = operation(); flights.set(key, pending);
    try { return await pending; } finally { if (flights.get(key) === pending) flights.delete(key); }
  };
  const guard = (req: IncomingMessage, websocket = false) => {
    const address = server.address(), ownPort = typeof address === 'object' && address ? address.port : 3001;
    const allowedHosts = new Set([`127.0.0.1:${ownPort}`, `localhost:${ownPort}`, `127.0.0.1:${options.webPort ?? 3000}`, `localhost:${options.webPort ?? 3000}`, ...(options.allowedHosts ?? [])]);
    const origins = new Set([`http://127.0.0.1:${ownPort}`, `http://localhost:${ownPort}`, `http://127.0.0.1:${options.webPort ?? 3000}`, `http://localhost:${options.webPort ?? 3000}`, ...(options.allowedOrigins ?? [])]);
    if (!allowedHosts.has(req.headers.host ?? '') || req.headers['sec-fetch-site'] === 'cross-site' || req.headers.origin && !origins.has(req.headers.origin) || websocket && !req.headers.origin) throw new RequestAccessError(403, 'REQUEST_ORIGIN_DENIED');
  };
  const authenticate = async (req: IncomingMessage, url: URL) => {
    rejectIdentitySpoof(req, url);
    const context = await identity.authenticate(req.headers.authorization); onlyAuthenticated(context);
    return identity.selectScope(context, selection(url)) as AuthenticatedContext;
  };
  const checkBinding = (context: AuthenticatedContext, binding: ResourceBinding) => {
    try { identity.assertResource(context, binding); } catch (error) { if (error instanceof RequestAccessError && error.status === 503) throw error; throw notFound(); }
  };
  const sessionAccess = async (context: AuthenticatedContext, id: string) => {
    const found = await resources().sessionBinding(context, id);
    if (!found || found.sessionId !== id || !/^[0-9a-f]{64}$/u.test(found.contextSnapshotSha256)) throw notFound();
    const binding = Object.freeze({ ownerId: found.ownerId, studentId: found.studentId, applicationTargetId: found.applicationTargetId,
      supportTargetId: found.supportTargetId, ...(found.sourceRevision === undefined ? {} : { sourceRevision: found.sourceRevision }),
      sessionId: found.sessionId, contextSnapshotSha256: found.contextSnapshotSha256 });
    checkBinding(context, binding);
    return { context: identity.selectScope(context, binding) as AuthenticatedContext, binding };
  };
  const audioAccess = async (context: AuthenticatedContext, id: string) => {
    const found = await resources().audioBinding(context, id);
    if (!found || found.resourceId !== id || found.objectIdentity !== undefined && !/^[a-f0-9]{64}$/u.test(found.objectIdentity) ||
      found.contentType !== undefined && !['audio/mpeg','audio/wav'].includes(found.contentType)) throw notFound();
    const binding = Object.freeze({ ownerId: found.ownerId, studentId: found.studentId, applicationTargetId: found.applicationTargetId,
      supportTargetId: found.supportTargetId, ...(found.sourceRevision === undefined ? {} : { sourceRevision: found.sourceRevision }), resourceId: found.resourceId,
      ...(found.objectIdentity === undefined ? {} : { objectIdentity: found.objectIdentity }),
      ...(found.contentType === undefined ? {} : { contentType: found.contentType }) });
    checkBinding(context, binding);
    return { context: identity.selectScope(context, binding) as AuthenticatedContext, binding };
  };
  const refresh = async (context: AuthenticatedContext, binding?: ResourceBinding) => {
    const current = await identity.revalidate(context); onlyAuthenticated(current);
    if (binding) checkBinding(current, binding);
    return current;
  };
  const server = http.createServer(async (req, res) => {
    try {
      guard(req); const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { app: 'each-answer-interview', ok: true, mode: 'service' });
      const context = await authenticate(req, url);
      if (req.method === 'POST' && url.pathname === '/api/sessions' && options.sessionMutations) {
        const current = await refresh(context), value = await mutations().create(current, await body(req));
        await refresh(current); return send(res, 201, value);
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        if (!context.scope) return send(res, 200, { authenticated: true, selectionRequired: true });
        const current = await refresh(context);
        const value = await singleFlight(flightKey(current, 'status'), () => resources().readStatus(current));
        await refresh(current); return send(res, 200, value);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/audio/')) {
        // Private audio is verified as one complete object before delivery.
        if (req.headers.range !== undefined) throw new RequestAccessError(416, 'INVALID_REQUEST');
        const id = url.pathname.slice('/api/audio/'.length);
        if (!id || !/^[A-Za-z0-9._-]+$/u.test(id) || id === '.' || id === '..') throw notFound();
        const access = await audioAccess(context, id), binding = access.binding;
        const scoped = await refresh(access.context, binding);
        const bytes = await singleFlight(flightKey(scoped, 'audio', id, binding), () => resources().readAudio(scoped, binding));
        const current = await refresh(scoped, binding), latest = await audioAccess(current, id);
        if (JSON.stringify(latest.binding) !== JSON.stringify(binding) || !bytes) throw notFound();
        await refresh(latest.context, binding);
        res.writeHead(200, { 'Content-Type': binding.contentType ?? 'audio/mpeg', 'Content-Length': bytes.length, 'Cache-Control': 'private, no-store', Vary: 'Authorization, Cookie', 'X-Content-Type-Options': 'nosniff' }); return void res.end(bytes);
      }
      const evaluation = evaluationPattern.exec(url.pathname);
      if (evaluation) {
        const access = await sessionAccess(context, evaluation[1]), current = await refresh(access.context, access.binding);
        let value: unknown;
        if (req.method === 'GET' && (!evaluation[2] || ['registry', 'review', 'approval', 'commands', 'revision'].includes(evaluation[2]))) {
          value = await evaluations().query(current, access.binding, (evaluation[2] ?? 'status') as EvaluationQueryAction,
            Object.fromEntries(url.searchParams.entries()));
        } else if (req.method === 'POST' && evaluation[2] && ['registry', 'approval', 'withdraw', 'consume', 'retry'].includes(evaluation[2])) {
          value = await evaluations().command(current, access.binding, evaluation[2] as EvaluationMutationAction, await body(req, 8 * 1024 * 1024));
        } else throw unavailable();
        const checked = await refresh(current, access.binding), latest = await sessionAccess(checked, evaluation[1]);
        if (JSON.stringify(latest.binding) !== JSON.stringify(access.binding)) throw notFound();
        return send(res, 200, value);
      }
      const match = sessionPattern.exec(url.pathname);
      if (match) {
        const access = await sessionAccess(context, match[1]);
        if (req.method === 'GET' && options.sessionMutations && (!match[2] || match[2] === 'context')) {
          const current = await refresh(access.context, access.binding);
          const value = match[2] === 'context' ? await mutations().context(current, access.binding) : await mutations().read(current, access.binding);
          const checked = await refresh(current, access.binding), latest = await sessionAccess(checked, match[1]);
          if (JSON.stringify(latest.binding) !== JSON.stringify(access.binding)) throw notFound();
          return send(res, 200, value);
        }
        if (req.method === 'GET' && match[2] === 'commands' && options.sessionMutations) {
          const current = await refresh(access.context, access.binding);
          const value = await mutations().receipt(current, access.binding, { key: url.searchParams.get('key') ?? '', inputSha256: url.searchParams.get('inputSha256') ?? '' });
          await refresh(current, access.binding); return send(res, 200, value);
        }
        if (req.method === 'GET' && !match[2]) {
          const scoped = await refresh(access.context, access.binding);
          const saved = await singleFlight(flightKey(scoped, 'session', match[1], access.binding), () => resources().readSession(scoped, access.binding));
          const current = await refresh(scoped, access.binding), latest = await sessionAccess(current, match[1]);
          if (JSON.stringify(latest.binding) !== JSON.stringify(access.binding)) throw notFound();
          await refresh(latest.context, access.binding);
          if (!saved || saved.id !== match[1] || saved.runtime?.owner.id !== access.binding.ownerId || saved.runtime.contextSnapshotSha256 !== access.binding.contextSnapshotSha256) throw notFound();
          return send(res, 200, saved);
        }
        if (req.method === 'POST' && match[2] === 'realtime-ticket') {
          const input = await body(req);
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new RequestAccessError(400, 'INVALID_REQUEST');
          const current = await refresh(access.context, access.binding), ticket = randomBytes(32).toString('base64url');
          const expiresAt = Math.min(current.principal.expiresAt, now() + lifetime);
          for (const [key, value] of tickets) if (value.expiresAt <= now()) tickets.delete(key);
          if (tickets.size >= 1024) throw new RequestAccessError(503, 'REALTIME_TICKET_LIMIT');
          tickets.set(ticket, { context: current, binding: access.binding, expiresAt });
          return send(res, 200, { ticket, expiresAt, sessionId: match[1], credential: 'single-use-session-ticket' });
        }
        if (req.method === 'POST' && match[2] && options.sessionMutations) {
          const current = await refresh(access.context, access.binding);
          const value = await mutations().command(current, access.binding, match[2], await body(req));
          await refresh(current, access.binding); return send(res, match[2] === 'end' ? 202 : 200, value);
        }
        if (req.method === 'POST') throw unavailable();
      }
      if (req.method === 'POST' && ['/api/prepare', '/api/sessions'].includes(url.pathname)) throw unavailable();
      throw notFound();
    } catch (error) { fail(res, error); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  server.on('upgrade', async (req, socket, head) => {
    try {
      guard(req, true); const url = new URL(req.url ?? '/', 'http://localhost'); rejectIdentitySpoof(req, url);
      if (url.pathname !== '/api/realtime' || [...url.searchParams.keys()].some(key => !['sessionId', 'ticket'].includes(key))) throw notFound();
      const ticket = url.searchParams.get('ticket') ?? '', stored = tickets.get(ticket); tickets.delete(ticket);
      if (!stored || stored.expiresAt <= now() || stored.binding.sessionId !== url.searchParams.get('sessionId')) throw new RequestAccessError(401, 'REALTIME_TICKET_INVALID');
      const current = await refresh(stored.context, stored.binding);
      const access = await sessionAccess(current, stored.binding.sessionId);
      if (JSON.stringify(access.binding) !== JSON.stringify(stored.binding)) throw notFound();
      const checked = await refresh(access.context, access.binding);
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, { ...access, context: checked }));
    } catch { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); }
  });
  wss.on('connection', (ws: WebSocket, access: { context: AuthenticatedContext; binding: SessionAccessBinding }) => {
    sockets.add(ws); let context = access.context, queue = Promise.resolve();
    let writerGeneration: string | undefined, connectionToken: string | undefined;
    const close = () => ws.close(1008, 'Access is no longer valid');
    const commandFailure = (error: unknown) => {
      if (!options.sessionMutations) { close(); return; }
      const { status, code } = requestFailure(error);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', status, code }));
      if ([401, 403, 404, 413].includes(status) || code === 'SESSION_STALE_SOCKET') close();
    };
    const check = async () => {
      context = await refresh(context, access.binding);
      const current = await sessionAccess(context, access.binding.sessionId);
      if (JSON.stringify(current.binding) !== JSON.stringify(access.binding)) throw notFound();
      context = await refresh(current.context, access.binding);
      if (writerGeneration !== undefined) await mutations().assertSocketCurrent(context, access.binding, writerGeneration);
    };
    const expire = setTimeout(close, Math.min(2_147_483_647, Math.max(1, context.principal.expiresAt - now())));
    const timer = setInterval(() => { queue = queue.then(check).catch(close); }, checkInterval);
    expire.unref(); timer.unref();
    if (options.sessionMutations) {
      queue = queue.then(async () => {
        await check(); const connected = await mutations().connect(context, access.binding);
        writerGeneration = connected.writerGeneration; connectionToken = connected.connectionToken;
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ready', sessionId: access.binding.sessionId, readOnly: false, writerGeneration }));
      }).catch(close);
    } else ws.send(JSON.stringify({ type: 'ready', sessionId: access.binding.sessionId, readOnly: true }));
    ws.on('message', (data, binary) => {
      // Audio persistence is unsupported here. Reject bytes without a remote
      // lookup per chunk; the bounded timer and expiry still close the socket.
      if (binary) {
        if (options.sessionMutations) {
          queue = queue.then(async () => {
            await check(); if (writerGeneration === undefined) throw unavailable();
            await mutations().audio(context, access.binding, writerGeneration, Buffer.from(data as Buffer), connectionToken!);
          }).catch(commandFailure); return;
        }
        if (now() >= context.principal.expiresAt) close();
        else if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', code: 'AUTHENTICATED_STORAGE_UNAVAILABLE' }));
        return;
      }
      queue = queue.then(async () => {
        await check(); if (ws.readyState !== WebSocket.OPEN) return;
        let message: unknown; try { message = JSON.parse(data.toString()); } catch { close(); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { close(); return; }
        const value = message as Record<string, unknown>;
        if (options.sessionMutations && value.type !== 'ping') {
          if (writerGeneration === undefined) throw unavailable();
          const response = await mutations().socket(context, access.binding, writerGeneration, value, connectionToken!);
          await check(); if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response)); return;
        }
        if (Object.keys(value).some(key => !['type', 'sessionId'].includes(key)) || value.sessionId !== undefined && value.sessionId !== access.binding.sessionId) { close(); return; }
        if (value.type === 'ping') ws.send(JSON.stringify({ type: 'pong', sessionId: access.binding.sessionId }));
        else ws.send(JSON.stringify({ type: 'error', code: 'AUTHENTICATED_STORAGE_UNAVAILABLE' }));
      }).catch(commandFailure);
    });
    ws.on('close', () => {
      clearTimeout(expire); clearInterval(timer); sockets.delete(ws);
      if (writerGeneration !== undefined && options.sessionMutations) {
        queue = queue.then(() => mutations().disconnect(context, access.binding, writerGeneration!, connectionToken!)).catch(() => {});
      }
    });
    ws.on('error', close);
  });
  const close = async () => { tickets.clear(); for (const ws of sockets) ws.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); };
  return { server, wss, close };
}
