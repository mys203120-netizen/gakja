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
import type { SessionCommandSnapshot,SessionWriterClaim,SessionPreservationBundle } from '../../server/session-writer/session-command-ports';
import { testPools,closePools } from './session-writer-test-database';
import { createSessionTestSigningAuthority,loadOwnedPublicDFixture,seedPublicDOuterScope,importPublicDContexts } from './d-preparation';

const phaseTrace:Record<string,unknown>[]=[];
const tracePhase=(event:string,detail:Record<string,unknown>={})=>phaseTrace.push({utc:new Date().toISOString(),monotonicMs:performance.now(),event,...detail});
const diagnostic=process.env.PR07E_TEST_CONTROLLED_PROVIDER_DIAGNOSTIC==='1';
if(diagnostic&&process.env.GITHUB_ACTIONS==='true')throw new Error('PR07E_CI_REQUIRES_OFFICIAL_STORAGE');
const data=await loadOwnedPublicDFixture(),pools=testPools(1),restorePools=testPools(1,'restore');
const signing=await createSessionTestSigningAuthority(),tokens={a:await signing.token('a'),b:await signing.token('b')};
const api=process.env.PR07E_TEST_STORAGE_API_URL,credential=process.env.PR07E_TEST_STORAGE_SERVICE_KEY,bucket=process.env.PR07E_TEST_BUCKET,prefix=process.env.PR07E_TEST_KEY_PREFIX;
if(!api||!credential||!bucket||!prefix)throw new Error('PR07E_EXPLICIT_STORAGE_REQUIRED');
const bodies=new Map<string,Buffer>(),providerIo={read:0,upload:0,copy:0,remove:0};
const actual:ObjectStorageProvider=diagnostic?{async read(ref){const body=bodies.get(JSON.stringify(ref));if(!body)throw new Error('PR07E_CONTROLLED_BODY_MISSING');return Buffer.from(body);},
  async upload(ref,bytes){const key=JSON.stringify(ref);if(bodies.has(key))throw new Error('PR07E_CONTROLLED_BODY_EXISTS');bodies.set(key,Buffer.from(bytes));},
  async copy(from,to){const body=bodies.get(JSON.stringify(from));if(!body)throw new Error('PR07E_CONTROLLED_BODY_MISSING');bodies.set(JSON.stringify(to),Buffer.from(body));},async remove(ref){bodies.delete(JSON.stringify(ref));}}:
  createSupabaseObjectProvider({apiUrl:api,serviceCredential:credential,bucket,keyPrefix:prefix,allowLoopbackHttp:true});
const provider:ObjectStorageProvider={read(ref,options){providerIo.read++;return actual.read(ref,options);},upload(ref,body,options){providerIo.upload++;return actual.upload(ref,body,options);},copy(from,to,options){providerIo.copy++;return actual.copy(from,to,options);},remove(ref,options){providerIo.remove++;return actual.remove(ref,options);}};
const rows:Record<string,unknown>[]=[],children:ServerChild[]=[],snapshots:Record<string,unknown>[]=[];
let imported:Awaited<ReturnType<typeof importPublicDContexts>>,one:ServerChild,two:ServerChild;
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
interface Reply<R=Record<string,unknown>>{version:string;operationId:string;revision:string;writerGeneration:string;key:string;inputSha256:string;replay:boolean;result:R}
interface View {sessionId:string;revision:string;writerGeneration:string;status:string;evaluationStatus:string;writer:string;contextSnapshotSha256:string;recovery:{epoch:number;phase:string;currentTurn:RecordedTurn|null;transcript:string;transcriptStatus:string|null;captureRevision:number};evaluationHandoff:{state:string;intentId:string;payloadSha256:string}|null;evaluationJob:null}
interface Barrier {type:'barrier';barrierId:string;phase:string;detail:{action?:string;sessionId?:string;key?:string;operationId?:string}}
type Message=Record<string,unknown>;
class ServerChild {
  process:ChildProcess;port=0;pid=0;name:string;database:'primary'|'restore';ready:Message={};logs='';messages:Message[]=[];
  lastPhase:Message|null=null;lastIpc:Array<{type:unknown;phase?:unknown;utc:string}>=[];
  pending=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  constructor(name:string,database:'primary'|'restore'='primary'){
    this.name=name;this.database=database;
    const env:NodeJS.ProcessEnv={...process.env,NODE_ENV:'test',INTERVIEW_EXECUTION_MODE:'service',NODE_OPTIONS:''};
    for(const key of Object.keys(env))if(!key.startsWith('PR07E_TEST_')&&/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DATABASE_URL|POSTGRES_URL|SUPABASE_URL|STORAGE_URL/u.test(key))env[key]='';
    for(const key of Object.keys(env))if(/^PR07E_TEST_(?:(?:RESTORE_)?(?:ADMIN|WORKER|BYPASS)_URL|BOOTSTRAP_URL)$/u.test(key))delete env[key];
    this.process=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./session-writer-child.ts',import.meta.url))],{cwd:process.cwd(),env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
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
    this.process.once('exit',()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('PR07E_CHILD_EXITED'));}this.pending.clear();});
    children.push(this);
  }
  async wait(predicate:(value:Message)=>boolean,timeout=30_000,phase='unspecified'):Promise<Message>{
    const started=performance.now();tracePhase('wait-start',{server:this.name,childPid:this.process.pid,phase,timeoutMs:timeout});
    const found=this.messages.findIndex(predicate);if(found>=0){tracePhase('wait-resolved',{server:this.name,childPid:this.process.pid,phase,elapsedMs:performance.now()-started,buffered:true});return this.messages.splice(found,1)[0];}
    return new Promise((resolve,reject)=>{
      const deadline=setTimeout(()=>{const evidence={server:this.name,pid:this.process.pid,phase,timeoutMs:timeout,elapsedMs:performance.now()-started,lastPhase:this.lastPhase,lastIpc:this.lastIpc};tracePhase('wait-timeout',evidence);cleanup();reject(new Error('PR07E_CHILD_MESSAGE_TIMEOUT:'+JSON.stringify(evidence)+':'+this.logs.slice(-2000)));},timeout);
      const message=(value:Message)=>{if(predicate(value)){tracePhase('wait-resolved',{server:this.name,childPid:this.process.pid,phase,elapsedMs:performance.now()-started,type:value.type});cleanup();const index=this.messages.indexOf(value);if(index>=0)this.messages.splice(index,1);resolve(value);}};
      const exit=()=>{cleanup();reject(new Error('PR07E_CHILD_EXIT_BEFORE_MESSAGE:'+this.logs.slice(-2000)));};
      const cleanup=()=>{clearTimeout(deadline);this.process.off('message',message);this.process.off('exit',exit);};
      this.process.on('message',message);this.process.once('exit',exit);
    });
  }
  async start(){
    await this.wait(m=>m.type==='boot',30_000,'boot');
    this.process.send?.({type:'initialize',requestId:randomUUID(),name:this.name,database:this.database,fixtureRoot:data.root,fixture:data.fixture,jwk:signing.jwk,tokens,
      runIds:Object.fromEntries([...imported.inventories.values()].map(v=>[v.plan.ownerId,v.plan.runId])),controlledProvider:diagnostic});
    const ready=await this.wait(m=>m.type==='ready',120_000,'ready');this.ready=ready;this.port=Number(ready.port);this.pid=Number(ready.pid);assert.ok(this.port>0&&this.pid>0);return this;
  }
  rpc<T=Record<string,unknown>>(operation:string,payload:Record<string,unknown>={}):Promise<T>{
    const requestId=randomUUID(),started=performance.now();tracePhase('rpc-start',{server:this.name,childPid:this.process.pid,operation,requestId});return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{tracePhase('rpc-timeout',{server:this.name,childPid:this.process.pid,operation,requestId,timeoutMs:30_000,elapsedMs:performance.now()-started,lastPhase:this.lastPhase});this.pending.delete(requestId);reject(new Error('PR07E_CONTROL_TIMEOUT:'+operation));},30_000);
      this.pending.set(requestId,{resolve:value=>resolve(value as T),reject,timer});this.process.send?.({type:'control',requestId,operation,payload});});
  }
  async barrier(phase:string,key?:string){return await this.wait(m=>m.type==='barrier'&&m.phase===phase&&(!key||(m.detail as Barrier['detail']).key===key),30_000,'barrier:'+phase) as unknown as Barrier;}
  get base(){return 'http://127.0.0.1:'+this.port;}
  async request<T=Record<string,unknown>>(who:'a'|'b',route:string,input?:unknown,signal?:AbortSignal){
    tracePhase('http-start',{server:this.name,childPid:this.pid,route,key:(input as {key?:string}|undefined)?.key});
    const sep=route.includes('?')?'&':'?',response=await fetch(this.base+route+sep+'applicationTargetId=shadow-app-'+who,{method:input===undefined?'GET':'POST',headers:{Authorization:'Bearer '+tokens[who],Origin:this.base,'Content-Type':'application/json'},
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
    if(errors().length)throw new Error('PR07E_SOCKET_COMMAND_ERROR:'+JSON.stringify(errors()));
    return new Promise<Record<string,unknown>>((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(new Error('PR07E_SOCKET_MESSAGE_TIMEOUT:'+JSON.stringify(messages.map(m=>({type:m.type,action:m.action,status:m.status,code:m.code})))));},15_000);
      const receive=(body:Buffer)=>{const value=JSON.parse(body.toString());if(predicate(value)){cleanup();const i=messages.findIndex(m=>m.type===value.type&&m.action===value.action);if(i>=0)messages.splice(i,1);resolve(value);}else if(value.type==='error'){cleanup();reject(new Error('PR07E_SOCKET_COMMAND_ERROR:'+JSON.stringify({code:value.code,status:value.status,action:value.action})));}};
      const closed=()=>{cleanup();reject(new Error('PR07E_SOCKET_CLOSED:'+JSON.stringify(errors())));};const cleanup=()=>{clearTimeout(timer);ws.off('message',receive);ws.off('close',closed);};ws.on('message',receive);ws.once('close',closed);});
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
const condition=(snapshot:SessionCommandSnapshot):SessionWriterClaim=>({sessionId:snapshot.binding.sessionId,expectedRevision:snapshot.revision,writerGeneration:snapshot.writerGeneration,writerToken:snapshot.writerToken});
const happy=new Map<'a'|'b',Awaited<ReturnType<typeof create>>>();

test.before(async()=>{
  await seedPublicDOuterScope(pools,data.fixture);await seedPublicDOuterScope(restorePools,data.fixture);
  imported=await importPublicDContexts(pools,signing,data.root,data.fixture,provider);
  [one,two]=await Promise.all([new ServerChild('one').start(),new ServerChild('two').start()]);
  assert.notEqual(one.pid,two.pid);assert.notEqual((one.ready.backendPids as {request:number}).request,(two.ready.backendPids as {request:number}).request);
  for(const child of [one,two]){assert.deepEqual(child.ready.backendRoles,{request:'gakja_request',mapping:'gakja_mapping'});assert.equal(child.ready.privilegedTestCredentialsInherited,false);}
  rows.push({caseId:'E-ENV',twoIndependentProcesses:true,processes:[one.ready,two.ready],actualPostgreSQL:true,storageEngine:diagnostic?'controlled-body-diagnostic-NOT-official-Storage':'official-Supabase-Storage-REST',baselineCodeCommit:data.baseline.codeCommit,baselineFileReads:data.baseline.metrics.fixtureFileReads,baselineFileWrites:0});
},{timeout:600_000});
test.after(async()=>{
  const states=[];for(const child of children)if(child.process.exitCode===null&&child.process.signalCode===null)try{states.push(await child.rpc('state'));}catch{/* a deliberately killed child has its own exit evidence */}
  for(const child of children)await child.stop();
  let cleanup:unknown;try{if(imported){await imported.cleanup();cleanup={complete:true};}}catch(error){cleanup={complete:false,errorCode:(error as {code?:string;message?:string}).code??(error as Error).message};}
  await closePools(pools);await closePools(restorePools);
  const output=process.env.PR07E_TEST_OUTPUT??'artifacts/pr07e';await mkdir(output,{recursive:true});
  for(const child of children)await writeFile(path.join(output,`child-${child.name}-${child.pid||child.process.pid}.log`),child.logs);
  await writeFile(path.join(output,'two-server-cases.json'),JSON.stringify({version:'pr07e-actual-two-server-session-writer-v1',rows,states,snapshots,providerIo,cleanup,
    twoIndependentProcesses:one?.pid!==two?.pid&&!!one?.pid&&!!two?.pid,actualStudentDataTransferred:false,paidProviderCalls:0,evaluationApprovalGranted:false},null,2)+'\n');
  await writeFile(path.join(output,'phase-trace.json'),JSON.stringify({version:'pr07e-two-server-phase-trace-v1',rows:phaseTrace},null,2)+'\n');
  assert.equal((cleanup as {complete:boolean})?.complete,true);
  for(const state of states){const value=state as {counters:{localDataReadAttempts:number;localSessionWriteAttempts:number;externalNetworkAttempts:number}};assert.equal(value.counters.localDataReadAttempts,0);assert.equal(value.counters.localSessionWriteAttempts,0);assert.equal(value.counters.externalNetworkAttempts,0);}
});

test('E-HTTP-01 actual two processes create independently scoped A/B sessions, pin context bytes and expose verified MPEG audio',{timeout:240_000},async()=>{
  for(const [who,server]of [['a',one],['b',two]] as const){
    const created=await create(server,who,'shared-scoped-create-key');happy.set(who,created);
    const current=await view(server,who,created.id);assert.equal(current.status,'active');assert.equal(current.recovery.currentTurn!.id,created.turn.id);assert.equal(current.writer,'db');
    const context=await server.request<{contextJson:string;contextSha256:string;pinsJson:string;pinsSha256:string}>(who,`/api/sessions/${created.id}/context`);assert.equal(context.status,200);assert.equal(hash(context.value.contextJson),context.value.contextSha256);assert.equal(hash(context.value.pinsJson),context.value.pinsSha256);
    const second=await (server===one?two:one).request<typeof context.value>(who,`/api/sessions/${created.id}/context`);assert.equal(second.status,200);assert.deepEqual(second.value,context.value);
    const snapshot=await server.rpc<SessionCommandSnapshot>('snapshot',{who,sessionId:created.id});const session=JSON.parse(snapshot.sessionJson) as InterviewSession;
    assert.equal(session.runtime!.owner.mode,'authenticated');assert.equal(session.runtime!.owner.id,'owner-'+who);assert.equal(snapshot.contextSnapshotSha256,current.contextSnapshotSha256);
    const audio=await fetch(server.base+`/api/audio/${data.fixture.speechHash}?applicationTargetId=shadow-app-${who}`,{headers:{Authorization:'Bearer '+tokens[who],Origin:server.base}});
    assert.equal(audio.status,200);assert.equal(audio.headers.get('content-type'),'audio/mpeg');assert.equal(audio.headers.get('cache-control'),'private, no-store');
    const bytes=Buffer.from(await audio.arrayBuffer()),artifact=imported.inventories.get(who)!.plan.artifacts.find(a=>a.artifactId==='audio')!;assert.equal(hash(bytes),artifact.availability==='present'?artifact.rawSha256:null);
    rows.push({caseId:'E-HTTP-01-'+who,created:true,serverPid:server.pid,authenticatedRuntime:true,contextBytesSha256:context.value.contextSha256,pinsSha256:context.value.pinsSha256,actualMpegSha256:hash(bytes)});
  }
  assert.notEqual(happy.get('a')!.id,happy.get('b')!.id);
});

test('E-HTTP-02 WSS capture and actual answer commit recover on the other server; original receipts replay after revision advancement',{timeout:240_000},async()=>{
  for(const [who,server,other]of [['a',one,two],['b',two,one]] as const){
    const created=happy.get(who)!,capture=await captureAnswer(server,who,created.id,created.turn);
    assert.equal(capture.finish.value.result.confirmed,true);assert.ok(capture.finish.value.result.rawTranscript.length>0);
    const answer=await mutate(server,who,created.id,'answer',{turnId:created.turn.id,answerId:capture.answerId,captureRevision:capture.captureRevision,elapsedMs:2500});assert.equal(answer.status,200,JSON.stringify(answer.value));
    const duplicate=await other.request<Reply>(who,`/api/sessions/${created.id}/answer`,answer.input);assert.equal(duplicate.status,200);assert.equal(duplicate.value.operationId,answer.value.operationId);assert.equal(duplicate.value.replay,true);assert.deepEqual(duplicate.value.result,answer.value.result);
    const recovered=await mutate(other,who,created.id,'recover',{});assert.equal(recovered.status,200,JSON.stringify(recovered.value));
    const head=await view(other,who,created.id);assert.ok(BigInt(head.writerGeneration)>BigInt(answer.value.writerGeneration));assert.equal(head.recovery.currentTurn!.rawTranscript,capture.finish.value.result.rawTranscript);
    const replay=await other.request<Reply<{sessionId:string;turn:RecordedTurn}>>(who,'/api/sessions',created.request);assert.equal(replay.status,201);assert.equal(replay.value.operationId,created.reply.operationId);assert.equal(replay.value.revision,created.reply.revision);assert.deepEqual(replay.value.result,created.reply.result);
    const receipt=await other.request<Reply>(who,`/api/sessions/${created.id}/commands?key=${answer.value.key}&inputSha256=${answer.value.inputSha256}`);assert.equal(receipt.status,200);assert.equal(receipt.value.operationId,answer.value.operationId);
    capture.channel.ws.close();
    if(who==='b'){const ended=await mutate(other,who,created.id,'end',{elapsedMs:8000});assert.equal(ended.status,202,JSON.stringify(ended.value));assert.equal((await sqlRows(pools,'session_evaluation_handoffs',created.id)).length,1);}
    rows.push({caseId:'E-HTTP-02-'+who,actualBinaryCapture:true,answerCommitted:true,recoveredOnOtherPid:other.pid,writerGenerationChanged:true,oldRevisionReceiptReplayed:true,...(who==='b'?{endedSuccessfully:true,handoffCount:1}:{})});
  }
});

test('E-HTTP-03 cross-account, spoofed selection and conflicting idempotency input return no private result or provider work',async()=>{
  const a=happy.get('a')!,b=happy.get('b')!,before=await one.rpc('state');
  assert.equal((await one.request('b',`/api/sessions/${a.id}`)).status,404);
  assert.equal((await two.request('a',`/api/sessions/${b.id}/commands?key=${b.reply.key}&inputSha256=${b.reply.inputSha256}`)).status,404);
  const forged=await one.request('a','/api/sessions',{...a.request,ownerId:'owner-b'});assert.equal(forged.status,400);
  const target=await fetch(one.base+`/api/sessions/${a.id}?applicationTargetId=shadow-app-a&studentId=other-student`,{headers:{Authorization:'Bearer '+tokens.a,Origin:one.base}});assert.ok([403,404].includes(target.status));
  const changed=await one.request('a','/api/sessions',{...a.request,payload:{ownerId:'owner-b'}});assert.equal(changed.status,400);
  const after=await one.rpc('state');assert.deepEqual(after.providers,before.providers);rows.push({caseId:'E-HTTP-03',crossAccountRefused:true,spoofedOwnerRefused:true,wrongStudentRefused:true,providerDelta:0,payloadReturned:false});
});
const event=(turnId:string,phase='paused')=>({eventId:randomUUID(),type:'phase_changed',turnId,phase,atMs:1000,clockId:randomUUID()});
const snapshot=(server:ServerChild,id:string,who:'a'|'b'='a')=>server.rpc<SessionCommandSnapshot>('snapshot',{who,sessionId:id});
async function configure(server:ServerChild,hooks:Record<string,unknown>[]=[] ,provider:Record<string,unknown>={}){await server.rpc('configure',{hooks,provider});}
async function release(server:ServerChild,barrier:Barrier){await server.rpc('release',{barrierId:barrier.barrierId});}
async function sqlRows(database:ReturnType<typeof testPools>,table:string,id:string){return (await database.admin.query(`SELECT to_jsonb(t) value FROM gakja.${table} t WHERE session_id=$1 ORDER BY to_jsonb(t)::text`,[id])).rows.map(r=>r.value);}

test('E-CAS-04 actual two-server same-revision writes, event semantic deduplication and conflicting keys',{timeout:240_000},async()=>{
  const created=await create(one,'a','cas-'+randomUUID()),head=await view(one,'a',created.id),firstKey=randomUUID(),firstPayload=event(created.turn.id,'paused'),secondPayload=event(created.turn.id,'listening');
  await configure(one,[{phase:'before-commit',key:firstKey,mode:'hold',once:true}]);
  const first=one.request<Reply>('a',`/api/sessions/${created.id}/events`,envelope(firstKey,head,firstPayload)),barrier=await one.barrier('before-commit',firstKey);
  const second=await two.request<Reply>('a',`/api/sessions/${created.id}/events`,envelope(randomUUID(),head,secondPayload));assert.equal(second.status,200,JSON.stringify(second.value));
  await release(one,barrier);const loser=await first;assert.equal(loser.status,409,JSON.stringify(loser.value));
  const replay=await one.request<Reply>('a',`/api/sessions/${created.id}/events`,envelope(randomUUID(),head,secondPayload));assert.equal(replay.status,200);assert.equal(replay.value.operationId,second.value.operationId);assert.equal(replay.value.replay,true);
  const conflict=await one.request('a',`/api/sessions/${created.id}/events`,envelope(second.value.key,await view(one,'a',created.id),firstPayload));assert.equal(conflict.status,409);
  const events=await sqlRows(pools,'session_mandatory_events',created.id);assert.equal(events.filter(v=>v.event_id===secondPayload.eventId).length,1);assert.equal(events.filter(v=>v.event_id===firstPayload.eventId).length,0);
  rows.push({caseId:'E-CAS-04',pids:[one.pid,two.pid],sameRevisionLoser:loser.status,semanticOperationId:second.value.operationId,eventCount:1,conflictingKeyRefused:true});
});

test('E-LOSS-05 failed precommit create resumes explicitly and lost postcommit response replays after a real process restart',{timeout:300_000},async()=>{
  const failedKey='precommit-'+randomUUID();await configure(one,[{phase:'before-commit',key:failedKey,mode:'fail',once:true}]);
  const input=envelope(failedKey,{revision:'0',writerGeneration:'1'},{}),failed=await one.request('a','/api/sessions',input);assert.equal(failed.status,503,JSON.stringify(failed.value));
  const resumed=await two.request<Reply<{sessionId:string;turn:RecordedTurn}>>('a','/api/sessions',{...input,resume:true});assert.equal(resumed.status,201,JSON.stringify(resumed.value));
  const recovered=await snapshot(two,resumed.value.result.sessionId);assert.equal(JSON.parse(recovered.sessionJson).turns.length,1);
  const crash=new ServerChild('response-loss');await crash.start();const key='lost-response-'+randomUUID();await configure(crash,[{phase:'after-commit',key,mode:'hold',once:true}]);
  const request=envelope(key,{revision:'0',writerGeneration:'1'},{}),pending=crash.request('a','/api/sessions',request).then(value=>({response:value}),error=>({error:String(error)}));
  const committed=await crash.barrier('after-commit',key),id=committed.detail.sessionId!;
  const before=await snapshot(two,id),receipt=(await sqlRows(pools,'session_commands',id)).find(v=>v.original_key===key);assert.equal(receipt.status,'committed');
  const lostPid=crash.pid;await crash.stop(true);const outcome=await pending;assert.ok('error'in outcome);
  const restarted=await new ServerChild('response-loss-restarted').start();assert.notEqual(restarted.pid,lostPid);
  const original=await restarted.request<Reply<{sessionId:string;turn:RecordedTurn}>>('a','/api/sessions',request);assert.equal(original.status,201);assert.equal(original.value.replay,true);assert.equal(original.value.operationId,receipt.operation_id);assert.deepEqual(original.value.result,JSON.parse(receipt.result_json));
  const after=await snapshot(restarted,id);assert.equal(before.sessionJson,after.sessionJson);assert.equal(before.revision,after.revision);const state=await restarted.rpc('state');assert.equal((state.service as {providerAttempts:number}).providerAttempts,0);
  rows.push({caseId:'E-LOSS-05',precommitFailure:503,explicitResume:true,oneFirstQuestion:true,responseActuallyLost:true,killedPid:lostPid,restartedPid:restarted.pid,operationId:original.value.operationId,originalBytesPreserved:true,replayProviderAttempts:0});await restarted.stop();
});

test('E-FENCE-06 recovery fences late provider results and stale sockets without keeping a request connection over provider work',{timeout:240_000},async()=>{
  const created=await create(one,'a','fence-'+randomUUID()),capture=await captureAnswer(one,'a',created.id,created.turn,true),key=randomUUID(),attempt=capture.finish.value.result as {submissionAttemptId?:string};
  await configure(one,[{phase:'after-external',key,mode:'hold',once:true}]);
  const input=envelope(key,await view(one,'a',created.id),{turnId:created.turn.id,answerId:capture.answerId,captureRevision:1,elapsedMs:3000,submissionAttemptId:attempt.submissionAttemptId,endingObservation:{stopSource:'button',lastSpeechMs:2000,trailingSilenceMs:1000,speechActiveAtEnd:false,vadAvailable:true}});
  const pending=one.request<Reply>('a',`/api/sessions/${created.id}/answer-candidate`,input),barrier=await one.barrier('after-external',key);
  const probe=await one.rpc<{pid:number;role:string}>('probe-database');assert.equal(probe.role,'gakja_request');
  const observed=await until(async()=>{const state=await one.rpc('state'),pool=(state.pool as {request:{idle:number;total:number;waiting:number}}).request;
    const tx=await pools.admin.query('SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1',[probe.pid]);return {pool,transaction:tx.rows[0]};},v=>v.pool.idle===v.pool.total&&v.pool.waiting===0&&!!v.transaction&&v.transaction.xact_start===null),requestPool=observed.pool;
  assert.equal((await one.request('b',`/api/sessions/${happy.get('b')!.id}`)).status,200);
  const recovered=await mutate(two,'a',created.id,'recover',{});assert.equal(recovered.status,200,JSON.stringify(recovered.value));const before=await snapshot(two,created.id);
  await release(one,barrier);const late=await pending;assert.equal(late.status,409,JSON.stringify(late.value));const after=await snapshot(two,created.id);assert.equal(after.sessionJson,before.sessionJson);assert.equal(after.revision,before.revision);
  const stale=await one.request('a',`/api/sessions/${created.id}/answer`,envelope(randomUUID(),{revision:before.revision,writerGeneration:input.writerGeneration},{turnId:created.turn.id,answerId:capture.answerId,captureRevision:1,elapsedMs:3000}));assert.equal(stale.status,409);
  capture.channel.ws.close();rows.push({caseId:'E-FENCE-06',lateProviderStatus:late.status,unchangedSnapshot:true,writerGenerationAdvanced:true,staleMutationRefused:true,providerAwaitRequestPoolIdle:requestPool,providerAwaitPgTransaction:null,otherRequestSucceeded:true});
});
async function withHeldCommit(created:Awaited<ReturnType<typeof create>>,change:()=>Promise<void>,restore:()=>Promise<void>,expected:number,label:string){
  const key=randomUUID(),payload=event(created.turn.id);await configure(one,[{phase:'before-commit',key,mode:'hold',once:true}]);
  const pending=one.request<Reply>('a',`/api/sessions/${created.id}/events`,envelope(key,await view(one,'a',created.id),payload)),barrier=await one.barrier('before-commit',key);
  const before=await snapshot(two,created.id);try{await change();await release(one,barrier);const result=await pending;assert.equal(result.status,expected,JSON.stringify(result.value));}
  finally{await restore();await configure(one);}
  const after=await snapshot(two,created.id);assert.equal(after.sessionJson,before.sessionJson);assert.equal(after.revision,before.revision);assert.equal((await sqlRows(pools,'session_commands',created.id)).filter(v=>v.original_key===key&&v.status==='committed').length,0);
  rows.push({caseId:label,observedAt:'before-commit',status:expected,noCommit:true,noFallback:true});
}

test('E-AUTH-07 revoke, source selection change and expiry at commit fail closed; a revocation after commit retains the original durable fact',{timeout:300_000},async()=>{
  const created=await create(one,'a','authority-'+randomUUID()),grant=[data.fixture.source.studentId,'shadow-app-a'];
  const changeGrant=async(active:boolean)=>{await pools.admin.query('UPDATE gakja.access_grants SET active=$1 WHERE account_id=$2 AND student_id=$3 AND application_target_id=$4',[active,'account-a',...grant]);};
  await withHeldCommit(created,()=>changeGrant(false),()=>changeGrant(true),403,'E-AUTH-07-revoke');
  await withHeldCommit(created,async()=>{await pools.admin.query('UPDATE gakja.access_grants SET source_present=true,source_revision=$1 WHERE account_id=$2 AND student_id=$3 AND application_target_id=$4',['obsolete-source','account-a',...grant]);},async()=>{await pools.admin.query('UPDATE gakja.access_grants SET source_present=false,source_revision=NULL WHERE account_id=$1 AND student_id=$2 AND application_target_id=$3',['account-a',...grant]);},403,'E-AUTH-07-source');
  await withHeldCommit(created,async()=>{await one.rpc('configure',{clockOffsetMs:3*60*60*1000});},async()=>{await one.rpc('configure',{clockOffsetMs:0});},401,'E-AUTH-07-expiry');
  const key=randomUUID(),input=envelope(key,await view(one,'a',created.id),event(created.turn.id,'listening'));await configure(one,[{phase:'after-commit',key,mode:'hold',once:true}]);
  const pending=one.request<Reply>('a',`/api/sessions/${created.id}/events`,input),barrier=await one.barrier('after-commit',key),committed=await snapshot(two,created.id);await changeGrant(false);await release(one,barrier);
  const rejected=await pending;assert.equal(rejected.status,403,JSON.stringify(rejected.value));await changeGrant(true);const replay=await two.request<Reply>('a',`/api/sessions/${created.id}/events`,input);assert.equal(replay.status,200);assert.equal(replay.value.replay,true);assert.equal((await snapshot(two,created.id)).sessionJson,committed.sessionJson);
  rows.push({caseId:'E-AUTH-07-after-commit',responseDenied:403,durableFactRetained:true,replayOperationId:replay.value.operationId});
});

test('E-DB-08 an owned row lock times out without success or local fallback and succeeds only after an explicit retry',{timeout:240_000},async()=>{
  const created=await create(one,'a','db-unavailable-'+randomUUID()),head=await view(one,'a',created.id),before=await snapshot(two,created.id),lock=await pools.admin.connect();
  const input=envelope(randomUUID(),head,event(created.turn.id));let denied;
  try{await lock.query('BEGIN');await lock.query('SELECT session_id FROM gakja.session_command_sessions WHERE session_id=$1 FOR UPDATE',[created.id]);denied=await one.request('a',`/api/sessions/${created.id}/events`,input);assert.equal(denied.status,503,JSON.stringify(denied.value));}
  finally{await lock.query('ROLLBACK');lock.release();}
  const after=await snapshot(two,created.id);assert.equal(after.sessionJson,before.sessionJson);assert.equal(after.revision,before.revision);
  const retried=await two.request<Reply>('a',`/api/sessions/${created.id}/events`,input);assert.equal(retried.status,200,JSON.stringify(retried.value));rows.push({caseId:'E-DB-08',timeoutStatus:denied.status,snapshotUnchangedDuringFailure:true,explicitRetryCommitted:true,localFallbackWrites:0});
});

let preservedEnd:{id:string;input:ReturnType<typeof envelope>;reply:Reply;frozen:SessionCommandSnapshot}|undefined;
test('E-END-09 concurrent end inputs freeze once after drain and preserve late canonical closing evidence',{timeout:300_000},async()=>{
  const created=happy.get('a')!;assert.equal((await sqlRows(pools,'session_answer_facts',created.id)).length,1);const observedSocket=await socket(one,'a',created.id),closed=new Promise<void>(resolve=>observedSocket.ws.once('close',()=>resolve()));observedSocket.ws.close();await closed;await until(()=>sqlRows(pools,'session_connection_closes',created.id),items=>items.length>0);const head=await view(one,'a',created.id),key=randomUUID(),first={elapsedMs:9000,metrics:{answerId:'first-input',durationMs:9000}};
  await configure(one,[{phase:'before-external',action:'end-finalize',mode:'hold',once:true}]);
  const input=envelope(key,head,first),pending=one.request<Reply>('a',`/api/sessions/${created.id}/end`,input),barrier=await one.barrier('before-external');
  const durable=await snapshot(two,created.id);assert.ok(durable.endIntent);assert.ok(JSON.parse(durable.endIntent!.inputJson));assert.equal(durable.handoff,null);
  const acceptedInput=durable.endIntent!.inputJson,acceptedHash=durable.endIntent!.inputSha256;
  const newer=envelope(randomUUID(),await view(two,'a',created.id),{elapsedMs:25000,metrics:{answerId:'changed-input',durationMs:25000}}),otherPending=two.request<Reply>('a',`/api/sessions/${created.id}/end`,newer);
  await release(one,barrier);const results=await Promise.all([pending,otherPending]);assert.ok(results.some(v=>v.status===202),JSON.stringify(results));
  const frozen=await snapshot(two,created.id);assert.equal(frozen.endIntent!.inputJson,acceptedInput);assert.equal(frozen.endIntent!.inputSha256,acceptedHash);assert.ok(frozen.handoff);assert.equal(frozen.handoff!.intentId,frozen.endIntent!.intentId);
  assert.equal((await sqlRows(pools,'session_end_intents',created.id)).length,1);assert.equal((await sqlRows(pools,'session_evaluation_handoffs',created.id)).length,1);
  const session=JSON.parse(frozen.sessionJson) as InterviewSession;assert.equal(session.status,'ending');assert.equal(session.evaluationStatus,'review_required');assert.equal(session.evaluation,undefined);assert.equal(session.runtime!.evaluationJob,undefined);assert.ok(session.runtime!.evaluationInputFrozenAt);
  const payload=JSON.parse(frozen.handoff!.payloadJson);assert.equal(payload.sessionJson,frozen.sessionJson);assert.equal(payload.contextJson,frozen.contextJson);assert.equal(payload.frozenSessionSha256,frozen.sessionSha256);assert.equal(payload.evaluationApprovalGranted,false);
  const closing=await mutate<{closingUtterance:{id:string;text:string}}>(two,'a',created.id,'closing',{reason:'user_ended',elapsedMs:9000});assert.equal(closing.status,200,JSON.stringify(closing.value));
  const closingEvent={eventId:randomUUID(),type:'acknowledgement_playing',turnId:closing.value.result.closingUtterance.id,atMs:9500,clockId:randomUUID(),payload:{closingReceipt:{key:closing.value.key,inputSha256:closing.value.inputSha256},text:'untrusted client replacement'}};
  const late=await mutate(one,'a',created.id,'events',closingEvent);assert.equal(late.status,200,JSON.stringify(late.value));assert.equal((await snapshot(one,created.id)).sessionJson,frozen.sessionJson);
  const events=await sqlRows(pools,'session_mandatory_events',created.id),canonical=events.filter(v=>v.event_id===closingEvent.eventId);assert.equal(canonical.length,1);assert.ok(JSON.stringify(canonical).includes(closing.value.result.closingUtterance.text));assert.equal(JSON.stringify(canonical).includes('untrusted client replacement'),false);
  const replay=await two.request<Reply>('a',`/api/sessions/${created.id}/end`,input);assert.equal(replay.status,202,JSON.stringify(replay.value));assert.equal((await snapshot(two,created.id)).sessionJson,frozen.sessionJson);
  preservedEnd={id:created.id,input,reply:results.find(v=>v.status===202)!.value,frozen};rows.push({caseId:'E-END-09',firstInputSha256:acceptedHash,endIntentCount:1,handoffCount:1,frozenSessionSha256:frozen.sessionSha256,contextSha256:frozen.contextSnapshotSha256,canonicalClosingJournaled:true,lateEventsPreserveFrozenBytes:true,evaluationQueued:false,evaluationApproved:false});
});

test('E-ROLLBACK-10 unpublished enrollment returns a fenced tombstone; committed export restores exact authenticated read-only history',{timeout:300_000},async()=>{
  const key='rollback-unpublished-'+randomUUID();await configure(one,[{phase:'before-begin',key,mode:'hold',once:true}]);const input=envelope(key,{revision:'0',writerGeneration:'1'},{}),pending=one.request('a','/api/sessions',input),barrier=await one.barrier('before-begin',key),id=barrier.detail.sessionId!;
  const unpublished=await snapshot(two,id);assert.equal(unpublished.revision,'0');assert.equal(unpublished.created,false);assert.equal(unpublished.writer,'db');const rolled=await two.rpc<SessionCommandSnapshot>('rollback',{who:'a',sessionId:id,condition:condition(unpublished)});assert.equal(rolled.writer,'local');
  await release(one,barrier);assert.equal((await pending).status,409);assert.equal((await sqlRows(pools,'session_bindings',id)).length,0);
  assert.ok(preservedEnd);const committed=preservedEnd!.id,before=await snapshot(two,committed),readOnly=await two.rpc<SessionCommandSnapshot>('freeze',{who:'a',sessionId:committed,condition:condition(before)});assert.equal(readOnly.writer,'read-only');assert.equal(readOnly.sessionJson,before.sessionJson);
  const bundle=await two.rpc<SessionPreservationBundle>('export',{who:'a',sessionId:committed});assert.equal(hash(bundle.payloadJson),bundle.sha256);
  const output=process.env.PR07E_TEST_OUTPUT??'artifacts/pr07e';await writeFile(path.join(output,'controlled-public-preservation-bundle.json'),JSON.stringify(bundle,null,2)+'\n');
  const restoredServer=await new ServerChild('read-only-restored','restore').start();await assert.rejects(restoredServer.rpc('restore',{who:'b',bundle}));
  const restored=await restoredServer.rpc<SessionCommandSnapshot>('restore',{who:'a',bundle});assert.equal(restored.writer,'read-only');assert.equal(restored.sessionJson,readOnly.sessionJson);assert.equal(restored.contextJson,readOnly.contextJson);assert.equal(restored.pinsJson,readOnly.pinsJson);
  for(const table of ['session_commands','session_command_keys','session_command_semantics','session_command_attempts','session_mandatory_events','session_answer_facts','session_end_intents','session_evaluation_handoffs','session_connection_closes'])assert.deepEqual(await sqlRows(restorePools,table,committed),await sqlRows(pools,table,committed),table);
  assert.equal((await sqlRows(restorePools,'session_answer_facts',committed)).length,1);assert.ok(JSON.parse(restored.sessionJson).turns[0].rawTranscript.length>0);assert.ok(JSON.parse(restored.sessionJson).turns[0].metadata.captureParts.length>0);
  const loaded=await view(restoredServer,'a',committed);assert.equal(loaded.writer,'read-only');assert.equal(loaded.recovery.currentTurn!.id,JSON.parse(restored.sessionJson).turns.at(-1).id);
  const replay=await restoredServer.request<Reply>('a',`/api/sessions/${committed}/end`,preservedEnd!.input);assert.equal(replay.status,202,JSON.stringify(replay.value));assert.equal(replay.value.replay,true);
  const denied=await mutate(restoredServer,'a',committed,'events',event(JSON.parse(restored.sessionJson).turns[0].id));assert.equal(denied.status,409);assert.equal((await snapshot(restoredServer,committed)).sessionJson,restored.sessionJson);
  rows.push({caseId:'E-ROLLBACK-10',unpublishedWriter:'local',unpublishedBindingCount:0,oldAttemptFenced:true,preservationSha256:bundle.sha256,newOwnedDatabase:true,restoredPid:restoredServer.pid,writer:'read-only',exactSessionContextPins:true,allNineChildCollectionsPreserved:true,receiptReplayAllowed:true,newMutationRefused:true,sourceRecordsRetained:true});await restoredServer.stop();
});
const endingObservation={stopSource:'button',lastSpeechMs:2000,trailingSilenceMs:1000,speechActiveAtEnd:false,vadAvailable:true,microphoneEnabled:true};
test('E-DOMAIN-11 confirmed silence, failed STT and staged continuation remain separate and approved replay uses the shared engine',{timeout:600_000},async()=>{
  for(const mode of ['silence','failure'] as const){
    await configure(one,[],{transcript:'',confirmed:mode==='silence',captureError:mode==='failure'});const created=await create(one,'a',mode+'-'+randomUUID()),capture=await captureAnswer(one,'a',created.id,created.turn,mode==='silence');
    assert.equal(capture.finish.value.result.confirmed,mode==='silence');
    const scope={turnId:created.turn.id,answerId:capture.answerId,captureRevision:1,elapsedMs:4500,endingObservation,...(capture.finish.value.result.submissionAttemptId?{submissionAttemptId:capture.finish.value.result.submissionAttemptId}:{})};
    let candidateId:string|undefined;
    if(mode==='silence'){
      const bypass=await mutate(one,'a',created.id,'answer',scope);assert.equal(bypass.status,409,JSON.stringify(bypass.value));
      const candidate=await mutate<{action:string;candidateId:string}>(one,'a',created.id,'answer-candidate',scope);assert.equal(candidate.status,200,JSON.stringify(candidate.value));assert.equal(candidate.value.result.action,'ADVANCE');candidateId=candidate.value.result.candidateId;
      const tampered=await mutate(one,'a',created.id,'answer',{...scope,candidateId,endingObservation:{...endingObservation,microphoneEnabled:false}});assert.equal(tampered.status,409,JSON.stringify(tampered.value));
    }
    const answer=await mutate(one,'a',created.id,'answer',{...scope,...(candidateId?{candidateId}:{})});
    const raw=JSON.parse((await snapshot(one,created.id)).sessionJson) as InterviewSession,turn=raw.turns.at(-1)!;
    if(mode==='silence'){assert.equal(answer.status,200,JSON.stringify(answer.value));assert.equal(turn.rawTranscript,'');assert.equal(turn.transcriptStatus,'finalized');assert.ok(turn.answerObservation);}
    else{assert.equal(answer.status,409,JSON.stringify(answer.value));assert.equal(turn.transcriptStatus,'error');assert.equal(turn.answerObservation,undefined);assert.equal((await sqlRows(pools,'session_answer_facts',created.id)).length,0);}
    capture.channel.ws.close();rows.push({caseId:'E-DOMAIN-11-'+mode,providerConfirmed:mode==='silence',answerStatus:answer.status,transcriptStatus:turn.transcriptStatus,silenceAndFailureDistinct:true,...(mode==='silence'?{invalidAnswerBeforeCandidate:409,validAnswerAfterCandidate:200,pendingSemanticNotPoisoned:true,tamperedCandidateEndingObservation:409,originalEndingObservationPreserved:true}:{})});
  }
  await configure(one,[],{transcript:'첫 번째 합성 설명입니다.',confirmed:true,captureError:false,classifyAction:'continue',nextAction:'REPLAY'});
  const created=await create(one,'a','continuation-'+randomUUID()),first=await captureAnswer(one,'a',created.id,created.turn,true),scope={turnId:created.turn.id,answerId:first.answerId,captureRevision:1,elapsedMs:3500,endingObservation,submissionAttemptId:(first.finish.value.result as {submissionAttemptId:string}).submissionAttemptId};
  const candidate=await mutate<{action:string;candidateId:string}>(one,'a',created.id,'answer-candidate',scope);assert.equal(candidate.status,200,JSON.stringify(candidate.value));assert.equal(candidate.value.result.action,'CONTINUE_ANSWER');
  const refused=await mutate(one,'a',created.id,'answer',{...scope,candidateId:candidate.value.result.candidateId});assert.equal(refused.status,409);const changedId=await mutate(one,'a',created.id,'capture-start',{turnId:created.turn.id,answerId:randomUUID(),captureRevision:2,staged:true});assert.equal(changedId.status,409);first.channel.ws.close();
  await configure(one,[],{transcript:'추가 합성 설명입니다.',classifyAction:'advance',nextAction:'REPLAY'});
  const nextCapture=await captureAnswer(one,'a',created.id,created.turn,true,first.answerId),nextScope={...scope,captureRevision:2,elapsedMs:7000,submissionAttemptId:(nextCapture.finish.value.result as {submissionAttemptId:string}).submissionAttemptId};
  const advance=await mutate<{action:string;candidateId:string}>(one,'a',created.id,'answer-candidate',nextScope);assert.equal(advance.status,200,JSON.stringify(advance.value));assert.equal(advance.value.result.action,'ADVANCE');
  const committed=await mutate(one,'a',created.id,'answer',{...nextScope,candidateId:advance.value.result.candidateId});assert.equal(committed.status,200,JSON.stringify(committed.value));
  const before=JSON.parse((await snapshot(one,created.id)).sessionJson) as InterviewSession,current=before.turns.at(-1)!;assert.equal(current.answerId,first.answerId);assert.equal(current.metadata.captureParts!.length,2);assert.equal(current.metadata.captureParts![0].sha256,hash('첫 번째 합성 설명입니다.'));assert.equal(current.metadata.captureParts![1].sha256,hash('추가 합성 설명입니다.'));assert.ok(current.rawTranscript!.includes('첫 번째 합성 설명입니다.'));assert.ok(current.rawTranscript!.includes('추가 합성 설명입니다.'));
  const following=await mutate<{turn:RecordedTurn;done:boolean}>(one,'a',created.id,'next',{turnId:created.turn.id,answerId:first.answerId,captureRevision:2,elapsedMs:7100,submissionAttemptId:nextScope.submissionAttemptId,candidateId:advance.value.result.candidateId});assert.equal(following.status,200,JSON.stringify(following.value));assert.equal(following.value.result.done,false);assert.equal(following.value.result.turn.questionText,created.turn.questionText);assert.equal(following.value.result.turn.questionAudioUrl,created.turn.questionAudioUrl);
  nextCapture.channel.ws.close();rows.push({caseId:'E-DOMAIN-11-continuation',sameAnswerId:true,captureRevisions:[1,2],rawPartsSha256:current.metadata.captureParts!.map(v=>v.sha256),continueCannotCommit:true,candidateDecisionBound:true,sharedApprovedReplay:true,originalQuestionTextAudioPreserved:true});await configure(one,[],{transcript:'합성 면접에서 자료를 비교하고 확인한 방법을 설명했습니다.',confirmed:true,captureError:false,classifyAction:'advance',nextAction:'CLOSING'});
});

async function until<T>(read:()=>Promise<T>,ready:(value:T)=>boolean,timeout=10_000){const deadline=performance.now()+timeout;while(true){const value=await read();if(ready(value))return value;if(performance.now()>deadline)throw new Error('PR07E_CONDITION_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,10));}}
async function beginLiveCapture(server:ServerChild,id:string,turn:RecordedTurn,staged=false){const channel=await socket(server,'a',id),answerId=randomUUID(),head=await view(server,'a',id);channel.ws.send(JSON.stringify({type:'command',action:'capture-start',command:envelope(randomUUID(),head,{turnId:turn.id,answerId,captureRevision:1,staged})}));const started=await channel.wait(m=>m.type==='command_result'&&m.action==='capture-start');assert.ok(started.value);channel.ws.send(Buffer.alloc(320,1));return {channel,answerId};}
test('E-DRAIN-12 same-server and other-server end wait for owner WS tail PCM and finish; missing marker remains an error',{timeout:600_000},async()=>{
  for(const mode of ['same-server','other-server','missing-marker'] as const){
    await configure(one,[],{transcript:'종료 직전 보존할 합성 원문입니다.',confirmed:true,captureError:false});const created=await create(one,'a','drain-'+mode+'-'+randomUUID()),capture=await beginLiveCapture(one,created.id,created.turn),other=mode==='other-server'?two:one;
    const input=envelope(randomUUID(),await view(other,'a',created.id),{elapsedMs:12000,metrics:{answerId:capture.answerId,durationMs:12000,captureFinishScope:{turnId:created.turn.id,answerId:capture.answerId,captureRevision:1}}}),pending=other.request<Reply>('a',`/api/sessions/${created.id}/end`,input);
    const accepted=await until(()=>sqlRows(pools,'session_end_intents',created.id),items=>items.length===1);
    if(mode!=='missing-marker'){
      capture.channel.ws.send(Buffer.alloc(160,2));capture.channel.ws.send(JSON.stringify({type:'command',action:'capture-finish',command:envelope(randomUUID(),{revision:input.expectedRevision,writerGeneration:input.writerGeneration},{turnId:created.turn.id,answerId:capture.answerId,captureRevision:1})}));
      const finished=await capture.channel.wait(m=>m.type==='command_result'&&m.action==='capture-finish');assert.ok(finished.value,JSON.stringify(finished));
    }
    const ended=await pending;assert.equal(ended.status,202,JSON.stringify(ended.value));const frozen=await snapshot(two,created.id),raw=JSON.parse(frozen.sessionJson) as InterviewSession,turn=raw.turns.at(-1)!;
    assert.ok(frozen.handoff);assert.equal((await sqlRows(pools,'session_evaluation_handoffs',created.id)).length,1);assert.equal((await sqlRows(pools,'session_end_intents',created.id)).length,1);assert.equal(raw.runtime!.evaluationJob,undefined);
    if(mode==='missing-marker'){assert.equal(turn.transcriptStatus,'error');assert.equal(turn.rawTranscript??'','');assert.equal(turn.answerObservation,undefined);}
    else{assert.equal(turn.transcriptStatus,'finalized');assert.equal(turn.rawTranscript,'종료 직전 보존할 합성 원문입니다.');assert.equal(turn.metadata.captureParts!.length,1);assert.equal(turn.metadata.captureParts![0].sha256,hash(turn.rawTranscript));}
    capture.channel.ws.close();rows.push({caseId:'E-DRAIN-12-'+mode,acceptedEndInputSha256:accepted[0].input_sha256,serverPids:[one.pid,other.pid],endIntentCount:1,handoffCount:1,tailBytesSent:mode==='missing-marker'?0:160,transcriptStatus:turn.transcriptStatus,rawTranscriptSha256:hash(turn.rawTranscript??''),missingMarkerFabricatedSilence:false,frozenSha256:frozen.sessionSha256,evaluationQueued:false});
  }
});
test('E-BUDGET-13 unrelated socket closure cannot close capture; staged answer cannot bypass approval; the actual 95-second deadline is not renewed on another server',{timeout:300_000},async()=>{
  await configure(one,[],{transcript:'95초 예산 검증용 합성 원문입니다.',confirmed:true,captureError:false,classifyAction:'advance',nextAction:'CLOSING'});
  const created=await create(one,'a','budget-'+randomUUID()),live=await beginLiveCapture(one,created.id,created.turn,true),unrelated=await socket(one,'a',created.id);
  const disconnected=new Promise<void>(resolve=>unrelated.ws.once('close',()=>resolve()));unrelated.ws.close();await disconnected;
  live.channel.ws.send(Buffer.alloc(640,3));
  const finish=await mutate<{confirmed:boolean;rawTranscript:string;submissionAttemptId:string}>(one,'a',created.id,'capture-finish',{turnId:created.turn.id,answerId:live.answerId,captureRevision:1});assert.equal(finish.status,200,JSON.stringify(finish.value));assert.equal(finish.value.result.confirmed,true);assert.equal(finish.value.result.rawTranscript,'95초 예산 검증용 합성 원문입니다.');
  const scope={turnId:created.turn.id,answerId:live.answerId,captureRevision:1,elapsedMs:6000,submissionAttemptId:finish.value.result.submissionAttemptId,endingObservation};
  const bypass=await mutate(one,'a',created.id,'answer',scope);assert.equal(bypass.status,409,JSON.stringify(bypass.value));assert.equal((await sqlRows(pools,'session_answer_facts',created.id)).length,0);
  const first=JSON.parse((await snapshot(one,created.id)).sessionJson) as InterviewSession,record=first.runtime!.submissionAttempts![`${scope.turnId}:${scope.answerId}:1`];assert.equal(Date.parse(record.deadlineAt)-Date.parse(record.startedAt),95_000);
  await configure(one,[{phase:'after-external',action:'answer-candidate',mode:'hold',once:true,timeoutMs:110_000}]);const key=randomUUID(),pending=mutate(one,'a',created.id,'answer-candidate',scope,key),barrier=await one.barrier('after-external',key);
  const original=JSON.parse((await snapshot(two,created.id)).sessionJson).runtime.submissionAttempts[`${scope.turnId}:${scope.answerId}:1`];assert.equal(original.deadlineAt,record.deadlineAt);assert.equal(original.attemptId,record.attemptId);
  const elapsedBeforeWait=Date.now()-Date.parse(record.startedAt),remaining=Math.max(0,Date.parse(record.deadlineAt)-Date.now()+100);
  await new Promise(resolve=>setTimeout(resolve,remaining));await release(one,barrier);const expired=await pending;assert.equal(expired.status,408,JSON.stringify(expired.value));assert.equal((expired.value as unknown as {code:string}).code,'TURN_WORK_TIMEOUT');
  const retry=await mutate(two,'a',created.id,'answer-candidate',scope,randomUUID(),true);assert.equal(retry.status,408,JSON.stringify(retry.value));assert.equal((retry.value as unknown as {code:string}).code,'TURN_WORK_TIMEOUT');
  const final=JSON.parse((await snapshot(two,created.id)).sessionJson).runtime.submissionAttempts[`${scope.turnId}:${scope.answerId}:1`];assert.equal(final.deadlineAt,record.deadlineAt);assert.equal(final.attemptId,record.attemptId);assert.equal((await sqlRows(pools,'session_answer_facts',created.id)).length,0);
  live.channel.ws.close();rows.push({caseId:'E-BUDGET-13',unrelatedSocketClosed:true,producerRemainedUsable:true,stagedBypassStatus:409,startedAt:record.startedAt,deadlineAt:record.deadlineAt,actualBudgetMs:95_000,elapsedBeforeWait,actualWaitMs:remaining,actualElapsedMs:Date.now()-Date.parse(record.startedAt),firstExpiredStatus:expired.status,otherServerRetryStatus:retry.status,deadlineUnchanged:true,attemptUnchanged:true,answerFacts:0});
});
test('E-END-DEADLINE-14 timed-out STT cannot gain another 15 seconds or become confirmed after a failed final commit and owner retry',{timeout:240_000},async()=>{
  await configure(one,[],{transcript:'기한 뒤 도착해 승인되면 안 되는 합성 원문입니다.',confirmed:true,captureError:false});
  const created=await create(one,'a','end-deadline-'+randomUUID()),capture=await beginLiveCapture(one,created.id,created.turn),scope={turnId:created.turn.id,answerId:capture.answerId,captureRevision:1};
  await configure(one,[{phase:'synthetic-stt-finish',sessionId:created.id,mode:'hold',once:true,timeoutMs:30_000},{phase:'before-commit',action:'end-finalize',sessionId:created.id,mode:'fail',once:true}]);
  const input=envelope(randomUUID(),await view(one,'a',created.id),{elapsedMs:17000,metrics:{answerId:capture.answerId,durationMs:17000,captureFinishScope:scope}}),pending=one.request<Reply>('a',`/api/sessions/${created.id}/end`,input);
  await until(()=>sqlRows(pools,'session_end_intents',created.id),items=>items.length===1);
  capture.channel.ws.send(Buffer.alloc(160,4));capture.channel.ws.send(JSON.stringify({type:'command',action:'capture-finish',command:envelope(randomUUID(),{revision:input.expectedRevision,writerGeneration:input.writerGeneration},scope)}));
  const provider=await one.barrier('synthetic-stt-finish'),draining=await snapshot(two,created.id),drain=(JSON.parse(draining.sessionJson) as InterviewSession).runtime as unknown as {endCaptureDrain:{providerDeadlineAt:string;markerReceivedAt:string}};
  assert.ok(drain.endCaptureDrain);const deadline=drain.endCaptureDrain.providerDeadlineAt,first=await pending;assert.equal(first.status,503,JSON.stringify(first.value));
  assert.ok(Date.now()>=Date.parse(deadline));const afterFailure=await snapshot(two,created.id);assert.equal(afterFailure.handoff,null);assert.equal(JSON.parse(afterFailure.sessionJson).runtime.endCaptureDrain.providerDeadlineAt,deadline);
  await release(one,provider);const socketError=await capture.channel.wait(m=>m.type==='error');assert.equal(socketError.status,503);
  const retried=await one.request<Reply>('a',`/api/sessions/${created.id}/end`,input);assert.equal(retried.status,202,JSON.stringify(retried.value));
  const frozen=await snapshot(two,created.id),session=JSON.parse(frozen.sessionJson) as InterviewSession,turn=session.turns.at(-1)!;
  assert.equal(JSON.parse(frozen.sessionJson).runtime.endCaptureDrain.providerDeadlineAt,deadline);assert.equal(turn.transcriptStatus,'error');assert.equal(turn.rawTranscript??'','');assert.equal(turn.answerObservation,undefined);assert.ok(frozen.handoff);assert.equal((await sqlRows(pools,'session_evaluation_handoffs',created.id)).length,1);assert.equal((await sqlRows(pools,'session_answer_facts',created.id)).length,0);
  capture.channel.ws.close();rows.push({caseId:'E-END-DEADLINE-14',providerDeadlineAt:deadline,firstFinalCommitStatus:503,lateProviderReleasedAfterDeadline:true,ownerRetryStatus:202,providerDeadlineRenewed:false,lateConfirmedPromoted:false,transcriptStatus:turn.transcriptStatus,rawTranscriptSha256:hash(turn.rawTranscript??''),handoffCount:1,answerFacts:0,frozenSha256:frozen.sessionSha256});
});
