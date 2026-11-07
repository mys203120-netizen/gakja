import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { createHash,randomUUID } from 'node:crypto';
import { createServiceRealtimeServer } from '../../server/request-realtime-server';
import { createIsolatedSessionService } from '../../server/session-writer/isolated-session-service';
import { createPostgresSessionCommandRepository,createSessionEnrollmentCapability } from '../../server/db/postgres-session-writer';
import type { AuthenticatedRequestContext } from '../../server/auth/request-identity';
import type { ObjectStorageProvider } from '../../server/storage/private-object-ports';
import { createSupabaseObjectProvider } from '../../server/storage/supabase-object-provider';
import type { SessionPreservationBundle,SessionCommandSnapshot,SessionWriterClaim } from '../../server/session-writer/session-command-ports';
import { createShadowReadRepositories } from '../../server/repositories/shadow-read-repositories';
import { loadQuestionBankByPinnedPlan } from '../../server/data/prepared-question-bank';
import { withPrivateObjectAudio } from '../../server/storage/service-object-audio';
import { createSessionTestAuthority,createEObjects,readVerifiedDPreparation,type PublicDSessionFixture,type createSessionTestSigningAuthority } from './d-preparation';
import { createSyntheticSessionProviders,type SyntheticSessionProviderConfiguration } from './synthetic-providers';
import { testPools,closePools } from './session-writer-test-database';

if(process.env.PR07E_TEST_DISPOSABLE!=='1'||!process.env.PR07E_TEST_RUN_ID||!process.send)throw new Error('PR07E_OWNED_CHILD_PROCESS_REQUIRED');
const send=(value:unknown)=>process.send?.(value);
interface Init {type:'initialize';requestId:string;name:string;database:'primary'|'restore';fixtureRoot:string;fixture:PublicDSessionFixture;
  jwk:Awaited<ReturnType<typeof createSessionTestSigningAuthority>>['jwk'];tokens:Record<'a'|'b',string>;runIds:Record<string,string>;controlledProvider:boolean}
interface Control {type:'control';requestId:string;operation:string;payload?:Record<string,unknown>}
const initial=await new Promise<Init>(resolve=>{const receive=(message:Init)=>{if(message?.type==='initialize'){process.off('message',receive);resolve(message);}};process.on('message',receive);send({type:'boot',pid:process.pid});});
if(initial.controlledProvider&&process.env.GITHUB_ACTIONS==='true')throw new Error('PR07E_CI_REQUIRES_OFFICIAL_STORAGE');
const counters={localDataReadAttempts:0,localSessionWriteAttempts:0,externalNetworkAttempts:0,storageReads:0,providerRpcReads:0};
const deniedRoots=[path.resolve(initial.fixtureRoot),path.resolve('artifacts/pr07e/forbidden-local-candidate-data')];
const inRoot=(file:string,root:string)=>{const rel=path.relative(root,path.resolve(file));return rel===''||!rel.startsWith('..')&&!path.isAbsolute(rel);};
const fileName=(file:unknown)=>file instanceof URL?file.protocol==='file:'?decodeURIComponent(file.pathname).replace(/^\/([A-Za-z]:)/u,'$1'):null:typeof file==='string'?file:null;
const denyRead=(file:unknown)=>{const value=fileName(file);if(value&&deniedRoots.some(root=>inRoot(value,root))){counters.localDataReadAttempts++;throw new Error('PR07E_FORBIDDEN_LOCAL_DATA_READ');}};
const denyWrite=(file:unknown)=>{const value=fileName(file);if(value&&(inRoot(value,process.cwd())||deniedRoots.some(root=>inRoot(value,root)))){counters.localSessionWriteAttempts++;throw new Error('PR07E_FORBIDDEN_LOCAL_SESSION_WRITE');}};
const nativeRead=fs.promises.readFile.bind(fs.promises);fs.promises.readFile=(async(...args:Parameters<typeof nativeRead>)=>{denyRead(args[0]);return nativeRead(...args);}) as typeof fs.promises.readFile;
const nativeReadSync=fs.readFileSync.bind(fs);fs.readFileSync=((...args:Parameters<typeof nativeReadSync>)=>{denyRead(args[0]);return nativeReadSync(...args);}) as typeof fs.readFileSync;
for(const name of ['writeFile','appendFile','mkdir','rm','rmdir','unlink','truncate'] as const){
  const native=fs.promises[name].bind(fs.promises) as (...args:unknown[])=>Promise<unknown>;
  Object.assign(fs.promises,{[name]:async(file:unknown,...args:unknown[])=>{denyWrite(file);return native(file,...args);}});
}
const nativeRename=fs.promises.rename.bind(fs.promises);fs.promises.rename=async(from,to)=>{denyWrite(from);denyWrite(to);return nativeRename(from,to);};
syncBuiltinESMExports();
const nativeFetch=globalThis.fetch;
globalThis.fetch=(input,options)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)){counters.externalNetworkAttempts++;throw new Error('PR07E_PAID_OR_EXTERNAL_PROVIDER_FORBIDDEN');}
  return nativeFetch(input,options);
};
const nativeConnect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(this:net.Socket,...args:Parameters<typeof nativeConnect>){
  const value=args[0] as unknown,option=Array.isArray(value)?value[0]:value;
  const host=option&&typeof option==='object'&&'host' in option?String(option.host):typeof args[1]==='string'?args[1]:'localhost';
  if(!(option&&typeof option==='object'&&'path' in option)&&!['127.0.0.1','localhost','::1','[::1]'].includes(host)){counters.externalNetworkAttempts++;throw new Error('PR07E_PAID_OR_EXTERNAL_PROVIDER_FORBIDDEN');}
  return Reflect.apply(nativeConnect,this,args);
} as typeof nativeConnect;
let offsetMs=0;const now=()=>Date.now()+offsetMs,pools=testPools(1,initial.database,'server'),auth=createSessionTestAuthority(pools,initial.jwk,now);
const pendingObject=new Map<string,{resolve:(value:Buffer)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
const controlled:ObjectStorageProvider|undefined=initial.controlledProvider?{
  read(ref){counters.providerRpcReads++;const requestId=randomUUID();return new Promise<Buffer>((resolve,reject)=>{
    const timer=setTimeout(()=>{pendingObject.delete(requestId);reject(new Error('PR07E_CONTROLLED_BODY_TIMEOUT'));},15_000);pendingObject.set(requestId,{resolve,reject,timer});send({type:'object-read',requestId,ref});
  });},async upload(){throw new Error('PR07E_CHILD_READ_ONLY_PROVIDER');},async copy(){throw new Error('PR07E_CHILD_READ_ONLY_PROVIDER');},async remove(){throw new Error('PR07E_CHILD_READ_ONLY_PROVIDER');},
}:undefined;
const actualProvider=controlled??createSupabaseObjectProvider({apiUrl:process.env.PR07E_TEST_STORAGE_API_URL!,serviceCredential:process.env.PR07E_TEST_STORAGE_SERVICE_KEY!,bucket:process.env.PR07E_TEST_BUCKET!,keyPrefix:process.env.PR07E_TEST_KEY_PREFIX!,allowLoopbackHttp:true});
const readOnlyProvider:ObjectStorageProvider={read(ref,options){counters.storageReads++;return actualProvider.read(ref,options);},async upload(){throw new Error('PR07E_CHILD_READ_ONLY_PROVIDER');},async copy(){throw new Error('PR07E_CHILD_READ_ONLY_PROVIDER');},async remove(){throw new Error('PR07E_CHILD_READ_ONLY_PROVIDER');}};
const storage=createEObjects(pools,auth,readOnlyProvider),repository=createPostgresSessionCommandRepository({boundary:auth.identity,requestPool:pools.request,mappingPool:pools.mapping,environment:'isolated-session-writer',now});
type Hook={phase:string;key?:string;action?:string;sessionId?:string;mode:'hold'|'fail';once:boolean;timeoutMs?:number};let hooks:Hook[]=[];
const holds=new Map<string,{resolve:()=>void;timer:ReturnType<typeof setTimeout>}>();
async function stage(phase:string,detail:Record<string,unknown>){
  const fields=new Set(['action','sessionId','key','operationId','turnId','answerId','captureRevision','streamId','writerGeneration','bytes']);
  send({type:'phase',phase,utc:new Date().toISOString(),monotonicMs:performance.now(),detail:Object.fromEntries(Object.entries(detail).filter(([key])=>fields.has(key)))});
  const index=hooks.findIndex(h=>h.phase===phase&&(h.key===undefined||h.key===detail.key)&&(h.action===undefined||h.action===detail.action)&&(h.sessionId===undefined||h.sessionId===detail.sessionId));
  if(index<0)return;const hook=hooks[index];if(hook.once)hooks.splice(index,1);
  if(hook.mode==='fail'){send({type:'injected-failure',phase,detail});throw new Error('PR07E_CONTROLLED_BEFORE_COMMIT_FAILURE');}
  const timeout=hook.timeoutMs??30_000;if(!Number.isInteger(timeout)||timeout<1||timeout>110_000)throw new Error('PR07E_CONTROLLED_BARRIER_LIMIT');
  const barrierId=randomUUID();await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{holds.delete(barrierId);reject(new Error('PR07E_CONTROLLED_BARRIER_TIMEOUT'));},timeout);holds.set(barrierId,{resolve,timer});send({type:'barrier',barrierId,phase,detail});});
}
const contexts=new Map<string,AuthenticatedRequestContext>();
const synthetic=createSyntheticSessionProviders({stage,async readPinnedAudio(scope,id){const context=contexts.get(scope.ownerId);if(!context)throw new Error('PR07E_SYNTHETIC_SCOPE_MISSING');return storage.objects.readAudio(context,id);}});
async function contextFor(who:'a'|'b'){return auth.identity.selectScope(await auth.identity.authenticate('Bearer '+initial.tokens[who]),{applicationTargetId:'shadow-app-'+who}) as AuthenticatedRequestContext;}
async function pinned(context:AuthenticatedRequestContext,snapshot:SessionCommandSnapshot){
  const pins=JSON.parse(snapshot.pinsJson) as {D:{runId:string;generation:string;planSha256:string}};
  if(!pins.D||initial.runIds[context.account.ownerId]!==pins.D.runId||!await storage.shadow.unchanged(context,pins.D.runId,pins.D.generation))throw new Error('PR07E_D_PIN_CHANGED');
  const current=await storage.shadow.capture(context,pins.D.runId);if(!current||current.planSha256!==pins.D.planSha256)throw new Error('PR07E_D_PIN_CHANGED');
  contexts.set(context.account.ownerId,context);
}
const service=createIsolatedSessionService({environment:'isolated-session-writer',identity:auth.identity,repository,now,
  async prepare(context){
    const runId=initial.runIds[context.account.ownerId];if(!runId)throw new Error('PR07E_D_OWNER_NOT_SELECTED');
    const prepared=await readVerifiedDPreparation(auth,storage,context,initial.fixture,runId);contexts.set(context.account.ownerId,context);
    const snapshot=prepared.read.snapshot;
    return {context:prepared.context,bank:prepared.bank,sourceRevision:initial.fixture.source.revision,
      pins:{D:{runId,generation:snapshot.generation,planSha256:snapshot.planSha256},sourceRevision:initial.fixture.source.revision,profileRevision:initial.fixture.profileRevision,
        policySha256:prepared.context.interviewerPolicy?.contentSha256??null,analysisVersion:snapshot.artifacts.find(a=>a.artifactId==='analysis-v2')?.versionId??null},
      assertCurrent:async()=>{await prepared.read.assertSnapshotUnchanged();await auth.identity.revalidate(context);}};
  },
  async readPinnedBank(context,snapshot,session,fixedContext){
    await pinned(context,snapshot);const pins=JSON.parse(snapshot.pinsJson) as {D:{runId:string}};
    const read=await createShadowReadRepositories({context,runId:pins.D.runId,repository:storage.shadow,objects:storage.objects,environment:'isolated-shadow'});
    const bank=await loadQuestionBankByPinnedPlan(fixedContext,session.plan!,{...read.bankOptions(),root:path.resolve('artifacts/pr07e/forbidden-local-candidate-data')});
    await read.assertSnapshotUnchanged();if(!bank)throw new Error('PR07E_PINNED_BANK_UNAVAILABLE');return bank;
  },assertPinned:pinned,
  mintEnrollment(context,input){return createSessionEnrollmentCapability({ownerId:context.account.ownerId,studentId:context.scope!.studentId,applicationTargetId:context.scope!.applicationTargetId,supportTargetId:context.scope!.supportTargetId,
    sessionId:input.sessionId,creationKey:input.creationKey,inputSha256:input.inputSha256,expiresAt:Math.min(context.principal.expiresAt,now()+900_000),async checkCurrent(){try{await auth.identity.revalidate(context);return true;}catch{return false;}}});},
  providers:synthetic.providers,models:{question:'synthetic-question-v1',realtime:'synthetic-core-v1',review:'synthetic-review-v1',evaluation:'synthetic-evaluation-pinned-v1'},observe:stage});
const actualAudio=withPrivateObjectAudio({...service.resources,audioBinding:(context,id)=>auth.authority.discoverAudio(context,id)},storage.objects,auth.identity);
const resources={...actualAudio,async audioBinding(context:AuthenticatedRequestContext,id:string){return synthetic.audioBinding(context,id)??actualAudio.audioBinding(context,id);},
  async readAudio(context:AuthenticatedRequestContext,binding:Parameters<typeof actualAudio.readAudio>[1]){return synthetic.readAudio(context,binding)??actualAudio.readAudio(context,binding);}};
const transport=createServiceRealtimeServer({identity:auth.identity,resources,sessionMutations:service.mutations,environment:'test',now,accessCheckIntervalMs:500});
await new Promise<void>(resolve=>transport.server.listen(0,'127.0.0.1',resolve));
const address=transport.server.address();if(!address||typeof address==='string')throw new Error('PR07E_CHILD_LISTEN_FAILED');
const requestBackend=(await pools.request.query('SELECT pg_backend_pid() pid,current_user role')).rows[0],mappingBackend=(await pools.mapping.query('SELECT pg_backend_pid() pid,current_user role')).rows[0];
const backendPids={request:requestBackend.pid,mapping:mappingBackend.pid},backendRoles={request:requestBackend.role,mapping:mappingBackend.role};
async function shutdown(){for(const hold of holds.values()){clearTimeout(hold.timer);hold.resolve();}holds.clear();await service.close();await transport.close();await closePools(pools);}
process.on('message',(message:Control|{type:'object-result';requestId:string;bytes?:string;error?:string})=>{
  if(message?.type==='object-result'){const pending=pendingObject.get(message.requestId);if(pending){clearTimeout(pending.timer);pendingObject.delete(message.requestId);if(message.error)pending.reject(new Error('PR07E_CONTROLLED_BODY_MISSING'));else pending.resolve(Buffer.from(message.bytes!,'base64'));}return;}
  if(message?.type!=='control')return;
  void (async()=>{
    const p=message.payload??{};let result:unknown;
    if(message.operation==='configure'){hooks=(p.hooks??[]) as Hook[];synthetic.configure((p.provider??{}) as Partial<SyntheticSessionProviderConfiguration>);if(typeof p.clockOffsetMs==='number')offsetMs=p.clockOffsetMs;result={configured:true};}
    else if(message.operation==='release'){const hold=holds.get(String(p.barrierId));if(!hold)throw new Error('PR07E_BARRIER_NOT_FOUND');clearTimeout(hold.timer);holds.delete(String(p.barrierId));hold.resolve();result={released:true};}
    else if(message.operation==='state')result={pid:process.pid,name:initial.name,database:initial.database,backendPids,counters:{...counters},providers:synthetic.diagnostics(),service:service.diagnostics(),holds:[...holds.keys()],pool:{request:{total:pools.request.totalCount,idle:pools.request.idleCount,waiting:pools.request.waitingCount},mapping:{total:pools.mapping.totalCount,idle:pools.mapping.idleCount,waiting:pools.mapping.waitingCount}}};
    else if(message.operation==='probe-database')result=(await pools.request.query('SELECT pg_backend_pid() pid,current_user role')).rows[0];
    else if(['snapshot','freeze','claim','rollback','export'].includes(message.operation)){
      const context=await contextFor(p.who as 'a'|'b'),id=String(p.sessionId);
      if(message.operation==='snapshot')result=await repository.read(context,id);
      else if(message.operation==='export')result=await repository.exportPreservation(context,id);
      else {const condition=p.condition as SessionWriterClaim;if(!condition||condition.sessionId!==id)throw new Error('PR07E_OPERATOR_CONDITION_REQUIRED');
        result=message.operation==='freeze'?await repository.freeze(context,condition):message.operation==='claim'?await repository.claimWriter(context,condition):await repository.rollbackUncommitted(context,condition);}
    }else if(message.operation==='restore'){
      const context=await contextFor(p.who as 'a'|'b'),bundle=p.bundle as SessionPreservationBundle,body=JSON.parse(bundle.payloadJson).session;
      const cap=createSessionEnrollmentCapability({ownerId:context.account.ownerId,studentId:context.scope!.studentId,applicationTargetId:context.scope!.applicationTargetId,supportTargetId:context.scope!.supportTargetId,
        sessionId:body.session_id,creationKey:body.creation_key,inputSha256:body.creation_input_sha256,expiresAt:Math.min(context.principal.expiresAt,now()+900_000),async checkCurrent(){try{await auth.identity.revalidate(context);return true;}catch{return false;}}});
      result=await repository.restorePreservation(context,bundle,cap);
    }else if(message.operation==='stop'){await shutdown();send({type:'control-result',requestId:message.requestId,result:{stopped:true}});process.disconnect?.();return;}
    else throw new Error('PR07E_CONTROL_OPERATION_INVALID');
    send({type:'control-result',requestId:message.requestId,result});
  })().catch(error=>send({type:'control-result',requestId:message.requestId,error:{code:typeof error?.code==='string'?error.code:/^[A-Z0-9_]+$/u.test(error?.message??'')?error.message:'PR07E_CONTROL_FAILED'}}));
});
process.once('SIGTERM',()=>{void shutdown().finally(()=>process.exit());});
send({type:'ready',name:initial.name,pid:process.pid,port:address.port,backendPids,backendRoles,privilegedTestCredentialsInherited:false,database:initial.database,storageEngine:initial.controlledProvider?'controlled-body-diagnostic':'official-Supabase-Storage-REST',sourceFileSha256:createHash('sha256').update(await nativeRead(new URL(import.meta.url))).digest('hex')});
