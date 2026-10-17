import { loadProjectEnv, projectRoot } from './load-env.mjs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
loadProjectEnv();
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.DATABASE_URL) throw new Error('Supabase URL, 서비스 키, DATABASE_URL을 먼저 설정해 주세요.');
const result = spawnSync(process.execPath, ['--import', 'tsx', join(projectRoot, 'scripts/seed-data.mts'), '--supabase'], { cwd: projectRoot, stdio: 'inherit', env: { ...process.env, AUTH_MODE: 'supabase' } });
process.exit(result.status ?? 1);

