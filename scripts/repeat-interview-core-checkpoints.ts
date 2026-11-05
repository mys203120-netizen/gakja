import dotenv from 'dotenv';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { zodTextFormat } from 'openai/helpers/zod';
import { interviewConfig } from '../interview.config';
import { loadInterviewContext } from '../server/data/load-interview-context';
import { loadQuestionBank } from '../server/data/prepared-question-bank';
import { mayAskFollowUp } from '../server/interview-planner';
import { mayAskClarification, mayReplayQuestion, type InterviewSession } from '../server/protocol';
import { assertQuestionContractIntegrity } from '../server/question-objective';
import { runStrategyRealtimeCore } from '../server/providers/realtime-strategy-core';
import { singleCoreWireSchema, SINGLE_CORE_DIALOGUE_RULES } from '../server/providers/single-core-contract';
import { buildRuntimeCoreScope } from '../server/providers/runtime-core-scope';
import { singleCoreInputPayload } from '../server/providers/runtime-core-payload';
import { loadApprovedRecoveryVariants } from '../server/data/approved-recovery-variants';
import { selectRuntimePolicy } from '../server/policy/compiled-runtime-policy';
import { estimateProviderCost } from '../server/observability/provider-cost';
import { maskConversationSecrets } from '../server/storage/conversation-log';
import { coreCheckpoint } from './replay-interview-core-checkpoints';
import { assertReplayBank, replayEngineSourceFingerprints, replayHash, type ReplayBaseline } from './live-e2e-replay';

type Data = Record<string, any>;
const sources = ['artifacts/live-interview-e2e-20261103T125013Z-conversation.json',
  'artifacts/live-interview-e2e-20261103T125455Z-coverage.json'];
const approvedCaseIds = ['conversation:3', 'conversation:4', 'coverage:4'];

export function repeatConfiguration(args: string[]) {
  const repeats = Number(args.find(arg => arg.startsWith('--repeats='))?.slice(10) ?? 5);
  const cases = (args.find(arg => arg.startsWith('--only='))?.slice(7) ?? approvedCaseIds.join(',')).split(',');
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5 || !cases.length ||
    new Set(cases).size !== cases.length || cases.some(id => !approvedCaseIds.includes(id))) throw new Error('BOUNDED_REPEAT_CONFIGURATION_INVALID');
  return { repeats, cases, plannedDecisions: repeats * cases.length };
}

async function main() {
  if (!process.argv.includes('--run-live')) throw new Error('EXPLICIT_RUN_LIVE_REQUIRED');
  const config = repeatConfiguration(process.argv.slice(2));
  const output = process.argv.find(arg => arg.startsWith('--out='))?.slice(6);
  if (!output || !/^artifacts\/[a-zA-Z0-9-]+\.json$/u.test(output)) throw new Error('REPEATED_OUTPUT_PATH_REQUIRED');
  if (await access(output).then(() => true, () => false)) throw new Error('REPEATED_OUTPUT_ALREADY_EXISTS');
  dotenv.config({ path: '.env.local', quiet: true });
  // All production imports above are evaluated before this point. Capture their
  // disk revision before the coordinator releases its production edit freeze.
  const engineSourceSha256 = await replayEngineSourceFingerprints();
  console.log(JSON.stringify({ event: 'REPEAT_BASELINE_IMPORTS_AND_SOURCE_CAPTURED', plannedDecisions: config.plannedDecisions,
    sourceFiles: Object.keys(engineSourceSha256).length, policyMode: 'compiled' }));
  const context = await loadInterviewContext(), bank = await loadQuestionBank(context);
  if (context.errors.length || !bank) throw new Error('VERIFIED_QUESTION_BANK_REQUIRED');
  const frozenText = await readFile('artifacts/live-e2e-replay-input-manifest.json', 'utf8'), frozen: Data = JSON.parse(frozenText);
  if (frozen.bankIdentity !== bank.key || frozen.bankContentSha256 !== bank.contentSha256) throw new Error('FROZEN_REPLAY_BANK_CHANGED');
  const checkpoints: Data[] = [];
  for (const sourcePath of sources) {
    const text = await readFile(sourcePath, 'utf8'), baseline: ReplayBaseline = JSON.parse(text);
    const sessionPath = `data/sessions/${baseline.sessionId}.json`, sessionText = await readFile(sessionPath, 'utf8');
    const session: InterviewSession = JSON.parse(sessionText);
    assertReplayBank(baseline, bank, session);
    if (!frozen.sources.some((s: Data) => s.sourcePath === sourcePath && s.sourceSha256 === replayHash(text))) throw new Error('FROZEN_SOURCE_CHANGED');
    for (const row of baseline.turns) {
      const caseId = `${baseline.scenario}:${row.index}`;
      if (!config.cases.includes(caseId)) continue;
      const answer = frozen.answers.find((a: Data) => a.sourcePath === sourcePath && a.sourceIndex === row.index);
      if (!answer || answer.answerSha256 !== replayHash(row.syntheticStudent.text) ||
        answer.originalTranscriptSha256 !== replayHash(row.capture.rawTranscript)) throw new Error('FROZEN_CHECKPOINT_CHANGED');
      checkpoints.push({ caseId, row, session, sessionPath, sessionSha256: replayHash(sessionText), sourcePath,
        sourceSha256: replayHash(text), answerSha256: answer.answerSha256 });
    }
  }
  if (checkpoints.length !== config.cases.length) throw new Error('REPEATED_CASES_MISSING');
  const report: Data = { startedAt: new Date().toISOString(), ...config, policyMode: 'compiled',
    requestedCoreModel: process.env.OPENAI_QUESTION_MODEL || 'gpt-6-luna', requestedCoreReasoningEffort: interviewConfig.coreReasoningEffort,
    bankIdentity: bank.key, bankContentSha256: bank.contentSha256, frozenInputManifestSha256: replayHash(frozenText),
    engineSourceSha256, originalSessionSaved: false, sourceFilesModified: false, cases: [],
    provenance: { syntheticStudentAnswers: true, newStudentGenerationCalls: 0, humanReviewedGold: false,
      voiceFreeControlledCheckpoint: true, continuousE2E: false, policyMode: 'compiled',
      policyScope: 'Current service compiled mandatory policy plus pinned original MD corpus; not raw full-document injection.',
      requestProjection: 'Reconstructed with the same exported payload/schema/policy builders, not a provider echo.',
      loadedBaseline: 'Static production imports and disk source fingerprints captured before coordinator releases edit freeze.' } };
  const save = () => writeFile(output, JSON.stringify(maskConversationSecrets(report), null, 2), { mode: 0o600 });
  const projections = new Map<string, string>();
  await save();
  // Interleave case order. Each decision starts from an independently cloned
  // identical prefix; no prior repetition output or decision enters another.
  for (let repeat = 1; repeat <= config.repeats; repeat++) for (const source of checkpoints) {
    const item: Data = { caseId: source.caseId, repeat, question: source.row.question,
      rawTranscript: source.row.capture.rawTranscript, rawTranscriptSha256: replayHash(source.row.capture.rawTranscript),
      answerSha256: source.answerSha256, sourcePath: source.sourcePath, sourceSha256: source.sourceSha256,
      originalSessionSha256: source.sessionSha256, providerUsage: [] };
    report.cases.push(item); const at = performance.now();
    try {
      const session = coreCheckpoint(context, source.session, source.row), current = session.turns.at(-1)!;
      assertQuestionContractIntegrity({ ...current.metadata, acknowledgement: null, questionText: current.questionText,
        questionKind: current.questionKind, parentMainQuestionId: current.questionKind === 'main' ? null : current.parentMainQuestionId,
        evidenceIds: current.evidenceIds }, current.metadata.approvedQuestion!);
      const duration = session.durationSeconds ?? context.interviewOverview!.durationSeconds;
      const options = { policyMode: 'compiled' as const, allowFollowUp: mayAskFollowUp(session, duration, 2),
        allowClarification: mayAskClarification(session, duration), allowReplay: mayReplayQuestion(session, duration) };
      const scope = buildRuntimeCoreScope(context, session);
      const variants = options.allowClarification ? await loadApprovedRecoveryVariants(context, current).catch(() => []) : [];
      const policy = selectRuntimePolicy(context, session);
      const input = singleCoreInputPayload(context, session, scope, { allowFollowUp: options.allowFollowUp,
        allowClarification: options.allowClarification, allowAudioReplay: options.allowReplay,
        remainingMs: duration * 1000 - session.elapsedMs, semanticAuthority: 'single_core' }, variants.map(d => d.questionText));
      item.checkpointSessionId = session.id; item.prefixTurnCount = session.turns.length;
      item.sourceTurnId = current.id; item.sourceAnswerId = current.answerId; item.options = options;
      item.requestProjection = { inputSha256: replayHash(JSON.stringify(input)),
        instructionsSha256: replayHash(`${policy.instructions}\n${SINGLE_CORE_DIALOGUE_RULES}`),
        schemaSha256: replayHash(JSON.stringify(zodTextFormat(singleCoreWireSchema, 'single_interview_decision'))),
        policyRegistrySha256: policy.trace.registrySha256, originalMdSha256: policy.trace.originalMdSha256 };
      const signature = replayHash(JSON.stringify({ checkpointSessionId: session.id, options, projection: item.requestProjection }));
      if (projections.has(source.caseId) && projections.get(source.caseId) !== signature) throw new Error('REPEATED_REQUEST_PROJECTION_CHANGED');
      projections.set(source.caseId, signature); item.repetitionIdentitySha256 = signature;
      item.result = await runStrategyRealtimeCore(context, session, { ...options,
        onProviderUsage: (stage, observation) => item.providerUsage.push({ stage, observation, estimatedCost: estimateProviderCost(observation) }) });
    } catch (error) { item.failure = error instanceof Error ? error.message : String(error); }
    item.wallMs = performance.now() - at;
    item.originalSessionUnchanged = replayHash(await readFile(source.sessionPath, 'utf8')) === source.sessionSha256;
    if (!item.originalSessionUnchanged) report.sourceFilesModified = true;
    await save();
    console.log(JSON.stringify({ caseId: item.caseId, repeat, coreAction: item.result?.semanticDecision?.next.action,
      executedAction: item.result?.execution?.action, coverage: item.result?.fulfillment,
      wallMs: Math.round(item.wallMs), failure: item.failure ?? item.result?.failureDetail ?? null }));
  }
  report.completedAt = new Date().toISOString();
  report.providerRequests = report.cases.reduce((n: number, c: Data) => n + c.providerUsage.length, 0);
  const after = await replayEngineSourceFingerprints();
  report.engineSourceUnchangedOnDisk = JSON.stringify(engineSourceSha256) === JSON.stringify(after);
  if (!report.engineSourceUnchangedOnDisk) report.engineSourceSha256After = after;
  report.distributions = Object.fromEntries(config.cases.map(id => {
    const rows = report.cases.filter((c: Data) => c.caseId === id), count: Data = {};
    for (const row of rows) { const action = row.result?.semanticDecision?.next.action ?? 'NO_CORE_DECISION'; count[action] = (count[action] ?? 0) + 1; }
    return [id, { repeats: rows.length, coreActionCounts: count,
      runtimeReady: rows.filter((c: Data) => c.result?.execution?.status === 'ready').length,
      blocked: rows.filter((c: Data) => c.failure || c.result?.execution?.status === 'blocked').length,
      identicalRepetitionInputs: new Set(rows.map((c: Data) => c.repetitionIdentitySha256)).size === 1 }];
  }));
  await save(); console.log(JSON.stringify({ output, decisions: report.cases.length, providerRequests: report.providerRequests, distributions: report.distributions }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
