import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, args) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), args[index + 1]]);
  return pairs;
}, []));
if (!options.source || !options.baseline || !options.current || !options.manifest) {
  throw new Error('Usage: node scripts/w0-source-snapshot.mjs --source ABS --baseline ABS --current ABS --manifest ABS');
}
const source = path.resolve(options.source);
const baseline = path.resolve(options.baseline);
const current = path.resolve(options.current);
const development = options.development ? path.resolve(options.development) : null;
const roots = [source, baseline, current, ...(development ? [development] : [])];
if (new Set(roots).size !== roots.length) throw new Error('Snapshot directories must be distinct.');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
const baseCommit = git(source, ['rev-parse', 'HEAD']).trim();
for (const root of [baseline, current, ...(development ? [development] : [])]) {
  if (git(root, ['rev-parse', 'HEAD']).trim() !== baseCommit) throw new Error('Baseline commit mismatch.');
}
const trackedChanges = git(source, ['diff', '--name-only', 'HEAD']).trim();
if (trackedChanges) throw new Error(`Tracked source differs from HEAD: ${trackedChanges}`);
const tracked = git(source, ['ls-files', '-z']).split('\0').filter(Boolean);
const extra = git(source, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
const allowed = (name) => /^(app\/w0\/|components\/w0\/|lib\/w0\/|tests\/w0-[^/]+\.test\.ts$|scripts\/w0-[^/]+\.mjs$|docs\/w0-[^/]+\.(md|json)$)/.test(name) || name === 'docs/ia-registry.csv';
const excludedReports = new Set(['docs/w0-source-manifest.json', 'docs/w0-test-comparison.json']);
const additions = extra.filter((name) => allowed(name) && !excludedReports.has(name));
const unexpected = extra.filter((name) => !allowed(name));
if (unexpected.length) throw new Error(`Unexpected untracked files: ${unexpected.join(', ')}`);

function safeFile(root, relative) {
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(root + path.sep)) throw new Error(`Path escaped root: ${relative}`);
  return absolute;
}
function copy(root, relative, bytes) {
  const destination = safeFile(root, relative);
  if (existsSync(destination) && readFileSync(destination).equals(bytes)) return;
  if (root === development && relative === 'next-env.d.ts' && existsSync(destination)) return;
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
}
const records = [];
for (const relative of [...tracked, ...additions].sort()) {
  const original = safeFile(source, relative);
  if (lstatSync(original).isSymbolicLink()) throw new Error(`Source links are not frozen: ${relative}`);
  const bytes = readFileSync(original);
  const digest = sha(bytes);
  const isAddition = additions.includes(relative);
  copy(current, relative, bytes);
  if (development) copy(development, relative, bytes);
  if (!isAddition) copy(baseline, relative, bytes);
  if (sha(readFileSync(safeFile(current, relative))) !== digest) throw new Error(`Current copy mismatch: ${relative}`);
  if (!isAddition && sha(readFileSync(safeFile(baseline, relative))) !== digest) throw new Error(`Baseline copy mismatch: ${relative}`);
  records.push({ path: relative, bytes: bytes.length, sha256: digest, origin: isAddition ? 'W0 addition' : 'unchanged baseline worktree bytes' });
}
// Reports may be updated after checks. Their hashes remain recorded, while the
// executed fingerprint includes all code, canonical policy text, tests and assets.
const isReport = (relative) => /^docs\/w0-/.test(relative);
const executableRecords = records.filter((record) => !isReport(record.path) && record.path !== 'next-env.d.ts');
const fingerprint = sha(JSON.stringify(executableRecords));
const baselineRecords = records.filter((record) => record.origin !== 'W0 addition');
const nodeModules = safeFile(current, 'node_modules');
const manifest = {
  created_at: new Date().toISOString(), source, baseline, current, development, base_commit: baseCommit,
  branch: git(source, ['branch', '--show-current']).trim(),
  tracked_diff: trackedChanges || null,
  node: process.version, npm: process.env.npm_config_user_agent ?? null,
  lockfile_sha256: sha(readFileSync(safeFile(source, 'package-lock.json'))),
  code_fingerprint_sha256: fingerprint,
  baseline_files_sha256: sha(JSON.stringify(baselineRecords)),
  source_files_sha256: sha(JSON.stringify(records)),
  baseline_byte_policy: 'Same exact unchanged worktree bytes as W0, including checkout line endings; no latest backend or private ignored data copied.',
  report_hash_policy: 'docs/w0-* reports and generated next-env.d.ts are recorded but excluded from executed fingerprint; source manifest and generated test comparison are excluded to avoid circular hashes.',
  allowed_generated_changes: ['next-env.d.ts', '.next/**', '*.tsbuildinfo'],
  node_modules_before_install: existsSync(nodeModules) ? { exists: true, symbolic_link: lstatSync(nodeModules).isSymbolicLink() } : { exists: false },
  added_files: additions.sort(), files: records,
};
mkdirSync(path.dirname(path.resolve(options.manifest)), { recursive: true });
writeFileSync(path.resolve(options.manifest), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(safeFile(current, '.w0-source-fingerprint.json'), JSON.stringify({ code_fingerprint_sha256: fingerprint, lockfile_sha256: manifest.lockfile_sha256, base_commit: baseCommit }, null, 2) + '\n');
writeFileSync(safeFile(baseline, '.w0-source-fingerprint.json'), JSON.stringify({ baseline_files_sha256: manifest.baseline_files_sha256, lockfile_sha256: manifest.lockfile_sha256, base_commit: baseCommit }, null, 2) + '\n');
console.log(JSON.stringify({ files: records.length, additions: additions.length, code_fingerprint_sha256: fingerprint, lockfile_sha256: manifest.lockfile_sha256, manifest: path.resolve(options.manifest) }, null, 2));
