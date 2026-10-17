import { spawnSync } from 'node:child_process';
import { projectRoot } from './load-env.mjs';
import { join } from 'node:path';
const result = spawnSync(process.execPath, ['--import', 'tsx', join(projectRoot, 'scripts/seed-data.mts')], { cwd: projectRoot, stdio: 'inherit' });
process.exit(result.status ?? 1);

