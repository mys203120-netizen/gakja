/** Actual independent private session/context reads. No logger append, recovery
 * save, private export, credentials or provider request is performed. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { InterviewSession } from '../server/protocol';

async function main() {
  const flags = new Map(process.argv.slice(2).map(value => { const match = /^--(source-root|data-root|output)=(.+)$/u.exec(value); if (!match) throw new Error('PR06C_PRIVATE_FLAGS_INVALID'); return [match[1], match[2]]; }));
  for (const key of ['source-root', 'data-root', 'output']) if (!flags.has(key)) throw new Error('PR06C_PRIVATE_ROOT_OUTPUT_REQUIRED');
  const sourceRoot = path.resolve(flags.get('source-root')!), dataRoot = path.resolve(flags.get('data-root')!), output = path.resolve(flags.get('output')!);
  const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex'), jsonSha = (value: unknown) => sha(JSON.stringify(value) ?? '<undefined>');
  const moduleFiles = ['server/storage/local-session-store.ts', 'server/storage/conversation-log.ts', 'server/session-runtime.ts', 'scripts/review-interview-logs.ts'];
  const moduleHashes = async () => Object.fromEntries(await Promise.all(moduleFiles.map(async relative => [relative, sha(await readFile(path.join(sourceRoot, relative)))])));
  const modulesBefore = await moduleHashes();
  const groups = ['audio', 'prepared', 'sessions', 'session-contexts', 'conversation-logs', 'evaluation-jobs', 'local'];
  async function inventory() {
    const result = [];
    for (const category of groups) {
      const files: { fileNameSha256: string; bytes: number; sha256: string }[] = [];
      const visit = async (directory: string) => { let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; } for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) { const file = path.join(directory, entry.name); if (entry.isDirectory()) await visit(file); else if (entry.isFile()) { const hash = createHash('sha256'); let bytes = 0; for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; } files.push({ fileNameSha256: sha(path.relative(path.join(dataRoot, 'data', category), file).replaceAll('\\', '/')), bytes, sha256: hash.digest('hex') }); } } };
      await visit(path.join(dataRoot, 'data', category)); result.push({ category, files: files.length, bytes: files.reduce((sum, row) => sum + row.bytes, 0), fileIdentityAndBinarySha256: jsonSha(files) });
    }
    return result;
  }
  const protectedBefore = await inventory();
  await mkdir(path.dirname(output), { recursive: true }); const emptyCwd = await mkdtemp(path.join(path.dirname(output), 'pr06c-no-env-'));
  const originalCwd = process.cwd(); process.chdir(emptyCwd);
  const load = (relative: string) => import(pathToFileURL(path.join(sourceRoot, relative)).href);
  // The existing review module calls dotenv at import time. Import from an empty
  // owned cwd so no developer credential file is read, then call only its parser.
  let storeApi, runtimeApi, reviewApi;
  try { [storeApi, runtimeApi, reviewApi] = await Promise.all([load('server/storage/local-session-store.ts'), load('server/session-runtime.ts'), load('scripts/review-interview-logs.ts')]); }
  finally { process.chdir(originalCwd); }
  const store = new storeApi.LocalSessionStore(path.join(dataRoot, 'data/sessions'));
  const nativeFs = createRequire(import.meta.url)('node:fs/promises'), keys = ['writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm', 'copyFile', 'open'];
  const originalFs = Object.fromEntries(keys.map(key => [key, nativeFs[key]])), fetch = globalThis.fetch; let privateWriteAttempts = 0, networkAttempts = 0;
  for (const key of keys) nativeFs[key] = async (...args: unknown[]) => {
    const writeOpen = key === 'open' && typeof args[1] === 'string' && /[wa+]/u.test(args[1]);
    if (key !== 'open' || writeOpen) {
      const paths = (key === 'rename' || key === 'copyFile' ? args.slice(0, 2) : args.slice(0, 1)).filter(value => typeof value === 'string') as string[];
      if (paths.some(value => [sourceRoot, dataRoot].some(root => { const relative = path.relative(root, path.resolve(value)); return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative); }))) { privateWriteAttempts++; throw new Error('PR06C_PRIVATE_WRITE_BLOCKED'); }
    }
    return originalFs[key](...args);
  };
  globalThis.fetch = async () => { networkAttempts++; throw new Error('PR06C_NETWORK_BLOCKED'); }; syncBuiltinESMExports();
  const sessionRows = [], logRows = [], contextRows = [], listRows = []; const owners = new Set<string>(), contextPins = new Map<string, { ownerId: string; digest: string }>();
  const rejection = (error: unknown) => { const row = error as Error & { code?: string }; return { status: 'rejected', name: row.name, code: row.code ?? (/^[A-Z0-9_]+$/u.test(row.message) ? row.message : null), errorMessageSha256: sha(row.message.replaceAll(dataRoot, '<private-root>')) }; };
  try {
    const files = (await readdir(path.join(dataRoot, 'data/sessions'))).filter(file => /^[0-9a-f-]{36}\.json$/iu.test(file));
    for (const file of files) {
      const raw = JSON.parse(await readFile(path.join(dataRoot, 'data/sessions', file), 'utf8')) as InterviewSession, id = file.slice(0, -5), ownerId = raw.runtime?.owner?.id ?? 'explicit-inspection-unknown-owner';
      owners.add(ownerId); let outcome;
      try { const loaded = await store.load(id, ownerId) as InterviewSession | null; assert.ok(loaded); outcome = { status: 'returned', payloadJsonSha256: jsonSha(loaded), exactOriginalObject: JSON.stringify(loaded) === JSON.stringify(raw),
        recoveryProjectionSha256: jsonSha(runtimeApi.recoveryProjection(loaded)), checkpointSha256: jsonSha(loaded.runtime?.checkpoint), frozenInputSha256: jsonSha([loaded.runtime?.acceptedEndRequest, loaded.runtime?.evaluationInputFrozenAt, loaded.runtime?.evaluationJob]),
        sourceBankAnalysisPinsSha256: jsonSha([loaded.sourceManifest, loaded.plan, loaded.runtime?.contextSnapshotSha256]), statusValue: loaded.status, turnCount: loaded.turns.length };
        if (loaded.runtime?.contextSnapshotSha256) contextPins.set(ownerId + ':' + loaded.runtime.contextSnapshotSha256, { ownerId, digest: loaded.runtime.contextSnapshotSha256 });
      } catch (error) { outcome = rejection(error); }
      let wrongOwner; try { await store.load(id, ownerId + ':explicit-wrong-owner'); wrongOwner = { status: 'returned' }; } catch (error) { wrongOwner = rejection(error); }
      sessionRows.push({ identitySha256: sha(id), outcome, wrongOwner });
      let log = ''; try { log = await readFile(path.join(dataRoot, 'data/conversation-logs', id + '.jsonl'), 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const parsed = reviewApi.parseConversationJsonl(log); const matching = parsed.rows.filter((row: { sessionId?: string }) => row.sessionId === id);
      logRows.push({ identitySha256: sha(id), physicalTextSha256: sha(log), parsedRowsSha256: jsonSha(parsed.rows), matchingSessionRowsSha256: jsonSha(matching), malformedLines: parsed.malformedLines,
        orderedSeqAndEventBindingsSha256: jsonSha(parsed.rows.map((row: { seq?: number; eventId?: string; turnId?: string; answerId?: string }) => [row.seq, row.eventId, row.turnId, row.answerId])), finalNewline: log.endsWith('\n') });
    }
    for (const ownerId of owners) {
      try { const rows = await store.list(ownerId) as InterviewSession[]; listRows.push({ ownerIdentitySha256: sha(ownerId), status: 'returned', count: rows.length, orderedSessionIdentityAndPayloadSha256: jsonSha(rows) }); }
      catch (error) { listRows.push({ ownerIdentitySha256: sha(ownerId), ...rejection(error) }); }
    }
    for (const { ownerId, digest } of contextPins.values()) {
      try { const context = await store.loadContext(digest, ownerId); contextRows.push({ identitySha256: sha(ownerId + ':' + digest), status: 'returned', exactSnapshotHashMatches: runtimeApi.snapshotHash(context) === digest,
        payloadJsonSha256: jsonSha(context), manifestAndObjectivesSha256: jsonSha([context.manifest, context.studentObjectives]), studentAnalysisAndTargetSha256: jsonSha([context.student, context.studentAnalysis, context.targetAnalysis]) }); }
      catch (error) { contextRows.push({ identitySha256: sha(ownerId + ':' + digest), ...rejection(error) }); }
    }
  } finally { for (const [key, value] of Object.entries(originalFs)) nativeFs[key] = value; globalThis.fetch = fetch; syncBuiltinESMExports(); }
  const protectedAfter = await inventory(); assert.deepEqual(protectedAfter, protectedBefore); assert.deepEqual(await moduleHashes(), modulesBefore); assert.equal(privateWriteAttempts, 0); assert.equal(networkAttempts, 0);
  const observations = { sessionCount: sessionRows.length, sessionReadAndOwnerOutcomesSha256: jsonSha(sessionRows), ownerListCount: listRows.length, ownerListOutcomesSha256: jsonSha(listRows),
    referencedContextCount: contextRows.length, contextReadAndExactPinsSha256: jsonSha(contextRows), logFileSlots: logRows.length, existingParserOrderedReadSha256: jsonSha(logRows),
    sessionOutcomeCounts: sessionRows.reduce<Record<string, number>>((counts, row) => { counts[row.outcome.status] = (counts[row.outcome.status] ?? 0) + 1; return counts; }, {}),
    contextOutcomeCounts: contextRows.reduce<Record<string, number>>((counts, row) => { counts[row.status] = (counts[row.status] ?? 0) + 1; return counts; }, {}) };
  const report = { version: 'pr06c-independent-private-session-context-log-read-v1', generatedAt: new Date().toISOString(), sourceRoot, sourceModuleHashes: modulesBefore, dependencyReuse: true, freshInstall: false,
    privateAssetsCopied: false, privateRawTextOrIdsExported: false, originalFilesUnchanged: true, sourceModulesUnchanged: true, privateWriteAttempts, networkAttempts, protectedGroups: protectedBefore, observations,
    limitations: ['Actual LocalSessionStore load/list/loadContext and runtime recovery projection; no recovery save or event emission.', 'Private logs use the existing offline JSONL parser in recorded order. Logs remain auxiliary observations; no new replay/state reconstruction, logger append or correction is performed.', 'Only session-referenced contexts are loaded; all session-context files are additionally protected by physical file/binary inventory.'] };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ output, observations, privateWriteAttempts, networkAttempts }, null, 2));
}
main().catch(error => { const message = error instanceof Error ? error.message : String(error); console.error(JSON.stringify({ status: 'failed', code: /^[A-Z0-9_]+$/u.test(message) ? message : null, errorMessageSha256: createHash('sha256').update(message).digest('hex') })); process.exitCode = 1; });
