import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detailPages } from '../lib/w0/navigation.ts';
import { fixtureScenarios } from '../lib/w0/development-fixtures.ts';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const usage = `W0 HTTP verification (local servers only)

Usage:
  node --import tsx scripts/w0-http-check.mjs --base http://127.0.0.1:PORT --mode production --out ABSOLUTE_REPORT.json
  node --import tsx scripts/w0-http-check.mjs --base http://127.0.0.1:PORT --mode development --out ABSOLUTE_REPORT.json

The script never launches or stops a server. Production checks rejection and
fixture absence across the W0 route matrix; development checks the nine home
scenarios, four entry screens and G04's initial editing controls. Browser
interaction, client-chunk scanning and physical-device checks are separate.
Reports contain marker booleans, not response bodies or student content.
`;

function optionsFrom(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return null;
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!['--base', '--mode', '--out'].includes(flag) || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error('Use --base URL --mode production|development --out ABSOLUTE_JSON_PATH.');
    }
    if (Object.hasOwn(options, flag.slice(2))) throw new Error(`Repeated option: ${flag}`);
    options[flag.slice(2)] = argv[index + 1];
  }
  if (!options.base || !['production', 'development'].includes(options.mode) || !options.out || !path.isAbsolute(options.out)) {
    throw new Error('A local base URL, production|development mode and absolute report path are required.');
  }
  const base = new URL(options.base);
  if (!['http:', 'https:'].includes(base.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
    || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('--base must be an HTTP(S) loopback origin without credentials, a path, query or fragment.');
  }
  return { base: base.origin, mode: options.mode, out: path.resolve(options.out) };
}

const entryPaths = ['/w0', '/w0/record', '/w0/interviews', '/w0/answers', '/w0/memory'];
const representativePaths = [...entryPaths, '/w0/view/G04'];
const allPagePaths = [...entryPaths, ...Object.keys(detailPages).map((id) => `/w0/view/${id}`)];
const invalidSuffixes = [
  'view/A05', 'view/G08', 'view/G09', 'view/A04', 'view/I04', 'view/I09',
  'view/U06', 'view/U08', 'unknown', 'view/G04/extra', 'record/extra', 'view/__proto__',
];

function previewPath(ordinaryPath) {
  return `/w0/preview${ordinaryPath.slice('/w0'.length)}`;
}

function buildCases(mode) {
  if (allPagePaths.length !== 45 || new Set(allPagePaths).size !== 45) {
    throw new Error('Expected the current W0 registry projection to contain 45 unique page paths.');
  }
  const cases = [];
  function add(group, routePath, scenario, expected) {
    const query = scenario === null ? '' : `?${new URLSearchParams({ scenario })}`;
    cases.push({ id: `${mode}-${String(cases.length + 1).padStart(3, '0')}`, group, path: `${routePath}${query}`, scenario, expected });
  }
  const ordinary = (requireDisconnected = false) => ({ status: 200, kind: 'ordinary', requireDisconnected });
  const rejected = { status: 404, kind: 'rejected' };
  if (mode === 'production') {
    for (const routePath of representativePaths) {
      for (const scenario of [null, ...fixtureScenarios]) {
        add('ordinary-main', routePath, scenario, ordinary(true));
        add('preview-main-rejected', previewPath(routePath), scenario, rejected);
      }
    }
    for (const routePath of allPagePaths.filter((candidate) => !representativePaths.includes(candidate))) {
      add('ordinary-other-page', routePath, 'ready', ordinary());
      add('preview-other-page-rejected', previewPath(routePath), 'ready', rejected);
    }
    for (const suffix of invalidSuffixes) {
      add('invalid-ordinary-rejected', `/w0/${suffix}`, 'ready', rejected);
      add('invalid-preview-rejected', `/w0/preview/${suffix}`, 'ready', rejected);
    }
    add('ordinary-unknown-scenario', '/w0/view/G04', 'unknown-scenario', ordinary(true));
    add('preview-unknown-scenario-rejected', '/w0/preview/view/G04', 'unknown-scenario', rejected);
  } else {
    for (const scenario of fixtureScenarios) {
      const state = ['ready', 'long-target', 'one-target'].includes(scenario) ? null : scenario;
      add('development-home-scenario', '/w0/preview', scenario, {
        status: 200, kind: 'example', state, reviewScoreNull: scenario === 'review_required',
      });
    }
    for (const routePath of entryPaths.slice(1)) {
      add('development-entry-ready', previewPath(routePath), 'ready', { status: 200, kind: 'example', state: null });
    }
    add('development-g04-ready', '/w0/preview/view/G04', 'ready', { status: 200, kind: 'example', state: null, questionControls: true });
    // Verify that enabling development previews did not enable fixtures on ordinary pages.
    for (const routePath of representativePaths) add('development-ordinary-isolation', routePath, 'ready', ordinary(true));
    add('development-unknown-scenario-rejected', '/w0/preview/view/G04', 'unknown-scenario', rejected);
  }
  return cases;
}

function responseMarkers(body) {
  // Flight payload strings escape quotes. Normalize quoting only; never retain body content.
  const payload = body.replace(/\\+(?=")/g, '');
  const uniqueFixtures = {
    universityA: body.includes('예시대학교'),
    universityB: body.includes('가상대학교'),
    syntheticSource: body.includes('합성 학생부 원문'),
    exactQuestion: body.includes('탐구 활동에서 실험 조건을 비교할 때 어떤 역할을 맡았나요?'),
    exactAnswer: body.includes('저는 측정 조건을 정리하고 팀원들의 관찰 내용을 모아 비교하는 역할을 맡았습니다.'),
  };
  return {
    w0Shell: /data-w0-shell=["']true["']/.test(body),
    fixtureSelector: /<select\b[^>]*\baria-label=["']미리보기 상태["']/.test(body),
    exampleLabel: body.includes('예시 데이터'),
    isExampleTrue: /"isExample"\s*:\s*true/.test(payload),
    isExampleFalse: /"isExample"\s*:\s*false/.test(payload),
    states: [...new Set([...body.matchAll(/data-state=["']([a-z_]+)["']/g)].map((match) => match[1]))],
    uniqueFixtures,
    anyUniqueFixture: Object.values(uniqueFixtures).some(Boolean),
    editAnswerControl: /<button\b[^>]*>[\s\S]*?답변 수정하기[\s\S]*?<\/button>/.test(body),
    saveQuestionControl: body.includes('질문 저장하기'),
    savedQuestionSuccess: body.includes('예시 질문 저장됨'),
    savedAnswerSuccess: body.includes('이 화면의 예시 답변에 반영했어요.'),
    nullScorePayload: /"score"\s*:\s*null/.test(payload),
    zeroScoreText: body.includes('0점'),
  };
}

function assess(expected, status, markers) {
  const errors = [];
  if (status !== expected.status) errors.push(`status: expected ${expected.status}, received ${status}`);
  function require(value, description) { if (!value) errors.push(description); }
  if (expected.kind === 'rejected') {
    require(!markers.w0Shell, 'rejected response must not render the W0 shell');
    require(!markers.fixtureSelector, 'rejected response must not render the fixture selector');
    require(!markers.isExampleTrue && !markers.anyUniqueFixture, 'rejected response contains example payload or fixture values');
    require(!markers.exampleLabel && !markers.savedQuestionSuccess && !markers.savedAnswerSuccess, 'rejected response contains preview or saved-success content');
  } else if (expected.kind === 'ordinary') {
    require(markers.w0Shell, 'ordinary response must render the W0 shell');
    require(markers.isExampleFalse && !markers.isExampleTrue, 'ordinary payload must remain explicitly non-example');
    require(!markers.fixtureSelector && !markers.exampleLabel && !markers.anyUniqueFixture, 'ordinary response contains fixture controls or values');
    require(!markers.savedQuestionSuccess && !markers.savedAnswerSuccess, 'ordinary response contains example save-success content');
    if (expected.requireDisconnected) require(markers.states.includes('disconnected'), 'ordinary representative response must show the disconnected state');
  } else {
    require(markers.w0Shell && markers.fixtureSelector && markers.exampleLabel, 'development preview must render shell, fixture selector and example label');
    require(markers.isExampleTrue && !markers.isExampleFalse, 'development preview must carry an explicit example payload');
    if (expected.state === null) require(markers.states.length === 0, 'ready preview unexpectedly renders a non-ready notice');
    else require(markers.states.includes(expected.state), `development preview must render state ${expected.state}`);
    if (expected.reviewScoreNull) {
      require(markers.nullScorePayload, 'review-required preview must retain a null score');
      require(!markers.zeroScoreText, 'review-required preview must not replace its null score with 0점');
    }
    if (expected.questionControls) {
      require(markers.uniqueFixtures.syntheticSource && markers.uniqueFixtures.exactQuestion && markers.uniqueFixtures.exactAnswer, 'G04 preview is missing its synthetic source, question or initial answer');
      require(markers.editAnswerControl && markers.saveQuestionControl, 'G04 preview is missing answer-edit or question-save controls');
      require(!markers.savedQuestionSuccess && !markers.savedAnswerSuccess, 'fresh G04 HTTP response must not claim a completed save');
    }
  }
  return errors;
}

async function executeCase(base, entry) {
  const started = performance.now();
  const url = new URL(entry.path, base).href;
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      headers: { Accept: 'text/html', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(30000),
    });
    const markers = responseMarkers(await response.text());
    const errors = assess(entry.expected, response.status, markers);
    return { ...entry, url, status: response.status, contentType: response.headers.get('content-type'), location: response.headers.get('location'), markers, durationMs: Math.round(performance.now() - started), passed: errors.length === 0, errors };
  } catch (error) {
    return { ...entry, url, status: null, markers: null, durationMs: Math.round(performance.now() - started), passed: false, errors: [`HTTP request failed (${error instanceof Error ? error.name : 'unknown error'})`] };
  }
}

function sourceMetadata() {
  const files = [
    'scripts/w0-http-check.mjs', 'app/w0/[[...path]]/page.tsx',
    'lib/w0/navigation.ts', 'lib/w0/development-fixtures.ts', 'lib/w0/view-model.ts',
    'components/w0/W0App.tsx', 'components/w0/ui.tsx', 'components/w0/DetailScreen.tsx',
    'components/w0/QuestionPreview.tsx', 'package-lock.json',
  ];
  const checkedSourceSha256 = Object.fromEntries(files.map((file) => [file, createHash('sha256').update(readFileSync(path.join(sourceRoot, file))).digest('hex')]));
  let gitHead = null;
  try { gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* A frozen source directory need not be a Git worktree. */ }
  return { sourceRoot, gitHead, checkedSourceSha256, nodeVersion: process.version, platform: process.platform };
}

async function main() {
  const options = optionsFrom(process.argv.slice(2));
  if (!options) { process.stdout.write(usage); return; }
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const cases = buildCases(options.mode);
  const concurrency = options.mode === 'production' ? 4 : 2;
  const results = new Array(cases.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
    while (cursor < cases.length) {
      const index = cursor++;
      results[index] = await executeCase(options.base, cases[index]);
    }
  }));
  const groups = {};
  for (const result of results) {
    groups[result.group] ??= { total: 0, passed: 0, failed: 0 };
    groups[result.group].total += 1;
    groups[result.group][result.passed ? 'passed' : 'failed'] += 1;
  }
  const passed = results.filter((result) => result.passed).length;
  const summary = { total: results.length, passed, failed: results.length - passed, groups };
  const report = {
    reportVersion: 1, startedAt, completedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started), base: options.base, mode: options.mode,
    concurrency, ...sourceMetadata(),
    coverage: { pageCount: allPagePaths.length, representativePaths, fixtureScenarios: [...fixtureScenarios], invalidSuffixes },
    limitations: ['HTTP and initial HTML/payload markers only', 'No browser editing, focus, zoom or device interaction', 'Client chunk scanning is a separate check', 'Source hashes cover the listed files; the caller owns the complete frozen-source manifest'],
    summary, results,
  };
  mkdirSync(path.dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ mode: options.mode, ...summary, durationMs: report.durationMs, out: options.out })}\n`);
  if (summary.failed) {
    process.stderr.write(`${JSON.stringify(results.filter((result) => !result.passed).slice(0, 10).map(({ id, url, errors }) => ({ id, url, errors })))}\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
