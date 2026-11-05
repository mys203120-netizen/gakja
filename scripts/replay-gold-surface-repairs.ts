import dotenv from 'dotenv';
import { access, readFile, writeFile } from 'node:fs/promises';
import { loadInterviewContext } from '../server/data/load-interview-context';
import { mayAskFollowUp } from '../server/interview-planner';
import { mayAskClarification, mayReplayQuestion } from '../server/protocol';
import { runStrategyRealtimeCore } from '../server/providers/realtime-strategy-core';
import { estimateProviderCost } from '../server/observability/provider-cost';
import { maskConversationSecrets } from '../server/storage/conversation-log';
import { syntheticGoldCheckpoint } from './evaluate-historical-dialogue-gold';
import { replayEngineSourceFingerprints, replayHash } from './live-e2e-replay';
import { loadOfflineSemanticBinding } from './lib/semantic-release-gate';

type Data = Record<string, any>;
if (!process.argv.includes('--run-live')) throw new Error('EXPLICIT_RUN_LIVE_REQUIRED');
const output = process.argv.find(a => a.startsWith('--out='))?.slice(6);
if (!output || !/^artifacts\/[a-zA-Z0-9-]+\.json$/u.test(output)) throw new Error('REPAIR_REPLAY_OUTPUT_INVALID');
if (await access(output).then(() => true, () => false)) throw new Error('REPAIR_REPLAY_OUTPUT_ALREADY_EXISTS');
dotenv.config({ path: '.env.local', quiet: true });
const semanticReleaseIdentity = await loadOfflineSemanticBinding(process.argv.slice(2));
const sourcePath = 'artifacts/phase1-historical-gold-candidate-v32-20261104.json';
const sourceText = await readFile(sourcePath, 'utf8'), source: Data = JSON.parse(sourceText);
const recorded = source.cases.find((c: Data) => c.variantId === 'DHG-04-v3');
const manifestText = await readFile(source.manifestPath, 'utf8'), manifest: Data = JSON.parse(manifestText);
if (replayHash(manifestText) !== source.manifestSha256 || !recorded?.result?.semanticDecision) throw new Error('REPAIR_REPLAY_SOURCE_CHANGED');
const gold = manifest.frozenCases.find((g: Data) => g.id === recorded.caseId);
const variant = gold.variants.find((v: Data) => v.id === recorded.variantId);
const anchors: Data = JSON.parse(await readFile(gold.sourceAnchor.artifactPath, 'utf8'));
const anchor = anchors.cases[gold.sourceAnchor.sourceRowIndex];
const baseline: Data = JSON.parse(await readFile(anchor.baselinePath, 'utf8'));
const row = baseline.turns.find((r: Data) => r.index === anchor.sourceIndex);
const originalPath = `data/sessions/${anchor.observedSessionId}.json`, originalText = await readFile(originalPath, 'utf8');
if (replayHash(originalText) !== anchor.observedSessionSha256) throw new Error('REPAIR_REPLAY_ORIGINAL_CHANGED');
const context = await loadInterviewContext();
const report: Data = { startedAt: new Date().toISOString(), semanticReleaseIdentity, sourcePath, sourceSha256: replayHash(sourceText),
  manifestPath: source.manifestPath, manifestSha256: source.manifestSha256, variantId: variant.id,
  plannedRepeats: 3, knownEstimateCapUsd: 0.05, knownEstimatedUsd: 0, unknownCostRequests: 0, cases: [],
  engineSourceSha256: await replayEngineSourceFingerprints(),
  scope: 'Counterfactual surface-only replay of the exact recorded core decision at its synthetic gold checkpoint. No fresh core classification, STT/TTS/HTTP or fabricated prior503.' };
const save = () => writeFile(output, JSON.stringify(maskConversationSecrets(report), null, 2), { mode: 0o600 });
await save();
for (let repeat = 1; repeat <= 3; repeat++) {
  if (report.unknownCostRequests || report.knownEstimatedUsd >= 0.05) { report.stopReason = 'UNKNOWN_COST_OR_CAP'; break; }
  const { session } = syntheticGoldCheckpoint(context, JSON.parse(originalText), row, gold, variant), current = session.turns.at(-1)!;
  if (current.id !== recorded.sourceTurnId || current.answerId !== recorded.syntheticAnswerId || session.id !== recorded.checkpointSessionId) throw new Error('REPAIR_REPLAY_IDENTITY_CHANGED');
  current.metadata.coreDecision = { ...structuredClone(recorded.result), sourceTurnId: current.id, sourceAnswerId: current.answerId };
  const item: Data = { repeat, originalCoreDecisionSha256: replayHash(JSON.stringify(recorded.result.semanticDecision)),
    question: current.questionText, answerSha256: replayHash(current.rawTranscript ?? ''), priorSha256: replayHash(JSON.stringify(session.turns.slice(0, -1))),
    originalCoreQuestion: recorded.result.semanticDecision.next.question.text,
    originalBadRepairedQuestion: recorded.result.draft?.questionText, sourceTurnId: current.id, sourceAnswerId: current.answerId,
    providerUsage: [...(recorded.providerUsage ?? recorded.result.providerUsage ?? []).filter((entry: Data) => entry.stage === 'core')] };
  report.cases.push(item); const at = performance.now(), duration = session.durationSeconds ?? context.interviewOverview!.durationSeconds;
  try { item.result = await runStrategyRealtimeCore(context, session, { recoveryOnly: true, policyMode: 'compiled',
    allowFollowUp: mayAskFollowUp(session, duration, 2), allowClarification: mayAskClarification(session, duration), allowReplay: mayReplayQuestion(session, duration),
    onProviderUsage: (stage, observation) => { const cost = estimateProviderCost(observation); item.providerUsage.push({ stage, observation, estimatedCost: cost });
      if (typeof cost.usd === 'number') report.knownEstimatedUsd += cost.usd; else report.unknownCostRequests++; } });
  } catch (error) { item.failure = error instanceof Error ? error.message : String(error); }
  item.wallMs = performance.now() - at; item.originalSessionUnchanged = replayHash(await readFile(originalPath, 'utf8')) === anchor.observedSessionSha256;
  await save(); console.log(JSON.stringify({ repeat, action: item.result?.execution?.action, status: item.result?.execution?.status,
    question: item.result?.draft?.questionText, coreCalls: item.result?.providerTimings.coreModelCalls,
    failure: item.failure ?? item.result?.failureDetail ?? null }));
}
report.completedAt = new Date().toISOString();
report.engineSourceUnchanged = JSON.stringify(report.engineSourceSha256) === JSON.stringify(await replayEngineSourceFingerprints());
await save(); console.log(JSON.stringify({ output, repeats: report.cases.length, knownEstimatedUsd: report.knownEstimatedUsd, unknownCostRequests: report.unknownCostRequests }));
