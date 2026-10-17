import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const files=readdirSync('tests').filter(name=>/\.test\.(ts|mts)$/.test(name)).sort().map(name=>'tests/'+name);
for(const args of [['--import','tsx','--test',...files,'packages/content-contracts/test/contracts.test.ts'],['--import','tsx','tests/bootstrap-overview.mjs']]) {
  const result=spawnSync(process.execPath,args,{stdio:'inherit',env:process.env,windowsHide:true});
  if(result.status!==0)process.exit(result.status||1);
}
