import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { compareFollowupLatency, type FollowupLatencyReport } from './lib/followup-latency-gate';

export async function compareFollowupLatencyFiles(args: string[]) {
  if (args.includes('--help')) return { help: 'compare-followup-latency --before <report.json> --after <report.json> --out <receipt.json> [--minimum-pairs 20]' };
  const value = (name: string) => { const index = args.indexOf(name); if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name}`); return args[index + 1]; };
  const beforePath = value('--before'), afterPath = value('--after');
  const beforeBytes = await readFile(beforePath), afterBytes = await readFile(afterPath);
  const before = JSON.parse(beforeBytes.toString('utf8')) as FollowupLatencyReport;
  const after = JSON.parse(afterBytes.toString('utf8')) as FollowupLatencyReport;
  const minimum = args.includes('--minimum-pairs') ? Number(value('--minimum-pairs')) : 20;
  const receipt = compareFollowupLatency(before, after, minimum);
  receipt.evidence = {
    before: { path: path.relative(process.cwd(), path.resolve(beforePath)).replaceAll('\\', '/'), sha256: createHash('sha256').update(beforeBytes).digest('hex') },
    after: { path: path.relative(process.cwd(), path.resolve(afterPath)).replaceAll('\\', '/'), sha256: createHash('sha256').update(afterBytes).digest('hex') },
  };
  await writeFile(value('--out'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  compareFollowupLatencyFiles(process.argv.slice(2)).then(receipt => {
    console.log(JSON.stringify(receipt));
    if ('status' in receipt && receipt.status !== 'pass') process.exitCode = 1;
  }).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
