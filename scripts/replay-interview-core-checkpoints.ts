import dotenv from 'dotenv';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadInterviewContext, type InterviewContext } from '../server/data/load-interview-context';
import { loadQuestionBank } from '../server/data/prepared-question-bank';
import { mayAskFollowUp } from '../server/interview-planner';
import { mayAskClarification, mayReplayQuestion, type InterviewSession } from '../server/protocol';
import { assertQuestionContractIntegrity } from '../server/question-objective';
import { createSessionRuntime } from '../server/session-runtime';
import { assertRealtimeCoreSource } from '../server/providers/realtime-core';
import { runStrategyRealtimeCore } from '../server/providers/realtime-strategy-core';
import { maskConversationSecrets } from '../server/storage/conversation-log';
import { interviewConfig } from '../interview.config';
import { assertReplayBank, replayEngineSourceFingerprints, replayHash, type ReplayBaseline } from './live-e2e-replay';

type Data = Record<string, any>;
const baselinePaths = [
  'artifacts/live-interview-e2e-20261103T125013Z-conversation.json',
  'artifacts/live-interview-e2e-20261103T125455Z-coverage.json',
  'artifacts/live-interview-e2e-20261103T125437Z-silence.json',
];
/** Read-only historical prefix. No later answer, later F count or current cached
 * decision is allowed into a controlled per-turn model diagnosis. */
export function coreCheckpoint(context: InterviewContext, original: InterviewSession, row: Data) {
  const index = original.turns.findIndex(turn => turn.id === row.turnId);
  if (index < 0) throw new Error('DIAGNOSTIC_TURN_MISSING');
  const checkpoint = structuredClone(original);
  const digest = replayHash(`voice-free-controlled-checkpoint-v1:${original.id}:${row.turnId}`);
  // A deterministic UUIDv8 keeps retrieval tie-breaking identical across engines.
  checkpoint.id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-${((parseInt(digest[16], 16) & 3) | 8).toString(16)}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  checkpoint.turns = checkpoint.turns.slice(0, index + 1);
  const current = checkpoint.turns.at(-1)!;
  if (current.questionText !== row.question || current.rawTranscript !== row.capture.rawTranscript ||
    !current.answerId || current.transcriptStatus !== 'finalized') throw new Error('DIAGNOSTIC_OBSERVED_CHECKPOINT_MISMATCH');
  checkpoint.status = 'active'; checkpoint.evaluationStatus = 'pending';
  delete checkpoint.evaluation; delete checkpoint.evaluationError; delete checkpoint.providerUsageLedger;
  delete checkpoint.conversationLedger;
  checkpoint.elapsedMs = row.response?.requestBody?.elapsedMs ?? original.elapsedMs;
  const owner = { id: `synthetic-core-diagnostic-${checkpoint.id}`, mode: 'local-development' as const };
  checkpoint.runtime = createSessionRuntime(context, owner);
  checkpoint.runtime.checkpoint = { phase: 'answer_finalized', at: new Date().toISOString(), turnId: current.id, answerId: current.answerId };
  if (checkpoint.plan?.selectionContext) delete checkpoint.plan.selectionContext.lastSelection;
  if (checkpoint.plan?.selectionContext?.scope) checkpoint.plan.selectionContext.scope.ownerId = owner.id;
  const turnIds = new Set(checkpoint.turns.map(turn => turn.id));
  checkpoint.questionPresentations = checkpoint.questionPresentations?.filter(item => turnIds.has(item.turnId));
  checkpoint.questionPresentationEventIds = [];
  checkpoint.followUpCountByMainQuestion = {};
  for (const turn of checkpoint.turns) {
    checkpoint.followUpCountByMainQuestion[turn.parentMainQuestionId] ??= 0;
    if (turn.questionKind === 'follow_up') checkpoint.followUpCountByMainQuestion[turn.parentMainQuestionId]++;
  }
  delete current.metadata.coreDecision;
  delete current.metadata.answerReaction;
  delete current.metadata.answerContext;
  checkpoint.metrics = { verification: { syntheticTest: true, voiceFreeControlledCheckpoint: true,
    originalObservedTranscript: true, continuousE2E: false } };
  return checkpoint;
}

async function main() {
  const live = process.argv.includes('--run-live');
  const recoveryOnly = process.argv.includes('--recovery-only');
  const engineMode = process.argv.find(arg => arg.startsWith('--engine='))?.slice(9);
  if (engineMode && !['legacy', 'single_core'].includes(engineMode)) throw new Error('DIAGNOSTIC_ENGINE_MODE_INVALID');
  const coreReasoningEffort = process.argv.find(arg => arg.startsWith('--core-effort='))?.slice(14);
  if (coreReasoningEffort && (!['none', 'low'].includes(coreReasoningEffort) || engineMode === 'legacy')) throw new Error('DIAGNOSTIC_CORE_EFFORT_INVALID');
  const effectiveCoreEffort = coreReasoningEffort ?? (engineMode === 'legacy' ? 'none' : interviewConfig.coreReasoningEffort);
  dotenv.config({ path: '.env.local', quiet: true });
  const context = await loadInterviewContext(), bank = await loadQuestionBank(context);
  if (context.errors.length || !bank) throw new Error('VERIFIED_QUESTION_BANK_REQUIRED');
  const only = new Set((process.argv.find(arg => arg.startsWith('--only='))?.slice(7) ?? '').split(',').filter(Boolean));
  const observedPaths = process.argv.find(arg => arg.startsWith('--observations='))?.slice(15).split(',').filter(Boolean) ?? [];
  if (recoveryOnly && !observedPaths.length) throw new Error('RECOVERY_OBSERVED_FAILED_SOURCE_REQUIRED');
  const observed = await Promise.all(observedPaths.map(async sourcePath => {
    if (!/^artifacts\/live-interview-e2e-[a-zA-Z0-9-]+\.json$/u.test(sourcePath)) throw new Error('OBSERVATION_PATH_INVALID');
    return { sourcePath, report: JSON.parse(await readFile(sourcePath, 'utf8')) as Data };
  }));
  const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z');
  const output = process.argv.find(arg => arg.startsWith('--out='))?.slice(6) ?? `artifacts/core-checkpoint-diagnosis-${stamp}.json`;
  if (!/^artifacts\/[a-zA-Z0-9-]+\.json$/u.test(output)) throw new Error('DIAGNOSTIC_OUTPUT_PATH_INVALID');
  if (await access(output).then(() => true, () => false)) throw new Error('DIAGNOSTIC_OUTPUT_ALREADY_EXISTS');
  const manifestPath = 'artifacts/live-e2e-replay-input-manifest.json';
  const manifestText = await readFile(manifestPath, 'utf8'), manifest: Data = JSON.parse(manifestText);
  if (manifest.bankIdentity !== bank.key || manifest.bankContentSha256 !== bank.contentSha256) throw new Error('FROZEN_REPLAY_BANK_CHANGED');
  const report: Data = { startedAt: new Date().toISOString(), live, bankIdentity: bank.key, bankContentSha256: bank.contentSha256,
    recoveryOnly,
    checkpointConstruction: 'voice-free-controlled-checkpoint-v1-deterministic-uuidv8',
    ...(engineMode ? { engineMode } : {}), frozenInputManifest: { path: manifestPath, sha256: replayHash(manifestText) },
    requestedCoreReasoningEffort: effectiveCoreEffort,
    requestedCoreOutputTokenBudget: engineMode === 'legacy' ? 900 : effectiveCoreEffort === 'low' ? 2000 : 600,
    requestedCoreModel: process.env.OPENAI_QUESTION_MODEL || 'gpt-6-luna',
    scope: 'Independent per-turn, voice-free historical checkpoint diagnosis. Not a continuous session, HTTP/WS/STT/TTS or browser E2E test.',
    sourceFilesModified: false, originalSessionSaved: false, cases: [],
    engineSourceSha256: await replayEngineSourceFingerprints() };
  const save = () => writeFile(output, JSON.stringify(maskConversationSecrets(report), null, 2), { mode: 0o600 });
  for (const baselinePath of baselinePaths) {
    const baselineText = await readFile(baselinePath, 'utf8'), baseline: ReplayBaseline = JSON.parse(baselineText);
    const originalText = await readFile(`data/sessions/${baseline.sessionId}.json`, 'utf8');
    const original: InterviewSession = JSON.parse(originalText);
    assertReplayBank(baseline, bank, original);
    if (!manifest.sources.some((source: Data) => source.sourcePath === baselinePath && source.sourceSha256 === replayHash(baselineText))) throw new Error('FROZEN_REPLAY_SOURCE_CHANGED');
    for (const sourceRow of baseline.turns) {
      const key = `${baseline.scenario}:${sourceRow.index}`;
      if (only.size && !only.has(key)) continue;
      const frozen = manifest.answers.find((answer: Data) => answer.sourcePath === baselinePath && answer.sourceIndex === sourceRow.index);
      if (!frozen || frozen.answerSha256 !== replayHash(sourceRow.syntheticStudent.text) || frozen.originalTranscriptSha256 !== replayHash(sourceRow.capture.rawTranscript)) throw new Error('FROZEN_CHECKPOINT_INPUT_CHANGED');
      // A newer raw transcript is usable only together with its own actually
      // delivered question and historical prefix, never pasted onto old state.
      const match = observed.flatMap(item => item.report.replay?.sourceSessionId === baseline.sessionId ?
        item.report.turns.filter((row: Data) => row.capture?.exactReplayInput?.sourceIndex === sourceRow.index)
          .map((row: Data) => ({ ...item, row })) : []).at(-1);
      const row = match?.row ?? sourceRow;
      const actualSessionId = match?.report.sessionId ?? baseline.sessionId;
      const sessionPath = `data/sessions/${actualSessionId}.json`;
      const sessionText = await readFile(sessionPath, 'utf8');
      const item: Data = { caseId: key, sourceScenario: baseline.scenario, sourceIndex: sourceRow.index,
        answerScenario: sourceRow.scenario, baselinePath, baselineSha256: replayHash(baselineText),
        baselineSessionId: baseline.sessionId, originalAnswerSha256: replayHash(sourceRow.syntheticStudent.text),
        observedArtifact: match?.sourcePath ?? baselinePath, observedSessionId: actualSessionId,
        observedSessionSha256: replayHash(sessionText), question: row.question, questionKind: row.questionKind,
        rawTranscript: row.capture.rawTranscript, rawTranscriptSha256: replayHash(row.capture.rawTranscript),
        baselineQuestionChanged: row.question !== sourceRow.question, sourceEpoch: match ? 'selected_replay' : 'original_baseline',
        syntheticQuestionDivergencePreserved: true, providerUsage: [] };
      report.cases.push(item);
      const started = performance.now();
      try {
        if (match && (row.capture.exactReplayInput.answerSha256 !== item.originalAnswerSha256 ||
          !row.capture.exactReplayInput.pcmHashEqualToFrozenBaseline)) throw new Error('OBSERVED_ANSWER_IDENTITY_INVALID');
        const observedSession: InterviewSession = JSON.parse(sessionText);
        const checkpoint = coreCheckpoint(context, observedSession, row), current = checkpoint.turns.at(-1)!;
        if (recoveryOnly) {
          const saved = observedSession.turns.find(turn => turn.id === current.id)?.metadata.coreDecision;
          if (!match || !saved?.questionRecoveryRequired || saved.sourceTurnId !== current.id || saved.sourceAnswerId !== current.answerId) throw new Error('RECOVERY_SOURCE_BOUND_FAILED_DECISION_REQUIRED');
          current.metadata.coreDecision = structuredClone(saved);
          item.restoredFailedDecision = { sourceTurnId: saved.sourceTurnId, sourceAnswerId: saved.sourceAnswerId,
            engineVersion: saved.engineVersion, questionRecoveryRequired: true, failureDetail: saved.failureDetail };
        }
        assertRealtimeCoreSource(context, checkpoint);
        if (!current.metadata.approvedQuestion) throw new Error('DIAGNOSTIC_APPROVED_CONTRACT_MISSING');
        assertQuestionContractIntegrity({ ...current.metadata, acknowledgement: null, questionText: current.questionText,
          questionKind: current.questionKind, parentMainQuestionId: current.questionKind === 'main' ? null : current.parentMainQuestionId,
          evidenceIds: current.evidenceIds }, current.metadata.approvedQuestion);
        item.checkpointValid = true;
        item.checkpointSessionId = checkpoint.id;
        item.prefixTurnCount = checkpoint.turns.length;
        item.currentTurnId = current.id; item.currentAnswerId = current.answerId;
        const duration = checkpoint.durationSeconds ?? context.interviewOverview!.durationSeconds;
        item.options = { policyMode: 'compiled', allowFollowUp: mayAskFollowUp(checkpoint, duration, 2),
          allowClarification: mayAskClarification(checkpoint, duration), allowReplay: mayReplayQuestion(checkpoint, duration),
          ...(recoveryOnly ? { recoveryOnly: true } : {}) };
        if (live) item.result = await runStrategyRealtimeCore(context, checkpoint, { ...item.options, ...(engineMode ? { engineMode } : {}),
          ...(coreReasoningEffort ? { coreReasoningEffort } : {}),
          onProviderUsage: (stage, observation) => item.providerUsage.push({ stage, observation }) });
        else item.result = null;
      } catch (error) { item.failure = error instanceof Error ? error.message : String(error); }
      item.wallMs = performance.now() - started;
      item.originalSessionUnchanged = replayHash(await readFile(sessionPath, 'utf8')) === item.observedSessionSha256;
      if (!item.originalSessionUnchanged) report.sourceFilesModified = 'Concurrent external change observed; diagnostic never saves sessions.';
      await save();
      console.log(JSON.stringify({ key, checkpointValid: item.checkpointValid ?? false, live, wallMs: Math.round(item.wallMs),
        action: item.result?.nextAction, failure: item.failure ?? item.result?.failureDetail ?? null }));
    }
  }
  report.completedAt = new Date().toISOString();
  report.providerRequests = report.cases.reduce((count: number, item: Data) => count + item.providerUsage.length, 0);
  const endingSource = await replayEngineSourceFingerprints();
  report.engineSourceUnchanged = JSON.stringify(report.engineSourceSha256) === JSON.stringify(endingSource);
  if (!report.engineSourceUnchanged) report.engineSourceSha256After = endingSource;
  await save(); console.log(JSON.stringify({ output, cases: report.cases.length, providerRequests: report.providerRequests }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
