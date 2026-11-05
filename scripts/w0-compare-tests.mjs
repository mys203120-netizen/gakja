import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeText } from './w0-test-reporter.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const reporter = fileURLToPath(new URL('./w0-test-reporter.mjs', import.meta.url));
const overrides = { NODE_ENV: 'test', TZ: 'Asia/Seoul', NEXT_TELEMETRY_DISABLED: '1' };

function argumentsFor(argv) {
  if (argv.includes('--help')) return null;
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!['--baseline', '--current', '--out'].includes(key) || !argv[index + 1]) throw new Error(`Unknown or incomplete argument: ${key}`);
    result[key.slice(2)] = argv[index + 1];
  }
  for (const key of ['baseline', 'current', 'out']) {
    if (!result[key] || !path.isAbsolute(result[key])) throw new Error(`--${key} must be an absolute path`);
  }
  if (path.resolve(result.baseline) === path.resolve(result.current)) throw new Error('Baseline and current directories must differ');
  return result;
}

async function optionalHash(filename) {
  try { return hash(await readFile(filename)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function inspectRoot(root) {
  if (!(await stat(root)).isDirectory()) throw new Error(`Not a snapshot directory: ${root}`);
  const tests = (await readdir(path.join(root, 'tests'))).filter((name) => name.endsWith('.test.ts')).sort().map((name) => `tests/${name}`);
  if (!tests.length) throw new Error(`No root tests/*.test.ts found in ${root}`);
  const testSources = Object.fromEntries(await Promise.all(tests.map(async (name) => [name, hash(await readFile(path.join(root, name)))])));
  const packages = {};
  for (const name of ['tsx', 'typescript', 'next']) {
    packages[name] = JSON.parse(await readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
  }
  return {
    root: await realpath(root),
    packageJsonSha256: hash(await readFile(path.join(root, 'package.json'))),
    packageLockSha256: hash(await readFile(path.join(root, 'package-lock.json'))),
    installedLockSha256: await optionalHash(path.join(root, 'node_modules', '.package-lock.json')),
    nodeModulesRealPath: await realpath(path.join(root, 'node_modules')),
    packages,
    tests,
    testSources,
  };
}

function safeProcessText(value, roots) {
  let result = normalizeText(value);
  for (const root of roots) {
    for (const spelling of new Set([root, root.replaceAll('\\', '/')])) result = result.split(spelling).join('<SNAPSHOT>');
  }
  return result;
}

async function runSuite(label, root, metadata, out, env, roots) {
  const destination = path.join(out, `${label}.events.jsonl`);
  const command = [
    '--import', 'tsx', '--test', '--test-concurrency=4',
    `--test-reporter=${pathToFileURL(reporter).href}`, `--test-reporter-destination=${destination}`,
    ...metadata.tests,
  ];
  const startedAt = new Date().toISOString();
  const output = { stdout: '', stderr: '' };
  process.stdout.write(`Running ${label}: ${metadata.tests.length} test files\n`);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, command, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { output.stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output.stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ exitCode: code, signal }));
  });
  // Persist the exit result before examining the reporter, even for a crash.
  const execution = { command: [process.execPath, ...command], cwd: root, startedAt, endedAt: new Date().toISOString(), ...result };
  await writeFile(path.join(out, `${label}.execution.json`), `${JSON.stringify(execution, null, 2)}\n`);
  await writeFile(path.join(out, `${label}.process-output.json`), `${JSON.stringify({
    stdout: { bytes: Buffer.byteLength(output.stdout), sha256: hash(output.stdout) },
    stderr: { bytes: Buffer.byteLength(output.stderr), sha256: hash(output.stderr), normalizedSha256: hash(safeProcessText(output.stderr, roots)), codes: [...new Set(output.stderr.match(/\b(?:ERR_[A-Z_]+|ENOENT|EADDRINUSE|ECONNREFUSED)\b/gu) ?? [])] },
  }, null, 2)}\n`);
  process.stdout.write(`Finished ${label}: exit ${result.exitCode ?? result.signal}\n`);
  let parsed;
  try { parsed = await parseEvents(destination); }
  catch (error) {
    parsed = { counts: { tests: null, pass: null, fail: null, skip: null, cancelled: null, todo: null, suites: null }, success: false, duration_ms: null, records: [], integrityErrors: [safeProcessText(error.message, roots)] };
  }
  return { execution, parsed };
}

function idKey(record, id) { return id === null ? null : `${record.entryFile ?? record.file}\u0000${id}`; }

function ancestorNames(record, records, metadata, index) {
  const names = [];
  let parentId = record.parentId;
  const visited = new Set();
  while (parentId !== null && parentId !== undefined) {
    const key = idKey(record, parentId);
    if (visited.has(key)) break;
    visited.add(key);
    const parent = metadata.get(key);
    if (!parent) break;
    names.unshift(parent.name);
    parentId = parent.parentId;
  }
  if (names.length || record.nesting === 0) return { names, method: 'runtime-parent-id' };
  // Older Node versions do not expose parentId. pass/fail reporter events are
  // emitted in declaration order, with children before their aggregate parent.
  // Resolve that terminal tree, retaining an explicit method for review.
  let needed = record.nesting - 1;
  for (let cursor = index + 1; cursor < records.length && needed >= 0; cursor += 1) {
    const candidate = records[cursor];
    if (candidate.file !== record.file) continue;
    if (candidate.nesting < needed) break;
    if (candidate.nesting === needed) { names.unshift(candidate.name); needed -= 1; }
  }
  return { names, method: needed < 0 ? 'ordered-terminal-tree' : 'unresolved' };
}

function causeForComparison(error) {
  if (!error || typeof error !== 'object') return error;
  return Object.fromEntries(Object.entries(error).filter(([key]) => key !== 'frames').sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, Array.isArray(value) ? value.map(causeForComparison) : causeForComparison(value)]));
}

export async function parseEvents(filename) {
  const lines = (await readFile(filename, 'utf8')).split(/\r?\n/u).filter(Boolean);
  const events = lines.map((line, index) => { try { return JSON.parse(line); } catch { throw new Error(`Invalid reporter JSON at ${filename}:${index + 1}`); } });
  if (!events.some((event) => event.type === 'w0:reporter' && event.schemaVersion === 1)) throw new Error(`Missing structured reporter header in ${filename}`);
  const metadata = new Map();
  for (const event of events) if (event.testId !== null && event.testId !== undefined) metadata.set(idKey(event, event.testId), event);
  const terminals = events.filter((event) => event.type === 'test:pass' || event.type === 'test:fail');
  const occurrence = new Map();
  const records = terminals.map((event, index) => {
    const ancestry = ancestorNames(event, terminals, metadata, index);
    const base = JSON.stringify([event.file, event.line, event.column, ancestry.names, event.name]);
    const ordinal = (occurrence.get(base) ?? 0) + 1;
    occurrence.set(base, ordinal);
    const identity = JSON.stringify([event.file, event.line, event.column, ancestry.names, event.name, ordinal]);
    return {
      identity, file: event.file, line: event.line, column: event.column, ancestors: ancestry.names, ancestorMethod: ancestry.method,
      name: event.name, occurrence: ordinal, nesting: event.nesting, testType: event.testType,
      outcome: event.type === 'test:fail' ? 'fail' : event.skip ? 'skip' : event.todo ? 'todo' : 'pass',
      ...(event.error ? { error: event.error, causeSha256: hash(JSON.stringify(causeForComparison(event.error))) } : {}),
    };
  });
  const globalSummary = events.filter((event) => event.type === 'test:summary' && event.file === null).at(-1) ?? null;
  const diagnostics = Object.fromEntries(events.filter((event) => event.type === 'test:diagnostic' && event.nesting === 0).map((event) => event.message.split(' ')).map(([key, value]) => [key, Number(value)]));
  const counts = {
    tests: globalSummary?.counts?.tests ?? diagnostics.tests,
    pass: globalSummary?.counts?.passed ?? diagnostics.pass,
    fail: globalSummary?.counts?.failed ?? diagnostics.fail ?? records.filter((record) => record.outcome === 'fail' && record.testType !== 'suite').length,
    skip: globalSummary?.counts?.skipped ?? diagnostics.skipped ?? 0,
    cancelled: globalSummary?.counts?.cancelled ?? diagnostics.cancelled ?? 0,
    todo: globalSummary?.counts?.todo ?? diagnostics.todo ?? 0,
    suites: globalSummary?.counts?.suites ?? diagnostics.suites ?? 0,
  };
  const terminalTests = records.filter((record) => record.testType !== 'suite');
  const integrityErrors = [];
  if (!Number.isInteger(counts.tests)) integrityErrors.push('No final global test count was reported');
  if (Number.isInteger(counts.tests) && counts.tests !== terminalTests.length) integrityErrors.push(`Final tests=${counts.tests}, terminal test records=${terminalTests.length}`);
  if (counts.fail !== terminalTests.filter((record) => record.outcome === 'fail').length) integrityErrors.push('Final failed count differs from structured failure records');
  if (records.some((record) => record.ancestorMethod === 'unresolved')) integrityErrors.push('At least one nested test ancestor could not be resolved');
  return { counts, success: globalSummary?.success ?? null, duration_ms: globalSummary?.duration_ms ?? diagnostics.duration_ms ?? null, integrityErrors, records };
}

function comparableEnvironment(baseline, current) {
  const reasons = [];
  for (const key of ['packageJsonSha256', 'packageLockSha256', 'installedLockSha256']) {
    if (!baseline[key] || baseline[key] !== current[key]) reasons.push(`${key} differs or is unavailable`);
  }
  if (JSON.stringify(baseline.packages) !== JSON.stringify(current.packages)) reasons.push('Installed tool versions differ');
  return reasons;
}

export function compareRuns(baseline, current, baselineMetadata, currentMetadata) {
  const parityReasons = comparableEnvironment(baselineMetadata, currentMetadata);
  const left = new Map(baseline.records.map((record) => [record.identity, record]));
  const right = new Map(current.records.map((record) => [record.identity, record]));
  const result = { commonExistingFailures: [], w0NewFailures: [], existingFailuresResolved: [], incomparable: [], changedCauses: [], currentOnlyTests: [], missingCurrentTests: [] };
  for (const [identity, old] of left) {
    const now = right.get(identity);
    if (!now) {
      result.missingCurrentTests.push(old);
      if (old.outcome === 'fail') result.incomparable.push({ reason: 'Baseline failing test has no matching current test; not a resolved failure', baseline: old });
      continue;
    }
    const fileChanged = baselineMetadata.testSources[old.file] !== currentMetadata.testSources[now.file];
    const reason = [...parityReasons, ...(fileChanged ? ['Common test source bytes differ'] : []), ...baseline.integrityErrors, ...current.integrityErrors];
    if ((old.outcome === 'fail' || now.outcome === 'fail') && reason.length) {
      result.incomparable.push({ reason, baseline: old, current: now });
    } else if (old.outcome === 'fail' && now.outcome === 'fail') {
      if (old.causeSha256 === now.causeSha256) result.commonExistingFailures.push({ baseline: old, current: now });
      else {
        const changed = { reason: 'Same test identity but normalized cause changed; review required, not assumed environmental', baseline: old, current: now };
        result.changedCauses.push(changed);
        result.incomparable.push(changed);
      }
    } else if (old.outcome !== 'fail' && now.outcome === 'fail') result.w0NewFailures.push({ reason: 'Baseline test now fails', baseline: old, current: now });
    else if (old.outcome === 'fail' && now.outcome === 'pass') result.existingFailuresResolved.push({ baseline: old, current: now });
    else if (old.outcome === 'fail') result.incomparable.push({ reason: `Baseline fail became ${now.outcome}, not a passing test`, baseline: old, current: now });
  }
  for (const [identity, now] of right) {
    if (left.has(identity)) continue;
    const addedFile = !Object.hasOwn(baselineMetadata.testSources, now.file);
    result.currentOnlyTests.push({ addedFile, w0File: /^tests\/w0-/u.test(now.file ?? ''), test: now });
    if (now.outcome === 'fail') {
      if (!addedFile) result.incomparable.push({ reason: 'New identity in a common test file; inspect identity/source changes', current: now });
      else result.w0NewFailures.push({ reason: 'New current-only test fails', current: now });
    }
  }
  return { environmentComparable: parityReasons.length === 0, environmentReasons: parityReasons, executionComparable: baseline.integrityErrors.length === 0 && current.integrityErrors.length === 0, ...result };
}

function markdownReport(report) {
  const { comparison } = report;
  const rows = [
    ['공통 기존 실패', comparison.commonExistingFailures.length], ['W0 신규 실패', comparison.w0NewFailures.length],
    ['기존 실패 해소', comparison.existingFailuresResolved.length], ['비교 불가/원인 변경', comparison.incomparable.length],
    ['현재에만 있는 테스트', comparison.currentOnlyTests.length],
  ];
  const lines = ['# W0 전체 테스트 기준본 대조', '', `Node ${report.environment.node}; NODE_ENV=test; TZ=Asia/Seoul; concurrency=4.`, '',
    '| 실행 | 전체 | 통과 | 실패 | skip | exit |', '|---|---:|---:|---:|---:|---:|',
    ...['baseline', 'current'].map((key) => { const run = report[key]; return `| ${key} | ${run.parsed.counts.tests} | ${run.parsed.counts.pass} | ${run.parsed.counts.fail} | ${run.parsed.counts.skip} | ${run.execution.exitCode} |`; }), '',
    '| 분류 | 건수 |', '|---|---:|', ...rows.map(([name, count]) => `| ${name} | ${count} |`), '',
    `의존성/환경 비교 가능: ${comparison.environmentComparable}. 원인 변경은 공통 실패로 합치지 않는다.`, '',
    '정확한 이름·상대 위치·ancestor·정규화된 원인과 서명은 comparison.json을 참조한다. 원본 stdout/학생 assertion 본문은 저장하지 않는다.', '',
  ];
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const args = argumentsFor(argv);
  if (!args) {
    process.stdout.write('Usage: node scripts/w0-compare-tests.mjs --baseline ABS --current ABS --out ABS\nRuns both full suites sequentially with a shared structured reporter; no source or dependency mutations.\n');
    return;
  }
  await mkdir(args.out, { recursive: true });
  const baselineMetadata = await inspectRoot(args.baseline);
  const currentMetadata = await inspectRoot(args.current);
  const env = { ...process.env, ...overrides };
  const npmCli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const npm = spawnSync(process.execPath, [npmCli, '--version'], { encoding: 'utf8', windowsHide: true });
  const environment = {
    node: process.version, nodeExecutable: process.execPath, npm: npm.status === 0 ? npm.stdout.trim() : null,
    overrides, inheritedEnvironmentSha256: hash(JSON.stringify(Object.entries(env).sort(([left], [right]) => left.localeCompare(right)))),
    sameEnvironmentObject: true, reporter, reporterSha256: hash(await readFile(reporter)),
    comparatorSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    credentialAvailability: Object.fromEntries(['OPENAI_API_KEY', 'CLOVA_SPEECH_SECRET_KEY', 'CLOVA_VOICE_CLIENT_ID', 'CLOVA_VOICE_CLIENT_SECRET'].map((key) => [key, Boolean(env[key])])),
  };
  await writeFile(path.join(args.out, 'inputs.json'), `${JSON.stringify({ environment, baselineMetadata, currentMetadata }, null, 2)}\n`);
  const roots = [args.baseline, args.current];
  const baseline = await runSuite('baseline', args.baseline, baselineMetadata, args.out, env, roots);
  const current = await runSuite('current', args.current, currentMetadata, args.out, env, roots);
  const comparison = compareRuns(baseline.parsed, current.parsed, baselineMetadata, currentMetadata);
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), environment, baselineMetadata, currentMetadata, baseline, current, comparison };
  await writeFile(path.join(args.out, 'comparison.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(args.out, 'comparison.md'), markdownReport(report));
  process.stdout.write(`Comparison: common=${comparison.commonExistingFailures.length}, new=${comparison.w0NewFailures.length}, resolved=${comparison.existingFailuresResolved.length}, incomparable=${comparison.incomparable.length}, current-only=${comparison.currentOnlyTests.length}\n`);
  process.exitCode = comparison.w0NewFailures.length || comparison.incomparable.length || baseline.parsed.integrityErrors.length || current.parsed.integrityErrors.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => { process.stderr.write(`${normalizeText(error.stack ?? error)}\n`); process.exitCode = 1; });
}
