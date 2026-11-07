import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { SignJWT } from 'jose';
import { prepareExactCBaseline } from './pr07d-baseline.mjs';

// Two independent application DB endpoints and two independent official Storage
// stacks. No operating DATABASE_URL/bucket/credentials are read or adopted.
const storageImage='supabase/storage-api:v1.89.12@sha256:8526956cb462e9f7d392e9848ec77133b2769982ed614e9753cc687e8e4339a6';
const postgresImage='postgres:17.11';
const runId=process.env.PR07G_TEST_RUN_ID??'storage_'+randomBytes(10).toString('hex');
if(!/^[a-z0-9_]{8,48}$/u.test(runId))throw new Error('PR07G_RUN_ID_INVALID');
const output=path.resolve(process.env.PR07G_TEST_OUTPUT??'artifacts/pr07g/storage-'+runId);
if(!output.startsWith(path.resolve('artifacts/pr07g')+path.sep))throw new Error('PR07G_OWNED_REPORT_DIRECTORY_REQUIRED');
await mkdir(output,{recursive:true});
const execute=promisify(execFile), secrets=[], containers=[], stacks=[];
const redact=value=>secrets.reduce((text,secret)=>text.replaceAll(secret,'[redacted]'),String(value)).replace(/([?&]token=)[^\s"'<>]+/gu,'$1[redacted]').replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gu,'[database-url]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,'[redacted-jwt]');
const report={version:'pr07g-owned-two-endpoint-transition-recovery-run-v1',runId,status:'running',startedAt:new Date().toISOString(),pid:process.pid,
  storageImage,postgresImage,operatingInputsUsed:false,actualStudentDataTransferred:false,providerBackend:'official Supabase Storage API/internal file backend',
  sourceCommit:(await execute('git',['rev-parse','HEAD'])).stdout.trim(),sourceStatus:(await execute('git',['status','--porcelain=v1','-uall'])).stdout.trim(),resources:[],cleanup:[],phases:[]};
let networkId;
const phase=(name,event)=>{report.phases.push({name,event,utc:new Date().toISOString(),monotonicMs:performance.now(),pid:process.pid});};
async function docker(args){return(await execute('docker',args,{windowsHide:true,timeout:240_000,maxBuffer:8_000_000})).stdout.trim();}
async function markedContainer(id){if(await docker(['inspect',id,'--format','{{ index .Config.Labels "gakja.pr07g.run" }}'])!==runId)throw new Error('PR07G_CONTAINER_MARKER_MISMATCH');}
async function ownContainer(name,args){const id=await docker(['run','--detach','--name',name,'--label','gakja.pr07g.run='+runId,'--label','gakja.pr07g.disposable=true','--network',networkId,...args]);containers.push(id);report.resources.push({type:'container',id,name});return id;}
async function pgReady(id,database){for(let attempt=0;attempt<80;attempt++){try{await docker(['exec',id,'pg_isready','-h','127.0.0.1','-U','postgres','-d',database]);return;}catch{await new Promise(resolve=>setTimeout(resolve,500));}}throw new Error('PR07G_OWNED_PG_NOT_READY');}
async function port(id,internal){const value=await docker(['port',id,internal]);const match=value.match(/^127\.0\.0\.1:(\d+)$/u);if(!match)throw new Error('PR07G_LOOPBACK_PORT_REQUIRED');return match[1];}
async function api(stack,route,init={},timeout=10_000){return fetch(stack.apiUrl+route,{...init,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(timeout),headers:{Authorization:'Bearer '+stack.serviceKey,'Content-Type':'application/json',...init.headers}});}
async function bodyCancelled(response){await response.body?.cancel();}
async function createStack(kind){
  phase(kind+'-setup','start');
  const adminPassword=randomBytes(24).toString('hex'),storagePassword=randomBytes(24).toString('hex'),jwtSecret=randomBytes(32).toString('hex');
  secrets.push(adminPassword,storagePassword,jwtSecret);
  const database='pr07g_admin_'+randomBytes(8).toString('hex');
  const appDb=await ownContainer('pr07g-'+runId+'-'+kind+'-appdb',['--network-alias',kind+'-app-db','--tmpfs','/var/lib/postgresql/data:rw','-e','POSTGRES_DB='+database,'-e','POSTGRES_USER=postgres','-e','POSTGRES_PASSWORD='+adminPassword,'-p','127.0.0.1::5432',postgresImage]);
  const storageDb=await ownContainer('pr07g-'+runId+'-'+kind+'-providerdb',['--network-alias',kind+'-provider-db','--tmpfs','/var/lib/postgresql/data:rw','-e','POSTGRES_DB=postgres','-e','POSTGRES_USER=postgres','-e','POSTGRES_PASSWORD='+storagePassword,postgresImage]);
  await pgReady(appDb,database);await pgReady(storageDb,'postgres');await markedContainer(appDb);await markedContainer(storageDb);
  const appPort=await port(appDb,'5432/tcp'),bootstrapUrl=`postgresql://postgres:${adminPassword}@127.0.0.1:${appPort}/${database}`;
  const marker=new pg.Client({connectionString:bootstrapUrl});await marker.connect();
  try{await marker.query('CREATE TABLE public.pr07g_disposable_marker(run_id text PRIMARY KEY,marker text NOT NULL)');await marker.query('INSERT INTO public.pr07g_disposable_marker VALUES($1,$2)',[runId,'gakja-pr07g-'+kind+'-disposable-only']);}finally{await marker.end();}
  const jwt=role=>new SignJWT({role}).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('3h').sign(new TextEncoder().encode(jwtSecret));
  const serviceKey=await jwt('service_role'),anonKey=await jwt('anon');secrets.push(serviceKey,anonKey);
  const dbUrl=`postgresql://postgres:${storagePassword}@${kind}-provider-db:5432/postgres`;
  const settings={SERVER_PORT:'5000',AUTH_JWT_SECRET:jwtSecret,AUTH_JWT_ALGORITHM:'HS256',ANON_KEY:anonKey,SERVICE_KEY:serviceKey,
    DATABASE_URL:dbUrl,DATABASE_POOL_URL:dbUrl,DB_INSTALL_ROLES:'true',DB_SUPER_USER:'postgres',STORAGE_BACKEND:'file',STORAGE_FILE_BACKEND_PATH:'/var/lib/storage',
    STORAGE_S3_BUCKET:'pr07g-internal',TENANT_ID:'pr07g-'+kind,REGION:'local',UPLOAD_FILE_SIZE_LIMIT:'16777216',UPLOAD_FILE_SIZE_LIMIT_STANDARD:'16777216',
    UPLOAD_SIGNED_URL_EXPIRATION_TIME:'7200',IMAGE_TRANSFORMATION_ENABLED:'false',JWT_CACHING_ENABLED:'false',LOG_LEVEL:'error',S3_PROTOCOL_ACCESS_KEY_ID:'pr07g-synthetic',S3_PROTOCOL_ACCESS_KEY_SECRET:randomBytes(32).toString('hex')};
  secrets.push(settings.S3_PROTOCOL_ACCESS_KEY_SECRET);
  const storage=await ownContainer('pr07g-'+runId+'-'+kind+'-storage',['--network-alias',kind+'-storage','--tmpfs','/var/lib/storage:rw,mode=1777',...Object.entries(settings).flatMap(([name,value])=>['-e',name+'='+value]),'-p','127.0.0.1::5000',storageImage]);
  const stack={kind,appDb,storageDb,storage,bootstrapUrl,apiUrl:'http://127.0.0.1:'+await port(storage,'5000/tcp'),serviceKey,anonKey,
    bucket:'pr07g-'+randomBytes(10).toString('hex'),keyPrefix:'run_'+randomBytes(12).toString('hex'),controlBucket:'pr07g-control-'+randomBytes(8).toString('hex'),controlBytes:Buffer.from('PR07G independent '+kind+' unrelated control'),createdBucket:false,createdControl:false};
  stacks.push(stack);
  const deadline=Date.now()+90_000;let healthy=false;
  while(Date.now()<deadline){try{const response=await api(stack,'/bucket',{},2_000);healthy=response.ok;await bodyCancelled(response);if(healthy)break;}catch{/* API owns its own migration readiness */}await new Promise(resolve=>setTimeout(resolve,500));}
  if(!healthy)throw new Error('PR07G_ACTUAL_STORAGE_NOT_READY');
  let response=await api(stack,'/bucket',{method:'POST',body:JSON.stringify({id:stack.bucket,name:stack.bucket,public:false,file_size_limit:16777216})});
  if(!response.ok)throw new Error('PR07G_PRIVATE_BUCKET_CREATE_FAILED');await bodyCancelled(response);stack.createdBucket=true;
  response=await api(stack,'/bucket/'+stack.bucket);const info=await response.json();
  if(!response.ok||info.id!==stack.bucket||info.public!==false)throw new Error('PR07G_PRIVATE_BUCKET_VERIFICATION_FAILED');
  response=await api(stack,'/bucket',{method:'POST',body:JSON.stringify({id:stack.controlBucket,name:stack.controlBucket,public:false})});
  if(!response.ok)throw new Error('PR07G_CONTROL_BUCKET_CREATE_FAILED');await bodyCancelled(response);stack.createdControl=true;
  response=await api(stack,'/object/'+stack.controlBucket+'/unrelated-control',{method:'POST',headers:{'Content-Type':'application/octet-stream','x-upsert':'false'},body:stack.controlBytes});
  if(!response.ok)throw new Error('PR07G_CONTROL_UPLOAD_FAILED');await bodyCancelled(response);
  report.resources.push({type:'stack-evidence',kind,appPgImageId:await docker(['inspect',appDb,'--format','{{.Image}}']),providerPgImageId:await docker(['inspect',storageDb,'--format','{{.Image}}']),storageImageId:await docker(['inspect',storage,'--format','{{.Image}}']),apiOrigin:stack.apiUrl,privateBucket:stack.bucket,controlSha256:createHash('sha256').update(stack.controlBytes).digest('hex')});
  phase(kind+'-setup','end');return stack;
}
async function cleanupStack(stack){
  if(stack.createdBucket){
    for(const part of ['staging','final'])for(let batch=0;batch<100;batch++){
      const prefix=stack.keyPrefix+'/'+part,response=await api(stack,'/object/list/'+stack.bucket,{method:'POST',body:JSON.stringify({prefix,limit:100,offset:0})});
      if(!response.ok)throw new Error('PR07G_OWN_OBJECT_LIST_FAILED');const rows=await response.json();
      if(!Array.isArray(rows)||rows.some(row=>typeof row.name!=='string'||!/^[a-f0-9-]{36}$/u.test(row.name)))throw new Error('PR07G_UNEXPECTED_OBJECT_KEY_REFUSED');
      if(!rows.length)break;const removed=await api(stack,'/object/'+stack.bucket,{method:'DELETE',body:JSON.stringify({prefixes:rows.map(row=>prefix+'/'+row.name)})});
      if(!removed.ok)throw new Error('PR07G_OWN_OBJECT_DELETE_FAILED');await bodyCancelled(removed);if(batch===99)throw new Error('PR07G_CLEANUP_BOUND_EXCEEDED');
    }
    const response=await api(stack,'/bucket/'+stack.bucket,{method:'DELETE'});if(!response.ok)throw new Error('PR07G_OWN_BUCKET_DELETE_FAILED');await bodyCancelled(response);
  }
  if(stack.createdControl){
    const response=await api(stack,'/object/authenticated/'+stack.controlBucket+'/unrelated-control');if(!response.ok||!Buffer.from(await response.arrayBuffer()).equals(stack.controlBytes))throw new Error('PR07G_UNRELATED_CONTROL_CHANGED');
    let removed=await api(stack,'/object/'+stack.controlBucket,{method:'DELETE',body:JSON.stringify({prefixes:['unrelated-control']})});if(!removed.ok)throw new Error('PR07G_CONTROL_DELETE_FAILED');await bodyCancelled(removed);
    removed=await api(stack,'/bucket/'+stack.controlBucket,{method:'DELETE'});if(!removed.ok)throw new Error('PR07G_CONTROL_BUCKET_DELETE_FAILED');await bodyCancelled(removed);
  }
  report.cleanup.push({type:'private-buckets',kind:stack.kind,ownedNamespaceOnly:true,controlUnchanged:true,removedByOfficialApi:true});
}
try{
  await docker(['info','--format','{{.ServerVersion}}']);
  await mkdir(path.resolve('artifacts/pr07d'),{recursive:true});phase('exact-c-baseline','start');
  const baseline=await prepareExactCBaseline({runId,reportDirectory:output});phase('exact-c-baseline','end');report.baseline=baseline.report;
  networkId=await docker(['network','create','--label','gakja.pr07g.run='+runId,'pr07g-'+runId]);report.resources.push({type:'network',id:networkId});
  const source=await createStack('primary'),restore=await createStack('restore');
  if(source.apiUrl===restore.apiUrl||new URL(source.bootstrapUrl).host===new URL(restore.bootstrapUrl).host)throw new Error('PR07G_ENDPOINTS_NOT_INDEPENDENT');
  if(process.env.GITHUB_ACTIONS==='true')for(const secret of secrets)process.stdout.write('::add-mask::'+secret+'\n');
  const env={...process.env,PR07G_TEST_DISPOSABLE:'1',PR07G_TEST_RUN_ID:runId,PR07G_TEST_OUTPUT:output,PR07G_TEST_WITH_STORAGE:'1',
    PR07G_TEST_FIXTURE_ROOT:baseline.fixtureRoot,PR07G_TEST_BASELINE_RESULT:baseline.baselineResult,PR07G_TEST_BASELINE_CODE_ROOT:baseline.codeRoot};
  for(const stack of stacks){const prefix=stack.kind==='restore'?'RESTORE_':'';Object.assign(env,Object.fromEntries(Object.entries({BOOTSTRAP_URL:stack.bootstrapUrl,STORAGE_API_URL:stack.apiUrl,STORAGE_SERVICE_KEY:stack.serviceKey,STORAGE_ANON_KEY:stack.anonKey,BUCKET:stack.bucket,KEY_PREFIX:stack.keyPrefix}).map(([name,value])=>['PR07G_TEST_'+prefix+name,value])));}
  phase('actual-transition-suite','start');const command=['scripts/run-pr07g-db-tests.mjs'];const child=spawn(process.execPath,command,{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let log='';
  child.stdout.on('data',value=>{log+=value;});child.stderr.on('data',value=>{log+=value;});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});phase('actual-transition-suite','end');
  await writeFile(path.join(output,'storage-tests.log'),redact(log));report.command='node '+command.join(' ');report.testExitCode=code;
  if(code!==0)throw new Error('PR07G_ACTUAL_TRANSITION_SUITE_FAILED');report.status='passed';
}catch(error){report.status='failed';report.error=redact(error?.message??error);process.exitCode=1;}
finally{
  phase('cleanup','start');
  for(const stack of stacks.reverse())try{await cleanupStack(stack);}catch(error){report.cleanup.push({kind:stack.kind,error:redact(error.message)});process.exitCode=1;}
  for(const id of [...containers].reverse())try{await markedContainer(id);const logs=await execute('docker',['logs',id],{windowsHide:true,maxBuffer:8_000_000}).then(value=>value.stdout+value.stderr).catch(()=> '');await writeFile(path.join(output,'container-'+id+'.log'),redact(logs));await docker(['rm','--force',id]);report.cleanup.push({type:'container',id,owned:true,removed:true});}catch(error){report.cleanup.push({type:'container',id,error:redact(error.message)});process.exitCode=1;}
  if(networkId)try{if(await docker(['network','inspect',networkId,'--format','{{ index .Labels "gakja.pr07g.run" }}'])!==runId)throw new Error('PR07G_NETWORK_MARKER_MISMATCH');await docker(['network','rm',networkId]);report.cleanup.push({type:'network',owned:true,removed:true});}catch(error){report.cleanup.push({type:'network',error:redact(error.message)});process.exitCode=1;}
  phase('cleanup','end');if(process.exitCode)report.status='failed';report.finishedAt=new Date().toISOString();report.exitCode=process.exitCode??0;await writeFile(path.join(output,'storage-run.json'),JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify({status:report.status,sourceCommit:report.sourceCommit,actualStorageImage:storageImage,independentAppEndpoints:2,independentPrivateStorageEndpoints:2,containers:report.resources.filter(r=>r.type==='container').length,output,exitCode:report.exitCode}));
