import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyLive2DAssets } from '../lib/live2d/asset-validation.mjs';
export { verifyLive2DAssets };

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.includes('--delivery-root')) {
      const { deliveryCli } = await import('../lib/live2d/delivery-validation.mjs');
      await deliveryCli(process.argv.slice(2));
    } else {
    const args = process.argv.slice(2), options = {};
    let reportPath;
    for (let i = 0; i < args.length; i++) {
      if (!['--report', '--manifest', '--public-root'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('사용법: node scripts/verify-live2d-assets.mjs [--report artifacts/live2d-asset-check.json] [--manifest 파일] [--public-root 디렉터리]');
      const key = args[i++], value = path.resolve(args[i]);
      if (key === '--report') reportPath = value;
      else if (key === '--manifest') options.manifestPath = value;
      else options.publicRoot = value;
    }
    const report = await verifyLive2DAssets(options);
    if (reportPath) { await mkdir(path.dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' }); }
    process.stdout.write(`${JSON.stringify({ ...report, checkedFiles: report.checkedFiles.length, ...(reportPath ? { reportPath } : {}) }, null, 2)}\n`);
    process.exitCode = report.status === 'ready' ? 0 : 1;
    }
  } catch (failure) { process.stderr.write(`${failure.message}\n`); process.exitCode = 1; }
}
