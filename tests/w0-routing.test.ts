import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { detailPages, getW0Route, primaryNavigation } from '../lib/w0/navigation';

const root = fileURLToPath(new URL('../', import.meta.url));
const readSource = (relativePath: string) => readFileSync(path.join(root, relativePath), 'utf8');

// Read the CSV as CSV, including quoted fields, so descriptions may contain commas.
function registryRows() {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let quoted = false;
  const source = readSource('docs/ia-registry.csv').replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) { record.push(cell); cell = ''; }
    else if (character === '\n' && !quoted) {
      record.push(cell.replace(/\r$/, ''));
      if (record.some(Boolean)) records.push(record);
      record = [];
      cell = '';
    } else cell += character;
  }
  if (cell || record.length) { record.push(cell.replace(/\r$/, '')); records.push(record); }
  assert.equal(quoted, false, 'The registry must contain valid quoted CSV fields');
  const [headers, ...rows] = records;
  return rows.map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])));
}

const ids = (prefix: string, start: number, end: number) => Array.from(
  { length: end - start + 1 }, (_, index) => `${prefix}${String(start + index).padStart(2, '0')}`,
);
const approvedIds = [
  ...ids('P', 1, 6), ...ids('O', 1, 6), 'H01', ...ids('G', 1, 7), 'G09',
  ...ids('I', 0, 10), ...ids('A', 0, 4), 'A06', ...ids('M', 0, 4), ...ids('U', 1, 8),
];
const entryScreenIds: Record<string, string> = {
  home: 'H01', record: 'G01', interviews: 'I00', answers: 'A00', memory: 'M00',
};

test('registry covers exactly the 51 active collaboration IDs without removed or invented screens', () => {
  const rows = registryRows();
  const actualIds = rows.map((row) => row.id ?? row.ia_id);
  assert.equal(rows.length, 51);
  assert.equal(new Set(actualIds).size, 51);
  assert.deepEqual(actualIds.toSorted(), approvedIds.toSorted());
  assert.ok(rows.every((row) => ['page', 'panel', 'action'].includes(row.kind ?? row.type)));
});

test('every registry page resolves once while panels and actions remain inside their hosts', () => {
  const rows = registryRows();
  const routableIds = new Set<string>();
  const pages = rows.filter((row) => (row.kind ?? row.type) === 'page');
  assert.equal(pages.length, 45);
  for (const row of rows) {
    const id = row.id ?? row.ia_id;
    const kind = row.kind ?? row.type;
    if (kind !== 'page') {
      assert.equal(getW0Route(['view', id]), null, `${id} is a ${kind}, not an independent route`);
      assert.equal(Object.hasOwn(detailPages, id), false);
      continue;
    }
    const routePath = row.route_or_host;
    assert.ok(routePath.startsWith('/w0'), `${id} must have an isolated W0 path`);
    const segments = routePath.slice('/w0'.length).split('/').filter(Boolean);
    const route = getW0Route(segments);
    assert.ok(route, `${id}: ${routePath} must resolve`);
    const resolvedId = route.id ?? entryScreenIds[route.screen];
    assert.equal(resolvedId, id, `${routePath} must resolve to its own collaboration ID`);
    assert.equal(route.preview, false);
    assert.equal(routableIds.has(resolvedId), false, `${id} must not resolve twice`);
    routableIds.add(resolvedId);
  }
  assert.equal(Object.keys(detailPages).length + Object.keys(entryScreenIds).length, routableIds.size);
  assert.ok(Object.keys(detailPages).every((id) => routableIds.has(id)), 'No detail route may bypass the registry');
});

test('primary navigation preserves the four approved learning areas and the logo-only home', () => {
  assert.deepEqual(primaryNavigation.map((item) => item.label), ['생기부', '면접 연습실', '내 답변', '암기 훈련실']);
  assert.equal(primaryNavigation.length, 4);
  for (const item of primaryNavigation) {
    const route = getW0Route(item.path.slice('/w0/'.length).split('/'));
    assert.ok(route);
    assert.equal(route.area, item.area);
    assert.notEqual(route.screen, 'home');
  }
  assert.equal(getW0Route()?.screen, 'home');
});

test('removed IDs, panel URLs, prototype property names, and unknown paths fail closed', () => {
  for (const id of ['A05', 'G00', 'G08', 'G09', 'A04', 'I04', 'I09', 'U06', 'U08', 'G99', '__proto__', 'constructor', 'toString']) {
    assert.equal(getW0Route(['view', id]), null, id);
  }
  for (const segments of [
    ['unknown'], ['interview'], ['interview', 'scene'], ['record', 'G02'],
    ['home'], ['view'], ['view', 'G02', 'extra'], ['preview', 'preview'],
  ]) assert.equal(getW0Route(segments), null, segments.join('/'));
});

test('preview routing is explicit and cannot silently turn an ordinary W0 page into example data', () => {
  for (const segments of [[], ['record'], ['interviews'], ['answers'], ['memory'], ['view', 'G04']]) {
    const ordinary = getW0Route(segments);
    const preview = getW0Route(['preview', ...segments]);
    assert.ok(ordinary && preview);
    assert.equal(ordinary.preview, false);
    assert.deepEqual(preview, { ...ordinary, preview: true });
  }
  assert.equal(getW0Route(['preview', 'view', 'A05']), null);
  const page = readSource('app/w0/[[...path]]/page.tsx');
  const developmentGate = page.indexOf("route.preview && process.env.NODE_ENV !== 'development'");
  const fixtureImport = page.indexOf("await import('@/lib/w0/development-fixtures')");
  assert.ok(developmentGate >= 0 && developmentGate < fixtureImport, 'The server must reject non-development previews before importing fixtures');
  assert.match(page.slice(developmentGate, fixtureImport), /notFound\(\)/);
  assert.match(page, /let model = createDisconnectedModel\(\)/);
  assert.match(page.slice(0, fixtureImport), /if \(route\.preview\)\s*\{/);
  for (const file of readdirSync(path.join(root, 'components/w0')).filter((name) => /\.tsx?$/.test(name))) {
    assert.doesNotMatch(readSource(`components/w0/${file}`), /(?:from\s*|import\s*\()['"][^'"]*development-fixtures/, `${file} must not import synthetic data into a client bundle`);
  }
});

test('the new shell cannot wrap the existing interview entry, layout, or session engine', () => {
  const existingBoundary = [
    'app/page.tsx', 'app/layout.tsx', 'app/globals.css', 'app/interview/page.tsx',
    'app/interview/scene/page.tsx', 'components/interview/InterviewShell.tsx',
    'hooks/useInterviewSession.ts', 'start server.bat', 'scripts/start-local.mjs',
  ];
  for (const file of existingBoundary) {
    assert.doesNotMatch(readSource(file), /(?:from\s*['"][^'"]*\/w0(?:\/|['"])|<W0(?:App|Provider|Shell)\b|\/w0(?:\/|['"`]))/, `${file} must stay outside W0 layout and target state`);
  }
  assert.match(readSource('app/page.tsx'), /redirect\(\s*['"]\/interview['"]\s*\)/);
  assert.match(readSource('app/interview/page.tsx'), /<InterviewShell\s*\/>/);
  assert.match(readSource('app/interview/scene/page.tsx'), /<SceneHost\s*\/>/);
  assert.match(readSource('start server.bat'), /scripts\\start-local\.mjs/);
  assert.match(readSource('scripts/start-local.mjs'), /openBrowser\(`http:\/\/localhost:\$\{web\}\/interview`\)/);
});
