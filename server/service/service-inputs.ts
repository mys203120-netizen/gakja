import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuthenticatedRequestContext, RequestIdentityBoundary } from '../auth/request-identity';
import type { PostgresRequestAuthority } from '../db/postgres-authority';
import type { PostgresObjectRepository } from '../db/postgres-object-repository';
import type { PrivateObjectService } from '../storage/private-object-service';
import { createInternalObjectCapability } from '../storage/private-object-service';
import type { ShadowRunPlan, ShadowSnapshot } from '../shadow/shadow-ports';
import { TransitionError } from '../transition/transition-ports';
import { authorizeScoped, bindScopedComponent, scopedServiceAuthority, type ScopedServiceAuthority } from './scoped-authority';
import type { ScopedServiceAudio } from './session-providers';
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
export interface ServiceInputApproval {
  version:'service-input-approval-v1';planSha256:string;mappingApprovalSha256:string;sourceClosureSha256:string;provenanceOwnerId:string;sourceRevision?:string|null;
}
/** New plans require explicit finite G operator authority. Old runs cannot be promoted. */
export function createServiceInputRegistrar(options:{identity:RequestIdentityBoundary;requestAuthority:PostgresRequestAuthority;mappingPool:Pool}) {
  return {
    async register(context:AuthenticatedRequestContext,plan:ShadowRunPlan,evidence:ServiceInputApproval):Promise<ShadowSnapshot>{
      const current=await options.identity.revalidate(context);if(current.mode!=='authenticated'||!current.scope||plan.binding!=='service-verified')throw new TransitionError(403,'SERVICE_INPUT_AUTHORITY_REQUIRED');
      options.identity.assertResource(current,plan);
      const {planSha256,...body}=plan;
      if(sha(JSON.stringify(body))!==planSha256||evidence.version!=='service-input-approval-v1'||evidence.planSha256!==planSha256||
        ![evidence.mappingApprovalSha256,evidence.sourceClosureSha256].every(value=>/^[a-f0-9]{64}$/u.test(value)))throw new TransitionError(400,'SERVICE_INPUT_INVALID');
      let client:PoolClient|undefined,begun=false,healthy=true;
      try{
        client=await options.mappingPool.connect();const role=(await client.query(`SELECT current_user::text current,session_user::text session,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
          EXISTS(SELECT 1 FROM pg_roles p WHERE (p.rolsuper OR p.rolbypassrls OR p.rolname='gakja_owner') AND pg_has_role(current_user,p.oid,'MEMBER')) elevated FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
        if(!role||role.current!=='gakja_mapping'||role.session!=='gakja_mapping'||role.rolsuper||role.rolbypassrls||role.rolcreaterole||role.rolcreatedb||role.elevated)throw new TransitionError(403,'SERVICE_INPUT_AUTHORITY_REQUIRED');
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');begun=true;
        const vars={issuer:current.principal.issuer,subject:current.principal.subject,account_id:current.account.accountId,account_revision:current.account.revision,owner_id:current.account.ownerId,student_id:current.scope.studentId,application_target_id:current.scope.applicationTargetId};
        for(const [key,value]of Object.entries(vars))await client.query('SELECT set_config($1,$2,true)',['gakja.'+key,value]);
        await client.query("SELECT set_config('statement_timeout','5000',true)");
        const result=(await client.query('SELECT gakja.service_register_shadow_run($1::text,$2::text) value',[JSON.stringify(plan),JSON.stringify(evidence)])).rows[0]?.value as ShadowSnapshot|undefined;
        if(!result||result.binding!=='service-verified'||result.planSha256!==planSha256||result.runId!==plan.runId)throw new TransitionError(409,'SERVICE_INPUT_CHANGED');
        options.identity.selectScope(current,{});await client.query('COMMIT');begun=false;return result;
      }finally{if(client){if(begun)try{await client.query('ROLLBACK');}catch{healthy=false;}try{await client.query('RESET ALL');}catch{healthy=false;}client.release(!healthy);}}
    },
    async status(context:AuthenticatedRequestContext,runId:string){return options.requestAuthority.withScope(context,async client=>(await client.query('SELECT gakja.service_input_status($1::text) value',[runId])).rows[0]?.value??null);},
  };
}
/** Generated audio uses the unchanged v2 audio ID and C's actual byte verifier. */
export function createScopedServiceAudio(options:{authority:ScopedServiceAuthority;identity:RequestIdentityBoundary;requestAuthority:PostgresRequestAuthority;repository:PostgresObjectRepository;objects:PrivateObjectService}):ScopedServiceAudio {
  scopedServiceAuthority(options.authority);
  return bindScopedComponent(options.authority,{
    async read(context:AuthenticatedRequestContext,id:string){await authorizeScoped(options.authority,context,'read');return options.objects.readAudio(context,id);},
    async write(context:AuthenticatedRequestContext,input:{audioId:string;bytes:Buffer;sessionId:string;sourceRevision?:string|null}){
      const current=await options.identity.revalidate(context);if(current.mode!=='authenticated'||!current.scope)throw new TransitionError(403,'SERVICE_AUDIO_AUTHORITY_REQUIRED');
      await authorizeScoped(options.authority,current,'session-write',input.sessionId);
      if(!/^[a-f0-9]{64}$/u.test(input.audioId)||!Buffer.isBuffer(input.bytes)||!input.bytes.length)throw new TransitionError(400,'SERVICE_AUDIO_INVALID');
      const contentSha256=sha(input.bytes),source=Object.hasOwn(input,'sourceRevision')?{sourceRevision:input.sourceRevision}:{};
      const registered=await options.requestAuthority.withScope(current,async client=>(await client.query('SELECT gakja.service_register_audio($1::jsonb) value',[JSON.stringify({audioId:input.audioId,contentSha256,sessionId:input.sessionId,...source})])).rows[0]?.value);
      if(registered!==true)throw new TransitionError(409,'SERVICE_AUDIO_BINDING_CHANGED');
      const idempotencyKey='service-audio-v1:'+input.audioId;
      const internalAuthority={scope:{kind:'target',ownerId:current.account.ownerId,studentId:current.scope.studentId,applicationTargetId:current.scope.applicationTargetId,supportTargetId:current.scope.supportTargetId},...source,
        kinds:['audio'],idempotencyKeys:[idempotencyKey],objectIds:[],expiresAt:current.principal.expiresAt,
        async checkCurrent(){try{await options.identity.revalidate(current);await authorizeScoped(options.authority,current,'session-write',input.sessionId);return true;}catch{return false;}}};
      const capability=createInternalObjectCapability({...internalAuthority,scope:{...internalAuthority.scope,kind:'target'},kinds:['audio']});
      const receipt=await options.objects.admitGenerated(current,{kind:'audio',scope:'target',studentId:current.scope.studentId,...source,expectedSize:input.bytes.length,expectedSha256:contentSha256,idempotencyKey,mediaType:'audio/mpeg'},capability);
      const exactCapability=createInternalObjectCapability({...internalAuthority,scope:{...internalAuthority.scope,kind:'target'},kinds:['audio'],objectIds:[receipt.objectId]});
      await options.objects.upload(current,receipt.receiptId,input.bytes,exactCapability);await options.objects.complete(current,receipt.receiptId,exactCapability);
      if(!await options.repository.linkAudio(current,receipt.receiptId,input.audioId))throw new TransitionError(409,'SERVICE_AUDIO_BINDING_CHANGED');
      const actual=await options.objects.readAudio(current,input.audioId);if(!actual||!actual.equals(input.bytes))throw new TransitionError(409,'SERVICE_AUDIO_BYTES_CHANGED');
      await authorizeScoped(options.authority,current,'session-write',input.sessionId);
    },
  });
}
