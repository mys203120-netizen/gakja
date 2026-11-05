import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const read = async (file: string) => JSON.parse((await readFile(path.resolve(root, file), 'utf8')).replace(/^\uFEFF/u, ''));
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const baseline = await read('artifacts/p0-preservation-baseline-20261103T201246844Z.json');
const originals = await Promise.all(baseline.entries.map(async (entry: { path: string; sha256: string; archive?: string }) => ({
  path: entry.path, unchanged: sha(await readFile(path.resolve(root, entry.path))) === entry.sha256,
  archiveVerified: entry.archive ? sha(await readFile(entry.archive)) === entry.sha256 : null,
})));
const ui = await read('artifacts/schema-simplification-ui-baseline.json');
const uiChecks = await Promise.all(ui.map(async (entry: { path: string; sha256: string }) => ({
  path: path.relative(root, entry.path), unchanged: sha(await readFile(entry.path)).toLowerCase() === entry.sha256.toLowerCase(),
})));
const active = await read('data/prepared/student-analysis-current.json');
const analysis = await read(active.path);
const bankKey = '9e185f3157cd561e91919dde906550aba009f01b2651868fc8519cb52f2320c0';
const bankFile = `data/prepared/question-banks/${bankKey}.json`;
const bank = await read(bankFile);
const selected = await read('artifacts/actual-user-core-v7-final-c00231-20261104.json');
const initial = await read('artifacts/actual-user-core-v6-c00231-20261104.json');
function metrics(report: { cases: Array<{ wallMs: number; providerTimings: { inputTokens?: number } }>; providerRequests: number; acceptedReactionCount: number }) {
  const values = report.cases.map(row => row.wallMs).sort((a, b) => a - b);
  const tokens = report.cases.flatMap(row => row.providerTimings.inputTokens ?? []).sort((a, b) => a - b);
  return { cases: values.length, providerCalls: report.providerRequests, medianMs: Math.round(values[Math.floor(values.length / 2)]),
    p95Ms: Math.round(values[Math.ceil(values.length * .95) - 1]), inputMin: tokens[0], inputMax: tokens.at(-1), acceptedReactions: report.acceptedReactionCount };
}
const fullTestLog = await readFile('artifacts/phase4-final-accepted-tests.log', 'utf8');
const browserSession = await read('data/sessions/d1f2b11c-2b86-4c8a-9c9e-523585683ab3.json');
const browserRecheck = await read('artifacts/phase4-browser-final-recheck.json');
const report = {
  version: 'interviewer-p0-implementation-verification-v1', createdAt: new Date().toISOString(),
  localRuntime: { url: 'http://127.0.0.1:3000/interview', ordinaryOwnerEnvironmentRestored: true, statusEndpointReady: true,
    browserLeftIdle: true, microphoneAndCameraNotStartedInDeliverableTab: true },
  requirements: { soleCoreSemanticAuthority: true, technicalCaptureGuardsSeparate: true, noNewScreens: true,
    commonOpeningQuestionsOptional: true, existingRecordsPreserved: originals.filter(row => /sessions|conversation-logs/u.test(row.path)).every(row => row.unchanged),
    cssPreserved: uiChecks.filter(row => row.path.endsWith('.css')).every(row => row.unchanged) },
  data: { activeRevision: active.path, codec: analysis.common.codecVersion, activities: analysis.common.activities.length,
    academicRowsReviewed: 13, academicLiteralsReviewed: 35, academicRemainderUnresolved: 3,
    sourceQA: 'artifacts/phase4-student-analysis-source-qa.json', completeScopeContractQA: 'artifacts/staged-contract-complete-validation.json' },
  bank: { key: bankKey, fileSha256: sha(await readFile(bankFile)), approved: bank.slots.reduce((n: number, slot: { candidates: unknown[] }) => n + slot.candidates.length, 0),
    quarantined: bank.slots.filter((slot: { quarantine?: unknown }) => slot.quarantine).length,
    audit: 'artifacts/phase4-final-bank-quality-and-lineage-audit.json', lineageRegistry: `data/prepared/question-purpose-lineages/${bankKey}.json`,
    readiness: `data/prepared/student-analysis-readiness/${analysis.common.revision}-${bankKey}.json` },
  actualThreeInterviewComparison: { fixedActualAnswers: 25, originalInputsUnchanged: true,
    comparisonScope: 'Exact historical raw Q/A prefixes; same verified staged c002 context; core only. Does not recreate original human audio or compare identical old prompts.',
    baseline: metrics(initial), selected: metrics(selected), humanReview: { pass: 22, nuance: 2, remainingClearCoverageDefect: 1 },
    selectedReport: 'artifacts/actual-user-core-v7-final-c00231-20261104.json', audit: 'artifacts/actual-user-core-v7-human-verification-final-20261104.json',
    compactExperimentRejected: true, inputTokenTargetFullyMet: false },
  browser: { firstRun: { sessionId: browserSession.id, owner: browserSession.runtime.owner.id, status: browserSession.status,
    evaluationStatus: browserSession.evaluationStatus, hardwareMicrophoneUsed: true, syntheticVoice: false,
    intentionalHumanParticipationNotInferred: true, inputMutedAfterCheck: true,
    originalObservedEmptyCaptureError: 'CORE_EMPTY_TRANSCRIPT_UNOBSERVED; subsequently fixed and separately reverified',
    completedScreenshot: 'artifacts/phase4-browser-completed.jpg' },
    finalRecheckReport: 'artifacts/phase4-browser-final-recheck.json', finalRecheck: {
      sessionId: browserRecheck.sessionId, status: browserRecheck.status, evaluationStatus: browserRecheck.evaluationStatus,
      errors: browserRecheck.errorCount, observation: browserRecheck.observation, score: browserRecheck.sessionScore,
      sameQuestionPreserved: browserRecheck.sameQuestionPreserved, captureRevision: browserRecheck.captureRevision,
      technicalReason: browserRecheck.captureReason, coreCalls: browserRecheck.coreCalls,
      screenshot: browserRecheck.completedScreenshot,
    } },
  checks: { tests: Number(fullTestLog.match(/ℹ tests (\d+)/u)?.[1]), passed: Number(fullTestLog.match(/ℹ pass (\d+)/u)?.[1]),
    failed: Number(fullTestLog.match(/ℹ fail (\d+)/u)?.[1]), buildLog: 'artifacts/phase4-final-accepted-build.log', lintLog: 'artifacts/phase4-final-accepted-lint.log',
    finalAudioReport: 'artifacts/final-full-audio-e2e-summary-v2.json',
    postAudioMechanicalDelta: { files: ['server/answer-submission.ts', 'server/providers/single-core-runtime.ts', 'server/realtime.ts'],
      scope: 'Disabled-input observation and finalization only; prompt/schema/scoring formula unchanged. Added after the three voice runs; final 899-test suite and muted-End browser check cover the final source.',
      evidence: 'artifacts/final-full-audio-v2-post-run-source-drift.json' } },
  preservation: { originals, uiChecks },
  remainingLimitations: ['One historical comparison answer was marked partial for an unasked principle; its concept follow-up was relevant, but coverage is still wrong.',
    'Selected core inputs are approximately11.5–12.3k tokens. The shorter experiment regressed semantic quality and was rejected.',
    'Three unreviewed academic table sections remain explicitly unresolved; no values or causes were invented.'],
};
const file = 'artifacts/interviewer-p0-implementation-verification-20261104.json';
await writeFile(file, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ file, originalsPreserved: report.requirements.existingRecordsPreserved, cssPreserved: report.requirements.cssPreserved, bank: report.bank.approved, tests: report.checks.tests, failed: report.checks.failed }));
