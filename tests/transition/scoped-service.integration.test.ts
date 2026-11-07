/** New G service integration: raw provider fixtures run through native cores. */
import { exportJWK,generateKeyPair,SignJWT } from 'jose';
import { supplySigner,supplyRecordBundle,supplyReviewer } from '../fixtures/evaluation-supply';
import { sealBankScopeRegistry,type BankEvaluationScopeRegistry } from '../../server/data/evaluation-scope-registry';
import { snapshotHash } from '../../server/session-runtime';
import type { EvaluationProjection } from '../../server/evaluation-writer/evaluation-writer-ports';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn,type ChildProcess } from 'node:child_process';
import { writeFile,mkdir,mkdtemp,lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash,randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createSupabaseObjectProvider,ObjectProviderError } from '../../server/storage/supabase-object-provider';
import type { ObjectStorageProvider,StorageObjectRef } from '../../server/storage/private-object-ports';
import type { RecordedTurn,InterviewSession } from '../../server/protocol';
import type { SessionCommandSnapshot } from '../../server/session-writer/session-command-ports';
import { testPools,closePools } from './transition-test-database';
import { createControlledObjectProvider } from '../evaluation-writer/controlled-object-provider';
import { loadOwnedPublicDFixture,seedPublicDOuterScope,importPublicDContexts,createSessionTestAuthority,eAudience } from '../session-writer/d-preparation';
import { createPostgresTransitionRepository,createTransitionOperatorCapability,createTransitionInstallerCapability,createTransitionCommand } from '../../server/transition/postgres-transition';
import type { AuthenticatedRequestContext } from '../../server/auth/request-identity';
import type { TransitionOperatorAction,TransitionRepository,TransitionOperatorCapability } from '../../server/transition/transition-ports';
import { createLocalTransitionCoordinator } from '../../server/transition/local-transition-coordinator';
import { runIntegratedRecoveryCases } from './recovery-cases';
const generations:Record<string,string>={};
const scoped=(who:string,command:unknown)=>({version:'scoped-service-command-v1',expectedTransitionGeneration:generations[who.startsWith('b')?'b':'a'],command});
const phaseTrace:Record<string,unknown>[]=[];
const tracePhase=(event:string,detail:Record<string,unknown>={})=>{phaseTrace.push({utc:new Date().toISOString(),monotonicMs:performance.now(),event,...detail});if(['wait-start','wait-resolved','http-start','http-result','rpc-start','rpc-result'].includes(event))process.stderr.write('# G phase '+event+' '+JSON.stringify(detail)+'\n');};
const diagnostic=process.env.PR07G_TEST_CONTROLLED_PROVIDER_DIAGNOSTIC==='1';
if(diagnostic&&process.env.GITHUB_ACTIONS==='true')throw new Error('PR07G_CI_REQUIRES_OFFICIAL_STORAGE');
const data=await loadOwnedPublicDFixture(),pools=testPools(1),restorePools=testPools(1,'restore');
const jwtKeys=await generateKeyPair('ES256'),jwk={...await exportJWK(jwtKeys.publicKey),kid:'pr07g-owned-jwt',alg:'ES256'};
const signing={jwk,async token(who:'a'|'b',subject='shared'){return new SignJWT().setProtectedHeader({alg:'ES256',kid:jwk.kid}).setIssuer(`https://issuer-${who}.example`).setSubject(subject).setAudience(eAudience).setIssuedAt().setExpirationTime('2h').sign(jwtKeys.privateKey);}};
const tokens:Record<string,string>={};
for(const who of ['a','b'] as const){tokens[who]=await signing.token(who);for(const role of ['reviewer','specreviewer','operator','worker1','worker2'])tokens[who+role]=await signing.token(who,'f-'+who+'-'+role);}
const api=process.env.PR07G_TEST_STORAGE_API_URL,credential=process.env.PR07G_TEST_STORAGE_SERVICE_KEY,bucket=process.env.PR07G_TEST_BUCKET,prefix=process.env.PR07G_TEST_KEY_PREFIX;
if(!api||!credential||!bucket||!prefix)throw new Error('PR07G_EXPLICIT_STORAGE_REQUIRED');
const providerIo={read:0,upload:0,copy:0,remove:0};
const actual:ObjectStorageProvider=diagnostic?createControlledObjectProvider():
  createSupabaseObjectProvider({apiUrl:api,serviceCredential:credential,bucket,keyPrefix:prefix,allowLoopbackHttp:true});
const provider:ObjectStorageProvider={read(ref,options){providerIo.read++;return actual.read(ref,options);},upload(ref,body,options){providerIo.upload++;return actual.upload(ref,body,options);},copy(from,to,options){providerIo.copy++;return actual.copy(from,to,options);},remove(ref,options){providerIo.remove++;return actual.remove(ref,options);}};
const rows:Record<string,unknown>[]=[],children:ServerChild[]=[],snapshots:Record<string,unknown>[]=[];
const liveSockets=new Set<WebSocket>();
let imported!:Awaited<ReturnType<typeof importPublicDContexts>>,one!:ServerChild,two!:ServerChild,worker1!:ServerChild,worker2!:ServerChild;
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
interface Reply<R=Record<string,unknown>>{version:string;operationId:string;revision:string;writerGeneration:string;key:string;inputSha256:string;replay:boolean;result:R}
interface View {sessionId:string;revision:string;writerGeneration:string;status:string;evaluationStatus:string;writer:string;contextSnapshotSha256:string;recovery:{epoch:number;phase:string;currentTurn:RecordedTurn|null;transcript:string;transcriptStatus:string|null;captureRevision:number};evaluationHandoff:{state:string;intentId:string;payloadSha256:string}|null;evaluationJob:null}
interface Barrier {type:'barrier';barrierId:string;phase:string;detail:{action?:string;sessionId?:string;key?:string;operationId?:string}}
type Message=Record<string,unknown>;
class ServerChild {
  process:ChildProcess;port=0;pid=0;name:string;database:'primary'|'restore';ready:Message={};logs='';messages:Message[]=[];
  lastPhase:Message|null=null;lastIpc:Array<{type:unknown;phase?:unknown;utc:string}>=[];
  pending=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  constructor(name:string,database:'primary'|'restore'='primary',readonly kind:'service'|'worker'|'readonly'='service',readonly extras:Record<string,unknown>={}){
    this.name=name;this.database=database;
    const env:NodeJS.ProcessEnv={...process.env,NODE_ENV:'test',INTERVIEW_EXECUTION_MODE:'service',NODE_OPTIONS:''};
    for(const key of Object.keys(env)){
      if(!key.startsWith('PR07G_TEST_')&&/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DATABASE_URL|POSTGRES_URL|SUPABASE_URL|STORAGE_URL/u.test(key))delete env[key];
      if(/^PR07[BCDEF]_TEST_/u.test(key)&&/URL|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/u.test(key))delete env[key];
      if(/^PR07G_TEST_(?:RESTORE_)?(?:(?:ADMIN|BYPASS)_URL|BOOTSTRAP_URL)$/u.test(key))delete env[key];
      if((kind==='worker'||kind==='readonly')&&/^PR07G_TEST_(?:RESTORE_)?MAPPING_URL$/u.test(key))delete env[key];
      if(kind==='worker'&&/^PR07G_TEST_(?:RESTORE_)?STORAGE_(?:SERVICE|ANON)_KEY$/u.test(key))delete env[key];
      if(kind==='readonly'&&/^PR07G_TEST_STORAGE_(?:SERVICE|ANON)_KEY$/u.test(key))delete env[key];
      if(kind!=='worker'&&/^PR07G_TEST_(?:RESTORE_)?WORKER_URL$/u.test(key))delete env[key];
      if(/^PR07G_TEST_(?:RESTORE_)?(?:REQUEST|MAPPING|WORKER)_URL$/u.test(key)&&key.includes('_RESTORE_')!==(database==='restore'))delete env[key];
      if(kind==='readonly'&&/^PR07G_TEST_(?:STORAGE_API_URL|BUCKET|KEY_PREFIX)$/u.test(key))delete env[key];
    }
    // Reused E D-preparation needs only explicit owned fixture/storage aliases.
    if(kind==='service')for(const suffix of ['DISPOSABLE','RUN_ID','FIXTURE_ROOT','BASELINE_RESULT','BASELINE_CODE_ROOT','STORAGE_API_URL','STORAGE_SERVICE_KEY','STORAGE_ANON_KEY','BUCKET','KEY_PREFIX'])if(env['PR07G_TEST_'+suffix]!==undefined)env['PR07E_TEST_'+suffix]=env['PR07G_TEST_'+suffix];
    this.process=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL(kind==='worker'?'./scoped-worker-child.ts':kind==='readonly'?'./scoped-readonly-child.ts':'./scoped-service-child.ts',import.meta.url))],{cwd:process.cwd(),env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
    this.process.stdout!.on('data',bytes=>{this.logs+=String(bytes);});this.process.stderr!.on('data',bytes=>{this.logs+=String(bytes);});
    this.process.on('error',error=>{this.logs+='\nowned child error: '+error.message;for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error('PR07G_CHILD_CHANNEL_FAILED'));}this.pending.clear();});
    this.process.on('message',(raw:Message)=>{
      this.lastIpc.push({type:raw.type,phase:raw.phase,utc:new Date().toISOString()});if(this.lastIpc.length>12)this.lastIpc.shift();
      if(raw.type==='phase'){this.lastPhase=raw;tracePhase('child-phase',{server:this.name,childPid:this.process.pid,phase:raw.phase,detail:raw.detail,childUtc:raw.utc,childMonotonicMs:raw.monotonicMs});return;}
      if(raw.type==='object-read'){const target=this.kind==='readonly'?nativeRestore:provider;void target.read(raw.ref as StorageObjectRef,{signal:AbortSignal.timeout(15_000),maxBytes:32*1024*1024}).then(body=>this.process.send?.({type:'object-result',requestId:raw.requestId,bytes:body.toString('base64')}),()=>this.process.send?.({type:'object-result',requestId:raw.requestId,error:'missing'}));return;}
      if(['object-upload','object-copy','object-remove'].includes(String(raw.type))){
        const action=raw.type==='object-upload'?provider.upload(raw.ref as StorageObjectRef,Buffer.from(String(raw.bytes),'base64'),{contentType:String(raw.contentType??'application/octet-stream')}):
          raw.type==='object-copy'?provider.copy(raw.from as StorageObjectRef,raw.to as StorageObjectRef):provider.remove(raw.ref as StorageObjectRef);
        void action.then(()=>this.process.send?.({type:'object-result',requestId:raw.requestId}),()=>this.process.send?.({type:'object-result',requestId:raw.requestId,error:'controlled-object-failed'}));return;
      }
      if(raw.type==='control-result'){
        tracePhase('rpc-result',{server:this.name,childPid:this.process.pid,requestId:raw.requestId,errorCode:(raw.error as {code?:string}|undefined)?.code});
        const pending=this.pending.get(String(raw.requestId));if(pending){clearTimeout(pending.timer);this.pending.delete(String(raw.requestId));if(raw.error)pending.reject(Object.assign(new Error((raw.error as {code:string}).code),{code:(raw.error as {code:string}).code}));else pending.resolve(raw.result);}return;
      }
      this.messages.push(raw);
    });
    this.process.once('exit',()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('PR07G_CHILD_EXITED'));}this.pending.clear();});
    children.push(this);
  }
  async wait(predicate:(value:Message)=>boolean,timeout=30_000,phase='unspecified'):Promise<Message>{
    const started=performance.now();tracePhase('wait-start',{server:this.name,childPid:this.process.pid,phase,timeoutMs:timeout});
    const found=this.messages.findIndex(predicate);if(found>=0){tracePhase('wait-resolved',{server:this.name,childPid:this.process.pid,phase,elapsedMs:performance.now()-started,buffered:true});return this.messages.splice(found,1)[0];}
    return new Promise((resolve,reject)=>{
      const deadline=setTimeout(()=>{const evidence={server:this.name,pid:this.process.pid,phase,timeoutMs:timeout,elapsedMs:performance.now()-started,lastPhase:this.lastPhase,lastIpc:this.lastIpc};tracePhase('wait-timeout',evidence);cleanup();reject(new Error('PR07G_CHILD_MESSAGE_TIMEOUT:'+JSON.stringify(evidence)+':'+this.logs.slice(-2000)));},timeout);
      const message=(value:Message)=>{if(predicate(value)){tracePhase('wait-resolved',{server:this.name,childPid:this.process.pid,phase,elapsedMs:performance.now()-started,type:value.type});cleanup();const index=this.messages.indexOf(value);if(index>=0)this.messages.splice(index,1);resolve(value);}};
      const exit=()=>{cleanup();reject(new Error('PR07G_CHILD_EXIT_BEFORE_MESSAGE:'+this.logs.slice(-2000)));};
      const cleanup=()=>{clearTimeout(deadline);this.process.off('message',message);this.process.off('exit',exit);};
      this.process.on('message',message);this.process.once('exit',exit);
    });
  }
  async start(){
    await this.wait(m=>m.type==='boot',30_000,'boot');
    this.process.send?.({type:'initialize',requestId:randomUUID(),name:this.name,database:this.database,fixtureRoot:data.root,fixture:data.fixture,jwk:signing.jwk,tokens,
      runIds:Object.fromEntries([...imported.inventories.values()].map(v=>[v.plan.ownerId,v.plan.runId])),controlledProvider:diagnostic,...this.extras});
    const ready=await this.wait(m=>m.type==='ready',120_000,'ready');this.ready=ready;this.port=Number(ready.port);this.pid=Number(ready.pid);assert.ok(this.pid>0&&(this.kind==='worker'||this.port>0));return this;
  }
  rpc<T=Record<string,unknown>>(operation:string,payload:Record<string,unknown>={}):Promise<T>{
    const requestId=randomUUID(),started=performance.now();tracePhase('rpc-start',{server:this.name,childPid:this.process.pid,operation,requestId});return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{tracePhase('rpc-timeout',{server:this.name,childPid:this.process.pid,operation,requestId,timeoutMs:30_000,elapsedMs:performance.now()-started,lastPhase:this.lastPhase});this.pending.delete(requestId);reject(new Error('PR07G_CONTROL_TIMEOUT:'+operation));},30_000);
      this.pending.set(requestId,{resolve:value=>resolve(value as T),reject,timer});this.process.send?.({type:'control',requestId,operation,payload});});
  }
  async barrier(phase:string,key?:string){return await this.wait(m=>m.type==='barrier'&&m.phase===phase&&(!key||(m.detail as Barrier['detail']).key===key),30_000,'barrier:'+phase) as unknown as Barrier;}
  get base(){return 'http://127.0.0.1:'+this.port;}
  async request<T=Record<string,unknown>>(who:string,route:string,input?:unknown,signal?:AbortSignal){
    tracePhase('http-start',{server:this.name,childPid:this.pid,route,key:(input as {key?:string}|undefined)?.key});
    if(input && typeof input==='object' && ['authenticated-session-command-v1','authenticated-evaluation-command-v1'].includes(String(Reflect.get(input,'version')))) input=scoped(who,input);
    const sep=route.includes('?')?'&':'?',response=await fetch(this.base+route+sep+'applicationTargetId=shadow-app-'+(who.startsWith('b')?'b':'a'),{method:input===undefined?'GET':'POST',headers:{Authorization:'Bearer '+tokens[who],Origin:this.base,'Content-Type':'application/json'},
      ...(input===undefined?{}:{body:JSON.stringify(input)}),signal:signal??AbortSignal.timeout(120_000),redirect:'error'});
    const value=await response.json() as T;tracePhase('http-result',{server:this.name,childPid:this.pid,route,status:response.status});return {status:response.status,value,headers:response.headers};
  }
  async stop(force=false){if(this.process.exitCode!==null||this.process.signalCode!==null)return;
    if(!force)try{await this.rpc('stop');}catch{/* exit evidence below remains authoritative */}
    if(this.process.exitCode===null&&this.process.signalCode===null){const exited=new Promise<void>(resolve=>this.process.once('exit',()=>resolve()));this.process.kill(force?'SIGKILL':'SIGTERM');const watchdog=setTimeout(()=>{if(this.process.exitCode===null&&this.process.signalCode===null)this.process.kill('SIGKILL');},5000);try{await exited;}finally{clearTimeout(watchdog);}}
  }
}
const envelope=(key:string,view:Pick<View,'revision'|'writerGeneration'>,payload:unknown,resume=false)=>({version:'authenticated-session-command-v1',key,expectedRevision:view.revision,writerGeneration:view.writerGeneration,...(resume?{resume:true}:{}),payload});
async function create(server:ServerChild,who:'a'|'b',key:string){const request=envelope(key,{revision:'0',writerGeneration:'1'},{}),reply=await server.request<Reply<{sessionId:string;turn:RecordedTurn}>>(who,'/api/sessions',request);assert.equal(reply.status,201,JSON.stringify(reply.value));return {request,reply:reply.value,id:reply.value.result.sessionId,turn:reply.value.result.turn};}
async function view(server:ServerChild,who:'a'|'b',id:string){const result=await server.request<View>(who,'/api/sessions/'+id);assert.equal(result.status,200,JSON.stringify(result.value));return result.value;}
async function mutate<R=Record<string,unknown>>(server:ServerChild,who:'a'|'b',id:string,action:string,payload:unknown,key:string=randomUUID(),resume=false){const current=await view(server,who,id);const input=envelope(key,current,payload,resume),response=await server.request<Reply<R>>(who,`/api/sessions/${id}/${action}`,input);return {...response,input};}
async function socket(server:ServerChild,who:'a'|'b',id:string){
  const ticket=await server.request<{ticket:string}>(who,`/api/sessions/${id}/realtime-ticket`,{});assert.equal(ticket.status,200);
  const ws=new WebSocket(`ws://127.0.0.1:${server.port}/api/realtime?sessionId=${id}&ticket=${ticket.value.ticket}`,{origin:server.base});liveSockets.add(ws);ws.once('close',()=>liveSockets.delete(ws));
  const messages:Record<string,unknown>[]=[];ws.on('message',body=>messages.push(JSON.parse(body.toString())));
  await new Promise<void>((resolve,reject)=>{ws.once('open',()=>resolve());ws.once('error',reject);});
  const wait=async(predicate:(v:Record<string,unknown>)=>boolean)=>{
    const found=messages.findIndex(predicate);if(found>=0)return messages.splice(found,1)[0];
    const errors=()=>messages.filter(m=>m.type==='error').map(m=>({type:m.type,code:m.code,status:m.status,action:m.action}));
    if(errors().length){ws.terminate();throw new Error('PR07G_SOCKET_COMMAND_ERROR:'+JSON.stringify(errors()));}
    return new Promise<Record<string,unknown>>((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();ws.terminate();reject(new Error('PR07G_SOCKET_MESSAGE_TIMEOUT:'+JSON.stringify(messages.map(m=>({type:m.type,action:m.action,status:m.status,code:m.code})))));},15_000);
      const receive=(body:Buffer)=>{const value=JSON.parse(body.toString());if(predicate(value)){cleanup();const i=messages.findIndex(m=>m.type===value.type&&m.action===value.action);if(i>=0)messages.splice(i,1);resolve(value);}else if(value.type==='error'){cleanup();ws.terminate();reject(new Error('PR07G_SOCKET_COMMAND_ERROR:'+JSON.stringify({code:value.code,status:value.status,action:value.action})));}};
      const closed=()=>{cleanup();reject(new Error('PR07G_SOCKET_CLOSED:'+JSON.stringify(errors())));};const cleanup=()=>{clearTimeout(timer);ws.off('message',receive);ws.off('close',closed);};ws.on('message',receive);ws.once('close',closed);});
  };
  const ready=await wait(m=>m.type==='ready');assert.equal(ready.readOnly,false);return {ws,wait,messages,ready};
}
async function captureAnswer(server:ServerChild,who:'a'|'b',id:string,turn:RecordedTurn,staged=false,reuseAnswerId?:string){
  const channel=await socket(server,who,id),answerId=reuseAnswerId??randomUUID(),current=await view(server,who,id),captureRevision=(current.recovery.captureRevision??0)+1;
  const start=envelope(randomUUID(),current,{turnId:turn.id,answerId,captureRevision,staged});channel.ws.send(JSON.stringify(scoped(who,{type:'command',action:'capture-start',command:start})));
  const started=await channel.wait(m=>m.type==='command_result'&&m.action==='capture-start');assert.ok(started.value);
  channel.ws.send(Buffer.alloc(320,1));
  const finish=await mutate<{confirmed:boolean;rawTranscript:string;transcriptStatus:string;submissionAttemptId?:string}>(server,who,id,'capture-finish',{turnId:turn.id,answerId,captureRevision});assert.equal(finish.status,200,JSON.stringify(finish.value));
  return {channel,answerId,captureRevision,finish};
}

interface EvaluationView { control:{trustGeneration:string;registryGeneration:string;approvalGeneration:string;approvalSha256:string|null;fence:string|null};handoff:{payloadSha256:string};projection:EvaluationProjection|null }
function assertFrozen(actual:SessionCommandSnapshot,expected:SessionCommandSnapshot){const {serverNow:a,lastDisconnectedAt:b,...left}=actual;const {serverNow:c,lastDisconnectedAt:d,...right}=expected;void a;void b;void c;void d;assert.deepEqual(left,right);}
const epath=(id:string,action='')=>`/api/sessions/${id}/evaluation${action?'/'+action:''}`;
async function eview(who:string,id:string,server=one){const response=await server.request<EvaluationView>(who,epath(id));assert.equal(response.status,200,JSON.stringify(response.value));return response.value;}
async function fcommand(who:string,id:string,action:string,payload:unknown,key=randomUUID(),server=one){const v=await eview(who,id,server);return server.request<Reply>(who,epath(id,action),{version:'authenticated-evaluation-command-v1',key,expectedTrustGeneration:v.control.trustGeneration,expectedRegistryGeneration:v.control.registryGeneration,expectedApprovalGeneration:v.control.approvalGeneration,payload});}
const signers={a:supplySigner(),b:supplySigner()},registrySigners={a:supplySigner(),b:supplySigner()},specReviewer=supplyReviewer+'-spec';
const immutable=new Map<string,SessionCommandSnapshot>(),completed=new Map<'a'|'b',{id:string;jobId:string;result:unknown}>();
async function endedHttp(who:'a'|'b'){
  const created=await create(one,who,'f-http-'+randomUUID()),capture=await captureAnswer(one,who,created.id,created.turn);
  assert.equal((await mutate(one,who,created.id,'answer',{turnId:created.turn.id,answerId:capture.answerId,captureRevision:1,elapsedMs:3500})).status,200);
  capture.channel.ws.close();assert.equal((await mutate(one,who,created.id,'end',{elapsedMs:9000})).status,202);
  const snapshot=await one.rpc<SessionCommandSnapshot>('snapshot',{who,sessionId:created.id});assert.ok(snapshot.handoff);immutable.set(created.id,snapshot);snapshots.push({sessionId:created.id,snapshot});return created.id;
}
async function installTrust(who:'a'|'b',revoked=false){
  const body={version:'evaluation-review-trust-v1',ownerId:'owner-'+who,studentId:data.fixture.source.studentId,applicationTargetId:'shadow-app-'+who,supportTargetId:data.fixture.scope.supportTargetId,
    reviewers:[{issuer:`https://issuer-${who}.example`,subject:'f-'+who+'-reviewer',actorId:supplyReviewer,publicKey:signers[who].trustedPublicKey,actions:['supply-session','withdraw'],notBefore:new Date(Date.now()-60_000).toISOString(),expiresAt:new Date(Date.now()+3600_000).toISOString(),revoked},{issuer:`https://issuer-${who}.example`,subject:'f-'+who+'-specreviewer',actorId:specReviewer,publicKey:registrySigners[who].trustedPublicKey,actions:['publish-spec'],notBefore:new Date(Date.now()-60_000).toISOString(),expiresAt:new Date(Date.now()+3600_000).toISOString(),revoked}]};
  const trust={...body,contentSha256:snapshotHash(body)},json=JSON.stringify(trust);
  await one.rpc('install-trust',{who:who+'operator',trust:{kind:'trust',contentSha256:trust.contentSha256,json,rawSha256:hash(json)}});return trust;
}
async function publishA(who:'a'|'b',id:string){
  const inventory=await one.request<{inventory:BankEvaluationScopeRegistry}>(who,epath(id,'registry'));assert.equal(inventory.status,200,JSON.stringify(inventory.value));
  const {contentSha256:old,...body}=structuredClone(inventory.value.inventory);void old;
  // Explicit public fixture review of the exact demands/contracts, rather
  // than an approval inferred from ROLE/CONCEPT/other labels.
  for(const row of body.entries){row.scope='record_consistency_only';row.assessableCriteria=['Only the exact finalized answer and approved demand consistency in this public fixture.'];row.excludedCriteria=['External scientific accuracy and claims not stated by the applicant.'];row.review={status:'approved',authority:'explicit_reviewed_input',approverId:specReviewer,reviewedAt:new Date().toISOString(),reason:'Explicit isolated public input review of exact source and contract.'};}
  const registry=sealBankScopeRegistry(body),receipt=registrySigners[who].receipt({version:'authenticated-bank-scope-review-v1',actorId:specReviewer,registrySha256:registry.contentSha256,action:'publish_scopes',issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600_000).toISOString()});
  const supplied=await fcommand(who+'specreviewer',id,'registry',{registryJson:JSON.stringify(registry),receiptJson:JSON.stringify(receipt)});assert.equal(supplied.status,200,JSON.stringify(supplied.value));return registry;
}
async function publishB(who:'a'|'b',id:string,mutate?:(value:Record<string,unknown>)=>void,selectedTurnIds?:string[]){
  const proposed=await one.request<{proposal:{contentSha256:string;sessionQuestionAnswerSha256:string;contextSnapshotSha256:string}}>(who,epath(id,'review'));assert.equal(proposed.status,200,JSON.stringify(proposed.value));
  const proposal=proposed.value.proposal,snapshot=await one.rpc<SessionCommandSnapshot>('snapshot',{who,sessionId:id}),session=JSON.parse(snapshot.sessionJson) as InterviewSession,bundle=supplyRecordBundle(session,selectedTurnIds?session.turns.filter(turn=>selectedTurnIds.includes(turn.id)):session.turns);
  const receipt=signers[who].receipt({version:'authenticated-session-evaluation-review-v1',actorId:supplyReviewer,action:'approve_session_evaluation',proposalSha256:proposal.contentSha256,bundleSha256:bundle.contentSha256,sessionId:id,
    sessionQuestionAnswerSha256:proposal.sessionQuestionAnswerSha256,contextSnapshotSha256:proposal.contextSnapshotSha256,issuedAt:new Date(Date.now()-500).toISOString(),expiresAt:new Date(Date.now()+3600_000).toISOString()});
  const payload={bundleJson:JSON.stringify(bundle),reviewJson:JSON.stringify({receipt,proposal})};mutate?.(payload);
  return fcommand(who+'reviewer',id,'approval',payload);
}
async function consume(who:'a'|'b',id:string,key=randomUUID(),server=one){const current=await eview(who,id,server);return fcommand(who,id,'consume',{handoffPayloadSha256:current.handoff.payloadSha256,approvalSha256:current.control.approvalSha256},key,server);}
async function dispatch(who:'a'|'b',jobId:string,worker:ServerChild,expiresAt=Date.now()+300_000){const workerSuffix=worker===worker1?'worker1':'worker2';const grant=await one.rpc('grant-worker',{who:who+'operator',jobIds:[jobId],subjectId:'f-'+who+'-'+workerSuffix,expiresAt});return {grant,who:who+workerSuffix,jobId};}
async function runJob(who:'a'|'b',jobId:string,worker=worker1,leaseMs?:number){return worker.rpc<{processed:boolean;job:{status:string}|null}>('run',{...await dispatch(who,jobId,worker),...(leaseMs?{leaseMs}:{})});}
async function sql(table:string,id:string,database=pools){const predicate=['evaluation_results','evaluation_checkpoints','evaluation_usage','evaluation_worker_grants'].includes(table)?'(owner_id,job_id) IN (SELECT owner_id,job_id FROM gakja.evaluation_jobs WHERE session_id=$1)':'session_id=$1';return (await database.admin.query(`SELECT to_jsonb(t) value FROM gakja.${table} t WHERE ${predicate} ORDER BY to_jsonb(t)::text`,[id])).rows.map(row=>row.value);}
async function until<T>(read:()=>Promise<T>,condition:(value:T)=>boolean,timeout=15_000){const deadline=Date.now()+timeout;while(true){const value=await read();if(condition(value))return value;if(Date.now()>deadline)throw new Error('F_CONDITION_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,50));}}

const sourceContexts=new Map<string,AuthenticatedRequestContext>(),restoreContexts=new Map<string,AuthenticatedRequestContext>();
const sourceOperators=new Map<string,TransitionOperatorCapability>(),restoreOperators=new Map<string,TransitionOperatorCapability>();
let sourceTransition:TransitionRepository,restoreTransition:TransitionRepository;
const output=process.env.PR07G_TEST_OUTPUT??'artifacts/pr07g';
const restoreBodies=createControlledObjectProvider();
const nativeRestore: ObjectStorageProvider=diagnostic?{...restoreBodies,async read(...args){try{return await restoreBodies.read(...args);}catch(error){if(error instanceof Error&&error.message==='PR07F_CONTROLLED_BODY_MISSING')throw new ObjectProviderError('STORAGE_NOT_FOUND');throw error;}}}:createSupabaseObjectProvider({apiUrl:process.env.PR07G_TEST_RESTORE_STORAGE_API_URL!,serviceCredential:process.env.PR07G_TEST_RESTORE_STORAGE_SERVICE_KEY!,bucket:process.env.PR07G_TEST_RESTORE_BUCKET!,keyPrefix:process.env.PR07G_TEST_RESTORE_KEY_PREFIX!,allowLoopbackHttp:true});
const allowedActions:readonly TransitionOperatorAction[]=['prepare','verify','activate','freeze','rollback-empty','recover','status','export','restore','register-input'];
async function installTransition(repository:TransitionRepository,context:AuthenticatedRequestContext){
  const expiresAt=Date.now()+2*3600_000,base={ownerId:context.account.ownerId,...context.scope!,issuer:context.principal.issuer,subject:context.principal.subject,expiresAt,async checkCurrent(){return true;}};
  const input={key:randomUUID(),inputSha256:hash(randomUUID()),grant:{issuer:base.issuer,subject:base.subject,actions:allowedActions,expiresAt:new Date(expiresAt-1000).toISOString(),active:true}};
  await repository.installOperator(context,input,createTransitionInstallerCapability({...base,key:input.key,inputSha256:input.inputSha256,sourceProofSha256:hash('explicit public G rehearsal operator source')}));
  return createTransitionOperatorCapability({...base,actions:allowedActions});
}
async function transition(who:'a'|'b',action:'freeze'|'prepare'|'activate'|'rollback-empty'|'recover',payload:unknown={},key:string=randomUUID()){
  const context=sourceContexts.get(who)!,state=(await sourceTransition.read(context))!;
  const command=createTransitionCommand({key,action,expectedGeneration:state.generation,payloadJson:JSON.stringify(payload)});
  const receipt=await sourceTransition.command(context,command,sourceOperators.get(who)!);generations[who]=JSON.parse(receipt.resultJson).generation;return {command,receipt};
}
test.before(async()=>{
  await mkdir(output,{recursive:true});await seedPublicDOuterScope(pools,data.fixture);await seedPublicDOuterScope(restorePools,data.fixture);
  for(const database of [pools,restorePools])for(const who of ['a','b'])for(const role of ['reviewer','specreviewer','operator','worker1','worker2'])await database.admin.query('INSERT INTO gakja.principals(issuer,subject,account_id) VALUES($1,$2,$3)',[`https://issuer-${who}.example`,'f-'+who+'-'+role,'account-'+who]);
  imported=await importPublicDContexts(pools,signing,data.root,data.fixture,provider);
  const restoredAuth=createSessionTestAuthority(restorePools,signing.jwk);
  sourceTransition=createPostgresTransitionRepository({identity:imported.auth.identity,requestPool:pools.request,mappingPool:pools.mapping});
  restoreTransition=createPostgresTransitionRepository({identity:restoredAuth.identity,requestPool:restorePools.request,mappingPool:restorePools.mapping});
  for(const who of ['a','b'] as const){
    const context=imported.auth.identity.selectScope(await imported.auth.identity.authenticate('Bearer '+tokens[who+'operator']),{applicationTargetId:'shadow-app-'+who}) as AuthenticatedRequestContext;
    const restored=restoredAuth.identity.selectScope(await restoredAuth.identity.authenticate('Bearer '+tokens[who+'operator']),{applicationTargetId:'shadow-app-'+who}) as AuthenticatedRequestContext;
    sourceContexts.set(who,context);restoreContexts.set(who,restored);
    sourceOperators.set(who,await installTransition(sourceTransition,context));restoreOperators.set(who,await installTransition(restoreTransition,restored));
    const inventory=imported.inventories.get(who)!,pinned=await imported.storage.shadow.capture(imported.contexts.get(who)!,inventory.plan.runId);
    assert.ok(pinned);assert.equal(pinned.planSha256,inventory.plan.planSha256);
    const own=path.resolve('artifacts/pr07g/integration-local-sources');await mkdir(own,{recursive:true});const root=await mkdtemp(path.join(own,'owned-'+who+'-'));await mkdir(path.join(root,'data'),{recursive:true});
    await writeFile(path.join(root,'data/pinned-inputs.json'),JSON.stringify({version:'g-public-source-checkpoint-v1',D:pinned,scope:{ownerId:context.account.ownerId,...context.scope!}}));
    const coordinator=createLocalTransitionCoordinator({root,scope:{ownerId:context.account.ownerId,...context.scope!},identity:imported.auth.identity,context,repository:sourceTransition,operator:sourceOperators.get(who)!,
      async verifyStoppedParticipants(){return {complete:true,unparticipatingProcesses:0,proofSha256:hash(JSON.stringify({version:'explicit-owned-copy-process-inventory-v1',root,participatingPids:[],oldWriters:[],createdByPid:process.pid}))};}});
    await coordinator.install();const activated=await coordinator.activate({key:'activate-'+who,expectedGeneration:'0',expiresAt:new Date(Date.now()+90*60_000).toISOString(),async verifyCheckpoint(bytes){const checkpoint=JSON.parse(bytes) as {files:unknown[]};return checkpoint.files.length===1&&await imported.storage.shadow.unchanged(imported.contexts.get(who)!,pinned.runId,pinned.generation);}});
    generations[who]=JSON.parse(activated.resultJson).generation;assert.equal((await lstat(path.join(root,'data'))).isFile(),true);
    rows.push({caseId:'G-ACTIVATE-'+who,state:JSON.parse(activated.resultJson),localFinalRenameBarrier:true,CAndDActualPinnedCheckpoint:true,sourceRoot:root});
  }
  [one,two,worker1,worker2]=await Promise.all([new ServerChild('g-service-one').start(),new ServerChild('g-service-two').start(),new ServerChild('g-worker-one','primary','worker').start(),new ServerChild('g-worker-two','primary','worker').start()]);
  assert.equal(new Set([one.pid,two.pid,worker1.pid,worker2.pid]).size,4);
  for(const worker of [worker1,worker2]){assert.equal(worker.ready.mappingPoolPresent,false);assert.equal(worker.ready.privilegedCredentialsInherited,false);assert.equal(worker.ready.storageCredentialsInherited,false);}
  rows.push({caseId:'G-ENV',servers:[one.ready,two.ready],workers:[worker1.ready,worker2.ready],actualPostgreSQL:true,storageEngine:diagnostic?'controlled-body-diagnostic-NOT-official-Storage':'official-Supabase-Storage-REST',nativeProviderCores:true,publicSyntheticRawInputsOnly:true});
},{timeout:600_000});
test.after(async()=>{
  for(const ws of liveSockets)ws.terminate();
  const states:Record<string,unknown>[]=[];for(const child of children)if(child.process.exitCode===null&&child.process.signalCode===null)try{states.push({name:child.name,kind:child.kind,...await child.rpc('state')});}catch{/* dead child remains in its unique log */}
  for(const child of children)await child.stop();await closePools(pools);await closePools(restorePools);
  for(const child of children)await writeFile(path.join(output,`child-${child.name}-${child.pid||child.process.pid}.log`),child.logs);
  await writeFile(path.join(output,'transition-rehearsal.json'),JSON.stringify({version:'pr07g-two-server-two-worker-rehearsal-v1',rows,states,snapshots,providerIo,twoIndependentServers:!!one?.pid&&!!two?.pid&&one.pid!==two.pid,twoIndependentWorkers:!!worker1?.pid&&!!worker2?.pid&&worker1.pid!==worker2.pid,paidProviderCalls:0,actualStudentDataTransferred:false,objectCleanup:'The owning G Storage runner removes only its two marked buckets and verifies unrelated controls; DB runner drops only its two marked databases.'},null,2)+'\n');
  await writeFile(path.join(output,'g-phase-trace.json'),JSON.stringify({version:'pr07g-phase-trace-v1',rows:phaseTrace},null,2)+'\n');
  for(const state of states){const counters=state.counters as Record<string,number>;for(const key of ['localDataReadAttempts','localSessionWriteAttempts','localFileWrites','localPrivateReads','paidProviderCalls'])assert.equal(counters?.[key]??0,0,key);}
});

test('G-HTTP-01 two native-core service PIDs share exact authenticated HTTP/WSS inputs; missing approval stays durable with zero models',{timeout:300_000},async()=>{
  for(const who of ['a','b'] as const){
    const created=await create(who==='a'?one:two,who,'g-http-'+randomUUID()),capture=await captureAnswer(who==='a'?one:two,who,created.id,created.turn);
    assert.equal((await mutate(who==='a'?one:two,who,created.id,'answer',{turnId:created.turn.id,answerId:capture.answerId,captureRevision:1,elapsedMs:3500})).status,200);
    capture.channel.ws.close();assert.equal((await mutate(who==='a'?one:two,who,created.id,'end',{elapsedMs:9000})).status,202);
    const snapshot=await one.rpc<SessionCommandSnapshot>('snapshot',{who,sessionId:created.id});assert.ok(snapshot.handoff);immutable.set(created.id,snapshot);snapshots.push({sessionId:created.id,snapshot});
    const key=randomUUID(),first=await consume(who,created.id,key),replay=await consume(who,created.id,key,two);assert.equal(first.status,200,JSON.stringify(first.value));assert.equal(replay.status,200);assert.equal(replay.value.operationId,first.value.operationId);assert.equal(replay.value.replay,true);
    const projection=(await eview(who,created.id)).projection!;assert.equal(projection.state,'review_required');assert.equal(projection.job,null);assert.equal(projection.result,null);assert.equal((await sql('evaluation_jobs',created.id)).length,0);
    assert.equal((await one.request(who==='a'?'b':'a','/api/sessions/'+created.id)).status,404);completed.set(who,{id:created.id,jobId:'',result:null});
    rows.push({caseId:'G-HTTP-01-'+who,sessionId:created.id,serverPid:who==='a'?one.pid:two.pid,httpAndWss:true,immutableHandoffSha256:snapshot.handoff!.payloadSha256,evaluationApprovalGranted:JSON.parse(snapshot.handoff!.payloadJson).evaluationApprovalGranted,missingApprovalState:'review_required',runnableJobs:0});
  }
  for(const worker of [worker1,worker2])assert.equal(((await worker.rpc('state')).counters as {modelCalls:number}).modelCalls,0);
});
test('G-SUPPLY-02 separate A/B reviewers drive two independent service workers through actual parsing, held-F policy and DB publication',{timeout:300_000},async()=>{
  for(const who of ['a','b'] as const){const item=completed.get(who)!;await installTrust(who);await publishA(who,item.id);
    assert.equal((await fcommand(who+'specreviewer',item.id,'approval',{bundleJson:'{}',reviewJson:'{}'})).status,403);
    assert.equal((await consume(who,item.id)).status,200);assert.equal((await eview(who,item.id)).projection!.job,null);
    const invalid=await publishB(who,item.id,payload=>{const value=JSON.parse(String(payload.reviewJson));value.receipt.signature='invalid';payload.reviewJson=JSON.stringify(value);});assert.equal(invalid.status,409);
    assert.equal((await publishB(who,item.id)).status,200);assert.equal((await consume(who,item.id)).status,200);item.jobId=(await eview(who,item.id)).projection!.job!.id;
  }
  const outcomes=await Promise.all([runJob('a',completed.get('a')!.jobId,worker1),runJob('b',completed.get('b')!.jobId,worker2)]);
  for(const [index,who] of (['a','b'] as const).entries()){const item=completed.get(who)!,current=await eview(who,item.id);assert.equal(outcomes[index].job?.status,'completed',JSON.stringify(outcomes[index]));assert.equal(current.projection!.state,'completed');assert.ok(current.projection!.result);item.result=current.projection!.result;assertFrozen(await one.rpc<SessionCommandSnapshot>('snapshot',{who,sessionId:item.id}),immutable.get(item.id)!);
    assert.equal((await sql('evaluation_results',item.id)).length,1);assert.equal((await runJob(who,item.jobId,who==='a'?worker2:worker1)).processed,false);
    rows.push({caseId:'G-SUPPLY-02-'+who,workerPid:who==='a'?worker1.pid:worker2.pid,sessionId:item.id,jobId:item.jobId,actualEvaluationEngine:true,syntheticRawProviderOnly:true,publicSyntheticABSeparate:true,result:current.projection!.result});
  }
});
test('G-RACE-03 independent servers retain one same-key command receipt and two workers retain one logical job while model I/O holds no SQL transaction',{timeout:300_000},async()=>{
  const id=await endedHttp('a');await publishA('a',id);assert.equal((await publishB('a',id)).status,200);
  const key=randomUUID(),answers=await Promise.all([consume('a',id,key,one),consume('a',id,key,two)]);assert.deepEqual(answers.map(r=>r.status),[200,200]);assert.equal(answers[0].value.operationId,answers[1].value.operationId);
  const current=await eview('a',id),jobId=current.projection!.job!.id;assert.equal((await fcommand('a',id,'consume',{handoffPayloadSha256:'0'.repeat(64),approvalSha256:current.control.approvalSha256},key,two)).status,409);
  const permit1=await dispatch('a',jobId,worker1),permit2=await dispatch('a',jobId,worker2);await worker1.rpc('configure',{holdModel:true});const first=worker1.rpc<{job:{status:string}}>('run',permit1),barrier=await worker1.barrier('model');
  const second=await worker2.rpc<{processed:boolean}>('run',permit2);assert.equal(second.processed,false);
  const probe=await worker1.rpc<{request:{pid:number};worker:{pid:number}}>('probe-database'),activities=await pools.admin.query('SELECT pid,xact_start FROM pg_stat_activity WHERE pid=ANY($1::int[])',[[probe.request.pid,probe.worker.pid]]);assert.equal(activities.rows.length,2);assert.ok(activities.rows.every(r=>r.xact_start===null));
  await worker1.rpc('release',{barrierId:barrier.barrierId});assert.equal((await first).job.status,'completed');await worker1.rpc('configure',{});
  assert.equal((await sql('evaluation_jobs',id)).length,1);assert.equal((await sql('evaluation_results',id)).length,1);rows.push({caseId:'G-RACE-03',servers:[one.pid,two.pid],workers:[worker1.pid,worker2.pid],singleLogicalJob:true,singleReceipt:true,singleResult:true,providerAwaitSqlTransactions:0});
});
test('G-REVOKE-04 current review withdrawal during a raw model await blocks publication and retains the older exact result revision',{timeout:300_000},async()=>{
  const id=await endedHttp('a');await publishA('a',id);assert.equal((await publishB('a',id)).status,200);assert.equal((await consume('a',id)).status,200);const jobId=(await eview('a',id)).projection!.job!.id;
  await worker1.rpc('configure',{holdModel:true});const pending=runJob('a',jobId,worker1).catch(error=>({error:(error as Error).message})),barrier=await worker1.barrier('model');assert.equal((await fcommand('areviewer',id,'withdraw',{reason:'Explicit G controlled withdrawal during native core I/O'})).status,200);
  await worker1.rpc('release',{barrierId:barrier.barrierId});await pending;await worker1.rpc('configure',{});assert.equal((await sql('evaluation_results',id)).length,0);assert.equal((await eview('a',id)).projection!.state,'review_required');
  const old=completed.get('a')!,historical=await one.request<EvaluationProjection>('a',epath(old.id,'revision')+'?jobId='+old.jobId);assert.equal(historical.status,200);assert.deepEqual(historical.value.result,old.result);rows.push({caseId:'G-REVOKE-04',workerPid:worker1.pid,staleResultRows:0,olderResultPreserved:true});
});
test('G-END-05 actual WSS tail frames remain in one accepted end/handoff and a different service PID replays the exact receipt',{timeout:300_000},async()=>{
  await one.rpc('configure',{provider:{transcript:'전환 전에 받아들인 종료의 마지막 전사 원문입니다.',confirmed:true}});
  const created=await create(one,'b','g-tail-'+randomUUID()),channel=await socket(one,'b',created.id),answerId=randomUUID(),head=await view(one,'b',created.id);
  channel.ws.send(JSON.stringify(scoped('b',{type:'command',action:'capture-start',command:envelope(randomUUID(),head,{turnId:created.turn.id,answerId,captureRevision:1})})));await channel.wait(m=>m.type==='command_result'&&m.action==='capture-start');channel.ws.send(Buffer.alloc(320,1));
  const input=envelope(randomUUID(),await view(one,'b',created.id),{elapsedMs:12000,metrics:{answerId,durationMs:12000,captureFinishScope:{turnId:created.turn.id,answerId,captureRevision:1}}}),pending=one.request<Reply>('b',`/api/sessions/${created.id}/end`,input);
  await until(()=>sql('session_end_intents',created.id),values=>values.length===1);channel.ws.send(Buffer.alloc(160,2));
  channel.ws.send(JSON.stringify(scoped('b',{type:'command',action:'capture-finish',command:envelope(randomUUID(),{revision:input.expectedRevision,writerGeneration:input.writerGeneration},{turnId:created.turn.id,answerId,captureRevision:1})})));await channel.wait(m=>m.type==='command_result'&&m.action==='capture-finish');assert.equal((await pending).status,202);channel.ws.close();
  const frozen=await one.rpc<SessionCommandSnapshot>('snapshot',{who:'b',sessionId:created.id});assert.equal((JSON.parse(frozen.sessionJson) as InterviewSession).turns.at(-1)!.rawTranscript,'전환 전에 받아들인 종료의 마지막 전사 원문입니다.');
  const replay=await two.request<Reply>('b',`/api/sessions/${created.id}/end`,input);assert.equal(replay.status,202);assert.equal(replay.value.replay,true);assert.equal((await sql('session_evaluation_handoffs',created.id)).length,1);
  rows.push({caseId:'G-END-05',serverPids:[one.pid,two.pid],sessionId:created.id,orderedTailBytes:160,endInputPreserved:true,handoffs:1,receiptReplayedDifferentPid:true});await one.rpc('configure',{provider:{transcript:'합성 면접에서 자료를 비교하고 확인한 방법을 설명했습니다.'}});
});
test('G-HELD-06 mixed ready and held F keeps three-member weights and all-held input queues no job or model',{timeout:300_000},async()=>{
  const seeded=await one.rpc<{sessionId:string;snapshot:SessionCommandSnapshot}>('seed-controlled-ended',{who:'a',followUps:2}),session=JSON.parse(seeded.snapshot.sessionJson) as InterviewSession,id=seeded.sessionId;
  assert.equal(session.turns.length,3);await publishA('a',id);const missingId=session.turns[1].id,ready=session.turns.filter(turn=>turn.id!==missingId).map(turn=>turn.id);
  assert.equal((await publishB('a',id,undefined,ready)).status,200);assert.equal((await consume('a',id)).status,200);const jobId=(await eview('a',id)).projection!.job!.id,before=await worker1.rpc<{modelInputs:{turnIds:string[]}[]}>('state');
  assert.equal((await runJob('a',jobId,worker1)).job?.status,'completed');const after=await worker1.rpc<{modelInputs:{turnIds:string[]}[]}>('state'),submitted=after.modelInputs.slice(before.modelInputs.length).flatMap(row=>row.turnIds);assert.deepEqual([...submitted].sort(),[...ready].sort());
  const result=(await eview('a',id)).projection!.result!,evaluation=result.evaluation as unknown as {answers:{turnId:string;status:string;score:number|null}[];clusterScores:{score:number|null;members:{turnId:string;weight:number;score:number|null}[]}[];sessionScore:number|null;partialReport:boolean};
  const held=evaluation.answers.find(answer=>answer.turnId===missingId)!;assert.equal(held.status,'NOT_EVALUABLE');assert.equal(held.score,null);assert.equal(evaluation.clusterScores[0].score,null);assert.deepEqual(session.turns.map(turn=>evaluation.clusterScores[0].members.find(member=>member.turnId===turn.id)!.weight),[0.7,0.15,0.15]);assert.equal(evaluation.sessionScore,null);assert.equal(evaluation.partialReport,true);
  assertFrozen(await one.rpc<SessionCommandSnapshot>('snapshot',{who:'a',sessionId:id}),seeded.snapshot);
  const all=await one.rpc<{sessionId:string}>('seed-controlled-ended',{who:'a',followUps:2});await publishA('a',all.sessionId);const modelBefore=((await worker1.rpc('state')).counters as {modelCalls:number}).modelCalls;
  assert.equal((await publishB('a',all.sessionId,undefined,[])).status,200);assert.equal((await consume('a',all.sessionId)).status,200);const projection=(await eview('a',all.sessionId)).projection!;assert.equal(projection.state,'review_required');assert.equal(projection.job,null);assert.equal(projection.result,null);assert.equal((await sql('evaluation_jobs',all.sessionId)).length,0);assert.equal(((await worker1.rpc('state')).counters as {modelCalls:number}).modelCalls,modelBefore);
  rows.push({caseId:'G-HELD-06',sessionId:id,heldFollowUpId:missingId,heldScore:null,clusterScore:null,originalWeights:[0.7,0.15,0.15],actualSubmittedTurns:submitted,allHeldSessionId:all.sessionId,allHeldModelCalls:0,allHeldRunnableJobs:0,actualNativeWorkerParser:true});
});
test('G-MAPPING-07 current account revision/grant revoked during real model I/O rejects publication before restoring only the original mapping',{timeout:300_000},async()=>{
  const id=await endedHttp('a');await publishA('a',id);assert.equal((await publishB('a',id)).status,200);assert.equal((await consume('a',id)).status,200);const jobId=(await eview('a',id)).projection!.job!.id;
  const original=(await pools.admin.query('SELECT active FROM gakja.access_grants WHERE account_id=$1 AND student_id=$2 AND application_target_id=$3',['account-a',data.fixture.source.studentId,'shadow-app-a'])).rows[0];assert.equal(original.active,true);
  const revision=(await pools.admin.query('SELECT revision::text value FROM gakja.accounts WHERE account_id=$1',['account-a'])).rows[0].value;
  await worker1.rpc('configure',{holdModel:true});const pending=runJob('a',jobId,worker1).then(value=>({value}),error=>({error:(error as Error).message})),barrier=await worker1.barrier('model');
  try {await pools.admin.query('UPDATE gakja.access_grants SET active=false WHERE account_id=$1 AND student_id=$2 AND application_target_id=$3',['account-a',data.fixture.source.studentId,'shadow-app-a']);assert.notEqual((await one.request('a',epath(id))).status,200);await worker1.rpc('release',{barrierId:barrier.barrierId});await pending;assert.equal((await sql('evaluation_results',id)).length,0);}
  finally {await pools.admin.query('UPDATE gakja.access_grants SET active=$4 WHERE account_id=$1 AND student_id=$2 AND application_target_id=$3',['account-a',data.fixture.source.studentId,'shadow-app-a',original.active]);await worker1.rpc('release',{barrierId:barrier.barrierId}).catch(()=>{});await pending;await worker1.rpc('configure',{});}
  const fresh=imported.auth.identity.selectScope(await imported.auth.identity.authenticate('Bearer '+tokens.aoperator),{applicationTargetId:'shadow-app-a'}) as AuthenticatedRequestContext;sourceContexts.set('a',fresh);
  const next=(await pools.admin.query('SELECT revision::text value FROM gakja.accounts WHERE account_id=$1',['account-a'])).rows[0].value;assert.ok(BigInt(next)>BigInt(revision));assert.equal((await one.request('a',epath(id))).status,200);
  rows.push({caseId:'G-MAPPING-07',sessionId:id,currentGrantRevokedDuringModel:true,staleResults:0,originalActiveGrantRestored:true,accountRevisionRemainedMonotonic:true});
});
test('G-FAILURE-08 HTTP failure before commit and lost committed response never fall back and same key recovers the one durable receipt',{timeout:300_000},async()=>{
  const key='g-create-failure-'+randomUUID();await two.rpc('configure',{hooks:[{phase:'before-commit',action:'create',key,mode:'fail',once:true}]});const first=await createRejected(two,'a',key);assert.notEqual(first.status,201);
  const row=(await pools.admin.query('SELECT session_id,created FROM gakja.session_command_sessions WHERE owner_id=$1 AND student_id=$2 AND application_target_id=$3 AND creation_key=$4',['owner-a',data.fixture.source.studentId,'shadow-app-a',key])).rows[0];assert.ok(row);assert.equal(row.created,false);
  await two.rpc('configure',{});const retry=await create(one,'a',key);assert.equal(retry.id,row.session_id);
  const lostKey='g-lost-response-'+randomUUID();await two.rpc('configure',{hooks:[{phase:'after-commit',action:'create',key:lostKey,mode:'fail',once:true}]});const lost=await createRejected(two,'a',lostKey);assert.equal(lost.status,503);
  const committed=(await pools.admin.query('SELECT session_id,created FROM gakja.session_command_sessions WHERE owner_id=$1 AND student_id=$2 AND application_target_id=$3 AND creation_key=$4',['owner-a',data.fixture.source.studentId,'shadow-app-a',lostKey])).rows[0];assert.equal(committed.created,true);
  await two.rpc('configure',{});const replay=await create(one,'a',lostKey);assert.equal(replay.id,committed.session_id);assert.equal(replay.reply.replay,true);
  rows.push({caseId:'G-FAILURE-08',beforeCommitCreated:false,committedResponseStatus:lost.status,sameKeyReceiptRecovered:true,localFallbackWrites:0,serverPids:[one.pid,two.pid]});
});
test('G-OBJECT-09 a missing verified private object fails through actual C/HTTP without local fallback and exact bytes can be restored',{timeout:120_000},async()=>{
  const object=(await pools.admin.query('SELECT u.bucket,u.final_key,u.expected_size,u.expected_sha256 FROM gakja.storage_audio_links l JOIN gakja.storage_uploads u USING(object_id) WHERE l.owner_id=$1 AND l.resource_id=$2',['owner-a',data.fixture.speechHash])).rows[0];assert.ok(object);
  const ref={bucket:object.bucket,key:object.final_key},bytes=await provider.read(ref,{maxBytes:Number(object.expected_size)});assert.equal(hash(bytes),object.expected_sha256);
  const url=one.base+'/api/audio/'+encodeURIComponent(data.fixture.speechHash)+'?applicationTargetId=shadow-app-a',options={headers:{Authorization:'Bearer '+tokens.a,Origin:one.base},signal:AbortSignal.timeout(15_000),redirect:'error'as const};
  let missingStatus=0;await provider.remove(ref);
  try {const response=await fetch(url,options);missingStatus=response.status;await response.arrayBuffer();assert.ok(response.status>=400);}
  finally {await provider.upload(ref,bytes,{contentType:'audio/mpeg'});}
  const restored=await fetch(url,{...options,signal:AbortSignal.timeout(15_000)});assert.equal(restored.status,200);assert.equal(hash(Buffer.from(await restored.arrayBuffer())),object.expected_sha256);
  const state=await one.rpc<{counters:Record<string,number>}>('state');assert.equal(state.counters.localDataReadAttempts,0);assert.equal(state.counters.localSessionWriteAttempts,0);
  rows.push({caseId:'G-OBJECT-09',missingStatus,verifiedObjectHash:object.expected_sha256,restoredBytesExact:true,localFallbackReads:0,source:'owned public synthetic object only'});
});
test('G-FREEZE-10 freeze during independent worker/raw session provider I/O fences every late publication and exact committed receipt remains readable',{timeout:300_000},async()=>{
  const id=await endedHttp('a');await publishA('a',id);assert.equal((await publishB('a',id)).status,200);const consumeKey=randomUUID(),consumed=await consume('a',id,consumeKey);assert.equal(consumed.status,200);const jobId=(await eview('a',id)).projection!.job!.id;
  await worker1.rpc('configure',{holdModel:true});const running=runJob('a',jobId,worker1).then(value=>({value}),error=>({error:(error as Error).message})),model=await worker1.barrier('model');
  const created=await create(two,'a','g-freeze-provider-'+randomUUID()),capture=await captureAnswer(two,'a',created.id,created.turn,true);capture.channel.ws.close();
  await two.rpc('configure',{hooks:[{phase:'raw-model',mode:'hold',once:true}]});
  const answering=mutate(two,'a',created.id,'answer-candidate',{turnId:created.turn.id,answerId:capture.answerId,captureRevision:1,elapsedMs:3500,
    submissionAttemptId:capture.finish.value.result.submissionAttemptId,endingObservation:{stopSource:'button',lastSpeechMs:2000,trailingSilenceMs:1000,speechActiveAtEnd:false,vadAvailable:true,microphoneEnabled:true}}).then(value=>({value}),error=>({error:(error as Error).message}));
  const raw=await two.barrier('raw-model'),before=(await sourceTransition.read(sourceContexts.get('a')!))!;assert.ok(before.activeOperations>=2);
  const {command,receipt}=await transition('a','freeze',{},'freeze-a-'+randomUUID());
  const same=await sourceTransition.command(sourceContexts.get('a')!,command,sourceOperators.get('a')!);assert.equal(same.operationId,receipt.operationId);assert.equal(same.replay,true);
  await assert.rejects(sourceTransition.command(sourceContexts.get('a')!,createTransitionCommand({...command,payloadJson:'{"conflict":true}'}),sourceOperators.get('a')!),/TRANSITION_IDEMPOTENCY_CONFLICT/u);
  await worker1.rpc('release',{barrierId:model.barrierId});await two.rpc('release',{barrierId:raw.barrierId});const late=await Promise.all([running,answering]);
  assert.equal((await sql('evaluation_results',id)).length,0);assert.equal((await sql('session_answer_facts',created.id)).length,0);
  const replay=await consume('a',id,consumeKey,two);assert.equal(replay.status,200,JSON.stringify(replay.value));assert.equal(replay.value.operationId,consumed.value.operationId);assert.equal(replay.value.replay,true);
  const blocked=await createRejected(two,'a','g-frozen-new-'+randomUUID());assert.equal(blocked.status,409);await assert.rejects(runJob('a',jobId,worker2));
  assert.equal((await sourceTransition.read(sourceContexts.get('a')!))!.state,'frozen');rows.push({caseId:'G-FREEZE-10',servers:[one.pid,two.pid],workerPid:worker1.pid,generationBefore:before.generation,generationAfter:generations.a,lateOutcomes:late,staleResults:0,staleAnswers:0,committedReceiptReplayed:true,freshAdmissionStatus:blocked.status});
});
async function createRejected(server:ServerChild,who:'a'|'b',key:string){return server.request(who,'/api/sessions',envelope(key,{revision:'0',writerGeneration:'1'},{}));}
test('G-RECOVERY-11 actual post-write C/D/E/F/G bytes restore to another DB/Storage endpoint; original endpoints denied and fresh execution disabled',{timeout:600_000},async()=>{
  const item=completed.get('b')!,before=await eview('b',item.id),source=await one.rpc<SessionCommandSnapshot>('snapshot',{who:'b',sessionId:item.id});assert.equal(before.projection!.state,'completed');
  await transition('b','freeze',{},'freeze-b-recovery');
  const result=await runIntegratedRecoveryCases({sourcePools:pools,restorePools,sourceContext:sourceContexts.get('b')!,restoreContext:restoreContexts.get('b')!,sourceTransition,restoreTransition,
    sourceOperator:()=>sourceOperators.get('b')!,restoreOperator:()=>restoreOperators.get('b')!,sourceProvider:provider,destinationProvider:nativeRestore,output,
    async readRestored(input){
      const db=new URL(process.env.PR07G_TEST_REQUEST_URL!),readonly=await new ServerChild('g-restored-readonly','restore','readonly',{...input,originalEndpoints:{database:{hostname:db.hostname,port:Number(db.port)||5432},storageOrigin:api}}).start();
      assert.equal(readonly.ready.mappingPoolPresent,false);assert.equal(readonly.ready.workerPoolPresent,false);assert.equal(readonly.ready.originalStorageCredentialsInherited,false);
      const blocked=await readonly.rpc<{counters:Record<string,number>}>('probe-source-endpoints');assert.ok(blocked.counters.originalDbDeniedAttempts>0);assert.ok(blocked.counters.originalStorageDeniedAttempts>0);
      const selections=[];
      for(const selection of ['current','pinned','historical']as const){const read=await readonly.rpc<{selection:'current'|'pinned'|'historical';artifacts:{artifactId:string;originalSha256:string;restoredSha256:string}[]}>('select-input',{who:'b',selection});for(const row of read.artifacts)selections.push({selection,originalSha256:row.originalSha256,restoredSha256:row.restoredSha256});}
      const restored=await readonly.rpc<SessionCommandSnapshot>('snapshot',{who:'b',sessionId:item.id});assert.equal(restored.sessionJson,source.sessionJson);assert.equal(restored.contextJson,source.contextJson);assert.equal(restored.pinsJson,source.pinsJson);assert.equal(restored.handoff!.payloadJson,source.handoff!.payloadJson);
      const eRows=await sql('session_command_keys',item.id),eKey=eRows[0],originalE=await one.request<Reply>('b',`/api/sessions/${item.id}/commands?key=${encodeURIComponent(String(eKey.key))}&inputSha256=${eKey.input_sha256}`);assert.equal(originalE.status,200,JSON.stringify(originalE.value));
      const eCommand=(await sql('session_commands',item.id)).find(row=>row.operation_id===eKey.operation_id)!;assert.equal(originalE.value.operationId,eCommand.operation_id);
      const replayE=await readonly.rpc<{resultJson:string;replay:boolean}>('replay-E',{who:'b',sessionId:item.id,key:eKey.key,inputSha256:eKey.input_sha256});
      const fRows=await sql('evaluation_command_receipts',item.id),fKey=fRows.find(row=>row.action==='consume')??fRows[0];assert.ok(fKey);
      const replayF=await readonly.rpc<{resultJson:string;replay:boolean}>('replay-F',{who:'b',key:fKey.key,inputSha256:fKey.input_sha256});
      const actual=await readonly.rpc<EvaluationProjection>('result',{who:'b',sessionId:item.id});assert.equal(actual.state,'completed');assert.deepEqual(actual.result,before.projection!.result);
      const response=await readonly.request('b','/api/sessions/'+item.id);assert.equal(response.status,200,JSON.stringify(response.value));
      // Use the destination's current generation, so the refusal proves the
      // read-only state rather than merely the stale source generation.
      const recoveredState=(await restoreTransition.read(restoreContexts.get('b')!))!;assert.equal(recoveredState.state,'read-only-recovery');
      const create=await readonly.request('b','/api/sessions',{version:'scoped-service-command-v1',expectedTransitionGeneration:recoveredState.generation,
        command:envelope('readonly-new-'+randomUUID(),{revision:'0',writerGeneration:'1'},{})});assert.equal(create.status,409);
      const freshGuards=['admit','session-write','review-write','worker-write']as const;
      for(const operation of freshGuards)await assert.rejects(restoreTransition.access(restoreContexts.get('b')!,operation),/TRANSITION_GENERATION_CHANGED/u);
      const disabled=await readonly.rpc<{counters:Record<string,number>}>('probe-disabled');const counters=disabled.counters;
      await readonly.stop();return {originalDbDeniedAttempts:counters.originalDbDeniedAttempts,originalStorageDeniedAttempts:counters.originalStorageDeniedAttempts,localFallbackReads:counters.localPrivateReads,selections,
        receipts:[{layer:'E',originalResultJson:String(eCommand.result_json),restoredResultJson:replayE.resultJson,replay:replayE.replay},{layer:'F',originalResultJson:String(fKey.result_json),restoredResultJson:replayF.resultJson,replay:replayF.replay}],
        results:[{originalJson:JSON.stringify(before.projection!.result),restoredJson:JSON.stringify(actual.result)}],freshWriteRejections:counters.freshWriteRejections+freshGuards.length,freshProviderCalls:counters.modelCalls,workerClaims:counters.workerClaims,
        currentDestinationGenerationUsed:recoveredState.generation,freshGuardOperationsDenied:[...freshGuards]};
    }});
  rows.push({caseId:'G-RECOVERY-11',status:result.status,manifestSha256:result.manifestSha256,objects:result.objects,bytes:result.bytes,readonlyOriginalEndpointsDenied:true,newWritableLocalReverseMigration:false,approvedRtoTarget:null,approvedRpoTarget:null});
});
