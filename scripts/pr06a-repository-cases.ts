/** Same synthetic bytes through independent before/after source modules.
 * Fixture setup writes only owned artifact directories; observed reads may not write. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const flags = new Map(process.argv.slice(2).map(argument => { const match = /^--(source-root|fixture|output|freeze-fixture)=(.+)$/u.exec(argument); if (!match) throw new Error('PR06A_CASE_FLAGS_INVALID'); return [match[1], match[2]]; }));
for (const key of ['source-root', 'fixture', 'output']) if (!flags.has(key)) throw new Error('PR06A_CASE_EXPLICIT_ROOT_FIXTURE_OUTPUT_REQUIRED');
const sourceRoot = path.resolve(flags.get('source-root')!), fixtureFile = path.resolve(flags.get('fixture')!), output = path.resolve(flags.get('output')!);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const jsonSha = (value: unknown) => sha(JSON.stringify(value));
const clone = <T>(value: T): T => structuredClone(value);
const rehash = (value: Record<string, unknown>) => { const { contentSha256: ignored, ...body } = value; void ignored; value.contentSha256 = jsonSha(body); };
const load = (relative: string) => import(pathToFileURL(path.join(sourceRoot, relative)).href);
const [api, objectiveApi, questionDomainApi] = await Promise.all([load('server/data/full-student-analysis.ts'), load('server/question-objective.ts'), load('server/contracts/question-domain-adapters.ts')]);
await mkdir(path.dirname(output), { recursive: true });
if (flags.get('freeze-fixture') === 'true') {
  const { analysisDomainFixture } = await load('tests/fixtures/analysis-domain.ts');
  const base = analysisDomainFixture();
  base.context.errors = []; base.context.student.studentId = base.source.studentId; base.context.student.recordRevision = base.source.recordRevision;
  const derived = clone(base.v2); derived.target.revision = 'synthetic-derived-target-revision'; derived.target.analysisRevision = 'synthetic-derived-analysis-revision';
  derived.target.activityPriorities[0].reason = '동일한 공통 분석을 참조하는 합성 target-only 검수 자료';
  derived.target.objectiveContractRevision = { version: 'independently-reviewed-objective-contract-v1', parentRevision: base.v2.target.revision, parentContentSha256: base.v2.target.contentSha256,
    reviewArtifactSha256: sha('explicit synthetic target-only provenance'), reviewModel: 'synthetic-offline-review-fixture', reviewedAt: '2026-11-06T00:00:00.000Z', changedObjectiveIds: [], blockedObjectives: [] };
  rehash(derived.target);
  const frozen = { version: 'pr06a-before-generated-synthetic-input-v1', source: base.source, context: base.context, v1: base.v1, v2: base.v2, derived,
    qaV2: api.analysisQAManifest(base.v2, base.source, null), qaDerived: api.analysisQAManifest(derived, base.source, null) };
  await writeFile(fixtureFile, JSON.stringify(frozen, null, 2) + '\n', { flag: 'wx' });
}
const fixtureBytes = await readFile(fixtureFile), f = JSON.parse(fixtureBytes.toString('utf8'));
assert.equal(f.version, 'pr06a-before-generated-synthetic-input-v1');
const ownedBase = path.join(path.dirname(output), 'synthetic-roots'); await mkdir(ownedBase, { recursive: true });
const nativeFs = createRequire(import.meta.url)('node:fs/promises');
const fsKeys = ['readFile', 'writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm', 'copyFile'];
const originals = Object.fromEntries(fsKeys.map(key => [key, nativeFs[key]]));
const sourcePath = 'data/prepared/record-revisions/synthetic-source/source.json';
const analysisPath = 'data/prepared/student-analysis-revisions/synthetic-current/analysis.json';
const derivedPath = 'data/prepared/student-analysis-revisions/synthetic-current/synthetic-derived/analysis.json';
const sourcePointer = 'data/prepared/full-record-current.json', analysisPointer = 'data/prepared/student-analysis-current.json';
type State = { root: string; context: typeof f.context; write(relative: string, value: unknown): Promise<void>; json(relative: string): Promise<any>; remove(relative: string): Promise<void>; query: 'source' | 'current' | 'staged' | 'activate' | 'owner'; stagedPath: string; race?: 'analysis' | 'source' };
async function setup(version: 'v1' | 'v2' = 'v2'): Promise<State> {
  const root = await mkdtemp(path.join(ownedBase, 'owned-'));
  const write = async (relative: string, value: unknown) => { const file = path.join(root, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); };
  const payload = (value: unknown) => ({ ...(value as object), sourceRevision: f.source.revision, sourceContentSha256: f.source.contentSha256 });
  await write(sourcePath, f.source); await write(sourcePointer, { path: sourcePath, pdfSha256: f.source.pdfSha256, contentSha256: f.source.contentSha256 });
  await write(analysisPath, payload(f[version])); await write(analysisPointer, { path: analysisPath, revision: f[version].common.revision, sourceContentSha256: f.source.contentSha256 });
  if (version === 'v2') await write(path.join(path.dirname(analysisPath), 'analysis-qa.json'), f.qaV2);
  await write(derivedPath, payload(f.derived)); await write(path.join(path.dirname(derivedPath), 'analysis-qa.json'), f.qaDerived);
  return { root, write, context: clone(f.context), query: 'current', stagedPath: derivedPath,
    json: async relative => JSON.parse(await readFile(path.join(root, relative), 'utf8')), remove: relative => originals.unlink(path.join(root, relative)) };
}
async function inventory(root: string) {
  const rows: [string, string][] = [];
  const visit = async (directory: string) => { for (const entry of await readdir(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) await visit(file); else rows.push([path.relative(root, file).replaceAll('\\', '/'), sha(await readFile(file))]); } };
  await visit(root); return rows.sort(([a], [b]) => a.localeCompare(b));
}
function summarize(value: any) {
  if (value === null) return { status: 'null' };
  if (value.schemaVersion === 'full-record-source-v1') return { status: 'returned', kind: 'source', payloadJsonSha256: jsonSha(value), contentSha256: value.contentSha256 };
  const context = { ...clone(f.context), student: { ...clone(f.context.student), evidence: value.evidence }, studentAnalysis: value.common, targetAnalysis: value.target };
  return { status: 'returned', kind: 'analysis', commonVersion: value.common.schemaVersion, targetVersion: value.target.schemaVersion,
    payloadJsonSha256: jsonSha(value), commonJsonSha256: jsonSha(value.common), targetJsonSha256: jsonSha(value.target), evidenceJsonSha256: jsonSha(value.evidence),
    commonContentSha256: value.common.contentSha256, targetContentSha256: value.target.contentSha256, objectiveIdsSha256: jsonSha(value.target.objectives.map((row: { id: string }) => row.id)),
    anchorsSha256: jsonSha(value.target.objectives.map((row: { anchorRefs: unknown }) => row.anchorRefs)), runtimeObjectivesSha256: jsonSha(objectiveApi.createStudentObjectiveCandidates(context)) };
}
type Case = { id: string; version?: 'v1' | 'v2'; mutate?(state: State): Promise<void> };
const edit = async (s: State, relative: string, change: (value: any) => void) => { const value = await s.json(relative); change(value); await s.write(relative, value); };
const cases: Case[] = [
  { id: 'source-current-valid', mutate: async s => { s.query = 'source'; } },
  { id: 'current-v1-valid', version: 'v1' }, { id: 'current-v2-valid' },
  { id: 'current-target-only-valid', mutate: s => edit(s, analysisPointer, p => { p.path = derivedPath; }) },
  { id: 'staged-derived-does-not-activate', mutate: async s => { s.query = 'staged'; } },
  { id: 'staged-v1-rejected', version: 'v1', mutate: async s => { s.query = 'staged'; s.stagedPath = analysisPath; } },
  { id: 'source-pointer-missing', mutate: async s => { s.query = 'source'; await s.remove(sourcePointer); } },
  { id: 'source-pointer-corrupt-json', mutate: async s => { s.query = 'source'; await s.write(sourcePointer, '{'); } },
  { id: 'source-file-missing', mutate: async s => { s.query = 'source'; await s.remove(sourcePath); } },
  { id: 'source-file-corrupt-json', mutate: async s => { s.query = 'source'; await s.write(sourcePath, '{'); } },
  { id: 'source-content-hash-mismatch', mutate: async s => { s.query = 'source'; await edit(s, sourcePath, p => { p.contentSha256 = 'f'.repeat(64); }); } },
  { id: 'source-page-hash-mismatch', mutate: async s => { s.query = 'source'; await edit(s, sourcePath, p => { p.pages[0].text += 'wrong'; rehash(p); }); const source = await s.json(sourcePath); await edit(s, sourcePointer, p => { p.contentSha256 = source.contentSha256; }); } },
  { id: 'analysis-pointer-missing', mutate: s => s.remove(analysisPointer) },
  { id: 'analysis-pointer-corrupt-json', mutate: s => s.write(analysisPointer, '{') },
  { id: 'analysis-file-missing', mutate: s => s.remove(analysisPath) },
  { id: 'analysis-file-corrupt-json', mutate: s => s.write(analysisPath, '{') },
  { id: 'analysis-source-missing', mutate: s => s.remove(sourcePointer) },
  { id: 'analysis-common-content-hash-mismatch', mutate: s => edit(s, analysisPath, p => { p.common.contentSha256 = 'f'.repeat(64); }) },
  { id: 'analysis-target-content-hash-mismatch', mutate: s => edit(s, analysisPath, p => { p.target.contentSha256 = 'f'.repeat(64); }) },
  { id: 'analysis-pdf-pin-mismatch', mutate: async s => { s.context.student.pdfSha256 = 'f'.repeat(64); } },
  { id: 'analysis-target-pin-mismatch', mutate: async s => { s.context.school.interview.id = 'wrong-target'; } },
  { id: 'analysis-profile-pin-mismatch', mutate: async s => { s.context.target.department = 'wrong-profile'; } },
  { id: 'analysis-revision-pin-mismatch', mutate: s => edit(s, analysisPointer, p => { p.revision = 'wrong-analysis'; }) },
  { id: 'analysis-source-content-pin-mismatch', mutate: s => edit(s, analysisPointer, p => { p.sourceContentSha256 = 'f'.repeat(64); }) },
  { id: 'analysis-common-student-mismatch', mutate: s => edit(s, analysisPath, p => { p.common.studentId = 'wrong-student'; rehash(p.common); }) },
  { id: 'analysis-common-record-pin-rehashed', mutate: s => edit(s, analysisPath, p => { p.common.recordRevision = 'wrong-record'; rehash(p.common); }) },
  { id: 'analysis-common-target-relation-mismatch', mutate: s => edit(s, analysisPath, p => { p.target.commonAnalysisRevision = 'wrong-common'; rehash(p.target); }) },
  { id: 'analysis-evidence-anchor-mismatch', mutate: s => edit(s, analysisPath, p => { p.evidence[0].sourceRef.startOffset++; }) },
  { id: 'staged-qa-missing', mutate: async s => { s.query = 'staged'; await s.remove(path.join(path.dirname(derivedPath), 'analysis-qa.json')); } },
  { id: 'staged-qa-content-hash-mismatch', mutate: async s => { s.query = 'staged'; await edit(s, path.join(path.dirname(derivedPath), 'analysis-qa.json'), p => { p.contentSha256 = 'f'.repeat(64); }); } },
  { id: 'staged-source-revision-mismatch', mutate: async s => { s.query = 'staged'; await edit(s, derivedPath, p => { p.sourceRevision = 'wrong-source'; }); } },
  { id: 'unapproved-staged-activation-rejected', mutate: async s => { s.query = 'activate'; } },
  { id: 'wrong-owner-export-rejected', mutate: async s => { s.query = 'owner'; } },
  { id: 'analysis-pointer-switch-after-first-read', mutate: async s => { s.race = 'analysis'; } },
  { id: 'source-pointer-switch-after-first-read', mutate: async s => { s.race = 'source'; const changed = clone(f.source); changed.revision = 'synthetic-raced-extraction'; rehash(changed); await s.write(sourcePath.replace('source.json', 'raced-source.json'), changed); } },
];
const outcomes = [];
for (const item of cases) {
  const state = await setup(item.version); await item.mutate?.(state); const before = await inventory(state.root);
  let writesAttempted = 0, providerCallsAttempted = 0, racedPointerReads = 0; const fetch = globalThis.fetch;
  nativeFs.readFile = async (...args: unknown[]) => {
    const bytes = await originals.readFile(...args);
    const pointer = state.race === 'analysis' ? analysisPointer : sourcePointer;
    if (state.race && typeof args[0] === 'string' && path.resolve(args[0]) === path.resolve(state.root, pointer)) {
      racedPointerReads++;
      // The virtual pointer changes immediately after its first immutable read.
      // No original/synthetic disk file is changed during the observed operation.
      if (racedPointerReads > 1) { const changed = JSON.parse(bytes.toString()); changed.path = state.race === 'analysis' ? derivedPath : sourcePath.replace('source.json', 'raced-source.json'); if (state.race === 'source') { const source = JSON.parse(await originals.readFile(path.join(state.root, changed.path), 'utf8')); changed.contentSha256 = source.contentSha256; } const raw = JSON.stringify(changed); return typeof bytes === 'string' ? raw : Buffer.from(raw); }
    }
    return bytes;
  };
  for (const key of fsKeys.filter(key => key !== 'readFile')) nativeFs[key] = async (...args: unknown[]) => {
    if (typeof args[0] === 'string' && !path.relative(state.root, path.resolve(args[0])).startsWith('..')) { writesAttempted++; throw new Error('PR06A_READ_PATH_WRITE_BLOCKED'); }
    return originals[key](...args);
  };
  globalThis.fetch = async () => { providerCallsAttempted++; throw new Error('PR06A_PROVIDER_CALL_BLOCKED'); }; syncBuiltinESMExports();
  let result;
  try {
    const value = state.query === 'source' ? await api.loadFullRecord(state.root, state.context.student.pdfSha256)
      : state.query === 'staged' ? await api.loadStagedFullStudentAnalysis(state.context, state.stagedPath, state.root)
      : state.query === 'activate' ? await api.activateStagedFullStudentAnalysis(state.context, state.stagedPath, {}, state.root)
      : state.query === 'owner' ? await questionDomainApi.readVerifiedQuestionDomainExport(state.context, { ownerId: 'wrong-synthetic-owner', root: state.root })
      : await api.loadFullStudentAnalysis(state.context, state.root);
    result = summarize(value);
  } catch (error) { const e = error as Error & { code?: string }; result = { status: 'rejected', name: e.name, code: e.code ?? (/^[A-Z0-9_]+$/u.test(e.message) ? e.message : null), messageSha256: sha(e.message.replaceAll(state.root, '<owned-synthetic-root>')) }; }
  finally { for (const [key, value] of Object.entries(originals)) nativeFs[key] = value; globalThis.fetch = fetch; syncBuiltinESMExports(); }
  const after = await inventory(state.root); assert.deepEqual(after, before, item.id + ': stored file bytes'); assert.equal(writesAttempted, 0, item.id); assert.equal(providerCallsAttempted, 0, item.id);
  outcomes.push({ id: item.id, query: state.query, result, ...(state.race ? { virtualPointerSwitchAfterFirstRead: true, racedPointerReads } : {}), protectedFileCount: before.length, protectedFilesUnchanged: true, fileBytesSha256: jsonSha(before), writesAttempted, providerCallsAttempted });
}
const sourceFiles = ['server/data/full-student-analysis.ts', 'server/contracts/analysis-domain-adapters.ts', 'server/question-objective.ts'];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async relative => [relative, sha(await readFile(path.join(sourceRoot, relative)))])));
const report = { version: 'pr06a-independent-synthetic-read-cases-v1', generatedAt: new Date().toISOString(), sourceRoot, sourceHashes, fixtureSha256: sha(fixtureBytes),
  dependencyReuse: true, freshInstall: false, privateDataUsed: false, observedBeforeCodeNotSharedNewHelper: true, cases: outcomes };
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, fixtureSha256: report.fixtureSha256, count: outcomes.length, outcomes: outcomes.map(row => ({ id: row.id, ...row.result, payloadJsonSha256: undefined })) }, null, 2));
