import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runServicePreflight } from '../server/service/preflight.ts';
const file=process.env.INTERVIEW_G_DEPLOYMENT_FILE;
let deployment;let deploymentReadFailure=false;try{if(file)deployment=JSON.parse(await readFile(file,'utf8'));}catch{deploymentReadFailure=true;deployment=null;}
let report;
if(process.argv.includes('--verify-configured-readonly')&&deployment){
 const {createProductionServiceComposition}=await import('../server/service/production-composition.ts');
 const composition=await createProductionServiceComposition({deployment});try{report=composition.readiness;}finally{await composition.close();}
}else report=await runServicePreflight({environment:process.env,deployment});
const destination=path.resolve(process.argv.slice(2).find(value=>!value.startsWith('--'))??'artifacts/pr07g/preflight.json');
if(deploymentReadFailure)report.checks.push({id:'deployment-file',status:'fail',evidence:['EXPLICIT_DEPLOYMENT_FILE_INVALID_OR_UNREADABLE']});
await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
process.exitCode=report.checks.every(check=>check.status==='pass')?0:2;
