/** Independent PR06-B private read-only observations. Reports hashes/counts,
 * never private names, IDs, text, credentials or raw storage paths. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PreparedQuestionBank } from '../server/data/prepared-question-bank';

async function main() {
  const flags = new Map(process.argv.slice(2).map(argument => { const match = /^--(source-root|data-root|output)=(.+)$/u.exec(argument); if (!match) throw new Error('PR06B_PRIVATE_FLAGS_INVALID'); return [match[1], match[2]]; }));
  for (const key of ['source-root', 'data-root', 'output']) if (!flags.has(key)) throw new Error('PR06B_EXPLICIT_ROOT_OUTPUT_REQUIRED');
  const sourceRoot = path.resolve(flags.get('source-root')!), dataRoot = path.resolve(flags.get('data-root')!), output = path.resolve(flags.get('output')!);
  const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex'), jsonSha = (value: unknown) => sha(JSON.stringify(value));
  const moduleFiles = ['server/data/prepared-question-bank.ts', 'server/providers/speech-audio-cache.ts', 'server/providers/clova-tts.ts', 'server/providers/approved-audio-replay.ts', 'server/data/load-interview-context.ts'];
  const moduleHashes = async () => Object.fromEntries(await Promise.all(moduleFiles.map(async relative => [relative, sha(await readFile(path.join(sourceRoot, relative)))])));
  const modulesBefore = await moduleHashes();
  async function fileHash(file: string) { const hash = createHash('sha256'); let bytes = 0; for await (const chunk of createReadStream(file)) { bytes += chunk.length; hash.update(chunk); } return { bytes, sha256: hash.digest('hex') }; }
  const groups = ['audio', 'prepared', 'sessions', 'session-contexts', 'conversation-logs', 'evaluation-jobs', 'local'];
  async function inventory() {
    const result = [];
    for (const category of groups) {
      const files: { fileNameSha256: string; bytes: number; sha256: string }[] = [];
      const visit = async (directory: string) => { let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; } for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) { const file = path.join(directory, entry.name); if (entry.isDirectory()) await visit(file); else if (entry.isFile()) files.push({ fileNameSha256: sha(path.relative(path.join(dataRoot, 'data', category), file).replaceAll('\\', '/')), ...await fileHash(file) }); } };
      await visit(path.join(dataRoot, 'data', category)); result.push({ category, files: files.length, bytes: files.reduce((sum, row) => sum + row.bytes, 0), fileIdentityAndBinarySha256: jsonSha(files) });
    }
    return result;
  }
  const protectedBefore = await inventory();
  const load = (relative: string) => import(pathToFileURL(path.join(sourceRoot, relative)).href);
  const [contextApi, bankApi, speechApi, replayApi, ownerApi] = await Promise.all([load('server/data/load-interview-context.ts'), load('server/data/prepared-question-bank.ts'), load('server/providers/clova-tts.ts'), load('server/providers/approved-audio-replay.ts'), load('server/session-runtime.ts')]);
  const nativeFs = createRequire(import.meta.url)('node:fs/promises'), keys = ['writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm', 'copyFile'];
  const originalFs = Object.fromEntries(keys.map(key => [key, nativeFs[key]])); const originalFetch = globalThis.fetch;
  let privateWriteAttempts = 0, networkAttempts = 0;
  for (const key of keys) nativeFs[key] = async (...args: unknown[]) => {
    const paths = (key === 'rename' || key === 'copyFile' ? args.slice(0, 2) : args.slice(0, 1)).filter(value => typeof value === 'string') as string[];
    if (paths.some(value => [sourceRoot, dataRoot].some(root => { const relative = path.relative(root, path.resolve(value)); return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative); }))) { privateWriteAttempts++; throw new Error('PR06B_PRIVATE_WRITE_BLOCKED'); }
    return originalFs[key](...args);
  };
  globalThis.fetch = async () => { networkAttempts++; throw new Error('PR06B_NETWORK_BLOCKED'); }; syncBuiltinESMExports();
  let observations;
  try {
    const context = await contextApi.loadInterviewContextAt(dataRoot, { writeManifest: false }); assert.deepEqual(context.errors, []);
    const bank = await bankApi.loadQuestionBank(context, { root: dataRoot }) as PreparedQuestionBank | null; assert.ok(bank, 'PR06B_EXISTING_BANK_REQUIRED');
    const candidates = bank.slots.flatMap(row => row.candidates);
    const plan = bankApi.createSessionQuestionPlan(context, bank, { sessionSeed: 'explicit-pr06b-private-read-seed' });
    const pinned = await bankApi.loadQuestionBankByPinnedPlan(context, plan, { root: dataRoot }); assert.ok(pinned); assert.equal(JSON.stringify(pinned), JSON.stringify(bank));
    const session = { id: 'explicit-pr06b-read-only-session', target: context.target, plan, turns: [] as unknown[] };
    const selection: unknown[] = []; const audioRows: unknown[] = [];
    for (let index = 1; index <= Math.min(5, plan.slots.length); index++) {
      const selected = bankApi.selectNextPreparedMainQuestion(bank, session); if (!selected) break;
      selection.push({ candidateId: selected.candidateId, bankKey: selected.bankKey, variant: selected.variant, draft: selected.draft, slot: selected.slot, audioUrl: selected.audioUrl });
      session.turns.push({ id: 'explicit-pr06b-selected-' + index, questionKind: 'main', questionText: selected.draft.questionText, parentMainQuestionId: 'explicit-pr06b-selected-' + index, mainIndex: index,
        evidenceIds: selected.draft.evidenceIds, questionAudioUrl: selected.audioUrl, transcriptStatus: 'finalized', rawTranscript: '', metadata: { ...selected.draft, activityIds: selected.slot.activityIds, rulesVersion: context.manifest.rulesVersion } });
    }
    for (const candidate of candidates) {
      const id = candidate.speechHash, bytes = await speechApi.readSpeechAudio(id), durable = await speechApi.readDurableSpeechAudio(id);
      assert.ok(bytes?.length); assert.ok(durable?.equals(bytes)); assert.equal(sha(bytes), candidate.audioSha256);
      audioRows.push({ speechHash: id, audioSha256: sha(bytes), bytes: bytes.length, settings: candidate.voiceSettings, questionSha256: candidate.questionSha256 });
    }
    const replay = replayApi.approvedAudioReplay(context, session);
    observations = { contextStableJsonSha256: jsonSha({ ...context, questionStrategies: context.questionStrategies ? { ...context.questionStrategies, generatedAt: undefined } : context.questionStrategies }),
      contextRawJsonSha256: jsonSha(context), contextComparisonOnlyExcluded: ['questionStrategies.generatedAt: existing per-read timestamp, not catalogContentHash'],
      sourceManifestSha256: jsonSha(context.manifest), runtimeObjectivesSha256: jsonSha(context.studentObjectives),
      bankKeySha256: sha(bank.key), bankDomainJsonSha256: jsonSha(bank), bankContentSha256: bank.contentSha256, candidateCount: candidates.length,
      orderedCandidateIdentityContractHashesSha256: jsonSha(candidates.map((row: { id: string; draft: unknown; questionSha256: string; speechHash: string; audioSha256: string }) => [row.id, row.draft, row.questionSha256, row.speechHash, row.audioSha256])),
      sessionPlanSha256: jsonSha(plan), selectionCount: selection.length, orderedSelectionSha256: jsonSha(selection), pinnedBankExact: true,
      actualSpeechCacheCallerReadCount: audioRows.length, durableAndPlaybackAudioRowsSha256: jsonSha(audioRows),
      approvedReplayAccepted: Boolean(replay), approvedReplaySha256: replay ? jsonSha(replay) : null,
      localOwnerMode: ownerApi.localDevelopmentOwner().mode, evaluationApprovalGranted: false };
  } finally { for (const [key, value] of Object.entries(originalFs)) nativeFs[key] = value; globalThis.fetch = originalFetch; syncBuiltinESMExports(); }
  const protectedAfter = await inventory(), modulesAfter = await moduleHashes();
  assert.deepEqual(protectedAfter, protectedBefore, 'private original file/binary bytes changed'); assert.deepEqual(modulesAfter, modulesBefore, 'source code changed during evidence capture');
  assert.equal(privateWriteAttempts, 0); assert.equal(networkAttempts, 0);
  const report = { version: 'pr06b-independent-private-bank-audio-v1', generatedAt: new Date().toISOString(), sourceRoot, sourceModuleHashes: modulesBefore,
    dependencyReuse: true, freshInstall: false, privateRawTextOrIdsExported: false, privateAssetsCopied: false, privateWriteAttempts, networkAttempts,
    originalFilesUnchanged: true, sourceModulesUnchanged: true, protectedGroups: protectedBefore, observations };
  await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, observations, protectedGroups: protectedBefore, privateWriteAttempts, networkAttempts }, null, 2));
}
main().catch(error => { const message = error instanceof Error ? error.message : String(error); console.error(JSON.stringify({ status: 'failed', code: /^[A-Z0-9_]+$/u.test(message) ? message : null, errorMessageSha256: createHash('sha256').update(message).digest('hex') })); process.exitCode = 1; });
