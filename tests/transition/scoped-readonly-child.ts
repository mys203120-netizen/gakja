import { decodeScopedServiceCommand } from '../../server/service/scoped-command';
import { authenticatedSessionCommandSchema,sessionCommandInputSha256 } from '../../server/session-writer/session-command-codec';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { createHash,randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createSessionTestAuthority,type createSessionTestSigningAuthority,type PublicDSessionFixture } from '../session-writer/d-preparation';
import { createPostgresTransitionRepository } from '../../server/transition/postgres-transition';
import { createTransitionServiceAuthority,TransitionError } from '../../server/transition/transition-ports';
import { createScopedServiceAuthority,bindScopedComponent } from '../../server/service/scoped-authority';
import { createScopedPostgresRequestAuthority } from '../../server/service/postgres-request-authority';
import { createScopedPostgresSessionCommandRepository } from '../../server/db/postgres-session-writer';
import { createScopedPostgresEvaluationWriter } from '../../server/db/postgres-evaluation-writer';
import { createReadOnlyScopedPostgresObjectRepository } from '../../server/db/postgres-object-repository';
import { createScopedPostgresShadowReader } from '../../server/db/postgres-shadow-repository';
import { createPrivateObjectService } from '../../server/storage/private-object-service';
import { createSupabaseObjectProvider } from '../../server/storage/supabase-object-provider';
import { createRestoredObjectProvider,type RecoveryLocation } from '../../server/transition/recovery';
import { createScopedShadowReadRepositories } from '../../server/repositories/shadow-read-repositories';
import { createScopedServiceRealtimeServer,type ServiceRequestResources } from '../../server/request-realtime-server';
import { AUTHENTICATED_SESSION_ENVELOPE_VERSION,decodeAuthenticatedSessionEnvelope } from '../../server/contracts/authenticated-session-codec';
import type { AuthenticatedRequestContext } from '../../server/auth/request-identity';
import type { ServiceSessionMutations } from '../../server/session-writer/service-session-mutations';
import type { ObjectStorageProvider } from '../../server/storage/private-object-ports';
import type { LocatedStoredFile } from '../../server/repositories/analysis-read-ports';
import { composeScopedEvaluation } from './scoped-evaluation-composition';
import { interviewConfig } from '../../interview.config';
import { loadInterviewContextAt } from '../../server/data/load-interview-context';
import { loadQuestionBank } from '../../server/data/prepared-question-bank';
if(process.env.PR07G_TEST_DISPOSABLE!=='1'||!process.env.PR07G_TEST_RUN_ID||!process.send)throw new Error('G_OWNED_READONLY_CHILD_REQUIRED');
const send=(value:unknown)=>process.send?.(value);
interface Initial{type:'initialize';name:string;database:'restore';jwk:Awaited<ReturnType<typeof createSessionTestSigningAuthority>>['jwk'];tokens:Record<string,string>;fixtureRoot:string;fixture:PublicDSessionFixture;runIds:Record<string,string>;locations:RecoveryLocation[];metadataJson:string;manifestSha256:string;controlledProvider:boolean;originalEndpoints:{database:{hostname:string;port:number};storageOrigin:string}}
const initial=await new Promise<Initial>(resolve=>{const receive=(value:Initial)=>{if(value?.type==='initialize'){process.off('message',receive);resolve(value);}};process.on('message',receive);send({type:'boot',pid:process.pid});});
if(initial.database!=='restore'||!initial.locations?.length)throw new Error('G_RESTORED_LOCATIONS_REQUIRED');
const forbidden=Object.keys(process.env).filter(key=>/^PR07[BCDEFG]_TEST_(?:(?:RESTORE_)?(?:ADMIN|MAPPING|BYPASS|WORKER)_URL|BOOTSTRAP_URL)$/u.test(key)||/^PR07[BCDEF]_TEST_.*STORAGE.*KEY$/u.test(key)||/^PR07G_TEST_STORAGE_(?:SERVICE|ANON)_KEY$/u.test(key));
if(forbidden.length)throw new Error('G_READONLY_PRIVILEGED_OR_SOURCE_CREDENTIAL_INHERITED');
const url=process.env.PR07G_TEST_RESTORE_REQUEST_URL;if(!url||!/^\/pr07g_restore_[a-z0-9_]+$/u.test(new URL(url).pathname))throw new Error('G_OWNED_RESTORE_DATABASE_REQUIRED');
const request=new Pool({connectionString:url,max:1,connectionTimeoutMillis:5000,idleTimeoutMillis:1000});
const auth=createSessionTestAuthority({request}as Parameters<typeof createSessionTestAuthority>[0],initial.jwk);
const counters={localFileWrites:0,localPrivateReads:0,externalNetworkAttempts:0,modelCalls:0,paidProviderCalls:0,storageReads:0,originalDbDeniedAttempts:0,originalStorageDeniedAttempts:0,freshWriteRejections:0,workerClaims:0};
const nativeRead=fs.promises.readFile.bind(fs.promises),nativeReadSync=fs.readFileSync.bind(fs);
const denyRead=(value:unknown)=>{const name=String(value).replaceAll('\\','/');if(name.includes('/server/data/')||name.includes('/synthetic-input/')||path.resolve(String(value)).startsWith(path.resolve(initial.fixtureRoot))){counters.localPrivateReads++;throw new Error('G_READONLY_LOCAL_PRIVATE_READ');}};
fs.promises.readFile=(async(...args:Parameters<typeof nativeRead>)=>{denyRead(args[0]);return nativeRead(...args);})as typeof fs.promises.readFile;
fs.readFileSync=((...args:Parameters<typeof nativeReadSync>)=>{denyRead(args[0]);return nativeReadSync(...args);})as typeof fs.readFileSync;
for(const name of ['writeFile','appendFile','mkdir','rm','rmdir','unlink','truncate','rename']as const)Object.assign(fs.promises,{[name]:async()=>{counters.localFileWrites++;throw new Error('G_READONLY_LOCAL_WRITE');}});
syncBuiltinESMExports();
const sourceStorage=new URL(initial.originalEndpoints.storageOrigin),nativeFetch=globalThis.fetch;
globalThis.fetch=(input,options)=>{const target=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(target.origin===sourceStorage.origin){counters.originalStorageDeniedAttempts++;throw new Error('G_SOURCE_STORAGE_ENDPOINT_DENIED');}if(!['127.0.0.1','localhost','[::1]'].includes(target.hostname)){counters.externalNetworkAttempts++;throw new Error('G_READONLY_EXTERNAL_PROVIDER');}return nativeFetch(input,options);};
const nativeConnect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(this:net.Socket,...args:Parameters<typeof nativeConnect>){const value=args[0]as unknown,option=Array.isArray(value)?value[0]:value;
 const host=option&&typeof option==='object'&&'host'in option?String(option.host):typeof args[1]==='string'?args[1]:'localhost';const port=option&&typeof option==='object'&&'port'in option?Number(option.port):typeof option==='number'?option:NaN;
 if(host===initial.originalEndpoints.database.hostname&&port===initial.originalEndpoints.database.port){counters.originalDbDeniedAttempts++;throw new Error('G_SOURCE_DATABASE_ENDPOINT_DENIED');}
 if(!(option&&typeof option==='object'&&'path'in option)&&!['127.0.0.1','localhost','::1','[::1]'].includes(host)){counters.externalNetworkAttempts++;throw new Error('G_READONLY_EXTERNAL_NETWORK');}return Reflect.apply(nativeConnect,this,args);
}as typeof nativeConnect;
const transitions=createPostgresTransitionRepository({identity:auth.identity,requestPool:request});
const authority=createScopedServiceAuthority(createTransitionServiceAuthority({mode:'rehearsal',identity:auth.identity,repository:transitions}),'rehearsal');
const requestAuthority=createScopedPostgresRequestAuthority({pool:request,boundary:auth.identity,authority});
const pending=new Map<string,{resolve:(bytes:Buffer)=>void;reject:(cause:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
const rpcProvider:ObjectStorageProvider={read(ref){counters.storageReads++;const requestId=randomUUID();return new Promise<Buffer>((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('G_RESTORE_BODY_TIMEOUT'));},15000);pending.set(requestId,{resolve,reject,timer});send({type:'object-read',requestId,ref});});},async upload(){throw new Error('G_READONLY_STORAGE_WRITE');},async copy(){throw new Error('G_READONLY_STORAGE_WRITE');},async remove(){throw new Error('G_READONLY_STORAGE_WRITE');}};
const physical=initial.controlledProvider?rpcProvider:createSupabaseObjectProvider({apiUrl:process.env.PR07G_TEST_RESTORE_STORAGE_API_URL!,serviceCredential:process.env.PR07G_TEST_RESTORE_STORAGE_SERVICE_KEY!,bucket:process.env.PR07G_TEST_RESTORE_BUCKET!,keyPrefix:process.env.PR07G_TEST_RESTORE_KEY_PREFIX!,allowLoopbackHttp:true});
const provider=createRestoredObjectProvider({destination:physical,locations:initial.locations});
const logical=initial.locations[0].logicalRef;
const objectRepository=createReadOnlyScopedPostgresObjectRepository({authority:requestAuthority,boundary:auth.identity,bucket:logical.bucket,keyPrefix:logical.key.split('/')[0],serviceAuthority:authority});
const objects=createPrivateObjectService({repository:objectRepository,provider});
const shadow=createScopedPostgresShadowReader({authority:requestAuthority,boundary:auth.identity,serviceAuthority:authority});
const sessions=createScopedPostgresSessionCommandRepository({authority,boundary:auth.identity,requestPool:request});
const repository=createScopedPostgresEvaluationWriter({authority,boundary:auth.identity,requestPool:request});
Object.assign(interviewConfig,{target:initial.fixture.configuration.target,files:initial.fixture.configuration.files});
async function contextFor(who:string){return auth.identity.selectScope(await auth.identity.authenticate('Bearer '+initial.tokens[who]),{applicationTargetId:'shadow-app-'+(who.startsWith('b')?'b':'a')})as AuthenticatedRequestContext;}
async function reader(context:AuthenticatedRequestContext){const runId=initial.runIds[context.account.ownerId];if(!runId)throw new Error('G_RESTORED_SCOPE_REQUIRED');return createScopedShadowReadRepositories({authority,context,runId,repository:shadow,objects});}
const evaluation=composeScopedEvaluation({authority,identity:auth.identity,repository,sessions,async loadPinnedBank(context){const read=await reader(context),root=path.resolve('artifacts/pr07g/forbidden-local-candidate-data');const value=await loadInterviewContextAt(root,{...read.readOptions(),writeManifest:false});const bank=await loadQuestionBank(value,{...read.bankOptions(),root,plan:initial.fixture.plan,environment:initial.fixture.environment});if(!bank)throw new Error('G_RESTORED_BANK_UNAVAILABLE');return bank;},async assertTrustCurrent(context){await auth.identity.revalidate(context);}});
const resources:ServiceRequestResources=bindScopedComponent(authority,{kind:'operational',async sessionBinding(context,id){const value=await sessions.read(context,id);return value?.created?value.binding:null;},async readStatus(){return {mode:'read-only-recovery',modelEnabled:false};},async readSession(context,binding){const value=await sessions.read(context,binding.sessionId);return value?decodeAuthenticatedSessionEnvelope({version:AUTHENTICATED_SESSION_ENVELOPE_VERSION,sessionJson:value.sessionJson,sessionSha256:value.sessionSha256,contextJson:value.contextJson,contextSha256:value.contextSnapshotSha256},binding.ownerId).session:null;},audioBinding:(context,id)=>requestAuthority.discoverAudio(context,id),readAudio:(context,binding)=>objects.readAudio(context,binding.resourceId)});
const denied=async()=>{counters.freshWriteRejections++;throw new TransitionError(409,'TRANSITION_READ_ONLY_RECOVERY');};
async function receiptValue(context:AuthenticatedRequestContext,sessionId:string,action:string,raw:unknown){const wrapped=decodeScopedServiceCommand(raw),input=authenticatedSessionCommandSchema.parse(wrapped.command);
 const state=await transitions.read(context);if(!state||state.generation!==wrapped.expectedTransitionGeneration)throw new TransitionError(409,'TRANSITION_GENERATION_CHANGED');
 const value=await sessions.receiptByKey(context,{sessionId,key:input.key,inputSha256:sessionCommandInputSha256(action,input.payload)});if(!value)return denied();
 return {version:'authenticated-session-command-v1',operationId:value.operationId,revision:value.committedRevision,writerGeneration:value.writerGeneration,key:value.key,inputSha256:value.inputSha256,replay:true,result:JSON.parse(value.resultJson)};}
const mutations=bindScopedComponent(authority,{kind:'scoped-db-session-writer'as const,async create(context,raw){const input=authenticatedSessionCommandSchema.parse(decodeScopedServiceCommand(raw).command),snapshot=await sessions.findCreation(context,input.key,sessionCommandInputSha256('create',input.payload));if(!snapshot)return denied();return receiptValue(context,snapshot.binding.sessionId,'create',raw);},async command(context,binding,action,raw){return receiptValue(context,binding.sessionId,action,raw);},connect:denied,assertSocketCurrent:denied,socket:denied,audio:denied,disconnect:denied,
 async read(context,binding){return sessions.read(context,binding.sessionId);},async context(context,binding){const value=await sessions.read(context,binding.sessionId);if(!value)throw new Error('G_SESSION_NOT_FOUND');return {contextJson:value.contextJson,contextSha256:value.contextSnapshotSha256,pinsJson:value.pinsJson,pinsSha256:value.pinsSha256};},
 async receipt(context,binding,query){const value=await sessions.receiptByKey(context,{sessionId:binding.sessionId,...query});if(!value)throw new Error('G_RECEIPT_NOT_FOUND');return value;},
} satisfies Omit<ServiceSessionMutations,'kind'>&{kind:'scoped-db-session-writer'});
const transport=createScopedServiceRealtimeServer({authority,identity:auth.identity,resources,sessionMutations:mutations,evaluationMutations:evaluation.mutations});
await new Promise<void>(resolve=>transport.server.listen(0,'127.0.0.1',resolve));const address=transport.server.address();if(!address||typeof address==='string')throw new Error('G_READONLY_LISTEN_FAILED');
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
function state(){return {pid:process.pid,counters:{...counters},privilegedCredentialsInherited:false,mappingPoolPresent:false,adminPoolPresent:false,workerPoolPresent:false,originalStorageCredentialsInherited:false,modelEnabled:false,request:{total:request.totalCount,idle:request.idleCount,waiting:request.waitingCount}};}
process.on('message',(message:{type:string;requestId:string;operation:string;payload?:Record<string,unknown>;bytes?:string;error?:string})=>{
 if(message?.type==='object-result'){const value=pending.get(message.requestId);if(value){pending.delete(message.requestId);clearTimeout(value.timer);if(message.error)value.reject(new Error('G_RESTORE_BODY_MISSING'));else value.resolve(Buffer.from(message.bytes??'','base64'));}return;}
 if(message?.type!=='control')return;void(async()=>{const p=message.payload??{};let result:unknown;
 if(message.operation==='state')result=state();
 else if(message.operation==='probe-source-endpoints'){try{await fetch(new URL('/storage/v1/bucket',sourceStorage));}catch{}try{await new Promise<void>((resolve,reject)=>{const socket=net.connect(initial.originalEndpoints.database.port,initial.originalEndpoints.database.hostname);socket.once('connect',()=>{socket.destroy();resolve();});socket.once('error',reject);});}catch{}result=state();}
 else if(message.operation==='select-input'){
  const context=await contextFor(String(p.who)),read=await reader(context),selection=String(p.selection),scope=read.readOptions().scope;
  const checked:{artifactId:string;originalSha256:string;restoredSha256:string}[]=[];
  const remember=(file:LocatedStoredFile)=>{
    if(!file.locator)throw new Error('G_RESTORED_LOCAL_LOCATOR_DENIED');
    const artifact=read.snapshot.artifacts.find(row=>row.artifactId===file.locator!.artifactId);
    if(!artifact||artifact.objectId!==file.locator.objectId||hash(file.bytes)!==artifact.rawSha256||file.sha256!==artifact.rawSha256)throw new Error('G_RESTORED_DOMAIN_INPUT_CHANGED');
    checked.push({artifactId:artifact.artifactId,originalSha256:artifact.rawSha256,restoredSha256:hash(file.bytes)});
  };
  if(selection==='current'){
    const record=await read.repositories.source.readCurrentRecord({scope,purpose:'runtime-context'});
    if(!record)throw new Error('G_RESTORED_CURRENT_RECORD_MISSING');remember(record.pointer);remember(record.document);
    const pointer=await read.repositories.analysis.readCurrentPointer({scope,purpose:'runtime-context'});
    if(!pointer)throw new Error('G_RESTORED_CURRENT_ANALYSIS_MISSING');remember(pointer);
    remember(await read.repositories.analysis.readAnalysis({scope,purpose:'runtime-context',selection:'current',reference:pointer.value.path}));
  }else if(selection==='pinned'){
    const bank=await read.bankReader.readReady({purpose:'pinned',scope:{...scope,bankKey:initial.fixture.bankKey,bankContentSha256:null,sourceFingerprint:null}});
    if(!bank)throw new Error('G_RESTORED_PINNED_BANK_MISSING');
    const artifact=await shadow.resolve(context,read.snapshot.runId,{role:'bank-ready',reference:'data/prepared/question-banks/'+initial.fixture.bankKey+'.json',selection:'pinned'});
    if(!artifact?.objectId)throw new Error('G_RESTORED_PINNED_BINDING_MISSING');
    const bytes=await objects.read(context,{objectId:artifact.objectId,scope:artifact.scope.kind});
    if(hash(bytes)!==artifact.rawSha256)throw new Error('G_RESTORED_PINNED_BYTES_CHANGED');
    checked.push({artifactId:artifact.artifactId,originalSha256:artifact.rawSha256,restoredSha256:hash(bytes)});
  }else if(selection==='historical'){
    const historical=read.snapshot.artifacts.filter(row=>row.role==='analysis-document'&&row.availability==='present'&&row.status==='bound'&&
      (row.selection==='historical'||row.aliases?.some(alias=>alias.role==='analysis-document'&&alias.selection==='historical')));
    for(const artifact of historical)remember(await read.repositories.analysis.readAnalysis({scope,purpose:'historical-revision',selection:'revision',reference:artifact.reference}));
  }else throw new Error('G_RESTORED_SELECTION_INVALID');
  if(!checked.length)throw new Error('G_RESTORED_SELECTION_EMPTY');await read.assertSnapshotUnchanged();result={selection,artifacts:checked};
 }
 else if(message.operation==='snapshot')result=await sessions.read(await contextFor(String(p.who)),String(p.sessionId));
 else if(message.operation==='replay-E')result=await sessions.receiptByKey(await contextFor(String(p.who)),{sessionId:String(p.sessionId),key:String(p.key),inputSha256:String(p.inputSha256)});
 else if(message.operation==='replay-F')result=await repository.receipt(await contextFor(String(p.who)),{key:String(p.key),inputSha256:String(p.inputSha256)});
 else if(message.operation==='result')result=await repository.projection(await contextFor(String(p.who)),String(p.sessionId));
 else if(message.operation==='probe-disabled'){await denied().catch(()=>{});result=state();}
 else if(message.operation==='stop'){await transport.close();await request.end();send({type:'control-result',requestId:message.requestId,result:{stopped:true}});process.disconnect?.();return;}
 else throw new Error('G_READONLY_CONTROL_INVALID');send({type:'control-result',requestId:message.requestId,result});
 })().catch(error=>send({type:'control-result',requestId:message.requestId,error:{code:typeof error?.code==='string'?error.code:/^[A-Z0-9_]+$/u.test(error?.message??'')?error.message:'G_READONLY_CONTROL_FAILED'}}));
});
send({type:'ready',name:initial.name,port:address.port,...state(),roles:{request:(await request.query('SELECT current_user role')).rows[0].role}});
