import { loadInterviewContext } from '../server/data/load-interview-context';

const context = await loadInterviewContext();
const integrity = context.manifest.sourceIntegrity;
const sourceIntegrityPassed = context.errors.length === 0 && integrity.pdfHashVerified && integrity.evidenceReferencesVerified && integrity.evidenceTextVerified;
const report = {
  passed: sourceIntegrityPassed && Boolean(context.interviewerPolicy && context.questionStrategies?.coverage.complete && context.questionReferences?.analysis?.coverage.complete && context.questionReferences.counts.runtimeApprovedQuestions),
  sourceIntegrityPassed,
  errors: context.errors,
  manifestSchema: context.manifest.schemaVersion,
  guidelineSourceVersions: context.manifest.guidelineSourceVersions,
  sourceIntegrity: integrity,
  sources: context.manifest.files.map(file => ({ role: file.role, path: file.path, sha256: file.sha256 })),
  durationSeconds: context.interviewOverview?.durationSeconds ?? null,
  interviewerPolicy: context.manifest.interviewerPolicy ?? null,
  questionStrategies: context.manifest.questionStrategyCatalog ?? null,
  questionReferences: context.questionReferences ? {
    ready: Boolean(context.questionReferences.analysis?.coverage.complete && context.questionReferences.counts.runtimeApprovedQuestions),
    digest: context.questionReferences.digest,
    sourceHashes: context.questionReferences.sourceHashes,
    figuresDirectory: context.questionReferences.figuresDirectory,
    counts: context.questionReferences.counts,
    analysis: context.questionReferences.analysis,
    purpose: 'wording_reference_only',
    changesStudentEvidenceOrAdmissionPolicy: false,
  } : { ready: false, action: 'npm run prepare:question-references' },
};
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
