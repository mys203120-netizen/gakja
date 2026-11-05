import dotenv from 'dotenv';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dialogueActionHistoricalGoldCases, dialogueActionHistoricalGoldProvenance } from '../tests/fixtures/dialogue-action-historical-gold';
import { loadInterviewContext, type InterviewContext } from '../server/data/load-interview-context';
import { loadQuestionBank } from '../server/data/prepared-question-bank';
import { mayAskFollowUp } from '../server/interview-planner';
import { mayAskClarification, mayReplayQuestion, type InterviewSession } from '../server/protocol';
import { assertQuestionContractIntegrity } from '../server/question-objective';
import { assertRealtimeCoreSource } from '../server/providers/realtime-core';
import { runStrategyRealtimeCore } from '../server/providers/realtime-strategy-core';
import { estimateProviderCost } from '../server/observability/provider-cost';
import { maskConversationSecrets } from '../server/storage/conversation-log';
import { coreCheckpoint } from './replay-interview-core-checkpoints';
import { assertReplayBank, replayEngineSourceFingerprints, replayHash, type ReplayBaseline } from './live-e2e-replay';
import { loadOfflineSemanticBinding } from './lib/semantic-release-gate';

type Data = Record<string, any>;
const fixturePath = 'tests/fixtures/dialogue-action-historical-gold.ts';
const uuid = (name: string) => { const h = replayHash(name); return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const validOutput = (value: string | undefined): value is string => Boolean(value && /^artifacts\/[a-zA-Z0-9-]+\.json$/u.test(value));

export function syntheticGoldCheckpoint(context: InterviewContext, original: InterviewSession, row: Data, gold: Data, variant: Data) {
  if (row.question !== gold.expectedQuestion || typeof variant.answer !== 'string' || !variant.answer.trim()) throw new Error('GOLD_ANCHOR_OR_ANSWER_INVALID');
  const session = coreCheckpoint(context, original, row), current = session.turns.at(-1)!;
  const priorSha256 = replayHash(JSON.stringify(session.turns.slice(0, -1)));
  const questionContractSha256 = replayHash(JSON.stringify(current.metadata.approvedQuestion));
  current.answerId = uuid(`synthetic-gold-v1:${original.id}:${gold.id}:${variant.id}`);
  current.rawTranscript = variant.answer; current.transcriptStatus = 'finalized';
  delete current.answerObservation; delete current.sttObservations; delete current.metrics;
  delete current.metadata.lastStreamId; delete current.metadata.coreDecision;
  delete current.metadata.answerReaction; delete current.metadata.answerContext;
  session.runtime!.checkpoint.answerId = current.answerId;
  if (priorSha256 !== replayHash(JSON.stringify(session.turns.slice(0, -1))) || questionContractSha256 !== replayHash(JSON.stringify(current.metadata.approvedQuestion))) throw new Error('GOLD_HISTORY_OR_QUESTION_MUTATED');
  // Original questions may depend on prior answers. Those words and identities
  // stay exact; replacing an answer must never silently invalidate an old proof.
  for (const turn of session.turns) for (const ref of turn.metadata.approvedQuestion?.blueprint.anchorRefs ?? []) {
    if (ref.kind !== 'ANSWER_TURN') continue;
    const source = session.turns.find(t => `ANSWER_TURN:${t.id}:${t.answerId}` === ref.sourceId);
    if (!source?.rawTranscript || replayHash(source.rawTranscript) !== ref.revision || ref.start < 0 || ref.end > source.rawTranscript.length || ref.end <= ref.start) throw new Error('GOLD_PRIOR_ANSWER_PROOF_INVALID');
  }
  assertRealtimeCoreSource(context, session);
  assertQuestionContractIntegrity({ ...current.metadata, acknowledgement: null, questionText: current.questionText,
    questionKind: current.questionKind, parentMainQuestionId: current.questionKind === 'main' ? null : current.parentMainQuestionId,
    evidenceIds: current.evidenceIds }, current.metadata.approvedQuestion!);
  return { session, priorSha256, questionContractSha256 };
}

async function main() {
  const live = process.argv.includes('--run-live'), prepare = process.argv.includes('--prepare');
  if (live === prepare) throw new Error('GOLD_EXPLICIT_SINGLE_MODE_REQUIRED');
  const manifestPath = process.argv.find(a => a.startsWith('--manifest='))?.slice(11);
  const output = process.argv.find(a => a.startsWith('--out='))?.slice(6);
  if (!validOutput(manifestPath) || live && !validOutput(output)) throw new Error('GOLD_PATH_INVALID');
  if (await access(prepare ? manifestPath : output!).then(() => true, () => false)) throw new Error('GOLD_OUTPUT_ALREADY_EXISTS');
  dotenv.config({ path: '.env.local', quiet: true });
  const semanticReleaseIdentity = await loadOfflineSemanticBinding(process.argv.slice(2));
  const context = await loadInterviewContext(), bank = await loadQuestionBank(context);
  if (context.errors.length || !bank) throw new Error('VERIFIED_QUESTION_BANK_REQUIRED');
  const anchorText = await readFile(dialogueActionHistoricalGoldProvenance.anchorArtifact, 'utf8');
  if (replayHash(anchorText) !== dialogueActionHistoricalGoldProvenance.anchorArtifactSha256) throw new Error('GOLD_FROZEN_ANCHOR_CHANGED');
  const anchors: Data = JSON.parse(anchorText);
  const loaded = new Map<string, { baseline: ReplayBaseline; original: InterviewSession; sessionPath: string; sessionSha256: string }>();
  const resolve = async (gold: Data, variant: Data) => {
    const anchor = anchors.cases[gold.sourceAnchor.sourceRowIndex];
    if (!anchor || anchor.question !== gold.expectedQuestion || gold.sourceAnchor.artifactPath !== dialogueActionHistoricalGoldProvenance.anchorArtifact) throw new Error('GOLD_EXACT_QUESTION_MISMATCH');
    const key = anchor.baselinePath;
    if (!loaded.has(key)) {
      const text = await readFile(key, 'utf8'), baseline: ReplayBaseline = JSON.parse(text);
      const sessionPath = `data/sessions/${anchor.observedSessionId}.json`, sessionText = await readFile(sessionPath, 'utf8');
      const original: InterviewSession = JSON.parse(sessionText); assertReplayBank(baseline, bank, original);
      if (replayHash(text) !== anchor.baselineSha256 || replayHash(sessionText) !== anchor.observedSessionSha256) throw new Error('GOLD_ORIGINAL_SOURCE_CHANGED');
      loaded.set(key, { baseline, original, sessionPath, sessionSha256: replayHash(sessionText) });
    }
    const data = loaded.get(key)!, row = data.baseline.turns.find((r: Data) => r.index === anchor.sourceIndex);
    if (!row || row.question !== anchor.question || row.capture.rawTranscript !== anchor.rawTranscript) throw new Error('GOLD_ORIGINAL_CHECKPOINT_CHANGED');
    return { ...data, ...syntheticGoldCheckpoint(context, data.original, row, gold, variant) };
  };
  const fixtureSha256 = replayHash(await readFile(fixturePath));
  if (prepare) {
    const frozenCases = structuredClone(dialogueActionHistoricalGoldCases), planned = frozenCases.reduce((n, c) => n + c.variants.length, 0);
    if (frozenCases.length !== 24 || planned !== 36) throw new Error('GOLD_APPROVED_BUDGET_CHANGED');
    const preflight = [];
    for (const gold of frozenCases) for (const variant of gold.variants) {
      const checked = await resolve(gold, variant);
      preflight.push({ caseId: gold.id, variantId: variant.id, question: checked.session.turns.at(-1)!.questionText,
        syntheticAnswerSha256: replayHash(variant.answer), priorSha256: checked.priorSha256,
        questionContractSha256: checked.questionContractSha256, originalSessionSha256: checked.sessionSha256 });
    }
    const manifest = { frozenAt: new Date().toISOString(), fixturePath, fixtureSha256,
      provenance: dialogueActionHistoricalGoldProvenance, baseCases: 24, plannedDecisions: 36,
      knownOpenAiEstimateCapUsd: 0.15, bankIdentity: bank.key, bankContentSha256: bank.contentSha256,
      mdSourcePins: context.manifest.fullMdPolicyOriginals, frozenCases, preflight,
      limits: ['Agent-authored MD expectations; human review pending.', 'Current synthetic text is injected only into an in-memory approved historical question checkpoint; no STT/audio observation is claimed.', 'Earlier question/answer proof and source facts remain unchanged. Expected labels are never provider input.'] };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ manifestPath, manifestSha256: replayHash(await readFile(manifestPath)), baseCases: 24, plannedDecisions: 36, preflight: preflight.length })); return;
  }
  const manifestText = await readFile(manifestPath, 'utf8'), manifest: Data = JSON.parse(manifestText);
  if (manifest.fixtureSha256 !== fixtureSha256 || manifest.bankIdentity !== bank.key || manifest.bankContentSha256 !== bank.contentSha256 || manifest.plannedDecisions !== 36 || manifest.knownOpenAiEstimateCapUsd !== 0.15) throw new Error('GOLD_FROZEN_MANIFEST_CHANGED');
  if (replayHash(JSON.stringify(manifest.frozenCases)) !== replayHash(JSON.stringify(dialogueActionHistoricalGoldCases))) throw new Error('GOLD_FROZEN_EXPECTATIONS_CHANGED');
  const report: Data = { startedAt: new Date().toISOString(), semanticReleaseIdentity, manifestPath, manifestSha256: replayHash(manifestText),
    baseCases: 24, plannedDecisions: 36, provenance: manifest.provenance, scope: 'Voice-free synthetic current answers at unchanged approved historical questions/prefixes; not continuous E2E.',
    engineSourceSha256: await replayEngineSourceFingerprints(), cases: [], knownOpenAiEstimatedSubtotalUsd: 0, unknownCostRequests: 0 };
  const save = () => writeFile(output!, JSON.stringify(maskConversationSecrets(report), null, 2), { mode: 0o600 });
  await save();
  outer: for (const gold of manifest.frozenCases) for (const variant of gold.variants) {
    if (report.unknownCostRequests || report.knownOpenAiEstimatedSubtotalUsd >= manifest.knownOpenAiEstimateCapUsd) { report.stopReason = report.unknownCostRequests ? 'UNKNOWN_USAGE_OR_COST' : 'KNOWN_ESTIMATE_CAP'; break outer; }
    const checked = await resolve(gold, variant), session: InterviewSession = checked.session;
    const duration = session.durationSeconds ?? context.interviewOverview!.durationSeconds;
    const item: Data = { caseId: gold.id, variantId: variant.id, split: gold.split, category: gold.category,
      question: gold.expectedQuestion, syntheticAnswer: variant.answer, answerSha256: replayHash(variant.answer),
      expected: gold.expected, mdRefs: gold.mdRefs, checkpointSessionId: session.id,
      sourceTurnId: session.turns.at(-1)!.id, syntheticAnswerId: session.turns.at(-1)!.answerId,
      priorSha256: checked.priorSha256, questionContractSha256: checked.questionContractSha256,
      technicalObservation: null, providerUsage: [] };
    report.cases.push(item); const at = performance.now();
    try { item.result = await runStrategyRealtimeCore(context, session, { policyMode: 'compiled',
      allowFollowUp: mayAskFollowUp(session, duration, 2), allowClarification: mayAskClarification(session, duration), allowReplay: mayReplayQuestion(session, duration),
      onProviderUsage: (stage, observation) => { const cost = estimateProviderCost(observation); item.providerUsage.push({ stage, observation, estimatedCost: cost });
        if (typeof cost.usd === 'number') report.knownOpenAiEstimatedSubtotalUsd += cost.usd; else report.unknownCostRequests++; } });
    } catch (error) { item.failure = error instanceof Error ? error.message : String(error); }
    item.wallMs = performance.now() - at;
    item.originalSessionUnchanged = replayHash(await readFile(checked.sessionPath, 'utf8')) === checked.sessionSha256;
    const assessment = item.result?.semanticDecision?.assessment, action = item.result?.semanticDecision?.next.action;
    item.rubric = { actionInExpectedSet: gold.expected.actions.includes(action), coverageInExpectedSet: gold.expected.coverage.includes(assessment?.coverage),
      responseInExpectedSet: gold.expected.response.includes(assessment?.response), manualSurfaceReviewRequired: true,
      note: 'Label agreement is separate from semantic scope/surface quality and legitimate discretionary met+F benefit.' };
    await save(); console.log(JSON.stringify({ caseId: gold.id, variantId: variant.id, coreAction: action,
      coverage: assessment?.coverage, runtime: item.result?.execution?.status, rubric: item.rubric,
      failure: item.failure ?? item.result?.failureDetail ?? null, wallMs: Math.round(item.wallMs), knownCostUsd: report.knownOpenAiEstimatedSubtotalUsd }));
  }
  report.completedAt = new Date().toISOString();
  report.executedDecisions = report.cases.length;
  report.allPlannedDecisionsExecuted = report.cases.length === manifest.plannedDecisions;
  report.engineSourceUnchanged = JSON.stringify(report.engineSourceSha256) === JSON.stringify(await replayEngineSourceFingerprints());
  report.observedOpenAiTotalUsd = report.unknownCostRequests ? null : report.knownOpenAiEstimatedSubtotalUsd;
  await save(); console.log(JSON.stringify({ output, decisions: report.cases.length, allPlanned: report.allPlannedDecisionsExecuted,
    knownCostUsd: report.knownOpenAiEstimatedSubtotalUsd, unknownCostRequests: report.unknownCostRequests, stopReason: report.stopReason ?? null }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
