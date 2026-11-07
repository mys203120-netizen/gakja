import { createHash } from 'node:crypto';
import { schemaFingerprint } from '../../scripts/pr07b-migration.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { createRequestIdentityBoundary, type AuthenticatedRequestContext } from '../auth/request-identity';
import { trustedJwtVerifierFromEnv } from '../auth/jose-jwt-verifier';
import { createPostgresAccountResolver } from '../db/postgres-authority';
import { createScopedPostgresSessionCommandRepository, createSessionEnrollmentCapability } from '../db/postgres-session-writer';
import { createScopedPostgresEvaluationWriter, createEvaluationReviewerCapability, createEvaluationAdmissionCapability } from '../db/postgres-evaluation-writer';
import { createScopedPostgresObjectRepository } from '../db/postgres-object-repository';
import { createScopedPostgresShadowRepository } from '../db/postgres-shadow-repository';
import { createPostgresTransitionRepository } from '../transition/postgres-transition';
import { createTransitionServiceAuthority, TransitionError } from '../transition/transition-ports';
import { createPrivateObjectService } from '../storage/private-object-service';
import { createSupabaseObjectProvider } from '../storage/supabase-object-provider';
import { withPrivateObjectAudio } from '../storage/service-object-audio';
import { createScopedShadowReadRepositories } from '../repositories/shadow-read-repositories';
import { loadInterviewContextAt } from '../data/load-interview-context';
import { loadQuestionBank, loadQuestionBankByPinnedPlan } from '../data/prepared-question-bank';
import type { InterviewPlan } from '../interview-planner';
import type { SessionCommandSnapshot } from '../session-writer/session-command-ports';
import { createScopedSessionService } from '../session-writer/isolated-session-service';
import { createScopedEvaluationService } from '../evaluation-writer/isolated-evaluation-service';
import { createScopedEvaluationWorker, createNativeEvaluationProvider } from '../evaluation-writer/isolated-evaluation-worker';
import { EvaluationWriterError, type EvaluationReviewArtifact } from '../evaluation-writer/evaluation-writer-ports';
import { createScopedServiceRealtimeServer } from '../request-realtime-server';
import { realtimeCoreModel, runtimeFactReviewModel } from '../providers/realtime-model';
import { createScopedServiceAuthority, bindScopedComponent, authorizeScoped } from './scoped-authority';
import { createScopedPostgresRequestAuthority } from './postgres-request-authority';
import { createNativeSessionProviders } from './session-providers';
import { createScopedServiceAudio, createServiceInputRegistrar } from './service-inputs';
import { parseServiceDeployment, runServicePreflight, type ServiceDeploymentConfig,type ServicePreflight } from './preflight';

function required(env:Readonly<Record<string,string|undefined>>,key:string){const value=env[key];if(!value||value!==value.trim())throw new TransitionError(503,'SERVICE_CONFIGURATION_REQUIRED');return value;}
function databaseUrl(env:Readonly<Record<string,string|undefined>>,key:string,role:string){const value=required(env,key);let url:URL;try{url=new URL(value);}catch{throw new TransitionError(503,'SERVICE_DATABASE_CONFIGURATION_INVALID');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||decodeURIComponent(url.username)!==role||!url.password||url.hash)throw new TransitionError(503,'SERVICE_DATABASE_ROLE_REQUIRED');return value;}
function selectedBinding(config:ServiceDeploymentConfig,context:AuthenticatedRequestContext){
 const now=Date.now();if(now<Date.parse(config.responsibility.startsAt)||now>=Date.parse(config.responsibility.endsAt))throw new TransitionError(403,'SERVICE_SCOPE_PERIOD_ENDED');
 const rows=config.bindings.filter(value=>value.ownerId===context.account.ownerId&&value.studentId===context.scope?.studentId&&value.applicationTargetId===context.scope.applicationTargetId&&value.supportTargetId===context.scope.supportTargetId&&
 Object.hasOwn(value,'sourceRevision')===Object.hasOwn(context.scope,'sourceRevision')&&value.sourceRevision===context.scope.sourceRevision);
 if(rows.length!==1)throw new TransitionError(403,'SERVICE_SELECTED_SCOPE_REQUIRED');return rows[0];
}
/** Apply the declared native deployment allowlist before work and before a
 * result is published. Actual request identity and G authority remain live DB checks. */
export async function runProductionScopedOperation<T>(config:ServiceDeploymentConfig,context:AuthenticatedRequestContext,operation:()=>Promise<T>):Promise<T>{
 const selected=selectedBinding(config,context);
 const pin=()=>JSON.stringify([context.account.ownerId,context.scope?.studentId,context.scope?.applicationTargetId,context.scope?.supportTargetId,Object.hasOwn(context.scope??{},'sourceRevision'),context.scope?.sourceRevision??null]);
 const before=pin(),runId=selected.runId,result=await operation();
 if(selectedBinding(config,context).runId!==runId||pin()!==before)throw new TransitionError(403,'SERVICE_SCOPE_CHANGED');return result;
}
/** Freshness is an explicit externally supplied policy. No default age is invented. */
export async function assertExternalReviewCurrent(config:ServiceDeploymentConfig,trust:EvaluationReviewArtifact,now=Date.now()){
 const policy=config.reviewSynchronization;if(!policy)throw new EvaluationWriterError(409,'F_REVIEW_TRUST_FRESHNESS_REQUIRED');
 let assertion:{version?:unknown;trustSha256?:unknown;observedAt?:unknown;expiresAt?:unknown;revoked?:unknown};
 try{const bytes=await readFile(policy.assertionPath);if(bytes.length>1048576)throw new Error();assertion=JSON.parse(bytes.toString('utf8'));}catch{throw new EvaluationWriterError(409,'F_REVIEW_TRUST_SYNCHRONIZATION_UNAVAILABLE');}
 const observed=typeof assertion.observedAt==='string'?Date.parse(assertion.observedAt):NaN,expires=typeof assertion.expiresAt==='string'?Date.parse(assertion.expiresAt):NaN;
 if(assertion.version!=='review-trust-synchronization-v1'||assertion.trustSha256!==trust.contentSha256||assertion.revoked!==false||!Number.isFinite(observed)||!Number.isFinite(expires)||observed>now||now-observed>policy.maxAgeMs||now>=expires)
 throw new EvaluationWriterError(409,'F_REVIEW_TRUST_NOT_CURRENT');
}
/** Native-only production assembly. No signer, raw model transport, synthetic
 * resource, alternate identity factory, local data reader or fetch override is accepted. */
export async function createProductionServiceComposition(input:{deployment:unknown;environment?:Readonly<Record<string,string|undefined>>}){
 if(input.environment&&input.environment!==process.env)throw new TransitionError(503,'SERVICE_ENVIRONMENT_OVERRIDE_FORBIDDEN');
 const env=input.environment??process.env,config=parseServiceDeployment(input.deployment),now=Date.now();
 if(now<Date.parse(config.responsibility.startsAt)||now>=Date.parse(config.responsibility.endsAt))throw new TransitionError(503,'SERVICE_SCOPE_PERIOD_REQUIRED');
 const verifier=trustedJwtVerifierFromEnv(env);if(!verifier)throw new TransitionError(503,'SERVICE_AUTH_CONFIGURATION_REQUIRED');
 const pools={request:new Pool({connectionString:databaseUrl(env,'INTERVIEW_DB_REQUEST_URL','gakja_request'),max:4}),mapping:new Pool({connectionString:databaseUrl(env,'INTERVIEW_DB_MAPPING_URL','gakja_mapping'),max:2}),worker:new Pool({connectionString:databaseUrl(env,'INTERVIEW_DB_WORKER_URL','gakja_worker'),max:2})};
 const identity=createRequestIdentityBoundary({mode:'service',verifier,accounts:createPostgresAccountResolver(pools.request)});
 const transitions=createPostgresTransitionRepository({identity,requestPool:pools.request,mappingPool:pools.mapping});
 const authority=createScopedServiceAuthority(createTransitionServiceAuthority({mode:'service',identity,repository:transitions}),'production');
 const requestAuthority=createScopedPostgresRequestAuthority({pool:pools.request,boundary:identity,authority});
 const bucket=required(env,'INTERVIEW_STORAGE_BUCKET'),keyPrefix=required(env,'INTERVIEW_STORAGE_KEY_PREFIX');
 const objectRepository=createScopedPostgresObjectRepository({authority:requestAuthority,boundary:identity,mappingPool:pools.mapping,bucket,keyPrefix,serviceAuthority:authority});
 const objects=createPrivateObjectService({repository:objectRepository,provider:createSupabaseObjectProvider({apiUrl:required(env,'INTERVIEW_STORAGE_API_URL'),serviceCredential:required(env,'INTERVIEW_STORAGE_SERVICE_KEY'),bucket,keyPrefix})});
 const shadow=createScopedPostgresShadowRepository({authority:requestAuthority,boundary:identity,mappingPool:pools.mapping,serviceAuthority:authority});
 const inputs=createServiceInputRegistrar({identity,requestAuthority,mappingPool:pools.mapping});
 const repository=createScopedPostgresSessionCommandRepository({authority,boundary:identity,requestPool:pools.request,mappingPool:pools.mapping});
 const evaluations=createScopedPostgresEvaluationWriter({authority,boundary:identity,requestPool:pools.request,mappingPool:pools.mapping,workerPool:pools.worker});
 const root=path.resolve('.service-local-inputs-forbidden');
 async function reader(context:AuthenticatedRequestContext,runId:string){
   const read=await createScopedShadowReadRepositories({authority,context,runId,repository:shadow,objects});
   const approved=await inputs.status(context,runId);
   if(!approved||approved.planSha256!==read.snapshot.planSha256)throw new TransitionError(409,'SERVICE_INPUT_APPROVAL_REQUIRED');return read;
 }
 async function assertPinned(context:AuthenticatedRequestContext,snapshot:SessionCommandSnapshot){
   const binding=selectedBinding(config,context),pins=JSON.parse(snapshot.pinsJson) as {D?:{runId:string;generation:string;planSha256:string}};
   if(!pins.D||pins.D.runId!==binding.runId)throw new TransitionError(409,'SERVICE_PIN_CHANGED');
   const read=await reader(context,pins.D.runId);if(read.snapshot.generation!==pins.D.generation||read.snapshot.planSha256!==pins.D.planSha256)throw new TransitionError(409,'SERVICE_PIN_CHANGED');await read.assertSnapshotUnchanged();
 }
 async function bank(context:AuthenticatedRequestContext,snapshot:SessionCommandSnapshot,session:Parameters<Parameters<typeof createScopedSessionService>[0]['readPinnedBank']>[2],fixed:Parameters<Parameters<typeof createScopedSessionService>[0]['readPinnedBank']>[3]){
   await assertPinned(context,snapshot);const binding=selectedBinding(config,context),read=await reader(context,binding.runId);
   const value=await loadQuestionBankByPinnedPlan(fixed,session.plan!,{...read.bankOptions(),root});await read.assertSnapshotUnchanged();if(!value)throw new TransitionError(409,'SERVICE_PINNED_BANK_UNAVAILABLE');return value;
 }
 const audio=createScopedServiceAudio({authority,identity,requestAuthority,repository:objectRepository,objects});
 const models={question:env.OPENAI_QUESTION_MODEL||'gpt-6-luna',realtime:realtimeCoreModel(env),review:runtimeFactReviewModel(env),evaluation:env.OPENAI_ANALYSIS_MODEL||'gpt-6.1-terra'};
 if(Object.values(models).some(value=>/synthetic|fixture|test-only/iu.test(value)))throw new TransitionError(503,'SERVICE_NATIVE_MODEL_REQUIRED');
 const finite=(context:AuthenticatedRequestContext)=>({ownerId:context.account.ownerId,...context.scope!,expiresAt:context.principal.expiresAt,async checkCurrent(){try{await identity.revalidate(context);await authorizeScoped(authority,context,'read');return true;}catch{return false;}}});
 const service=createScopedSessionService({authority,identity,repository,providers:createNativeSessionProviders({authority,audio}),models,
   async prepare(context){const binding=selectedBinding(config,context),read=await reader(context,binding.runId),value=await loadInterviewContextAt(root,{...read.readOptions(),writeManifest:false});
     const prepared=await loadQuestionBank(value,{...read.bankOptions(),root,plan:binding.plan as InterviewPlan,environment:env});
     if(value.errors.length||!prepared)throw new TransitionError(409,'SERVICE_INPUT_PREPARATION_REJECTED');await read.assertSnapshotUnchanged();
     return {context:value,bank:prepared,pins:{D:{runId:binding.runId,generation:read.snapshot.generation,planSha256:read.snapshot.planSha256}},...(Object.hasOwn(binding,'sourceRevision')?{sourceRevision:binding.sourceRevision}:{}),assertCurrent:async()=>{await read.assertSnapshotUnchanged();await identity.revalidate(context);}};
   },assertPinned,readPinnedBank:bank,
   mintEnrollment(context,entry){return createSessionEnrollmentCapability({...finite(context),sessionId:entry.sessionId,creationKey:entry.creationKey,inputSha256:entry.inputSha256});},
 });
 const evaluation=createScopedEvaluationService({authority,identity,repository:evaluations,sessions:repository,
   async loadPinnedBank(context,snapshot){const decoded=await service.mutations.context(context,snapshot.binding);void decoded;
     const value=JSON.parse(snapshot.sessionJson),fixed=JSON.parse(snapshot.contextJson);return bank(context,snapshot,value,fixed);},
   async assertTrustCurrent(_context,trust){await assertExternalReviewCurrent(config,trust);},
   mintReviewer(context,value){return createEvaluationReviewerCapability({...finite(context),issuer:context.principal.issuer,subject:context.principal.subject,actorId:value.actorId,publicKeySha256:value.publicKeySha256,action:value.action,expectedTrustGeneration:value.control.trustGeneration,...(value.sessionId?{sessionId:value.sessionId}:{})});},
   mintAdmission(context,entry){return createEvaluationAdmissionCapability({...finite(context),sessionId:entry.sessionId,inputSha256:entry.inputSha256,handoffIntentId:entry.handoffIntentId,handoffPayloadSha256:entry.handoffPayloadSha256});},
 });
 const resourcesBase=bindScopedComponent(authority,withPrivateObjectAudio({...service.resources,audioBinding:(context,id)=>requestAuthority.discoverAudio(context,id)},objects,identity));
 let readiness:ServicePreflight|undefined;
 async function verifyReadiness(){
   let selected:Promise<AuthenticatedRequestContext[]>|undefined;
   const contexts=()=>selected??=(async()=>{
     const file=env.INTERVIEW_G_PREFLIGHT_TOKENS_FILE;if(!file)throw new TransitionError(503,'SERVICE_PREFLIGHT_TOKENS_REQUIRED');
     const bytes=await readFile(file);if(bytes.length>1048576)throw new Error('SERVICE_PREFLIGHT_TOKENS_INVALID');
     const tokens=JSON.parse(bytes.toString('utf8')) as Array<{applicationTargetId:string;bearerToken:string}>;
     if(!Array.isArray(tokens)||tokens.length!==config.bindings.length)throw new Error('SERVICE_PREFLIGHT_TOKENS_INVALID');
     const result:AuthenticatedRequestContext[]=[];
     for(const binding of config.bindings){const matches=tokens.filter(value=>value.applicationTargetId===binding.applicationTargetId);if(matches.length!==1||typeof matches[0].bearerToken!=='string')throw new Error('SERVICE_PREFLIGHT_TOKENS_INVALID');
       const authenticated=await identity.authenticate('Bearer '+matches[0].bearerToken);if(authenticated.mode!=='authenticated')throw new Error('SERVICE_PREFLIGHT_AUTH_INVALID');
       const current=identity.selectScope(authenticated,{studentId:binding.studentId,applicationTargetId:binding.applicationTargetId,supportTargetId:binding.supportTargetId}) as AuthenticatedRequestContext;
       selectedBinding(config,current);result.push(current);
     }return result;
   })();
   const pass=(code:string)=>({status:'pass' as const,evidence:[code]});
   const tokenCheck=async()=>{if(!env.INTERVIEW_G_PREFLIGHT_TOKENS_FILE)return {status:'blocked' as const,evidence:['EXPLICIT_PREFLIGHT_TOKEN_SUPPLY_REQUIRED']};await contexts();return pass('CURRENT_JWT_ACCOUNT_SCOPE_VERIFIED');};
   readiness=await runServicePreflight({environment:env,deployment:config,probes:{
     auth:tokenCheck,'account-mapping':tokenCheck,
     async 'database-roles'(){for(const [role,pool]of Object.entries(pools)){const actual=(await pool.query(`SELECT current_user::text current,session_user::text session,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
       EXISTS(SELECT 1 FROM pg_roles p WHERE (p.rolsuper OR p.rolbypassrls OR p.rolname='gakja_owner') AND pg_has_role(current_user,p.oid,'MEMBER')) elevated FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
       if(!actual||actual.current!=='gakja_'+role||actual.session!=='gakja_'+role||actual.rolsuper||actual.rolbypassrls||actual.rolcreaterole||actual.rolcreatedb||actual.elevated)throw new Error('SERVICE_DATABASE_ROLE_DENIED');}return pass('ALL_THREE_RUNTIME_ROLES_VERIFIED');},
     async 'migrations-rls-fk'(){const versions=['0001_ownership','0002_private_storage','0003_read_shadow','0004_session_writer','0005_evaluation_writer','0006_scoped_transition','0007_transition_recovery','0008_service_inputs'];
       const rows=(await pools.request.query('SELECT gakja.service_migration_status() value')).rows[0]?.value as Array<{version:string;checksum:string;fingerprint:string}>;
       if(!Array.isArray(rows)||rows.length!==versions.length)throw new Error('SERVICE_MIGRATION_BOUNDARY_REQUIRED');
       for(let i=0;i<versions.length;i++){const expected=createHash('sha256').update(await readFile(new URL('../../db/migrations/'+versions[i]+'.sql',import.meta.url))).digest('hex');if(rows[i].version!==versions[i]||rows[i].checksum!==expected)throw new Error('SERVICE_MIGRATION_CHECKSUM_CHANGED');}
       if(rows.at(-1)!.fingerprint!==await schemaFingerprint(pools.request))throw new Error('SERVICE_SCHEMA_RLS_FK_DRIFT');return pass('EXACT_MIGRATION_CHECKSUMS_AND_SCHEMA_FINGERPRINT_VERIFIED');},
     async storage(){const base=new URL(required(env,'INTERVIEW_STORAGE_API_URL'));base.pathname=base.pathname.replace(/\/$/u,'')+'/bucket/'+encodeURIComponent(bucket);
       const response=await fetch(base,{method:'GET',headers:{apikey:required(env,'INTERVIEW_STORAGE_SERVICE_KEY'),Authorization:'Bearer '+required(env,'INTERVIEW_STORAGE_SERVICE_KEY')},redirect:'error',signal:AbortSignal.timeout(15000)});
       if(!response.ok)throw new Error('SERVICE_PRIVATE_BUCKET_UNAVAILABLE');const value=await response.json() as {id?:unknown;public?:unknown};if(value.id!==bucket||value.public!==false)throw new Error('SERVICE_BUCKET_MUST_BE_PRIVATE');return pass('CONFIGURED_PRIVATE_BUCKET_METADATA_VERIFIED_NO_UPLOAD');},
     async 'review-trust'(){if(!env.INTERVIEW_G_PREFLIGHT_TOKENS_FILE)return {status:'blocked',evidence:['EXPLICIT_PREFLIGHT_TOKEN_SUPPLY_REQUIRED']};for(const context of await contexts()){const control=await evaluations.scopeControl(context);if(!control.trust)return {status:'blocked',evidence:['CURRENT_A_B_TRUST_SUPPLY_REQUIRED']};await assertExternalReviewCurrent(config,control.trust);}return pass('CURRENT_TRUST_AND_EXPLICIT_EXTERNAL_SYNCHRONIZATION_VERIFIED');},
     async providers(){return {status:'pass',evidence:['NATIVE_ADAPTERS_AND_EXISTING_MODELS_BOUND','COMMERCIAL_PROVIDER_CALL_NOT_RUN']};},
     async 'transition-scope'(){if(!env.INTERVIEW_G_PREFLIGHT_TOKENS_FILE)return {status:'blocked',evidence:['EXPLICIT_PREFLIGHT_TOKEN_SUPPLY_REQUIRED']};let writable=true;for(const context of await contexts()){const state=await transitions.read(context);if(!state||!['verified','db-primary','read-only-recovery'].includes(state.state))return {status:'blocked',evidence:['VERIFIED_FINITE_TRANSITION_SCOPE_REQUIRED']};if(state.scopeExpiresAt&&Date.parse(state.scopeExpiresAt)>Date.parse(config.responsibility.endsAt))return {status:'fail',evidence:['TRANSITION_SCOPE_EXCEEDS_DECLARED_RESPONSIBILITY_PERIOD']};await reader(context,selectedBinding(config,context).runId);writable=writable&&state.state==='db-primary'&&typeof state.scopeExpiresAt==='string'&&Date.parse(state.scopeExpiresAt)>Date.now();}return {status:'pass',evidence:['CURRENT_TRANSITION_AND_NEW_EXPLICIT_SERVICE_INPUT_APPROVAL_VERIFIED',writable?'TRANSITION_DB_PRIMARY_FINITE_WRITE_ENABLED':'TRANSITION_READ_ONLY_OR_NOT_ACTIVATED']};},
   }});return readiness;
 }
 await verifyReadiness();
 function checked<T extends object>(component:T):T{
   const wrapped=new Proxy(component,{get(target,key,receiver){const value=Reflect.get(target,key,receiver);if(typeof value!=='function')return value;
     return (...args:unknown[])=>runProductionScopedOperation(config,args[0] as AuthenticatedRequestContext,()=>Reflect.apply(value,target,args));
   }});return bindScopedComponent(authority,wrapped);
 }
 const resources=checked(resourcesBase),sessionMutations=checked(service.mutations),evaluationMutations=checked(evaluation.mutations);
 const worker=createScopedEvaluationWorker({authority,identity,repository:evaluations,sessions:repository,service:evaluation,provider:createNativeEvaluationProvider(authority)});
 return {identity,authority,transitions,repository,evaluations,objects,shadow,inputs,service:{...service,mutations:sessionMutations},evaluation:{...evaluation,mutations:evaluationMutations},worker,resources,
   preflight:verifyReadiness,readiness,
   createServer:(options:{webPort?:number;allowedHosts?:readonly string[];allowedOrigins?:readonly string[]}={})=>{if(!readiness?.ready)throw new TransitionError(503,'SERVICE_PREFLIGHT_NOT_READY');return createScopedServiceRealtimeServer({...options,authority,identity,resources,sessionMutations,evaluationMutations});},
   async close(){await service.close();await Promise.all(Object.values(pools).map(pool=>pool.end()));},
 };
}
