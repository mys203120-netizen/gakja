/** Request authority is execution metadata, never part of a signed/domain payload. */
export type ExecutionMode = 'local-development' | 'service';
export type AccessCode = 'AUTH_REQUIRED' | 'AUTH_INVALID' | 'AUTH_UNAVAILABLE' | 'AUTH_EXPIRED' |
  'ACCOUNT_UNMAPPED' | 'ACCESS_DENIED' | 'RESOURCE_NOT_FOUND' | 'STORAGE_UNSUPPORTED' | 'EXECUTION_MODE_INVALID' |
  'AUTHENTICATED_STORAGE_UNAVAILABLE' | 'INVALID_REQUEST' | 'IDENTITY_CONFIGURATION_INVALID' |
  'CLIENT_IDENTITY_NOT_ALLOWED' | 'REQUEST_ORIGIN_DENIED' | 'REALTIME_TICKET_LIMIT' | 'REALTIME_TICKET_INVALID';
export class RequestAccessError extends Error {
  constructor(public readonly status: number, public readonly code: AccessCode) { super(code); this.name = 'RequestAccessError'; }
}
export function resolveExecutionMode(env: Readonly<Record<string, string | undefined>> = process.env): ExecutionMode {
  const mode = env.INTERVIEW_EXECUTION_MODE;
  if (mode === undefined || mode === '' || mode === 'service') return 'service';
  if (mode === 'local-development' && env.NODE_ENV !== 'production') return mode;
  throw new RequestAccessError(503, 'EXECUTION_MODE_INVALID');
}
export interface VerifiedPrincipal {
  issuer: string; subject: string; expiresAt: number; issuedAt?: number; tokenId?: string;
}
export interface PrincipalVerifier { kind: 'trusted-jwt'; verify(token: string): Promise<VerifiedPrincipal> }
export interface AccessGrant {
  studentId: string; applicationTargetId: string; supportTargetId: string; sourceRevision?: string | null;
}
export interface AccountAccess { accountId: string; ownerId: string; revision: string; grants: readonly AccessGrant[] }
export interface AccountResolver { kind: 'operational' | 'synthetic'; resolve(principal: VerifiedPrincipal): Promise<AccountAccess | null> }
export interface ScopeSelection { studentId?: string; applicationTargetId?: string; supportTargetId?: string }
export interface ResourceBinding extends AccessGrant { ownerId: string; sessionId?: string; resourceId?: string }
export interface AuthenticatedRequestContext {
  mode: 'authenticated'; principal: Readonly<VerifiedPrincipal>; account: Readonly<AccountAccess>; scope: Readonly<AccessGrant> | null;
}
export interface LocalRequestContext { mode: 'local-development'; ownerId: string }
export type RequestContext = AuthenticatedRequestContext | LocalRequestContext;
export interface RequestIdentityBoundary {
  readonly mode: ExecutionMode;
  authenticate(authorization: string | undefined): Promise<RequestContext>;
  selectScope(context: RequestContext, selection: ScopeSelection): RequestContext;
  assertResource(context: RequestContext, binding: ResourceBinding): void;
  revalidate(context: RequestContext): Promise<RequestContext>;
}
export interface RequestIdentityOptions {
  mode: ExecutionMode; verifier?: PrincipalVerifier; accounts?: AccountResolver;
  environment?: 'operational' | 'test'; localOwnerId?: string; now?: () => number;
}
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value === value.trim();
const sameGrant = (left: AccessGrant, right: AccessGrant) => left.studentId === right.studentId &&
  left.applicationTargetId === right.applicationTargetId && left.supportTargetId === right.supportTargetId &&
  (left.sourceRevision === undefined || left.sourceRevision === right.sourceRevision);
const validGrant = (value: AccessGrant) => nonempty(value.studentId) && nonempty(value.applicationTargetId) &&
  nonempty(value.supportTargetId) && (value.sourceRevision === undefined || value.sourceRevision === null || nonempty(value.sourceRevision));

export function createRequestIdentityBoundary(options: RequestIdentityOptions): RequestIdentityBoundary {
  const now = options.now ?? Date.now, issued = new WeakSet<object>();
  const mint = <T extends RequestContext>(value: T): T => { issued.add(value); return Object.freeze(value); };
  const assertIssued = (context: RequestContext) => {
    if (!issued.has(context)) throw new RequestAccessError(403, 'ACCESS_DENIED');
    if (context.mode === 'authenticated' && now() >= context.principal.expiresAt) throw new RequestAccessError(401, 'AUTH_EXPIRED');
  };
  const assertConfigured = () => {
    if (options.mode === 'local-development') {
      if (process.env.NODE_ENV === 'production') throw new RequestAccessError(503, 'EXECUTION_MODE_INVALID');
      if (!nonempty(options.localOwnerId)) throw new RequestAccessError(503, 'AUTH_UNAVAILABLE');
    } else if (!options.verifier || options.verifier.kind !== 'trusted-jwt' || !options.accounts ||
      (options.accounts.kind !== 'operational' && (options.environment !== 'test' || process.env.NODE_ENV === 'production'))) {
      throw new RequestAccessError(503, 'AUTH_UNAVAILABLE');
    }
  };
  async function resolve(principal: VerifiedPrincipal): Promise<Readonly<AccountAccess>> {
    let access: AccountAccess | null;
    try { access = await options.accounts!.resolve(principal); }
    catch { throw new RequestAccessError(503, 'AUTH_UNAVAILABLE'); }
    if (!access) throw new RequestAccessError(403, 'ACCOUNT_UNMAPPED');
    if (!nonempty(access.accountId) || !nonempty(access.ownerId) || !nonempty(access.revision) ||
      !Array.isArray(access.grants) || !access.grants.every(validGrant)) throw new RequestAccessError(503, 'AUTH_UNAVAILABLE');
    const grants = Object.freeze(access.grants.map(grant => Object.freeze({ ...grant })));
    if (new Set(grants.map(grant => JSON.stringify([grant.studentId, grant.applicationTargetId, grant.supportTargetId]))).size !== grants.length) {
      throw new RequestAccessError(503, 'AUTH_UNAVAILABLE');
    }
    return Object.freeze({ accountId: access.accountId, ownerId: access.ownerId, revision: access.revision, grants });
  }
  const boundary: RequestIdentityBoundary = {
    mode: options.mode,
    async authenticate(authorization) {
      assertConfigured();
      if (options.mode === 'local-development') return mint({ mode: 'local-development', ownerId: options.localOwnerId! });
      if (!authorization) throw new RequestAccessError(401, 'AUTH_REQUIRED');
      const match = /^Bearer ([^\s,]+)$/iu.exec(authorization);
      if (!match || match[1].length > 16_384) throw new RequestAccessError(401, 'AUTH_INVALID');
      let principal: VerifiedPrincipal;
      try { principal = await options.verifier!.verify(match[1]); }
      catch (error) { if (error instanceof RequestAccessError) throw error; throw new RequestAccessError(503, 'AUTH_UNAVAILABLE'); }
      if (!nonempty(principal.issuer) || !nonempty(principal.subject) || !Number.isFinite(principal.expiresAt)) throw new RequestAccessError(401, 'AUTH_INVALID');
      if (now() >= principal.expiresAt) throw new RequestAccessError(401, 'AUTH_EXPIRED');
      const verified = Object.freeze({ ...principal });
      const account = await resolve(verified);
      if (now() >= verified.expiresAt) throw new RequestAccessError(401, 'AUTH_EXPIRED');
      return mint({ mode: 'authenticated', principal: verified, account, scope: null });
    },
    selectScope(context, selection) {
      assertIssued(context);
      if (context.mode === 'local-development') return context;
      const values = [selection.studentId, selection.applicationTargetId, selection.supportTargetId];
      if (values.every(value => value === undefined)) return context;
      if (values.some(value => value !== undefined && !nonempty(value))) throw new RequestAccessError(403, 'ACCESS_DENIED');
      const candidates = context.account.grants.filter(grant =>
        (selection.studentId === undefined || selection.studentId === grant.studentId) &&
        (selection.applicationTargetId === undefined || selection.applicationTargetId === grant.applicationTargetId) &&
        (selection.supportTargetId === undefined || selection.supportTargetId === grant.supportTargetId));
      if (candidates.length !== 1) throw new RequestAccessError(403, 'ACCESS_DENIED');
      return mint({ ...context, scope: candidates[0] });
    },
    assertResource(context, binding) {
      assertIssued(context);
      const ownerId = context.mode === 'authenticated' ? context.account.ownerId : context.ownerId;
      if (binding.ownerId !== ownerId || !validGrant(binding)) throw new RequestAccessError(404, 'RESOURCE_NOT_FOUND');
      if (context.mode === 'authenticated' && (!context.account.grants.some(grant => sameGrant(grant, binding)) ||
        context.scope !== null && !sameGrant(context.scope, binding))) throw new RequestAccessError(404, 'RESOURCE_NOT_FOUND');
    },
    async revalidate(context) {
      assertConfigured(); assertIssued(context);
      if (context.mode === 'local-development') return context;
      const current = await resolve(context.principal);
      if (now() >= context.principal.expiresAt) throw new RequestAccessError(401, 'AUTH_EXPIRED');
      if (current.accountId !== context.account.accountId || current.ownerId !== context.account.ownerId || current.revision !== context.account.revision ||
        context.scope !== null && !current.grants.some(grant => sameGrant(grant, context.scope!))) throw new RequestAccessError(403, 'ACCESS_DENIED');
      return mint({ ...context, account: current });
    },
  };
  return Object.freeze(boundary);
}

/** The input contains server-owned authority and pins only, never a bearer token. */
export function cacheScopeKey(context: RequestContext, binding?: ResourceBinding): string {
  if (context.mode === 'local-development') return JSON.stringify(['local-development', context.ownerId, binding ?? null]);
  return JSON.stringify(['authenticated', context.account.accountId, context.account.ownerId, context.account.revision,
    context.principal.issuer, context.principal.subject, binding ?? context.scope]);
}

export const privateResponseHeaders = Object.freeze({ 'Cache-Control': 'private, no-store', Vary: 'Authorization, Cookie' });
