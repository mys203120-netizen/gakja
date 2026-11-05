import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';

// Verify the committed source graph without adding private prepared data to Git.
const root = process.cwd();
const workingTree = process.argv.includes('--working-tree');
const manifestArg = process.argv.indexOf('--manifest');
const manifest = manifestArg < 0 ? null : JSON.parse(fs.readFileSync(process.argv[manifestArg + 1], 'utf8'));
if (manifest) for (const entry of manifest.files) {
  const absolute = path.resolve(root, entry.path);
  if (path.relative(root, absolute).startsWith('..')) throw new Error('MANIFEST_PATH_OUTSIDE_ROOT');
  const bytes = fs.readFileSync(absolute);
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('SNAPSHOT_BYTES_CHANGED:' + entry.path);
}
const tracked = new Set(manifest ? manifest.files.map(entry => entry.path) : execFileSync('git', ['ls-files', '-z', ...(workingTree ? ['--cached', '--others', '--exclude-standard'] : [])], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean));
const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
if (!configPath) throw new Error('TSCONFIG_MISSING');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const failures = [];
let checked = 0;
for (const file of tracked) {
  if (!/\.(?:[cm]?[jt]sx?)$/u.test(file) || /^(?:production|public|\.local|\.archify)\//u.test(file)) continue;
  const absolute = path.resolve(root, file);
  const content = fs.readFileSync(absolute, 'utf8');
  for (const item of ts.preProcessFile(content, true, true).importedFiles) {
    if (!item.fileName.startsWith('.') && !item.fileName.startsWith('@/')) continue;
    const resolved = ts.resolveModuleName(item.fileName, absolute, options, ts.sys).resolvedModule;
    if (!resolved || resolved.isExternalLibraryImport) continue;
    const relative = path.relative(root, resolved.resolvedFileName).split(path.sep).join('/');
    if (relative.startsWith('../') || relative.startsWith('node_modules/') || relative.startsWith('.next/')) continue;
    checked++;
    if (!tracked.has(relative)) failures.push(`${file} -> ${relative}`);
  }
}
if (failures.length) {
  console.error('Untracked source dependencies (clean checkout cannot reproduce these imports):\n' + [...new Set(failures)].join('\n'));
  process.exitCode = 1;
} else console.log(`Source closure verified: ${checked} local imports resolve to ${manifest ? 'byte-verified snapshot' : workingTree ? 'non-ignored working-tree' : 'tracked'} files.`);
