import { readFile } from 'node:fs/promises';
import { createProductionEvaluationWorker } from '../server/service/production-evaluation-worker.ts';
// Trusted internal one-job entry. Never scans, polls or dispatches from HTTP.
if(!process.argv.includes('--run-authorized-job')){console.log('SERVICE_WORKER_EXPLICIT_FINITE_DISPATCH_REQUIRED');process.exitCode=2;}
else{let worker;try{
 const deployment=JSON.parse(await readFile(process.env.INTERVIEW_G_DEPLOYMENT_FILE,'utf8'));
 const command=JSON.parse(await readFile(process.env.INTERVIEW_G_WORKER_COMMAND_FILE,'utf8'));
 worker=createProductionEvaluationWorker({deployment});await worker.run(command);console.log('SERVICE_WORKER_FINITE_DISPATCH_COMPLETED');
}catch{console.error('SERVICE_WORKER_DISPATCH_BLOCKED');process.exitCode=2;}finally{await worker?.close();}}
