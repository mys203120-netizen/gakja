import { readFile,writeFile,mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { inventoryShadowFiles,assertShadowInventory,type ShadowInventory,type ShadowInventoryRequest,type ShadowSourceRoots } from '../server/shadow/shadow-plan';
import type { ShadowImporter } from '../server/shadow/shadow-import';
import type { RequestContext } from '../server/auth/request-identity';
import type { ShadowImportCapability } from '../server/shadow/shadow-ports';
import { runIndependentShadow,type ShadowComparisonCase,type ShadowObservation } from '../server/shadow/shadow-compare';

/** This is a server/operator composition, not a module path accepted from a
 * student document or inventory. Factories own marker checks and credentials. */
export interface ReadShadowRuntime {
  importer:ShadowImporter;context:RequestContext;capability:ShadowImportCapability;
  shadow?:{config:ShadowComparisonCase;baseline:()=>Promise<ShadowObservation>;candidate:()=>Promise<ShadowObservation>};
  close():Promise<void>;
}
const args=process.argv.slice(2),command=args.shift();
const flags=new Map<string,string>();
for(let n=0;n<args.length;n+=2) {
  if(!['--request','--roots','--inventory','--runtime','--out'].includes(args[n])||!args[n+1]||flags.has(args[n]))throw new Error('SHADOW_CLI_ARGUMENT_INVALID');
  flags.set(args[n],args[n+1]);
}
const commands=['inventory','plan','import','resume','verify','shadow','status','cleanup'];
if(!command||!commands.includes(command)||!flags.get('--out'))throw new Error('SHADOW_CLI_USAGE: inventory|plan|import|resume|verify|shadow|status|cleanup --out <new-report>');
const boundedJson=async(file:string)=>{const bytes=await readFile(file);if(bytes.length>8*1024*1024)throw new Error('SHADOW_CLI_INPUT_LIMIT');return JSON.parse(bytes.toString('utf8'));};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
let runtime:ReadShadowRuntime|undefined;
let result:unknown,failed=false;
try {
  if(command==='inventory'||command==='plan') {
    if(!flags.get('--request')||!flags.get('--roots'))throw new Error('SHADOW_CLI_INVENTORY_INPUT_REQUIRED');
    result=await inventoryShadowFiles(await boundedJson(flags.get('--request')!) as ShadowInventoryRequest,await boundedJson(flags.get('--roots')!) as ShadowSourceRoots);
    failed=!(result as ShadowInventory).eligible;
  } else {
    if(!flags.get('--inventory')||!flags.get('--runtime'))throw new Error('SHADOW_CLI_EXPLICIT_RUNTIME_REQUIRED');
    const inventory=await boundedJson(flags.get('--inventory')!) as ShadowInventory;assertShadowInventory(inventory);
    // This path comes only from an explicit trusted operator CLI option. No
    // provenance/URL/root/selector in the data plan can select executable code.
    const runtimeModule=await import(pathToFileURL(path.resolve(flags.get('--runtime')!)).href);
    if(typeof runtimeModule.openReadShadowRuntime!=='function')throw new Error('SHADOW_CLI_RUNTIME_FACTORY_REQUIRED');
    runtime=await runtimeModule.openReadShadowRuntime({inventory});
    if(!runtime||!runtime.importer||typeof runtime.close!=='function')throw new Error('SHADOW_CLI_RUNTIME_INVALID');
    if(command==='import'||command==='resume')result=await runtime.importer.import(runtime.context,inventory,runtime.capability);
    else if(command==='status')result=await runtime.importer.status(runtime.context,inventory);
    else if(command==='verify')result=await runtime.importer.verify(runtime.context,inventory);
    else if(command==='cleanup') {result=await runtime.importer.cleanup(runtime.context,inventory,runtime.capability);failed=!(result as {complete:boolean}).complete;}
    else {
      if(!runtime.shadow)throw new Error('SHADOW_CLI_INDEPENDENT_EXECUTORS_REQUIRED');
      result=await runIndependentShadow(runtime.shadow.config,runtime.shadow.baseline,runtime.shadow.candidate);failed=!(result as {passed:boolean}).passed;
    }
  }
} catch(error) {
  failed=true;const safe=(error as {code?:unknown}).code;
  result={version:'shadow-cli-failure-v1',command,status:'failed',errorCode:typeof safe==='string'&&/^[A-Z0-9_:-]{1,160}$/u.test(safe)?safe:'SHADOW_EXECUTION_FAILED',
    explanation:'No local fallback, original restoration, primary writer switch or approval is performed by a failed command.'};
} finally {
  try{await runtime?.close();}catch{failed=true;result={version:'shadow-cli-failure-v1',command,status:'failed',errorCode:'SHADOW_RUNTIME_CLOSE_FAILED'};}
}
const report=JSON.stringify(result,null,2)+'\n',output=path.resolve(flags.get('--out')!);
await mkdir(path.dirname(output),{recursive:true});await writeFile(output,report,{flag:'wx'});
// The report can contain private provenance in a local-verification-only run.
// Stdout is always a digest/summary, never a domain payload or credential.
console.log(JSON.stringify({command,status:failed?'failed':'completed',reportSha256:hash(report),
  ...(result&&typeof result==='object'&&'counts' in result?{counts:Reflect.get(result,'counts')}:{}),backendWrites:command==='inventory'||command==='plan'?0:undefined}));
process.exitCode=failed?1:0;
