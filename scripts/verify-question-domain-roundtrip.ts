import dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadInterviewContextAt } from '../server/data/load-interview-context';
import { FULL_ANALYSIS_CURRENT } from '../server/data/full-student-analysis';
import { loadQuestionBank, questionBankIdentity } from '../server/data/prepared-question-bank';
import { readVerifiedQuestionDomainExport } from '../server/contracts/question-domain-adapters';
import { readExistingDomainEnvelopes } from '../server/contracts/read-domain-envelopes';
import { decodeDomainEnvelope, inspectDomainEnvelope, type DomainDecodeContext, type DomainKind } from '../server/contracts/domain-envelope';
import { localDevelopmentOwner } from '../server/session-runtime';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const jsonDigest = (value: unknown) => digest(JSON.stringify(value));
async function fileDigest(file: string): Promise<string | null> {
  try { return digest(await readFile(file)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function evaluationResultDigests(root: string) {
  const directory = path.resolve(root, 'data/evaluation-jobs');
  const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
  return await Promise.all(files.filter(file => /^[a-f0-9]{64}\.result\.json$/u.test(file)).sort().map(async file => [file, await fileDigest(path.join(directory, file))]));
}

/** Private optional verification. Writes only a summary artifact; never emits
 * payloads, student/target identifiers, private paths, keys or raw transcripts. */
export async function verifyQuestionDomainRoundtrip(root = process.cwd()) {
  const absoluteRoot = path.resolve(root), pointerPath = path.resolve(absoluteRoot, FULL_ANALYSIS_CURRENT);
  const pointerBytes = await readFile(pointerPath), pointer = JSON.parse(pointerBytes.toString('utf8')) as { path: string };
  const revisionPath = path.resolve(absoluteRoot, pointer.path), revisionsBase = path.resolve(absoluteRoot, 'data/prepared/student-analysis-revisions');
  const relativeRevision = path.relative(revisionsBase, revisionPath);
  if (!relativeRevision || relativeRevision.startsWith('..') || path.isAbsolute(relativeRevision)) throw new Error('QUESTION_DOMAIN_REVISION_PATH_INVALID');
  const recordPointerPath = path.resolve(absoluteRoot, 'data/prepared/full-record-current.json');
  const recordPointer = JSON.parse(await readFile(recordPointerPath, 'utf8')) as { path: string };
  const recordRevisionPath = path.resolve(absoluteRoot, recordPointer.path), recordRevisionsBase = path.resolve(absoluteRoot, 'data/prepared/record-revisions');
  const relativeRecordRevision = path.relative(recordRevisionsBase, recordRevisionPath);
  if (!relativeRecordRevision || relativeRecordRevision.startsWith('..') || path.isAbsolute(relativeRecordRevision)) throw new Error('QUESTION_DOMAIN_RECORD_REVISION_PATH_INVALID');
  const protectedFiles = [
    { role: 'active-analysis-pointer', file: pointerPath },
    { role: 'active-analysis-revision', file: revisionPath },
    { role: 'active-record-pointer', file: recordPointerPath },
    { role: 'active-record-revision', file: recordRevisionPath },
    { role: 'source-manifest', file: path.resolve(absoluteRoot, 'data/prepared/source-manifest.json') },
  ];
  const before = await Promise.all(protectedFiles.map(row => fileDigest(row.file))), evaluationsBefore = await evaluationResultDigests(absoluteRoot);
  const context = await loadInterviewContextAt(absoluteRoot, { writeManifest: false });
  if (context.errors.length) throw new Error('QUESTION_DOMAIN_PRIVATE_CONTEXT_UNAVAILABLE');
  const identity = questionBankIdentity(context), bankPath = path.resolve(absoluteRoot, 'data/prepared/question-banks', `${identity.key}.json`);
  const bankBefore = await fileDigest(bankPath), bank = await loadQuestionBank(context, { root: absoluteRoot });
  if (!bank || !bankBefore) throw new Error('QUESTION_DOMAIN_PRIVATE_BANK_UNAVAILABLE');
  const exported = await readVerifiedQuestionDomainExport(context, { ownerId: localDevelopmentOwner().id, root: absoluteRoot });
  const objectives = context.studentObjectives ?? [], candidates = bank.slots.flatMap(slot => slot.candidates);
  const contracts = candidates.flatMap(candidate => candidate.draft.approvedQuestion ? [candidate.draft.approvedQuestion] : []);
  const expectedEnvelopes: { kind: DomainKind; payload: unknown; decodeContext?: DomainDecodeContext }[] = [];
  if (context.studentAnalysis) expectedEnvelopes.push({ kind: 'full-student-analysis', payload: context.studentAnalysis });
  if (context.targetAnalysis) expectedEnvelopes.push({ kind: 'target-student-analysis', payload: context.targetAnalysis });
  for (const objective of objectives) expectedEnvelopes.push({ kind: 'student-objective-candidate', payload: objective });
  for (const candidate of candidates) {
    expectedEnvelopes.push({ kind: 'prepared-main-candidate', payload: candidate });
    if (candidate.draft.approvedQuestion) expectedEnvelopes.push({ kind: 'approved-question-contract', payload: candidate.draft.approvedQuestion,
      decodeContext: { draft: candidate.draft } });
  }
  const transport = await readExistingDomainEnvelopes(context, { ownerId: localDevelopmentOwner().id, root: absoluteRoot });
  const transportChecks = {
    expectedCount: expectedEnvelopes.length === transport.envelopes.length,
    exactPayloadJson: transport.envelopes.every((envelope, index) => envelope.kind === expectedEnvelopes[index]?.kind &&
      envelope.payloadJson === JSON.stringify(expectedEnvelopes[index]?.payload)),
    inspectedPayloadJson: transport.envelopes.every(envelope => JSON.stringify(inspectDomainEnvelope(envelope).payload) === envelope.payloadJson),
    decodedPayloadJson: transport.envelopes.every((envelope, index) =>
      JSON.stringify(decodeDomainEnvelope(envelope, expectedEnvelopes[index]?.decodeContext)) === envelope.payloadJson),
    readOnlyAuthority: transport.writes === 0 && transport.providerCalls === 0 && transport.analysisActivation === false &&
      transport.evaluationApprovalGranted === false && transport.envelopes.every(envelope => envelope.authority === 'transport_only_not_approval_or_authentication'),
  };
  const transportCounts = Object.fromEntries([...new Set(transport.envelopes.map(envelope => envelope.kind))].map(kind =>
    [kind, transport.envelopes.filter(envelope => envelope.kind === kind).length]));
  const payloadChecks = {
    objectives: jsonDigest(objectives) === jsonDigest(exported.objectives), candidates: jsonDigest(candidates) === jsonDigest(exported.candidates),
    approvedContracts: jsonDigest(contracts) === jsonDigest(exported.approvedContracts),
    objectiveIds: jsonDigest(objectives.map(row => row.id)) === jsonDigest(exported.objectives.map(row => row.id)),
    candidateIds: jsonDigest(candidates.map(row => row.id)) === jsonDigest(exported.candidates.map(row => row.id)),
    anchors: jsonDigest([objectives.map(row => row.anchorRefs), contracts.map(row => row.blueprint.anchorRefs)]) ===
      jsonDigest([exported.objectives.map(row => row.anchorRefs), exported.approvedContracts.map(row => row.blueprint.anchorRefs)]),
    existingQuestionHashes: jsonDigest(candidates.map(row => [row.questionSha256, row.speechHash, row.audioSha256, row.draft.approvedQuestion])) ===
      jsonDigest(exported.candidates.map(row => [row.questionSha256, row.speechHash, row.audioSha256, row.draft.approvedQuestion])),
  };
  const after = await Promise.all(protectedFiles.map(row => fileDigest(row.file))), bankAfter = await fileDigest(bankPath), evaluationsAfter = await evaluationResultDigests(absoluteRoot);
  const fileChecks = protectedFiles.map((row, index) => ({ role: row.role, beforeSha256: before[index], afterSha256: after[index], unchanged: before[index] === after[index] }));
  fileChecks.push({ role: 'approved-question-bank', beforeSha256: bankBefore, afterSha256: bankAfter, unchanged: bankBefore === bankAfter });
  const evaluationResultsUnchanged = jsonDigest(evaluationsBefore) === jsonDigest(evaluationsAfter);
  const passed = Object.values(payloadChecks).every(Boolean) && Object.values(transportChecks).every(Boolean) && fileChecks.every(row => row.unchanged) && evaluationResultsUnchanged;
  const report = { reportVersion: 'question-domain-private-roundtrip-v1', generatedAt: new Date().toISOString(), passed,
    verificationScope: 'private-read-only-existing-domain', providerCalls: 0, originalFilesModified: false,
    counts: { objectives: objectives.length, candidates: candidates.length, approvedContracts: contracts.length,
      domainEnvelopes: transport.envelopes.length, existingEvaluationResults: evaluationsBefore.length },
    payloadChecks, transportChecks, transportCounts, fileChecks, evaluationResults: { countBefore: evaluationsBefore.length, countAfter: evaluationsAfter.length,
      aggregateBeforeSha256: jsonDigest(evaluationsBefore), aggregateAfterSha256: jsonDigest(evaluationsAfter), unchanged: evaluationResultsUnchanged },
    limitations: ['transport-and-existing-verifier-roundtrip-only', 'not-new-content-or-evaluation-approval', 'not-new-multi-user-authentication'] };
  const reportPath = path.resolve(absoluteRoot, 'artifacts/pr05/question-domain-private-roundtrip.json');
  await mkdir(path.dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  if (!passed) throw new Error('QUESTION_DOMAIN_PRIVATE_ROUNDTRIP_CHANGED');
  return { passed, reportPath: 'artifacts/pr05/question-domain-private-roundtrip.json', ...report.counts, providerCalls: 0,
    allPayloadChecksPassed: true, allTransportChecksPassed: true, allProtectedFilesUnchanged: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  dotenv.config({ path: '.env.local', quiet: true });
  verifyQuestionDomainRoundtrip().then(summary => console.log(JSON.stringify(summary, null, 2))).catch(error => {
    const message = error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : 'QUESTION_DOMAIN_PRIVATE_ROUNDTRIP_FAILED';
    console.error(JSON.stringify({ passed: false, error: message })); process.exitCode = 1;
  });
}
