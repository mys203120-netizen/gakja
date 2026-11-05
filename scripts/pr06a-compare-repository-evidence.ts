/** Compare observations made by two independent application source trees.
 * This reads evidence only; it neither loads nor approves domain payloads. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directory = path.resolve(process.argv[2] ?? 'artifacts/pr06a');
const read = async (name: string) => JSON.parse(await readFile(path.join(directory, name), 'utf8'));
const [before, after, beforeCases, afterCases, beforeRaces, afterRaces, snapshot] = await Promise.all([
  read('before-private-extended.json'), read('after-private.json'), read('before-synthetic.json'), read('after-synthetic.json'),
  read('before-context-races-extended.json'), read('after-context-races.json'), read('source-capture-before.log'),
]);
assert.notEqual(path.resolve(before.sourceRoot), path.resolve(after.sourceRoot), 'independent source roots required');
assert.notEqual(before.sourceModuleHashes['server/data/full-student-analysis.ts'], after.sourceModuleHashes['server/data/full-student-analysis.ts']);
const checks: { id: string; passed: boolean }[] = [];
const same = (id: string, left: unknown, right: unknown) => checks.push({ id, passed: JSON.stringify(left) === JSON.stringify(right) });
const { contextJsonSha256: beforeRawContext, ...beforeContext } = before.observations.context;
const { contextJsonSha256: afterRawContext, ...afterContext } = after.observations.context;
same('private-context-all-fields-except-one-existing-runtime-timestamp', beforeContext, afterContext);
same('private-source-payload-and-content-hash', before.observations.source, after.observations.source);
same('private-full-target-evidence-objective-ids-anchors-runtime-objectives', before.observations.analysis, after.observations.analysis);
same('private-ordered-transport-payloadJson-candidate-ids-question-audio-hashes', before.observations.questionDomain, after.observations.questionDomain);
same('private-configured-source-canonical-manifest-pointer-file-bytes', before.protectedFiles, after.protectedFiles);
same('private-active-bank-file-bytes', before.bankFileEvidence, after.bankFileEvidence);
same('same-before-frozen-synthetic-input', beforeCases.fixtureSha256, afterCases.fixtureSha256);
const intentional = 'analysis-common-record-pin-rehashed';
const syntheticDifferences = [];
for (const row of beforeCases.cases) {
  const next = afterCases.cases.find((candidate: { id: string }) => candidate.id === row.id);
  assert.ok(next, 'missing after case: ' + row.id);
  same(row.id + ':stored-file-bytes', row.fileBytesSha256, next.fileBytesSha256);
  if (row.id === intentional) {
    checks.push({ id: row.id + ':intentional-existing-record-gap-closed', passed: row.result.status === 'returned' && next.result.status === 'rejected' && next.result.code === 'FULL_ANALYSIS_STUDENT_OR_REVISION_MISMATCH' });
    syntheticDifferences.push({ id: row.id, before: row.result.status, after: next.result.status, afterCode: next.result.code,
      reason: 'Explicit source/record consistency required by PR06-A; existing loader accepted a rehashed wrong common.recordRevision.' });
  } else same(row.id + ':outcome-and-domain-digests', row.result, next.result);
  assert.equal(row.writesAttempted + next.writesAttempted + row.providerCallsAttempted + next.providerCallsAttempted, 0);
}
assert.equal(beforeCases.cases.length, afterCases.cases.length);
const raceComparisons = [];
for (const row of beforeRaces.results) {
  const next = afterRaces.results.find((candidate: { fault: string }) => candidate.fault === row.fault); assert.ok(next);
  if (row.fault === 'source_pointer') {
    same('source-pointer-race:coherent-original-context', row.stableContextJsonSha256, next.stableContextJsonSha256);
    checks.push({ id: 'source-pointer-race:never-reselected-or-mixed', passed: row.acceptedContextMatchesNormal === true && next.acceptedContextMatchesNormal === true && row.sourcePointerReads === 1 && next.sourcePointerReads === 1 });
  } else {
    same(row.fault + ':race-rejection-kind', row.status, next.status); same(row.fault + ':race-rejection-message', row.errorMessageSha256, next.errorMessageSha256);
    checks.push({ id: row.fault + ':fault-actually-delivered-and-rejected', passed: row.faultDeliveredOnLaterRead && next.faultDeliveredOnLaterRead && row.status === 'rejected_exception' && next.status === 'rejected_exception' });
  }
  assert.equal(row.writesAttempted + next.writesAttempted + row.providerCallsAttempted + next.providerCallsAttempted, 0);
  raceComparisons.push({ fault: row.fault, before: row.status, after: next.status, acceptedContextMatchesNormal: next.acceptedContextMatchesNormal ?? null });
}
for (const report of [before, after]) { assert.equal(report.writesAttempted, 0); assert.equal(report.providerCallsAttempted, 0); assert.equal(report.protectedFilesUnchanged, true); assert.equal(report.sourceModulesUnchanged, true); }
for (const key of ['protectedPointerSha256', 'protectedDocumentSha256', 'protectedSourcePointerSha256', 'protectedSourceDocumentSha256']) same('context-race:' + key, beforeRaces[key], afterRaces[key]);
const result = { version: 'pr06a-independent-before-after-comparison-v1', status: checks.every(row => row.passed) ? 'passed' : 'failed', generatedAt: new Date().toISOString(),
  beforeSource: { head: snapshot.head, sourceTreeSha256: snapshot.sourceTreeSha256, fileCount: snapshot.files, kind: snapshot.sourceKind, sourceRoot: before.sourceRoot },
  afterSource: { sourceRoot: after.sourceRoot, moduleHashes: after.sourceModuleHashes }, dependencyReuse: true, freshInstallClaimed: false,
  private: { protectedConfiguredSourceCanonicalManifestPointerFiles: before.protectedFiles.length, activeBankAdditionallyProtected: Boolean(before.bankFileEvidence),
    sourcePages: after.observations.source.pages, sourceBlocks: after.observations.source.blocks, runtimeEvidence: after.observations.context.studentEvidenceCount,
    runtimeObjectives: after.observations.context.objectiveCount, bankCandidates: after.observations.questionDomain.candidateCount, exactTransportEnvelopes: after.observations.questionDomain.envelopeCount },
  synthetic: { count: beforeCases.cases.length, exactlyPreserved: beforeCases.cases.length - syntheticDifferences.length, intentionalDifferences: syntheticDifferences }, contextRaces: raceComparisons,
  contextTimestamp: { beforeRawSha256: beforeRawContext, afterRawSha256: afterRawContext, stableProjectionSha256: after.observations.context.stableContextJsonSha256,
    exclusion: 'Only questionStrategies.generatedAt, an existing runtime build timestamp already excluded by catalogContentHash. Equality projection only; original objects, files, payloadJson and canonical hashes were never normalized.' },
  writesAttempted: 0, providerCallsAttempted: 0, privateRawTextOrIdsExported: false, evaluationApprovalGranted: false,
  checks, failedChecks: checks.filter(row => !row.passed).map(row => row.id), limitations: ['Local read-boundary evidence only; no production Auth/RLS/DB/paid-provider or release-gate completion claim.', 'New explicit fallback scope guards have dedicated public synthetic PDF regression in tests/read-repositories.test.ts.'] };
await writeFile(path.join(directory, 'repository-comparison.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ status: result.status, checks: checks.length, failedChecks: result.failedChecks, private: result.private, synthetic: result.synthetic, contextRaces: result.contextRaces }, null, 2));
if (result.status !== 'passed') process.exitCode = 1;
