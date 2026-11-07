import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { RequestAccessError, type AuthenticatedRequestContext, type RequestContext, type RequestIdentityBoundary } from '../auth/request-identity';
import { SessionCommandError, type SessionCommandRepository, type SessionCommandSnapshot, type SessionCommandReceipt, type SessionCommandStart,
  type SessionCommandIdentity, type SessionCommandIntent, type SessionCommandProgress, type SessionEnrollmentCapability } from '../session-writer/session-command-ports';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const hex=/^[a-f0-9]{64}$/u,uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u,revision=/^\d+$/u;
const kinds=['create','answer','next','event','capture','recover','closing','end-accept','end-finalize'];
const nonempty=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value===value.trim();
const invalid=()=>new SessionCommandError(400,'SESSION_COMMAND_INVALID');
const denied=()=>new SessionCommandError(403,'SESSION_ACCESS_DENIED');
const absent=()=>new SessionCommandError(404,'SESSION_NOT_FOUND');
const settings=['issuer','subject','account_id','account_revision','owner_id','student_id','application_target_id','job_id','worker_subject'];

export interface SessionEnrollmentAuthority {
  ownerId:string;studentId:string;applicationTargetId:string;supportTargetId:string;
  sessionId:string;creationKey:string;inputSha256:string;expiresAt:number;
  checkCurrent():Promise<boolean>;
}
const capabilities=new WeakMap<SessionEnrollmentCapability,Readonly<SessionEnrollmentAuthority>>();
export function createSessionEnrollmentCapability(value:SessionEnrollmentAuthority):SessionEnrollmentCapability {
  if(![value.ownerId,value.studentId,value.applicationTargetId,value.supportTargetId,value.creationKey].every(nonempty)||
    !uuid.test(value.sessionId)||value.creationKey.length>160||!hex.test(value.inputSha256)||!Number.isFinite(value.expiresAt)||typeof value.checkCurrent!=='function')throw denied();
  const cap=Object.freeze({kind:'session-enrollment-capability-v1' as const});
  capabilities.set(cap,Object.freeze({...value,checkCurrent:value.checkCurrent.bind(value)}));return cap;
}
function sameScope(value:{ownerId:string;studentId:string;applicationTargetId?:string;supportTargetId?:string},context:AuthenticatedRequestContext){
  if(!context.scope||value.ownerId!==context.account.ownerId||value.studentId!==context.scope.studentId||
    value.applicationTargetId!==context.scope.applicationTargetId||value.supportTargetId!==context.scope.supportTargetId)throw denied();
}
function json(text:unknown,max=16*1024*1024):string {
  if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>max||text.length<1)throw invalid();
  try{JSON.parse(text);}catch{throw invalid();}return text;
}
function identity(value:SessionCommandIdentity){
  if(!value||!uuid.test(value.sessionId)||!nonempty(value.key)||value.key.length>160||!kinds.includes(value.kind)||!hex.test(value.inputSha256)||
    !nonempty(value.semanticKey)||value.semanticKey.length>512||!hex.test(value.semanticSha256))throw invalid();
}
function condition(value:{expectedRevision:string;writerGeneration:string;writerToken:string}){
  if(!revision.test(value.expectedRevision)||!revision.test(value.writerGeneration)||value.writerGeneration==='0'||!uuid.test(value.writerToken))throw invalid();
}
function snapshot(value:unknown,context:AuthenticatedRequestContext):SessionCommandSnapshot|null {
  if(value===null)return null;const s=value as SessionCommandSnapshot;
  if(!s||s.version!=='authenticated-session-snapshot-v1'||!s.binding||!uuid.test(s.binding.sessionId)||
    !['db','read-only','local'].includes(s.writer)||!revision.test(s.revision)||!revision.test(s.writerGeneration)||s.writerGeneration==='0'||!uuid.test(s.writerToken)||typeof s.created!=='boolean'||!Number.isFinite(Date.parse(s.serverNow)))throw invalid();
  if(Object.hasOwn(s,'lastDisconnectedAt')&&(typeof s.lastDisconnectedAt!=='string'||!Number.isFinite(Date.parse(s.lastDisconnectedAt))))throw invalid();
  sameScope(s.binding,context);
  json(s.sessionJson);json(s.contextJson);json(s.pinsJson,1024*1024);
  if(!hex.test(s.sessionSha256)||sha(s.sessionJson)!==s.sessionSha256||!hex.test(s.contextSnapshotSha256)||sha(s.contextJson)!==s.contextSnapshotSha256||
    s.binding.contextSnapshotSha256!==s.contextSnapshotSha256||!hex.test(s.pinsSha256)||sha(s.pinsJson)!==s.pinsSha256)throw invalid();
  const body=JSON.parse(s.sessionJson);
  if(body.id!==s.binding.sessionId||body.runtime?.version!=='authenticated-session-runtime-v1'||body.runtime.owner?.mode!=='authenticated'||
    body.runtime.owner.id!==s.binding.ownerId||body.runtime.contextSnapshotSha256!==s.contextSnapshotSha256)throw invalid();
  if(s.endIntent){json(s.endIntent.inputJson);if(!uuid.test(s.endIntent.intentId)||sha(s.endIntent.inputJson)!==s.endIntent.inputSha256||!revision.test(s.endIntent.acceptedRevision))throw invalid();}
  if(s.handoff){json(s.handoff.payloadJson);if(!uuid.test(s.handoff.intentId)||s.handoff.version!=='session-evaluation-handoff-v1'||s.handoff.state!=='awaiting-evaluation-consumer'||
    sha(s.handoff.payloadJson)!==s.handoff.payloadSha256||s.handoff.contextSnapshotSha256!==s.contextSnapshotSha256||!hex.test(s.handoff.frozenSessionSha256)||!revision.test(s.handoff.committedRevision))throw invalid();}
  return s;
}
function receipt(value:unknown):SessionCommandReceipt|null{
  if(value===null)return null;const r=value as SessionCommandReceipt;identity(r);
  if(!uuid.test(r.operationId)||!revision.test(r.committedRevision)||r.committedRevision==='0'||!revision.test(r.writerGeneration)||r.writerGeneration==='0'||
    !hex.test(r.sessionSha256)||typeof r.replay!=='boolean'||!Number.isFinite(Date.parse(r.committedAt))||sha(json(r.resultJson))!==r.resultSha256)throw invalid();
  return r;
}
function start(value:unknown,context:AuthenticatedRequestContext):SessionCommandStart|null{
  if(value===null)return null;const r=value as SessionCommandStart;
  if(r.status==='committed'){const result=receipt(r.receipt);if(!result)throw invalid();return {status:'committed',receipt:result};}
  if(r.status!=='pending'||!r.intent)throw invalid();identity(r.intent);condition(r.intent);
  if(!uuid.test(r.intent.operationId)||!uuid.test(r.intent.attemptId)||!uuid.test(r.intent.operationToken))throw invalid();
  const s=snapshot(r.snapshot,context);if(!s||s.binding.sessionId!==r.intent.sessionId||s.revision!==r.intent.expectedRevision||s.writerGeneration!==r.intent.writerGeneration||s.writerToken!==r.intent.writerToken)throw invalid();
  return {status:'pending',intent:r.intent,snapshot:s};
}
function progress(value:SessionCommandProgress){
  json(value.sessionJson);if(!Array.isArray(value.events)||value.events.length<1||value.events.length>256)throw invalid();
  for(const event of value.events)if(!nonempty(event.eventId)||event.eventId.length>160||!nonempty(event.kind)||event.kind.length>128)throw invalid();else json(event.payloadJson,1024*1024);
}
function sqlError(error:unknown,commitStarted:boolean):Error {
  if(error instanceof SessionCommandError||error instanceof RequestAccessError)return error;
  const code=(error as {code?:string})?.code;
  const known:Record<string,[number,string]>={P7101:[409,'SESSION_IDEMPOTENCY_CONFLICT'],P7102:[409,'SESSION_REVISION_CONFLICT'],P7103:[409,'SESSION_WRITER_STALE'],
    P7104:[409,'SESSION_INPUT_FROZEN'],P7105:[409,'SESSION_SEMANTIC_CONFLICT'],'42501':[404,'SESSION_NOT_FOUND'],
    P7106:[408,'SESSION_TURN_WORK_TIMEOUT'],P7107:[409,'SESSION_TURN_WORK_CANCELLED'],
    '22023':[400,'SESSION_COMMAND_INVALID'],'22P02':[400,'SESSION_COMMAND_INVALID'],'23505':[409,'SESSION_SEMANTIC_CONFLICT'],'23503':[409,'SESSION_RELATION_CONFLICT'],'23514':[409,'SESSION_INVARIANT_CONFLICT'],
    '57014':[503,'SESSION_DATABASE_TIMEOUT'],'55P03':[503,'SESSION_DATABASE_TIMEOUT'],'40P01':[409,'SESSION_REVISION_CONFLICT']};
  if(code&&known[code])return new SessionCommandError(...known[code]);
  return new SessionCommandError(503,commitStarted?'SESSION_COMMIT_UNKNOWN':'SESSION_DATABASE_UNAVAILABLE');
}

/** Credentials/pools and the isolated composition are explicit. No production
 * env fallback, arbitrary callback, local SessionStore save or provider I/O. */
export function createPostgresSessionCommandRepository(options:{
  boundary:RequestIdentityBoundary;requestPool:Pool;mappingPool:Pool;environment:'isolated-session-writer';now?:()=>number;statementTimeoutMs?:number;
}):SessionCommandRepository {
  if(options.environment!=='isolated-session-writer'||process.env.NODE_ENV==='production')throw denied();
  const {boundary,requestPool,mappingPool}=options,now=options.now??Date.now,timeout=options.statementTimeoutMs??5000;
  if(!Number.isInteger(timeout)||timeout<1||timeout>30000)throw invalid();
  async function current(context:RequestContext){const value=await boundary.revalidate(context);if(value.mode!=='authenticated'||!value.scope)throw denied();return value;}
  async function cap(context:AuthenticatedRequestContext,value:SessionEnrollmentCapability,input:{sessionId:string;creationKey:string;inputSha256:string}){
    const permit=capabilities.get(value);if(!permit||now()>=permit.expiresAt||permit.sessionId!==input.sessionId||permit.creationKey!==input.creationKey||permit.inputSha256!==input.inputSha256)throw denied();
    sameScope(permit,context);let allowed=false;try{allowed=await permit.checkCurrent();}catch{/* fail closed */}if(!allowed||now()>=permit.expiresAt)throw denied();
  }
  async function tx<T>(context:RequestContext,role:'gakja_request'|'gakja_mapping',sql:string,args:unknown[],validate:(value:unknown,context:AuthenticatedRequestContext)=>T,
    permit?:{value:SessionEnrollmentCapability;input:{sessionId:string;creationKey:string;inputSha256:string}}):Promise<T>{
    const selected=await current(context);if(permit)await cap(selected,permit.value,permit.input);
    let client:PoolClient|undefined,begun=false,healthy=true,commitStarted=false,result:T;
    try{
      client=await(role==='gakja_request'?requestPool:mappingPool).connect();boundary.selectScope(selected,{});
      const r=(await client.query(`SELECT current_user::text current,session_user::text session,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
        EXISTS(SELECT 1 FROM pg_roles p WHERE (p.rolsuper OR p.rolbypassrls OR p.rolname='gakja_owner') AND pg_has_role(current_user,p.oid,'MEMBER')) elevated FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
      if(!r||r.current!==role||r.session!==role||r.rolsuper||r.rolbypassrls||r.rolcreaterole||r.rolcreatedb||r.elevated)throw denied();
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');begun=true;
      const values=[selected.principal.issuer,selected.principal.subject,selected.account.accountId,selected.account.revision,selected.account.ownerId,selected.scope!.studentId,selected.scope!.applicationTargetId,'',''];
      for(let i=0;i<settings.length;i++)await client.query('SELECT set_config($1,$2,true)',['gakja.'+settings[i],values[i]]);
      await client.query("SELECT set_config('statement_timeout',$1,true)",[String(timeout)]);
      const account=(await client.query('SELECT gakja.resolve_account($1,$2) value',[selected.principal.issuer,selected.principal.subject])).rows[0]?.value;
      if(!account||account.accountId!==selected.account.accountId||account.ownerId!==selected.account.ownerId||account.revision!==selected.account.revision)throw denied();
      result=validate((await client.query(sql,args)).rows[0]?.value??null,selected);
      boundary.selectScope(selected,{});commitStarted=true;await client.query('COMMIT');begun=false;
    }catch(error){if(client&&begun)try{await client.query('ROLLBACK');}catch{healthy=false;}throw sqlError(error,commitStarted);}
    finally{
      if(client){try{await client.query('RESET ALL');healthy=healthy&&(await client.query(`SELECT ${settings.map((_,i)=>`coalesce(current_setting($${i+1},true),'')=''`).join(' AND ')} clean`,settings.map(k=>'gakja.'+k))).rows[0]?.clean===true;}catch{healthy=false;}client.release(!healthy);}
    }
    await current(selected);if(permit)await cap(selected,permit.value,permit.input);return result;
  }
  const required=<T>(value:T|null):T=>{if(value===null)throw absent();return value;};
  function validateIntent(value:SessionCommandIntent){identity(value);condition(value);if(!uuid.test(value.operationId)||!uuid.test(value.attemptId)||!uuid.test(value.operationToken))throw invalid();}
  return Object.freeze({
    async enroll(context,input,capability){
      if(!uuid.test(input.sessionId)||!nonempty(input.creationKey)||input.creationKey.length>160||!hex.test(input.inputSha256)||!hex.test(input.sourceSha256))throw invalid();
      json(input.sessionJson);json(input.contextJson);json(input.pinsJson,1024*1024);
      if(Object.hasOwn(input,'sourceRevision')&&input.sourceRevision!==null&&!nonempty(input.sourceRevision))throw invalid();
      return required(await tx(context,'gakja_mapping','SELECT gakja.session_enroll($1::jsonb) value',[JSON.stringify(input)],snapshot,{value:capability,input}));
    },
    findCreation:(context,key,inputSha256)=>{
      if(!nonempty(key)||key.length>160||!hex.test(inputSha256))throw invalid();
      return tx(context,'gakja_request','SELECT gakja.session_find_creation($1,$2) value',[key,inputSha256],snapshot);
    },
    read:(context,id)=>uuid.test(id)?tx(context,'gakja_request','SELECT gakja.session_read($1) value',[id],snapshot):Promise.resolve(null),
    async list(context){return tx(context,'gakja_request','SELECT gakja.session_list() value',[],(value,ctx)=>{
      if(!Array.isArray(value)||value.length>256)throw invalid();return value.map(v=>required(snapshot(v,ctx)));
    });},
    async observeConnectionClosed(context,input){
      if(!uuid.test(input.sessionId)||!revision.test(input.writerGeneration)||input.writerGeneration==='0'||!uuid.test(input.connectionToken))throw invalid();
      return tx(context,'gakja_request','SELECT gakja.session_observe_connection_closed($1,$2::bigint,$3::uuid) value',[input.sessionId,input.writerGeneration,input.connectionToken],value=>{
        if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))throw invalid();return value;
      });
    },
    receipt:(context,input)=>{identity(input);return tx(context,'gakja_request','SELECT gakja.session_receipt($1::jsonb) value',[JSON.stringify(input)],receipt);},
    findCommitted:(context,input)=>{identity(input);return tx(context,'gakja_request','SELECT gakja.session_find_committed($1::jsonb) value',[JSON.stringify(input)],receipt);},
    receiptByKey:(context,input)=>{
      if(!uuid.test(input.sessionId)||!nonempty(input.key)||input.key.length>160||!hex.test(input.inputSha256))throw invalid();
      return tx(context,'gakja_request','SELECT gakja.session_receipt_by_key($1,$2,$3) value',[input.sessionId,input.key,input.inputSha256],receipt);
    },
    async beginIntent(context,input){identity(input);condition(input);return required(await tx(context,'gakja_request','SELECT gakja.session_begin($1::jsonb) value',[JSON.stringify(input)],start));},
    async persistProgress(context,intent,value){validateIntent(intent);progress(value);return required(await tx(context,'gakja_request','SELECT gakja.session_progress($1::jsonb,$2::jsonb) value',[JSON.stringify(intent),JSON.stringify(value)],start));},
    async commit(context,intent,value){
      validateIntent(intent);progress(value);json(value.resultJson);
      if(value.answerFact&&(!uuid.test(value.answerFact.turnId)||!nonempty(value.answerFact.answerId)||value.answerFact.answerId.length>160||!Number.isSafeInteger(value.answerFact.captureRevision)||value.answerFact.captureRevision<1||!hex.test(value.answerFact.inputSha256)))throw invalid();
      if(value.endIntent&&(!uuid.test(value.endIntent.intentId)||sha(json(value.endIntent.inputJson))!==value.endIntent.inputSha256))throw invalid();
      if(value.handoff&&(!uuid.test(value.handoff.intentId)||sha(json(value.handoff.payloadJson))!==value.handoff.payloadSha256||sha(value.sessionJson)!==value.handoff.frozenSessionSha256))throw invalid();
      return required(await tx(context,'gakja_request','SELECT gakja.session_commit($1::jsonb,$2::jsonb) value',[JSON.stringify(intent),JSON.stringify(value)],receipt));
    },
    async claimWriter(context,input){condition(input);return required(await tx(context,'gakja_request','SELECT gakja.session_fence($1::jsonb,$2) value',[JSON.stringify(input),'claim'],snapshot));},
    async freeze(context,input){condition(input);return required(await tx(context,'gakja_request','SELECT gakja.session_fence($1::jsonb,$2) value',[JSON.stringify(input),'freeze'],snapshot));},
    async rollbackUncommitted(context,input){condition(input);return required(await tx(context,'gakja_request','SELECT gakja.session_fence($1::jsonb,$2) value',[JSON.stringify(input),'local'],snapshot));},
    async exportPreservation(context,id){
      if(!uuid.test(id))throw invalid();const value=required(await tx(context,'gakja_request','SELECT gakja.session_export($1) value',[id],v=>v));
      const payloadJson=JSON.stringify(value);return {version:'session-preservation-v1',payloadJson,sha256:sha(payloadJson)};
    },
    async restorePreservation(context,bundle,capability){
      if(bundle.version!=='session-preservation-v1'||sha(json(bundle.payloadJson,64*1024*1024))!==bundle.sha256)throw invalid();
      const value=JSON.parse(bundle.payloadJson),s=value.session;
      if(!s||!uuid.test(s.session_id)||!nonempty(s.creation_key)||!hex.test(s.creation_input_sha256))throw invalid();
      const input={sessionId:s.session_id,creationKey:s.creation_key,inputSha256:s.creation_input_sha256};
      return required(await tx(context,'gakja_mapping','SELECT gakja.session_restore($1::jsonb) value',[bundle.payloadJson],snapshot,{value:capability,input}));
    },
  } satisfies SessionCommandRepository);
}

/** Alias retains a concise name for trusted server composition. */
export const createPostgresSessionWriter=createPostgresSessionCommandRepository;
