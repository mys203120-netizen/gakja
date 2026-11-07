import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exactCBaseline } from './pr07d-baseline.mjs';
const execute=promisify(execFile),hash=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Explicit native diagnostic reuse of an earlier owned fresh C checkout. This
 * is never available to CI and never reported as a new lockfile installation. */
export async function reuseOwnedDiagnosticBaseline(root,options){
  if(process.env.GITHUB_ACTIONS==='true'||process.env.NODE_ENV==='production'||options?.kind!=='native-controlled-diagnostic')throw new Error('PR07G_BASELINE_REUSE_DIAGNOSTIC_ONLY');
  const absolute=path.resolve(root),allowed=path.resolve('artifacts/pr07d');
  if(!absolute.startsWith(allowed+path.sep)||await realpath(absolute)!==absolute||!/^baseline-[a-z0-9_]{8,48}$/u.test(path.basename(absolute)))throw new Error('PR07G_DIAGNOSTIC_BASELINE_PATH_DENIED');
  const ownership=JSON.parse(await readFile(path.join(absolute,'ownership.json'),'utf8'));
  if(ownership.marker!=='pr07d-exact-c-baseline-only'||ownership.baseline!==exactCBaseline||path.basename(absolute)!=='baseline-'+ownership.runId)throw new Error('PR07G_DIAGNOSTIC_BASELINE_MARKER_MISMATCH');
  const codeRoot=path.join(absolute,'code'),fixtureRoot=path.join(absolute,'synthetic-input'),baselineResult=path.join(absolute,'baseline.json');
  const originalOutput=path.resolve('artifacts/pr07g/local-'+ownership.runId);
  const installLog=path.join(originalOutput,'baseline-npm-ci.log'),installBytes=await readFile(installLog);
  if(!/added \d+ packages/u.test(installBytes.toString('utf8')))throw new Error('PR07G_ORIGINAL_FRESH_INSTALL_EVIDENCE_MISSING');
  const modules=path.join(codeRoot,'node_modules');if((await lstat(modules)).isSymbolicLink()||await realpath(modules)!==modules)throw new Error('PR07G_BASELINE_MODULES_MUST_BE_OWNED_DIRECTORY');
  const fixture=JSON.parse(await readFile(path.join(fixtureRoot,'fixture-manifest.json'),'utf8')),baseline=JSON.parse(await readFile(baselineResult,'utf8'));
  if(fixture.version!=='pr07d-public-synthetic-fixture-v1'||baseline.codeCommit!==exactCBaseline||baseline.metrics.fixtureFileReads<1||baseline.metrics.fixtureFileWrites!==0)throw new Error('PR07G_DIAGNOSTIC_PUBLIC_BASELINE_INVALID');
  async function codeCheck(){
    const commit=(await execute('git',['-c','core.longpaths=true','rev-parse','HEAD'],{cwd:codeRoot,windowsHide:true})).stdout.trim();
    const changed=(await execute('git',['-c','core.longpaths=true','diff','--name-only',exactCBaseline],{cwd:codeRoot,windowsHide:true})).stdout.trim();
    if(commit!==exactCBaseline||changed)throw new Error('PR07G_DIAGNOSTIC_BASELINE_SOURCE_CHANGED');
  }
  async function inventory(){
    const entries=[];
    async function visit(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name),info=await lstat(file);if(info.isSymbolicLink())throw new Error('PR07G_PUBLIC_FIXTURE_LINK_DENIED');if(entry.isDirectory())await visit(file);else if(entry.isFile())entries.push({path:path.relative(fixtureRoot,file).replaceAll('\\','/'),sha256:hash(await readFile(file))});else throw new Error('PR07G_PUBLIC_FIXTURE_TYPE_DENIED');}}
    await visit(fixtureRoot);return entries.sort((a,b)=>a.path.localeCompare(b.path));
  }
  await codeCheck();const before=await inventory(),beforeSha=hash(JSON.stringify(before));
  const report={version:'pr07g-explicit-owned-diagnostic-baseline-reuse-v1',codeCommit:exactCBaseline,originalRunId:ownership.runId,
    freshLockfileInstallThisRun:false,earlierOwnedFreshInstallReused:true,nodeModulesCopied:false,fixtureKind:'public-synthetic-only',
    initialInstallEvidence:{file:installLog,sha256:hash(installBytes)},lockfileSha256:hash(await readFile(path.join(codeRoot,'package-lock.json'))),
    fixtureBeforeSha256:beforeSha,fixtureFiles:before.length,metrics:baseline.metrics,sourceCheck:'git -c core.longpaths=true diff exact C; clean'};
  async function verifyUnchanged(){await codeCheck();const after=await inventory();if(hash(JSON.stringify(after))!==beforeSha)throw new Error('PR07G_REUSED_PUBLIC_FIXTURE_CHANGED');
    report.fixtureAfterSha256=beforeSha;report.fixtureAndCodeUnchanged=true;return report;}
  return{codeRoot,fixtureRoot,baselineResult,report,verifyUnchanged};
}
