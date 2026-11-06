import type { Pool, PoolClient } from 'pg';
import { RequestAccessError, type AccountAccess, type AccountResolver, type AuthenticatedRequestContext,
  type RequestContext, type RequestIdentityBoundary, type ResourceBinding, type VerifiedPrincipal } from '../auth/request-identity';
import type { AudioAccessBinding, ServiceRequestResources, SessionAccessBinding } from '../request-realtime-server';
import type { InterviewSession } from '../protocol';
import type { TrustedEvaluationJobBinding } from '../internal-execution';

/** Credentials/pools are explicit server dependencies. No application DB URL or
 * browser claim is read from the environment by this module. */
export class DatabaseAuthorityError extends Error {
  constructor(readonly code: 'DB_UNAVAILABLE' | 'DB_ROLE_DENIED' | 'DB_CONTEXT_REQUIRED' | 'DB_BINDING_INVALID') {
    super(code); this.name = 'DatabaseAuthorityError';
  }
}
const settingNames = ['issuer', 'subject', 'account_id', 'account_revision', 'owner_id', 'student_id', 'application_target_id', 'job_id', 'worker_subject'] as const;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value === value.trim();
const failUnavailable = () => new RequestAccessError(503, 'AUTH_UNAVAILABLE');
const principalCurrent = (principal: VerifiedPrincipal, now: () => number) => {
  if (!nonempty(principal.issuer) || !nonempty(principal.subject) || !Number.isFinite(principal.expiresAt) || now() >= principal.expiresAt) {
    throw new RequestAccessError(401, 'AUTH_EXPIRED');
  }
};

async function assertRole(client: PoolClient, expected: 'gakja_request' | 'gakja_worker') {
  const { rows } = await client.query<{ current: string; session: string; superuser: boolean; bypass: boolean; elevated: boolean }>(
    `SELECT current_user::text AS current, session_user::text AS session, r.rolsuper AS superuser, r.rolbypassrls AS bypass,
      EXISTS (SELECT 1 FROM pg_catalog.pg_roles privileged WHERE
        (privileged.rolsuper OR privileged.rolbypassrls OR privileged.rolname IN ('gakja_owner','gakja_mapping'))
        AND pg_catalog.pg_has_role(current_user, privileged.oid, 'MEMBER')) AS elevated
     FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`);
  const role = rows[0];
  if (!role || role.current !== expected || role.session !== expected || role.superuser || role.bypass || role.elevated) {
    throw new DatabaseAuthorityError('DB_ROLE_DENIED');
  }
}

async function setLocals(client: PoolClient, settings: Partial<Record<typeof settingNames[number], string>>, timeoutMs: number) {
  for (const key of settingNames) await client.query('SELECT pg_catalog.set_config($1, $2, true)', ['gakja.' + key, settings[key] ?? '']);
  await client.query('SELECT pg_catalog.set_config($1, $2, true)', ['statement_timeout', String(timeoutMs)]);
}

/** COMMIT/ROLLBACK and RESET happen before release. A damaged/unclean connection
 * is destroyed rather than returned to the shared pool. */
async function transaction<T>(pool: Pool, role: 'gakja_request' | 'gakja_worker',
  settings: () => Partial<Record<typeof settingNames[number], string>>, operation: (client: PoolClient) => Promise<T>,
  options: { timeoutMs?: number; beforeBegin?: () => void } = {}): Promise<T> {
  let client: PoolClient | undefined, begun = false, healthy = true;
  const timeout = options.timeoutMs ?? 5_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000) throw new DatabaseAuthorityError('DB_CONTEXT_REQUIRED');
  try {
    client = await pool.connect(); options.beforeBegin?.();
    await assertRole(client, role);
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); begun = true;
    await setLocals(client, settings(), timeout);
    const value = await operation(client);
    options.beforeBegin?.();
    await client.query('COMMIT'); begun = false;
    return value;
  } catch (error) {
    if (client && begun) { try { await client.query('ROLLBACK'); } catch { healthy = false; } }
    if (error instanceof RequestAccessError || error instanceof DatabaseAuthorityError) throw error;
    // Never propagate driver detail/constraint values, connection strings or
    // another account's existence through the service error boundary.
    throw new DatabaseAuthorityError('DB_UNAVAILABLE');
  } finally {
    if (client) {
      if (healthy) {
        try {
          await client.query('RESET ALL');
          const result = await client.query<{ clean: boolean }>(`SELECT ${settingNames.map((_, index) => `COALESCE(pg_catalog.current_setting($${index + 1},true),'') = ''`).join(' AND ')} AS clean`, settingNames.map(key => 'gakja.' + key));
          healthy = result.rows[0]?.clean === true;
        } catch { healthy = false; }
      }
      client.release(!healthy);
    }
  }
}

function account(value: unknown): AccountAccess | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failUnavailable();
  const row = value as AccountAccess;
  if (!nonempty(row.accountId) || !nonempty(row.ownerId) || !nonempty(row.revision) || !Array.isArray(row.grants)) throw failUnavailable();
  for (const grant of row.grants) {
    if (!nonempty(grant.studentId) || !nonempty(grant.applicationTargetId) || !nonempty(grant.supportTargetId) ||
      Object.hasOwn(grant, 'sourceRevision') && grant.sourceRevision !== null && !nonempty(grant.sourceRevision)) throw failUnavailable();
  }
  return row;
}
async function readAccount(client: PoolClient, principal: VerifiedPrincipal): Promise<AccountAccess | null> {
  const result = await client.query<{ access: unknown }>('SELECT gakja.resolve_account($1::text,$2::text) AS access', [principal.issuer, principal.subject]);
  return account(result.rows[0]?.access ?? null);
}
function assertSameAccount(current: AccountAccess | null, context: AuthenticatedRequestContext) {
  if (!current || current.accountId !== context.account.accountId || current.ownerId !== context.account.ownerId || current.revision !== context.account.revision) {
    throw new RequestAccessError(403, 'ACCESS_DENIED');
  }
  if (context.scope && !current.grants.some(grant => grant.studentId === context.scope!.studentId &&
    grant.applicationTargetId === context.scope!.applicationTargetId && grant.supportTargetId === context.scope!.supportTargetId &&
    (grant.sourceRevision === undefined || grant.sourceRevision === context.scope!.sourceRevision))) throw new RequestAccessError(403, 'ACCESS_DENIED');
}

export function createPostgresAccountResolver(pool: Pool, options: { now?: () => number } = {}): AccountResolver {
  const now = options.now ?? Date.now;
  return Object.freeze({ kind: 'operational' as const, async resolve(principal: VerifiedPrincipal) {
    principalCurrent(principal, now);
    try {
      return await transaction(pool, 'gakja_request', () => ({ issuer: principal.issuer, subject: principal.subject }),
        async client => { const value = await readAccount(client, principal); principalCurrent(principal, now); return value; },
        { beforeBegin: () => principalCurrent(principal, now) });
    } catch { throw failUnavailable(); }
  } });
}

export interface PostgresRequestAuthority {
  withScope<T>(context: RequestContext, operation: (client: PoolClient, current: AuthenticatedRequestContext) => Promise<T>, options?: { timeoutMs?: number }): Promise<T>;
  authorizeBody(context: RequestContext, binding?: ResourceBinding): Promise<AuthenticatedRequestContext>;
  discoverSession(context: RequestContext, id: string): Promise<SessionAccessBinding | null>;
  discoverAudio(context: RequestContext, id: string): Promise<AudioAccessBinding | null>;
}
export function createPostgresRequestAuthority(pool: Pool, boundary: RequestIdentityBoundary): PostgresRequestAuthority {
  async function run<T>(context: RequestContext, selected: boolean,
    operation: (client: PoolClient, current: AuthenticatedRequestContext) => Promise<T>, options: { timeoutMs?: number } = {}): Promise<T> {
    // Revalidation mints/validates authority before checking out the connection.
    // Calling it while holding a max=1 pool would deadlock the DB account lookup.
    const current = await boundary.revalidate(context);
    if (current.mode !== 'authenticated' || selected && !current.scope) throw new DatabaseAuthorityError('DB_CONTEXT_REQUIRED');
    const verifyIssuedAndExpiry = () => { boundary.selectScope(current, {}); };
    const value = await transaction(pool, 'gakja_request', () => ({ issuer: current.principal.issuer, subject: current.principal.subject,
      account_id: current.account.accountId, account_revision: current.account.revision, owner_id: current.account.ownerId,
      student_id: current.scope?.studentId ?? '', application_target_id: current.scope?.applicationTargetId ?? '' }), async client => {
      assertSameAccount(await readAccount(client, current.principal), current);
      const value = await operation(client, current);
      // Each statement uses READ COMMITTED, not a long-lived old grant snapshot.
      assertSameAccount(await readAccount(client, current.principal), current);
      verifyIssuedAndExpiry(); return value;
    }, { ...options, beforeBegin: verifyIssuedAndExpiry });
    // COMMIT/cleanup may themselves wait. Do not publish scoped SQL results
    // under a principal that expired during those final awaits.
    verifyIssuedAndExpiry(); return value;
  }
  return Object.freeze({
    withScope: <T>(context: RequestContext, operation: (client: PoolClient, current: AuthenticatedRequestContext) => Promise<T>, options?: { timeoutMs?: number }) => run(context, true, operation, options),
    async authorizeBody(context: RequestContext, binding?: ResourceBinding) {
      // Called after metadata transaction cleanup/release. Revalidation can
      // safely acquire the same max=1 pool and cannot deadlock on a held client.
      const current = await boundary.revalidate(context);
      if (current.mode !== 'authenticated' || !current.scope) throw new DatabaseAuthorityError('DB_CONTEXT_REQUIRED');
      if (binding) boundary.assertResource(current, binding);
      boundary.selectScope(current, {}); return current;
    },
    async discoverSession(context: RequestContext, id: string) {
      return run(context, false, async client => {
        const result = await client.query<{ binding: SessionAccessBinding | null }>('SELECT gakja.resolve_session_binding($1::text) AS binding', [id]);
        return result.rows[0]?.binding ?? null;
      });
    },
    async discoverAudio(context: RequestContext, id: string) {
      return run(context, false, async client => {
        const result = await client.query<{ binding: AudioAccessBinding | null }>('SELECT gakja.resolve_audio_binding($1::text) AS binding', [id]);
        return result.rows[0]?.binding ?? null;
      });
    },
  });
}

/** Only synthetic bodies are supplied in B. This is metadata integration, not
 * a private Storage reader, migrated session store or operational composition. */
export interface SyntheticResourceBodies {
  readStatus(context: AuthenticatedRequestContext): Promise<unknown>;
  readSession(context: AuthenticatedRequestContext, binding: SessionAccessBinding): Promise<InterviewSession | null>;
  readAudio(context: AuthenticatedRequestContext, binding: AudioAccessBinding): Promise<Buffer | null>;
}
function sameBinding(left: ResourceBinding | null, right: ResourceBinding) {
  if (!left) return false;
  return left.ownerId === right.ownerId && left.studentId === right.studentId && left.applicationTargetId === right.applicationTargetId &&
    left.supportTargetId === right.supportTargetId && Object.hasOwn(left, 'sourceRevision') === Object.hasOwn(right, 'sourceRevision') &&
    left.sourceRevision === right.sourceRevision && left.sessionId === right.sessionId && left.resourceId === right.resourceId &&
    (!('contextSnapshotSha256' in right) || 'contextSnapshotSha256' in left && left.contextSnapshotSha256 === right.contextSnapshotSha256);
}
export function createPostgresTestResources(authority: PostgresRequestAuthority, bodies: SyntheticResourceBodies): ServiceRequestResources {
  return Object.freeze({ kind: 'synthetic' as const,
    sessionBinding: (context: AuthenticatedRequestContext, id: string) => authority.discoverSession(context, id),
    audioBinding: (context: AuthenticatedRequestContext, id: string) => authority.discoverAudio(context, id),
    async readStatus(context: AuthenticatedRequestContext) {
      const current = await authority.withScope(context, async (_client, value) => value);
      return bodies.readStatus(await authority.authorizeBody(current));
    },
    async readSession(context: AuthenticatedRequestContext, binding: SessionAccessBinding) {
      const current = await authority.withScope(context, async (client, value) => {
        const result = await client.query<{ binding: SessionAccessBinding | null }>('SELECT gakja.resolve_session_binding($1::text) AS binding', [binding.sessionId]);
        if (!sameBinding(result.rows[0]?.binding ?? null, binding)) return null;
        return value;
      });
      return current ? bodies.readSession(await authority.authorizeBody(current, binding), binding) : null;
    },
    async readAudio(context: AuthenticatedRequestContext, binding: AudioAccessBinding) {
      const current = await authority.withScope(context, async (client, value) => {
        const result = await client.query<{ binding: AudioAccessBinding | null }>('SELECT gakja.resolve_audio_binding($1::text) AS binding', [binding.resourceId]);
        if (!sameBinding(result.rows[0]?.binding ?? null, binding)) return null;
        return value;
      });
      return current ? bodies.readAudio(await authority.authorizeBody(current, binding), binding) : null;
    },
  });
}

/** This resolver is an input to A's server-minted finite-job capability. The
 * SQL FK proves the separate personal application target through its session. */
export function createPostgresWorkerBindingResolver(pool: Pool, workerSubject: string, options: { now?: () => number } = {}) {
  if (!nonempty(workerSubject)) throw new DatabaseAuthorityError('DB_CONTEXT_REQUIRED');
  return async (jobId: string): Promise<TrustedEvaluationJobBinding | null> => transaction(pool, 'gakja_worker',
    () => ({ worker_subject: workerSubject, job_id: jobId }), async client => {
      const result = await client.query<{ binding: TrustedEvaluationJobBinding & { applicationTargetId?: string } | null }>('SELECT gakja.resolve_job_binding($1::text) AS binding', [jobId]);
      const value = result.rows[0]?.binding;
      if (!value) return null;
      if (!nonempty(value.applicationTargetId) || value.jobId !== jobId) throw new DatabaseAuthorityError('DB_BINDING_INVALID');
      const { applicationTargetId: _relationAlreadyVerified, ...legacyBinding } = value;
      void _relationAlreadyVerified;
      return legacyBinding;
    }, { beforeBegin: () => { if (options.now && !Number.isFinite(options.now())) throw new DatabaseAuthorityError('DB_CONTEXT_REQUIRED'); } });
}
