/** Read-only PR05 proof against mounted private existing artifacts. Reports only
 * counts/hashes/booleans; original sources, IDs and private text are not exported. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadInterviewContextAt } from '../server/data/load-interview-context';
import { loadFullRecord, loadFullStudentAnalysis } from '../server/data/full-student-analysis';
import { assertAnalysisDocumentHash, decodeFullAnalysisPreservingOrder, decodeTargetAnalysisPreservingOrder, encodeAnalysisWireV2, encodeFullAnalysis, encodeTargetAnalysis, validateAnalysisEnvelopeSemantics } from '../server/contracts/analysis-domain-adapters';
import { analysisDomainSchemas } from '../server/contracts/analysis-domain-codecs';
import { createDomainEnvelope, decodeDomainEnvelope, emptyDomainScope } from '../server/contracts/domain-envelope';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function within(root: string, value: string, directory: string) {
  const file = path.resolve(root, value), relative = path.relative(path.resolve(root, directory), file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('ANALYSIS_ROUNDTRIP_PATH_INVALID');
  return file;
}
/** No current-target comparison: historical versions retain their own targets.
 * Counts distinguish a pre-existing broken hash from a new shape restriction. */
export async function verifyHistoricalAnalysisInventory(root = process.cwd()) {
  const files: string[] = [], base = path.join(root, 'data/prepared/student-analysis-revisions');
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file); else if (entry.isFile() && entry.name === 'analysis.json') files.push(file);
    }
  };
  await visit(base); files.sort();
  const counts = { total: files.length, parseFailures: 0, commonShapeFailures: 0, targetShapeFailures: 0, commonHashFailures: 0, targetHashFailures: 0, commonAdapterFailures: 0, targetAdapterFailures: 0,
    versions: { v1: 0, v2: 0, other: 0 }, changedFiles: 0 };
  const before: string[] = [];
  for (const file of files) {
    const bytes = await readFile(file); before.push(sha(bytes));
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { counts.parseFailures++; continue; }
    if (value.common?.schemaVersion === 'full-student-analysis-v1') counts.versions.v1++; else if (value.common?.schemaVersion === 'full-student-analysis-v2') counts.versions.v2++; else counts.versions.other++;
    if (!analysisDomainSchemas['full-student-analysis'].safeParse(value.common).success) counts.commonShapeFailures++;
    if (!analysisDomainSchemas['target-student-analysis'].safeParse(value.target).success) counts.targetShapeFailures++;
    try { assertAnalysisDocumentHash(value.common); } catch { counts.commonHashFailures++; }
    try { assertAnalysisDocumentHash(value.target); } catch { counts.targetHashFailures++; }
    try { decodeFullAnalysisPreservingOrder(value.common); } catch { counts.commonAdapterFailures++; }
    try { decodeTargetAnalysisPreservingOrder(value.target); } catch { counts.targetAdapterFailures++; }
  }
  const after = await Promise.all(files.map(async file => sha(await readFile(file))));
  counts.changedFiles = after.filter((value, index) => value !== before[index]).length;
  const failures = counts.parseFailures + counts.commonShapeFailures + counts.targetShapeFailures + counts.commonHashFailures + counts.targetHashFailures + counts.commonAdapterFailures + counts.targetAdapterFailures + counts.changedFiles;
  return { status: failures ? 'failed' : 'passed', ...counts, originalFilesUnchanged: counts.changedFiles === 0, originalInventorySha256: sha(JSON.stringify(before)), providerCalls: 0 };
}
export async function verifyAnalysisDomainRoundtrip(options: { root?: string; proposalPath: string; outputPath?: string }) {
  const root = path.resolve(options.root ?? process.cwd());
  const pointerFile = path.join(root, 'data/prepared/student-analysis-current.json'), sourcePointerFile = path.join(root, 'data/prepared/full-record-current.json');
  const pointer = JSON.parse(await readFile(pointerFile, 'utf8')) as { path: string }, sourcePointer = JSON.parse(await readFile(sourcePointerFile, 'utf8')) as { path: string };
  const canonicalFile = within(root, pointer.path, 'data/prepared/student-analysis-revisions'), sourceFile = within(root, sourcePointer.path, 'data/prepared/record-revisions');
  const proposalFile = within(root, options.proposalPath, 'data/prepared/student-analysis-proposals');
  const files = [{ role: 'analysis_pointer', file: pointerFile }, { role: 'source_pointer', file: sourcePointerFile },
    { role: 'source_manifest', file: path.join(root, 'data/prepared/source-manifest.json') }, { role: 'canonical_analysis', file: canonicalFile },
    { role: 'canonical_source', file: sourceFile }, { role: 'original_wire_proposal', file: proposalFile }];
  const before = await Promise.all(files.map(async item => sha(await readFile(item.file))));
  const canonical = JSON.parse(await readFile(canonicalFile, 'utf8')), proposal = JSON.parse(await readFile(proposalFile, 'utf8')) as { output: unknown };
  const context = await loadInterviewContextAt(root, { writeManifest: false }); if (context.errors.length) throw new Error('ANALYSIS_ROUNDTRIP_CONTEXT_INVALID');
  const analysis = await loadFullStudentAnalysis(context, root); if (!analysis) throw new Error('ANALYSIS_ROUNDTRIP_CANONICAL_MISSING');
  const source = await loadFullRecord(root, analysis.common.recordRevision); if (!source) throw new Error('ANALYSIS_ROUNDTRIP_SOURCE_MISSING');
  const semantic = validateAnalysisEnvelopeSemantics(analysis, source, { studentId: source.studentId, sourceRevision: source.revision,
    commonRevision: analysis.common.revision, supportTargetId: analysis.target.supportTargetId, profileRevision: analysis.target.profileRevision });
  const fullBytes = JSON.stringify(canonical.common), targetBytes = JSON.stringify(canonical.target), wireBytes = JSON.stringify(proposal.output);
  assert.equal(encodeFullAnalysis(canonical.common), fullBytes); assert.equal(encodeTargetAnalysis(canonical.target), targetBytes);
  assert.equal(encodeAnalysisWireV2(source, proposal.output), wireBytes);
  const scope = { ...emptyDomainScope(), studentId: source.studentId, supportTargetId: analysis.target.supportTargetId,
    sourceRevision: source.revision, recordRevision: analysis.common.recordRevision, sourceContentSha256: source.contentSha256,
    analysisRevision: analysis.common.revision, profileRevision: analysis.target.profileRevision };
  const wireEnvelope = createDomainEnvelope('student-analysis-codec-v2', proposal.output, scope, { source });
  assert.equal(wireEnvelope.payloadJson, wireBytes); assert.equal(JSON.stringify(decodeDomainEnvelope(wireEnvelope, { source })), wireBytes);
  const after = await Promise.all(files.map(async item => sha(await readFile(item.file))));
  assert.deepEqual(after, before, 'PR05 verification must not alter the original source or canonical files');
  const historicalRevisionInventory = await verifyHistoricalAnalysisInventory(root);
  const report = { status: 'passed', version: 'analysis-domain-private-roundtrip-v1', generatedAt: new Date().toISOString(),
    providerCalls: 0, activated: false, originalFilesUnchanged: true, canonicalMutation: false,
    schemaVersions: { common: analysis.common.schemaVersion, target: analysis.target.schemaVersion, wire: 'student-analysis-wire-v2', codec: analysis.common.codecVersion ?? null },
    counts: { activities: analysis.common.activities.length, academicRecords: analysis.common.academicRecords.length, objectives: analysis.target.objectives.length, evidence: analysis.evidence.length },
    roundtrips: { fullExact: true, targetExact: true, originalWireExact: true, originalWireEnvelopeExact: true },
    contentHashes: { common: semantic.commonContentSha256, target: semantic.targetContentSha256, evidence: semantic.evidenceSha256,
      wirePayload: wireEnvelope.payloadSha256, source: source.contentSha256, envelope: sha(JSON.stringify(wireEnvelope)) },
    protectedFiles: files.map((item, index) => ({ role: item.role, sha256: before[index], unchanged: before[index] === after[index] })),
    historicalRevisionInventory,
    boundaries: { privateRawDataExported: false, personalIdsExported: false, sourceQa: 'existing TS decoder and analysisQAManifest',
      transportAuthority: wireEnvelope.authority, scientificTruthGranted: false, independentSemanticReviewGranted: false },
  };
  const output = within(root, options.outputPath ?? 'artifacts/pr05/analysis-domain-private-roundtrip.json', 'artifacts');
  await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const flags = new Map<string, string>();
  for (const arg of process.argv.slice(2)) { const match = /^--(proposal|output|root)=(.+)$/u.exec(arg); if (!match || flags.has(match[1])) throw new Error('USE_PROPOSAL_OPTIONAL_ROOT_OUTPUT'); flags.set(match[1], match[2]); }
  const proposalPath = flags.get('proposal'); if (!proposalPath) throw new Error('EXACT_PROPOSAL_PATH_REQUIRED_NO_NEWEST_FILE_GUESS');
  verifyAnalysisDomainRoundtrip({ proposalPath, root: flags.get('root'), outputPath: flags.get('output') }).then(report => console.log(JSON.stringify(report))).catch(error => {
    const message = error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : 'ANALYSIS_DOMAIN_ROUNDTRIP_FAILED';
    console.error(JSON.stringify({ status: 'failed', error: message, providerCalls: 0, activated: false })); process.exitCode = 1;
  });
}
