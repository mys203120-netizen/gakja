import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import pg from 'pg';
import { prepareExactCBaseline } from './pr07d-baseline.mjs';
import { reuseOwnedDiagnosticBaseline } from './pr07g-diagnostic-baseline.mjs';

// Local diagnostic: two fresh native PostgreSQL clusters, controlled object
// bytes and raw model only. It never claims the official Storage acceptance.
const runId=process.env.PR07G_TEST_RUN_ID??'local_'+randomBytes(10).toString('hex');
if(!/^[a-z0-9_]{8,48}$/u.test(runId))throw new Error('PR07G_RUN_ID_INVALID');
const configured=process.env.PR07G_TEST_PG_BIN;
if(!configured)throw new Error('PR07G_EXPLICIT_PORTABLE_PG_BIN_REQUIRED');
if(process.env.GITHUB_ACTIONS==='true')throw new Error('PR07G_CI_REQUIRES_OFFICIAL_STORAGE');
const bin=await realpath(configured), output=path.resolve('artifacts/pr07g/local-'+runId);
await mkdir(output);await writeFile(path.join(output,'ownership.json'),JSON.stringify({runId,marker:'gakja-pr07g-owned-native-pg-diagnostic-only'}));
const execute=promisify(execFile), clusters=[], secrets=[];
const redact=value=>secrets.reduce((s,secret)=>s.replaceAll(secret,'[redacted]'),String(value)).replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gu,'[database-url]');
const report={version:'pr07g-owned-native-two-pg-diagnostic-v1',runId,status:'running',startedAt:new Date().toISOString(),officialStorageGateSatisfied:false,clusters:[],output};
let reusedBaseline;
const program=name=>path.join(bin,name+(process.platform==='win32'?'.exe':''));
async function freePort(){const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const address=server.address();const port=address.port;await new Promise(resolve=>server.close(resolve));return port;}
async function cli(name,args){return execute(program(name),args,{windowsHide:true,timeout:60_000,maxBuffer:4_000_000});}
async function cluster(kind){
  const root=path.join(output,kind);await mkdir(root);const data=path.join(root,'data'),password=randomBytes(24).toString('base64url'),passwordFile=path.join(root,'init-password');secrets.push(password);
  await writeFile(path.join(root,'ownership.json'),JSON.stringify({runId,kind,marker:'gakja-pr07g-owned-native-cluster-only'}));
  await writeFile(passwordFile,password+'\n',{mode:0o600});
  try{await cli('initdb',['-D',data,'-U','postgres','--auth=scram-sha-256','--pwfile='+passwordFile,'--encoding=UTF8','--locale=C']);}finally{await rm(passwordFile,{force:true});}
  const port=await freePort();const value={kind,root,data,port,started:false};clusters.push(value);
  // On Windows the daemon inherits pipe handles. Observe the launcher's exit
  // with ignored stdio, as the retained F launcher does, rather than waiting
  // for the server's inherited pipe to close.
  value.started=true;
  await new Promise((resolve,reject)=>{
    const child=spawn(program('pg_ctl'),['-D',data,'-l',path.join(root,'postgres.log'),'-o','-h 127.0.0.1 -p '+port,'-w','-t','30','start'],{windowsHide:true,stdio:'ignore'});
    child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('PR07G_NATIVE_PG_START_FAILED')));
  });
  const database='pr07g_admin_'+randomBytes(8).toString('hex'),base=`postgresql://postgres:${password}@127.0.0.1:${port}/postgres`;
  const client=new pg.Client({connectionString:base});await client.connect();
  try{await client.query('CREATE DATABASE '+database);}finally{await client.end();}
  const url=new URL(base);url.pathname='/'+database;const marker=new pg.Client({connectionString:url.href});await marker.connect();
  try{await marker.query('CREATE TABLE public.pr07g_disposable_marker(run_id text PRIMARY KEY,marker text NOT NULL)');await marker.query('INSERT INTO public.pr07g_disposable_marker VALUES($1,$2)',[runId,'gakja-pr07g-'+kind+'-disposable-only']);}finally{await marker.end();}
  report.clusters.push({kind,endpoint:{hostname:'127.0.0.1',port},owned:true,postgresVersion:(await cli('postgres',['--version'])).stdout.trim()});return url.href;
}
try{
  const primary=await cluster('primary'),restore=await cluster('restore');
  const env={...process.env,PR07G_TEST_RUN_ID:runId,PR07G_TEST_DISPOSABLE:'1',PR07G_TEST_BOOTSTRAP_URL:primary,PR07G_TEST_RESTORE_BOOTSTRAP_URL:restore,PR07G_TEST_OUTPUT:output,
    PR07G_TEST_CONTROLLED_PROVIDER_DIAGNOSTIC:'1'};
  if(process.env.PR07G_TEST_WITH_STORAGE==='1'){
    await mkdir(path.resolve('artifacts/pr07d'),{recursive:true});
    const baseline=process.env.PR07G_TEST_REUSE_BASELINE_ROOT
      ?await reuseOwnedDiagnosticBaseline(process.env.PR07G_TEST_REUSE_BASELINE_ROOT,{kind:'native-controlled-diagnostic'})
      :await prepareExactCBaseline({runId,reportDirectory:output});
    if('verifyUnchanged' in baseline)reusedBaseline=baseline;
    report.baseline=baseline.report;
    if(reusedBaseline)await writeFile(path.join(output,'diagnostic-baseline-reuse.json'),JSON.stringify(reusedBaseline.report,null,2)+'\n');
    Object.assign(env,{PR07G_TEST_WITH_STORAGE:'1',PR07G_TEST_FIXTURE_ROOT:baseline.fixtureRoot,PR07G_TEST_BASELINE_RESULT:baseline.baselineResult,PR07G_TEST_BASELINE_CODE_ROOT:baseline.codeRoot,
      PR07G_TEST_STORAGE_API_URL:'http://127.0.0.1:1',PR07G_TEST_STORAGE_SERVICE_KEY:'synthetic-diagnostic-no-endpoint',PR07G_TEST_STORAGE_ANON_KEY:'synthetic-diagnostic-no-endpoint',PR07G_TEST_BUCKET:'pr07g-diagnostic-source',PR07G_TEST_KEY_PREFIX:'diagnosticsource',
      PR07G_TEST_RESTORE_STORAGE_API_URL:'http://127.0.0.1:2',PR07G_TEST_RESTORE_STORAGE_SERVICE_KEY:'synthetic-diagnostic-no-endpoint',PR07G_TEST_RESTORE_STORAGE_ANON_KEY:'synthetic-diagnostic-no-endpoint',PR07G_TEST_RESTORE_BUCKET:'pr07g-diagnostic-restore',PR07G_TEST_RESTORE_KEY_PREFIX:'diagnosticrestore'});
  }
  const child=spawn(process.execPath,['scripts/run-pr07g-db-tests.mjs'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let log='',progress=Promise.resolve();
  const observe=value=>{log+=value;progress=progress.then(()=>writeFile(path.join(output,'native-progress.log'),redact(log)));};child.stdout.on('data',observe);child.stderr.on('data',observe);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});await progress;await writeFile(path.join(output,'native-tests.log'),redact(log));
  report.testExitCode=code;report.status=code===0?'passed':'failed';process.exitCode=code===0?0:1;
}catch(error){report.status='failed';report.error=redact(error?.message??error);process.exitCode=1;}
finally{
  if(reusedBaseline)try{await reusedBaseline.verifyUnchanged();await writeFile(path.join(output,'diagnostic-baseline-reuse.json'),JSON.stringify(reusedBaseline.report,null,2)+'\n');}
  catch(error){report.baselineReuseError=redact(error.message);process.exitCode=1;}
  for(const value of clusters.reverse())if(value.started)try{
    const marker=JSON.parse(await readFile(path.join(value.root,'ownership.json'),'utf8'));
    const resolved=await realpath(value.data),expected=path.resolve(output,value.kind,'data');
    if(marker.runId!==runId||marker.kind!==value.kind||marker.marker!=='gakja-pr07g-owned-native-cluster-only'||resolved!==expected)throw new Error('PR07G_NATIVE_CLUSTER_MARKER_MISMATCH');
    await cli('pg_ctl',['-D',resolved,'-m','fast','-w','-t','30','stop']);
    // Only data belonging to this exact, marked new run is removed. Reports,
    // SQL logs and ownership evidence remain alongside it for later audit.
    if(!resolved.startsWith(path.resolve(output)+path.sep)||resolved!==path.resolve(output,value.kind,'data'))throw new Error('PR07G_NATIVE_DATA_PATH_MISMATCH');
    await rm(resolved,{recursive:true,force:false,maxRetries:2});
    (report.cleanup??=[]).push({kind:value.kind,ownedClusterStopped:true,ownedClusterDataRemoved:true});
  }catch(error){(report.cleanup??=[]).push({kind:value.kind,error:redact(error.message)});process.exitCode=1;}
  if(process.exitCode)report.status='failed';report.finishedAt=new Date().toISOString();report.exitCode=process.exitCode??0;await writeFile(path.join(output,'native-run.json'),JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify({status:report.status,runId,officialStorageGateSatisfied:false,output,exitCode:report.exitCode}));
