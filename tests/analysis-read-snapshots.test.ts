import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { analysisDomainFixture } from './fixtures/analysis-domain';
import { analysisQAManifest, loadFullRecordSnapshot, loadFullStudentAnalysis, loadFullStudentAnalysisSnapshot,
  loadStagedFullStudentAnalysisSnapshot, validateFullRecord } from '../server/data/full-student-analysis';
import { emptyReadScope, type AnalysisPayload, type ReadRepositories, type StoredJson } from '../server/repositories/analysis-read-ports';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function stored<T>(path: string, value: T): StoredJson<T> {
  const bytes = Buffer.from(JSON.stringify(value, null, 2));
  return { path, value, bytes, sha256: sha(bytes) };
}
function fixture(version: 'v1' | 'v2' = 'v2') {
  const value = analysisDomainFixture(), analysis = value[version];
  const payload: AnalysisPayload = { ...analysis, sourceRevision: value.source.revision, sourceContentSha256: value.source.contentSha256 };
  const document = stored('data/prepared/student-analysis-revisions/synthetic/analysis.json', payload);
  const pointer = stored('data/prepared/student-analysis-current.json', { path: document.path, revision: analysis.common.revision, sourceContentSha256: value.source.contentSha256 });
  const sourceDocument = stored('data/prepared/record-revisions/synthetic/source.json', value.source);
  const sourcePointer = stored('data/prepared/full-record-current.json', { path: sourceDocument.path, pdfSha256: value.source.pdfSha256, contentSha256: value.source.contentSha256 });
  const calls: string[] = [];
  const repositories: ReadRepositories = { ownerId: 'synthetic-read-owner', source: {
    async readConfiguredInputs() { throw new Error('UNEXPECTED_CONFIGURED_READ'); },
    async readPinnedInput() { throw new Error('UNEXPECTED_PINNED_READ'); },
    async readCurrentRecord() { calls.push('source'); return { pointer: sourcePointer, document: sourceDocument }; },
  }, analysis: {
    async readCurrentPointer() { calls.push('pointer'); return pointer; },
    async readAnalysis(request) { calls.push(request.selection); return document; },
    async readQaManifest() { calls.push('qa'); return stored('data/prepared/student-analysis-revisions/synthetic/analysis-qa.json', analysisQAManifest(payload, value.source, null)); },
    async readReviewFile() { throw new Error('UNEXPECTED_REVIEW_READ'); },
    async currentPointerUnchanged() { throw new Error('DOMAIN_MUST_NOT_RESELECT_POINTER'); },
    async analysisDocumentUnchanged() { throw new Error('DOMAIN_MUST_NOT_REREAD_DOCUMENT'); },
  } };
  return { ...value, analysis, document, pointer, sourceDocument, sourcePointer, repositories, calls };
}

test('current snapshots retain the first pointer and exact artifact bytes while legacy wrappers retain their shape', async () => {
  const value = fixture(), snapshot = await loadFullStudentAnalysisSnapshot(value.context, '.', { repositories: value.repositories });
  assert.ok(snapshot);
  assert.deepEqual(value.calls, ['pointer', 'source', 'current']);
  assert.deepEqual(snapshot.analysis, value.v2);
  assert.equal(snapshot.pointer, value.pointer);
  assert.equal(snapshot.document, value.document);
  assert.equal(snapshot.source, value.source);
  assert.equal(snapshot.document.sha256, sha(snapshot.document.bytes));
  assert.deepEqual(await loadFullStudentAnalysis(value.context, '.', { repositories: value.repositories }), value.v2);
  assert.deepEqual(Object.keys(snapshot.analysis), ['common', 'target', 'evidence']);
});

test('staged snapshots are explicit v2 preparation reads and do not consult or activate current pointers', async () => {
  const value = fixture();
  const snapshot = await loadStagedFullStudentAnalysisSnapshot(value.context, value.document.path, '.', { repositories: value.repositories, purpose: 'staged-context' });
  assert.deepEqual(value.calls, ['source', 'staged', 'qa']);
  assert.deepEqual(snapshot.analysis.common, value.v2.common);
  assert.deepEqual(snapshot.analysis.target, value.v2.target);
  assert.equal(snapshot.analysis.revisionPath, value.document.path);
  assert.equal(snapshot.analysis.manifestPath, snapshot.qaDocument.path);
  assert.equal(snapshot.analysis.manifest.independentlyReviewedSemantics, false);
  assert.equal(snapshot.document.sha256, sha(snapshot.document.bytes));
  assert.equal(snapshot.qaDocument.sha256, sha(snapshot.qaDocument.bytes));
  const historical = fixture('v1');
  assert.deepEqual((await loadFullStudentAnalysisSnapshot(historical.context, '.', { repositories: historical.repositories }))?.analysis, historical.v1);
  await assert.rejects(loadStagedFullStudentAnalysisSnapshot(historical.context, historical.document.path, '.', { repositories: historical.repositories }), /FULL_ANALYSIS_STALE/u);
});

test('explicit owner, source, record, common, target and profile pins fail closed without reinterpreting target authoring revision', async () => {
  for (const pin of ['studentId', 'supportTargetId', 'pdfSha256', 'recordRevision', 'sourceRevision', 'sourceContentSha256', 'commonRevision', 'targetRevision', 'profileRevision'] as const) {
    const value = fixture();
    await assert.rejects(loadFullStudentAnalysisSnapshot(value.context, '.', { repositories: value.repositories, scope: { [pin]: 'wrong-explicit-pin' } }), /FULL_(?:RECORD|ANALYSIS)_READ_SCOPE_MISMATCH/u, pin);
  }
  const value = fixture();
  await assert.rejects(loadFullStudentAnalysisSnapshot(value.context, '.', { repositories: value.repositories, scope: { ownerId: 'another-owner' } }), /READ_REPOSITORY_OWNER_MISMATCH/u);
  assert.deepEqual(value.calls, []);
  const scope = { ...emptyReadScope(value.repositories.ownerId), studentId: value.source.studentId, pdfSha256: value.source.pdfSha256,
    recordRevision: value.source.recordRevision, sourceRevision: value.source.revision, sourceContentSha256: value.source.contentSha256,
    commonRevision: value.v2.common.revision, targetRevision: value.v2.target.revision, supportTargetId: value.v2.target.supportTargetId, profileRevision: value.v2.target.profileRevision };
  assert.ok(await loadFullStudentAnalysisSnapshot(value.context, '.', { repositories: value.repositories, scope }));
});

test('missing pointers and read failures preserve null versus thrown-error behavior', async () => {
  const value = fixture();
  value.repositories.analysis.readCurrentPointer = async () => null;
  assert.equal(await loadFullStudentAnalysisSnapshot(value.context, '.', { repositories: value.repositories }), null);
  assert.deepEqual(value.calls, []);
  value.repositories.source.readCurrentRecord = async () => null;
  assert.equal(await loadFullRecordSnapshot('.', undefined, { repositories: value.repositories }), null);
  value.repositories.analysis.readCurrentPointer = async () => value.pointer;
  await assert.rejects(loadFullStudentAnalysisSnapshot(value.context, '.', { repositories: value.repositories }), /ANALYSIS_FULL_SOURCE_MISSING/u);
  const failure = new SyntaxError('synthetic malformed stored JSON');
  value.repositories.source.readCurrentRecord = async () => { throw failure; };
  await assert.rejects(loadFullRecordSnapshot('.', undefined, { repositories: value.repositories }), error => error === failure);
});

test('outer unknown pins cannot erase known context identities from repository requests', async () => {
  const value = fixture(), scope = emptyReadScope(value.repositories.ownerId);
  const context = structuredClone(value.context);
  context.student.studentId = value.source.studentId;
  const readPointer = value.repositories.analysis.readCurrentPointer;
  let receivedScope: typeof scope | undefined;
  value.repositories.analysis.readCurrentPointer = async request => { receivedScope = request.scope; return readPointer(request); };
  assert.ok(await loadFullStudentAnalysisSnapshot(context, '.', { repositories: value.repositories, scope }));
  assert.equal(receivedScope?.studentId, value.source.studentId);
  assert.equal(receivedScope?.pdfSha256, context.student.pdfSha256);
  assert.equal(receivedScope?.supportTargetId, value.v2.target.supportTargetId);
  assert.equal(receivedScope?.profileRevision, value.v2.target.profileRevision);
  const anotherStudent = structuredClone(context); anotherStudent.student.studentId = 'another-known-context-student';
  await assert.rejects(loadFullStudentAnalysisSnapshot(anotherStudent, '.', { repositories: value.repositories, scope }), /FULL_RECORD_READ_SCOPE_MISMATCH/u);
});

test('dependent analysis and QA requests carry the captured source pins and the correct discovered analysis revision', async () => {
  const value = fixture(), queries: Array<{ selection: string; scope: ReturnType<typeof emptyReadScope> }> = [];
  const readAnalysis = value.repositories.analysis.readAnalysis, readQa = value.repositories.analysis.readQaManifest;
  value.repositories.analysis.readAnalysis = async request => { queries.push({ selection: request.selection, scope: request.scope }); return readAnalysis(request); };
  value.repositories.analysis.readQaManifest = async request => { queries.push({ selection: 'qa', scope: request.scope }); return readQa(request); };
  await loadFullStudentAnalysisSnapshot(value.context, '.', { repositories: value.repositories, scope: emptyReadScope(value.repositories.ownerId) });
  await loadStagedFullStudentAnalysisSnapshot(value.context, value.document.path, '.', { repositories: value.repositories, scope: emptyReadScope(value.repositories.ownerId) });
  assert.deepEqual(queries.map(query => query.selection), ['current', 'staged', 'qa']);
  for (const query of queries) {
    assert.equal(query.scope.studentId, value.source.studentId);
    assert.equal(query.scope.pdfSha256, value.source.pdfSha256);
    assert.equal(query.scope.recordRevision, value.source.recordRevision);
    assert.equal(query.scope.sourceRevision, value.source.revision);
    assert.equal(query.scope.sourceContentSha256, value.source.contentSha256);
  }
  assert.equal(queries[0].scope.commonRevision, value.pointer.value.revision);
  assert.equal(queries[0].scope.targetRevision, null);
  assert.equal(queries[1].scope.commonRevision, null, 'staged read does not inherit an active common pin');
  assert.equal(queries[1].scope.targetRevision, null);
  assert.equal(queries[2].scope.commonRevision, value.v2.common.revision);
  assert.equal(queries[2].scope.targetRevision, value.v2.target.revision);
});

test('standalone source requests carry a known PDF argument without erasing explicit pins or changing empty-string compatibility', async () => {
  const value = fixture(), scopes: Array<ReturnType<typeof emptyReadScope>> = [];
  const readSource = value.repositories.source.readCurrentRecord;
  value.repositories.source.readCurrentRecord = async request => { scopes.push(request.scope); return readSource(request); };
  assert.ok(await loadFullRecordSnapshot('.', value.source.pdfSha256, { repositories: value.repositories }));
  assert.equal(scopes[0].pdfSha256, value.source.pdfSha256);
  assert.ok(await loadFullRecordSnapshot('.', '', { repositories: value.repositories }));
  assert.equal(scopes[1].pdfSha256, null);
  await assert.rejects(loadFullRecordSnapshot('.', value.source.pdfSha256, { repositories: value.repositories, scope: { pdfSha256: 'explicit-wrong-pdf-pin' } }), /FULL_RECORD_READ_SCOPE_MISMATCH/u);
  assert.equal(scopes[2].pdfSha256, 'explicit-wrong-pdf-pin');
});

test('missing current analysis cannot bypass explicit context or revision pins through legacy fallback', async () => {
  for (const key of ['studentId', 'pdfSha256', 'recordRevision', 'supportTargetId', 'profileRevision'] as const) {
    const value = fixture(), context = structuredClone(value.context);
    context.student.studentId = value.source.studentId; context.student.recordRevision = value.source.recordRevision;
    value.repositories.analysis.readCurrentPointer = async () => { value.calls.push('missing-pointer'); return null; };
    await assert.rejects(loadFullStudentAnalysisSnapshot(context, '.', { repositories: value.repositories, scope: { [key]: 'wrong-explicit-context-pin' } }), /FULL_(?:RECORD|ANALYSIS)_READ_SCOPE_MISMATCH/u, key);
    assert.deepEqual(value.calls, [], 'known scope mismatch is rejected before pointer discovery');
  }
  for (const key of ['commonRevision', 'targetRevision'] as const) {
    const value = fixture(); value.repositories.analysis.readCurrentPointer = async () => null;
    await assert.rejects(loadFullStudentAnalysisSnapshot(value.context, '.', { repositories: value.repositories, scope: { [key]: 'requested-analysis-revision' } }), /FULL_ANALYSIS_READ_SCOPE_MISMATCH/u);
    assert.deepEqual(value.calls, []);
  }
  const value = fixture(); value.repositories.analysis.readCurrentPointer = async () => null;
  await assert.rejects(loadFullStudentAnalysisSnapshot(value.context, '.', { repositories: value.repositories, scope: { sourceRevision: 'wrong-source-revision' } }), /FULL_RECORD_READ_SCOPE_MISMATCH/u);
  assert.deepEqual(value.calls, ['source']);
  value.calls.length = 0;
  assert.equal(await loadFullStudentAnalysisSnapshot(value.context, '.', { repositories: value.repositories, scope: { sourceRevision: value.source.revision } }), null);
  assert.deepEqual(value.calls, ['source']);
  value.repositories.source.readCurrentRecord = async () => null;
  await assert.rejects(loadFullStudentAnalysisSnapshot(value.context, '.', { repositories: value.repositories, scope: { sourceRevision: value.source.revision } }), /ANALYSIS_FULL_SOURCE_MISSING/u);
  assert.equal(await loadFullStudentAnalysisSnapshot(value.context, '.', { repositories: value.repositories }), null, 'unrequested legacy lookup remains null');
});

test('pure source validation retains range gates and a rehashed wrong record revision is now rejected', async () => {
  const value = fixture();
  assert.equal(validateFullRecord(value.source, value.sourcePointer.value), value.source);
  const changed = structuredClone(value.source); changed.blocks[0].startOffset++;
  const { contentSha256: ignoredSource, ...sourceBody } = changed; void ignoredSource;
  changed.contentSha256 = sha(JSON.stringify(sourceBody));
  assert.throws(() => validateFullRecord(changed, { ...value.sourcePointer.value, contentSha256: changed.contentSha256 }), /FULL_RECORD_SOURCE_RANGE_INVALID/u);
  value.document.value.common.recordRevision = 'wrong-record';
  const { contentSha256: ignoredCommon, ...commonBody } = value.document.value.common; void ignoredCommon;
  value.document.value.common.contentSha256 = sha(JSON.stringify(commonBody));
  await assert.rejects(loadFullStudentAnalysisSnapshot(value.context, '.', { repositories: value.repositories }), /FULL_ANALYSIS_STUDENT_OR_REVISION_MISMATCH/u);
  await assert.rejects(loadStagedFullStudentAnalysisSnapshot(value.context, value.document.path, '.', { repositories: value.repositories }), /FULL_ANALYSIS_STUDENT_OR_REVISION_MISMATCH/u);
});
