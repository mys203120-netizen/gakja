import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID,createHash } from 'node:crypto';

const execute=promisify(execFile),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
/** New copies of public inputs only. Each expected refusal is observed by the
 * unchanged exact C caller in its own process, before D sees its fault bytes. */
export async function baselineDependencyFaults({codeRoot,fixtureRoot,driver,output}) {
  const fixture=JSON.parse(await fs.readFile(path.join(fixtureRoot,'fixture-manifest.json'),'utf8'));
  const cases=[
    {caseId:'D-DEP-QA',artifactId:'analysis-qa',resultKey:'staged',change:value=>({...value,revision:'explicit-synthetic-tampered-revision'})},
    {caseId:'D-DEP-IMAGE',artifactId:'book-png',resultKey:'bank',binary:true},
    {caseId:'D-DEP-JOURNAL',artifactId:'book-analysis-journal',resultKey:'bank',journal:true},
    {caseId:'D-DEP-REVIEW-PARENT',artifactId:'review-parent',resultKey:'ancestry',change:value=>({...value,common:{...value.common,model:'explicit-synthetic-tampered-parent'}})},
    {caseId:'D-DEP-SOURCE-REVIEW',artifactId:'review-source',resultKey:'review',whitespace:true},
  ];
  const results=[];
  for(const item of cases){
    const artifact=fixture.artifacts.find(a=>a.artifactId===item.artifactId);
    if(!artifact||artifact.availability!=='present')throw new Error('PR07D_FAULT_ARTIFACT_MISSING');
    const copy=path.join(path.dirname(fixtureRoot),'fault-input-'+randomUUID());
    await fs.cp(fixtureRoot,copy,{recursive:true,errorOnExist:true,force:false});
    const file=path.join(copy,artifact.source.relativePath),original=await fs.readFile(file);let bytes;
    if(item.binary){bytes=Buffer.from(original);bytes[0]^=1;}
    else if(item.whitespace)bytes=Buffer.concat([original,Buffer.from(' ')]);
    else if(item.journal){const lines=original.toString('utf8').split('\n');lines[0]=JSON.stringify({...JSON.parse(lines[0]),key:'explicit-synthetic-tampered-journal'});bytes=Buffer.from(lines.join('\n'));}
    else bytes=Buffer.from(JSON.stringify(item.change(JSON.parse(original.toString('utf8'))),null,2)+'\n');
    await fs.writeFile(file,bytes);
    const resultFile=path.join(output,item.caseId+'-C.json');
    const run=await execute(process.execPath,['--import','tsx',driver,'read',codeRoot,copy,resultFile],{cwd:codeRoot,windowsHide:true,
      env:{...process.env,INTERVIEW_EXECUTION_MODE:'local-development'},timeout:120_000,maxBuffer:2_000_000});
    await fs.writeFile(path.join(output,item.caseId+'-C.log'),run.stdout+run.stderr);
    const observed=JSON.parse(await fs.readFile(resultFile,'utf8')),baseline=observed[item.resultKey];
    if(observed.codeCommit!=='3204e83ea5bde64c57fe0da57cc7abc8ecca44fb'||observed.metrics.fixtureFileWrites!==0)throw new Error('PR07D_FAULT_BASELINE_INVALID');
    results.push({caseId:item.caseId,artifactId:item.artifactId,resultKey:item.resultKey,bytes,originalSha256:sha(original),faultSha256:sha(bytes),
      baseline:{status:baseline.status,errorCode:baseline.code??baseline.message??null,returnedNull:baseline.status==='fulfilled'&&baseline.value===null,
        payloadReturned:baseline.status==='fulfilled'&&baseline.value!=null,valueSha256:sha(Buffer.from(JSON.stringify(baseline.value)??'undefined')),
        effects:baseline.effects,wholeReadEffects:{fixtureFileReads:observed.metrics.fixtureFileReads,fixtureFileWrites:observed.metrics.fixtureFileWrites,paidProviderCalls:observed.metrics.paidProviderCalls},codeCommit:observed.codeCommit},historicalCurrent:'separate immutable historical selection intentionally unchanged'});
  }
  return results;
}
