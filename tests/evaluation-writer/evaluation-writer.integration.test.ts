import { registerHandoffIntegrityCases } from './handoff-integrity-cases';
import { createControlledObjectProvider } from './controlled-object-provider';
import { registerPartialHeldCases } from './partial-held-cases';
import { registerAuthorityLineageCases } from './authority-lineage-cases';
import { exportJWK,generateKeyPair,SignJWT } from 'jose';
import { eAudience } from '../session-writer/d-preparation';
import { supplySigner,supplyRecordBundle,supplyReviewer } from '../fixtures/evaluation-supply';
import { sealBankScopeRegistry,type BankEvaluationScopeRegistry } from '../../server/data/evaluation-scope-registry';
import { snapshotHash } from '../../server/session-runtime';
import type { EvaluationProjection,EvaluationPreservationBundle } from '../../server/evaluation-writer/evaluation-writer-ports';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn,type ChildProcess } from 'node:child_process';
import { writeFile,mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash,randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createSupabaseObjectProvider } from '../../server/storage/supabase-object-provider';
import type { ObjectStorageProvider,StorageObjectRef } from '../../server/storage/private-object-ports';
import type { RecordedTurn,InterviewSession } from '../../server/protocol';
import type { SessionCommandSnapshot } from '../../server/session-writer/session-command-ports';
import { testPools,closePools } from './evaluation-writer-test-database';
import { loadOwnedPublicDFixture,seedPublicDOuterScope,importPublicDContexts } from '../session-writer/d-preparation';

const phaseTrace:Record<string,unknown>[]=[];
const tracePhase=(event:string,detail:Record<string,unknown>={})=>{phaseTrace.push({utc:new Date().toISOString(),monotonicMs:performance.now(),event,...detail});if(['wait-start','wait-resolved','http-start','http-result','rpc-start','rpc-result'].includes(event))process.stderr.write('# F phase '+event+' '+JSON.stringify(detail)+'\n');};
const diagnostic=process.env.PR07F_TEST_CONTROLLED_PROVIDER_DIAGNOSTIC==='1';
if(diagnostic&&process.env.GITHUB_ACTIONS==='true')throw new Error('PR07F_CI_REQUIRES_OFFICIAL_STORAGE');
const data=await loadOwnedPublicDFixture(),pools=testPools(1),restorePools=testPools(1,'restore');
const jwtKeys=await generateKeyPair('ES256'),jwk={...await exportJWK(jwtKeys.publicKey),kid:'pr07f-owned-jwt',alg:'ES256'};
const signing={jwk,async token(who:'a'|'b',subject='shared'){return new SignJWT().setProtectedHeader({alg:'ES256',kid:jwk.kid}).setIssuer(`https://issuer-${who}.example`).setSubject(subject).setAudience(eAudience).setIssuedAt().setExpirationTime('2h').sign(jwtKeys.privateKey);}};
const tokens:Record<string,string>={};
for(const who of ['a','b'] as const){tokens[who]=await signing.token(who);for(const role of ['reviewer','specreviewer','operator','worker1','worker2'])tokens[who+role]=await signing.token(who,'f-'+who+'-'+role);}
const api=process.env.PR07F_TEST_STORAGE_API_URL,credential=process.env.PR07F_TEST_STORAGE_SERVICE_KEY,bucket=process.env.PR07F_TEST_BUCKET,prefix=process.env.PR07F_TEST_KEY_PREFIX;
if(!api||!credential||!bucket||!prefix)throw new Error('PR07F_EXPLICIT_STORAGE_REQUIRED');
const providerIo={read:0,upload:0,copy:0,remove:0};
const actual:ObjectStorageProvider=diagnostic?createControlledObjectProvider():
  createSupabaseObjectProvider({apiUrl:api,serviceCredential:credential,bucket,keyPrefix:prefix,allowLoopbackHttp:true});
const provider:ObjectStorageProvider={read(ref,options){providerIo.read++;return actual.read(ref,options);},upload(ref,body,options){providerIo.upload++;return actual.upload(ref,body,options);},copy(from,to,options){providerIo.copy++;return actual.copy(from,to,options);},remove(ref,options){providerIo.remove++;return actual.remove(ref,options);}};
const rows:Record<string,unknown>[]=[],children:ServerChild[]=[],snapshots:Record<string,unknown>[]=[];
let imported!:Awaited<ReturnType<typeof importPublicDContexts>>,one:ServerChild,worker1:ServerChild,worker2:ServerChild;
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
interface Reply<R=Record<string,unknown>>{version:string;operationId:string;revision:string;writerGeneration:string;key:string;inputSha256:string;replay:boolean;result:R}
interface View {sessionId:string;revision:string;writerGeneration:string;status:string;evaluationStatus:string;writer:string;contextSnapshotSha256:string;recovery:{epoch:number;phase:string;currentTurn:RecordedTurn|null;transcript:string;transcriptStatus:string|null;captureRevision:number};evaluationHandoff:{state:string;intentId:string;payloadSha256:string}|null;evaluationJob:null}
interface Barrier {type:'barrier';barrierId:string;phase:string;detail:{action?:string;sessionId?:string;key?:string;operationId?:string}}
type Message=Record<string,unknown>;
class ServerChild {
  process:ChildProcess;port=0;pid=0;name:string;database:'primary'|'restore';ready:Message={};logs='';messages:Message[]=[];
  lastPhase:Message|null=null;lastIpc:Array<{type:unknown;phase?:unknown;utc:string}>=[];
  pending=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  constructor(name:string,database:'primary'|'restore'='primary',readonly kind:'service'|'worker'|'readonly'='service'){
    this.name=name;this.database=database;
    const env:NodeJS.ProcessEnv={...process.env,NODE_ENV:'test',INTERVIEW_EXECUTION_MODE:'service',NODE_OPTIONS:''};
    for(const key of Object.keys(env)){
      if(!key.startsWith('PR07F_TEST_')&&/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DATABASE_URL|POSTGRES_URL|SUPABASE_URL|STORAGE_URL/u.test(key))delete env[key];
      if(/^PR07[BCDE]_TEST_/u.test(key)&&/URL|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/u.test(key))delete env[key];
      if(/^PR07F_TEST_(?:(?:RESTORE_)?(?:ADMIN|BYPASS)_URL|BOOTSTRAP_URL)$/u.test(key))delete env[key];
      if((kind==='worker'||kind==='readonly')&&/^PR07F_TEST_(?:(?:RESTORE_)?MAPPING_URL|STORAGE_SERVICE_KEY|STORAGE_ANON_KEY)$/u.test(key))delete env[key];
      if(kind!=='worker'&&/^PR07F_TEST_(?:RESTORE_)?WORKER_URL$/u.test(key))delete env[key];
      if(/^PR07F_TEST_(?:RESTORE_)?(?:REQUEST|MAPPING|WORKER)_URL$/u.test(key)&&key.includes('_RESTORE_')!==(database==='restore'))delete env[key];
    }
    // Reused E D-preparation needs only explicit owned fixture/storage aliases.
    if(kind==='service')for(const suffix of ['DISPOSABLE','RUN_ID','FIXTURE_ROOT','BASELINE_RESULT','BASELINE_CODE_ROOT','STORAGE_API_URL','STORAGE_SERVICE_KEY','STORAGE_ANON_KEY','BUCKET','KEY_PREFIX'])if(env['PR07F_TEST_'+suffix]!==undefined)env['PR07E_TEST_'+suffix]=env['PR07F_TEST_'+suffix];
    this.process=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL(kind==='worker'?'./evaluation-worker-child.ts':kind==='readonly'?'./evaluation-readonly-child.ts':'./evaluation-service-child.ts',import.meta.url))],{cwd:process.cwd(),env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
    this.process.stdout!.on('data',bytes=>{this.logs+=String(bytes);});this.process.stderr!.on('data',bytes=>{this.logs+=String(bytes);});
    this.process.on('message',(raw:Message)=>{
      this.lastIpc.push({type:raw.type,phase:raw.phase,utc:new Date().toISOString()});if(this.lastIpc.length>12)this.lastIpc.shift();
      if(raw.type==='phase'){this.lastPhase=raw;tracePhase('child-phase',{server:this.name,childPid:this.process.pid,phase:raw.phase,detail:raw.detail,childUtc:raw.utc,childMonotonicMs:raw.monotonicMs});return;}
      if(raw.type==='object-read'){void provider.read(raw.ref as StorageObjectRef,{signal:AbortSignal.timeout(15_000),maxBytes:32*1024*1024}).then(body=>this.process.send?.({type:'object-result',requestId:raw.requestId,bytes:body.toString('base64')}),()=>this.process.send?.({type:'object-result',requestId:raw.requestId,error:'missing'}));return;}
      if(raw.type==='control-result'){
        tracePhase('rpc-result',{server:this.name,childPid:this.process.pid,requestId:raw.requestId,errorCode:(raw.error as {code?:string}|undefined)?.code});
        const pending=this.pending.get(String(raw.requestId));if(pending){clearTimeout(pending.timer);this.pending.delete(String(raw.requestId));if(raw.error)pending.reject(Object.assign(new Error((raw.error as {code:string}).code),{code:(raw.error as {code:string}).code}));else pending.resolve(raw.result);}return;
      }
      this.messages.push(raw);
    });
    this.process.once('exit',()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('PR07F_CHILD_EXITED'));}this.pending.clear();});
    children.push(this);
  }
  async wait(predicate:(value:Message)=>boolean,timeout=30_000,phase='unspecified'):Promise<Message>{
    const started=performance.now();tracePhase('wait-start',{server:this.name,childPid:this.process.pid,phase,timeoutMs:timeout});
    const found=this.messages.findIndex(predicate);if(found>=0){tracePhase('wait-resolved',{server:this.name,childPid:this.process.pid,phase,elapsedMs:performance.now()-started,buffered:true});return this.messages.splice(found,1)[0];}
    return new Promise((resolve,reject)=>{
      const deadline=setTimeout(()=>{const evidence={server:this.name,pid:this.process.pid,phase,timeoutMs:timeout,elapsedMs:performance.now()-started,lastPhase:this.lastPhase,lastIpc:this.lastIpc};tracePhase('wait-timeout',evidence);cleanup();reject(new Error('PR07F_CHILD_MESSAGE_TIMEOUT:'+JSON.stringify(evidence)+':'+this.logs.slice(-2000)));},timeout);
      const message=(value:Message)=>{if(predicate(value)){tracePhase('wait-resolved',{server:this.name,childPid:this.process.pid,phase,elapsedMs:performance.now()-started,type:value.type});cleanup();const index=this.messages.indexOf(value);if(index>=0)this.messages.splice(index,1);resolve(value);}};
      const exit=()=>{cleanup();reject(new Error('PR07F_CHILD_EXIT_BEFORE_MESSAGE:'+this.logs.slice(-2000)));};
      const cleanup=()=>{clearTimeout(deadline);this.process.off('message',message);this.process.off('exit',exit);};
      this.process.on('message',message);this.process.once('exit',exit);
    });
  }
  async start(){
    await this.wait(m=>m.type==='boot',30_000,'boot');
    this.process.send?.({type:'initialize',requestId:randomUUID(),name:this.name,database:this.database,fixtureRoot:data.root,fixture:data.fixture,jwk:signing.jwk,tokens,
      runIds:Object.fromEntries([...imported.inventories.values()].map(v=>[v.plan.ownerId,v.plan.runId])),controlledProvider:diagnostic});
    const ready=await this.wait(m=>m.type==='ready',120_000,'ready');this.ready=ready;this.port=Number(ready.port);this.pid=Number(ready.pid);assert.ok(this.pid>0&&(this.kind==='worker'||this.port>0));return this;
  }
  rpc<T=Record<string,unknown>>(operation:string,payload:Record<string,unknown>={}):Promise<T>{
    const requestId=randomUUID(),started=performance.now();tracePhase('rpc-start',{server:this.name,childPid:this.process.pid,operation,requestId});return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{tracePhase('rpc-timeout',{server:this.name,childPid:this.process.pid,operation,requestId,timeoutMs:30_000,elapsedMs:performance.now()-started,lastPhase:this.lastPhase});this.pending.delete(requestId);reject(new Error('PR07F_CONTROL_TIMEOUT:'+operation));},30_000);
      this.pending.set(requestId,{resolve:value=>resolve(value as T),reject,timer});this.process.send?.({type:'control',requestId,operation,payload});});
  }
  async barrier(phase:string,key?:string){return await this.wait(m=>m.type==='barrier'&&m.phase===phase&&(!key||(m.detail as Barrier['detail']).key===key),30_000,'barrier:'+phase) as unknown as Barrier;}
  get base(){return 'http://127.0.0.1:'+this.port;}
  async request<T=Record<string,unknown>>(who:string,route:string,input?:unknown,signal?:AbortSignal){
    tracePhase('http-start',{server:this.name,childPid:this.pid,route,key:(input as {key?:string}|undefined)?.key});
    const sep=route.includes('?')?'&':'?',response=await fetch(this.base+route+sep+'applicationTargetId=shadow-app-'+(who.startsWith('b')?'b':'a'),{method:input===undefined?'GET':'POST',headers:{Authorization:'Bearer '+tokens[who],Origin:this.base,'Content-Type':'application/json'},
      ...(input===undefined?{}:{body:JSON.stringify(input)}),signal:signal??AbortSignal.timeout(120_000),redirect:'error'});
    const value=await response.json() as T;tracePhase('http-result',{server:this.name,childPid:this.pid,route,status:response.status});return {status:response.status,value,headers:response.headers};
  }
  async stop(force=false){if(this.process.exitCode!==null||this.process.signalCode!==null)return;
    if(!force)try{await this.rpc('stop');}catch{/* exit evidence below remains authoritative */}
    if(this.process.exitCode===null&&this.process.signalCode===null){const exited=new Promise<void>(resolve=>this.process.once('exit',()=>resolve()));this.process.kill(force?'SIGKILL':'SIGTERM');await exited;}
  }
}
const envelope=(key:string,view:Pick<View,'revision'|'writerGeneration'>,payload:unknown,resume=false)=>({version:'authenticated-session-command-v1',key,expectedRevision:view.revision,writerGeneration:view.writerGeneration,...(resume?{resume:true}:{}),payload});
async function create(server:ServerChild,who:'a'|'b',key:string){const request=envelope(key,{revision:'0',writerGeneration:'1'},{}),reply=await server.request<Reply<{sessionId:string;turn:RecordedTurn}>>(who,'/api/sessions',request);assert.equal(reply.status,201,JSON.stringify(reply.value));return {request,reply:reply.value,id:reply.value.result.sessionId,turn:reply.value.result.turn};}
async function view(server:ServerChild,who:'a'|'b',id:string){const result=await server.request<View>(who,'/api/sessions/'+id);assert.equal(result.status,200,JSON.stringify(result.value));return result.value;}
async function mutate<R=Record<string,unknown>>(server:ServerChild,who:'a'|'b',id:string,action:string,payload:unknown,key:string=randomUUID(),resume=false){const current=await view(server,who,id);const input=envelope(key,current,payload,resume),response=await server.request<Reply<R>>(who,`/api/sessions/${id}/${action}`,input);return {...response,input};}
async function socket(server:ServerChild,who:'a'|'b',id:string){
  const ticket=await server.request<{ticket:string}>(who,`/api/sessions/${id}/realtime-ticket`,{});assert.equal(ticket.status,200);
  const ws=new WebSocket(`ws://127.0.0.1:${server.port}/api/realtime?sessionId=${id}&ticket=${ticket.value.ticket}`,{origin:server.base});
  const messages:Record<string,unknown>[]=[];ws.on('message',body=>messages.push(JSON.parse(body.toString())));
  await new Promise<void>((resolve,reject)=>{ws.once('open',()=>resolve());ws.once('error',reject);});
  const wait=async(predicate:(v:Record<string,unknown>)=>boolean)=>{
    const found=messages.findIndex(predicate);if(found>=0)return messages.splice(found,1)[0];
    const errors=()=>messages.filter(m=>m.type==='error').map(m=>({type:m.type,code:m.code,status:m.status,action:m.action}));
    if(errors().length)throw new Error('PR07F_SOCKET_COMMAND_ERROR:'+JSON.stringify(errors()));
    return new Promise<Record<string,unknown>>((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(new Error('PR07F_SOCKET_MESSAGE_TIMEOUT:'+JSON.stringify(messages.map(m=>({type:m.type,action:m.action,status:m.status,code:m.code})))));},15_000);
      const receive=(body:Buffer)=>{const value=JSON.parse(body.toString());if(predicate(value)){cleanup();const i=messages.findIndex(m=>m.type===value.type&&m.action===value.action);if(i>=0)messages.splice(i,1);resolve(value);}else if(value.type==='error'){cleanup();reject(new Error('PR07F_SOCKET_COMMAND_ERROR:'+JSON.stringify({code:value.code,status:value.status,action:value.action})));}};
      const closed=()=>{cleanup();reject(new Error('PR07F_SOCKET_CLOSED:'+JSON.stringify(errors())));};const cleanup=()=>{clearTimeout(timer);ws.off('message',receive);ws.off('close',closed);};ws.on('message',receive);ws.once('close',closed);});
  };
  const ready=await wait(m=>m.type==='ready');assert.equal(ready.readOnly,false);return {ws,wait,messages,ready};
}
async function captureAnswer(server:ServerChild,who:'a'|'b',id:string,turn:RecordedTurn,staged=false,reuseAnswerId?:string){
  const channel=await socket(server,who,id),answerId=reuseAnswerId??randomUUID(),current=await view(server,who,id),captureRevision=(current.recovery.captureRevision??0)+1;
  const start=envelope(randomUUID(),current,{turnId:turn.id,answerId,captureRevision,staged});channel.ws.send(JSON.stringify({type:'command',action:'capture-start',command:start}));
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

test.before(async()=>{
  await seedPublicDOuterScope(pools,data.fixture);await seedPublicDOuterScope(restorePools,data.fixture);
  for(const database of [pools,restorePools])for(const who of ['a','b'])for(const role of ['reviewer','specreviewer','operator','worker1','worker2'])await database.admin.query('INSERT INTO gakja.principals(issuer,subject,account_id) VALUES($1,$2,$3)',[`https://issuer-${who}.example`,'f-'+who+'-'+role,'account-'+who]);
  imported=await importPublicDContexts(pools,signing,data.root,data.fixture,provider);
  [one,worker1,worker2]=await Promise.all([new ServerChild('service').start(),new ServerChild('worker-one','primary','worker').start(),new ServerChild('worker-two','primary','worker').start()]);
  assert.notEqual(worker1.pid,worker2.pid);assert.notEqual(worker1.pid,one.pid);
  for(const worker of [worker1,worker2]){assert.deepEqual(worker.ready.roles,{request:'gakja_request',worker:'gakja_worker'});assert.equal(worker.ready.mappingPoolPresent,false);assert.equal(worker.ready.privilegedCredentialsInherited,false);assert.equal(worker.ready.storageCredentialsInherited,false);}
  rows.push({caseId:'F-ENV',service:one.ready,workers:[worker1.ready,worker2.ready],actualPostgreSQL:true,storageEngine:diagnostic?'controlled-body-diagnostic-NOT-official-Storage':'official-Supabase-Storage-REST',baselineCodeCommit:data.baseline.codeCommit});
},{timeout:600_000});

test.after(async()=>{
  const states:Record<string,unknown>[]=[];for(const child of children)if(child.process.exitCode===null&&child.process.signalCode===null)try{states.push({name:child.name,kind:child.kind,...await child.rpc('state')});}catch{/* Killed processes have explicit case evidence. */}
  for(const child of children)await child.stop();
  let cleanup:{complete:boolean;errorCode?:string}={complete:false};try{if(imported){await imported.cleanup();cleanup={complete:true};}}catch(error){cleanup={complete:false,errorCode:(error as {code?:string}).code??(error as Error).message};}
  await closePools(pools);await closePools(restorePools);
  const output=process.env.PR07F_TEST_OUTPUT??'artifacts/pr07f';await mkdir(output,{recursive:true});
  for(const child of children)await writeFile(path.join(output,`child-${child.name}-${child.pid||child.process.pid}.log`),child.logs);
  await writeFile(path.join(output,'evaluation-writer-cases.json'),JSON.stringify({version:'pr07f-actual-service-two-worker-v1',rows,states,snapshots,workerProcesses:[worker1?.ready,worker2?.ready],twoIndependentWorkers:!!worker1?.pid&&!!worker2?.pid&&worker1.pid!==worker2.pid,paidProviderCalls:0,actualStudentDataTransferred:false,cleanup,providerIo,source:{baselineCodeCommit:data.baseline.codeCommit}},null,2)+'\n');
  await writeFile(path.join(output,'phase-trace.json'),JSON.stringify({version:'pr07f-service-worker-phase-trace-v1',rows:phaseTrace},null,2)+'\n');
  assert.equal(cleanup.complete,true);
  for(const state of states){const counters=state.counters as Record<string,number>;for(const key of ['localDataReadAttempts','localSessionWriteAttempts','externalNetworkAttempts','localFileWrites','localPrivateReads','paidProviderCalls'])assert.equal(counters[key]??0,0,key);}
});

test('F-HTTP-01 actual E HTTP/WSS end preserves an immutable handoff and persists review-required without jobs or provider calls',{timeout:240_000},async()=>{
  for(const who of ['a','b'] as const){const id=await endedHttp(who),key=randomUUID(),first=await consume(who,id,key);assert.equal(first.status,200,JSON.stringify(first.value));const replay=await consume(who,id,key);assert.equal(replay.status,200);assert.equal(replay.value.replay,true);assert.equal(replay.value.operationId,first.value.operationId);
    const current=await eview(who,id);assert.equal(current.projection!.state,'review_required');assert.equal(current.projection!.job,null);assert.equal(current.projection!.result,null);assert.equal((await sql('evaluation_jobs',id)).length,0);
    assertFrozen(await one.rpc<SessionCommandSnapshot>('snapshot',{who,sessionId:id}),immutable.get(id)!);completed.set(who,{id,jobId:'',result:null});rows.push({caseId:'F-HTTP-01-'+who,id,reviewRequiredDurable:true,runnableJobs:0,modelCalls:0,handoffUnchanged:true});}
  for(const worker of [worker1,worker2])assert.equal(((await worker.rpc('state')).counters as {modelCalls:number}).modelCalls,0);
});

test('F-SUPPLY-02 separate trusted reviewer publishes exact A and B; two independent workers process separate owners through the actual evaluator',{timeout:240_000},async()=>{
  for(const who of ['a','b'] as const){const value=completed.get(who)!,id=value.id;await installTrust(who);
    const forbidden=await fcommand(who,id,'registry',{registryJson:'{}',receiptJson:'{}'});assert.equal(forbidden.status,403,JSON.stringify(forbidden.value));await publishA(who,id);
    const specCannotSupply=await fcommand(who+'specreviewer',id,'approval',{bundleJson:'{}',reviewJson:'{}'});assert.equal(specCannotSupply.status,403);
    const aOnly=await consume(who,id);assert.equal(aOnly.status,200);assert.equal((await eview(who,id)).projection!.job,null);
    const invalid=await publishB(who,id,payload=>{const envelope=JSON.parse(String(payload.reviewJson));envelope.receipt.signature='invalid';payload.reviewJson=JSON.stringify(envelope);});assert.equal(invalid.status,409,JSON.stringify(invalid.value));
    const supplied=await publishB(who,id);assert.equal(supplied.status,200,JSON.stringify(supplied.value));
    const key=randomUUID(),registered=await consume(who,id,key);assert.equal(registered.status,200,JSON.stringify(registered.value));const view=await eview(who,id);value.jobId=view.projection!.job!.id;assert.equal(view.projection!.state,'queued');
    const duplicate=await consume(who,id);assert.equal(duplicate.status,200);assert.equal((await sql('evaluation_jobs',id)).length,1);
  }
  const results=await Promise.all([runJob('a',completed.get('a')!.jobId,worker1),runJob('b',completed.get('b')!.jobId,worker2)]);
  for(const [index,who]of (['a','b'] as const).entries()){assert.equal(results[index].job?.status,'completed',JSON.stringify(results[index]));const item=completed.get(who)!,current=await eview(who,item.id);assert.equal(current.projection!.state,'completed');assert.ok(current.projection!.result);item.result=current.projection!.result;
    assertFrozen(await one.rpc<SessionCommandSnapshot>('snapshot',{who,sessionId:item.id}),immutable.get(item.id)!);assert.equal((await sql('evaluation_results',item.id)).length,1);assert.equal((await one.request(who==='a'?'b':'a',epath(item.id))).status,404);
    const replay=await runJob(who,item.jobId,who==='a'?worker2:worker1);assert.equal(replay.processed,false);rows.push({caseId:'F-SUPPLY-02-'+who,separateReviewer:true,separateABKeysAndPrincipals:true,questionApprovalDidNotApproveEvaluation:true,actualEvaluator:true,result:current.projection!.result,immutableE:true});}
});

test('F-RACE-03 two consumers and two workers retain one logical job and result; changed same-key input is refused',{timeout:240_000},async()=>{
  const id=await endedHttp('a');await publishA('a',id);assert.equal((await publishB('a',id)).status,200);
  const key=randomUUID(),consumed=await Promise.all([consume('a',id,key),consume('a',id,key)]);assert.deepEqual(consumed.map(v=>v.status),[200,200]);assert.equal(consumed[0].value.operationId,consumed[1].value.operationId);
  const current=await eview('a',id),jobId=current.projection!.job!.id;const collision=await fcommand('a',id,'consume',{handoffPayloadSha256:'0'.repeat(64),approvalSha256:current.control.approvalSha256},key);assert.equal(collision.status,409);
  const grant1=await dispatch('a',jobId,worker1),grant2=await dispatch('a',jobId,worker2);await worker1.rpc('configure',{holdModel:true});const first=worker1.rpc('run',grant1),barrier=await worker1.barrier('model');
  const before=await worker2.rpc('state'),second=await worker2.rpc<{processed:boolean}>('run',grant2);assert.equal(second.processed,false);assert.equal(((await worker2.rpc('state')).counters as {modelCalls:number}).modelCalls,(before.counters as {modelCalls:number}).modelCalls);
  const probe=await worker1.rpc<{request:{pid:number};worker:{pid:number}}>('probe-database');const activities=await pools.admin.query('SELECT pid,xact_start FROM pg_stat_activity WHERE pid=ANY($1::int[])',[[probe.request.pid,probe.worker.pid]]);assert.equal(activities.rows.length,2);assert.ok(activities.rows.every(row=>row.xact_start===null));
  await worker1.rpc('release',{barrierId:barrier.barrierId});const finished=await first;assert.equal((finished.job as {status:string}).status,'completed',JSON.stringify(finished));await worker1.rpc('configure',{});
  assert.equal((await sql('evaluation_jobs',id)).length,1);assert.equal((await sql('evaluation_results',id)).length,1);rows.push({caseId:'F-RACE-03',workerPids:[worker1.pid,worker2.pid],jobId,logicalJobs:1,resultRows:1,modelAwaitTransactions:0,sameKeyConflict:409});
});

test('F-REVOKE-04 withdrawal during raw model I/O prevents completion while retaining original result history',{timeout:240_000},async()=>{
  const id=await endedHttp('a');await publishA('a',id);assert.equal((await publishB('a',id)).status,200);assert.equal((await consume('a',id)).status,200);const current=await eview('a',id),jobId=current.projection!.job!.id;
  await worker1.rpc('configure',{holdModel:true});const pending=runJob('a',jobId,worker1),barrier=await worker1.barrier('model');const withdrawn=await fcommand('areviewer',id,'withdraw',{reason:'Explicit synthetic race withdrawal'});assert.equal(withdrawn.status,200,JSON.stringify(withdrawn.value));
  await worker1.rpc('release',{barrierId:barrier.barrierId});await pending.catch(error=>({code:(error as Error).message}));await worker1.rpc('configure',{});assert.equal((await sql('evaluation_results',id)).length,0);assert.equal((await eview('a',id)).projection!.state,'review_required');
  const old=completed.get('a')!,before=await sql('evaluation_results',old.id);assert.equal((await fcommand('areviewer',old.id,'withdraw',{reason:'Public historical result remains immutable'})).status,200);
  const currentOld=await eview('a',old.id);assert.equal(currentOld.projection!.result,null);const history=await one.request<EvaluationProjection&{resultIsHistorical:boolean}>('a',epath(old.id,'revision')+'?jobId='+old.jobId);assert.equal(history.status,200,JSON.stringify(history.value));assert.equal(history.value.resultIsHistorical,true);assert.deepEqual(history.value.result,old.result);assert.deepEqual(await sql('evaluation_results',old.id),before);
  rows.push({caseId:'F-REVOKE-04',modelRaceResultRows:0,currentProjection:'review_required',historicalBytesPreserved:true});
});

registerAuthorityLineageCases({one:()=>one,worker1:()=>worker1,endedHttp,publishA,publishB,consume,eview,runJob,sql,pools,completed,rows,epath});

test('F-LOSS-07 process death after consumer commit and worker completion replays persisted receipts and results without a second publication',{timeout:300_000},async()=>{
  const id=await endedHttp('a');await publishA('a',id);assert.equal((await publishB('a',id)).status,200);
  const crash=await new ServerChild('consume-response-loss').start(),key=randomUUID();await crash.rpc('configure',{hooks:[{phase:'after-consume',key,mode:'hold',once:true}]});
  const consuming=consume('a',id,key,crash).then(value=>({value}),error=>({error:(error as Error).message}));await crash.barrier('after-consume',key);
  const registered=await eview('a',id),jobId=registered.projection!.job!.id,receipt=(await sql('evaluation_command_receipts',id)).find(row=>row.key===key);assert.ok(receipt);
  const oldServicePid=crash.pid;await crash.stop(true);const lost=await consuming;assert.ok('error'in lost);
  const restart=await new ServerChild('consume-response-restarted').start(),replay=await consume('a',id,key,restart);assert.equal(replay.status,200);assert.equal(replay.value.replay,true);assert.equal(replay.value.operationId,receipt.operation_id);
  const lostWorker=await new ServerChild('result-response-loss','primary','worker').start();await lostWorker.rpc('configure',{holdAfterWorker:true});
  const grant=await dispatch('a',jobId,worker1),running=lostWorker.rpc('run',{...grant,who:'aworker1'}).then(value=>({value}),error=>({error:(error as Error).message}));
  await lostWorker.barrier('after-worker');const completedBefore=(await eview('a',id)).projection!;assert.equal(completedBefore.state,'completed');const exactResults=await sql('evaluation_results',id),exactRevisions=await sql('evaluation_result_revisions',id);await lostWorker.stop(true);assert.ok('error'in await running);
  const replayRun=await runJob('a',jobId,worker2);assert.equal(replayRun.processed,false);assert.deepEqual(await sql('evaluation_results',id),exactResults);assert.deepEqual(await sql('evaluation_result_revisions',id),exactRevisions);
  rows.push({caseId:'F-LOSS-07',oldServicePid,restartedServicePid:restart.pid,killedWorkerPid:lostWorker.pid,consumeReceiptReplayed:true,logicalJobs:1,resultRows:1,resultRevisionRows:1});await restart.stop();
});

test('F-LEASE-08 killing an actual worker allows DB-clock expiration and reassignment to a different process',{timeout:240_000},async()=>{
  const id=await endedHttp('a');await publishA('a',id);assert.equal((await publishB('a',id)).status,200);assert.equal((await consume('a',id)).status,200);const jobId=(await eview('a',id)).projection!.job!.id;
  const killed=await new ServerChild('lease-killed','primary','worker').start();await killed.rpc('configure',{holdModel:true});const grant=await dispatch('a',jobId,worker1);
  const pending=killed.rpc('run',{...grant,leaseMs:1500}).then(value=>({value}),error=>({error:(error as Error).message}));await killed.barrier('model');const old=await eview('a',id),oldToken=old.projection!.job!.lease!.token;const killedPid=killed.pid;await killed.stop(true);assert.ok('error'in await pending);
  const expiration=await until(async()=>{const query=await pools.admin.query('SELECT lease_until,clock_timestamp() now,lease_until<=clock_timestamp() expired FROM gakja.evaluation_jobs WHERE job_id=$1',[jobId]);return query.rows[0];},row=>row.expired===true);assert.ok(expiration.expired);
  const reassigned=await runJob('a',jobId,worker2);assert.equal(reassigned.job?.status,'completed',JSON.stringify(reassigned));const result=(await eview('a',id)).projection!;assert.equal(result.job!.attempts,2);assert.notEqual(result.job!.lease?.token,oldToken);assert.equal((await sql('evaluation_results',id)).length,1);
  rows.push({caseId:'F-LEASE-08',killedPid,reassignedPid:worker2.pid,actualDatabaseClockExpired:true,attempts:2,oneResult:true});
});

test('F-END-09 actual E ordered tail drain survives a service restart before F consumes the frozen input',{timeout:300_000},async()=>{
  await one.rpc('configure',{provider:{transcript:'종료 직전 보존할 합성 원문입니다.',confirmed:true}});
  const created=await create(one,'a','f-drain-'+randomUUID()),channel=await socket(one,'a',created.id),answerId=randomUUID(),head=await view(one,'a',created.id);
  channel.ws.send(JSON.stringify({type:'command',action:'capture-start',command:envelope(randomUUID(),head,{turnId:created.turn.id,answerId,captureRevision:1})}));await channel.wait(m=>m.type==='command_result'&&m.action==='capture-start');channel.ws.send(Buffer.alloc(320,1));
  const input=envelope(randomUUID(),await view(one,'a',created.id),{elapsedMs:12000,metrics:{answerId,durationMs:12000,captureFinishScope:{turnId:created.turn.id,answerId,captureRevision:1}}}),pending=one.request<Reply>('a',`/api/sessions/${created.id}/end`,input);
  await until(()=>sql('session_end_intents',created.id),values=>values.length===1);
  channel.ws.send(Buffer.alloc(160,2));channel.ws.send(JSON.stringify({type:'command',action:'capture-finish',command:envelope(randomUUID(),{revision:input.expectedRevision,writerGeneration:input.writerGeneration},{turnId:created.turn.id,answerId,captureRevision:1})}));await channel.wait(m=>m.type==='command_result'&&m.action==='capture-finish');assert.equal((await pending).status,202);channel.ws.close();
  const frozen=await one.rpc<SessionCommandSnapshot>('snapshot',{who:'a',sessionId:created.id}),raw=JSON.parse(frozen.sessionJson) as InterviewSession;assert.equal(raw.turns.at(-1)!.rawTranscript,'종료 직전 보존할 합성 원문입니다.');
  const restarted=await new ServerChild('end-handoff-restarted').start();const replay=await restarted.request('a',`/api/sessions/${created.id}/end`,input);assert.equal(replay.status,202);await publishA('a',created.id);assert.equal((await publishB('a',created.id)).status,200);assert.equal((await consume('a',created.id,randomUUID(),restarted)).status,200);const jobId=(await eview('a',created.id)).projection!.job!.id;assert.equal((await runJob('a',jobId)).job?.status,'completed');assertFrozen(await restarted.rpc<SessionCommandSnapshot>('snapshot',{who:'a',sessionId:created.id}),frozen);assert.equal((await sql('session_evaluation_handoffs',created.id)).length,1);await restarted.stop();
  rows.push({caseId:'F-END-09',actualEHttpWssDrain:true,tailBytes:160,endInputReplayedOnNewPid:true,immutableFrozenBytes:true,handoffs:1,actualFWorker:true});
});

registerPartialHeldCases({one:()=>one,worker1:()=>worker1,installTrust,eview,publishA,publishB,consume,runJob,sql,rows,epath,signReceipt:(who,payload)=>signers[who].receipt(payload)});

test('F-RESTORE-12 completed real E/F input, reviews and results restore read-only and remain readable over HTTP without Storage credentials',{timeout:300_000},async()=>{
  const item=completed.get('b')!,before=await eview('b',item.id),source=await one.rpc<SessionCommandSnapshot>('snapshot',{who:'b',sessionId:item.id});assert.equal(before.projection!.state,'completed');
  await one.rpc('f-freeze',{who:'boperator',sessionId:item.id,expectedFence:before.control.fence});
  const bundle=await one.rpc<EvaluationPreservationBundle>('f-export',{who:'boperator',sessionId:item.id});assert.equal(hash(bundle.payloadJson),bundle.sha256);const archive=JSON.parse(bundle.payloadJson);
  assert.equal(Object.keys(archive.fTables).length,14);assert.equal(archive.manifest.length,14);assert.equal(archive.eSession.session.session_json,source.sessionJson);assert.equal(archive.eSession.session.context_json,source.contextJson);
  assert.equal(hash(archive.sourceDependenciesJson),archive.sourceDependenciesSha256);assert.deepEqual(archive.newResultObjects,[]);
  const dependencies=JSON.parse(archive.sourceDependenciesJson) as {state:string;objects:Array<{bucket:string;key:string;bytes:string;sha256:string}>};assert.equal(dependencies.state,'pinned-D-manifest');assert.ok(dependencies.objects.length>0);
  for(const reference of dependencies.objects){
    const expectedBytes=Number(reference.bytes);
    assert.ok(Number.isSafeInteger(expectedBytes)&&expectedBytes>0&&expectedBytes<=16*1024*1024,'Public source fixture must fit the retained provider limit');
    const bytes=await provider.read({bucket:reference.bucket,key:reference.key},{maxBytes:expectedBytes,signal:AbortSignal.timeout(15_000)});
    assert.equal(bytes.length,expectedBytes);assert.equal(hash(bytes),reference.sha256);
  }
  const restoring=await new ServerChild('restore-mapping','restore').start();await restoring.rpc('f-restore',{who:'boperator',sessionId:item.id,bundle});const restored=await restoring.rpc<SessionCommandSnapshot>('snapshot',{who:'b',sessionId:item.id});assert.equal(restored.writer,'read-only');assert.equal(restored.sessionJson,source.sessionJson);assert.equal(restored.contextJson,source.contextJson);assert.equal(restored.pinsJson,source.pinsJson);assert.deepEqual(restored.handoff,source.handoff);
  const recopy=await restoring.rpc<EvaluationPreservationBundle>('f-export',{who:'boperator',sessionId:item.id}),copied=JSON.parse(recopy.payloadJson);assert.deepEqual(copied.fTables,archive.fTables);assert.deepEqual(copied.manifest,archive.manifest);
  assert.equal(copied.sourceDependenciesJson,archive.sourceDependenciesJson);assert.equal(copied.sourceDependenciesSha256,archive.sourceDependenciesSha256);assert.deepEqual(copied.newResultObjects,[]);
  const reader=await new ServerChild('restore-request-only','restore','readonly').start(),ioBefore={...providerIo};assert.deepEqual(reader.ready.roles,{request:'gakja_request'});
  assert.equal(reader.ready.storageCredentialsInherited,false);assert.equal(reader.ready.mappingPoolPresent,false);assert.equal(reader.ready.workerPoolPresent,false);assert.equal(reader.ready.modelEnabled,false);
  const historical=await reader.request<EvaluationProjection>('b',epath(item.id,'revision')+'?jobId='+item.jobId);assert.equal(historical.status,200,JSON.stringify(historical.value));assert.deepEqual(historical.value.result,item.result);
  const blocked=await fcommand('b',item.id,'consume',{handoffPayloadSha256:source.handoff!.payloadSha256,approvalSha256:before.control.approvalSha256},randomUUID(),reader);assert.equal(blocked.status,503,JSON.stringify(blocked.value));assert.deepEqual(providerIo,ioBefore);
  assert.equal((await reader.request('a',epath(item.id,'revision')+'?jobId='+item.jobId)).status,404);
  assertFrozen(await one.rpc<SessionCommandSnapshot>('snapshot',{who:'b',sessionId:item.id}),source);
  const output=process.env.PR07F_TEST_OUTPUT!;await writeFile(path.join(output,'readonly-preservation.json'),JSON.stringify({version:'pr07f-full-owned-readonly-preservation-v1',bundle,manifest:archive.manifest,restoredBundleSha256:recopy.sha256,FExternalObjects:[],qualification:'All F artifacts/results are DB TEXT; original E C/D references and raw JSON retained. This does not claim E media object reconstruction.'},null,2)+'\n');
  rows.push({caseId:'F-RESTORE-12',sourcePid:one.pid,restoreReaderPid:reader.pid,FCollections:14,EChildCollections:9,FExternalObjects:0,noStorageCredentials:true,noModel:true,readOnly:true,sourceEBytesUnchanged:true,bundleSha256:bundle.sha256});await reader.stop();await restoring.stop();
});

test('F-CHECKPOINT-13 an actual killed worker resumes its exact persisted cluster in another process with zero replacement model calls',{timeout:300_000},async()=>{
  await installTrust('a');const id=await endedHttp('a');await publishA('a',id);assert.equal((await publishB('a',id)).status,200);assert.equal((await consume('a',id)).status,200);const jobId=(await eview('a',id)).projection!.job!.id;
  const killed=await new ServerChild('checkpoint-killed','primary','worker').start();await killed.rpc('configure',{holdAfterCheckpoint:true});const granted=await dispatch('a',jobId,worker1),pending=killed.rpc('run',{...granted,leaseMs:1500}).then(value=>({value}),error=>({error:(error as Error).message}));
  await killed.barrier('checkpoint');const before=(await eview('a',id)).projection!.job!;assert.equal(before.checkpoints.length,1);assert.equal((await pools.admin.query('SELECT count(*)::int count FROM gakja.evaluation_checkpoints WHERE job_id=$1',[jobId])).rows[0].count,1);const checkpointSha=snapshotHash(before.checkpoints[0]),killedPid=killed.pid;await killed.stop(true);assert.ok('error'in await pending);
  await until(async()=> (await pools.admin.query('SELECT lease_until<=clock_timestamp() expired FROM gakja.evaluation_jobs WHERE job_id=$1',[jobId])).rows[0],row=>row.expired===true);
  const modelBefore=((await worker2.rpc('state')).counters as {modelCalls:number}).modelCalls,result=await runJob('a',jobId,worker2);assert.equal(result.job?.status,'completed',JSON.stringify(result));const modelAfter=((await worker2.rpc('state')).counters as {modelCalls:number}).modelCalls;assert.equal(modelAfter,modelBefore);
  const after=(await eview('a',id)).projection!.job!;assert.equal(after.attempts,2);assert.equal(snapshotHash(after.checkpoints[0]),checkpointSha);assert.equal((await sql('evaluation_results',id)).length,1);
  rows.push({caseId:'F-CHECKPOINT-13',killedPid,resumedPid:worker2.pid,actualCheckpoint:true,identicalInputBinding:true,resumeModelCalls:0,checkpointSha256:checkpointSha,resultRows:1});
});

registerHandoffIntegrityCases({one:()=>one,worker1:()=>worker1,worker2:()=>worker2,fcommand,sql,rows});

test('F-RETRY-14 authenticated retry and receipt queries recover a real synthetic provider failure and reject another session receipt',{timeout:300_000},async()=>{
  await installTrust('a');const id=await endedHttp('a');await publishA('a',id);assert.equal((await publishB('a',id)).status,200);assert.equal((await consume('a',id)).status,200);const jobId=(await eview('a',id)).projection!.job!.id;
  const dbState=async()=> (await pools.admin.query("SELECT status,attempts,next_retry_at::text next_retry_at,lease_token::text lease_token,clock_timestamp()::text server_now,(status='queued' AND (next_retry_at IS NULL OR next_retry_at<=clock_timestamp())) eligible FROM gakja.evaluation_jobs WHERE job_id=$1",[jobId])).rows[0];
  // A transient 503 is already queued behind the retained DB-clock backoff;
  // manual retry deliberately resets terminal failed jobs only, as locally.
  await worker1.rpc('configure',{failModel:'terminal'});let failed:Awaited<ReturnType<typeof runJob>>;
  try{failed=await runJob('a',jobId);}finally{await worker1.rpc('configure',{});}
  assert.equal(failed!.job?.status,'failed',JSON.stringify(failed!));const failedState=await dbState();assert.equal(failedState.status,'failed');assert.equal(failedState.attempts,1);assert.equal(failedState.next_retry_at,null);assert.equal(failedState.lease_token,null);assert.equal(failedState.eligible,false);assert.equal((await sql('evaluation_results',id)).length,0);
  const retried=await fcommand('a',id,'retry',{jobId});assert.equal(retried.status,200,JSON.stringify(retried.value));
  const queuedState=await dbState();assert.equal(queuedState.status,'queued');assert.equal(queuedState.attempts,1);assert.equal(queuedState.next_retry_at,null);assert.equal(queuedState.lease_token,null);assert.equal(queuedState.eligible,true);
  rows.push({caseId:'F-RETRY-14-admission',jobId,failureMode:'explicit-synthetic-terminal-400',failedWorkerResult:failed!,failedState,queuedState,retryReceipt:retried.value});
  const query=`?key=${retried.value.key}&inputSha256=${retried.value.inputSha256}`,receipt=await one.request<Reply>('a',epath(id,'commands')+query);assert.equal(receipt.status,200);assert.equal(receipt.value.operationId,retried.value.operationId);
  const other=completed.get('a')!.id,wrong=await one.request<{code:string}>('a',epath(other,'commands')+query);assert.equal(wrong.status,409,JSON.stringify(wrong.value));assert.equal(wrong.value.code,'F_RECEIPT_SESSION_CHANGED');
  const complete=await runJob('a',jobId,worker2);assert.equal(complete.job?.status,'completed',JSON.stringify(complete));assert.equal((await sql('evaluation_results',id)).length,1);assert.equal((await eview('a',id)).projection!.job!.attempts,2);
  rows.push({caseId:'F-RETRY-14',jobId,actualFailure:true,failureMode:'explicit-synthetic-terminal-400',authorizedRetry:200,sameReceiptReplayed:true,crossSessionReceiptRejected:409,attempts:2,resultRows:1,failedState,queuedState,completedState:await dbState()});
});
