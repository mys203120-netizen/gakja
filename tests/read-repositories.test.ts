import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analysisDomainFixture } from './fixtures/analysis-domain';
import { analysisQAManifest, loadFullRecord, loadFullStudentAnalysis, loadFullStudentAnalysisSnapshot, loadStagedFullStudentAnalysis } from '../server/data/full-student-analysis';
import { loadInterviewContextAt } from '../server/data/load-interview-context';
import { createLocalReadRepositories } from '../server/repositories/local-read-repositories';
import { emptyReadScope, type AnalysisPayload, type ReadRepositories, type StoredJson } from '../server/repositories/analysis-read-ports';
import { interviewConfig } from '../interview.config';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const stored = <T>(value: T, reference: string): StoredJson<T> => { const bytes = Buffer.from(JSON.stringify(value, null, 2)); return { path: reference, bytes, sha256: sha(bytes), value: structuredClone(value) }; };
function memory(version: 'v1' | 'v2' = 'v2') {
  const f = analysisDomainFixture(), reference = 'data/prepared/student-analysis-revisions/explicit-synthetic/analysis.json';
  f.context.errors = []; f.context.student.studentId = f.source.studentId; f.context.student.recordRevision = f.source.recordRevision;
  const payload: AnalysisPayload = { ...f[version], sourceRevision: f.source.revision, sourceContentSha256: f.source.contentSha256 };
  const source = stored(f.source, 'data/prepared/record-revisions/explicit-synthetic/source.json');
  const sourcePointer = stored({ path: source.path, pdfSha256: f.source.pdfSha256, contentSha256: f.source.contentSha256 }, 'data/prepared/full-record-current.json');
  const document = stored(payload, reference), pointer = stored({ path: reference, revision: payload.common.revision, sourceContentSha256: f.source.contentSha256 }, 'data/prepared/student-analysis-current.json');
  const counts = { source: 0, pointer: 0, analysis: 0, qa: 0, configured: 0 };
  const selections: string[] = [];
  const repositories: ReadRepositories = { ownerId: 'explicit-synthetic-owner', source: {
    async readConfiguredInputs() { counts.configured++; return { inputs: Object.entries(interviewConfig.files).filter(([role]) => role !== 'sourceManifest').map(([role, path]) => ({ role, path, bytes: null, sha256: null })), missing: Object.entries(interviewConfig.files).filter(([role]) => role !== 'sourceManifest').map(([role, path]) => ({ role, path })) }; },
    async readPinnedInput() { throw new Error('UNEXPECTED_PINNED_FILE_READ'); },
    async readCurrentRecord() { counts.source++; return { pointer: sourcePointer, document: source }; },
  }, analysis: {
    async readCurrentPointer() { counts.pointer++; return pointer; },
    async readAnalysis(request) { counts.analysis++; selections.push(request.selection); assert.equal(request.reference, reference); return document; },
    async readQaManifest(request) { counts.qa++; assert.equal(request.analysisReference, reference); return stored(analysisQAManifest(payload, f.source, null), 'data/prepared/student-analysis-revisions/explicit-synthetic/analysis-qa.json'); },
    async readReviewFile() { throw new Error('UNEXPECTED_REVIEW_FILE_READ'); },
    async currentPointerUnchanged() { return true; }, async analysisDocumentUnchanged() { return true; },
  } };
  return { f, reference, payload, source, sourcePointer, pointer, document, repositories, counts, selections };
}

test('actual source loader consumes injected repository and retains source/hash/UTF16 gates', async () => {
  const h = memory();
  assert.deepEqual(await loadFullRecord('UNUSED_ROOT_MUST_NOT_BE_READ', h.f.source.pdfSha256, { repositories: h.repositories }), h.f.source);
  assert.deepEqual(h.counts, { source: 1, pointer: 0, analysis: 0, qa: 0, configured: 0 });
  const original = h.source.value; h.source.value = structuredClone(original); h.source.value.pages[0].text += 'bad';
  const { contentSha256: ignored, ...body } = h.source.value; void ignored; h.source.value.contentSha256 = sha(JSON.stringify(body)); h.sourcePointer.value.contentSha256 = h.source.value.contentSha256;
  await assert.rejects(loadFullRecord('UNUSED_ROOT_MUST_NOT_BE_READ', undefined, { repositories: h.repositories }), /FULL_RECORD_PAGE_IDENTITY_INVALID/);
});

for (const version of ['v1', 'v2'] as const) test(`actual ${version} analysis loader consumes injected ports and preserves exact payload order`, async () => {
  const h = memory(version), original = JSON.stringify(h.f[version]);
  const snapshot = await loadFullStudentAnalysisSnapshot(h.f.context, 'UNUSED_ROOT_MUST_NOT_BE_READ', { repositories: h.repositories });
  assert.ok(snapshot); assert.equal(JSON.stringify(snapshot.analysis), original);
  assert.equal(snapshot.document.sha256, sha(h.document.bytes)); assert.equal(snapshot.document.bytes.toString(), JSON.stringify(h.payload, null, 2));
  assert.equal(h.counts.pointer, 1); assert.equal(h.counts.source, 1); assert.equal(h.counts.analysis, 1); assert.deepEqual(h.selections, ['current']);
});

test('staged read uses explicit reference/QA port and never selects or activates current', async () => {
  const h = memory(), currentBytes = Buffer.from(h.pointer.bytes);
  const value = await loadStagedFullStudentAnalysis(h.f.context, h.reference, 'UNUSED_ROOT_MUST_NOT_BE_READ', { repositories: h.repositories, purpose: 'historical-revision' });
  assert.equal(JSON.stringify(value.common), JSON.stringify(h.f.v2.common)); assert.equal(JSON.stringify(value.target), JSON.stringify(h.f.v2.target));
  assert.deepEqual(h.pointer.bytes, currentBytes); assert.equal(h.counts.pointer, 0); assert.equal(h.counts.qa, 1); assert.deepEqual(h.selections, ['staged']);
});

test('wrong owner fails before any injected source/context/analysis read', async () => {
  const h = memory(), options = { repositories: h.repositories, scope: { ownerId: 'wrong-owner' } };
  await assert.rejects(loadFullRecord('UNUSED_ROOT', undefined, options), /READ_REPOSITORY_OWNER_MISMATCH/);
  await assert.rejects(loadFullStudentAnalysis(h.f.context, 'UNUSED_ROOT', options), /READ_REPOSITORY_OWNER_MISMATCH/);
  await assert.rejects(loadInterviewContextAt('UNUSED_ROOT', { ...options, writeManifest: false }), /READ_REPOSITORY_OWNER_MISMATCH/);
  assert.equal(Object.values(h.counts).reduce((sum, n) => sum + n, 0), 0);
});

test('explicit student/PDF/record/source revision/hash pins are enforced above adapter reads', async () => {
  for (const pin of ['studentId', 'pdfSha256', 'recordRevision', 'sourceRevision', 'sourceContentSha256'] as const) {
    const h = memory();
    await assert.rejects(loadFullRecord('UNUSED_ROOT', undefined, { repositories: h.repositories, scope: { [pin]: 'wrong-pin' } }), /FULL_RECORD_READ_SCOPE_MISMATCH/, pin);
  }
});

test('analysis target/common/target revision/profile pins remain distinct', async () => {
  for (const pin of ['supportTargetId', 'commonRevision', 'targetRevision', 'profileRevision'] as const) {
    const h = memory();
    await assert.rejects(loadFullStudentAnalysis(h.f.context, 'UNUSED_ROOT', { repositories: h.repositories, scope: { [pin]: 'wrong-pin' } }), /FULL_ANALYSIS_READ_SCOPE_MISMATCH/, pin);
  }
});

test('injected adapters cannot bypass legacy document hash and source-record consistency gates', async () => {
  const h = memory(); h.document.value.target.contentSha256 = 'f'.repeat(64);
  await assert.rejects(loadFullStudentAnalysis(h.f.context, 'UNUSED_ROOT', { repositories: h.repositories }), /ANALYSIS_CONTRACT_CONTENT_HASH_CHANGED/);
  const changed = memory(); changed.document.value.common.recordRevision = 'wrong-record';
  const { contentSha256: ignored, ...body } = changed.document.value.common; void ignored; changed.document.value.common.contentSha256 = sha(JSON.stringify(body));
  await assert.rejects(loadFullStudentAnalysis(changed.f.context, 'UNUSED_ROOT', { repositories: changed.repositories }), /FULL_ANALYSIS_STUDENT_OR_REVISION_MISMATCH|FULL_ANALYSIS_READ_SCOPE_MISMATCH/);
});

test('missing pointer remains null while missing required source cannot become empty valid analysis', async () => {
  const h = memory(); h.repositories.analysis.readCurrentPointer = async () => null;
  assert.equal(await loadFullStudentAnalysis(h.f.context, 'UNUSED_ROOT', { repositories: h.repositories }), null);
  const missing = memory(); missing.repositories.source.readCurrentRecord = async () => null;
  await assert.rejects(loadFullStudentAnalysis(missing.f.context, 'UNUSED_ROOT', { repositories: missing.repositories }), /ANALYSIS_FULL_SOURCE_MISSING/);
});

test('context uses configured-input port and preserves explicit missing-input failure instead of fabricated facts', async t => {
  const h = memory(), root = await mkdtemp(path.join(os.tmpdir(), 'pr06a-missing-context-'));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('pr06a-missing-context-')); await rm(root, { recursive: true, force: true }); });
  h.repositories.analysis.readCurrentPointer = async () => null;
  const context = await loadInterviewContextAt(root, { repositories: h.repositories, writeManifest: false });
  assert.equal(h.counts.configured, 1); assert.ok(context.errors.length > 0); assert.deepEqual(context.student.evidence, []); assert.equal(context.studentAnalysis, undefined);
  await assert.rejects(readFile(path.join(root, interviewConfig.files.sourceManifest)), { code: 'ENOENT' });
});

function syntheticPdf(text: string) {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let raw = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(raw)); raw += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(raw); raw += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(raw);
}

test('explicit context pins cannot fall through to clean legacy data when current analysis is missing', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pr06a-synthetic-legacy-'));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('pr06a-synthetic-legacy-')); await rm(root, { recursive: true, force: true }); });
  const text = 'Synthetic source probe.', pdf = syntheticPdf(text), pdfSha256 = sha(pdf);
  const cache = { studentName: interviewConfig.target.studentName, studentId: 'explicit-synthetic-legacy-student', schemaVersion: 'verified-pdf-excerpts-v2',
    sourceFile: interviewConfig.files.studentPdf, pdfSha256, pageCount: 1, extractionStatus: 'explicit-synthetic-fixture', limitations: [],
    evidence: [{ id: 'explicit-synthetic-evidence', activityId: 'explicit-synthetic-activity', page: 1, grade: 2, section: 'synthetic', title: 'Synthetic record', text,
      sourceRef: { file: interviewConfig.files.studentPdf, pdfSha256, page: 1, startOffset: 0, endOffset: text.length, extraction: 'pdfjs' },
      confirmationStatus: 'confirmed_from_record', preparationPriority: null, scientificTruthVerification: 'not_independently_verified' }] };
  // School/MD inputs are public repository sources. The private PDF/cache roles
  // are replaced in memory and never read from the workspace.
  const inputs = await Promise.all(Object.entries(interviewConfig.files).filter(([role]) => role !== 'sourceManifest').map(async ([role, reference]) => {
    const bytes = role === 'studentPdf' ? pdf : role === 'preparedStudent' ? Buffer.from(JSON.stringify(cache)) : await readFile(path.resolve(reference));
    return { role, path: reference, bytes, sha256: sha(bytes) };
  }));
  const make = () => { const h = memory(); h.repositories.source.readConfiguredInputs = async () => ({ inputs, missing: [] }); h.repositories.analysis.readCurrentPointer = async () => null; h.repositories.source.readCurrentRecord = async () => null; return h; };
  const normal = make(), loaded = await loadInterviewContextAt(root, { repositories: normal.repositories, writeManifest: false });
  assert.deepEqual(loaded.errors, [], 'synthetic legacy baseline must be genuinely valid'); assert.equal(loaded.student.evidence.length, 1); assert.equal(loaded.studentAnalysis, undefined);
  for (const scope of [{ supportTargetId: 'wrong-target' }, { pdfSha256: 'f'.repeat(64) }, { commonRevision: 'unavailable-common' }, { sourceRevision: 'unavailable-source' }]) {
    const h = make();
    const outcome = await loadInterviewContextAt(root, { repositories: h.repositories, writeManifest: false, scope }).then(context => ({ context, rejected: false }), () => ({ context: null, rejected: true }));
    assert.ok(outcome.rejected || outcome.context!.errors.length > 0, 'explicit pin must not return clean legacy context: ' + Object.keys(scope)[0]);
  }
  await assert.rejects(readFile(path.join(root, interviewConfig.files.sourceManifest)), { code: 'ENOENT' });
});

test('local operation caches exact captured bytes but freshness compares current pointer/document without reselection', async t => {
  const h = memory(), root = await mkdtemp(path.join(os.tmpdir(), 'pr06a-local-read-'));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('pr06a-local-read-')); await rm(root, { recursive: true, force: true }); });
  for (const row of [h.pointer, h.document]) { const file = path.join(root, row.path); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, row.bytes); }
  const repository = createLocalReadRepositories(root), request = { scope: emptyReadScope(repository.ownerId), purpose: 'runtime-context' as const };
  const pointer = await repository.analysis.readCurrentPointer(request); assert.ok(pointer);
  const document = await repository.analysis.readAnalysis({ ...request, reference: pointer.value.path, selection: 'current' });
  pointer.bytes[0] = 0; const again = await repository.analysis.readCurrentPointer(request); assert.ok(again); assert.notEqual(again.bytes[0], 0);
  await writeFile(path.join(root, h.pointer.path), Buffer.concat([h.pointer.bytes, Buffer.from('\n')]));
  await writeFile(path.join(root, h.document.path), Buffer.concat([h.document.bytes, Buffer.from('\n')]));
  assert.equal(await repository.analysis.currentPointerUnchanged({ ...request, captured: again }), false);
  assert.equal(await repository.analysis.analysisDocumentUnchanged({ ...request, captured: document }), false);
  const cached = await repository.analysis.readCurrentPointer(request); assert.ok(cached); assert.deepEqual(cached.bytes, h.pointer.bytes);
  const fresh = await createLocalReadRepositories(root).analysis.readCurrentPointer(request); assert.ok(fresh); assert.notDeepEqual(fresh.bytes, h.pointer.bytes);
  await assert.rejects(repository.analysis.readAnalysis({ ...request, reference: '../escape/analysis.json', selection: 'revision' }), /ANALYSIS_PATH_INVALID/);
  await assert.rejects(repository.analysis.readCurrentPointer({ ...request, scope: { ...request.scope, ownerId: 'wrong-owner' } }), /READ_REPOSITORY_OWNER_MISMATCH/);
});
