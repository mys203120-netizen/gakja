import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { schemaFingerprint } from '../../scripts/pr07b-migration.mjs';
import { Pool } from 'pg';
import { createRequestIdentityBoundary,type AuthenticatedRequestContext } from '../auth/request-identity';
import { trustedJwtVerifierFromEnv } from '../auth/jose-jwt-verifier';
import { createPostgresAccountResolver } from '../db/postgres-authority';
import { createScopedPostgresSessionCommandReader } from '../db/postgres-session-writer';
import { createScopedPostgresEvaluationWriter,createEvaluationWorkerCapability } from '../db/postgres-evaluation-writer';
import { createScopedEvaluationService } from '../evaluation-writer/isolated-evaluation-service';
import { createScopedEvaluationWorker,createNativeEvaluationProvider } from '../evaluation-writer/isolated-evaluation-worker';
import { createTrustedAuthenticatedEvaluationWorkerExecution } from '../internal-execution';
import { createPostgresTransitionRepository } from '../transition/postgres-transition';
import { createTransitionServiceAuthority,TransitionError } from '../transition/transition-ports';
import { createScopedServiceAuthority } from './scoped-authority';
import { parseServiceDeployment } from './preflight';
import { assertExternalReviewCurrent } from './production-composition';
/** Independent native worker. Only request+worker credentials are accepted;
 * no mapper, Storage service credential, global scan or public dispatch route. */
export function createProductionEvaluationWorker(input:{deployment:unknown;environment?:Readonly<Record<string,string|undefined>>}){
 if(input.environment&&input.environment!==process.env)throw new TransitionError(503,'SERVICE_ENVIRONMENT_OVERRIDE_FORBIDDEN');
 const env=input.environment??process.env,config=parseServiceDeployment(input.deployment);
 if(Object.keys(env).some(key=>/^(?:INTERVIEW_DB_(?:MAPPING|ADMIN|BYPASS)_URL|INTERVIEW_STORAGE_SERVICE_KEY)$/u.test(key)&&env[key]))throw new TransitionError(503,'WORKER_PRIVILEGED_CREDENTIAL_FORBIDDEN');
 if(!env.OPENAI_API_KEY?.trim())throw new TransitionError(503,'WORKER_NATIVE_PROVIDER_CONFIGURATION_REQUIRED');
 const make=(role:'REQUEST'|'WORKER')=>{const value=env['INTERVIEW_DB_'+role+'_URL'];if(!value)throw new TransitionError(503,'WORKER_DATABASE_CONFIGURATION_REQUIRED');let url:URL;try{url=new URL(value);}catch{throw new TransitionError(503,'WORKER_DATABASE_CONFIGURATION_REQUIRED');}if(!['postgres:','postgresql:'].includes(url.protocol)||decodeURIComponent(url.username)!=='gakja_'+role.toLowerCase()||!url.password)throw new TransitionError(503,'WORKER_RUNTIME_ROLE_REQUIRED');return new Pool({connectionString:value,max:1,connectionTimeoutMillis:5000});};
 const pools={request:make('REQUEST'),worker:make('WORKER')};
 const verifier=trustedJwtVerifierFromEnv(env);if(!verifier)throw new TransitionError(503,'WORKER_JWT_CONFIGURATION_REQUIRED');
 const identity=createRequestIdentityBoundary({mode:'service',verifier,accounts:createPostgresAccountResolver(pools.request)});
 const transitions=createPostgresTransitionRepository({identity,requestPool:pools.request});
 const authority=createScopedServiceAuthority(createTransitionServiceAuthority({mode:'service',identity,repository:transitions}),'production');
 const sessions=createScopedPostgresSessionCommandReader({authority,boundary:identity,requestPool:pools.request});
 const repository=createScopedPostgresEvaluationWriter({authority,boundary:identity,requestPool:pools.request,workerPool:pools.worker});
 const denied=()=>{throw new TransitionError(403,'WORKER_REVIEW_MUTATION_FORBIDDEN');};
 const service=createScopedEvaluationService({authority,identity,repository,sessions,async loadPinnedBank(){return denied();},mintReviewer:denied,mintAdmission:denied,async assertTrustCurrent(_context,trust){await assertExternalReviewCurrent(config,trust);}});
 const worker=createScopedEvaluationWorker({authority,identity,repository,sessions,service,provider:createNativeEvaluationProvider(authority)});
 return {async run(command:{bearerToken:string;selection:{studentId:string;applicationTargetId:string;supportTargetId:string};jobId:string;workerId:string;expectedTransitionGeneration:string;signal?:AbortSignal}){
   if(!/^[a-f0-9]{64}$/u.test(command.jobId)||!command.workerId||!/^\d+$/u.test(command.expectedTransitionGeneration))throw new TransitionError(400,'WORKER_FINITE_JOB_REQUIRED');
   for(const [role,pool]of Object.entries(pools)){const actual=(await pool.query("SELECT current_user::text current,session_user::text session,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb FROM pg_roles r WHERE r.rolname=current_user")).rows[0];if(!actual||actual.current!=='gakja_'+role||actual.session!=='gakja_'+role||actual.rolsuper||actual.rolbypassrls||actual.rolcreaterole||actual.rolcreatedb)throw new TransitionError(403,'WORKER_RUNTIME_ROLE_REQUIRED');}
   const versions=['0001_ownership','0002_private_storage','0003_read_shadow','0004_session_writer','0005_evaluation_writer','0006_scoped_transition','0007_transition_recovery','0008_service_inputs'];
   const migrations=(await pools.request.query('SELECT gakja.service_migration_status() value')).rows[0]?.value as Array<{version:string;checksum:string;fingerprint:string}>;
   if(!Array.isArray(migrations)||migrations.length!==versions.length)throw new TransitionError(503,'WORKER_MIGRATION_BOUNDARY_REQUIRED');
   for(let i=0;i<versions.length;i++){const expected=createHash('sha256').update(await readFile(new URL('../../db/migrations/'+versions[i]+'.sql',import.meta.url))).digest('hex');if(migrations[i].version!==versions[i]||migrations[i].checksum!==expected)throw new TransitionError(503,'WORKER_MIGRATION_CHECKSUM_CHANGED');}
   if(migrations.at(-1)!.fingerprint!==await schemaFingerprint(pools.request))throw new TransitionError(503,'WORKER_SCHEMA_DRIFT');
   const current=identity.selectScope(await identity.authenticate('Bearer '+command.bearerToken),command.selection)as AuthenticatedRequestContext;
   if(current.mode!=='authenticated'||!current.scope)throw new TransitionError(403,'WORKER_SCOPE_REQUIRED');
   const selected=config.bindings.filter(value=>value.ownerId===current.account.ownerId&&value.studentId===current.scope!.studentId&&value.applicationTargetId===current.scope!.applicationTargetId&&value.supportTargetId===current.scope!.supportTargetId&&Object.hasOwn(value,'sourceRevision')===Object.hasOwn(current.scope!,'sourceRevision')&&value.sourceRevision===current.scope!.sourceRevision);
   if(selected.length!==1||Date.now()<Date.parse(config.responsibility.startsAt)||Date.now()>=Date.parse(config.responsibility.endsAt))throw new TransitionError(403,'WORKER_EXPLICIT_DEPLOYMENT_SCOPE_REQUIRED');
   const state=await transitions.read(current);if(!state||state.generation!==command.expectedTransitionGeneration||state.state!=='db-primary'||!state.scopeExpiresAt)throw new TransitionError(409,'WORKER_TRANSITION_NOT_CURRENT');
   const expiresAt=Math.min(current.principal.expiresAt,Date.parse(state.scopeExpiresAt));
   const capability=createEvaluationWorkerCapability({ownerId:current.account.ownerId,...current.scope,subjectId:current.principal.subject,jobIds:[command.jobId],expiresAt,async checkCurrent(){try{await identity.revalidate(current);const actual=await transitions.read(current);return actual?.state==='db-primary'&&actual.generation===state.generation&&Date.now()<expiresAt;}catch{return false;}}});
   const jobs=repository.workerJobs(current,capability);
   const execution=createTrustedAuthenticatedEvaluationWorkerExecution({subjectId:current.principal.subject,jobIds:[command.jobId],issuedAt:Date.now(),expiresAt,scope:{ownerId:current.account.ownerId,...current.scope},async resolveBinding(jobId){if(jobId!==command.jobId)return null;const job=await jobs.get(jobId);return job?{jobId:job.id,ownerId:job.ownerId,sessionId:job.sessionId,studentId:current.scope!.studentId,applicationTargetId:current.scope!.applicationTargetId,supportTargetId:current.scope!.supportTargetId,sourceSha256:job.sourceSha256,snapshotSha256:job.snapshotSha256,contextSnapshotSha256:job.contextSnapshotSha256,pipelineVersion:job.pipelineVersion,model:job.model}:null;}});
   // The real F worker claim repeats the current, expiring DB subject→job grant
   // before any native SDK request; no supplied role or label substitutes it.
   return worker.run(current,{jobId:command.jobId,workerId:command.workerId,expectedTransitionGeneration:command.expectedTransitionGeneration,capability,execution,signal:command.signal});
 },async close(){await Promise.all(Object.values(pools).map(pool=>pool.end()));}};
}
