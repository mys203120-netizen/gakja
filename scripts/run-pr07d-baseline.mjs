import { randomBytes } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareExactCBaseline } from './pr07d-baseline.mjs';

const runId=process.env.PR07D_TEST_RUN_ID??'baseline_'+randomBytes(8).toString('hex');
const output=path.resolve(process.env.PR07D_TEST_OUTPUT??'artifacts/pr07d/baseline-report-'+runId);
await mkdir(output,{recursive:false});
try{
  const result=await prepareExactCBaseline({runId,reportDirectory:output});
  await writeFile(path.join(output,'runtime-paths.local.json'),JSON.stringify({codeRoot:result.codeRoot,fixtureRoot:result.fixtureRoot,baselineResult:result.baselineResult},null,2)+'\n');
  console.log(JSON.stringify({status:'passed',baseline:result.report.codeCommit,freshLockfileInstall:true,nodeModulesCopied:false,output}));
}catch(error){await writeFile(path.join(output,'failure.json'),JSON.stringify({status:'failed',message:error.message}));throw error;}
