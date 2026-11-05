/** Read independent PR06-B observations; never import application helpers. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directory = path.resolve(process.argv[2] ?? 'artifacts/pr06b');
const read = async (name: string) => JSON.parse(await readFile(path.join(directory, name), 'utf8'));
const [before, repeatedPrivate, after, bankBefore, bankAfter, audioBefore, audioAfter, callerBefore, callerAfter, uncontrolledBefore, repeatedBefore, uncontrolledAfter, source] = await Promise.all([
  read('before-private.json'), read('before-private-repeated.json'), read('after-private.json'), read('bank-before-cases.json'), read('bank-after-cases.json'), read('before-audio-cases.json'), read('after-audio-cases.json'),
  read('before-clova-caller.json'), read('after-clova-caller.json'), read('before-audio-cases-uncontrolled.json'), read('before-audio-cases-repeated.json'), read('after-audio-cases-uncontrolled.json'), read('source-capture-before.log'),
]);
const checks: { id: string; passed: boolean }[] = [];
const same = (id: string, left: unknown, right: unknown) => checks.push({ id, passed: JSON.stringify(left) === JSON.stringify(right) });
assert.notEqual(path.resolve(before.sourceRoot), path.resolve(after.sourceRoot));
assert.notEqual(bankBefore.sourceSha256, bankAfter.sourceSha256); assert.notEqual(audioBefore.sourceSha256, audioAfter.sourceSha256);
same('bank-synthetic-inputs-and-controlled-clock', [bankBefore.fixtureSha256, bankBefore.controlledClock], [bankAfter.fixtureSha256, bankAfter.controlledClock]);
same('clova-caller-same-isolated-child-fixture', callerBefore.fixtureSha256, callerAfter.fixtureSha256);
assert.equal(bankBefore.cases.length, bankAfter.cases.length); assert.equal(audioBefore.cases.length, audioAfter.cases.length);
for (const row of bankBefore.cases) {
  const next = bankAfter.cases.find((candidate: { id: string }) => candidate.id === row.id); assert.ok(next);
  same('bank:' + row.id + ':entire-output-identity-provider-count-event-order-files', row, next);
  assert.equal(row.networkCalls + next.networkCalls, 0);
}
for (const row of audioBefore.cases) {
  const next = audioAfter.cases.find((candidate: { name: string }) => candidate.name === row.name); assert.ok(next);
  same('audio:' + row.name + ':entire-cache-cancel-writer-warning-files', row, next);
}
same('actual-clova-generate-shared-cancel-and-bytes', callerBefore.generate, callerAfter.generate);
same('actual-clova-fresh-process-reopen-disk-zero-fetch', callerBefore.reopen, callerAfter.reopen);
assert.equal(callerBefore.actualProviderCalls + callerAfter.actualProviderCalls, 0);
const { contextRawJsonSha256: beforeRaw, ...beforeObservations } = before.observations;
const { contextRawJsonSha256: repeatedBeforeRaw, ...repeatedBeforeObservations } = repeatedPrivate.observations;
const { contextRawJsonSha256: afterRaw, ...afterObservations } = after.observations;
same('repeated-B-before-same-application-modules', before.sourceModuleHashes, repeatedPrivate.sourceModuleHashes);
same('repeated-B-before-entire-stable-observation', beforeObservations, repeatedBeforeObservations);
same('repeated-B-before-identical-protected-input-files-and-bytes', before.protectedGroups, repeatedPrivate.protectedGroups);
checks.push({ id: 'repeated-B-before-raw-context-varies-only-existing-strategy-timestamp', passed: beforeRaw !== repeatedBeforeRaw });
same('private-entire-bank-pinned-selection-replay-audio-binary-context-projection', beforeObservations, afterObservations);
assert.equal(before.protectedGroups.length, after.protectedGroups.length);
for (const group of before.protectedGroups) same('private:' + group.category + ':file-identities-and-physical-binary-bytes', group, after.protectedGroups.find((row: { category: string }) => row.category === group.category));
for (const row of [before, repeatedPrivate, after]) { assert.equal(row.privateWriteAttempts, 0); assert.equal(row.networkAttempts, 0); assert.equal(row.originalFilesUnchanged, true); assert.equal(row.sourceModulesUnchanged, true); }
const order = (report: typeof audioBefore) => report.cases.find((row: { name: string }) => row.name === 'different-key-sharing').writerEvents.filter((event: { op: string }) => event.op === 'writeFile').map((event: { file: string }) => event.file);
const originalOrder = order(uncontrolledBefore), repeatedOrder = order(repeatedBefore), observedAfterOrder = order(uncontrolledAfter);
checks.push({ id: 'original-uncontrolled-different-key-order-varies-before-any-refactor', passed: JSON.stringify(originalOrder) !== JSON.stringify(repeatedOrder) });
same('observed-uncontrolled-after-order-is-already-observed-before', observedAfterOrder, repeatedOrder);
const controlled = audioAfter.cases.find((row: { name: string }) => row.name === 'different-key-sharing');
assert.equal(controlled.details.concurrentProducersBeforeRelease, 2); assert.equal(controlled.details.controlledReleaseOrder, 'first-key-commit-before-second-key-release');
const partial = audioAfter.cases.find((row: { name: string }) => row.name === 'partial-write-failure'), corrupt = audioAfter.cases.find((row: { name: string }) => row.name === 'nonempty-corrupt-disk-hit');
assert.equal(partial.details.legacyPartialNonemptyDiskAcceptedOnReopen, true); assert.equal(partial.details.durableNull, true); assert.equal(corrupt.providerCalls, 0);
const report = { version: 'pr06b-independent-before-after-comparison-v1', generatedAt: new Date().toISOString(), status: checks.every(row => row.passed) ? 'passed' : 'failed',
  beforeSource: { kind: source.sourceKind, head: source.head, treeSha256: source.sourceTreeSha256, files: source.files, sourceModuleHashes: before.sourceModuleHashes },
  afterSource: { sourceModuleHashes: after.sourceModuleHashes }, dependencyReuse: true, freshInstallClaimed: false,
  execution: { bankCases: bankBefore.cases.length, audioCacheCases: audioBefore.cases.length, actualClovaCallerModes: ['generate', 'fresh-process-reopen'], allCaseRowsAndOrderedWriterEventsExact: checks.every(row => row.passed),
    privateProtectedFiles: before.protectedGroups.reduce((sum: number, row: { files: number }) => sum + row.files, 0), privateProtectedBytes: before.protectedGroups.reduce((sum: number, row: { bytes: number }) => sum + row.bytes, 0),
    privateAudioFiles: before.protectedGroups.find((row: { category: string }) => row.category === 'audio').files, currentBankCandidates: after.observations.candidateCount,
    deterministicSelections: after.observations.selectionCount, actualSpeechCacheCallerReads: after.observations.actualSpeechCacheCallerReadCount },
  preservation: { privateOriginalFileIdentitiesAndBinaryBytes: true, currentAndPinnedBankExact: true, orderedCandidateIdsContractsQuestionAudioHashes: true,
    selectionAndApprovedReplay: true, sourceAnalysisPointersSessionsEvaluationFiles: true, privateWrites: 0, paidOrActualProviderCalls: 0, evaluationApprovalGranted: false, privateRawTextOrIdsExported: false },
  comparisonControls: { bank: 'Known controlled clock is input. UUIDv4 tmp names validated 1:1 before ordinal replacement only in ordered event paths; all modes/flags/write hashes/rename targets/errors/final bytes retained.',
    audio: 'Both different-key producers enter concurrently, then fixture releases first and waits for its actual commit before releasing second; no event sorting or dropping.',
    observedOriginalNondeterminism: { rawBeforeWriteOrder: originalOrder, rawRepeatedBeforeWriteOrder: repeatedOrder, rawAfterWriteOrder: observedAfterOrder, rawReportsPreserved: true },
    context: { beforeRawSha256: beforeRaw, repeatedBBeforeRawSha256: repeatedBeforeRaw, afterRawSha256: afterRaw,
      actualBBeforeRepeatProvesNondeterminismWithIdenticalStableObservationsAndInputs: beforeRaw !== repeatedBeforeRaw,
      excludedOnlyForComparison: 'Only questionStrategies.generatedAt; actual B BEFORE repeated execution has different raw context SHA with identical full comparison projection, application module hashes and protected input bytes. Already excluded from catalogContentHash; canonical objects/payloadJson/file bytes never normalized.' },
    timings: 'Actual finite/nonnegative timing bounds and cache categories/nullability validated; numeric performance durations are not identity or byte-equality claims.' },
  unchangedLimits: ['Speech cache accepts any nonempty disk bytes without verifying a content hash. Injected partial write then EIO leaves bytes a fresh cache accepts; old RAM remains ready and durable comparison rejects mismatch.',
    'Speech cache background persistence is a plain write, not an atomic transaction. Bank audio/JSON use per-file tmp write→rename→own-temp cleanup, no cross-file transaction.',
    'No Windows rename retry, fsync, distributed lease or process-crash guarantees were added. ENOSPC/EPERM are deterministic injected filesystem errors, not an OS crash experiment.',
    'Synthetic audio/provider fixtures do not verify paid provider quality, microphone/speaker hardware, W0 integration, production Auth/RLS/DB or remote release gates.'],
  checks, failedChecks: checks.filter(row => !row.passed).map(row => row.id) };
await writeFile(path.join(directory, 'repository-comparison.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, checks: checks.length, failedChecks: report.failedChecks, execution: report.execution }, null, 2));
if (report.status !== 'passed') process.exitCode = 1;
