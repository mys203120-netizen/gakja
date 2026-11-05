import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(root, 'node_modules', '.cache', 'live2d-sdk');
const outputIndex = process.argv.indexOf('--output-dir');
if (outputIndex >= 0 && (!process.argv[outputIndex + 1] || process.argv[outputIndex + 1].startsWith('--'))) throw new Error('--output-dir requires a new build directory.');
const outputRoot = outputIndex < 0 ? path.join(root, 'public', 'live2d', 'runtime') : path.resolve(process.argv[outputIndex + 1]);
const packages = [
  { name: 'Framework', repository: 'https://github.com/Live2D/CubismWebFramework.git', tag: '5-r.5', commit: '198a3769c26ca3d7b600e932590433badd392edd' },
  { name: 'MotionSync', repository: 'https://github.com/Live2D/CubismWebMotionSyncComponents.git', tag: '5-r.3', commit: '90806089d1753bf2e7643287319d2123b59a8546' },
];

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

async function prepareSource(pkg) {
  const directory = path.join(sourceRoot, pkg.name);
  if (!(await exists(directory))) {
    await run('git', ['-c', 'advice.detachedHead=false', 'clone', '--depth', '1', '--branch', pkg.tag, pkg.repository, directory], { cwd: root, maxBuffer: 2 * 1024 * 1024 });
  }
  const git = async (...args) => (await run('git', ['-C', directory, ...args], { cwd: root })).stdout.trim();
  const [remote, tag, commit, changes] = await Promise.all([
    git('remote', 'get-url', 'origin'), git('describe', '--tags', '--exact-match', 'HEAD'), git('rev-parse', 'HEAD'), git('status', '--porcelain'),
  ]);
  if (remote !== pkg.repository || tag !== pkg.tag || (pkg.commit && commit !== pkg.commit) || changes) {
    throw new Error(`SDK source identity does not match the pinned release: ${directory}. Existing source was left untouched.`);
  }
  return { ...pkg, commit, directory };
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write('node scripts/setup-live2d-sdk.mjs [--sources-only] [--output-dir <new directory>]\nDownloads pinned official public Framework / MotionSync source, then bundles the scene adapter.\nCore binaries and interviewer models are NOT downloaded or created.\n');
    return;
  }
  await fs.mkdir(sourceRoot, { recursive: true });
  const sources = await Promise.all(packages.map(prepareSource));
  if (process.argv.includes('--sources-only')) {
    process.stdout.write(`${JSON.stringify(sources.map(({ directory, ...source }) => ({ ...source, directory })), null, 2)}\n`);
    return;
  }
  let esbuild;
  try { esbuild = await import('esbuild'); } catch {
    throw new Error('esbuild is required. Add esbuild as a development dependency, install dependencies, and run this setup again.');
  }
  await fs.mkdir(outputRoot, { recursive: true });
  const output = path.join(outputRoot, 'renderer.mjs');
  if (outputIndex >= 0 && await exists(output)) throw new Error('Refusing to overwrite an existing versioned build. Choose a new --output-dir.');
  await esbuild.build({
    entryPoints: [path.join(root, 'integrations', 'live2d', 'renderer.mjs')],
    outfile: output,
    absWorkingDir: root,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    legalComments: 'eof',
    alias: {
      '@framework': path.join(sourceRoot, 'Framework', 'src'),
      '@motionsyncframework': path.join(sourceRoot, 'MotionSync', 'Framework', 'src'),
    },
    logLevel: 'warning',
  });
  await fs.cp(path.join(sourceRoot, 'Framework', 'Shaders', 'WebGL'), path.join(outputRoot, 'shaders'), { recursive: true });
  for (const source of sources) {
    const destination = path.join(outputRoot, 'licenses', source.name);
    await fs.mkdir(destination, { recursive: true });
    for (const filename of ['LICENSE.md', 'NOTICE.md', 'README.md', 'CHANGELOG.md']) {
      if (await exists(path.join(source.directory, filename))) await fs.copyFile(path.join(source.directory, filename), path.join(destination, filename));
    }
  }
  const bytes = await fs.readFile(output);
  const provenance = {
    builtAt: new Date().toISOString(),
    sources: sources.map(source => ({ name: source.name, repository: source.repository, tag: source.tag, commit: source.commit })),
    bundle: { path: outputIndex < 0 ? '/live2d/runtime/renderer.mjs' : path.relative(root, output).split(path.sep).join('/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), esbuild: esbuild.version },
    coreBinariesIncluded: false,
    modelsIncluded: false,
    runtimeVerified: false,
  };
  await fs.writeFile(path.join(outputRoot, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  process.stdout.write(`Built ${output}\n${bytes.length} bytes; Core binaries and dedicated models still required. No model rendering has been verified by this build.\n`);
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
