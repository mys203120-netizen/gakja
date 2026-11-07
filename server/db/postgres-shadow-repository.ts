import type { Pool, PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { RequestAccessError, type AccountAccess, type AuthenticatedRequestContext, type RequestContext, type RequestIdentityBoundary } from '../auth/request-identity';
import { type PostgresRequestAuthority } from './postgres-authority';
import type { ShadowArtifactBinding, ShadowArtifactRecord, ShadowImportCapability, ShadowPointer, ShadowRepository, ShadowSnapshot } from '../shadow/shadow-ports';

export class ShadowRepositoryError extends Error {
  constructor(readonly code: 'SHADOW_UNAVAILABLE' | 'SHADOW_INVALID_PLAN' | 'SHADOW_CONFLICT' | 'SHADOW_AUTHORITY_REQUIRED' | 'SHADOW_NOT_FOUND') {
    super(code); this.name='ShadowRepositoryError';
  }
}
export interface ShadowImportAuthority {
  runId: string; planSha256: string; ownerId: string; studentId: string; applicationTargetId: string; supportTargetId: string;
  artifactIds: readonly string[]; expiresAt: number; checkCurrent(): Promise<boolean>;
}
const capabilities=new WeakMap<ShadowImportCapability,Readonly<ShadowImportAuthority>>();
const nonempty=(value:unknown):value is string=>typeof value==='string' && value.length>0 && value===value.trim();
const sha=/^[a-f0-9]{64}$/u,runIdPattern=/^[a-z0-9_-]{8,128}$/u,uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const invalid=()=>new ShadowRepositoryError('SHADOW_INVALID_PLAN');
const scopeRequired=()=>new ShadowRepositoryError('SHADOW_AUTHORITY_REQUIRED');
const settings=['issuer','subject','account_id','account_revision','owner_id','student_id','application_target_id','job_id','worker_subject'];

/** Server composition only. A DTO cannot reproduce the WeakMap authority.
 * Operational operators and data attribution still require separate inputs. */
export function createShadowImportCapability(authority: ShadowImportAuthority): ShadowImportCapability {
  if (!runIdPattern.test(authority.runId) || !sha.test(authority.planSha256) ||
    ![authority.ownerId,authority.studentId,authority.applicationTargetId,authority.supportTargetId].every(nonempty) ||
    !Array.isArray(authority.artifactIds) || authority.artifactIds.length<1 || authority.artifactIds.length>512 ||
    authority.artifactIds.some(id=>!nonempty(id) || id.length>128) || new Set(authority.artifactIds).size!==authority.artifactIds.length ||
    !Number.isFinite(authority.expiresAt) || typeof authority.checkCurrent!=='function') throw scopeRequired();
  const capability=Object.freeze({kind:'shadow-import-capability-v1' as const});
  capabilities.set(capability,Object.freeze({...authority,artifactIds:Object.freeze([...authority.artifactIds]),checkCurrent:authority.checkCurrent.bind(authority)}));
  return capability;
}

/** Explicit request and trusted mapping pools. No operational env fallback and
 * no arbitrary SQL callback is exposed to import callers. All object I/O stays
 * outside these short transactions in the C service/orchestrator. */
export function createPostgresShadowRepository(options:{authority:PostgresRequestAuthority;boundary:RequestIdentityBoundary;mappingPool:Pool;now?:()=>number}):ShadowRepository {
  const {authority,boundary,mappingPool}=options,now=options.now??Date.now;
  async function current(context:RequestContext):Promise<AuthenticatedRequestContext> {
    const value=await boundary.revalidate(context);
    if(value.mode!=='authenticated' || !value.scope)throw scopeRequired();
    return value;
  }
  function sameScope(value:{ownerId:string;studentId:string;applicationTargetId?:string;supportTargetId?:string},context:AuthenticatedRequestContext,common=false) {
    if(value.ownerId!==context.account.ownerId || value.studentId!==context.scope!.studentId || !common &&
      (value.applicationTargetId!==context.scope!.applicationTargetId || value.supportTargetId!==context.scope!.supportTargetId))throw invalid();
  }
  function record(value:ShadowArtifactRecord|null,context:AuthenticatedRequestContext):ShadowArtifactRecord|null {
    if(value===null)return null;
    if(!value || !runIdPattern.test(value.runId) || !nonempty(value.artifactId) || !nonempty(value.role) || !nonempty(value.reference) ||
      !value.scope || !['common','target'].includes(value.scope.kind) || !/^\d+$/u.test(value.generation) || value.snapshotToken!==value.generation ||
      !['present','absent'].includes(value.availability) || !['planned','staged','bound','quarantined','absent'].includes(value.status))throw invalid();
    sameScope(value.scope,context,value.scope.kind==='common');
    if(value.availability==='absent') {
      if(value.status!=='absent' || value.required || value.absenceReason!=='known-absent' || value.objectId!==undefined || value.rawSha256!==undefined || value.sizeBytes!==undefined)throw invalid();
    } else {
      if(!sha.test(value.rawSha256??'') || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes!<1 || !nonempty(value.objectKind))throw invalid();
      if(value.objectId!==undefined && !uuid.test(value.objectId) || value.receiptId!==undefined && !uuid.test(value.receiptId))throw invalid();
      if(value.object) {
        const object=value.object;
        sameScope(object.scope,context,object.scope.kind==='common');
        if(value.objectId!==object.objectId || value.receiptId!==object.receiptId || value.objectRevision!==object.revision ||
          value.rawSha256!==object.contentSha256 || value.sizeBytes!==object.sizeBytes || value.objectKind!==object.kind ||
          value.scope.kind!==object.scope.kind || Object.hasOwn(value,'sourceRevision')!==Object.hasOwn(object,'sourceRevision') || value.sourceRevision!==object.sourceRevision ||
          Object.hasOwn(value,'domainSha256')!==Object.hasOwn(object,'domainSha256') || value.domainSha256!==object.domainSha256 || value.mediaType!==object.mediaType)throw invalid();
      }
    }
    return value;
  }
  function binding(value:ShadowArtifactBinding|null,context:AuthenticatedRequestContext):ShadowArtifactBinding|null {
    const checked=record(value,context);
    if(checked===null)return null;
    if(checked.status!=='bound' || checked.availability!=='present' || !checked.object)throw invalid();
    return checked as ShadowArtifactBinding;
  }
  function snapshot(value:ShadowSnapshot|null,context:AuthenticatedRequestContext):ShadowSnapshot|null {
    if(value===null)return null;
    if(!value || !runIdPattern.test(value.runId) || !sha.test(value.planSha256) || !['synthetic','local-verification-only'].includes(value.binding) ||
      !['open','cancelled','cleaned'].includes(value.state) || !/^\d+$/u.test(value.generation) || value.snapshotToken!==value.generation ||
      !Array.isArray(value.artifacts) || !Array.isArray(value.pointers))throw invalid();
    sameScope(value,context);
    for(const item of value.artifacts)if(!record(item,context) || item.runId!==value.runId || item.generation!==value.generation)throw invalid();
    return value;
  }
  function pointer(value:ShadowPointer|null):ShadowPointer|null {
    if(value!==null && (!nonempty(value.name) || !nonempty(value.artifactId) || !/^\d+$/u.test(value.generation)))throw invalid();
    return value;
  }
  async function requireCap(cap:ShadowImportCapability,context:AuthenticatedRequestContext,run:string,artifactIds:readonly string[]=[]) {
    const value=capabilities.get(cap);
    if(!value || value.runId!==run || now()>=value.expiresAt || artifactIds.some(id=>!value.artifactIds.includes(id)))throw scopeRequired();
    sameScope(value,context);
    let allowed=false;try{allowed=await value.checkCurrent();}catch{/* fail closed */}
    if(!allowed || now()>=value.expiresAt)throw scopeRequired();
    boundary.selectScope(context,{});return value;
  }
  async function read<T>(context:RequestContext,sql:string,args:unknown[],validate:(value:T|null,ctx:AuthenticatedRequestContext)=>T|null) {
    const result=await authority.withScope(context,async(client,ctx)=>({value:validate((await client.query<{value:T|null}>(sql,args)).rows[0]?.value??null,ctx),context:ctx}));
    await current(result.context);return result.value;
  }
  async function sameAccount(client:PoolClient,context:AuthenticatedRequestContext) {
    const value=(await client.query<{value:AccountAccess|null}>('SELECT gakja.resolve_account($1,$2) value',[context.principal.issuer,context.principal.subject])).rows[0]?.value;
    if(!value || value.accountId!==context.account.accountId || value.ownerId!==context.account.ownerId || value.revision!==context.account.revision)throw new RequestAccessError(403,'ACCESS_DENIED');
  }
  async function mutate<T>(context:RequestContext,run:string,cap:ShadowImportCapability,ids:readonly string[],sql:string,args:unknown[],validate:(value:T|null,ctx:AuthenticatedRequestContext)=>T|null,register=false) {
    const selected=await current(context),permit=await requireCap(cap,selected,run,ids);
    let client:PoolClient|undefined,begun=false,healthy=true,result:T|null=null;
    try {
      client=await mappingPool.connect();boundary.selectScope(selected,{});
      const role=(await client.query(`SELECT current_user::text current,session_user::text session,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
        EXISTS(SELECT 1 FROM pg_roles p WHERE (p.rolsuper OR p.rolbypassrls OR p.rolname='gakja_owner') AND pg_has_role(current_user,p.oid,'MEMBER')) elevated
        FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
      if(!role || role.current!=='gakja_mapping' || role.session!=='gakja_mapping' || role.rolsuper || role.rolbypassrls || role.rolcreaterole || role.rolcreatedb || role.elevated)throw scopeRequired();
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');begun=true;
      const values=[selected.principal.issuer,selected.principal.subject,selected.account.accountId,selected.account.revision,selected.account.ownerId,selected.scope!.studentId,selected.scope!.applicationTargetId,'',''];
      for(let i=0;i<settings.length;i++)await client.query('SELECT set_config($1,$2,true)',['gakja.'+settings[i],values[i]]);
      await client.query("SELECT set_config('statement_timeout','5000',true)");await sameAccount(client,selected);
      if(!register) {
        const capture=(await client.query<{value:ShadowSnapshot|null}>('SELECT gakja.shadow_capture($1) value',[run])).rows[0]?.value;
        if(!capture || capture.planSha256!==permit.planSha256)throw new ShadowRepositoryError('SHADOW_CONFLICT');
      }
      result=validate((await client.query<{value:T|null}>(sql,args)).rows[0]?.value??null,selected);
      await sameAccount(client,selected);boundary.selectScope(selected,{});
      await client.query('COMMIT');begun=false;
    } catch(error) {
      if(client&&begun){try{await client.query('ROLLBACK');}catch{healthy=false;}}
      if(error instanceof RequestAccessError || error instanceof ShadowRepositoryError)throw error;
      const code=(error as {code?:string})?.code;
      if(code==='23505'||code==='23514'||code==='23503')throw new ShadowRepositoryError('SHADOW_CONFLICT');
      if(code==='22023'||code==='22P02')throw invalid();
      if(code==='42501')throw new RequestAccessError(404,'RESOURCE_NOT_FOUND');
      throw new ShadowRepositoryError('SHADOW_UNAVAILABLE');
    } finally {
      if(client) {
        try{await client.query('RESET ALL');const clean=(await client.query<{clean:boolean}>(`SELECT ${settings.map((_,i)=>`coalesce(current_setting($${i+1},true),'')=''`).join(' AND ')} clean`,settings.map(s=>'gakja.'+s))).rows[0]?.clean;healthy=healthy&&clean===true;}catch{healthy=false;}
        client.release(!healthy);
      }
    }
    await requireCap(cap,selected,run,ids);await current(selected);boundary.selectScope(selected,{});return result;
  }
  const required=<T>(value:T|null):T=>{if(value===null)throw new ShadowRepositoryError('SHADOW_NOT_FOUND');return value;};
  return Object.freeze({
    async registerRun(context,plan,cap) {
      if(!plan || !runIdPattern.test(plan.runId) || !sha.test(plan.planSha256) || !Array.isArray(plan.artifacts) || !plan.artifacts.length || plan.artifacts.length>512)throw invalid();
      // The capability pins exact plan serialization, not merely a caller's
      // assertion that an arbitrary object happens to have the same SHA field.
      const {planSha256:_expected,...body}=plan;void _expected;
      let serialized:string;try{serialized=JSON.stringify(body);}catch{throw invalid();}
      if(createHash('sha256').update(serialized).digest('hex')!==plan.planSha256)throw invalid();
      const selected=await current(context),permit=await requireCap(cap,selected,plan.runId,plan.artifacts.map(a=>a.artifactId));sameScope(plan,selected);
      if(permit.planSha256!==plan.planSha256 || plan.artifacts.length!==permit.artifactIds.length || new Set(plan.artifacts.map(a=>a.artifactId)).size!==plan.artifacts.length)throw scopeRequired();
      return required(await mutate(context,plan.runId,cap,plan.artifacts.map(a=>a.artifactId),'SELECT gakja.shadow_register_run($1::jsonb) value',[JSON.stringify(plan)],snapshot,true));
    },
    async noteReceipt(context,run,id,receipt,cap) {if(!uuid.test(receipt))throw invalid();return required(await mutate(context,run,cap,[id],'SELECT gakja.shadow_note_receipt($1,$2,$3::uuid) value',[run,id,receipt],record));},
    async bindObject(context,run,id,receipt,cap) {if(!uuid.test(receipt))throw invalid();return required(await mutate(context,run,cap,[id],'SELECT gakja.shadow_bind_object($1,$2,$3::uuid) value',[run,id,receipt],binding));},
    async quarantine(context,run,id,cap) {return required(await mutate(context,run,cap,[id],'SELECT gakja.shadow_quarantine($1,$2) value',[run,id],record));},
    setPointer: (context,run,value,generation,cap)=>/^\d+$/u.test(generation)?mutate(context,run,cap,[value.artifactId],'SELECT gakja.shadow_set_pointer($1,$2,$3,$4,$5::bigint) value',[run,value.name,value.selection,value.artifactId,generation],pointer):Promise.reject(invalid()),
    async cancel(context,run,cap) {return required(await mutate(context,run,cap,[],'SELECT gakja.shadow_cancel_run($1) value',[run],snapshot));},
    async markCleaned(context,run,cap) {return required(await mutate(context,run,cap,[],'SELECT gakja.shadow_mark_cleaned($1) value',[run],snapshot));},
    capture: (context,run)=>runIdPattern.test(run)?read(context,'SELECT gakja.shadow_capture($1) value',[run],snapshot):Promise.resolve(null),
    resolve: (context,run,selector)=>read(context,'SELECT gakja.shadow_resolve($1,$2,$3,$4) value',[run,selector.role,selector.reference??null,selector.selection??null],binding),
    async unchanged(context,run,generation) {if(!/^\d+$/u.test(generation))return false;return (await read(context,'SELECT gakja.shadow_unchanged($1,$2::bigint) value',[run,generation],value=>value===null?false:value))===true;},
  } satisfies ShadowRepository);
}
