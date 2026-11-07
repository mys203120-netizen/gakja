import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthenticatedRequestContext, RequestIdentityBoundary, ResourceBinding } from '../auth/request-identity';

export class TransitionError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); this.name = 'TransitionError'; }
}
export type TransitionState = 'unprepared' | 'blocking' | 'verified' | 'db-primary' | 'frozen' | 'restoring' | 'read-only-recovery' | 'local-primary';
export type TransitionAccessOperation = 'read' | 'admit' | 'session-write' | 'review-write' | 'worker-write';
export type TransitionOperationKind = 'http' | 'wss' | 'capture' | 'provider' | 'worker' | 'cli';
export type TransitionCommandAction = 'prepare' | 'verify' | 'activate' | 'freeze' | 'rollback-empty' | 'recover';
export type TransitionOperatorAction = TransitionCommandAction | 'status' | 'export' | 'restore' | 'register-input';
export interface TransitionScope extends ResourceBinding {
  ownerId: string; studentId: string; applicationTargetId: string; supportTargetId: string;
}
export interface TransitionSnapshot {
  version: 'scoped-transition-state-v1'; transitionId: string; scope: TransitionScope; state: TransitionState;
  generation: string; fence: string; serverNow: string; scopeExpiresAt: string | null;
  localEvidenceJson: string | null; localEvidenceSha256: string | null;
  verificationJson: string | null; verificationSha256: string | null;
  checkpointJson: string | null; checkpointSha256: string | null;
  recoveryManifestSha256: string | null; primaryGeneration: string | null;
  operationId: string | null; activeOperations: number; writeFacts: number;
}
export interface TransitionCommand {
  version: 'scoped-transition-command-v1'; key: string; action: TransitionCommandAction;
  expectedGeneration: string; inputJson: string; inputSha256: string; payloadJson: string;
}
export interface TransitionReceipt {
  version: 'scoped-transition-receipt-v1'; transitionId: string; operationId: string; key: string;
  action: string; inputSha256: string; resultJson: string; resultSha256: string; replay: boolean; committedAt: string;
}
export interface TransitionOperatorCapability { readonly kind: 'scoped-transition-operator-v1' }
export interface TransitionInstallerCapability { readonly kind: 'scoped-transition-installer-v1' }
export interface TransitionOperatorGrant {
  issuer: string; subject: string; actions: readonly TransitionOperatorAction[]; expiresAt: string; active: boolean;
}
export interface TransitionAccess {
  transitionId: string; generation: string; fence: string; scope: TransitionScope; state: TransitionState; serverNow: string;
}
export interface TransitionOperation extends TransitionAccess { operationId: string; expiresAt: string; kind: TransitionOperationKind }
export interface TransitionRepository {
  readonly kind: 'postgres-scoped-transition-v1';
  read(context: AuthenticatedRequestContext): Promise<TransitionSnapshot | null>;
  authorizeOperator(context: AuthenticatedRequestContext, action: TransitionOperatorAction, capability: TransitionOperatorCapability): Promise<TransitionSnapshot>;
  access(context: AuthenticatedRequestContext, operation: TransitionAccessOperation, input?: { expectedGeneration?: string; sessionId?: string }): Promise<TransitionAccess>;
  installOperator(context: AuthenticatedRequestContext, input: { key: string; inputSha256: string; grant: TransitionOperatorGrant }, capability: TransitionInstallerCapability): Promise<TransitionSnapshot>;
  command(context: AuthenticatedRequestContext, input: TransitionCommand, capability: TransitionOperatorCapability): Promise<TransitionReceipt>;
  receipt(context: AuthenticatedRequestContext, key: string, inputSha256: string, capability: TransitionOperatorCapability): Promise<TransitionReceipt | null>;
  beginOperation(context: AuthenticatedRequestContext, input: { operationId: string; generation: string; kind: TransitionOperationKind; sessionId?: string; expiresAt: string }): Promise<TransitionOperation>;
  finishOperation(context: AuthenticatedRequestContext, input: { operationId: string; generation: string; outcome: 'completed' | 'failed' | 'cancelled' }): Promise<void>;
  exportRecovery(context: AuthenticatedRequestContext, capability: TransitionOperatorCapability): Promise<{ metadataJson: string; metadataSha256: string }>;
  restoreRecovery(context: AuthenticatedRequestContext, capability: TransitionOperatorCapability, input: { metadataJson: string; metadataSha256: string; manifestSha256: string; locations: readonly unknown[] }): Promise<unknown>;
}

/** Server-installed authority; a request role string or extra DTO properties
 * cannot install it. Every write uses a pinned operation generation, never a
 * newly observed generation silently adopted after a provider await. */
export interface TransitionServiceAuthority { readonly kind: 'scoped-transition-service-authority-v1' }
interface ServiceAuthority {
  mode: 'service' | 'rehearsal'; identity: RequestIdentityBoundary; repository: TransitionRepository;
  operations: AsyncLocalStorage<{ context: AuthenticatedRequestContext; operation: TransitionOperation; controller: AbortController }>;
}
const authorities = new WeakMap<TransitionServiceAuthority, ServiceAuthority>();
const sameScope = (left: TransitionScope, right: AuthenticatedRequestContext) => !!right.scope &&
  left.ownerId === right.account.ownerId && left.studentId === right.scope.studentId && left.applicationTargetId === right.scope.applicationTargetId &&
  left.supportTargetId === right.scope.supportTargetId && Object.hasOwn(left, 'sourceRevision') === Object.hasOwn(right.scope, 'sourceRevision') && left.sourceRevision === right.scope.sourceRevision;
export function createTransitionServiceAuthority(input: { mode: 'service' | 'rehearsal'; identity: RequestIdentityBoundary; repository: TransitionRepository }): TransitionServiceAuthority {
  if (input.repository.kind !== 'postgres-scoped-transition-v1' || input.identity.mode !== 'service' ||
    process.env.NODE_ENV === 'production' && input.mode !== 'service') throw new TransitionError(503, 'TRANSITION_SERVICE_AUTHORITY_REQUIRED');
  const authority = Object.freeze({ kind: 'scoped-transition-service-authority-v1' as const });
  authorities.set(authority, { ...input, operations: new AsyncLocalStorage() }); return authority;
}
export function assertTransitionServiceAuthority(input: TransitionServiceAuthority, expectedMode?: 'service' | 'rehearsal') {
  const value = authorities.get(input);
  if (!value || expectedMode && value.mode !== expectedMode || process.env.NODE_ENV === 'production' && value.mode !== 'service')
    throw new TransitionError(503, 'TRANSITION_SERVICE_AUTHORITY_REQUIRED');
  return value.mode;
}
export function currentTransitionOperation(authority: TransitionServiceAuthority) {
  assertTransitionServiceAuthority(authority);
  const active = authorities.get(authority)!.operations.getStore();
  return active ? { signal: active.controller.signal, generation: active.operation.generation, operationId: active.operation.operationId } : null;
}
export async function transitionServiceSnapshot(authority: TransitionServiceAuthority, context: AuthenticatedRequestContext) {
  assertTransitionServiceAuthority(authority); const value = authorities.get(authority)!;
  const current = await value.identity.revalidate(context);
  if (current.mode !== 'authenticated' || !current.scope) throw new TransitionError(403, 'TRANSITION_SCOPE_REQUIRED');
  return value.repository.read(current);
}
export async function transitionSqlAuthorization(authority: TransitionServiceAuthority, context: AuthenticatedRequestContext,
  operation: TransitionAccessOperation, sessionId?: string) {
  assertTransitionServiceAuthority(authority); const value = authorities.get(authority)!;
  const current = await value.identity.revalidate(context);
  if (current.mode !== 'authenticated' || !current.scope) throw new TransitionError(403, 'TRANSITION_SCOPE_REQUIRED');
  const active = value.operations.getStore();
  if (!active && operation !== 'read') throw new TransitionError(503, 'TRANSITION_OPERATION_REQUIRED');
  if (active && (!sameScope(active.operation.scope, current) || active.context.principal.issuer !== current.principal.issuer ||
    active.context.principal.subject !== current.principal.subject)) throw new TransitionError(403, 'TRANSITION_OPERATION_BINDING_CHANGED');
  active?.controller.signal.throwIfAborted();
  const result = await value.repository.access(current, operation, {
    ...(active ? { expectedGeneration: active.operation.generation } : {}), ...(sessionId ? { sessionId } : {}),
  });
  if (active && (result.transitionId !== active.operation.transitionId || result.generation !== active.operation.generation))
    throw new TransitionError(409, 'TRANSITION_GENERATION_CHANGED');
  return { transition_mode: 'service-g', transition_id: result.transitionId, transition_generation: result.generation,
    transition_operation: active?.operation.operationId ?? '' };
}
export async function withTransitionOperation<T>(authority: TransitionServiceAuthority, context: AuthenticatedRequestContext,
  input: { operationId: string; generation: string; kind: TransitionOperationKind; sessionId?: string; expiresAt: string; signal?: AbortSignal },
  operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  assertTransitionServiceAuthority(authority); const value = authorities.get(authority)!;
  const current = await value.identity.revalidate(context);
  if (current.mode !== 'authenticated' || !current.scope) throw new TransitionError(403, 'TRANSITION_SCOPE_REQUIRED');
  const controller = new AbortController(), abort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener('abort', abort, { once: true }); if (input.signal?.aborted) abort();
  let active: TransitionOperation | undefined, polling = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    active = await value.repository.beginOperation(current, input);
    const pinned = active;
    timer = setInterval(() => {
      if (polling || controller.signal.aborted) return;
      polling = true;
      void value.identity.revalidate(current).then(fresh => {
        if (fresh.mode !== 'authenticated') throw new TransitionError(403, 'TRANSITION_SCOPE_REQUIRED');
        return value.repository.access(fresh, 'session-write', { expectedGeneration: pinned.generation, ...(input.sessionId ? { sessionId: input.sessionId } : {}) });
      }).then(result => {
        if (result.transitionId !== pinned.transitionId || Date.now() >= Date.parse(pinned.expiresAt)) throw new TransitionError(409, 'TRANSITION_GENERATION_CHANGED');
      }).catch(error => controller.abort(error)).finally(() => { polling = false; });
    }, 250);
    timer.unref();
    const result = await value.operations.run({ context: current, operation: active, controller }, async () => {
      controller.signal.throwIfAborted(); return operation(controller.signal);
    });
    controller.signal.throwIfAborted();
    await value.repository.finishOperation(current, { operationId: active.operationId, generation: active.generation, outcome: 'completed' });
    return result;
  } catch (error) {
    controller.abort(error);
    if (active) await value.repository.finishOperation(current, { operationId: active.operationId, generation: active.generation, outcome: 'failed' }).catch(() => {});
    throw error;
  } finally { if (timer) clearInterval(timer); input.signal?.removeEventListener('abort', abort); }
}
