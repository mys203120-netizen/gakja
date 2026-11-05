import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
/** Copy Git-visible working-tree sources, never dependencies, private data or
 * credentials. The snapshot is deliberately NOT described as a clean commit. */
export async function captureSourceSnapshot(root, destination) {
  root = path.resolve(root); destination = path.resolve(destination);
  if (root === destination || path.relative(root, destination).split(path.sep).includes('node_modules')) throw new Error('SNAPSHOT_DESTINATION_INVALID');
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trimEnd();
  const files = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))].sort();
  const denied = file => /(?:^|\/)(?:node_modules|\.git|\.next|artifacts|__pycache__)(?:\/|$)/u.test(file) || /^data\//u.test(file) || /(?:^|\/)\.env(?!\.example$)/u.test(file) || /(?:^|\/)(?:id_rsa|id_ed25519|\.npmrc)$/u.test(file);
  const rejected = files.filter(denied);
  if (rejected.length) throw new Error('SOURCE_INVENTORY_CONTAINS_EXCLUDED_PATHS:' + rejected.join(','));
  await mkdir(destination, { recursive: false });
  const records = [];
  for (const file of files) {
    const source = path.resolve(root, file), target = path.resolve(destination, file);
    if (path.relative(root, source).startsWith('..') || path.relative(destination, target).startsWith('..')) throw new Error('SNAPSHOT_PATH_OUTSIDE_ROOT');
    const stat = await lstat(source).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) continue; // A tracked deletion is represented in gitStatus below.
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('SNAPSHOT_REQUIRES_REGULAR_FILE:' + file);
    const bytes = await readFile(source); await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
    if (hash(await readFile(target)) !== hash(bytes)) throw new Error('SNAPSHOT_COPY_CHANGED:' + file);
    records.push({ path: file, bytes: bytes.length, sha256: hash(bytes) });
  }
  const manifest = { version: 'working-tree-source-snapshot-v1', capturedAt: new Date().toISOString(),
    head: git(['rev-parse', 'HEAD']), branch: git(['branch', '--show-current']), gitStatus: git(['status', '--porcelain=v1', '-uall']),
    sourceKind: 'git-visible-uncommitted-working-tree', dependencyCopy: false, credentialsCopied: false, privateDataCopied: false,
    nodeVersion: process.version, lockfileSha256: hash(await readFile(path.join(destination, 'package-lock.json'))),
    sourceTreeSha256: hash(JSON.stringify(records)), files: records };
  await writeFile(path.join(destination, 'source-snapshot-manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const destination = process.argv[2]; if (!destination) throw new Error('Usage: node scripts/capture-source-snapshot.mjs NEW_ABSOLUTE_DIRECTORY');
  if (!path.isAbsolute(destination)) throw new Error('SNAPSHOT_DESTINATION_MUST_BE_ABSOLUTE');
  const manifest = await captureSourceSnapshot(process.cwd(), destination);
  console.log(JSON.stringify({ destination, head: manifest.head, sourceKind: manifest.sourceKind, sourceTreeSha256: manifest.sourceTreeSha256,
    files: manifest.files.length, lockfileSha256: manifest.lockfileSha256, dependencyCopy: false, credentialsCopied: false, privateDataCopied: false }, null, 2));
}
