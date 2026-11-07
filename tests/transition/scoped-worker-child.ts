import { createPostgresTransitionRepository } from '../../server/transition/postgres-transition';
import { createTransitionServiceAuthority } from '../../server/transition/transition-ports';
import { createScopedServiceAuthority } from '../../server/service/scoped-authority';
import fs from 'node:fs';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createSessionTestAuthority, type createSessionTestSigningAuthority } from '../session-writer/d-preparation';
import { createScopedPostgresSessionCommandReader } from '../../server/db/postgres-session-writer';
import { createScopedPostgresEvaluationWriter, createEvaluationWorkerCapability, type EvaluationWorkerAuthority } from '../../server/db/postgres-evaluation-writer';
import { createScopedEvaluationWorker,createRehearsalEvaluationProvider } from '../../server/evaluation-writer/isolated-evaluation-worker';
import { createTrustedAuthenticatedEvaluationWorkerExecution } from '../../server/internal-execution';
import type { AuthenticatedRequestContext } from '../../server/auth/request-identity';
import { composeScopedEvaluation } from './scoped-evaluation-composition';
import { syntheticEvaluationResponse } from '../evaluation-writer/synthetic-model';

if (process.env.PR07G_TEST_DISPOSABLE !== '1' || !process.env.PR07G_TEST_RUN_ID || !process.send) throw new Error('F_OWNED_WORKER_REQUIRED');
const send = (value: unknown) => process.send?.(value);
interface Initial { type: 'initialize'; name: string; database: 'primary' | 'restore'; jwk: Awaited<ReturnType<typeof createSessionTestSigningAuthority>>['jwk']; tokens: Record<string, string> }
const initial = await new Promise<Initial>(resolve => { const receive = (m: Initial) => { if (m?.type === 'initialize') { process.off('message', receive); resolve(m); } }; process.on('message', receive); send({ type: 'boot', pid: process.pid }); });
const forbiddenCredentialNames = Object.keys(process.env).filter(key => /^PR07[BCDEFG]_TEST_(?:(?:RESTORE_)?(?:ADMIN|MAPPING|BYPASS)_URL|BOOTSTRAP_URL|STORAGE_SERVICE_KEY|STORAGE_ANON_KEY)$/u.test(key));
if (forbiddenCredentialNames.length) throw new Error('F_WORKER_PRIVILEGED_CREDENTIAL_INHERITED');
const makePool = (role: string) => {
  const url = process.env['PR07G_TEST_' + (initial.database === 'restore' ? 'RESTORE_' : '') + role + '_URL'];
  if (!url || !/^\/pr07g_[a-z0-9_]+$/u.test(new URL(url).pathname)) throw new Error('F_OWNED_DATABASE_REQUIRED');
  return new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000 });
};
const request = makePool('REQUEST'), worker = makePool('WORKER');
// The identity factory uses only its request pool; no mapping/admin/bypass
// pool exists in this process, even as a credential-bearing dormant object.
const auth = createSessionTestAuthority({ request } as Parameters<typeof createSessionTestAuthority>[0], initial.jwk);
const counters = { modelCalls: 0, localFileWrites: 0, localPrivateReads: 0, externalNetworkAttempts: 0, paidProviderCalls: 0 };
const modelInputs:Array<{model:string;turnIds:string[]}>=[];
const nativeRead = fs.promises.readFile.bind(fs.promises), nativeReadSync = fs.readFileSync.bind(fs);
const deniedRead = (value: unknown) => { const name = String(value).replaceAll('\\', '/'); if (/\/server\/data\/|\/synthetic-input\//u.test(name)) { counters.localPrivateReads++; throw new Error('F_WORKER_LOCAL_PRIVATE_READ'); } };
fs.promises.readFile = (async (...args: Parameters<typeof nativeRead>) => { deniedRead(args[0]); return nativeRead(...args); }) as typeof nativeRead;
fs.readFileSync = ((...args: Parameters<typeof nativeReadSync>) => { deniedRead(args[0]); return nativeReadSync(...args); }) as typeof nativeReadSync;
for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm', 'rmdir', 'unlink', 'truncate', 'rename'] as const) Object.assign(fs.promises, { [name]: async () => { counters.localFileWrites++; throw new Error('F_WORKER_LOCAL_WRITE'); } });
syncBuiltinESMExports();
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, options) => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) { counters.externalNetworkAttempts++; throw new Error('F_WORKER_EXTERNAL_PROVIDER'); } return nativeFetch(input, options); };
const nativeConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: Parameters<typeof nativeConnect>) { const raw = args[0] as unknown, option = Array.isArray(raw) ? raw[0] : raw;
  const host = option && typeof option === 'object' && 'host' in option ? String(option.host) : typeof args[1] === 'string' ? args[1] : 'localhost';
  if (!(option && typeof option === 'object' && 'path' in option) && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) { counters.externalNetworkAttempts++; throw new Error('F_WORKER_EXTERNAL_NETWORK'); } return Reflect.apply(nativeConnect, this, args); } as typeof nativeConnect;
const transitions=createPostgresTransitionRepository({identity:auth.identity,requestPool:request});
const authority=createScopedServiceAuthority(createTransitionServiceAuthority({mode:'rehearsal',identity:auth.identity,repository:transitions}),'rehearsal');
const sessions = createScopedPostgresSessionCommandReader({authority,boundary:auth.identity,requestPool:request});
const actualRepository = createScopedPostgresEvaluationWriter({authority,boundary:auth.identity,requestPool:request,workerPool:worker});
let holdModel = false, failModel = false, terminalModelFailure = false, holdAfterWorker = false,holdAfterCheckpoint=false;
const holds = new Map<string, () => void>(), aborts = new Map<string, AbortController>();
const repository={...actualRepository,workerJobs(context:Parameters<typeof actualRepository.workerJobs>[0],capability:Parameters<typeof actualRepository.workerJobs>[1]){
  const actual=actualRepository.workerJobs(context,capability);return {...actual,async checkpoint(...args:Parameters<typeof actual.checkpoint>){
    const result=await actual.checkpoint(...args);
    if(holdAfterCheckpoint){const id=randomUUID();await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{holds.delete(id);reject(new Error('F_CHECKPOINT_BARRIER_TIMEOUT'));},30_000);holds.set(id,()=>{clearTimeout(timer);holds.delete(id);resolve();});send({type:'barrier',phase:'checkpoint',barrierId:id,detail:{jobId:args[0],clusterId:args[2].clusterId}});});}
    return result;
  }};
}};
const service = composeScopedEvaluation({authority,identity:auth.identity,repository,sessions,async loadPinnedBank(){throw new Error('G_WORKER_CANNOT_SUPPLY_REGISTRY');},async assertTrustCurrent(context){await auth.identity.revalidate(context);}});
const engine = createScopedEvaluationWorker({authority,identity:auth.identity, repository, sessions, service,
  async observe(phase) {
    if(phase==='after-worker'&&holdAfterWorker){const id=randomUUID();await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{holds.delete(id);reject(new Error('F_AFTER_WORKER_BARRIER_TIMEOUT'));},30_000);holds.set(id,()=>{clearTimeout(timer);holds.delete(id);resolve();});send({type:'barrier',phase:'after-worker',barrierId:id});});}
  },
  provider:createRehearsalEvaluationProvider(authority,async(input,execution)=>{
    const measured=JSON.parse(input.input) as {answers:Array<{id:string}>};modelInputs.push({model:input.model,turnIds:measured.answers.map(answer=>answer.id)});
    counters.modelCalls++; const callId = randomUUID(); send({ type: 'model-start', callId, pid: process.pid, model: input.model });
    if (holdModel) await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { holds.delete(callId); reject(new Error('F_MODEL_BARRIER_TIMEOUT')); }, 30_000); holds.set(callId, () => { clearTimeout(timer); holds.delete(callId); resolve(); }); send({ type: 'barrier', phase: 'model', barrierId: callId }); });
    if (failModel) throw Object.assign(new Error(terminalModelFailure ? 'Explicit synthetic terminal provider failure' : 'Explicit synthetic transient provider failure'), { status: terminalModelFailure ? 400 : 503 });
    return syntheticEvaluationResponse(input, execution);
  }) });
async function contextFor(who: string): Promise<AuthenticatedRequestContext> { return auth.identity.selectScope(await auth.identity.authenticate('Bearer ' + initial.tokens[who]), { applicationTargetId: 'shadow-app-' + (who.startsWith('b') ? 'b' : 'a') }) as AuthenticatedRequestContext; }
async function state() { return { pid: process.pid, counters: { ...counters }, modelInputs, privilegedCredentialsInherited: false, mappingPoolPresent: false, adminPoolPresent: false, storageCredentialsInherited: false,
  request: { total: request.totalCount, idle: request.idleCount, waiting: request.waitingCount }, worker: { total: worker.totalCount, idle: worker.idleCount, waiting: worker.waitingCount } }; }
process.on('message', (message: { type: string; requestId: string; operation: string; payload?: Record<string, unknown> }) => {
  if (message?.type !== 'control') return;
  void (async () => { const p = message.payload ?? {}; let result: unknown;
    if (message.operation === 'configure') { holdModel = p.holdModel === true; failModel = p.failModel === true || p.failModel === 'terminal'; terminalModelFailure = p.failModel === 'terminal'; holdAfterWorker=p.holdAfterWorker===true;holdAfterCheckpoint=p.holdAfterCheckpoint===true; result = { configured: true }; }
    else if (message.operation === 'release') { const release = holds.get(String(p.barrierId)); if (!release) throw new Error('F_BARRIER_NOT_FOUND'); release(); result = { released: true }; }
    else if (message.operation === 'state') result = await state();
    else if (message.operation === 'probe-database') result = { request: (await request.query('SELECT pg_backend_pid() pid,current_user role')).rows[0], worker: (await worker.query('SELECT pg_backend_pid() pid,current_user role')).rows[0] };
    else if (message.operation === 'abort') { aborts.get(String(p.runId))?.abort(new Error('F_CONTROLLED_ABORT')); result = { aborted: true }; }
    else if (message.operation === 'run') {
      const context = await contextFor(String(p.who)), grant = p.grant as Omit<EvaluationWorkerAuthority, 'checkCurrent'>;
      if (grant.subjectId !== context.principal.subject || grant.ownerId !== context.account.ownerId) throw new Error('F_WORKER_GRANT_SUBJECT_INVALID');
      const capability = createEvaluationWorkerCapability({ ...grant, async checkCurrent() { try { await auth.identity.revalidate(context); return true; } catch { return false; } } });
      const jobs = repository.workerJobs(context, capability), execution = createTrustedAuthenticatedEvaluationWorkerExecution({ subjectId: grant.subjectId, issuedAt: Date.now() - 1000, expiresAt: grant.expiresAt, jobIds: grant.jobIds,
        scope: { ownerId: grant.ownerId, studentId: grant.studentId, applicationTargetId: grant.applicationTargetId, supportTargetId: grant.supportTargetId }, async resolveBinding(id) {
          if (!grant.jobIds.includes(id)) return null; const job = await jobs.get(id); if (!job) return null;
          return { jobId: job.id, ownerId: job.ownerId, sessionId: job.sessionId, studentId: grant.studentId, applicationTargetId: grant.applicationTargetId, supportTargetId: grant.supportTargetId,
            sourceSha256: job.sourceSha256, snapshotSha256: job.snapshotSha256, contextSnapshotSha256: job.contextSnapshotSha256, pipelineVersion: job.pipelineVersion, model: job.model };
        } });
      const controller = new AbortController(), runId = String(p.runId ?? message.requestId); aborts.set(runId, controller);
      try { result = await engine.run(context, { expectedTransitionGeneration:String(p.expectedTransitionGeneration??(await transitions.read(context))?.generation??''), jobId: String(p.jobId), workerId: initial.name, capability, execution, signal: controller.signal, ...(typeof p.leaseMs === 'number' ? { leaseMs: p.leaseMs } : {}) }); }
      finally { aborts.delete(runId); }
    } else if (message.operation === 'stop') { for (const release of holds.values()) release(); await Promise.all([request.end(), worker.end()]); send({ type: 'control-result', requestId: message.requestId, result: { stopped: true } }); process.disconnect?.(); return; }
    else throw new Error('F_WORKER_CONTROL_INVALID');
    send({ type: 'control-result', requestId: message.requestId, result });
  })().catch(error => send({ type: 'control-result', requestId: message.requestId, error: { code: typeof error?.code === 'string' ? error.code : error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : 'F_WORKER_CONTROL_FAILED' } }));
});
send({ type: 'ready', name: initial.name, ...(await state()), roles: { request: (await request.query('SELECT current_user role')).rows[0].role, worker: (await worker.query('SELECT current_user role')).rows[0].role } });
