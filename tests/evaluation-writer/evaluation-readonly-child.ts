import fs from 'node:fs';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { Pool } from 'pg';
import { createSessionTestAuthority, type createSessionTestSigningAuthority } from '../session-writer/d-preparation';
import { createPostgresSessionCommandReader } from '../../server/db/postgres-session-writer';
import { createPostgresEvaluationWriter } from '../../server/db/postgres-evaluation-writer';
import { createServiceRealtimeServer, type ServiceRequestResources } from '../../server/request-realtime-server';
import { AUTHENTICATED_SESSION_ENVELOPE_VERSION, decodeAuthenticatedSessionEnvelope } from '../../server/contracts/authenticated-session-codec';
import { EvaluationWriterError } from '../../server/evaluation-writer/evaluation-writer-ports';
import { authenticatedEvaluationCommandSchema, evaluationCommandInputSha256 } from '../../server/evaluation-writer/service-evaluation';
import type { AuthenticatedRequestContext } from '../../server/auth/request-identity';
import { composeEvaluation } from './evaluation-composition';

if (process.env.PR07F_TEST_DISPOSABLE !== '1' || !process.env.PR07F_TEST_RUN_ID || !process.send) throw new Error('F_OWNED_READONLY_CHILD_REQUIRED');
const send = (value: unknown) => process.send?.(value);
interface Initial { type: 'initialize'; name: string; database: 'restore'; jwk: Awaited<ReturnType<typeof createSessionTestSigningAuthority>>['jwk']; tokens: Record<string, string> }
const initial = await new Promise<Initial>(resolve => {
  const receive = (value: Initial) => { if (value?.type === 'initialize') { process.off('message', receive); resolve(value); } };
  process.on('message', receive); send({ type: 'boot', pid: process.pid });
});
if (initial.database !== 'restore') throw new Error('F_READONLY_RESTORE_DATABASE_REQUIRED');
const forbidden = Object.keys(process.env).filter(key => /^PR07[BCDEF]_TEST_(?:(?:RESTORE_)?(?:ADMIN|MAPPING|BYPASS|WORKER)_URL|BOOTSTRAP_URL|STORAGE_SERVICE_KEY|STORAGE_ANON_KEY)$/u.test(key));
if (forbidden.length) throw new Error('F_READONLY_PRIVILEGED_CREDENTIAL_INHERITED');
const url = process.env.PR07F_TEST_RESTORE_REQUEST_URL;
if (!url || !/^\/pr07f_restore_[a-z0-9_]+$/u.test(new URL(url).pathname)) throw new Error('F_OWNED_RESTORE_DATABASE_REQUIRED');
const request = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000 });
const auth = createSessionTestAuthority({ request } as Parameters<typeof createSessionTestAuthority>[0], initial.jwk);
const counters = { localFileWrites: 0, localPrivateReads: 0, externalNetworkAttempts: 0, modelCalls: 0, paidProviderCalls: 0, storageReads: 0 };
const nativeRead = fs.promises.readFile.bind(fs.promises), nativeReadSync = fs.readFileSync.bind(fs);
const denyRead = (value: unknown) => { if (/\/server\/data\/|\/synthetic-input\//u.test(String(value).replaceAll('\\', '/'))) { counters.localPrivateReads++; throw new Error('F_READONLY_LOCAL_PRIVATE_READ'); } };
fs.promises.readFile = (async (...args: Parameters<typeof nativeRead>) => { denyRead(args[0]); return nativeRead(...args); }) as typeof nativeRead;
fs.readFileSync = ((...args: Parameters<typeof nativeReadSync>) => { denyRead(args[0]); return nativeReadSync(...args); }) as typeof nativeReadSync;
for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm', 'rmdir', 'unlink', 'truncate', 'rename'] as const)
  Object.assign(fs.promises, { [name]: async () => { counters.localFileWrites++; throw new Error('F_READONLY_LOCAL_WRITE'); } });
syncBuiltinESMExports();
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) { counters.externalNetworkAttempts++; throw new Error('F_READONLY_EXTERNAL_PROVIDER'); }
  return nativeFetch(input, options);
};
const nativeConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: Parameters<typeof nativeConnect>) {
  const value = args[0] as unknown, option = Array.isArray(value) ? value[0] : value;
  const host = option && typeof option === 'object' && 'host' in option ? String(option.host) : typeof args[1] === 'string' ? args[1] : 'localhost';
  if (!(option && typeof option === 'object' && 'path' in option) && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    counters.externalNetworkAttempts++; throw new Error('F_READONLY_EXTERNAL_NETWORK');
  }
  return Reflect.apply(nativeConnect, this, args);
} as typeof nativeConnect;
const sessions = createPostgresSessionCommandReader({ boundary: auth.identity, requestPool: request, environment: 'isolated-session-writer' });
const repository = createPostgresEvaluationWriter({ boundary: auth.identity, requestPool: request, environment: 'isolated-evaluation-writer' });
const evaluation = composeEvaluation({ identity: auth.identity, repository, sessions,
  async loadPinnedBank() { throw new EvaluationWriterError(503, 'F_READONLY_BANK_UNAVAILABLE'); } }, async context => { await auth.identity.revalidate(context); });
const resources: ServiceRequestResources = {
  kind: 'synthetic',
  async sessionBinding(context, id) {
    const found = await auth.authority.discoverSession(context, id); if (!found) return null;
    auth.identity.assertResource(context, found);
    const selected = auth.identity.selectScope(context, found) as AuthenticatedRequestContext;
    const snapshot = await sessions.read(selected, id); return snapshot?.created ? snapshot.binding : null;
  },
  async readStatus() { return { mode: 'readonly-restored-evaluation', modelEnabled: false }; },
  async readSession(context, binding) {
    const snapshot = await sessions.read(context, binding.sessionId); if (!snapshot) return null;
    return decodeAuthenticatedSessionEnvelope({ version: AUTHENTICATED_SESSION_ENVELOPE_VERSION,
      sessionJson: snapshot.sessionJson, sessionSha256: snapshot.sessionSha256, contextJson: snapshot.contextJson, contextSha256: snapshot.contextSnapshotSha256 }, binding.ownerId).session;
  },
  async audioBinding() { return null; }, async readAudio() { return null; },
};
const transport = createServiceRealtimeServer({ identity: auth.identity, resources, environment: 'test', evaluationMutations: {
  kind: evaluation.mutations.kind, query: evaluation.mutations.query,
  async command(context, binding, action, raw) {
    const input = authenticatedEvaluationCommandSchema.safeParse(raw);
    if (!input.success) throw new EvaluationWriterError(400, 'F_COMMAND_INVALID');
    const saved = await repository.receipt(context, { key: input.data.key, inputSha256: evaluationCommandInputSha256(binding.sessionId, action, input.data.payload) });
    if (!saved) throw new EvaluationWriterError(503, 'F_READONLY_RESTORE');
    // Existing immutable receipt replay remains possible. No new command can
    // reach a write-capable method, and the child has no writer/worker pool.
    return evaluation.mutations.command(context, binding, action, raw);
  },
} });
await new Promise<void>(resolve => transport.server.listen(0, '127.0.0.1', resolve));
const address = transport.server.address(); if (!address || typeof address === 'string') throw new Error('F_READONLY_LISTEN_FAILED');
async function state() { return { pid: process.pid, counters: { ...counters }, privilegedCredentialsInherited: false, mappingPoolPresent: false,
  adminPoolPresent: false, workerPoolPresent: false, storageCredentialsInherited: false, modelEnabled: false,
  request: { total: request.totalCount, idle: request.idleCount, waiting: request.waitingCount } }; }
process.on('message', (message: { type: string; requestId: string; operation: string }) => {
  if (message?.type !== 'control') return;
  void (async () => {
    if (message.operation === 'state') send({ type: 'control-result', requestId: message.requestId, result: await state() });
    else if (message.operation === 'stop') {
      await transport.close(); await request.end(); send({ type: 'control-result', requestId: message.requestId, result: { stopped: true } }); process.disconnect?.();
    } else throw new Error('F_READONLY_CONTROL_INVALID');
  })().catch(() => send({ type: 'control-result', requestId: message.requestId, error: { code: 'F_READONLY_CONTROL_FAILED' } }));
});
send({ type: 'ready', name: initial.name, port: address.port, roles: { request: (await request.query('SELECT current_user role')).rows[0].role }, ...(await state()) });
