import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { assertLocalCommandAllowed } from '../server/transition/local-writer-fence.ts';

dotenv.config({ path: '.env.local', quiet: true });
if (process.env.NODE_ENV === 'production' ||
    process.env.INTERVIEW_EXECUTION_MODE && process.env.INTERVIEW_EXECUTION_MODE !== 'local-development') {
  throw new Error('LOCAL_COMPOSITION_UNAVAILABLE');
}
const allowed = new Set(['prepare-evaluation-scopes.ts', 'prepare-approved-knowledge.ts', 'run-evaluation-worker.ts']);
const [command, ...args] = process.argv.slice(2);
if (!allowed.has(command)) throw new Error('LOCAL_COMMAND_UNSUPPORTED');
await assertLocalCommandAllowed(process.cwd());
process.env.INTERVIEW_EXECUTION_MODE = 'local-development';
const moduleUrl = new URL(command, import.meta.url);
process.argv = [process.execPath, fileURLToPath(moduleUrl), ...args];
await import(moduleUrl.href);
