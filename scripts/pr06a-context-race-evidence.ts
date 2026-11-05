/** Private context race injection is memory-only. No private IDs/text are output. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const flags = new Map(process.argv.slice(2).map(argument => { const match = /^--(source-root|data-root|output|normal-evidence)=(.+)$/u.exec(argument); if (!match) throw new Error('PR06A_RACE_FLAGS_INVALID'); return [match[1], match[2]]; }));
for (const key of ['source-root', 'data-root', 'output']) if (!flags.has(key)) throw new Error('PR06A_RACE_EXPLICIT_ROOT_OUTPUT_REQUIRED');
const sourceRoot = path.resolve(flags.get('source-root')!), dataRoot = path.resolve(flags.get('data-root')!), output = path.resolve(flags.get('output')!);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const jsonSha = (value: unknown) => sha(JSON.stringify(value));
const pointerFile = path.join(dataRoot, 'data/prepared/student-analysis-current.json');
const pointerBytes = await readFile(pointerFile), pointer = JSON.parse(pointerBytes.toString('utf8'));
const documentFile = path.resolve(dataRoot, pointer.path), documentBytes = await readFile(documentFile);
const virtualFile = path.join(dataRoot, 'data/prepared/student-analysis-revisions/pr06a-virtual-race/analysis.json');
const virtualPointer = JSON.stringify({ ...pointer, path: path.relative(dataRoot, virtualFile) });
const virtualDocument = JSON.parse(documentBytes.toString('utf8'));
virtualDocument.target.revision = 'explicit-synthetic-in-memory-race-revision';
const { contentSha256: ignored, ...targetBody } = virtualDocument.target; void ignored; virtualDocument.target.contentSha256 = jsonSha(targetBody);
const virtualBytes = JSON.stringify(virtualDocument);
const sourcePointerFile = path.join(dataRoot, 'data/prepared/full-record-current.json'), sourcePointerBytes = await readFile(sourcePointerFile), sourcePointer = JSON.parse(sourcePointerBytes.toString('utf8'));
const sourceDocumentFile = path.resolve(dataRoot, sourcePointer.path), sourceDocumentBytes = await readFile(sourceDocumentFile);
const virtualSourceFile = path.join(dataRoot, 'data/prepared/record-revisions/pr06a-virtual-race/source.json'), virtualSource = JSON.parse(sourceDocumentBytes.toString('utf8'));
virtualSource.revision = 'explicit-synthetic-in-memory-raced-source'; const { contentSha256: ignoredSource, ...sourceBody } = virtualSource; void ignoredSource; virtualSource.contentSha256 = jsonSha(sourceBody);
const virtualSourceBytes = JSON.stringify(virtualSource), virtualSourcePointer = JSON.stringify({ ...sourcePointer, path: path.relative(dataRoot, virtualSourceFile), contentSha256: virtualSource.contentSha256 });
const normalEvidence = flags.has('normal-evidence') ? JSON.parse(await readFile(path.resolve(flags.get('normal-evidence')!), 'utf8')) : null;
if (normalEvidence) { assert.equal(path.resolve(normalEvidence.sourceRoot), sourceRoot); assert.equal(typeof normalEvidence.observations.context.stableContextJsonSha256, 'string'); }
const api = await import(pathToFileURL(path.join(sourceRoot, 'server/data/load-interview-context.ts')).href);
const nativeFs = createRequire(import.meta.url)('node:fs/promises');
const keys = ['readFile', 'writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm', 'copyFile'];
const originals = Object.fromEntries(keys.map(key => [key, nativeFs[key]]));
const results = [];
for (const fault of ['pointer', 'document', 'source_pointer']) {
  let pointerReads = 0, documentReads = 0, sourcePointerReads = 0, sourceDocumentReads = 0, faultDelivered = false, writesAttempted = 0, providerCallsAttempted = 0;
  nativeFs.readFile = async (...args: unknown[]) => {
    const file = typeof args[0] === 'string' ? path.resolve(args[0]) : '';
    if (file === virtualFile) { faultDelivered = true; return args[1] === 'utf8' ? virtualBytes : Buffer.from(virtualBytes); }
    if (file === virtualSourceFile) { faultDelivered = true; return args[1] === 'utf8' ? virtualSourceBytes : Buffer.from(virtualSourceBytes); }
    const bytes = await originals.readFile(...args);
    if (file === pointerFile) { pointerReads++; if (fault === 'pointer' && pointerReads > 1) { faultDelivered = true; return typeof bytes === 'string' ? virtualPointer : Buffer.from(virtualPointer); } }
    if (file === documentFile) { documentReads++; if (fault === 'document' && documentReads > 1) { faultDelivered = true; return typeof bytes === 'string' ? virtualBytes : Buffer.from(virtualBytes); } }
    if (file === sourcePointerFile) { sourcePointerReads++; if (fault === 'source_pointer' && sourcePointerReads > 1) { faultDelivered = true; return typeof bytes === 'string' ? virtualSourcePointer : Buffer.from(virtualSourcePointer); } }
    if (file === sourceDocumentFile) sourceDocumentReads++;
    return bytes;
  };
  for (const key of keys.filter(key => key !== 'readFile')) nativeFs[key] = async (...args: unknown[]) => {
    const paths = (key === 'rename' || key === 'copyFile' ? args.slice(0, 2) : args.slice(0, 1)).filter(value => typeof value === 'string') as string[];
    if (paths.some(value => [sourceRoot, dataRoot].some(root => { const relative = path.relative(root, path.resolve(value)); return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative); }))) { writesAttempted++; throw new Error('PR06A_RACE_WRITE_BLOCKED'); }
    return originals[key](...args);
  };
  const fetch = globalThis.fetch; globalThis.fetch = async () => { providerCallsAttempted++; throw new Error('PR06A_RACE_PROVIDER_BLOCKED'); }; syncBuiltinESMExports();
  try {
    const context = await api.loadInterviewContextAt(dataRoot, { writeManifest: false });
    const stableContextJsonSha256 = jsonSha({ ...context, questionStrategies: context.questionStrategies ? { ...context.questionStrategies, generatedAt: undefined } : context.questionStrategies });
    const acceptedContextMatchesNormal = context.errors.length ? null : normalEvidence ? stableContextJsonSha256 === normalEvidence.observations.context.stableContextJsonSha256 : null;
    results.push({ fault, status: context.errors.length ? 'rejected_context' : 'returned_context', errorCount: context.errors.length, errorsSha256: jsonSha(context.errors),
      explicitRaceError: context.errors.includes('FULL_ANALYSIS_MANIFEST_REVISION_CHANGED'), contextJsonSha256: jsonSha(context), objectivesSha256: jsonSha(context.studentObjectives),
      pointerReads, documentReads, sourcePointerReads, sourceDocumentReads, virtualSwitchCommittedAfterFirstRead: fault === 'source_pointer' ? sourcePointerReads > 0 : fault === 'pointer' ? pointerReads > 0 : documentReads > 0,
      faultDeliveredOnLaterRead: faultDelivered, stableContextJsonSha256, acceptedContextMatchesNormal, writesAttempted, providerCallsAttempted });
  } catch (error) {
    const row = error as Error;
    results.push({ fault, status: 'rejected_exception', errorName: row.name, errorCode: /^[A-Z0-9_]+$/u.test(row.message) ? row.message : null,
      errorMessageSha256: sha(row.message), pointerReads, documentReads, sourcePointerReads, sourceDocumentReads, faultDeliveredOnLaterRead: faultDelivered, writesAttempted, providerCallsAttempted });
  } finally { for (const [key, value] of Object.entries(originals)) nativeFs[key] = value; globalThis.fetch = fetch; syncBuiltinESMExports(); }
  assert.equal(writesAttempted, 0); assert.equal(providerCallsAttempted, 0);
  const result: { status: string; acceptedContextMatchesNormal?: boolean | null } = results.at(-1)!;
  if (result.status === 'returned_context' && normalEvidence) assert.equal(result.acceptedContextMatchesNormal, true, 'race must not return a mixed context');
}
assert.equal(sha(await readFile(pointerFile)), sha(pointerBytes)); assert.equal(sha(await readFile(documentFile)), sha(documentBytes));
assert.equal(sha(await readFile(sourcePointerFile)), sha(sourcePointerBytes)); assert.equal(sha(await readFile(sourceDocumentFile)), sha(sourceDocumentBytes));
const report = { version: 'pr06a-independent-context-race-v1', generatedAt: new Date().toISOString(), sourceRoot,
  contextModuleSha256: sha(await readFile(path.join(sourceRoot, 'server/data/load-interview-context.ts'))), dependencyReuse: true, freshInstall: false,
  privateAssetsCopied: false, privateRawTextOrIdsExported: false, protectedPointerSha256: sha(pointerBytes), protectedDocumentSha256: sha(documentBytes),
  protectedSourcePointerSha256: sha(sourcePointerBytes), protectedSourceDocumentSha256: sha(sourceDocumentBytes), originalFilesUnchanged: true, results };
await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
