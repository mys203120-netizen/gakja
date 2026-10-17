import {mkdir,writeFile,rename} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fetchAconInterviewCalendar} from '../apps/web/src/lib/acon-calendar-source.ts';

const catalogue=await fetchAconInterviewCalendar();
const destination=new URL('../apps/web/src/data/school-interview-calendar.json',import.meta.url);
const temporary=new URL('../apps/web/src/data/school-interview-calendar.json.next',import.meta.url);
const auditFile=new URL('../.local/acon-calendar/import-audit.json',import.meta.url);
await mkdir(new URL('../.local/acon-calendar/',import.meta.url),{recursive:true});
// Only a fully parsed catalogue reaches disk. A failed network/parser refresh preserves the previous file.
await writeFile(temporary,`${JSON.stringify(catalogue,null,2)}\n`,'utf8');
await rename(temporary,destination);
await writeFile(auditFile,`${JSON.stringify({source:catalogue.source,audit:catalogue.audit,schools:catalogue.schools.map(({schoolReferenceId,university,status,sourceUniversities,entries,unresolved})=>({schoolReferenceId,university,status,sourceUniversities,entries:entries.length,unresolved}))},null,2)}\n`,'utf8');
console.log(JSON.stringify({source:catalogue.source,audit:catalogue.audit}));
if(!process.argv.includes('--no-db')){
  const result=spawnSync(process.execPath,['--import','tsx',fileURLToPath(new URL('./import-admission-calendar.mts',import.meta.url))],{stdio:'inherit',cwd:fileURLToPath(new URL('../',import.meta.url)),windowsHide:true});
  if(result.error)throw result.error;
  if(result.status!==0)process.exitCode=result.status||1;
}
