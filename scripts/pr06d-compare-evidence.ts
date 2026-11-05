/** Strict comparison of independently executed D source trees. Domain bytes,
 * signature preimages, arrays and I/O order are never normalized. */
import assert from 'node:assert/strict';
import { createHash, verify } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directory = path.resolve(process.argv[2] ?? 'artifacts/pr06d');
const read = async (file: string) => JSON.parse(await readFile(path.join(directory, file), 'utf8'));
const [before, after, jobsBefore, jobsRepeat, jobsAfter, reviewBefore, reviewAfter, naturalOne, naturalTwo, integrationBefore, integrationRepeat, integrationAfter, source] = await Promise.all([
  read('before-private.json'), read('after-private.json'), read('job-before-cases.json'), read('job-before-repeat-cases.json'), read('job-after-cases.json'),
  read('before-review.json'), read('after-review.json'), read('integration-before-natural-1.json'), read('integration-before-natural-2.json'),
  read('integration-before-cases.json'), read('integration-before-repeat-cases.json'), read('integration-after-cases.json'), read('source-capture-before.log'),
]);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const jsonSha = (value: unknown) => sha(JSON.stringify(value) ?? '<undefined>');
const checks: Array<{ id: string; passed: boolean }> = [];
const same = (id: string, left: unknown, right: unknown) => checks.push({ id, passed: JSON.stringify(left) === JSON.stringify(right) });
type Case = { id: string; [key: string]: unknown };
function compareCases(label: string, old: Case[], current: Case[]) {
  assert.equal(new Set(old.map(row => row.id)).size, old.length); assert.equal(new Set(current.map(row => row.id)).size, current.length);
  same(label + ':case-order-and-identities', old.map(row => row.id), current.map(row => row.id));
  for (let index = 0; index < old.length; index++) same(label + ':' + old[index].id + ':entire-case', old[index], current[index]);
}
// Verify every retained synthetic physical file, including files recorded at
// failure boundaries. This recurses through observations without changing order.
function verifyPhysicalFiles(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.reduce((count, row) => count + verifyPhysicalFiles(row), 0);
  const row = value as Record<string, unknown>, text = typeof row.text === 'string' ? row.text : typeof row.utf8 === 'string' ? row.utf8 : null;
  let count = 0;
  if (text !== null && typeof row.bytes === 'number' && typeof row.sha256 === 'string') { assert.equal(Buffer.byteLength(text), row.bytes); assert.equal(sha(text), row.sha256); count++; }
  for (const child of Object.values(row)) count += verifyPhysicalFiles(child); return count;
}
assert.notEqual(path.resolve(before.sourceRoot), path.resolve(after.sourceRoot));
same('private:same-exact-reader-fixture', before.fixtureSha256, after.fixtureSha256);
same('private:actual-job-registry-revision-history-session-context-log-read-outcomes', before.observations, after.observations);
same('private:actual-category-order-and-set', before.protectedGroups.map((row: { category: string }) => row.category), after.protectedGroups.map((row: { category: string }) => row.category));
for (let index = 0; index < before.protectedGroups.length; index++) same('private:' + before.protectedGroups[index].category + ':all-file-identities-and-physical-bytes', before.protectedGroups[index], after.protectedGroups[index]);
for (const report of [before, after]) { assert.equal(report.privateWriteAttempts, 0); assert.equal(report.networkAttempts, 0); assert.equal(report.originalFilesUnchanged, true); assert.equal(report.sourceModulesUnchanged, true); }
same('review:same-fixed-input-script-and-clock', [reviewBefore.fixtureSha256, reviewBefore.scriptSha256, reviewBefore.controlledClock], [reviewAfter.fixtureSha256, reviewAfter.scriptSha256, reviewAfter.controlledClock]);
for (const report of [reviewBefore, reviewAfter]) assert.equal(report.actualProviderCalls, 0);
compareCases('review:before-after', reviewBefore.cases, reviewAfter.cases);
same('job:same-controlled-fixture-clock-and-UUID-policy', [jobsBefore.fixtureSha256, jobsBefore.controlledClock, jobsBefore.controlledUuid], [jobsAfter.fixtureSha256, jobsAfter.controlledClock, jobsAfter.controlledUuid]);
same('job:before-repeat-same-controlled-fixture', jobsBefore.fixtureSha256, jobsRepeat.fixtureSha256);
type PidEvidence = { caseId: string; path: string; rawJson: string; rawBytes: number; rawSha256: string; projectedSha256: string };
for (const report of [jobsBefore, jobsRepeat, jobsAfter]) {
  assert.equal(report.privateDataUsed, false); assert.equal(report.realProviderCalls, 0); assert.ok(Number.isInteger(report.nativePid) && report.nativePid > 0);
  for (const row of report.nativePidEvidence as PidEvidence[]) {
    assert.ok(row.path.endsWith('.lock.json')); assert.equal(Buffer.byteLength(row.rawJson), row.rawBytes); assert.equal(sha(row.rawJson), row.rawSha256);
    const raw = JSON.parse(row.rawJson); assert.equal(JSON.stringify(raw), row.rawJson); assert.equal(raw.pid, report.nativePid);
    const projected = JSON.stringify({ ...raw, pid: '<native-process-pid>' }); assert.equal(sha(projected), row.projectedSha256);
  }
  for (const row of report.cases as Array<{ files: Array<{ path: string; pidProjection: boolean }>; events: Array<{ path: string; pidProjection?: boolean }> }>) {
    for (const file of [...row.files, ...row.events]) if (file.pidProjection) assert.ok(file.path.endsWith('.lock.json'));
  }
}
assert.notEqual(jobsBefore.nativePid, jobsRepeat.nativePid);
checks.push({ id: 'job:actual-BEFORE-repeat-proves-native-PID-only-lock-nondeterminism', passed: jobsBefore.nativePidEvidence[0].rawSha256 !== jobsRepeat.nativePidEvidence[0].rawSha256 });
const pidProjectionEvidence = (report: typeof jobsBefore) => (report.nativePidEvidence as PidEvidence[]).map(({ caseId, path, projectedSha256 }) => ({ caseId, path, projectedSha256 }));
same('job:before-repeat-all-raw-lock-relations', pidProjectionEvidence(jobsBefore), pidProjectionEvidence(jobsRepeat));
same('job:before-after-all-raw-lock-relations', pidProjectionEvidence(jobsBefore), pidProjectionEvidence(jobsAfter));
compareCases('job:before-repeat', jobsBefore.cases, jobsRepeat.cases); compareCases('job:before-after', jobsBefore.cases, jobsAfter.cases);
for (const report of [naturalOne, naturalTwo, integrationBefore, integrationRepeat, integrationAfter]) {
  assert.equal(report.privateDataUsed, false); assert.equal(report.realProviderCalls, 0); assert.equal(report.modelBoundaryOnlySynthetic, true);
  assert.equal(report.fixtureSha256, integrationBefore.fixtureSha256); assert.equal(report.controlledPublicSigningKey, integrationBefore.controlledPublicSigningKey);
  for (const row of report.cases) if (row.observations.contractBytes) { const bytes = row.observations.contractBytes; assert.equal(sha(bytes.receiptSignaturePreimage), bytes.receiptSignaturePreimageUtf8Sha256); assert.equal(verify(null, Buffer.from(bytes.receiptSignaturePreimage), report.controlledPublicSigningKey, Buffer.from(bytes.signatureBase64, 'base64')), true); }
}
const n1 = naturalOne.cases[0].observations.data, n2 = naturalTwo.cases[0].observations.data;
for (const item of [n1, n2]) for (const key of ['sessionId', 'turnId', 'answerId']) assert.match(item[key], /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu);
checks.push({ id: 'integration:actual-natural-BEFORE-repeat-proves-UUID-and-clock-nondeterminism', passed: n1.sessionId !== n2.sessionId && n1.turnId !== n2.turnId && n1.answerId !== n2.answerId && n1.createdAt !== n2.createdAt && Number.isFinite(Date.parse(n1.createdAt)) && Number.isFinite(Date.parse(n2.createdAt)) });
same('integration:same-controlled-clock-and-UUID', [integrationBefore.controlledClock, integrationBefore.controlledUUID], [integrationAfter.controlledClock, integrationAfter.controlledUUID]);
compareCases('integration:before-repeat', integrationBefore.cases, integrationRepeat.cases); compareCases('integration:before-after', integrationBefore.cases, integrationAfter.cases);
const physicalByteAssertions = [reviewBefore, reviewAfter, naturalOne, naturalTwo, integrationBefore, integrationRepeat, integrationAfter].reduce((sum, report) => sum + verifyPhysicalFiles(report.cases), 0);
const result = { version: 'pr06d-independent-before-after-comparison-v1', generatedAt: new Date().toISOString(), status: checks.every(row => row.passed) ? 'passed' : 'failed',
  beforeSource: { head: source.head, treeSha256: source.sourceTreeSha256, files: source.files, sourceModuleHashes: before.sourceModuleHashes }, afterSource: { sourceModuleHashes: after.sourceModuleHashes }, dependencyReuse: true, freshInstallClaimed: false,
  execution: { jobCases: jobsBefore.cases.length, reviewCases: reviewBefore.cases.length, signedIntegrationCases: integrationBefore.cases.length,
    privateProtectedFiles: before.protectedGroups.reduce((sum: number, row: { files: number }) => sum + row.files, 0), privateProtectedBytes: before.protectedGroups.reduce((sum: number, row: { bytes: number }) => sum + row.bytes, 0),
    privateObservedReads: before.observations, syntheticPhysicalByteAssertions: physicalByteAssertions, controlledIntegrationEntireCaseSha256: jsonSha(integrationAfter.cases),
    integrationMode: 'Natural frozen BEFORE twice, controlled frozen BEFORE twice and AFTER once; actual signed A/B supply, ordinary worker, revision/history and different-process reopen.' },
  comparisonRules: { integration: 'All entire case arrays, raw synthetic final/failure file text/bytes/SHA, signature preimages/signatures, gate/pipeline outputs and saved identities compare exactly. No sorting, timestamp/ID/hash rewriting or byte normalization.',
    review: 'All entire cases, ordered actual I/O, final UTF8 bytes/hashes, errors and decisions compare exactly.',
    jobs: jobsBefore.pidComparison, nativePidRawEvidenceSha256: { before: jsonSha(jobsBefore.nativePidEvidence), repeatedBefore: jsonSha(jobsRepeat.nativePidEvidence), after: jsonSha(jobsAfter.nativePidEvidence) },
    naturalIntegration: { beforeCasesSha256: jsonSha(naturalOne.cases), repeatedBeforeCasesSha256: jsonSha(naturalTwo.cases), observedAt: n1.createdAt, repeatedObservedAt: n2.createdAt } },
  preservation: { privateFilesUnchanged: true, privateWrites: 0, realProviderCalls: 0, privateRawTextOrIdsExported: false, actualEvaluationApprovalsGranted: false, originalSessionAndContextPreserved: true },
  limitations: ['All approvals/signatures and model responses in the integration are explicit public synthetic fixtures. Current private registry remains absent; no pending specification was approved.', 'Private get/snapshot/result and verified registry/revision/history are read-only; pending is deliberately not called because quarantine may write.', 'Native job short-lock PID fields and temporary filename PID are validated relationally; raw lock bytes are retained. Domain job/snapshot/result/quarantine bytes are unmodified.', 'Existing per-file write/claim/retry semantics, partial temporary files and after-link cleanup failures are preserved. This does not establish a multi-file transaction, distributed lease, fsync/power-loss guarantee, production Auth/RLS or remote CI.', 'No W0 integration, real provider, new human approval, paid request, browser or hardware verification is claimed.'],
  checks, failedChecks: checks.filter(row => !row.passed).map(row => row.id) };
await writeFile(path.join(directory, 'repository-comparison.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ status: result.status, checks: checks.length, failedChecks: result.failedChecks, execution: result.execution }, null, 2));
if (result.status !== 'passed') process.exitCode = 1;
