/** Explicit offline, source-pinned candidate -> committed runtime QA. */
import dotenv from 'dotenv';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureLatestRequests, latestHumanLabels } from './benchmark-latest-interview';
import { classifySingleCoreAnswerCandidate, runSingleCoreRuntime } from '../server/providers/single-core-runtime';
import { mayAskFollowUp } from '../server/interview-planner';
import { mayAskClarification, mayReplayQuestion, safeProviderError } from '../server/protocol';
import { createTurnWorkContext } from '../server/turn-work';
import { assertQuestionContractIntegrity } from '../server/question-objective';
import { loadOfflineSemanticBinding, semanticEngineSources, semanticHash } from './lib/semantic-release-gate';
import type { ProviderUsageObservation } from '../server/observability/provider-cost';

const sourcePaths = { session: 'data/sessions/8f54631b-d1ce-404a-97ba-17394fd111b9.json', journal: 'data/conversation-logs/8f54631b-d1ce-404a-97ba-17394fd111b9.jsonl' };
const expectedSourceHashes = { session: '314738be844dedad0156f59c134ec8de56670dfa97d4e1ffdccd5a90fd3b62e1', journal: '032bcd26063c92e5cb4b608d369c550a22416fcd20110aa6a837d8fdd45d20b1' };
const supportFiles = ['scripts/verify-followup-final-runtime.ts', 'scripts/benchmark-latest-interview.ts', 'scripts/lib/semantic-release-gate.ts', 'package-lock.json', 'interview-files.mjs'];
const supportSources = async () => Object.fromEntries(await Promise.all(supportFiles.map(async file => [file, semanticHash(await readFile(file))])));

export function finalRuntimeQaOptions(args: string[]) {
  const value = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const only = (value('only') ?? '6,14').split(',').map(Number);
  const repeats = Number(value('repeats') ?? 3);
  const output = value('out');
  if (only.some(n => !Number.isInteger(n) || !latestHumanLabels[n]) || new Set(only).size !== only.length ||
    !Number.isInteger(repeats) || repeats < 1 || repeats > 5 || only.length * repeats > 30 ||
    !output || !/^artifacts\/followup-final-runtime-[a-zA-Z0-9-]+\.json$/u.test(output)) throw new Error('FINAL_RUNTIME_QA_OPTIONS_INVALID');
  return { runLive: args.includes('--run-live'), only, repeats, output };
}

async function main() {
  const args = process.argv.slice(2), options = finalRuntimeQaOptions(args);
  if (!options.runLive) throw new Error('EXPLICIT_RUN_LIVE_REQUIRED');
  dotenv.config({ path: '.env.local', quiet: true });
  const identity = await loadOfflineSemanticBinding(args);
  for (const kind of ['session', 'journal'] as const) if (semanticHash(await readFile(sourcePaths[kind])) !== expectedSourceHashes[kind]) throw new Error('FINAL_RUNTIME_QA_HISTORICAL_SOURCE_CHANGED');
  const sources = await semanticEngineSources(process.cwd());
  const support = await supportSources();
  const handle = await open(options.output, 'wx', 0o600);
  const cases: Array<Record<string, unknown>> = [];
  const report = { version: 'followup-final-runtime-qa-v1', startedAt: new Date().toISOString(), completedAt: null as string | null,
    semanticReleaseIdentity: identity, engineSourceSha256: sources, engineSourceUnchanged: true,
    supportSourceSha256: support, supportSourceUnchanged: true, engineSourceSha256After: null as Record<string, string> | null,
    supportSourceSha256After: null as Record<string, string> | null, sourceCapture: null as Record<string, unknown> | null,
    provisional: identity === null, productionReleaseApproved: false, reviewerProvenance: 'model_review_required_not_human_signoff',
    coreReasoningEffort: 'low', coreTimeoutMs: 15000, maxOutputTokens: 2000, maxRetries: 0,
    scope: 'exact historical Q/A and prefix; real candidate + source-bound next runtime, excludes STT/TTS/browser',
    latencyLimitations: ['Own requests run sequentially. A separate root latency experiment may run concurrently with the same provider key; timings are not an isolated latency comparison.'],
    sourceRecordsModified: false, semanticReviewRequired: true, cases };
  const save = async () => { await handle.truncate(0); await handle.write(JSON.stringify(report, null, 2), 0, 'utf8'); await handle.sync(); };
  try {
    await save();
    const capture = await captureLatestRequests(process.cwd(), 'final-runtime-qa', { onCheckpoint: async (context, checkpoint, number, revision) => {
      if (revision !== undefined || !options.only.includes(number)) return;
      for (let repeat = 1; repeat <= options.repeats; repeat++) {
        const session = structuredClone(checkpoint), current = session.turns.at(-1)!;
        const raw = current.rawTranscript ?? '', captureRevision = current.metadata.answerCaptureRevision ?? 1;
        current.metadata.answerCaptureRevision = captureRevision;
        current.transcriptStatus = 'paused';
        const work = createTurnWorkContext({ attemptId: `offline-final-runtime-Q${number}-${repeat}`, timeoutMs: 95000 });
        const started = performance.now();
        const providerUsage: Array<{stage: string; observation: ProviderUsageObservation}> = [];
        const opts = { engineMode: 'single_core' as const, policyMode: 'compiled' as const, coreReasoningEffort: 'low' as const,
          allowFollowUp: mayAskFollowUp(session, session.durationSeconds ?? 720, 2),
          allowClarification: mayAskClarification(session, session.durationSeconds ?? 720),
          allowReplay: mayReplayQuestion(session, session.durationSeconds ?? 720), workContext: work,
          onProviderUsage: (stage: 'core' | 'review' | 'repair', observation: ProviderUsageObservation) => { providerUsage.push({stage, observation}); } };
        const row: Record<string, unknown> = { id: `Q${number}`, repeat, question: current.questionText, rawTranscript: raw,
          sourceQuestionSha256: semanticHash(current.questionText), sourceAnswerSha256: semanticHash(raw),
          historicalPrefixSha256: semanticHash(JSON.stringify(session.turns.slice(0, -1))),
          questionContractSha256: semanticHash(JSON.stringify(current.metadata.approvedQuestion)),
          approvedQuestionContentSha256: current.metadata.approvedQuestion?.contentSha256 ?? null,
          sourceTurnId: current.id, sourceAnswerId: current.answerId, prefixTurnIds: session.turns.map(turn => turn.id),
          endingObservation: current.metadata.answerEndingObservation ?? null, captureRevision,
          captureRevisionOrigin: checkpoint.turns.at(-1)!.metadata.answerCaptureRevision === undefined ? 'isolated_replay_default' : 'historical',
          expected: latestHumanLabels[number], result: null, providerUsage, failure: null, wallMs: null };
        try {
          const candidate = await classifySingleCoreAnswerCandidate(context, session, { text: raw, captureRevision,
            endingObservation: current.metadata.answerEndingObservation }, opts);
          row.candidate = candidate;
          current.transcriptStatus = 'finalized';
          const result = await runSingleCoreRuntime(context, session, { ...opts, pendingCandidateDecision: candidate });
          if (result.draft?.approvedQuestion) assertQuestionContractIntegrity(result.draft, result.draft.approvedQuestion);
          row.result = result;
          row.finalQuestionSha256 = result.draft ? semanticHash(result.draft.questionText) : null;
          row.labelCheck = { structuralLabelsPassed: latestHumanLabels[number].actions.includes(result.execution?.action as typeof candidate.semanticDecision.next.action) &&
            (!latestHumanLabels[number].coverage || latestHumanLabels[number].coverage!.includes(result.semanticDecision?.assessment?.coverage ?? '')), manualReviewRequired: true };
          if (result.execution?.status !== 'ready') row.failure = result.failureDetail ?? 'FINAL_RUNTIME_BLOCKED';
        } catch (error) { row.failure = safeProviderError(error); }
        finally { work.complete(); }
        // Let cancellation-triggered SDK usage observers report their failed attempts.
        await new Promise(resolve => setImmediate(resolve));
        row.observedProviderCalls = { core: providerUsage.filter(item => item.stage === 'core').length, review: providerUsage.filter(item => item.stage === 'review').length, repair: providerUsage.filter(item => item.stage === 'repair').length };
        if (providerUsage.filter(item => item.stage === 'core').length !== 1) row.callCountFailure = 'CORE_CALL_COUNT_NOT_ONE';
        row.sourcePreserved = { rawAnswer: current.rawTranscript === raw, question: semanticHash(current.questionText) === row.sourceQuestionSha256,
          history: semanticHash(JSON.stringify(session.turns.slice(0, -1))) === row.historicalPrefixSha256,
          approvedQuestion: semanticHash(JSON.stringify(current.metadata.approvedQuestion)) === row.questionContractSha256,
          endingObservation: JSON.stringify(current.metadata.answerEndingObservation ?? null) === JSON.stringify(row.endingObservation) };
        if (Object.values(row.sourcePreserved as Record<string, boolean>).some(value => !value)) row.sourceFailure = 'SOURCE_CHANGED_DURING_FINAL_RUNTIME';
        row.wallMs = performance.now() - started; cases.push(row); await save();
        console.log(JSON.stringify({ id: row.id, repeat, wallMs: Math.round(Number(row.wallMs)), failure: row.failure,
          action: (row.result as {execution?: {action?: string}} | null)?.execution?.action ?? null, calls: providerUsage.map(item => item.stage) }));
      }
    } });
    report.sourceCapture = { sourcePath: capture.sourcePath, sourceSha256: capture.sourceSha256, journalPath: capture.journalPath, journalSha256: capture.journalSha256,
      contextManifestSha256: capture.contextManifestSha256, engineVersion: capture.engineVersion, contractVersion: capture.contractVersion,
      totalCapturedCheckpoints: capture.cases.length, selectedCheckpoints: capture.cases.filter(row => row.captureRevision === undefined && options.only.includes(row.number)).map(row => ({ id: row.id, turnId: row.turnId, answerId: row.answerId,
        questionSha256: row.questionSha256, transcriptSha256: row.transcriptSha256, requestSha256: row.requestSha256, elapsedMs: row.elapsedMs, endingObservation: row.endingObservation })), sourceRecordsModified: false };
    const after = await semanticEngineSources(process.cwd()), supportAfter = await supportSources();
    report.engineSourceUnchanged = JSON.stringify(sources) === JSON.stringify(after);
    report.supportSourceUnchanged = JSON.stringify(support) === JSON.stringify(supportAfter);
    if (!report.engineSourceUnchanged) report.engineSourceSha256After = after;
    if (!report.supportSourceUnchanged) report.supportSourceSha256After = supportAfter;
    report.completedAt = new Date().toISOString(); await save();
    if (!report.engineSourceUnchanged || !report.supportSourceUnchanged || cases.some(row => row.failure || row.callCountFailure || row.sourceFailure)) process.exitCode = 1;
    console.log(JSON.stringify({ output: options.output, attempts: cases.length, failures: cases.filter(row => row.failure).length, engineSourceUnchanged: report.engineSourceUnchanged }));
  } finally { await handle.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
