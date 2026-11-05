/** Independent PR06-A comparison runner. Application modules come only from
 * --source-root; --data-root private inputs are read-only and never serialized. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const flags = new Map(process.argv.slice(2).map(argument => { const match = /^--(source-root|data-root|output)=(.+)$/u.exec(argument); if (!match) throw new Error('PR06A_EXPLICIT_SOURCE_DATA_OUTPUT_REQUIRED'); return [match[1], match[2]]; }));
const sourceRoot = path.resolve(flags.get('source-root') ?? ''), dataRoot = path.resolve(flags.get('data-root') ?? '');
const output = path.resolve(flags.get('output') ?? 'artifacts/pr06a/repository-evidence.json');
if (!flags.has('source-root') || !flags.has('data-root')) throw new Error('PR06A_EXPLICIT_SOURCE_DATA_ROOT_REQUIRED');
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const jsonSha = (value: unknown) => sha(JSON.stringify(value));
const modulePaths = ['server/data/full-student-analysis.ts', 'server/data/load-interview-context.ts', 'server/contracts/analysis-domain-adapters.ts', 'server/contracts/domain-envelope.ts', 'server/question-objective.ts'];
const moduleHashes = async () => Object.fromEntries(await Promise.all(modulePaths.map(async relative => [relative, sha(await readFile(path.join(sourceRoot, relative)))])));
const sourceBefore = await moduleHashes();
const load = (relative: string) => import(pathToFileURL(path.join(sourceRoot, relative)).href);
const [analysis, contextApi, objectiveApi, configApi, bankApi, domainApi, ownerApi] = await Promise.all([load('server/data/full-student-analysis.ts'), load('server/data/load-interview-context.ts'), load('server/question-objective.ts'), load('interview.config.ts'), load('server/data/prepared-question-bank.ts'), load('server/contracts/read-domain-envelopes.ts'), load('server/session-runtime.ts')]);
const nativeFs = createRequire(import.meta.url)('node:fs/promises');
let writesAttempted = 0, providerCallsAttempted = 0, readCalls = 0, toolingWrites = 0;
const originals = Object.fromEntries(['readFile', 'writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm', 'copyFile'].map(key => [key, nativeFs[key]]));
const originalFetch = globalThis.fetch;
function guardPrivateReads() {
  nativeFs.readFile = async (...args: unknown[]) => { readCalls++; return originals.readFile(...args); };
  for (const key of ['writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm', 'copyFile']) nativeFs[key] = async (...args: unknown[]) => {
    const paths = (key === 'rename' || key === 'copyFile' ? args.slice(0, 2) : args.slice(0, 1)).filter(value => typeof value === 'string') as string[];
    if (paths.some(value => [dataRoot, sourceRoot].some(root => { const relative = path.relative(root, path.resolve(value)); return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative); }))) { writesAttempted++; throw new Error('PR06A_PRIVATE_WRITE_BLOCKED'); }
    toolingWrites++; return originals[key](...args);
  };
  globalThis.fetch = async () => { providerCallsAttempted++; throw new Error('PR06A_NETWORK_CALL_BLOCKED'); };
  syncBuiltinESMExports();
}
function restore() { for (const [key, value] of Object.entries(originals)) nativeFs[key] = value; globalThis.fetch = originalFetch; syncBuiltinESMExports(); }
const rejection = (error: unknown) => { const row = error as Error & { code?: string }; return { status: 'rejected', name: row.name, code: row.code ?? (/^[A-Z0-9_]+$/u.test(row.message) ? row.message : null), messageSha256: sha(row.message) }; };
async function protectInventory() {
  const rows: { role: string; file: string }[] = Object.entries(configApi.interviewConfig.files).map(([role, relative]) => ({ role: 'configured:' + role, file: path.resolve(dataRoot, relative as string) }));
  for (const [role, pointer] of [['source', 'data/prepared/full-record-current.json'], ['analysis', 'data/prepared/student-analysis-current.json']]) {
    const file = path.join(dataRoot, pointer); rows.push({ role: role + ':pointer', file });
    try { const value = JSON.parse(await readFile(file, 'utf8')); const target = path.resolve(dataRoot, value.path); assert.ok(!path.relative(dataRoot, target).startsWith('..')); rows.push({ role: role + ':revision', file: target }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return Promise.all(rows.map(async row => { try { return { role: row.role, sha256: sha(await readFile(row.file)) }; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { role: row.role, sha256: null }; throw error; } }));
}
const protectedBefore = await protectInventory();
const observations: Record<string, unknown> = {};
let bankFileEvidence: { unchanged: boolean; sha256: string } | undefined;
guardPrivateReads();
try {
  const context = await contextApi.loadInterviewContextAt(dataRoot, { writeManifest: false });
  observations.context = { status: 'returned', errorCount: context.errors.length, errorsSha256: jsonSha(context.errors), contextJsonSha256: jsonSha(context),
    stableContextJsonSha256: jsonSha({ ...context, questionStrategies: context.questionStrategies ? { ...context.questionStrategies, generatedAt: undefined } : context.questionStrategies }),
    comparisonOnlyExcludedFields: ['questionStrategies.generatedAt (existing runtime build timestamp; already excluded from catalogContentHash)'],
    sourceManifestSha256: jsonSha(context.manifest), studentEvidenceSha256: jsonSha(context.student.evidence), studentEvidenceCount: context.student.evidence.length,
    studentObjectivesSha256: jsonSha(context.studentObjectives), objectiveIdsSha256: jsonSha(context.studentObjectives?.map((row: { id: string }) => row.id)),
    objectiveCount: context.studentObjectives?.length ?? null, preparedActivitiesSha256: jsonSha(context.preparedActivities), trajectorySha256: jsonSha(context.studentTrajectory) };
  try { const source = await analysis.loadFullRecord(dataRoot, context.student.pdfSha256); observations.source = source === null ? { status: 'null' } : { status: 'returned', schemaVersion: source.schemaVersion, jsonSha256: jsonSha(source), contentSha256: source.contentSha256, pages: source.pages.length, blocks: source.blocks.length }; } catch (error) { observations.source = rejection(error); }
  try { const value = await analysis.loadFullStudentAnalysis(context, dataRoot); observations.analysis = value === null ? { status: 'null' } : { status: 'returned', commonSchemaVersion: value.common.schemaVersion, targetSchemaVersion: value.target.schemaVersion,
    commonJsonSha256: jsonSha(value.common), targetJsonSha256: jsonSha(value.target), evidenceJsonSha256: jsonSha(value.evidence), commonContentSha256: value.common.contentSha256, targetContentSha256: value.target.contentSha256,
    objectiveIdsSha256: jsonSha(value.target.objectives.map((row: { id: string }) => row.id)), anchorsSha256: jsonSha(value.target.objectives.map((row: { anchorRefs: unknown }) => row.anchorRefs)),
    runtimeObjectivesSha256: jsonSha(objectiveApi.createStudentObjectiveCandidates(context, context.preparedActivities)) }; } catch (error) { observations.analysis = rejection(error); }
  try {
    const identity = bankApi.questionBankIdentity(context), file = path.resolve(dataRoot, 'data/prepared/question-banks', identity.key + '.json');
    const before = sha(await readFile(file));
    const exported = await domainApi.readExistingDomainEnvelopes(context, { ownerId: ownerApi.localDevelopmentOwner().id, root: dataRoot });
    const candidates = exported.envelopes.filter((row: { kind: string }) => row.kind === 'prepared-main-candidate');
    const contracts = exported.envelopes.filter((row: { kind: string }) => row.kind === 'approved-question-contract');
    const parsed = candidates.map((row: { payloadJson: string }) => JSON.parse(row.payloadJson));
    observations.questionDomain = { status: 'returned', envelopeCount: exported.envelopes.length, candidateCount: candidates.length, approvedQuestionContractCount: contracts.length,
      orderedPayloadJsonSha256: jsonSha(exported.envelopes.map((row: { kind: string; payloadJson: string }) => [row.kind, row.payloadJson])),
      candidateIdsSha256: jsonSha(parsed.map((row: { id: string }) => row.id)), candidateQuestionAudioHashesSha256: jsonSha(parsed.map((row: { questionSha256: string; speechHash: string; audioSha256: string }) => [row.questionSha256, row.speechHash, row.audioSha256])),
      questionVerificationSha256: jsonSha(exported.questionVerification), transportScopeSha256: jsonSha(exported.scope), evaluationApprovalGranted: exported.evaluationApprovalGranted };
    const after = sha(await readFile(file)); assert.equal(after, before); bankFileEvidence = { unchanged: true, sha256: before };
  } catch (error) { observations.questionDomain = rejection(error); }
} catch (error) { observations.context = rejection(error); }
finally { restore(); }
const protectedAfter = await protectInventory(), sourceAfter = await moduleHashes();
assert.deepEqual(protectedAfter, protectedBefore, 'private source/canonical/manifest/pointer bytes must stay unchanged');
assert.deepEqual(sourceAfter, sourceBefore, 'source snapshot changed during evidence capture');
assert.equal(writesAttempted, 0); assert.equal(providerCallsAttempted, 0);
const report = { version: 'pr06a-independent-repository-evidence-v1', generatedAt: new Date().toISOString(), sourceRoot, sourceModuleHashes: sourceBefore,
  dependencyReuse: true, freshDependencyInstall: false, applicationModuleOrigin: 'explicit source-root; never imports live new repository helpers for baseline', privateRawTextOrIdsExported: false,
  readCalls, writesAttempted, toolingCacheWritesOutsideSourceAndData: toolingWrites, providerCallsAttempted, protectedFiles: protectedBefore, bankFileEvidence, protectedFilesUnchanged: true, sourceModulesUnchanged: true, observations };
await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, protectedFileCount: protectedBefore.length, writesAttempted, providerCallsAttempted, observations }, null, 2));
