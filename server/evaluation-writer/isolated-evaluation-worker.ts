import { assertScopedComponent, authorizeScoped, bindScopedComponent, scopedServiceAuthority, type ScopedServiceAuthority } from '../service/scoped-authority';
import { runScopedOperation } from '../service/scoped-command';
import type { AuthenticatedRequestContext, RequestIdentityBoundary } from '../auth/request-identity';
import { runEvaluationWorkerOnce } from '../evaluation-worker';
import { authenticatedEvaluationWorkerScope, assertWorkerMetadataBinding, type TrustedEvaluationWorkerExecution } from '../internal-execution';
import type { EvaluationSessionOptions } from '../providers/openai';
import type { StoredSessionEvaluationReviewReaders } from '../evaluation-supply';
import type { SessionCommandRepository } from '../session-writer/session-command-ports';
import { decodeSessionEvaluationHandoff } from './e-handoff-codec';
import { EvaluationWriterError, type EvaluationWorkerCapability, type EvaluationWriterRepository } from './evaluation-writer-ports';
import type { createIsolatedEvaluationService } from './isolated-evaluation-service';

type Service = Pick<ReturnType<typeof createIsolatedEvaluationService>, 'prepare'>;
export interface IsolatedEvaluationWorkerOptions {
  environment: 'isolated-evaluation-writer'; identity: RequestIdentityBoundary;
  repository: EvaluationWriterRepository; sessions: Pick<SessionCommandRepository, 'read'>; service: Service;
  provider: { kind: 'synthetic'; requestEvaluation: NonNullable<EvaluationSessionOptions['requestEvaluation']> };
  now?: () => number;
  observe?(phase: 'before-worker' | 'after-worker', detail: { jobId: string; workerId: string }): Promise<void>;
}

/** The caller supplies two server-issued finite capabilities: the SQL grant
 * and shared worker execution binding. No HTTP DTO, local path, global queue
 * scan, signed reviewer label or arbitrary evaluate() function can replace them. */
export function createIsolatedEvaluationWorker(options: IsolatedEvaluationWorkerOptions) {
  if (options.environment !== 'isolated-evaluation-writer' || options.provider.kind !== 'synthetic' || process.env.NODE_ENV === 'production')
    throw new EvaluationWriterError(503, 'F_ISOLATED_WORKER_REQUIRED');
  return createEvaluationWorkerCore(options);
}
function createEvaluationWorkerCore(options: Omit<IsolatedEvaluationWorkerOptions,'environment'|'provider'> & { provider: {requestEvaluation?:EvaluationSessionOptions['requestEvaluation']} }) {
  const { repository, identity } = options, now = options.now ?? Date.now;
  return {
    async run(context: AuthenticatedRequestContext, input: {
      jobId: string; workerId: string; capability: EvaluationWorkerCapability; execution: TrustedEvaluationWorkerExecution;
      leaseMs?: number; signal?: AbortSignal;
    }) {
      const selected = await identity.revalidate(context);
      if (selected.mode !== 'authenticated' || !selected.scope) throw new EvaluationWriterError(403, 'F_SCOPE_REQUIRED');
      const workerScope = authenticatedEvaluationWorkerScope(input.execution, now());
      if (!workerScope || workerScope.ownerId !== selected.account.ownerId || workerScope.studentId !== selected.scope.studentId ||
        workerScope.applicationTargetId !== selected.scope.applicationTargetId || workerScope.supportTargetId !== selected.scope.supportTargetId)
        throw new EvaluationWriterError(403, 'F_WORKER_SCOPE_CHANGED');
      const baseJobs = repository.workerJobs(selected, input.capability);
      const job = await baseJobs.get(input.jobId);
      if (!job) return { processed: false as const, job: null };
      await assertWorkerMetadataBinding(input.execution, job, now);
      async function material() {
        const current = await identity.revalidate(selected);
        if (current.mode !== 'authenticated' || !current.scope) throw new EvaluationWriterError(403, 'F_SCOPE_REQUIRED');
        // Every refresh is finite-job SQL first, before frozen private bytes.
        const actual = await baseJobs.get(job!.id);
        if (!actual || actual.sourceSha256 !== job!.sourceSha256 || actual.snapshotSha256 !== job!.snapshotSha256 ||
          actual.contextSnapshotSha256 !== job!.contextSnapshotSha256 || actual.model !== job!.model || actual.pipelineVersion !== job!.pipelineVersion)
          throw new EvaluationWriterError(409, 'F_WORKER_INPUT_CHANGED');
        const snapshot = await options.sessions.read(current, job!.sessionId);
        if (!snapshot) throw new EvaluationWriterError(404, 'F_SESSION_NOT_FOUND');
        identity.assertResource(current, snapshot.binding);
        const frozen = decodeSessionEvaluationHandoff(snapshot), scope = await repository.scopeControl(current);
        const session = await repository.sessionControl(current, job!.sessionId);
        if (!session || session.approvalRevoked) throw new EvaluationWriterError(409, 'F_REVIEW_NOT_CURRENT');
        const prepared = await options.service.prepare(current, scope, session, frozen);
        if (!prepared || prepared.derived.jobId !== job!.id || prepared.derived.snapshotSha256 !== job!.snapshotSha256 ||
          prepared.derived.sourceSha256 !== job!.sourceSha256 || prepared.derived.contextSnapshotSha256 !== job!.contextSnapshotSha256)
          throw new EvaluationWriterError(409, 'F_REVIEW_NOT_CURRENT');
        return prepared;
      }
      const initial = await material();
      const reviewInputs: StoredSessionEvaluationReviewReaders = {
        trustedPublicKey: initial.readers.trustedPublicKey, trustedRegistryPublicKey: initial.readers.trustedRegistryPublicKey,
        // Receipt issuance/period semantics stay in the existing verifier;
        // current account/trust/review generation is refreshed for every read.
        now,
        async loadContext(hash, owner) { return (await material()).readers.loadContext(hash, owner); },
        reviews: {
          async readRegistryPointer() { return (await material()).readers.reviews.readRegistryPointer(); },
          async readRegistryRevision(hash) { return (await material()).readers.reviews.readRegistryRevision(hash); },
          async readSessionReceipt(hash) { return (await material()).readers.reviews.readSessionReceipt(hash); },
        },
      };
      // A finite execution may contain multiple granted IDs, but this explicit
      // invocation prepares and runs one exact job; others are not read first.
      const jobs = { ...baseJobs, get: (id: string) => id === job.id ? baseJobs.get(id) : Promise.resolve(null) };
      await options.observe?.('before-worker', { jobId: job.id, workerId: input.workerId });
      const result = await runEvaluationWorkerOnce({ jobs, execution: input.execution, workerId: input.workerId, leaseMs: input.leaseMs,
        requestEvaluation: options.provider.requestEvaluation, reviewInputs, signal: input.signal, now });
      await options.observe?.('after-worker', { jobId: job.id, workerId: input.workerId });
      return result;
    },
  };
}

export interface ScopedEvaluationProvider { readonly kind:'service-native-evaluation'|'service-rehearsal-evaluation' }
const providers=new WeakMap<ScopedEvaluationProvider,{requestEvaluation?:EvaluationSessionOptions['requestEvaluation']}>();
export function createNativeEvaluationProvider(authority:ScopedServiceAuthority):ScopedEvaluationProvider {
  scopedServiceAuthority(authority);const handle=bindScopedComponent(authority,Object.freeze({kind:'service-native-evaluation' as const}));providers.set(handle,{});return handle;
}
export function createRehearsalEvaluationProvider(authority:ScopedServiceAuthority,requestEvaluation:NonNullable<EvaluationSessionOptions['requestEvaluation']>):ScopedEvaluationProvider {
  if(scopedServiceAuthority(authority).mode!=='rehearsal'||process.env.NODE_ENV==='production'||typeof requestEvaluation!=='function')throw new EvaluationWriterError(503,'F_REHEARSAL_PROVIDER_REQUIRED');
  const handle=bindScopedComponent(authority,Object.freeze({kind:'service-rehearsal-evaluation' as const}));providers.set(handle,{requestEvaluation});return handle;
}
export function createScopedEvaluationWorker(options:Omit<IsolatedEvaluationWorkerOptions,'environment'|'provider'> & {authority:ScopedServiceAuthority;provider:ScopedEvaluationProvider}) {
  const detail=scopedServiceAuthority(options.authority);assertScopedComponent(options.authority,options.provider);
  const provider=providers.get(options.provider);if(!provider||detail.mode==='production'&&options.provider.kind!=='service-native-evaluation')throw new EvaluationWriterError(503,'F_NATIVE_PROVIDER_REQUIRED');
  const core=createEvaluationWorkerCore({...options,provider});
  return {async run(context:AuthenticatedRequestContext,input:Parameters<typeof core.run>[1]&{expectedTransitionGeneration:string}){
    return runScopedOperation(options.authority,context,{generation:input.expectedTransitionGeneration,kind:'worker',signal:input.signal},async signal=>{
      await authorizeScoped(options.authority,context,'worker-write');return core.run(context,{...input,signal});
    });
  }};
}
