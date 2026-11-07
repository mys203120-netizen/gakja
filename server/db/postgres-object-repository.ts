import type { Pool, PoolClient } from 'pg';
import { RequestAccessError, type AccountAccess, type AuthenticatedRequestContext, type RequestContext, type RequestIdentityBoundary } from '../auth/request-identity';
import { DatabaseAuthorityError, type PostgresRequestAuthority } from './postgres-authority';
import { privateObjectKinds, type ObjectRegistration, type PrivateObjectRepository,
  type PrivateObjectSelector, type StorageObjectRef, type VerifiedPrivateObject } from '../storage/private-object-ports';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const sha = /^[a-f0-9]{64}$/u;
const settings = ['issuer','subject','account_id','account_revision','owner_id','student_id','application_target_id','job_id','worker_subject'];
const unavailable = () => new DatabaseAuthorityError('DB_UNAVAILABLE');
const invalid = () => new DatabaseAuthorityError('DB_BINDING_INVALID');
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value === value.trim();

export interface PostgresObjectRepository extends PrivateObjectRepository {
  /** Trusted registration composition only; no operational route invokes these. */
  linkAudio(context: RequestContext, receiptId: string, audioId: string): Promise<PrivateObjectSelector | null>;
  linkVersion(context: RequestContext, receiptId: string, domainKind: string, versionId: string): Promise<PrivateObjectSelector | null>;
  versionObject(context: RequestContext, scope: 'common' | 'target', domainKind: string, versionId: string): Promise<PrivateObjectSelector | null>;
  legacyObject(context: RequestContext, scope: 'common' | 'target', domainKind: string, legacyId: string, originalPin: string): Promise<PrivateObjectSelector | null>;
}

/** Both pools are explicit server dependencies. Request SQL never receives the
 * mapping credential; only this internal lifecycle composition can finalize.
 * No caller-supplied owner, ref, bucket or key reaches storage_admit. */
export function createPostgresObjectRepository(options: {
  authority: PostgresRequestAuthority; boundary: RequestIdentityBoundary; mappingPool: Pool;
  bucket: string; keyPrefix: string; admissionTtlSeconds?: number;
}): PostgresObjectRepository {
  const { authority, boundary, mappingPool, bucket, keyPrefix } = options;
  const ttl = options.admissionTtlSeconds ?? 900;
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/u.test(bucket) || !/^[a-z0-9_-]{8,64}$/u.test(keyPrefix) ||
    !Number.isInteger(ttl) || ttl < 1 || ttl > 900) throw invalid();
  const current = async (context: RequestContext) => {
    const value = await boundary.revalidate(context);
    if (value.mode !== 'authenticated' || !value.scope) throw new DatabaseAuthorityError('DB_CONTEXT_REQUIRED');
    return value;
  };
  function ref(value: StorageObjectRef, stage: 'staging' | 'final', objectId: string) {
    if (!value || value.bucket !== bucket || value.key !== `${keyPrefix}/${stage}/${objectId}`) throw invalid();
  }
  function scoped(value: ObjectRegistration['scope'], context: AuthenticatedRequestContext) {
    if (!value || value.ownerId !== context.account.ownerId || value.studentId !== context.scope?.studentId ||
      value.kind !== 'common' && value.kind !== 'target' || value.kind === 'target' &&
      (value.applicationTargetId !== context.scope?.applicationTargetId || value.supportTargetId !== context.scope?.supportTargetId)) throw invalid();
  }
  function registration(value: ObjectRegistration | null, context: AuthenticatedRequestContext) {
    if (value === null) return null;
    if (!value || !uuid.test(value.objectId) || !uuid.test(value.receiptId) || !/^\d+$/u.test(value.revision) ||
      !privateObjectKinds.includes(value.kind) || !['pending','uploading','verifying','verified','rejected','cancelled','expired'].includes(value.state) ||
      !Number.isSafeInteger(value.expectedSize) || value.expectedSize < 0 || !sha.test(value.expectedSha256) ||
      !Number.isFinite(value.expiresAt) || !['pending','clean','failed'].includes(value.cleanupState) ||
      value.sourceRevision !== undefined && value.sourceRevision !== null && !nonempty(value.sourceRevision) ||
      value.domainSha256 !== undefined && value.domainSha256 !== null && !sha.test(value.domainSha256)) throw invalid();
    scoped(value.scope, context); ref(value.stagingRef, 'staging', value.objectId); ref(value.finalRef, 'final', value.objectId);
    if (value.state === 'verified' && (value.actualSize !== value.expectedSize || value.actualSha256 !== value.expectedSha256)) throw invalid();
    return value;
  }
  function verified(value: VerifiedPrivateObject | null, context: AuthenticatedRequestContext) {
    if (value === null) return null;
    if (!value || !uuid.test(value.objectId) || !uuid.test(value.receiptId) || !/^\d+$/u.test(value.revision) ||
      !privateObjectKinds.includes(value.kind) || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0 || !sha.test(value.contentSha256)) throw invalid();
    scoped(value.scope, context); ref(value.ref, 'final', value.objectId); return value;
  }
  function selector(value: PrivateObjectSelector | null): PrivateObjectSelector | null {
    if (value === null) return null;
    if (!value || !uuid.test(value.objectId) || !['common','target'].includes(value.scope ?? '')) throw invalid();
    return value;
  }
  async function read<T>(context: RequestContext, query: string, args: unknown[], validate: (value: T | null, context: AuthenticatedRequestContext) => T | null) {
    const result = await authority.withScope(context, async (client, scopedContext) => {
      const { rows } = await client.query<{ value: T | null }>(query, args);
      return { value: validate(rows[0]?.value ?? null, scopedContext), context: scopedContext };
    });
    await current(result.context);
    return result.value;
  }
  async function sameAccount(client: PoolClient, context: AuthenticatedRequestContext) {
    const { rows } = await client.query<{ value: AccountAccess | null }>('SELECT gakja.resolve_account($1,$2) value', [context.principal.issuer,context.principal.subject]);
    const value = rows[0]?.value;
    if (!value || value.accountId !== context.account.accountId || value.ownerId !== context.account.ownerId || value.revision !== context.account.revision) {
      throw new RequestAccessError(403, 'ACCESS_DENIED');
    }
  }
  async function mutate<T>(context: RequestContext, query: string, args: unknown[], validate: (value: T | null, context: AuthenticatedRequestContext) => T | null) {
    const selected = await current(context);
    let client: PoolClient | undefined, begun = false, healthy = true;
    let result: T | null = null;
    try {
      client = await mappingPool.connect(); boundary.selectScope(selected, {});
      const role = (await client.query(`SELECT current_user::text AS current,session_user::text AS session,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
        EXISTS(SELECT 1 FROM pg_catalog.pg_roles p WHERE (p.rolsuper OR p.rolbypassrls OR p.rolname='gakja_owner')
          AND pg_catalog.pg_has_role(current_user,p.oid,'MEMBER')) elevated
        FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`)).rows[0];
      if (!role || role.current !== 'gakja_mapping' || role.session !== 'gakja_mapping' || role.rolsuper || role.rolbypassrls || role.rolcreaterole || role.rolcreatedb || role.elevated) {
        throw new DatabaseAuthorityError('DB_ROLE_DENIED');
      }
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); begun = true;
      const values = [selected.principal.issuer,selected.principal.subject,selected.account.accountId,selected.account.revision,
        selected.account.ownerId,selected.scope!.studentId,selected.scope!.applicationTargetId,'',''];
      for (let i=0;i<settings.length;i++) await client.query('SELECT pg_catalog.set_config($1,$2,true)', ['gakja.'+settings[i],values[i]]);
      await client.query("SELECT pg_catalog.set_config('statement_timeout','5000',true)");
      await sameAccount(client, selected);
      result = validate((await client.query<{value:T|null}>(query,args)).rows[0]?.value ?? null,selected);
      await sameAccount(client, selected); boundary.selectScope(selected, {});
      await client.query('COMMIT'); begun = false;
    } catch (error) {
      if (client && begun) { try { await client.query('ROLLBACK'); } catch { healthy = false; } }
      if (error instanceof RequestAccessError || error instanceof DatabaseAuthorityError) throw error;
      throw unavailable();
    } finally {
      if (client) {
        try {
          await client.query('RESET ALL');
          const { rows } = await client.query<{clean:boolean}>(`SELECT ${settings.map((_,i)=>`COALESCE(current_setting($${i+1},true),'')=''`).join(' AND ')} clean`,settings.map(s=>'gakja.'+s));
          healthy = healthy && rows[0]?.clean === true;
        } catch { healthy = false; }
        client.release(!healthy);
      }
    }
    // All SQL connections have been released before A reacquires its max=1 pool.
    await current(selected); boundary.selectScope(selected, {}); return result;
  }
  const transition = (context: RequestContext, receiptId: string, revision: string | null, action: string, actual?: {sizeBytes:number;contentSha256:string}) => {
    if (!uuid.test(receiptId) || revision !== null && !/^\d+$/u.test(revision)) return Promise.resolve(null);
    return mutate(context,'SELECT gakja.storage_transition($1::uuid,$2::bigint,$3::text,$4::bigint,$5::text) value',
      [receiptId,revision,action,actual?.sizeBytes ?? null,actual?.contentSha256 ?? null],registration);
  };
  return Object.freeze({
    async admit(context, input) {
      const selected = await current(context);
      if (input.studentId !== selected.scope!.studentId) throw new RequestAccessError(403,'ACCESS_DENIED');
      const payload = { kind:input.kind,scope:input.scope,studentId:input.studentId,
        ...(input.scope === 'target' ? {applicationTargetId:selected.scope!.applicationTargetId,supportTargetId:selected.scope!.supportTargetId}:{}),
        sourcePresent:Object.hasOwn(input,'sourceRevision') && input.sourceRevision !== undefined,sourceRevision:input.sourceRevision ?? null,
        domainPresent:Object.hasOwn(input,'domainSha256') && input.domainSha256 !== undefined,domainSha256:input.domainSha256 ?? null,
        expectedSize:input.expectedSize,expectedSha256:input.expectedSha256,idempotencyKey:input.idempotencyKey,
        bucket,keyPrefix,expiresInSeconds:ttl };
      const value = await mutate(selected,'SELECT gakja.storage_admit($1::jsonb) value',[JSON.stringify(payload)],registration);
      if (!value) throw invalid();
      if (input.mediaType !== undefined && value.mediaType !== input.mediaType) {
        const formatted = await mutate(selected,'SELECT gakja.storage_set_media_type($1::uuid,$2::bigint,$3::text) value',[value.receiptId,value.revision,input.mediaType],registration);
        if (!formatted) throw invalid(); return formatted;
      }
      return value;
    },
    setMediaType: (context,id,revision,mediaType) => mutate(context,'SELECT gakja.storage_set_media_type($1::uuid,$2::bigint,$3::text) value',[id,revision,mediaType],registration),
    getReceipt: (context,id) => uuid.test(id) ? read(context,'SELECT gakja.storage_get_receipt($1::uuid) value',[id],registration) : Promise.resolve(null),
    getVerified: (context,input) => uuid.test(input.objectId) ? read(context,'SELECT gakja.storage_get_verified($1::uuid,$2::text) value',[input.objectId,input.scope ?? null],verified) : Promise.resolve(null),
    beginUpload: (context,id,revision) => transition(context,id,revision,'uploading'),
    beginVerification: (context,id,revision) => transition(context,id,revision,'verifying'),
    finishVerification: (context,id,revision,actual) => transition(context,id,revision,'verified',actual),
    reject: (context,id,revision) => transition(context,id,revision,'rejected'),
    cancel: (context,id) => transition(context,id,null,'cancelled'),
    expire: (context,id) => transition(context,id,null,'expired'),
    markCleanup: (context,id,revision,result) => transition(context,id,revision,'cleanup_'+result),
    audioObject: (context,id) => read(context,'SELECT gakja.storage_audio_object($1::text) value',[id],selector),
    linkAudio: (context,id,audio) => mutate(context,'SELECT gakja.storage_link_audio($1::uuid,$2::text) value',[id,audio],selector),
    linkVersion: (context,id,kind,version) => mutate(context,'SELECT gakja.storage_link_version($1::uuid,$2::text,$3::text) value',[id,kind,version],selector),
    versionObject: (context,scope,kind,version) => read(context,'SELECT gakja.storage_version_object($1::text,$2::text,$3::text) value',[scope,kind,version],selector),
    legacyObject: (context,scope,kind,legacy,pin) => read(context,'SELECT gakja.storage_legacy_object($1::text,$2::text,$3::text,$4::text) value',[scope,kind,legacy,pin],selector),
  } satisfies PostgresObjectRepository);
}
