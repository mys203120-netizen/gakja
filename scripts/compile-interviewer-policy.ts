import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { compileInterviewerPolicy, INTERVIEWER_POLICY_PATH } from '../server/policy/interviewer-policy';

const root = process.cwd();
const pack = await compileInterviewerPolicy(root);
const outputPath = resolve(root, INTERVIEWER_POLICY_PATH);
if (process.argv.includes('--check')) {
  const stored = JSON.parse(await readFile(outputPath, 'utf8'));
  if (JSON.stringify(stored) !== JSON.stringify(pack)) throw new Error('INTERVIEWER_POLICY_CACHE_STALE');
} else {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(pack, null, 2) + '\n', 'utf8');
}
console.log(JSON.stringify({ ready: true, version: pack.version, contentSha256: pack.contentSha256, sourceFiles: pack.sourceFiles.length, rules: pack.rules.length, userOverrides: pack.userOverrides.length, providerCalls: 0, path: INTERVIEWER_POLICY_PATH }));
