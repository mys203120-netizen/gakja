import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

export const exactCBaseline='3204e83ea5bde64c57fe0da57cc7abc8ecca44fb';
/** A newly created exact C checkout and lockfile install. Nothing is copied
 * from another node_modules, and an existing directory is never adopted. */
export async function prepareExactCBaseline({runId,workspace=process.cwd(),reportDirectory}) {
  if(!/^[a-z0-9_]{8,48}$/u.test(runId))throw new Error('PR07D_BASELINE_RUN_INVALID');
  const owned=path.resolve(workspace,'artifacts/pr07d/baseline-'+runId);
  await mkdir(owned); // EEXIST is intentional: do not adopt another run.
  await writeFile(path.join(owned,'ownership.json'),JSON.stringify({runId,marker:'pr07d-exact-c-baseline-only',baseline:exactCBaseline}));
  const codeRoot=path.join(owned,'code'),fixtureRoot=path.join(owned,'synthetic-input'),baselineResult=path.join(owned,'baseline.json');
  const commands=[];
  async function command(program,args,cwd,label,extra={}) {
    const log=path.join(reportDirectory,'baseline-'+label+'.log');let output='';
    const start=Date.now();
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(program,args,{cwd,windowsHide:true,env:{...process.env,...extra},shell:process.platform==='win32'&&program==='npm.cmd'});
      child.stdout.on('data',bytes=>{output+=bytes.toString();});child.stderr.on('data',bytes=>{output+=bytes.toString();});
      child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));
    });
    await writeFile(log,output);commands.push({label,program,args,exitCode:result.code,elapsedMs:Date.now()-start,log:path.basename(log)});
    if(result.code!==0)throw new Error('PR07D_BASELINE_'+label.toUpperCase()+'_FAILED');return output.trim();
  }
  await command('git',['-c','core.longpaths=true','worktree','add','--detach',codeRoot,exactCBaseline],workspace,'checkout');
  if(await command('git',['rev-parse','HEAD'],codeRoot,'commit')!==exactCBaseline)throw new Error('PR07D_BASELINE_COMMIT_MISMATCH');
  await command(process.platform==='win32'?'npm.cmd':'npm',['ci','--no-audit','--no-fund'],codeRoot,'npm-ci');
  // Match checkout's long-path handling. Otherwise Git for Windows reports
  // existing deep Live2D files as changed/deleted in a longer G checkout path.
  const changed=await command('git',['-c','core.longpaths=true','diff','--name-only',exactCBaseline],codeRoot,'source-check');
  if(changed)throw new Error('PR07D_BASELINE_SOURCE_CHANGED');
  await command(process.execPath,['--import','tsx',path.join(workspace,'tests/shadow/c-baseline-driver.mjs'),'build',codeRoot,fixtureRoot,baselineResult],codeRoot,'actual-local-read',
    {INTERVIEW_EXECUTION_MODE:'local-development'});
  const baseline=JSON.parse(await readFile(baselineResult,'utf8'));
  if(baseline.codeCommit!==exactCBaseline||baseline.metrics.fixtureFileReads<1||baseline.metrics.fixtureFileWrites!==0)throw new Error('PR07D_BASELINE_OBSERVATION_INVALID');
  const report={version:'pr07d-fresh-exact-c-baseline-v1',runId,codeCommit:exactCBaseline,freshLockfileInstall:true,nodeModulesCopied:false,
    studentData:'public-synthetic-only',commands,metrics:baseline.metrics};
  await writeFile(path.join(reportDirectory,'baseline-preparation.json'),JSON.stringify(report,null,2)+'\n');
  return {codeRoot,fixtureRoot,baselineResult,report};
}
